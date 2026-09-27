/**
 * Phase 3 step 7: the portfolio report. The JS reference (src/lib/paper/portfolio/report.ts) is tested on hand-built
 * rows with known answers; the SQL function (supabase/migrations/0010_portfolio_report.sql) must equal it field by
 * field on random portfolios in real Postgres (PG_TEST_URL). Also: the runner's delete counts (R10), the snapshot, and
 * a check that the report agrees with the book on a real run.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { stressDb } from "./helpers/stressDb";
import { pgDb } from "./helpers/pgDb";
import { buildPortfolioReport, savePortfolioSnapshot, portfolioReport, PORTFOLIO_SNAPSHOT_KEY, LOCKED_RULE, staleWarning, NO_WATERMARK, type ReportInput } from "@/lib/paper/portfolio/report";
import { runPortfolios, countAndDelete } from "@/lib/paper/portfolio/run";
import { validatePortfolioConfig, portfolioDefinitions, IDEAL_LABEL } from "@/lib/paper/portfolio/config";
import type { ModeName, PortfolioConfig } from "@/lib/paper/sim/config";

const B = 1_900_000_000; const DAY = 86_400;
const iso = (s: number) => new Date(s * 1000).toISOString();
const PC: PortfolioConfig = { startingCapitalUsd: 1_000, positionUsd: 100, maxMarketExposureUsd: 300, maxTotalExposurePct: 80, maxOpenPositions: 20, maxWalletAllocationUsd: 400, minCashReserveUsd: 50, allowResize: true };
const MIG = path.resolve(__dirname, "../supabase/migrations");
afterEach(() => { vi.useRealTimers(); delete process.env.PAPER_PORTFOLIO_CONFIG; });

// ───────────────────────────── hand-built rows ─────────────────────────────
const uid = (ns: number, i: number) => `2e${String(ns).padStart(6, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`;
type Row = Record<string, any>;
function base(mode: ModeName = "REALISTIC", W: number | null = B + 40 * DAY, stats: Row = {}): ReportInput {
  const config = { ...PC, startTs: iso(B), ...(mode === "IDEAL" ? { nonCausalBaseline: true, note: IDEAL_LABEL } : {}) };
  return { portfolio: { id: `rep-${mode.toLowerCase()}-0001`, mode, start_ts: iso(B), config }, run: W == null ? null : { portfolio_id: `rep-${mode.toLowerCase()}-0001`, last_watermark_ts: iso(W), last_run_started_at: iso(W + 60), last_run_finished_at: iso(W + 90), lease_owner: null, lease_until: null, stats },
    decisions: [], lots: [], equity: [], marks: [], executionFillTs: [], now: W == null ? B : W + 120 };
}
const dec = (id: string, t: number, o: Row = {}): Row => ({ signal_id: id, kind: "NEW_POSITION", source_key: `k-${id}`, event_ts: iso(t), outcome: "FILLED", reason: null, requested_usd: 100, filled_usd: 100, filled_shares: 200, fill_price: 0.5, fee: 1, resized: false, input_hash: "i", record_hash: "r", ...o });
/** A lot and its (filled) decision. state: OPEN | PARTIALLY_EXITED | EXITED | RESOLVED; net = realised P&L for settled lots. */
function lotPair(id: string, t: number, o: { state?: string; cost?: number; wallet?: string; cond?: string; net?: number; closedAt?: number; kind?: string; sold?: number } = {}): [Row, Row] {
  const cost = o.cost ?? 100, shares = cost / 0.5, fee = 1, state = o.state ?? "OPEN";
  const l: Row = { portfolio_id: "x", signal_id: id, wallet: o.wallet ?? "w1", token_id: `t-${id}`, condition_id: o.cond ?? "c1", opened_ts: iso(t), shares_filled: shares, cost_usd: cost, entry_fee: fee,
    shares_open: shares, cost_open: cost, exit_signal_id: null, exit_ts: null, exit_shares: null, exit_proceeds: null, exit_fee: null, resolution_ts: null, resolution_value: null, resolution_proceeds: null,
    state, locked_unresolved: false, realized_pnl: -fee, closed_ts: null, record_hash: "r" };
  const closed = o.closedAt ?? t + 3600;
  if (state === "PARTIALLY_EXITED") { const f = o.sold ?? 0.4; Object.assign(l, { exit_ts: iso(closed), exit_shares: shares * f, exit_proceeds: cost * f * 1.2, exit_fee: 0.5, shares_open: shares * (1 - f), cost_open: cost * (1 - f), realized_pnl: -fee + cost * f * 0.2 - 0.5 }); }
  if (state === "EXITED") { const net = o.net ?? 5; Object.assign(l, { exit_ts: iso(closed), exit_shares: shares, exit_proceeds: cost + net + fee + 0.5, exit_fee: 0.5, shares_open: 0, cost_open: 0, realized_pnl: net, closed_ts: iso(closed) }); }
  if (state === "RESOLVED") { const net = o.net ?? -3; Object.assign(l, { resolution_ts: iso(closed), resolution_value: 1, resolution_proceeds: Math.max(0, cost + net + fee), shares_open: 0, cost_open: 0, realized_pnl: net, closed_ts: iso(closed) }); }
  return [dec(id, t, { kind: o.kind ?? "NEW_POSITION", filled_usd: cost, filled_shares: shares }), l];
}
function withLots(inp: ReportInput, pairs: [Row, Row][]) { for (const [d, l] of pairs) { inp.decisions.push(d); inp.lots.push({ ...l, portfolio_id: inp.portfolio!.id }); } return inp; }
const rep = (inp: ReportInput) => buildPortfolioReport(inp)!;

