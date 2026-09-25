import { describe, it, expect } from "vitest";
import { evaluate, applyFill, DEFAULT_CONFIG, looksLikeHedgeResidue, configFromEnv } from "@/lib/signals/rules";
import type { Fill, Position, WalletProfile } from "@/lib/polymarket/types";

const NOW = 1_789_658_160;
const wallet: WalletProfile = { address: "0xabc", name: "crckr", copyScore: 77, pnl90d: 289_530, style: "Selective directional", fillsPerDay: 12, programShare: 0.02, concentration: 0.1, netDd: 44, monthsUp: 3, monthsTotal: 3, daysIdle: 0, tradeCount: 3000, sources: [] };
const fill = (o: Partial<Fill> = {}): Fill => ({ id: "tx:tok:0xabc:1:BUY:1000", wallet: "0xabc", conditionId: "0xc1", tokenId: "tok1", side: "BUY", size: 10_000, price: 0.3, usd: 3000, ts: NOW, title: "Will X happen?", slug: "will-x-happen", outcome: "Yes", tx: "0xtx", source: "rest", ...o });
const ctx = (o: Partial<Parameters<typeof evaluate>[0]> = {}) => ({ fill: fill(), wallet, before: null, consensus: { peers: [] }, medianFillUsd: 200, hasOpenSignal: false, endDate: null, now: NOW, ...o });

describe("applyFill", () => {
  it("opens a position and tracks weighted average", () => {
    const p1 = applyFill(null, fill({ size: 100, price: 0.2 }), "2026-10-01");
    expect(p1.size).toBe(100); expect(p1.avgPrice).toBeCloseTo(0.2); expect(p1.costUsd).toBeCloseTo(20); expect(p1.endDate).toBe("2026-10-01");
    const p2 = applyFill(p1, fill({ size: 100, price: 0.4 }), null);
    expect(p2.size).toBe(200); expect(p2.avgPrice).toBeCloseTo(0.3); expect(p2.peakSize).toBe(200);
    const p3 = applyFill(p2, fill({ side: "SELL", size: 200, price: 0.5 }), null);
    expect(p3.size).toBe(0); expect(p3.avgPrice).toBe(0); expect(p3.peakSize).toBe(200);
  });
  it("never goes negative on an over-sell", () => { const p = applyFill(applyFill(null, fill({ size: 10 }), null), fill({ side: "SELL", size: 50 }), null); expect(p.size).toBe(0); });
});

describe("evaluate: gates", () => {
  it("ignores dust", () => { expect(evaluate(ctx({ fill: fill({ usd: 10, size: 30 }) }))).toEqual([]); });
  it("ignores bot-like wallets", () => { expect(evaluate(ctx({ wallet: { ...wallet, style: "Market maker / bot" } }))).toEqual([]); expect(evaluate(ctx({ wallet: { ...wallet, fillsPerDay: 900 } }))).toEqual([]); });
  it("ignores wallets under the score floor", () => { expect(evaluate(ctx({ wallet: { ...wallet, copyScore: 20 } }))).toEqual([]); });
  it("ignores neg-risk hedge residue", () => { const f = fill({ price: 0.5, usd: 100, size: 200 }); expect(looksLikeHedgeResidue(f, null)).toBe(true); expect(evaluate(ctx({ fill: f }))).toEqual([]); });
});

describe("evaluate: NEW_POSITION", () => {
  it("fires on a fresh buy above the notional floor", () => {
    const s = evaluate(ctx()); expect(s.map((x) => x.kind)).toContain("NEW_POSITION");
    const n = s.find((x) => x.kind === "NEW_POSITION")!; expect(n.severity).toBeGreaterThanOrEqual(2); expect(n.dedupeKey).toMatch(/^NEW:0xabc:tok1:/);
  });
  it("fires on a buy that is 2× the wallet's median fill even below the USD floor", () => {
    const s = evaluate(ctx({ fill: fill({ usd: 600, size: 2000 }), medianFillUsd: 250 })); expect(s.map((x) => x.kind)).toContain("NEW_POSITION");
  });
  it("does not fire on a small add to an existing position", () => {
    const before: Position = { wallet: "0xabc", tokenId: "tok1", conditionId: "0xc1", outcome: "Yes", title: "", slug: "", size: 50_000, avgPrice: 0.3, costUsd: 15_000, peakSize: 50_000, firstSeen: NOW - 1000, lastSeen: NOW - 1000, endDate: null };
    const s = evaluate(ctx({ before, fill: fill({ size: 1000, usd: 300 }) })); expect(s.map((x) => x.kind)).not.toContain("NEW_POSITION");
  });
  it("dedupe key changes across the dedupe window", () => {
    const a = evaluate(ctx())[0]; const b = evaluate(ctx({ fill: fill({ ts: NOW + DEFAULT_CONFIG.dedupeMinutes * 60 + 1 }) }))[0];
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });
});

