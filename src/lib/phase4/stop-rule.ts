/**
 * Phase 4.0d, Part B4 — the pre-approved STOP RULE. Whether a venue is infeasible for the evidence gate is decided by numbers the owner writes down BEFORE the
 * review results exist, in `docs/phase4/stop_rule.json`, so the goalposts cannot move afterwards:
 *
 *   INFEASIBLE   the UPPER bound of the expected verified-executable eligible signals per day is below the number the evidence window REQUIRES at the
 *                rule's `infeasible` acceptance rate and effect (strictly below: equal is not infeasible);
 *   FEASIBLE     the LOWER bound is above the number required at the rule's `feasible` acceptance rate and effect (strictly above);
 *   UNDETERMINED otherwise: including every case in which a bound is unknown (an unreviewed band, a cut-off listing, a stage not measured).
 *
 * The file ships with `"approved": false`. `evaluateStopRule` returns a verdict ONLY when the file is valid AND approved; otherwise "UNDETERMINED: stop rule not
 * approved". `review-ingest` records the file's hash and approval state at the moment the review results are ingested, and `phase4:merge` refuses a verdict
 * when the rule on disk differs from the one the results were ingested under (so approving or editing the rule AFTER the review results are in does not
 * produce a verdict: ingest again under the approved rule, which is deterministic and free). This code never sets `approved`.
 * Pure apart from the hash (node:crypto); no I/O.
 */
import { hash } from "node:crypto";

export const STOP_RULE_PATH = "docs/phase4/stop_rule.json";
export type Verdict = "FEASIBLE" | "INFEASIBLE" | "UNDETERMINED";

export interface StopRule {
  version: number; approved: boolean; approvedBy: string | null; approvedOn: string | null; description: string;
  /** MAX_WINDOW in days and the grids the required-per-day table is computed on (the two tests below must use a listed effect and acceptance rate). */
  windowDays: number; effectsPts: number[]; acceptRates: number[];
  infeasible: { effectPts: number; acceptRate: number; when: "upper_bound_below_required" };
  feasible: { effectPts: number; acceptRate: number; when: "lower_bound_above_required" };
  /** z of the Wilson intervals (1.96 = 95 %). */
  wilsonZ: number;
  /** which settled paper trades give the SD, design effect and settlement lag: the eligible-like subset when it has at least `minTrades`, else all settled trades. */
  settledSubset: { minTradesForEligibleLike: number };
  /** the review must hold at least this many rows in the below-0.30 stratum for a cut-off listing's upper bound to be closed (otherwise it is unknown, and a venue cannot be INFEASIBLE). */
  minFalseNegativeRows: number;
  /** the owner's reasons; informational. */
  rationale: string[];
}

export interface RuleCheck { ok: boolean; errors: string[]; rule: StopRule | null }
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** Validate the parsed file: every number present and sensible, the two tests naming an effect and an acceptance rate that are in the grids. Pure. */
export function validateStopRule(j: unknown): RuleCheck {
  const errors: string[] = []; const o = (j && typeof j === "object" ? j : {}) as Record<string, unknown>;
  if (!isNum(o.version)) errors.push("version must be a number");
  if (typeof o.approved !== "boolean") errors.push("approved must be true or false");
  if (!isNum(o.windowDays) || o.windowDays <= 0) errors.push("windowDays must be a positive number");
  const eff = Array.isArray(o.effectsPts) && o.effectsPts.length > 0 && o.effectsPts.every((x) => isNum(x) && x > 0) ? (o.effectsPts as number[]) : null; if (!eff) errors.push("effectsPts must be a non-empty list of positive numbers");
  const acc = Array.isArray(o.acceptRates) && o.acceptRates.length > 0 && o.acceptRates.every((x) => isNum(x) && x > 0 && x < 1) ? (o.acceptRates as number[]) : null; if (!acc) errors.push("acceptRates must be a non-empty list of numbers strictly between 0 and 1");
  for (const k of ["infeasible", "feasible"] as const) {
    const t = o[k] as Record<string, unknown> | undefined;
    if (!t || !isNum(t.effectPts) || !isNum(t.acceptRate)) { errors.push(`${k}.effectPts and ${k}.acceptRate must be numbers`); continue; }
    if (eff && !eff.includes(t.effectPts)) errors.push(`${k}.effectPts ${t.effectPts} is not in effectsPts`); if (acc && !acc.includes(t.acceptRate)) errors.push(`${k}.acceptRate ${t.acceptRate} is not in acceptRates`);
    if (t.when !== (k === "infeasible" ? "upper_bound_below_required" : "lower_bound_above_required")) errors.push(`${k}.when must be "${k === "infeasible" ? "upper_bound_below_required" : "lower_bound_above_required"}"`);
  }
  if (!isNum(o.wilsonZ) || o.wilsonZ <= 0) errors.push("wilsonZ must be a positive number");
  const ss = o.settledSubset as Record<string, unknown> | undefined; if (!ss || !isNum(ss.minTradesForEligibleLike) || ss.minTradesForEligibleLike < 0) errors.push("settledSubset.minTradesForEligibleLike must be a non-negative number");
  if (!isNum(o.minFalseNegativeRows) || o.minFalseNegativeRows < 0) errors.push("minFalseNegativeRows must be a non-negative number");
  return errors.length ? { ok: false, errors, rule: null } : { ok: true, errors: [], rule: o as unknown as StopRule };
}
export function parseStopRule(text: string | null): RuleCheck { if (text === null) return { ok: false, errors: ["the stop rule file was not found"], rule: null }; try { return validateStopRule(JSON.parse(text)); } catch (e) { return { ok: false, errors: [`not valid JSON: ${(e as Error).message}`], rule: null }; } }

