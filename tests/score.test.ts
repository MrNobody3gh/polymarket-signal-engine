import { describe, it, expect } from "vitest";
import { windowPnl, maxDrawdown, monthsUp, copyScore, classifyStyle, buildProfile, programShare, concentration, statTradeCount, statVolumeUsd, DAY } from "@/lib/scoring/score";

const NOW = 1_789_658_160; // 2026-09-17
const curve = (vals: number[], endTs = NOW) => vals.map((pnl, i) => ({ ts: endTs - (vals.length - 1 - i) * DAY, pnl }));

describe("windowPnl", () => {
  it("is last minus the value at the window start", () => { const c = curve([0, 100, 150, 120, 300]); expect(windowPnl(c, NOW, 2)).toBe(150); expect(windowPnl(c, NOW, 90)).toBe(300); });
  it("treats a curve that starts inside the window as starting from zero", () => { const c = curve([-50, 20, 80]); expect(windowPnl(c, NOW, 90)).toBe(80); });
  it("is zero for a dormant curve", () => { const c = curve([0, 100, 200], NOW - 200 * DAY); expect(windowPnl(c, NOW, 90)).toBe(0); });
});

describe("maxDrawdown", () => {
  it("seeds the peak at zero so an inception loss counts", () => { const d = maxDrawdown(curve([-176_289, -100_000, 50_000])); expect(d.maxDdUsd).toBe(176_289); expect(d.moves).toBe(3); });
  it("measures peak-to-trough", () => { const d = maxDrawdown(curve([0, 100, 40, 120, 90])); expect(d.maxDdUsd).toBe(60); });
  it("flags a flat back-filled line with few moves", () => { expect(maxDrawdown(curve(Array(30).fill(500))).moves).toBe(1); });
});

describe("monthsUp", () => {
  it("counts calendar months inside the window that finished up", () => {
    // 100 daily points ending 2026-09-17: +1/day in Jul, −1/day in Aug, +1/day in Sep
    const pts: { ts: number; pnl: number }[] = []; let v = 0;
    for (let i = 99; i >= 0; i--) { const ts = NOW - i * DAY; const m = new Date(ts * 1000).getUTCMonth(); v += m === 7 ? -1 : 1; pts.push({ ts, pnl: v }); }
    const r = monthsUp(pts, NOW, 90); expect(r.total).toBe(4); expect(r.up).toBe(3); // Jun(partial) Jul Sep up, Aug down
  });
});

describe("copyScore", () => {
  const base = { pnl90d: 100_000, netDd: 20, monthsUp: 3, monthsTotal: 3, fillsPerDay: 20, programShare: 0.02, concentration: 0.1, edgePerDollar: 0.08, daysIdle: 0, rankable: true };
  it("is zero when the window is not profitable", () => { expect(copyScore({ ...base, pnl90d: -5 })).toBe(0); });
  it("rewards a consistent, low-drawdown, human-speed wallet", () => { expect(copyScore(base)).toBeGreaterThan(70); });
  it("penalises bots, program income, concentration and dormancy", () => {
    expect(copyScore({ ...base, fillsPerDay: 5000 })).toBeLessThan(copyScore(base) - 20);
    expect(copyScore({ ...base, programShare: 0.6 })).toBeLessThan(copyScore(base) - 10);
    expect(copyScore({ ...base, concentration: 0.9 })).toBeLessThan(copyScore(base) - 5);
    expect(copyScore({ ...base, daysIdle: 45 })).toBeLessThan(copyScore(base) - 25);
  });
  it("caps at 100 and the profit term at 40", () => { expect(copyScore({ ...base, pnl90d: 1e12, netDd: 1e6 })).toBeLessThanOrEqual(100); });
});

describe("classifyStyle", () => {
  it("maps the thresholds", () => {
    expect(classifyStyle({ fillsPerDay: 600, programShare: 0, concentration: 0, edgePerDollar: 0.05 })).toBe("Market maker / bot");
    expect(classifyStyle({ fillsPerDay: 5, programShare: 0.3, concentration: 0, edgePerDollar: 0.05 })).toBe("Market maker / bot");
    expect(classifyStyle({ fillsPerDay: 5, programShare: 0, concentration: 0.5, edgePerDollar: 0.05 })).toBe("Lottery ticket");
    expect(classifyStyle({ fillsPerDay: 5, programShare: 0, concentration: 0.1, edgePerDollar: 0.3 })).toBe("Concentrated directional");
    expect(classifyStyle({ fillsPerDay: 200, programShare: 0, concentration: 0.1, edgePerDollar: 0.05 })).toBe("High-frequency directional");
    expect(classifyStyle({ fillsPerDay: 20, programShare: 0, concentration: 0.1, edgePerDollar: 0.05 })).toBe("Selective directional");
  });
});

