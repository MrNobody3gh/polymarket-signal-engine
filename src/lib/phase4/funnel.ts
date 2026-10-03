/**
 * Phase 4.0 (S1b) — the eligibility funnel of docs/PHASE4_PLAN.md §3.2 as pure arithmetic over a list of signal rows.
 * The caller (scripts/phase4/coverage-probe.ts) decides each row's mapping, tradability and usable event time; this
 * file only counts, in the brief's order:
 *   all entry signals → copy score ≥ SCORE_MIN → market mapped → venue market tradable → usable event timestamp →
 *   event not started → within 24 h → at least MIN_LEAD of lead (= expected Grok-eligible).
 * Stages are cumulative (a row counts at a stage only if it passed every earlier one). A stage the caller could not
 * measure is reported as null, and so is every stage after it; it is never counted as zero or guessed.
 */
import type { Confidence } from "./mapping";
import { DAY_MS, MAX_HORIZON_MS, MIN_LEAD_MS, easternParts } from "./timestamps";

export const SCORE_MIN = 68;
export const MAX_SIGNAL_AGE_MS = 600_000;
export const STAGES = [
  { key: "all", label: "all entry signals" },
  { key: "score", label: "copy score ≥ 68 (payload.copyScore)" },
  { key: "mapped", label: "market mapped on the execution venue" },
  { key: "tradable", label: "venue market tradable" },
  { key: "timestamp", label: "usable event timestamp (unknown = reject)" },
  { key: "notStarted", label: "event not started" },
  { key: "within24h", label: "within 24 h" },
  { key: "minLead", label: "at least MIN_LEAD of lead = Grok-eligible" },
] as const;
export type StageKey = (typeof STAGES)[number]["key"];
export type VariantName = "EXACT" | "EXACT_PLUS_PROBABLE";

export interface FunnelRow {
  signalId: string;
  /** Source trade time (`signals.created_at`), UTC ms. The day buckets use this. */
  createdAtMs: number;
  /** Time the eligibility chain would have run: `signals.evaluated_at` when observed, else `created_at` (the caller says which). */
  evalMs: number;
  kind: string; wallet: string; category: string;
  /** `payload.copyScore`; null = missing (counts as below the minimum). */
  copyScore: number | null;
  mapping: Confidence | "NOT_MEASURED";
  /** The venue market is tradable (the caller's documented definition); null = unknown (counts as not tradable once measured). */
  tradable: boolean | null;
  /** The usable event time (UTC ms) from the Part B recommended field; null = no usable timestamp (reject). */
  eventMs: number | null;
  /** DB-only proxy: the stored `markets.end_date` falls on the signal's UTC day or the next one. Optional. */
  proxyWithin24h?: boolean | null;
  /** True when `evalMs` is the observed `signals.evaluated_at` (so evalMs − createdAtMs is a real detection lag); false/undefined: the lag is unknown. */
  lagObserved?: boolean;
  /** For the date-level row only (NOT the V1 policy): the Eastern calendar date (YYYY-MM-DD) the venue candidate's placeholder or date-only field implies; null = none. */
  impliedDateEt?: string | null;
}
export interface FunnelConfig {
  startMs: number; endMs: number;
  scoreMin?: number; minLeadMs?: number; horizonMs?: number;
  /** E1 (plan §3.6 MAX_SIGNAL_AGE, proposed 600 s). A SUPPLEMENTARY measure: it is not in the brief's funnel order. */
  maxSignalAgeMs?: number;
  /** Which stages the caller actually measured. Unmeasured stages and everything after them are reported as null. */
  measured: { mapping: boolean; tradable: boolean; timestamp: boolean };
}

