/**
 * Phase 4.1 Part B — the shadow-book report: pure arithmetic over `shadow_books` rows joined (by the caller) with the signal's category and the paper
 * REALISTIC execution of the same signal. No I/O. Rows are fed one at a time into `ReportAcc`, which keeps only numbers (no row, no book), so the
 * report streams over any number of snapshots.
 *
 * Units: prices are fractions (0.01 = 1 point); the report prints POINTS (price × 100) and PERCENT OF STAKE. For a taker buy of `shares` at average
 * price `a` against a reference price `r`, the cost as a share of the stake (`shares × a`) is `(a − r) / a`. Depth is in dollars (price × size).
 *
 * NOTHING HERE IS AN EDGE ESTIMATE. It measures what it costs to follow, never whether following pays.
 */
import { quantile, mean, toCsv } from "../stats";
import { MODES } from "../../paper/sim/config";
import type { Level } from "./book";
import { clusterMean, type MeanCi } from "./report-math";
import { FeeRelAcc, UNKNOWN_FEE, recomputeFeeUsd, type FeeRelation, type MarketFee } from "./fee-compare";
import { PassiveAcc, evaluate, type Base, type PassiveStats, type Snap } from "./passive";
import { OFFSETS_S } from "./config";
import { buildDecision, decisionDetail, decisionLines, passiveLines, powerLines, type DecisionRow, type PowerNote } from "./decision";

export const PTS = 100;
export const MIN_PAIRS = 30; export const MIN_CLUSTERS = 10;
/** A table cell (a category, a kind, or both) with fewer signals than this is marked "too few" (Phase 4.1b). It is a display rule, not a decision threshold. */
export const MIN_CELL = 30;
/** The stake the decision table and the passive indicator are read at. */
export const REF_USD = 25;
/** The paper REALISTIC timing the pairing is anchored to: decision + execution latency after our evaluation (config.ts). */
export const PAPER_LATENCY_S = MODES.REALISTIC.decisionLatencySec + MODES.REALISTIC.executionLatencySec;
/** References from docs/PHASE4_PLAN_V3.md §1 (the settled REALISTIC population): printed beside the paired numbers, never used in a calculation. */
export const PLAN_REFERENCE = { priceCostPts: 6.7, feeCostPts: 4.5 } as const;

export type Category = string;
export interface FillLite { filled_usd: number; shares: number; avg_price: number | null; slippage_vs_source: number | null; slippage_vs_mid: number | null; filled_share: number; fee_usd: number }
export interface RowLite {
  signal_id: string; offset_s: number; status: string; source_price: number | null; best_bid: number | null; best_ask: number | null; spread: number | null; mid: number | null;
  bids: Level[] | null; asks: Level[] | null; fills: { by_usd: Record<string, FillLite> } | null; fee_rate_bps: number | null; fee_source: string | null; bytes: number;
}
/** `marketFee` (Phase 4.1b): the market's own effective rate as the paper simulator reads it; absent or UNKNOWN → the recomputed fee is shown as unknown. */
export interface SignalMeta { kind: string; category: Category; conditionId: string; marketFee?: MarketFee }
export interface PaperLite { status: string; signal_price: number | null; market_price: number | null; fill_price: number | null; filled_usd: number | null; entry_fee: number | null; fee_source: string | null; evaluated_gap_s: number | null }

/** The offset closest to the paper latency; a tie goes to the earlier offset. */
export function nearestOffset(offsets: readonly number[], latencyS = PAPER_LATENCY_S): number {
  return [...offsets].sort((a, b) => Math.abs(a - latencyS) - Math.abs(b - latencyS) || a - b)[0];
}
/** Dollars resting within `points` price points of the best level (ask side: at or above the best ask; bid side: at or below the best bid). `truncated` = the stored levels end inside the range, so the number is a lower bound. */
export function depthWithin(levels: readonly Level[] | null, side: "ask" | "bid", points: number): { usd: number; truncated: boolean } | null {
  if (!levels || !levels.length) return null;
  const best = levels[0][0]; const lim = points / PTS + 1e-9; let usd = 0; let inside = 0;
  for (const [p, s] of levels) { if (Math.abs(p - best) <= lim) { usd += p * s; inside++; } }
  return { usd, truncated: inside === levels.length };
}

export { clusterMean };
export type { MeanCi };
export type Verdict = "CONFIRMED" | "UNDERSTATED" | "OVERSTATED" | "INSUFFICIENT_DATA";
/**
 * The paper model's cost versus the observed cost, from the paired differences `obs − paper` (positive = the real book is MORE expensive):
 * INSUFFICIENT_DATA below MIN_PAIRS pairs or MIN_CLUSTERS markets; UNDERSTATED when the whole 95 % interval is above 0 (paper too cheap); OVERSTATED when
 * it is below 0 (paper too dear); CONFIRMED otherwise (the data cannot tell them apart, which is not proof they are equal: read the interval).
 */
export function verdictOf(d: MeanCi): Verdict {
  if (d.n < MIN_PAIRS || d.clusters < MIN_CLUSTERS || d.lo === null || d.hi === null) return "INSUFFICIENT_DATA";
  return d.lo > 0 ? "UNDERSTATED" : d.hi < 0 ? "OVERSTATED" : "CONFIRMED";
}

