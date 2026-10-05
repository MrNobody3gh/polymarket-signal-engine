/**
 * Phase 4.0c, Part C and D — the corrected US queries (a fake server that answers HTTP 400 to anything but a category slug must be satisfied), the sports API
 * (sports, leagues, events by sport and league slug, open and ended), the `live` / `ended` reliability computation, the schedule sources, the FUTURES
 * comparison, and the per-candidate slot verdicts (a case where `startDate` fails and `gameStartTime` passes must pick the second; an open-only sample says
 * "no ordering evidence", not "unusable").
 */
import { describe, expect, it } from "vitest";
import { EXIT, runTimestampAuditCli } from "../src/lib/phase4/cli";
import { PoliteHttp } from "../src/lib/phase4/http";
import { US_DEFAULTS, US_SPORTS_MARKET_TYPES, defaultTargetedQueries, fetchUsTargeted } from "../src/lib/phase4/venues";
import { boundSample, discoverUsSports, eventFlagRows, fetchUsSportsTargeted, inPlayReliability, INPLAY_BUCKETS, scheduleCompare, usScheduleRows, type EventFlagRow } from "../src/lib/phase4/us-sports";
import { buildInventory, recommendSlots } from "../src/lib/phase4/audit";
import { futuresVerdicts, gameStartDeepDive, marketClassOf } from "../src/lib/phase4/events";
import { fakeFetch, json, virtualClock } from "./helpers/phase4Db";
import { marketsOfEvents, toMarkets, varied } from "./helpers/phase4EventWorld";

const NOW = Date.parse("2026-10-03T00:00:00Z");
const CATEGORY_SLUGS = new Set(["sports", "crypto", "politics", "culture", "finance", "tech"]);
const lenient = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "+00");
const Z = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const KICK0 = Date.UTC(2026, 9, 1, 0, 0, 0);
/** One US sports event: `n` markets sharing a game start, a listing time days before, a closedTime after the game when ended. */
const usEvent = (id: string, i: number, o: { ended: boolean; markets?: number; live?: boolean; startOffsetH?: number }) => {
  const kick = (o.ended ? KICK0 - 5 * 86_400_000 : KICK0 + 5 * 86_400_000) + i * 7 * 3_600_000 + 17 * 60_000 + (i % 4) * 15 * 60_000; const created = kick - 5 * 86_400_000 + i * 1000;
  return { id, slug: `nba-${id}`, title: `Team ${id}a vs Team ${id}b`, startDate: new Date(created).toISOString(), live: !!o.live, ended: o.ended,
    markets: Array.from({ length: o.markets ?? 3 }, (_, k) => ({ id: `${id}-m${k}`, slug: `nba-${id}-m${k}`, question: k === 0 ? `Team ${id}a vs Team ${id}b` : `Team ${id}a vs Team ${id}b: TOTAL ${k}`, outcomes: '["Yes","No"]', sportsMarketType: ["moneyline", "total", "spread"][k % 3], gameStartTime: lenient(kick), createdAt: new Date(created).toISOString(), startDate: new Date(created + 60_000).toISOString(), endDate: Z(Date.UTC(new Date(kick).getUTCFullYear(), new Date(kick).getUTCMonth(), new Date(kick).getUTCDate())), closed: o.ended, active: !o.ended, ...(o.ended ? { closedTime: lenient(kick + 2.5 * 3_600_000 + k * 60_000) } : {}) })) };
};
const events = (prefix: string, n: number, ended: boolean) => Array.from({ length: n }, (_, i) => usEvent(`${prefix}${i}`, i, { ended }));

interface Srv { sports?: unknown; leagues?: unknown; sportEvents?: Record<string, { open: unknown[]; ended: unknown[] }>; leagueEvents?: Record<string, { open: unknown[]; ended: unknown[] }>; markets?: { open: unknown[]; ended: unknown[] } }
/** A fake US exchange. `categories` must be a documented slug or the answer is HTTP 400 (as the real venue answered the 4.0b guess `categories=football`). */
function usServer(s: Srv, seen: { bad: string[]; urls: string[] } = { bad: [], urls: [] }) {
  const page = (all: unknown[], u: URL) => { const lim = Number(u.searchParams.get("limit") ?? 100), off = Number(u.searchParams.get("offset") ?? 0); return all.slice(off, off + lim); };
  const handler = (u: URL): Response => {
    if (u.host !== "gateway.polymarket.us") return new Response("no", { status: 404 });
    seen.urls.push(u.pathname + u.search);
    for (const c of u.searchParams.getAll("categories")) if (!CATEGORY_SLUGS.has(c)) { seen.bad.push(c); return new Response(JSON.stringify({ error: `unknown category ${c}` }), { status: 400 }); }
    for (const t of u.searchParams.getAll("sportsMarketTypes")) if (!(US_SPORTS_MARKET_TYPES as readonly string[]).includes(t)) return new Response("bad market type", { status: 400 });
    const side = u.searchParams.get("closed") === "true" || u.searchParams.get("ended") === "true" ? "ended" : "open";
    if (u.pathname === "/v2/sports") return s.sports ? json(s.sports) : new Response("no", { status: 404 });
    if (u.pathname === "/v2/leagues") return s.leagues ? json(s.leagues) : new Response("no", { status: 404 });
    let m = /^\/v2\/sports\/([^/]+)\/events$/.exec(u.pathname); if (m) { const e = s.sportEvents?.[m[1]]; return e ? json({ events: page(e[side], u) }) : new Response("no", { status: 404 }); }
    m = /^\/v2\/leagues\/([^/]+)\/events$/.exec(u.pathname); if (m) { const e = s.leagueEvents?.[m[1]]; return e ? json({ events: page(e[side], u) }) : new Response("no", { status: 404 }); }
    if (u.pathname === "/v1/markets") { const all = (s.markets?.[side] ?? []) as { markets: unknown[] }[]; return json({ markets: page(all.flatMap((e) => e.markets.map((mk) => ({ ...(mk as object), event: { id: (e as any).id, slug: (e as any).slug, title: (e as any).title, startDate: (e as any).startDate } }))), u) }); }
    if (u.pathname === "/v1/events") { const live = u.searchParams.get("live") === "true"; const all = ([...(s.markets?.open ?? []), ...(s.markets?.ended ?? [])] as any[]).filter((e) => (live ? e.live : e.ended)); return json({ events: page(all, u) }); }
    return new Response("no", { status: 404 });
  };
  return { handler, seen };
}
const setup = (handler: Parameters<typeof fakeFetch>[0]) => { const c = virtualClock(NOW); const f = fakeFetch(handler, c.now); return { c, f, http: new PoliteHttp({ fetch: f.fetch, now: c.now, sleep: c.sleep }) }; };

