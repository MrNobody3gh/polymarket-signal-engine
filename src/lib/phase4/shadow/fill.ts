/**
 * Phase 4.1 — hypothetical TAKER BUY of the signal's token against an observed book (pure). Walks the ask side from the best ask upwards,
 * spends up to `usd` dollars of stake, fills partially when the book is thinner than the order, and never fabricates liquidity: whatever the
 * book does not offer is reported as unfilled (`filled_share` < 1). Fees use the PAPER simulator's `takerFee` on each level taken, so a one-level
 * fill equals the paper function exactly (tests/phase4-shadow-fill.test.ts).
 */
import { r6, type Book, type Level } from "./book";
import { takerFee } from "./fee";

export interface Fill {
  usd_requested: number;
  filled_usd: number; shares: number;
  /** null when nothing filled */
  avg_price: number | null;
  /** the worst (highest) ask level touched: the limit price an order would have to carry to take this fill; null when nothing filled */
  limit_price: number | null;
  /** avg_price − the wallet's price / − the mid, in price units (0.01 = 1 point); null when nothing filled or the reference is missing */
  slippage_vs_source: number | null; slippage_vs_mid: number | null;
  /** filled_usd ÷ usd_requested, 0..1 */
  filled_share: number;
  fee_usd: number;
  /** the fill is smaller than the venue's minimum order size (a real order would be rejected); null when the book did not state it */
  below_min_order: boolean | null;
}

const EPS = 1e-9;
export function walkBuy(asks: readonly Level[], usd: number, ref: { sourcePrice: number | null; mid: number | null; feeRate: number; minOrderSize: number | null }): Fill {
  let remaining = usd, spent = 0, shares = 0, fee = 0, worst: number | null = null;
  for (const [price, size] of asks) {
    if (remaining <= EPS) break;
    const take = Math.min(remaining / price, size);
    if (!(take > 0)) continue;
    spent += take * price; shares += take; fee += takerFee(take, price, ref.feeRate); remaining -= take * price; worst = price;
  }
  const avg = shares > 0 ? spent / shares : null;
  return {
    usd_requested: usd, filled_usd: r6(spent), shares: r6(shares), avg_price: avg === null ? null : r6(avg), limit_price: worst,
    slippage_vs_source: avg !== null && ref.sourcePrice !== null ? r6(avg - ref.sourcePrice) : null,
    slippage_vs_mid: avg !== null && ref.mid !== null ? r6(avg - ref.mid) : null,
    filled_share: r6(Math.min(1, spent / usd)), fee_usd: r6(fee),
    below_min_order: ref.minOrderSize === null ? null : shares < ref.minOrderSize - EPS,
  };
}

export interface Fills { tick_size: number | null; min_order_size: number | null; by_usd: Record<string, Fill> }
/** Fills at every size, or null for a crossed book (its prices cannot be trusted, so no fill is invented from it). */
export function fillsFor(book: Book, sizesUsd: readonly number[], ref: { sourcePrice: number | null; feeRate: number }): Fills | null {
  if (book.state === "CROSSED") return null;
  const by_usd: Record<string, Fill> = {};
  for (const s of sizesUsd) by_usd[String(s)] = walkBuy(book.asks, s, { sourcePrice: ref.sourcePrice, mid: book.mid, feeRate: ref.feeRate, minOrderSize: book.minOrderSize });
  return { tick_size: book.tickSize, min_order_size: book.minOrderSize, by_usd };
}
