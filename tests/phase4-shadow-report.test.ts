import { describe, expect, it } from "vitest";
import { ReportAcc, buildReport, clusterMean, consoleLines, depthWithin, groupsCsv, nearestOffset, pairedCsv, verdictOf, MIN_PAIRS, MIN_CLUSTERS, PAPER_LATENCY_S, type PaperLite, type RowLite, type SignalMeta } from "@/lib/phase4/shadow/report";
import { readReport, runShadowReportCli, REPORT_PAGE } from "@/lib/phase4/shadow/report-cli";
import { readOnly } from "@/lib/phase4/readonly-db";
import { shadowDb } from "./helpers/shadowDb";
import { T0, uid } from "./helpers/shadowWorld";

const fill = (usd: number, avg: number | null, o: Partial<Record<string, any>> = {}) => ({ usd_requested: usd, filled_usd: avg === null ? 0 : usd, shares: avg === null ? 0 : usd / avg, avg_price: avg, limit_price: avg, slippage_vs_source: null as number | null, slippage_vs_mid: null as number | null, filled_share: avg === null ? 0 : 1, fee_usd: 0, below_min_order: false, ...o });
const mkRow = (i: number, o: Partial<RowLite> & { avg?: number; source?: number; mid?: number; fee?: number; feeSource?: string } = {}): RowLite => {
  const source = o.source ?? 0.5, mid = o.mid ?? 0.51, avg = o.avg ?? 0.53;
  const f = (usd: number) => fill(usd, avg, { slippage_vs_source: avg - source, slippage_vs_mid: avg - mid, fee_usd: o.fee ?? usd * 0.02 });
  return { signal_id: uid(i), offset_s: 0, status: "OK", source_price: source, best_bid: 0.5, best_ask: 0.52, spread: 0.02, mid, bids: [[0.5, 100], [0.49, 100]], asks: [[0.52, 100], [0.53, 400], [0.56, 100]], fills: { by_usd: { "10": f(10), "25": f(25), "100": f(100) } }, fee_rate_bps: 200, fee_source: o.feeSource ?? "OBSERVED_RATE", bytes: 1200, ...o } as RowLite;
};
const paper = (o: Partial<PaperLite> = {}): PaperLite => ({ status: "FILLED", signal_price: 0.5, market_price: 0.51, fill_price: 0.52, filled_usd: 100, entry_fee: 1, fee_source: "OBSERVED_RATE", evaluated_gap_s: 2, ...o });
const meta = (i: number, o: Partial<SignalMeta> = {}): SignalMeta => ({ kind: "NEW_POSITION", category: "sports", conditionId: `c${i % 12}`, marketFee: { rate: 0.02, source: "OBSERVED_RATE" }, ...o });
const acc = () => new ReportAcc({ sizes: [10, 25, 100], pairOffset: 0 });