describe("the corrected US queries (D77)", () => {
  it("the default queries use documented category SLUGS and the documented market types, ask for both the open and the ended side, and never a sport name", () => {
    const q = defaultTargetedQueries(); const cats = q.flatMap((x) => new URLSearchParams(x.query).getAll("categories"));
    expect(cats.length).toBeGreaterThan(0); for (const c of cats) expect(CATEGORY_SLUGS.has(c), c).toBe(true); expect(cats).toContain("sports"); expect(cats).toContain("crypto"); expect(q.join("|")).not.toMatch(/football|basketball|baseball|hockey|soccer|tennis|combat/);
    const sp = q.find((x) => x.sport === "sports")!; expect(new URLSearchParams(sp.query).getAll("sportsMarketTypes")).toEqual(["MONEYLINE", "SPREAD", "TOTAL", "PROP"]); expect([...US_SPORTS_MARKET_TYPES]).toEqual(["MONEYLINE", "SPREAD", "TOTAL", "PROP"]);
    expect(q.some((x) => /(^|&)closed=true/.test(x.query))).toBe(true); expect(q.some((x) => /(^|&)active=true/.test(x.query))).toBe(true);
  });
  it("a fake server that answers 400 to anything but a category slug is satisfied by every default query, and the old guess is rejected (the server is as strict as the venue was)", async () => {
    const srv = usServer({ markets: { open: events("o", 40, false), ended: events("e", 40, true) } }); const { http } = setup(srv.handler);
    for (const q of defaultTargetedQueries()) { const r = await fetchUsTargeted(http, US_DEFAULTS, q); expect(r.notes.errors, q.sport).toEqual([]); }
    expect(srv.seen.bad).toEqual([]);
    const old = await fetchUsTargeted(http, US_DEFAULTS, { sport: "football", query: "categories=football&sportsMarketTypes=MONEYLINE&active=true" }); expect(old.notes.errors[0]).toContain("BAD_REQUEST"); expect(old.notes.errors[0]).toContain("400"); expect(srv.seen.bad).toEqual(["football"]);
  });
});

