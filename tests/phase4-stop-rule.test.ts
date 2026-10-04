/**
 * Phase 4.0d, Part B — the stop rule: the committed file ships UNAPPROVED and valid; an unapproved rule issues no verdict; an approved rule gives the documented
 * verdict at every boundary (strictly below / at / above the requirement, for both bounds); an unknown bound never gives INFEASIBLE or FEASIBLE; the hash gates
 * the order "approve, then ingest".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateStopRule, parseStopRule, stampOf, stopRuleHash, validateStopRule, STOP_RULE_PATH, type RuleCheck, type StopRule } from "../src/lib/phase4/stop-rule";

const FILE = readFileSync(STOP_RULE_PATH, "utf8"); const shipped = JSON.parse(FILE) as StopRule;
const approvedText = JSON.stringify({ ...shipped, approved: true, approvedBy: "owner", approvedOn: "2026-10-05" }); const approved = parseStopRule(approvedText);
// a requirement table with known numbers: infeasible test (15 pts, 25 %) needs 26, feasible test (10 pts, 50 %) needs 30
const REQ: Record<string, number> = { "15|0.25": 26, "10|0.5": 30 }; const req = (e: number, a: number) => REQ[`${e}|${a}`] ?? 99;
const none = { current: stampOf(STOP_RULE_PATH, approvedText), ingestedUnder: "none" as const };
const ev = (b: { lower: number | null; upper: number | null }, c: RuleCheck = approved, o: Parameters<typeof evaluateStopRule>[3] = none) => evaluateStopRule(c, b, req, o);

describe("the committed stop_rule.json", () => {
  it("is valid, NOT approved, and every number the verdict depends on is in it", () => {
    const c = validateStopRule(shipped); expect(c.errors).toEqual([]); expect(c.ok).toBe(true); expect(shipped.approved).toBe(false); expect(shipped.approvedBy).toBeNull(); expect(shipped.approvedOn).toBeNull();
    expect(shipped).toMatchObject({ windowDays: 84, effectsPts: [10, 15], acceptRates: [0.1, 0.25, 0.5], infeasible: { effectPts: 15, acceptRate: 0.25, when: "upper_bound_below_required" }, feasible: { effectPts: 10, acceptRate: 0.5, when: "lower_bound_above_required" }, wilsonZ: 1.96, minFalseNegativeRows: 15, settledSubset: { minTradesForEligibleLike: 100 } });
    expect(shipped.rationale.length).toBeGreaterThanOrEqual(4);
  });
  it("the shipped text says how to approve it", () => { expect(shipped.description).toMatch(/set "approved" to true/); expect(shipped.description).toMatch(/COMMIT/); expect(shipped.description).toMatch(/before|only then/); });
});

describe("validation", () => {
  it("rejects a missing number, a test naming an effect or acceptance rate that is not in the grids, a wrong `when`, and bad types", () => {
    expect(validateStopRule({}).ok).toBe(false);
    const bad = (patch: Partial<StopRule> | Record<string, unknown>) => validateStopRule({ ...shipped, ...patch });
    expect(bad({ windowDays: 0 }).errors.join()).toContain("windowDays"); expect(bad({ approved: "yes" }).errors.join()).toContain("approved"); expect(bad({ effectsPts: [] }).errors.join()).toContain("effectsPts"); expect(bad({ acceptRates: [0.5, 1] }).errors.join()).toContain("acceptRates");
    expect(bad({ infeasible: { effectPts: 12, acceptRate: 0.25, when: "upper_bound_below_required" } }).errors.join()).toContain("infeasible.effectPts 12 is not in effectsPts"); expect(bad({ feasible: { effectPts: 10, acceptRate: 0.3, when: "lower_bound_above_required" } }).errors.join()).toContain("feasible.acceptRate 0.3");
    expect(bad({ feasible: { effectPts: 10, acceptRate: 0.5, when: "upper_bound_below_required" } }).errors.join()).toContain("feasible.when"); expect(bad({ wilsonZ: 0 }).errors.join()).toContain("wilsonZ"); expect(bad({ minFalseNegativeRows: -1 }).errors.join()).toContain("minFalseNegativeRows"); expect(bad({ settledSubset: {} as never }).errors.join()).toContain("settledSubset");
  });
  it("parseStopRule: not found and not JSON are invalid, never a thrown error", () => { expect(parseStopRule(null).ok).toBe(false); expect(parseStopRule("{").errors[0]).toContain("not valid JSON"); });
});

describe("approval is a precondition of any verdict", () => {
  it("unapproved: 'UNDETERMINED: stop rule not approved', not issued, whatever the numbers (even a bound far below the requirement)", () => {
    const r = ev({ lower: 0, upper: 0 }, parseStopRule(FILE)); expect(r).toMatchObject({ verdict: "UNDETERMINED", issued: false, reason: "UNDETERMINED: stop rule not approved" }); expect(r.requiredInfeasible).toBe(26); expect(r.requiredFeasible).toBe(30);
    expect(ev({ lower: 1000, upper: 1000 }, parseStopRule(FILE)).issued).toBe(false);
  });
  it("invalid file: no verdict, the first error shown", () => { const r = ev({ lower: 0, upper: 0 }, parseStopRule("{}")); expect(r.issued).toBe(false); expect(r.reason).toContain("stop rule invalid"); });
});

describe("the verdict at every boundary (approved rule; required 26 for the infeasible test, 30 for the feasible test)", () => {
  it("INFEASIBLE only when the UPPER bound is strictly below 26", () => {
    expect(ev({ lower: 0, upper: 25.999 })).toMatchObject({ verdict: "INFEASIBLE", issued: true }); expect(ev({ lower: 0, upper: 26 }).verdict).toBe("UNDETERMINED"); expect(ev({ lower: 0, upper: 26.001 }).verdict).toBe("UNDETERMINED"); expect(ev({ lower: 0, upper: 0 }).verdict).toBe("INFEASIBLE");
    expect(ev({ lower: 0, upper: 25.5 }).reason).toMatch(/INFEASIBLE: upper bound 25\.50\/day < required 26\.00\/day \(25 % acceptance, 15-point effect\)/);
  });
  it("FEASIBLE only when the LOWER bound is strictly above 30", () => {
    expect(ev({ lower: 30.001, upper: 50 })).toMatchObject({ verdict: "FEASIBLE", issued: true }); expect(ev({ lower: 30, upper: 50 }).verdict).toBe("UNDETERMINED"); expect(ev({ lower: 29.999, upper: 50 }).verdict).toBe("UNDETERMINED");
    expect(ev({ lower: 31, upper: 50 }).reason).toMatch(/FEASIBLE: lower bound 31\.00\/day > required 30\.00\/day \(50 % acceptance, 10-point effect\)/);
  });
  it("between the two it is UNDETERMINED with both numbers in the reason", () => { const r = ev({ lower: 10, upper: 40 }); expect(r.verdict).toBe("UNDETERMINED"); expect(r.issued).toBe(true); expect(r.reason).toContain("upper 40.00 ≥ 26.00"); expect(r.reason).toContain("lower 10.00 ≤ 30.00"); });
  it("an unknown bound never gives INFEASIBLE (unknown upper) or FEASIBLE (unknown lower): missing evidence is not evidence", () => {
    expect(ev({ lower: 0, upper: null }).verdict).toBe("UNDETERMINED"); expect(ev({ lower: 0, upper: null }).reason).toContain("the upper bound is unknown"); expect(ev({ lower: null, upper: 100 }).verdict).toBe("UNDETERMINED"); expect(ev({ lower: null, upper: 100 }).reason).toContain("the lower bound is unknown"); expect(ev({ lower: null, upper: null }).verdict).toBe("UNDETERMINED");
  });
  it("a requirement that cannot be computed gives UNDETERMINED, never a verdict", () => { const r = evaluateStopRule(approved, { lower: 100, upper: 100 }, () => null, none); expect(r).toMatchObject({ verdict: "UNDETERMINED", issued: true }); expect(r.reason).toContain("cannot be computed"); });
  it("a rule whose two tests both hold is UNDETERMINED, not an arbitrary pick", () => { const odd = evaluateStopRule(approved, { lower: 50, upper: 20 }, (e) => (e === 15 ? 40 : 10), none); expect(odd.verdict).toBe("UNDETERMINED"); expect(odd.reason).toContain("both hold"); });
});

describe("the goalposts cannot move: approve, THEN ingest", () => {
  const stamp = (text: string) => stampOf(STOP_RULE_PATH, text);
  it("the hash ignores whitespace and key order, and changes with any number", () => {
    expect(stopRuleHash(JSON.stringify(shipped, null, 4))).toBe(stopRuleHash(JSON.stringify(shipped))); expect(stopRuleHash(JSON.stringify(Object.fromEntries(Object.entries(shipped).reverse())))).toBe(stopRuleHash(FILE)); expect(stopRuleHash(JSON.stringify({ ...shipped, wilsonZ: 1.64 }))).not.toBe(stopRuleHash(FILE)); expect(stopRuleHash("{")).toBeNull(); expect(stopRuleHash(null)).toBeNull();
  });
  it("review results ingested under an UNAPPROVED rule give no verdict even after the rule is approved (ingest again)", () => {
    const r = ev({ lower: 0, upper: 0 }, approved, { current: stamp(approvedText), ingestedUnder: stamp(FILE) }); expect(r).toMatchObject({ verdict: "UNDETERMINED", issued: false }); expect(r.reason).toContain("ingested before the stop rule was approved");
  });
  it("review results ingested under an approved rule that was edited afterwards give no verdict (hash mismatch, both hashes named)", () => {
    const edited = JSON.stringify({ ...JSON.parse(approvedText), infeasible: { effectPts: 15, acceptRate: 0.1, when: "upper_bound_below_required" } }); const r = ev({ lower: 0, upper: 0 }, parseStopRule(edited), { current: stamp(edited), ingestedUnder: stamp(approvedText) });
    expect(r.issued).toBe(false); expect(r.reason).toMatch(/changed after the review results were ingested \(hash [0-9a-f]{8} then, [0-9a-f]{8} now\)/);
  });
  it("review results ingested under the same approved rule give the verdict", () => { expect(ev({ lower: 0, upper: 1 }, approved, { current: stamp(approvedText), ingestedUnder: stamp(approvedText) })).toMatchObject({ verdict: "INFEASIBLE", issued: true }); });
  it("results ingested when the rule was unreadable carry approved null and are refused", () => { const r = ev({ lower: 0, upper: 0 }, approved, { current: stamp(approvedText), ingestedUnder: stampOf(STOP_RULE_PATH, null) }); expect(r.issued).toBe(false); });
});
