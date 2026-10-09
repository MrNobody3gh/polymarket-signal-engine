/**
 * Phase 4.1b Part D — the owner's decision table (one row per category), the passive-indicator lines and the power note. Pure; no I/O.
 *
 * Everything here restates numbers the accumulator already holds; it adds no estimate. The cells are COSTS (spread, slippage, fees, the unfillable share, the passive-touch indicator)
 * and a PAIRED comparison of the same costs with the paper REALISTIC model. None is an outcome: whether following pays needs settled trades (see `powerLines`).
 */
import { RETURN_SD_PTS, nForHalfWidth, nForPower, nFromSe, type MeanCi } from "./report-math";
import type { FillStats, GroupStats, MetricComparison } from "./report";
import type { PassiveStats } from "./passive";

export interface PassiveCell { offset: number; share: number | null; known: number; touched: number }
export interface DecisionRow {
  category: string; /** signals with an OK book at the paired offset */ signals: number; tooFew: boolean;
  spreadP50Pts: number | null; slipPtsP50: number | null; slipPctP50: number | null; slipPts: MeanCi; slipPct: MeanCi;
  feeMarketPct: MeanCi; feeMarketUnknown: number; feeRecordedPct: MeanCi; unfillableShare: number | null;
  passiveBid: PassiveCell | null; passiveMid: PassiveCell | null;
  paper: { pairs: number; pts: MetricComparison | null; feeMarket: MetricComparison | null };
}
export interface PowerNote { returnSdPts: number; nHalfWidth5: number; nPower5: number; slipSignals: number; slipSe: number | null; slipSignalsFor1Pt: number | null }

const f1 = (x: number | null, d = 1) => (x === null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const sh = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);
const num = (n: number) => n.toLocaleString("en-US");
const ci = (c: MeanCi, d = 2) => (c.mean === null ? "—" : c.lo === null || c.hi === null ? `${f1(c.mean, d)} [no interval]` : `${f1(c.mean, d)} [${f1(c.lo, d)}, ${f1(c.hi, d)}]`);
const half = (c: MeanCi, d = 1) => (c.mean === null ? "—" : c.lo === null || c.hi === null ? f1(c.mean, d) : `${f1(c.mean, d)}±${f1((c.hi - c.lo) / 2, d)}`);
const EMPTY: MeanCi = { n: 0, clusters: 0, mean: null, se: null, lo: null, hi: null };

export interface DecisionInput {
  groups: GroupStats[]; passive: Record<string, { bid: PassiveStats; mid: PassiveStats }>; byCategory: Record<string, MetricComparison[]>; allPairs: MetricComparison[];
  pairOffset: number; refUsd: number; laterOffsets: readonly number[];
}
const POINTS = /^price cost, points of price/; const FEE_MKT = /^fee, % of stake at the market's own rate/;

function rowFor(key: string, g: GroupStats, passive: DecisionInput["passive"][string] | undefined, ms: MetricComparison[] | undefined, inp: DecisionInput): DecisionRow {
  const f: FillStats | undefined = g.fills.find((x) => x.offset === inp.pairOffset && x.usd === inp.refUsd); const last = inp.laterOffsets[inp.laterOffsets.length - 1];
  const cell = (s: PassiveStats | undefined): PassiveCell | null => { const r = s?.rows.find((x) => x.offset === last); return r ? { offset: r.offset, share: r.share, known: r.known, touched: r.touched } : null; };
  const pts = ms?.find((m) => POINTS.test(m.metric)) ?? null;
  return {
    category: key, signals: g.signalsOk, tooFew: g.tooFew, spreadP50Pts: g.spreadPts[String(inp.pairOffset)]?.p50 ?? null,
    slipPtsP50: f?.slipPts.p50 ?? null, slipPctP50: f?.slipPctStake.p50 ?? null, slipPts: f?.slipPtsCi ?? EMPTY, slipPct: f?.slipPctCi ?? EMPTY,
    feeMarketPct: f?.feeMarketPct ?? EMPTY, feeMarketUnknown: f?.feeMarketUnknown ?? 0, feeRecordedPct: f?.feeRecordedPct ?? EMPTY, unfillableShare: f?.unfillableShare ?? null,
    passiveBid: cell(passive?.bid), passiveMid: cell(passive?.mid),
    paper: { pairs: pts?.n ?? 0, pts, feeMarket: ms?.find((m) => FEE_MKT.test(m.metric)) ?? null },
  };
}

