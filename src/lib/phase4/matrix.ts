/**
 * Phase 4.0d, Part B — the venue feasibility matrix. Pure functions over the per-venue evidence files (no network, no database):
 *
 *   expected verified-executable eligible signals per day
 *     = (score ≥ 68 entry signals per day)
 *     × (share of those signals that pass the 24-hour / not-started / MIN_LEAD rules)      — the WINDOW share
 *     × (share of the proposed pairs whose venue market has a verified-valid event time)   — the TIMESTAMP share, by stratum
 *     × (share of signals with an owner-confirmed proposed candidate)                      — from the human review (Wilson intervals)
 *
 * Each factor has a lower, a point (where it is measured) and an upper value; the bounds multiply the per-factor bounds, which is wider than a joint
 * interval on purpose (the stop rule is conservative in both directions). A factor that has not been measured is NEVER a zero in the point estimate: the
 * lower bound takes 0, the upper bound takes 1, the point is "n/m". The WINDOW share's upper bound is the date-level proxy (score ≥ 68 with an end date today
 * or tomorrow: it includes events that had already started, so it over-states), its lower bound is the measured funnel survival (0 until timestamps can be
 * measured). The TIMESTAMP share is stratum-level: a proposed pair counts when the S1a audit recommends a field for the candidate's stratum; a stratum
 * with too few events to judge counts only in the upper bound. All of this is research for the owner's decision D53, not a decision.
 */
import type { SlotVerdict } from "./audit";
import type { CoverageResult, VenueCoverageFile } from "./probe";
import type { KalshiCoverageResult } from "./venue-funnel";
import type { VenueAuditFile } from "./s1a";
import type { ReviewResults, Triple } from "./review";
import { proposedOf, type VenueTitlesFile } from "./title-search";
import { requiredPerDayTable, type RequiredPerDay } from "./feasibility";
import { evaluateStopRule, stopRuleHash, type RuleCheck, type RuleEvaluation, type RuleStamp, type Verdict } from "./stop-rule";
import { SIMILARITY_BANDS } from "./mapping";
import { VENUE_LABEL, VENUE_SHORT, type VenueId } from "./venue-run";

export interface Tri { lower: number | null; point: number | null; upper: number | null }
const BAND_NAMES = SIMILARITY_BANDS.map((b) => b.name as string);

// ───────────────────────────────────────────── timestamp share ──────────────────────────────────────────────

export type StratumTime = "passes" | "fails" | "unknown";
/** Does the S1a audit recommend a field (slot 1 or 2) for this stratum? passes = at least one slot RECOMMEND; fails = every judged slot UNRELIABLE_REJECT; unknown = no judgement (too few events, or the stratum was not audited). */
export function stratumTime(recs: SlotVerdict[], stratum: string): StratumTime {
  const mine = recs.filter((r) => r.stratum === stratum); if (!mine.length) return "unknown";
  if (mine.some((r) => r.verdict === "RECOMMEND")) return "passes"; if (mine.some((r) => r.verdict === "INSUFFICIENT_DATA")) return "unknown"; return "fails";
}
export interface TimestampCoverage { status: "no field passes" | "measured" | "audit not run" | "no proposed pairs"; pairs: number; passes: number; unknown: number; fails: number; tri: Tri; note: string }
/**
 * Share of the PROPOSED score ≥ 68 signals whose candidate's stratum has a recommended time field, weighted by the signals behind each pair. Lower counts passes only,
 * point counts passes only (an unjudged stratum is not a pass), upper counts passes and unknown strata. Without an audit file: lower 0, upper 1, point n/m.
 */
export function timestampCoverage(recs: SlotVerdict[] | null, titles: VenueTitlesFile | null): TimestampCoverage {
  const rows = (titles?.rows ?? []).filter((r) => (r.pair.score ?? -1) >= 68); const prop = rows.map((r) => ({ r, c: proposedOf(r) })).filter((x) => x.c);
  if (!recs) return { status: "audit not run", pairs: prop.length, passes: 0, unknown: 0, fails: 0, tri: { lower: 0, point: null, upper: 1 }, note: "no audit file for this venue: the timestamp share is unknown (0 in the lower bound, 1 in the upper)" };
  if (!prop.length) return { status: "no proposed pairs", pairs: 0, passes: 0, unknown: 0, fails: 0, tri: { lower: 0, point: null, upper: 1 }, note: "no proposed pairs to judge" };
  let pass = 0, unk = 0, fail = 0, total = 0; for (const { r, c } of prop) { const w = r.pair.signals; total += w; const t = stratumTime(recs, c!.stratum ?? "(none)"); if (t === "passes") pass += w; else if (t === "unknown") unk += w; else fail += w; }
  const anyPass = recs.some((r) => r.verdict === "RECOMMEND"); const share = (x: number) => (total ? x / total : 0);
  return { status: anyPass ? "measured" : "no field passes", pairs: prop.length, passes: pass, unknown: unk, fails: fail, tri: { lower: share(pass), point: share(pass), upper: share(pass + unk) }, note: anyPass ? "stratum-level: a pair passes when the audit recommends a field for its candidate's stratum (a market-level check is the production gate)" : "no stratum has a recommended time field: nothing can be dated, so the lower and point values are 0 by construction (not evidence about the venue); strata with too few events to judge stay in the upper bound" };
}

