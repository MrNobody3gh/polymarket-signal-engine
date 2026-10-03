/**
 * Phase 4.0 — sample-size and feasibility arithmetic with known answers (docs/PHASE4_PLAN.md §3.6, D48).
 */
import { describe, expect, it } from "vitest";
import { csvEscape, daysToSample, designEffect, mean, normInv, quantile, sampleSizePerArm, sd, toCsv } from "../src/lib/phase4/stats";
import { ACCEPT_RATES, WINDOW_DAYS, buildFeasibility, solveMinEffect, subsetStats, type SettledTrade } from "../src/lib/phase4/feasibility";

describe("normal quantile", () => {
  it("matches the textbook values", () => {
    expect(normInv(0.975)).toBeCloseTo(1.959964, 6); expect(normInv(0.8)).toBeCloseTo(0.841621, 5); expect(normInv(0.5)).toBeCloseTo(0, 9); expect(normInv(0.995)).toBeCloseTo(2.575829, 5);
    expect(normInv(0.025)).toBeCloseTo(-1.959964, 5); expect(normInv(0.001)).toBeCloseTo(-3.090232, 5); expect(normInv(0.9999)).toBeCloseTo(3.719016, 4);
  });
  it("refuses 0, 1 and values outside", () => { for (const p of [0, 1, -0.1, 1.2, NaN]) expect(() => normInv(p)).toThrow(RangeError); });
});

describe("sampleSizePerArm", () => {
  it("SD 89 points, effect 10 points, no clustering → about 1,241 per arm (the plan's figure; the exact calculation gives 1,244)", () => {
    const n = sampleSizePerArm({ sd: 89, effect: 10 }); expect(n).toBe(1244); expect(Math.abs(n - 1241)).toBeLessThanOrEqual(5);
  });
  it("known textbook case: σ 10, δ 5 → 63 per arm", () => { expect(sampleSizePerArm({ sd: 10, effect: 5 })).toBe(63); });
  it("scales with σ², 1/δ² and the design effect; 15 points needs 2.25 times fewer than 10", () => {
    expect(sampleSizePerArm({ sd: 89, effect: 15 })).toBe(553); expect(sampleSizePerArm({ sd: 89, effect: 10, deff: 1.5 })).toBe(1866); expect(sampleSizePerArm({ sd: 178, effect: 10 })).toBe(4974);
  });
  it("responds to alpha and power (stricter test needs more)", () => {
    expect(sampleSizePerArm({ sd: 89, effect: 10, power: 0.9 })).toBeGreaterThan(1244); expect(sampleSizePerArm({ sd: 89, effect: 10, alpha: 0.01 })).toBeGreaterThan(1244);
  });
  it("refuses nonsense input", () => { expect(() => sampleSizePerArm({ sd: 0, effect: 10 })).toThrow(); expect(() => sampleSizePerArm({ sd: 89, effect: 0 })).toThrow(); expect(() => sampleSizePerArm({ sd: 89, effect: 10, deff: 0.5 })).toThrow(); });
});

describe("designEffect (market clustering)", () => {
  it("perfectly clustered data: every trade in a market has the same return → ICC 1, DEFF = the cluster size", () => {
    const d = designEffect([1, 1, 3, 3, 5, 5], ["a", "a", "b", "b", "c", "c"]); expect(d.icc).toBeCloseTo(1, 9); expect(d.deff).toBeCloseTo(2, 9); expect(d.clusters).toBe(3);
    const d3 = designEffect([1, 1, 1, 3, 3, 3], ["a", "a", "a", "b", "b", "b"]); expect(d3.deff).toBeCloseTo(3, 9);
  });
  it("no clustering (within-market spread at least as large as between-market): ICC clamps at 0, DEFF 1", () => {
    const d = designEffect([1, 3, 1, 3, 1, 3], ["a", "a", "b", "b", "c", "c"]); expect(d.icc).toBe(0); expect(d.deff).toBe(1);
  });
  it("a hand-computed unbalanced example", () => {
    // clusters: a=[2,4], b=[6,8,10]; N=5, k=2; M=6; ssb = 2(3-6)^2 + 3(8-6)^2 = 18+12 = 30; ssw = (1+1) + (4+0+4) = 10; msb=30; msw=10/3
    // n0 = (5 - (4+9)/5)/(2-1) = 2.4; icc = (30-3.3333)/(30+1.4*3.3333) = 26.6667/34.6667 = 0.76923; m = 13/5 = 2.6; deff = 1 + 1.6*0.76923 = 2.23077
    const d = designEffect([2, 4, 6, 8, 10], ["a", "a", "b", "b", "b"]); expect(d.icc).toBeCloseTo(0.769231, 5); expect(d.deff).toBeCloseTo(2.230769, 5); expect(d.meanClusterSizeWeighted).toBeCloseTo(2.6, 9);
  });
  it("is not estimable (DEFF 1, with a note) for a single cluster or all singletons; length mismatch throws", () => {
    expect(designEffect([1, 2, 3], ["a", "a", "a"])).toMatchObject({ deff: 1, icc: null }); expect(designEffect([1, 2, 3], ["a", "b", "c"])).toMatchObject({ deff: 1, icc: null }); expect(designEffect([1, 2, 3], ["a", "b", "c"]).note).toMatch(/not estimable/);
    expect(() => designEffect([1], ["a", "b"])).toThrow();
  });
});

