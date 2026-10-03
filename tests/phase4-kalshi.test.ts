/**
 * Phase 4.0c — the Kalshi adapter: how each time field is classified (and why), status buckets, outcome labels and categories, cursor pagination, the
 * finite cap, slimming on arrival (memory proportional to the cap, not to the responses), the base-URL resolution and a refusal, and the milestone schedule source.
 * Synthetic objects only (tests/helpers/phase4Kalshi.ts): nothing here is evidence about Kalshi.
 */
import { describe, expect, it } from "vitest";
import { buildInventory, flatten, toAuditMarkets } from "../src/lib/phase4/audit";
import { classifyFieldName, classifyFieldNameFor, roleAllowedForSlot, validateTimestamp } from "../src/lib/phase4/timestamps";
import { KALSHI_DEFAULTS, KALSHI_DEFAULT_CAP, fetchKalshi, fetchKalshiListing, fetchKalshiMilestones, kalshiAll, kalshiBucket, kalshiCounts, kalshiFetchPlan, kalshiGroupOf, kalshiIdOf, kalshiIsResolved, kalshiOutcomes, kalshiScheduleRows, kalshiSlug, kalshiTags, kalshiTitleOf, resolveKalshiBase } from "../src/lib/phase4/venue-kalshi";
import { categorize, stratum } from "../src/lib/phase4/categorize";
import { PoliteHttp } from "../src/lib/phase4/http";
import { fakeFetch, json, virtualClock } from "./helpers/phase4Db";
import { KALSHI_BASE, funnelEvents, kEvent, kalshiServer, type Raw } from "./helpers/phase4Kalshi";

const setup = (handler: Parameters<typeof fakeFetch>[0]) => { const c = virtualClock(); const f = fakeFetch(handler, c.now); return { c, f, http: new PoliteHttp({ fetch: f.fetch, now: c.now, sleep: c.sleep }) }; };
const manyEvents = (n: number, o: { prefix?: string; marketsPer?: number; bigText?: number; category?: string } = {}): Raw[] => Array.from({ length: n }, (_, i) => kEvent({ ticker: `${o.prefix ?? "KXEV"}-${i}`, series: "KXNBAGAME", title: `Team A${i} vs Team B${i}`, category: o.category ?? "Sports", strike: "2026-10-05T20:00:00Z", markets: Array.from({ length: o.marketsPer ?? 2 }, (_, k) => ({ ticker: `${o.prefix ?? "KXEV"}-${i}-M${k}`, yes: `Team A${i}`, close: "2026-10-05T23:00:00Z", extra: o.bigText ? { rules_primary: "r".repeat(o.bigText), rules_secondary: "s".repeat(o.bigText), custom_strike: { deep: "d".repeat(o.bigText) } } : undefined })) }));