// ───────────────────────────────────────────── window share ─────────────────────────────────────────────────

export interface WindowShare { tri: Tri; basis: string }
/** Lower: the funnel's measured survival of the 24 h / not-started / lead rules among signals with a usable timestamp (needs ≥ 30 such signals, else 0). Upper: the date-level proxy share (over-states: includes started events), else 1. Point: the measurement, else the proxy. */
export function windowShare(cov: CoverageResult | KalshiCoverageResult | null, proxySource: CoverageResult | KalshiCoverageResult | null = cov): WindowShare {
  if (!cov) return { tri: { lower: 0, point: null, upper: 1 }, basis: "no coverage file: unknown" };
  const f = cov.funnel; const v = f.variants.EXACT_PLUS_PROBABLE; const ts = v.counts[4], fin = v.counts[7];
  const measured = ts !== null && ts !== undefined && ts >= 30 && fin !== null && fin !== undefined ? fin / ts : null;
  // the date-level proxy comes from the database (stored end dates), so any venue's coverage file of the same window can supply it
  const pf = f.proxy.scoreAndProxy !== null ? { c: f.proxy.scoreAndProxy, n: cov.counts.withScore } : proxySource && proxySource.funnel.proxy.scoreAndProxy !== null ? { c: proxySource.funnel.proxy.scoreAndProxy, n: proxySource.counts.withScore } : null;
  const proxy = pf && pf.n > 0 ? Math.min(1, pf.c / pf.n) : null;
  return { tri: { lower: measured ?? 0, point: measured ?? proxy, upper: proxy ?? 1 }, basis: measured !== null ? `measured funnel survival ${(measured * 100).toFixed(0)} % (of ${ts} signals with a usable timestamp); upper bound ${proxy === null ? "1" : `${(proxy * 100).toFixed(0)} % date-level proxy`}` : `timestamps not measurable (fewer than 30 dated signals): lower 0; point and upper from the date-level proxy ${proxy === null ? "(unavailable: 1)" : `${(proxy * 100).toFixed(0)} %`} (it includes events that had already started)` };
}

// ───────────────────────────────────────────── expected per day ─────────────────────────────────────────────

export interface Expected { tri: Tri; upperOpen: boolean; notes: string[] }
export function expectedPerDay(f: { score68PerDay: number | null; review: ReviewResults | null; window: Tri; ts: Tri; cutOff: boolean; minFalseNegativeRows: number }): Expected {
  const notes: string[] = []; const s = f.score68PerDay; if (s === null) return { tri: { lower: null, point: null, upper: null }, upperOpen: false, notes: ["the score ≥ 68 signals per day are not known (no coverage run)"] };
  const share: Triple | null = f.review ? f.review.extrapolation.share : null; if (!share) notes.push("no review ingested: precision unknown (lower 0, upper 1)");
  const fn = f.review?.falseNegatives.sampled ?? 0; const upperOpen = f.cutOff && fn < f.minFalseNegativeRows;
  if (f.cutOff) notes.push(upperOpen ? `the listing was cut off and only ${fn} below-0.30 rows were reviewed (< ${f.minFalseNegativeRows}): the upper bound is OPEN (a venue cannot be declared infeasible)` : `the listing was cut off; ${fn} below-0.30 rows reviewed (owner searched the venue) bound what the cut-off hides`);
  const lo = (share ? share.lo : 0) * (f.window.lower ?? 0) * (f.ts.lower ?? 0); const up = (share ? share.hi : 1) * (f.window.upper ?? 1) * (f.ts.upper ?? 1);
  const pt = share && share.point !== null && f.window.point !== null && f.ts.point !== null ? share.point * f.window.point * f.ts.point : null;
  return { tri: { lower: s * lo, point: pt === null ? null : s * pt, upper: upperOpen ? null : s * up }, upperOpen, notes };
}

// ───────────────────────────────────────────── required per day ─────────────────────────────────────────────

