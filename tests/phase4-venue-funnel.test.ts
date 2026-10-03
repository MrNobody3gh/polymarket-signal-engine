/**
 * Phase 4.0c, Part A4–A5 — the coverage funnel for Kalshi on a fixture world with hand-derived answers, its tradability and event-time rules, the three-way
 * category table, and the combined command-line run (US exchange and Kalshi from the same signal window, ≤ 60 printed lines, select-only database).
 */
import { describe, expect, it } from "vitest";
import { EXIT, runCoverageCli } from "../src/lib/phase4/cli";
import { readOnly } from "../src/lib/phase4/readonly-db";
import { PoliteHttp } from "../src/lib/phase4/http";
import { KALSHI_DEFAULTS, fetchKalshiListing } from "../src/lib/phase4/venue-kalshi";
import { categoryMix3, kalshiCoverageSummaryLines, kalshiDateLevel, kalshiEventTimeAt, kalshiTradableAt, mix3Lines, runKalshiCoverage } from "../src/lib/phase4/venue-funnel";
import type { SlotVerdict } from "../src/lib/phase4/audit";
import { fakeFetch, json, memDb, virtualClock } from "./helpers/phase4Db";
import { funnelEvents, kEvent, kalshiServer, type Raw } from "./helpers/phase4Kalshi";

const NOW = Date.parse("2026-10-03T00:00:00Z"); const z = (s: string) => new Date(Date.parse(s)).toISOString();
const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-never-logged" };
const sig = (id: string, o: Partial<Record<string, any>>) => ({ id, kind: "NEW_POSITION", wallet: "0xw1", condition_id: "0xc1", token_id: "tok1", outcome: "Lakers", title: "Lakers vs. Celtics", slug: "nba-lal-bos", price: 0.5, created_at: z("2026-10-02T10:00:00Z"), evaluated_at: z("2026-10-02T10:02:00Z"), payload: { copyScore: 80 }, ...o });
const SIGNALS = [
  sig("s1", {}), sig("s2", { wallet: "0xw2", evaluated_at: z("2026-10-02T13:57:00Z") }), sig("s3", { wallet: "0xw3", evaluated_at: z("2026-10-02T14:30:00Z") }),
  sig("s4", { wallet: "0xw4", condition_id: "0xc2", token_id: "tok3", outcome: "Warriors", title: "Warriors vs. Knicks", slug: "nba-gsw-nyk", evaluated_at: z("2026-10-02T09:00:00Z") }),
  sig("s5", { wallet: "0xw5", payload: { copyScore: 60 } }), sig("s6", { wallet: "0xw6", condition_id: "0xc9", token_id: "tok9", outcome: "Yes", title: "Unknown game xyz", slug: "xyz" }),
  sig("s7", { wallet: "0xw7", condition_id: "0xc3", token_id: "tok5", outcome: "Bulls", title: "Bulls vs. Heat", slug: "nba-chi-mia" }), sig("s8", { wallet: "0xw8", condition_id: "0xc4", token_id: "tok7", outcome: "Nets", title: "Nets vs. Suns", slug: "nba-bkn-phx", evaluated_at: z("2026-10-02T18:00:00Z") }),
  sig("x1", { kind: "EXIT", wallet: "0xw1" }), sig("old", { created_at: z("2026-09-27T04:28:37Z"), evaluated_at: z("2026-09-27T04:30:00Z") }),
];
const worldDb = () => memDb({ signals: SIGNALS.map((s) => ({ ...s })), markets: [{ condition_id: "0xc1", end_date: "2026-10-02" }, { condition_id: "0xc2", end_date: "2026-10-04" }, { condition_id: "0xc3", end_date: "2026-10-02" }, { condition_id: "0xc4", end_date: "2026-10-02" }], paper_executions: [] });
const REC = (venue: string, stratum: string, slot: 1 | 2, field: string | null, verdict: SlotVerdict["verdict"] = "RECOMMEND"): SlotVerdict => ({ venue, stratum, slot, field, verdict, usableShare: 1, presentShare: 1, placeholderShare: 0, failed: [], evidence: {}, needsHumanReview: false, events: 100, markets: 100, etPlaceholderShare: 0, decidedBy: "allPassed", failedRules: [] });
const KRECS = [REC("kalshi", "sports:basketball", 1, "event.strike_date"), REC("kalshi", "sports:basketball", 2, "close_time")];
const listingOf = async (events: Parameters<typeof kalshiServer>[0], cap = 10_000, handler?: Parameters<typeof fakeFetch>[0]) => { const c = virtualClock(NOW); const f = fakeFetch(handler ?? kalshiServer(events).handler, c.now); const http = new PoliteHttp({ fetch: f.fetch, now: c.now, sleep: c.sleep }); return { l: await fetchKalshiListing(http, KALSHI_DEFAULTS, cap), f }; };
const files = () => { const out: Record<string, string> = {}; return { out, write: (p: string, c: string) => { out[p] = c; } }; };
const runK = async (o: { recs?: SlotVerdict[] | null; events?: Parameters<typeof kalshiServer>[0]; cap?: number; db?: ReturnType<typeof worldDb>; endIso?: string; handler?: Parameters<typeof fakeFetch>[0]; startIso?: string } = {}) => {
  const { l } = await listingOf(o.events ?? funnelEvents(), o.cap, o.handler); const w = files(); const d = o.db ?? worldDb();
  const res = await runKalshiCoverage({ db: readOnly(d.db as never), listing: l, recommendations: o.recs === undefined ? KRECS : o.recs, now: () => NOW, startIso: o.startIso, endIso: o.endIso, write: w.write }); return { res, files: w.out, d, l };
};