describe("daysToSample", () => {
  it("lag + perArm / (eligible per day × min(accept, 1 − accept))", () => {
    expect(daysToSample({ perArm: 1000, eligiblePerDay: 100, acceptRate: 0.25, settlementLagDays: 5 })).toBeCloseTo(45, 9);
    expect(daysToSample({ perArm: 1000, eligiblePerDay: 100, acceptRate: 0.75, settlementLagDays: 5 })).toBeCloseTo(45, 9);   // symmetric: the scarcer arm decides
    expect(daysToSample({ perArm: 1000, eligiblePerDay: 100, acceptRate: 0.5, settlementLagDays: 0 })).toBeCloseTo(20, 9);
    expect(daysToSample({ perArm: 1000, eligiblePerDay: 100, acceptRate: 0.1, settlementLagDays: 2, settledShare: 0.5 })).toBeCloseTo(202, 9);
  });
  it("refuses nonsense", () => { for (const bad of [{ eligiblePerDay: 0 }, { acceptRate: 0 }, { acceptRate: 1 }, { settlementLagDays: -1 }, { perArm: 0 }, { settledShare: 0 }]) expect(() => daysToSample({ perArm: 10, eligiblePerDay: 10, acceptRate: 0.5, settlementLagDays: 1, ...bad })).toThrow(); });
});

describe("basic statistics and CSV", () => {
  it("mean, sd (n − 1) and quantiles by linear interpolation", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5); expect(mean([])).toBeNull(); expect(sd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4); expect(sd([1])).toBeNull();
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5); expect(quantile([10, 20, 30, 40, 50], 0.9)).toBe(46); expect(quantile([5], 0.9)).toBe(5); expect(quantile([], 0.5)).toBeNull(); expect(quantile([1, 2], 1.5)).toBeNull();
  });
  it("CSV quoting", () => { expect(csvEscape('a,"b"')).toBe('"a,""b"""'); expect(csvEscape(null)).toBe(""); expect(toCsv(["x", "y"], [["1", "a\nb"]])).toBe('x,y\n1,"a\nb"\n'); });
});

