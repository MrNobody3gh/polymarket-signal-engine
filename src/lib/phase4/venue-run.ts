/**
 * Phase 4.0d, Part A — one venue per process. The 4.0–4.0c runs died or were killed out of memory (exit 134 / 137) because one process held the
 * listings of two or three venues at once. A run with `--venue <id>` touches ONLY that venue, writes a compact per-venue evidence file
 * (`v_<venue>_audit.json`, `v_<venue>_coverage.json`, `v_<venue>_titles.json`), and drops its raw markets before it exits; `npm run phase4:merge`
 * later combines the files (no network, no database). This module holds what the three runners share:
 *
 *  - the venue ids and the file names;
 *  - `MemoryGuard`: an in-process heap budget (default 350 MB of the ~500 MB the temporary Railway service has) checked at every page and stage;
 *    exceeding it STOPS the run with a message naming the venue and the stage (`HeapBudgetExceeded`), it never crashes the process;
 *  - `VenueScope`: a process scoped to one venue refuses to enter a stage of another (defence in depth: the CLIs also never build the other venues' stages);
 *  - the shapes of the evidence files, with a schema number.
 * Read-only by construction: nothing here touches a network, a database or a file.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { INTERNATIONAL, US_EXCHANGE } from "./venues";
import { KALSHI } from "./timestamps";

export const VENUE_IDS = [INTERNATIONAL, US_EXCHANGE, KALSHI] as const;
export type VenueId = (typeof VENUE_IDS)[number];
const ALIASES: Record<string, VenueId> = { polymarket_intl: INTERNATIONAL, intl: INTERNATIONAL, international: INTERNATIONAL, polymarket_us: US_EXCHANGE, us: US_EXCHANGE, kalshi: KALSHI };
/** A venue id or one of its short aliases (`us`, `intl`); null for anything else (including `both`, which is the all-in-one mode, not a venue). */
export const parseVenueId = (s: string | undefined | null): VenueId | null => (s ? ALIASES[s.trim().toLowerCase()] ?? null : null);
export const VENUE_LABEL: Record<VenueId, string> = { polymarket_intl: "international platform (signal source)", polymarket_us: "US exchange", kalshi: "Kalshi" };
export const VENUE_SHORT: Record<VenueId, string> = { polymarket_intl: "Intl", polymarket_us: "US", kalshi: "Kalshi" };

export const EVIDENCE_SCHEMA = 1;
export type EvidenceKind = "audit" | "coverage" | "titles";
export const evidenceFile = (venue: VenueId, kind: EvidenceKind): string => `v_${venue}_${kind}.json`;

// ───────────────────────────────────────────── heap budget ──────────────────────────────────────────────────

/** The default in-process budget: 350 MB of heap in use (the temporary Railway service dies at about 500 MB; the margin is for the garbage collector and the response being parsed). */
export const DEFAULT_HEAP_BUDGET_MB = 350;
export class HeapBudgetExceeded extends Error {
  readonly venue: string; readonly stage: string; readonly usedMb: number; readonly budgetMb: number;
  constructor(venue: string, stage: string, usedMb: number, budgetMb: number) {
    super(`STOPPED (heap budget): venue ${venue}, stage "${stage}": ${usedMb.toFixed(0)} MB of heap in use exceeds the budget of ${budgetMb} MB (--heap-budget-mb). Nothing further was fetched for this venue; run it alone in its own process, lower its cap, or raise the budget.`);
    this.name = "HeapBudgetExceeded"; this.venue = venue; this.stage = stage; this.usedMb = usedMb; this.budgetMb = budgetMb;
  }
}
/** `setStage` names what the process is doing ("kalshi: open listing"); `check` is called before every request and between stages, with an optional detail ("request 41"). */
export interface Guard { setStage(stage: string, venue?: string): void; check(detail?: string): void }
const defaultHeapUsed = (): number => process.memoryUsage().heapUsed;
/**
 * A garbage collection on demand, without a command-line flag (`--expose-gc` is switched on at run time). `heapUsed` counts garbage that has not been collected
 * yet, and the host kills the process on what it holds, not on what is alive; the guard therefore collects BEFORE it decides to stop, so the budget is judged
 * on live data. null when this runtime cannot do it.
 */
