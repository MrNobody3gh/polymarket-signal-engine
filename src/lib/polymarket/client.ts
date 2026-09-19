/**
 * Thin client for Polymarket's public read APIs (Data API v2 + Gamma).
 *
 * Verified-live quirks this file exists to absorb (2026-09):
 *  1. Unknown query params are SILENTLY ignored with a 200 and default-window
 *     data. Every param is whitelisted here so a typo throws locally instead.
 *  2. /v2/trades defaults to taker_only=true and silently drops maker fills.
 *  3. v2 pages with opaque cursors; `offset` is a 400.
 *  4. REST is CDN-cached max-age=300. It is history, not a live feed.
 *  5. `volume` on the boards is SHARES, not USD.
 *  6. Finite leaderboard windows are mark-inclusive; `all` is realized-only.
 */
import type { LeaderboardRow, RawFill, UserPnlPoint, UserStats } from "./types";

export const DATA_API = "https://data-api.polymarket.com";
export const GAMMA_API = "https://gamma-api.polymarket.com";
export const WS_LIVE = "wss://ws-live-data.polymarket.com";

const ALLOWED: Record<string, Set<string>> = {
  "/v2/leaderboard": new Set(["time_period", "sort_by", "category", "limit", "cursor", "user"]),
  "/v2/user-stats": new Set(["user"]),
  "/v2/user-pnl": new Set(["user", "interval", "fidelity"]),
  "/v2/positions": new Set(["user", "condition", "limit", "cursor", "sort_by", "sort_direction", "status", "include_pnl", "start", "end", "title"]),
  "/v2/trades": new Set(["user", "condition", "event_id", "taker_only", "limit", "cursor", "side", "start", "end", "filter_type", "filter_amount"]),
  "/v2/holders": new Set(["condition", "limit", "include_pnl", "min_balance", "cursor"]),
  "/v2/prices-history": new Set(["token_id", "start", "end", "interval", "bucket_seconds", "as_of", "limit", "cursor"]),
  "/v2/resolutions": new Set(["condition", "event_id", "question_id"]),
  "/v2/status": new Set([]),
  "/markets/keyset": new Set(["limit", "closed", "order", "ascending", "after_cursor", "condition_ids", "slug"]),
};

export class PolymarketError extends Error {
  constructor(msg: string, public status?: number, public retryable = false) { super(msg); this.name = "PolymarketError"; }
}

export interface ClientOptions { fetch?: typeof fetch; retries?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; userAgent?: string }

type Params = Record<string, string | number | boolean | null | undefined>;

export class PolymarketClient {
  private f: typeof fetch; private retries: number; private timeoutMs: number; private sleep: (ms: number) => Promise<void>; private ua: string;
  constructor(o: ClientOptions = {}) {
    this.f = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.retries = o.retries ?? 4; this.timeoutMs = o.timeoutMs ?? 45_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ua = o.userAgent ?? "polymarket-signal-engine/1.0 (read-only research)";
  }

