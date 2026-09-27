/**
 * Portfolio report (docs/PHASE3_PLAN.md §J step 7).
 *
 * `portfolio_report(id)` (supabase/migrations/0010_portfolio_report.sql) computes it in Postgres; `buildPortfolioReport`
 * below is the pure JS reference with the identical shape, used by the parity test (tests/phase3-report.test.ts). The
 * rules are in the migration's header: everything as of the watermark (each lot rebuilt as of it), cost basis and market value kept apart, cash
 * derived from the lots, measured results only (no rankings), `insufficient` under 10 settled lots.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { portfolioDefinitions, portfolioRunConfigFromEnv, type PortfolioRunConfig } from "./config";

export const PORTFOLIO_SNAPSHOT_KEY = "paper:portfolio";
export const LOCKED_AFTER_SEC = 30 * 86_400;
export const KINDS = ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"] as const;
const OUTCOMES = ["FILLED", "PARTIALLY_FILLED", "UNFILLED", "EXPIRED", "INVALID", "UNKNOWN", "REJECTED"] as const;
const DUP = "REJECTED_DUPLICATE_POSITION";
export const FILL_RATE_BASIS = "fills / decisions, excluding UNKNOWN (no price data) and REJECTED_DUPLICATE_POSITION (same source fill, plan D1)";
export const DUPLICATES_NOTE = "REJECTED_DUPLICATE_POSITION is the same source fill seen by two signals (plan D1), not a risk limit";
export const BY_KIND_NOTE = "CONSENSUS is under-attributed: when it shares a source fill with NEW_POSITION the lot is credited to NEW_POSITION (plan D1)";
export const THINNING_NOTE = "points older than 7 days are thinned to the last point per hour, so drawdown before thinnedBefore is measured on hourly points";
export const LOCKED_RULE = "open lots opened 30 days or more before asOf with no resolution; derived here, portfolio_lots.locked_unresolved is not maintained (D11)";
export const NO_WATERMARK = "no run has finished yet: nothing is decided";
export const staleWarning = (n: number) => `${n} execution row(s) were skipped in the last run because their stored fill time no longer matched their inputs; they are decided once the sweep recomputes them`;

type Row = Record<string, any>;
/** Rows exactly as stored (timestamps as ISO strings or Dates; numerics as numbers or strings). */
export interface ReportInput {
  portfolio: Row | null; run: Row | null;
  decisions: Row[]; lots: Row[]; equity: Row[];
  /** paper_marks rows for the portfolio's lots (any horizon; the report picks). */
  marks: Row[];
  /** fill_ts of this mode's paper_executions rows (only the count after asOf is used). */
  executionFillTs: (string | Date)[];
  /** Clock for generatedAt and the lease state, epoch seconds. */
  now: number;
}

const ts = (v: unknown): number | null => (v == null ? null : v instanceof Date ? v.getTime() / 1000 : Date.parse(String(v)) / 1000);
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const cmpC = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // code-unit order = Postgres "C" collation
const isoZ = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const countBy = (rows: Row[], key: (r: Row) => string) => { const o: Record<string, number> = {}; for (const r of rows) { const k = key(r); o[k] = (o[k] ?? 0) + 1; } return o; };

/**
 * A stored lot as it stood at `asOf`: its (single) exit and resolution count only if they happened by then, and state,
 * open shares and cost, exit / resolution cash and realised P&L are rebuilt from the stored amounts, exactly as the book
 * booked them (the exit takes cost × sold / shares). A lot exited after asOf is open, at full cost, with only its entry
 * fee realised.
 */
export function lotAsOf(x: Row, asOf: number): Row {
  const xa = x.exit_ts != null && ts(x.exit_ts)! <= asOf, ra = x.resolution_ts != null && ts(x.resolution_ts)! <= asOf;
  const cost = num(x.cost_usd), cpart = cost * (num(x.exit_shares) / num(x.shares_filled)); const full = xa && x.state === "EXITED";
  const state = ra ? "RESOLVED" : full ? "EXITED" : xa ? "PARTIALLY_EXITED" : "OPEN";
  return { ...x, state,
    shares_open: ra || full ? 0 : xa ? num(x.shares_filled) - num(x.exit_shares) : num(x.shares_filled),
    cost_open: ra || full ? 0 : xa ? cost - cpart : cost,
    exit_proceeds: xa ? x.exit_proceeds : null, exit_fee: xa ? x.exit_fee : null,
    resolution_proceeds: ra ? x.resolution_proceeds : null, resolution_ts: ra ? x.resolution_ts : null,
    closed_ts: ra ? x.resolution_ts : full ? x.exit_ts : null,
    realized_pnl: -num(x.entry_fee) + (xa ? num(x.exit_proceeds) - cpart - num(x.exit_fee) : 0) + (ra ? num(x.resolution_proceeds) - (cost - (xa ? cpart : 0)) : 0) };
}