export interface RequiredBasis { subset: string; n: number; sdPts: number; deff: number; lagP90Days: number; windowDays: number; settledShare: number; rows: RequiredPerDay[] }
/** The required-per-day table from the settled-paper-trade statistics of any coverage file that has them (the signal side's file first); null when none has a usable variance. */
export function requiredBasis(files: (VenueCoverageFile | null)[], rule: { windowDays: number; effectsPts: number[]; acceptRates: number[]; minTrades: number }): RequiredBasis | null {
  for (const f of files) {
    const res = f?.result as CoverageResult | null | undefined; const fe = res && "feasibility" in res ? res.feasibility : null; if (!fe) continue;
    const eligible = fe.subsets.find((s) => s.stats.name.startsWith("eligible-like")); const all = fe.subsets.find((s) => s.stats.name.startsWith("all"));
    const pick = eligible && eligible.stats.n >= rule.minTrades && eligible.stats.sdPts && eligible.stats.sdPts > 0 ? eligible : all; if (!pick || !pick.stats.sdPts || pick.stats.sdPts <= 0) continue;
    const share = res!.settled.fillShare && res!.settled.fillShare > 0 ? res!.settled.fillShare : 1; const lag = pick.stats.holdP90Days ?? 0;
    return { subset: pick.stats.name, n: pick.stats.n, sdPts: pick.stats.sdPts, deff: pick.stats.deff, lagP90Days: lag, windowDays: rule.windowDays, settledShare: share, rows: requiredPerDayTable({ sd: pick.stats.sdPts, deff: pick.stats.deff, lagDays: lag, windowDays: rule.windowDays, effects: rule.effectsPts, acceptRates: rule.acceptRates, settledShare: share }) };
  }
  return null;
}

// ───────────────────────────────────────────── the matrix ───────────────────────────────────────────────────

export interface VenueFiles { venue: VenueId; audit: VenueAuditFile | null; coverage: VenueCoverageFile | null; titles: VenueTitlesFile | null; review: ReviewResults | null }
export interface MatrixRow {
  venue: VenueId; run: { audit: string; coverage: string; titles: string; review: string }; role: "execution candidate" | "signal source";
  pairs68: number | null; reached68: number | null; pairsAll: number | null; signals68PerDay: number | null;
  proposedByBand: Record<string, number> | null; proposed68: number | null;
  precisionByBand: { band: string; text: string }[]; resolution: { reviewed: number; yes: number; no: number; unsure: number } | null;
  timestamps: TimestampCoverage | null; window: WindowShare | null; cutOff: boolean | null;
  expected: Expected | null; evaluation: RuleEvaluation | null;
}
export interface MatrixResult { rule: { check: RuleCheck; stamp: RuleStamp }; required: RequiredBasis | null; rows: MatrixRow[]; notes: string[] }