/** The decision rows: ALL first, then every category by number of signals, and the power note read from the ALL row's slippage precision. */
export function buildDecision(inp: DecisionInput): { rows: DecisionRow[]; power: PowerNote } {
  const rows: DecisionRow[] = [];
  const all = inp.groups.find((g) => g.key === "ALL"); if (all) rows.push(rowFor("ALL", all, inp.passive.ALL, inp.allPairs, inp));
  const cats = inp.groups.filter((g) => g.key.startsWith("cat:") && !g.key.includes("|")).sort((a, b) => b.signalsOk - a.signalsOk || (a.key < b.key ? -1 : 1));
  for (const g of cats) { const c = g.key.slice(4); rows.push(rowFor(c, g, inp.passive[g.key], inp.byCategory[c], inp)); }
  const a = rows[0]; const power: PowerNote = {
    returnSdPts: RETURN_SD_PTS, nHalfWidth5: nForHalfWidth(RETURN_SD_PTS, 5), nPower5: nForPower(RETURN_SD_PTS, 5),
    slipSignals: a?.slipPts.n ?? 0, slipSe: a?.slipPts.se ?? null, slipSignalsFor1Pt: a ? nFromSe(a.slipPts.n, a.slipPts.se, 1) : null,
  };
  return { rows, power };
}

const THIN = "too few";
/** The console block: two header lines, at most `cap` rows (ALL first), then a pointer to the rest. */
export function decisionLines(rows: DecisionRow[], cap: number, offset: number, usd: number): string[] {
  const L = [`DECISION TABLE at offset ${offset} s, $${usd} taker buy (costs only; medians here, means with 95% intervals in shadow_report.md; fee = the market's own rate, the recorded-bps fee beside it)`];
  L.push(`${"category".padEnd(22)} ${"sig".padStart(5)} ${"spr50".padStart(6)} ${"slip pts".padStart(8)} ${"slip %stk".padStart(9)} ${"fee% mkt ±(unk)".padStart(16)} ${"fee% rec".padStart(9)} ${"unf".padStart(4)} ${"pass@end bid/mid".padStart(17)}  Δ price vs paper, pts [95%] pairs → verdict`);
  for (const r of rows.slice(0, cap)) {
    const pb = r.passiveBid, pm = r.passiveMid; const d = r.paper.pts;
    L.push(`${r.category.padEnd(22).slice(0, 22)} ${String(r.signals).padStart(5)} ${f1(r.spreadP50Pts, 2).padStart(6)} ${f1(r.slipPtsP50, 2).padStart(8)} ${f1(r.slipPctP50, 2).padStart(9)} ${`${half(r.feeMarketPct)} (${r.feeMarketUnknown})`.padStart(16)} ${f1(r.feeRecordedPct.mean, 1).padStart(9)} ${sh(r.unfillableShare).padStart(4)} ${`${sh(pb?.share ?? null)}/${sh(pm?.share ?? null)}`.padStart(17)}  ${d ? `${ci(d.diff, 1)} n=${d.n} → ${d.verdict}` : "—"}${r.tooFew ? `  ${THIN}` : ""}`);
  }
  if (rows.length > cap) L.push(`  … ${rows.length - cap} more strata in shadow_report.md`);
  return L;
}
/** The long form: every cell with its sample size and interval. */
export function decisionDetail(rows: DecisionRow[], usd: number): string[] {
  const L: string[] = [];
  for (const r of rows) {
    L.push(`${r.category}${r.tooFew ? `   [${THIN}: ${r.signals} signals with an OK book, fewer than 30]` : `   [${r.signals} signals with an OK book]`}`);
    L.push(`  median spread ${f1(r.spreadP50Pts, 2)} points · share unfillable at $${usd}: ${sh(r.unfillableShare)}`);
    L.push(`  taker slippage vs the wallet's price at $${usd}: median ${f1(r.slipPtsP50, 2)} points / ${f1(r.slipPctP50, 2)}% of stake · mean ${ci(r.slipPts)} points (n=${r.slipPts.n}, ${r.slipPts.clusters} markets) · mean ${ci(r.slipPct)}% of stake`);
    L.push(`  taker fee, % of stake: at the market's own rate ${ci(r.feeMarketPct)} (n=${r.feeMarketPct.n}, rate unknown for ${r.feeMarketUnknown}) · at the recorded bps ${ci(r.feeRecordedPct)} (n=${r.feeRecordedPct.n})`);
    const p = (n: string, c: PassiveCell | null) => (c ? `${n} touched by ${c.offset} s: ${sh(c.share)} (${c.touched}/${c.known})` : `${n}: no eligible signal`);
    L.push(`  passive indicator (NOT a fill rate): ${p("best bid", r.passiveBid)} · ${p("mid", r.passiveMid)}`);
    const d = r.paper.pts, fe = r.paper.feeMarket;
    L.push(`  paired with paper REALISTIC (observed − paper): price cost ${d ? `${ci(d.diff)} points, n=${d.n}, ${d.markets} markets → ${d.verdict}` : "no pairs"} · fee ${fe ? `${ci(fe.diff)} points of stake, n=${fe.n} → ${fe.verdict}` : "no pairs"}`);
  }
  return L;
}