describe("the sports API: sports, leagues, events by sport slug and by league slug", () => {
  const SPORTS = { sports: [{ slug: "nba", name: "NBA" }, { slug: "nfl", name: "NFL" }, { slug: "mlb", name: "MLB" }] }; const LEAGUES = { leagues: [{ slug: "nba-l", sportSlug: "nba" }, { slug: "nfl-l", sport: { slug: "nfl" } }, { slug: "mlb-l", sport: "mlb" }] };
  it("discovers sports and leagues (several response shapes), de-duplicated; an error is reported, not thrown", async () => {
    const a = setup(usServer({ sports: SPORTS, leagues: LEAGUES }).handler); const d = await discoverUsSports(a.http, US_DEFAULTS); expect(d.sports.map((x) => x.slug)).toEqual(["nba", "nfl", "mlb"]); expect(d.leagues).toEqual([{ slug: "nba-l", sportSlug: "nba" }, { slug: "nfl-l", sportSlug: "nfl" }, { slug: "mlb-l", sportSlug: "mlb" }]); expect(d.requests).toBe(2);
    const b = setup(usServer({ sports: [{ slug: "x" }, { slug: "x" }, { id: "y" }, { name: "no slug" }] }).handler); expect((await discoverUsSports(b.http, US_DEFAULTS)).sports.map((x) => x.slug)).toEqual(["x", "y"]);
    const c = setup(usServer({}).handler); const none = await discoverUsSports(c.http, US_DEFAULTS); expect(none.sports).toEqual([]); expect(none.errors).toEqual(["sports: NOT_FOUND 404", "leagues: NOT_FOUND 404"]);
  });
  // Found on the 4.0d production run: the US audit died out of memory because the sports-API stage kept every market of every page of every sport.
  it("keeps at most 600 markets per sport and side (default), however many pages and markets the venue has, and still reports the true quota", async () => {
    const big = Array.from({ length: 40 }, (_, i) => usEvent(`bg${i}`, i, { ended: false, markets: 40 }));   // 1,600 markets in 40 events
    const srv = usServer({ sports: { sports: [{ slug: "nba", name: "NBA" }] }, leagues: { leagues: [] }, sportEvents: { nba: { open: big, ended: [] } } } as never); const { http } = setup(srv.handler);
    const r = await fetchUsSportsTargeted(http, US_DEFAULTS, { maxPages: 50 }); const nba = r.results.find((x) => x.sport === "nba")!;
    expect(nba.markets.length).toBeLessThanOrEqual(600); expect(nba.markets.length).toBeGreaterThan(100); expect(nba.reachedQuota).toBe(true);
    const small = await fetchUsSportsTargeted(http, US_DEFAULTS, { maxPages: 50, maxMarketsPerQuery: 120 }); expect(small.results.find((x) => x.sport === "nba")!.markets.length).toBeLessThanOrEqual(120);
  });
  // Found on the 4.0d production run: the US audit died out of memory because the sports-API stage kept every market of every page of every sport.
  it("keeps at most 10 markets per event and 600 per sport and side, never starves the distinct-event count, and still reports the true quota", async () => {
    const big = Array.from({ length: 40 }, (_, i) => usEvent(`bg${i}`, i, { ended: false, markets: 40 }));   // 1,600 markets in 40 events
    const srv = usServer({ sports: { sports: [{ slug: "nba", name: "NBA" }] }, leagues: { leagues: [] }, sportEvents: { nba: { open: big, ended: [] } } } as never); const { http } = setup(srv.handler);
    const r = await fetchUsSportsTargeted(http, US_DEFAULTS, { maxPages: 50 }); const nba = r.results.find((x) => x.sport === "nba")!;
    expect(nba.markets.length).toBe(400); expect(nba.events).toBe(40); expect(nba.reachedQuota).toBe(true);          // 40 events x 10 markets: far fewer than 1,600, quota intact
    const small = await fetchUsSportsTargeted(http, US_DEFAULTS, { maxPages: 50, maxMarketsPerQuery: 120 }); expect(small.results.find((x) => x.sport === "nba")!.markets.length).toBe(120);
  });
  it("boundSample: first N per event, at most `total`, order-preserving, pure", () => {
    const mk = (g: string, i: number) => ({ id: `${g}-${i}`, event: { id: g } }) as never;
    const input = [mk("a", 1), mk("a", 2), mk("a", 3), mk("b", 1), mk("a", 4), mk("c", 1)];
    expect(boundSample(input, 99, 2).map((m) => (m as unknown as { id: string }).id)).toEqual(["a-1", "a-2", "b-1", "c-1"]);
    expect(boundSample(input, 3, 2).length).toBe(3); expect(boundSample([], 5, 5)).toEqual([]);
  });
  // Review addition (mutation U6 survived): the quota is markets AND events (D76); many markets from few events is the clustering problem the quota exists to expose.
  it("many markets from few events does NOT reach the quota, nor do many events with too few markets", async () => {
    const fewEvents = Array.from({ length: 4 }, (_, i) => usEvent(`mm${i}`, i, { ended: false, markets: 40 }));          // 160 markets, 4 events
    const fewMarkets = Array.from({ length: 30 }, (_, i) => usEvent(`ff${i}`, i, { ended: false, markets: 3 }));          // 90 markets, 30 events
    const both = Array.from({ length: 35 }, (_, i) => usEvent(`bb${i}`, i, { ended: false, markets: 3 }));                // 105 markets, 35 events
    const run = async (sport: string, open: unknown[]) => { const srv = usServer({ sports: { sports: [{ slug: sport, name: sport }] }, leagues: { leagues: [] }, sportEvents: { [sport]: { open, ended: [] } } } as never); const { http } = setup(srv.handler); const r = await fetchUsSportsTargeted(http, US_DEFAULTS, { maxMarketsPerEvent: 100 }); return r.results.find((x) => x.sport === sport)!; };   // the per-event bound is lifted here: this test is about the quota rule itself
    const a = await run("nba", fewEvents); expect(a.markets.length).toBe(160); expect(a.events).toBe(4); expect(a.reachedQuota).toBe(false);
    const b = await run("nfl", fewMarkets); expect(b.markets.length).toBe(90); expect(b.events).toBe(30); expect(b.reachedQuota).toBe(false);
    const c = await run("mlb", both); expect(c.markets.length).toBe(105); expect(c.events).toBe(35); expect(c.reachedQuota).toBe(true);
  });
  it("per sport it fetches the OPEN and the ENDED events by sport slug until ≥ 100 markets from ≥ 30 events, labels them, and a sport that cannot reach the quota says so", async () => {
    const srv = usServer({ sports: SPORTS, leagues: LEAGUES, sportEvents: { nba: { open: events("no", 50, false), ended: events("ne", 50, true) }, nfl: { open: events("fo", 5, false), ended: [] }, mlb: { open: [], ended: [] } } }); const { http } = setup(srv.handler);
    const r = await fetchUsSportsTargeted(http, US_DEFAULTS); const by = Object.fromEntries(r.results.map((x) => [x.sport, x]));
    expect(Object.keys(by).sort()).toEqual(["mlb", "mlb:ended", "nba", "nba:ended", "nfl", "nfl:ended"]); expect(by.nba).toMatchObject({ reachedQuota: true }); expect(by["nba:ended"]).toMatchObject({ reachedQuota: true }); expect(by.nba.events).toBeGreaterThanOrEqual(30); expect(by.nba.markets.length).toBeGreaterThanOrEqual(100); expect(by.nba.notes.stoppedBecause).toBe("quota reached");
    expect(by.nfl).toMatchObject({ reachedQuota: false, events: 5 }); expect(by.nfl.markets).toHaveLength(15); expect(by.nfl.notes.stoppedBecause).toBe("empty page"); expect(by.mlb.markets).toHaveLength(0);
    expect(r.discovery).toEqual({ sports: 3, leagues: 3, errors: [] }); expect(srv.seen.urls.some((u) => u.startsWith("/v2/sports/nba/events?active=true"))).toBe(true); expect(srv.seen.urls.some((u) => u.startsWith("/v2/sports/nba/events?closed=true"))).toBe(true);
    expect((by.nba.markets[0].event as Record<string, unknown>).title).toBe("Team no0a vs Team no0b"); // each market keeps its event
  });
  it("falls back to the sport's league slugs when the sport endpoint has nothing; the label names the league", async () => {
    const srv = usServer({ sports: SPORTS, leagues: LEAGUES, sportEvents: {}, leagueEvents: { "nba-l": { open: events("lo", 40, false), ended: events("le", 40, true) } } }); const { http } = setup(srv.handler); const r = await fetchUsSportsTargeted(http, US_DEFAULTS, { maxSports: 1 });
    expect(r.results.map((x) => x.sport)).toEqual(["nba/nba-l", "nba:ended/nba-l"]); expect(r.results.every((x) => x.reachedQuota)).toBe(true); expect(srv.seen.urls.some((u) => u.startsWith("/v2/leagues/nba-l/events?active=true"))).toBe(true);
  });
  it("only the first `maxSports` sports are fetched, and a request budget stops the fetch with a clear note instead of exceeding it", async () => {
    const world = { sports: SPORTS, leagues: LEAGUES, sportEvents: { nba: { open: events("no", 50, false), ended: events("ne", 50, true) }, nfl: { open: events("fo", 50, false), ended: events("fe", 50, true) }, mlb: { open: events("mo", 50, false), ended: events("me", 50, true) } } };
    const a = setup(usServer(world).handler); expect((await fetchUsSportsTargeted(a.http, US_DEFAULTS, { maxSports: 2 })).results.map((x) => x.sport)).toEqual(["nba", "nba:ended", "nfl", "nfl:ended"]);
    const b = setup(usServer(world).handler); const r = await fetchUsSportsTargeted(b.http, US_DEFAULTS, { maxRequests: 5 }); expect(r.requests).toBeLessThanOrEqual(5); expect(r.stoppedBecause).toMatch(/^request budget \(5\) reached before /); expect(b.f.calls.length).toBeLessThanOrEqual(5);
  });
  it("only public GETs, the research User-Agent, no credential header", async () => { const { http, f } = setup(usServer({ sports: SPORTS, leagues: LEAGUES, sportEvents: { nba: { open: events("no", 40, false), ended: [] } } }).handler); await fetchUsSportsTargeted(http, US_DEFAULTS, { maxSports: 1 }); for (const c of f.calls) { expect(c.method).toBe("GET"); expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]); } });
});

