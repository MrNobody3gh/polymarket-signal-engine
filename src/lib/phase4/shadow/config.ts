/**
 * Phase 4.1 — shadow order-book measurement: constants (versioned, D106) and the flag parsing.
 *
 * `SHADOW_BOOKS` unset, empty or "0" → off, silently counted as the default. "1" → on. Anything else (e.g. "true", "yes") → OFF with one
 * logged line, never on (the PAPER_PORTFOLIO_DRY_RUN precedent). The two numeric flags are only read when the feature is on, and a malformed
 * one also turns the feature off with one line. Off means: no request and no database call from this job.
 */

/** Bump when OFFSETS_S, SIZES_USD, DEPTH_LEVELS or the fill rules change: it is stored on every row, so results of two versions are never mixed. */
export const SCHEMA_VERSION = 1;
/** Seconds after the signal's created_at at which the public book is read (D106). */
export const OFFSETS_S: readonly number[] = [0, 60, 300];
/** Dollars of stake for the hypothetical taker buys (D106). */
export const SIZES_USD: readonly number[] = [10, 25, 100];
/** Levels stored per side (the fill walk uses the whole book; only the stored copy is cut). */
export const DEPTH_LEVELS = 10;
/** A snapshot more than this many seconds after its due time is recorded as MISSED with no data: a late book would bias the measurement. */
export const MAX_LATE_S = 120;
/** Signals older than this (seconds) are not looked at when the job starts or restarts: only an outage shorter than this is back-filled with MISSED rows. */
export const LOOKBACK_S = 2 * 3600;
/** Raw snapshots are kept this many days (D106), then pruned by the job in bounded deletes. */
export const RETENTION_DAYS = 45;

export const CYCLE_MS = 15_000;
/** At most this many snapshots (network reads) per cycle. */
export const MAX_SNAPSHOTS_PER_CYCLE = 20;
/** At most this many MISSED rows (no network) written per cycle, so a long outage is back-filled gradually. */
export const MAX_MISSED_PER_CYCLE = 200;
/** No new snapshot is started after this much wall time in a cycle (the 500 ms pacing floor makes a snapshot cost 0.5 s with a cached fee rate and 1 s without, so a cycle does at most about 14-28 of them: far above the expected ~0.03 per second). */
export const CYCLE_BUDGET_MS = 14_000;
/** Signals read per page while looking for due work; at most MAX_PAGES pages per cycle. */
export const PAGE_SIZE = 200; export const MAX_PAGES = 5;
export const DEFAULT_DAILY_REQUESTS = 20_000;
/** The fee rate of a token is cached this long (and at most FEE_CACHE_MAX tokens), so a token is not asked about at every offset. */
export const FEE_CACHE_TTL_S = 3600; export const FEE_CACHE_MAX = 500;
/** Pruning: run at most this often, at most PRUNE_BATCH rows per delete and PRUNE_MAX_BATCHES deletes per run. */
export const PRUNE_EVERY_S = 3600; export const PRUNE_BATCH = 100; export const PRUNE_MAX_BATCHES = 20;
/** After a refusal the job pauses for these many seconds (doubling at each consecutive refusal, to the cap), then tries again. It never retries inside a cycle and never works around the refusal. */
export const REFUSAL_PAUSE_S = 60; export const REFUSAL_PAUSE_MAX_S = 3600;

export const CLOB_BASE = "https://clob.polymarket.com";
export const USER_AGENT = "polymarket-signal-engine-shadow-books/4.1 (read-only public order-book measurement; no orders, no account; contact: repository owner)";

export interface ShadowConfig { minScore: number; dailyRequests: number }
export type ShadowSetup = { on: false; config: null } | { on: true; config: ShadowConfig };

/** Read the flags once per boot. Never throws. */
export function shadowSetup(env: Record<string, string | undefined> = process.env, log: (m: string) => void = console.log): ShadowSetup {
  const off = (why: string): ShadowSetup => { log(`shadow books: off (${why})`); return { on: false, config: null }; };
  const raw = env.SHADOW_BOOKS;
  if (raw === undefined || raw === "" || raw === "0") return off("SHADOW_BOOKS unset or 0");
  if (raw !== "1") return off(`invalid configuration: SHADOW_BOOKS must be 0 or 1, got ${JSON.stringify(raw)}`);
  const num = (name: string, v: string | undefined, dflt: number, ok: (n: number) => boolean): number | null => {
    if (v === undefined || v === "") return dflt;
    if (!/^\d+(\.\d+)?$/.test(v.trim())) return null; const n = Number(v); return ok(n) ? n : null;
  };
  const minScore = num("SHADOW_BOOKS_MIN_SCORE", env.SHADOW_BOOKS_MIN_SCORE, 0, (n) => n >= 0 && n <= 100);
  if (minScore === null) return off(`invalid configuration: SHADOW_BOOKS_MIN_SCORE must be a number from 0 to 100, got ${JSON.stringify(env.SHADOW_BOOKS_MIN_SCORE)}`);
  const daily = num("SHADOW_BOOKS_DAILY_REQUESTS", env.SHADOW_BOOKS_DAILY_REQUESTS, DEFAULT_DAILY_REQUESTS, (n) => Number.isInteger(n) && n >= 1 && n <= 172_800);
  if (daily === null) return off(`invalid configuration: SHADOW_BOOKS_DAILY_REQUESTS must be a whole number from 1 to 172800, got ${JSON.stringify(env.SHADOW_BOOKS_DAILY_REQUESTS)}`);
  log(`shadow books: on · offsets ${OFFSETS_S.join("/")} s · sizes $${SIZES_USD.join("/$")} · min score ${minScore} · daily request budget ${daily} · read-only public order books, no orders`);
  return { on: true, config: { minScore, dailyRequests: daily } };
}
