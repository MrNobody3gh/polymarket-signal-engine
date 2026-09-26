/**
 * Pure, deterministic portfolio simulation. Finite capital; every signal ends in exactly one recorded state.
 * Events are processed in (time, kind-order, signal id) order; exits/resolutions free cash before entries at the same
 * second. No clock, no randomness.
 */
import type { ExecConfig, PortfolioConfig } from "./config";
import { simulateEntry, simulateExit, type EntryInput, type ExitInput, timeline } from "./execute";

export type PortfolioOutcome = "FILLED" | "PARTIALLY_FILLED" | "UNFILLED" | "EXPIRED" | "INVALID" | "UNKNOWN" | "REJECTED";
export type RejectReason = "REJECTED_DUPLICATE_POSITION" | "REJECTED_MAX_OPEN_POSITIONS" | "REJECTED_MAX_WALLET_ALLOCATION" | "REJECTED_MAX_MARKET_EXPOSURE" | "REJECTED_MAX_PORTFOLIO_EXPOSURE" | "REJECTED_INSUFFICIENT_CASH" | "REJECTED_BELOW_MIN_ORDER";
export interface PortfolioSignal {
  signalId: string; kind: string; wallet: string; conditionId: string; tokenId: string;
  /** Identity of the source trade; two signals from one wallet fill are one trading opportunity. */
  sourceKey: string;
  entry: EntryInput; exit: ExitInput | null; resolution: { ts: number; value: number } | null; mark: { ts: number; price: number } | null;
}
export interface Decision { signalId: string; kind: string; outcome: PortfolioOutcome; reason: string | null; requestedUsd: number; filledUsd: number; ts: number }
export interface EquityPoint { ts: number; equity: number; cash: number; exposure: number }
export interface PortfolioResult {
  decisions: Decision[]; curve: EquityPoint[];
  endingCash: number; invested: number; realizedPnl: number; unrealizedPnl: number; fees: number; slippageCost: number;
  endingEquity: number; peakEquity: number; maxDrawdown: number; maxDrawdownPct: number;
}
interface Lot { signalId: string; wallet: string; conditionId: string; shares: number; cost: number; mark: { ts: number; price: number } | null }

const KIND_ORDER: Record<string, number> = { RESOLUTION: 0, EXIT: 1, NEW_POSITION: 2, EARLY_ENTRY: 3, CONVICTION_ADD: 4, CONSENSUS: 5 };