describe("the Kalshi funnel on the fixture world (hand-derived)", () => {
  it("EXACT is structurally zero (Kalshi shares no identifier with Polymarket); EXACT+PROBABLE: all 8 → score 7 → mapped 5 → tradable 4 → timestamp 4 → not started 3 → within 24 h 2 → lead 1", async () => {
    const { res } = await runK(); const ex = res.funnel.variants.EXACT, pr = res.funnel.variants.EXACT_PLUS_PROBABLE;
    // 8 entry signals (the EXIT and the one-second-early signal are out); score ≥ 68: s1 s2 s3 s4 s6 s7 s8 = 7;
    // mapped (title + date within a day + outcome label): s1 s2 s3 (Lakers) s4 (Warriors) s8 (Nets) = 5; s6 has no counterpart, s7's market carries no date at all (cannot be PROBABLE);
    // tradable (open_time ≤ evaluation < close_time): all but s8 (closed 15:00, evaluated 18:00) = 4; usable timestamp (event.strike_date): 4; not started: all but s3 = 3; within 24 h: all but s4 (2 days) = 2; lead ≥ 300 s: all but s2 (180 s) = 1
    expect(ex.counts).toEqual([8, 7, 0, 0, 0, 0, 0, 0]); expect(pr.counts).toEqual([8, 7, 5, 4, 4, 3, 2, 1]);
    expect(pr.exits).toEqual({ score: 1, mapped: 2, tradable: 1, notStarted: 1, within24h: 1, minLead: 1 }); expect(pr.wallets).toEqual([8, 7, 5, 4, 4, 3, 2, 1]);
    expect(res.mappingBuckets).toEqual({ EXACT: 0, PROBABLE: 3, NONE: 2 }); expect(res.counts).toEqual({ signals: 8, withScore: 7, conditions: 5 }); expect(res.measured).toEqual({ mapping: true, tradable: true, timestamp: true }); expect(res.listing.cutOff).toBe(false);
    expect(pr.byCategory["sports:basketball"]).toEqual([7, 6, 5, 4, 4, 3, 2, 1]); // s6 ("Unknown game xyz") is culture_other, so it is not among the basketball rows
  });
  it("the same signal window as the US run: endIso is honoured exclusively, and the files are the documented ones", async () => {
    const { res, files: out } = await runK({ endIso: "2026-10-02T10:00:00Z" }); expect(res.window.endIso).toBe("2026-10-02T10:00:00.000Z"); expect(res.funnel.variants.EXACT.counts[0]).toBe(0); // every signal is at or after 10:00
    const b = await runK({ endIso: "2026-10-02T10:00:01Z" }); expect(b.res.funnel.variants.EXACT.counts[0]).toBe(8); // all eight entry signals were created at 10:00:00
    expect(Object.keys(out).sort()).toEqual(["s1b_funnel_kalshi.json", "s1b_mapping_review_kalshi.csv"]);
  });
  it("without S1a recommendations the timestamp stage is NOT MEASURED (null, never zero); mapping then relies on a close-like date, and the reason is printed", async () => {
    const { res } = await runK({ recs: null }); expect(res.funnel.variants.EXACT_PLUS_PROBABLE.counts).toEqual([8, 7, 5, 4, null, null, null, null]); expect(res.measured.timestamp).toBe(false); expect(res.reasons.join(" ")).toContain("no S1a recommendations for kalshi"); expect(res.dateBasis).toEqual({ close_date: 3 });
  });
  it("Kalshi unreachable or refusing: reported with the exact outcome, the database stages still run, later stages are null", async () => {
    const { res } = await runK({ handler: () => new Response("Host not in allowlist", { status: 403 }) }); expect(res.listing.base).toBeNull(); expect(res.listing.tried).toEqual([{ base: KALSHI_DEFAULTS.bases[0], outcome: "BLOCKED 403" }]); expect(res.funnel.variants.EXACT_PLUS_PROBABLE.counts).toEqual([8, 7, null, null, null, null, null, null]); expect(res.measured).toEqual({ mapping: false, tradable: false, timestamp: false }); expect(res.reasons[0]).toMatch(/Kalshi unreachable .*BLOCKED 403.*not measured/);
  });
  it("a listing cut off at the cap is reported: mapped counts are a LOWER BOUND", async () => { const { res } = await runK({ cap: 3 }); expect(res.listing.cutOff).toBe(true); expect(res.reasons.join(" ")).toMatch(/cut off at 3 markets.*LOWER BOUND/); });
  it("READ-ONLY: a database that throws on every write and every RPC is never tripped; only `signals` and `markets` are read; rows are unchanged", async () => {
    const d = worldDb(); const before = JSON.stringify(d.tables); await runK({ db: d }); expect(d.touched).toEqual([]); expect([...new Set(d.reads.map((r) => r.table))].sort()).toEqual(["markets", "signals"]); expect(JSON.stringify(d.tables)).toBe(before);
  });
  it("the review CSV lists the PROBABLE candidates (never verified) for the owner's eye", async () => { const { files: out } = await runK(); const csv = out["s1b_mapping_review_kalshi.csv"].trim().split("\n"); expect(csv).toHaveLength(1 + 3); expect(csv[0]).toContain("reviewer_verdict"); expect(csv.slice(1).every((l) => l.includes("PROBABLE") && l.includes("kalshi"))).toBe(true); });
  it("the printed summary is ≤ 60 lines and states what could not be measured", async () => { const { res } = await runK({ recs: null }); const lines = kalshiCoverageSummaryLines(res, "out"); expect(lines.length).toBeLessThanOrEqual(60); expect(lines.join("\n")).toContain("NOT MEASURED"); expect(lines.join("\n")).toContain("EXACT"); expect(lines.join("\n")).toContain("s1b_funnel_kalshi.json"); });
});

