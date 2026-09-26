/** Phase 2 — realistic paper execution. Letters map to the brief's §23 test list. */
import { describe, it, expect } from "vitest";
import { MODES, type ExecConfig, type PortfolioConfig } from "@/lib/paper/sim/config";
import { simulateEntry, simulateExit, lifecycle, timeline, takerFee, usableObs, type EntryInput, type ExitInput } from "@/lib/paper/sim/execute";
import { simulatePortfolio, type PortfolioSignal } from "@/lib/paper/sim/portfolio";
import { execReport, type SimRow } from "@/lib/paper/sim/report";
import { observeAt, evalTsOf, buildSignals, simulateMode, BACKFILL_INSTANT, type SimInputs } from "@/lib/paper/sim/run";
import { parseV2Resolution } from "@/lib/paper/mark";
import { parseGammaExecMeta } from "@/lib/polymarket/markets";

const T0 = 1_790_000_000;
const R: ExecConfig = { ...MODES.REALISTIC, paperSizeUsd: 100 }; const C: ExecConfig = { ...MODES.CONSERVATIVE, paperSizeUsd: 100 }; const I: ExecConfig = { ...MODES.IDEAL, paperSizeUsd: 100 };
const noFee = { feesEnabled: false, takerFeeRate: null, tickSize: 0.01, minOrderShares: 5 };
const entry = (o: Partial<EntryInput> = {}): EntryInput => ({ sourceTs: T0, evalTs: T0 + 60, signalPrice: 0.4, sourceUsd: 5000, obs: { ts: T0 + 65, price: 0.42, resolutionSeconds: 0 }, market: noFee, ...o });
const exitIn = (o: Partial<ExitInput> = {}): ExitInput => ({ triggerTs: T0 + 3600, triggerEvalTs: T0 + 3660, triggerPrice: 0.6, triggerUsd: 5000, obs: { ts: T0 + 3665, price: 0.58, resolutionSeconds: 0 }, market: noFee, ...o });

describe("A–D execution prices, latency, slippage", () => {
  it("A: realistic entry ≠ signal price; the three prices are kept apart", () => {
    const e = simulateEntry(entry(), R);
    expect(e.status).toBe("FILLED"); expect(e.marketPrice).toBe(0.42); expect(e.fillPrice).not.toBe(0.4);
    expect(e.latencyCost).toBeCloseTo(e.filledShares * 0.02, 9); expect(e.slippageCost).toBeCloseTo(e.filledShares * (e.fillPrice! - 0.42), 9);
  });
  it("IDEAL reproduces the old ledger: entry at signal price, zero latency, no costs", () => {
    const e = simulateEntry(entry(), I); expect(e.fillPrice).toBe(0.4); expect(e.timing.fillTs).toBe(T0); expect(e.filledShares).toBeCloseTo(250, 9); expect(e.fee + e.slippageCost + e.latencyCost).toBe(0);
  });
  it("B: latency moves the fill time — observed evaluation time when recorded, assumption otherwise", () => {
    expect(timeline(T0, T0 + 60, R)).toMatchObject({ evalTs: T0 + 60, submitTs: T0 + 65, fillTs: T0 + 70, latencySource: "OBSERVED" });
    expect(timeline(T0, null, R)).toMatchObject({ evalTs: T0 + 134, fillTs: T0 + 144, latencySource: "ASSUMED" });
    expect(timeline(T0, null, C).fillTs).toBe(T0 + 3173 + 75);
  });
  it("C: entry slippage = spread + size-scaled impact, rounded against the trader", () => {
    const e = simulateEntry(entry(), R); // 1 spread tick + 1 × (100/5000) impact → 1.02 ticks → rounds up to 0.44
    expect(e.fillPrice).toBe(0.44); expect(e.slippageTicks).toBeCloseTo(2, 9);
    const big = simulateEntry(entry({ sourceUsd: 100 }), R); expect(big.fillPrice).toBe(0.44); // 1 + 1 = 2 ticks exactly
    const cons = simulateEntry(entry(), C); expect(cons.fillPrice).toBe(0.45);
  });
  it("tick drops to 0.001 in the tails", () => { expect(simulateEntry(entry({ signalPrice: 0.97, obs: { ts: T0 + 65, price: 0.97, resolutionSeconds: 0 } }), R).fillPrice).toBe(0.972); });
  it("D: exit slippage lowers the sale price", () => {
    const x = simulateExit(exitIn(), 200, R); expect(x.marketPrice).toBe(0.58); expect(x.fillPrice).toBeLessThan(0.58); expect(x.proceeds).toBeCloseTo(200 * x.fillPrice!, 9); expect(x.slippageCost).toBeCloseTo(200 * (0.58 - x.fillPrice!), 9);
  });
});

