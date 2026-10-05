/**
 * Phase 4.1 — the shadow order-book job: a flag-gated, failure-isolated worker job that records PUBLIC order-book snapshots (never an order, an
 * account, a key or an authenticated call). Modelled on the portfolio job (src/lib/paper/portfolio/job.ts):
 *
 *   off (SHADOW_BOOKS unset/0/malformed) → `runCycle` returns at once: NO request and NO database call (tests/phase4-shadow-job.test.ts)
 *   own busy guard                       → a cycle that starts while one runs returns immediately
 *   own time budget per cycle            → no new snapshot starts after CYCLE_BUDGET_MS
 *   own request budget                   → per cycle (MAX_SNAPSHOTS_PER_CYCLE) and per UTC day (SHADOW_BOOKS_DAILY_REQUESTS), restart-safe
 *   a refusal (401/403/451/429)          → recorded as REFUSED, the cycle ends, the job pauses (doubling to REFUSAL_PAUSE_MAX_S), no retry, no workaround
 *   `runShadowCycleSafely`               → never throws; one log line and a status heartbeat per failed cycle; the signal sweep, the paper simulation,
 *                                          the portfolio runner and the alerts are separate timers and never see this job's errors
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PoliteHttp } from "../http";
import { heartbeat } from "../../health/heartbeat";
import { CYCLE_BUDGET_MS, MAX_MISSED_PER_CYCLE, MAX_SNAPSHOTS_PER_CYCLE, PRUNE_BATCH, PRUNE_EVERY_S, PRUNE_MAX_BATCHES, REFUSAL_PAUSE_MAX_S, REFUSAL_PAUSE_S, RETENTION_DAYS, USER_AGENT, type ShadowConfig } from "./config";
import { planWork, isTooLate } from "./schedule";
import { FeeCache, missedRow, takeSnapshot, type ShadowRow } from "./snapshot";
import { existingKeys, insertRows, loadWindow, pruneBatch, requestsSince } from "./store";

export interface ShadowJobDeps {
  db: SupabaseClient; config: ShadowConfig | null;
  /** tests inject a client over a fake fetch; production builds the polite client below */
  http?: PoliteHttp;
  nowSec?: () => number; clockMs?: () => number; log?: (m: string) => void;
  beat?: (db: SupabaseClient, value: string) => Promise<void>;
}
export interface CycleStats {
  off?: true; skipped?: "BUSY" | "PAUSED" | "DAILY_BUDGET"; snapshots: number; missed: number; requests: number; refused: boolean; pausedUntilSec: number | null;
  statuses: Record<string, number>; pruned: number; durationMs: number; usedToday: number;
}
const emptyStats = (): CycleStats => ({ snapshots: 0, missed: 0, requests: 0, refused: false, pausedUntilSec: null, statuses: {}, pruned: 0, durationMs: 0, usedToday: 0 });

/** The polite client of this job: ≤ 2 requests/s in total (one instance, one gap), a 429 is returned at once (the job pauses), the event list is not kept. */
export const makeShadowHttp = (o: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): PoliteHttp =>
  new PoliteHttp({ ...o, userAgent: USER_AGENT, minIntervalMs: 500, maxAttempts: 2, retryRateLimited: false, recordEvents: false, blockedStop: 1_000_000 });

export class ShadowJob {
  private busy = false; private day: string | null = null; private used = 0; private budgetLogged = false;
  private pausedUntil = 0; private consecutiveRefusals = 0; private lastPrune = -Infinity;
  readonly fees = new FeeCache(); private http: PoliteHttp | null = null;
  private nowSec: () => number; private clockMs: () => number; private log: (m: string) => void;
  constructor(private d: ShadowJobDeps) {
    this.nowSec = d.nowSec ?? (() => Math.floor(Date.now() / 1000)); this.clockMs = d.clockMs ?? (() => Date.now()); this.log = d.log ?? console.log;
  }
  isBusy() { return this.busy; }

  async runCycle(): Promise<CycleStats> {
    const stats = emptyStats();
    if (!this.d.config) return { ...stats, off: true }; // OFF: nothing below runs — no request, no database call
    if (this.busy) return { ...stats, skipped: "BUSY" };
    this.busy = true; const t0 = this.clockMs();
    try { return await this.cycle(this.d.config, stats, t0); } finally { this.busy = false; stats.durationMs = Math.round(this.clockMs() - t0); }
  }