describe("Kalshi time fields: the role of each, by name (UNVERIFIED names; the audit measures the meaning)", () => {
  it("close_time is a close; open_time is a listing-like time; created/updated are bookkeeping; strike_date is neutral (the audit must judge it)", () => {
    expect(classifyFieldName("close_time")).toBe("CLOSE_LIKE"); expect(classifyFieldName("open_time")).toBe("CREATION_LIKE"); expect(classifyFieldName("created_time")).toBe("CREATION_LIKE"); expect(classifyFieldName("updated_time")).toBe("UPDATE_LIKE");
    expect(classifyFieldName("event.strike_date")).toBe("OTHER_TIME"); expect(classifyFieldName("event.series_ticker")).toBe("NOT_TIME");
  });
  it("expected_expiration_time, latest_expiration_time and settlement times are RESOLUTION-like: never a start, never a close", () => {
    for (const f of ["expected_expiration_time", "latest_expiration_time", "settlement_ts", "settled_time"]) expect(classifyFieldName(f), f).toBe("RESOLUTION_LIKE");
    for (const f of ["expected_expiration_time", "latest_expiration_time"]) { expect(roleAllowedForSlot(classifyFieldName(f), 1), f).toBe(false); expect(roleAllowedForSlot(classifyFieldName(f), 2), f).toBe(false); expect(validateTimestamp(f, "2026-10-05T23:00:00Z", Date.parse("2026-10-05T00:00:00Z"), { slot: 2 })).toEqual({ ok: false, reason: "FIELD_ROLE_FORBIDDEN" }); }
    expect(roleAllowedForSlot("CREATION_LIKE", 1)).toBe(false); // open_time can never fill slot 1
  });
  it("the deprecated expiration_time is RESOLUTION-like on Kalshi only: a generic expirationTime elsewhere stays close-like", () => {
    expect(classifyFieldName("expiration_time")).toBe("CLOSE_LIKE"); expect(classifyFieldNameFor("kalshi", "expiration_time")).toBe("RESOLUTION_LIKE"); expect(classifyFieldNameFor("polymarket_us", "expirationTime")).toBe("CLOSE_LIKE"); expect(classifyFieldNameFor(undefined, "expiration_time")).toBe("CLOSE_LIKE");
    // and the audit's inventory uses the venue of the markets it is given
    const raws = [{ ticker: "T", expiration_time: "2026-10-05T23:00:00Z", close_time: "2026-10-05T20:00:00Z" }];
    const mk = (venue: string) => buildInventory(toAuditMarkets(venue, raws, { idOf: (m) => String(m.ticker), isResolved: () => false, titleOf: () => "t", slugOf: () => null }));
    expect(mk("kalshi").find((f) => f.path === "expiration_time")!.role).toBe("RESOLUTION_LIKE"); expect(mk("polymarket_us").find((f) => f.path === "expiration_time")!.role).toBe("CLOSE_LIKE");
  });
  it("a Kalshi listing's own fields classify as the table says (flattened, event fields under `event.`)", () => {
    const raw = { ...(funnelEvents().open[0] as { markets: Raw[] }).markets[0], event: { event_ticker: "KXNBAGAME-26OCT02LALBOS", strike_date: "2026-10-02T14:00:00Z", category: "Sports" } };
    const roles = Object.fromEntries(Object.entries(flatten(raw)).filter(([, v]) => typeof v === "string" && /^\d{4}-/.test(v)).map(([k]) => [k, classifyFieldNameFor("kalshi", k)]));
    expect(roles).toEqual({ created_time: "CREATION_LIKE", updated_time: "UPDATE_LIKE", open_time: "CREATION_LIKE", close_time: "CLOSE_LIKE", expected_expiration_time: "RESOLUTION_LIKE", latest_expiration_time: "RESOLUTION_LIKE", "event.strike_date": "OTHER_TIME" });
  });
});