describe("E–F fills", () => {
  it("E: partial fill — P&L on the filled size only", () => {
    const e = simulateEntry(entry({ sourceUsd: 60 }), R); // cap = 1× $60 of a $100 order
    expect(e.status).toBe("PARTIALLY_FILLED"); expect(e.filledUsd).toBe(60); expect(e.fillPct).toBeCloseTo(0.6, 9);
    const life = lifecycle(e, null, { ts: T0 + 86400, value: 1 }, null, R);
    expect(life.grossPnl).toBeCloseTo(e.filledShares * 1 - 60, 9);
  });
  it("F: an unfilled trade has zero P&L, even if the market later resolves in its favour", () => {
    const e = simulateEntry(entry({ sourceUsd: 1 }), R); expect(e.status).toBe("UNFILLED");
    const life = lifecycle(e, null, { ts: T0 + 86400, value: 1 }, { ts: T0 + 7200, price: 0.9 }, R);
    expect(life.state).toBe("NOT_ENTERED"); expect(life.netPnl).toBe(0); expect(life.grossPnl).toBe(0);
  });
  it("no price observation → UNKNOWN, never assumed", () => { expect(simulateEntry(entry({ obs: null }), R)).toMatchObject({ status: "UNKNOWN", reason: "NO_PRICE_OBSERVATION", filledUsd: 0 }); });
  it("stale quote → UNKNOWN; settled market → INVALID; late order → EXPIRED (conservative)", () => {
    expect(simulateEntry(entry({ obs: { ts: T0 - 10_000, price: 0.42, resolutionSeconds: 0 } }), R).reason).toBe("STALE_QUOTE");
    expect(simulateEntry(entry({ obs: { ts: T0 + 60, price: 1, resolutionSeconds: 0 } }), R).reason).toBe("MARKET_SETTLED_BEFORE_FILL");
    expect(simulateEntry(entry({ evalTs: T0 + 7200, obs: { ts: T0 + 7200, price: 0.42, resolutionSeconds: 0 } }), C)).toMatchObject({ status: "EXPIRED", reason: "EXECUTION_TIMEOUT" });
  });
  it("a fill priced at or above 1 is INVALID", () => { expect(simulateEntry(entry({ obs: { ts: T0 + 65, price: 0.999, resolutionSeconds: 0 } }), R).reason).toBe("FILL_PRICE_OUT_OF_RANGE"); });
});

describe("M–N fees and slippage cost", () => {
  it("M: taker fee = shares × rate × p × (1 − p), reducing net but not gross", () => {
    expect(takerFee(200, 0.5, 0.07)).toBeCloseTo(3.5, 9);
    const e = simulateEntry(entry({ market: { feesEnabled: true, takerFeeRate: 0.05, tickSize: 0.01, minOrderShares: 5 } }), R);
    expect(e.feeSource).toBe("OBSERVED"); expect(e.fee).toBeCloseTo(e.filledShares * 0.05 * e.fillPrice! * (1 - e.fillPrice!), 9);
    const life = lifecycle(e, null, { ts: T0 + 86400, value: 1 }, null, R); expect(life.grossPnl - life.netPnl).toBeCloseTo(life.fees, 9);
  });
  it("fee flag false → zero (observed); unknown → mode fallback (assumed)", () => {
    expect(simulateEntry(entry(), R)).toMatchObject({ fee: 0, feeSource: "OBSERVED" });
    expect(simulateEntry(entry({ market: null }), R).feeSource).toBe("ASSUMED");
  });
  it("N: slippage cost is separate from market P&L and from latency cost", () => {
    const e = simulateEntry(entry(), R); const l = lifecycle(e, null, { ts: T0 + 86400, value: 1 }, null, R);
    // gross P&L = market move from our fill; latency and slippage are what separate it from the ideal
    const ideal = lifecycle(simulateEntry(entry(), I), null, { ts: T0 + 86400, value: 1 }, null, I);
    expect(ideal.grossPnl / 250 - l.grossPnl / e.filledShares).toBeCloseTo((e.latencyCost + e.slippageCost) / e.filledShares, 9);
  });
});

