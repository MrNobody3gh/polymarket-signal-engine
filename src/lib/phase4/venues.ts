/**
 * Phase 4.0 — public, unauthenticated read adapters for the two venues the S1 audits look at. Read-only: GET only,
 * through PoliteHttp. NO order, key, wallet or account endpoint is referenced anywhere in this file.
 *
 * What is established and what is not:
 *  - International Polymarket (signal source): `GAMMA_API` + `/markets/keyset` is already used by this repository
 *    (src/lib/polymarket/client.ts, markets.ts), with the parameters `limit`, `closed`, `order`, `ascending`,
 *    `after_cursor`, `condition_ids`, `slug`. The response's cursor field name, the `order` values and the full set of
 *    time fields are NOT established here: the S1a script discovers and records them.
 *  - US-regulated Polymarket exchange (candidate execution venue): the defaults below are RECALLED, not verified. The
 *    authoring environment could not reach docs.polymarket.us (network policy 403), so endpoint paths, query parameters
 *    and field names are unconfirmed. They are configurable (`--us-*` options) and the first run must check them against
 *    https://docs.polymarket.us before any result is trusted. A wrong default fails with NOT_FOUND / BAD_REQUEST and is
 *    reported; it cannot do harm (GET of public data only).
 */
import { GAMMA_API } from "../polymarket/client";
import type { PoliteHttp } from "./http";
import type { RawMarket } from "./audit";
import { normalizeTitle } from "./mapping";
import { categorize, stratum } from "./categorize";

export const INTERNATIONAL = "polymarket_intl";
export const US_EXCHANGE = "polymarket_us";

export interface UsConfig {
  base: string; marketsPath: string;
  /** Query-string fragments (without `?`). UNVERIFIED defaults; override from the documentation. */
  openQuery: string; closedQuery: string;
  /** Query for archived markets (diagnostic runs only). UNVERIFIED default; null skips it. */
  archivedQuery: string | null;
  limitParam: string; pageParam: string | null; pageSize: number;
}
/** Memory bound for the diagnostic (found on the first production run: the uncapped full US listing exhausted a ~500 MB heap after about 12 minutes of paging). */
export const NORMAL_CAP = 6000;
export const DIAGNOSE_DEFAULT_CAP = 40_000;
export const ARCHIVED_CAP = 5_000;
export function usFetchPlan(o: { diagnose?: boolean; maxUsMarkets?: number }): { cap: number; half: number; archivedMax: number; slim: boolean } {
  const cap = o.maxUsMarkets ?? (o.diagnose ? DIAGNOSE_DEFAULT_CAP : NORMAL_CAP); const half = Math.ceil(cap / 2);
  return { cap, half, archivedMax: Math.min(half, ARCHIVED_CAP), slim: !!o.diagnose };
}
/** Keeps what the audits and the matcher read (short strings, numbers, booleans, nested objects and arrays) and drops what dominates memory: free text beyond 200 characters, arrays beyond 30 items, nested `markets` lists, depth beyond 6. */
export function slimRaw(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) : v;
  if (v === null || typeof v !== "object") return v;
  if (depth >= 6) return null;
  if (Array.isArray(v)) return v.slice(0, 30).map((x) => slimRaw(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (depth > 0 && k === "markets") continue; out[k] = slimRaw(x, depth + 1); }
  return out;
}
export const US_DEFAULTS: UsConfig = { base: "https://gateway.polymarket.us", marketsPath: "/v1/markets", openQuery: "active=true&closed=false", closedQuery: "closed=true", archivedQuery: "archived=true", limitParam: "limit", pageParam: "offset", pageSize: 100 };
/** Where the owner should confirm every US default. */
export const US_DOCS = ["https://docs.polymarket.us"];
export const INTL_DOCS = ["https://docs.polymarket.com"];

export interface FetchNotes { endpoint: string; pages: number; records: number; cursorKey: string | null; filterHonoured: boolean | null; stoppedBecause: string; errors: string[] }
export interface Fetched { markets: RawMarket[]; notes: FetchNotes }

/** Records inside a JSON response: the root array, or the first array under a conventional key; events that carry a `markets` array are exploded (the event is kept under `event`). */
export function extractRecords(json: unknown): { records: RawMarket[]; path: string } {
  const pick = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);
  let arr = pick(json), path = "$";
  if (!arr && json && typeof json === "object") { for (const k of ["markets", "data", "events", "results", "items"]) { const a = pick((json as Record<string, unknown>)[k]); if (a) { arr = a; path = `$.${k}`; break; } } }
  const records: RawMarket[] = [];
  for (const r of arr ?? []) {
    if (!r || typeof r !== "object") continue; const o = r as RawMarket;
    if (Array.isArray(o.markets) && o.markets.length && o.markets.every((m) => m && typeof m === "object")) { const { markets, ...event } = o; for (const m of markets as RawMarket[]) records.push({ ...m, event }); }
    else records.push(o);
  }
  return { records, path };
}
const cursorOf = (json: unknown): { key: string; value: string } | null => {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) if (/cursor/i.test(k) && typeof v === "string" && v) return { key: k, value: v };
  return null;
};

