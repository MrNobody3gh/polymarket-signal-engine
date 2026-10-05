/**
 * Phase 4.0c — the US exchange's documented SPORTS API (sports, leagues, events by sport slug and by league slug), the in-play indicator
 * (`live` / `ended` on events) and the schedule sources. Read-only: GET through PoliteHttp. Probe only: nothing here adopts a field or a rule.
 *
 * UNVERIFIED (the documentation could not be fetched in the authoring environment; paths and parameter names come from search-engine summaries
 * of docs.polymarket.us): GET /v2/sports, GET /v2/leagues, GET /v2/sports/{slug}/events, GET /v2/leagues/{slug}/events, and the event filters
 * `active`, `closed`, `archived`, `ended`, `live`, `categories`, `seriesId`, `gameId`. A wrong path or parameter fails with NOT_FOUND / BAD_REQUEST
 * and is reported; it cannot do harm (GET of public data only).
 */
import type { PoliteHttp } from "./http";
import type { RawMarket } from "./audit";
import { fetchUs, usGroupOf, usIsResolved, type FetchNotes, type TargetedResult, type UsConfig } from "./venues";
import { parseTimestamp, placeholderKind } from "./timestamps";
import { quantile } from "./stats";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const arrayIn = (json: unknown, keys: string[]): Record<string, unknown>[] => {
  const pick = (v: unknown) => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : null);
  const root = pick(json); if (root) return root;
  if (json && typeof json === "object") for (const k of keys) { const a = pick((json as Record<string, unknown>)[k]); if (a) return a; }
  return [];
};

export interface SportRef { slug: string; name: string | null }
export interface LeagueRef { slug: string; sportSlug: string | null }
/** Discover the sports (`GET <sportsPath>`) and leagues (`GET <leaguesPath>`). Never throws; an error is returned as text. */
export async function discoverUsSports(http: PoliteHttp, cfg: UsConfig): Promise<{ sports: SportRef[]; leagues: LeagueRef[]; errors: string[]; requests: number }> {
  const errors: string[] = []; let requests = 0;
  const s = await http.getJson(`${cfg.base}${cfg.sportsPath}`); requests++;
  const sports: SportRef[] = s.ok ? arrayIn(s.json, ["sports", "data", "results", "items"]).map((x) => ({ slug: str(x.slug) ?? str(x.id) ?? "", name: str(x.name) ?? str(x.label) })).filter((x) => x.slug) : (errors.push(`sports: ${s.kind}${s.status ? ` ${s.status}` : ""}`), []);
  const l = await http.getJson(`${cfg.base}${cfg.leaguesPath}`); requests++;
  const leagues: LeagueRef[] = l.ok ? arrayIn(l.json, ["leagues", "data", "results", "items"]).map((x) => ({ slug: str(x.slug) ?? str(x.id) ?? "", sportSlug: str(x.sportSlug) ?? str(x.sport_slug) ?? str((x.sport as Record<string, unknown> | undefined)?.slug) ?? (typeof x.sport === "string" ? x.sport : null) })).filter((x) => x.slug) : (errors.push(`leagues: ${l.kind}${l.status ? ` ${l.status}` : ""}`), []);
  return { sports: [...new Map(sports.map((x) => [x.slug, x])).values()], leagues: [...new Map(leagues.map((x) => [x.slug, x])).values()], errors, requests };
}

/** The first `perEvent` markets of each event, at most `total` markets: bounds what a per-sport sample retains without ever starving the distinct-event count (pure, order-preserving). */
export function boundSample(markets: RawMarket[], total: number, perEvent: number): RawMarket[] {
  const seen = new Map<string, number>(); const out: RawMarket[] = [];
  for (const m of markets) { if (out.length >= total) break; const g = usGroupOf(m); const n = seen.get(g) ?? 0; if (n >= perEvent) continue; seen.set(g, n + 1); out.push(m); }
  return out;
}
export interface SportsFetchOptions { /** markets kept per sport and side (default 600) and per event (default 10): the quota needs 100 markets from 30 events, so 30 events always fit; retaining every page of 12 sports x 2 sides exhausted the heap on the 4.0d production run */ maxMarketsPerQuery?: number; maxMarketsPerEvent?: number; maxSports?: number; minMarkets?: number; minEvents?: number; maxPages?: number; /** a request budget for the whole sports fetch; reaching it stops the fetch with a clear note */ maxRequests?: number }
/**
 * Per-sport samples from the sports API: for each discovered sport, the OPEN events (`active=true`) and the ENDED events (`closed=true`), by sport slug,
 * falling back to the sport's league slugs when the sport endpoint answers with an error or nothing. Each side is paged until ≥ `minMarkets` markets from
 * ≥ `minEvents` distinct events (D76) or the listing ends. Markets arrive exploded from their events (each keeps its event under `event`).
 */
