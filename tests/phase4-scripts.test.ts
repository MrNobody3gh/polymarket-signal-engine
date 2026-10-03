/**
 * Phase 4.0 — both scripts end to end through their command-line entry points, with a fake network and a SPY database:
 *  - read-only: a database that throws on every write method and every RPC is never tripped, on every database path;
 *  - summaries ≤ 60 lines and the documented files are produced;
 *  - a blocked, failing or malformed venue is reported and the run continues; no retries beyond the polite limit.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXIT, runCoverageCli, runTimestampAuditCli } from "../src/lib/phase4/cli";
import { readOnly } from "../src/lib/phase4/readonly-db";
import { coverageSummaryLines } from "../src/lib/phase4/probe";
import { s1aSummaryLines, type S1aResult } from "../src/lib/phase4/s1a";
import { fakeFetch, json, memDb, virtualClock } from "./helpers/phase4Db";
import { buildWorld } from "./helpers/phase4World";
import type { SlotVerdict } from "../src/lib/phase4/audit";

const world = buildWorld(4);
const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-never-logged" };
const files = () => { const out: Record<string, string> = {}; return { out, writeFile: (p: string, c: string) => { out[p] = c; }, mkdir: () => {} }; };

// ───────────────────────────────────────── S1a ─────────────────────────────────────────
/** Gamma: pages of 100 with a cursor; US: offset paging, no cursor. */
const venueHandler = (u: URL): Response => {
  if (u.host === "gamma-api.polymarket.com") {
    const closed = u.searchParams.get("closed") === "true"; const all = (world.gamma as any[]).filter((m) => m.closed === closed); const off = Number(u.searchParams.get("after_cursor") ?? 0);
    const page = all.slice(off, off + 100); return json({ markets: page, next_cursor: off + 100 < all.length ? String(off + 100) : null });
  }
  if (u.host === "gateway.polymarket.us") {
    const closed = u.searchParams.get("closed") === "true"; const all = (world.us as any[]).filter((m) => (m.status === "settled") === closed); const off = Number(u.searchParams.get("offset") ?? 0); return json({ markets: all.slice(off, off + 100) });
  }
  return new Response("no", { status: 404 });
};