  private async cycle(cfg: ShadowConfig, stats: CycleStats, t0: number): Promise<CycleStats> {
    const now = this.nowSec(); const http = (this.http ??= this.d.http ?? makeShadowHttp());
    if (now < this.pausedUntil) { stats.skipped = "PAUSED"; stats.pausedUntilSec = this.pausedUntil; return stats; }
    // The daily request budget, from the rows themselves (restart-safe), re-read once per UTC day.
    const day = new Date(now * 1000).toISOString().slice(0, 10);
    if (this.day !== day) { this.used = await requestsSince(this.d.db, `${day}T00:00:00.000Z`); this.day = day; this.budgetLogged = false; }
    const startReq = http.requests;
    const spent = () => this.used + (http.requests - startReq);

    const window = await loadWindow(this.d.db, now, (sig) => planWork(sig, new Set(), now, { minScore: cfg.minScore, maxSnapshots: Infinity, maxMissed: Infinity }).snapshots.length >= MAX_SNAPSHOTS_PER_CYCLE * 2);
    const have = await existingKeys(this.d.db, window.map((s) => s.id));
    const plan = planWork(window, have, now, { minScore: cfg.minScore, maxSnapshots: MAX_SNAPSHOTS_PER_CYCLE, maxMissed: MAX_MISSED_PER_CYCLE });

    const tally = (r: ShadowRow) => { stats.statuses[r.status] = (stats.statuses[r.status] ?? 0) + 1; };
    if (plan.missed.length) { const rows = plan.missed.map((d) => missedRow(d, now)); await insertRows(this.d.db, rows); rows.forEach(tally); stats.missed += rows.length; }

    for (const due of plan.snapshots) {
      if (this.clockMs() - t0 >= CYCLE_BUDGET_MS) break;
      if (spent() + 2 > cfg.dailyRequests) { if (!this.budgetLogged) { this.log(`shadow books: daily request budget reached (${spent()} of ${cfg.dailyRequests}); no more snapshots today, the rest are recorded as MISSED`); this.budgetLogged = true; } stats.skipped = "DAILY_BUDGET"; break; }
      const at = this.nowSec();
      if (isTooLate(due.dueAtSec, at)) { const row = missedRow(due, at); await insertRows(this.d.db, [row]); tally(row); stats.missed++; continue; } // pacing made it late
      const r = await takeSnapshot(due, { http, fees: this.fees, nowSec: this.nowSec, clockMs: this.clockMs });
      await insertRows(this.d.db, [r.row]); tally(r.row); stats.snapshots++;
      if (r.refused) {
        stats.refused = true; this.consecutiveRefusals++;
        const pause = Math.min(REFUSAL_PAUSE_MAX_S, Math.max(REFUSAL_PAUSE_S * 2 ** (this.consecutiveRefusals - 1), Math.ceil((r.refused.retryAfterMs ?? 0) / 1000)));
        this.pausedUntil = this.nowSec() + pause; stats.pausedUntilSec = this.pausedUntil;
        this.log(`shadow books: the venue refused a request (${r.refused.status ?? "blocked"}): ${r.refused.message}. Not retried, not worked around; paused ${pause}s`);
        break;
      }
      this.consecutiveRefusals = 0;
    }
    stats.requests = http.requests - startReq; this.used += stats.requests; stats.usedToday = this.used;

    // Retention: at most once per PRUNE_EVERY_S, in bounded deletes. A failure here is logged and does not fail the cycle.
    if (now - this.lastPrune >= PRUNE_EVERY_S) {
      this.lastPrune = now;
      try { const cutoff = new Date((now - RETENTION_DAYS * 86400) * 1000).toISOString(); for (let i = 0; i < PRUNE_MAX_BATCHES; i++) { const n = await pruneBatch(this.d.db, cutoff, PRUNE_BATCH); stats.pruned += n; if (n < PRUNE_BATCH) break; } }
      catch (e) { this.log(`shadow books: pruning failed (${(e as Error).message})`); }
    }
    return stats;
  }
}

const line = (s: CycleStats) => `shadow books: ${s.snapshots} snapshot(s), ${s.missed} missed, ${s.requests} request(s), ${JSON.stringify(s.statuses)}${s.refused ? " · REFUSED" : ""}${s.skipped ? ` · ${s.skipped}` : ""}${s.pruned ? ` · pruned ${s.pruned}` : ""} · ${s.durationMs} ms`;

/**
 * The worker's hook: one cycle, never throws. A failure is caught, logged once, and recorded as a status (best effort); the next cycle runs normally.
 * Nothing it does can reach another worker timer.
 */
export async function runShadowCycleSafely(job: ShadowJob, o: { db: SupabaseClient; log?: (m: string) => void; beat?: (db: SupabaseClient, value: string) => Promise<void>; nowSec?: () => number }): Promise<CycleStats | { failed: string }> {
  const log = o.log ?? console.log; const now = o.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const beat = o.beat ?? ((db, v) => heartbeat(db, "last_shadow_books", v));
  try {
    const s = await job.runCycle();
    if (s.off || s.skipped === "BUSY") return s;
    if (s.snapshots || s.missed || s.refused || s.pruned) log(line(s));
    try { await beat(o.db, JSON.stringify({ at: new Date(now() * 1000).toISOString(), ok: true, snapshots: s.snapshots, missed: s.missed, statuses: s.statuses, refused: s.refused, usedToday: s.usedToday })); } catch { /* a status write must never fail the cycle */ }
    return s;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    try { log(`shadow books: cycle failed (${msg}); the signal sweep, paper simulation, portfolio and alerts are not affected`); } catch { /* logging must not throw either */ }
    try { await beat(o.db, JSON.stringify({ at: new Date(now() * 1000).toISOString(), ok: false, error: msg.slice(0, 300) })); } catch { /* best effort */ }
    return { failed: msg };
  }
}