describe("the live / ended indicator: reliability on a fixture with hand-derived answers (measured, never adopted)", () => {
  const T0 = NOW; const row = (id: string, minToStart: number, o: Partial<EventFlagRow> = {}): EventFlagRow => ({ id, startMs: T0 + minToStart * 60_000, live: false, ended: false, allMarketsResolved: false, anyMarketResolved: false, ...o });
  const rows = [row("A", 120), row("B", 30, { live: true }), row("C", -10, { live: true }), row("D", -40, { live: true }), row("E", -60), row("F", -90, { ended: true, allMarketsResolved: true, anyMarketResolved: true }), row("G", -5), row("H", -200), row("I", -20), row("J", -300, { live: true, ended: true, allMarketsResolved: true, anyMarketResolved: true })];
  it("buckets by time to the scheduled start, with the live share and ended count of each", () => {
    const r = inPlayReliability(rows, T0); expect(r.adopted).toBe(false); expect(r.events).toBe(10); expect(r.withStart).toBe(10); expect(r.withLiveFlag).toBe(10);
    const b = Object.fromEntries(r.buckets.map((x) => [x.bucket, x])); expect(r.buckets.map((x) => x.bucket)).toEqual(INPLAY_BUCKETS.map((x) => x.name));
    expect(b["1–3 h before"]).toMatchObject({ events: 1, live: 0 }); expect(b["15–60 min before"]).toMatchObject({ events: 1, live: 1, liveShare: 1 }); expect(b["0–15 min after"]).toMatchObject({ events: 2, live: 1, liveShare: 0.5 }); expect(b["15–60 min after"]).toMatchObject({ events: 3, live: 1, liveShare: 0.333 });
    expect(b["1–3 h after"]).toMatchObject({ events: 1, live: 0, ended: 1 }); expect(b["> 3 h after"]).toMatchObject({ events: 2, live: 1, ended: 1 }); expect(b["> 3 h before"]).toMatchObject({ events: 0, liveShare: null }); expect(r.buckets.reduce((a, x) => a + x.events, 0)).toBe(10);
  });
  it("live before the scheduled start (false positive for 'in play'): beyond the 5-minute tolerance, how many, how early", () => {
    const r = inPlayReliability(rows, T0); expect(r.liveBeforeStart).toEqual({ count: 1, shareOfLive: 0.25, maxLeadMin: 30, toleranceMin: 5 }); expect(inPlayReliability([row("x", 5, { live: true })], T0).liveBeforeStart.count).toBe(0); // exactly the tolerance is not early
    expect(inPlayReliability([row("x", 5.1, { live: true })], T0).liveBeforeStart.count).toBe(1);
  });
  it("live events that had started: how long ago (p10 / p50 / p90 / max)", () => { const r = inPlayReliability(rows, T0); expect(r.liveAfterStartAgeMin).toEqual({ n: 3, p10: 16, p50: 40, p90: 248, max: 300 }); });
  it("started more than 5 and at most 180 minutes ago, neither live nor ended (false negatives for 'in play'): the flag is missing or the event finished unflagged", () => {
    const r = inPlayReliability(rows, T0); expect(r.startedNotLive).toEqual({ count: 2, shareOfRecentlyStarted: 0.5, ageMin: { p10: 24, p50: 40, p90: 56 }, windowMin: 180 });
    // the edges: exactly 5 minutes ago and exactly 180 minutes ago
    expect(inPlayReliability([row("g", -5)], T0).startedNotLive.count).toBe(0); expect(inPlayReliability([row("g", -5.1)], T0).startedNotLive.count).toBe(1); expect(inPlayReliability([row("h", -180)], T0).startedNotLive.count).toBe(1); expect(inPlayReliability([row("h", -180.1)], T0).startedNotLive.count).toBe(0);
  });
  it("`ended` against the markets' resolved status, and the contradictions (live and ended at once, live with everything resolved)", () => {
    const r = inPlayReliability(rows, T0); expect(r.ended).toEqual({ flagged: 2, allMarketsResolved: 2, anyMarketOpen: 0, resolvedButNotFlagged: 0, resolvedEvents: 2, liveAndEnded: 1, liveAndAllResolved: 1 });
    const bad = inPlayReliability([row("p", -300, { ended: true, allMarketsResolved: false }), row("q", -300, { ended: false, allMarketsResolved: true })], T0); expect(bad.ended).toMatchObject({ flagged: 1, allMarketsResolved: 0, anyMarketOpen: 1, resolvedButNotFlagged: 1, resolvedEvents: 1 });
  });
  it("events without a start, or without flags, are counted but not guessed; an empty snapshot is all zeros", () => {
    const r = inPlayReliability([{ id: "n", startMs: null, live: null, ended: null, allMarketsResolved: null, anyMarketResolved: null }], T0); expect(r).toMatchObject({ events: 1, withStart: 0, withLiveFlag: 0, withEndedFlag: 0 }); expect(r.buckets.every((b) => b.events === 0)).toBe(true); expect(r.liveBeforeStart.shareOfLive).toBeNull(); expect(r.startedNotLive.shareOfRecentlyStarted).toBeNull();
    expect(inPlayReliability([], T0).events).toBe(0);
  });
  it("rows are built per distinct event from exploded markets: the event's live / ended flags, its start (event time first, else the market's gameStartTime), resolved status of its markets", () => {
    const ev = { id: "e1", live: true, ended: false, startTime: "2026-10-03T00:30:00Z" }; const mk = (id: string, closed: boolean, extra: Record<string, unknown> = {}) => ({ id, closed, event: ev, gameStartTime: "2026-10-03 01:00:00+00", ...extra });
    const r = eventFlagRows([mk("a", true), mk("b", false), { id: "c", closed: false, event: { id: "e2", ended: true }, gameStartTime: "2026-10-03 02:00:00+00" }, { id: "d", closed: true, live: false, event: { id: "e3" } }]);
    expect(r).toEqual([{ id: "e1", startMs: Date.parse("2026-10-03T00:30:00Z"), live: true, ended: false, allMarketsResolved: false, anyMarketResolved: true }, { id: "e2", startMs: Date.parse("2026-10-03T02:00:00Z"), live: null, ended: true, allMarketsResolved: false, anyMarketResolved: false }, { id: "e3", startMs: null, live: false, ended: null, allMarketsResolved: true, anyMarketResolved: true }]);
  });
});