describe("evaluate: CONVICTION_ADD", () => {
  const before: Position = { wallet: "0xabc", tokenId: "tok1", conditionId: "0xc1", outcome: "Yes", title: "", slug: "", size: 10_000, avgPrice: 0.35, costUsd: 3500, peakSize: 10_000, firstSeen: NOW - 1000, lastSeen: NOW - 1000, endDate: null };
  it("fires when the add is ≥50% at no worse than entry", () => { expect(evaluate(ctx({ before, fill: fill({ size: 6000, price: 0.33, usd: 1980 }) })).map((x) => x.kind)).toContain("CONVICTION_ADD"); });
  it("does not fire when averaging down below 50% or at a worse price", () => {
    expect(evaluate(ctx({ before, fill: fill({ size: 2000, price: 0.33, usd: 660 }) })).map((x) => x.kind)).not.toContain("CONVICTION_ADD");
    expect(evaluate(ctx({ before, fill: fill({ size: 6000, price: 0.45, usd: 2700 }) })).map((x) => x.kind)).not.toContain("CONVICTION_ADD");
  });
});

describe("evaluate: EARLY_ENTRY", () => {
  it("fires for a long shot inside 30 days by an all-months-up wallet", () => {
    const s = evaluate(ctx({ fill: fill({ price: 0.12, size: 5000, usd: 600 }), endDate: "2026-09-30" })); expect(s.map((x) => x.kind)).toContain("EARLY_ENTRY");
    expect(s.find((x) => x.kind === "EARLY_ENTRY")!.payload.daysToEnd).toBeGreaterThanOrEqual(12); expect(s.find((x) => x.kind === "EARLY_ENTRY")!.payload.daysToEnd).toBeLessThanOrEqual(13);
  });
  it("does not fire for a wallet with a down month or a far-off market", () => {
    expect(evaluate(ctx({ fill: fill({ price: 0.12, size: 5000, usd: 600 }), endDate: "2026-09-30", wallet: { ...wallet, monthsUp: 2 } })).map((x) => x.kind)).not.toContain("EARLY_ENTRY");
    expect(evaluate(ctx({ fill: fill({ price: 0.12, size: 5000, usd: 600 }), endDate: "2027-06-30" })).map((x) => x.kind)).not.toContain("EARLY_ENTRY");
  });
});

describe("evaluate: CONSENSUS", () => {
  it("fires when a second tracked wallet joins inside the window and carries the count", () => {
    const s = evaluate(ctx({ consensus: { peers: [{ wallet: "0xdef", lastBuyTs: NOW - 3600, copyScore: 60 }] } }));
    const c = s.find((x) => x.kind === "CONSENSUS")!; expect(c).toBeTruthy(); expect(c.payload.wallets).toBe(2); expect(c.dedupeKey).toBe("CONS:tok1:2");
  });
  it("ignores peers outside the 72h window and the wallet itself", () => {
    const s = evaluate(ctx({ consensus: { peers: [{ wallet: "0xdef", lastBuyTs: NOW - 80 * 3600, copyScore: 60 }, { wallet: "0xabc", lastBuyTs: NOW, copyScore: 77 }] } }));
    expect(s.map((x) => x.kind)).not.toContain("CONSENSUS");
  });
});

describe("evaluate: EXIT", () => {
  const before: Position = { wallet: "0xabc", tokenId: "tok1", conditionId: "0xc1", outcome: "Yes", title: "", slug: "", size: 10_000, avgPrice: 0.3, costUsd: 3000, peakSize: 10_000, firstSeen: NOW - 1000, lastSeen: NOW - 1000, endDate: null };
  it("fires when ≥60% of an alerted position is sold", () => {
    const s = evaluate(ctx({ before, hasOpenSignal: true, fill: fill({ side: "SELL", size: 7000, price: 0.6, usd: 4200 }) }));
    const e = s.find((x) => x.kind === "EXIT")!; expect(e).toBeTruthy(); expect(e.payload.soldFraction).toBe(0.7); expect(e.payload.pnlPerShare).toBeCloseTo(0.3);
  });
  it("stays quiet on a trim, or when nothing was alerted", () => {
    expect(evaluate(ctx({ before, hasOpenSignal: true, fill: fill({ side: "SELL", size: 2000, price: 0.6, usd: 1200 }) }))).toEqual([]);
    expect(evaluate(ctx({ before, hasOpenSignal: false, fill: fill({ side: "SELL", size: 9000, price: 0.6, usd: 5400 }) }))).toEqual([]);
  });
});

describe("configFromEnv", () => {
  it("reads overrides and falls back to defaults", () => {
    const c = configFromEnv({ MIN_FILL_USD: "25", EXIT_SELL_RATIO: "abc" }); expect(c.minFillUsd).toBe(25); expect(c.exitSellRatio).toBe(DEFAULT_CONFIG.exitSellRatio);
  });
});

describe("volume control", () => {
  it("bot-like wallets are recognised so the engine can skip them before any database work", async () => {
    const { isBotLike } = await import("@/lib/signals/rules");
    expect(isBotLike({ ...wallet, style: "Market maker / bot" })).toBe(true);
    expect(isBotLike({ ...wallet, fillsPerDay: 900 })).toBe(true);
    expect(isBotLike(wallet)).toBe(false);
  });
});
