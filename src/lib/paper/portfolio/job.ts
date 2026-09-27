/**
 * The portfolio job and the worker's 15-minute simulation cycle (docs/PHASE3_PLAN.md §G, §J step 8).
 *
 *   cycle: orphans → Phase 2 sweep → portfolio job, one at a time under one busy guard
 *   job:   runPortfolios (mode by mode) → savePortfolioSnapshot → heartbeat health:last_portfolio
 *
 * PAPER_PORTFOLIO_CONFIG is read once per boot by `portfolioJobSetup`. Unset → the job does not exist: the cycle makes
 * exactly the calls it made before Phase 3 and logs one "portfolio: off" line at boot. Invalid → the error is logged
 * once and the feature is off; nothing else changes. PAPER_PORTFOLIO_DRY_RUN=1 → portfolios are computed with
 * dryRun (nothing written) and the would-be result is logged instead of saving the snapshot or heartbeat.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModeName } from "../sim/config";
import { heartbeat } from "../../health/heartbeat";
import { PORTFOLIO_MODES, PortfolioConfigError, portfolioRunConfigFromEnv, type PortfolioRunConfig } from "./config";
import { runPortfolios, type PortfolioRunStats } from "./run";
import { savePortfolioSnapshot } from "./report";

export interface PortfolioJobDeps {
  config: PortfolioRunConfig | null;
  dryRun?: boolean;
  modes?: ModeName[];
  now?: () => number;
  log?: (m: string) => void;
  run?: typeof runPortfolios;
  snapshot?: typeof savePortfolioSnapshot;
  beat?: (db: SupabaseClient, value: string) => Promise<void>;
}

export interface ModeResult {
  mode: ModeName; portfolioId: string | null; watermark: number | null; rowsRead: number; decisions: Record<string, number>;
  rewound: boolean; rewindTo: number | null; rewindDistanceSec: number; firstReason: string | null; rewindsLast20: number; enqueued: number;
  writes: Record<string, number>; deletes: Record<string, number>; durationMs: number; heapBeforeMb: number | null; heapAfterMb: number | null;
  skipped?: "LEASE_HELD"; failed?: string;
}
export type PortfolioJobResult = { off: true } | { off?: false; dryRun: boolean; modes: ModeResult[]; snapshotSaved: boolean; durationMs: number };

/** Read the configuration once at boot. Never throws: an invalid value turns the feature off with one logged line. */
export function portfolioJobSetup(env: Record<string, string | undefined> = process.env, now = Math.floor(Date.now() / 1000), log: (m: string) => void = console.log): PortfolioJobDeps {
  const dryRun = env.PAPER_PORTFOLIO_DRY_RUN === "1";
  try {
    const config = portfolioRunConfigFromEnv(env, now);
    if (!config) { log("portfolio: off (PAPER_PORTFOLIO_CONFIG unset)"); return { config: null, dryRun }; }
    log(`portfolio: on${dryRun ? " (dry run: nothing written)" : ""} · start ${config.startIso} · capital $${config.portfolio.startingCapitalUsd} · $${config.portfolio.positionUsd}/position`);
    return { config, dryRun };
  } catch (e) {
    const msg = e instanceof PortfolioConfigError ? e.message : `PAPER_PORTFOLIO_CONFIG: ${(e as Error).message}`;
    log(`portfolio: off (invalid configuration) — ${msg}`);
    return { config: null, dryRun };
  }
}

const summarise = (s: PortfolioRunStats, mode: ModeName): ModeResult => ({
  mode, portfolioId: s.portfolioId, watermark: s.watermark, rowsRead: s.rowsRead, decisions: s.decisions,
  rewound: s.rewind.to != null || s.rewind.reasons.length > 0, rewindTo: s.rewind.to, rewindDistanceSec: s.rewindDistanceSec ?? 0, firstReason: s.rewind.reasons[0] ?? null,
  rewindsLast20: s.rewindsLast20 ?? 0, enqueued: s.enqueued ?? 0, writes: s.writes, deletes: s.deletes, durationMs: s.durationMs,
  heapBeforeMb: s.memory?.before.heapUsedMb ?? null, heapAfterMb: s.memory?.after.heapUsedMb ?? null, ...(s.skipped ? { skipped: s.skipped } : {}),
});
const iso = (t: number | null) => (t == null ? "—" : new Date(t * 1000).toISOString().slice(0, 19) + "Z");
export const modeLine = (r: ModeResult) => r.failed ? `${r.mode}: FAILED — ${r.failed}` : r.skipped ? `${r.mode}: skipped (lease held by another runner)`
  : `${r.mode}: watermark ${iso(r.watermark)} · ${r.rowsRead} rows · ${r.rewound ? `rewound ${r.rewindDistanceSec}s (${r.firstReason ?? "—"})` : "no rewind"} · rewinds in last 20 runs: ${r.rewindsLast20}${r.enqueued ? ` · queued ${r.enqueued} price(s)` : ""} · wrote ${JSON.stringify(r.writes)} · deleted ${JSON.stringify(r.deletes)} · heap ${r.heapBeforeMb}→${r.heapAfterMb} MB`;

