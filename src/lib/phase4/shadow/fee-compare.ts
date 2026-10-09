/**
 * Phase 4.1b Part A — what does the venue's `fee_rate_bps` mean? Pure functions for the REPORT only (the recorder is untouched).
 *
 * Two rates exist for the same market: the one the recorder stored (`fee_rate_bps ÷ 10 000`, from the CLOB `/fee-rate` answer) and the one the PAPER simulator
 * uses (the market's own `fees_enabled` / `taker_fee_rate`, read through the paper `feeRateFor`). The report computes shadow fees from the market's own rate and
 * shows the fee implied by the recorded bps beside it. Whether the two are equal, a constant multiple or unrelated is decided by `classifyRelation`, from data,
 * with fixed tolerances; below `REL_MIN_PAIRS` pairs it says UNKNOWN and nothing is guessed.
 */
import { feeRateFor, type MarketCfg } from "../../paper/sim/execute";
import { walkBuy } from "./fill";
import { BPS_PER_UNIT, PAPER_FEE_MODE } from "./fee";
import type { Level } from "./book";

/** Provenance of a recomputed fee. `OBSERVED_*` only when the rate came from the market's own schedule; otherwise `UNKNOWN` (never an assumed rate). */
export type MarketFeeSource = "OBSERVED_RATE" | "OBSERVED_FEE_FREE" | "UNKNOWN";
export interface MarketFee { rate: number | null; source: MarketFeeSource }
export const UNKNOWN_FEE: MarketFee = { rate: null, source: "UNKNOWN" };

/** The market's effective taker rate, exactly as the paper simulator reads it (execute.ts `feeRateFor`); an assumed (fallback) rate is NOT used: it is reported as unknown. */
export function marketFee(m: { fees_enabled?: unknown; taker_fee_rate?: unknown } | null | undefined): MarketFee {
  if (!m) return UNKNOWN_FEE;
  const rate = m.taker_fee_rate === null || m.taker_fee_rate === undefined || m.taker_fee_rate === "" ? null : Number(m.taker_fee_rate);
  const cfg: MarketCfg = { feesEnabled: m.fees_enabled === true || m.fees_enabled === "true" ? true : m.fees_enabled === false || m.fees_enabled === "false" ? false : null, takerFeeRate: rate !== null && Number.isFinite(rate) && rate >= 0 ? rate : null, tickSize: null, minOrderShares: null };
  const r = feeRateFor(cfg, PAPER_FEE_MODE);
  return r.source === "OBSERVED_RATE" || r.source === "OBSERVED_FEE_FREE" ? { rate: r.rate, source: r.source } : UNKNOWN_FEE;
}

/** The rate the recorder actually used for a row's `fee_usd`: bps ÷ 10 000, or the paper REALISTIC fallback when the venue's rate was unknown (fee.ts `feeFromBps`). */
export const recordedRate = (bps: number | null): number => (bps === null ? PAPER_FEE_MODE.fallbackFeeRate : bps / BPS_PER_UNIT);

const EPS_USD = 1e-4;
/**
 * A stored fill's fee at `rate` instead of the rate it was recorded with. The fee is linear in the rate, so when the recorded rate is positive the answer is the recorded fee scaled
 * by `rate ÷ recordedRate` (exact, whatever levels the fill took). When the recorded rate was 0 the recorded fee carries no information, so the stored asks are walked again at `rate`;
 * that is accepted only when the walk reproduces the recorded fill (it can differ if the fill went deeper than the stored levels), otherwise null (unknown, never guessed).
 */
export function recomputeFeeUsd(fill: { filled_usd: number; fee_usd: number }, usd: number, asks: readonly Level[] | null, bps: number | null, rate: number): number | null {
  if (!(fill.filled_usd > 0)) return null;
  if (rate === 0) return 0;
  const rec = recordedRate(bps);
  if (rec > 0) return (fill.fee_usd * rate) / rec;
  if (!asks || !asks.length) return null;
  const w = walkBuy(asks, usd, { sourcePrice: null, mid: null, feeRate: rate, minOrderSize: null });
  return Math.abs(w.filled_usd - fill.filled_usd) <= EPS_USD ? w.fee_usd : null;
}