describe("Kalshi tradability and event time", () => {
  const T = (s: string) => Date.parse(s); const m = (o: Raw) => ({ ticker: "T", status: "active", ...o });
  it("tradable = opened (≥ open_time) and not closed (< close_time); exactly at open is tradable, exactly at close is not; no close time: open → true, otherwise unknown (null)", () => {
    const o = m({ open_time: "2026-10-01T00:00:00Z", close_time: "2026-10-02T00:00:00Z" });
    expect(kalshiTradableAt(o, T("2026-09-30T23:59:59Z"))).toBe(false); expect(kalshiTradableAt(o, T("2026-10-01T00:00:00Z"))).toBe(true); expect(kalshiTradableAt(o, T("2026-10-01T23:59:59Z"))).toBe(true); expect(kalshiTradableAt(o, T("2026-10-02T00:00:00Z"))).toBe(false);
    expect(kalshiTradableAt(m({ open_time: "2026-10-01T00:00:00Z" }), T("2026-10-05T00:00:00Z"))).toBe(true); expect(kalshiTradableAt(m({ status: "finalized", open_time: "2026-10-01T00:00:00Z" }), T("2026-10-05T00:00:00Z"))).toBeNull(); expect(kalshiTradableAt(m({}), T("2026-10-05T00:00:00Z"))).toBe(true);
  });
  it("resolution-like fields are never consulted: a market whose expected expiration is in the future but whose close time has passed is not tradable", () => {
    expect(kalshiTradableAt(m({ close_time: "2026-10-02T00:00:00Z", expected_expiration_time: "2026-10-09T00:00:00Z", latest_expiration_time: "2026-11-01T00:00:00Z" }), T("2026-10-03T00:00:00Z"))).toBe(false);
  });
  it("event time follows the recommended fields; a date-only value, a missing value or a resolution-like field is rejected (never a start)", () => {
    const raw = { ticker: "T", title: "Lakers vs Celtics", event: { category: "Sports", series_ticker: "KXNBAGAME", strike_date: "2026-10-05T20:00:00Z" }, close_time: "2026-10-05T23:00:00Z", expected_expiration_time: "2026-10-05T23:00:00Z" };
    const ev = T("2026-10-04T00:00:00Z"); expect(kalshiEventTimeAt(raw, ev, KRECS)).toEqual({ ms: T("2026-10-05T20:00:00Z"), why: "slot 1 event.strike_date" });
    expect(kalshiEventTimeAt({ ...raw, event: { ...raw.event, strike_date: "2026-10-05" } }, ev, KRECS)).toEqual({ ms: null, why: "TIMESTAMP_MISSING" }); // a start that is present but unusable is not replaced by the close time
    expect(kalshiEventTimeAt({ ...raw, event: { ...raw.event, strike_date: undefined } }, ev, KRECS).why).toBe("slot 2 close_time"); // absent: the close time stands in (deadline-type)
    const bad = [REC("kalshi", "sports:basketball", 2, "expected_expiration_time")]; expect(kalshiEventTimeAt({ ...raw, event: { ...raw.event, strike_date: undefined } }, ev, bad)).toEqual({ ms: null, why: "TIMESTAMP_MISSING" });
    expect(kalshiEventTimeAt(raw, ev, [])).toEqual({ ms: null, why: "no recommended field for sports:basketball" });
  });
  it("the date level uses close-like fields only (Eastern placeholder → implied date; a real close → its Eastern date); never a resolution field", () => {
    expect(kalshiDateLevel({ close_time: "2026-10-05T04:00:00Z" })).toEqual({ date: "2026-10-05", basis: "implied" }); expect(kalshiDateLevel({ close_time: "2026-10-05T17:00:00Z" })).toEqual({ date: "2026-10-05", basis: "close_date" });
    expect(kalshiDateLevel({ expected_expiration_time: "2026-10-05T17:00:00Z", expiration_time: "2026-10-09T17:00:00Z" })).toBeNull(); expect(kalshiDateLevel({})).toBeNull();
  });
});