/** The passive-indicator lines of one group (3 lines; the label first). */
export function passiveLines(v: { bid: PassiveStats; mid: PassiveStats } | undefined, laterOffsets: readonly number[], key = "ALL"): string[] {
  const L = [`PASSIVE BUY INDICATOR (${key}) — NOT a fill rate, NOT evidence of profit, and not a strict bound: a later best ask at or below the offset-0 limit; queue, partial fills and between-snapshot moves ignored`];
  if (!v) { L.push("  no signal had a readable offset-0 book and later snapshots"); return L; }
  const one = (name: string, s: PassiveStats) => {
    const by = s.rows.map((r) => `by ${r.offset} s ${sh(r.share)} (${r.touched}/${r.known})`).join(" · "); const d = s.touchedDetail;
    return `  ${name.padEnd(12)} ${by} · of ${d.n} touched by ${laterOffsets[laterOffsets.length - 1] ?? "—"} s: ${ci(d.improvementPts, 2)} points better than the taker fill (${f1(d.improvementPct.mean, 2)}% of stake), fee avoided ${f1(d.avoidedFeePct.mean, 2)}% of stake (unknown ${d.avoidedFeeUnknown}), touch price below the wallet's ${sh(d.belowSourceShare)}, first touched only at the last offset ${sh(d.firstTouchLateShare)}`;
  };
  L.push(one("at best bid", v.bid), one("at the mid", v.mid)); return L;
}

/** The power note, 4 lines: what is a cost (readable at hundreds of signals) and what would need outcomes. */
export function powerLines(p: PowerNote): string[] {
  return [
    `POWER NOTE  OUTCOMES (does following pay) are not in this report. With a per-trade return SD of about ${p.returnSdPts} points (the owner's figure, not measured here) a ±5-point 95% interval needs about ${num(p.nHalfWidth5)} settled trades,`,
    `  and detecting a 5-point difference with 80% power about ${num(p.nPower5)}, per category: 1,000+ settled trades each. COSTS (spread, slippage, fees, unfillable share, touch shares) vary far less across signals and are readable at hundreds:`,
    `  from this report's own standard error, ±1 point of taker slippage at $25 needs about ${p.slipSignalsFor1Pt === null ? "an unknown number of (no interval yet)" : num(p.slipSignalsFor1Pt)} signals (${num(p.slipSignals)} measured). Paired differences with paper are costs too; none is an outcome.`,
  ];
}
