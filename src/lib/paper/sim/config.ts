/**
 * Execution-simulation configuration. Three frozen modes; every number is labelled with where it comes from.
 * Change these only BEFORE looking at results (see docs/PAPER_EXECUTION.md §"Do not overfit").
 */
export type ModeName = "IDEAL" | "REALISTIC" | "CONSERVATIVE";
export type Provenance = "OBSERVED" | "DERIVED" | "CONFIGURED" | "APPROXIMATED";

export interface ExecConfig {
  mode: ModeName;
  /** IDEAL only: fill at the signal price with no market lookup (the original ledger methodology). */
  fillAtSignalPrice: boolean;
  /** Seconds from the source trade to our evaluation, used ONLY when the evaluation time was not recorded. */
  assumedDetectionLatencySec: number;
  /** Seconds from evaluation to order submission (a human or bot reading the alert and acting). */
  decisionLatencySec: number;
  /** Seconds from submission to match. */
  executionLatencySec: number;
  /** If the latest observed trade is older than this at fill time, the fill price is UNKNOWN (not guessed). */
  maxQuoteAgeSec: number;
  /** If fill time is later than this after the source trade, the order EXPIRES. null = never expires. */
  maxSignalAgeSec: number | null;
  /** Ticks paid beyond the last trade when crossing the spread (buys above, sells below). */
  spreadTicks: number;
  /** Extra ticks of impact when the order equals the source trade's notional (scales linearly). */
  impactTicksAtFullParticipation: number;
  /** Max order notional as a multiple of the source trade's notional (the only liquidity evidence we have). null = unlimited. */
  participation: number | null;
  /** Fees: "none" (IDEAL) or "market" (per-market flag/rate, falling back to fallbackFeeRate when unknown). */
  feeModel: "none" | "market";
  /** Taker fee rate used when a market's fee status is unknown. */
  fallbackFeeRate: number;
  /** Tick size when the market's is unknown. */
  defaultTickSize: number;
  /** Minimum order in shares when the market's is unknown. */
  defaultMinOrderShares: number;
  /** Notional per independent experiment (existing project convention). */
  paperSizeUsd: number;
}

const paperSize = () => { const v = Number(process.env.PAPER_SIZE_USD); return Number.isFinite(v) && v > 0 ? v : 100; };

export const MODES: Record<ModeName, ExecConfig> = {
  IDEAL: { mode: "IDEAL", fillAtSignalPrice: true, assumedDetectionLatencySec: 0, decisionLatencySec: 0, executionLatencySec: 0, maxQuoteAgeSec: Infinity, maxSignalAgeSec: null, spreadTicks: 0, impactTicksAtFullParticipation: 0, participation: null, feeModel: "none", fallbackFeeRate: 0, defaultTickSize: 0.01, defaultMinOrderShares: 0, paperSizeUsd: paperSize() },
  REALISTIC: { mode: "REALISTIC", fillAtSignalPrice: false, assumedDetectionLatencySec: 134, decisionLatencySec: 5, executionLatencySec: 5, maxQuoteAgeSec: 3600, maxSignalAgeSec: null, spreadTicks: 1, impactTicksAtFullParticipation: 1, participation: 1, feeModel: "market", fallbackFeeRate: 0.05, defaultTickSize: 0.01, defaultMinOrderShares: 5, paperSizeUsd: paperSize() },
  CONSERVATIVE: { mode: "CONSERVATIVE", fillAtSignalPrice: false, assumedDetectionLatencySec: 3173, decisionLatencySec: 60, executionLatencySec: 15, maxQuoteAgeSec: 900, maxSignalAgeSec: 3600, spreadTicks: 2, impactTicksAtFullParticipation: 3, participation: 0.5, feeModel: "market", fallbackFeeRate: 0.07, defaultTickSize: 0.01, defaultMinOrderShares: 5, paperSizeUsd: paperSize() },
};