// ───────────────────────────────────────── the relation rule ─────────────────────────────────────────
export const REL_MIN_PAIRS = 30;
/** EQUAL: at least REL_SHARE of the pairs have recorded rate within ±1 % of the market's. CONSTANT_MULTIPLE: otherwise, at least REL_SHARE within ±5 % of the median ratio. */
export const REL_EQUAL_TOL = 0.01; export const REL_MULT_TOL = 0.05; export const REL_SHARE = 0.95;
const TOL_EPS = 1e-9;
export type Relation = "EQUAL" | "CONSTANT_MULTIPLE" | "UNRELATED" | "UNKNOWN";
export interface FeeRelation { pairs: number; relation: Relation; /** recorded rate ÷ market rate: 1 for EQUAL, the median ratio for CONSTANT_MULTIPLE, else null */ multiple: number | null; shareEqual: number | null; shareNearMedian: number | null; medianRatio: number | null }

/** Weighted median of [value, weight] pairs sorted ascending (the lower middle on an exact tie). */
function wMedian(xs: [number, number][]): number | null {
  if (!xs.length) return null; const total = xs.reduce((a, [, w]) => a + w, 0); let acc = 0;
  for (const [v, w] of [...xs].sort((a, b) => a[0] - b[0])) { acc += w; if (acc >= total / 2) return v; }
  return null;
}
/** `pairs`: [recorded bps, market rate (fraction), count]. A market rate of 0 matches only 0 bps (ratio 1); any other bps against rate 0 is infinitely far from every ratio. */
export function classifyRelation(pairs: Iterable<readonly [number, number, number]>): FeeRelation {
  const rs: [number, number][] = []; let n = 0;
  for (const [bps, rate, k] of pairs) { if (!(k > 0)) continue; n += k; rs.push([rate > 0 ? bps / BPS_PER_UNIT / rate : bps === 0 ? 1 : Infinity, k]); }
  if (n < REL_MIN_PAIRS) return { pairs: n, relation: "UNKNOWN", multiple: null, shareEqual: n ? rs.filter(([r]) => Math.abs(r - 1) <= REL_EQUAL_TOL + TOL_EPS).reduce((a, [, w]) => a + w, 0) / n : null, shareNearMedian: null, medianRatio: null };
  const shareEqual = rs.filter(([r]) => Math.abs(r - 1) <= REL_EQUAL_TOL + TOL_EPS).reduce((a, [, w]) => a + w, 0) / n;
  const med = wMedian(rs.filter(([r]) => Number.isFinite(r)));
  const shareNear = med !== null && med > 0 ? rs.filter(([r]) => Number.isFinite(r) && Math.abs(r / med - 1) <= REL_MULT_TOL + TOL_EPS).reduce((a, [, w]) => a + w, 0) / n : null;
  if (shareEqual >= REL_SHARE - TOL_EPS) return { pairs: n, relation: "EQUAL", multiple: 1, shareEqual, shareNearMedian: shareNear, medianRatio: med };
  if (shareNear !== null && shareNear >= REL_SHARE - TOL_EPS) return { pairs: n, relation: "CONSTANT_MULTIPLE", multiple: med, shareEqual, shareNearMedian: shareNear, medianRatio: med };
  return { pairs: n, relation: "UNRELATED", multiple: null, shareEqual, shareNearMedian: shareNear, medianRatio: med };
}

/** Counts of (recorded bps, market rate) pairs with bounded memory: at most `max` distinct pairs are kept, the rest are counted in `overflow` (and reported as such). */
export class FeeRelAcc {
  readonly pairs = new Map<string, [number, number, number]>(); overflow = 0; noMarketRate = 0; noBps = 0;
  constructor(private max = 400) {}
  add(bps: number | null, rate: number | null): void {
    if (bps === null) { this.noBps++; return; } if (rate === null) { this.noMarketRate++; return; }
    const k = `${bps}|${rate}`; const e = this.pairs.get(k);
    if (e) e[2]++; else if (this.pairs.size < this.max) this.pairs.set(k, [bps, rate, 1]); else this.overflow++;
  }
  relation(): FeeRelation { return classifyRelation(this.pairs.values()); }
  /** The most frequent recorded bps values and market rates, for the distribution lines. */
  top(n = 5): { bps: [number, number][]; rate: [number, number][] } {
    const by = (i: 0 | 1) => { const m = new Map<number, number>(); for (const p of this.pairs.values()) m.set(p[i], (m.get(p[i]) ?? 0) + p[2]); return [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, n); };
    return { bps: by(0), rate: by(1) };
  }
}
