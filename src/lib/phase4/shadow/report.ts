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

export const PTS = 100;
export const MIN_PAIRS = 30; export const MIN_CLUSTERS = 10;
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
export interface SignalMeta { kind: string; category: Category; conditionId: string }
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

// ───────────────────────────────────────── cluster-robust mean ──────────────────────────────────────────
export interface MeanCi { n: number; clusters: number; mean: number | null; se: number | null; lo: number | null; hi: number | null }
/** Mean of `xs` with a cluster-robust standard error (clusters = markets: signals on one market are not independent) and a normal 95 % interval. */
export function clusterMean(xs: readonly number[], clusters: readonly string[], z = 1.96): MeanCi {
  const n = xs.length; if (!n) return { n: 0, clusters: 0, mean: null, se: null, lo: null, hi: null };
  const m = xs.reduce((a, b) => a + b, 0) / n; const by = new Map<string, { s: number; k: number }>();
  for (let i = 0; i < n; i++) { const e = by.get(clusters[i]) ?? { s: 0, k: 0 }; e.s += xs[i]; e.k++; by.set(clusters[i], e); }
  const g = by.size; if (g < 2) return { n, clusters: g, mean: m, se: null, lo: null, hi: null };
  let ss = 0; for (const { s, k } of by.values()) ss += (s - m * k) ** 2;
  const se = Math.sqrt((g / (g - 1)) * ss) / n;
  return { n, clusters: g, mean: m, se, lo: m - z * se, hi: m + z * se };
}
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
interface FillAcc { n: number; notFull: number; none: number; pts: number[]; pct: number[]; midPts: number[] }
interface Group { rows: number; signals: Set<string>; status: Map<number, Map<string, number>>; spread: Map<number, number[]>; depth: Map<number, { ask1: number[]; ask2: number[]; bid1: number[]; bid2: number[]; trunc: number; n: number }>; feeBps: number[]; feeZero: number; feeAssumed: number; fills: Map<number, Map<number, FillAcc>> }
interface Pair { cluster: string; paperLat: number; paperExec: number; paperPrice: number; paperFee: number; obsLat: number; obsExec: number; obsPrice: number; obsFee: number; obsFeeObserved: boolean; paperFeeObserved: boolean; paperPts: number; obsPts: number }

const mk = (): Group => ({ rows: 0, signals: new Set(), status: new Map(), spread: new Map(), depth: new Map(), feeBps: [], feeZero: 0, feeAssumed: 0, fills: new Map() });
const get = <K, V>(m: Map<K, V>, k: K, f: () => V): V => { let v = m.get(k); if (v === undefined) { v = f(); m.set(k, v); } return v; };
const pct = (x: number, fill: number) => (x / fill) * 100;

export class ReportAcc {
  readonly groups = new Map<string, Group>(); readonly pairs = new Map<Category, Pair[]>();
  readonly offsets = new Set<number>(); readonly sizes: number[]; readonly pairOffset: number;
  rowsTotal = 0; bytesTotal = 0; minDue = Infinity; maxDue = -Infinity; readonly days = new Set<string>(); evalGapS: number[] = []; paperRowsSeen = 0;
  constructor(o: { sizes: readonly number[]; pairOffset: number }) { this.sizes = [...o.sizes]; this.pairOffset = o.pairOffset; }

  /** Group keys a row counts toward: everything, its category, its signal kind, and the two together. */
  static keys(m: SignalMeta): string[] { return ["ALL", `cat:${m.category}`, `kind:${m.kind}`, `cat:${m.category}|kind:${m.kind}`]; }

  add(row: RowLite, meta: SignalMeta, dueSec: number, paper: PaperLite | null): void {
    this.rowsTotal++; this.bytesTotal += row.bytes; this.offsets.add(row.offset_s); this.minDue = Math.min(this.minDue, dueSec); this.maxDue = Math.max(this.maxDue, dueSec); this.days.add(new Date(dueSec * 1000).toISOString().slice(0, 10));
    for (const key of ReportAcc.keys(meta)) this.addTo(get(this.groups, key, mk), row);
    if (row.offset_s === this.pairOffset && paper) this.pair(row, meta, paper);
  }