const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v);
/** SHA-256 of the rule's canonical JSON (keys sorted, whitespace ignored): the fingerprint `review-ingest` records. null when the text is not JSON. */
export function stopRuleHash(text: string | null): string | null { if (text === null) return null; try { return hash("sha256", JSON.stringify(canon(JSON.parse(text))), "hex"); } catch { return null; } }

/** What a review result remembers about the rule it was ingested under. */
export interface RuleStamp { path: string; sha256: string | null; approved: boolean | null }
export const stampOf = (path: string, text: string | null): RuleStamp => { const c = parseStopRule(text); return { path, sha256: stopRuleHash(text), approved: c.rule ? c.rule.approved : null }; };

export interface Bounds { lower: number | null; upper: number | null }
export interface RuleEvaluation { verdict: Verdict; /** false = a verdict was withheld (not approved, invalid, changed after ingest); the numbers are still shown */ issued: boolean; reason: string; requiredInfeasible: number | null; requiredFeasible: number | null }
/**
 * The verdict for one venue. `required(effect, accept)` is the eligible signals per day the window needs (null when it cannot be computed). `stamp` is the
 * rule the review results were ingested under (null when no review was ingested: the bounds then carry no review and the rule's approval is judged on the file alone).
 */
export function evaluateStopRule(check: RuleCheck, b: Bounds, required: (effectPts: number, acceptRate: number) => number | null, o: { current: RuleStamp | null; ingestedUnder: RuleStamp | null | "none" }): RuleEvaluation {
  const withheld = (reason: string): RuleEvaluation => ({ verdict: "UNDETERMINED", issued: false, reason, requiredInfeasible: null, requiredFeasible: null });
  if (!check.ok || !check.rule) return withheld(`UNDETERMINED: stop rule invalid (${check.errors[0] ?? "unreadable"})`);
  const r = check.rule; const reqInf = required(r.infeasible.effectPts, r.infeasible.acceptRate), reqFeas = required(r.feasible.effectPts, r.feasible.acceptRate);
  const base = { requiredInfeasible: reqInf, requiredFeasible: reqFeas };
  if (!r.approved) return { verdict: "UNDETERMINED", issued: false, reason: "UNDETERMINED: stop rule not approved", ...base };
  if (o.ingestedUnder !== "none") {
    const u = o.ingestedUnder; if (!u || u.approved !== true) return { verdict: "UNDETERMINED", issued: false, reason: "UNDETERMINED: the review results were ingested before the stop rule was approved; approve and commit the rule, then run review-ingest again", ...base };
    if (!o.current || u.sha256 !== o.current.sha256) return { verdict: "UNDETERMINED", issued: false, reason: `UNDETERMINED: the stop rule changed after the review results were ingested (hash ${u.sha256?.slice(0, 8) ?? "?"} then, ${o.current?.sha256?.slice(0, 8) ?? "?"} now); run review-ingest again`, ...base };
  }
  if (reqInf === null || reqFeas === null) return { verdict: "UNDETERMINED", issued: true, reason: "UNDETERMINED: the required signals per day cannot be computed (no settled paper trades with a variance)", ...base };
  const infeasible = b.upper !== null && b.upper < reqInf; const feasible = b.lower !== null && b.lower > reqFeas;
  if (infeasible && feasible) return { verdict: "UNDETERMINED", issued: true, reason: "UNDETERMINED: the rule's two tests both hold (check the thresholds: the feasible requirement must not be below the infeasible one)", ...base };
  if (infeasible) return { verdict: "INFEASIBLE", issued: true, reason: `INFEASIBLE: upper bound ${b.upper!.toFixed(2)}/day < required ${reqInf.toFixed(2)}/day (${r.infeasible.acceptRate * 100} % acceptance, ${r.infeasible.effectPts}-point effect)`, ...base };
  if (feasible) return { verdict: "FEASIBLE", issued: true, reason: `FEASIBLE: lower bound ${b.lower!.toFixed(2)}/day > required ${reqFeas.toFixed(2)}/day (${r.feasible.acceptRate * 100} % acceptance, ${r.feasible.effectPts}-point effect)`, ...base };
  const why = [b.upper === null ? "the upper bound is unknown" : `upper ${b.upper.toFixed(2)} ≥ ${reqInf.toFixed(2)}`, b.lower === null ? "the lower bound is unknown" : `lower ${b.lower.toFixed(2)} ≤ ${reqFeas.toFixed(2)}`];
  return { verdict: "UNDETERMINED", issued: true, reason: `UNDETERMINED: ${why.join("; ")}`, ...base };
}
