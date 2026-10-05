/**
 * Phase 4.1 — one snapshot: read the public book of a token (and, when there is something to fill, its fee rate), and turn the outcome into a
 * `shadow_books` row. Public, unauthenticated GETs only, through `PoliteHttp` (≤ 2 requests/s, a descriptive User-Agent, no credentials).
 *
 * Endpoints (public CLOB; documentation in docs/phase4/SHADOW_BOOKS.md — NOT verified live from this environment, whose network policy blocks the venue):
 *   GET {CLOB_BASE}/book?token_id=<token>        → { bids: [{price,size}…], asks: […], tick_size, min_order_size, … }; 404 when the token has no book
 *   GET {CLOB_BASE}/fee-rate?token_id=<token>    → { fee_rate_bps }
 *
 * Failure mapping (nothing is retried here beyond PoliteHttp's bounded retry of 5xx / timeouts; a refusal is never retried):
 *   401 / 403 / 451 / 429 / BLOCKED_SKIPPED → REFUSED, and `stop` is set: the caller ends the cycle and pauses
 *   404                                     → NOT_FOUND
 *   timeout, network, 5xx, 400, not JSON, JSON that is not a book → ERROR
 *   a book → OK / EMPTY_BOOK / ONE_SIDED / CROSSED
 */
import type { HttpResult, PoliteHttp } from "../http";
import { CLOB_BASE, DEPTH_LEVELS, FEE_CACHE_MAX, FEE_CACHE_TTL_S, SCHEMA_VERSION, SIZES_USD } from "./config";
import { normaliseBook, topLevels } from "./book";
import { feeFromBps, parseFeeRateBps, type FeeSource } from "./fee";
import { fillsFor, type Fills } from "./fill";
import type { Due } from "./schedule";

export type ShadowStatus = "OK" | "EMPTY_BOOK" | "ONE_SIDED" | "CROSSED" | "NOT_FOUND" | "ERROR" | "REFUSED" | "MISSED";
export interface ShadowRow {
  signal_id: string; offset_s: number; due_at: string; taken_at: string; token_id: string; side: "BUY"; source_price: number | null;
  best_bid: number | null; best_ask: number | null; spread: number | null; mid: number | null;
  bids: [number, number][] | null; asks: [number, number][] | null; fills: Fills | null;
  fee_rate_bps: number | null; fee_source: FeeSource | null; status: ShadowStatus; http_status: number | null; latency_ms: number | null; request_count: number; schema_version: number;
}
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const baseRow = (d: Due, takenAtSec: number): ShadowRow => ({ signal_id: d.signalId, offset_s: d.offsetS, due_at: iso(d.dueAtSec), taken_at: iso(takenAtSec), token_id: d.tokenId, side: "BUY", source_price: d.sourcePrice,
  best_bid: null, best_ask: null, spread: null, mid: null, bids: null, asks: null, fills: null, fee_rate_bps: null, fee_source: null, status: "ERROR", http_status: null, latency_ms: null, request_count: 0, schema_version: SCHEMA_VERSION });

/** A snapshot that was not taken because it was too late: no data, no request. */
export const missedRow = (d: Due, nowSec: number): ShadowRow => ({ ...baseRow(d, nowSec), status: "MISSED" });

/** Fee rates by token: bounded in size and in age. Stale entries are ignored (and overwritten on refresh); when the cache is full it is emptied, so it never holds more than `max` tokens. An unknown rate is never cached. */
export class FeeCache {
  private m = new Map<string, { bps: number; at: number }>();
  constructor(private ttlS = FEE_CACHE_TTL_S, private max = FEE_CACHE_MAX) {}
  get(token: string, nowSec: number): number | null { const e = this.m.get(token); return e && nowSec - e.at < this.ttlS ? e.bps : null; }
  set(token: string, bps: number, nowSec: number) { if (!this.m.has(token) && this.m.size >= this.max) this.m.clear(); this.m.set(token, { bps, at: nowSec }); }
  get size() { return this.m.size; }
}

const refusal = (r: Extract<HttpResult, { ok: false }>) => r.kind === "BLOCKED" || r.kind === "BLOCKED_SKIPPED" || r.kind === "RATE_LIMITED";
export interface SnapshotResult { row: ShadowRow; /** set when the venue refused (or rate-limited) a request: the cycle must stop */ refused: { status: number | null; retryAfterMs: number | null; message: string } | null }

export async function takeSnapshot(d: Due, o: { http: PoliteHttp; fees: FeeCache; nowSec: () => number; clockMs: () => number; sizesUsd?: readonly number[] }): Promise<SnapshotResult> {
  const t0 = o.clockMs(); const req0 = o.http.requests; const takenAt = o.nowSec();
  const row = baseRow(d, takenAt); const token = encodeURIComponent(d.tokenId);
  const finish = (refused: SnapshotResult["refused"] = null): SnapshotResult => { row.request_count = o.http.requests - req0; if (row.latency_ms === null) row.latency_ms = Math.max(0, Math.round(o.clockMs() - t0)); return { row, refused }; };

  const b = await o.http.getJson<unknown>(`${CLOB_BASE}/book?token_id=${token}`);
  if (!b.ok) {
    row.http_status = b.status; row.latency_ms = Math.max(0, Math.round(o.clockMs() - t0));
    if (refusal(b)) { row.status = "REFUSED"; return finish({ status: b.status, retryAfterMs: b.retryAfterMs ?? null, message: b.message }); }
    row.status = b.kind === "NOT_FOUND" ? "NOT_FOUND" : "ERROR"; return finish();
  }
  row.http_status = b.status; row.latency_ms = Math.round(b.ms);
  const book = normaliseBook(b.json);
  if (!book) { row.status = "ERROR"; return finish(); }
  row.status = book.state; row.best_bid = book.bestBid; row.best_ask = book.bestAsk; row.spread = book.spread; row.mid = book.mid;
  row.bids = book.bids.length ? topLevels(book.bids, DEPTH_LEVELS) : null; row.asks = book.asks.length ? topLevels(book.asks, DEPTH_LEVELS) : null;

  // A fee rate is only worth a request when there is something to fill (a crossed book gets no fills; an empty or bid-only book has nothing to buy).
  let refused: SnapshotResult["refused"] = null;
  if (book.state !== "CROSSED" && book.asks.length) {
    let bps = o.fees.get(d.tokenId, takenAt);
    if (bps === null) {
      const f = await o.http.getJson<unknown>(`${CLOB_BASE}/fee-rate?token_id=${token}`);
      if (f.ok) { bps = parseFeeRateBps(f.json); if (bps !== null) o.fees.set(d.tokenId, bps, takenAt); }
      else if (refusal(f)) refused = { status: f.status, retryAfterMs: f.retryAfterMs ?? null, message: f.message };
    }
    const { rate, source } = feeFromBps(bps); row.fee_rate_bps = bps; row.fee_source = source;
    row.fills = fillsFor(book, o.sizesUsd ?? SIZES_USD, { sourcePrice: d.sourcePrice, feeRate: rate });
  } else if (book.state !== "CROSSED") row.fills = fillsFor(book, o.sizesUsd ?? SIZES_USD, { sourcePrice: d.sourcePrice, feeRate: 0 }); // nothing to buy: every size reads as unfilled
  return finish(refused);
}
