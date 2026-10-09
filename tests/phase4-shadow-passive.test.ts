import { describe, expect, it } from "vitest";
import { PassiveAcc, TOUCH_EPS, evaluate, limitPrice, touched, type Base, type Snap } from "@/lib/phase4/shadow/passive";

const snap = (o: Partial<Snap> = {}): Snap => ({ status: "OK", bid: 0.5, ask: 0.52, mid: 0.51, ...o });
const base = (o: Partial<Base> = {}): Base => ({ snap: snap(), source: 0.52, takerAvg: 0.53, takerFeePct: 2, ...o });
const at = (offset: number, s: Snap | undefined) => ({ offset, snap: s });

describe("limitPrice", () => {
  it("bid: the best bid of a readable book (OK, or ONE_SIDED with bids); mid: only a two-sided OK book", () => {
    expect(limitPrice("bid", snap())).toBe(0.5); expect(limitPrice("bid", snap({ status: "ONE_SIDED", ask: null, mid: null }))).toBe(0.5); expect(limitPrice("mid", snap())).toBe(0.51);
    expect(limitPrice("mid", snap({ status: "ONE_SIDED", ask: null, mid: null }))).toBeNull();
  });
  it("no bid, an empty book, a crossed book, an error, a missed snapshot: no limit price (never invented)", () => {
    expect(limitPrice("bid", snap({ status: "ONE_SIDED", bid: null }))).toBeNull(); for (const status of ["EMPTY_BOOK", "CROSSED", "ERROR", "MISSED", "REFUSED", "NOT_FOUND"]) { expect(limitPrice("bid", snap({ status }))).toBeNull(); expect(limitPrice("mid", snap({ status }))).toBeNull(); }
  });
});

describe("touched: a later best ask at or below the limit", () => {
  it("exactly at the limit counts (the boundary), a float-noise hair above it counts, a tick above does not", () => {
    expect(touched(0.5, snap({ ask: 0.5 }))).toBe(true); expect(touched(0.5, snap({ ask: 0.5 + TOUCH_EPS / 2 }))).toBe(true); expect(touched(0.5, snap({ ask: 0.51 }))).toBe(false); expect(touched(0.5, snap({ ask: 0.49 }))).toBe(true);
  });
  it("a readable book without asks is known and not touched; an unreadable snapshot (or none) is unknown", () => {
    expect(touched(0.5, snap({ status: "ONE_SIDED", ask: null }))).toBe(false); expect(touched(0.5, snap({ status: "EMPTY_BOOK", bid: null, ask: null, mid: null }))).toBe(false);
    for (const status of ["CROSSED", "ERROR", "MISSED", "REFUSED", "NOT_FOUND"]) expect(touched(0.5, snap({ status, ask: 0.4 }))).toBeNull(); expect(touched(0.5, undefined)).toBeNull();
  });
});

describe("evaluate: one signal, with known answers", () => {
  it("touched only late: not at 60 s, exactly at the limit at 300 s → the touch price, the improvement over the taker, the avoided fee and the below-the-wallet flag", () => {
    const o = evaluate("bid", base(), [at(60, snap({ ask: 0.53 })), at(300, snap({ ask: 0.5 }))])!;
    expect(o.by).toEqual([{ offset: 60, known: true, touched: false }, { offset: 300, known: true, touched: true }]); expect(o.firstTouchOffset).toBe(300); expect(o.touchPrice).toBe(0.5); expect(o.limit).toBe(0.5);
    expect(o.improvementPts).toBeCloseTo(3, 9); expect(o.improvementPct).toBeCloseTo((0.03 / 0.53) * 100, 9); expect(o.avoidedFeePct).toBe(2); expect(o.belowSource).toBe(true); // 0.50 < the wallet's 0.52
  });
  it("touched early: the first touch is at 60 s, cumulative at 300 s, and the touch price is the ask at 60 s", () => {
    const o = evaluate("bid", base(), [at(60, snap({ ask: 0.49 })), at(300, snap({ ask: 0.7 }))])!; expect(o.by.map((b) => b.touched)).toEqual([true, true]); expect(o.firstTouchOffset).toBe(60); expect(o.touchPrice).toBe(0.49);
  });
  it("never touched: no touch price, no flag", () => {
    const o = evaluate("bid", base(), [at(60, snap({ ask: 0.53 })), at(300, snap({ ask: 0.51 }))])!; expect(o.by.map((b) => b.touched)).toEqual([false, false]); expect(o.firstTouchOffset).toBeNull(); expect(o.touchPrice).toBeNull(); expect(o.belowSource).toBeNull();
  });
  it("touched at a price AT or ABOVE the wallet's is not 'below the wallet's price' (the equality case)", () => {
    expect(evaluate("bid", base({ source: 0.5 }), [at(60, snap({ ask: 0.5 }))])!.belowSource).toBe(false); expect(evaluate("bid", base({ source: 0.51 }), [at(60, snap({ ask: 0.5 }))])!.belowSource).toBe(true);
    expect(evaluate("bid", base({ source: null }), [at(60, snap({ ask: 0.5 }))])!.belowSource).toBeNull();
  });
  it("the mid limit is the offset-0 mid, and is touched later than the bid limit would be", () => {
    const later = [at(60, snap({ ask: 0.505 })), at(300, snap({ ask: 0.505 }))]; expect(evaluate("bid", base(), later)!.by[1].touched).toBe(false); const m = evaluate("mid", base(), later)!; expect(m.limit).toBe(0.51); expect(m.by[1].touched).toBe(true); expect(m.improvementPts).toBeCloseTo(2, 9);
  });
  it("an unreadable snapshot breaks the cohort from there on: a later touch is not counted as known", () => {
    const o = evaluate("bid", base(), [at(60, snap({ status: "MISSED", ask: null })), at(300, snap({ ask: 0.4 }))])!; expect(o.by).toEqual([{ offset: 60, known: false, touched: false }, { offset: 300, known: false, touched: false }]); expect(o.firstTouchOffset).toBeNull();
    const o2 = evaluate("bid", base(), [at(60, snap({ ask: 0.4 })), at(300, undefined)])!; expect(o2.by).toEqual([{ offset: 60, known: true, touched: true }, { offset: 300, known: false, touched: false }]);
  });
  it("a book without asks later is known and untouched (empty or bid-only books)", () => {
    expect(evaluate("bid", base(), [at(60, snap({ status: "EMPTY_BOOK", bid: null, ask: null, mid: null }))])!.by[0]).toEqual({ offset: 60, known: true, touched: false });
  });
  it("a baseline that cannot support a limit (crossed, empty, bid-less) gives no outcome; a missing taker fill leaves the improvement null", () => {
    expect(evaluate("bid", base({ snap: snap({ status: "CROSSED" }) }), [at(60, snap())])).toBeNull(); expect(evaluate("bid", base({ snap: snap({ status: "EMPTY_BOOK", bid: null }) }), [at(60, snap())])).toBeNull();
    const o = evaluate("bid", base({ takerAvg: null, takerFeePct: null }), [at(60, snap({ ask: 0.4 }))])!; expect(o.improvementPts).toBeNull(); expect(o.improvementPct).toBeNull(); expect(o.avoidedFeePct).toBeNull();
  });
});