// ───────────────────────────────────────────── accumulator ─────────────────────────────────────────────
interface FillAcc { n: number; notFull: number; none: number; pts: number[]; pct: number[]; cl: string[]; midPts: number[]; feeRec: number[]; feeRecCl: string[]; feeRecUnknown: number; feeRecorded: number[]; feeRecordedCl: string[] }
interface Group { rows: number; signals: Set<string>; status: Map<number, Map<string, number>>; spread: Map<number, number[]>; depth: Map<number, { ask1: number[]; ask2: number[]; bid1: number[]; bid2: number[]; trunc: number; n: number }>; feeBps: number[]; feeZero: number; feeAssumed: number; fills: Map<number, Map<number, FillAcc>>; rel: FeeRelAcc }
interface Pair { cluster: string; paperLat: number; paperExec: number; paperPrice: number; paperFee: number; obsLat: number; obsExec: number; obsPrice: number; obsFee: number; obsFeeRec: number | null; obsFeeObserved: boolean; paperFeeObserved: boolean; paperPts: number; obsPts: number }

const mk = (): Group => ({ rows: 0, signals: new Set(), status: new Map(), spread: new Map(), depth: new Map(), feeBps: [], feeZero: 0, feeAssumed: 0, fills: new Map(), rel: new FeeRelAcc() });
const get = <K, V>(m: Map<K, V>, k: K, f: () => V): V => { let v = m.get(k); if (v === undefined) { v = f(); m.set(k, v); } return v; };
const pct = (x: number, fill: number) => (x / fill) * 100;
interface Pend { meta: SignalMeta; base?: Base; later: Map<number, Snap> }

export class ReportAcc {
  readonly groups = new Map<string, Group>(); readonly pairs = new Map<Category, Pair[]>();
  readonly offsets = new Set<number>(); readonly sizes: number[]; readonly pairOffset: number;
  /** Phase 4.1b: the start-up cut (the earliest OK snapshot, epoch seconds; null = none known), the back-fill it excludes, and the per-signal passive-buy bookkeeping. */
  readonly startSec: number | null; backfillRows = 0; readonly backfillSignals = new Set<string>();
  readonly planned: number[]; readonly passive = new Map<string, { bid: PassiveAcc; mid: PassiveAcc }>(); private pend: Record<string, Pend> = Object.create(null); private pendCount = 0; pendingMax = 0;
  rowsTotal = 0; bytesTotal = 0; minDue = Infinity; maxDue = -Infinity; readonly days = new Set<string>(); evalGapS: number[] = []; paperRowsSeen = 0;
  constructor(o: { sizes: readonly number[]; pairOffset: number; startSec?: number | null; offsets?: readonly number[] }) { this.sizes = [...o.sizes]; this.pairOffset = o.pairOffset; this.startSec = o.startSec ?? null; this.planned = [...(o.offsets ?? OFFSETS_S)].sort((a, b) => a - b); }

  /** Group keys a row counts toward: everything, its category, its signal kind, and the two together. */
  static keys(m: SignalMeta): string[] { return ["ALL", `cat:${m.category}`, `kind:${m.kind}`, `cat:${m.category}|kind:${m.kind}`]; }

  /**
   * The start-up cut (Phase 4.1b): a MISSED row that fell due BEFORE the first OK snapshot was ever taken (`startSec`) belongs to the back-fill of the first cycles after the job was
   * switched on (its signals were older than the job); no snapshot could have been taken for it. It is counted apart and takes part in no statistic. MISSED rows due at or after the
   * start are real misses and stay in.
   */
  add(row: RowLite, meta: SignalMeta, dueSec: number, paper: PaperLite | null): void {
    if (row.status === "MISSED" && this.startSec !== null && dueSec < this.startSec) { this.backfillRows++; this.backfillSignals.add(row.signal_id); return; }
    this.rowsTotal++; this.bytesTotal += row.bytes; this.offsets.add(row.offset_s); this.minDue = Math.min(this.minDue, dueSec); this.maxDue = Math.max(this.maxDue, dueSec); this.days.add(new Date(dueSec * 1000).toISOString().slice(0, 10));
    for (const key of ReportAcc.keys(meta)) this.addTo(get(this.groups, key, mk), row, meta);
    if (row.offset_s === this.pairOffset && paper) this.pair(row, meta, paper);
    this.track(row, meta);
  }

  /** The fee of a stored fill at the market's own rate, or null when that rate is unknown (or the fill cannot be re-priced). */
  private feeAtMarket(r: RowLite, f: FillLite, size: number, meta: SignalMeta): number | null {
    const mf = meta.marketFee ?? UNKNOWN_FEE; if (mf.rate === null) return null;
    return recomputeFeeUsd(f, size, r.asks, r.fee_rate_bps, mf.rate);
  }

  /** Collect the snapshots of one signal (baseline and later offsets); the passive indicator is evaluated when the last offset arrives (or at `flush`). Rows come in due order, so the map holds only signals still waiting for their last snapshot. */
  private track(r: RowLite, meta: SignalMeta) {
    if (this.planned.length < 2) return;
    let e = this.pend[r.signal_id]; if (!e) { e = { meta, later: new Map<number, Snap>() }; this.pend[r.signal_id] = e; this.pendCount++; } const snap: Snap = { status: r.status, bid: r.best_bid, ask: r.best_ask, mid: r.mid };
    if (r.offset_s === this.planned[0]) {
      const f = r.fills?.by_usd[String(REF_USD)]; const rec = f && f.filled_usd > 0 ? this.feeAtMarket(r, f, REF_USD, meta) : null;
      e.base = { snap, source: r.source_price, takerAvg: f && f.filled_usd > 0 ? f.avg_price : null, takerFeePct: f && rec !== null ? pct(rec, f.filled_usd) : null };
    } else e.later.set(r.offset_s, snap);
    this.pendingMax = Math.max(this.pendingMax, this.pendCount);
    if (r.offset_s === this.planned[this.planned.length - 1]) this.finalize(r.signal_id);
  }
  private finalize(id: string) {
    const e = this.pend[id]; if (!e) return; delete this.pend[id]; this.pendCount--; if (!e.base) return;
    const later = this.planned.slice(1).map((offset) => ({ offset, snap: e.later.get(offset) })); const last = this.planned[this.planned.length - 1];
    for (const kind of ["bid", "mid"] as const) {
      const out = evaluate(kind, e.base, later); if (!out) continue;
      for (const key of ReportAcc.keys(e.meta)) get(this.passive, key, () => ({ bid: new PassiveAcc("bid", last), mid: new PassiveAcc("mid", last) }))[kind].add(out, e.meta.conditionId);
    }
  }
  /** Evaluate the signals still waiting for a snapshot (the window ended, or a snapshot was never written). Idempotent. */
  flush(): void { for (const id of Object.keys(this.pend)) this.finalize(id); }

