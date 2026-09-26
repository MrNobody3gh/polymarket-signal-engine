/**
 * Wallet activity → fills per day, from the trade feed the current API actually serves.
 *
 * Why: /v2/user-stats no longer carries a per-fill count at the top level (its `trades` is DISTINCT MARKETS), so the
 * old fills/day was null for every wallet and bot detection silently never fired.
 *
 * Method (documented in docs/BOT_DETECTION.md):
 *   window    = the last ACTIVITY_WINDOW_DAYS calendar days (7)
 *   fills     = rows in /v2/trades?user=…&taker_only=false&start=now−window (maker AND taker fills)
 *   fillsPerDay = fills / window days  — calendar days, matching the original trade_count / curve-days definition
 *   activeDays  = distinct UTC days with ≥1 fill (reported, not used for the threshold)
 * States:
 *   OK                 full window read
 *   LOWER_BOUND        the walk hit ACTIVITY_MAX_ROWS before reaching the window start; fillsPerDay is the rate over the
 *                      span actually read, which is a floor on activity (more fills exist). Only ever makes a wallet MORE bot-like.
 *   INSUFFICIENT_DATA  fetch failed, or zero fills in the window — we cannot classify, and it is NOT treated as zero.
 */
import type { PolymarketClient } from "../polymarket/client";

export const ACTIVITY_WINDOW_DAYS = 7;
/** 4,000 rows in 7 days = 571 fills/day, already above the 500/day bot threshold — reading further cannot change the class. */
export const ACTIVITY_MAX_ROWS = 4000;
export type ActivityStatus = "OK" | "LOWER_BOUND" | "INSUFFICIENT_DATA";
export interface Activity { status: ActivityStatus; reason: string | null; fills: number; windowDays: number; activeDays: number; fillsPerDay: number | null; measuredAt: number }

export async function measureActivity(client: Pick<PolymarketClient, "paginate">, wallet: string, now: number, opts: { windowDays?: number; maxRows?: number; pageSize?: number } = {}): Promise<Activity> {
  const windowDays = opts.windowDays ?? ACTIVITY_WINDOW_DAYS, maxRows = opts.maxRows ?? ACTIVITY_MAX_ROWS; const start = now - windowDays * 86400;
  let fills = 0; let oldest = now; const days = new Set<string>(); let truncated = false;
  try {
    for await (const r of client.paginate<Record<string, unknown>>("/v2/trades", { user: wallet, taker_only: false, start }, { page: opts.pageSize ?? 500 })) {
      const ts = Number(r.timestamp ?? r.ts); if (!Number.isFinite(ts)) continue; if (ts < start) break;
      fills++; oldest = Math.min(oldest, ts); days.add(new Date(ts * 1000).toISOString().slice(0, 10));
      if (fills >= maxRows) { truncated = true; break; }
    }
  } catch (e) { return { status: "INSUFFICIENT_DATA", reason: `FETCH_FAILED: ${(e as Error).message.slice(0, 120)}`, fills: 0, windowDays, activeDays: 0, fillsPerDay: null, measuredAt: now }; }
  if (fills === 0) return { status: "INSUFFICIENT_DATA", reason: "NO_FILLS_IN_WINDOW", fills: 0, windowDays, activeDays: 0, fillsPerDay: null, measuredAt: now };
  if (truncated) { const spanDays = Math.max((now - oldest) / 86400, 1 / 24); return { status: "LOWER_BOUND", reason: "ROW_CAP_REACHED", fills, windowDays: spanDays, activeDays: days.size, fillsPerDay: fills / spanDays, measuredAt: now }; }
  return { status: "OK", reason: null, fills, windowDays, activeDays: days.size, fillsPerDay: fills / windowDays, measuredAt: now };
}

export type BotClass = "MARKET_MAKER" | "BOT_HIGH_FREQUENCY" | "HIGH_FREQUENCY" | "ACTIVE" | "INSUFFICIENT_DATA";
/** Existing thresholds, unchanged: >25% program income = maker; >500 fills/day = software; >150 = high-frequency directional. */
export function botClass(a: { status: ActivityStatus | null; fillsPerDay: number | null }, programShare: number | null): BotClass {
  if ((programShare ?? 0) > 0.25) return "MARKET_MAKER";
  if (a.status == null || a.status === "INSUFFICIENT_DATA" || a.fillsPerDay == null) return "INSUFFICIENT_DATA";
  if (a.fillsPerDay > 500) return "BOT_HIGH_FREQUENCY";
  if (a.fillsPerDay > 150) return "HIGH_FREQUENCY";
  return "ACTIVE";
}

export function activityRow(a: Activity, programShare: number | null) {
  return { fills_per_day: a.fillsPerDay, activity_status: a.status, activity_reason: a.reason, activity_fills: a.fills, activity_window_days: a.windowDays, active_days: a.activeDays,
    activity_measured_at: new Date(a.measuredAt * 1000).toISOString(), bot_class: botClass(a, programShare) };
}