describe("portfolio report (JS reference)", () => {
  it("R2 (test 2): cost basis and market value are separate; unmarked lots at cost and counted; marks after asOf or before the fill ignored", () => {
    const W = B + 10 * DAY; const inp = base("REALISTIC", W);
    const t = B + DAY; withLots(inp, [lotPair(uid(1, 1), t, { cost: 100 }), lotPair(uid(1, 2), t, { cost: 50 }), lotPair(uid(1, 3), t, { cost: 80 }), lotPair(uid(1, 4), t, { cost: 60 }), lotPair(uid(1, 5), t, { state: "EXITED", net: 7 })]);
    inp.marks.push(
      { signal_id: uid(1, 1), horizon: "1h", observed_at: iso(t + 3600), price: 0.9 }, { signal_id: uid(1, 1), horizon: "24h", observed_at: iso(t + DAY), price: 0.6 }, // latest wins: 0.6
      { signal_id: uid(1, 1), horizon: "exit", observed_at: iso(t + 2 * DAY), price: 0.99 },                                                                    // not a 1h/6h/24h mark
      { signal_id: uid(1, 3), horizon: "24h", observed_at: iso(W + 1), price: 0.9 },                                                                           // after asOf: ignored
      { signal_id: uid(1, 4), horizon: "1h", observed_at: iso(t - 10), price: 0.9 });                                                                          // before the fill: ignored
    const r = rep(inp);
    const cash = 1000 - (100 + 50 + 80 + 60 + 100) - 5 + (100 + 7 + 1 + 0.5) - 0.5; // costs + entry fees; the exited lot's proceeds − exit fee
    expect(r.capital).toMatchObject({ startingCapital: 1000, investedAtCost: 290, minCashReserve: 50 }); expect(r.capital.cash).toBeCloseTo(cash, 9);
    expect(r.capital.equityAtCost).toBeCloseTo(cash + 290, 9); expect(r.capital.utilisation).toBeCloseTo(290 / (cash + 290), 12); expect(r.capital.availableCash).toBeCloseTo(cash - 50, 9);
    expect(r.pnl.realized).toBeCloseTo(-4 + 7, 9); expect(r.capital.equityAtCost - 1000).toBeCloseTo(r.pnl.realized, 9); // cash identity
    expect(r.pnl).toMatchObject({ basis: "cost", entryFees: 5, exitFees: 0.5 }); expect(r.pnl.gross).toBeCloseTo(3 + 5.5, 9); expect(r.pnl.returnPct).toBeCloseTo(3 / 1000, 12);
    const mv = r.pnl.marketValue; expect(mv.basis).toBe("marks");
    expect(mv.unrealisedAtMarks).toBeCloseTo(200 * 0.6 - 100, 9); expect(mv.lotsWithoutMark).toEqual({ count: 3, cost: 190 });
    expect(mv.equityAtMarks).toBeCloseTo(cash + 120 + 190, 9);
  });

  it("R3 (test 3): rows after the watermark change nothing; the basis is labelled", () => {
    const W = B + 10 * DAY; const mk = () => { const i = withLots(base("CONSERVATIVE", W), [lotPair(uid(2, 1), B + DAY, { cost: 100 }), lotPair(uid(2, 2), B + 2 * DAY, { state: "RESOLVED", net: 4 })]);
      i.equity.push({ ts: iso(B + DAY), seq: 0, cash: 899, exposure: 100, equity: 999 }, { ts: iso(B + 2 * DAY), seq: 0, cash: 900, exposure: 100, equity: 1000 }); i.marks.push({ signal_id: uid(2, 1), horizon: "6h", observed_at: iso(B + DAY + 6 * 3600), price: 0.3 }); return i; };
    const a = rep(mk()); const later = mk();
    withLots(later, [lotPair(uid(2, 3), W + 1, { cost: 90, cond: "c9" }), lotPair(uid(2, 4), W + 5, { state: "EXITED", net: 50, closedAt: W + 50 })]);
    later.decisions.push(dec(uid(2, 5), W + 2, { outcome: "REJECTED", reason: "REJECTED_MAX_OPEN_POSITIONS", filled_usd: 0, filled_shares: 0, fill_price: null, fee: 0 }));
    later.equity.push({ ts: iso(W + 1), seq: 0, cash: 10, exposure: 5, equity: 15 }); later.marks.push({ signal_id: uid(2, 1), horizon: "24h", observed_at: iso(W + 1), price: 0.99 });
    expect(rep(later)).toEqual(a);
    expect(a.asOf).toMatchObject({ basis: "watermark", ts: W, iso: iso(W).replace(".000Z", "Z") });
  });

  it("R8 (test 4): locked unresolved — 29d23h is not locked, 30d and more is; settled lots never", () => {
    const W = B + 60 * DAY; const inp = withLots(base("REALISTIC", W), [
      lotPair(uid(3, 1), W - (30 * DAY - 3600), { cost: 11 }), lotPair(uid(3, 2), W - 30 * DAY, { cost: 13 }), lotPair(uid(3, 3), W - 45 * DAY, { cost: 17, state: "PARTIALLY_EXITED", closedAt: W - 40 * DAY }),
      lotPair(uid(3, 4), W - 50 * DAY, { state: "RESOLVED", closedAt: W - DAY }), lotPair(uid(3, 5), W - 50 * DAY, { state: "EXITED", closedAt: W - DAY })]);
    const r = rep(inp).lots.lockedUnresolved;
    expect(r).toEqual({ count: 2, cost: 13 + 17 * 0.6, oldestOpenedTs: W - 45 * DAY, rule: LOCKED_RULE });
    expect(inp.lots.every((l) => l.locked_unresolved === false)).toBe(true); // the column is not written (D11)
  });

  it("R4 (test 5): drawdown on a hand-built equity path, including hourly-thinned points and same-second sequences", () => {
    const inp = base("REALISTIC", B + 20 * DAY, { equityDownsampledTo: B + 13 * DAY });
    const pts: [number, number, number][] = [[B + 3600, 0, 950], [B + 7200, 0, 1100], [B + 10_800, 0, 990], [B + 10_800, 1, 1050], [B + 14 * DAY, 0, 1200], [B + 15 * DAY, 0, 1068], [B + 15 * DAY, 1, 1100]];
    for (const [t, seq, equity] of [...pts].reverse()) inp.equity.push({ ts: iso(t), seq, cash: equity, exposure: 0, equity }); // unordered on purpose
    inp.equity.push({ ts: iso(B + 21 * DAY), seq: 0, cash: 1, exposure: 0, equity: 1 });                                       // after asOf
    const r = rep(inp).risk;
    // peaks: 1000 (start) → dd 50 (5%); 1100 → dd 110 (10%); 1200 → dd 132 (11%)
    expect(r).toMatchObject({ basis: "cost", points: 7, peakEquity: 1200, maxDrawdown: 132, endingEquity: 1100, thinnedBefore: B + 13 * DAY });
    expect(r.maxDrawdownPct).toBeCloseTo(0.11, 12);
    const below = base("REALISTIC", B + 5 * DAY); for (const [t, e] of [[B + 60, 980], [B + 120, 800], [B + 180, 850]]) below.equity.push({ ts: iso(t), seq: 0, cash: e, exposure: 0, equity: e });
    expect(rep(below).risk).toMatchObject({ peakEquity: 1000, maxDrawdown: 200, maxDrawdownPct: 0.2, endingEquity: 850 });            // measured from the starting capital
  });

  it("R5 (test 6): rejections by reason, duplicates apart, fill rate over decided requests only", () => {
    const inp = base(); const t = B + DAY; let i = 0;
    const add = (n: number, o: Row) => { for (let k = 0; k < n; k++) inp.decisions.push(dec(uid(4, ++i), t + i, o)); };
    const none = { filled_usd: 0, filled_shares: 0, fill_price: null, fee: 0 };
    add(6, {}); add(2, { outcome: "PARTIALLY_FILLED", filled_usd: 40, filled_shares: 80, resized: true, reason: "RESIZED:LIMIT" }); add(3, { outcome: "UNFILLED", ...none });
    add(1, { outcome: "EXPIRED", ...none }); add(1, { outcome: "INVALID", ...none }); add(4, { outcome: "UNKNOWN", ...none });
    add(5, { outcome: "REJECTED", reason: "REJECTED_MAX_OPEN_POSITIONS", ...none }); add(2, { outcome: "REJECTED", reason: "REJECTED_INSUFFICIENT_CASH", ...none }); add(7, { outcome: "REJECTED", reason: "REJECTED_DUPLICATE_POSITION", ...none });
    const d = rep(inp).decisions;
    expect(d.total).toBe(31); expect(d.byOutcome).toEqual({ FILLED: 6, PARTIALLY_FILLED: 2, UNFILLED: 3, EXPIRED: 1, INVALID: 1, UNKNOWN: 4, REJECTED: 14 });
    expect(d.rejectionsByReason).toEqual({ REJECTED_MAX_OPEN_POSITIONS: 5, REJECTED_INSUFFICIENT_CASH: 2 }); expect(d.duplicates).toBe(7);
    expect(d.fillRate).toBeCloseTo(8 / (31 - 4 - 7), 12); expect(d.requestedUsd).toBe(3100); expect(d.filledUsd).toBe(680); expect(d.resized).toBe(2);
    expect(rep(base()).decisions.fillRate).toBeNull();
  });

  it("R6 (test 7): by kind, with the insufficient flag exactly at 10 settled lots", () => {
    const inp = base(); let i = 0; const t = B + DAY;
    for (let k = 0; k < 10; k++) withLots(inp, [lotPair(uid(5, ++i), t + i, { kind: "NEW_POSITION", state: k % 2 ? "EXITED" : "RESOLVED", net: k < 7 ? 2 : -1 })]);
    for (let k = 0; k < 9; k++) withLots(inp, [lotPair(uid(5, ++i), t + i, { kind: "CONSENSUS", state: "EXITED", net: 1 })]);
    withLots(inp, [lotPair(uid(5, ++i), t + i, { kind: "CONSENSUS" })]);
    inp.decisions.push(dec(uid(5, ++i), t + i, { kind: "CONSENSUS", outcome: "REJECTED", reason: "REJECTED_DUPLICATE_POSITION", filled_usd: 0, filled_shares: 0, fill_price: null, fee: 0 }));
    const k = rep(inp).byKind as Record<string, any>;
    expect(Object.keys(k)).toEqual(["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"]);
    expect(k.NEW_POSITION).toMatchObject({ requests: 10, fills: 10, lotsOpened: 10, openLots: 0, settledLots: 10, winRate: 0.7, insufficient: false }); expect(k.NEW_POSITION.realizedPnl).toBeCloseTo(7 * 2 - 3, 9);
    expect(k.CONSENSUS).toMatchObject({ requests: 11, fills: 10, rejections: { REJECTED_DUPLICATE_POSITION: 1 }, lotsOpened: 10, openLots: 1, settledLots: 9, winRate: 1, insufficient: true });
    expect(k.EARLY_ENTRY).toMatchObject({ requests: 0, lotsOpened: 0, winRate: null, insufficient: true, fees: 0 });
    expect(rep(inp).byKindNote).toMatch(/CONSENSUS is under-attributed/);
  });

  it("R7 (test 8): exposure top 10 by cost, ties broken by id (code-unit order), with shares of invested", () => {
    const inp = base(); let i = 0; const t = B + DAY;
    const costs: [string, number][] = [["cB", 50], ["ca", 50], ["cA", 50], ["c9", 70], ["c1", 20], ["c2", 20], ["c3", 20], ["c4", 20], ["c5", 20], ["c6", 20], ["c7", 20], ["c8", 10]];
    for (const [c, cost] of costs) withLots(inp, [lotPair(uid(6, ++i), t + i, { cond: c, cost, wallet: `W${c}` })]);
    withLots(inp, [lotPair(uid(6, ++i), t + i, { cond: "c9", cost: 5, state: "EXITED" })]); // settled: not exposure
    const e = rep(inp).exposure; const inv = 370;
    expect(e.openLots).toBe(12); expect(e.investedAtCost).toBe(inv);
    expect(e.topMarkets.map((x) => x.conditionId)).toEqual(["c9", "cA", "cB", "ca", "c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(e.topMarkets[0]).toEqual({ conditionId: "c9", lots: 1, cost: 70, share: 70 / inv });
    expect(e.topWallets.map((x) => x.wallet)).toEqual(["Wc9", "WcA", "WcB", "Wca", "Wc1", "Wc2", "Wc3", "Wc4", "Wc5", "Wc6"]);
  });

  it("R9 (test 9): robustness — ex-best-N, profit factor (null with no losses), expectancy, largest win/loss, median return", () => {
    const inp = base(); let i = 0; const t = B + DAY;
    for (const net of [10, 5, -3, 20, 0]) withLots(inp, [lotPair(uid(7, ++i), t + i, { state: "EXITED", net, cost: 100 })]);
    withLots(inp, [lotPair(uid(7, ++i), t + i, { cost: 100 })]); // open: not in robustness
    const r = rep(inp).robustness;
    expect(r).toMatchObject({ settled: 5, total: 32, exBest1: 12, exBest3: -3, exBest5: -3, exBest10: -3, largestWin: 20, largestLoss: -3, insufficient: true });
    expect(r.profitFactor).toBeCloseTo(35 / 3, 12); expect(r.expectancy).toBeCloseTo(6.4, 12); expect(r.medianReturn).toBeCloseTo(0.05, 12);
    const noLoss = base(); for (const net of [1, 2]) withLots(noLoss, [lotPair(uid(7, ++i), t + i, { state: "EXITED", net })]);
    expect(rep(noLoss).robustness).toMatchObject({ profitFactor: null, largestLoss: null, largestWin: 2 });
    expect(rep(base()).robustness).toMatchObject({ settled: 0, total: 0, profitFactor: null, expectancy: null, largestWin: null, largestLoss: null, medianReturn: null });
  });

  it("B10 (test 10): IDEAL carries the non-causal label; REALISTIC and CONSERVATIVE do not", () => {
    const defs = portfolioDefinitions(validatePortfolioConfig({ ...PC, startTs: iso(B) }, B + DAY));
    for (const d of defs) {
      const r = rep({ ...base(d.mode), portfolio: { id: d.id, mode: d.mode, start_ts: iso(B), config: d.config } });
      expect(r.portfolio).toMatchObject({ id: d.id, mode: d.mode, nonCausalBaseline: d.mode === "IDEAL", label: d.mode === "IDEAL" ? IDEAL_LABEL : null, startTs: B });
    }
  });

  it("R11 (test 11): stale rows raise a warning; pendingAhead counts only rows after asOf; lease state", () => {
    const W = B + 5 * DAY; const inp = base("REALISTIC", W, { staleRows: 3, rowsRead: 900, rewind: { to: W - 100, restoredFrom: W - 3600, reasons: ["x"] }, frontier: { ts: W + 1, order: 1, id: "s" } });
    inp.executionFillTs = [iso(W - 5), iso(W), iso(W + 1), new Date((W + 50) * 1000), iso(W + 3600)];
    inp.run!.lease_owner = "host:1:ab"; inp.run!.lease_until = iso(inp.now + 30);
    const r = rep(inp);
    expect(r.health).toMatchObject({ staleRows: 3, pendingAhead: 3, rowsRead: 900, lastRewind: { to: W - 100 }, lease: { owner: "host:1:ab", until: inp.now + 30, held: true }, warnings: [staleWarning(3)] });
    expect(r.asOf.frontier).toEqual({ ts: W + 1, order: 1, id: "s" });
    expect(rep(base("REALISTIC", W)).health.warnings).toEqual([]);
  });

  it("test 14: a portfolio with no run and no rows is well-formed (zeros and nulls); an unknown portfolio is null", () => {
    const inp = base("IDEAL", null); inp.executionFillTs = [iso(B - 1), iso(B), iso(B + 5)];
    const r = rep(inp);
    expect(r.asOf).toMatchObject({ ts: null, iso: null, lastRunFinishedAt: null });
    expect(r.capital).toEqual({ startingCapital: 1000, cash: 1000, investedAtCost: 0, equityAtCost: 1000, utilisation: 0, minCashReserve: 50, availableCash: 950 });
    expect(r.risk).toMatchObject({ points: 0, peakEquity: 1000, maxDrawdown: 0, maxDrawdownPct: 0, endingEquity: 1000, thinnedBefore: null });
    expect(r.decisions).toMatchObject({ total: 0, fillRate: null }); expect(r.lots).toMatchObject({ total: 0, medianHoldingSec: null, lockedUnresolved: { count: 0, cost: 0, oldestOpenedTs: null } });
    expect(r.health).toMatchObject({ pendingAhead: 2, staleRows: 0, rowsRead: null, warnings: [NO_WATERMARK], lease: { held: false } });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r); // plain JSON
    expect(buildPortfolioReport({ ...inp, portfolio: null })).toBeNull();
  });
});

// ───────────────────────────── against a real run ─────────────────────────────
function lease(db: ReturnType<typeof stressDb>) {
  return {
    claim_portfolio_lease: ({ p_portfolio_id: id, p_owner: owner, p_seconds: s }: any) => {
      let r = db.T("portfolio_runs").find((x) => x.portfolio_id === id); const now = Math.floor(Date.now() / 1000);
      if (!r) { r = { portfolio_id: id, lease_owner: null, lease_until: null, stats: {} }; db.insertRow("portfolio_runs", r); }
      if (r.lease_until == null || Date.parse(r.lease_until) / 1000 <= now || r.lease_owner === owner) { r.lease_owner = owner; r.lease_until = iso(now + s); return true; } return false;
    },
    release_portfolio_lease: ({ p_portfolio_id: id, p_owner: owner }: any) => { const r = db.T("portfolio_runs").find((x) => x.portfolio_id === id); if (r && r.lease_owner === owner) { r.lease_owner = null; r.lease_until = null; } return true; },
  };
}
/** An in-memory stand-in for the SQL function: the JS reference over the database's rows. */
function reportRpc(db: ReturnType<typeof stressDb>) {
  return (a: { p_portfolio_id: string }) => {
    const p = db.T("portfolios").find((x) => x.id === a.p_portfolio_id) ?? null; const mine = (t: string) => db.T(t).filter((x) => x.portfolio_id === a.p_portfolio_id);
    const lots = mine("portfolio_lots"); const ids = new Set(lots.map((l) => l.signal_id));
    return buildPortfolioReport({ portfolio: p, run: mine("portfolio_runs")[0] ?? null, decisions: mine("portfolio_decisions"), lots, equity: mine("portfolio_equity"),
      marks: db.T("paper_marks").filter((m) => ids.has(m.signal_id)), executionFillTs: p ? db.T("paper_executions").filter((e) => e.mode === p.mode).map((e) => e.fill_ts) : [], now: Math.floor(Date.now() / 1000) });
  };
}
/** An IDEAL world (no prices needed): entries in same-second groups, exits, resolutions, marks. */
function idealWorld(n: number, o: { maxRows?: number; seed?: number } = {}) {
  let db!: ReturnType<typeof stressDb>; const rpc: Record<string, (a: any) => any> = {};
  db = stressDb({ maxRows: o.maxRows, rpc }); Object.assign(rpc, lease(db), { portfolio_report: reportRpc(db) });
  let seed = o.seed ?? 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const E = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, X = (i: number) => `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`;
  let t = B; const led: Row[] = [], xled: Row[] = [];
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.8) t += 60;
    db.insertRow("signals", { id: E(i), kind: ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"][i % 4], wallet: `w${i % 7}`, condition_id: `c${i % 11}`, token_id: `t${i}`, price: 0.1 + rnd() * 0.8, usd: 2000, created_at: iso(t), evaluated_at: iso(t + 5), source_fill_id: `f${i}` });
    led.push({ signal_id: E(i), created_at: iso(t + 5), sim_terminal: false, side: "LONG" });
    db.insertRow("paper_executions", { signal_id: E(i), mode: "IDEAL", fill_ts: iso(t), computed_at: iso(B), state: "OPEN", coverage_state: "SIMULATED", record_hash: "x" });
    if (rnd() < 0.4) { const xs = t + 600 + Math.floor(rnd() * 90_000); db.insertRow("signals", { id: X(i), kind: "EXIT", wallet: `w${i % 7}`, condition_id: `c${i % 11}`, token_id: `t${i}`, price: 0.1 + rnd() * 0.8, usd: rnd() < 0.3 ? 20 : 3000, created_at: iso(xs), evaluated_at: iso(xs + 4) }); xled.push({ signal_id: X(i), created_at: iso(xs + 4), sim_terminal: true, side: "EXIT_EVENT" }); }
    if (rnd() < 0.4) db.insertRow("token_resolutions", { token_id: `t${i}`, value: rnd() < 0.5 ? 1 : 0, resolved_ts: iso(t + 300 + Math.floor(rnd() * 200_000)) });
    if (rnd() < 0.6) db.insertRow("paper_marks", { signal_id: E(i), horizon: "1h", observed_at: iso(t + 3600), price: rnd() });
  }
  for (const r of [...led, ...xled]) db.insertRow("paper_ledger", r);
  return { db, E, end: t };
}

describe("portfolio report against the runner", () => {
  it("agrees with the book: equity at cost, realised P&L, peak and drawdown equal the run's own summary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); const { db, end } = idealWorld(600); vi.setSystemTime((end + DAY) * 1000);
    const cfg = validatePortfolioConfig({ ...PC, startingCapitalUsd: 20_000, maxOpenPositions: 60, maxMarketExposureUsd: 2_000, maxWalletAllocationUsd: 3_000, startTs: iso(B) }, end + DAY);
    const [st] = await runPortfolios(db as never, { config: cfg, modes: ["IDEAL"], owner: "t" });
    const r = (await portfolioReport(db as never, st.portfolioId))!; const s = st.summary!;
    expect(r.asOf.ts).toBe(st.watermark); expect(r.lots.total).toBeGreaterThan(30); expect(r.lots.closedByExit + r.lots.closedByResolution).toBeGreaterThan(10);
    expect(r.capital.cash).toBeCloseTo(s.endingCash, 6); expect(r.capital.investedAtCost).toBeCloseTo(s.invested, 6); expect(r.pnl.realized).toBeCloseTo(s.realizedPnl, 6);
    expect(r.pnl.entryFees + r.pnl.exitFees).toBeCloseTo(s.fees, 6); expect(r.risk.peakEquity).toBeCloseTo(s.peakEquity, 6); expect(r.risk.maxDrawdown).toBeCloseTo(s.maxDrawdown, 6);
    expect(r.risk.endingEquity).toBeCloseTo(s.endingCash + s.invested, 6);
    expect(r.decisions.total).toBe(Object.values(st.decisions).reduce((a, b) => a + b, 0)); expect(r.decisions.duplicates + Object.values(r.decisions.rejectionsByReason).reduce((a, b) => a + b, 0)).toBe(st.decisions.REJECTED ?? 0);
    expect(r.exposure.openLots).toBe(r.lots.byState.OPEN + r.lots.byState.PARTIALLY_EXITED); expect(r.exposure.openLots).toBeGreaterThan(0); expect(r.health.pendingAhead).toBe(0);
  });

  it("R10 (test 12): a rewind that deletes more than 1,000 rows counts them exactly under Supabase's 1,000-row read cap — dry run and real", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const setup = async () => {
      const w = idealWorld(1600, { maxRows: 1000, seed: 9 }); vi.setSystemTime((w.end + DAY) * 1000);
      const cfg = validatePortfolioConfig({ ...PC, startingCapitalUsd: 1_000_000, maxOpenPositions: 5000, maxMarketExposureUsd: 1e6, maxWalletAllocationUsd: 1e6, minCashReserveUsd: 0, startTs: iso(B) }, w.end + DAY);
      const [s1] = await runPortfolios(w.db as never, { config: cfg, modes: ["IDEAL"], owner: "t" }); return { ...w, cfg, s1 };
    };
    let dryDeletes: Record<string, number> | null = null;
    for (const dryRun of [true, false]) {
      const { db, E, cfg, s1 } = await setup(); const pid = s1.portfolioId;
      // a late resolution for the very first lot: the whole history after it replays
      const first = db.T("portfolio_lots").filter((l) => l.portfolio_id === pid && l.state === "OPEN").sort((a, b) => a.opened_ts.localeCompare(b.opened_ts))[0];
      expect(first).toBeTruthy(); void E;
      db.T("token_resolutions").splice(0, Infinity, ...db.T("token_resolutions").filter((x) => x.token_id !== first.token_id));
      db.insertRow("token_resolutions", { token_id: first.token_id, value: 1, resolved_ts: iso(Date.parse(first.opened_ts) / 1000 + 30) });
      for (const e of db.T("paper_executions")) if (e.signal_id === first.signal_id) e.computed_at = iso(Math.floor(Date.now() / 1000) + 5); // what the sweep does
      const after = (t: string, col: string, S: number) => db.T(t).filter((x) => x.portfolio_id === pid && Date.parse(x[col]) / 1000 > S).length;
      vi.setSystemTime(Date.now() + 60_000);
      const [s2] = await runPortfolios(db as never, { config: cfg, modes: ["IDEAL"], owner: "t", dryRun });
      const S = s2.rewind.restoredFrom ?? B - 1;
      expect(s2.rewind.to).not.toBeNull();
      if (dryRun) {
        const want = { portfolio_decisions: after("portfolio_decisions", "event_ts", S), portfolio_lots: after("portfolio_lots", "opened_ts", S), portfolio_equity: after("portfolio_equity", "ts", S) };
        expect(want.portfolio_equity).toBeGreaterThan(1000); expect(want.portfolio_decisions).toBeGreaterThan(1000);
        for (const [t, n] of Object.entries(want)) expect(s2.deletes[t], t).toBe(n);
        dryDeletes = s2.deletes; expect(db.T("portfolio_equity").filter((x) => x.portfolio_id === pid && Date.parse(x.ts) / 1000 > S).length).toBe(want.portfolio_equity); // nothing deleted
      } else {
        for (const t of ["portfolio_decisions", "portfolio_lots", "portfolio_equity"]) expect(s2.deletes[t], t).toBe(dryDeletes![t]);                                            // same world, same rewind: same exact counts
      }
    }
  }, 120_000);

  it("R12 (test 13): the snapshot has one entry per configured portfolio, one RPC each and no row reads; unset config writes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); const { db, end } = idealWorld(120); vi.setSystemTime((end + DAY) * 1000);
    const cfg = validatePortfolioConfig({ ...PC, startTs: iso(B) }, end + DAY);
    await runPortfolios(db as never, { config: cfg, owner: "t", modes: ["IDEAL"] });
    let rpcCalls = 0; const froms: string[] = [];
    const spy = { from: (t: string) => { froms.push(t); return db.from(t); }, rpc: (n: string, a: any) => { rpcCalls++; return db.rpc(n, a); } };
    const snap = (await savePortfolioSnapshot(spy as never, { config: cfg, now: () => end + DAY }))!;
    expect(rpcCalls).toBe(3); expect(froms).toEqual(["cursors"]);
    expect(snap.portfolios.map((p) => p.mode)).toEqual(["IDEAL", "REALISTIC", "CONSERVATIVE"]);
    expect(snap.portfolios[0].report!.lots.total).toBeGreaterThan(0); expect(snap.portfolios[1].report).toBeNull();   // REALISTIC has never run: no portfolio row yet
    const stored = JSON.parse(db.T("cursors").find((c) => c.key === PORTFOLIO_SNAPSHOT_KEY)!.value);
    expect(stored).toEqual(JSON.parse(JSON.stringify(snap))); expect(stored.generatedAt).toBe(iso(end + DAY));
    const empty = stressDb(); expect(await savePortfolioSnapshot(empty as never, { config: null })).toBeNull(); expect(await savePortfolioSnapshot(empty as never, {})).toBeNull();
    expect(empty.T("cursors")).toEqual([]); expect(empty.stats.calls).toBe(0);
  });
});