  private addTo(g: Group, r: RowLite, meta: SignalMeta) {
    g.rows++; g.signals.add(r.signal_id);
    const st = get(g.status, r.offset_s, () => new Map<string, number>()); st.set(r.status, (st.get(r.status) ?? 0) + 1);
    if (r.spread !== null && r.status === "OK") get(g.spread, r.offset_s, () => []).push(r.spread * PTS);
    if (r.status === "OK" || r.status === "ONE_SIDED") {
      const d = get(g.depth, r.offset_s, () => ({ ask1: [], ask2: [], bid1: [], bid2: [], trunc: 0, n: 0 })); d.n++;
      const a1 = depthWithin(r.asks, "ask", 1), a2 = depthWithin(r.asks, "ask", 2), b1 = depthWithin(r.bids, "bid", 1), b2 = depthWithin(r.bids, "bid", 2);
      if (a1) d.ask1.push(a1.usd); if (a2) { d.ask2.push(a2.usd); if (a2.truncated) d.trunc++; } if (b1) d.bid1.push(b1.usd); if (b2) d.bid2.push(b2.usd);
    }
    if (r.fee_rate_bps !== null && r.fee_source !== null) { g.feeBps.push(r.fee_rate_bps); if (r.fee_rate_bps === 0) g.feeZero++; }
    if (r.fee_source !== null) g.rel.add(r.fee_rate_bps, meta.marketFee?.rate ?? null);
    if (r.fee_source === "ASSUMED_UNKNOWN" || r.fee_source === "ASSUMED_RATE") g.feeAssumed++;
    if (r.fills) for (const size of this.sizes) {
      const f = r.fills.by_usd[String(size)]; if (!f) continue;
      const a = get(get(g.fills, r.offset_s, () => new Map<number, FillAcc>()), size, () => ({ n: 0, notFull: 0, none: 0, pts: [], pct: [], cl: [], midPts: [], feeRec: [], feeRecCl: [], feeRecUnknown: 0, feeRecorded: [], feeRecordedCl: [] }));
      a.n++; if (f.filled_share < 1 - 1e-9) a.notFull++; if (f.filled_share <= 0) a.none++;
      if (f.avg_price !== null && f.slippage_vs_source !== null) { a.pts.push(f.slippage_vs_source * PTS); a.pct.push(pct(f.slippage_vs_source, f.avg_price)); a.cl.push(meta.conditionId); }
      if (f.filled_usd > 0) {
        const rec = this.feeAtMarket(r, f, size, meta); if (rec === null) a.feeRecUnknown++; else { a.feeRec.push(pct(rec, f.filled_usd)); a.feeRecCl.push(meta.conditionId); }
        if (r.fee_rate_bps !== null) { a.feeRecorded.push(pct(f.fee_usd, f.filled_usd)); a.feeRecordedCl.push(meta.conditionId); }
      }
      if (f.slippage_vs_mid !== null) a.midPts.push(f.slippage_vs_mid * PTS);
    }
  }

  /** One paper/observed pair: the SAME signal, the paper REALISTIC fill at its own size versus the observed taker fill at the paper's size. */
  private pair(r: RowLite, meta: SignalMeta, p: PaperLite) {
    this.paperRowsSeen++; if (p.evaluated_gap_s !== null) this.evalGapS.push(p.evaluated_gap_s);
    const size = this.sizes.includes(100) ? 100 : this.sizes[this.sizes.length - 1];
    const f = r.fills?.by_usd[String(size)];
    if (!f || f.avg_price === null || f.filled_usd <= 0 || r.mid === null || r.source_price === null || r.fee_source === null) return;
    if ((p.status !== "FILLED" && p.status !== "PARTIALLY_FILLED") || p.fill_price === null || p.market_price === null || p.signal_price === null || !p.filled_usd || p.filled_usd <= 0) return;
    const src = r.source_price; const a = f.avg_price;
    get(this.pairs, meta.category, () => []).push({
      cluster: meta.conditionId,
      paperLat: pct(p.market_price - p.signal_price, p.fill_price), paperExec: pct(p.fill_price - p.market_price, p.fill_price), paperPrice: pct(p.fill_price - p.signal_price, p.fill_price), paperFee: pct(p.entry_fee ?? 0, p.filled_usd),
      obsLat: pct(r.mid - src, a), obsExec: pct(a - r.mid, a), obsPrice: pct(a - src, a), obsFee: pct(f.fee_usd, f.filled_usd), obsFeeRec: ((rec) => (rec === null ? null : pct(rec, f.filled_usd)))(this.feeAtMarket(r, f, size, meta)),
      obsFeeObserved: r.fee_source.startsWith("OBSERVED"), paperFeeObserved: (p.fee_source ?? "").startsWith("OBSERVED"),
      paperPts: (p.fill_price - p.signal_price) * PTS, obsPts: (a - src) * PTS,
    });
  }