/** Page the international Gamma `/markets/keyset` for open or closed markets. Stops at `max` markets, `maxPages` pages, a missing cursor, or an error. */
export async function fetchGamma(http: PoliteHttp, o: { closed: boolean; max: number; maxPages?: number; pageSize?: number; order?: { order: string; ascending: boolean } | null }): Promise<Fetched> {
  const notes: FetchNotes = { endpoint: `${GAMMA_API}/markets/keyset`, pages: 0, records: 0, cursorKey: null, filterHonoured: null, stoppedBecause: "", errors: [] };
  const out: RawMarket[] = []; const seen = new Set<string>(); let cursor: string | null = null; const size = o.pageSize ?? 100;
  for (let page = 0; page < (o.maxPages ?? 40) && out.length < o.max; page++) {
    const qs = new URLSearchParams({ limit: String(size), closed: String(o.closed) }); if (o.order) { qs.set("order", o.order.order); qs.set("ascending", String(o.order.ascending)); } if (cursor) qs.set("after_cursor", cursor);
    const r = await http.getJson(`${GAMMA_API}/markets/keyset?${qs}`); notes.pages++;
    if (!r.ok) { notes.errors.push(`${r.kind}${r.status ? ` ${r.status}` : ""}: ${r.message}`); notes.stoppedBecause = `error (${r.kind})`; break; }
    const { records } = extractRecords(r.json); const c = cursorOf(r.json); if (c) notes.cursorKey = c.key;
    let fresh = 0; for (const m of records) { const id = String(m.conditionId ?? m.id ?? ""); if (id && seen.has(id)) continue; if (id) seen.add(id); out.push(m); fresh++; if (out.length >= o.max) break; }
    if (page === 0 && records.length) notes.filterHonoured = records.every((m) => m.closed === o.closed);
    if (!records.length) { notes.stoppedBecause = "empty page"; break; }
    if (!c) { notes.stoppedBecause = "no cursor in the response"; break; }
    if (!fresh) { notes.stoppedBecause = "page repeated"; break; }
    cursor = c.value;
  }
  if (!notes.stoppedBecause) notes.stoppedBecause = out.length >= o.max ? "sample size reached" : "page limit reached";
  notes.records = out.length; return { markets: out, notes };
}

/** Page the US venue's markets listing with the configured (unverified) parameters. */
export async function fetchUs(http: PoliteHttp, cfg: UsConfig, o: { closed: boolean; max: number; maxPages?: number; /** slim each market on arrival (diagnostic mode: bounds memory) */ slim?: boolean; /** a query string that replaces the configured open/closed one (targeted fetches); `closed` is then only used to judge whether the venue honoured a filter */ query?: string; /** stop as soon as this returns true for the markets fetched so far (a per-sport quota) */ enough?: (markets: RawMarket[]) => boolean }): Promise<Fetched> {
  const endpoint = `${cfg.base}${cfg.marketsPath}`; const notes: FetchNotes = { endpoint, pages: 0, records: 0, cursorKey: null, filterHonoured: null, stoppedBecause: "", errors: [] };
  const out: RawMarket[] = []; const seen = new Set<string>(); let offset = 0; let cursor: string | null = null;
  // a finite cap pages as far as it needs (never fewer than the old 40); only an explicit maxPages or an infinite cap differ
  const maxPages = o.maxPages ?? (o.max === Infinity ? 5000 : Math.max(40, Math.ceil(o.max / cfg.pageSize) + 2));
  for (let page = 0; page < maxPages && out.length < o.max; page++) {
    let url = `${endpoint}?${o.query ?? (o.closed ? cfg.closedQuery : cfg.openQuery)}&${cfg.limitParam}=${cfg.pageSize}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`; else if (cfg.pageParam && page > 0) url += `&${cfg.pageParam}=${offset}`;
    const r = await http.getJson(url); notes.pages++;
    if (!r.ok) { notes.errors.push(`${r.kind}${r.status ? ` ${r.status}` : ""}: ${r.message}`); notes.stoppedBecause = `error (${r.kind})`; break; }
    const { records } = extractRecords(r.json); const c = cursorOf(r.json); if (c) notes.cursorKey = c.key;
    let fresh = 0; for (const m of records) { const id = usIdOf(m); if (id && seen.has(id)) continue; if (id) seen.add(id); out.push(o.slim ? (slimRaw(m) as RawMarket) : m); fresh++; if (out.length >= o.max) break; }
    if (page === 0 && records.length && o.query === undefined) notes.filterHonoured = records.every((m) => usIsResolved(m) === o.closed);
    if (o.enough?.(out)) { notes.stoppedBecause = "quota reached"; break; }
    if (!records.length) { notes.stoppedBecause = "empty page"; break; }
    if (!fresh) { notes.stoppedBecause = "page repeated (paging parameter ignored?)"; break; }
    if (c) cursor = c.value; else if (cfg.pageParam) offset += records.length; else { notes.stoppedBecause = "no paging mechanism"; break; }
  }
  if (!notes.stoppedBecause) notes.stoppedBecause = out.length >= o.max ? "sample size reached" : "page limit reached";
  notes.records = out.length; return { markets: out, notes };
}