describe("schedule sources", () => {
  it("per sport: does the schedule source carry a time of day, and does it agree with gameStartTime (within 1 and 15 minutes), with the placeholder count", () => {
    const rows = [
      { group: "g1", sport: "basketball", source: "2026-10-05T00:00:00Z", other: "2026-10-05 00:00:00+00" },           // equal, but a midnight placeholder: no time of day
      { group: "g2", sport: "basketball", source: "2026-10-05T23:30:00Z", other: "2026-10-05 23:40:00+00" },           // 10 minutes apart
      { group: "g3", sport: "basketball", source: "2026-10-06T01:00:30Z", other: "2026-10-06 01:00:00+00" },           // 30 s apart
      { group: "g4", sport: "basketball", source: null, other: "2026-10-06 02:00:00+00" },                             // no source value
      { group: "g5", sport: "hockey", source: "2026-10-05", other: "2026-10-05 23:00:00+00" },                         // date only
    ];
    const s = scheduleCompare(rows); expect(s.map((x) => x.sport)).toEqual(["basketball", "hockey"]); const b = s[0];
    expect(b).toMatchObject({ events: 4, sourceWithTimeOfDay: 2, otherWithTimeOfDay: 3, both: 3, agreeWithin1Min: 2, agreeWithin15Min: 3, agreeShare: 0.667, sourcePlaceholders: 1 }); expect(b.absDiffMin).toEqual({ p50: 0.5, p90: 8.1, max: 10 });
    expect(s[1]).toMatchObject({ events: 1, sourceWithTimeOfDay: 0, both: 0, agreeShare: null, sourcePlaceholders: 1 }); expect(scheduleCompare([])).toEqual([]);
  });
  it("US rows: one per distinct event, the event-level start (never startDate, a listing time) against the market's gameStartTime", () => {
    const m = (id: string, ev: Record<string, unknown>, g: string) => ({ id, gameStartTime: g, event: { id: ev.id ?? "e", ...ev } });
    const rows = usScheduleRows([m("a", { id: "e1", startTime: "2026-10-05T20:00:00Z", startDate: "2026-09-30T10:00:00Z" }, "2026-10-05 20:00:00+00"), m("b", { id: "e1", startTime: "x" }, "x"), m("c", { id: "e2", startDate: "2026-09-30T10:00:00Z" }, "2026-10-06 01:00:00+00")], () => "sports:basketball");
    expect(rows).toEqual([{ group: "e1", sport: "sports:basketball", source: "2026-10-05T20:00:00Z", other: "2026-10-05 20:00:00+00" }, { group: "e2", sport: "sports:basketball", source: null, other: "2026-10-06 01:00:00+00" }]);
  });
});