describe("the category table: our score ≥ 68 flow against the Kalshi listing and the US listing", () => {
  it("counts and shares per stratum, each side over its own total; a listing that was not fetched is n/m; sorted by our flow", () => {
    const rows = categoryMix3({ esports: 31, "sports:basketball": 10, politics: 21, culture_other: 38 }, { "sports:basketball": 40, politics: 40, culture_other: 20 }, { "sports:basketball": 29, politics: 16, culture_other: 3, esports: 0 });
    expect(rows.map((r) => r.stratum)).toEqual(["culture_other", "esports", "politics", "sports:basketball"]); expect(rows[0]).toMatchObject({ ours68: 38, oursShare: 0.38, kalshiMarkets: 20, kalshiShare: 0.2, usMarkets: 3, usShare: 0.063 });
    expect(rows.find((r) => r.stratum === "esports")).toMatchObject({ kalshiMarkets: 0, kalshiShare: 0, usMarkets: 0 });
    const n = categoryMix3({ politics: 1 }, null, null); expect(n[0]).toMatchObject({ kalshiMarkets: null, kalshiShare: null, usMarkets: null, usShare: null }); expect(mix3Lines(n).join("\n")).toContain("n/m");
    expect(mix3Lines(rows)[0]).toContain("ours | Kalshi | US exchange"); expect(mix3Lines(rows, 2)).toHaveLength(3);
  });
});

