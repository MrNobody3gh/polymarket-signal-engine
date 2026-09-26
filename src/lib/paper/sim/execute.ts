/**
 * Pure execution simulator. No I/O, no clock, no randomness: the same inputs always give the same output.
 *
 * Price vocabulary (never conflated):
 *   signalPrice         — what the source wallet paid (the old ledger's entry)
 *   marketPrice         — last observed trade at or before the simulated fill time (OBSERVED)
 *   fillPrice           — marketPrice + spread/impact ticks, rounded to the tick grid against the trader (APPROXIMATED)
 * Cost attribution per trade:
 *   latencyCost  = shares × (marketPrice − signalPrice)   price moved while we were detecting/deciding
 *   slippageCost = shares × (fillPrice − marketPrice)     crossing the spread + impact
 *   fees         = taker fee on the executed notional
 */
import type { ExecConfig } from "./config";

export type FillStatus = "FILLED" | "PARTIALLY_FILLED" | "UNFILLED" | "EXPIRED" | "INVALID" | "UNKNOWN";
export interface PriceObs { ts: number; price: number; resolutionSeconds: number }
export interface MarketCfg { feesEnabled: boolean | null; takerFeeRate: number | null; tickSize: number | null; minOrderShares: number | null }

export interface EntryInput {
  sourceTs: number;          // wallet's trade (OBSERVED)
  evalTs: number | null;     // our evaluation (OBSERVED when recorded)
  signalPrice: number;
  sourceUsd: number;         // wallet's fill notional — liquidity evidence
  obs: PriceObs | null;      // last trade at/before the fill time (fetched with as_of = fillTs)
  market: MarketCfg | null;
}
export interface Timing { sourceTs: number; evalTs: number; submitTs: number; fillTs: number; latencySource: "OBSERVED" | "ESTIMATED" | "NONE" }
export interface ExecResult {
  status: FillStatus; reason: string | null; timing: Timing;
  requestedUsd: number; filledUsd: number; filledShares: number; fillPct: number;
  marketPrice: number | null; marketObsTs: number | null; fillPrice: number | null; tick: number | null; slippageTicks: number;
  fee: number; feeRate: number; feeSource: FeeSource;
  latencyCost: number; slippageCost: number;
}

/** Timeline: source → evaluation (observed, else assumed) → submit → fill. */
export function timeline(sourceTs: number, evalTs: number | null, cfg: ExecConfig): Timing {
  // IDEAL executes at the source trade itself: zero latency by definition (the original ledger's assumption).
  if (cfg.fillAtSignalPrice) return { sourceTs, evalTs: sourceTs, submitTs: sourceTs, fillTs: sourceTs, latencySource: "NONE" };
  const observed = evalTs != null && evalTs >= sourceTs;
  const ev = observed ? (evalTs as number) : sourceTs + cfg.assumedDetectionLatencySec;
  const submit = ev + cfg.decisionLatencySec; const fill = submit + cfg.executionLatencySec;
  return { sourceTs, evalTs: ev, submitTs: submit, fillTs: fill, latencySource: observed ? "OBSERVED" : "ESTIMATED" };
}

/** Polymarket tick: the market's tick, dropping to 0.001 in the tails (below 0.04 / above 0.96). */
export function tickFor(price: number, market: MarketCfg | null, cfg: ExecConfig): number {
  const base = market?.tickSize ?? cfg.defaultTickSize;
  return price < 0.04 || price > 0.96 ? Math.min(base, 0.001) : base;
}
const roundUp = (p: number, t: number) => Math.round(Math.ceil(p / t - 1e-9) * t * 1e6) / 1e6;
const roundDown = (p: number, t: number) => Math.round(Math.floor(p / t + 1e-9) * t * 1e6) / 1e6;

/** Taker fee in USDC: shares × rate × p × (1 − p). */
export function takerFee(shares: number, price: number, rate: number): number { return rate > 0 ? shares * rate * price * (1 - price) : 0; }
/** Fee provenance, most → least certain:
 *  OBSERVED_FEE_FREE    market reports feesEnabled=false → 0
 *  OBSERVED_RATE        market reports feesEnabled=true and a rate
 *  ASSUMED_RATE         market reports feesEnabled=true, rate not provided → mode fallback rate
 *  ASSUMED_UNKNOWN      no fee metadata for this market → mode fallback rate (may overstate fees on fee-free markets)
 *  NONE                 IDEAL: fees not modelled */