let gcFn: (() => void) | null | undefined;
export function collectGarbage(): void {
  if (gcFn === undefined) { try { const g = (globalThis as { gc?: () => void }).gc; if (typeof g === "function") gcFn = g; else { setFlagsFromString("--expose-gc"); const x = runInNewContext("gc") as unknown; gcFn = typeof x === "function" ? (x as () => void) : null; } } catch { gcFn = null; } }
  gcFn?.();
}
/** Checks the heap in use against a budget. `heapUsed` is injectable so tests can drive it exactly; with an injected meter nothing is collected unless `collect` is given too. */
export class MemoryGuard implements Guard {
  /** the venue the process is working on (fixed in a `--venue` run; follows the stages in an all-in-one run) */ venue: string; readonly budgetMb: number; private meter: () => number; private collect: (() => void) | null; peakMb = 0; checks = 0; stage = "start"; collections = 0;
  constructor(o: { venue: string; budgetMb?: number; heapUsed?: () => number; collect?: (() => void) | null }) { this.venue = o.venue; this.budgetMb = o.budgetMb !== undefined && o.budgetMb > 0 ? o.budgetMb : DEFAULT_HEAP_BUDGET_MB; this.meter = o.heapUsed ?? defaultHeapUsed; this.collect = o.collect !== undefined ? o.collect : o.heapUsed ? null : collectGarbage; }
  setStage(stage: string, venue?: string): void { this.stage = stage; if (venue) this.venue = venue; this.check(); }
  check(detail?: string): void {
    this.checks++; let mb = this.meter() / (1024 * 1024);
    if (mb > this.budgetMb && this.collect) { this.collect(); this.collections++; mb = this.meter() / (1024 * 1024); } // judge live data, not garbage
    if (mb > this.peakMb) this.peakMb = mb;
    if (mb > this.budgetMb) throw new HeapBudgetExceeded(this.venue, detail ? `${this.stage}, ${detail}` : this.stage, mb, this.budgetMb);
  }
}
/** A guard that never stops (the all-in-one commands without a budget keep their old behaviour). */
export const NO_GUARD: Guard = { setStage() {}, check() {} };

/** Exit code of a run that stopped on the heap budget (0 finished, 1 failed, 2 configuration, 3 stopped by the budget with a message and a partial evidence file). */
export const EXIT_BUDGET = 3;

// ───────────────────────────────────────────── venue scope ──────────────────────────────────────────────────

export class VenueScopeError extends Error { constructor(scope: string, asked: string, stage: string) { super(`venue scope violation: this process is scoped to ${scope} but stage "${stage}" asked for ${asked}; one process never holds two venues`); this.name = "VenueScopeError"; } }
/** A process scoped to one venue. `enter` is called at the start of each venue-specific stage. */
export class VenueScope {
  readonly venue: VenueId; readonly entered: string[] = [];
  constructor(venue: VenueId) { this.venue = venue; }
  enter(venue: VenueId, stage: string): void { if (venue !== this.venue) throw new VenueScopeError(this.venue, venue, stage); this.entered.push(stage); }
}

// ───────────────────────────────────────────── evidence files ───────────────────────────────────────────────

/** Why a run ended before it finished; null in a finished file. A stopped run still writes its file so the merge shows "stopped", not "not run". */
export interface StopInfo { reason: "heap_budget" | "refused" | "error"; stage: string; message: string }
export interface HeapInfo { budgetMb: number; peakMb: number }
export const heapInfo = (g: MemoryGuard | null | undefined): HeapInfo | null => (g ? { budgetMb: g.budgetMb, peakMb: Math.round(g.peakMb * 10) / 10 } : null);

/** Parse an evidence file's text; null when it is missing, not JSON, of another kind, venue or schema. */
export function parseEvidence<T extends { schema: number; kind: EvidenceKind; venue: string }>(text: string | null, kind: EvidenceKind, venue: VenueId): T | null {
  if (!text) return null;
  try { const j = JSON.parse(text) as T; return j && j.schema === EVIDENCE_SCHEMA && j.kind === kind && j.venue === venue ? j : null; } catch { return null; }
}