describe("gameStartTime on single-game markets versus FUTURES markets (Part D2)", () => {
  it("market classes", () => { expect(["MONEYLINE", "SPREAD", "TOTAL", "PROP", "PARLAY"].map(marketClassOf)).toEqual(Array(5).fill("single_game")); expect(["FUTURES", "SEASON_FUTURES"].map(marketClassOf)).toEqual(["futures", "futures"]); expect(["(unknown)", "(none)"].map(marketClassOf)).toEqual(["unclassified", "unclassified"]); });
  const world = () => {
    const single = marketsOfEvents(varied("g", 40, { markets: 2, resolved: (i) => i % 2 === 1 }));                              // kick-offs within hours of resolution, days after creation
    const fut = marketsOfEvents(varied("f", 40, { markets: 1, resolved: (i) => i % 2 === 1 })).map((m) => { const created = Date.parse(String(m.createdAt)); return { ...m, sportsMarketType: "futures", gameStartTime: new Date(created + 5 * 60_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "+00"), closedTime: m.closed ? new Date(created + 200 * 86_400_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "+00") : undefined }; });
    return [...single, ...fut];
  };
  it("a futures market's gameStartTime is a listing time (minutes after creation, resolution months later): the verdict is SINGLE_GAME_ONLY, with the numbers behind it", () => {
    const ms = toMarkets(world()); const inv = buildInventory(ms); const d = gameStartDeepDive("v", ms, inv); const sp = d.futures.filter((f) => f.sport === "sports:basketball");
    const sg = sp.find((f) => f.class === "single_game")!, fu = sp.find((f) => f.class === "futures")!; expect(sg.events).toBe(40); expect(fu.events).toBe(40); expect(sg.resolutionMinusStartHours!.p50!).toBeGreaterThan(2); expect(sg.resolutionMinusStartHours!.p50!).toBeLessThan(3.5); expect(sg.resolutionMinusStartHours!.within24hShare).toBe(1);
    expect(fu.withinHourOfCreationShare).toBe(1); expect(fu.startMinusCreationHours!.p50).toBeCloseTo(0.08, 1); expect(fu.resolutionMinusStartHours!.p50!).toBeGreaterThan(24 * 100); expect(sg.withinHourOfCreationShare).toBe(0);
    expect(futuresVerdicts(d.futures)).toEqual([expect.objectContaining({ sport: "sports:basketball", verdict: "SINGLE_GAME_ONLY" })]);
  });
  // Review addition (found by the mutation checker: G6 survived). The verdict is a statement about the SINGLE-GAME class: it must not be given when the single-game
  // times themselves do not look like a start, even if the futures class looks like a listing time.
  const frow = (cls: "single_game" | "futures", o: { p50Gap: number | null; withinHour?: number | null; withField?: number }) => ({
    sport: "sports:basketball", class: cls, events: 40, withField: o.withField ?? 40, distinctClocks: 12, topClock: "01:00:00", topClockShare: 0.2,
    startMinusCreationHours: { p10: 20, p50: 100, p90: 150 }, withinHourOfCreationShare: o.withinHour ?? 0,
    resolutionMinusStartHours: o.p50Gap === null ? null : { n: 30, p10: 1, p50: o.p50Gap, p90: o.p50Gap * 2, within24hShare: o.p50Gap <= 24 ? 1 : 0 },
  }) as never;
  it("SINGLE_GAME_ONLY is never given when the single-game times do not look like a start (the futures class alone looking like a listing time is not enough)", () => {
    const bad = futuresVerdicts([frow("single_game", { p50Gap: 100 }), frow("futures", { p50Gap: 5000, withinHour: 1 })]);   // game gap far above 24 h; futures clearly a listing time
    expect(bad[0].verdict).toBe("NO_DIFFERENCE_OBSERVED");
    const noRes = futuresVerdicts([frow("single_game", { p50Gap: null }), frow("futures", { p50Gap: 5000, withinHour: 1 })]);    // no resolution evidence for the single-game class
    expect(noRes[0].verdict).toBe("NO_DIFFERENCE_OBSERVED");
    const nonPositive = futuresVerdicts([frow("single_game", { p50Gap: -2 }), frow("futures", { p50Gap: 5000, withinHour: 1 })]); // resolved before the claimed start
    expect(nonPositive[0].verdict).toBe("NO_DIFFERENCE_OBSERVED");
    const good = futuresVerdicts([frow("single_game", { p50Gap: 3 }), frow("futures", { p50Gap: 5000, withinHour: 1 })]);
    expect(good[0].verdict).toBe("SINGLE_GAME_ONLY");
    const futuresFine = futuresVerdicts([frow("single_game", { p50Gap: 3 }), frow("futures", { p50Gap: 5, withinHour: 0.1 })]);  // single game fine, futures fine too
    expect(futuresFine[0].verdict).toBe("NO_DIFFERENCE_OBSERVED");
  });
  it("INSUFFICIENT_DATA below 30 events in a class, and NO_DIFFERENCE_OBSERVED when futures behave like games", () => {
    const few = toMarkets([...marketsOfEvents(varied("g", 40, { markets: 1, resolved: (i) => i % 2 === 1 })), ...marketsOfEvents(varied("f", 10, { markets: 1, resolved: (i) => i % 2 === 1 })).map((m) => ({ ...m, sportsMarketType: "futures" }))]); const v1 = futuresVerdicts(gameStartDeepDive("v", few, buildInventory(few)).futures); expect(v1[0].verdict).toBe("INSUFFICIENT_DATA"); expect(v1[0].rule).toContain("futures 10");
    const same = toMarkets([...marketsOfEvents(varied("g", 40, { markets: 1, resolved: (i) => i % 2 === 1 })), ...marketsOfEvents(varied("f", 40, { markets: 1, resolved: (i) => i % 2 === 1 })).map((m) => ({ ...m, sportsMarketType: "futures" }))]); const v2 = futuresVerdicts(gameStartDeepDive("v", same, buildInventory(same)).futures); expect(v2[0].verdict).toBe("NO_DIFFERENCE_OBSERVED");
    expect(futuresVerdicts([])).toEqual([]);
  });
});

