/**
 * Phase 4.0d, Part A — one venue per process, the heap budget, the evidence files.
 *  - a `--venue` run asks only that venue's host and writes only that venue's evidence file;
 *  - the heap guard stops a run with a message naming the venue and the stage (never a crash), writes a partial file, exits 3;
 *  - a 40,000-market synthetic Kalshi listing and a 40,000-market synthetic US listing each complete one at a time inside the 350 MB default budget;
 *  - the three commands refuse a bad `--venue` before touching anything.
 */
import { describe, expect, it } from "vitest";
import { EXIT, runCoverageCli, runTimestampAuditCli, runTitleSearchCli } from "../src/lib/phase4/cli";
import { readOnly } from "../src/lib/phase4/readonly-db";
import { DEFAULT_HEAP_BUDGET_MB, HeapBudgetExceeded, collectGarbage, MemoryGuard, VenueScope, VenueScopeError, evidenceFile, heapInfo, parseEvidence, parseVenueId } from "../src/lib/phase4/venue-run";
import { PoliteHttp } from "../src/lib/phase4/http";
import type { VenueAuditFile } from "../src/lib/phase4/s1a";
import type { VenueCoverageFile } from "../src/lib/phase4/probe";
import type { VenueTitlesFile } from "../src/lib/phase4/title-search";
import { fakeFetch, json, memDb, virtualClock } from "./helpers/phase4Db";
import { buildWorld } from "./helpers/phase4World";
import { kalshiServer, nbaEvents } from "./helpers/phase4Kalshi";
import { KALSHI_HOST, US_HOST, bigKalshi, bigUs } from "./helpers/phase4Big";

const MB = 1024 * 1024; const world = buildWorld(4); const OUT = "docs/phase4/data";
const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-never-logged" };
const NOW = Date.parse("2026-10-03T00:00:00Z"); const z = (s: string) => new Date(Date.parse(s)).toISOString();
const sig = (id: string, o: Record<string, unknown> = {}) => ({ id, kind: "NEW_POSITION", wallet: `0xw${id}`, condition_id: `0xc${id}`, token_id: `tok${id}`, outcome: "Lakers", title: "Lakers vs. Celtics", slug: "nba-lal-bos", price: 0.5, created_at: z("2026-10-02T10:00:00Z"), evaluated_at: z("2026-10-02T10:02:00Z"), payload: { copyScore: 80 }, ...o });
const files = () => { const out: Record<string, string> = {}; return { out, writeFile: (p: string, c: string) => { out[p] = c; }, mkdir: () => {}, readFile: (p: string) => out[p] ?? null }; };

const gammaHandler = (u: URL): Response => {
  if (u.host !== "gamma-api.polymarket.com") return new Response("no", { status: 404 });
  const closed = u.searchParams.get("closed") === "true"; const all = (world.gamma as any[]).filter((m) => m.closed === closed); const off = Number(u.searchParams.get("after_cursor") ?? 0); const page = all.slice(off, off + 100);
  return json({ markets: page, next_cursor: off + 100 < all.length ? String(off + 100) : null });
};
const usHandler = (u: URL): Response => {
  if (u.host !== US_HOST) return new Response("no", { status: 404 });
  if (u.pathname === "/v1/markets") { const closed = u.searchParams.get("closed") === "true"; const all = (world.us as any[]).filter((m) => (m.status === "settled") === closed); const off = Number(u.searchParams.get("offset") ?? 0); return json({ markets: all.slice(off, off + 100) }); }
  return new Response("no", { status: 404 });
};
const kalshiHandler = kalshiServer({ open: nbaEvents("o", 40, false), settled: nbaEvents("s", 40, true) }).handler;
const allHandler = (u: URL): Response => (u.host === "gamma-api.polymarket.com" ? gammaHandler(u) : u.host === US_HOST ? usHandler(u) : kalshiHandler(u));
const hosts = (calls: { url: string }[]) => [...new Set(calls.map((c) => new URL(c.url).host))].sort();