const statusOf = (f: unknown, stopped: { reason: string } | null | undefined): string => (f ? (stopped ? `stopped (${stopped.reason})` : "run") : "not run");
const bandText = (r: ReviewResults | null) => (r ? r.bands.map((b) => ({ band: b.band, text: b.precisionOfProposed ? `${b.precisionOfProposed.k}/${b.precisionOfProposed.n} = ${(b.precisionOfProposed.point * 100).toFixed(0)} % [${(b.precisionOfProposed.lo * 100).toFixed(0)}–${(b.precisionOfProposed.hi * 100).toFixed(0)}]` : b.proposedRows === 0 && b.sampled > 0 ? "no proposed row in the sample" : "not reviewed" })) : []);
export function buildMatrix(venues: VenueFiles[], ruleCheck: RuleCheck, ruleText: string | null, rulePath: string): MatrixResult {
  const stamp: RuleStamp = { path: rulePath, sha256: stopRuleHash(ruleText), approved: ruleCheck.rule ? ruleCheck.rule.approved : null };
  const rule = ruleCheck.rule; const covFiles = [...venues].sort((a, b) => Number(b.venue === "polymarket_intl") - Number(a.venue === "polymarket_intl")).map((v) => v.coverage);
  const required = rule ? requiredBasis(covFiles, { windowDays: rule.windowDays, effectsPts: rule.effectsPts, acceptRates: rule.acceptRates, minTrades: rule.settledSubset.minTradesForEligibleLike }) : null;
  const reqFn = (e: number, a: number): number | null => required?.rows.find((r) => r.effectPts === e && r.acceptRate === a)?.requiredEligiblePerDay ?? null;
  const notes: string[] = []; const anyCov = venues.map((v) => v.coverage?.result).find((r) => !!r) ?? null; const anyProxy = venues.map((v) => v.coverage?.result).find((r) => !!r && r.funnel.proxy.scoreAndProxy !== null) ?? null;
  const rows: MatrixRow[] = venues.map((v) => {
    const exec = v.venue !== "polymarket_intl"; const cov = v.coverage?.result ?? null; const covForRate = cov ?? anyCov; const t = v.titles; const s = t?.summary;
    const elapsed = covForRate ? covForRate.funnel.window.elapsedDays : 0; const perDay = covForRate && elapsed > 0 ? covForRate.counts.withScore / elapsed : null;
    const row: MatrixRow = { venue: v.venue, run: { audit: statusOf(v.audit, v.audit?.stopped), coverage: statusOf(v.coverage, v.coverage?.stopped), titles: statusOf(v.titles, v.titles?.stopped), review: v.review ? "ingested" : "not run" }, role: exec ? "execution candidate" : "signal source",
      pairs68: s ? s.score68.pairs : null, reached68: s ? s.score68.byBestBand ? Object.values(s.score68.byBestBand).reduce((a, b) => a + b, 0) : null : null, pairsAll: t?.allScores && s ? s.pairs : null, signals68PerDay: perDay,
      proposedByBand: s ? s.proposed.byBandScore68 : null, proposed68: s ? s.proposed.score68 : null, precisionByBand: bandText(v.review), resolution: null, timestamps: null, window: null, cutOff: t ? t.listingCutOff : null, expected: null, evaluation: null };
    if (!exec) return row;
    if (v.review) { const rc = v.review.answerCounts.RESOLUTION; row.resolution = { reviewed: v.review.rows, yes: rc.Y, no: rc.N, unsure: rc.U }; }
    // without a title search there are no proposed pairs: nothing about this venue can be estimated, and it is "not run", not a range that starts at zero
    if (!t) return row;
    row.timestamps = timestampCoverage(v.audit?.audit?.recommendations ?? null, t); row.window = windowShare(cov, anyProxy);
    row.expected = expectedPerDay({ score68PerDay: perDay, review: v.review, window: row.window.tri, ts: row.timestamps.tri, cutOff: t?.listingCutOff === true || (cov !== null && "listing" in cov && (cov as KalshiCoverageResult).listing.cutOff === true), minFalseNegativeRows: rule?.minFalseNegativeRows ?? 15 });
    row.evaluation = evaluateStopRule(ruleCheck, { lower: row.expected.tri.lower, upper: row.expected.tri.upper }, reqFn, { current: stamp, ingestedUnder: v.review ? v.review.stopRule : "none" });
    return row;
  });
  if (!required) notes.push("the required signals per day are not computed: no coverage file with settled paper trades (run `npm run phase4:coverage -- --venue polymarket_intl` where the database is reachable)");
  return { rule: { check: ruleCheck, stamp }, required, rows, notes };
}

// ───────────────────────────────────────────── rendering ────────────────────────────────────────────────────