describe("per-candidate slot verdicts (Part D1)", () => {
  /** `noEventStart` removes the event-level startTime (the US documentation shows gameStartTime, not an event startTime), so gameStartTime is the only real start. */
  const audited = (specs: ReturnType<typeof varied>, o: { gameStart?: boolean; noEventStart?: boolean } = {}) => { const raws = marketsOfEvents(specs, { gameStartField: o.gameStart }).map((m) => (o.noEventStart ? { ...m, events: (m.events as Record<string, unknown>[]).map(({ startTime, ...e }) => e) } : m)); const ms = toMarkets(raws); return recommendSlots("v", ms, buildInventory(ms)); };
  const slot1 = (v: ReturnType<typeof audited>) => v.find((r) => r.stratum === "sports:basketball" && r.slot === 1)!;
  it("startDate (a listing time) fails and gameStartTime passes: the slot's best field is gameStartTime, and BOTH verdicts are reported with the rule that decided each", () => {
    const v = slot1(audited(varied("g", 60, { markets: 2, resolved: (i) => i % 2 === 1 }), { noEventStart: true })); expect(v.bestField).toBe("gameStartTime"); expect(v.verdict).toBe("RECOMMEND"); expect(v.field).toBe("gameStartTime");
    const c = Object.fromEntries(v.candidates!.map((x) => [x.field, x])); expect(c.gameStartTime).toMatchObject({ verdict: "RECOMMEND", decidedBy: "allPassed", best: true, failedRules: [] }); expect(c.startDate).toMatchObject({ verdict: "UNRELIABLE_REJECT", best: false }); expect(c.startDate.failedRules).toContain("creationCoincidence");
    expect(v.candidates![0].field).toBe("gameStartTime"); // best first
  });
  it("every candidate field is judged, event-level fields included, with presence and usable share", () => {
    const v = slot1(audited(varied("g", 60, { markets: 2, resolved: (i) => i % 2 === 1 }))); expect(v.candidates!.map((x) => x.field).sort()).toEqual(["events[].startDate", "events[].startTime", "gameStartTime", "startDate"]); for (const c of v.candidates!) { expect(c.presentEvents).toBe(60); expect(c.role).toBe("START_LIKE"); expect(c.usableShare).toBeGreaterThan(0.9); }
    expect(v.candidates!.find((x) => x.field === "events[].startTime")!.verdict).toBe("RECOMMEND"); expect(v.bestField).toBe("events[].startTime"); // ties between passing candidates go to the first by name; both are listed
  });
  it("an OPEN-only sample gives gameStartTime NO ordering evidence: INSUFFICIENT_DATA (evidenceGap), not 'unusable' — and the older single-field row still names the rejected startDate, which is why 4.0b misread it", () => {
    const v = slot1(audited(varied("g", 60, { markets: 2, resolved: () => false }), { noEventStart: true })); const c = Object.fromEntries(v.candidates!.map((x) => [x.field, x]));
    expect(c.gameStartTime).toMatchObject({ verdict: "INSUFFICIENT_DATA", decidedBy: "evidenceGap" }); expect(c.gameStartTime.failed[0]).toMatch(/only 0 resolved events with a reference time/); expect(c.startDate.verdict).toBe("UNRELIABLE_REJECT"); expect(v.bestField).toBeNull();
    expect(v.field).toContain("startDate"); expect(v.verdict).toBe("UNRELIABLE_REJECT"); // the legacy summary row prints the field with the fewest definitive failures; `candidates` tells the rest
  });
  it("no start-like field at all: no candidates, bestField null, the old rule key", () => { const ms = toMarkets([{ conditionId: "0x1", question: "Team a vs Team b", slug: "nba-a-b", closed: false, endDate: "2026-10-05T17:00:00Z" }]); const v = recommendSlots("v", ms, buildInventory(ms)).find((r) => r.slot === 1)!; expect(v).toMatchObject({ candidates: [], bestField: null, decidedBy: "noField" }); });
  it("slot 2 judges close-like fields only (resolution-like fields never appear), and a passing close field needs human review", () => {
    const ms = toMarkets(marketsOfEvents(varied("g", 60, { markets: 2, resolved: (i) => i % 2 === 1 }))); const s2 = recommendSlots("v", ms, buildInventory(ms)).find((r) => r.stratum === "sports:basketball" && r.slot === 2)!; expect(s2.candidates!.every((c) => c.role === "CLOSE_LIKE")).toBe(true); expect(s2.candidates!.map((c) => c.field)).not.toContain("closedTime");
  });
  it("the thresholds are untouched (owner decision D68)", async () => { const { RECOMMEND_RULES } = await import("../src/lib/phase4/audit"); expect(RECOMMEND_RULES).toEqual({ minPresent: 30, minUsableShare: 0.9, maxPlaceholderShare: 0.1, maxTopClockShare: 0.5, minOrderedShare: 0.99, minOrderedSamples: 30, startToleranceVsCloseMin: 15, minStartBeforeCloseShare: 0.95, maxCreationCoincidenceShare: 0.5, creationCoincidenceMin: 60, eventTypeMaxMedianGapHours: 24 }); });
});