const run = async (cli: typeof runTimestampAuditCli, argv: string[], h: Parameters<typeof fakeFetch>[0], o: { env?: Record<string, string>; db?: ReturnType<typeof memDb>; heapUsed?: () => number } = {}) => {
  const c = virtualClock(NOW); const f = fakeFetch(h, c.now); const w = files(); const lines: string[] = [];
  const code = await cli(argv, o.env ?? {}, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: w.writeFile, mkdir: w.mkdir, readFile: w.readFile, log: (l) => lines.push(l), db: o.db ? () => readOnly(o.db!.db as never) : undefined, heapUsed: o.heapUsed }); return { code, f, files: w.out, lines };
};
const auditFile = (r: { files: Record<string, string> }, v: string) => JSON.parse(r.files[`${OUT}/v_${v}_audit.json`]) as VenueAuditFile;

describe("venue ids", () => {
  it("accepts the three ids and the short aliases, nothing else (both is the all-in-one mode, not a venue)", () => {
    expect(parseVenueId("polymarket_intl")).toBe("polymarket_intl"); expect(parseVenueId("intl")).toBe("polymarket_intl"); expect(parseVenueId("US")).toBe("polymarket_us"); expect(parseVenueId("polymarket_us")).toBe("polymarket_us"); expect(parseVenueId("kalshi")).toBe("kalshi");
    for (const bad of ["both", "bing", "", undefined, null, "polymarket"]) expect(parseVenueId(bad as never)).toBeNull();
  });
  it("evidence files are named v_<venue>_<kind>.json", () => { expect(evidenceFile("kalshi", "audit")).toBe("v_kalshi_audit.json"); expect(evidenceFile("polymarket_us", "titles")).toBe("v_polymarket_us_titles.json"); expect(evidenceFile("polymarket_intl", "coverage")).toBe("v_polymarket_intl_coverage.json"); });
  it("parseEvidence rejects a missing file, bad JSON, another kind, another venue and another schema", () => {
    const f = { schema: 1, kind: "audit", venue: "kalshi" }; expect(parseEvidence(JSON.stringify(f), "audit", "kalshi")).toMatchObject(f);
    expect(parseEvidence(null, "audit", "kalshi")).toBeNull(); expect(parseEvidence("{", "audit", "kalshi")).toBeNull(); expect(parseEvidence(JSON.stringify(f), "titles", "kalshi")).toBeNull(); expect(parseEvidence(JSON.stringify(f), "audit", "polymarket_us")).toBeNull(); expect(parseEvidence(JSON.stringify({ ...f, schema: 2 }), "audit", "kalshi")).toBeNull();
  });
});