  private addTo(g: Group, r: RowLite) {
    g.rows++; g.signals.add(r.signal_id);
    const st = get(g.status, r.offset_s, () => new Map<string, number>()); st.set(r.status, (st.get(r.status) ?? 0) + 1);
    if (r.spread !== null && r.status === "OK") get(g.spread, r.offset_s, () => []).push(r.spread * PTS);
    if (r.status === "OK" || r.status === "ONE_SIDED") {
      const d = get(g.depth, r.offset_s, () => ({ ask1: [], ask2: [], bid1: [], bid2: [], trunc: 0, n: 0 })); d.n++;
      const a1 = depthWithin(r.asks, "ask", 1), a2 = depthWithin(r.asks, "ask", 2), b1 = depthWithin(r.bids, "bid", 1), b2 = depthWithin(r.bids, "bid", 2);
      if (a1) d.ask1.push(a1.usd); if (a2) { d.ask2.push(a2.usd); if (a2.truncated) d.trunc++; } if (b1) d.bid1.push(b1.usd); if (b2) d.bid2.push(b2.usd);
    }
    if (r.fee_rate_bps !== null && r.fee_source !== null) { g.feeBps.push(r.fee_rate_bps); if (r.fee_rate_bps === 0) g.feeZero++; }
    if (r.fee_source === "ASSUMED_UNKNOWN" || r.fee_source === "ASSUMED_RATE") g.feeAssumed++;
    if (r.fills) for (const size of this.sizes) {
      const f = r.fills.by_usd[String(size)]; if (!f) continue;
      const a = get(get(g.fills, r.offset_s, () => new Map<number, FillAcc>()), size, () => ({ n: 0, notFull: 0, none: 0, pts: [], pct: [], midPts: [] }));
      a.n++; if (f.filled_share < 1 - 1e-9) a.notFull++; if (f.filled_share <= 0) a.none++;
      if (f.avg_price !== null && f.slippage_vs_source !== null) { a.pts.push(f.slippage_vs_source * PTS); a.pct.push(pct(f.slippage_vs_source, f.avg_price)); }
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
      obsLat: pct(r.mid - src, a), obsExec: pct(a - r.mid, a), obsPrice: pct(a - src, a), obsFee: pct(f.fee_usd, f.filled_usd),
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
export interface FillStats { offset: number; usd: number; n: number; unfillableShare: number | null; noneShare: number | null; slipPts: Dist; slipPctStake: Dist; slipMidPts: Dist }
export interface GroupStats {
  key: string; rows: number; signals: number; statusByOffset: Record<string, Record<string, number>>;
  spreadPts: Record<string, Dist>; depth: Record<string, { n: number; ask1: Dist; ask2: Dist; bid1: Dist; bid2: Dist; truncatedShare: number | null }>;
  feeBps: Dist; feeZeroShare: number | null; feeAssumedShare: number | null; fills: FillStats[];
}
export interface MetricComparison { metric: string; n: number; markets: number; paperMean: number | null; observedMean: number | null; diff: MeanCi; verdict: Verdict; observedShareOfPaper: number | null }
export interface PairedReport { offsetUsed: number; why: string; paperLatencyS: number; evalGapMedianS: number | null; paperRowsSeen: number; pairs: number; metrics: MetricComparison[]; byCategory: Record<string, MetricComparison[]> }
export interface ShadowReport {
  generatedAt: string; window: { fromIso: string | null; toIso: string | null; days: number };
  coverage: { rows: number; signalsMeasured: number; statusByOffset: Record<string, Record<string, number>>; missedShare: number | null; refusedShare: number | null; entrySignalsInPeriod: number | null; signalsWithoutRows: number | null };
  volume: { rowsPerDay: number | null; bytesPerRow: number | null; mbPer45Days: number | null };
  groups: GroupStats[]; paired: PairedReport; offsets: number[]; sizes: number[];
}

const share = (k: number, n: number) => (n > 0 ? k / n : null);
function groupStats(key: string, g: Group, sizes: number[]): GroupStats {
  const statusByOffset: GroupStats["statusByOffset"] = {}; for (const [o, m] of g.status) statusByOffset[String(o)] = Object.fromEntries(m);
  const spreadPts: GroupStats["spreadPts"] = {}; for (const [o, xs] of g.spread) spreadPts[String(o)] = dist(xs);
  const depth: GroupStats["depth"] = {}; for (const [o, d] of g.depth) depth[String(o)] = { n: d.n, ask1: dist(d.ask1), ask2: dist(d.ask2), bid1: dist(d.bid1), bid2: dist(d.bid2), truncatedShare: share(d.trunc, d.ask2.length) };
  const fills: FillStats[] = [];
  for (const [o, bySize] of [...g.fills].sort((a, b) => a[0] - b[0])) for (const usd of sizes) { const a = bySize.get(usd); if (a) fills.push({ offset: o, usd, n: a.n, unfillableShare: share(a.notFull, a.n), noneShare: share(a.none, a.n), slipPts: dist(a.pts), slipPctStake: dist(a.pct), slipMidPts: dist(a.midPts) }); }
  return { key, rows: g.rows, signals: g.signals.size, statusByOffset, spreadPts, depth, feeBps: dist(g.feeBps), feeZeroShare: share(g.feeZero, g.feeBps.length), feeAssumedShare: share(g.feeAssumed, g.rows), fills };
}

function compare(metric: string, ps: Pair[], paperOf: (p: Pair) => number, obsOf: (p: Pair) => number): MetricComparison {
  const diffs = ps.map((p) => obsOf(p) - paperOf(p)); const d = clusterMean(diffs, ps.map((p) => p.cluster));
  const pm = mean(ps.map(paperOf)), om = mean(ps.map(obsOf));
  return { metric, n: ps.length, markets: d.clusters, paperMean: pm, observedMean: om, diff: d, verdict: verdictOf(d), observedShareOfPaper: pm !== null && pm > 0 && om !== null ? om / pm : null };
}
const METRICS: [string, (p: Pair) => number, (p: Pair) => number][] = [
  ["price cost, % of stake (latency + spread + impact)", (p) => p.paperPrice, (p) => p.obsPrice],
  ["  of which price moved before the order (mid vs the wallet's price)", (p) => p.paperLat, (p) => p.obsLat],
  ["  of which spread and impact (fill vs mid)", (p) => p.paperExec, (p) => p.obsExec],
  ["price cost, points of price", (p) => p.paperPts, (p) => p.obsPts],
];
const comparisons = (ps: Pair[]): MetricComparison[] => {
  const out = METRICS.map(([m, a, b]) => compare(m, ps, a, b));
  const fee = ps.filter((p) => p.obsFeeObserved && p.paperFeeObserved); // a fee is compared only where BOTH sides observed a rate: assumed against assumed says nothing
  out.push(compare("fee, % of stake (both sides observed)", fee, (p) => p.paperFee, (p) => p.obsFee));
  return out;
};

export function buildReport(acc: ReportAcc, o: { generatedAt: string; days: number; entrySignalsInPeriod?: number | null }): ShadowReport {
  const groups = [...acc.groups].sort((a, b) => (a[0] === "ALL" ? -1 : b[0] === "ALL" ? 1 : a[0] < b[0] ? -1 : 1)).map(([k, g]) => groupStats(k, g, acc.sizes));
  const all = groups.find((g) => g.key === "ALL"); const statusByOffset = all?.statusByOffset ?? {};
  let total = 0, missed = 0, refused = 0; for (const m of Object.values(statusByOffset)) for (const [s, n] of Object.entries(m)) { total += n; if (s === "MISSED") missed += n; if (s === "REFUSED") refused += n; }
  const measured = all?.signals ?? 0; const nDays = Math.max(1, acc.days.size);
  const ps = acc.allPairs(); const byCategory: Record<string, MetricComparison[]> = {}; for (const [c, xs] of acc.pairs) byCategory[c] = comparisons(xs);
  return {
    generatedAt: o.generatedAt, window: { fromIso: Number.isFinite(acc.minDue) ? new Date(acc.minDue * 1000).toISOString() : null, toIso: Number.isFinite(acc.maxDue) ? new Date(acc.maxDue * 1000).toISOString() : null, days: o.days },
    coverage: { rows: total, signalsMeasured: measured, statusByOffset, missedShare: share(missed, total), refusedShare: share(refused, total), entrySignalsInPeriod: o.entrySignalsInPeriod ?? null, signalsWithoutRows: o.entrySignalsInPeriod == null ? null : Math.max(0, o.entrySignalsInPeriod - measured) },
    volume: { rowsPerDay: acc.rowsTotal ? acc.rowsTotal / nDays : null, bytesPerRow: acc.rowsTotal ? acc.bytesTotal / acc.rowsTotal : null, mbPer45Days: acc.rowsTotal ? ((acc.rowsTotal / nDays) * (acc.bytesTotal / acc.rowsTotal) * 45) / 1e6 : null },
    groups, offsets: [...acc.offsets].sort((a, b) => a - b), sizes: acc.sizes,
    paired: { offsetUsed: acc.pairOffset, why: `offset ${acc.pairOffset} s is the offset nearest to the paper REALISTIC decision + execution latency (${PAPER_LATENCY_S} s) after our evaluation`, paperLatencyS: PAPER_LATENCY_S, evalGapMedianS: quantile(acc.evalGapS, 0.5), paperRowsSeen: acc.paperRowsSeen, pairs: ps.length, metrics: comparisons(ps), byCategory },
  };
}

// ───────────────────────────────────────────── rendering ─────────────────────────────────────────────
const f1 = (x: number | null, d = 1) => (x === null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const sh = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);
export const WHAT_THIS_IS_NOT = [
  "WHAT THIS IS NOT: no number here is an edge estimate. It measures the COST of following a wallet (spread, depth, price movement, fees), never",
  "whether following pays. It places no order, uses no account or key, and changes no signal, score, alert or paper result. A cost that is",
  "'confirmed' is a statement about the paper model's cost assumptions only. Verify the fee unit and formula on the live venue first (D111).",
];
const find = (r: ShadowReport, key: string) => r.groups.find((g) => g.key === key);
const fillAt = (g: GroupStats | undefined, offset: number, usd: number) => g?.fills.find((f) => f.offset === offset && f.usd === usd);
function table(r: ShadowReport, keys: string[], offset: number): string[] {
  const out = [`${"group".padEnd(30)} ${"rows".padStart(6)} ${"spr p50".padStart(7)} ${"p90".padStart(5)} ${"ask≤1pt$".padStart(8)} ${"fee bps".padStart(7)} ${"unf@25".padStart(6)} ${"unf@100".padStart(7)} ${"slip25 p50/p90".padStart(14)}`];
  for (const k of keys) {
    const g = find(r, k); if (!g) continue; const sp = g.spreadPts[String(offset)]; const dp = g.depth[String(offset)]; const f25 = fillAt(g, offset, 25), f100 = fillAt(g, offset, 100);
    out.push(`${k.replace(/^cat:|^kind:/, "").padEnd(30).slice(0, 30)} ${String(g.rows).padStart(6)} ${f1(sp?.p50 ?? null, 2).padStart(7)} ${f1(sp?.p90 ?? null, 2).padStart(5)} ${f1(dp?.ask1.p50 ?? null, 0).padStart(8)} ${f1(g.feeBps.p50, 0).padStart(7)} ${sh(f25?.unfillableShare ?? null).padStart(6)} ${sh(f100?.unfillableShare ?? null).padStart(7)} ${`${f1(f25?.slipPts.p50 ?? null, 2)}/${f1(f25?.slipPts.p90 ?? null, 2)}`.padStart(14)}`);
  }
  return out;
}
export function consoleLines(r: ShadowReport, outDir: string, files: string[]): string[] {
  const L: string[] = []; const c = r.coverage; const off = r.paired.offsetUsed;
  L.push(`Phase 4.1 shadow order books — ${r.window.fromIso?.slice(0, 16) ?? "no data"} → ${r.window.toIso?.slice(0, 16) ?? ""} UTC (${r.window.days} d requested)`);
  if (!c.rows) { L.push("No shadow_books rows in this window. Is SHADOW_BOOKS=1 set on the worker, and has migration 0012 been applied?"); L.push(...WHAT_THIS_IS_NOT); return L; }
  L.push(`COVERAGE  ${c.rows} rows · ${c.signalsMeasured} signals measured${c.entrySignalsInPeriod != null ? ` of ${c.entrySignalsInPeriod} entry signals in the period (${c.signalsWithoutRows} with no row)` : ""} · MISSED ${sh(c.missedShare)} · REFUSED ${sh(c.refusedShare)}`);
  for (const o of r.offsets) { const m = c.statusByOffset[String(o)] ?? {}; L.push(`  offset ${String(o).padStart(3)} s: ${Object.entries(m).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(" · ")}`); }
  const cats = r.groups.filter((g) => g.key.startsWith("cat:") && !g.key.includes("|")).sort((a, b) => b.rows - a.rows).map((g) => g.key);
  const kinds = r.groups.filter((g) => g.key.startsWith("kind:")).sort((a, b) => b.rows - a.rows).map((g) => g.key);
  L.push(`BY CATEGORY AND KIND at offset ${off} s (spread in price points, depth in $ on the ask side, unf = share not fully fillable in the top book)`);
  L.push(...table(r, ["ALL", ...cats, ...kinds], off));
  const p = r.paired; L.push(`PAIRED WITH PAPER REALISTIC (same signals; ${p.pairs} pairs of ${p.paperRowsSeen} with a paper row; ${p.why}; observed fill at $100)`);
  for (const m of p.metrics) L.push(`  ${m.metric.padEnd(66).slice(0, 66)} paper ${f1(m.paperMean, 2).padStart(6)} obs ${f1(m.observedMean, 2).padStart(6)} Δ ${f1(m.diff.mean, 2).padStart(6)} [${f1(m.diff.lo, 2)}, ${f1(m.diff.hi, 2)}] n=${m.n} → ${m.verdict}${m.observedShareOfPaper !== null ? ` (obs = ${(m.observedShareOfPaper * 100).toFixed(0)}% of paper)` : ""}`);
  L.push(`  plan v3 §1 reference over all settled signals: price ${PLAN_REFERENCE.priceCostPts} points, fees ${PLAN_REFERENCE.feeCostPts} points of stake (a different population; printed for orientation only)`);
  if (p.evalGapMedianS !== null) L.push(`  median gap between the signal's created_at and the paper evaluation time: ${f1(p.evalGapMedianS, 1)} s (the pairing treats them as the same instant)`);
  L.push(`VOLUME  ${f1(r.volume.rowsPerDay, 0)} rows/day · ${f1(r.volume.bytesPerRow, 0)} bytes/row (JSON, before indexes) · ≈ ${f1(r.volume.mbPer45Days, 0)} MB at 45 days' retention`);
  L.push(`Files in ${outDir}: ${files.join(", ")}`);
  L.push(...WHAT_THIS_IS_NOT); return L;
}

/** Long form of the per-group results: one CSV row per group × offset × size. */
export function groupsCsv(r: ShadowReport): string {
  const header = ["group", "offset_s", "usd", "rows_in_group", "n_fills", "unfillable_share", "none_filled_share", "slip_pts_p50", "slip_pts_p90", "slip_pts_mean", "slip_pct_stake_p50", "slip_pct_stake_p90", "slip_pct_stake_mean", "slip_vs_mid_pts_p50", "spread_pts_p50", "spread_pts_p90", "ask_depth_1pt_usd_p50", "ask_depth_2pt_usd_p50", "bid_depth_1pt_usd_p50", "depth_2pt_truncated_share", "fee_bps_p50", "fee_bps_p90", "fee_zero_share", "fee_assumed_share"];
  const rows: unknown[][] = [];
  for (const g of r.groups) for (const f of g.fills) { const sp = g.spreadPts[String(f.offset)], d = g.depth[String(f.offset)];
    rows.push([g.key, f.offset, f.usd, g.rows, f.n, f.unfillableShare, f.noneShare, f.slipPts.p50, f.slipPts.p90, f.slipPts.mean, f.slipPctStake.p50, f.slipPctStake.p90, f.slipPctStake.mean, f.slipMidPts.p50, sp?.p50, sp?.p90, d?.ask1.p50, d?.ask2.p50, d?.bid1.p50, d?.truncatedShare, g.feeBps.p50, g.feeBps.p90, g.feeZeroShare, g.feeAssumedShare]); }
  return toCsv(header, rows);
}
export function pairedCsv(r: ShadowReport): string {
  const rows: unknown[][] = []; const add = (scope: string, ms: MetricComparison[]) => { for (const m of ms) rows.push([scope, m.metric.trim(), m.n, m.markets, m.paperMean, m.observedMean, m.diff.mean, m.diff.se, m.diff.lo, m.diff.hi, m.verdict, m.observedShareOfPaper]); };
  add("ALL", r.paired.metrics); for (const [c, ms] of Object.entries(r.paired.byCategory)) add(`cat:${c}`, ms);
  return toCsv(["scope", "metric", "pairs", "markets", "paper_mean", "observed_mean", "diff_mean", "diff_se_cluster_robust", "diff_lo95", "diff_hi95", "verdict", "observed_share_of_paper"], rows);
}