export function simulatePortfolio(signals: PortfolioSignal[], exec: ExecConfig, pc: PortfolioConfig): PortfolioResult {
  type Ev = { ts: number; order: number; id: string; run: () => void };
  const evs: Ev[] = []; const decisions: Decision[] = []; const lots = new Map<string, Lot>(); const taken = new Set<string>();
  let cash = pc.startingCapitalUsd; let realized = 0; let fees = 0; let slip = 0; const curve: EquityPoint[] = [];
  const exposure = () => [...lots.values()].reduce((a, l) => a + l.cost, 0);
  const snap = (ts: number) => { const e = exposure(); curve.push({ ts, equity: cash + e, cash, exposure: e }); };
  for (const s of [...signals].sort((a, b) => a.signalId.localeCompare(b.signalId))) {
    const fillTs = timeline(s.entry.sourceTs, s.entry.evalTs, exec).fillTs;
    evs.push({ ts: fillTs, order: KIND_ORDER[s.kind] ?? 9, id: s.signalId, run: () => enter(s, fillTs) });
  }
  function enter(s: PortfolioSignal, ts: number) {
    const d = (outcome: PortfolioOutcome, reason: string | null, req: number, filled = 0) => decisions.push({ signalId: s.signalId, kind: s.kind, outcome, reason, requestedUsd: req, filledUsd: filled, ts });
    let size = pc.positionUsd;
    if (taken.has(s.sourceKey)) return d("REJECTED", "REJECTED_DUPLICATE_POSITION", size);
    if (lots.size >= pc.maxOpenPositions) return d("REJECTED", "REJECTED_MAX_OPEN_POSITIONS", size);
    const room = (limit: number, used: number) => limit - used;
    const walletUsed = [...lots.values()].filter((l) => l.wallet === s.wallet).reduce((a, l) => a + l.cost, 0);
    const marketUsed = [...lots.values()].filter((l) => l.conditionId === s.conditionId).reduce((a, l) => a + l.cost, 0);
    const equity = cash + exposure(); const totalRoom = room(pc.maxTotalExposurePct / 100 * equity, exposure()); const cashRoom = cash - pc.minCashReserveUsd;
    const checks: [number, RejectReason][] = [[room(pc.maxWalletAllocationUsd, walletUsed), "REJECTED_MAX_WALLET_ALLOCATION"], [room(pc.maxMarketExposureUsd, marketUsed), "REJECTED_MAX_MARKET_EXPOSURE"], [cashRoom, "REJECTED_INSUFFICIENT_CASH"], [totalRoom, "REJECTED_MAX_PORTFOLIO_EXPOSURE"]];
    for (const [r, reason] of checks) { if (r >= size) continue; if (!pc.allowResize || r <= 0) return d("REJECTED", reason, pc.positionUsd); size = r; }
    const e = simulateEntry(s.entry, exec, size);
    if (e.filledShares <= 0) return d(e.status === "UNFILLED" && e.reason === "INSUFFICIENT_LIQUIDITY" && size < pc.positionUsd ? "REJECTED" : e.status, e.status === "UNFILLED" && size < pc.positionUsd ? "REJECTED_BELOW_MIN_ORDER" : e.reason, pc.positionUsd);
    const cost = e.filledUsd + e.fee; cash -= cost; fees += e.fee; slip += e.slippageCost; realized -= e.fee;
    lots.set(s.signalId, { signalId: s.signalId, wallet: s.wallet, conditionId: s.conditionId, shares: e.filledShares, cost: e.filledUsd, mark: s.mark && s.mark.ts >= e.timing.fillTs ? s.mark : null });
    taken.add(s.sourceKey); d(e.status as PortfolioOutcome, size < pc.positionUsd ? `RESIZED:${e.reason ?? "LIMIT"}` : e.reason, pc.positionUsd, e.filledUsd); snap(ts);
    // schedule the lot's own exit / resolution (after its fill only)
    if (s.exit && s.exit.triggerTs >= e.timing.fillTs) { const x = s.exit; const xTs = timeline(x.triggerTs, x.triggerEvalTs, exec).fillTs; if (!(s.resolution && s.resolution.ts <= xTs)) evs.push({ ts: xTs, order: KIND_ORDER.EXIT, id: s.signalId, run: () => close(s.signalId, x, xTs) }); }
    if (s.resolution && s.resolution.ts >= e.timing.fillTs) { const r = s.resolution; evs.push({ ts: r.ts, order: KIND_ORDER.RESOLUTION, id: s.signalId, run: () => settle(s.signalId, r.value, r.ts) }); }
  }
  function close(id: string, x: ExitInput, ts: number) {
    const l = lots.get(id); if (!l) return; const r = simulateExit(x, l.shares, exec); if (r.soldShares <= 0) return;
    const costPart = l.cost * (r.soldShares / l.shares); cash += r.proceeds - r.fee; realized += r.proceeds - costPart - r.fee; fees += r.fee; slip += r.slippageCost;
    l.cost -= costPart; l.shares -= r.soldShares; if (l.shares <= 1e-12) lots.delete(id); snap(ts);
  }
  function settle(id: string, value: number, ts: number) {
    const l = lots.get(id); if (!l) return; const proceeds = l.shares * value; cash += proceeds; realized += proceeds - l.cost; lots.delete(id); snap(ts);
  }
  const cmp = (a: Ev, b: Ev) => a.ts - b.ts || a.order - b.order || a.id.localeCompare(b.id);
  // Binary min-heap: events scheduled while running (a lot's exit/resolution) are always ordered correctly,
  // including ones at the same second as the event that created them.
  const heap: Ev[] = []; let seq = 0; const key = new Map<Ev, number>();
  const less = (a: Ev, b: Ev) => { const c = cmp(a, b); return c < 0 || (c === 0 && key.get(a)! < key.get(b)!); };
  const push = (e: Ev) => { key.set(e, seq++); heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
  const pop = (): Ev => { const top = heap[0]; const last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
  for (const e of evs) push(e); evs.length = 0; evs.push = ((...xs: Ev[]) => { xs.forEach(push); return heap.length; }) as typeof evs.push;
  while (heap.length) pop().run();
  const invested = exposure(); const unrealized = [...lots.values()].reduce((a, l) => a + (l.mark ? l.shares * l.mark.price - l.cost : 0), 0);
  let peak = pc.startingCapitalUsd, mdd = 0, mddPct = 0;
  for (const p of curve) { peak = Math.max(peak, p.equity); const dd = peak - p.equity; if (dd > mdd) { mdd = dd; mddPct = peak > 0 ? dd / peak : 0; } }
  return { decisions, curve, endingCash: cash, invested, realizedPnl: realized, unrealizedPnl: unrealized, fees, slippageCost: slip, endingEquity: cash + invested + unrealized, peakEquity: peak, maxDrawdown: mdd, maxDrawdownPct: mddPct };
}
