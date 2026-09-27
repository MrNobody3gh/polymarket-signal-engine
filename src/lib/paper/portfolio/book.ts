/**
 * PortfolioBook: the Phase 2 portfolio rules (sim/portfolio.ts simulatePortfolio) applied one event at a time, with
 * plain-JSON state so a run can stop, be checkpointed, and resume exactly (docs/PHASE3_PLAN.md §B, §J step 4).
 *
 * simulatePortfolio stays the reference: fed the same signals in event order, the book produces the same decisions,
 * equity curve and totals (tests/phase3.test.ts). What the book adds:
 *  - submit() takes entries one at a time, in event order, and refuses anything out of order;
 *  - scheduled exits and resolutions are data in the state (not closures), applied as the book advances;
 *  - relink() re-attaches a restored lot to exits/resolutions learned after the checkpoint (§B11), or reports the
 *    earliest time the caller must rewind to when that is no longer possible;
 *  - richer outputs (fill price, fee, per-lot exit/resolution detail) for portfolio_decisions / portfolio_lots.
 *
 * Kept exactly as in the reference, including one quirk: a resized order that ends UNFILLED for a reason other than
 * liquidity (e.g. NO_ASK_BELOW_ONE) is recorded with outcome UNFILLED and reason REJECTED_BELOW_MIN_ORDER.
 */
import type { ExecConfig, PortfolioConfig } from "../sim/config";
import { simulateEntry, simulateExit, timeline, type ExitInput } from "../sim/execute";
import type { PortfolioResult } from "../sim/portfolio";
import type { BookDecision, BookLot, BookOutput, BookSignal, BookState, EquityPoint, EventKey, ScheduledEvent } from "./types";

export const KIND_ORDER: Record<string, number> = { RESOLUTION: 0, EXIT: 1, NEW_POSITION: 2, EARLY_ENTRY: 3, CONVICTION_ADD: 4, CONSENSUS: 5 };
/** Source keys are only ever duplicated within one source trade; keep them this long after their fill, then forget. */
export const TAKEN_WINDOW_SEC = 7 * 86_400;

const cmpId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const cmpKey = (a: EventKey, b: EventKey) => a.ts - b.ts || a.order - b.order || cmpId(a.id, b.id);
const cmpEv = (a: ScheduledEvent, b: ScheduledEvent) => cmpKey(a, b) || a.seq - b.seq;

/** The event key of an entry signal under an execution config. */
export function entryKey(s: Pick<BookSignal, "signalId" | "kind" | "entry">, exec: ExecConfig): EventKey {
  return { ts: timeline(s.entry.sourceTs, s.entry.evalTs, exec).fillTs, order: KIND_ORDER[s.kind] ?? 9, id: s.signalId };
}

export function emptyState(pc: PortfolioConfig): BookState {
  return { v: 1, cash: pc.startingCapitalUsd, realized: 0, fees: 0, slippage: 0, peakEquity: pc.startingCapitalUsd, maxDrawdown: 0, maxDrawdownPct: 0, lots: [], taken: [], heap: [], seq: 0, last: null, events: 0 };
}

export class PortfolioBook {
  private s: BookState;
  private lots = new Map<string, BookLot>();
  private taken = new Map<string, number>();
  private out: BookOutput = { decisions: [], lots: [], equity: [] };

  constructor(private exec: ExecConfig, private pc: PortfolioConfig, state?: BookState) {
    const st = state ? (JSON.parse(JSON.stringify(state)) as BookState) : emptyState(pc);
    if (st.v !== 1) throw new Error(`unsupported book state version ${st.v}`);
    this.s = st; for (const l of st.lots) this.lots.set(l.signalId, l); for (const [k, t] of st.taken) this.taken.set(k, t);
  }

  // ───────────────────────────── entries ─────────────────────────────
  /** Apply every scheduled event that orders before this entry, then decide the entry. */
  submit(sig: BookSignal): BookDecision {
    const key = entryKey(sig, this.exec);
    if (this.s.last && cmpKey(key, this.s.last) <= 0) throw new Error(`out of order: ${JSON.stringify(key)} is not after ${JSON.stringify(this.s.last)}`);
    this.advance(key);
    const d = this.enter(sig, key.ts);
    this.s.last = key; this.s.events++;
    return d;
  }

