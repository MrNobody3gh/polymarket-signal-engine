import { describe, it, expect } from "vitest";
import { windowPnl, maxDrawdown, monthsUp, copyScore, classifyStyle, buildProfile, programShare, concentration, DAY } from "@/lib/scoring/score";

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
