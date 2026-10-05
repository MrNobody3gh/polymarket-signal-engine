/**
 * Phase 4.1 — order-book normalisation (pure). Takes the parsed JSON of the public CLOB `GET /book?token_id=…` answer and returns sorted,
 * validated levels plus the book's state. Nothing is invented: a level that cannot be read is dropped and counted, never repaired.
 *
 * The documented answer carries `bids` and `asks` as arrays of `{ price, size }` with decimal STRINGS (an array of `[price, size]` pairs and
 * plain numbers are accepted too), and `tick_size` / `min_order_size`. The order of the levels is NOT relied on: both sides are sorted here.
 *
 * Rounding rule (the venue's own, D106 item): prices and sizes are read exactly as the venue prints them and are never rounded to a tick,
 * because a resting level is already on the tick. Derived numbers (spread, mid, averages) are rounded to 6 decimals, only to remove float noise.
 */
export type BookState = "OK" | "EMPTY_BOOK" | "ONE_SIDED" | "CROSSED";
export type Level = readonly [price: number, size: number];
export interface Book {
  state: BookState;
  /** best first: bids descending, asks ascending; the WHOLE book as returned (the stored copy is cut to DEPTH_LEVELS) */
  bids: Level[]; asks: Level[];
  bestBid: number | null; bestAsk: number | null; spread: number | null; mid: number | null;
  tickSize: number | null; minOrderSize: number | null;
  /** levels dropped because price or size was unreadable, price outside (0,1) or size not positive */
  dropped: number;
}
export const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

const toNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*\d*\.?\d+\s*$/.test(v)) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
};
function levels(raw: unknown): { ok: true; levels: Level[]; dropped: number } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, levels: [], dropped: 0 };
  if (!Array.isArray(raw)) return { ok: false };
  const merged = new Map<number, number>(); let dropped = 0;
  for (const l of raw) {
    const p = Array.isArray(l) ? toNum(l[0]) : l && typeof l === "object" ? toNum((l as Record<string, unknown>).price) : null;
    const s = Array.isArray(l) ? toNum(l[1]) : l && typeof l === "object" ? toNum((l as Record<string, unknown>).size) : null;
    if (p === null || s === null || !(p > 0 && p < 1) || !(s > 0)) { dropped++; continue; }
    const k = r6(p); merged.set(k, (merged.get(k) ?? 0) + s); // a repeated price is one level
  }
  return { ok: true, levels: [...merged].map(([p, s]): Level => [p, r6(s)]), dropped };
}

/** `null` = the answer is not an order book at all (not an object, or `bids` / `asks` is not an array): the caller records ERROR. */
export function normaliseBook(raw: unknown): Book | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const b = levels(o.bids), a = levels(o.asks); if (!b.ok || !a.ok) return null;
  if (o.bids === undefined && o.asks === undefined) return null; // no book member at all: an error body, not an empty book
  const bids = b.levels.sort((x, y) => y[0] - x[0]); const asks = a.levels.sort((x, y) => x[0] - y[0]);
  const bestBid = bids.length ? bids[0][0] : null; const bestAsk = asks.length ? asks[0][0] : null;
  const state: BookState = !bids.length && !asks.length ? "EMPTY_BOOK" : !bids.length || !asks.length ? "ONE_SIDED" : bestBid! > bestAsk! ? "CROSSED" : "OK";
  const two = bestBid !== null && bestAsk !== null;
  const tick = toNum(o.tick_size), min = toNum(o.min_order_size);
  return { state, bids, asks, bestBid, bestAsk, spread: two ? r6(bestAsk! - bestBid!) : null, mid: two ? r6((bestAsk! + bestBid!) / 2) : null, tickSize: tick !== null && tick > 0 ? tick : null, minOrderSize: min !== null && min >= 0 ? min : null, dropped: b.dropped + a.dropped };
}

/** The stored copy of one side: the top `n` levels as compact `[price, size]` pairs. */
export const topLevels = (ls: readonly Level[], n: number): [number, number][] => ls.slice(0, n).map(([p, s]) => [p, s]);