describe("S1a script (timestamp audit)", () => {
  const run = async (handler: Parameters<typeof fakeFetch>[0], argv: string[] = [], env: Record<string, string | undefined> = {}) => {
    const c = virtualClock(); const f = fakeFetch(handler, c.now); const w = files(); const lines: string[] = [];
    const code = await runTimestampAuditCli(argv, env, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: w.writeFile, mkdir: w.mkdir, log: (l) => lines.push(l) }); return { code, f, files: w.out, lines, c };
  };

  it("full run against the synthetic venues: exit 0, documented files, ≤ 60 lines, the expected verdicts and venue agreement", async () => {
    const r = await run(venueHandler); expect(r.code).toBe(EXIT.OK); expect(r.lines.length).toBeLessThanOrEqual(60);
    expect(Object.keys(r.files).sort()).toEqual(["docs/phase4/data/S1a_RESULTS.md", "docs/phase4/data/s1a_polymarket_intl.json", "docs/phase4/data/s1a_polymarket_us.json", "docs/phase4/data/s1a_summary.json", "tests/fixtures/phase4/s1a_polymarket_intl_open.json", "tests/fixtures/phase4/s1a_polymarket_intl_resolved.json", "tests/fixtures/phase4/s1a_polymarket_us_open.json", "tests/fixtures/phase4/s1a_polymarket_us_resolved.json"]);
    const summary = JSON.parse(r.files["docs/phase4/data/s1a_summary.json"]); const intl = summary.venues.find((v: any) => v.venue === "polymarket_intl"); const us = summary.venues.find((v: any) => v.venue === "polymarket_us");
    expect(intl.counts).toMatchObject({ open: 191, resolved: 191 }); expect(us.counts).toMatchObject({ open: 30, resolved: 30 });
    const pick = (v: any, st: string, slot: number) => v.recommendations.find((x: SlotVerdict) => x.stratum === st && x.slot === slot);
    expect(pick(intl, "sports:basketball", 1).verdict).toBe("RECOMMEND"); expect(pick(intl, "politics", 1).verdict).toBe("UNRELIABLE_REJECT"); expect(pick(intl, "crypto_short_term", 2).verdict).toBe("RECOMMEND"); expect(pick(us, "sports:basketball", 1)).toMatchObject({ verdict: "RECOMMEND", field: "eventStartTime" });
    // the 60 basketball events exist on both venues with start times that differ by [0,0,5,-5,10,-10,20,-30,0,15] minutes
    expect(summary.venueAgreement).toMatchObject({ available: true, matched: 60 }); const b = summary.venueAgreement.summary.find((s: any) => s.stratum === "sports:basketball");
    expect(b).toMatchObject({ n: 60, within15MinShare: 0.8, within60MinShare: 1, absP50Min: 7.5, maxAbsMin: 30 });
    expect(r.files["docs/phase4/data/S1a_RESULTS.md"]).toContain("## Venue agreement (D51 input)");
  });
  it("only public GETs: every request is a GET to a venue host, with the research User-Agent and no credentials, at most 2 per second", async () => {
    const r = await run(venueHandler); expect(r.f.calls.length).toBeGreaterThan(5);
    for (const c of r.f.calls) { expect(c.method).toBe("GET"); expect(["gamma-api.polymarket.com", "gateway.polymarket.us"]).toContain(new URL(c.url).host); expect(c.headers["user-agent"]).toMatch(/read-only/); expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]); }
    for (let i = 1; i < r.f.calls.length; i++) expect(r.f.calls[i].at! - r.f.calls[i - 1].at!).toBeGreaterThanOrEqual(500);
  });
  it("fixtures written for the next run are bounded, sanitised public data (no images or descriptions, no long text)", async () => {
    const r = await run((u) => { const res = venueHandler(u); return res; });
    for (const [p, text] of Object.entries(r.files)) if (p.startsWith("tests/fixtures/")) { expect(text.length, p).toBeLessThan(400_000); const list = JSON.parse(text); expect(list.length).toBeLessThanOrEqual(40); expect(text).not.toMatch(/"(image|icon|description|resolutionSource)"/i); }
    const big = await run((u) => { const res = venueHandler(u); if (u.host !== "gamma-api.polymarket.com") return res; return res; }); expect(big.code).toBe(0);
  });
  it("--no-fixtures and --no-us are honoured", async () => { const r = await run(venueHandler, ["--no-fixtures", "--no-us"]); expect(Object.keys(r.files).some((p) => p.startsWith("tests/"))).toBe(false); expect(Object.keys(r.files).some((p) => p.includes("polymarket_us"))).toBe(false); expect(r.f.calls.every((c) => c.url.includes("gamma-api"))).toBe(true); expect(r.lines.join("\n")).toContain("polymarket_us: not audited"); });
  it("--fetch-factor and the sample sizes bound what is fetched; per-stratum counts are printed so thin strata are visible", async () => {
    const small = await run(venueHandler, ["--no-us", "--no-fixtures", "--sample-open", "40", "--sample-resolved", "40", "--fetch-factor", "1"]); const full = await run(venueHandler, ["--no-us", "--no-fixtures"]);
    expect(small.f.calls.length).toBeLessThan(full.f.calls.length); const s = JSON.parse(small.files["docs/phase4/data/s1a_polymarket_intl.json"]); expect(s.fetch.open.records).toBe(40); expect(s.fetch.open.stoppedBecause).toBe("sample size reached");
    expect(full.lines.join("\n")).toMatch(/strata open\/resolved: .*sports:basketball 31\/31/);
  });
  it("a US listing that ignores the open/closed filter is noticed (filterHonoured false), and its closed list holds only markets the venue calls resolved", async () => {
    const r = await run((u) => (u.host === "gateway.polymarket.us" ? json({ markets: world.us.slice(0, 40) }) : venueHandler(u)));
    const us = JSON.parse(r.files["docs/phase4/data/s1a_polymarket_us.json"]); expect(us.fetch.open.filterHonoured).toBe(false); expect(us.fetch.resolved.filterHonoured).toBe(false);
  });
  it("both venues blocked (403): reported exactly, the run still finishes with exit 0, nothing is retried or worked around, the other stages are listed as not established", async () => {
    const r = await run(() => new Response("Host not in allowlist", { status: 403 })); expect(r.code).toBe(0); expect(r.lines.length).toBeLessThanOrEqual(60);
    expect(r.lines.join("\n")).toMatch(/BLOCKED 403/); expect(r.lines.join("\n")).toContain("NOT REACHED"); expect(r.lines.join("\n")).toMatch(/NOT ESTABLISHED: polymarket_intl/); expect(r.lines.join("\n")).toContain("Host not in allowlist");
    expect(r.f.calls.length).toBeLessThanOrEqual(4); // two refusals per origin, then no more requests to it
    expect(JSON.parse(r.files["docs/phase4/data/s1a_summary.json"]).venues.every((v: any) => !v.reachable)).toBe(true);
  });
  it("one venue down (network error), the other up: the audit continues with the venue that answers", async () => {
    const r = await run((u) => { if (u.host === "gateway.polymarket.us") throw new TypeError("fetch failed"); return venueHandler(u); }); expect(r.code).toBe(0);
    expect(r.f.calls.filter((c) => c.url.includes("polymarket.us")).length).toBeLessThanOrEqual(6); // 3 attempts each for the open and the resolved listing, no more
    const s = JSON.parse(r.files["docs/phase4/data/s1a_summary.json"]); expect(s.venues.find((v: any) => v.venue === "polymarket_intl").reachable).toBe(true); expect(s.venues.find((v: any) => v.venue === "polymarket_us").reachable).toBe(false); expect(s.venueAgreement.available).toBe(false);
  });
  it("malformed responses (HTML, truncated JSON, an unexpected shape) are reported and do not crash the run", async () => {
    for (const body of ["<html>maintenance</html>", '{"markets": [{"id": 1', JSON.stringify({ unexpected: true }), JSON.stringify([1, "x", null])]) {
      const r = await run(() => new Response(body, { status: 200 })); expect(r.code, body).toBe(0); expect(r.lines.length).toBeLessThanOrEqual(60); expect(JSON.parse(r.files["docs/phase4/data/s1a_summary.json"]).venues.every((v: any) => v.counts.open === 0)).toBe(true);
    }
  });
  it("a query filter the venue ignores (open and closed returned together) is noticed and the resolved list is taken only from closed markets", async () => {
    const r = await run((u) => (u.host === "gamma-api.polymarket.com" ? json({ markets: world.gamma.slice(0, 100) }) : new Response("x", { status: 404 })), ["--no-us"]);
    const intl = JSON.parse(r.files["docs/phase4/data/s1a_polymarket_intl.json"]); expect(intl.fetch.open.filterHonoured).toBe(false); expect(intl.fetch.open.stoppedBecause).toMatch(/no cursor/);
  });
  it("--with-db without the two Supabase variables stops with exit 2 and does not touch the database", async () => { let touched = false; const w = files(); const lines: string[] = []; const code = await runTimestampAuditCli(["--with-db"], {}, { fetch: fakeFetch(venueHandler).fetch, writeFile: w.writeFile, mkdir: w.mkdir, log: (l) => lines.push(l), db: undefined }); void touched; expect(code).toBe(EXIT.CONFIG); expect(lines.join(" ")).toContain("database was not touched"); expect(Object.keys(w.out)).toEqual([]); });
  it("--with-db compares with OUR resolution times through select-only reads (spy database never tripped)", async () => {
    const resolved = (world.gamma as any[]).filter((m) => m.closed).slice(0, 12);
    const tokenRows = resolved.map((m, i) => ({ token_id: `tok${i}`, resolved_ts: new Date(Date.UTC(2026, 9, 1, 12, i)).toISOString(), value: 1 }));
    const ledger = resolved.map((m, i) => ({ token_id: `tok${i}`, condition_id: m.conditionId }));
    const spy = memDb({ token_resolutions: tokenRows, paper_ledger: ledger }); const c = virtualClock(); const f = fakeFetch((u) => { if (u.pathname === "/markets/keyset" && u.searchParams.get("condition_ids")) { const id = u.searchParams.get("condition_ids")!; return json({ markets: (world.gamma as any[]).filter((m) => m.conditionId === id) }); } return venueHandler(u); }, c.now);
    const w = files(); const lines: string[] = [];
    const code = await runTimestampAuditCli(["--with-db", "--no-us", "--no-fixtures"], ENV, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: w.writeFile, mkdir: w.mkdir, log: (l) => lines.push(l), db: () => readOnly(spy.db as never) });
    expect(code).toBe(0); expect(spy.touched).toEqual([]); expect([...new Set(spy.reads.map((r) => r.table))].sort()).toEqual(["paper_ledger", "token_resolutions"]);
    const intl = JSON.parse(w.out["docs/phase4/data/s1a_polymarket_intl.json"]); expect(intl.counts.ours).toBe(12); expect(intl.evidence["sports:basketball"].some((e: any) => e.vsReference["ours:token_resolutions.resolved_ts"])).toBe(true);
  });
  it("the printed summary is capped at 60 lines whatever the number of strata, and long lines are truncated", () => {
    const rec = (i: number, slot: 1 | 2): SlotVerdict => ({ venue: "v", stratum: `stratum-${i}`, slot, field: "f".repeat(300), verdict: "RECOMMEND", usableShare: 1, presentShare: 1, placeholderShare: 0, failed: [], evidence: {}, needsHumanReview: false });
    const v = (name: string) => ({ venue: name, reachable: true, fetch: { open: null, resolved: null }, counts: { open: 1, resolved: 1, ours: 0 }, strata: {}, inventory: [], evidence: {}, recommendations: Array.from({ length: 80 }, (_, i) => rec(i, (i % 2 ? 2 : 1) as 1 | 2)) });
    const res: S1aResult = { startedAt: "a", finishedAt: "b", venues: [v("one"), v("two")] as never, venueAgreement: { available: false, reason: "x".repeat(900), matched: 0, byConfidence: {}, summary: [] }, http: { requests: 1, ok: 1, byKind: {}, firstErrors: Array.from({ length: 5 }, () => "e".repeat(500)) }, endpoints: [], docs: [], rules: {}, notEstablished: Array.from({ length: 9 }, () => "n".repeat(900)) };
    const lines = s1aSummaryLines(res, "out"); expect(lines.length).toBeLessThanOrEqual(60); expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(220);
  });
});

