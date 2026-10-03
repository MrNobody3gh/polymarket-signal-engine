/**
 * Phase 4.0c, Part D3 — S1_COMPACT.md: at most 80 lines whatever the data, one row per venue × stratum × slot with the best field, the verdict, the events and
 * the deciding rule, one funnel table, missing inputs stated and never guessed; and the S1a / coverage / title-search command lines end to end with Kalshi.
 */
import { describe, expect, it } from "vitest";
import { COMPACT_FILE, COMPACT_MAX_LINES, renderCompact, ruleText, writeCompact } from "../src/lib/phase4/compact";
import { EXIT, printFiles, runTimestampAuditCli, runTitleSearchCli } from "../src/lib/phase4/cli";
import { readOnly } from "../src/lib/phase4/readonly-db";
import { computeFunnel, type FunnelRow } from "../src/lib/phase4/funnel";
import type { SlotVerdict } from "../src/lib/phase4/audit";
import { fakeFetch, json, memDb, virtualClock } from "./helpers/phase4Db";
import { KALSHI_BASE, funnelEvents, kalshiServer, nbaEvents, type Raw } from "./helpers/phase4Kalshi";

const NOW = Date.parse("2026-10-03T00:00:00Z");
const cand = (field: string, verdict: "RECOMMEND" | "UNRELIABLE_REJECT" | "INSUFFICIENT_DATA", decidedBy: any, best = false) => ({ field, role: "START_LIKE" as const, verdict, decidedBy, failedRules: decidedBy === "allPassed" ? [] : [decidedBy], failed: [], presentEvents: 50, usableShare: 1, presentShare: 1, placeholderShare: 0, etPlaceholderShare: 0, evidence: {}, best });
const rec = (venue: string, stratum: string, slot: 1 | 2, o: Partial<SlotVerdict> = {}): SlotVerdict => ({ venue, stratum, slot, field: "gameStartTime", verdict: "RECOMMEND", usableShare: 1, presentShare: 1, placeholderShare: 0, failed: [], evidence: {}, needsHumanReview: false, events: 100, markets: 200, etPlaceholderShare: 0, decidedBy: "allPassed", failedRules: [], candidates: [cand("gameStartTime", "RECOMMEND", "allPassed", true), cand("startDate", "UNRELIABLE_REJECT", "creationCoincidence")], bestField: "gameStartTime", ...o });
const funnelFile = (n: number) => { const rows: FunnelRow[] = Array.from({ length: 20 }, (_, i) => ({ signalId: `s${i}`, createdAtMs: NOW - 2 * 86_400_000 + i * 3_600_000, evalMs: NOW - 86_400_000 + i * 3_600_000, kind: "NEW_POSITION", wallet: `w${i % 4}`, category: "x", copyScore: 80, mapping: i < n ? "EXACT" : "NONE", tradable: true, eventMs: NOW - 86_400_000 + i * 3_600_000 + 7_200_000 })); return { window: { startIso: "2026-10-01T00:00:00Z", endIso: "2026-10-03T00:00:00Z" }, funnel: computeFunnel(rows, { startMs: NOW - 2 * 86_400_000, endMs: NOW, measured: { mapping: true, tradable: true, timestamp: true } }) }; };