// ───────────────────────────── real Postgres ─────────────────────────────
const PGURL = process.env.PG_TEST_URL; const d = PGURL ? describe : describe.skip;

/** A random portfolio's stored rows (all 0008 constraints hold), with rows after the watermark and marks either side of it. */
function randomPortfolio(mode: ModeName, ns: number, seed: number, o: { lots?: number; drift?: number } = {}) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const W = B + 45 * DAY; const inp = base(mode, W, { staleRows: ns % 2 ? 0 : 4, rowsRead: 1234, rewind: { to: W - 99, restoredFrom: W - 3600, reasons: ["late signal"] }, frontier: ns % 2 ? null : { ts: W + 1, order: 2, id: "z" }, equityDownsampledTo: W - 7 * DAY });
  inp.portfolio!.id = `rep-${ns}-${mode.toLowerCase()}`; inp.run!.portfolio_id = inp.portfolio!.id; inp.run!.lease_owner = "h:1:x"; inp.run!.lease_until = iso(W + 10_000_000);
  const n = o.lots ?? 260; const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = uid(ns, i); ids.push(id); const beyond = rnd() < 0.08; const t = beyond ? W + 1 + Math.floor(rnd() * 5 * DAY) : B + Math.floor(rnd() * 44 * DAY);
    const kind = pick(["NEW_POSITION", "NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"]); const roll = rnd();
    if (roll < 0.55) {
      const state = pick(["OPEN", "OPEN", "PARTIALLY_EXITED", "EXITED", "RESOLVED", "RESOLVED"]); const cost = 20 + Math.floor(rnd() * 80) + rnd();
      const closedAt = Math.min(beyond ? t + DAY : W, t + 60 + Math.floor(rnd() * 20 * DAY));
      const [dd, l] = lotPair(id, t, { kind, state, cost, wallet: `w${Math.floor(rnd() * 9)}`, cond: `c${Math.floor(rnd() * 14)}`, net: (rnd() - 0.45) * 40, closedAt, sold: 0.1 + rnd() * 0.8 });
      if (rnd() < 0.3) Object.assign(dd, { outcome: "PARTIALLY_FILLED", resized: rnd() < 0.5, reason: "RESIZED:LIMIT" });
      withLots(inp, [[dd, l]]);
      if (rnd() < 0.2) inp.marks.push({ signal_id: id, horizon: "exit", observed_at: iso(t + 2 * DAY), price: 0.99 });          // not a valuation mark
      for (const h of ["1h", "6h", "24h"]) if (rnd() < 0.5) inp.marks.push({ signal_id: id, horizon: h, observed_at: iso(t + (h === "1h" ? 3600 : h === "6h" ? 6 * 3600 : DAY) - (rnd() < 0.1 ? 5 * DAY : 0) + (rnd() < 0.1 ? 30 * DAY : 0)), price: rnd() });
    } else {
      const none = { filled_usd: 0, filled_shares: 0, fill_price: null, fee: 0, kind };
      inp.decisions.push(dec(id, t, roll < 0.8 ? { outcome: "REJECTED", reason: pick(["REJECTED_DUPLICATE_POSITION", "REJECTED_MAX_OPEN_POSITIONS", "REJECTED_MAX_MARKET_EXPOSURE", "REJECTED_INSUFFICIENT_CASH", "REJECTED_BELOW_MIN_ORDER"]), ...none }
        : { outcome: pick(["UNFILLED", "EXPIRED", "INVALID", "UNKNOWN"]), reason: pick([null, "NO_PRICE_OBSERVATION", "INSUFFICIENT_LIQUIDITY"]), ...none }));
    }
  }
  // exact ties straddling the top-10 cut (same cost, ids differing only in case: code-unit order decides who is in)
  for (const [k, cond] of ["cZ", "cz", "cY", "cy", "cX", "cx", "cW", "cw", "cV", "cv", "cU", "cu"].entries()) { const id = uid(ns, n + k); ids.push(id); const [dd, l] = lotPair(id, B + DAY + k, { cost: 5000, cond, wallet: cond.toUpperCase() + k }); dd.requested_usd = 5000; withLots(inp, [[dd, l]]); }
  // equity: hourly before the thinning cutoff, dense after it, some same-second sequences, some after the watermark
  let t = B, eqv = 1000;
  while (t < W + 3 * DAY) { eqv += (rnd() - (o.drift ?? 0.48)) * 30; const k = rnd() < 0.15 ? 2 : 1; for (let q = 0; q < k; q++) inp.equity.push({ ts: iso(t), seq: q, cash: eqv - 100, exposure: 100, equity: eqv + q }); t += t < W - 7 * DAY ? 3600 : 60 + Math.floor(rnd() * 900); }
  inp.executionFillTs = [];
  return { inp, ids };
}