describe("the command line with --kalshi: both venues from one signal window", () => {
  const usMarkets = [{ id: "u1", slug: "nba-lal-bos", question: "Lakers vs Celtics", outcomes: '["Lakers","Celtics"]', conditionId: "0xc1", clobTokenIds: ["tok1", "tok2"], status: "open", eventStartTime: "2026-10-02T14:00:00+00:00", closeTime: "2026-10-02T17:00:00+00:00" }];
  const handler = (u: URL): Response => { if (u.host === "gateway.polymarket.us") { const closed = u.searchParams.get("closed") === "true"; return json({ markets: usMarkets.filter((m) => (m.status === "settled") === closed) }); } return kalshiServer(funnelEvents()).handler(u); };
  const RECS = { venues: [{ venue: "polymarket_us", recommendations: [REC("polymarket_us", "sports:basketball", 1, "eventStartTime"), REC("polymarket_us", "sports:basketball", 2, "closeTime")] }, { venue: "kalshi", recommendations: KRECS }] };
  const run = async (argv: string[], o: { db?: ReturnType<typeof worldDb>; h?: Parameters<typeof fakeFetch>[0] } = {}) => { const c = virtualClock(NOW); const f = fakeFetch(o.h ?? handler, c.now); const w = files(); const lines: string[] = []; const d = o.db ?? worldDb();
    const code = await runCoverageCli(argv, ENV, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: w.write, mkdir: () => {}, readFile: (p) => (w.out[p] !== undefined ? w.out[p] : p.endsWith("s1a_summary.json") ? JSON.stringify(RECS) : null), log: (l) => lines.push(l), db: () => readOnly(d.db as never) }); return { code, f, files: w.out, lines, d }; };
  it("prints ONE summary of at most 60 lines with both funnels side by side and the three-way table, writes the Kalshi files and S1_COMPACT.md, and touches the database with select only", async () => {
    const d = worldDb(); const r = await run(["--kalshi"], { db: d }); expect(r.code).toBe(EXIT.OK); expect(r.lines.length).toBeLessThanOrEqual(60);
    expect(Object.keys(r.files).sort()).toEqual(["docs/phase4/data/S1_COMPACT.md", "docs/phase4/data/s1b_feasibility.json", "docs/phase4/data/s1b_funnel.json", "docs/phase4/data/s1b_funnel_kalshi.json", "docs/phase4/data/s1b_mapping_review.csv", "docs/phase4/data/s1b_mapping_review_kalshi.csv"]);
    const text = r.lines.join("\n"); expect(text).toContain("both venues, same signals"); expect(text).toContain("US exact / +prob"); expect(text).toContain("Kalshi exact / +prob"); expect(text).toContain("category mix, our score ≥ 68 flow vs listings");
    const us = JSON.parse(r.files["docs/phase4/data/s1b_funnel.json"]); const k = JSON.parse(r.files["docs/phase4/data/s1b_funnel_kalshi.json"]); expect(k.window).toEqual(us.window); expect(k.funnel.variants.EXACT_PLUS_PROBABLE.counts).toEqual([8, 7, 5, 4, 4, 3, 2, 1]);
    expect(d.touched).toEqual([]); expect([...new Set(d.reads.map((x) => x.table))].sort()).toEqual(["markets", "paper_executions", "signals"]);
    const compact = r.files["docs/phase4/data/S1_COMPACT.md"]; expect(compact).toContain("| stage | US | Kalshi |"); expect(compact.split("\n").length).toBeLessThanOrEqual(81);
  });
  it("without --kalshi nothing is sent to Kalshi and the output is the unchanged single-venue summary", async () => { const r = await run([]); expect(r.f.calls.every((c) => new URL(c.url).host === "gateway.polymarket.us")).toBe(true); expect(Object.keys(r.files).some((p) => p.includes("kalshi"))).toBe(false); expect(r.lines[0]).toMatch(/^S1b coverage probe/); });
  it("only public GETs: Kalshi requests carry no credential, are ≥ 500 ms apart, and the US origin keeps its slower pace", async () => {
    const r = await run(["--kalshi"]); const k = r.f.calls.filter((c) => new URL(c.url).host.includes("kalshi")); expect(k.length).toBeGreaterThan(3); for (const c of r.f.calls) { expect(c.method).toBe("GET"); expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]); }
    for (const host of ["gateway.polymarket.us", new URL(KALSHI_DEFAULTS.bases[0]).host]) { const h = r.f.calls.filter((c) => new URL(c.url).host === host); for (let i = 1; i < h.length; i++) expect(h[i].at! - h[i - 1].at!, host).toBeGreaterThanOrEqual(500); } // the ceiling is per host
    const us = r.f.calls.filter((c) => new URL(c.url).host === "gateway.polymarket.us"); for (let i = 1; i < us.length; i++) expect(us[i].at! - us[i - 1].at!).toBeGreaterThanOrEqual(1100);
    expect(JSON.stringify(r.lines) + JSON.stringify(r.files)).not.toContain("service-role-secret-never-logged");
  });
  it("Kalshi refusing (403) does not stop the US measurement: both are reported, the run exits 0", async () => {
    const r = await run(["--kalshi"], { h: (u) => (u.host.includes("kalshi") ? new Response("Host not in allowlist", { status: 403 }) : handler(u)) }); expect(r.code).toBe(0); expect(r.lines.join("\n")).toMatch(/KALSHI NOT MEASURED: Kalshi unreachable .*BLOCKED 403/); expect(JSON.parse(r.files["docs/phase4/data/s1b_funnel.json"]).venue.measured.mapping).toBe(true);
    expect(r.f.calls.filter((c) => c.url.includes("kalshi")).length).toBe(1); // one refusal, no second base, no listing request
  });
});