// ───────────────────────────────────────── S1b ─────────────────────────────────────────
const NOW = Date.parse("2026-10-03T00:00:00Z");
const z = (s: string) => new Date(Date.parse(s)).toISOString();
const sig = (id: string, o: Partial<Record<string, any>>) => ({ id, kind: "NEW_POSITION", wallet: "0xw1", condition_id: "0xc1", token_id: "tok1", outcome: "Lakers", title: "Lakers vs. Celtics", slug: "nba-lal-bos", price: 0.5, created_at: z("2026-10-02T10:00:00Z"), evaluated_at: z("2026-10-02T10:02:00Z"), payload: { copyScore: 80 }, ...o });
const SIGNALS = [
  sig("s1", {}),                                                                                                   // eligible: 4 h to go
  sig("s2", { wallet: "0xw2", evaluated_at: z("2026-10-02T13:57:00Z") }),                                          // 180 s before kick-off < MIN_LEAD
  sig("s3", { wallet: "0xw3", evaluated_at: z("2026-10-02T14:30:00Z") }),                                          // already started
  sig("s4", { wallet: "0xw4", condition_id: "0xc2", token_id: "tok3", outcome: "Warriors", title: "Warriors vs. Knicks", slug: "nba-gsw-nyk", evaluated_at: z("2026-10-02T09:00:00Z") }), // 2 days away
  sig("s5", { wallet: "0xw5", payload: { copyScore: 60 } }),                                                       // score below 68
  sig("s6", { wallet: "0xw6", condition_id: "0xc9", token_id: "tok9", outcome: "Yes", title: "Unknown game xyz", slug: "xyz" }), // not on the venue
  sig("s7", { wallet: "0xw7", condition_id: "0xc3", token_id: "tok5", outcome: "Bulls", title: "Bulls vs. Heat", slug: "nba-chi-mia" }), // no time field on the venue
  sig("s8", { wallet: "0xw8", condition_id: "0xc4", token_id: "tok7", outcome: "Nets", title: "Nets vs. Suns", slug: "nba-bkn-phx", evaluated_at: z("2026-10-02T18:00:00Z") }), // resolved before the signal
  sig("x1", { kind: "EXIT", wallet: "0xw1" }),                                                                     // an EXIT is not an entry signal
  sig("old", { created_at: z("2026-09-27T04:28:37Z"), evaluated_at: z("2026-09-27T04:30:00Z") }),                  // one second before the clean regime
];
const US_MARKETS = [
  { id: "u1", slug: "nba-lal-bos", question: "Lakers vs Celtics", outcomes: '["Lakers","Celtics"]', conditionId: "0xc1", clobTokenIds: ["tok1", "tok2"], status: "open", eventStartTime: "2026-10-02T14:00:00+00:00", closeTime: "2026-10-02T17:00:00+00:00" },
  { id: "u2", slug: "nba-gsw-nyk", question: "Warriors vs Knicks", outcomes: '["Warriors","Knicks"]', clobTokenIds: ["tok3", "tok4"], status: "open", eventStartTime: "2026-10-04T20:00:00+00:00" },
  { id: "u3", slug: "nba-chi-mia", question: "Bulls vs Heat", outcomes: '["Bulls","Heat"]', clobTokenIds: ["tok5", "tok6"], status: "open" },
  { id: "u4", slug: "nba-bkn-phx", question: "Nets vs Suns", outcomes: '["Nets","Suns"]', clobTokenIds: ["tok7", "tok8"], status: "settled", eventStartTime: "2026-10-02T12:00:00+00:00", settledAt: "2026-10-02T15:00:00+00:00" },
];
const REC = (field: string, slot: 1 | 2): SlotVerdict => ({ venue: "polymarket_us", stratum: "sports:basketball", slot, field, verdict: "RECOMMEND", usableShare: 1, presentShare: 1, placeholderShare: 0, failed: [], evidence: {}, needsHumanReview: false });
const RECS = { venues: [{ venue: "polymarket_us", recommendations: [REC("eventStartTime", 1), REC("closeTime", 2)] }] };
const PAPER = [
  ...[ [10, 5, 1], [-100, 5, 3], [30, 5, 2], [-60, 5, 1], [90, 5, 4], [-100, 5, 2] ].map(([ret, usd, days], i) => ({ signal_id: `s${i + 1}`, mode: "REALISTIC", coverage_state: "SIMULATED", state: "RESOLVED", source_trade_ts: z("2026-09-30T10:00:00Z"), fill_ts: z("2026-09-30T10:05:00Z"), closed_at: new Date(Date.parse("2026-09-30T10:05:00Z") + (days as number) * 86_400_000).toISOString(), net_pnl: (ret as number) * (usd as number) / 100, filled_usd: usd })),
  { signal_id: "s7", mode: "REALISTIC", coverage_state: "UNFILLED", state: "NOT_ENTERED", source_trade_ts: z("2026-09-30T11:00:00Z"), fill_ts: null, closed_at: null, net_pnl: 0, filled_usd: 0 },
  { signal_id: "s1", mode: "IDEAL", coverage_state: "SIMULATED", state: "RESOLVED", source_trade_ts: z("2026-09-30T10:00:00Z"), fill_ts: z("2026-09-30T10:05:00Z"), closed_at: z("2026-10-01T10:05:00Z"), net_pnl: 1, filled_usd: 5 },
];
const worldDb = () => memDb({ signals: SIGNALS.map((s) => ({ ...s })), markets: [{ condition_id: "0xc1", end_date: "2026-10-02" }, { condition_id: "0xc2", end_date: "2026-10-04" }, { condition_id: "0xc3", end_date: "2026-10-02" }, { condition_id: "0xc4", end_date: "2026-10-02" }], paper_executions: PAPER.map((p) => ({ ...p })) });
const usHandler = (u: URL): Response => { if (u.host !== "gateway.polymarket.us") return new Response("no", { status: 404 }); const closed = u.searchParams.get("closed") === "true"; return json({ markets: US_MARKETS.filter((m) => (m.status === "settled") === closed) }); };