describe("Kalshi accessors", () => {
  const m = (o: Raw) => ({ ticker: "KXNBAGAME-26OCT02LALBOS-LAL", event_ticker: "KXNBAGAME-26OCT02LALBOS", title: "Lakers vs Celtics", yes_sub_title: "Lakers", no_sub_title: "Not Lakers", status: "active", event: { category: "Sports", series_ticker: "KXNBAGAME", title: "Lakers vs Celtics" }, ...o });
  it("status buckets: active is open; initialized is unopened; closed; determined / finalized / settled are settled; resolved = closed or settled", () => {
    const b = (s: string) => kalshiBucket(m({ status: s }));
    expect(["active", "open"].map(b)).toEqual(["open", "open"]); expect(["initialized", "inactive", "unopened"].map(b)).toEqual(["unopened", "unopened", "unopened"]); expect(b("closed")).toBe("closed"); expect(["determined", "disputed", "amended", "finalized", "settled"].map(b)).toEqual(Array(5).fill("settled")); expect(b("weird")).toBe("unknown"); expect(kalshiBucket({})).toBe("unknown");
    expect(["active", "initialized", "weird"].map((s) => kalshiIsResolved(m({ status: s })))).toEqual([false, false, false]); expect(["closed", "finalized"].map((s) => kalshiIsResolved(m({ status: s })))).toEqual([true, true]);
  });
  it("ids, titles, events, outcome labels, categories", () => {
    expect(kalshiIdOf(m({}))).toBe("KXNBAGAME-26OCT02LALBOS-LAL"); expect(kalshiTitleOf(m({}))).toBe("Lakers vs Celtics"); expect(kalshiTitleOf(m({ title: undefined }))).toBe("Lakers vs Celtics"); expect(kalshiGroupOf(m({}))).toBe("KXNBAGAME-26OCT02LALBOS"); expect(kalshiGroupOf({ ticker: "A-B-C" })).toBe("ticker:A-B");
    expect(kalshiOutcomes(m({}))).toEqual(["Yes", "No", "Lakers", "Not Lakers"]); expect(kalshiOutcomes(m({ yes_sub_title: "Yes", no_sub_title: "No" }))).toEqual(["Yes", "No"]); expect(kalshiTags(m({}))).toEqual(["Sports"]); expect(kalshiTags({})).toEqual([]);
  });
  it("tickers have no separators: the series is split into <sport>-<rest> so the categoriser reads the sport", () => {
    expect(kalshiSlug(m({}))).toBe("nba-game"); expect(kalshiSlug(m({ event: { series_ticker: "KXLOLGAME" } }))).toBe("lol-game"); expect(kalshiSlug(m({ event: { series_ticker: "KXBTCD" } }))).toBe("btc-d"); expect(kalshiSlug(m({ event: { series_ticker: "KXFEDDECISION" } }))).toBe("feddecision"); expect(kalshiSlug({})).toBeNull();
    expect(stratum(categorize({ title: "Lakers vs Celtics", slug: kalshiSlug(m({})), tags: ["Sports"] }))).toBe("sports:basketball");
    expect(stratum(categorize({ title: "T1 vs Gen.G", slug: kalshiSlug(m({ event: { series_ticker: "KXLOLGAME" } })), tags: ["Sports"] }))).toBe("esports");
    expect(stratum(categorize({ title: "Will the Fed cut rates in December?", slug: "feddecision", tags: ["Economics"] }))).toBe("politics");
  });
});

