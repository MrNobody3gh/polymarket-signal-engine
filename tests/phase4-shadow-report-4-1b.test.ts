import { describe, expect, it } from "vitest";
import { ReportAcc, buildReport, consoleLines, fullMarkdown, groupsCsv, passiveCsv, feeRelationCsv, MIN_CELL, type PaperLite, type RowLite, type SignalMeta } from "@/lib/phase4/shadow/report";
import { readReport, readStart, runShadowReportCli } from "@/lib/phase4/shadow/report-cli";
import { decisionLines, powerLines } from "@/lib/phase4/shadow/decision";
import { RETURN_SD_PTS, nForHalfWidth, nForPower, nFromSe } from "@/lib/phase4/shadow/report-math";
import { takerFee } from "@/lib/phase4/shadow/fee";
import { categorize, stratum } from "@/lib/phase4/categorize";
import { readOnly } from "@/lib/phase4/readonly-db";
import { shadowDb } from "./helpers/shadowDb";
import { T0, uid } from "./helpers/shadowWorld";

const OFFS = [0, 60, 300];
const acc = (o: { startSec?: number | null } = {}) => new ReportAcc({ sizes: [10, 25, 100], pairOffset: 0, offsets: OFFS, ...o });
const iso = (sec: number) => new Date(sec * 1000).toISOString();
/** a row whose fills are single-level at `avg`, fee charged at the RECORDED rate (bps) with the paper function, so every number is known by hand */
function row(i: number, offset: number, o: { status?: string; bid?: number; ask?: number; avg?: number; source?: number; bps?: number | null; asks?: [number, number][] } = {}): RowLite {
  const status = o.status ?? "OK"; const source = o.source ?? 0.5; const avg = o.avg ?? 0.53; const bps = o.bps === undefined ? 1000 : o.bps; const rate = bps === null ? 0.05 : bps / 10_000;
  const f = (usd: number) => ({ usd_requested: usd, filled_usd: usd, shares: usd / avg, avg_price: avg, limit_price: avg, slippage_vs_source: avg - source, slippage_vs_mid: avg - 0.51, filled_share: 1, fee_usd: takerFee(usd / avg, avg, rate), below_min_order: false });
  const ok = status === "OK"; const bid = o.bid ?? 0.5, ask = o.ask ?? 0.52;
  return { signal_id: uid(i), offset_s: offset, status, source_price: source, best_bid: ok ? bid : null, best_ask: ok ? ask : null, spread: ok ? ask - bid : null, mid: ok ? (ask + bid) / 2 : null,
    bids: ok ? [[bid, 100]] : null, asks: ok ? o.asks ?? [[ask, 100000]] : null, fills: ok ? { by_usd: { "10": f(10), "25": f(25), "100": f(100) } } : null, fee_rate_bps: ok ? bps : null, fee_source: ok ? (bps === null ? "ASSUMED_UNKNOWN" : bps === 0 ? "OBSERVED_FEE_FREE" : "OBSERVED_RATE") : null, bytes: 1000 };
}
const meta = (i: number, o: Partial<SignalMeta> = {}): SignalMeta => ({ kind: "NEW_POSITION", category: "sports:basketball", conditionId: `c${i % 15}`, marketFee: { rate: 0.05, source: "OBSERVED_RATE" }, ...o });
const paper = (o: Partial<PaperLite> = {}): PaperLite => ({ status: "FILLED", signal_price: 0.5, market_price: 0.51, fill_price: 0.52, filled_usd: 100, entry_fee: 2.5, fee_source: "OBSERVED_RATE", evaluated_gap_s: 2, ...o });
const report = (a: ReportAcc, o: { entry?: number } = {}) => buildReport(a, { generatedAt: "2026-10-08T00:00:00Z", days: 14, entrySignalsInPeriod: o.entry });
const group = (r: ReturnType<typeof report>, key: string) => r.groups.find((g) => g.key === key)!;