// ───────────────────────────────────────── field accessors (venue-specific, supplied to toAuditMarkets) ──────

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const first = (m: RawMarket, ...keys: string[]): string | null => { for (const k of keys) { const v = str(m[k]); if (v) return v; } return null; };
/** Collect label strings from tag arrays on a market or its first event (`tags[].label|slug|name` or plain strings). */
export function tagsOf(m: RawMarket): string[] {
  const out: string[] = []; const take = (a: unknown) => { if (Array.isArray(a)) for (const t of a) { if (typeof t === "string") out.push(t); else if (t && typeof t === "object") for (const k of ["label", "slug", "name"]) { const v = str((t as RawMarket)[k]); if (v) out.push(v); } } };
  take(m.tags); take(m.categories); { const c = str(m.category); if (c) out.push(c); } const ev = Array.isArray(m.events) ? (m.events[0] as RawMarket | undefined) : (m.event as RawMarket | undefined); take(ev?.tags); take((ev as RawMarket | undefined)?.categories); return out;
}
export const gammaIdOf = (m: RawMarket) => String(m.conditionId ?? m.condition_id ?? m.id ?? "");
export const gammaIsResolved = (m: RawMarket) => m.closed === true;
export const gammaTitleOf = (m: RawMarket) => first(m, "question", "title");
/** The event a market belongs to: the venue's event id or slug, else a key from the normalised title and the end date (markets of one event share both). Never the market's own slug or id. */
export const eventFallbackKey = (title: string | null, date: unknown, id: string): string => { const t = normalizeTitle(title); return t ? `title:${t}|${typeof date === "string" ? date.slice(0, 10) : ""}` : `market:${id}`; };
export const gammaGroupOf = (m: RawMarket) => { const ev = Array.isArray(m.events) ? (m.events[0] as RawMarket | undefined) : undefined; const id = ev?.id ?? ev?.slug; return id !== undefined && id !== null && id !== "" ? String(id) : eventFallbackKey(gammaTitleOf(m), m.endDateIso ?? m.endDate, gammaIdOf(m)); };
/** CLOB token ids of a Gamma market (`clobTokenIds` is a JSON-encoded string or an array). */
export const gammaTokenIds = (m: RawMarket): string[] => { const raw = m.clobTokenIds; const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : []; return Array.isArray(arr) ? arr.map(String) : []; };
export const gammaOutcomes = (m: RawMarket): string[] => { const raw = m.outcomes; const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : []; return Array.isArray(arr) ? arr.map(String) : []; };

export const usIdOf = (m: RawMarket) => String(m.id ?? m.marketId ?? m.market_id ?? m.slug ?? "");
export const usTitleOf = (m: RawMarket) => first(m, "question", "title", "name");
/** UNVERIFIED heuristic over conventional status fields; the audit records which one decided. */
export function usIsResolved(m: RawMarket): boolean {
  if (m.closed === true || m.resolved === true || m.isResolved === true) return true;
  for (const k of ["status", "state", "marketState", "market_state"]) { const v = str(m[k]); if (v && /resolv|settled|closed|final|expired|ended/i.test(v)) return true; }
  return false;
}
export const usGroupOf = (m: RawMarket) => {
  const ev = (m.event ?? m.eventId ?? m.event_id) as unknown;
  if (ev && typeof ev === "object") { const id = (ev as RawMarket).id ?? (ev as RawMarket).slug; if (id !== undefined && id !== null && id !== "") return String(id); }
  else if (ev !== undefined && ev !== null && ev !== "") return String(ev);
  if (typeof m.eventSlug === "string" && m.eventSlug) return m.eventSlug;
  return eventFallbackKey(usTitleOf(m), m.endDate ?? m.endDateIso ?? m.gameStartTime, usIdOf(m));
};
export const usOutcomes = (m: RawMarket): string[] => gammaOutcomes(m);