describe("MemoryGuard", () => {
  it("stops above the budget (strictly), names the venue and the stage, and reports the peak", () => {
    let used = 349 * MB; const g = new MemoryGuard({ venue: "kalshi", heapUsed: () => used }); g.setStage("listing");
    g.check("request 3"); used = 350 * MB; expect(() => g.check()).not.toThrow(); // exactly the budget is allowed
    used = 351 * MB; let err: unknown; try { g.check("request 9"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HeapBudgetExceeded); const e = err as HeapBudgetExceeded; expect(e.venue).toBe("kalshi"); expect(e.stage).toBe("listing, request 9"); expect(e.message).toContain('venue kalshi, stage "listing, request 9"'); expect(e.message).toContain("351 MB"); expect(e.message).toContain("350 MB"); expect(e.message).toContain("--heap-budget-mb");
    expect(g.peakMb).toBeCloseTo(351, 5); expect(heapInfo(g)).toEqual({ budgetMb: 350, peakMb: 351 });
  });
  it("the guard judges LIVE data: it collects garbage before it decides to stop, and stops only if the heap is still over budget afterwards", () => {
    let used = 400 * MB; let collected = 0; const ok = new MemoryGuard({ venue: "v", heapUsed: () => used, collect: () => { collected++; used = 100 * MB; } }); ok.setStage("listing"); expect(collected).toBe(1); expect(ok.collections).toBe(1); expect(ok.peakMb).toBeCloseTo(100, 5);
    used = 400 * MB; collected = 0; const stuck = new MemoryGuard({ venue: "v", heapUsed: () => used, collect: () => { collected++; /* nothing is freed */ } }); expect(() => stuck.check("request 1")).toThrow(HeapBudgetExceeded); expect(collected).toBe(1);
    const under = new MemoryGuard({ venue: "v", heapUsed: () => 10 * MB, collect: () => { collected += 100; } }); collected = 0; under.check(); expect(collected).toBe(0); // under budget: no collection (it is not free)
  });
  it("the default budget is 350 MB, a custom one is honoured, a non-positive one falls back to the default", () => {
    expect(DEFAULT_HEAP_BUDGET_MB).toBe(350); expect(new MemoryGuard({ venue: "v" }).budgetMb).toBe(350); expect(new MemoryGuard({ venue: "v", budgetMb: 12 }).budgetMb).toBe(12); expect(new MemoryGuard({ venue: "v", budgetMb: 0 }).budgetMb).toBe(350);
  });
  it("setStage checks at once and moves the venue label (an all-in-one run names the venue it is in)", () => {
    const g = new MemoryGuard({ venue: "all-in-one run", heapUsed: () => 999 * MB }); let e: HeapBudgetExceeded | null = null; try { g.setStage("listing", "polymarket_us"); } catch (x) { e = x as HeapBudgetExceeded; }
    expect(e?.venue).toBe("polymarket_us"); expect(e?.stage).toBe("listing");
  });
  it("the HTTP client checks the guard BEFORE every request: over budget, no request is sent", async () => {
    const f = fakeFetch(() => json({})); const g = new MemoryGuard({ venue: "kalshi", heapUsed: () => 500 * MB }); g.stage = "listing";
    await expect(new PoliteHttp({ fetch: f.fetch, sleep: async () => {}, guard: g }).getJson("https://x.test/a")).rejects.toBeInstanceOf(HeapBudgetExceeded); expect(f.calls).toHaveLength(0);
  });
});

describe("VenueScope", () => {
  it("a process scoped to one venue refuses a stage of another (one process never holds two venues)", () => {
    const s = new VenueScope("kalshi"); s.enter("kalshi", "listing"); expect(s.entered).toEqual(["listing"]);
    expect(() => s.enter("polymarket_us", "listing")).toThrow(VenueScopeError); expect(() => s.enter("polymarket_us", "listing")).toThrow(/scoped to kalshi.*asked for polymarket_us/);
  });
});

describe("phase4:ts-audit --venue", () => {
  it("kalshi: asks only the Kalshi host, writes only v_kalshi_audit.json (no combined summary, no compact file), and holds only Kalshi", async () => {
    const r = await run(runTimestampAuditCli, ["--venue", "kalshi", "--no-fixtures"], allHandler); expect(r.code).toBe(EXIT.OK); expect(hosts(r.f.calls)).toEqual([KALSHI_HOST]);
    expect(Object.keys(r.files)).toEqual([`${OUT}/v_kalshi_audit.json`]); const f = auditFile(r, "kalshi"); expect(f).toMatchObject({ schema: 1, kind: "audit", venue: "kalshi", stopped: null }); expect(f.audit!.venue).toBe("kalshi"); expect(f.audit!.reachable).toBe(true);
    expect(f.notEstablished.join(" ")).not.toMatch(/polymarket_/); expect(f.heap!.budgetMb).toBe(350); expect(f.heap!.peakMb).toBeGreaterThan(0); expect(r.lines.length).toBeLessThanOrEqual(60); expect(r.lines.join("\n")).toContain("v_kalshi_audit.json");
  });
  it("polymarket_us: asks only the US host (the sports API first), reaches the per-sport route by default, and writes only its file", async () => {
    const r = await run(runTimestampAuditCli, ["--venue", "polymarket_us", "--no-fixtures"], allHandler); expect(r.code).toBe(EXIT.OK); expect(hosts(r.f.calls)).toEqual([US_HOST]); expect(Object.keys(r.files)).toEqual([`${OUT}/v_polymarket_us_audit.json`]);
    const f = auditFile(r, "polymarket_us"); expect(f.audit!.venue).toBe("polymarket_us"); expect(f.sportsApi).not.toBeNull(); expect(f.schedule).not.toBeNull(); expect(r.f.calls.some((c) => c.url.includes("/v2/sports"))).toBe(true);
  });
  it("polymarket_intl: asks only Gamma, never the US or Kalshi host", async () => {
    const r = await run(runTimestampAuditCli, ["--venue", "intl", "--no-fixtures"], allHandler); expect(r.code).toBe(EXIT.OK); expect(hosts(r.f.calls)).toEqual(["gamma-api.polymarket.com"]); expect(Object.keys(r.files)).toEqual([`${OUT}/v_polymarket_intl_audit.json`]); expect(auditFile(r, "polymarket_intl").audit!.venue).toBe("polymarket_intl");
  });
  it("fixtures of a single-venue run hold only that venue's samples", async () => {
    const r = await run(runTimestampAuditCli, ["--venue", "kalshi"], allHandler); const fx = Object.keys(r.files).filter((p) => p.startsWith("tests/fixtures/")); expect(fx.length).toBeGreaterThan(0); for (const p of fx) expect(p).toContain("s1a_kalshi_");
  });
  it("--with-db is for the international venue only: for another venue it is ignored with a note and the database is not touched", async () => {
    const spy = memDb({}); const r = await run(runTimestampAuditCli, ["--venue", "kalshi", "--with-db", "--no-fixtures"], allHandler, { env: ENV, db: spy }); expect(r.code).toBe(EXIT.OK); expect(r.lines.join("\n")).toContain("--with-db applies to polymarket_intl only"); expect(spy.reads).toHaveLength(0);
  });
  it("a bad --venue, or --venue polymarket_us with --no-us, is refused before anything is fetched", async () => {
    const a = await run(runTimestampAuditCli, ["--venue", "bing"], allHandler); expect(a.code).toBe(EXIT.CONFIG); expect(a.lines.join(" ")).toContain("--venue must be"); expect(a.f.calls).toHaveLength(0);
    const b = await run(runTimestampAuditCli, ["--venue", "us", "--no-us"], allHandler); expect(b.code).toBe(EXIT.CONFIG); expect(b.f.calls).toHaveLength(0);
  });
  it("the all-in-one command still works for a small run (every venue, the combined files, no evidence files)", async () => {
    const r = await run(runTimestampAuditCli, ["--kalshi", "--no-fixtures"], allHandler); expect(r.code).toBe(EXIT.OK); expect(hosts(r.f.calls)).toEqual([KALSHI_HOST, US_HOST, "gamma-api.polymarket.com"].sort()); expect(Object.keys(r.files)).toContain(`${OUT}/s1a_summary.json`); expect(Object.keys(r.files).some((p) => p.includes("/v_"))).toBe(false);
  });
});

describe("the heap budget stops a run with a message, a partial file and exit 3 (never a crash)", () => {
  const over = () => 400 * MB;
  it("audit --venue kalshi: names the venue and the stage, sends no request, writes a stopped file the merge can show", async () => {
    const r = await run(runTimestampAuditCli, ["--venue", "kalshi", "--no-fixtures"], allHandler, { heapUsed: over }); expect(r.code).toBe(EXIT.BUDGET); expect(EXIT.BUDGET).toBe(3);
    expect(r.lines[0]).toContain('STOPPED (heap budget): venue kalshi, stage "listing"'); expect(r.lines[0]).toContain("400 MB"); expect(r.f.calls).toHaveLength(0);
    const f = auditFile(r, "kalshi"); expect(f.stopped).toMatchObject({ reason: "heap_budget", stage: "listing" }); expect(f.audit).toBeNull(); expect(f.heap!.peakMb).toBeCloseTo(400, 0);
  });
  it("audit all-in-one: the message names the venue it was in", async () => {
    const r = await run(runTimestampAuditCli, ["--kalshi", "--no-fixtures"], allHandler, { heapUsed: over }); expect(r.code).toBe(EXIT.BUDGET); expect(r.lines[0]).toMatch(/venue polymarket_intl, stage "markets"/);
  });
  it("a real-meter budget of 1 MB also stops (the default meter is process.memoryUsage)", async () => {
    const r = await run(runTimestampAuditCli, ["--venue", "kalshi", "--no-fixtures", "--heap-budget-mb", "1"], allHandler); expect(r.code).toBe(EXIT.BUDGET); expect(r.lines[0]).toContain("venue kalshi"); expect(r.lines[0]).toContain("1 MB");
  });
  it("a heap limit reached half-way through a listing stops at the next request, after the pages already fetched", async () => {
    let n = 0; const meter = () => (n >= 5 ? 500 * MB : 10 * MB); const big = bigKalshi(4000); const h = (u: URL) => { n++; return big.handler(u); };
    const r = await run(runTimestampAuditCli, ["--venue", "kalshi", "--no-fixtures"], h, { heapUsed: meter }); expect(r.code).toBe(EXIT.BUDGET); expect(r.lines[0]).toMatch(/stage "listing, request \d+"/); expect(r.f.calls.length).toBeGreaterThanOrEqual(4); expect(r.f.calls.length).toBeLessThanOrEqual(6);
  });
  it("coverage --venue polymarket_us: exit 3, a partial coverage file, the stage named", async () => {
    const spy = memDb({ signals: [sig("1")] }); const r = await run(runCoverageCli, ["--venue", "polymarket_us"], allHandler, { env: ENV, db: spy, heapUsed: over }); expect(r.code).toBe(EXIT.BUDGET); expect(r.lines[0]).toContain("STOPPED (heap budget): venue polymarket_us");
    const f = JSON.parse(r.files[`${OUT}/v_polymarket_us_coverage.json`]) as VenueCoverageFile; expect(f.stopped?.reason).toBe("heap_budget"); expect(f.result).toBeNull(); expect(spy.touched).toEqual([]);
  });
  it("title search --venue kalshi: exit 3 and a partial titles file", async () => {
    const spy = memDb({ signals: [sig("1")] }); const r = await run(runTitleSearchCli, ["--venue", "kalshi"], allHandler, { env: ENV, db: spy, heapUsed: over }); expect(r.code).toBe(EXIT.BUDGET); expect(r.lines.join("\n")).toContain("STOPPED (heap budget): venue kalshi");
    const f = JSON.parse(r.files[`${OUT}/v_kalshi_titles.json`]) as VenueTitlesFile; expect(f.stopped?.reason).toBe("heap_budget");
  });
  it("title search stops part-way: the pairs answered before the stop are kept in the file", async () => {
    const sigs = Array.from({ length: 6 }, (_, i) => sig(String(i), { title: `Team ${i}a vs Team ${i}b`, outcome: `Team ${i}a`, slug: `s-${i}` })); let n = 0;
    const r = await run(runTitleSearchCli, ["--venue", "polymarket_us"], (u) => (u.pathname === "/v1/search" ? json({ events: [] }) : new Response("no", { status: 404 })), { env: ENV, db: memDb({ signals: sigs }), heapUsed: () => (++n > 4 ? 500 * MB : 10 * MB) });
    expect(r.code).toBe(EXIT.BUDGET); const f = JSON.parse(r.files[`${OUT}/v_polymarket_us_titles.json`]) as VenueTitlesFile; expect(f.stopped?.reason).toBe("heap_budget"); expect(f.rows.length).toBeGreaterThan(0); expect(f.rows.length).toBeLessThan(6); expect(f.unsearched.pairs).toBe(6 - f.rows.length);
  });
});

describe("40,000-market listings, each in its own process, inside the default 350 MB budget", () => {
  it("Kalshi: the audit of a 40,000-market listing completes with --venue kalshi and never holds anything else", async () => {
    const big = bigKalshi(40_000); const r = await run(runTimestampAuditCli, ["--venue", "kalshi", "--no-fixtures", "--kalshi-max", "40000"], big.handler);
    expect(r.code).toBe(EXIT.OK); const f = auditFile(r, "kalshi"); expect(f.stopped).toBeNull(); expect(f.audit!.listing!.total).toBe(40_000); expect(f.heap!.peakMb).toBeLessThan(DEFAULT_HEAP_BUDGET_MB); expect(f.heap!.budgetMb).toBe(350); expect(big.hits.nested).toBeGreaterThan(0);
  }, 120_000);
  it("Kalshi: the title search over a 40,000-market listing completes and its file holds refs, not the listing", async () => {
    const big = bigKalshi(40_000); const spy = memDb({ signals: [sig("1", { title: "Team O10a vs Team O10b", outcome: "Team O10a" }), sig("2")] });
    const r = await run(runTitleSearchCli, ["--venue", "kalshi", "--kalshi-max", "40000"], big.handler, { env: ENV, db: spy }); expect(r.code).toBe(EXIT.OK); const f = JSON.parse(r.files[`${OUT}/v_kalshi_titles.json`]) as VenueTitlesFile;
    expect(f.stopped).toBeNull(); expect(f.listingMarkets).toBe(40_000); expect(f.heap!.peakMb).toBeLessThan(DEFAULT_HEAP_BUDGET_MB); expect(f.rows).toHaveLength(2); expect(r.files[`${OUT}/v_kalshi_titles.json`].length).toBeLessThan(200_000);
  }, 120_000);
  it("Kalshi: the coverage of a 40,000-market listing completes", async () => {
    const big = bigKalshi(40_000); const spy = memDb({ signals: [sig("1"), sig("2", { title: "Team O10a vs Team O10b", outcome: "Team O10a" })] });
    const r = await run(runCoverageCli, ["--venue", "kalshi", "--kalshi-max", "40000"], big.handler, { env: ENV, db: spy }); expect(r.code).toBe(EXIT.OK); const f = JSON.parse(r.files[`${OUT}/v_kalshi_coverage.json`]) as VenueCoverageFile; expect(f.stopped).toBeNull(); expect(f.heap!.peakMb).toBeLessThan(DEFAULT_HEAP_BUDGET_MB); expect((f.result as any).listing.counts.total).toBe(40_000); expect(spy.touched).toEqual([]);
  }, 120_000);
  it("US exchange: the coverage diagnostic over a 40,000-market listing completes with --venue polymarket_us", async () => {
    const big = bigUs(40_000); const spy = memDb({ signals: [sig("1"), sig("2", { title: "Team o10a vs Team o10b", outcome: "Team o10a" })] });
    const r = await run(runCoverageCli, ["--venue", "polymarket_us", "--diagnose", "--us-max", "40000"], big.handler, { env: ENV, db: spy }); expect(r.code).toBe(EXIT.OK); const f = JSON.parse(r.files[`${OUT}/v_polymarket_us_coverage.json`]) as VenueCoverageFile;
    expect(f.stopped).toBeNull(); expect(f.heap!.peakMb).toBeLessThan(DEFAULT_HEAP_BUDGET_MB); expect((f.result as any).diagnostic.listing.all.markets).toBeGreaterThanOrEqual(40_000); expect(hosts(r.f.calls)).toEqual([US_HOST]); expect(spy.touched).toEqual([]);
  }, 120_000);
  it("an over-large input stops with the message instead of crashing: the same listings under a budget just above this process's live heap", async () => {
    collectGarbage(); const base = Math.ceil(process.memoryUsage().heapUsed / MB); const small = String(base + 12);
    const big = bigKalshi(40_000); const r = await run(runTimestampAuditCli, ["--venue", "kalshi", "--no-fixtures", "--kalshi-max", "40000", "--heap-budget-mb", small], big.handler);
    expect(r.code).toBe(EXIT.BUDGET); expect(r.lines[0]).toMatch(new RegExp(`^STOPPED \\(heap budget\\): venue kalshi, stage "listing, request \\d+": \\d+ MB of heap in use exceeds the budget of ${small} MB`)); const f = auditFile(r, "kalshi"); expect(f.stopped?.stage).toMatch(/^listing, request \d+/); expect(big.hits.n).toBeLessThan(150);
    const big2 = bigUs(40_000); collectGarbage(); const small2 = String(Math.ceil(process.memoryUsage().heapUsed / MB) + 12); const r2 = await run(runCoverageCli, ["--venue", "polymarket_us", "--diagnose", "--us-max", "40000", "--heap-budget-mb", small2], big2.handler, { env: ENV, db: memDb({ signals: [sig("1")] }) });
    expect(r2.code).toBe(EXIT.BUDGET); expect(r2.lines[0]).toMatch(/^STOPPED \(heap budget\): venue polymarket_us, stage "listing, request \d+"/);
  }, 120_000);
});

describe("phase4:coverage --venue", () => {
  const db = () => memDb({ signals: [sig("1"), sig("2", { wallet: "0xw2", payload: { copyScore: 60 } })], markets: [{ condition_id: "0xc1", end_date: "2026-10-03" }] });
  it("polymarket_us: only the US host, one evidence file with the funnel, the venue's CSVs renamed after it, no combined s1b_*.json", async () => {
    const spy = db(); const r = await run(runCoverageCli, ["--venue", "polymarket_us", "--diagnose"], allHandler, { env: ENV, db: spy }); expect(r.code).toBe(EXIT.OK); expect(hosts(r.f.calls)).toEqual([US_HOST]);
    expect(Object.keys(r.files).sort()).toEqual([`${OUT}/v_polymarket_us_coverage.json`, `${OUT}/v_polymarket_us_s1b_mapping_diagnostic.csv`, `${OUT}/v_polymarket_us_s1b_mapping_review.csv`]); const f = JSON.parse(r.files[`${OUT}/v_polymarket_us_coverage.json`]) as VenueCoverageFile;
    expect(f).toMatchObject({ kind: "coverage", venue: "polymarket_us", stopped: null }); expect((f.result as any).counts).toMatchObject({ signals: 2, withScore: 1 }); expect(spy.touched).toEqual([]); expect(r.lines.length).toBeLessThanOrEqual(60);
  });
  it("kalshi: only the Kalshi host", async () => {
    const spy = db(); const r = await run(runCoverageCli, ["--venue", "kalshi"], allHandler, { env: ENV, db: spy }); expect(r.code).toBe(EXIT.OK); expect(hosts(r.f.calls)).toEqual([KALSHI_HOST]); expect(Object.keys(r.files)).toContain(`${OUT}/v_kalshi_coverage.json`); expect(Object.keys(r.files).some((p) => p.endsWith("s1b_funnel.json"))).toBe(false);
  });
  it("polymarket_intl: the database side only (the signal window, the category mix, the settled paper trades), no venue request at all", async () => {
    const spy = db(); const r = await run(runCoverageCli, ["--venue", "polymarket_intl"], allHandler, { env: ENV, db: spy }); expect(r.code).toBe(EXIT.OK); expect(r.f.calls).toHaveLength(0); const f = JSON.parse(r.files[`${OUT}/v_polymarket_intl_coverage.json`]) as VenueCoverageFile;
    expect(f.venue).toBe("polymarket_intl"); expect((f.result as any).counts.signals).toBe(2); expect((f.result as any).feasibility).toBeTruthy(); expect((f.result as any).diagnostic.categoryMix.length).toBeGreaterThan(0);
  });
  it("the recommendations come from the venue's own audit file first, then from the combined summary", async () => {
    const spy = db(); const c = virtualClock(NOW); const w = files(); const a = await run(runTimestampAuditCli, ["--venue", "polymarket_us", "--no-fixtures"], allHandler); w.out[`${OUT}/v_polymarket_us_audit.json`] = a.files[`${OUT}/v_polymarket_us_audit.json`];
    const f = fakeFetch(allHandler, c.now); const code = await runCoverageCli(["--venue", "polymarket_us"], ENV, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: w.writeFile, mkdir: w.mkdir, readFile: w.readFile, log: () => {}, db: () => readOnly(spy.db as never) });
    expect(code).toBe(EXIT.OK); const res = JSON.parse(w.out[`${OUT}/v_polymarket_us_coverage.json`]).result; expect(res.venue.measured.timestamp).toBe(true);
  });
  it("contradicting flags and a bad venue are refused before the database is touched", async () => {
    const spy = db(); for (const argv of [["--venue", "kalshi", "--kalshi"], ["--venue", "us", "--no-venue"], ["--venue", "bing"]]) { const r = await run(runCoverageCli, argv, allHandler, { env: ENV, db: spy }); expect(r.code, argv.join(" ")).toBe(EXIT.CONFIG); }
    expect(spy.reads).toHaveLength(0);
  });
  it("the all-in-one coverage (US + Kalshi) still works and writes the combined files", async () => {
    const spy = db(); const r = await run(runCoverageCli, ["--kalshi"], allHandler, { env: ENV, db: spy }); expect(r.code).toBe(EXIT.OK); expect(Object.keys(r.files)).toContain(`${OUT}/s1b_funnel.json`); expect(Object.keys(r.files)).toContain(`${OUT}/s1b_funnel_kalshi.json`);
  });
});