describe("renderCompact", () => {
  const venues = (n: number) => ["polymarket_us", "kalshi", "polymarket_intl"].map((v) => ({ venue: v, reachable: true, recommendations: Array.from({ length: n }, (_, i) => rec(v, `stratum-${String(i).padStart(2, "0")}`, (1 + (i % 2)) as 1 | 2, { events: 200 - i })) }));
  it("never more than 80 lines, however many venues, strata and slots: rows are dropped (least informative first) with one line saying how many", () => {
    for (const n of [1, 10, 40, 200]) { const text = renderCompact({ s1a: { startedAt: "a", finishedAt: "b", venues: venues(n) }, funnels: [{ venue: "polymarket_us", file: funnelFile(10) }, { venue: "kalshi", file: funnelFile(5) }] }); const lines = text.trimEnd().split("\n"); expect(lines.length, `n=${n}`).toBeLessThanOrEqual(COMPACT_MAX_LINES); if (n >= 40) expect(text).toMatch(/… \d+ more rows/); }
    expect(COMPACT_MAX_LINES).toBe(80); expect(COMPACT_FILE).toBe("S1_COMPACT.md");
  });
  it("informative rows (≥ 30 events, or a passing field) come first; thin strata are the ones dropped", () => {
    const v = [{ venue: "kalshi", reachable: true, recommendations: [...Array.from({ length: 70 }, (_, i) => rec("kalshi", `thin-${String(i).padStart(2, "0")}`, 1, { events: 5, bestField: null, field: null, verdict: "INSUFFICIENT_DATA", candidates: [] })), rec("kalshi", "big", 1, { events: 300 })] }];
    const text = renderCompact({ s1a: { venues: v }, funnels: [] }); expect(text).toContain("| Kalshi | big | 1 |"); expect(text).toMatch(/… \d+ more rows/); expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(80);
  });
  it("a row carries the best field, the verdict, the events and the deciding rule with the other candidates' rules", () => {
    const text = renderCompact({ s1a: { venues: [{ venue: "polymarket_us", reachable: true, recommendations: [rec("polymarket_us", "sports:basketball", 1, { events: 266 }), rec("polymarket_us", "politics", 1, { bestField: null, field: "startDate", verdict: "UNRELIABLE_REJECT", events: 80, candidates: [cand("gameStartTime", "INSUFFICIENT_DATA", "evidenceGap"), cand("startDate", "UNRELIABLE_REJECT", "creationCoincidence")] }), rec("polymarket_us", "esports", 2, { events: 40 })] }] }, funnels: [] });
    expect(text).toContain("| US | sports:basketball | 1 | `gameStartTime` | OK | 266 | allPassed; also startDate:creationCoincidence |"); expect(text).toContain("| US | politics | 1 | NONE | REJECT | 80 | gameStartTime:evidenceGap, startDate:creationCoincidence |"); expect(text).toContain("| US | esports | 2 | `gameStartTime` | OK (human review) | 40 |");
  });
  it("an unreachable venue is a row, never silence; an old summary without candidates falls back to the single field", () => {
    const text = renderCompact({ s1a: { venues: [{ venue: "kalshi", reachable: false }, { venue: "polymarket_us", reachable: true, recommendations: [{ ...rec("polymarket_us", "x", 1), candidates: undefined, bestField: undefined, field: "endDate" }] }] }, funnels: [] }); expect(text).toContain("| Kalshi | (venue) | — | NONE | NOT REACHED | 0 | no markets fetched |"); expect(text).toContain("| US | x | 1 | `endDate` | OK | 100 | allPassed |");
  });
  it("the funnel table lists each venue's EXACT / EXACT+PROBABLE counts per stage and the final-stage rate; n/m for an unmeasured stage", () => {
    const f = funnelFile(10); const text = renderCompact({ s1a: null, funnels: [{ venue: "polymarket_us", file: f }, { venue: "kalshi", file: { ...f, funnel: { ...f.funnel, variants: { ...f.funnel.variants, EXACT: { ...f.funnel.variants.EXACT, counts: f.funnel.variants.EXACT.counts.map((c, i) => (i >= 4 ? null : c)) } } } } }] });
    expect(text).toContain("| stage | US | Kalshi |"); expect(text).toContain("| all entry signals | 20 / 20 | 20 / 20 |"); expect(text).toMatch(/\| market mapped on the execution venue \| 10 \/ 10 \| 10 \/ 10 \|/); expect(text).toMatch(/\| usable event timestamp[^|]* \| 10 \/ 10 \| n\/m \/ 10 \|/); expect(text).toContain("s1a_summary.json not found"); expect(text).toContain("Final stage per elapsed day (EXACT): US");
  });
  it("missing inputs are stated, never guessed", () => { const t = renderCompact({ s1a: null, funnels: [{ venue: "polymarket_us", file: null }, { venue: "kalshi", file: null }] }); expect(t).toContain("s1a_summary.json not found"); expect(t).toContain("s1b_funnel*.json not found"); expect(t.split("\n").length).toBeLessThan(20); });
  it("writeCompact reads the three JSON files (unreadable ones count as missing) and writes S1_COMPACT.md, honouring an in-memory S1a summary", () => {
    const store: Record<string, string> = { "s1a_summary.json": JSON.stringify({ venues: venues(2) }), "s1b_funnel.json": JSON.stringify(funnelFile(10)), "s1b_funnel_kalshi.json": "{ not json" }; const out: Record<string, string> = {};
    writeCompact((r) => store[r] ?? null, (r, c) => (out[r] = c)); expect(out[COMPACT_FILE]).toContain("| US | stratum-00 | 1 |"); expect(out[COMPACT_FILE]).toContain("| stage | US |"); expect(out[COMPACT_FILE]).not.toContain("| US | Kalshi |");
    const out2: Record<string, string> = {}; writeCompact(() => null, (r, c) => (out2[r] = c), { s1a: { venues: venues(1) } }); expect(out2[COMPACT_FILE]).toContain("| Kalshi | stratum-00 | 1 |"); expect(out2[COMPACT_FILE]).toContain("s1b_funnel*.json not found");
    expect(ruleText(rec("v", "s", 1, { candidates: undefined, bestField: null, field: null, verdict: "UNRELIABLE_REJECT", decidedBy: "noField" }))).toBe("noField");
  });
  it("--print-files S1_COMPACT.md returns it from a log-only host, paced (≤ 200 lines per second)", async () => {
    const text = renderCompact({ s1a: { venues: venues(40) }, funnels: [{ venue: "polymarket_us", file: funnelFile(10) }] }); const lines: string[] = []; const sleeps: number[] = [];
    await printFiles(["S1_COMPACT.md"], { outDir: "out", readFile: (p) => (p === "out/S1_COMPACT.md" ? text : null), log: (l) => lines.push(l), sleep: async (ms) => { sleeps.push(ms); } }); expect(lines[0]).toBe("=====FILE S1_COMPACT.md"); expect(lines[lines.length - 1]).toBe("=====END S1_COMPACT.md"); expect(lines.length).toBeLessThanOrEqual(82); expect(sleeps).toEqual([]);
  });
});