  /** Apply scheduled exits/resolutions ordered strictly before `to` (all of them when `to` is null). */
  advance(to: EventKey | null): void {
    for (;;) {
      const top = this.peek(); if (!top || (to && cmpKey(top, to) >= 0)) return;
      this.pop();
      if (top.type === "EXIT") this.close(top.id, top.exit!, top.ts); else this.settle(top.id, top.value!, top.ts);
      if (!this.s.last || cmpKey(top, this.s.last) > 0) this.s.last = { ts: top.ts, order: top.order, id: top.id };
      this.s.events++;
    }
  }

  private enter(sig: BookSignal, ts: number): BookDecision {
    const pc = this.pc; const exec = this.exec;
    const decide = (outcome: BookDecision["outcome"], reason: string | null, extra: Partial<BookDecision> = {}): BookDecision => {
      const d: BookDecision = { signalId: sig.signalId, kind: sig.kind, sourceKey: sig.sourceKey, ts, outcome, reason, requestedUsd: pc.positionUsd, filledUsd: 0, filledShares: 0, fillPrice: null, fee: 0, resized: false, ...extra };
      this.out.decisions.push(d); return d;
    };
    let size = pc.positionUsd;
    if (this.taken.has(sig.sourceKey)) return decide("REJECTED", "REJECTED_DUPLICATE_POSITION");
    if (this.lots.size >= pc.maxOpenPositions) return decide("REJECTED", "REJECTED_MAX_OPEN_POSITIONS");
    const exposure = this.exposure(); let walletUsed = 0, marketUsed = 0;
    for (const l of this.lots.values()) { if (l.wallet === sig.wallet) walletUsed += l.cost; if (l.conditionId === sig.conditionId) marketUsed += l.cost; }
    const equity = this.s.cash + exposure;
    const checks: [number, string][] = [[pc.maxWalletAllocationUsd - walletUsed, "REJECTED_MAX_WALLET_ALLOCATION"], [pc.maxMarketExposureUsd - marketUsed, "REJECTED_MAX_MARKET_EXPOSURE"], [this.s.cash - pc.minCashReserveUsd, "REJECTED_INSUFFICIENT_CASH"], [(pc.maxTotalExposurePct / 100) * equity - exposure, "REJECTED_MAX_PORTFOLIO_EXPOSURE"]];
    for (const [room, reason] of checks) { if (room >= size) continue; if (!pc.allowResize || room <= 0) return decide("REJECTED", reason); size = room; }
    const e = simulateEntry(sig.entry, exec, size); const resized = size < pc.positionUsd;
    if (e.filledShares <= 0) {
      // Reference behaviour, quirk included (see file header).
      const outcome = e.status === "UNFILLED" && e.reason === "INSUFFICIENT_LIQUIDITY" && resized ? "REJECTED" : e.status;
      return decide(outcome, e.status === "UNFILLED" && resized ? "REJECTED_BELOW_MIN_ORDER" : e.reason, { resized });
    }
    this.s.cash -= e.filledUsd + e.fee; this.s.fees += e.fee; this.s.slippage += e.slippageCost; this.s.realized -= e.fee;
    const lot: BookLot = { signalId: sig.signalId, kind: sig.kind, wallet: sig.wallet, conditionId: sig.conditionId, tokenId: sig.tokenId, openedTs: e.timing.fillTs,
      sharesFilled: e.filledShares, costFilled: e.filledUsd, entryFee: e.fee, fillPrice: e.fillPrice!, shares: e.filledShares, cost: e.filledUsd,
      mark: sig.mark && sig.mark.ts >= e.timing.fillTs ? sig.mark : null, exitId: null, exitTs: null, exitShares: null, exitProceeds: null, exitFee: null,
      resolutionTs: null, resolutionValue: null, resolutionProceeds: null, state: "OPEN", realizedPnl: -e.fee, closedTs: null };
    this.lots.set(lot.signalId, lot); this.taken.set(sig.sourceKey, ts);
    const d = decide(e.status, resized ? `RESIZED:${e.reason ?? "LIMIT"}` : e.reason, { filledUsd: e.filledUsd, filledShares: e.filledShares, fillPrice: e.fillPrice, fee: e.fee, resized });
    this.scheduleFor(lot, sig.exit, sig.exitId ?? null, sig.resolution); // first, so the emitted lot names its linked exit
    this.emitLot(lot); this.snap(ts);
    return d;
  }