describe("PassiveAcc: shares by offset and the detail of the touched cohort", () => {
  const run = (cases: { later: [Snap | undefined, Snap | undefined]; base?: Partial<Base>; cluster?: string }[]) => {
    const a = new PassiveAcc("bid", 300); cases.forEach((c, i) => a.add(evaluate("bid", base(c.base), [at(60, c.later[0]), at(300, c.later[1])])!, c.cluster ?? `m${i}`)); return a.stats([60, 300]);
  };
  it("touched shares by 60 s and by 300 s over the readable cohorts, with the counts", () => {
    const s = run([
      { later: [snap({ ask: 0.49 }), snap({ ask: 0.6 })] }, // touched at 60
      { later: [snap({ ask: 0.53 }), snap({ ask: 0.5 })] }, // touched only at 300
      { later: [snap({ ask: 0.53 }), snap({ ask: 0.6 })] }, // never
      { later: [snap({ ask: 0.53 }), snap({ ask: 0.6 })] }, // never
      { later: [snap({ status: "MISSED", ask: null }), snap({ ask: 0.4 })] }, // 60 unreadable: out of both cohorts
    ]);
    expect(s.eligible).toBe(5); expect(s.rows).toEqual([{ offset: 60, known: 4, touched: 1, share: 0.25 }, { offset: 300, known: 4, touched: 2, share: 0.5 }]);
  });
  it("the detail covers the signals touched by the last offset: improvement, avoided fee (unknown counted), below-the-wallet share, and the share first touched only at the last offset", () => {
    const s = run([
      { later: [snap({ ask: 0.49 }), snap({ ask: 0.6 })], base: { source: 0.52 } }, // early, below the wallet
      { later: [snap({ ask: 0.53 }), snap({ ask: 0.5 })], base: { source: 0.5, takerFeePct: null } }, // late, at the wallet's price → not below; fee unknown
      { later: [snap({ ask: 0.53 }), snap({ ask: 0.5 })], base: { source: 0.6, takerAvg: 0.55 } }, // late, below; improvement 5 points
    ]); const d = s.touchedDetail;
    expect(d.n).toBe(3); expect(d.improvementPts.mean).toBeCloseTo((3 + 3 + 5) / 3, 9); expect(d.avoidedFeePct.n).toBe(2); expect(d.avoidedFeePct.mean).toBe(2); expect(d.avoidedFeeUnknown).toBe(1);
    expect(d.belowSourceShare).toBeCloseTo(2 / 3, 9); expect(d.firstTouchLateShare).toBeCloseTo(2 / 3, 9);
  });
  it("nothing touched → empty detail, shares of 0 (not null) where a cohort exists", () => { const s = run([{ later: [snap({ ask: 0.6 }), snap({ ask: 0.6 })] }]); expect(s.rows[1]).toMatchObject({ known: 1, touched: 0, share: 0 }); expect(s.touchedDetail.n).toBe(0); expect(s.touchedDetail.belowSourceShare).toBeNull(); });
  it("no readable cohort at all → share null, never a division by zero", () => { const s = run([{ later: [undefined, undefined] }]); expect(s.rows).toEqual([{ offset: 60, known: 0, touched: 0, share: null }, { offset: 300, known: 0, touched: 0, share: null }]); });
});
