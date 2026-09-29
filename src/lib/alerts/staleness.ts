/**
 * D22 — no alerts for signals detected too late.
 *
 * lag = evaluation time − source trade time (`signals.evaluated_at` − `signals.created_at`), computed once, when the
 * engine evaluates the fill. A signal is late when lag is STRICTLY greater than ALERT_MAX_LAG_HOURS (default 1, D23).
 * A late signal is stored, gets its paper ledger row and consensus event and stays visible everywhere; only the alert
 * push (Telegram subscribers, the admin chat, and Discord/email, which share `dispatch`) is skipped.
 */
/** D23 (29 Sep 2026): 1 hour. The owner first decided 6 h (D22); the 29 Sep re-score showed backfills 1.1-5.7 h late that a 6 h rule cannot catch. */
export const DEFAULT_ALERT_MAX_LAG_HOURS = 1;
export const STALE_ALERT_KIND = "stale_alert_suppressed";
const SUMMARY_WINDOW_SEC = 60;

/** Strict parse: a plain positive decimal number of hours. Anything else (empty, 0, negative, text, hex, exponent,
 *  Infinity) falls back to the default and says so; the rule is never disabled by a bad value. */
export function parseMaxLagHours(raw: string | number | undefined | null): { hours: number; warning: string | null } {
  if (raw === undefined || raw === null) return { hours: DEFAULT_ALERT_MAX_LAG_HOURS, warning: null };
  const t = String(raw).trim();
  const n = /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  if (Number.isFinite(n) && n > 0) return { hours: n, warning: null };
  return { hours: DEFAULT_ALERT_MAX_LAG_HOURS, warning: `alerts: invalid ALERT_MAX_LAG_HOURS=${JSON.stringify(String(raw))} (want a positive number of hours); using ${DEFAULT_ALERT_MAX_LAG_HOURS}` };
}

/** Detection lag in seconds (both arguments are unix seconds). */
export const detectionLagSec = (evaluatedAtSec: number, sourceTsSec: number) => evaluatedAtSec - sourceTsSec;

/** Late = strictly more than the threshold. Exactly at the threshold is still fresh. */
export const isStaleLag = (lagSec: number, maxLagHours: number) => lagSec * 1000 > Math.round(maxLagHours * 3_600_000);

// One warning per process, however many engines a serverless route builds.
let warned = false;
export function resolveMaxLagHours(raw: string | number | undefined | null, log: (m: string) => void): number {
  const { hours, warning } = parseMaxLagHours(raw);
  if (warning && !warned) { warned = true; log(warning); }
  return hours;
}
/** Test hook: forget that the invalid-value warning was already logged. */
export function resetStaleWarning() { warned = false; }

/** Rate-limited visibility: the first suppression of a window is logged at once, the rest of the window is one summary
 *  line (a replay burst is never one line per signal). The summary is flushed by an unref'd timer, so a burst that
 *  ends is still reported, and never keeps a process alive. */
export class StaleAlertLog {
  private pending = 0; private maxLagH = 0; private windowStart = -Infinity; private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private log: (m: string) => void, private thresholdHours: number) {}
  note(lagSec: number, nowSec: number) {
    const lagH = lagSec / 3600;
    if (nowSec - this.windowStart >= SUMMARY_WINDOW_SEC) {
      this.flush(); this.windowStart = nowSec;
      this.log(`alerts: suppressed 1 stale alert (detected ${lagH.toFixed(1)} h after the trade, limit ${this.thresholdHours} h); further ones this minute are summarised`);
      this.arm(); return;
    }
    this.pending++; this.maxLagH = Math.max(this.maxLagH, lagH);
    this.arm();
  }
  private arm() { if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.flush(); }, SUMMARY_WINDOW_SEC * 1000); this.timer.unref?.(); }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.pending) return;
    this.log(`alerts: suppressed ${this.pending} more stale alert(s) in the last minute (max lag ${this.maxLagH.toFixed(1)} h, limit ${this.thresholdHours} h)`);
    this.pending = 0; this.maxLagH = 0;
  }
}
