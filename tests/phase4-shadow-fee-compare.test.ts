import { describe, expect, it } from "vitest";
import { FeeRelAcc, REL_MIN_PAIRS, classifyRelation, marketFee, recomputeFeeUsd, recordedRate } from "@/lib/phase4/shadow/fee-compare";
import { feeRateFor } from "@/lib/paper/sim/execute";
import { MODES } from "@/lib/paper/sim/config";
import { walkBuy } from "@/lib/phase4/shadow/fill";
import { feeFromBps } from "@/lib/phase4/shadow/fee";

const ASKS: [number, number][] = [[0.5, 100], [0.6, 1000]];
/** the fill the recorder would have stored for $100 at a given recorded rate: 100 shares at 0.50 ($50) then 83.3 shares at 0.60 ($50) */
const stored = (rate: number) => { const w = walkBuy(ASKS, 100, { sourcePrice: null, mid: null, feeRate: rate, minOrderSize: null }); return { filled_usd: w.filled_usd, fee_usd: w.fee_usd }; };

describe("marketFee: the market's own rate, read as the paper simulator reads it", () => {
  it("fees on with a rate → OBSERVED_RATE at that rate, identical to the paper's feeRateFor", () => {
    const m = marketFee({ fees_enabled: true, taker_fee_rate: 0.07 }); expect(m).toEqual({ rate: 0.07, source: "OBSERVED_RATE" });
    const p = feeRateFor({ feesEnabled: true, takerFeeRate: 0.07, tickSize: null, minOrderShares: null }, MODES.REALISTIC); expect(m.rate).toBe(p.rate); expect(m.source).toBe(p.source);
  });
  it("fees off → OBSERVED_FEE_FREE at 0, whatever rate is stored", () => { expect(marketFee({ fees_enabled: false, taker_fee_rate: 0.07 })).toEqual({ rate: 0, source: "OBSERVED_FEE_FREE" }); expect(marketFee({ fees_enabled: false, taker_fee_rate: null })).toEqual({ rate: 0, source: "OBSERVED_FEE_FREE" }); });
  it("fees on but no rate, fees unknown, no market row: UNKNOWN (null), never the paper's assumed 0.05", () => {
    for (const m of [{ fees_enabled: true, taker_fee_rate: null }, { fees_enabled: null, taker_fee_rate: 0.07 }, { fees_enabled: null, taker_fee_rate: null }, {}, null, undefined]) expect(marketFee(m as any)).toEqual({ rate: null, source: "UNKNOWN" });
  });
  it("Postgres numerics and booleans arrive as strings; a bad rate is unknown, a zero rate with fees on is a real zero", () => {
    expect(marketFee({ fees_enabled: "true", taker_fee_rate: "0.05" })).toEqual({ rate: 0.05, source: "OBSERVED_RATE" });
    expect(marketFee({ fees_enabled: "false", taker_fee_rate: "0.05" }).source).toBe("OBSERVED_FEE_FREE");
    for (const bad of ["abc", -0.01, Number.NaN]) expect(marketFee({ fees_enabled: true, taker_fee_rate: bad }).source).toBe("UNKNOWN");
    expect(marketFee({ fees_enabled: true, taker_fee_rate: 0 })).toEqual({ rate: 0, source: "OBSERVED_RATE" });
  });
});

describe("recordedRate: the rate the recorder used for fee_usd", () => {
  it("bps ÷ 10 000, and the paper REALISTIC fallback when the venue's rate was unknown (parity with fee.ts)", () => {
    expect(recordedRate(1000)).toBe(0.1); expect(recordedRate(0)).toBe(0); expect(recordedRate(null)).toBe(0.05);
    for (const bps of [null, 0, 200, 1000]) expect(recordedRate(bps)).toBe(feeFromBps(bps).rate);
  });
});

describe("recomputeFeeUsd: a stored fill's fee at another rate", () => {
  it("scales a multi-level fill exactly: the fee at 0.07 equals walking the book at 0.07, whatever the recorded rate", () => {
    const want = stored(0.07).fee_usd;
    for (const bps of [1000, 300, 700]) expect(recomputeFeeUsd(stored(bps / 10_000), 100, ASKS, bps, 0.07)).toBeCloseTo(want, 5);
    expect(want).toBeGreaterThan(0.5); // a real number, not a vacuous zero
  });
  it("a recorded fee with an unknown venue rate was charged at the paper fallback 0.05, and is scaled from that", () => { expect(recomputeFeeUsd(stored(0.05), 100, ASKS, null, 0.07)).toBeCloseTo(stored(0.07).fee_usd, 5); });
  it("a market rate of 0 is a fee of exactly 0, even where nothing could be re-walked", () => { expect(recomputeFeeUsd({ filled_usd: 100, fee_usd: 3 }, 100, null, 1000, 0)).toBe(0); expect(recomputeFeeUsd({ filled_usd: 100, fee_usd: 0 }, 100, null, 0, 0)).toBe(0); });
  it("recorded at 0 bps (no information in the stored fee): the stored asks are walked again, and the answer is accepted only if the walk reproduces the fill", () => {
    expect(recomputeFeeUsd(stored(0), 100, ASKS, 0, 0.07)).toBeCloseTo(stored(0.07).fee_usd, 5);
    // the stored fill went deeper than the stored levels: the re-walk cannot reproduce it → unknown, never a guess
    expect(recomputeFeeUsd({ filled_usd: 100, fee_usd: 0 }, 100, [[0.5, 10]], 0, 0.07)).toBeNull();
    expect(recomputeFeeUsd(stored(0), 100, null, 0, 0.07)).toBeNull(); expect(recomputeFeeUsd(stored(0), 100, [], 0, 0.07)).toBeNull();
  });
  it("nothing filled → unknown", () => { expect(recomputeFeeUsd({ filled_usd: 0, fee_usd: 0 }, 100, ASKS, 1000, 0.07)).toBeNull(); });
});