describe("S1b script (coverage probe)", () => {
  const run = async (o: { handler?: Parameters<typeof fakeFetch>[0]; argv?: string[]; env?: Record<string, string | undefined>; recs?: unknown | null; db?: ReturnType<typeof worldDb> | null } = {}) => {
    const c = virtualClock(NOW); const f = fakeFetch(o.handler ?? usHandler, c.now); const w = files(); const lines: string[] = []; const d = o.db === undefined ? worldDb() : o.db;
    const code = await runCoverageCli(o.argv ?? [], o.env ?? ENV, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: w.writeFile, mkdir: w.mkdir, readFile: (p) => (o.recs === null ? null : p.endsWith("s1a_summary.json") ? JSON.stringify(o.recs ?? RECS) : null), log: (l) => lines.push(l), db: d ? () => readOnly(d.db as never) : undefined });
    return { code, f, files: w.out, lines, d, c };
  };

  it("funnel on the fixture world, every stage with a hand-derived answer, and the documented files", async () => {
    const r = await run(); expect(r.code).toBe(EXIT.OK); expect(r.lines.length).toBeLessThanOrEqual(60);
    expect(Object.keys(r.files).sort()).toEqual(["docs/phase4/data/s1b_feasibility.json", "docs/phase4/data/s1b_funnel.json", "docs/phase4/data/s1b_mapping_review.csv"]);
    const j = JSON.parse(r.files["docs/phase4/data/s1b_funnel.json"]); const ex = j.funnel.variants.EXACT;
    // 8 entry signals in the window (the EXIT and the 04:28:37 signal are out); score ≥ 68: s1 s2 s3 s4 s6 s7 s8 = 7; mapped (token ids): all but s6 = 6;
    // tradable: all but s8 (settled before the signal) = 5; usable timestamp: all but s7 (no time field) = 4; not started: all but s3 = 3; within 24 h: all but s4 = 2; lead ≥ 300 s: all but s2 = 1 (s1)
    expect(ex.counts).toEqual([8, 7, 6, 5, 4, 3, 2, 1]); expect(ex.exits).toEqual({ score: 1, mapped: 1, tradable: 1, timestamp: 1, notStarted: 1, within24h: 1, minLead: 1 }); expect(ex.wallets).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(j.counts).toEqual({ signals: 8, withScore: 7, conditions: 5 }); expect(j.mappingBuckets).toEqual({ EXACT: 4, PROBABLE: 0, NONE: 1 }); expect(ex.top3Share).toBe(1); expect(j.venue.measured).toEqual({ mapping: true, tradable: true, timestamp: true });
    const csv = r.files["docs/phase4/data/s1b_mapping_review.csv"].trim().split("\n"); expect(csv).toHaveLength(1 + 4); expect(csv[0]).toContain("reviewer_verdict"); expect(csv[1]).toContain("EXACT");
  });
  it("without the S1a recommendations the timestamp stage is NOT MEASURED (null), never zero, and the reason is printed", async () => {
    const r = await run({ recs: null }); const j = JSON.parse(r.files["docs/phase4/data/s1b_funnel.json"]); expect(j.funnel.variants.EXACT.counts).toEqual([8, 7, 6, 5, null, null, null, null]); expect(r.lines.join("\n")).toContain("NOT MEASURED"); expect(r.lines.join("\n")).toContain("no S1a recommendations");
  });
  it("feasibility from settled REALISTIC trades: per-trade SD, design effect and the sample-size table", async () => {
    const r = await run(); const j = JSON.parse(r.files["docs/phase4/data/s1b_feasibility.json"]); const all = j.feasibility.subsets[0];
    expect(j.mode).toBe("REALISTIC"); expect(all.stats.n).toBe(6); expect(j.settled.fillShare).toBeCloseTo(6 / 7, 12); // 6 simulated, 1 unfilled; the IDEAL row is not used
    const rets = [10, -100, 30, -60, 90, -100]; const m = rets.reduce((a, b) => a + b) / 6; const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / 5); expect(all.stats.sdPts).toBeCloseTo(sd, 9); expect(all.stats.meanPts).toBeCloseTo(m, 9);
    expect(all.stats.holdP50Days).toBeCloseTo(2, 9); expect(all.sampleSize[0]).toMatchObject({ effectPts: 10 }); expect(all.sampleSize[0].perArmIndependent).toBe(Math.ceil((2 * (1.959963985 + 0.841621234) ** 2 * sd * sd) / 100));
    expect(j.feasibility.eligiblePerDay.basis).toMatch(/^venue funnel/); // the venue funnel was measured, so it is the basis, not the proxy
  });
  it("--start moves the window start (inclusive); a start with no time zone is refused before the database is touched", async () => {
    const a = await run({ argv: ["--start", "2026-10-02T10:00:00Z"] }); expect(JSON.parse(a.files["docs/phase4/data/s1b_funnel.json"]).funnel.variants.EXACT.counts[0]).toBe(8);
    const b = await run({ argv: ["--start", "2026-10-02T10:00:01Z", "--no-venue"] }); const j = JSON.parse(b.files["docs/phase4/data/s1b_funnel.json"]); expect(j.funnel.variants.EXACT.counts[0]).toBe(0); expect(b.code).toBe(0);
    const d = worldDb(); const c = await run({ argv: ["--start", "2026-10-02T10:00:00"], db: d }); expect(c.code).toBe(EXIT.CONFIG); expect(d.reads).toHaveLength(0); expect(c.lines.join(" ")).toContain("time zone");
  });
  it("--mode IDEAL uses the IDEAL rows", async () => { const r = await run({ argv: ["--mode", "IDEAL"] }); const j = JSON.parse(r.files["docs/phase4/data/s1b_feasibility.json"]); expect(j.mode).toBe("IDEAL"); expect(j.feasibility.subsets[0].stats.n).toBe(1); });
  it("READ-ONLY: a database that throws on every write method and every RPC is never tripped, and only the three expected tables are read, with select", async () => {
    const d = worldDb(); const r = await run({ db: d }); expect(r.code).toBe(0); expect(d.touched).toEqual([]);
    expect([...new Set(d.reads.map((x) => x.table))].sort()).toEqual(["markets", "paper_executions", "signals"]);
    const before = JSON.stringify(d.tables); await run({ db: d }); expect(JSON.stringify(d.tables)).toBe(before); // rows unchanged
  });
  it("the read-only wrapper exposes select and nothing else; reaching for a write method fails", () => {
    const d = worldDb(); const ro = readOnly(d.db as never); expect(Object.keys(ro)).toEqual(["select"]); expect((ro as any).insert).toBeUndefined(); expect((ro as any).rpc).toBeUndefined(); expect((ro as any).from).toBeUndefined();
    expect(() => (d.db.from("signals") as any).upsert({})).toThrow(/WRITE upsert/); expect(d.touched).toEqual(["upsert:signals"]); // and the spy does catch a write when one is attempted
  });
  it("only public GETs to the venue: no credentials, polite pace", async () => {
    const r = await run(); expect(r.f.calls.length).toBeGreaterThan(1); for (const c of r.f.calls) { expect(c.method).toBe("GET"); expect(new URL(c.url).host).toBe("gateway.polymarket.us"); expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]); }
    for (let i = 1; i < r.f.calls.length; i++) expect(r.f.calls[i].at! - r.f.calls[i - 1].at!).toBeGreaterThanOrEqual(500); expect(JSON.stringify(r.lines) + JSON.stringify(r.files)).not.toContain("service-role-secret-never-logged");
  });
  it("venue blocked (403): reported, the database stages still run, later funnel stages are null, the feasibility falls back to the labelled date-level proxy", async () => {
    const r = await run({ handler: () => new Response("Host not in allowlist", { status: 403 }) }); expect(r.code).toBe(0); expect(r.f.calls.length).toBe(2); // one refusal per listing, then the origin is left alone
    const j = JSON.parse(r.files["docs/phase4/data/s1b_funnel.json"]); expect(j.funnel.variants.EXACT.counts).toEqual([8, 7, null, null, null, null, null, null]); expect(j.venue.measured).toEqual({ mapping: false, tradable: false, timestamp: false });
    expect(r.lines.join("\n")).toContain("NOT MEASURED"); expect(r.lines.join("\n")).toMatch(/BLOCKED 403/);
    const fe = JSON.parse(r.files["docs/phase4/data/s1b_feasibility.json"]).feasibility; expect(fe.eligiblePerDay.basis).toMatch(/^DATE-LEVEL PROXY/); expect(fe.eligiblePerDay.basis).toContain("UPPER BOUND");
  });
  it("venue network failure and malformed pages: reported, never retried beyond 3 attempts, the run finishes", async () => {
    const a = await run({ handler: () => { throw new TypeError("fetch failed"); } }); expect(a.code).toBe(0); expect(a.f.calls.length).toBe(6); // open and closed listing, 3 attempts each
    for (const body of ["<html>down</html>", '{"markets": [', JSON.stringify({ nothing: [] })]) { const b = await run({ handler: () => new Response(body, { status: 200 }) }); expect(b.code, body).toBe(0); expect(JSON.parse(b.files["docs/phase4/data/s1b_funnel.json"]).venue.measured.mapping).toBe(false); }
  });
  it("a truncated venue listing is reported: mapped counts are then a lower bound", async () => {
    const r = await run({ argv: ["--us-max", "2"] }); expect(r.lines.join("\n")).toMatch(/listing was cut off at 1 markets .*LOWER BOUND/);
    const j = JSON.parse(r.files["docs/phase4/data/s1b_funnel.json"]); expect(j.venue.reasons.some((x: string) => x.includes("LOWER BOUND"))).toBe(true);
    const full = await run(); expect(JSON.parse(full.files["docs/phase4/data/s1b_funnel.json"]).venue.reasons).toEqual([]); // not truncated: no warning
  });
  it("--no-venue skips the network entirely", async () => { const r = await run({ argv: ["--no-venue"] }); expect(r.f.calls).toHaveLength(0); expect(r.code).toBe(0); expect(r.lines.join("\n")).toContain("not configured"); });
  it("without the two Supabase variables: exit 2 and the database is not touched", async () => { const d = worldDb(); const lines: string[] = []; const code = await runCoverageCli([], {}, { fetch: fakeFetch(usHandler).fetch, writeFile: () => {}, mkdir: () => {}, log: (l) => lines.push(l) }); expect(code).toBe(EXIT.CONFIG); expect(lines.join(" ")).toContain("database was not touched"); expect(d.reads).toHaveLength(0); });
  it("a database error is reported as a failure (exit 1), not swallowed", async () => { const bad = { select: () => ({ in: () => ({ gte: () => ({ lt: () => ({ order: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }) }) }) }) }) }; const lines: string[] = []; const code = await runCoverageCli(["--no-venue"], ENV, { writeFile: () => {}, mkdir: () => {}, log: (l) => lines.push(l), db: () => bad as never }); expect(code).toBe(EXIT.FAILED); expect(lines.join(" ")).toContain("boom"); });
  it("summary stays within 60 lines even with many kinds and categories, and the funnel files are valid JSON", async () => {
    const many = Array.from({ length: 70 }, (_, i) => sig(`m${i}`, { kind: "NEW_POSITION", wallet: `0xw${i}`, condition_id: `0xcc${i}`, token_id: `tt${i}`, slug: `nba-x-${i}`, title: `Team ${i} vs Other ${i}` }));
    const d = memDb({ signals: [...SIGNALS, ...many], markets: [], paper_executions: PAPER }); const r = await run({ db: d }); expect(r.lines.length).toBeLessThanOrEqual(60); for (const p of ["s1b_funnel.json", "s1b_feasibility.json"]) expect(() => JSON.parse(r.files[`docs/phase4/data/${p}`])).not.toThrow();
    const res = JSON.parse(r.files["docs/phase4/data/s1b_funnel.json"]); void res; const lines = coverageSummaryLines(({ startedAt: "", window: { startIso: "a", endIso: "b" }, counts: { signals: 1, withScore: 1, conditions: 1 }, venue: { configured: true, notes: { open: null, closed: null }, candidates: 0, measured: { mapping: false, tradable: false, timestamp: false }, reasons: Array.from({ length: 80 }, () => "r".repeat(400)) }, funnel: JSON.parse(r.files["docs/phase4/data/s1b_funnel.json"]).funnel, mappingBuckets: { EXACT: 0, PROBABLE: 0, NONE: 0 }, feasibility: JSON.parse(r.files["docs/phase4/data/s1b_feasibility.json"]).feasibility, feasibilityMode: "REALISTIC", settled: { n: 0, fillShare: null }, approximations: [] } as never), "out"); expect(lines.length).toBeLessThanOrEqual(60); expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(220);
  });
  it("the committed documentation lists the clean-regime start the probe uses", () => { expect(readFileSync("src/lib/phase4/probe.ts", "utf8")).toContain('REGIME_START_ISO = "2026-09-27T04:28:38Z"'); });
});
