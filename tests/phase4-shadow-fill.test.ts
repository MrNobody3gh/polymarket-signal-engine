import { describe, expect, it } from "vitest";
import { normaliseBook, topLevels } from "@/lib/phase4/shadow/book";
import { fillsFor, walkBuy } from "@/lib/phase4/shadow/fill";
import { BPS_PER_UNIT, feeFromBps, parseFeeRateBps } from "@/lib/phase4/shadow/fee";
import { MODES } from "@/lib/paper/sim/config";
import { simulateEntry, takerFee } from "@/lib/paper/sim/execute";

const lv = (rows: [string, string][]) => rows.map(([price, size]) => ({ price, size }));
const A = { bids: lv([["0.48", "50"], ["0.47", "100"]]), asks: lv([["0.50", "100"], ["0.51", "200"], ["0.60", "1000"]]), tick_size: "0.01", min_order_size: "5" };
const book = (raw: unknown) => normaliseBook(raw)!;
const ref = (over: Partial<Parameters<typeof walkBuy>[2]> = {}) => ({ sourcePrice: 0.49, mid: 0.49, feeRate: 0, minOrderSize: 5, ...over });

describe("normaliseBook", () => {
  it("reads the documented shape (decimal strings), sorts both sides best first and derives the top of book", () => {
    const b = book({ ...A, bids: [...A.bids].reverse(), asks: [...A.asks].reverse() }); // the venue's order is not relied on
    expect(b.bids.map((l) => l[0])).toEqual([0.48, 0.47]); expect(b.asks.map((l) => l[0])).toEqual([0.5, 0.51, 0.6]);
    expect(b).toMatchObject({ state: "OK", bestBid: 0.48, bestAsk: 0.5, spread: 0.02, mid: 0.49, tickSize: 0.01, minOrderSize: 5, dropped: 0 });
  });
  it("accepts numbers and [price, size] pairs, merges a repeated price into one level, and keeps the venue's price exactly (no rounding to a tick)", () => {
    const b = book({ bids: [[0.043, 10]], asks: [{ price: 0.5, size: 1 }, { price: "0.5000", size: "2" }, { price: 0.123456789, size: 1 }] });
    expect(b.asks).toEqual([[0.123457, 1], [0.5, 3]]); // 6-decimal float hygiene only; 0.5 and "0.5000" are one level of 3
    expect(b.bids).toEqual([[0.043, 10]]); // a 0.001-tick price is preserved
  });
  it("drops unreadable levels and counts them: price outside (0,1), size not positive, text", () => {
    const b = book({ bids: [{ price: "1.2", size: "5" }, { price: "0.4", size: "0" }, { price: "abc", size: "1" }, { price: "0", size: "1" }, { price: "0.4", size: "7" }], asks: [] });
    expect(b.bids).toEqual([[0.4, 7]]); expect(b.dropped).toBe(4);
  });
  it("states: empty, one-sided (either side), crossed, and a locked book (bid = ask) is still OK", () => {
    expect(book({ bids: [], asks: [] }).state).toBe("EMPTY_BOOK");
    expect(book({ bids: A.bids, asks: [] }).state).toBe("ONE_SIDED"); expect(book({ bids: [], asks: A.asks }).state).toBe("ONE_SIDED");
    expect(book({ bids: lv([["0.55", "1"]]), asks: lv([["0.50", "1"]]) }).state).toBe("CROSSED");
    expect(book({ bids: lv([["0.50", "1"]]), asks: lv([["0.50", "1"]]) })).toMatchObject({ state: "OK", spread: 0 });
  });
  it("an answer that is not a book is null (the caller records ERROR): an error body, an array, a string, bids that are not an array", () => {
    for (const x of [null, "x", [], 5, { error: "No orderbook exists for the requested token id" }, { bids: "no", asks: [] }, { bids: [], asks: {} }]) expect(normaliseBook(x)).toBeNull();
  });
  it("topLevels cuts the stored copy to n levels, best first", () => { expect(topLevels(book(A).asks, 2)).toEqual([[0.5, 100], [0.51, 200]]); expect(topLevels([], 10)).toEqual([]); });
});