/** Where each assumption comes from. Rendered into docs and the dashboard. */
export const ASSUMPTIONS: { key: string; provenance: Provenance; note: string }[] = [
  { key: "source trade time", provenance: "OBSERVED", note: "Block timestamp of the wallet's fill from the Polymarket trade feed." },
  { key: "latency label", provenance: "OBSERVED", note: "Each record carries latency_source = OBSERVED (evaluation time recorded) or ESTIMATED (median/p90 fallback). Estimated latency is never reported as measured." },
  { key: "evaluation time", provenance: "OBSERVED", note: "signals.evaluated_at (new) or paper_ledger.created_at for signals evaluated live; unavailable for the 470 V1 signals back-filled on 18 Sep." },
  { key: "assumedDetectionLatencySec", provenance: "DERIVED", note: "Only when evaluation time is missing. REALISTIC = median (134 s) and CONSERVATIVE = 90th percentile (3,173 s) of observed source→evaluation latency over 36,197 live signals, 18–26 Sep 2026." },
  { key: "decision/execution latency", provenance: "CONFIGURED", note: "Reading the alert and submitting/matching an order. Not observable — no orders were placed." },
  { key: "market price at execution", provenance: "OBSERVED", note: "Last trade at or before the simulated fill time from /v2/prices-history?as_of; only complete buckets ending at or before fill time are used." },
  { key: "spreadTicks", provenance: "APPROXIMATED", note: "Historical order books are not available. Crossing a one-tick spread (REALISTIC) or two ticks (CONSERVATIVE) is assumed." },
  { key: "impact", provenance: "APPROXIMATED", note: "Linear in order notional ÷ source-trade notional. No depth data exists to calibrate it." },
  { key: "liquidity / participation", provenance: "APPROXIMATED", note: "The source wallet's own fill proves at least that notional traded at that time; the follower may take up to 1× (REALISTIC) or 0.5× (CONSERVATIVE) of it. Orders beyond that are partially filled." },
  { key: "tick size / min order", provenance: "OBSERVED", note: "Gamma orderPriceMinTickSize / orderMinSize when present; else 0.01 and 5 shares (Polymarket defaults). Tick drops to 0.001 below 0.04 / above 0.96 (DERIVED from Polymarket tick rules)." },
  { key: "fees", provenance: "OBSERVED", note: "Taker fee = shares × feeRate × p × (1 − p) (docs.polymarket.com/trading/fees). Per trade the provenance is recorded: OBSERVED_FEE_FREE (feesEnabled=false), OBSERVED_RATE, ASSUMED_RATE (fees on, rate not provided → 0.05 REALISTIC / 0.07 CONSERVATIVE), ASSUMED_UNKNOWN (no metadata). The flag is read today and applied to past trades: DERIVED, because Polymarket sets fee status per market at deployment ('fees apply only to markets deployed on or after the activation date'); fee_observed_at records when it was read." },
  { key: "resolution value", provenance: "OBSERVED", note: "/v2/resolutions payouts (micro-USDC per share) with resolved_at; settlement is not an execution (no slippage, no fee)." },
  { key: "marks (1h/6h/24h)", provenance: "OBSERVED", note: "Observations only. Never used as execution prices." },
];

/** Stable short hash of a config (for reproducibility records). */
export function configHash(c: unknown): string {
  const s = JSON.stringify(c, (_k, v) => (v === Infinity ? "Infinity" : v), 2);
  let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Portfolio limits have NO defaults: the operator must choose them (PAPER_PORTFOLIO_CONFIG JSON). */
export interface PortfolioConfig {
  startingCapitalUsd: number; positionUsd: number; maxMarketExposureUsd: number; maxTotalExposurePct: number;
  maxOpenPositions: number; maxWalletAllocationUsd: number; minCashReserveUsd: number; allowResize: boolean;
}
export function portfolioConfigFromEnv(env: Record<string, string | undefined> = process.env): PortfolioConfig | null {
  if (!env.PAPER_PORTFOLIO_CONFIG) return null;
  const c = JSON.parse(env.PAPER_PORTFOLIO_CONFIG) as Partial<PortfolioConfig>;
  const req: (keyof PortfolioConfig)[] = ["startingCapitalUsd", "positionUsd", "maxMarketExposureUsd", "maxTotalExposurePct", "maxOpenPositions", "maxWalletAllocationUsd", "minCashReserveUsd", "allowResize"];
  const missing = req.filter((k) => c[k] === undefined);
  if (missing.length) throw new Error(`PAPER_PORTFOLIO_CONFIG missing: ${missing.join(", ")}`);
  return c as PortfolioConfig;
}