const rep = (bps: number, rate: number, n: number): [number, number, number] => [bps, rate, n];
describe("classifyRelation: the rule at its boundaries", () => {
  it(`fewer than ${REL_MIN_PAIRS} pairs is UNKNOWN (29), exactly ${REL_MIN_PAIRS} is decided`, () => {
    expect(classifyRelation([rep(700, 0.07, REL_MIN_PAIRS - 1)]).relation).toBe("UNKNOWN"); expect(classifyRelation([rep(700, 0.07, REL_MIN_PAIRS - 1)]).pairs).toBe(29);
    expect(classifyRelation([rep(700, 0.07, REL_MIN_PAIRS)]).relation).toBe("EQUAL"); expect(classifyRelation([]).relation).toBe("UNKNOWN");
  });
  it("EQUAL: bps ÷ 10 000 equals the market's rate; the ±1 % edge is inside, just beyond it is a constant multiple", () => {
    expect(classifyRelation([rep(500, 0.05, 100)])).toMatchObject({ relation: "EQUAL", multiple: 1, shareEqual: 1 });
    expect(classifyRelation([rep(101, 0.01, 100)]).relation).toBe("EQUAL"); // ratio 1.01 exactly
    const beyond = classifyRelation([rep(10101, 1, 100)]); expect(beyond.relation).toBe("CONSTANT_MULTIPLE"); expect(beyond.multiple).toBeCloseTo(1.0101, 6);
  });
  it("the 95 % share: 95 of 100 equal is EQUAL, 94 of 100 is not", () => {
    expect(classifyRelation([rep(500, 0.05, 95), rep(900, 0.05, 5)]).relation).toBe("EQUAL");
    expect(classifyRelation([rep(500, 0.05, 94), rep(900, 0.05, 6)]).relation).toBe("UNRELATED");
  });
  it("CONSTANT_MULTIPLE: the observed pattern 1000 bps against a 0.07 market rate is a multiple of 1.43, and the multiple is reported", () => {
    const r = classifyRelation([rep(1000, 0.07, 200)]); expect(r.relation).toBe("CONSTANT_MULTIPLE"); expect(r.multiple).toBeCloseTo(1000 / 700, 9); expect(r.shareEqual).toBe(0);
  });
  it("CONSTANT_MULTIPLE: the ±5 % window around the median ratio, edge inclusive, and the 95 % share", () => {
    const m = 1000 / 700;
    expect(classifyRelation([rep(1000, 0.07, 95), rep(1050, 0.07, 5)]).relation).toBe("CONSTANT_MULTIPLE"); // 1.05 × m: on the edge, inside
    expect(classifyRelation([rep(1000, 0.07, 95), rep(1051, 0.07, 5)]).relation).toBe("CONSTANT_MULTIPLE"); // outside, but only 5 %
    expect(classifyRelation([rep(1000, 0.07, 94), rep(1051, 0.07, 6)]).relation).toBe("UNRELATED");
    expect(classifyRelation([rep(1000, 0.07, 95), rep(1051, 0.07, 5)]).multiple).toBeCloseTo(m, 9);
  });
  it("UNRELATED: a spread of ratios, or recorded 0 against a positive rate, or a positive recorded rate against a market rate of 0", () => {
    expect(classifyRelation([rep(1000, 0.07, 40), rep(300, 0.07, 40), rep(2000, 0.07, 40)]).relation).toBe("UNRELATED");
    expect(classifyRelation([rep(0, 0.05, 100)]).relation).toBe("UNRELATED");
    expect(classifyRelation([rep(1000, 0, 100)]).relation).toBe("UNRELATED");
  });
  it("a market rate of 0 recorded as 0 bps is EQUAL (both say fee-free)", () => { expect(classifyRelation([rep(0, 0, 100)]).relation).toBe("EQUAL"); });
  it("counts are weights, not entries, and a zero weight is ignored", () => { expect(classifyRelation([rep(700, 0.07, 30), rep(1, 0.07, 0)]).relation).toBe("EQUAL"); expect(classifyRelation([rep(700, 0.07, 15), rep(700, 0.07, 15)]).pairs).toBe(30); });
});

describe("FeeRelAcc: bounded counts of (recorded bps, market rate)", () => {
  it("counts pairs, separates the two kinds of missing value, and keeps the most frequent values first", () => {
    const a = new FeeRelAcc(); for (let i = 0; i < 40; i++) a.add(1000, 0.07); for (let i = 0; i < 5; i++) a.add(1000, 0.05); a.add(null, 0.07); a.add(500, null); a.add(500, null);
    expect(a.noBps).toBe(1); expect(a.noMarketRate).toBe(2); expect(a.relation().pairs).toBe(45); expect(a.top(2)).toEqual({ bps: [[1000, 45]], rate: [[0.07, 40], [0.05, 5]] }); expect(a.relation().relation).toBe("UNRELATED");
  });
  it("memory is bounded: beyond the cap of distinct pairs, new pairs are counted as overflow, known pairs keep counting", () => {
    const a = new FeeRelAcc(3); for (let i = 1; i <= 10; i++) a.add(i, 0.05); a.add(1, 0.05); expect(a.pairs.size).toBe(3); expect(a.overflow).toBe(7); expect(a.pairs.get("1|0.05")![2]).toBe(2);
  });
});