export async function fetchUsSportsTargeted(http: PoliteHttp, cfg: UsConfig, o: SportsFetchOptions = {}): Promise<{ results: TargetedResult[]; discovery: { sports: number; leagues: number; errors: string[] }; requests: number; stoppedBecause: string | null }> {
  const minM = o.minMarkets ?? 100, minE = o.minEvents ?? 30; const enough = (ms: RawMarket[]) => ms.length >= minM && new Set(ms.map(usGroupOf)).size >= minE;
  const d = await discoverUsSports(http, cfg); let requests = d.requests; const results: TargetedResult[] = []; let stoppedBecause: string | null = null;
  const budgetLeft = () => (o.maxRequests === undefined ? Infinity : o.maxRequests - requests);
  const one = async (label: string, path: string, query: string): Promise<TargetedResult> => {
    const left = budgetLeft(); const pages = Math.min(o.maxPages ?? 6, left);
    if (pages <= 0) { stoppedBecause = `request budget (${o.maxRequests}) reached before ${label}`; const notes: FetchNotes = { endpoint: `${cfg.base}${path}`, pages: 0, records: 0, cursorKey: null, filterHonoured: null, stoppedBecause: "request budget reached", errors: [] }; return { sport: label, query, markets: [], notes, reachedQuota: false, events: 0 }; }
    const r = await fetchUs(http, cfg, { closed: false, max: Infinity, maxPages: pages, query, path, enough, slim: true }); requests += r.notes.pages;
    const kept = boundSample(r.markets, o.maxMarketsPerQuery ?? 600, o.maxMarketsPerEvent ?? 10);
    return { sport: label, query, markets: kept, notes: r.notes, reachedQuota: enough(kept), events: new Set(kept.map(usGroupOf)).size };
  };
  for (const sp of d.sports.slice(0, o.maxSports ?? 12)) {
    for (const side of ["open", "ended"] as const) {
      const query = side === "open" ? "active=true" : "closed=true"; const label = side === "open" ? sp.slug : `${sp.slug}:ended`;
      let res = await one(label, `${cfg.sportsPath}/${encodeURIComponent(sp.slug)}/events`, query);
      if (!res.markets.length) for (const lg of d.leagues.filter((x) => x.sportSlug === sp.slug).slice(0, 3)) { const alt = await one(`${label}/${lg.slug}`, `${cfg.leaguesPath}/${encodeURIComponent(lg.slug)}/events`, query); if (alt.markets.length) { res = alt; break; } }
      results.push(res);
      if (stoppedBecause) break;
    }
    if (stoppedBecause) break;
  }
  return { results, discovery: { sports: d.sports.length, leagues: d.leagues.length, errors: d.errors }, requests, stoppedBecause };
}

// ───────────────────────────────────────────── in-play indicator (live / ended) ─────────────────────────────

export interface EventFlagRow { id: string; startMs: number | null; live: boolean | null; ended: boolean | null; /** every market of the event is resolved / at least one is */ allMarketsResolved: boolean | null; anyMarketResolved: boolean | null; sport?: string }
const startOf = (e: Record<string, unknown>, m: RawMarket): number | null => { for (const v of [e.gameStartTime, e.startTime, e.eventStartTime, m.gameStartTime]) { const p = parseTimestamp(v); if (p.kind === "datetime" || p.kind === "epoch") return p.ms; } return null; };
/** One row per distinct event from exploded markets (each keeps its event under `event`): the event's `live` / `ended` flags, its scheduled start, and whether its (listed) markets are resolved. */
export function eventFlagRows(markets: RawMarket[]): EventFlagRow[] {
  const by = new Map<string, { e: Record<string, unknown>; m: RawMarket; res: boolean[] }>();
  for (const m of markets) { const e = (m.event && typeof m.event === "object" ? (m.event as Record<string, unknown>) : {}); const id = usGroupOf(m); const cur = by.get(id); if (cur) cur.res.push(usIsResolved(m)); else by.set(id, { e, m, res: [usIsResolved(m)] }); }
  return [...by.entries()].map(([id, { e, m, res }]) => ({ id, startMs: startOf(e, m), live: typeof e.live === "boolean" ? e.live : typeof m.live === "boolean" ? m.live : null, ended: typeof e.ended === "boolean" ? e.ended : typeof m.ended === "boolean" ? m.ended : null, allMarketsResolved: res.every(Boolean), anyMarketResolved: res.some(Boolean) }));
}