describe("P look-ahead", () => {
  it("an observation stamped after the fill time is rejected", () => {
    expect(usableObs({ ts: T0 + 100, price: 0.5, resolutionSeconds: 0 }, T0 + 70, R)).toMatchObject({ ok: false, reason: "LOOKAHEAD_OBSERVATION_REJECTED" });
    expect(usableObs({ ts: T0 + 60, price: 0.5, resolutionSeconds: 60 }, T0 + 70, R)).toMatchObject({ ok: false, reason: "LOOKAHEAD_OBSERVATION_REJECTED" }); // bucket still open
  });
  it("observeAt never returns a bucket extending past the decision time", async () => {
    const calls: number[] = [];
    const src = { async priceAsOf(_t: string, asOf: number) { calls.push(asOf); return asOf >= T0 + 60 ? { ts: T0 + 60, price: 0.9, resolutionSeconds: 60 } : { ts: T0, price: 0.4, resolutionSeconds: 60 }; } };
    expect(await observeAt(src, "tok", T0 + 70)).toEqual({ ts: T0, price: 0.4, resolutionSeconds: 60 }); expect(calls).toEqual([T0 + 70, T0 + 59]);
  });
  it("future prices, resolution and marks cannot change whether or how an earlier order filled", () => {
    const base = simulateEntry(entry(), R);
    const withFuture = lifecycle(simulateEntry(entry(), R), null, { ts: T0 + 999, value: 0 }, { ts: T0 + 500, price: 0.01 }, R);
    expect(withFuture.entry).toEqual(base);
  });
  it("an exit trigger before our fill, or a resolution before the exit, does not close our position", () => {
    const e = simulateEntry(entry(), R);
    expect(lifecycle(e, { input: exitIn({ triggerTs: T0 + 5, triggerEvalTs: T0 + 6 }) }, null, null, R).exit).toBeNull();
    const l = lifecycle(e, { input: exitIn() }, { ts: T0 + 1000, value: 1 }, null, R); expect(l.exit).toBeNull(); expect(l.state).toBe("RESOLVED");
  });
});

describe("Q–R resolution and independence", () => {
  it("Q: resolution settles remaining shares at the payout with no slippage or fee", () => {
    const e = simulateEntry(entry({ market: { feesEnabled: true, takerFeeRate: 0.05, tickSize: 0.01, minOrderShares: 5 } }), R);
    const l = lifecycle(e, null, { ts: T0 + 86400, value: 1 }, null, R);
    expect(l.state).toBe("RESOLVED"); expect(l.resolution!.proceeds).toBeCloseTo(e.filledShares, 9); expect(l.fees).toBeCloseTo(e.fee, 9); expect(l.closedAt).toBe(T0 + 86400);
  });
  it("Q: partial exit leaves the remainder to resolution", () => {
    const e = simulateEntry(entry(), R); const l = lifecycle(e, { input: exitIn({ triggerUsd: 50 }) }, { ts: T0 + 86400, value: 0 }, null, R);
    expect(l.exit!.status).toBe("PARTIALLY_FILLED"); expect(l.resolution!.shares).toBeCloseTo(e.filledShares - l.exit!.soldShares, 9); expect(l.state).toBe("RESOLVED");
  });
  it("v2 resolution payouts map to the right token and never guess", () => {
    const row = { status: "resolved", payouts: [0, 1_000_000], resolved_at: "2026-09-20T12:00:00Z" };
    expect(parseV2Resolution(row, "B", ["A", "B"])).toMatchObject({ state: "resolved", finalPrice: 1, resolvedAt: Math.floor(Date.parse("2026-09-20T12:00:00Z") / 1000) });
    expect(parseV2Resolution(row, "A", ["A", "B"])).toMatchObject({ finalPrice: 0 });
    expect(parseV2Resolution(row, "X", null, "Team A").state).toBe("unknown"); expect(parseV2Resolution(row, "X", null, "No")).toMatchObject({ finalPrice: 1 });
    expect(parseV2Resolution({ status: "proposed" }, "A", ["A", "B"]).state).toBe("open"); expect(parseV2Resolution({ status: "resolved", payouts: [500_000, 500_000] }, "A", ["A", "B"])).toMatchObject({ finalPrice: 0.5 });
  });
  it("R: independent experiments stay independent — every signal gets its own full $100 regardless of the others", () => {
    const inputs = mkInputs(3); const out = simulateMode(buildSignals(inputs), inputs, R);
    expect(out.rows).toHaveLength(3); expect(out.rows.every((r) => r.life.entry.requestedUsd === 100)).toBe(true);
  });
});