describe("programShare / concentration / buildProfile", () => {
  const stats = { proxy_wallet: "0xabc", trades: 100, biggest_win: 20_000, views: 0, volume_usdc: 2_000_000, trade_count: 3000, all_time_pnl: { realized_market_pnl: 180_000, realized_combo_pnl: 0, realized_lp_pnl: 0, maker_rebate: 10_000, taker_rebate: 0, reward_income: 10_000, position_pnl: 200_000 } };
  it("computes program share and concentration", () => { expect(programShare(stats)).toBeCloseTo(0.1); expect(concentration(stats)).toBeCloseTo(20_000 / 180_000); });
  it("builds a full profile from stats + curve", () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({ timestamp: NOW - (199 - i) * DAY, position_pnl: i * 1000 }));
    const p = buildProfile("0xABC", "test", stats, pts, NOW, ["lb:overall:month"]);
    expect(p.address).toBe("0xabc"); expect(p.pnl90d).toBe(90_000); expect(p.monthsTotal).toBeGreaterThanOrEqual(3); expect(p.fillsPerDay).toBeCloseTo(15); expect(p.copyScore).toBeGreaterThan(50); expect(p.style).toBe("Selective directional"); expect(p.daysIdle).toBe(0);
  });
});

// Captured from GET /v2/user-stats on 2026-09-26 (crckr). The fill count and USD volume are nested in all_time_pnl; the top
// level carries only `trades` (distinct markets). Reading the top level silently cost every wallet 20 points.
const LIVE_STATS = { proxy_wallet: "0x2b3d1e9bdf941d435dc91a8b974b86f7064c8db7", trades: 5443, biggest_win: 3418.350714, views: 907, join_date: 1722406784,
  all_time_pnl: { realized_market_pnl: 45848.737706, realized_lp_pnl: 0, realized_combo_pnl: 139.289063, unrealized_pnl: 260640.932301, maker_rebate: 249.6391, taker_rebate: 318.631,
    reward_income: 11548.64454, yield_income: 1.0669, referral_income: 0, position_pnl: 306628.95907, volume: 6870783.31732, volume_usdc: 650107.67891, trade_count: 29257 } };

describe("user-stats shape (current API nests trade_count / volume_usdc)", () => {
  const pts = Array.from({ length: 200 }, (_, i) => ({ timestamp: NOW - (199 - i) * DAY, position_pnl: i * 1000 + (i % 3) * 50 }));
  const measured = { status: "OK" as const, fillsPerDay: 36 };
  it("reads the nested fields, falls back to the old top-level shape, and never invents a value", () => {
    expect(statTradeCount(LIVE_STATS)).toBe(29257); expect(statVolumeUsd(LIVE_STATS)).toBeCloseTo(650107.68, 1);
    expect(statTradeCount({ proxy_wallet: "0x", trades: 1, biggest_win: 0, trade_count: 12, volume_usdc: 99 })).toBe(12);
    expect(statVolumeUsd({ proxy_wallet: "0x", trades: 1, biggest_win: 0, trade_count: 12, volume_usdc: 99 })).toBe(99);
    expect(statTradeCount({ proxy_wallet: "0x", trades: 1, biggest_win: 0, all_time_pnl: {} })).toBeNull(); expect(statVolumeUsd(null)).toBeNull();
  });
  it("a live-shaped wallet is rankable and earns the copyable-edge bonus — the same score as the flat shape", () => {
    const flat = { ...LIVE_STATS, trade_count: 29257, volume_usdc: 650107.67891, all_time_pnl: { ...LIVE_STATS.all_time_pnl, trade_count: undefined, volume_usdc: undefined } };
    const live = buildProfile(LIVE_STATS.proxy_wallet, "crckr", LIVE_STATS, pts, NOW, [], measured);
    expect(live.tradeCount).toBe(29257);
    expect(live.copyScore).toBe(buildProfile(LIVE_STATS.proxy_wallet, "crckr", flat, pts, NOW, [], measured).copyScore);
    // Remove the two fields entirely: −10 (unrankable) and no +10 edge bonus. This is exactly the gap the bug opened.
    const blind = { ...LIVE_STATS, all_time_pnl: { ...LIVE_STATS.all_time_pnl, trade_count: undefined, volume_usdc: undefined } };
    expect(live.copyScore - buildProfile(LIVE_STATS.proxy_wallet, "crckr", blind, pts, NOW, [], measured).copyScore).toBeCloseTo(20, 5);
  });
  it("an unmeasured (newly discovered) wallet gets a fills/day estimate from the nested lifetime count again", () => {
    const p = buildProfile(LIVE_STATS.proxy_wallet, "crckr", LIVE_STATS, pts, NOW, [], null);
    expect(p.fillsPerDay).toBeCloseTo(29257 / 200, 5);
  });
});