/** Minutes from `now` to the scheduled start, in buckets (negative = started). */
export const INPLAY_BUCKETS = [{ name: "> 3 h before", lo: 180, hi: Infinity }, { name: "1–3 h before", lo: 60, hi: 180 }, { name: "15–60 min before", lo: 15, hi: 60 }, { name: "0–15 min before", lo: 0, hi: 15 }, { name: "0–15 min after", lo: -15, hi: 0 }, { name: "15–60 min after", lo: -60, hi: -15 }, { name: "1–3 h after", lo: -180, hi: -60 }, { name: "> 3 h after", lo: -Infinity, hi: -180 }] as const;
export interface InPlayReport {
  /** The in-play indicator is MEASURED here, never adopted: plan §3.4 keeps its own in-play rule (time_to_event ≤ 0). */
  adopted: false; nowIso: string; events: number; withStart: number; withLiveFlag: number; withEndedFlag: number;
  buckets: { bucket: string; events: number; live: number; ended: number; liveShare: number | null }[];
  /** live = true while the scheduled start is more than `toleranceMin` in the future: the flag flips EARLY (false positive for "in play"). */
  liveBeforeStart: { count: number; shareOfLive: number | null; maxLeadMin: number | null; toleranceMin: number };
  /** live events that had started: how long ago (minutes). Together with `startedNotLive` this brackets when the flag flips. */
  liveAfterStartAgeMin: { n: number; p10: number | null; p50: number | null; p90: number | null; max: number | null };
  /** Started more than `toleranceMin` and less than `windowMin` ago, neither live nor ended: the flag is missing, or the event finished without being flagged ended (false negatives for "in play"). */
  startedNotLive: { count: number; shareOfRecentlyStarted: number | null; ageMin: { p10: number | null; p50: number | null; p90: number | null }; windowMin: number };
  /** The `ended` flag against the markets' resolved status. */
  ended: { flagged: number; allMarketsResolved: number; anyMarketOpen: number; resolvedButNotFlagged: number; resolvedEvents: number; liveAndEnded: number; liveAndAllResolved: number };
}
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
/** Reliability of `live` / `ended` as an in-play indicator over a snapshot of events at `nowMs` (pure). */
export function inPlayReliability(rows: EventFlagRow[], nowMs: number, o: { toleranceMin?: number; windowMin?: number } = {}): InPlayReport {
  const tol = o.toleranceMin ?? 5, win = o.windowMin ?? 180; const withStart = rows.filter((r) => r.startMs !== null); const minToStart = (r: EventFlagRow) => (r.startMs! - nowMs) / 60_000;
  const buckets = INPLAY_BUCKETS.map((b) => { const sel = withStart.filter((r) => { const t = minToStart(r); return t >= b.lo && t < b.hi; }); const live = sel.filter((r) => r.live === true).length; return { bucket: b.name, events: sel.length, live, ended: sel.filter((r) => r.ended === true).length, liveShare: sel.length ? Math.round((live / sel.length) * 1000) / 1000 : null }; });
  const live = rows.filter((r) => r.live === true); const early = live.filter((r) => r.startMs !== null && minToStart(r) > tol);
  const liveStarted = live.filter((r) => r.startMs !== null && minToStart(r) <= 0).map((r) => -minToStart(r));
  const recent = withStart.filter((r) => { const age = -minToStart(r); return age > tol && age <= win && r.ended !== true; }); const missing = recent.filter((r) => r.live !== true);
  const ended = rows.filter((r) => r.ended === true); const resolved = rows.filter((r) => r.allMarketsResolved === true);
  return {
    adopted: false, nowIso: new Date(nowMs).toISOString(), events: rows.length, withStart: withStart.length, withLiveFlag: rows.filter((r) => r.live !== null).length, withEndedFlag: rows.filter((r) => r.ended !== null).length, buckets,
    liveBeforeStart: { count: early.length, shareOfLive: live.length ? Math.round((early.length / live.length) * 1000) / 1000 : null, maxLeadMin: early.length ? r1(Math.max(...early.map(minToStart))) : null, toleranceMin: tol },
    liveAfterStartAgeMin: { n: liveStarted.length, p10: r1(quantile(liveStarted, 0.1)), p50: r1(quantile(liveStarted, 0.5)), p90: r1(quantile(liveStarted, 0.9)), max: liveStarted.length ? r1(Math.max(...liveStarted)) : null },
    startedNotLive: { count: missing.length, shareOfRecentlyStarted: recent.length ? Math.round((missing.length / recent.length) * 1000) / 1000 : null, ageMin: { p10: r1(quantile(missing.map((r) => -minToStart(r)), 0.1)), p50: r1(quantile(missing.map((r) => -minToStart(r)), 0.5)), p90: r1(quantile(missing.map((r) => -minToStart(r)), 0.9)) }, windowMin: win },
    ended: { flagged: ended.length, allMarketsResolved: ended.filter((r) => r.allMarketsResolved === true).length, anyMarketOpen: ended.filter((r) => r.allMarketsResolved === false).length, resolvedButNotFlagged: resolved.filter((r) => r.ended !== true).length, resolvedEvents: resolved.length, liveAndEnded: rows.filter((r) => r.live === true && r.ended === true).length, liveAndAllResolved: live.filter((r) => r.allMarketsResolved === true).length },
  };
}