async function load(c: pg.Client, inp: ReportInput, ids: string[]) {
  const ins = async (table: string, rows: Row[]) => { for (const r of rows) { const ks = Object.keys(r); await c.query(`insert into ${table} (${ks.join(",")}) values (${ks.map((_, i) => `$${i + 1}`).join(",")})`, ks.map((k) => (r[k] !== null && typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k]))); } };
  await ins("signals", ids.map((id) => ({ id, kind: "NEW_POSITION", severity: 2, wallet: "w", condition_id: "c", token_id: `t-${id}`, dedupe_key: `rep:${id}` })));
  await ins("paper_ledger", ids.map((id) => ({ signal_id: id, entry_price: 0.5 })));
  await ins("portfolios", [{ id: inp.portfolio!.id, mode: inp.portfolio!.mode, exec_config_hash: "e", config: inp.portfolio!.config, config_hash: "c", start_ts: inp.portfolio!.start_ts }]);
  if (inp.run) await ins("portfolio_runs", [inp.run]);
  await ins("portfolio_decisions", inp.decisions.map((x) => ({ portfolio_id: inp.portfolio!.id, ...x })));
  await ins("portfolio_lots", inp.lots); await ins("portfolio_equity", inp.equity.map((x) => ({ portfolio_id: inp.portfolio!.id, ...x })));
  await ins("paper_marks", inp.marks.map((m) => ({ ...m, pnl: 0, return_pct: 0, source: "test" })));
}
/** Field-by-field equality, numbers within 1e-6. Reports the first differing path. */
function same(a: unknown, b: unknown, p = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : `${p}: ${a} vs ${b}`;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b ? null : `${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}: array vs object`;
  const ka = Object.keys(a as object).sort(), kb = Object.keys(b as object).sort(); if (ka.join() !== kb.join()) return `${p}: keys ${ka} vs ${kb}`;
  for (const k of ka) { const r = same((a as Row)[k], (b as Row)[k], `${p}.${k}`); if (r) return r; }
  return null;
}