describe("Part B1: the start-up back-fill is excluded from the statistics and reported apart", () => {
  const START = T0;
  const feed = (a: ReportAcc) => {
    let i = 1;
    for (let k = 0; k < 10; k++, i++) a.add(row(i, 0, { status: "MISSED" }), meta(i), START - 100, null); // back-fill: due before the first OK snapshot
    for (let k = 0; k < 5; k++, i++) a.add(row(i, 0, { status: "MISSED" }), meta(i), START, null); // due exactly at the start: a real miss
    for (let k = 0; k < 5; k++, i++) a.add(row(i, 0, { status: "MISSED" }), meta(i), START + 50, null); // after the start: a real miss
    for (let k = 0; k < 3; k++, i++) a.add(row(i, 0, { status: "ERROR" }), meta(i), START - 100, null); // an error before the start is not back-fill (only MISSED is)
    for (let k = 0; k < 20; k++, i++) a.add(row(i, 0), meta(i), START + 10, null);
  };
  it("MISSED rows due before the start are counted apart and take part in no figure; rows at the boundary and after it are counted", () => {
    const a = acc({ startSec: START }); feed(a); const r = report(a);
    expect(r.backfill).toMatchObject({ rows: 10, signals: 10, startIso: iso(START) }); expect(r.coverage.rows).toBe(5 + 5 + 3 + 20); expect(r.coverage.statusByOffset["0"]).toEqual({ MISSED: 10, ERROR: 3, OK: 20 });
    expect(r.coverage.missedShare).toBeCloseTo(10 / 33, 12); expect(r.coverage.signalsMeasured).toBe(33); expect(group(r, "ALL").rows).toBe(33);
  });
  it("without a known start nothing is excluded (no OK snapshot exists yet)", () => {
    const a = acc({ startSec: null }); feed(a); const r = report(a); expect(r.backfill).toMatchObject({ rows: 0, signals: 0, startIso: null }); expect(r.coverage.rows).toBe(43); expect(r.coverage.missedShare).toBeCloseTo(20 / 43, 12);
  });
  it("the same feed without the cut would overstate the missed share (the point of Part B1)", () => { const cut = acc({ startSec: START }); feed(cut); const raw = acc(); feed(raw); expect(report(cut).coverage.missedShare!).toBeLessThan(report(raw).coverage.missedShare!); });
  it("back-fill signals are not 'signals with no row': the entry-signal count is reconciled", () => {
    const a = acc({ startSec: START }); feed(a); expect(report(a, { entry: 43 }).coverage.signalsWithoutRows).toBe(0); expect(report(a, { entry: 45 }).coverage.signalsWithoutRows).toBe(2);
    // a signal with a back-fill row AND a later OK row is measured, and is not subtracted twice
    const b = acc({ startSec: START }); b.add(row(1, 0, { status: "MISSED" }), meta(1), START - 100, null); b.add(row(1, 60), meta(1), START + 10, null); expect(report(b, { entry: 1 }).coverage).toMatchObject({ signalsMeasured: 1, signalsWithoutRows: 0 }); expect(report(b).backfill.signals).toBe(1);
  });
  it("the console and the Markdown say it, with n; and say so when no OK snapshot exists", () => {
    const a = acc({ startSec: START }); feed(a); expect(consoleLines(report(a), "d", []).join("\n")).toMatch(/BACK-FILL AT START-UP \(n=10 rows, 10 signals\) excluded from every figure.*first OK snapshot/);
    const b = acc(); feed(b); expect(consoleLines(report(b), "d", []).join("\n")).toMatch(/BACK-FILL AT START-UP {2}no OK snapshot exists yet/);
  });
  it("a window holding only back-fill says so instead of printing an empty report", () => { const a = acc({ startSec: START }); a.add(row(1, 0, { status: "MISSED" }), meta(1), START - 5, null); expect(consoleLines(report(a), "d", []).join("\n")).toMatch(/1 start-up back-fill rows were excluded/); });
});

describe("Part B1 on the database: the start is the earliest OK snapshot of the WHOLE table", () => {
  const sig = (i: number, title: string, slug: string, ageS = 0) => ({ id: uid(i), kind: "NEW_POSITION", condition_id: `c${i}`, title, slug, created_at: iso(T0 + ageS) });
  const sb = (i: number, offset: number, due: number, taken: number, status: string, o: Record<string, any> = {}) => ({ ...(status === "OK" ? { ...row(i, offset), source_price: "0.5", best_bid: "0.5", best_ask: "0.52", spread: "0.02", mid: "0.51" } : { ...row(i, offset, { status }), fills: null }), due_at: iso(due), taken_at: iso(taken), ...o });
  it("readStart: the earliest OK taken_at, ignoring MISSED and ERROR rows, even outside any window; null when there is no OK row", async () => {
    const db = shadowDb({ shadow_books: [sb(1, 0, T0 - 500, T0 - 400, "MISSED"), sb(2, 0, T0 - 300, T0 - 200, "ERROR"), sb(3, 0, T0 - 100, T0 - 50, "OK"), sb(4, 0, T0, T0 + 5, "OK")] });
    expect(await readStart(readOnly(db as any))).toBe(T0 - 50); expect(await readStart(readOnly(shadowDb({ shadow_books: [sb(1, 0, T0, T0, "MISSED")] }) as any))).toBeNull(); expect(await readStart(readOnly(shadowDb() as any))).toBeNull();
    expect(db.writes).toEqual([]);
  });
  it("readReport: MISSED rows due before the start are excluded; a window that begins after the start still counts later MISSED rows as real", async () => {
    const t1 = T0 + 1000; // the first OK snapshot is taken at t1 − 5
    const sigs = [1, 2, 3, 4, 5, 6].map((i) => sig(i, "Will Team A beat Team B (NBA)?", "nba-a-b"));
    const books = [sb(1, 0, T0, t1 + 20, "MISSED"), sb(2, 0, T0 + 10, t1 + 20, "MISSED"), sb(3, 0, t1, t1 - 5, "OK"), sb(4, 0, t1 + 500, t1 + 500, "MISSED"), sb(5, 0, t1 + 600, t1 + 600, "OK"), sb(6, 0, t1 + 700, t1 + 700, "MISSED")];
    const db = shadowDb({ signals: sigs, shadow_books: books, markets: [] });
    const all = await readReport(readOnly(db as any), { sinceIso: iso(T0 - 10), days: 1, maxRows: 1000, nowIso: "x" });
    expect(all.backfill.rows).toBe(2); expect(all.coverage.rows).toBe(4); expect(all.coverage.missedShare).toBeCloseTo(2 / 4, 12);
    // a window that starts after the back-fill: the start must still come from the whole table, so the late MISSED rows are NOT mistaken for back-fill
    const late = await readReport(readOnly(db as any), { sinceIso: iso(t1 + 400), days: 1, maxRows: 1000, nowIso: "x" });
    expect(late.backfill.rows).toBe(0); expect(late.coverage.rows).toBe(3); expect(late.coverage.statusByOffset["0"]).toEqual({ MISSED: 2, OK: 1 }); expect(db.writes).toEqual([]);
  });
});

