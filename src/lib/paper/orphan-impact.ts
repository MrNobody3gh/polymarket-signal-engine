/**
 * What a newly known resolution does to a stored paper_executions record (Phase 3 step 3 impact report).
 *
 * The next sweep recomputes an affected record with lifecycle() (sim/execute.ts). That needs the price observations
 * behind its entry and exit, which a read-only report does not have. The arithmetic after the fills, however, uses only
 * values the record already stores: filled shares and notional, fees, what the exit sold and at what price, and the last
 * mark. This module repeats exactly that arithmetic. `recompute(rec, null)` must reproduce the stored P&L of every
 * record (checked row by row in the report), and tests/phase3.test.ts checks `recompute(rec, resolution)` against
 * simulateMode on the same inputs.
 */
export interface ExecRecordLite {
  signal_id: string; mode: string; state: string; fill_ts: string;
  filled_shares: number; filled_usd: number; entry_fee: number; fees_total: number;
  exit_status: string | null; exit_fill_ts: string | null; exit_sold_shares: number | null; exit_fill_price: number | null; exit_fee: number | null;
  open_shares: number; mark_price: number | null; mark_ts: string | null;
  gross_pnl: number; net_pnl: number; realized_pnl: number; unrealized_pnl: number;
}
export interface Recomputed { state: "OPEN" | "PARTIALLY_EXITED" | "EXITED" | "RESOLVED"; openShares: number; grossPnl: number; netPnl: number; realizedPnl: number; unrealizedPnl: number; fees: number; closedAt: number | null; exitVoided: boolean; resolutionIgnored: boolean;
  /** True when the result re-opens shares the stored record had closed: their unrealised value needs the latest mark, which
   *  lifecycle() only stores for open positions. State and open shares are exact; P&L is then not computable from the record. */
  incomplete: boolean }

const sec = (iso: string | null) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);
const n = (v: unknown) => (v == null ? 0 : Number(v));

/** lifecycle() arithmetic over a stored record, optionally with a resolution {ts, value}. */
export function recompute(r: ExecRecordLite, resolution: { ts: number; value: number } | null): Recomputed {
  const filled = n(r.filled_shares), filledUsd = n(r.filled_usd), fillTs = sec(r.fill_ts)!;
  let open = filled, proceeds = 0, fees = n(r.entry_fee), closedAt: number | null = null, sold = 0;
  let exitVoided = false, resolutionIgnored = false, applied = false;
  // The stored exit was computed without this resolution. lifecycle() drops an exit whose fill is at or after the resolution.
  const exitTs = sec(r.exit_fill_ts);
  if (r.exit_status != null) {
    if (resolution && exitTs != null && resolution.ts <= exitTs) exitVoided = true;
    else { sold = n(r.exit_sold_shares); open -= sold; proceeds += sold * n(r.exit_fill_price); fees += n(r.exit_fee); if (sold > 0) closedAt = exitTs; }
  }
  if (resolution) {
    if (resolution.ts >= fillTs && open > 1e-12) { proceeds += open * resolution.value; open = 0; closedAt = resolution.ts; applied = true; }
    else if (resolution.ts < fillTs) resolutionIgnored = true;
  }
  const soldCost = filled > 0 ? ((filled - open) / filled) * filledUsd : 0;
  const realizedGross = proceeds - soldCost;
  const markTs = sec(r.mark_ts); const m = open > 0 && r.mark_price != null && markTs != null && markTs >= fillTs ? { price: n(r.mark_price) } : null;
  const unrealized = m ? open * m.price - (filledUsd - soldCost) : 0;
  const incomplete = open > 1e-12 && n(r.open_shares) <= 1e-12;
  const state: Recomputed["state"] = open <= 1e-12 ? (applied ? "RESOLVED" : "EXITED") : sold > 0 ? "PARTIALLY_EXITED" : "OPEN";
  return { state, openShares: open, grossPnl: realizedGross + unrealized, netPnl: realizedGross + unrealized - fees, realizedPnl: realizedGross - fees, unrealizedPnl: unrealized, fees, closedAt, exitVoided, resolutionIgnored, incomplete };
}

/** Largest absolute difference between the stored P&L and recompute(rec, null): the report refuses to run if it is not ~0. */
export function reproductionError(r: ExecRecordLite): number {
  const b = recompute(r, null);
  return Math.max(Math.abs(b.netPnl - n(r.net_pnl)), Math.abs(b.realizedPnl - n(r.realized_pnl)), Math.abs(b.unrealizedPnl - n(r.unrealized_pnl)), Math.abs(b.grossPnl - n(r.gross_pnl)), Math.abs(b.openShares - n(r.open_shares)));
}