  /** Every pair, across categories. */
  allPairs(): Pair[] { return [...this.pairs.values()].flat(); }
}

// ───────────────────────────────────────────── the report ─────────────────────────────────────────────
export interface Dist { n: number; p50: number | null; p90: number | null; mean: number | null }
const dist = (xs: number[]): Dist => ({ n: xs.length, p50: quantile(xs, 0.5), p90: quantile(xs, 0.9), mean: mean(xs) });
export interface FillStats {
  offset: number; usd: number; n: number; unfillableShare: number | null; noneShare: number | null; slipPts: Dist; slipPctStake: Dist; slipMidPts: Dist;
  /** means with a cluster-robust 95 % interval (clusters = markets) */
  slipPtsCi: MeanCi; slipPctCi: MeanCi;
  /** the taker fee, % of stake: at the MARKET's own rate (the paper simulator's source; unknown where that rate is unknown) and, beside it, at the rate implied by the recorded bps */
  feeMarketPct: MeanCi; feeMarketUnknown: number; feeRecordedPct: MeanCi;
}
export type FeeRelationStats = FeeRelation & { top: { bps: [number, number][]; rate: [number, number][] }; noMarketRate: number; noBps: number; overflow: number };
export interface GroupStats {
  key: string; rows: number; signals: number; /** signals with an OK book at the paired offset: the n behind the cost figures */ signalsOk: number; /** fewer than MIN_CELL signalsOk */ tooFew: boolean;
  statusByOffset: Record<string, Record<string, number>>;
  spreadPts: Record<string, Dist>; depth: Record<string, { n: number; ask1: Dist; ask2: Dist; bid1: Dist; bid2: Dist; truncatedShare: number | null }>;
  feeBps: Dist; feeZeroShare: number | null; feeAssumedShare: number | null; feeRelation: FeeRelationStats; fills: FillStats[];
}
export interface MetricComparison { metric: string; n: number; markets: number; paperMean: number | null; observedMean: number | null; diff: MeanCi; verdict: Verdict; observedShareOfPaper: number | null }
export interface PairedReport { offsetUsed: number; why: string; paperLatencyS: number; evalGapMedianS: number | null; paperRowsSeen: number; pairs: number; metrics: MetricComparison[]; byCategory: Record<string, MetricComparison[]> }
export interface ShadowReport {
  generatedAt: string; window: { fromIso: string | null; toIso: string | null; days: number };
  /** rows exclude the start-up back-fill (see `backfill`); `missedShare` is therefore the share of genuine misses */
  coverage: { rows: number; signalsMeasured: number; statusByOffset: Record<string, Record<string, number>>; missedShare: number | null; refusedShare: number | null; entrySignalsInPeriod: number | null; signalsWithoutRows: number | null };
  backfill: { startIso: string | null; rows: number; signals: number; rule: string };
  volume: { rowsPerDay: number | null; bytesPerRow: number | null; mbPer45Days: number | null };
  groups: GroupStats[]; passive: Record<string, { bid: PassiveStats; mid: PassiveStats }>; paired: PairedReport; decision: DecisionRow[]; power: PowerNote; offsets: number[]; sizes: number[];
}

export const BACKFILL_RULE = "a MISSED row due before the earliest OK snapshot's taken_at (the job's start) is start-up back-fill: counted apart, in no statistic";
const share = (k: number, n: number) => (n > 0 ? k / n : null);
function groupStats(key: string, g: Group, sizes: number[], pairOffset: number): GroupStats {
  const statusByOffset: GroupStats["statusByOffset"] = {}; for (const [o, m] of g.status) statusByOffset[String(o)] = Object.fromEntries(m);
  const spreadPts: GroupStats["spreadPts"] = {}; for (const [o, xs] of g.spread) spreadPts[String(o)] = dist(xs);
  const depth: GroupStats["depth"] = {}; for (const [o, d] of g.depth) depth[String(o)] = { n: d.n, ask1: dist(d.ask1), ask2: dist(d.ask2), bid1: dist(d.bid1), bid2: dist(d.bid2), truncatedShare: share(d.trunc, d.ask2.length) };
  const fills: FillStats[] = [];
  for (const [o, bySize] of [...g.fills].sort((a, b) => a[0] - b[0])) for (const usd of sizes) {
    const a = bySize.get(usd); if (!a) continue;
    fills.push({ offset: o, usd, n: a.n, unfillableShare: share(a.notFull, a.n), noneShare: share(a.none, a.n), slipPts: dist(a.pts), slipPctStake: dist(a.pct), slipMidPts: dist(a.midPts), slipPtsCi: clusterMean(a.pts, a.cl), slipPctCi: clusterMean(a.pct, a.cl), feeMarketPct: clusterMean(a.feeRec, a.feeRecCl), feeMarketUnknown: a.feeRecUnknown, feeRecordedPct: clusterMean(a.feeRecorded, a.feeRecordedCl) });
  }
  const signalsOk = statusByOffset[String(pairOffset)]?.OK ?? 0;
  return { key, rows: g.rows, signals: g.signals.size, signalsOk, tooFew: signalsOk < MIN_CELL, statusByOffset, spreadPts, depth, feeBps: dist(g.feeBps), feeZeroShare: share(g.feeZero, g.feeBps.length), feeAssumedShare: share(g.feeAssumed, g.rows), feeRelation: { ...g.rel.relation(), top: g.rel.top(), noMarketRate: g.rel.noMarketRate, noBps: g.rel.noBps, overflow: g.rel.overflow }, fills };
}