describe("Part B2: every table is grouped by category (sports by league) and kind, thin cells are marked", () => {
  const CASES: [string, string, string][] = [
    ["Will Team A beat Team B (NBA)?", "nba-a-b", "sports:basketball"], ["Cowboys vs Giants: spread", "nfl-dal-nyg", "sports:american_football"], ["Premier League: Arsenal vs Chelsea", "epl-ars-che", "sports:soccer"],
    ["Counter-Strike: Navi vs Vitality (BO3)", "cs2-navi-vit", "esports"], ["Will Bitcoin be above $100k on Oct 10 at 5pm ET?", "btc-above-100k-oct-10", "crypto_short_term"], ["Will an Ethereum ETF allow staking in 2026?", "eth-etf-staking", "crypto_other"],
    ["Will Trump win the 2028 presidential election?", "trump-2028", "politics"], ["Will Taylor Swift release a new album in 2026?", "taylor-album", "culture_other"],
  ];
  it("the categoriser's stratum labels for fixture titles and slugs (sports split by league)", () => { for (const [title, slug, want] of CASES) expect(stratum(categorize({ title, slug })), title).toBe(want); });
  it("readReport groups by the stratum label and by kind, and by both", async () => {
    const sigs = CASES.map(([title, slug], k) => ({ id: uid(k + 1), kind: k % 2 ? "CONSENSUS" : "NEW_POSITION", condition_id: `c${k}`, title, slug, created_at: iso(T0) }));
    const books = sigs.map((s, k) => ({ ...row(k + 1, 0), source_price: "0.5", best_bid: "0.5", best_ask: "0.52", spread: "0.02", mid: "0.51", due_at: iso(T0), taken_at: iso(T0) }));
    const r = await readReport(readOnly(shadowDb({ signals: sigs, shadow_books: books }) as any), { sinceIso: iso(T0 - 10), days: 1, maxRows: 100, nowIso: "x" });
    const keys = r.groups.map((g) => g.key); for (const [, , want] of CASES) expect(keys).toContain(`cat:${want}`); expect(keys).toEqual(expect.arrayContaining(["kind:CONSENSUS", "kind:NEW_POSITION", "cat:esports|kind:CONSENSUS", "cat:sports:basketball|kind:NEW_POSITION"]));
    expect(r.decision.map((d) => d.category)).toEqual(expect.arrayContaining(["ALL", "esports", "sports:basketball", "politics"]));
  });
  it(`a cell with fewer than ${MIN_CELL} signals is marked "too few" (29 is, 30 is not), in the data and in the printed tables`, () => {
    const a = acc(); for (let i = 1; i <= 29; i++) a.add(row(i, 0), meta(i, { category: "esports" }), T0, null); for (let i = 100; i < 130; i++) a.add(row(i, 0), meta(i, { category: "politics" }), T0, null);
    const r = report(a); expect(group(r, "cat:esports")).toMatchObject({ signalsOk: 29, tooFew: true }); expect(group(r, "cat:politics")).toMatchObject({ signalsOk: 30, tooFew: false }); expect(group(r, "ALL").tooFew).toBe(false);
    const lines = decisionLines(r.decision, 8, 0, 25); expect(lines.find((l) => l.startsWith("esports"))).toMatch(/too few$/); expect(lines.find((l) => l.startsWith("politics"))).not.toMatch(/too few/);
    expect(fullMarkdown(r, "d", []).join("\n")).toMatch(/esports[^\n]*too few/); expect(groupsCsv(r).split("\n").find((l) => l.startsWith("cat:esports,0,25"))).toMatch(/,29,true,/);
  });
});