export interface PerDay { elapsedDays: number; perElapsedDay: number | null; completeDays: { n: number; mean: number | null; min: number | null; max: number | null }; byWeekday: Record<string, { days: number; mean: number | null; min: number | null; max: number | null }> }
export interface VariantResult {
  /** Cumulative count per stage, in STAGES order; null = not measured. */
  counts: (number | null)[];
  perDay: Record<StageKey, PerDay | null>;
  /** Cumulative count per stage for each kind / category. */
  byKind: Record<string, (number | null)[]>; byCategory: Record<string, (number | null)[]>;
  /** Distinct wallets still present at each stage. */
  wallets: (number | null)[];
  /** Final stage only: the three wallets with the most signals and their share of the final count. */
  top3Share: number | null; topWallets: { wallet: string; count: number; share: number }[];
  /** First-failing-stage counts: where signals leave the funnel. */
  exits: Record<string, number>;
  /** Supplementary (plan E1): of the final-stage signals, those whose observed detection lag (evaluated_at − source trade time) is within MAX_SIGNAL_AGE. null while the final stage is unmeasured. */
  freshAtFinal: { maxSignalAgeMs: number; finalCount: number; lagObserved: number; withinAge: number; perDay: PerDay } | null;
}
export interface FunnelResult {
  window: { startMs: number; endMs: number; elapsedDays: number; completeUtcDays: number };
  stages: typeof STAGES;
  measured: FunnelConfig["measured"];
  variants: Record<VariantName, VariantResult>;
  proxy: { definition: string; scoreAndProxy: number | null; perDay: PerDay | null };
  /** A SECOND funnel line, NOT THE V1 POLICY: time eligibility from the Eastern date implied by placeholder fields. Never an input to the feasibility table. */
  dateLevel: DateLevelFunnel;
}
export const DATE_LEVEL_STAGES = [
  { key: "all", label: "all entry signals" }, { key: "score", label: "copy score ≥ 68" }, { key: "mapped", label: "market mapped" }, { key: "tradable", label: "venue market tradable" },
  { key: "impliedDate", label: "an Eastern calendar date is implied by a placeholder / date-only field" }, { key: "dateToday", label: "that date is the evaluation's Eastern date or the next day" },
] as const;
export interface DateLevelFunnel {
  label: "NOT THE V1 POLICY"; definition: string;
  inPlayCheck: "cannot be evaluated at date level"; leadCheck: "cannot be evaluated at date level";
  stages: typeof DATE_LEVEL_STAGES; variants: Record<VariantName, { counts: (number | null)[]; perDay: PerDay | null }>;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const firstUnmeasured = (m: FunnelConfig["measured"]): number => (!m.mapping ? 2 : !m.tradable ? 3 : !m.timestamp ? 4 : STAGES.length);

/** Per-day statistics over WHOLE UTC days inside [startMs, endMs); the two partial edge days are excluded from the min / max / mean-by-day, and `perElapsedDay` divides by the exact elapsed time. */
export function perDayStats(timesMs: number[], startMs: number, endMs: number): PerDay {
  const elapsedDays = Math.max(0, (endMs - startMs) / DAY_MS);
  const firstDay = Math.ceil(startMs / DAY_MS), lastDay = Math.floor(endMs / DAY_MS); // whole days: [firstDay, lastDay)
  const inWindow = timesMs.filter((t) => t >= startMs && t < endMs);
  const counts = new Map<number, number>(); for (let d = firstDay; d < lastDay; d++) counts.set(d, 0);
  for (const t of inWindow) { const d = Math.floor(t / DAY_MS); if (counts.has(d)) counts.set(d, counts.get(d)! + 1); }
  const vals = [...counts.values()]; const agg = (xs: number[]) => (xs.length ? { mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) } : { mean: null, min: null, max: null });
  const byWd: Record<string, number[]> = {}; for (const [d, n] of counts) (byWd[WEEKDAYS[new Date(d * DAY_MS).getUTCDay()]] ??= []).push(n);
  const byWeekday: PerDay["byWeekday"] = {}; for (const w of WEEKDAYS) if (byWd[w]) byWeekday[w] = { days: byWd[w].length, ...agg(byWd[w]) };
  return { elapsedDays, perElapsedDay: elapsedDays > 0 ? inWindow.length / elapsedDays : null, completeDays: { n: vals.length, ...agg(vals) }, byWeekday };
}

/** The deepest stage (0-based index into STAGES) a row reaches under a variant; −1 = fails stage 0 (never: every row is an entry signal). */
export function deepestStage(r: FunnelRow, variant: VariantName, c: { scoreMin: number; minLeadMs: number; horizonMs: number; measured: FunnelConfig["measured"] }): number {
  if (r.copyScore === null || !(r.copyScore >= c.scoreMin)) return 0;
  const limit = firstUnmeasured(c.measured);
  if (limit <= 2) return 1;
  const mapped = r.mapping === "EXACT" || (variant === "EXACT_PLUS_PROBABLE" && r.mapping === "PROBABLE"); if (!mapped) return 1;
  if (limit <= 3) return 2;
  if (r.tradable !== true) return 2;
  if (limit <= 4) return 3;
  if (r.eventMs === null) return 3;
  const t = r.eventMs - r.evalMs;
  if (!(t > 0)) return 4;
  if (!(t <= c.horizonMs)) return 5;
  if (!(t >= c.minLeadMs)) return 6;
  return 7;
}