function compare(metric: string, ps: Pair[], paperOf: (p: Pair) => number, obsOf: (p: Pair) => number): MetricComparison {
  const diffs = ps.map((p) => obsOf(p) - paperOf(p)); const d = clusterMean(diffs, ps.map((p) => p.cluster));
  const pm = mean(ps.map(paperOf)), om = mean(ps.map(obsOf));
  return { metric, n: ps.length, markets: d.clusters, paperMean: pm, observedMean: om, diff: d, verdict: verdictOf(d), observedShareOfPaper: pm !== null && pm > 0 && om !== null ? om / pm : null };
}
/** The labels of the paired metrics (the decision table and the tests look them up by these). */
export const M = {
  price: "price cost, % of stake (latency + spread + impact)", moved: "  of which price moved before the order (mid vs the wallet's price)", exec: "  of which spread and impact (fill vs mid)", pts: "price cost, points of price",
  feeMarket: "fee, % of stake at the market's own rate (both sides observed)", feeRecorded: "fee, % of stake at the recorded bps (both sides observed)",
} as const;
const METRICS: [string, (p: Pair) => number, (p: Pair) => number][] = [
  [M.price, (p) => p.paperPrice, (p) => p.obsPrice],
  [M.moved, (p) => p.paperLat, (p) => p.obsLat],
  [M.exec, (p) => p.paperExec, (p) => p.obsExec],
  [M.pts, (p) => p.paperPts, (p) => p.obsPts],
];
const comparisons = (ps: Pair[]): MetricComparison[] => {
  const out = METRICS.map(([m, a, b]) => compare(m, ps, a, b));
  // a fee is compared only where BOTH sides observed a rate: assumed against assumed says nothing. The observed side is recomputed at the market's own rate (the paper's source); unknown where that rate is unknown.
  const mk = ps.filter((p) => p.obsFeeRec !== null && p.paperFeeObserved);
  out.push(compare(M.feeMarket, mk, (p) => p.paperFee, (p) => p.obsFeeRec as number));
  const fee = ps.filter((p) => p.obsFeeObserved && p.paperFeeObserved);
  out.push(compare(M.feeRecorded, fee, (p) => p.paperFee, (p) => p.obsFee));
  return out;
};

export function buildReport(acc: ReportAcc, o: { generatedAt: string; days: number; entrySignalsInPeriod?: number | null }): ShadowReport {
  acc.flush();
  const groups = [...acc.groups].sort((a, b) => (a[0] === "ALL" ? -1 : b[0] === "ALL" ? 1 : a[0] < b[0] ? -1 : 1)).map(([k, g]) => groupStats(k, g, acc.sizes, acc.pairOffset));
  const all = groups.find((g) => g.key === "ALL"); const statusByOffset = all?.statusByOffset ?? {};
  let total = 0, missed = 0, refused = 0; for (const m of Object.values(statusByOffset)) for (const [s, n] of Object.entries(m)) { total += n; if (s === "MISSED") missed += n; if (s === "REFUSED") refused += n; }
  const measured = all?.signals ?? 0; const nDays = Math.max(1, acc.days.size);
  const ps = acc.allPairs(); const byCategory: Record<string, MetricComparison[]> = {}; for (const [c, xs] of acc.pairs) byCategory[c] = comparisons(xs);
  const allSignals = acc.groups.get("ALL")?.signals; const backfillOnly = [...acc.backfillSignals].filter((id) => !allSignals?.has(id)).length;
  const offsets = [...acc.offsets].sort((a, b) => a - b); const laterOffsets = acc.planned.slice(1);
  const passive: ShadowReport["passive"] = {}; for (const [k, v] of acc.passive) passive[k] = { bid: v.bid.stats(laterOffsets), mid: v.mid.stats(laterOffsets) };
  const paired: PairedReport = { offsetUsed: acc.pairOffset, why: `offset ${acc.pairOffset} s is the offset nearest to the paper REALISTIC decision + execution latency (${PAPER_LATENCY_S} s) after our evaluation`, paperLatencyS: PAPER_LATENCY_S, evalGapMedianS: quantile(acc.evalGapS, 0.5), paperRowsSeen: acc.paperRowsSeen, pairs: ps.length, metrics: comparisons(ps), byCategory };
  const dec = buildDecision({ groups, passive, byCategory, pairOffset: acc.pairOffset, refUsd: REF_USD, allPairs: paired.metrics, laterOffsets });
  return {
    generatedAt: o.generatedAt, window: { fromIso: Number.isFinite(acc.minDue) ? new Date(acc.minDue * 1000).toISOString() : null, toIso: Number.isFinite(acc.maxDue) ? new Date(acc.maxDue * 1000).toISOString() : null, days: o.days },
    coverage: { rows: total, signalsMeasured: measured, statusByOffset, missedShare: share(missed, total), refusedShare: share(refused, total), entrySignalsInPeriod: o.entrySignalsInPeriod ?? null, signalsWithoutRows: o.entrySignalsInPeriod == null ? null : Math.max(0, o.entrySignalsInPeriod - measured - backfillOnly) },
    backfill: { startIso: acc.startSec === null ? null : new Date(acc.startSec * 1000).toISOString(), rows: acc.backfillRows, signals: acc.backfillSignals.size, rule: BACKFILL_RULE },
    volume: { rowsPerDay: acc.rowsTotal ? acc.rowsTotal / nDays : null, bytesPerRow: acc.rowsTotal ? acc.bytesTotal / acc.rowsTotal : null, mbPer45Days: acc.rowsTotal ? ((acc.rowsTotal / nDays) * (acc.bytesTotal / acc.rowsTotal) * 45) / 1e6 : null },
    groups, passive, paired, decision: dec.rows, power: dec.power, offsets, sizes: acc.sizes,
  };
}