/** Pure: the report from stored rows. Same shape and numbers as `portfolio_report` (up to float rounding). */
export function buildPortfolioReport(inp: ReportInput) {
  const p = inp.portfolio; if (!p) return null;
  const r = inp.run; const cfg = (p.config ?? {}) as Row; const stats = (r?.stats ?? null) as Row | null;
  const asOf = ts(r?.last_watermark_ts); const within = (t: unknown) => asOf != null && ts(t)! <= asOf;
  const cap0 = Number(cfg.startingCapitalUsd); const reserve = cfg.minCashReserveUsd == null ? 0 : Number(cfg.minCashReserveUsd);

  const d = inp.decisions.filter((x) => within(x.event_ts));
  const kindOf = new Map(d.map((x) => [String(x.signal_id), x.kind as string]));
  const l: Row[] = inp.lots.filter((x) => within(x.opened_ts)).map((x) => { const y = lotAsOf(x, asOf!); return { ...y, kind: kindOf.get(String(x.signal_id)) ?? null, isOpen: y.state === "OPEN" || y.state === "PARTIALLY_EXITED", isSettled: y.state === "EXITED" || y.state === "RESOLVED" }; });
  const lo = l.filter((x) => x.isOpen), ls = l.filter((x) => x.isSettled);

  const cash = cap0 - sum(l.map((x) => num(x.cost_usd) + num(x.entry_fee))) + sum(l.map((x) => num(x.exit_proceeds) - num(x.exit_fee))) + sum(l.map((x) => num(x.resolution_proceeds)));
  const inv = sum(lo.map((x) => num(x.cost_open)));

  // latest 1h/6h/24h mark observed between the lot's fill and the watermark
  const marksBySig = new Map<string, Row[]>(); for (const m of inp.marks) (marksBySig.get(String(m.signal_id)) ?? marksBySig.set(String(m.signal_id), []).get(String(m.signal_id))!).push(m);
  const om = lo.map((x) => {
    const c = (marksBySig.get(String(x.signal_id)) ?? []).filter((m) => ["1h", "6h", "24h"].includes(m.horizon) && ts(m.observed_at)! >= ts(x.opened_ts)! && within(m.observed_at))
      .sort((a, b) => ts(b.observed_at)! - ts(a.observed_at)! || cmpC(b.horizon, a.horizon));
    return { shares: num(x.shares_open), cost: num(x.cost_open), price: c.length ? Number(c[0].price) : null };
  });
  const marked = om.filter((x) => x.price != null), unmarked = om.filter((x) => x.price == null);

  const eqRows = inp.equity.filter((x) => within(x.ts)).map((x) => ({ t: ts(x.ts)!, seq: Number(x.seq), equity: Number(x.equity) })).sort((a, b) => a.t - b.t || a.seq - b.seq);
  let run = -Infinity, peakMax: number | null = null, mdd = 0, mddPct = 0;
  for (const e of eqRows) { run = Math.max(run, e.equity); const peak = Math.max(cap0, run); peakMax = peakMax == null ? peak : Math.max(peakMax, peak); mdd = Math.max(mdd, peak - e.equity); if (peak !== 0) mddPct = Math.max(mddPct, (peak - e.equity) / peak); }

  const realized = sum(l.map((x) => num(x.realized_pnl))); const entryFees = sum(l.map((x) => num(x.entry_fee))); const exitFees = sum(l.map((x) => num(x.exit_fee)));
  const out = (o: string) => d.filter((x) => x.outcome === o).length;
  const isDup = (x: Row) => x.outcome === "REJECTED" && x.reason === DUP;
  const fills = d.filter((x) => x.outcome === "FILLED" || x.outcome === "PARTIALLY_FILLED").length; const decided = d.filter((x) => x.outcome !== "UNKNOWN" && !isDup(x)).length;

  const byKind: Record<string, unknown> = {};
  for (const k of KINDS) {
    const dk = d.filter((x) => x.kind === k), lk = l.filter((x) => x.kind === k), settled = lk.filter((x) => x.isSettled);
    byKind[k] = { requests: dk.length, fills: dk.filter((x) => x.outcome === "FILLED" || x.outcome === "PARTIALLY_FILLED").length,
      rejections: countBy(dk.filter((x) => x.outcome === "REJECTED"), (x) => x.reason),
      lotsOpened: lk.length, openLots: lk.filter((x) => x.isOpen).length, settledLots: settled.length,
      realizedPnl: sum(lk.map((x) => num(x.realized_pnl))), fees: sum(lk.map((x) => num(x.entry_fee) + num(x.exit_fee))),
      winRate: settled.length ? settled.filter((x) => num(x.realized_pnl) > 0).length / settled.length : null, insufficient: settled.length < 10 };
  }

  const top = (key: string, name: string) => {
    const g = new Map<string, { n: number; c: number }>(); for (const x of lo) { const k = String(x[key]); const v = g.get(k) ?? { n: 0, c: 0 }; v.n++; v.c += num(x.cost_open); g.set(k, v); }
    return [...g].sort((a, b) => b[1].c - a[1].c || cmpC(a[0], b[0])).slice(0, 10).map(([k, v]) => ({ [name]: k, lots: v.n, cost: v.c, share: inv !== 0 ? v.c / inv : null }));
  };

  const locked = asOf == null ? [] : lo.filter((x) => x.resolution_ts == null && ts(x.opened_ts)! <= asOf - LOCKED_AFTER_SEC);
  const net = ls.map((x) => num(x.realized_pnl)); const desc = [...net].sort((a, b) => b - a); const total = sum(net);
  const exBest = (n: number) => total - sum(desc.slice(0, n).filter((x) => x > 0));
  const wins = net.filter((x) => x > 0), losses = net.filter((x) => x < 0);
  const staleRows = stats?.staleRows == null ? 0 : Number(stats.staleRows);
  const leaseUntil = ts(r?.lease_until);
  const pendingAhead = inp.executionFillTs.filter((f) => ts(f)! > (asOf ?? ts(p.start_ts)! - 1)).length;

  return {
    portfolio: { id: p.id, mode: p.mode, startTs: ts(p.start_ts), config: p.config, nonCausalBaseline: p.mode === "IDEAL", label: p.mode === "IDEAL" ? (cfg.note ?? null) : null },
    asOf: { basis: "watermark", ts: asOf, iso: asOf == null ? null : isoZ(asOf), lastRunFinishedAt: ts(r?.last_run_finished_at), frontier: stats?.frontier ?? null, generatedAt: inp.now },
    capital: { startingCapital: cap0, cash, investedAtCost: inv, equityAtCost: cash + inv, utilisation: cash + inv !== 0 ? inv / (cash + inv) : null, minCashReserve: reserve, availableCash: Math.max(0, cash - reserve) },
    pnl: { basis: "cost", realized, entryFees, exitFees, gross: realized + entryFees + exitFees, returnPct: cap0 !== 0 ? realized / cap0 : null,
      marketValue: { basis: "marks", unrealisedAtMarks: sum(marked.map((x) => x.price! * x.shares - x.cost)), equityAtMarks: cash + sum(marked.map((x) => x.price! * x.shares)) + sum(unmarked.map((x) => x.cost)),
        lotsWithoutMark: { count: unmarked.length, cost: sum(unmarked.map((x) => x.cost)) } } },
    risk: { basis: "cost", points: eqRows.length, peakEquity: peakMax ?? cap0, maxDrawdown: mdd, maxDrawdownPct: mddPct, endingEquity: eqRows.length ? eqRows[eqRows.length - 1].equity : cap0,
      thinnedBefore: stats?.equityDownsampledTo == null ? null : Number(stats.equityDownsampledTo), note: THINNING_NOTE },
    decisions: { total: d.length, byOutcome: Object.fromEntries(OUTCOMES.map((o) => [o, out(o)])),
      rejectionsByReason: countBy(d.filter((x) => x.outcome === "REJECTED" && x.reason !== DUP), (x) => x.reason), duplicates: d.filter(isDup).length,
      requestedUsd: sum(d.map((x) => num(x.requested_usd))), filledUsd: sum(d.map((x) => num(x.filled_usd))), fillRate: decided ? fills / decided : null, fillRateBasis: FILL_RATE_BASIS,
      resized: d.filter((x) => x.resized === true).length, duplicatesNote: DUPLICATES_NOTE },
    byKind, byKindNote: BY_KIND_NOTE,
    exposure: { openLots: lo.length, investedAtCost: inv, topMarkets: top("condition_id", "conditionId"), topWallets: top("wallet", "wallet") },
    lots: { total: l.length, byState: { OPEN: l.filter((x) => x.state === "OPEN").length, PARTIALLY_EXITED: l.filter((x) => x.state === "PARTIALLY_EXITED").length, EXITED: l.filter((x) => x.state === "EXITED").length, RESOLVED: l.filter((x) => x.state === "RESOLVED").length },
      closedByExit: l.filter((x) => x.state === "EXITED").length, closedByResolution: l.filter((x) => x.state === "RESOLVED").length,
      medianHoldingSec: median(ls.map((x) => ts(x.closed_ts)! - ts(x.opened_ts)!)),
      lockedUnresolved: { count: locked.length, cost: sum(locked.map((x) => num(x.cost_open))), oldestOpenedTs: locked.length ? Math.min(...locked.map((x) => ts(x.opened_ts)!)) : null, rule: LOCKED_RULE } },
    robustness: { basis: "settled lots, net of fees", settled: ls.length, total, exBest1: exBest(1), exBest3: exBest(3), exBest5: exBest(5), exBest10: exBest(10),
      profitFactor: losses.length ? sum(wins) / -sum(losses) : null, expectancy: net.length ? total / net.length : null,
      largestWin: wins.length ? Math.max(...wins) : null, largestLoss: losses.length ? Math.min(...losses) : null,
      medianReturn: median(ls.map((x) => num(x.realized_pnl) / num(x.cost_usd))), insufficient: ls.length < 10 },
    health: { lastRunStartedAt: ts(r?.last_run_started_at), lastRunFinishedAt: ts(r?.last_run_finished_at),
      lease: { owner: r?.lease_owner ?? null, until: leaseUntil, held: leaseUntil != null && leaseUntil > inp.now },
      lastRewind: stats?.rewind ?? null, rowsRead: numOrNull(stats?.rowsRead), staleRows, pendingAhead,
      warnings: [...(asOf == null ? [NO_WATERMARK] : []), ...(staleRows > 0 ? [staleWarning(staleRows)] : [])] },
  };
}
export type PortfolioReport = NonNullable<ReturnType<typeof buildPortfolioReport>>;