/** Fetch the events the venue itself flags `live` and `ended` (capped), so the report has flagged events even when the open sample holds none. */
export async function fetchUsFlagged(http: PoliteHttp, cfg: UsConfig, o: { max?: number } = {}): Promise<{ live: RawMarket[]; ended: RawMarket[]; notes: { live: FetchNotes; ended: FetchNotes } }> {
  const max = o.max ?? 600;
  const live = await fetchUs(http, cfg, { closed: false, max, query: "live=true", path: cfg.eventsPath, slim: true, maxPages: 8 });
  const ended = await fetchUs(http, cfg, { closed: true, max, query: "ended=true", path: cfg.eventsPath, slim: true, maxPages: 8 });
  return { live: live.markets, ended: ended.markets, notes: { live: live.notes, ended: ended.notes } };
}

// ───────────────────────────────────────────── schedule sources ─────────────────────────────────────────────

export interface ScheduleRow { group: string; sport: string; /** the schedule source's start (an event-level start from the sports / league events endpoint, or Kalshi's milestone / strike date) */ source: unknown; /** the other field: `gameStartTime` (US) or the event strike date (Kalshi) */ other: unknown }
export interface ScheduleSummary {
  sport: string; events: number; sourceWithTimeOfDay: number; otherWithTimeOfDay: number; both: number; agreeWithin1Min: number; agreeWithin15Min: number; agreeShare: number | null;
  absDiffMin: { p50: number | null; p90: number | null; max: number | null };
  /** How many source values are an exact placeholder shape (date-only, midnight, noon, end-of-day, Eastern midnight): no time of day. */
  sourcePlaceholders: number;
}
const inst = (v: unknown): number | null => { const p = parseTimestamp(v); return p.kind === "datetime" || p.kind === "epoch" ? p.ms : null; };
/** Does an event-level schedule source carry a time of day, and does it agree with the other start field, per sport? (pure; one row per distinct event) */
export function scheduleCompare(rows: ScheduleRow[]): ScheduleSummary[] {
  const by = new Map<string, ScheduleRow[]>(); for (const r of rows) { const a = by.get(r.sport); if (a) a.push(r); else by.set(r.sport, [r]); }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([sport, rs]) => {
    const withTod = (v: unknown) => inst(v) !== null && placeholderKind(v) === null; const both = rs.filter((r) => inst(r.source) !== null && inst(r.other) !== null);
    const d = both.map((r) => Math.abs(inst(r.source)! - inst(r.other)!) / 60_000);
    return { sport, events: rs.length, sourceWithTimeOfDay: rs.filter((r) => withTod(r.source)).length, otherWithTimeOfDay: rs.filter((r) => withTod(r.other)).length, both: both.length, agreeWithin1Min: d.filter((x) => x <= 1).length, agreeWithin15Min: d.filter((x) => x <= 15).length, agreeShare: both.length ? Math.round((d.filter((x) => x <= 1).length / both.length) * 1000) / 1000 : null, absDiffMin: { p50: r1(quantile(d, 0.5)), p90: r1(quantile(d, 0.9)), max: d.length ? r1(Math.max(...d)) : null }, sourcePlaceholders: rs.filter((r) => placeholderKind(r.source) !== null).length };
  });
}
/** Schedule rows from exploded US markets: the event-level start (`event.gameStartTime`, `event.startTime`, `event.eventStartTime`; never `startDate`, a listing time) against the market's `gameStartTime`. One row per distinct event. */
export function usScheduleRows(markets: RawMarket[], sportOf: (m: RawMarket) => string): ScheduleRow[] {
  const seen = new Set<string>(); const out: ScheduleRow[] = [];
  for (const m of markets) { const g = usGroupOf(m); if (seen.has(g)) continue; seen.add(g); const e = (m.event && typeof m.event === "object" ? (m.event as Record<string, unknown>) : {}); out.push({ group: g, sport: sportOf(m), source: e.gameStartTime ?? e.startTime ?? e.eventStartTime ?? null, other: m.gameStartTime ?? null }); }
  return out;
}