const files = () => { const out: Record<string, string> = {}; return { out, writeFile: (p: string, c: string) => { out[p] = c; }, mkdir: () => {} }; };
describe("S1a with --kalshi, end to end", () => {
  const world = () => ({ open: [...nbaEvents("o", 45, false), ...funnelEvents().open], settled: nbaEvents("s", 45, true) });
  const milestones = (n: number): Raw[] => nbaEvents("o", n, false).map((e, i) => ({ id: `ms${i}`, category: "Sports", type: "basketball_game", title: String(e.title), start_date: i % 3 === 0 ? new Date(Date.parse(String(e.strike_date)) + 10 * 60_000).toISOString() : e.strike_date, primary_event_tickers: [e.event_ticker] }));
  const run = async (argv: string[], h?: Parameters<typeof fakeFetch>[0], ms: Raw[] = milestones(30)) => { const c = virtualClock(NOW); const srv = kalshiServer(world(), { milestones: ms }); const f = fakeFetch(h ?? ((u) => (u.host === "gamma-api.polymarket.com" ? json({ markets: [], next_cursor: null }) : srv.handler(u))), c.now); const w = files(); const lines: string[] = [];
    const code = await runTimestampAuditCli(["--no-fixtures", "--no-us", "--kalshi", ...argv], {}, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: w.writeFile, mkdir: w.mkdir, readFile: (p) => w.out[p] ?? null, log: (l) => lines.push(l) }); return { code, f, files: w.out, lines, srv }; };
  it("audits Kalshi as a third venue: listing counts by category, per-candidate verdicts, the strike date judged as a start, the compact file, ≤ 60 console lines", async () => {
    const r = await run([]); expect(r.code).toBe(EXIT.OK); expect(r.lines.length).toBeLessThanOrEqual(60); const k = JSON.parse(r.files["docs/phase4/data/s1a_kalshi.json"]);
    expect(k.reachable).toBe(true); expect(k.listing.byBucket).toEqual({ open: 93, settled: 90 }); expect(k.listing.byCategory.Sports).toMatchObject({ open: 93, settled: 90 }); expect(k.listing.total).toBe(183); expect(k.listing.distinctEvents).toBe(45 + 3 + 45);
    const s1 = k.recommendations.find((x: SlotVerdict) => x.stratum === "sports:basketball" && x.slot === 1); expect(s1.bestField).toBe("event.strike_date"); const c = Object.fromEntries(s1.candidates.map((x: any) => [x.field, x])); expect(Object.keys(c)).toEqual(["event.strike_date"]); expect(c["event.strike_date"]).toMatchObject({ role: "OTHER_TIME", verdict: "RECOMMEND", best: true });
    // the settlement backstops and the forecast are RESOLUTION-like references, not candidates; open_time is a listing-like time
    const roles = Object.fromEntries(k.inventory.map((f: any) => [f.path, f.role])); expect(roles).toMatchObject({ open_time: "CREATION_LIKE", close_time: "CLOSE_LIKE", expected_expiration_time: "RESOLUTION_LIKE", latest_expiration_time: "RESOLUTION_LIKE", created_time: "CREATION_LIKE", "event.strike_date": "OTHER_TIME" });
    const text = r.lines.join("\n"); expect(text).toContain("[kalshi]"); expect(text).toMatch(/listing: 183 markets, 93 events; open \d+ · settled 90/); expect(text).toContain("S1_COMPACT.md");
    const compact = r.files["docs/phase4/data/S1_COMPACT.md"]; expect(compact.split("\n").length).toBeLessThanOrEqual(81); expect(compact).toMatch(/\| Kalshi \| sports:basketball \| 1 \| `event\.strike_date` \| OK \|/);
    expect(r.files["docs/phase4/data/S1a_RESULTS.md"]).toContain("### Listing (bounded)"); expect(r.files["docs/phase4/data/S1a_RESULTS.md"]).toContain("| Sports | 93 | 0 | 0 | 90 | 183 |");
  });
  it("the milestone schedule source is compared with the event strike date: how many agree within a minute and within 15 minutes", async () => {
    const r = await run([]); const s = JSON.parse(r.files["docs/phase4/data/s1a_summary.json"]).schedule.kalshi; expect(s).toHaveLength(1); expect(s[0]).toMatchObject({ sport: "Sports", events: 30, both: 30, agreeWithin1Min: 20, agreeWithin15Min: 30, agreeShare: 0.667 }); expect(s[0].absDiffMin.max).toBe(10);
    expect(r.files["docs/phase4/data/S1a_RESULTS.md"]).toContain("Kalshi: milestone start_date versus event strike_date");
  });
  it("no milestones endpoint (404) is a note, not a failure", async () => {
    const r = await run([], (u) => (u.host === "gamma-api.polymarket.com" ? json({ markets: [], next_cursor: null }) : u.pathname.endsWith("/milestones") ? new Response("no", { status: 404 }) : kalshiServer(world()).handler(u))); expect(r.code).toBe(0); expect(JSON.parse(r.files["docs/phase4/data/s1a_summary.json"]).schedule.notes.join(" ")).toContain("kalshi milestones: NOT_FOUND");
  });
  it("--kalshi-max caps the listing; a refusal is reported as NOT REACHED with the exact outcome, nothing else is asked of that host, and the compact file has the row", async () => {
    const a = await run(["--kalshi-max", "30"]); const k = JSON.parse(a.files["docs/phase4/data/s1a_kalshi.json"]); expect(k.listing.total).toBeLessThanOrEqual(30); expect(k.fetch.open.stoppedBecause).toBe("sample size reached");
    const b = await run([], (u) => (u.host.includes("kalshi") ? new Response("Host not in allowlist", { status: 403 }) : json({ markets: [], next_cursor: null }))); expect(b.code).toBe(0); expect(b.lines.join("\n")).toMatch(/NOT REACHED — https:\/\/api\.elections\.kalshi\.com.*BLOCKED 403/s); expect(b.f.calls.filter((c) => c.url.includes("kalshi")).length).toBe(1);
    expect(b.files["docs/phase4/data/S1_COMPACT.md"]).toContain("| Kalshi | (venue) | — | NONE | NOT REACHED |");
  });
  it("without --kalshi nothing is sent to Kalshi and no Kalshi file exists", async () => { const c = virtualClock(NOW); const f = fakeFetch(() => json({ markets: [], next_cursor: null }), c.now); const w = files(); await runTimestampAuditCli(["--no-fixtures", "--no-us"], {}, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: w.writeFile, mkdir: w.mkdir, log: () => {} }); expect(f.calls.some((x) => x.url.includes("kalshi"))).toBe(false); expect(Object.keys(w.out).some((p) => p.includes("kalshi"))).toBe(false); });
  it("only public GETs to Kalshi, no credential header, at least 500 ms apart", async () => { const r = await run([]); const k = r.f.calls.filter((c) => c.url.includes("kalshi")); expect(k.length).toBeGreaterThanOrEqual(5); for (const c of k) { expect(c.method).toBe("GET"); expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]); expect(c.url).not.toMatch(/portfolio|orders|balance/); } for (let i = 1; i < k.length; i++) expect(k[i].at! - k[i - 1].at!).toBeGreaterThanOrEqual(500); });
});