describe("report arithmetic", () => {
  it("depthWithin: dollars within k price points of the best level, and whether the stored levels end inside the range (a lower bound)", () => {
    const asks: [number, number][] = [[0.5, 100], [0.51, 200], [0.53, 50]];
    expect(depthWithin(asks, "ask", 1)).toEqual({ usd: 0.5 * 100 + 0.51 * 200, truncated: false }); expect(depthWithin(asks, "ask", 3)!.usd).toBeCloseTo(50 + 102 + 26.5, 9);
    expect(depthWithin(asks.slice(0, 2), "ask", 2)!.truncated).toBe(true);
    expect(depthWithin([[0.48, 10], [0.47, 20], [0.45, 5]], "bid", 1)!.usd).toBeCloseTo(4.8 + 9.4, 9); expect(depthWithin([], "ask", 1)).toBeNull(); expect(depthWithin(null, "bid", 1)).toBeNull();
  });
  it("nearestOffset: the offset closest to the paper REALISTIC latency (10 s), the earlier one on a tie", () => {
    expect(PAPER_LATENCY_S).toBe(10); expect(nearestOffset([0, 60, 300])).toBe(0); expect(nearestOffset([0, 20])).toBe(0); expect(nearestOffset([30, 60], 10)).toBe(30); expect(nearestOffset([0, 60, 300], 200)).toBe(300);
  });
  it("clusterMean: a known answer (clusters {1,2} and {3,4}: mean 2.5, cluster-robust SE exactly 1)", () => {
    const r = clusterMean([1, 2, 3, 4], ["a", "a", "b", "b"]); expect(r.mean).toBe(2.5); expect(r.se).toBeCloseTo(1, 12); expect(r.lo).toBeCloseTo(2.5 - 1.96, 12); expect(r.hi).toBeCloseTo(2.5 + 1.96, 12); expect(r.clusters).toBe(2);
    expect(clusterMean([1, 2], ["a", "a"]).se).toBeNull(); expect(clusterMean([], []).mean).toBeNull();
  });
  it("clusterMean is wider than the naive interval when markets cluster (the design effect the plan warns about)", () => {
    const xs: number[] = [], cl: string[] = []; for (let g = 0; g < 10; g++) for (let k = 0; k < 10; k++) { xs.push(g + (k % 2) * 0.01); cl.push(`m${g}`); } // everything inside a market is nearly identical
    const r = clusterMean(xs, cl); const m = xs.reduce((a, b) => a + b, 0) / xs.length; const naive = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length); expect(r.se!).toBeGreaterThan(naive * 0.99);
  });
  it("verdictOf: too few pairs or markets is INSUFFICIENT_DATA; the whole interval above 0 is UNDERSTATED, below 0 OVERSTATED, straddling or touching 0 is CONFIRMED", () => {
    const d = (o: Partial<ReturnType<typeof clusterMean>>) => ({ n: 100, clusters: 20, mean: 1, se: 0.1, lo: 0.8, hi: 1.2, ...o });
    expect(verdictOf(d({ n: MIN_PAIRS - 1 }))).toBe("INSUFFICIENT_DATA"); expect(verdictOf(d({ clusters: MIN_CLUSTERS - 1 }))).toBe("INSUFFICIENT_DATA"); expect(verdictOf(d({ lo: null, hi: null }))).toBe("INSUFFICIENT_DATA");
    expect(verdictOf(d({ n: MIN_PAIRS, clusters: MIN_CLUSTERS }))).toBe("UNDERSTATED"); expect(verdictOf(d({ lo: 0.0001, hi: 1 }))).toBe("UNDERSTATED"); expect(verdictOf(d({ lo: -1, hi: -0.0001 }))).toBe("OVERSTATED");
    expect(verdictOf(d({ lo: -0.5, hi: 0.5 }))).toBe("CONFIRMED"); expect(verdictOf(d({ lo: 0, hi: 1 }))).toBe("CONFIRMED"); expect(verdictOf(d({ lo: -1, hi: 0 }))).toBe("CONFIRMED");
  });
});

