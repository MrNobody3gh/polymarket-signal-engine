/**
 * Phase 4.0 (S1b) — pure statistics for the pre-registration feasibility table (docs/PHASE4_PLAN.md §3.6, §7 S2, D48).
 * No I/O. Every function states its assumptions; nothing here is tuned against results.
 */

export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Sample standard deviation (n − 1). null for fewer than two values. */
export function sd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!; let s = 0; for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** Quantile by linear interpolation between order statistics (the "R-7" definition). p in [0, 1]. null for no data. */
export function quantile(xs: number[], p: number): number | null {
  if (!xs.length || !(p >= 0 && p <= 1)) return null;
  const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p; const lo = Math.floor(i); const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Inverse of the standard normal CDF (Acklam's rational approximation, one Halley refinement step against an accurate erfc; |error| < 1e-12 in the central range). */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`normInv: p must be in (0, 1), got ${p}`);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const lo = 0.02425; let x: number;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p <= 1 - lo) { const q = p - 0.5; const r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  else { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const e = 0.5 * erfc(-x / Math.SQRT2) - p; const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}
/** Complementary error function to ~1e-13: the Taylor series of erf for |x| < 3, a continued fraction for the tail. */
function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  if (x < 3) { let term = x, sum = x; for (let n = 1; n < 80; n++) { term *= (-x * x) / n; sum += term / (2 * n + 1); } return 1 - (2 / Math.sqrt(Math.PI)) * sum; }
  let t = x; for (let k = 80; k >= 1; k--) t = x + k / 2 / t;
  return Math.exp(-x * x) / (Math.sqrt(Math.PI) * t);
}

export interface SampleSizeInput {
  /** Standard deviation of the per-trade return, in the same unit as `effect` (for example percentage points of stake). */
  sd: number;
  /** Minimum difference between the two arm means that must be detectable (same unit). */
  effect: number;
  alpha?: number;  // two-sided, default 0.05
  power?: number;  // default 0.80
  /** Variance inflation from clustering by market (≥ 1; see designEffect). Default 1 = independent trades. */
  deff?: number;
}
/**
 * Settled trades needed in EACH of two arms to detect a mean difference of `effect` (two-sample comparison, equal
 * variance and size): n = 2 (z(1−α/2) + z(power))² σ² / δ² × DEFF, rounded up.
 * Example: σ 89, δ 10, no clustering → 1,244 per arm (the plan's "about 1,241" is the same calculation to rounding).
 */
export function sampleSizePerArm(i: SampleSizeInput): number {
  const alpha = i.alpha ?? 0.05, power = i.power ?? 0.8, deff = i.deff ?? 1;
  if (!(i.sd > 0) || !(i.effect > 0) || !(deff >= 1)) throw new RangeError("sampleSizePerArm: sd and effect must be > 0 and deff ≥ 1");
  const z = normInv(1 - alpha / 2) + normInv(power);
  return Math.ceil((2 * z * z * i.sd * i.sd * deff) / (i.effect * i.effect));
}

export interface DesignEffect { deff: number; icc: number | null; clusters: number; n: number; meanClusterSizeWeighted: number | null; note: string | null }
/**
 * Market-clustering design effect from one-way ANOVA: ρ = (MSB − MSW) / (MSB + (n0 − 1) MSW) with n0 the unbalanced-design
 * average cluster size, DEFF = 1 + (m − 1) ρ with m the size-weighted mean cluster size (Σ nᵢ² / N). ρ < 0 is clamped to 0
 * (DEFF is never below 1: a plan must not shrink the sample because of sampling noise). With fewer than two clusters, or
 * every cluster a singleton, the effect cannot be estimated and DEFF = 1 with an explanatory note.
 */
export function designEffect(values: number[], clusterIds: string[]): DesignEffect {
  if (values.length !== clusterIds.length) throw new RangeError("designEffect: values and clusterIds differ in length");
  const groups = new Map<string, number[]>(); values.forEach((v, i) => { const g = groups.get(clusterIds[i]); if (g) g.push(v); else groups.set(clusterIds[i], [v]); });
  const N = values.length, k = groups.size;
  const base = { clusters: k, n: N, meanClusterSizeWeighted: null as number | null };
  if (k < 2) return { deff: 1, icc: null, ...base, note: "fewer than two clusters: design effect not estimable (taken as 1)" };
  if (N === k) return { deff: 1, icc: null, ...base, note: "every cluster has one trade: design effect not estimable (taken as 1)" };
  const M = values.reduce((a, b) => a + b, 0) / N; let ssb = 0, ssw = 0, sumSq = 0;
  for (const g of groups.values()) { const m = g.reduce((a, b) => a + b, 0) / g.length; ssb += g.length * (m - M) ** 2; for (const x of g) ssw += (x - m) ** 2; sumSq += g.length ** 2; }
  const msb = ssb / (k - 1), msw = ssw / (N - k), n0 = (N - sumSq / N) / (k - 1);
  const denom = msb + (n0 - 1) * msw;
  const icc = denom > 0 ? Math.max(0, (msb - msw) / denom) : 0; const m = sumSq / N;
  return { deff: 1 + (m - 1) * icc, icc, clusters: k, n: N, meanClusterSizeWeighted: m, note: null };
}

export interface DaysToSampleInput {
  /** Settled trades required in each arm. */
  perArm: number;
  /** Expected eligible signals per day (from the coverage funnel). */
  eligiblePerDay: number;
  /** Share of Grok decisions that are ACCEPT, in (0, 1). The scarcer arm decides how long the window takes. */
  acceptRate: number;
  /** Days from entry to settlement for the slowest trades that still have to settle before the analysis (median or p90 holding time). */
  settlementLagDays: number;
  /** Share of eligible signals that become a settled trade in the independent simulation (fill and settle). Default 1. */
  settledShare?: number;
}
/**
 * Calendar days until BOTH arms hold `perArm` settled trades: accrual of the scarcer arm, plus the settlement lag of its
 * last trades. days = lag + perArm / (eligiblePerDay × settledShare × min(acceptRate, 1 − acceptRate)).
 * Assumes a constant daily rate and independence of acceptance from holding time; both are approximations.
 */
export function daysToSample(i: DaysToSampleInput): number {
  const share = i.settledShare ?? 1;
  if (!(i.eligiblePerDay > 0) || !(i.acceptRate > 0 && i.acceptRate < 1) || !(share > 0) || !(i.perArm > 0) || !(i.settlementLagDays >= 0)) throw new RangeError("daysToSample: invalid input");
  return i.settlementLagDays + i.perArm / (i.eligiblePerDay * share * Math.min(i.acceptRate, 1 - i.acceptRate));
}

export interface WilsonInterval { n: number; k: number; point: number; lo: number; hi: number }
/**
 * Wilson score interval for a proportion k / n (default z = 1.96, a 95 % interval). Unlike the normal approximation it stays inside [0, 1] and is
 * sensible for k = 0, k = n and small n, which is what a 15-row review stratum is. null for n = 0 (nothing was reviewed: no interval exists).
 * Known values: 8/10 → [0.4902, 0.9433]; 0/10 → [0, 0.2775]; 10/10 → [0.7225, 1]; 50/100 → [0.4038, 0.5962].
 */
export function wilson(k: number, n: number, z = 1.96): WilsonInterval | null {
  if (!(Number.isInteger(n) && n >= 0 && Number.isInteger(k) && k >= 0 && k <= n)) throw new RangeError(`wilson: need integers 0 ≤ k ≤ n, got k=${k}, n=${n}`);
  if (!(z > 0)) throw new RangeError("wilson: z must be > 0");
  if (n === 0) return null;
  const p = k / n, z2 = z * z, d = 1 + z2 / n; const c = (p + z2 / (2 * n)) / d; const h = (z / d) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { n, k, point: p, lo: k === 0 ? 0 : Math.max(0, c - h), hi: k === n ? 1 : Math.min(1, c + h) }; // the closed form leaves ±1e-17 at the edges: k = 0 and k = n are exact
}

/** Cheap, dependency-free CSV writing (RFC 4180 quoting). */
export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";
}

/** RFC 4180 CSV reading (the inverse of toCsv): quoted fields, doubled quotes, CRLF or LF, a leading byte-order mark ignored, a final empty line ignored. Spreadsheet programs write this form. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^\uFEFF/, ""); const rows: string[][] = []; let row: string[] = []; let f = ""; let q = false; let i = 0; let any = false;
  for (; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') { q = true; any = true; } else if (c === ",") { row.push(f); f = ""; any = true; } else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; if (any || f !== "") { row.push(f); rows.push(row); } row = []; f = ""; any = false; } else { f += c; any = true; }
  }
  if (any || f !== "") { row.push(f); rows.push(row); }
  return rows;
}