// ───────────────────────────────────────────── rendering ─────────────────────────────────────────────
const f1 = (x: number | null, d = 1) => (x === null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const sh = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);
const ci = (c: MeanCi, d = 2) => (c.mean === null ? "—" : c.lo === null || c.hi === null ? `${f1(c.mean, d)} [no interval]` : `${f1(c.mean, d)} [${f1(c.lo, d)}, ${f1(c.hi, d)}]`);
export const WHAT_THIS_IS_NOT = [
  "WHAT THIS IS NOT: no number here is an edge estimate. It measures the COST of following a wallet (spread, depth, price movement, fees), never",
  "whether following pays. It places no order, uses no account or key, and changes no signal, score, alert or paper result. A cost that is",
  "'confirmed' is a statement about the paper model's cost assumptions only. The passive-touch figures are an INDICATOR, not a fill rate and not evidence of profit.",
];
const find = (r: ShadowReport, key: string) => r.groups.find((g) => g.key === key);
const fillAt = (g: GroupStats | undefined, offset: number, usd: number) => g?.fills.find((f) => f.offset === offset && f.usd === usd);
const label = (k: string) => k.replace(/^cat:|^kind:/, "").replace("|kind:", " · ");
const THIN = "too few";
function table(r: ShadowReport, keys: string[], offset: number): string[] {
  const out = [`${"group".padEnd(34)} ${"rows".padStart(6)} ${"sig".padStart(5)} ${"spr p50".padStart(7)} ${"p90".padStart(5)} ${"ask≤1pt$".padStart(8)} ${"fee bps".padStart(7)} ${"unf@25".padStart(6)} ${"unf@100".padStart(7)} ${"slip25 p50/p90".padStart(14)}`];
  for (const k of keys) {
    const g = find(r, k); if (!g) continue; const sp = g.spreadPts[String(offset)]; const dp = g.depth[String(offset)]; const f25 = fillAt(g, offset, 25), f100 = fillAt(g, offset, 100);
    out.push(`${label(k).padEnd(34).slice(0, 34)} ${String(g.rows).padStart(6)} ${String(g.signalsOk).padStart(5)} ${f1(sp?.p50 ?? null, 2).padStart(7)} ${f1(sp?.p90 ?? null, 2).padStart(5)} ${f1(dp?.ask1.p50 ?? null, 0).padStart(8)} ${f1(g.feeBps.p50, 0).padStart(7)} ${sh(f25?.unfillableShare ?? null).padStart(6)} ${sh(f100?.unfillableShare ?? null).padStart(7)} ${`${f1(f25?.slipPts.p50 ?? null, 2)}/${f1(f25?.slipPts.p90 ?? null, 2)}`.padStart(14)}${g.tooFew ? `  ${THIN}` : ""}`);
  }
  return out;
}
const catKeys = (r: ShadowReport) => r.groups.filter((g) => g.key.startsWith("cat:") && !g.key.includes("|")).sort((a, b) => b.signalsOk - a.signalsOk || (a.key < b.key ? -1 : 1)).map((g) => g.key);
const kindKeys = (r: ShadowReport) => r.groups.filter((g) => g.key.startsWith("kind:")).sort((a, b) => b.rows - a.rows).map((g) => g.key);
const comboKeys = (r: ShadowReport) => r.groups.filter((g) => g.key.includes("|")).sort((a, b) => (a.key < b.key ? -1 : 1)).map((g) => g.key);
const relText = (x: FeeRelation) => (x.relation === "UNKNOWN" ? `UNKNOWN (${x.pairs} pairs; at least 30 needed)` : x.relation === "CONSTANT_MULTIPLE" ? `CONSTANT_MULTIPLE ×${f1(x.multiple, 2)}` : x.relation === "EQUAL" ? "EQUAL" : `UNRELATED (${sh(x.shareEqual)} equal)`);
const topText = (xs: [number, number][], d = 0) => (xs.length ? xs.map(([v, n]) => `${v.toFixed(d)}×${n}`).join(" ") : "—");
const rateText = (xs: [number, number][]) => (xs.length ? xs.map(([v, n]) => `${v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}×${n}`).join(" ") : "—");