describe("the paired comparison with paper REALISTIC (fixture with known answers)", () => {
  const run = (rowFor: (i: number) => RowLite, paperFor: (i: number) => PaperLite | null, n = 60) => { const a = acc(); for (let i = 1; i <= n; i++) a.add(rowFor(i), meta(i), T0, paperFor(i)); return buildReport(a, { generatedAt: "2026-10-06T00:00:00Z", days: 14 }); };
  const metric = (r: ReturnType<typeof run>, name: RegExp) => r.paired.metrics.find((m) => name.test(m.metric))!;
  it("an observed book dearer than the paper assumed is UNDERSTATED, with the arithmetic checked by hand", () => {
    const r = run((i) => mkRow(i), () => paper());
    // paper: (0.52 − 0.50)/0.52 = 3.846 % price cost, of which 1.923 moved + 1.923 spread/impact; fee 1/100 = 1 %.  observed: (0.53 − 0.50)/0.53 = 5.660 %; 1.887 moved + 3.774 spread/impact; fee 2/100 = 2 %
    const price = metric(r, /^price cost, % of stake/); expect(price.n).toBe(60); expect(price.paperMean).toBeCloseTo((0.02 / 0.52) * 100, 9); expect(price.observedMean).toBeCloseTo((0.03 / 0.53) * 100, 9);
    expect(price.diff.mean).toBeCloseTo((0.03 / 0.53 - 0.02 / 0.52) * 100, 9); expect(price.verdict).toBe("UNDERSTATED"); expect(price.observedShareOfPaper).toBeCloseTo((0.03 / 0.53) / (0.02 / 0.52), 9);
    expect(metric(r, /price moved before/).observedMean).toBeCloseTo((0.01 / 0.53) * 100, 9); expect(metric(r, /spread and impact/).observedMean).toBeCloseTo((0.02 / 0.53) * 100, 9);
    expect(metric(r, /points of price/).diff.mean).toBeCloseTo(1, 9);
    const fee = metric(r, /^fee, % of stake at the market's own rate/); expect(fee.paperMean).toBeCloseTo(1, 9); expect(fee.observedMean).toBeCloseTo(2, 9); expect(fee.verdict).toBe("UNDERSTATED");
  });
  it("an observed book exactly as dear as the paper assumed is CONFIRMED; a cheaper one is OVERSTATED", () => {
    expect(metric(run((i) => mkRow(i, { avg: 0.52 }), () => paper()), /points of price/).verdict).toBe("CONFIRMED");
    const cheaper = run((i) => mkRow(i, { avg: 0.505, mid: 0.503, fee: 0.5 }), () => paper()); expect(metric(cheaper, /points of price/).verdict).toBe("OVERSTATED"); expect(metric(cheaper, /^fee, % of stake at the market's own rate/).verdict).toBe("OVERSTATED"); expect(metric(cheaper, /^fee, % of stake at the recorded bps/).verdict).toBe("OVERSTATED");
  });
  it("noise around the paper's cost gives an interval that straddles 0 → CONFIRMED (with the sign of the mean still shown)", () => {
    const r = run((i) => mkRow(i, { avg: 0.52 + (i % 2 ? 0.004 : -0.004) * ((i % 7) + 1) / 7 }), () => paper(), 120); expect(metric(r, /points of price/).verdict).toBe("CONFIRMED");
  });
  it("many pairs on too few markets → INSUFFICIENT_DATA (the interval cannot be trusted)", () => {
    const a = acc(); for (let i = 1; i <= 60; i++) a.add(mkRow(i), meta(i, { conditionId: `c${i % 5}` }), T0, paper()); expect(metric(buildReport(a, { generatedAt: "x", days: 1 }) as any, /points of price/).verdict).toBe("INSUFFICIENT_DATA");
  });
  it("too few pairs → INSUFFICIENT_DATA, never a verdict", () => { expect(metric(run((i) => mkRow(i), () => paper(), 20), /points of price/).verdict).toBe("INSUFFICIENT_DATA"); });
  it("only valid pairs count: paper UNFILLED/UNKNOWN, a missing paper row, an unfilled observed book and a non-paired offset are all excluded", () => {
    const r = run((i) => (i % 5 === 0 ? mkRow(i, { fills: { by_usd: { "10": fill(10, null), "25": fill(25, null), "100": fill(100, null) } } as any }) : i % 7 === 0 ? mkRow(i, { offset_s: 60 }) : mkRow(i)), (i) => (i % 3 === 0 ? paper({ status: "UNFILLED" }) : i % 4 === 0 ? null : paper()), 84);
    const expected = Array.from({ length: 84 }, (_, k) => k + 1).filter((i) => i % 5 && i % 7 && i % 3 && i % 4).length; expect(r.paired.pairs).toBe(expected);
  });
  it("a fee is compared only where BOTH sides observed a rate: an assumed rate on either side drops the pair from the fee lines, not from the price lines", () => {
    const r = run((i) => mkRow(i, { feeSource: i % 2 ? "ASSUMED_UNKNOWN" : "OBSERVED_RATE" }), (i) => paper({ fee_source: i % 3 ? "OBSERVED_RATE" : "ASSUMED_UNKNOWN" }));
    const both = Array.from({ length: 60 }, (_, k) => k + 1).filter((i) => i % 2 === 0 && i % 3 !== 0).length; expect(metric(r, /^fee, % of stake at the recorded bps/).n).toBe(both); expect(metric(r, /points of price/).n).toBe(60);
  });
  it("the fee at the market's own rate needs the market's rate: an unknown rate drops the pair from that line only (the recorded-bps line is unaffected)", () => {
    const a = acc(); for (let i = 1; i <= 60; i++) a.add(mkRow(i), meta(i, { marketFee: i % 2 ? { rate: null, source: "UNKNOWN" } : { rate: 0.02, source: "OBSERVED_RATE" } }), T0, paper());
    const r = buildReport(a, { generatedAt: "x", days: 1 }); expect(metric(r, /^fee, % of stake at the market's own rate/).n).toBe(30); expect(metric(r, /^fee, % of stake at the recorded bps/).n).toBe(60); expect(metric(r, /points of price/).n).toBe(60);
  });
  it("pairs are also reported per category", () => {
    const a = acc(); for (let i = 1; i <= 60; i++) a.add(mkRow(i), meta(i, { category: i % 2 ? "sports" : "esports" }), T0, paper()); const r = buildReport(a, { generatedAt: "x", days: 1 });
    expect(Object.keys(r.paired.byCategory).sort()).toEqual(["esports", "sports"]); expect(r.paired.byCategory.sports[0].n).toBe(30);
  });
});

describe("coverage, groups and volume", () => {
  it("counts rows and signals, the status mix by offset, and the MISSED and REFUSED shares", () => {
    const a = acc(); const st = ["OK", "OK", "MISSED", "REFUSED", "ONE_SIDED", "EMPTY_BOOK", "NOT_FOUND", "ERROR", "OK", "OK"];
    st.forEach((s, i) => a.add({ ...mkRow(i + 1), status: s, offset_s: i < 5 ? 0 : 60, fills: s === "OK" ? mkRow(i + 1).fills : null }, meta(i), T0 + i, null));
    const r = buildReport(a, { generatedAt: "x", days: 14, entrySignalsInPeriod: 14 }); expect(r.coverage).toMatchObject({ rows: 10, signalsMeasured: 10, missedShare: 0.1, refusedShare: 0.1, entrySignalsInPeriod: 14, signalsWithoutRows: 4 });
    expect(r.coverage.statusByOffset["0"]).toEqual({ OK: 2, MISSED: 1, REFUSED: 1, ONE_SIDED: 1 }); expect(r.offsets).toEqual([0, 60]);
  });
  it("per-group statistics: spread quantiles in POINTS, depth, share unfillable at $25 and $100, slippage versus the wallet in points and in percent of stake, with counts", () => {
    const a = acc(); for (let i = 1; i <= 10; i++) { const avg = 0.5 + i / 100; a.add({ ...mkRow(i, { avg }), spread: i / 100, fills: { by_usd: { "10": fill(10, avg, { slippage_vs_source: avg - 0.5 }), "25": fill(25, avg, { slippage_vs_source: avg - 0.5, filled_share: i <= 3 ? 0.4 : 1 }), "100": fill(100, avg, { slippage_vs_source: avg - 0.5, filled_share: i <= 8 ? 0.2 : 1 }) } } as any }, meta(i), T0, null); }
    const g = buildReport(a, { generatedAt: "x", days: 1 }).groups.find((x) => x.key === "ALL")!;
    expect(g.spreadPts["0"]).toMatchObject({ n: 10, p50: 5.5, p90: 9.1 }); const f25 = g.fills.find((f) => f.usd === 25)!, f100 = g.fills.find((f) => f.usd === 100)!;
    expect(f25.unfillableShare).toBeCloseTo(0.3, 9); expect(f100.unfillableShare).toBeCloseTo(0.8, 9); expect(f25.n).toBe(10); expect(f25.slipPts.p50).toBeCloseTo(5.5, 9); expect(f25.slipPts.mean).toBeCloseTo(5.5, 9);
    expect(f25.slipPctStake.mean).toBeCloseTo(Array.from({ length: 10 }, (_, k) => ((k + 1) / 100 / (0.5 + (k + 1) / 100)) * 100).reduce((x, y) => x + y) / 10, 9);
    expect(g.depth["0"].ask1.n).toBe(10); expect(g.depth["0"].ask1.p50).toBeCloseTo(0.52 * 100 + 0.53 * 400, 9); expect(g.feeBps.p50).toBe(200);
  });
  it("groups: ALL, each category, each kind, and category × kind", () => {
    const a = acc(); a.add(mkRow(1), meta(1, { category: "esports", kind: "CONSENSUS" }), T0, null); const keys = buildReport(a, { generatedAt: "x", days: 1 }).groups.map((g) => g.key);
    expect(keys.sort()).toEqual(["ALL", "cat:esports", "cat:esports|kind:CONSENSUS", "kind:CONSENSUS"].sort());
  });
  it("volume: rows per day, bytes per row, megabytes at 45 days", () => {
    const a = acc(); for (let i = 1; i <= 100; i++) a.add({ ...mkRow(i), bytes: 1500 }, meta(i), T0 + (i % 2) * 86400, null); const v = buildReport(a, { generatedAt: "x", days: 2 }).volume;
    expect(v.rowsPerDay).toBe(50); expect(v.bytesPerRow).toBe(1500); expect(v.mbPer45Days).toBeCloseTo((50 * 1500 * 45) / 1e6, 9);
  });
});

describe("rendering", () => {
  const big = () => { const a = acc(); const cats = ["sports", "esports", "crypto_short_term", "crypto_other", "politics", "culture_other"]; const kinds = ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"];
    for (let i = 1; i <= 240; i++) for (const off of [0, 60, 300]) a.add({ ...mkRow(i), offset_s: off }, meta(i, { category: cats[i % 6], kind: kinds[i % 4] }), T0 + off, off === 0 ? paper() : null);
    return buildReport(a, { generatedAt: "2026-10-06T00:00:00Z", days: 14, entrySignalsInPeriod: 240 }); };
  it("the console text is at most 60 lines, states the paired offset and the 'what this is not' block", () => {
    const L = consoleLines(big(), "docs/phase4/data", ["a", "b"]); expect(L.length).toBeLessThanOrEqual(60); const t = L.join("\n");
    expect(t).toMatch(/WHAT THIS IS NOT: no number here is an edge estimate/); expect(t).toMatch(/offset 0 s is the offset nearest to the paper REALISTIC/); expect(t).toMatch(/UNDERSTATED|CONFIRMED|OVERSTATED|INSUFFICIENT_DATA/); expect(t).toMatch(/plan v3 §1 reference/);
  });
  it("an empty window says so and points at the flag and the migration, still with the 'what this is not' block", () => {
    const L = consoleLines(buildReport(acc(), { generatedAt: "x", days: 14 }), "d", []); expect(L.join("\n")).toMatch(/SHADOW_BOOKS=1.*0012/); expect(L.join("\n")).toMatch(/WHAT THIS IS NOT/);
  });
  it("the CSV files carry one row per group × offset × size and one per paired metric", () => {
    const r = big(); const g = groupsCsv(r).trim().split("\n"); expect(g[0]).toMatch(/^group,offset_s,usd/); expect(g.length).toBe(1 + r.groups.length * 3 * 3); expect(pairedCsv(r).trim().split("\n").length).toBeGreaterThan(5);
  });
});

describe("the database side is read-only and streams", () => {
  const seed = (n: number) => {
    const signals = Array.from({ length: n }, (_, i) => ({ id: uid(i + 1), kind: "NEW_POSITION", condition_id: `c${i % 15}`, title: i % 2 ? "Will Team A beat Team B (NBA)?" : "Will Bitcoin be above $100k?", slug: i % 2 ? "nba-a-b" : "btc", created_at: new Date(T0 * 1000).toISOString() }));
    const shadow_books = signals.map((s, i) => ({ ...mkRow(i + 1), source_price: "0.5", best_bid: "0.5", best_ask: "0.52", spread: "0.02", mid: "0.51", fee_rate_bps: "200", due_at: new Date((T0 + 0) * 1000).toISOString(), bids: mkRow(1).bids, asks: mkRow(1).asks }));
    const paper_executions = signals.map((s) => ({ signal_id: s.id, mode: "REALISTIC", status: "FILLED", signal_price: "0.5", market_price: "0.51", fill_price: "0.52", filled_usd: "100", entry_fee: "1", fee_source: "OBSERVED_RATE", evaluated_ts: new Date((T0 - 2) * 1000).toISOString() }));
    return { signals, shadow_books, paper_executions };
  };
  it("reads every page (more than one REPORT_PAGE), joins signals and paper rows, categorises, and makes no write and no rpc", async () => {
    const n = REPORT_PAGE * 2 + 137; const db = shadowDb(seed(n)); const r = await readReport(readOnly(db as any), { sinceIso: new Date((T0 - 86400) * 1000).toISOString(), days: 1, maxRows: 100_000, nowIso: "x" });
    expect(r.coverage.rows).toBe(n); expect(r.paired.pairs).toBe(n); expect(r.groups.map((g) => g.key)).toEqual(expect.arrayContaining(["cat:sports:basketball", "cat:crypto_short_term", "kind:NEW_POSITION"])); expect(r.paired.evalGapMedianS).toBe(2); expect(r.groups.find((g) => g.key === "ALL")!.feeBps.p50).toBe(200); expect(r.groups.find((g) => g.key === "ALL")!.spreadPts["0"].p50).toBeCloseTo(2, 9); expect(r.coverage.entrySignalsInPeriod).toBe(n);
    expect(db.writes).toEqual([]); expect(db.calls.filter((c) => c.op !== "from" && c.op !== "select")).toEqual([]);
    expect(db.calls.filter((c) => c.table === "shadow_books" && c.op === "select").length).toBe(4); // one query per page (3) plus the one-row start query; never the whole table at once
  });
  it("the wrapper exposes no write method and no rpc at all", () => { const ro = readOnly(shadowDb() as any) as any; for (const k of ["insert", "upsert", "update", "delete", "rpc", "from"]) expect(ro[k]).toBeUndefined(); expect(Object.keys(ro)).toEqual(["select"]); });
  it("a window above --max-rows is refused loudly, never silently truncated", async () => { await expect(readReport(readOnly(shadowDb(seed(50)) as any), { sinceIso: "2000-01-01T00:00:00Z", days: 1, maxRows: 10, nowIso: "x" })).rejects.toThrow(/more than 10 rows/); });
  it("a database error is reported, not swallowed", async () => { const db = shadowDb(seed(5), { failOn: (t) => (t === "shadow_books" ? new Error("boom") : null) }); await expect(readReport(readOnly(db as any), { sinceIso: "2000-01-01T00:00:00Z", days: 1, maxRows: 100, nowIso: "x" })).rejects.toThrow(/boom/); });
  it("the CLI: missing database variables → exit 2 and the database is not touched; a bad --since → exit 2; --help prints usage", async () => {
    const out: string[] = []; const db = shadowDb(seed(3));
    expect(await runShadowReportCli([], {}, { log: (l) => out.push(l) })).toBe(2); expect(out.join("\n")).toMatch(/database was not touched/); expect(db.calls).toHaveLength(0);
    expect(await runShadowReportCli(["--since", "yesterday"], {}, { db: () => readOnly(db as any), log: (l) => out.push(l) })).toBe(2); expect(db.calls).toHaveLength(0);
    out.length = 0; expect(await runShadowReportCli(["--help"], {}, { log: (l) => out.push(l) })).toBe(0); expect(out[0]).toMatch(/^usage: npm run phase4:shadow-report/);
  });
  it("the CLI end to end: ≤ 60 console lines, six files written, --print-files returns a file between markers, exit 0", async () => {
    const out: string[] = []; const files = new Map<string, string>(); const db = shadowDb(seed(40));
    const code = await runShadowReportCli(["--since", new Date((T0 - 86400) * 1000).toISOString(), "--print-files", "shadow_report.md"], {}, { db: () => readOnly(db as any), now: () => T0 * 1000, log: (l) => out.push(l), writeFile: (p, c) => files.set(p, c), readFile: (p) => files.get(p) ?? null, mkdir: () => {}, sleep: async () => {} });
    expect(code).toBe(0); expect([...files.keys()].sort()).toEqual(["docs/phase4/data/shadow_fees.csv", "docs/phase4/data/shadow_groups.csv", "docs/phase4/data/shadow_paired.csv", "docs/phase4/data/shadow_passive.csv", "docs/phase4/data/shadow_report.json", "docs/phase4/data/shadow_report.md"]);
    const marker = out.indexOf("=====FILE shadow_report.md"); expect(marker).toBeGreaterThan(0); expect(out.slice(0, marker).length).toBeLessThanOrEqual(60); expect(out.at(-1)).toBe("=====END shadow_report.md"); expect(db.writes).toEqual([]);
  });
});
