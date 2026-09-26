/**
 * Scoring: turn a wallet's raw API numbers into "is the edge real, and could I
 * actually follow it?" Pure functions, no I/O — see tests/score.test.ts.
 *
 * The same formula produced the published snapshot, so the live engine and the
 * dashboard agree.
 */
import type { UserPnlPoint, UserStats, WalletProfile, WalletStyle } from "../polymarket/types";

export const DAY = 86_400;

export interface Curve { ts: number; pnl: number }

export function curveFromPoints(points: UserPnlPoint[], field: "position_pnl" | "realized_pnl" = "position_pnl"): Curve[] {
  return points
    .map((p) => ({ ts: Number(p.timestamp), pnl: Number(p[field] ?? p.position_pnl ?? 0) }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.pnl))
    .sort((a, b) => a.ts - b.ts);
}

/** PnL over the trailing `days` ending at `now` from a CUMULATIVE curve:
 *  last point minus the last point at/before the window start (0 if the curve
 *  begins inside the window — cumulative PnL is 0 at inception by definition). */
export function windowPnl(curve: Curve[], now: number, days = 90): number {
  if (curve.length === 0) return 0;
  const start = now - days * DAY;
  let base = 0;
  for (const p of curve) { if (p.ts <= start) base = p.pnl; else break; }
  const last = curve[curve.length - 1];
  return last.ts <= start ? 0 : last.pnl - base;
}

/** Max peak-to-trough on the cumulative curve, seeded at 0 before the first point. */
export function maxDrawdown(curve: Curve[]): { maxDdUsd: number; peak: number; moves: number } {
  if (curve.length === 0) return { maxDdUsd: 0, peak: 0, moves: 0 };
  const series = curve[0].pnl !== 0 ? [{ ts: curve[0].ts - DAY, pnl: 0 }, ...curve] : curve;
  let peak = series[0].pnl, maxDd = 0, moves = 0;
  for (let i = 0; i < series.length; i++) {
    const v = series[i].pnl;
    if (i > 0 && v !== series[i - 1].pnl) moves++;
    if (v > peak) peak = v;
    maxDd = Math.max(maxDd, peak - v);
  }
  return { maxDdUsd: maxDd, peak: Math.max(...series.map((s) => s.pnl)), moves };
}

/** Calendar months inside the window that finished up. */
export function monthsUp(curve: Curve[], now: number, days = 90): { up: number; total: number } {
  const start = now - days * DAY;
  const byMonth = new Map<string, { first: number; last: number }>();
  let prevPnl = 0;
  for (const p of curve) {
    if (p.ts < start) { prevPnl = p.pnl; continue; }
    const m = new Date(p.ts * 1000).toISOString().slice(0, 7);
    const e = byMonth.get(m);
    if (!e) byMonth.set(m, { first: prevPnl, last: p.pnl }); else e.last = p.pnl;
    prevPnl = p.pnl;
  }
  // month delta = last of month − last of previous month (first is carried in)
  const months = [...byMonth.entries()].sort();
  let up = 0;
  for (const [, v] of months) if (v.last - v.first > 0) up++;
  return { up, total: months.length };
}

export function programShare(stats: UserStats | null): number | null {
  const a = stats?.all_time_pnl; if (!a) return null;
  const prog = (a.maker_rebate ?? 0) + (a.taker_rebate ?? 0) + (a.reward_income ?? 0) + (a.referral_income ?? 0) + (a.yield_income ?? 0);
  const total = (a.realized_market_pnl ?? 0) + (a.realized_combo_pnl ?? 0) + (a.realized_lp_pnl ?? 0) + prog;
  if (total <= 0) return prog > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, prog / total));
}

export function concentration(stats: UserStats | null): number | null {
  const a = stats?.all_time_pnl; if (!a || !stats) return null;
  const realized = (a.realized_market_pnl ?? 0) + (a.realized_combo_pnl ?? 0);
  if (realized <= 0) return null;
  return Math.max(0, Math.min(1, (stats.biggest_win ?? 0) / realized));
}

export function classifyStyle(i: { fillsPerDay: number | null; programShare: number | null; concentration: number | null; edgePerDollar: number | null }): WalletStyle {
  if ((i.fillsPerDay ?? 0) > 500 || (i.programShare ?? 0) > 0.25) return "Market maker / bot";
  if ((i.concentration ?? 0) > 0.4) return "Lottery ticket";
  if ((i.edgePerDollar ?? 0) > 0.2) return "Concentrated directional";
  if ((i.fillsPerDay ?? 0) > 150) return "High-frequency directional";
  return "Selective directional";
}

