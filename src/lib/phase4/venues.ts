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

export const INTERNATIONAL = "polymarket_intl";
export const US_EXCHANGE = "polymarket_us";

export interface UsConfig {
  base: string; marketsPath: string;
  /** Query-string fragments (without `?`). UNVERIFIED defaults; override from the documentation. */
  openQuery: string; closedQuery: string;
  limitParam: string; pageParam: string | null; pageSize: number;
}
export const US_DEFAULTS: UsConfig = { base: "https://gateway.polymarket.us", marketsPath: "/v1/markets", openQuery: "active=true&closed=false", closedQuery: "closed=true", limitParam: "limit", pageParam: "offset", pageSize: 100 };
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
export async function fetchUs(http: PoliteHttp, cfg: UsConfig, o: { closed: boolean; max: number; maxPages?: number }): Promise<Fetched> {
  const endpoint = `${cfg.base}${cfg.marketsPath}`; const notes: FetchNotes = { endpoint, pages: 0, records: 0, cursorKey: null, filterHonoured: null, stoppedBecause: "", errors: [] };
  const out: RawMarket[] = []; const seen = new Set<string>(); let offset = 0; let cursor: string | null = null;
  for (let page = 0; page < (o.maxPages ?? 40) && out.length < o.max; page++) {
    let url = `${endpoint}?${o.closed ? cfg.closedQuery : cfg.openQuery}&${cfg.limitParam}=${cfg.pageSize}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`; else if (cfg.pageParam && page > 0) url += `&${cfg.pageParam}=${offset}`;
    const r = await http.getJson(url); notes.pages++;
    if (!r.ok) { notes.errors.push(`${r.kind}${r.status ? ` ${r.status}` : ""}: ${r.message}`); notes.stoppedBecause = `error (${r.kind})`; break; }
    const { records } = extractRecords(r.json); const c = cursorOf(r.json); if (c) notes.cursorKey = c.key;
    let fresh = 0; for (const m of records) { const id = usIdOf(m); if (id && seen.has(id)) continue; if (id) seen.add(id); out.push(m); fresh++; if (out.length >= o.max) break; }
    if (page === 0 && records.length) notes.filterHonoured = records.every((m) => usIsResolved(m) === o.closed);
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
  take(m.tags); const ev = Array.isArray(m.events) ? (m.events[0] as RawMarket | undefined) : (m.event as RawMarket | undefined); take(ev?.tags); take((ev as RawMarket | undefined)?.categories); return out;
}
export const gammaIdOf = (m: RawMarket) => String(m.conditionId ?? m.condition_id ?? m.id ?? "");
export const gammaIsResolved = (m: RawMarket) => m.closed === true;
export const gammaTitleOf = (m: RawMarket) => first(m, "question", "title");
export const gammaGroupOf = (m: RawMarket) => { const ev = Array.isArray(m.events) ? (m.events[0] as RawMarket | undefined) : undefined; return String(ev?.id ?? ev?.slug ?? m.slug ?? gammaIdOf(m)); };
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
export const usGroupOf = (m: RawMarket) => { const ev = (m.event ?? m.eventId ?? m.event_id) as unknown; if (ev && typeof ev === "object") return String((ev as RawMarket).id ?? (ev as RawMarket).slug ?? usIdOf(m)); return String(ev ?? m.eventSlug ?? m.slug ?? usIdOf(m)); };
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