d("portfolio report — real Postgres", () => {
  // Its own database, built from migrations 0001–0010 (test 15): no interference with the other files' SQL tests,
  // which run in parallel on the shared test database.
  let c: pg.Client; let url = ""; const name = `rep7_${process.pid}_${Date.now()}`;
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: PGURL }); await admin.connect(); await admin.query(`create database ${name}`); await admin.end();
    const u = new URL(PGURL!); u.pathname = `/${name}`; url = u.toString();
    const s0 = new pg.Client({ connectionString: url }); await s0.connect();
    try { for (const f of readdirSync(MIG).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) await s0.query(readFileSync(path.join(MIG, f), "utf8")); } finally { await s0.end(); }
  }, 120_000);
  afterAll(async () => { const admin = new pg.Client({ connectionString: PGURL }); await admin.connect(); await admin.query(`drop database if exists ${name} with (force)`); await admin.end(); });
  const connect = async () => { c = new pg.Client({ connectionString: url }); await c.connect(); };
  const sqlReport = async (id: string) => (await c.query("select portfolio_report($1) as r", [id])).rows[0].r;

  it("test 1: SQL equals the JS reference field by field on random portfolios, all three modes (and on an empty one)", async () => {
    await connect();
    try {
      await c.query("begin isolation level repeatable read");
      let ns = 700;
      // seed 2: equity drifts down (drawdown measured from the starting capital); seed 3: a small book (few winners)
      for (const mode of ["IDEAL", "REALISTIC", "CONSERVATIVE"] as ModeName[]) for (const seed of [1, 2, 3]) {
        const { inp, ids } = randomPortfolio(mode, ++ns, seed * 97 + ns, seed === 2 ? { drift: 0.9 } : seed === 3 ? { lots: 30 } : {}); await load(c, inp, ids);
        // executions of this mode after (and before) the watermark, for pendingAhead
        for (const [i, id] of ids.slice(0, 40).entries()) await c.query("insert into paper_executions (signal_id, mode, kind, config_hash, status, state, fill_ts) values ($1,$2,'NEW_POSITION','h','FILLED','OPEN',$3) on conflict do nothing", [id, mode, iso(B + 40 * DAY + i * 6 * 3600)]);
        const sql = await sqlReport(inp.portfolio!.id);
        inp.executionFillTs = (await c.query("select fill_ts from paper_executions where mode = $1 and fill_ts is not null", [mode])).rows.map((r) => r.fill_ts);
        const js = buildPortfolioReport({ ...inp, now: sql.asOf.generatedAt });
        expect(same(sql, JSON.parse(JSON.stringify(js))), `${mode}/${seed}`).toBeNull();
        // non-trivial: every branch has data
        if (seed !== 3) { expect(js!.lots.byState.PARTIALLY_EXITED * js!.lots.byState.EXITED * js!.lots.byState.RESOLVED * js!.lots.byState.OPEN).toBeGreaterThan(0); expect(js!.lots.lockedUnresolved.count).toBeGreaterThan(0); }
        else expect(inp.lots.filter((l) => ["EXITED", "RESOLVED"].includes(l.state) && Number(l.realized_pnl) > 0).length).toBeLessThan(10);     // ex-best-10 reaches losses
        if (seed === 2) expect(js!.risk.peakEquity).toBe(1000);                                                                              // never above the start
        expect(js!.pnl.marketValue.lotsWithoutMark.count).toBeGreaterThan(0); expect(js!.health.pendingAhead).toBeGreaterThan(0);
        expect(inp.decisions.some((x) => Date.parse(x.event_ts) / 1000 > js!.asOf.ts!)).toBe(true);
        expect(js!.exposure.topMarkets.map((x) => x.conditionId)).toEqual(["cU", "cV", "cW", "cX", "cY", "cZ", "cu", "cv", "cw", "cx"]); // the tie decides the cut
      }
      const empty = base("IDEAL", null); empty.portfolio!.id = "rep-empty-ideal"; await load(c, empty, []);
      const sql = await sqlReport("rep-empty-ideal");
      empty.executionFillTs = (await c.query("select fill_ts from paper_executions where mode = 'IDEAL' and fill_ts is not null")).rows.map((r) => r.fill_ts);
      expect(same(sql, JSON.parse(JSON.stringify(buildPortfolioReport({ ...empty, now: sql.asOf.generatedAt }))))).toBeNull();
      expect(await sqlReport("no-such-portfolio")).toBeNull();
      // the wrapper and the in-transaction adapter return the same object
      expect(same(await portfolioReport(pgDb(c) as never, "rep-empty-ideal").then((r) => ({ ...r!, asOf: { ...r!.asOf, generatedAt: 0 } })), { ...sql, asOf: { ...sql.asOf, generatedAt: 0 } })).toBeNull();
    } finally { await c.query("rollback"); await c.end(); }
  }, 120_000);

  it("R10 (test 12): countAndDelete counts more than 1,000 rows exactly through a 1,000-row-capped client — dry run and real", async () => {
    await connect();
    try {
      await c.query("begin");
      await c.query("insert into portfolios (id, mode, exec_config_hash, config, config_hash, start_ts) values ('rep-r10-0001','REALISTIC','e','{}','c',$1)", [iso(B)]);
      await c.query("insert into portfolio_equity (portfolio_id, ts, seq, cash, exposure, equity) select 'rep-r10-0001', to_timestamp($1 + g * 60), 0, 1, 0, 1 from generate_series(1, 1500) g", [B]);
      const db = pgDb(c, { maxRows: 1000 }); const where = (q: any) => q.gt("ts", iso(B + 100 * 60));
      expect((await (db.from("portfolio_equity").select("ts").eq("portfolio_id", "rep-r10-0001") as any)).data.length).toBe(1000); // the cap is real
      expect(await countAndDelete(db as never, "portfolio_equity", "rep-r10-0001", where, true)).toBe(1400);
      expect((await c.query("select count(*)::int n from portfolio_equity where portfolio_id = 'rep-r10-0001'")).rows[0].n).toBe(1500);
      expect(await countAndDelete(db as never, "portfolio_equity", "rep-r10-0001", where, false)).toBe(1400);
      expect((await c.query("select count(*)::int n from portfolio_equity where portfolio_id = 'rep-r10-0001'")).rows[0].n).toBe(100);
      expect(await countAndDelete(db as never, "portfolio_equity", "rep-r10-0001", where, false)).toBe(0);
    } finally { await c.query("rollback"); await c.end(); }
  });

  it("R13: on 100,000 decisions the plan uses the portfolio indexes; paper_executions and paper_marks are never scanned sequentially", async () => {
    await connect();
    try {
      await c.query("begin");
      const pid = "rep-plan-0001"; await c.query("insert into portfolios (id, mode, exec_config_hash, config, config_hash, start_ts) values ($1,'REALISTIC','e','{\"startingCapitalUsd\":1000}','c',$2)", [pid, iso(B)]);
      await c.query("insert into portfolio_runs (portfolio_id, last_watermark_ts, stats) values ($1, $2, '{}')", [pid, iso(B + 30 * DAY)]);
      await c.query("insert into signals (id, kind, severity, wallet, condition_id, token_id, dedupe_key) select ('2f000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'NEW_POSITION', 2, 'w', 'c', 't' || g, 'plan:' || g from generate_series(1, 100000) g");
      await c.query("insert into paper_ledger (signal_id, entry_price) select ('2f000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 0.5 from generate_series(1, 100000) g");
      await c.query(`insert into portfolio_decisions (portfolio_id, signal_id, kind, source_key, event_ts, outcome, reason, requested_usd, filled_usd, filled_shares, fill_price, fee, input_hash, record_hash)
        select $1, ('2f000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'NEW_POSITION', 'k' || g, to_timestamp($2 + g * 20), case when g % 5 = 0 then 'FILLED' else 'REJECTED' end, case when g % 5 = 0 then null else 'REJECTED_MAX_OPEN_POSITIONS' end, 100, case when g % 5 = 0 then 100 else 0 end, case when g % 5 = 0 then 200 else 0 end, case when g % 5 = 0 then 0.5 end, 0, 'i', 'r' from generate_series(1, 100000) g`, [pid, B]);
      await c.query(`insert into portfolio_lots (portfolio_id, signal_id, wallet, token_id, condition_id, opened_ts, shares_filled, cost_usd, shares_open, cost_open, state, closed_ts, realized_pnl, record_hash)
        select $1, ('2f000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'w' || (g % 50), 't' || g, 'c' || (g % 300), to_timestamp($2 + g * 20), 200, 100, case when g % 3 = 0 then 200 else 0 end, case when g % 3 = 0 then 100 else 0 end, case when g % 3 = 0 then 'OPEN' else 'EXITED' end, case when g % 3 = 0 then null else to_timestamp($2 + g * 20 + 3600) end, 1, 'r' from generate_series(5, 100000, 5) g`, [pid, B]);
      await c.query("insert into paper_marks (signal_id, horizon, observed_at, price, pnl, return_pct, source) select ('2f000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '1h', to_timestamp($1 + g * 20 + 3600), 0.6, 0, 0, 't' from generate_series(1, 100000) g", [B]);
      await c.query("insert into paper_executions (signal_id, mode, kind, config_hash, status, state, fill_ts) select ('2f000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'REALISTIC', 'NEW_POSITION', 'h', 'FILLED', 'OPEN', to_timestamp($1 + g * 20) from generate_series(1, 100000) g", [B]);
      await c.query("analyze portfolio_decisions; analyze portfolio_lots; analyze portfolio_equity; analyze paper_marks; analyze paper_executions; analyze portfolios; analyze portfolio_runs");
      const body = readFileSync(path.join(MIG, "0010_portfolio_report.sql"), "utf8").match(/function portfolio_report\(p_portfolio_id text\) returns jsonb language sql stable as \$\$([\s\S]*?)\$\$;/)![1].replaceAll("p_portfolio_id", `'${pid}'`);
      const plan = JSON.stringify((await c.query(`explain (format json) ${body}`)).rows[0]["QUERY PLAN"]);
      const seq = [...plan.matchAll(/"Node Type":"Seq Scan"[^}]*?"Relation Name":"([^"]+)"/g)].map((m) => m[1]);
      expect(seq).not.toContain("paper_executions"); expect(seq).not.toContain("paper_marks"); expect(plan).toMatch(/paper_marks_pkey/);
      // pendingAhead runs as portfolio_pending_ahead's EXECUTE, planned with the values: the index, not the table
      const pend = JSON.stringify((await c.query(`explain (format json) select count(*) from paper_executions where mode = 'REALISTIC' and fill_ts > '${iso(B + 30 * DAY)}'`)).rows[0]["QUERY PLAN"]);
      expect(pend).toMatch(/paper_executions_mode_fill_idx/); expect(pend).not.toMatch(/Seq Scan/);
      expect(body).toMatch(/portfolio_pending_ahead\(/); expect(body).not.toMatch(/from paper_executions/);
      if (process.env.PLAN_OUT) require("node:fs").writeFileSync(process.env.PLAN_OUT, JSON.stringify((await c.query(`explain (analyze, format json) ${body}`)).rows[0]["QUERY PLAN"], null, 1));
      const t0 = Date.now(); const r = await sqlReport(pid); const ms = Date.now() - t0;
      expect(r.decisions.total).toBe(100000); expect(r.lots.total).toBe(20000); expect(r.pnl.marketValue.lotsWithoutMark.count).toBe(0); expect(ms).toBeLessThan(10_000);
    } finally { await c.query("rollback"); await c.end(); }
  }, 180_000);

  it("test 15: migrations 0001–0010 applied to an empty database (above); 0010 re-runs cleanly", async () => {
    await connect();
    try {
      const files = readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort(); expect(files.slice(0, 10).map((f) => f.slice(0, 4))).toEqual(["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010"]);
      await c.query(readFileSync(path.join(MIG, "0010_portfolio_report.sql"), "utf8")); await c.query(readFileSync(path.join(MIG, "0010_portfolio_report.sql"), "utf8"));
      expect((await c.query("select portfolio_report('none') as r")).rows[0].r).toBeNull();
      expect((await c.query("select proname, provolatile, prolang = (select oid from pg_language where lanname = 'sql') as is_sql from pg_proc where proname in ('portfolio_report','portfolio_pending_ahead') order by proname")).rows)
        .toEqual([{ proname: "portfolio_pending_ahead", provolatile: "s", is_sql: false }, { proname: "portfolio_report", provolatile: "s", is_sql: true }]);
    } finally { await c.end(); }
  });
});