export function computeFunnel(rows: FunnelRow[], cfg: FunnelConfig): FunnelResult {
  const maxAge = cfg.maxSignalAgeMs ?? MAX_SIGNAL_AGE_MS; const c = { scoreMin: cfg.scoreMin ?? SCORE_MIN, minLeadMs: cfg.minLeadMs ?? MIN_LEAD_MS, horizonMs: cfg.horizonMs ?? MAX_HORIZON_MS, measured: cfg.measured };
  const limit = firstUnmeasured(c.measured); const n = STAGES.length;
  const inWin = rows.filter((r) => r.createdAtMs >= cfg.startMs && r.createdAtMs < cfg.endMs);
  const variants = {} as Record<VariantName, VariantResult>;
  for (const v of ["EXACT", "EXACT_PLUS_PROBABLE"] as VariantName[]) {
    const depth = inWin.map((r) => deepestStage(r, v, c));
    // the stage the row passed is `depth`; a stage ≥ `limit` was not measured, so it is null, not zero
    const cum = (sel: (i: number) => boolean): (number | null)[] => Array.from({ length: n }, (_, s) => (s >= limit && s >= 2 ? null : depth.reduce((a, d, i) => a + (sel(i) && d >= s ? 1 : 0), 0)));
    const counts = cum(() => true);
    const perDay = {} as Record<StageKey, PerDay | null>;
    STAGES.forEach((st, s) => { perDay[st.key] = counts[s] === null ? null : perDayStats(inWin.filter((_, i) => depth[i] >= s).map((r) => r.createdAtMs), cfg.startMs, cfg.endMs); });
    const byKind: VariantResult["byKind"] = {}, byCategory: VariantResult["byCategory"] = {};
    for (const k of [...new Set(inWin.map((r) => r.kind))].sort()) byKind[k] = cum((i) => inWin[i].kind === k);
    for (const k of [...new Set(inWin.map((r) => r.category))].sort()) byCategory[k] = cum((i) => inWin[i].category === k);
    const wallets = Array.from({ length: n }, (_, s) => (s >= limit && s >= 2 ? null : new Set(inWin.filter((_, i) => depth[i] >= s).map((r) => r.wallet)).size));
    const last = n - 1; const finalReached = limit >= n;
    const byW = new Map<string, number>(); inWin.forEach((r, i) => { if (depth[i] >= last) byW.set(r.wallet, (byW.get(r.wallet) ?? 0) + 1); });
    const total = [...byW.values()].reduce((a, b) => a + b, 0);
    const top = [...byW.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([wallet, count]) => ({ wallet, count, share: total ? count / total : 0 }));
    const exits: Record<string, number> = {}; depth.forEach((d) => { if (d < last && d + 1 < limit) { const key = STAGES[d + 1].key; exits[key] = (exits[key] ?? 0) + 1; } });
    const finals = finalReached ? inWin.filter((_, i) => depth[i] >= last) : []; const observed = finals.filter((r) => r.lagObserved === true); const fresh = observed.filter((r) => r.evalMs - r.createdAtMs <= maxAge);
    const freshAtFinal = finalReached ? { maxSignalAgeMs: maxAge, finalCount: finals.length, lagObserved: observed.length, withinAge: fresh.length, perDay: perDayStats(fresh.map((r) => r.createdAtMs), cfg.startMs, cfg.endMs) } : null;
    variants[v] = { counts, perDay, byKind, byCategory, wallets, top3Share: finalReached && total ? top.slice(0, 3).reduce((a, b) => a + b.count, 0) / total : null, topWallets: finalReached ? top : [], exits, freshAtFinal };
  }
  const nextDay = (d: string) => new Date(Date.parse(d + "T00:00:00Z") + DAY_MS).toISOString().slice(0, 10);
  const dateDepth = (r: FunnelRow, v: VariantName): number => {
    const d = deepestStage(r, v, { ...c, measured: { mapping: c.measured.mapping, tradable: c.measured.tradable, timestamp: false } });
    if (d < 3 || !c.measured.mapping || !c.measured.tradable) return d;
    if (!r.impliedDateEt) return 3;
    const today = easternParts(r.evalMs).date; return r.impliedDateEt === today || r.impliedDateEt === nextDay(today) ? 5 : 4;
  };
  const dlLimit = !c.measured.mapping ? 2 : !c.measured.tradable ? 3 : DATE_LEVEL_STAGES.length;
  const dateVariants = {} as DateLevelFunnel["variants"];
  for (const v of ["EXACT", "EXACT_PLUS_PROBABLE"] as VariantName[]) { const dd = inWin.map((r) => dateDepth(r, v)); dateVariants[v] = { counts: DATE_LEVEL_STAGES.map((_, s) => (s >= dlLimit && s >= 2 ? null : dd.filter((x) => x >= s).length)), perDay: dlLimit >= DATE_LEVEL_STAGES.length ? perDayStats(inWin.filter((_, i) => dd[i] >= 5).map((r) => r.createdAtMs), cfg.startMs, cfg.endMs) : null }; }
  const known = inWin.filter((r) => r.proxyWithin24h !== undefined);
  const proxyRows = known.filter((r) => r.copyScore !== null && r.copyScore >= c.scoreMin && r.proxyWithin24h === true);
  return {
    window: { startMs: cfg.startMs, endMs: cfg.endMs, elapsedDays: Math.max(0, (cfg.endMs - cfg.startMs) / DAY_MS), completeUtcDays: Math.max(0, Math.floor(cfg.endMs / DAY_MS) - Math.ceil(cfg.startMs / DAY_MS)) },
    stages: STAGES, measured: cfg.measured, variants,
    dateLevel: { label: "NOT THE V1 POLICY", definition: "time eligibility from the Eastern calendar date implied by a placeholder or date-only field (the evaluation's Eastern date or the next); no timestamp is verified", inPlayCheck: "cannot be evaluated at date level", leadCheck: "cannot be evaluated at date level", stages: DATE_LEVEL_STAGES, variants: dateVariants },
    proxy: { definition: "copy score ≥ min and the stored markets.end_date is the signal's UTC day or the next UTC day (date level; includes events that have already started)", scoreAndProxy: known.length ? proxyRows.length : null, perDay: known.length ? perDayStats(proxyRows.map((r) => r.createdAtMs), cfg.startMs, cfg.endMs) : null },
  };
}