  buildUrl(base: string, path: string, params: Params = {}): string {
    const allowed = ALLOWED[path];
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined) continue;
      if (allowed && !allowed.has(k)) throw new PolymarketError(`${path}: unknown param "${k}" — Polymarket would ignore it silently. Allowed: ${[...allowed].join(", ")}`);
      clean[k] = typeof v === "boolean" ? (v ? "true" : "false") : String(v);
    }
    const qs = new URLSearchParams(clean).toString();
    return `${base}${path}${qs ? `?${qs}` : ""}`;
  }

  async get<T = unknown>(base: string, path: string, params: Params = {}): Promise<T> {
    const url = this.buildUrl(base, path, params);
    let last: unknown;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
        const res = await this.f(url, { headers: { Accept: "application/json", "User-Agent": this.ua }, signal: ctrl.signal });
        clearTimeout(t);
        if (res.status === 429 || res.status === 503) {
          const ra = Number(res.headers.get("retry-after") ?? 0);
          last = new PolymarketError(`${res.status} on ${path}`, res.status, true);
          await this.sleep(ra > 0 ? ra * 1000 : 1500 * 2 ** attempt); continue;
        }
        if (!res.ok) {
          let body = ""; try { body = await res.text(); } catch { /* ignore */ }
          throw new PolymarketError(`HTTP ${res.status} on ${path}: ${body.slice(0, 200)}`, res.status, res.status >= 500);
        }
        return (await res.json()) as T;
      } catch (e) {
        last = e;
        if (e instanceof PolymarketError && !e.retryable) throw e;
        if (attempt === this.retries - 1) break;
        await this.sleep(1500 * 2 ** attempt);
      }
    }
    throw last instanceof Error ? last : new PolymarketError(`GET ${url} failed`);
  }

  /** Walk a v2 cursor-paged endpoint. Re-sends identical filters on every page
   *  (the feed cursors only carry the seek anchor). */
  async *paginate<T = Record<string, unknown>>(path: string, params: Params, opts: { cap?: number; page?: number } = {}): AsyncGenerator<T> {
    const p: Params = { ...params, limit: opts.page ?? 500 };
    let seen = 0; let guard = 0;
    for (;;) {
      if (++guard > 5000) throw new PolymarketError(`${path}: cursor did not terminate`);
      const body = await this.get<{ data?: T[] | null; pagination?: { next_cursor?: string | null } }>(DATA_API, path, p);
      const rows = body.data ?? [];
      for (const r of rows) { yield r; if (opts.cap && ++seen >= opts.cap) return; }
      const cur = body.pagination?.next_cursor;
      if (!cur || rows.length === 0) return;
      p.cursor = cur;
    }
  }

  // ---------------------------------------------------------------- boards
  async leaderboard(o: { timePeriod?: "day" | "week" | "month" | "all"; sortBy?: "PNL" | "VOLUME"; category?: string; limit?: number } = {}): Promise<LeaderboardRow[]> {
    const out: LeaderboardRow[] = [];
    for await (const r of this.paginate<LeaderboardRow>("/v2/leaderboard", { time_period: o.timePeriod ?? "month", sort_by: o.sortBy ?? "PNL", category: o.category }, { cap: o.limit ?? 100, page: Math.min(o.limit ?? 100, 1000) })) out.push(r);
    return out;
  }

  // ---------------------------------------------------------------- wallet
  async userStats(wallet: string): Promise<UserStats | null> {
    const b = await this.get<{ data: UserStats | null }>(DATA_API, "/v2/user-stats", { user: wallet }); return b.data;
  }
  /** Daily equity curve (cumulative). Always fidelity=1d — 1h is ~10MB/wallet. */
  async userPnl(wallet: string, interval: "max" | "all" | "1m" | "1w" | "1d" = "max"): Promise<UserPnlPoint[]> {
    const b = await this.get<{ data?: { points?: UserPnlPoint[] } }>(DATA_API, "/v2/user-pnl", { user: wallet, interval, fidelity: "1d" }); return b.data?.points ?? [];
  }
  async userTrades(wallet: string, o: { since?: number; cap?: number } = {}): Promise<RawFill[]> {
    const out: RawFill[] = [];
    for await (const r of this.paginate<RawFill>("/v2/trades", { user: wallet, taker_only: false, start: o.since ?? 0 }, { cap: o.cap ?? 2000 })) out.push(r);
    return out;
  }
  async userPositions(wallet: string, status: "OPEN" | "CLOSED" = "OPEN"): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for await (const r of this.paginate<Record<string, unknown>>("/v2/positions", { user: wallet, status, include_pnl: true }, { cap: 2000 })) out.push(r);
    return out;
  }
  /** Recent big fills across every market — a discovery route keyed on recent activity. */
  async bigTrades(minUsd = 10_000, cap = 2000): Promise<RawFill[]> {
    const out: RawFill[] = [];
    for await (const r of this.paginate<RawFill>("/v2/trades", { filter_type: "CASH", filter_amount: minUsd, taker_only: false }, { cap })) out.push(r);
    return out;
  }
  async holders(conditionId: string, limit = 100): Promise<{ token_id: string; holders: Record<string, unknown>[] }[]> {
    const b = await this.get<{ data: { token_id: string; holders: Record<string, unknown>[] }[] }>(DATA_API, "/v2/holders", { condition: conditionId, include_pnl: true, limit }); return b.data ?? [];
  }
  /** Point-in-time read: the latest observation at or before `asOf`. v2 shape is `{ data: [{timestamp, price, resolution_seconds}] }`;
   *  `resolution_seconds` 0 with price exactly 0/1 is the on-chain settlement point of a resolved market. */
  async priceAsOf(tokenId: string, asOf: number): Promise<PricePoint | null> {
    const b = await this.get<{ data?: PricePointRaw[] | { points?: PricePointRaw[] } | null }>(DATA_API, "/v2/prices-history", { token_id: tokenId, as_of: asOf });
    const arr = Array.isArray(b.data) ? b.data : b.data?.points ?? [];
    const pt = arr[arr.length - 1]; if (!pt) return null;
    const price = Number(pt.price ?? pt.p); const ts = Number(pt.timestamp ?? pt.t ?? asOf); const res = Number(pt.resolution_seconds ?? -1);
    return Number.isFinite(price) ? { price, ts: Number.isFinite(ts) ? ts : asOf, resolutionSeconds: Number.isFinite(res) ? res : -1 } : null;
  }
  async resolutions(conditionIds: string[]): Promise<Record<string, unknown>[]> {
    const b = await this.get<{ data: Record<string, unknown>[] }>(DATA_API, "/v2/resolutions", { condition: conditionIds.slice(0, 20).join(",") }); return b.data ?? [];
  }
  async marketsBySlug(slug: string): Promise<Record<string, unknown>[]> {
    const b = await this.get<{ markets?: Record<string, unknown>[] }>(GAMMA_API, "/markets/keyset", { slug, limit: 5 }); return b.markets ?? [];
  }
}