export type FeeSource = "NONE" | "OBSERVED_FEE_FREE" | "OBSERVED_RATE" | "ASSUMED_RATE" | "ASSUMED_UNKNOWN";
export function feeRateFor(market: MarketCfg | null, cfg: ExecConfig): { rate: number; source: FeeSource } {
  if (cfg.feeModel === "none") return { rate: 0, source: "NONE" };
  if (market?.feesEnabled === false) return { rate: 0, source: "OBSERVED_FEE_FREE" };
  if (market?.feesEnabled === true && market.takerFeeRate != null) return { rate: market.takerFeeRate, source: "OBSERVED_RATE" };
  if (market?.feesEnabled === true) return { rate: cfg.fallbackFeeRate, source: "ASSUMED_RATE" };
  return { rate: cfg.fallbackFeeRate, source: "ASSUMED_UNKNOWN" };
}

/** Is this observation usable for a decision at time t? Guards look-ahead and stale data. */
export function usableObs(obs: PriceObs | null, t: number, cfg: ExecConfig): { ok: true } | { ok: false; status: FillStatus; reason: string } {
  if (!obs) return { ok: false, status: "UNKNOWN", reason: "NO_PRICE_OBSERVATION" };
  if (obs.ts > t || (obs.resolutionSeconds > 0 && obs.ts + obs.resolutionSeconds > t)) return { ok: false, status: "INVALID", reason: "LOOKAHEAD_OBSERVATION_REJECTED" };
  if (t - obs.ts > cfg.maxQuoteAgeSec) return { ok: false, status: "UNKNOWN", reason: "STALE_QUOTE" };
  if (obs.resolutionSeconds === 0 && (obs.price <= 0 || obs.price >= 1)) return { ok: false, status: "INVALID", reason: "MARKET_SETTLED_BEFORE_FILL" };
  if (!(obs.price > 0 && obs.price < 1)) return { ok: false, status: "INVALID", reason: "PRICE_OUT_OF_RANGE" };
  return { ok: true };
}

function empty(status: FillStatus, reason: string | null, timing: Timing, requestedUsd: number): ExecResult {
  return { status, reason, timing, requestedUsd, filledUsd: 0, filledShares: 0, fillPct: 0, marketPrice: null, marketObsTs: null, fillPrice: null, tick: null, slippageTicks: 0, fee: 0, feeRate: 0, feeSource: "NONE" as FeeSource, latencyCost: 0, slippageCost: 0 };
}