  // ───────────────────────────── exits / resolutions ─────────────────────────────
  /** The reference's scheduling rule, for a lot that has filled. Returns the events it would add. */
  private eventsFor(lot: BookLot, exit: ExitInput | null, resolution: { ts: number; value: number } | null): Omit<ScheduledEvent, "seq">[] {
    const evs: Omit<ScheduledEvent, "seq">[] = [];
    if (exit && exit.triggerTs >= lot.openedTs) {
      const xTs = timeline(exit.triggerTs, exit.triggerEvalTs, this.exec).fillTs;
      if (!(resolution && resolution.ts <= xTs)) evs.push({ ts: xTs, order: KIND_ORDER.EXIT, id: lot.signalId, type: "EXIT", exit });
    }
    if (resolution && resolution.ts >= lot.openedTs) evs.push({ ts: resolution.ts, order: KIND_ORDER.RESOLUTION, id: lot.signalId, type: "RESOLUTION", value: resolution.value });
    return evs;
  }
  private scheduleFor(lot: BookLot, exit: ExitInput | null, exitId: string | null, resolution: { ts: number; value: number } | null) {
    for (const ev of this.eventsFor(lot, exit, resolution)) { this.push({ ...ev, seq: this.s.seq++ }); if (ev.type === "EXIT") lot.exitId = exitId; }
  }

  private close(id: string, x: ExitInput, ts: number) {
    const l = this.lots.get(id); if (!l) return;
    const r = simulateExit(x, l.shares, this.exec); if (r.soldShares <= 0) return;
    const costPart = l.cost * (r.soldShares / l.shares);
    this.s.cash += r.proceeds - r.fee; this.s.realized += r.proceeds - costPart - r.fee; this.s.fees += r.fee; this.s.slippage += r.slippageCost;
    l.cost -= costPart; l.shares -= r.soldShares;
    l.exitTs = ts; l.exitShares = r.soldShares; l.exitProceeds = r.proceeds; l.exitFee = r.fee; l.realizedPnl += r.proceeds - costPart - r.fee;
    if (l.shares <= 1e-12) { l.shares = 0; l.cost = 0; l.state = "EXITED"; l.closedTs = ts; this.lots.delete(id); } else l.state = "PARTIALLY_EXITED";
    this.emitLot(l); this.snap(ts);
  }

  private settle(id: string, value: number, ts: number) {
    const l = this.lots.get(id); if (!l) return;
    const proceeds = l.shares * value; this.s.cash += proceeds; this.s.realized += proceeds - l.cost;
    l.resolutionTs = ts; l.resolutionValue = value; l.resolutionProceeds = proceeds; l.realizedPnl += proceeds - l.cost;
    l.shares = 0; l.cost = 0; l.state = "RESOLVED"; l.closedTs = ts; this.lots.delete(id);
    this.emitLot(l); this.snap(ts);
  }

  /**
   * §B11 rehydration: attach an open lot to the exit/resolution known *now*. Nothing changes unless every resulting
   * event is still in the future of this book; otherwise `rewindTo` is the earliest time the caller must replay from.
   */
  relink(signalId: string, link: { exit: ExitInput | null; exitId: string | null; resolution: { ts: number; value: number } | null; mark?: { ts: number; price: number } | null }): { ok: true } | { ok: false; rewindTo: number } {
    const lot = this.lots.get(signalId); if (!lot) throw new Error(`relink: no open lot ${signalId}`);
    // An exit already applied cannot be taken back: a different linked exit (or a resolution before it) means rewinding.
    if (lot.exitTs != null) {
      if (link.exitId !== lot.exitId) return { ok: false, rewindTo: Math.min(lot.exitTs, link.exit ? timeline(link.exit.triggerTs, link.exit.triggerEvalTs, this.exec).fillTs : lot.exitTs) };
      if (link.resolution && link.resolution.ts <= lot.exitTs) return { ok: false, rewindTo: link.resolution.ts };
    }
    // Nor can an exit that was applied but sold nothing (no price, no liquidity): the lot still names it, but it is no
    // longer scheduled. Its time is not kept, so a different exit replays from the lot's own fill.
    const consumed = lot.exitTs == null && lot.exitId != null && !this.s.heap.some((e) => e.id === signalId && e.type === "EXIT");
    if (consumed && link.exitId !== lot.exitId) return { ok: false, rewindTo: lot.openedTs };
    const evs = this.eventsFor(lot, lot.exitTs != null || consumed ? null : link.exit, link.resolution);
    const last = this.s.last;
    const late = evs.filter((e) => last && cmpKey(e, last) <= 0);
    if (late.length) return { ok: false, rewindTo: Math.min(...late.map((e) => e.ts)) };
    this.s.heap = this.s.heap.filter((e) => e.id !== signalId); this.heapify();
    if (lot.exitTs == null && !consumed) lot.exitId = null;
    for (const ev of evs) { this.push({ ...ev, seq: this.s.seq++ }); if (ev.type === "EXIT") lot.exitId = link.exitId; }
    if (link.mark !== undefined) lot.mark = link.mark && link.mark.ts >= lot.openedTs ? link.mark : null;
    return { ok: true };
  }

