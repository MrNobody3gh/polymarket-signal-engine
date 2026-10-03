/**
 * Phase 4.0c — Kalshi (CFTC-regulated; candidate execution venue 2): a public, unauthenticated, READ-ONLY adapter. GET only, through PoliteHttp.
 * No order, portfolio, balance, key or account endpoint is referenced anywhere in this file, and no credential header exists in the client.
 *
 * WHAT IS ESTABLISHED AND WHAT IS NOT. The authoring environment could not reach any venue host or documentation page (network policy 403,
 * the documentation fetch tool was blocked too), so everything below is taken from SEARCH-ENGINE SUMMARIES of Kalshi's published documentation
 * and is marked UNVERIFIED in docs/phase4/KALSHI_API.md. The first production run must confirm it; every default is overridable (`--kalshi-*`):
 *  - base URL: https://api.elections.kalshi.com/trade-api/v2 (the production host named in the docs' examples) — one summary named
 *    https://external-api.kalshi.com/trade-api/v2 instead; `resolveKalshiBase` tries them in order and uses the first that answers;
 *  - market data needs no authentication (summary of the "Quick Start: Market Data" page);
 *  - `GET /events` (filters: status = unopened | open | closed | settled, series_ticker, with_nested_markets, limit ≤ 200, cursor) returns events
 *    with a `category` and, with nested markets, the markets; `GET /markets` (status, series_ticker, limit ≤ 1000, cursor) the markets alone;
 *  - cursor pagination: the response carries `cursor`, empty when there is no next page; pass it back as `cursor`;
 *  - market fields: ticker, event_ticker, title, subtitle, yes_sub_title, no_sub_title, status (initialized | inactive | active | closed |
 *    determined | disputed | amended | finalized), created_time, updated_time, open_time, close_time, expected_expiration_time ("when the outcome
 *    is expected to be known"; for a game typically a few hours after the scheduled start), latest_expiration_time, the deprecated expiration_time,
 *    and for events `category`, `series_ticker`, `strike_date`.
 * Rate limits: the summaries state 20 read requests/second on the Basic tier (UNVERIFIED); this client keeps to ≤ 2/second regardless.
 */
import type { PoliteHttp } from "./http";
import { flatten, type RawMarket } from "./audit";
import { extractRecords, slimRaw, type FetchNotes, type Fetched } from "./venues";
import { KALSHI } from "./timestamps";
export { KALSHI };

export interface KalshiConfig { bases: string[]; eventsPath: string; pageSize: number }
export const KALSHI_DEFAULTS: KalshiConfig = { bases: ["https://api.elections.kalshi.com/trade-api/v2", "https://external-api.kalshi.com/trade-api/v2"], eventsPath: "/events", pageSize: 200 };
export const KALSHI_DOCS = ["https://docs.kalshi.com/getting_started/quick_start_market_data", "https://docs.kalshi.com/api-reference/events/get-events", "https://docs.kalshi.com/api-reference/market/get-markets", "https://docs.kalshi.com/getting_started/pagination", "https://docs.kalshi.com/getting_started/rate_limits", "https://docs.kalshi.com/getting_started/market_lifecycle"];
export const KALSHI_DEFAULT_CAP = 40_000;