describe("fetchKalshi: cursor pagination, the cap, slimming, de-duplication", () => {
  const opts = { ...KALSHI_DEFAULTS, pageSize: 200 };
  it("follows the cursor page by page until it is empty, explodes events into markets (each keeps its event), and reports why it stopped", async () => {
    const srv = kalshiServer({ open: manyEvents(450, { marketsPer: 2 }) }); const { http } = setup(srv.handler);
    const r = await fetchKalshi(http, opts, KALSHI_BASE, { status: "open", max: 100_000 });
    expect(r.markets).toHaveLength(900); expect(r.notes.pages).toBe(3); expect(r.notes.stoppedBecause).toBe("no further cursor (listing ended)"); expect(r.notes.cursorKey).toBe("cursor"); expect(r.notes.filterHonoured).toBe(true);
    expect((r.markets[0].event as Raw).category).toBe("Sports"); expect((r.markets[0].event as Raw).markets).toBeUndefined(); expect(srv.hits.map((u) => [u.searchParams.get("status"), u.searchParams.get("with_nested_markets"), u.searchParams.get("limit"), u.searchParams.get("cursor")])).toEqual([["open", "true", "200", null], ["open", "true", "200", "200"], ["open", "true", "200", "400"]]);
  });
  it("a finite cap stops EXACTLY at the cap, mid-page, with 'sample size reached' (and never asks for more pages than it needs)", async () => {
    const srv = kalshiServer({ open: manyEvents(450) }); const { http } = setup(srv.handler); const r = await fetchKalshi(http, opts, KALSHI_BASE, { status: "open", max: 250 });
    expect(r.markets).toHaveLength(250); expect(r.notes.stoppedBecause).toBe("sample size reached"); expect(srv.hits).toHaveLength(1); // 200 events = 400 markets in the first page already: one request is enough
    const one = await fetchKalshi(setup(srv.handler).http, opts, KALSHI_BASE, { status: "open", max: 1 }); expect(one.markets).toHaveLength(1);
  });
  it("the default cap is 40,000 markets and its plan splits open / closed / settled so that the parts add up to the cap", () => {
    expect(KALSHI_DEFAULT_CAP).toBe(40_000); expect(kalshiFetchPlan(40_000)).toEqual({ open: 20_000, closed: 4_000, settled: 16_000 });
    for (const cap of [3, 10, 101, 40_000, 123_457]) { const p = kalshiFetchPlan(cap); expect(p.open + p.closed + p.settled).toBe(cap); expect(Math.min(p.open, p.closed, p.settled)).toBeGreaterThanOrEqual(0); expect(p.settled).toBeGreaterThanOrEqual(1); }
  });
  it("de-duplicates across fetches that share a `seen` set, and within a page", async () => {
    const ev = manyEvents(5); const srv = kalshiServer({ open: [...ev, ...ev], settled: ev }); const { http } = setup(srv.handler); const seen = new Set<string>();
    const a = await fetchKalshi(http, opts, KALSHI_BASE, { status: "open", max: 1000, seen }); expect(a.markets).toHaveLength(10); const b = await fetchKalshi(http, opts, KALSHI_BASE, { status: "settled", max: 1000, seen }); expect(b.markets).toHaveLength(0);
  });
  it("SLIMS ON ARRIVAL: long text, nested lists and deep objects are cut, every time field and identifier survives, memory follows the cap and not the response size", async () => {
    const srv = kalshiServer({ open: manyEvents(100, { bigText: 20_000 }) }); const { http } = setup(srv.handler); const r = await fetchKalshi(http, opts, KALSHI_BASE, { status: "open", max: 1000 });
    const rawBytes = JSON.stringify(manyEvents(100, { bigText: 20_000 })).length; const kept = JSON.stringify(r.markets).length;
    expect(rawBytes).toBeGreaterThan(8_000_000); expect(kept).toBeLessThan(rawBytes / 20); expect(kept / r.markets.length).toBeLessThan(2_500); // per retained market: bounded, whatever the response size
    const m = r.markets[0]; expect((m.rules_primary as string).length).toBe(200); expect(m.close_time).toBe("2026-10-05T23:00:00Z"); expect(m.open_time).toBe("2026-09-25T14:00:00Z"); expect((m.event as Raw).strike_date).toBe("2026-10-05T20:00:00Z"); expect(m.ticker).toBe("KXEV-0-M0");
  });
  it("a venue that ignores the cursor (the same page and the same cursor again) is noticed after the repeat, not paged forever", async () => {
    const page = { events: manyEvents(3), cursor: "same" }; const { http, f } = setup(() => json(page)); const r = await fetchKalshi(http, opts, KALSHI_BASE, { status: "open", max: 100_000 });
    expect(r.notes.stoppedBecause).toBe("page repeated (cursor ignored?)"); expect(f.calls).toHaveLength(2); expect(r.markets).toHaveLength(6);
  });
  it("the status filter is judged by the first page: a venue that ignores it is noticed", async () => {
    const srv = kalshiServer({ open: manyEvents(3), settled: manyEvents(3) }); const { http } = setup(srv.handler); const r = await fetchKalshi(http, opts, KALSHI_BASE, { status: "settled", max: 100 }); expect(r.notes.filterHonoured).toBe(false); // the fixture's settled bucket still holds `active` markets
  });
  it("errors are reported, never thrown; a 404 mid-listing returns what was read; at most 3 attempts per request", async () => {
    let n = 0; const { http, f } = setup((u) => (++n === 2 ? new Response("gone", { status: 404 }) : kalshiServer({ open: manyEvents(450) }).handler(u))); const r = await fetchKalshi(http, opts, KALSHI_BASE, { status: "open", max: 100_000 });
    expect(r.markets).toHaveLength(400); expect(r.notes.stoppedBecause).toBe("error (NOT_FOUND)"); expect(r.notes.errors[0]).toContain("NOT_FOUND"); expect(f.calls).toHaveLength(2);
    const bad = setup(() => { throw new TypeError("fetch failed"); }); const e = await fetchKalshi(bad.http, opts, KALSHI_BASE, { status: "open", max: 10 }); expect(e.markets).toHaveLength(0); expect(bad.f.calls).toHaveLength(3);
  });
  it("only public GETs: the research User-Agent, no credential header of any kind, requests at least 500 ms apart", async () => {
    const srv = kalshiServer({ open: manyEvents(450) }); const { http, f } = setup(srv.handler); await fetchKalshi(http, opts, KALSHI_BASE, { status: "open", max: 100_000 });
    for (const c of f.calls) { expect(c.method).toBe("GET"); expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]); expect(c.url).not.toMatch(/portfolio|orders|balance|api_key|signature/i); }
    for (let i = 1; i < f.calls.length; i++) expect(f.calls[i].at! - f.calls[i - 1].at!).toBeGreaterThanOrEqual(500);
  });
});