export const MATRIX_MAX_LINES = 100;
const f2 = (x: number | null | undefined) => (x === null || x === undefined ? "n/m" : x.toFixed(1)); const pc0 = (x: number | null | undefined) => (x === null || x === undefined ? "n/m" : `${(x * 100).toFixed(0)} %`);
const NR = "not run";
/** FEASIBILITY_MATRIX.md: ≤ 100 lines, one row per venue, every missing input shown as "not run", never as zero. */
export function renderMatrix(m: MatrixResult): string {
  const L: string[] = ["# Venue feasibility matrix (generated by `npm run phase4:merge`; research for decision D53, not a decision)", ""];
  const r = m.rule; L.push(`Stop rule \`${r.stamp.path}\`: ${r.check.ok ? (r.check.rule!.approved ? `**approved** (sha256 ${r.stamp.sha256?.slice(0, 12)})` : "**NOT approved**: no verdict is printed, only the numbers") : `INVALID (${r.check.errors[0]})`}. A venue is "proposed" by code, "verified" only by the owner's review (and a machine-verified timestamp); anything unverified is not tradable. A factor that was not measured is **n/m**, never 0 in a point estimate.`, "");
  L.push("## What the evidence window requires (eligible signals per day)", "");
  if (m.required) { const q = m.required; L.push(`Basis: ${q.subset}, ${q.n} settled paper trades, SD ${q.sdPts.toFixed(1)} pts, design effect ${q.deff.toFixed(2)}, p90 settlement lag ${q.lagP90Days.toFixed(1)} d, window ${q.windowDays} d, fill share ${pc0(q.settledShare)}.`, "", "| effect (pts) | per arm (settled trades) | " + [...new Set(q.rows.map((x) => x.acceptRate))].map((a) => `accept ${pc0(a)}`).join(" | ") + " |", "|---|---|" + [...new Set(q.rows.map((x) => x.acceptRate))].map(() => "---").join("|") + "|");
    for (const e of [...new Set(q.rows.map((x) => x.effectPts))]) { const rs = q.rows.filter((x) => x.effectPts === e); L.push(`| ${e} | ${rs[0].perArm} | ${rs.map((x) => f2(x.requiredEligiblePerDay)).join(" | ")} |`); } }
  else L.push(`${NR}: ${m.notes[0] ?? "no settled-trade statistics"}`);
  L.push("", "## One row per venue", "", "| venue | role | signal pairs ≥ 68 (reached) · all scores | proposed (≥ 68) by band: " + BAND_NAMES.join(" / ") + " | precision of proposals by band (human, Wilson) | timestamp coverage | resolution rules (Y/N/U) | expected verified-executable eligible per day: lower · point · upper | required: infeasible test · feasible test | verdict |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const x of m.rows) {
    const pairs = x.pairs68 === null ? NR : `${x.pairs68} (${x.reached68})`; const allp = x.pairsAll === null ? "all scores: not run (--all-scores)" : `all scores: ${x.pairsAll}`;
    const prop = x.proposedByBand ? `${x.proposed68}: ${BAND_NAMES.map((b) => x.proposedByBand![b] ?? 0).join(" / ")}` : NR;
    const prec = x.role === "signal source" ? "n/a" : x.precisionByBand.length ? x.precisionByBand.map((b) => `${b.band}: ${b.text}`).join("; ") : "not reviewed";
    const ts = x.role === "signal source" ? "n/a" : x.timestamps ? (x.timestamps.status === "audit not run" ? `${NR} (audit)` : x.timestamps.status === "no field passes" ? "no field passes" : `${pc0(x.timestamps.tri.lower)}–${pc0(x.timestamps.tri.upper)}`) : NR;
    const res = x.role === "signal source" ? "n/a" : x.resolution ? `${x.resolution.yes}/${x.resolution.no}/${x.resolution.unsure} of ${x.resolution.reviewed}` : "not reviewed";
    const ex = x.expected ? `${f2(x.expected.tri.lower)} · ${f2(x.expected.tri.point)} · ${x.expected.upperOpen ? "open" : f2(x.expected.tri.upper)}` : x.role === "signal source" ? `${f2(x.signals68PerDay)} score ≥ 68 signals/day (source)` : NR;
    const rq = x.evaluation ? `${f2(x.evaluation.requiredInfeasible)} · ${f2(x.evaluation.requiredFeasible)}` : x.role === "signal source" ? "n/a" : NR;
    const vd = x.evaluation ? (x.evaluation.issued ? `**${x.evaluation.verdict}**` : x.evaluation.reason) : x.role === "signal source" ? "n/a" : NR;
    L.push(`| ${VENUE_SHORT[x.venue]} | ${x.role} | ${pairs} · ${allp} | ${prop} | ${prec} | ${ts} | ${res} | ${ex} | ${rq} | ${vd} |`);
  }
  L.push("", "## Per venue: what was run and the notes behind each number", "");
  for (const x of m.rows) {
    L.push(`### ${VENUE_LABEL[x.venue]}`, `- files: audit ${x.run.audit} · coverage ${x.run.coverage} · titles ${x.run.titles} · review ${x.run.review}`);
    if (x.role === "signal source") { L.push(`- score ≥ 68 entry signals per day: ${f2(x.signals68PerDay)}`); continue; }
    if (!x.expected) L.push(`- no title search for this venue: ${NR}; nothing is estimated (not a zero)`);
    if (x.timestamps) L.push(`- timestamps: ${x.timestamps.status}; ${x.timestamps.note}`);
    if (x.window) L.push(`- 24 h / not-started / lead share: ${x.window.basis}`);
    if (x.cutOff !== null) L.push(`- listing cut off at the cap: ${x.cutOff ? "yes (matches are lower bounds)" : "no"}`);
    if (x.expected) for (const n of x.expected.notes) L.push(`- ${n}`);
    if (x.evaluation) L.push(`- ${x.evaluation.reason}`);
  }
  for (const n of m.notes) L.push("", `Note: ${n}`);
  L.push("", "Bounds multiply per-factor bounds (precision, window share, timestamp share): wider than a joint 95 % interval, on purpose. The expected number is a research estimate; the stop rule, not this page, decides.");
  return L.slice(0, MATRIX_MAX_LINES).join("\n") + "\n";
}