describe("the title-search command line", () => {
  const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-never-logged" };
  const z = (s: string) => new Date(Date.parse(s)).toISOString();
  const sig = (id: string, o: Record<string, unknown>) => ({ id, kind: "NEW_POSITION", wallet: `0xw${id}`, condition_id: `0xc${id}`, token_id: `tok${id}`, outcome: "Lakers", title: "Lakers vs. Celtics", slug: "nba-lal-bos", created_at: z("2026-10-02T10:00:00Z"), payload: { copyScore: 80 }, ...o });
  const SIGNALS = [sig("1", {}), sig("2", { title: "Bulls vs. Heat", outcome: "Bulls", slug: "nba-chi-mia" }), sig("3", { title: "Will it rain tomorrow?", outcome: "Yes", slug: "rain" }), sig("4", { payload: { copyScore: 50 }, title: "Low score game", outcome: "A" }), sig("x", { kind: "EXIT" })];
  const usAnswer = (q: string) => (q.includes("lakers") ? { events: [{ title: "Lakers vs Celtics", slug: "nba-lal-bos", markets: [{ id: "u1", question: "Lakers vs Celtics", outcomes: '["Lakers","Celtics"]' }] }] } : { events: [] });
  const kalshiWorld = () => ({ open: funnelEvents().open, settled: funnelEvents().settled });
  const handler = (u: URL): Response => (u.host === "gateway.polymarket.us" ? (u.pathname === "/v1/search" ? json(usAnswer(u.searchParams.get("query") ?? "")) : new Response("no", { status: 404 })) : kalshiServer(kalshiWorld()).handler(u));
  const run = async (argv: string[], o: { h?: Parameters<typeof fakeFetch>[0]; db?: ReturnType<typeof memDb> } = {}) => { const c = virtualClock(NOW); const f = fakeFetch(o.h ?? handler, c.now); const w = files(); const lines: string[] = []; const d = o.db ?? memDb({ signals: SIGNALS.map((s) => ({ ...s })) });
    const code = await runTitleSearchCli(argv, ENV, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: w.writeFile, mkdir: w.mkdir, readFile: (p) => w.out[p] ?? null, log: (l) => lines.push(l), db: () => readOnly(d.db as never) }); return { code, f, files: w.out, lines, d }; };
  it("looks up every score ≥ 68 pair on both venues, writes one CSV per venue and a summary, prints ≤ 60 lines, and reads the database with select only", async () => {
    const r = await run([]); expect(r.code).toBe(EXIT.OK); expect(r.lines.length).toBeLessThanOrEqual(60); expect(r.d.touched).toEqual([]); expect([...new Set(r.d.reads.map((x) => x.table))]).toEqual(["signals"]);
    expect(Object.keys(r.files).sort()).toEqual(["docs/phase4/data/s1b_title_search_kalshi.csv", "docs/phase4/data/s1b_title_search_polymarket_us.csv", "docs/phase4/data/s1b_title_search_summary.json"]);
    const sum = JSON.parse(r.files["docs/phase4/data/s1b_title_search_summary.json"]); const us = sum.find((s: any) => s.venue === "polymarket_us"), ka = sum.find((s: any) => s.venue === "kalshi");
    expect(us).toMatchObject({ pairs: 3, searched: 3, requests: 3, mode: "endpoint", withAnyCandidate: 1, noCandidate: 2, probable: 1, verified: false }); expect(ka).toMatchObject({ pairs: 3, searched: 3, requests: 0, mode: "listing" }); expect(ka.describe).toContain("no documented free-text search endpoint");
    expect(us.score68.byBestBand["≥ 0.90"]).toBe(1); expect(r.files["docs/phase4/data/s1b_title_search_polymarket_us.csv"].trim().split("\n")).toHaveLength(1 + 3); expect(r.files["docs/phase4/data/s1b_title_search_polymarket_us.csv"]).not.toContain("Low score game");
    const search = r.f.calls.filter((c) => c.url.includes("/v1/search")); expect(search.map((c) => new URL(c.url).searchParams.get("query")).sort()).toEqual(["bulls heat", "it rain tomorrow", "lakers celtics"]);
    expect(r.lines.join("\n")).toMatch(/\[polymarket_us\] search endpoint: 3\/3 pairs searched in 3 requests/); expect(r.lines.join("\n")).toMatch(/\[kalshi\] listing lookup/);
  });
  it("--all-scores includes the pairs below 68 (searched after the high-score ones)", async () => { const r = await run(["--all-scores", "--venue", "us"]); expect(JSON.parse(r.files["docs/phase4/data/s1b_title_search_summary.json"])[0]).toMatchObject({ pairs: 4, searched: 4 }); expect(r.f.calls.every((c) => new URL(c.url).host === "gateway.polymarket.us")).toBe(true); });
  it("a hard request budget stops with the clear message on the console and in the summary file", async () => { const r = await run(["--venue", "us", "--search-max-requests", "2"]); const s = JSON.parse(r.files["docs/phase4/data/s1b_title_search_summary.json"])[0]; expect(s).toMatchObject({ searched: 2, notSearched: 1, requests: 2 }); expect(s.stoppedBecause).toBe("request budget of 2 reached after 2 of 3 pairs (1 not searched); raise --search-max-requests to continue"); expect(r.lines.join("\n")).toContain("STOPPED: request budget of 2"); });
  it("the US origin is paced at 60 requests/minute; a refusal ends the US search at once with no workaround, and the Kalshi lookup still runs", async () => {
    const a = await run(["--venue", "us"]); const us = a.f.calls.filter((c) => c.url.includes("/v1/search")); for (let i = 1; i < us.length; i++) expect(us[i].at! - us[i - 1].at!).toBeGreaterThanOrEqual(1100);
    const b = await run([], { h: (u) => (u.host === "gateway.polymarket.us" ? new Response("denied", { status: 403 }) : handler(u)) }); expect(b.code).toBe(0); const sums = JSON.parse(b.files["docs/phase4/data/s1b_title_search_summary.json"]); expect(sums[0].stoppedBecause).toBe("polymarket_us refused access (BLOCKED 403) after 1 of 3 pairs; no workaround is attempted"); expect(sums[1].searched).toBe(3); expect(b.f.calls.filter((c) => c.url.includes("polymarket.us")).length).toBe(1);
  });
  it("Kalshi unreachable: the listing lookup says so, with the exact outcome", async () => { const r = await run(["--venue", "kalshi"], { h: (u) => (u.host.includes("kalshi") ? new Response("Host not in allowlist", { status: 403 }) : handler(u)) }); expect(r.code).toBe(0); const s = JSON.parse(r.files["docs/phase4/data/s1b_title_search_summary.json"])[0]; expect(s.stoppedBecause).toMatch(/Kalshi unreachable \(.*BLOCKED 403\)/); expect(s.withAnyCandidate).toBe(0); });
  it("configuration errors are refused BEFORE the database is touched: missing variables, a bad --venue, a --start without a time zone", async () => {
    const d = memDb({ signals: [] }); const lines: string[] = []; expect(await runTitleSearchCli([], {}, { log: (l) => lines.push(l) })).toBe(EXIT.CONFIG); expect(lines.join(" ")).toContain("must be set");
    const a = await run(["--venue", "bing"], { db: d }); expect(a.code).toBe(EXIT.CONFIG); expect(a.lines.join(" ")).toContain("--venue must be"); const b = await run(["--start", "2026-10-02T10:00:00"], { db: d }); expect(b.code).toBe(EXIT.CONFIG); expect(b.lines.join(" ")).toContain("time zone"); expect(d.reads).toHaveLength(0); expect(a.f.calls).toHaveLength(0);
    const h: string[] = []; expect(await runTitleSearchCli(["--help"], {}, { log: (l) => h.push(l) })).toBe(0); expect(h[0]).toContain("phase4:title-search");
  });
  it("only public GETs, no credential, and the service key is never printed or written", async () => { const r = await run([]); for (const c of r.f.calls) { expect(c.method).toBe("GET"); expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]); } expect(JSON.stringify(r.lines) + JSON.stringify(r.files)).not.toContain("service-role-secret-never-logged"); });
  it("--print-files returns the CSV and the summary from a log-only host", async () => { const r = await run(["--print-files", "s1b_title_search_summary.json"]); expect(r.lines).toContain("=====FILE s1b_title_search_summary.json"); expect(r.lines).toContain("=====END s1b_title_search_summary.json"); });
});
