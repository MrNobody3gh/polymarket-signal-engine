/**
 * Phase 4.1b Part C — the passive-buy INDICATOR: would a resting limit buy have been reached by the later snapshots? Pure.
 *
 * A hypothetical passive buy is placed at offset 0 at a limit price L (the best bid, or the mid). It counts as TOUCHED by a later snapshot when that snapshot's best ask is at or
 * below L (ask-through). Cumulative: "touched by 300 s" includes "touched by 60 s", and a cohort contains only signals whose snapshots up to that offset are all readable.
 *
 * READ THIS BEFORE USING THE NUMBER. It is NOT a fill rate and NOT evidence of profit. It is also not a strict bound in either direction:
 *   · a resting buy can be filled with the ask never reaching L (a seller hits the bid), and the book can dip through L and recover between two snapshots: both make the real
 *     fill share HIGHER than this share;
 *   · queue position (we join behind the existing size), partial fills and cancellations make it LOWER.
 * Two snapshots cannot observe a trade, so no necessary condition for a fill can be read from them. The figure measures how often the market was seen at or through our price,
 * which is also the situation in which a passive buyer is adversely selected (the wallet bought on information and the price went the other way).
 */
import { clusterMean, type MeanCi } from "./report-math";

export const TOUCH_EPS = 1e-9;
/** Statuses whose best ask can be read (a missing ask then means "no asks"); CROSSED / ERROR / MISSED / REFUSED / NOT_FOUND are unreadable. */
export const READABLE = new Set(["OK", "ONE_SIDED", "EMPTY_BOOK"]);
export type LimitKind = "bid" | "mid";

export interface Snap { status: string; bid: number | null; ask: number | null; mid: number | null }
/** What the baseline (offset 0) contributes: the book, the wallet's price and the taker fill at the reference size. */
export interface Base { snap: Snap; source: number | null; takerAvg: number | null; takerFeePct: number | null }

/** The limit price of a passive buy, or null when the baseline cannot support one (bid: a readable book with a bid; mid: a two-sided OK book). */
export function limitPrice(kind: LimitKind, s: Snap): number | null {
  if (kind === "bid") return (s.status === "OK" || s.status === "ONE_SIDED") && s.bid !== null ? s.bid : null;
  return s.status === "OK" && s.mid !== null ? s.mid : null;
}
/** Ask-through: a readable snapshot whose best ask is at or below the limit. An unreadable one is "unknown" (null). */
export function touched(limit: number, s: Snap | undefined): boolean | null {
  if (!s || !READABLE.has(s.status)) return null;
  return s.ask !== null && s.ask <= limit + TOUCH_EPS;
}

export interface Outcome {
  /** per later offset, in order: readable cohort so far (all snapshots up to it readable) and whether touched by then */
  by: { offset: number; known: boolean; touched: boolean }[];
  firstTouchOffset: number | null; touchPrice: number | null; limit: number;
  improvementPts: number | null; improvementPct: number | null; avoidedFeePct: number | null; belowSource: boolean | null;
}
/** `later`: the snapshots after the baseline, ascending by offset. */
export function evaluate(kind: LimitKind, base: Base, later: { offset: number; snap: Snap | undefined }[]): Outcome | null {
  const L = limitPrice(kind, base.snap); if (L === null) return null;
  const by: Outcome["by"] = []; let cohort = true; let hit = false; let first: number | null = null; let price: number | null = null;
  for (const { offset, snap } of later) {
    const t = touched(L, snap); if (t === null) cohort = false;
    if (cohort && t && !hit) { hit = true; first = offset; price = snap!.ask; }
    by.push({ offset, known: cohort, touched: cohort && hit });
  }
  const a = base.takerAvg;
  return {
    by, firstTouchOffset: first, touchPrice: price, limit: L,
    improvementPts: a !== null ? (a - L) * 100 : null, improvementPct: a !== null && a > 0 ? ((a - L) / a) * 100 : null, avoidedFeePct: base.takerFeePct,
    belowSource: price !== null && base.source !== null ? price < base.source - TOUCH_EPS : null,
  };
}

export interface PassiveRow { offset: number; known: number; touched: number; share: number | null }
export interface PassiveStats {
  limit: LimitKind; eligible: number; rows: PassiveRow[];
  /** over the signals touched by the LAST offset (a cohort fully readable up to it) */
  touchedDetail: { n: number; improvementPts: MeanCi; improvementPct: MeanCi; avoidedFeePct: MeanCi; avoidedFeeUnknown: number; belowSourceShare: number | null; firstTouchLateShare: number | null };
}
/** One accumulator per group and limit kind; keeps only numbers. */
export class PassiveAcc {
  eligible = 0; readonly known = new Map<number, number>(); readonly hits = new Map<number, number>();
  private imp: number[] = []; private impPct: number[] = []; private clPct: string[] = []; private fee: number[] = []; private cl: string[] = []; private feeCl: string[] = []; feeUnknown = 0; private below = 0; private belowKnown = 0; private late = 0; private nDetail = 0;
  constructor(readonly kind: LimitKind, private readonly lastOffset: number) {}
  add(o: Outcome, cluster: string): void {
    this.eligible++;
    for (const b of o.by) { if (b.known) this.known.set(b.offset, (this.known.get(b.offset) ?? 0) + 1); if (b.touched) this.hits.set(b.offset, (this.hits.get(b.offset) ?? 0) + 1); }
    const last = o.by[o.by.length - 1]; if (!last || last.offset !== this.lastOffset || !last.touched) return;
    this.nDetail++; if (o.improvementPts !== null) { this.imp.push(o.improvementPts); this.cl.push(cluster); } if (o.improvementPct !== null) { this.impPct.push(o.improvementPct); this.clPct.push(cluster); }
    if (o.avoidedFeePct !== null) { this.fee.push(o.avoidedFeePct); this.feeCl.push(cluster); } else this.feeUnknown++;
    if (o.belowSource !== null) { this.belowKnown++; if (o.belowSource) this.below++; }
    if (o.firstTouchOffset !== null && o.firstTouchOffset === this.lastOffset && o.by.length > 1) this.late++;
  }
  stats(offsets: readonly number[]): PassiveStats {
    const rows = offsets.map((offset): PassiveRow => { const known = this.known.get(offset) ?? 0, t = this.hits.get(offset) ?? 0; return { offset, known, touched: t, share: known > 0 ? t / known : null }; });
    return { limit: this.kind, eligible: this.eligible, rows, touchedDetail: { n: this.nDetail, improvementPts: clusterMean(this.imp, this.cl), improvementPct: clusterMean(this.impPct, this.clPct), avoidedFeePct: clusterMean(this.fee, this.feeCl), avoidedFeeUnknown: this.feeUnknown, belowSourceShare: this.belowKnown ? this.below / this.belowKnown : null, firstTouchLateShare: this.nDetail ? this.late / this.nDetail : null } };
  }
}
