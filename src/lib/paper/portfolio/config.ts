/**
 * Portfolio run configuration (docs/PHASE3_PLAN.md §C, D4, D5; step 6 R1).
 *
 * The operator supplies everything in PAPER_PORTFOLIO_CONFIG (JSON). There are no defaults, ever: an unset variable
 * turns the feature off. On top of the Phase 2 parser (sim/config.ts portfolioConfigFromEnv, unchanged) this:
 *  - rejects unknown keys (a typo such as "maxOpenPosition" would otherwise be silently ignored),
 *  - checks every value's range,
 *  - requires an explicit `startTs`: the completion instant of the 27 Sep 2026 re-score (D4), copied from
 *    cursors['refresh:last'].updated_at right after that run. It is never derived at runtime (that cursor is
 *    overwritten daily), must carry a timezone, and may not be in the future,
 *  - derives one portfolio per execution mode, with an id that changes whenever anything that affects results does.
 */
import { MODES, configHash, portfolioConfigFromEnv, type ModeName, type PortfolioConfig } from "../sim/config";
import { stableHash } from "./requests";

export const PORTFOLIO_MODES: ModeName[] = ["IDEAL", "REALISTIC", "CONSERVATIVE"];
const FIELDS: (keyof PortfolioConfig)[] = ["startingCapitalUsd", "positionUsd", "maxMarketExposureUsd", "maxTotalExposurePct", "maxOpenPositions", "maxWalletAllocationUsd", "minCashReserveUsd", "allowResize"];
export const IDEAL_LABEL = "IDEAL is a non-causal baseline: it fills at the source trade's own time, before the signal could have been known (plan B10). It is for comparison only, not a strategy that could have been run.";

export interface PortfolioRunConfig { portfolio: PortfolioConfig; startTs: number; startIso: string }
export interface PortfolioDefinition { id: string; mode: ModeName; execConfigHash: string; configHash: string; startTs: number; config: Record<string, unknown> }

export class PortfolioConfigError extends Error { constructor(msg: string) { super(`PAPER_PORTFOLIO_CONFIG: ${msg}`); this.name = "PortfolioConfigError"; } }

/** Pure: validate a parsed config object (all fields required, ranges checked, unknown keys rejected). */
export function validatePortfolioConfig(raw: Record<string, unknown>, nowSec: number): PortfolioRunConfig {
  const unknown = Object.keys(raw).filter((k) => k !== "startTs" && !FIELDS.includes(k as keyof PortfolioConfig));
  if (unknown.length) throw new PortfolioConfigError(`unknown key(s) ${unknown.join(", ")} (allowed: ${[...FIELDS, "startTs"].join(", ")})`);
  const missing = [...FIELDS, "startTs"].filter((k) => raw[k] === undefined);
  if (missing.length) throw new PortfolioConfigError(`missing ${missing.join(", ")}; there are no defaults`);
  const num = (k: keyof PortfolioConfig) => { const v = raw[k]; if (typeof v !== "number" || !Number.isFinite(v)) throw new PortfolioConfigError(`${k} must be a finite number, got ${JSON.stringify(v)}`); return v; };
  const c: PortfolioConfig = { startingCapitalUsd: num("startingCapitalUsd"), positionUsd: num("positionUsd"), maxMarketExposureUsd: num("maxMarketExposureUsd"), maxTotalExposurePct: num("maxTotalExposurePct"),
    maxOpenPositions: num("maxOpenPositions"), maxWalletAllocationUsd: num("maxWalletAllocationUsd"), minCashReserveUsd: num("minCashReserveUsd"), allowResize: raw.allowResize as boolean };
  const need = (ok: boolean, msg: string) => { if (!ok) throw new PortfolioConfigError(msg); };
  need(typeof raw.allowResize === "boolean", `allowResize must be true or false, got ${JSON.stringify(raw.allowResize)}`);
  need(c.startingCapitalUsd > 0, "startingCapitalUsd must be > 0");
  need(c.positionUsd > 0, "positionUsd must be > 0");
  need(c.positionUsd <= c.startingCapitalUsd, "positionUsd cannot exceed startingCapitalUsd");
  need(c.maxMarketExposureUsd > 0, "maxMarketExposureUsd must be > 0");
  need(c.maxWalletAllocationUsd > 0, "maxWalletAllocationUsd must be > 0");
  need(c.maxTotalExposurePct > 0 && c.maxTotalExposurePct <= 100, "maxTotalExposurePct must be in (0, 100]");
  need(Number.isInteger(c.maxOpenPositions) && c.maxOpenPositions >= 1, "maxOpenPositions must be an integer ≥ 1");
  need(c.minCashReserveUsd >= 0 && c.minCashReserveUsd < c.startingCapitalUsd, "minCashReserveUsd must be ≥ 0 and below startingCapitalUsd");
  const s = raw.startTs;
  need(typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s), `startTs must be an ISO timestamp with a timezone, e.g. "2026-09-27T04:26:41Z" (got ${JSON.stringify(s)})`);
  const ms = Date.parse(s as string); need(Number.isFinite(ms), `startTs is not a valid time: ${s}`);
  const startTs = Math.floor(ms / 1000);
  need(startTs <= nowSec, `startTs ${s} is in the future`);
  return { portfolio: c, startTs, startIso: new Date(startTs * 1000).toISOString() };
}

/** PAPER_PORTFOLIO_CONFIG → validated config, or null when unset (feature off). Throws on any invalid value. */
export function portfolioRunConfigFromEnv(env: Record<string, string | undefined> = process.env, nowSec = Math.floor(Date.now() / 1000)): PortfolioRunConfig | null {
  if (!env.PAPER_PORTFOLIO_CONFIG) return null;
  let raw: unknown; try { raw = JSON.parse(env.PAPER_PORTFOLIO_CONFIG); } catch (e) { throw new PortfolioConfigError(`not valid JSON (${(e as Error).message})`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PortfolioConfigError("must be a JSON object");
  const cfg = validatePortfolioConfig(raw as Record<string, unknown>, nowSec); // clearer errors first
  portfolioConfigFromEnv(env);                                                  // and the Phase 2 parser agrees
  return cfg;
}

/** hash(mode, execution config, portfolio config, start): 32 hex characters (the table allows 8–64). */
export function portfolioIdFor(mode: ModeName, execConfigHash: string, portfolioConfigHash: string, startTs: number): string {
  return stableHash({ mode, execConfigHash, portfolioConfigHash, startTs }, 32);
}

/** One portfolio per execution mode. */
export function portfolioDefinitions(cfg: PortfolioRunConfig, modes: ModeName[] = PORTFOLIO_MODES): PortfolioDefinition[] {
  const pch = configHash(cfg.portfolio);
  return modes.map((mode) => {
    const ech = configHash(MODES[mode]);
    return { id: portfolioIdFor(mode, ech, pch, cfg.startTs), mode, execConfigHash: ech, configHash: pch, startTs: cfg.startTs,
      config: { ...cfg.portfolio, startTs: cfg.startIso, ...(mode === "IDEAL" ? { nonCausalBaseline: true, note: IDEAL_LABEL } : {}) } };
  });
}