/** Keep an object's shape for a fixture but drop bulk and anything that is not needed to test time handling: long text is truncated, images/descriptions removed. */
export function sanitizeSample(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.slice(0, 6).map((x) => sanitizeSample(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (/image|icon|description|resolutionSource|rules|banner|avatar|email|secret|token(?!s$)|apikey|authorization/i.test(k) && !/tokenids?$/i.test(k)) continue; out[k] = depth > 4 ? null : sanitizeSample(x, depth + 1); }
    return out;
  }
  if (typeof v === "string") return v.length > 160 ? v.slice(0, 157) + "..." : v;
  return v;
}


// ───────────────────────────────────────── listing totals and targeted fetches (4.0b) ────────────────────────

/** The venue's own status label for a market: `archived`, `closed`/`resolved`, `open`, or the raw status string. UNVERIFIED heuristic over conventional fields. */
export function usStatusLabel(m: RawMarket): string {
  if (m.archived === true) return "archived";
  for (const k of ["status", "state", "marketState", "market_state"]) { const v = str(m[k]); if (v) return v.toLowerCase(); }
  if (m.closed === true || m.resolved === true || m.isResolved === true) return "closed";
  if (m.closed === false || m.active === true) return "open";
  return "unknown";
}
export interface ListingTotals { markets: number; byStatus: Record<string, number>; byStratum: Record<string, number>; byVenueCategory: Record<string, number>; distinctEvents: number }
/** Totals of a full listing: by the venue's status, by our category heuristic, by the venue's own category/tag labels. */
export function listingTotals(markets: RawMarket[]): ListingTotals {
  const byStatus: Record<string, number> = {}, byStratum: Record<string, number> = {}, byCat: Record<string, number> = {}; const events = new Set<string>();
  for (const m of markets) {
    const st = usStatusLabel(m); byStatus[st] = (byStatus[st] ?? 0) + 1;
    const tags = tagsOf(m); const k = stratum(categorize({ title: usTitleOf(m), slug: typeof m.slug === "string" ? m.slug : null, tags })); byStratum[k] = (byStratum[k] ?? 0) + 1;
    for (const t of new Set(tags.map((x) => x.toLowerCase()))) byCat[t] = (byCat[t] ?? 0) + 1; events.add(usGroupOf(m));
  }
  const top = (o: Record<string, number>, n = 60) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n));
  return { markets: markets.length, byStatus: top(byStatus), byStratum: top(byStratum), byVenueCategory: top(byCat), distinctEvents: events.size };
}

export interface TargetedQuery { sport: string; query: string }
/**
 * Per-sport queries for the US listing. The brief names the filters `sportsMarketTypes` (MONEYLINE, SPREAD, TOTAL, PROP) and `categories`;
 * their SYNTAX and the category values are NOT verified here (docs.polymarket.us was unreachable), so these defaults are guesses to be
 * replaced from the documentation with `--us-targeted "sport=query|sport=query"`. A wrong query returns an error or an empty page, is
 * reported, and the stratum is then reported as unable to reach its quota.
 */
export function defaultTargetedQueries(): TargetedQuery[] {
  return ["football", "basketball", "baseball", "hockey", "soccer", "tennis", "combat"].map((sport) => ({ sport, query: `categories=${sport}&sportsMarketTypes=MONEYLINE&sportsMarketTypes=SPREAD&sportsMarketTypes=TOTAL&sportsMarketTypes=PROP&active=true` }));
}
export function parseTargeted(spec: string): TargetedQuery[] { return spec.split("|").map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf("="); return { sport: x.slice(0, i), query: x.slice(i + 1) }; }).filter((q) => q.sport && q.query); }
export interface TargetedResult { sport: string; query: string; markets: RawMarket[]; notes: FetchNotes; reachedQuota: boolean; events: number }
/** Page one targeted query until ≥ minMarkets markets from ≥ minEvents distinct events, or the listing ends. */
export async function fetchUsTargeted(http: PoliteHttp, cfg: UsConfig, q: TargetedQuery, o: { minMarkets?: number; minEvents?: number; maxPages?: number } = {}): Promise<TargetedResult> {
  const minM = o.minMarkets ?? 100, minE = o.minEvents ?? 30; const enough = (ms: RawMarket[]) => ms.length >= minM && new Set(ms.map(usGroupOf)).size >= minE;
  const r = await fetchUs(http, cfg, { closed: false, max: Infinity, maxPages: o.maxPages ?? 40, query: q.query, enough });
  return { sport: q.sport, query: q.query, markets: r.markets, notes: r.notes, reachedQuota: enough(r.markets), events: new Set(r.markets.map(usGroupOf)).size };
}