export type KalshiBucket = "open" | "unopened" | "closed" | "settled" | "unknown";
/** The listing buckets fetched, with each one's share of the cap (the open listing is what matters for trading; settled markets give the resolution-ordering evidence). */
export function kalshiFetchPlan(cap: number): { open: number; closed: number; settled: number } {
  const c = Math.max(3, Math.floor(cap)); const open = Math.ceil(c * 0.5), closed = Math.floor(c * 0.1); return { open, closed, settled: Math.max(1, c - open - closed) };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
/** The market's own status, bucketed. Open = `active`; unopened = created but not yet open for trading; closed = trading ended, outcome not final; settled = the outcome is determined or final. */
export function kalshiBucket(m: RawMarket): KalshiBucket {
  const s = (str(m.status) ?? "").toLowerCase();
  if (s === "active" || s === "open") return "open";
  if (s === "initialized" || s === "inactive" || s === "unopened") return "unopened";
  if (s === "closed") return "closed";
  if (s === "determined" || s === "disputed" || s === "amended" || s === "finalized" || s === "settled") return "settled";
  return "unknown";
}
/** No longer tradable: closed or settled. (An unopened market is not resolved; it is just not open yet.) */
export const kalshiIsResolved = (m: RawMarket): boolean => { const b = kalshiBucket(m); return b === "closed" || b === "settled"; };
export const kalshiIdOf = (m: RawMarket): string => String(m.ticker ?? m.id ?? "");
const eventOf = (m: RawMarket): RawMarket | null => (m.event && typeof m.event === "object" && !Array.isArray(m.event) ? (m.event as RawMarket) : null);
/** The market title; for a single-outcome market of a multi-outcome event Kalshi's `title` is often just the event's, with the outcome in `yes_sub_title`. */
export const kalshiTitleOf = (m: RawMarket): string | null => str(m.title) ?? str(eventOf(m)?.title) ?? str(m.yes_sub_title);
/** The event the market belongs to (markets of one event share its times): the event ticker, else a key from the market ticker's first segment. */
export const kalshiGroupOf = (m: RawMarket): string => { const e = str(m.event_ticker) ?? str(eventOf(m)?.event_ticker); if (e) return e; const t = kalshiIdOf(m); return t ? `ticker:${t.split("-").slice(0, 2).join("-")}` : "ticker:"; };
/** Outcome labels a signal's outcome may match: Yes/No plus the market's own side labels (e.g. the team named in `yes_sub_title`). A label that equals another is kept once. */
export const kalshiOutcomes = (m: RawMarket): string[] => [...new Set(["Yes", "No", str(m.yes_sub_title), str(m.no_sub_title)].filter((x): x is string => !!x))];
/** The venue's own category labels: the event's `category` (the market itself has none in the documented schema). */
export function kalshiTags(m: RawMarket): string[] { const e = eventOf(m); return [str(e?.category), str(m.category), str(e?.series_category)].filter((x): x is string => !!x); }

/** Kalshi tickers are `KX<SERIES><…>` with no separators ("KXNBAGAME-26OCT05LALBOS"); our categoriser reads sport words from a slug, so the series is split into `<sport>-<rest>`. */
const KX_PREFIXES = ["wnba", "ncaab", "ncaaf", "nba", "nfl", "mlb", "nhl", "ufc", "atp", "wta", "epl", "ucl", "uel", "mls", "laliga", "bundesliga", "seriea", "ligue1", "f1", "pga", "lol", "cs2", "csgo", "dota2", "valorant", "cdl", "btc", "eth", "sol", "xrp", "doge"];
export function kalshiSlug(m: RawMarket): string | null {
  const e = eventOf(m); const series = (str(e?.series_ticker) ?? str(m.series_ticker) ?? (str(m.event_ticker) ?? str(e?.event_ticker) ?? kalshiIdOf(m)).split("-")[0] ?? "").toLowerCase(); if (!series) return null;
  const bare = series.replace(/^kx/, ""); const p = KX_PREFIXES.find((x) => bare.startsWith(x));
  return p ? `${p}-${bare.slice(p.length)}`.replace(/-$/, "") : bare;
}

export interface KalshiResolved { base: string | null; tried: { base: string; outcome: string }[] }
/** Pick the first base URL that answers `GET /events?limit=1`. A refusal (401/403/451) stops the search: no other host is tried for a refused one (and PoliteHttp stops asking that origin). */
export async function resolveKalshiBase(http: PoliteHttp, cfg: KalshiConfig): Promise<KalshiResolved> {
  const tried: KalshiResolved["tried"] = [];
  for (const base of cfg.bases) {
    const r = await http.getJson(`${base}${cfg.eventsPath}?limit=1`);
    if (r.ok) { tried.push({ base, outcome: "ok" }); return { base, tried }; }
    tried.push({ base, outcome: `${r.kind}${r.status ? ` ${r.status}` : ""}` });
    if (r.kind === "BLOCKED" || r.kind === "BLOCKED_SKIPPED") return { base: null, tried };
  }
  return { base: null, tried };
}

const cursorOfJson = (json: unknown): string | null => { if (!json || typeof json !== "object" || Array.isArray(json)) return null; const c = (json as Record<string, unknown>).cursor; return typeof c === "string" && c ? c : null; };

/**
 * Page `GET /events?status=<status>&with_nested_markets=true` and explode the events into markets (each market keeps its event under `event`).
 * Every market is SLIMMED ON ARRIVAL (long text cut, nested lists dropped), so memory is proportional to the cap, not to the size of the responses;
 * the raw page is dropped as soon as it is processed. Stops at `max` markets, `maxPages` pages, an empty cursor, a repeated page, or an error.
 * `seen` lets the three status fetches share one de-duplication set (an event can appear under more than one status).
 */
export async function fetchKalshi(http: PoliteHttp, cfg: KalshiConfig, base: string, o: { status: "open" | "closed" | "settled"; max: number; maxPages?: number; seen?: Set<string>; enough?: (markets: RawMarket[]) => boolean }): Promise<Fetched> {
  const endpoint = `${base}${cfg.eventsPath}`; const notes: FetchNotes = { endpoint, pages: 0, records: 0, cursorKey: null, filterHonoured: null, stoppedBecause: "", errors: [] };
  const out: RawMarket[] = []; const seen = o.seen ?? new Set<string>(); let cursor: string | null = null; const maxPages = o.maxPages ?? Math.max(40, Math.ceil(o.max / 20) + 5);
  for (let page = 0; page < maxPages && out.length < o.max; page++) {
    const qs = new URLSearchParams({ status: o.status, with_nested_markets: "true", limit: String(cfg.pageSize) }); if (cursor) qs.set("cursor", cursor);
    const r = await http.getJson(`${endpoint}?${qs}`); notes.pages++;
    if (!r.ok) { notes.errors.push(`${r.kind}${r.status ? ` ${r.status}` : ""}: ${r.message}`); notes.stoppedBecause = `error (${r.kind})`; break; }
    const { records } = extractRecords(r.json); const next = cursorOfJson(r.json); if (next !== null || (r.json && typeof r.json === "object" && "cursor" in (r.json as object))) notes.cursorKey = "cursor";
    // the status filter is judged by whether the first page holds at least one market of the requested kind (an event may nest markets of other statuses)
    if (page === 0 && records.length) notes.filterHonoured = records.some((m) => (o.status === "open" ? kalshiBucket(m) === "open" : kalshiBucket(m) === o.status || (o.status === "settled" && kalshiBucket(m) === "closed")));
    let fresh = 0, consumed = 0; for (const m of records) { consumed++; const id = kalshiIdOf(m); if (id && seen.has(id)) continue; if (id) seen.add(id); out.push(slimRaw(m) as RawMarket); fresh++; if (out.length >= o.max) break; }
    // the cap was reached while the listing still had more (records left in this page, or a next cursor): a cut-off, whatever the cursor says
    if (out.length >= o.max && (consumed < records.length || next)) { notes.stoppedBecause = "sample size reached"; break; }
    if (o.enough?.(out)) { notes.stoppedBecause = "quota reached"; break; }
    if (!records.length) { notes.stoppedBecause = "empty page"; break; }
    if (!next) { notes.stoppedBecause = "no further cursor (listing ended)"; break; }
    if (!fresh && next === cursor) { notes.stoppedBecause = "page repeated (cursor ignored?)"; break; }
    cursor = next;
  }
  if (!notes.stoppedBecause) notes.stoppedBecause = out.length >= o.max ? "sample size reached" : "page limit reached";
  notes.records = out.length; return { markets: out, notes };
}

export interface KalshiListing { base: string | null; tried: KalshiResolved["tried"]; open: Fetched | null; closed: Fetched | null; settled: Fetched | null; cap: number; plan: ReturnType<typeof kalshiFetchPlan> }
/** The whole bounded listing: open, closed and settled markets, de-duplicated across the three fetches. A refused or unreachable host yields nulls and the exact errors. */
export async function fetchKalshiListing(http: PoliteHttp, cfg: KalshiConfig, cap = KALSHI_DEFAULT_CAP): Promise<KalshiListing> {
  const plan = kalshiFetchPlan(cap); const res = await resolveKalshiBase(http, cfg); const empty = { base: res.base, tried: res.tried, open: null, closed: null, settled: null, cap, plan };
  if (!res.base) return empty;
  const seen = new Set<string>(); const open = await fetchKalshi(http, cfg, res.base, { status: "open", max: plan.open, seen }); const closed = await fetchKalshi(http, cfg, res.base, { status: "closed", max: plan.closed, seen }); const settled = await fetchKalshi(http, cfg, res.base, { status: "settled", max: plan.settled, seen });
  return { ...empty, open, closed, settled };
}
export const kalshiAll = (l: KalshiListing): RawMarket[] => [...(l.open?.markets ?? []), ...(l.closed?.markets ?? []), ...(l.settled?.markets ?? [])];

export interface KalshiCounts { total: number; byBucket: Record<string, number>; byCategory: Record<string, { open: number; closed: number; settled: number; unopened: number; unknown: number; total: number }>; distinctEvents: number }
/** How many open, closed and settled markets the listing holds, by Kalshi's own category. */
export function kalshiCounts(markets: RawMarket[]): KalshiCounts {
  const byBucket: Record<string, number> = {}; const byCategory: KalshiCounts["byCategory"] = {}; const events = new Set<string>();
  for (const m of markets) {
    const b = kalshiBucket(m); byBucket[b] = (byBucket[b] ?? 0) + 1; events.add(kalshiGroupOf(m));
    const cat = kalshiTags(m)[0] ?? "(none)"; const row = (byCategory[cat] ??= { open: 0, closed: 0, settled: 0, unopened: 0, unknown: 0, total: 0 }); row[b]++; row.total++;
  }
  return { total: markets.length, byBucket, byCategory, distinctEvents: events.size };
}

/** The time-like fields a Kalshi market carries in the listing, flattened (for the audit's field table and the tests). */
export const kalshiFlat = (m: RawMarket): Record<string, unknown> => flatten(m);

export interface KalshiMilestone { id: string; category: string | null; type: string | null; title: string | null; startDate: string | null; eventTickers: string[] }
/**
 * Kalshi's schedule source, if it has one: `GET /milestones` (documented in the summaries as real-world events with a `start_date`, a `category`, a `type`
 * and `primary_event_tickers`; UNVERIFIED). Paged by cursor, capped, slim by construction. An error is reported and returns what was read.
 */
export async function fetchKalshiMilestones(http: PoliteHttp, base: string, o: { max?: number; maxPages?: number; minStartIso?: string } = {}): Promise<{ milestones: KalshiMilestone[]; notes: FetchNotes }> {
  const endpoint = `${base}/milestones`; const notes: FetchNotes = { endpoint, pages: 0, records: 0, cursorKey: null, filterHonoured: null, stoppedBecause: "", errors: [] }; const out: KalshiMilestone[] = []; let cursor: string | null = null; const max = o.max ?? 2000;
  for (let page = 0; page < (o.maxPages ?? 10) && out.length < max; page++) {
    const qs = new URLSearchParams({ limit: "200" }); if (o.minStartIso) qs.set("minimum_start_date", o.minStartIso); if (cursor) qs.set("cursor", cursor);
    const r = await http.getJson<{ milestones?: Record<string, unknown>[]; cursor?: string }>(`${endpoint}?${qs}`); notes.pages++;
    if (!r.ok) { notes.errors.push(`${r.kind}${r.status ? ` ${r.status}` : ""}: ${r.message}`); notes.stoppedBecause = `error (${r.kind})`; break; }
    const list = Array.isArray(r.json?.milestones) ? r.json.milestones : []; for (const x of list) out.push({ id: String(x.id ?? x.milestone_id ?? ""), category: str(x.category), type: str(x.type), title: str(x.title), startDate: str(x.start_date), eventTickers: Array.isArray(x.primary_event_tickers) ? (x.primary_event_tickers as unknown[]).map(String) : [] });
    const next = cursorOfJson(r.json); if (!list.length) { notes.stoppedBecause = "empty page"; break; } if (!next) { notes.stoppedBecause = "no further cursor (listing ended)"; break; } cursor = next;
  }
  if (!notes.stoppedBecause) notes.stoppedBecause = out.length >= max ? "sample size reached" : "page limit reached"; notes.records = out.length; return { milestones: out.slice(0, max), notes };
}
/** Schedule rows: the milestone's `start_date` (the candidate schedule source) against the event's `strike_date` carried by the listing; one row per event ticker that appears in both. */
export function kalshiScheduleRows(markets: RawMarket[], milestones: KalshiMilestone[]): { group: string; sport: string; source: unknown; other: unknown }[] {
  const byTicker = new Map<string, KalshiMilestone>(); for (const ms of milestones) for (const t of ms.eventTickers) if (!byTicker.has(t)) byTicker.set(t, ms);
  const seen = new Set<string>(); const out: { group: string; sport: string; source: unknown; other: unknown }[] = [];
  for (const m of markets) { const g = kalshiGroupOf(m); if (seen.has(g)) continue; seen.add(g); const ms = byTicker.get(g); if (!ms) continue; out.push({ group: g, sport: ms.category ?? kalshiTags(m)[0] ?? "(none)", source: ms.startDate, other: eventOf(m)?.strike_date ?? null }); }
  return out;
}
