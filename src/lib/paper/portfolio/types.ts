/**
 * Phase 3 portfolio types (docs/PHASE3_PLAN.md §C). Everything in a BookState is plain JSON: it is what a checkpoint
 * stores, and restoring it must continue exactly where the book stopped.
 */
import type { PortfolioSignal, PortfolioOutcome } from "../sim/portfolio";
import type { ExitInput } from "../sim/execute";

/** Total order of events (§B9): time, then kind (RESOLUTION → EXIT → NEW_POSITION → EARLY_ENTRY → CONVICTION_ADD →
 *  CONSENSUS), then id. Ids compare by code unit, never by locale. */
export interface EventKey { ts: number; order: number; id: string }

/** A signal as the book receives it: the Phase 2 PortfolioSignal plus the id of its linked EXIT (for rehydration). */
export type BookSignal = PortfolioSignal & { exitId?: string | null; tokenId: string };

/** One decision per entry signal (the row behind portfolio_decisions). */
export interface BookDecision {
  signalId: string; kind: string; sourceKey: string; ts: number;
  outcome: PortfolioOutcome; reason: string | null; requestedUsd: number; filledUsd: number;
  filledShares: number; fillPrice: number | null; fee: number; resized: boolean;
}

/** An open or closed lot (the row behind portfolio_lots). `shares`/`cost` are what is still open. */
export interface BookLot {
  signalId: string; kind: string; wallet: string; conditionId: string; tokenId: string; openedTs: number;
  sharesFilled: number; costFilled: number; entryFee: number; fillPrice: number;
  shares: number; cost: number; mark: { ts: number; price: number } | null;
  exitId: string | null; exitTs: number | null; exitShares: number | null; exitProceeds: number | null; exitFee: number | null;
  resolutionTs: number | null; resolutionValue: number | null; resolutionProceeds: number | null;
  state: "OPEN" | "PARTIALLY_EXITED" | "EXITED" | "RESOLVED"; realizedPnl: number; closedTs: number | null;
}

/** A scheduled exit or resolution for one lot. Plain data, so it survives a checkpoint. */
export interface ScheduledEvent extends EventKey { seq: number; type: "EXIT" | "RESOLUTION"; exit?: ExitInput; value?: number }

export interface EquityPoint { ts: number; equity: number; cash: number; exposure: number }

export interface BookState {
  v: 1;
  cash: number; realized: number; fees: number; slippage: number;
  peakEquity: number; maxDrawdown: number; maxDrawdownPct: number;
  lots: BookLot[];                      // open lots only (closed ones are emitted, then dropped)
  taken: [string, number][];            // source key → fill time, pruned to TAKEN_WINDOW_SEC
  heap: ScheduledEvent[];               // pending exits / resolutions
  seq: number;                          // insertion counter for scheduled events
  last: EventKey | null;                // last event applied: nothing earlier may be submitted
  events: number;                       // events applied so far
}

/** What a step produced; the runner writes it. */
export interface BookOutput { decisions: BookDecision[]; lots: BookLot[]; equity: EquityPoint[] }