/** Accepts v1 REST / websocket (camelCase) and v2 REST (snake_case) fill rows. */
export function normalizeFill(raw: RawFill, source: "rest" | "ws" = "rest"): Fill | null {
  const g = (...ks: string[]) => { for (const k of ks) { const v = raw[k]; if (v !== undefined && v !== null && v !== "") return v; } return undefined; };
  const wallet = String(g("proxyWallet", "proxy_wallet", "wallet") ?? "").toLowerCase();
  const side = String(g("side") ?? "").toUpperCase();
  const size = Number(g("size")); const price = Number(g("price")); const ts = Number(g("timestamp", "ts"));
  const tokenId = String(g("asset", "token_id", "tokenId", "assetId") ?? "");
  const conditionId = String(g("conditionId", "condition_id") ?? "");
  if (!wallet || (side !== "BUY" && side !== "SELL") || !Number.isFinite(size) || !Number.isFinite(price) || !Number.isFinite(ts) || !tokenId) return null;
  const tx = String(g("transactionHash", "transaction_hash", "tx") ?? "");
  return {
    id: `${tx}:${tokenId}:${wallet}:${ts}:${side}:${size}`,
    wallet, conditionId, tokenId, side: side as "BUY" | "SELL", size, price, usd: Math.round(size * price * 100) / 100, ts,
    title: String(g("title") ?? ""), slug: String(g("slug", "eventSlug", "event_slug") ?? ""), outcome: String(g("outcome") ?? ""), tx, source,
  };
}
import type { Fill } from "./types";
type PricePointRaw = { timestamp?: number; price?: number; resolution_seconds?: number; t?: number; p?: number };
export interface PricePoint { price: number; ts: number; resolutionSeconds: number }