describe("the base URL and the refusal rule", () => {
  it("tries the documented bases in order and uses the first that answers; a network failure on the first falls through to the second", async () => {
    const { http, f } = setup((u) => (u.host === "api.elections.kalshi.com" ? (() => { throw new TypeError("fetch failed"); })() : json({ events: [], cursor: "" })));
    const r = await resolveKalshiBase(http, KALSHI_DEFAULTS); expect(r.base).toBe("https://external-api.kalshi.com/trade-api/v2"); expect(r.tried.map((t) => t.outcome)).toEqual(["NETWORK", "ok"]); expect(f.calls.length).toBe(4); // 3 attempts, then 1
  });
  it("a refusal (403) STOPS the search: the second host is not tried, no listing request follows, and the exact outcome is reported", async () => {
    const { http, f } = setup(() => new Response("Host not in allowlist", { status: 403 })); const l = await fetchKalshiListing(http, KALSHI_DEFAULTS, 1000);
    expect(l.base).toBeNull(); expect(l.tried).toEqual([{ base: KALSHI_DEFAULTS.bases[0], outcome: "BLOCKED 403" }]); expect(l.open).toBeNull(); expect(f.calls).toHaveLength(1); expect(f.calls.every((c) => c.url.startsWith("https://api.elections.kalshi.com"))).toBe(true);
  });
  it("--kalshi-base replaces the list: only that host is asked", async () => {
    const { http, f } = setup(() => json({ events: [], cursor: "" })); const r = await resolveKalshiBase(http, { ...KALSHI_DEFAULTS, bases: ["https://example.test/v2"] }); expect(r.base).toBe("https://example.test/v2"); expect(f.calls).toHaveLength(1);
  });
});

describe("the bounded listing and its counts", () => {
  it("fetches open, closed and settled markets, de-duplicated, and counts them by status and by Kalshi category", async () => {
    const edit = (evs: Raw[], status: string) => evs.forEach((e) => (e.markets as Raw[]).forEach((m) => (m.status = status)));
    const world = { open: [...manyEvents(30, { prefix: "KXA" }), ...manyEvents(10, { prefix: "KXP", category: "Politics" })], closed: manyEvents(4, { prefix: "KXC", category: "Politics" }), settled: manyEvents(20, { prefix: "KXS", category: "Crypto" }) };
    edit(world.closed, "closed"); edit(world.settled, "finalized"); const s2 = kalshiServer(world); const { http } = setup(s2.handler);
    const l = await fetchKalshiListing(http, KALSHI_DEFAULTS, 10_000); expect(l.base).toBe(KALSHI_BASE); const all = kalshiAll(l); const c = kalshiCounts(all);
    expect(c.total).toBe(2 * (30 + 10 + 4 + 20)); expect(c.byBucket).toEqual({ open: 80, closed: 8, settled: 40 }); expect(c.distinctEvents).toBe(64);
    expect(c.byCategory).toEqual({ Sports: { open: 60, closed: 0, settled: 0, unopened: 0, unknown: 0, total: 60 }, Politics: { open: 20, closed: 8, settled: 0, unopened: 0, unknown: 0, total: 28 }, Crypto: { open: 0, closed: 0, settled: 40, unopened: 0, unknown: 0, total: 40 } });
  });
  it("each part respects its share of the cap, and a cut-off listing says so", async () => {
    const world = { open: manyEvents(300, { prefix: "KXA" }), closed: manyEvents(50, { prefix: "KXC" }), settled: manyEvents(300, { prefix: "KXS" }) }; world.closed.forEach((e) => (e.markets as Raw[]).forEach((m) => (m.status = "closed"))); world.settled.forEach((e) => (e.markets as Raw[]).forEach((m) => (m.status = "settled")));
    const { http } = setup(kalshiServer(world).handler); const l = await fetchKalshiListing(http, KALSHI_DEFAULTS, 100); expect(l.plan).toEqual({ open: 50, closed: 10, settled: 40 }); expect([l.open!.markets.length, l.closed!.markets.length, l.settled!.markets.length]).toEqual([50, 10, 40]); expect(l.open!.notes.stoppedBecause).toBe("sample size reached");
  });
});

