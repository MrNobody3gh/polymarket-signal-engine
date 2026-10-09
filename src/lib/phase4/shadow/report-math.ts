/**
 * Phase 4.1 report arithmetic shared by the report modules: the cluster-robust mean, and the sample-size arithmetic behind the power note. Pure.
 */
export interface MeanCi { n: number; clusters: number; mean: number | null; se: number | null; lo: number | null; hi: number | null }
/** Mean of `xs` with a cluster-robust standard error (clusters = markets: signals on one market are not independent) and a normal 95 % interval. */
export function clusterMean(xs: readonly number[], clusters: readonly string[], z = 1.96): MeanCi {
  const n = xs.length; if (!n) return { n: 0, clusters: 0, mean: null, se: null, lo: null, hi: null };
  const m = xs.reduce((a, b) => a + b, 0) / n; const by = new Map<string, { s: number; k: number }>();
  for (let i = 0; i < n; i++) { const e = by.get(clusters[i]) ?? { s: 0, k: 0 }; e.s += xs[i]; e.k++; by.set(clusters[i], e); }
  const g = by.size; if (g < 2) return { n, clusters: g, mean: m, se: null, lo: null, hi: null };
  let ss = 0; for (const { s, k } of by.values()) ss += (s - m * k) ** 2;
  const se = Math.sqrt((g / (g - 1)) * ss) / n;
  return { n, clusters: g, mean: m, se, lo: m - z * se, hi: m + z * se };
}

// ───────────────────────────────────────── sample-size arithmetic (the power note) ─────────────────────────────────────────
/** The per-trade return SD (points of price) the owner quoted for settled outcomes (about 88). A figure from the brief, not measured by this report. */
export const RETURN_SD_PTS = 88;
export const Z_95 = 1.96; export const Z_POWER_80 = 0.8416212335729143;
/** Independent observations whose mean has a 95 % interval of ± `halfWidth`, given a standard deviation `sd` (same units). */
export const nForHalfWidth = (sd: number, halfWidth: number): number => Math.ceil(((Z_95 * sd) / halfWidth) ** 2);
/** Observations to detect a true mean difference `diff` with a two-sided 5 % test and 80 % power, given `sd`. */
export const nForPower = (sd: number, diff: number): number => Math.ceil((((Z_95 + Z_POWER_80) * sd) / diff) ** 2);
/** Observations (signals) a mean needs for a 95 % half-width of `target`, extrapolated from the standard error observed at `n` (the error shrinks with 1/√n). null when no error was estimated. */
export const nFromSe = (n: number, se: number | null, target: number): number | null => (se !== null && se > 0 && n > 0 && target > 0 ? Math.ceil(n * ((Z_95 * se) / target) ** 2) : null);