export interface ScoreInput {
  pnl90d: number; netDd: number | null; monthsUp: number; monthsTotal: number; fillsPerDay: number | null;
  programShare: number | null; concentration: number | null; edgePerDollar: number | null; daysIdle: number | null; rankable: boolean;
}

/** 0–100. Higher = more plausibly copyable AND profitable recently. */
export function copyScore(i: ScoreInput): number {
  if (i.pnl90d <= 0) return 0;
  let s = Math.min(40, 13 * Math.log10(Math.max(i.pnl90d, 1) / 1000));
  s += Math.min(20, Math.max(0, i.netDd ?? 0) * 1.5);
  s += 15 * (i.monthsTotal ? i.monthsUp / i.monthsTotal : 0);
  const fpd = i.fillsPerDay ?? 0;
  if (fpd > 500) s -= 25; else if (fpd > 150) s -= 8;
  s -= 30 * Math.max(0, (i.programShare ?? 0) - 0.1);
  s -= 20 * Math.max(0, (i.concentration ?? 0) - 0.4);
  const epd = i.edgePerDollar ?? 0;
  if (epd >= 0.03 && epd <= 0.25) s += 10;
  const idle = i.daysIdle ?? 0;
  if (idle > 14) s -= 15;
  if (idle > 30) s -= 15;
  if (!i.rankable) s -= 10;
  return Math.round(Math.max(0, Math.min(100, s)) * 10) / 10;
}

/** Full profile from the three API reads the refresh job makes per wallet. */
/** Measured activity (from scoring/activity.ts). When absent or INSUFFICIENT_DATA, fills/day is unknown — never 0 — and the
 *  wallet cannot be "rankable" (the existing −10 penalty), so missing data can never score better than measured data. */
export interface MeasuredActivity { status: "OK" | "LOWER_BOUND" | "INSUFFICIENT_DATA" | null; fillsPerDay: number | null }
export function buildProfile(address: string, name: string | null, stats: UserStats | null, points: UserPnlPoint[], now: number, sources: string[] = [], activity: MeasuredActivity | null = null): WalletProfile {
  const curve = curveFromPoints(points);
  const pnl90d = windowPnl(curve, now, 90);
  const dd = maxDrawdown(curve);
  const mu = monthsUp(curve, now, 90);
  const a = stats?.all_time_pnl ?? null;
  const realized = (a?.realized_market_pnl ?? 0) + (a?.realized_combo_pnl ?? 0);
  const curveDays = curve.length ? Math.max(1, Math.round((curve[curve.length - 1].ts - curve[0].ts) / DAY) + 1) : 0;
  const tradeCount = stats?.trade_count ?? null;
  const measured = activity && activity.status !== "INSUFFICIENT_DATA" && activity.fillsPerDay != null;
  // Measured activity wins. An explicit INSUFFICIENT_DATA stays unknown (null) — never replaced by a weaker proxy or by 0.
  const fillsPerDay = measured ? activity!.fillsPerDay : activity == null && tradeCount != null && curveDays > 0 ? tradeCount / curveDays : null;
  const volume = stats?.volume_usdc ?? 0;
  const edgePerDollar = volume > 0 ? realized / volume : null;
  const lastMove = [...curve].reverse().find((p, idx, arr) => idx < arr.length - 1 && p.pnl !== arr[idx + 1].pnl);
  const daysIdle = curve.length ? Math.max(0, Math.round((now - (lastMove?.ts ?? curve[0].ts)) / DAY)) : null;
  const netDd = dd.maxDdUsd > 0 ? realized / dd.maxDdUsd : null;
  const ps = programShare(stats); const conc = concentration(stats);
  const rankable = (tradeCount ?? 0) >= 100 && curveDays >= 60 && dd.moves >= 10 && fillsPerDay != null;
  const score = copyScore({ pnl90d, netDd, monthsUp: mu.up, monthsTotal: mu.total, fillsPerDay, programShare: ps, concentration: conc, edgePerDollar, daysIdle, rankable });
  return {
    address: address.toLowerCase(), name, copyScore: score, pnl90d: Math.round(pnl90d * 100) / 100,
    style: classifyStyle({ fillsPerDay, programShare: ps, concentration: conc, edgePerDollar }),
    fillsPerDay, programShare: ps, concentration: conc, netDd, monthsUp: mu.up, monthsTotal: mu.total, daysIdle, tradeCount, sources,
  };
}