describe("feasibility table", () => {
  // 40 trades in 40 markets (no clustering effect), returns alternating ±89 around 0: SD ≈ 90
  const mk = (i: number, ret: number, hold: number, eligibleLike = true, cond = `c${i}`): SettledTrade => ({ signalId: `s${i}`, conditionId: cond, wallet: `w${i % 5}`, returnPts: ret, holdDays: hold, eligibleLike });
  const trades = Array.from({ length: 40 }, (_, i) => mk(i, i % 2 ? 89 : -89, i < 36 ? 1 : 10));
  it("subset statistics", () => {
    const s = subsetStats("x", trades); expect(s).toMatchObject({ n: 40, markets: 40, wallets: 5, deff: 1 }); expect(s.meanPts).toBeCloseTo(0, 9); expect(s.sdPts).toBeCloseTo(90.1, 1); expect(s.holdP50Days).toBe(1); expect(s.holdP90Days).toBeCloseTo(1.9, 6);
  });
  it("zero measured eligible flow is reported as unreachable, not thrown (found on the first production run)", () => {
    const r = buildFeasibility(trades, { eligiblePerDay: { value: 0, basis: "test: no eligible signal on any complete day" } });
    for (const sub of r.subsets) for (const d of sub.days) { expect(d.days).toBeNull(); expect(d.feasibleWithinWindow).toBe(false); expect(d.noEligibleFlow).toBe(true); }
    expect(r.subsets[0].days.length).toBeGreaterThan(0);
    for (const sub of r.subsets) for (const w of sub.whatChanges) expect(w.minDetectableEffectPts).toBeNull();
    const nonsense = buildFeasibility(trades, { eligiblePerDay: { value: Number.NaN, basis: "test" } });
    for (const d of nonsense.subsets[0].days) expect(d.feasibleWithinWindow).toBe(false);
  });
  it("per-arm sizes use the measured SD and DEFF, and the days table follows daysToSample", () => {
    const r = buildFeasibility(trades, { eligiblePerDay: { value: 100, basis: "test" } }); const all = r.subsets[0];
    const n10 = all.sampleSize.find((x) => x.effectPts === 10)!; expect(n10.perArmIndependent).toBe(sampleSizePerArm({ sd: all.stats.sdPts!, effect: 10 })); expect(n10.perArmClustered).toBe(n10.perArmIndependent);
    const row = all.days.find((d) => d.effectPts === 10 && d.acceptRate === 0.25 && d.lag === "median")!; expect(row.days).toBeCloseTo(daysToSample({ perArm: n10.perArmClustered!, eligiblePerDay: 100, acceptRate: 0.25, settlementLagDays: all.stats.holdP50Days! }), 9);
    expect(all.days).toHaveLength(2 * ACCEPT_RATES.length * 2);
  });
  it("feasible exactly when the days fit inside the 12-week window", () => {
    const fast = buildFeasibility(trades, { eligiblePerDay: { value: 1000, basis: "t" } }).subsets[0].days; const slow = buildFeasibility(trades, { eligiblePerDay: { value: 5, basis: "t" } }).subsets[0].days;
    expect(fast.every((d) => d.feasibleWithinWindow)).toBe(true); expect(slow.every((d) => d.feasibleWithinWindow === false)).toBe(true); expect(WINDOW_DAYS).toBe(84);
    const edge = buildFeasibility(trades, { eligiblePerDay: { value: 30, basis: "t" } }).subsets[0].days.find((d) => d.effectPts === 10 && d.acceptRate === 0.25 && d.lag === "p90")!; expect(edge.feasibleWithinWindow).toBe(edge.days! <= 84);
  });
  it("a market-clustered subset needs more trades per arm", () => {
    const clustered = Array.from({ length: 40 }, (_, i) => mk(i, [89, -89][Math.floor(i / 4) % 2], 1, true, `c${Math.floor(i / 4)}`));
    const s = subsetStats("c", clustered); expect(s.deff).toBeGreaterThan(3); const r = buildFeasibility(clustered, { eligiblePerDay: null }); expect(r.subsets[0].sampleSize[0].perArmClustered!).toBeGreaterThan(r.subsets[0].sampleSize[0].perArmIndependent!);
    expect(r.subsets[0].days.every((d) => d.days === null && d.feasibleWithinWindow === null)).toBe(true); // no eligible rate → no days, never a guess
  });
  it("what would have to change: the required eligible rate and the smallest detectable effect are consistent with the sample-size formula", () => {
    const r = buildFeasibility(trades, { eligiblePerDay: { value: 30, basis: "t" } }); const w = r.subsets[0].whatChanges.find((x) => x.effectPts === 10 && x.acceptRate === 0.5)!; const lag = r.subsets[0].stats.holdP90Days!;
    expect(w.requiredEligiblePerDay).toBeCloseTo(r.subsets[0].sampleSize[0].perArmClustered! / ((84 - lag) * 0.5), 6);
    const nAvail = 30 * 0.5 * (84 - lag); expect(sampleSizePerArm({ sd: r.subsets[0].stats.sdPts!, effect: w.minDetectableEffectPts! * 1.001 })).toBeLessThanOrEqual(nAvail); expect(sampleSizePerArm({ sd: r.subsets[0].stats.sdPts!, effect: w.minDetectableEffectPts! * 0.99 })).toBeGreaterThan(nAvail);
  });
  it("solveMinEffect inverts sampleSizePerArm", () => { const e = solveMinEffect(89, 1.5, 1866); expect(e).toBeGreaterThan(9.99); expect(e).toBeLessThan(10.01); });
  it("with fewer than two trades there is nothing to compute, and it says so with nulls", () => { const r = buildFeasibility([mk(1, 5, 1)], { eligiblePerDay: { value: 10, basis: "t" } }); expect(r.subsets[0].sampleSize.every((x) => x.perArmIndependent === null)).toBe(true); expect(r.subsets[0].days).toEqual([]); });
  it("the eligible-like subset is computed separately", () => { const mixed = [...trades.slice(0, 20), ...trades.slice(20).map((t) => ({ ...t, eligibleLike: false }))]; const r = buildFeasibility(mixed, { eligiblePerDay: null }); expect(r.subsets[0].stats.n).toBe(40); expect(r.subsets[1].stats.n).toBe(20); });
});