/** The console text: at most 60 lines (a test checks it), every table capped; the long forms go to `fullMarkdown` and the CSV files. */
export function consoleLines(r: ShadowReport, outDir: string, files: string[]): string[] {
  const L: string[] = []; const c = r.coverage; const off = r.paired.offsetUsed;
  L.push(`Phase 4.1b shadow order books — ${r.window.fromIso?.slice(0, 16) ?? "no data"} → ${r.window.toIso?.slice(0, 16) ?? ""} UTC (${r.window.days} d requested)`);
  if (!c.rows) { L.push("No shadow_books rows in this window. Is SHADOW_BOOKS=1 set on the worker, and has migration 0012 been applied?"); if (r.backfill.rows) L.push(`(${r.backfill.rows} start-up back-fill rows were excluded.)`); L.push(...WHAT_THIS_IS_NOT); return L; }
  L.push(`COVERAGE  ${c.rows} rows · ${c.signalsMeasured} signals measured${c.entrySignalsInPeriod != null ? ` of ${c.entrySignalsInPeriod} entry signals in the period (${c.signalsWithoutRows} with no row)` : ""} · MISSED ${sh(c.missedShare)} · REFUSED ${sh(c.refusedShare)}  (back-fill excluded)`);
  for (const o of r.offsets.slice(0, 4)) { const m = c.statusByOffset[String(o)] ?? {}; L.push(`  offset ${String(o).padStart(3)} s: ${Object.entries(m).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(" · ")}`); }
  const b = r.backfill; L.push(b.startIso === null ? "BACK-FILL AT START-UP  no OK snapshot exists yet, so nothing can be separated; no row was excluded" : `BACK-FILL AT START-UP (n=${b.rows} rows, ${b.signals} signals) excluded from every figure: MISSED rows due before the first OK snapshot (${b.startIso.slice(0, 16)} UTC)`);
  const cats = catKeys(r);
  L.push("FEE RATE: the recorded fee_rate_bps ÷ 10 000 against the market's own rate (the paper simulator's source: markets.fees_enabled / taker_fee_rate), rows with both known");
  const feeRows = ["ALL", ...cats].slice(0, 9); for (const k of feeRows) { const g = find(r, k); if (!g) continue; const fr = g.feeRelation; L.push(`  ${label(k).padEnd(24).slice(0, 24)} pairs ${String(fr.pairs).padStart(5)}  recorded bps ${topText(fr.top.bps.slice(0, 2)).padEnd(14)} market rate ${rateText(fr.top.rate.slice(0, 2)).padEnd(16)} → ${relText(fr)}`); }
  if (["ALL", ...cats].length > feeRows.length) L.push(`  … ${["ALL", ...cats].length - feeRows.length} more strata in shadow_report.md`);
  L.push(...decisionLines(r.decision, 8, off, REF_USD));
  L.push(...passiveLines(r.passive.ALL, r.offsets.filter((o) => o > off)));
  const p = r.paired; L.push(`PAIRED WITH PAPER REALISTIC (same signals; ${p.pairs} pairs of ${p.paperRowsSeen} with a paper row; ${p.why}; observed fill at $100)`);
  for (const m of p.metrics.filter((x) => !x.metric.startsWith("  "))) L.push(`  ${m.metric.padEnd(66).slice(0, 66)} paper ${f1(m.paperMean, 2).padStart(6)} obs ${f1(m.observedMean, 2).padStart(6)} Δ ${f1(m.diff.mean, 2).padStart(6)} [${f1(m.diff.lo, 2)}, ${f1(m.diff.hi, 2)}] n=${m.n} → ${m.verdict}${m.observedShareOfPaper !== null ? ` (obs = ${(m.observedShareOfPaper * 100).toFixed(0)}% of paper)` : ""}`);
  L.push(`  plan v3 §1 reference over all settled signals: price ${PLAN_REFERENCE.priceCostPts} points, fees ${PLAN_REFERENCE.feeCostPts} points of stake (a different population; printed for orientation only)`);
  if (p.evalGapMedianS !== null) L.push(`  median gap between the signal's created_at and the paper evaluation time: ${f1(p.evalGapMedianS, 1)} s (the pairing treats them as the same instant)`);
  L.push(...powerLines(r.power));
  L.push(`VOLUME  ${f1(r.volume.rowsPerDay, 0)} rows/day · ${f1(r.volume.bytesPerRow, 0)} bytes/row (JSON, before indexes) · ≈ ${f1(r.volume.mbPer45Days, 0)} MB at 45 days' retention`);
  L.push(`Files in ${outDir}: ${files.join(", ")}`);
  L.push(...WHAT_THIS_IS_NOT); return L;
}

/** The long form (shadow_report.md): the console text, then every stratum, kind and combination, with intervals. */
export function fullMarkdown(r: ShadowReport, outDir: string, files: string[]): string[] {
  const out = ["# Phase 4.1b shadow order-book report", "", "```", ...consoleLines(r, outDir, files), "```", ""];
  if (!r.coverage.rows) return out; const off = r.paired.offsetUsed;
  out.push("## Every stratum, kind and combination at the paired offset", "", "```", ...table(r, ["ALL", ...catKeys(r), ...kindKeys(r), ...comboKeys(r)], off), "```", "", `A cell with fewer than ${MIN_CELL} signals (the \`sig\` column) is marked "${THIN}".`, "");
  out.push("## Decision table with means and 95 % intervals (cluster-robust, clusters = markets)", "", "```", ...decisionDetail(r.decision, REF_USD), "```", "");
  out.push("## The fee rate: recorded bps against the market's own rate", "", "```");
  for (const k of ["ALL", ...catKeys(r), ...kindKeys(r)]) { const g = find(r, k); if (!g) continue; const fr = g.feeRelation; out.push(`${label(k).padEnd(34).slice(0, 34)} pairs ${String(fr.pairs).padStart(5)} · recorded bps (top) ${topText(fr.top.bps)} · market rate (top) ${rateText(fr.top.rate)} · ratio median ${f1(fr.medianRatio, 3)} · equal ${sh(fr.shareEqual)} · near median ${sh(fr.shareNearMedian)} · no market rate ${fr.noMarketRate} · no bps ${fr.noBps}${fr.overflow ? ` · ${fr.overflow} beyond the distinct-pair cap` : ""} → ${relText(fr)}`); }
  out.push("```", "", "## Passive buys (an indicator, not a fill rate)", "", "```"); for (const k of ["ALL", ...catKeys(r), ...kindKeys(r)]) out.push(...passiveLines(r.passive[k], r.offsets.filter((o) => o > off), k)); out.push("```", "");
  out.push("## Paired with paper REALISTIC, by stratum", "", "```");
  for (const [cat, ms] of Object.entries(r.paired.byCategory).sort((a, b) => (a[0] < b[0] ? -1 : 1))) { out.push(cat); for (const m of ms) out.push(`  ${m.metric.padEnd(66).slice(0, 66)} paper ${f1(m.paperMean, 2).padStart(6)} obs ${f1(m.observedMean, 2).padStart(6)} Δ ${ci(m.diff)} n=${m.n} markets=${m.markets} → ${m.verdict}`); }
  out.push("```", ""); return out;
}

