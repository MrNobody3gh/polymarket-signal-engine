/** Pure reporting over simulated lifecycles: execution quality, P&L decomposition, robustness. */
import type { Lifecycle } from "./execute";

export interface SimRow { signalId: string; kind: string; closedAt: number | null; life: Lifecycle }
const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface ExecReport {
  signals: number; filled: number; partial: number; unfilled: number; expired: number; invalid: number; unknown: number; fillRate: number | null;
  avgEntrySlipTicks: number | null; medEntrySlipTicks: number | null; avgExitSlipTicks: number | null; medExitSlipTicks: number | null;
  avgLatencySec: number | null; medLatencySec: number | null; latencyObservedShare: number | null;
  fees: number; slippageCost: number; latencyCost: number; grossPnl: number; netPnl: number; realizedPnl: number; unrealizedPnl: number;
  settled: number; winRate: number | null; avgReturn: number | null; medReturn: number | null;
  maxDrawdown: number; peakEquity: number; endingEquity: number;
  robustness: { exBest1: number; exBest3: number; exBest5: number; exBest10: number; profitFactor: number | null; expectancy: number | null; largestWin: number | null; largestLoss: number | null };
}
export function execReport(rows: SimRow[]): ExecReport {
  const L = rows.map((r) => r.life);
  const entered = L.filter((l) => l.entry.filledShares > 0);
  const st = (s: string) => L.filter((l) => l.entry.status === s).length;
  const exits = entered.filter((l) => l.exit && l.exit.soldShares > 0).map((l) => l.exit!);
  const settled = rows.filter((r) => r.life.state === "EXITED" || r.life.state === "RESOLVED");
  const settledNet = settled.map((r) => r.life.netPnl);
  const rets = entered.map((l) => (l.costBasis > 0 ? l.netPnl / l.costBasis : 0));
  // Realised equity curve: independent experiments summed in closing order (open positions contribute nothing until closed).
  let eq = 0, peak = 0, mdd = 0; for (const r of [...settled].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0) || a.signalId.localeCompare(b.signalId))) { eq += r.life.netPnl; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); }
  const sortedDesc = [...settledNet].sort((a, b) => b - a); const total = settledNet.reduce((a, b) => a + b, 0);
  const ex = (n: number) => total - sortedDesc.slice(0, n).filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const wins = settledNet.filter((x) => x > 0), losses = settledNet.filter((x) => x < 0);
  const lat = L.map((l) => l.entry.timing.fillTs - l.entry.timing.sourceTs);
  return {
    signals: L.length, filled: st("FILLED"), partial: st("PARTIALLY_FILLED"), unfilled: st("UNFILLED"), expired: st("EXPIRED"), invalid: st("INVALID"), unknown: st("UNKNOWN"),
    fillRate: L.length ? entered.length / L.length : null,
    avgEntrySlipTicks: avg(entered.map((l) => l.entry.slippageTicks)), medEntrySlipTicks: med(entered.map((l) => l.entry.slippageTicks)),
    avgExitSlipTicks: avg(exits.map((x) => x.slippageTicks)), medExitSlipTicks: med(exits.map((x) => x.slippageTicks)),
    avgLatencySec: avg(lat), medLatencySec: med(lat), latencyObservedShare: L.length ? L.filter((l) => l.entry.timing.latencySource === "OBSERVED").length / L.length : null,
    fees: entered.reduce((a, l) => a + l.fees, 0), slippageCost: entered.reduce((a, l) => a + l.entry.slippageCost + (l.exit?.slippageCost ?? 0), 0), latencyCost: entered.reduce((a, l) => a + l.entry.latencyCost, 0),
    grossPnl: entered.reduce((a, l) => a + l.grossPnl, 0), netPnl: entered.reduce((a, l) => a + l.netPnl, 0), realizedPnl: entered.reduce((a, l) => a + l.realizedPnl, 0), unrealizedPnl: entered.reduce((a, l) => a + l.unrealizedPnl, 0),
    settled: settled.length, winRate: settled.length ? wins.length / settled.length : null, avgReturn: avg(rets), medReturn: med(rets),
    maxDrawdown: mdd, peakEquity: peak, endingEquity: eq,
    robustness: { exBest1: ex(1), exBest3: ex(3), exBest5: ex(5), exBest10: ex(10), profitFactor: losses.length ? wins.reduce((a, b) => a + b, 0) / -losses.reduce((a, b) => a + b, 0) : null, expectancy: avg(settledNet), largestWin: wins.length ? Math.max(...wins) : null, largestLoss: losses.length ? Math.min(...losses) : null },
  };
}
export function byKindReport(rows: SimRow[]): Record<string, ExecReport> {
  const out: Record<string, ExecReport> = {}; for (const k of [...new Set(rows.map((r) => r.kind))].sort()) out[k] = execReport(rows.filter((r) => r.kind === k)); return out;
}