/**
 * One portfolio pass. Modes run one after another; a mode that throws (a lost lease, a failed rewind) is reported and
 * the others still run. The snapshot and heartbeat follow only if at least one mode completed; if every mode failed the
 * job throws. Unset config → { off: true } and nothing is touched.
 */
export async function runPortfolioJob(db: SupabaseClient, deps: PortfolioJobDeps): Promise<PortfolioJobResult> {
  if (!deps.config) return { off: true };
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000)); const log = deps.log ?? console.log; const t0 = Date.now();
  const run = deps.run ?? runPortfolios; const snap = deps.snapshot ?? savePortfolioSnapshot;
  const beat = deps.beat ?? ((d: SupabaseClient, v: string) => heartbeat(d, "last_portfolio", v));
  const dryRun = !!deps.dryRun; const modes: ModeResult[] = [];
  for (const mode of deps.modes ?? PORTFOLIO_MODES) {
    try { const [s] = await run(db, { config: deps.config, modes: [mode], dryRun, now, log: () => {} }); modes.push(summarise(s, mode)); }
    catch (e) { modes.push({ mode, portfolioId: null, watermark: null, rowsRead: 0, decisions: {}, rewound: false, rewindTo: null, rewindDistanceSec: 0, firstReason: null, rewindsLast20: 0, enqueued: 0, writes: {}, deletes: {}, durationMs: 0, heapBeforeMb: null, heapAfterMb: null, failed: (e as Error).message }); }
  }
  for (const m of modes) log(`[portfolio] ${modeLine(m)}`);
  const ok = modes.filter((m) => !m.failed);
  if (!ok.length) throw new Error(`portfolio: every mode failed (${modes.map((m) => `${m.mode}: ${m.failed}`).join("; ")})`);
  let snapshotSaved = false;
  if (dryRun) log(`[portfolio] dry run: nothing written; snapshot and heartbeat not saved`);
  else {
    await snap(db, { config: deps.config, now }); snapshotSaved = true;
    await beat(db, JSON.stringify({ at: new Date(now() * 1000).toISOString(), modes: modes.map((m) => ({ mode: m.mode, watermark: m.watermark, rewound: m.rewound, failed: m.failed ?? null, skipped: m.skipped ?? null })) }));
  }
  return { dryRun, modes, snapshotSaved, durationMs: Date.now() - t0 };
}

/**
 * The worker's 15-minute cycle: orphans → sweep → portfolio job, never overlapping itself (a call while one is running
 * returns immediately). Each step is isolated: a failure is logged and the next step, and the next cycle, still run.
 * With no portfolio job (config unset or invalid) it is exactly the pre-Phase-3 cycle.
 */
export function makeSimCycle(steps: { orphans: () => Promise<unknown>; sim: () => Promise<unknown>; portfolio: (() => Promise<unknown>) | null; error?: (what: string, e: unknown) => void }) {
  let busy = false;
  const error = steps.error ?? ((what: string, e: unknown) => console.error(`${what} failed`, (e as Error).message));
  const cycle = async () => {
    if (busy) return { ran: false as const };
    busy = true;
    try {
      try { await steps.orphans(); } catch (e) { error("orphans", e); }
      let sim: unknown = null; try { sim = await steps.sim(); } catch (e) { error("sim", e); }
      let portfolio: unknown = null; if (steps.portfolio) { try { portfolio = await steps.portfolio(); } catch (e) { error("portfolio", e); } }
      return { ran: true as const, sim, portfolio };
    } finally { busy = false; }
  };
  return Object.assign(cycle, { busy: () => busy });
}