/** Simulate a BUY of `requestedUsd` for one signal. */
export function simulateEntry(inp: EntryInput, cfg: ExecConfig, requestedUsd: number = cfg.paperSizeUsd): ExecResult {
  const timing = timeline(inp.sourceTs, inp.evalTs, cfg);
  if (!(requestedUsd > 0)) return empty("INVALID", "ZERO_SIZE", timing, requestedUsd);
  if (!(inp.signalPrice > 0 && inp.signalPrice < 1)) return empty("INVALID", "INVALID_SIGNAL_PRICE", timing, requestedUsd);
  if (cfg.maxSignalAgeSec != null && timing.fillTs - timing.sourceTs > cfg.maxSignalAgeSec) return empty("EXPIRED", "EXECUTION_TIMEOUT", timing, requestedUsd);
  let market: number; let obsTs: number | null;
  if (cfg.fillAtSignalPrice) { market = inp.signalPrice; obsTs = inp.sourceTs; }
  else { const u = usableObs(inp.obs, timing.fillTs, cfg); if (!u.ok) return empty(u.status, u.reason, timing, requestedUsd); market = inp.obs!.price; obsTs = inp.obs!.ts; }
  const tick = tickFor(market, inp.market, cfg);
  const cap = cfg.participation == null ? Infinity : cfg.participation * inp.sourceUsd;
  const ratio = inp.sourceUsd > 0 ? Math.min(1, requestedUsd / inp.sourceUsd) : 1;
  const slipTicks = cfg.spreadTicks + cfg.impactTicksAtFullParticipation * ratio;
  const fill = slipTicks > 0 ? roundUp(market + slipTicks * tick, tick) : market;
  // A buy that would have to pay ≥ $1 has no ask to fill against: an execution outcome (UNFILLED), not bad data.
  if (!(fill < 1)) return { ...empty("UNFILLED", "NO_ASK_BELOW_ONE", timing, requestedUsd), marketPrice: market, marketObsTs: obsTs, tick };
  if (!(fill > 0)) return { ...empty("INVALID", "FILL_PRICE_OUT_OF_RANGE", timing, requestedUsd), marketPrice: market, marketObsTs: obsTs, tick };
  const filledUsd = Math.min(requestedUsd, cap); const shares = filledUsd / fill;
  const minShares = cfg.fillAtSignalPrice ? 0 : inp.market?.minOrderShares ?? cfg.defaultMinOrderShares;
  if (!(shares > 0) || shares < minShares) return { ...empty("UNFILLED", "INSUFFICIENT_LIQUIDITY", timing, requestedUsd), marketPrice: market, marketObsTs: obsTs, fillPrice: fill, tick };
  const { rate, source } = feeRateFor(inp.market, cfg);
  return {
    status: filledUsd >= requestedUsd - 1e-9 ? "FILLED" : "PARTIALLY_FILLED", reason: filledUsd >= requestedUsd - 1e-9 ? null : "LIQUIDITY_CAP",
    timing, requestedUsd, filledUsd, filledShares: shares, fillPct: filledUsd / requestedUsd,
    marketPrice: market, marketObsTs: obsTs, fillPrice: fill, tick, slippageTicks: (fill - market) / tick,
    fee: takerFee(shares, fill, rate), feeRate: rate, feeSource: source,
    latencyCost: shares * (market - inp.signalPrice), slippageCost: shares * (fill - market),
  };
}

export interface ExitInput { triggerTs: number; triggerEvalTs: number | null; triggerPrice: number; triggerUsd: number; obs: PriceObs | null; market: MarketCfg | null }
export interface ExitResult {
  status: FillStatus; reason: string | null; timing: Timing; sharesToSell: number; soldShares: number; proceeds: number;
  marketPrice: number | null; marketObsTs: number | null; fillPrice: number | null; slippageTicks: number; fee: number; slippageCost: number; latencyCost: number;
}
/** Simulate selling `shares` when the source wallet exits. Unsold shares stay open (to a later exit or resolution). */
export function simulateExit(inp: ExitInput, shares: number, cfg: ExecConfig): ExitResult {
  const timing = timeline(inp.triggerTs, inp.triggerEvalTs, cfg);
  const none = (status: FillStatus, reason: string, extra: Partial<ExitResult> = {}): ExitResult => ({ status, reason, timing, sharesToSell: shares, soldShares: 0, proceeds: 0, marketPrice: null, marketObsTs: null, fillPrice: null, slippageTicks: 0, fee: 0, slippageCost: 0, latencyCost: 0, ...extra });
  if (!(shares > 0)) return none("INVALID", "NOTHING_TO_SELL");
  let market: number; let obsTs: number | null;
  if (cfg.fillAtSignalPrice) { market = inp.triggerPrice; obsTs = inp.triggerTs; }
  else { const u = usableObs(inp.obs, timing.fillTs, cfg); if (!u.ok) return none(u.status, u.reason); market = inp.obs!.price; obsTs = inp.obs!.ts; }
  const tick = tickFor(market, inp.market, cfg);
  const capUsd = cfg.participation == null ? Infinity : cfg.participation * inp.triggerUsd;
  const wantUsd = shares * market; const ratio = inp.triggerUsd > 0 ? Math.min(1, wantUsd / inp.triggerUsd) : 1;
  const slipTicks = cfg.spreadTicks + cfg.impactTicksAtFullParticipation * ratio;
  const fill = slipTicks > 0 ? roundDown(market - slipTicks * tick, tick) : market;
  if (!(fill > 0)) return none("UNFILLED", "NO_BID_AFTER_SLIPPAGE", { marketPrice: market, marketObsTs: obsTs });
  const sold = Math.min(shares, capUsd / fill);
  const minShares = cfg.fillAtSignalPrice ? 0 : inp.market?.minOrderShares ?? cfg.defaultMinOrderShares;
  if (!(sold > 0) || (sold < minShares && sold < shares)) return none("UNFILLED", "INSUFFICIENT_LIQUIDITY", { marketPrice: market, marketObsTs: obsTs, fillPrice: fill });
  const { rate } = feeRateFor(inp.market, cfg);
  return { status: sold >= shares - 1e-9 ? "FILLED" : "PARTIALLY_FILLED", reason: sold >= shares - 1e-9 ? null : "LIQUIDITY_CAP", timing, sharesToSell: shares, soldShares: sold, proceeds: sold * fill,
    marketPrice: market, marketObsTs: obsTs, fillPrice: fill, slippageTicks: (market - fill) / tick, fee: takerFee(sold, fill, rate), slippageCost: sold * (market - fill), latencyCost: sold * (inp.triggerPrice - market) };
}