/** Long form of the per-group results: one CSV row per group × offset × size. */
export function groupsCsv(r: ShadowReport): string {
  const header = ["group", "offset_s", "usd", "rows_in_group", "signals_ok_at_paired_offset", "too_few", "n_fills", "unfillable_share", "none_filled_share", "slip_pts_p50", "slip_pts_p90", "slip_pts_mean", "slip_pts_lo95", "slip_pts_hi95", "slip_pct_stake_p50", "slip_pct_stake_p90", "slip_pct_stake_mean", "slip_pct_stake_lo95", "slip_pct_stake_hi95", "slip_vs_mid_pts_p50", "spread_pts_p50", "spread_pts_p90", "ask_depth_1pt_usd_p50", "ask_depth_2pt_usd_p50", "bid_depth_1pt_usd_p50", "depth_2pt_truncated_share", "fee_bps_p50", "fee_bps_p90", "fee_zero_share", "fee_assumed_share", "fee_market_pct_stake_mean", "fee_market_lo95", "fee_market_hi95", "fee_market_n", "fee_market_unknown", "fee_recorded_pct_stake_mean", "fee_recorded_lo95", "fee_recorded_hi95", "fee_recorded_n"];
  const rows: unknown[][] = [];
  for (const g of r.groups) for (const f of g.fills) { const sp = g.spreadPts[String(f.offset)], d = g.depth[String(f.offset)];
    rows.push([g.key, f.offset, f.usd, g.rows, g.signalsOk, g.tooFew, f.n, f.unfillableShare, f.noneShare, f.slipPts.p50, f.slipPts.p90, f.slipPts.mean, f.slipPtsCi.lo, f.slipPtsCi.hi, f.slipPctStake.p50, f.slipPctStake.p90, f.slipPctStake.mean, f.slipPctCi.lo, f.slipPctCi.hi, f.slipMidPts.p50, sp?.p50, sp?.p90, d?.ask1.p50, d?.ask2.p50, d?.bid1.p50, d?.truncatedShare, g.feeBps.p50, g.feeBps.p90, g.feeZeroShare, g.feeAssumedShare, f.feeMarketPct.mean, f.feeMarketPct.lo, f.feeMarketPct.hi, f.feeMarketPct.n, f.feeMarketUnknown, f.feeRecordedPct.mean, f.feeRecordedPct.lo, f.feeRecordedPct.hi, f.feeRecordedPct.n]); }
  return toCsv(header, rows);
}
export function pairedCsv(r: ShadowReport): string {
  const rows: unknown[][] = []; const add = (scope: string, ms: MetricComparison[]) => { for (const m of ms) rows.push([scope, m.metric.trim(), m.n, m.markets, m.paperMean, m.observedMean, m.diff.mean, m.diff.se, m.diff.lo, m.diff.hi, m.verdict, m.observedShareOfPaper]); };
  add("ALL", r.paired.metrics); for (const [c, ms] of Object.entries(r.paired.byCategory)) add(`cat:${c}`, ms);
  return toCsv(["scope", "metric", "pairs", "markets", "paper_mean", "observed_mean", "diff_mean", "diff_se_cluster_robust", "diff_lo95", "diff_hi95", "verdict", "observed_share_of_paper"], rows);
}
/** One row per group × limit kind × later offset (the touch shares), and the detail of the signals touched by the last offset. */
export function passiveCsv(r: ShadowReport): string {
  const rows: unknown[][] = [];
  for (const [k, v] of Object.entries(r.passive)) for (const s of [v.bid, v.mid]) { const d = s.touchedDetail; for (const x of s.rows) rows.push([k, s.limit, s.eligible, x.offset, x.known, x.touched, x.share, d.n, d.improvementPts.mean, d.improvementPts.lo, d.improvementPts.hi, d.improvementPct.mean, d.improvementPct.lo, d.improvementPct.hi, d.avoidedFeePct.mean, d.avoidedFeePct.lo, d.avoidedFeePct.hi, d.avoidedFeeUnknown, d.belowSourceShare, d.firstTouchLateShare]); }
  return toCsv(["group", "limit", "eligible", "by_offset_s", "cohort_readable", "touched", "touched_share", "touched_last_n", "improvement_pts_mean", "improvement_pts_lo95", "improvement_pts_hi95", "improvement_pct_mean", "improvement_pct_lo95", "improvement_pct_hi95", "avoided_fee_pct_mean", "avoided_fee_lo95", "avoided_fee_hi95", "avoided_fee_unknown", "touch_below_wallet_price_share", "first_touch_at_last_offset_share"], rows);
}
/** The fee-rate relation per group. */
export function feeRelationCsv(r: ShadowReport): string {
  return toCsv(["group", "pairs", "relation", "multiple", "median_ratio", "share_equal", "share_near_median", "no_market_rate", "no_bps", "beyond_cap", "top_bps", "top_market_rate"], r.groups.map((g) => { const f = g.feeRelation; return [g.key, f.pairs, f.relation, f.multiple, f.medianRatio, f.shareEqual, f.shareNearMedian, f.noMarketRate, f.noBps, f.overflow, topText(f.top.bps), rateText(f.top.rate)]; }));
}