/** The report for one portfolio, computed by Postgres. null when the portfolio does not exist yet. */
export async function portfolioReport(db: SupabaseClient, portfolioId: string): Promise<PortfolioReport | null> {
  const { data, error } = await db.rpc("portfolio_report", { p_portfolio_id: portfolioId });
  if (error) throw new Error(`portfolio_report: ${error.message}`);
  return (data ?? null) as PortfolioReport | null;
}

/**
 * Every configured portfolio's report in one cursor row (`cursors['paper:portfolio']`), for the dashboard and bot.
 * One RPC per portfolio, no row reads in JS. Unset config → writes nothing and returns null. Not wired into the worker.
 */
export async function savePortfolioSnapshot(db: SupabaseClient, opts: { config?: PortfolioRunConfig | null; now?: () => number } = {}) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const cfg = opts.config === undefined ? portfolioRunConfigFromEnv(process.env, now()) : opts.config;
  if (!cfg) return null;
  const portfolios = [];
  for (const def of portfolioDefinitions(cfg)) portfolios.push({ portfolioId: def.id, mode: def.mode, report: await portfolioReport(db, def.id) });
  const snapshot = { generatedAt: new Date(now() * 1000).toISOString(), portfolios };
  const { error } = await db.from("cursors").upsert({ key: PORTFOLIO_SNAPSHOT_KEY, value: JSON.stringify(snapshot), updated_at: snapshot.generatedAt });
  if (error) throw new Error(`cursors write: ${error.message}`);
  return snapshot;
}