/** Full lifecycle of one position: entry → (optional) exit → (optional) resolution → otherwise open, marked (not executed). */
export interface Lifecycle {
  entry: ExecResult; exit: ExitResult | null;
  resolution: { ts: number; value: number; shares: number; proceeds: number } | null;
  openShares: number; mark: { ts: number; price: number } | null;
  costBasis: number; proceeds: number; fees: number; grossPnl: number; netPnl: number; realizedPnl: number; unrealizedPnl: number;
  closedAt: number | null; state: "OPEN" | "EXITED" | "PARTIALLY_EXITED" | "RESOLVED" | "NOT_ENTERED";
}
export function lifecycle(entry: ExecResult, exit: { input: ExitInput } | null, resolution: { ts: number; value: number } | null, mark: { ts: number; price: number } | null, cfg: ExecConfig): Lifecycle {
  const base = { exit: null, resolution: null, openShares: 0, mark: null, costBasis: 0, proceeds: 0, fees: 0, grossPnl: 0, netPnl: 0, realizedPnl: 0, unrealizedPnl: 0, closedAt: null };
  if (entry.filledShares <= 0) return { entry, ...base, state: "NOT_ENTERED" };
  let open = entry.filledShares; let proceeds = 0; let fees = entry.fee; let ex: ExitResult | null = null; let closedAt: number | null = null;
  // Exits and resolutions only count if they happen after the fill (a trigger before our fill closes nothing of ours).
  if (exit && exit.input.triggerTs >= entry.timing.fillTs && !(resolution && resolution.ts <= timeline(exit.input.triggerTs, exit.input.triggerEvalTs, cfg).fillTs)) {
    ex = simulateExit(exit.input, open, cfg); open -= ex.soldShares; proceeds += ex.proceeds; fees += ex.fee; if (ex.soldShares > 0) closedAt = ex.timing.fillTs;
  }
  let res: Lifecycle["resolution"] = null;
  if (resolution && resolution.ts >= entry.timing.fillTs && open > 1e-12) { res = { ts: resolution.ts, value: resolution.value, shares: open, proceeds: open * resolution.value }; proceeds += res.proceeds; open = 0; closedAt = resolution.ts; }
  const soldCost = (entry.filledShares - open) / entry.filledShares * entry.filledUsd;
  const realizedGross = proceeds - soldCost;
  const m = open > 0 && mark && mark.ts >= entry.timing.fillTs ? mark : null;
  const unrealized = m ? open * m.price - (entry.filledUsd - soldCost) : 0;
  const state: Lifecycle["state"] = open <= 1e-12 ? (res ? "RESOLVED" : "EXITED") : ex && ex.soldShares > 0 ? "PARTIALLY_EXITED" : "OPEN";
  return { entry, exit: ex, resolution: res, openShares: open, mark: m, costBasis: entry.filledUsd, proceeds, fees, grossPnl: realizedGross + unrealized, netPnl: realizedGross + unrealized - fees, realizedPnl: realizedGross - fees, unrealizedPnl: unrealized, closedAt, state };
}