describe("phase4:title-search --venue", () => {
  const sigs = [sig("1"), sig("2", { title: "Bulls vs. Heat", outcome: "Bulls", slug: "nba-chi-mia" })];
  const usSearch = (u: URL): Response => (u.host === US_HOST && u.pathname === "/v1/search" ? json({ events: [{ title: "Lakers vs Celtics", slug: "nba-lal-bos", markets: [{ id: "u1", question: "Lakers vs Celtics", outcomes: '["Lakers","Celtics"]' }] }] }) : new Response("no", { status: 404 }));
  it("polymarket_intl is the signal source: nothing to search, refused before the database is touched", async () => { const spy = memDb({ signals: sigs }); const r = await run(runTitleSearchCli, ["--venue", "polymarket_intl"], usSearch, { env: ENV, db: spy }); expect(r.code).toBe(EXIT.CONFIG); expect(r.lines.join(" ")).toContain("signal source"); expect(spy.reads).toHaveLength(0); });
  it("polymarket_us: only the US host; the evidence file carries the pairs, the pace used and a reached count", async () => {
    const r = await run(runTitleSearchCli, ["--venue", "polymarket_us"], usSearch, { env: ENV, db: memDb({ signals: sigs }) }); expect(r.code).toBe(EXIT.OK); expect(hosts(r.f.calls)).toEqual([US_HOST]); const f = JSON.parse(r.files[`${OUT}/v_polymarket_us_titles.json`]) as VenueTitlesFile;
    expect(f).toMatchObject({ kind: "titles", venue: "polymarket_us", allScores: false, stopped: null }); expect(f.summary).toMatchObject({ pairs: 2, reachedPairs: 2, paceMs: 1100, requestsPerMinute: 54.5, refusal: null }); expect(f.rows).toHaveLength(2); expect(f.unsearched).toEqual({ pairs: 0, signals: 0 });
    expect(Object.keys(r.files).sort()).toEqual([`${OUT}/s1b_title_search_polymarket_us.csv`, `${OUT}/v_polymarket_us_titles.json`]);
  });
});