describe("walkBuy (known answers)", () => {
  const asks = book(A).asks;
  it("an exact fill inside the first level", () => {
    const f = walkBuy(asks, 10, ref());
    expect(f).toMatchObject({ filled_usd: 10, shares: 20, avg_price: 0.5, limit_price: 0.5, filled_share: 1, fee_usd: 0, below_min_order: false });
    expect(f.slippage_vs_source).toBeCloseTo(0.01, 9); expect(f.slippage_vs_mid).toBeCloseTo(0.01, 9);
  });
  it("a price exactly at a level: $50 buys exactly the 100 shares at 0.50 and never touches the 0.51 level", () => {
    const f = walkBuy(asks, 50, ref()); expect(f).toMatchObject({ shares: 100, avg_price: 0.5, limit_price: 0.5, filled_share: 1 });
  });
  it("walks into the second level: $100 = 100 shares at 0.50 + 50 dollars at 0.51", () => {
    const f = walkBuy(asks, 100, ref()); const shares = 100 + 50 / 0.51;
    expect(f.shares).toBeCloseTo(shares, 5); expect(f.avg_price).toBeCloseTo(100 / shares, 6); expect(f.limit_price).toBe(0.51); expect(f.filled_share).toBe(1); expect(f.filled_usd).toBeCloseTo(100, 6);
  });
  it("size larger than the whole book: partial fill, never fabricated liquidity", () => {
    const f = walkBuy([[0.5, 10]], 100, ref()); expect(f).toMatchObject({ shares: 10, filled_usd: 5, filled_share: 0.05, avg_price: 0.5 });
    const g = walkBuy([[0.5, 10], [0.6, 5]], 100, ref()); expect(g).toMatchObject({ shares: 15, filled_usd: 8, limit_price: 0.6 }); expect(g.filled_share).toBeCloseTo(0.08, 9);
  });
  it("an empty ask side fills nothing: null prices, share 0, zero fee", () => {
    expect(walkBuy([], 25, ref({ feeRate: 0.05 }))).toEqual({ usd_requested: 25, filled_usd: 0, shares: 0, avg_price: null, limit_price: null, slippage_vs_source: null, slippage_vs_mid: null, filled_share: 0, fee_usd: 0, below_min_order: true });
  });
  it("slippage is measured against the wallet's price and against the mid; a missing reference gives null, not 0", () => {
    const f = walkBuy(asks, 10, ref({ sourcePrice: 0.45, mid: 0.4 })); expect(f.slippage_vs_source).toBeCloseTo(0.05, 9); expect(f.slippage_vs_mid).toBeCloseTo(0.1, 9);
    const g = walkBuy(asks, 10, ref({ sourcePrice: null, mid: null })); expect(g.slippage_vs_source).toBeNull(); expect(g.slippage_vs_mid).toBeNull();
  });
  it("below the venue's minimum order size is flagged (and unknown is null)", () => {
    expect(walkBuy([[0.5, 4]], 100, ref({ minOrderSize: 5 })).below_min_order).toBe(true); expect(walkBuy([[0.5, 5]], 100, ref({ minOrderSize: 5 })).below_min_order).toBe(false); expect(walkBuy([[0.5, 4]], 100, ref({ minOrderSize: null })).below_min_order).toBeNull();
  });
  it("a size is spent in dollars: the stake, not the share count, is what is requested", () => {
    for (const usd of [10, 25, 100]) { const f = walkBuy([[0.25, 1_000_000]], usd, ref()); expect(f.filled_usd).toBeCloseTo(usd, 6); expect(f.shares).toBeCloseTo(usd / 0.25, 5); }
  });
});

