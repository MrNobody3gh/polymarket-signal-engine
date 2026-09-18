/**
 * Pure analytics over paper_ledger rows + marks. No opinions: every number is a measured outcome, every
 * bucket reports its sample size, and small samples are flagged rather than ranked.
 */
import type { PaperStatus } from "./ledger";

export interface PaperRowLite { signal_id: string; wallet: string | null; wallet_name: string | null; kind: string; token_id: string | null; title: string | null; outcome: string | null; signal_ts: string; entry_price: number; shares: number | null; size_usd: number; copy_score: number | null; consensus_depth: number | null; status: PaperStatus; final_pnl: number | null; final_return: number | null }
export interface MarkLite { signal_id: string; horizon: string; observed_at: string; price: number; pnl: number; return_pct: number }
export const MIN_SAMPLE = 10;
export const SETTLED: PaperStatus[] = ["RESOLVED_WIN", "RESOLVED_LOSS", "EXITED"];
export const SCORE_BANDS = [{ label: "0–39", lo: 0, hi: 39.999 }, { label: "40–59", lo: 40, hi: 59.999 }, { label: "60–79", lo: 60, hi: 79.999 }, { label: "80–100", lo: 80, hi: 100 }];
export const DEPTH_BANDS = [{ label: "2 wallets", lo: 2, hi: 2 }, { label: "3 wallets", lo: 3, hi: 3 }, { label: "4 wallets", lo: 4, hi: 4 }, { label: "5+ wallets", lo: 5, hi: Infinity }];

/** The return we can attribute to a position right now: settled value, else the latest observed mark, else null. */
export function currentReturn(p: PaperRowLite, marks: MarkLite[]): { pnl: number; ret: number; basis: "settled" | "mark" } | null {
  if (SETTLED.includes(p.status) && p.final_pnl != null && p.final_return != null) return { pnl: Number(p.final_pnl), ret: Number(p.final_return), basis: "settled" };
  const m = marks.filter((x) => x.signal_id === p.signal_id).sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0];
  return m ? { pnl: Number(m.pnl), ret: Number(m.return_pct), basis: "mark" } : null;
}

export interface Stats { signals: number; open: number; resolved: number; exited: number; unresolved: number; invalid: number; observed: number; pnl: number; avgReturn: number | null; medianReturn: number | null; winRate: number | null; lossRate: number | null; avgWin: number | null; avgLoss: number | null; best: { id: string; ret: number; title: string | null } | null; worst: { id: string; ret: number; title: string | null } | null; insufficient: boolean }

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Aggregate one set of positions. Win/loss rates are computed on SETTLED positions only; avg/median return on every observed position. */
export function computeStats(rows: PaperRowLite[], marks: MarkLite[]): Stats {
  const positions = rows.filter((r) => r.status !== "EXIT_EVENT");
  const obs = positions.map((p) => ({ p, c: currentReturn(p, marks) })).filter((x) => x.c) as { p: PaperRowLite; c: NonNullable<ReturnType<typeof currentReturn>> }[];
  const settled = obs.filter((x) => x.c.basis === "settled");
  const wins = settled.filter((x) => x.c.pnl > 0), losses = settled.filter((x) => x.c.pnl < 0);
  const rets = obs.map((x) => x.c.ret);
  const best = obs.length ? obs.reduce((a, b) => (b.c.ret > a.c.ret ? b : a)) : null; const worst = obs.length ? obs.reduce((a, b) => (b.c.ret < a.c.ret ? b : a)) : null;
  return {
    signals: positions.length, open: positions.filter((p) => p.status === "OPEN").length, resolved: positions.filter((p) => p.status === "RESOLVED_WIN" || p.status === "RESOLVED_LOSS").length,
    exited: positions.filter((p) => p.status === "EXITED").length, unresolved: positions.filter((p) => p.status === "UNRESOLVED").length, invalid: positions.filter((p) => p.status === "INVALID").length,
    observed: obs.length, pnl: obs.reduce((a, x) => a + x.c.pnl, 0), avgReturn: mean(rets), medianReturn: median(rets),
    winRate: settled.length ? wins.length / settled.length : null, lossRate: settled.length ? losses.length / settled.length : null,
    avgWin: mean(wins.map((x) => x.c.ret)), avgLoss: mean(losses.map((x) => x.c.ret)),
    best: best ? { id: best.p.signal_id, ret: best.c.ret, title: best.p.title } : null, worst: worst ? { id: worst.p.signal_id, ret: worst.c.ret, title: worst.p.title } : null,
    insufficient: obs.length < MIN_SAMPLE,
  };
}
export const byKind = (rows: PaperRowLite[], marks: MarkLite[]) => groupBy(rows, marks, (r) => r.kind);
export const byScoreBand = (rows: PaperRowLite[], marks: MarkLite[]) => groupBy(rows, marks, (r) => { const s = r.copy_score; if (s == null) return "unscored"; return SCORE_BANDS.find((b) => s >= b.lo && s <= b.hi)?.label ?? "unscored"; }, [...SCORE_BANDS.map((b) => b.label), "unscored"]);
export const byConsensusDepth = (rows: PaperRowLite[], marks: MarkLite[]) => groupBy(rows.filter((r) => r.kind === "CONSENSUS"), marks, (r) => { const d = r.consensus_depth ?? 0; return DEPTH_BANDS.find((b) => d >= b.lo && d <= b.hi)?.label ?? "unknown"; }, DEPTH_BANDS.map((b) => b.label));
export function byWallet(rows: PaperRowLite[], marks: MarkLite[]) {
  const g = groupBy(rows, marks, (r) => r.wallet ?? "unknown");
  return g.map((x) => ({ ...x, name: rows.find((r) => r.wallet === x.key)?.wallet_name ?? null, kinds: byKind(rows.filter((r) => r.wallet === x.key), marks) })).sort((a, b) => b.stats.signals - a.stats.signals);
}
export function groupBy(rows: PaperRowLite[], marks: MarkLite[], keyOf: (r: PaperRowLite) => string, order?: string[]): { key: string; stats: Stats }[] {
  const m = new Map<string, PaperRowLite[]>(); for (const r of rows) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); }
  const keys = order ? order.filter((k) => m.has(k)).concat([...m.keys()].filter((k) => !order.includes(k))) : [...m.keys()];
  return keys.map((k) => ({ key: k, stats: computeStats(m.get(k)!, marks) }));
}
export const pct = (v: number | null, d = 1) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
export const pctPlain = (v: number | null, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
export const usd = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`);