describe("Part A: the fee at the market's own rate, with the recorded-bps fee beside it", () => {
  // $25 at 0.50: 50 shares; at 0.10 the fee is 50 × 0.10 × 0.25 = 1.25 (5 % of stake); at the market's 0.05 it is 0.625 (2.5 %)
  it("the recorded 1000 bps against a market rate of 0.05: 5 % of stake recorded, 2.5 % at the market's rate, relation CONSTANT_MULTIPLE ×2", () => {
    const a = acc(); for (let i = 1; i <= 60; i++) a.add(row(i, 0, { avg: 0.5, bps: 1000 }), meta(i), T0, null); const r = report(a); const f = group(r, "ALL").fills.find((x) => x.usd === 25)!;
    expect(f.feeRecordedPct.mean).toBeCloseTo(5, 9); expect(f.feeMarketPct.mean).toBeCloseTo(2.5, 9); expect(f.feeMarketPct.n).toBe(60); expect(f.feeMarketUnknown).toBe(0);
    expect(group(r, "ALL").feeRelation).toMatchObject({ relation: "CONSTANT_MULTIPLE", pairs: 60 }); expect(group(r, "ALL").feeRelation.multiple).toBeCloseTo(2, 9); expect(group(r, "cat:sports:basketball").feeRelation.relation).toBe("CONSTANT_MULTIPLE");
    const text = consoleLines(r, "d", []).join("\n"); expect(text).toMatch(/FEE RATE: the recorded fee_rate_bps ÷ 10 000 against the market's own rate/); expect(text).toMatch(/CONSTANT_MULTIPLE ×2\.00/);
  });
  it("equal rates → EQUAL and both fee columns agree", () => {
    const a = acc(); for (let i = 1; i <= 40; i++) a.add(row(i, 0, { avg: 0.5, bps: 500 }), meta(i), T0, null); const r = report(a); const f = group(r, "ALL").fills.find((x) => x.usd === 25)!; expect(group(r, "ALL").feeRelation.relation).toBe("EQUAL"); expect(f.feeMarketPct.mean).toBeCloseTo(f.feeRecordedPct.mean!, 9);
  });
  it("an unknown market rate is shown as unknown, never guessed: no market-rate fee, the recorded fee still shown, relation UNKNOWN, every unknown counted", () => {
    const a = acc(); for (let i = 1; i <= 60; i++) a.add(row(i, 0, { avg: 0.5, bps: 1000 }), meta(i, { marketFee: { rate: null, source: "UNKNOWN" } }), T0, null); const r = report(a); const f = group(r, "ALL").fills.find((x) => x.usd === 25)!;
    expect(f.feeMarketPct.n).toBe(0); expect(f.feeMarketPct.mean).toBeNull(); expect(f.feeMarketUnknown).toBe(60); expect(f.feeRecordedPct.mean).toBeCloseTo(5, 9); expect(group(r, "ALL").feeRelation).toMatchObject({ relation: "UNKNOWN", pairs: 0, noMarketRate: 60 });
  });
  it("a meta without a marketFee at all behaves as unknown (old callers)", () => { const a = acc(); a.add(row(1, 0), { kind: "NEW_POSITION", category: "x", conditionId: "c" }, T0, null); expect(group(report(a), "ALL").fills[0].feeMarketUnknown).toBe(1); });
  it("a fee-free market (OBSERVED_FEE_FREE, rate 0) gives a fee of exactly 0 against the recorded 5 %", () => {
    const a = acc(); for (let i = 1; i <= 40; i++) a.add(row(i, 0, { avg: 0.5, bps: 1000 }), meta(i, { marketFee: { rate: 0, source: "OBSERVED_FEE_FREE" } }), T0, null); const f = group(report(a), "ALL").fills.find((x) => x.usd === 25)!; expect(f.feeMarketPct.mean).toBe(0); expect(f.feeRecordedPct.mean).toBeCloseTo(5, 9);
  });
  it("0 bps recorded against a market that charges: the stored asks are walked again at the market's rate", () => {
    const a = acc(); for (let i = 1; i <= 40; i++) a.add(row(i, 0, { avg: 0.5, ask: 0.5, bid: 0.48, bps: 0 }), meta(i), T0, null); const f = group(report(a), "ALL").fills.find((x) => x.usd === 25)!;
    expect(f.feeRecordedPct.mean).toBe(0); expect(f.feeMarketPct.mean).toBeCloseTo(2.5, 6); expect(group(report(a), "ALL").feeRelation.relation).toBe("UNRELATED");
  });
  it("the paired comparison with paper uses the market's rate for the observed side, and the recorded-bps fee on its own line beside it", () => {
    // $100 at 0.53: the fee as a share of stake is rate × (1 − p): at the market's 0.05 it is 2.35 %, at the recorded 1000 bps (0.10) 4.7 %; the paper fee here is 2.5 %
    const a = acc(); for (let i = 1; i <= 60; i++) a.add(row(i, 0, { avg: 0.53, bps: 1000 }), meta(i), T0, paper({ entry_fee: 2.5 })); const ms = report(a).paired.metrics;
    const mk = ms.find((m) => /^fee, % of stake at the market's own rate/.test(m.metric))!, rec = ms.find((m) => /^fee, % of stake at the recorded bps/.test(m.metric))!;
    expect(mk.observedMean).toBeCloseTo(2.35, 6); expect(rec.observedMean).toBeCloseTo(4.7, 6); expect(mk.paperMean).toBeCloseTo(2.5, 9); expect(mk.diff.mean).toBeCloseTo(-0.15, 6); expect(rec.diff.mean).toBeCloseTo(2.2, 6);
  });
  it("the fee-relation CSV and the Markdown carry the distribution and the verdict", () => {
    const a = acc(); for (let i = 1; i <= 60; i++) a.add(row(i, 0, { avg: 0.5, bps: 1000 }), meta(i), T0, null); const r = report(a);
    expect(feeRelationCsv(r)).toMatch(/ALL,60,CONSTANT_MULTIPLE,2,/); expect(fullMarkdown(r, "d", []).join("\n")).toMatch(/recorded bps \(top\) 1000×60 · market rate \(top\) 0\.05×60/);
  });
});

describe("Part C through the report: passive indicator per group, bounded memory", () => {
  /** one signal with three snapshots at 0/60/300 s; the bid at 0 is 0.50 */
  const feedSignal = (a: ReportAcc, i: number, due: number, asks: [number | null, number | null], m: Partial<SignalMeta> = {}) => {
    a.add(row(i, 0, { bid: 0.5, ask: 0.52, avg: 0.53, source: 0.52 }), meta(i, m), due, null);
    a.add(asks[0] === null ? row(i, 60, { status: "MISSED" }) : row(i, 60, { bid: asks[0]! - 0.02, ask: asks[0]! }), meta(i, m), due + 60, null);
    a.add(asks[1] === null ? row(i, 300, { status: "MISSED" }) : row(i, 300, { bid: asks[1]! - 0.02, ask: asks[1]! }), meta(i, m), due + 300, null);
  };
  it("shares touched by 60 s and by 300 s, by group; the improvement over the taker fill and the avoided fee for the touched", () => {
    const a = acc(); feedSignal(a, 1, T0, [0.5, 0.6]); feedSignal(a, 2, T0 + 1, [0.55, 0.5]); feedSignal(a, 3, T0 + 2, [0.55, 0.6]); feedSignal(a, 4, T0 + 3, [0.55, 0.6]); feedSignal(a, 5, T0 + 4, [null, 0.4]);
    const r = report(a); const p = r.passive.ALL.bid;
    expect(p.eligible).toBe(5); expect(p.rows).toEqual([{ offset: 60, known: 4, touched: 1, share: 0.25 }, { offset: 300, known: 4, touched: 2, share: 0.5 }]);
    expect(p.touchedDetail.n).toBe(2); expect(p.touchedDetail.improvementPts.mean).toBeCloseTo(3, 9); // taker 0.53 vs limit 0.50
    expect(p.touchedDetail.avoidedFeePct.mean).toBeCloseTo(2.35, 6); expect(p.touchedDetail.belowSourceShare).toBe(1); expect(p.touchedDetail.firstTouchLateShare).toBe(0.5); // touched at 0.50 and 0.50 against the wallet at 0.52; one of the two only at 300 s
  });
  it("the avoided fee is the taker fee at the market's own rate (% of stake): 0.05 × p × (1 − p) ÷ p at the taker's average price", () => {
    const a = acc(); feedSignal(a, 1, T0, [0.5, 0.6]); const d = report(a).passive.ALL.bid.touchedDetail; expect(d.avoidedFeePct.mean).toBeCloseTo(0.05 * (1 - 0.53) * 100, 6);
  });
  it("an unknown market rate leaves the avoided fee unknown (counted), not zero", () => {
    const a = acc(); feedSignal(a, 1, T0, [0.5, 0.6], { marketFee: { rate: null, source: "UNKNOWN" } }); const d = report(a).passive.ALL.bid.touchedDetail; expect(d.n).toBe(1); expect(d.avoidedFeePct.n).toBe(0); expect(d.avoidedFeeUnknown).toBe(1);
  });
  it("groups: the indicator exists for ALL, each category, each kind and the pair; the CSV has a row per group, limit and later offset", () => {
    const a = acc(); feedSignal(a, 1, T0, [0.5, 0.6], { category: "esports", kind: "CONSENSUS" }); const r = report(a); expect(Object.keys(r.passive).sort()).toEqual(["ALL", "cat:esports", "cat:esports|kind:CONSENSUS", "kind:CONSENSUS"]);
    expect(passiveCsv(r).trim().split("\n").length).toBe(1 + 4 * 2 * 2);
  });
  it("a signal whose later snapshots never arrived is evaluated at flush (eligible, nothing known); flush is idempotent", () => {
    const a = acc(); a.add(row(1, 0), meta(1), T0, null); const r = report(a); expect(r.passive.ALL.bid).toMatchObject({ eligible: 1 }); expect(r.passive.ALL.bid.rows.every((x) => x.known === 0 && x.share === null)).toBe(true); a.flush(); expect(report(a).passive.ALL.bid.eligible).toBe(1);
  });
  it("memory: in due order the per-signal bookkeeping holds only signals still waiting for their last snapshot (≈ 300 s of signals), however many pass", () => {
    const a = acc(); const rows: [number, RowLite][] = [];
    for (let i = 1; i <= 2000; i++) for (const o of OFFS) rows.push([T0 + i * 10 + o, row(i, o)]);
    rows.sort((x, y) => x[0] - y[0]); for (const [due, r] of rows) a.add(r, meta(Number(r.signal_id.slice(-12))), due, null);
    expect(a.pendingMax).toBeLessThanOrEqual(35); expect(report(a).passive.ALL.bid.eligible).toBe(2000);
  });
  it("the console prints the indicator with its label: not a fill rate, not evidence of profit, and not a strict bound", () => {
    const a = acc(); feedSignal(a, 1, T0, [0.5, 0.6]); const t = consoleLines(report(a), "d", []).join("\n"); expect(t).toMatch(/PASSIVE BUY INDICATOR \(ALL\) — NOT a fill rate, NOT evidence of profit, and not a strict bound/); expect(t).toMatch(/at best bid +by 60 s 100% \(1\/1\) · by 300 s 100% \(1\/1\)/);
  });
});

describe("Part D: the decision table, interval arithmetic and the power note", () => {
  it("one row per category plus ALL first, ordered by signals, each with its own sample size; the paired comparison uses the same signals", () => {
    const a = acc(); for (let i = 1; i <= 80; i++) a.add(row(i, 0, { avg: 0.53 }), meta(i, { category: i <= 50 ? "sports:soccer" : "esports" }), T0, paper());
    const r = report(a); expect(r.decision.map((d) => [d.category, d.signals])).toEqual([["ALL", 80], ["sports:soccer", 50], ["esports", 30]]);
    const s = r.decision[1]; expect(s.spreadP50Pts).toBeCloseTo(2, 9); expect(s.slipPtsP50).toBeCloseTo(3, 9); expect(s.slipPctP50).toBeCloseTo((0.03 / 0.53) * 100, 9); expect(s.feeMarketPct.n).toBe(50);
    expect(s.paper.pairs).toBe(50); expect(s.paper.pts!.diff.mean).toBeCloseTo(1, 9); expect(s.passiveBid).not.toBeNull();
    const lines = decisionLines(r.decision, 8, 0, 25); expect(lines[0]).toMatch(/^DECISION TABLE at offset 0 s, \$25 taker buy/); expect(lines.length).toBe(2 + 3);
  });
  it("the table is capped on the console with a pointer to the file", () => {
    const a = acc(); for (let i = 1; i <= 60; i++) a.add(row(i, 0), meta(i, { category: `cat${i % 12}` }), T0, null); const lines = decisionLines(report(a).decision, 8, 0, 25); expect(lines.length).toBe(2 + 8 + 1); expect(lines.at(-1)).toMatch(/… 5 more strata in shadow_report.md/);
  });
  it("interval arithmetic: the 95 % interval of a mean is mean ± 1.96 × the cluster-robust standard error (hand-checked fixture)", () => {
    // clusters m0 (4 signals at 3 points) and m1 (4 signals at 5 points): mean 4, cluster sums 12 and 20 → SE = sqrt(2/1 × ((12−16)² + (20−16)²)) / 8 = sqrt(64)/8 = 1
    const a = acc(); for (let i = 1; i <= 8; i++) a.add(row(i, 0, { avg: i <= 4 ? 0.53 : 0.55 }), meta(i, { conditionId: i <= 4 ? "m0" : "m1" }), T0, null); const f = group(report(a), "ALL").fills.find((x) => x.usd === 25)!;
    expect(f.slipPtsCi.mean).toBeCloseTo(4, 9); expect(f.slipPtsCi.se).toBeCloseTo(1, 9); expect(f.slipPtsCi.lo).toBeCloseTo(4 - 1.96, 9); expect(f.slipPtsCi.hi).toBeCloseTo(4 + 1.96, 9); expect(f.slipPtsCi.clusters).toBe(2);
  });
  it("sample-size arithmetic: ±5 points at SD 88 needs 1,190 trades; 80 % power for a 5-point difference needs 2,432; from an observed standard error the signals needed for ±1 point", () => {
    expect(RETURN_SD_PTS).toBe(88); expect(nForHalfWidth(88, 5)).toBe(1190); expect(nForPower(88, 5)).toBe(2432); expect(nFromSe(100, 0.5, 1)).toBe(97); expect(nFromSe(100, 0.5, 2)).toBe(25);
    expect(nFromSe(100, null, 1)).toBeNull(); expect(nFromSe(100, 0, 1)).toBeNull(); expect(nFromSe(0, 0.5, 1)).toBeNull(); expect(nFromSe(100, 0.5, 0)).toBeNull();
  });
  it("the power note names what is a cost (hundreds of signals) and what would need outcomes (1,000+ settled trades), with the owner's SD", () => {
    const a = acc(); for (let i = 1; i <= 40; i++) a.add(row(i, 0, { avg: 0.52 + (i % 5) / 100 }), meta(i, { conditionId: `m${i % 10}` }), T0, null); const t = powerLines(report(a).power).join("\n");
    expect(t).toMatch(/OUTCOMES \(does following pay\) are not in this report/); expect(t).toMatch(/SD of about 88 points/); expect(t).toMatch(/1,190 settled trades/); expect(t).toMatch(/2,432/); expect(t).toMatch(/1,000\+ settled trades each/); expect(t).toMatch(/COSTS .*readable at hundreds/); expect(t).toMatch(/±1 point of taker slippage at \$25 needs about [\d,]+ signals \(40 measured\)/);
  });
  it("with no interval yet (one market), the note says so instead of inventing a number", () => { const a = acc(); for (let i = 1; i <= 5; i++) a.add(row(i, 0), meta(i, { conditionId: "same" }), T0, null); expect(powerLines(report(a).power).join("\n")).toMatch(/an unknown number of \(no interval yet\)/); });
});

describe("outputs: limits, files and the read-only database", () => {
  const stratumNames = ["sports:basketball", "sports:soccer", "sports:american_football", "sports:tennis", "esports", "crypto_short_term", "crypto_other", "politics", "culture_other", "sports:baseball", "sports:hockey", "sports:combat"];
  const big = () => {
    const a = acc({ startSec: T0 - 5 }); const kinds = ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"]; const rows: [number, RowLite, SignalMeta, PaperLite | null][] = [];
    for (let i = 1; i <= 360; i++) { const m = meta(i, { category: stratumNames[i % 12], kind: kinds[i % 4], conditionId: `c${i % 40}` }); for (const o of OFFS) rows.push([T0 + i + o, row(i, o, { ask: 0.52 - (o ? (i % 3) / 100 : 0), bid: 0.5 - (o ? (i % 3) / 100 : 0) }), m, o === 0 ? paper() : null]); }
    rows.sort((x, y) => x[0] - y[0]); for (const [due, r, m, p] of rows) a.add(r, m, due, p); for (let i = 1000; i < 1010; i++) a.add(row(i, 0, { status: "MISSED" }), meta(i), T0 - 100, null);
    return report(a, { entry: 370 });
  };
  it("the console is at most 60 lines with twelve strata, names every section, and the 'what this is not' block", () => {
    const L = consoleLines(big(), "docs/phase4/data", ["a", "b", "c", "d", "e", "f"]); expect(L.length).toBeLessThanOrEqual(60); const t = L.join("\n");
    for (const re of [/COVERAGE/, /BACK-FILL AT START-UP \(n=10 rows/, /FEE RATE:/, /DECISION TABLE/, /PASSIVE BUY INDICATOR \(ALL\)/, /PAIRED WITH PAPER REALISTIC/, /POWER NOTE/, /VOLUME/, /WHAT THIS IS NOT/, /not evidence of profit/, /more strata in shadow_report.md/]) expect(t).toMatch(re);
  });
  it("the Markdown carries every stratum, kind and combination, the intervals and the paired lines by stratum; the CSVs have the new columns", () => {
    const r = big(); const md = fullMarkdown(r, "d", []).join("\n"); for (const h of ["Every stratum, kind and combination", "Decision table with means and 95 % intervals", "recorded bps against the market's own rate", "Passive buys (an indicator, not a fill rate)", "Paired with paper REALISTIC, by stratum"]) expect(md).toContain(h);
    for (const s of stratumNames) expect(md).toContain(s); expect(groupsCsv(r).split("\n")[0]).toMatch(/slip_pts_lo95.*fee_market_pct_stake_mean.*fee_recorded_pct_stake_mean/); expect(fullMarkdown(r, "d", []).length).toBeGreaterThan(consoleLines(r, "d", []).length);
  });
  const seed = (n: number) => {
    const signals = Array.from({ length: n }, (_, i) => ({ id: uid(i + 1), kind: "NEW_POSITION", condition_id: `C${i % 15}`, title: "Will Team A beat Team B (NBA)?", slug: "nba-a-b", created_at: iso(T0) }));
    const shadow_books = signals.map((s, i) => ({ ...row(i + 1, 0), source_price: "0.5", best_bid: "0.5", best_ask: "0.52", spread: "0.02", mid: "0.51", fee_rate_bps: "1000", due_at: iso(T0), taken_at: iso(T0) }));
    const markets = Array.from({ length: 15 }, (_, k) => ({ condition_id: `c${k}`, fees_enabled: "true", taker_fee_rate: "0.05" })); // lower case, as the paper path stores them
    const paper_executions = signals.map((s) => ({ signal_id: s.id, mode: "REALISTIC", status: "FILLED", signal_price: "0.5", market_price: "0.51", fill_price: "0.52", filled_usd: "100", entry_fee: "2.5", fee_source: "OBSERVED_RATE", evaluated_ts: iso(T0 - 2) }));
    return { signals, shadow_books, markets, paper_executions };
  };
  it("reads the market's rate (case-insensitive condition ids), recomputes the fee, and touches only four tables with select and nothing else", async () => {
    const db = shadowDb(seed(60)); const r = await readReport(readOnly(db as any), { sinceIso: iso(T0 - 10), days: 1, maxRows: 1000, nowIso: "x" });
    expect(group(r, "ALL").feeRelation).toMatchObject({ relation: "CONSTANT_MULTIPLE", pairs: 60 }); expect(group(r, "ALL").fills.find((f) => f.usd === 25)!.feeMarketPct.mean).toBeCloseTo(2.35, 6); // 0.05 × (1 − 0.53) = 2.35 % of stake at the $25 taker price 0.53
    expect(group(r, "ALL").fills.find((f) => f.usd === 25)!.feeMarketPct.n).toBe(60);
    expect(db.writes).toEqual([]); expect(db.calls.filter((c) => c.op !== "from" && c.op !== "select")).toEqual([]); expect([...new Set(db.calls.map((c) => c.table))].sort()).toEqual(["markets", "paper_executions", "shadow_books", "signals"]);
  });
  it("a market with no row in `markets` is unknown, not assumed; a database error from the new query is reported, not swallowed", async () => {
    const s = seed(40); const none = await readReport(readOnly(shadowDb({ ...s, markets: [] }) as any), { sinceIso: iso(T0 - 10), days: 1, maxRows: 1000, nowIso: "x" }); expect(group(none, "ALL").fills.find((f) => f.usd === 25)!.feeMarketUnknown).toBe(40); expect(group(none, "ALL").feeRelation.relation).toBe("UNKNOWN");
    await expect(readReport(readOnly(shadowDb(s, { failOn: (t) => (t === "markets" ? new Error("boom-markets") : null) }) as any), { sinceIso: iso(T0 - 10), days: 1, maxRows: 1000, nowIso: "x" })).rejects.toThrow(/boom-markets|markets/);
  });
  it("the CLI end to end: ≤ 60 console lines, six files, the Markdown is the long form, a database error and a missing variable exit non-zero without writing", async () => {
    const out: string[] = []; const files = new Map<string, string>(); const db = shadowDb(seed(40));
    const code = await runShadowReportCli(["--since", iso(T0 - 86400), "--print-files", "shadow_report.md"], {}, { db: () => readOnly(db as any), now: () => T0 * 1000, log: (l) => out.push(l), writeFile: (p, c) => files.set(p, c), readFile: (p) => files.get(p) ?? null, mkdir: () => {}, sleep: async () => {} });
    expect(code).toBe(0); expect(files.size).toBe(6); const marker = out.indexOf("=====FILE shadow_report.md"); expect(marker).toBeGreaterThan(0); expect(out.slice(0, marker).length).toBeLessThanOrEqual(60); expect(files.get("docs/phase4/data/shadow_report.md")!).toMatch(/## Decision table with means and 95 % intervals/); expect(db.writes).toEqual([]);
    const bad: string[] = []; const failing = shadowDb(seed(3), { failOn: (t) => (t === "shadow_books" ? new Error("boom") : null) }); const w = new Map<string, string>();
    expect(await runShadowReportCli([], {}, { db: () => readOnly(failing as any), now: () => T0 * 1000, log: (l) => bad.push(l), writeFile: (p, c) => w.set(p, c), mkdir: () => {} })).toBe(1); expect(w.size).toBe(0); expect(bad.join("\n")).toMatch(/shadow report failed: .*boom/);
  });
});