describe("fillsFor", () => {
  it("fills at every size for an ordinary book, with the venue's tick and minimum order recorded", () => {
    const f = fillsFor(book(A), [10, 25, 100], { sourcePrice: 0.49, feeRate: 0 })!;
    expect(Object.keys(f.by_usd)).toEqual(["10", "25", "100"]); expect(f.tick_size).toBe(0.01); expect(f.min_order_size).toBe(5); expect(f.by_usd["25"].shares).toBe(50);
  });
  it("a crossed book gets NO fills: its prices cannot be trusted", () => { expect(fillsFor(book({ bids: lv([["0.6", "1"]]), asks: lv([["0.5", "100"]]) }), [10], { sourcePrice: 0.5, feeRate: 0.05 })).toBeNull(); });
  it("a one-sided book with asks still prices a buy (the spread and mid are null); one with only bids reads as unfillable", () => {
    const a = fillsFor(book({ bids: [], asks: A.asks }), [10], { sourcePrice: 0.49, feeRate: 0 })!; expect(a.by_usd["10"].filled_share).toBe(1); expect(a.by_usd["10"].slippage_vs_mid).toBeNull();
    const b = fillsFor(book({ bids: A.bids, asks: [] }), [10], { sourcePrice: 0.49, feeRate: 0 })!; expect(b.by_usd["10"].filled_share).toBe(0);
  });
});

describe("fee parity with the paper simulator", () => {
  it("the paper takerFee is what the walk charges, level by level", () => {
    const f = walkBuy([[0.4, 10], [0.5, 1000]], 105, ref({ feeRate: 0.05 }));
    const expected = takerFee(10, 0.4, 0.05) + takerFee((105 - 4) / 0.5, 0.5, 0.05); expect(f.fee_usd).toBeCloseTo(expected, 5);
  });
  it("on the shared fixture the paper REALISTIC fee equals the observed-book fee: same fill price, same shares, same rate", () => {
    const rate = 0.03; const market = { feesEnabled: true, takerFeeRate: rate, tickSize: 0.01, minOrderShares: 5 };
    const res = simulateEntry({ sourceTs: 1000, evalTs: 1010, signalPrice: 0.42, sourceUsd: 5000, obs: { ts: 1010, price: 0.42, resolutionSeconds: 0 }, market }, MODES.REALISTIC, 100);
    expect(res.fee).toBeGreaterThan(0); expect(res.feeSource).toBe("OBSERVED_RATE");
    const ours = walkBuy([[res.fillPrice!, 1_000_000]], res.filledUsd, ref({ feeRate: rate }));
    expect(ours.shares).toBeCloseTo(res.filledShares, 4); expect(ours.fee_usd).toBeCloseTo(res.fee, 5);
  });
  it("the provenance vocabulary is the paper's: 0 bps observed fee-free, > 0 observed rate, unknown assumed at the paper's fallback rate", () => {
    expect(feeFromBps(0)).toEqual({ rate: 0, source: "OBSERVED_FEE_FREE" });
    expect(feeFromBps(300)).toEqual({ rate: 300 / BPS_PER_UNIT, source: "OBSERVED_RATE" });
    expect(feeFromBps(null)).toEqual({ rate: MODES.REALISTIC.fallbackFeeRate, source: "ASSUMED_UNKNOWN" });
    expect(BPS_PER_UNIT).toBe(10_000);
  });
  it("parses the fee-rate answer: a number or a numeric string, never a negative or non-numeric value", () => {
    expect(parseFeeRateBps({ fee_rate_bps: 1000 })).toBe(1000); expect(parseFeeRateBps({ fee_rate_bps: "250" })).toBe(250); expect(parseFeeRateBps({ base_fee: 0 })).toBe(0);
    for (const x of [null, {}, { fee_rate_bps: -1 }, { fee_rate_bps: "x" }, { fee_rate_bps: "" }, "5"]) expect(parseFeeRateBps(x)).toBeNull();
  });
});