  // ───────────────────────────── reading state ─────────────────────────────
  private exposure(): number { let e = 0; for (const l of this.lots.values()) e += l.cost; return e; }
  private snap(ts: number) {
    const e = this.exposure(); const eq = this.s.cash + e; const p: EquityPoint = { ts, equity: eq, cash: this.s.cash, exposure: e };
    this.out.equity.push(p);
    this.s.peakEquity = Math.max(this.s.peakEquity, eq); const dd = this.s.peakEquity - eq;
    if (dd > this.s.maxDrawdown) { this.s.maxDrawdown = dd; this.s.maxDrawdownPct = this.s.peakEquity > 0 ? dd / this.s.peakEquity : 0; }
  }
  private emitLot(l: BookLot) { this.out.lots.push({ ...l, mark: l.mark ? { ...l.mark } : null }); }

  openLots(): BookLot[] { return [...this.lots.values()].map((l) => ({ ...l })); }
  lastKey(): EventKey | null { return this.s.last ? { ...this.s.last } : null; }
  /** Everything produced since the previous call. */
  take(): BookOutput { const o = this.out; this.out = { decisions: [], lots: [], equity: [] }; return o; }

  /** Totals in the reference's shape (decisions and curve are streamed through take()). */
  summary(): Omit<PortfolioResult, "decisions" | "curve"> {
    const invested = this.exposure(); let unrealized = 0; for (const l of this.lots.values()) if (l.mark) unrealized += l.shares * l.mark.price - l.cost;
    return { endingCash: this.s.cash, invested, realizedPnl: this.s.realized, unrealizedPnl: unrealized, fees: this.s.fees, slippageCost: this.s.slippage, endingEquity: this.s.cash + invested + unrealized, peakEquity: this.s.peakEquity, maxDrawdown: this.s.maxDrawdown, maxDrawdownPct: this.s.maxDrawdownPct };
  }

  /** Plain-JSON state for a checkpoint. Source keys older than TAKEN_WINDOW_SEC before the last event are dropped. */
  snapshot(): BookState {
    const horizon = (this.s.last?.ts ?? 0) - TAKEN_WINDOW_SEC;
    for (const [k, t] of this.taken) if (t < horizon) this.taken.delete(k);
    return JSON.parse(JSON.stringify({ ...this.s, lots: [...this.lots.values()], taken: [...this.taken.entries()] })) as BookState;
  }

  // ───────────────────────────── binary min-heap on (key, seq) ─────────────────────────────
  private peek(): ScheduledEvent | undefined { return this.s.heap[0]; }
  private push(e: ScheduledEvent) { const h = this.s.heap; h.push(e); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (cmpEv(h[i], h[p]) >= 0) break; [h[i], h[p]] = [h[p], h[i]]; i = p; } }
  private pop(): ScheduledEvent { const h = this.s.heap; const top = h[0]; const last = h.pop()!; if (h.length) { h[0] = last; this.down(0); } return top; }
  private down(i: number) { const h = this.s.heap; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && cmpEv(h[l], h[m]) < 0) m = l; if (r < h.length && cmpEv(h[r], h[m]) < 0) m = r; if (m === i) return; [h[i], h[m]] = [h[m], h[i]]; i = m; } }
  private heapify() { for (let i = (this.s.heap.length >> 1) - 1; i >= 0; i--) this.down(i); }
}