// ── portfolio
const PC: PortfolioConfig = { startingCapitalUsd: 1000, positionUsd: 100, maxMarketExposureUsd: 1000, maxTotalExposurePct: 100, maxOpenPositions: 100, maxWalletAllocationUsd: 1000, minCashReserveUsd: 0, allowResize: false };
let n = 0;
const ps = (o: Partial<PortfolioSignal> & { at?: number } = {}): PortfolioSignal => { const id = `s${String(++n).padStart(4, "0")}`; const at = o.at ?? T0; return { signalId: id, kind: "NEW_POSITION", wallet: "w1", conditionId: "c1", tokenId: "t1", sourceKey: id, entry: entry({ sourceTs: at, evalTs: at + 60, obs: { ts: at + 65, price: 0.42, resolutionSeconds: 0 } }), exit: null, resolution: null, mark: null, ...o }; };
describe("G–L, O, S portfolio", () => {
  it("G: cash decreases by the filled cost on entry", () => {
    const r = simulatePortfolio([ps()], R, PC); expect(r.decisions[0].outcome).toBe("FILLED"); expect(r.endingCash).toBeCloseTo(900, 9); expect(r.invested).toBeCloseTo(100, 9);
  });
  it("H: exit returns proceeds to cash and clears exposure", () => {
    const s = ps({ exit: exitIn() }); const r = simulatePortfolio([s], R, PC);
    const x = simulateExit(exitIn(), simulateEntry(s.entry, R).filledShares, R);
    expect(r.invested).toBe(0); expect(r.endingCash).toBeCloseTo(900 + x.proceeds - x.fee, 9); expect(r.realizedPnl).toBeCloseTo(x.proceeds - 100 - x.fee, 9);
  });
  it("I: max market exposure rejects (or resizes when allowed)", () => {
    const pc = { ...PC, maxMarketExposureUsd: 150 };
    const r = simulatePortfolio([ps({ at: T0 }), ps({ at: T0 + 10 })], R, pc); expect(r.decisions[1]).toMatchObject({ outcome: "REJECTED", reason: "REJECTED_MAX_MARKET_EXPOSURE" });
    const r2 = simulatePortfolio([ps({ at: T0 }), ps({ at: T0 + 10 })], R, { ...pc, allowResize: true }); expect(r2.decisions[1].filledUsd).toBeCloseTo(50, 9); expect(r2.decisions[1].reason).toMatch(/^RESIZED/);
  });
  it("J: max total exposure rejects", () => { const r = simulatePortfolio([ps({ at: T0 }), ps({ at: T0 + 1, conditionId: "c2" })], R, { ...PC, maxTotalExposurePct: 15 }); expect(r.decisions[1].reason).toBe("REJECTED_MAX_PORTFOLIO_EXPOSURE"); });
  it("K: insufficient cash rejects", () => { const r = simulatePortfolio([ps({ at: T0 }), ps({ at: T0 + 1, conditionId: "c2" })], R, { ...PC, startingCapitalUsd: 150 }); expect(r.decisions[1].reason).toBe("REJECTED_INSUFFICIENT_CASH"); });
  it("L: two signals from one source trade (e.g. NEW_POSITION + CONSENSUS) take one position", () => {
    const a = ps({ sourceKey: "same" }); const b = ps({ sourceKey: "same", kind: "CONSENSUS" }); const r = simulatePortfolio([a, b], R, PC);
    expect(r.decisions.map((d) => d.outcome).sort()).toEqual(["FILLED", "REJECTED"]); expect(r.decisions.find((d) => d.outcome === "REJECTED")!.reason).toBe("REJECTED_DUPLICATE_POSITION"); expect(r.invested).toBeCloseTo(100, 9);
  });
  it("S: capital is finite — 15 signals, $1,000, $100 each → 10 fill, 5 rejected; freed cash is reusable after resolution", () => {
    const sig = Array.from({ length: 15 }, (_, i) => ps({ at: T0 + i, conditionId: `c${i}`, wallet: `w${i}` })); const r = simulatePortfolio(sig, R, PC);
    expect(r.decisions.filter((d) => d.outcome === "FILLED")).toHaveLength(10); expect(r.decisions.filter((d) => d.reason === "REJECTED_INSUFFICIENT_CASH")).toHaveLength(5);
    const withRes = [ps({ at: T0, resolution: { ts: T0 + 500, value: 1 } }), ...Array.from({ length: 10 }, (_, i) => ps({ at: T0 + 1000 + i, conditionId: `d${i}`, wallet: `v${i}` }))];
    expect(simulatePortfolio(withRes, R, PC).decisions.filter((d) => d.outcome === "FILLED")).toHaveLength(11);
  });
  it("max open positions rejects", () => { const r = simulatePortfolio([ps({ at: T0 }), ps({ at: T0 + 1, conditionId: "c2" })], R, { ...PC, maxOpenPositions: 1 }); expect(r.decisions[1].reason).toBe("REJECTED_MAX_OPEN_POSITIONS"); });
  it("O: same input → identical result, regardless of input order", () => {
    const sig = Array.from({ length: 30 }, (_, i) => ps({ at: T0 + (i % 5), conditionId: `c${i % 7}`, resolution: i % 3 ? { ts: T0 + 900, value: i % 2 } : null }));
    const a = simulatePortfolio(sig, R, PC); const b = simulatePortfolio([...sig].reverse(), R, PC); expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("reporting and outliers", () => {
  const row = (id: string, net: number, i: number): SimRow => { const e = simulateEntry(entry(), I); const life = lifecycle(e, null, { ts: T0 + 100 + i, value: net > 0 ? 1 : 0 }, null, I); return { signalId: id, kind: "NEW_POSITION", closedAt: life.closedAt, life: { ...life, netPnl: net, grossPnl: net } }; };
  it("excludes best-N winners diagnostically and computes profit factor/expectancy", () => {
    const rows = [row("a", 150, 1), row("b", 50, 2), row("c", -100, 3), row("d", -20, 4), row("e", 10, 5)]; const r = execReport(rows);
    expect(r.robustness.exBest1).toBeCloseTo(90 - 150, 9); expect(r.robustness.exBest3).toBeCloseTo(90 - 210, 9); expect(r.robustness.profitFactor).toBeCloseTo(210 / 120, 9);
    expect(r.robustness.expectancy).toBeCloseTo(18, 9); expect(r.robustness.largestWin).toBe(150); expect(r.robustness.largestLoss).toBe(-100); expect(r.maxDrawdown).toBeCloseTo(120, 9);
  });
});

// ── orchestration inputs
function mkInputs(k: number): SimInputs {
  const signals = Array.from({ length: k }, (_, i) => ({ id: `sig-${i}`, kind: i === 1 ? "CONSENSUS" : "NEW_POSITION", wallet: "w1", condition_id: "c1", token_id: "t1", price: 0.4, usd: 5000, payload: {}, created_at: new Date(T0 * 1000).toISOString(), evaluated_at: new Date((T0 + 60) * 1000).toISOString() }));
  const obs = new Map([[`t1@${T0 + 70}`, { ts: T0 + 65, price: 0.42, resolutionSeconds: 0 }]]);
  return { signals, ledger: new Map(), marks: new Map(), resolutions: new Map(), markets: new Map(), obs };
}
describe("orchestration", () => {
  it("uses paper_ledger.created_at as observed evaluation time, except for the back-filled batch", () => {
    expect(evalTsOf({ created_at: "2026-09-20T00:00:00Z" }, { created_at: "2026-09-20T00:02:14Z" })).toBe(Math.floor(Date.parse("2026-09-20T00:02:14Z") / 1000));
    expect(evalTsOf({}, { created_at: new Date(BACKFILL_INSTANT.from + 5000).toISOString() })).toBeNull();
    expect(evalTsOf({ evaluated_at: "2026-09-20T00:00:05Z" }, { created_at: "2026-09-21T00:00:00Z" })).toBe(Math.floor(Date.parse("2026-09-20T00:00:05Z") / 1000));
  });
  it("signals whose price observation has not been fetched yet are pending, not guessed", () => {
    const inputs = mkInputs(2); inputs.obs.clear(); const out = simulateMode(buildSignals(inputs), inputs, R); expect(out.rows).toHaveLength(0); expect(out.pending).toBe(2);
    expect(simulateMode(buildSignals(inputs), inputs, I).rows).toHaveLength(2); // IDEAL needs no market lookup
  });
  it("Gamma execution metadata parses fees/tick/min size and never invents them", () => {
    expect(parseGammaExecMeta("0xC", { feesEnabled: true, orderPriceMinTickSize: 0.001, orderMinSize: 5, clobTokenIds: '["a","b"]' })).toMatchObject({ conditionId: "0xc", feesEnabled: true, tickSize: 0.001, minOrderShares: 5, clobTokenIds: ["a", "b"], takerFeeRate: null });
    expect(parseGammaExecMeta("c", {})).toMatchObject({ feesEnabled: null, tickSize: null, minOrderShares: null, clobTokenIds: null });
  });
});
