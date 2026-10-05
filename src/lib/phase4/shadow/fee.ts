/**
 * Phase 4.1 — the observed fee rate, expressed through the PAPER simulator's own functions so the two are comparable by construction.
 *
 * The public CLOB `GET /fee-rate?token_id=…` answers `{ "fee_rate_bps": <number> }` (documented; see docs/phase4/SHADOW_BOOKS.md for the status of
 * the verification). The paper model's fee is `shares × rate × p × (1 − p)` (execute.ts `takerFee`) with `rate` a fraction; this module converts
 * basis points to that fraction with ONE named constant, BPS_PER_UNIT, and then calls the paper `feeRateFor` / `takerFee`. The unit
 * conversion and the formula are NOT verified against the live venue from this environment (open decision D111): the raw bps is always stored, so
 * every fee can be recomputed later without re-measuring.
 */
import { feeRateFor, takerFee, type FeeSource, type MarketCfg } from "../../paper/sim/execute";
import { MODES } from "../../paper/sim/config";

export const BPS_PER_UNIT = 10_000;
export const PAPER_FEE_MODE = MODES.REALISTIC;
export { takerFee };
export type { FeeSource };

/** `fee_rate_bps` out of the `/fee-rate` answer; null when absent or not a non-negative number. Accepts `base_fee` (an older name) too. */
export function parseFeeRateBps(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>; const v = o.fee_rate_bps ?? o.base_fee;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/** The rate and its provenance in the paper vocabulary: 0 bps → OBSERVED_FEE_FREE, > 0 → OBSERVED_RATE, unknown → ASSUMED_UNKNOWN at the paper REALISTIC fallback rate. */
export function feeFromBps(bps: number | null): { rate: number; source: FeeSource } {
  const market: MarketCfg | null = bps === null ? null : { feesEnabled: bps > 0, takerFeeRate: bps / BPS_PER_UNIT, tickSize: null, minOrderShares: null };
  return feeRateFor(market, PAPER_FEE_MODE);
}
