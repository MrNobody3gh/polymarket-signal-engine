/**
 * Phase 4.0 (S1b) — the pre-registration feasibility table (docs/PHASE4_PLAN.md §3.6 MIN_SETTLED_PER_ARM / MAX_WINDOW,
 * §7 S2 "feasibility rule", D48). Pure arithmetic over settled paper trades; the numbers come from the data it is
 * given and nothing is tuned.
 *
 * Approximations, stated once (also printed in the result):
 *  - the per-trade return and holding time come from settled trades only, which favour quick markets (plan §1 caveats);
 *  - the "eligible-like" subset is a proxy (copy score ≥ 68 and a date-level end date on the signal's UTC day or the
 *    next), because the real eligibility needs venue timestamps that history does not have;
 *  - the design effect is estimated from market clustering in that data (one-way ANOVA) and applied to both arms;
 *  - the days-to-sample model assumes a constant daily rate and that acceptance is independent of holding time.
 */
import { daysToSample, designEffect, mean, quantile, sampleSizePerArm, sd } from "./stats";

export interface SettledTrade {
  signalId: string; conditionId: string; wallet: string;
  /** Net return per dollar staked, in percentage points of stake (so +9.1 % → 9.1). */
  returnPts: number;
  /** Days from fill to settlement (exit or resolution). */
  holdDays: number;
  eligibleLike: boolean;
}
export const WINDOW_DAYS = 84; // MAX_WINDOW: 12 weeks
export const EFFECTS_PTS = [10, 15] as const;
export const ACCEPT_RATES = [0.1, 0.25, 0.5] as const;

export interface SubsetStats { name: string; n: number; markets: number; wallets: number; meanPts: number | null; sdPts: number | null; icc: number | null; deff: number; deffNote: string | null; holdP50Days: number | null; holdP90Days: number | null }
export interface EffectRow { effectPts: number; perArmIndependent: number | null; perArmClustered: number | null }
export interface DaysRow { effectPts: number; acceptRate: number; lag: "median" | "p90"; lagDays: number; perArm: number; days: number | null; feasibleWithinWindow: boolean | null }
export interface WhatChanges { effectPts: number; acceptRate: number; /** eligible signals per day needed to reach perArm inside the window with the p90 lag */ requiredEligiblePerDay: number | null; /** smallest effect (points) detectable inside the window at the measured eligible rate and the p90 lag */ minDetectableEffectPts: number | null }
export interface FeasibilityResult {
  windowDays: number; eligiblePerDay: { value: number; basis: string } | null; settledShare: number;
  subsets: { stats: SubsetStats; sampleSize: EffectRow[]; days: DaysRow[]; whatChanges: WhatChanges[] }[];
  assumptions: string[];
}

export function subsetStats(name: string, t: SettledTrade[]): SubsetStats {
  const rets = t.map((x) => x.returnPts); const de = designEffect(rets, t.map((x) => x.conditionId)); const hold = t.map((x) => x.holdDays);
  return { name, n: t.length, markets: new Set(t.map((x) => x.conditionId)).size, wallets: new Set(t.map((x) => x.wallet)).size, meanPts: mean(rets), sdPts: sd(rets), icc: de.icc, deff: de.deff, deffNote: de.note, holdP50Days: quantile(hold, 0.5), holdP90Days: quantile(hold, 0.9) };
}

export function buildFeasibility(trades: SettledTrade[], o: { eligiblePerDay: { value: number; basis: string } | null; settledShare?: number; windowDays?: number }): FeasibilityResult {
  const W = o.windowDays ?? WINDOW_DAYS; const share = o.settledShare ?? 1;
  const sets: [string, SettledTrade[]][] = [["all settled trades", trades], ["eligible-like subset (proxy)", trades.filter((t) => t.eligibleLike)]];
  const subsets = sets.map(([name, t]) => {
    const stats = subsetStats(name, t); const sdv = stats.sdPts;
    if (!sdv || sdv <= 0 || t.length < 2) return { stats, sampleSize: EFFECTS_PTS.map((e) => ({ effectPts: e, perArmIndependent: null, perArmClustered: null })), days: [] as DaysRow[], whatChanges: [] as WhatChanges[] };
    const sampleSize: EffectRow[] = EFFECTS_PTS.map((e) => ({ effectPts: e, perArmIndependent: sampleSizePerArm({ sd: sdv, effect: e }), perArmClustered: sampleSizePerArm({ sd: sdv, effect: e, deff: stats.deff }) }));
    const days: DaysRow[] = []; const whatChanges: WhatChanges[] = [];
    for (const row of sampleSize) for (const a of ACCEPT_RATES) for (const [lag, lagDays] of [["median", stats.holdP50Days ?? 0], ["p90", stats.holdP90Days ?? 0]] as const) {
      const perArm = row.perArmClustered!;
      const d = o.eligiblePerDay ? daysToSample({ perArm, eligiblePerDay: o.eligiblePerDay.value, acceptRate: a, settlementLagDays: lagDays, settledShare: share }) : null;
      days.push({ effectPts: row.effectPts, acceptRate: a, lag, lagDays, perArm, days: d, feasibleWithinWindow: d === null ? null : d <= W });
    }
    const lag90 = stats.holdP90Days ?? 0;
    for (const row of sampleSize) for (const a of ACCEPT_RATES) {
      const usable = W - lag90; const perArm = row.perArmClustered!; const scarce = Math.min(a, 1 - a) * share;
      const req = usable > 0 ? perArm / (usable * scarce) : null;
      let minEff: number | null = null;
      if (o.eligiblePerDay && usable > 0) { const nAvail = o.eligiblePerDay.value * scarce * usable; if (nAvail > 0) minEff = solveMinEffect(sdv, stats.deff, nAvail); }
      whatChanges.push({ effectPts: row.effectPts, acceptRate: a, requiredEligiblePerDay: req, minDetectableEffectPts: minEff });
    }
    return { stats, sampleSize, days, whatChanges };
  });
  return { windowDays: W, eligiblePerDay: o.eligiblePerDay, settledShare: share, subsets, assumptions: [
    "settled trades only (favours quick markets); spread, impact and liquidity are approximated in the simulation",
    "eligible-like subset is a proxy: copy score ≥ 68 and a date-level end date on the signal's UTC day or the next; it includes events that had already started",
    "design effect from one-way ANOVA on market clusters, applied to both arms; negative intra-class correlation is clamped to zero",
    "days = settlement lag + per-arm sample ÷ (eligible per day × settled share × min(accept, 1 − accept)); constant daily rate, acceptance independent of holding time",
    "relative metric: difference of two arm means, two-sided α = 0.05, power 80 %, equal arm variance",
  ] };
}

/** The smallest effect δ with sampleSizePerArm(sd, δ, deff) ≤ nAvail, by bisection on the closed form (monotone in δ). */
export function solveMinEffect(sdv: number, deff: number, nAvail: number): number {
  let lo = 1e-6, hi = 10_000;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (sampleSizePerArm({ sd: sdv, effect: mid, deff }) <= nAvail) hi = mid; else lo = mid; }
  return hi;
}