describe("the Kalshi schedule source (milestones, UNVERIFIED) against the event strike date", () => {
  it("pages milestones by cursor, reads start_date / category / type / primary_event_tickers, and builds one row per event that appears on both sides", async () => {
    const pages = [{ milestones: [{ id: "m1", category: "Sports", type: "football_game", title: "A at B", start_date: "2026-10-05T17:00:00Z", primary_event_tickers: ["KXNFLGAME-26OCT05AB"] }, { id: "m2", category: "Sports", type: "football_game", title: "C at D", start_date: "2026-10-05T20:25:00Z", primary_event_tickers: ["KXNFLGAME-26OCT05CD"] }], cursor: "p2" }, { milestones: [{ id: "m3", category: "Politics", type: "election", title: "Vote", start_date: "2026-11-03T05:00:00Z", primary_event_tickers: ["KXVOTE-26"] }], cursor: "" }];
    const { http, f } = setup((u) => json(pages[u.searchParams.get("cursor") === "p2" ? 1 : 0])); const r = await fetchKalshiMilestones(http, KALSHI_BASE, { minStartIso: "2026-10-01T00:00:00Z" });
    expect(r.milestones).toHaveLength(3); expect(r.notes.stoppedBecause).toBe("no further cursor (listing ended)"); expect(f.calls[0].url).toContain("minimum_start_date=2026-10-01T00%3A00%3A00Z"); expect(r.milestones[0]).toMatchObject({ id: "m1", category: "Sports", startDate: "2026-10-05T17:00:00Z", eventTickers: ["KXNFLGAME-26OCT05AB"] });
    const markets = [{ ticker: "X1", event_ticker: "KXNFLGAME-26OCT05AB", event: { strike_date: "2026-10-05T17:00:00Z", category: "Sports" } }, { ticker: "X2", event_ticker: "KXNFLGAME-26OCT05AB", event: { strike_date: "2026-10-05T17:00:00Z" } }, { ticker: "X3", event_ticker: "KXNFLGAME-26OCT05CD", event: { strike_date: "2026-10-05T23:59:59Z" } }, { ticker: "X4", event_ticker: "KXNOPE", event: {} }];
    const rows = kalshiScheduleRows(markets, r.milestones); expect(rows).toEqual([{ group: "KXNFLGAME-26OCT05AB", sport: "Sports", source: "2026-10-05T17:00:00Z", other: "2026-10-05T17:00:00Z" }, { group: "KXNFLGAME-26OCT05CD", sport: "Sports", source: "2026-10-05T20:25:00Z", other: "2026-10-05T23:59:59Z" }]);
  });
  it("an error is reported and the milestones read so far are returned", async () => { const { http } = setup(() => new Response("no", { status: 404 })); const r = await fetchKalshiMilestones(http, KALSHI_BASE); expect(r.milestones).toEqual([]); expect(r.notes.errors[0]).toContain("NOT_FOUND"); });
});