describe("S1a with --us-targeted default: the sports API, ended events, in-play and schedule, end to end", () => {
  const files = () => { const out: Record<string, string> = {}; return { out, writeFile: (p: string, c: string) => { out[p] = c; }, mkdir: () => {} }; };
  const run = async (srv: ReturnType<typeof usServer>, argv: string[] = []) => { const c = virtualClock(NOW); const f = fakeFetch((u) => (u.host === "gamma-api.polymarket.com" ? json({ markets: [], next_cursor: null }) : srv.handler(u)), c.now); const w = files(); const lines: string[] = [];
    const code = await runTimestampAuditCli(["--no-fixtures", "--us-targeted", "default", ...argv], {}, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: w.writeFile, mkdir: w.mkdir, log: (l) => lines.push(l) }); return { code, f, files: w.out, lines }; };
  const sports = { sports: [{ slug: "nba", name: "NBA" }] };
  it("open AND ended events reach the audit: gameStartTime is judged against resolution times, passes, and the compact file says so; startDate is rejected", async () => {
    const srv = usServer({ sports, leagues: { leagues: [] }, sportEvents: { nba: { open: events("o", 45, false), ended: events("e", 45, true) } }, markets: { open: events("o", 45, false), ended: events("e", 45, true) } });
    const r = await run(srv); expect(r.code).toBe(EXIT.OK); expect(r.lines.length).toBeLessThanOrEqual(60); const us = JSON.parse(r.files["docs/phase4/data/s1a_polymarket_us.json"]);
    const s1 = us.recommendations.find((x: any) => x.stratum === "sports:basketball" && x.slot === 1); expect(s1.bestField).toBe("gameStartTime"); const cand = Object.fromEntries(s1.candidates.map((c: any) => [c.field, c])); expect(cand.gameStartTime.verdict).toBe("RECOMMEND"); expect(cand.startDate.verdict).toBe("UNRELIABLE_REJECT");
    expect(us.counts.resolved).toBeGreaterThanOrEqual(45); expect(us.targeted.map((t: any) => t.sport).sort()).toEqual(["nba", "nba:ended"]); expect(us.futuresVerdicts).toBeDefined();
    const compact = r.files["docs/phase4/data/S1_COMPACT.md"]; expect(compact.split("\n").length).toBeLessThanOrEqual(81); expect(compact).toMatch(/\| US \| sports:basketball \| 1 \| `gameStartTime` \| OK \|/);
    const summary = JSON.parse(r.files["docs/phase4/data/s1a_summary.json"]); expect(summary.sportsApi).toMatchObject({ sports: 1, leagues: 0 }); expect(summary.inPlay).toMatchObject({ adopted: false }); expect(r.files["docs/phase4/data/s1a_inplay_us.json"]).toContain('"adopted": false');
    expect(r.files["docs/phase4/data/S1a_RESULTS.md"]).toContain("### Every candidate field judged per stratum and slot"); expect(r.files["docs/phase4/data/S1a_RESULTS.md"]).toContain("The `live` / `ended` indicator (MEASURED, NOT ADOPTED");
  });
  it("when the sports API answers nothing the corrected category-slug queries stand in, the fake venue's 400 is never provoked, and the fallback is stated", async () => {
    const srv = usServer({ markets: { open: events("o", 45, false), ended: events("e", 45, true) } }); const r = await run(srv); expect(r.code).toBe(0); expect(srv.seen.bad).toEqual([]);
    const us = JSON.parse(r.files["docs/phase4/data/s1a_polymarket_us.json"]); expect(us.targeted.map((t: any) => t.sport)).toEqual(["sports", "sports:ended", "crypto"]); expect(us.targeted.find((t: any) => t.sport === "sports").markets).toBeGreaterThan(0);
    expect(JSON.parse(r.files["docs/phase4/data/s1a_summary.json"]).sportsApi.errors.join(" ")).toContain("falling back to the category-slug queries");
  });
  it("an explicit override still works, and a wrong query is reported, not hidden (the 4.0b guess is a 400 and says so in the results)", async () => {
    const srv = usServer({ markets: { open: events("o", 5, false), ended: [] } }); const c = virtualClock(NOW); const f = fakeFetch((u) => (u.host === "gamma-api.polymarket.com" ? json({ markets: [], next_cursor: null }) : srv.handler(u)), c.now); const w = files();
    await runTimestampAuditCli(["--no-fixtures", "--us-targeted", "football=categories=football&active=true"], {}, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: w.writeFile, mkdir: w.mkdir, log: () => {} }); const us = JSON.parse(w.out["docs/phase4/data/s1a_polymarket_us.json"]); expect(us.targeted[0]).toMatchObject({ sport: "football", markets: 0 }); expect(us.targeted[0].errors[0]).toContain("BAD_REQUEST"); expect(srv.seen.bad).toEqual(["football"]);
  });
  it("the US origin is paced at its documented 60 requests/minute (≥ 1.1 s apart), Gamma at the brief's 2/second", async () => {
    const srv = usServer({ sports, leagues: { leagues: [] }, sportEvents: { nba: { open: events("o", 45, false), ended: events("e", 45, true) } }, markets: { open: events("o", 45, false), ended: events("e", 45, true) } }); const r = await run(srv);
    const us = r.f.calls.filter((c) => new URL(c.url).host === "gateway.polymarket.us"); expect(us.length).toBeGreaterThan(5); for (let i = 1; i < us.length; i++) expect(us[i].at! - us[i - 1].at!).toBeGreaterThanOrEqual(1100);
    const g = r.f.calls.filter((c) => new URL(c.url).host === "gamma-api.polymarket.com"); for (let i = 1; i < g.length; i++) expect(g[i].at! - g[i - 1].at!).toBeGreaterThanOrEqual(500);
  });
});
