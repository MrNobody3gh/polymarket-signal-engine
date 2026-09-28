/** Phase 3 — portfolio / risk layer (docs/PHASE3_PLAN.md). Step 3: orphan resolver (D3). */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeDb } from "./helpers/fakeDb";
import { stressDb } from "./helpers/stressDb";
import { orphanOutcome, resolveOrphans, _resetOrphanGuard, type OrphanCandidate } from "@/lib/paper/resolve-orphans";
import { sweepSimulation, simulateMode, buildSignals, neededObservations, type SimInputs } from "@/lib/paper/sim/run";
import { MODES } from "@/lib/paper/sim/config";
import { recompute, reproductionError, type ExecRecordLite } from "@/lib/paper/orphan-impact";
import { ensureTokenOrder } from "@/lib/polymarket/token-order";
import type { MarkSource, Resolution } from "@/lib/paper/mark";

const T0 = 1_790_000_000; const iso = (s: number) => new Date(s * 1000).toISOString();
const cand = (token: string, o: Partial<OrphanCandidate> = {}): OrphanCandidate => ({ token_id: token, condition_id: `0xC-${token}`, outcome: "Yes", open_lots: 1, frozen_lots: 0, oldest_fill_ts: iso(T0), last_checked_at: null, ...o });
/** fakeDb plus the candidate RPC (the SQL function itself is tested against real Postgres in tests/sql.test.ts). */
function dbWith(cands: OrphanCandidate[] | (() => OrphanCandidate[]), rpcError?: string) {
  const db = fakeDb(); const calls: unknown[] = [];
  const rpc = async (name: string, args: unknown) => { calls.push({ name, args }); if (rpcError) return { data: null, error: { message: rpcError } }; return { data: typeof cands === "function" ? cands() : cands, error: null }; };
  return { db: { ...db, rpc } as never, raw: db, calls };
}
function source(answers: Record<string, Resolution | Error>) {
  const outcomes = new Map<string, string>();
  const src = { priceAsOf: async () => null, prefetch: vi.fn(async (_conditionIds: string[]) => {}), resolution: vi.fn(async (_c: string, token: string) => { const a = answers[token]; if (a instanceof Error) throw a; return a ?? { state: "unknown", reason: "resolution_not_found" }; }), _outcomes: outcomes };
  return { src: src as unknown as MarkSource, spy: src, outcomes };
}

describe("orphanOutcome: what one answer means (never fabricates a resolution or its time)", () => {
  const c = { token_id: "t", condition_id: "0xABC" }; const now = T0 + 86_400;
  it("resolved with an on-chain time → an observation at that time, condition id lower-cased", () => {
    expect(orphanOutcome(c, { state: "resolved", won: true, finalPrice: 1, source: "v2-resolutions", resolvedAt: T0 }, now))
      .toEqual({ state: "RESOLVED", reason: null, obs: { token_id: "t", condition_id: "0xabc", value: 1, resolved_ts: iso(T0), source: "v2-resolutions" } });
    expect(orphanOutcome(c, { state: "resolved", won: true, finalPrice: 0.5, source: "v2-resolutions", resolvedAt: T0 }, now).obs?.value).toBe(0.5); // 50/50 payout kept as is
  });
  it("resolved without a time (e.g. Gamma fallback) → NO_RESOLVED_TIME, no observation (D2 needs the on-chain instant)", () => {
    for (const resolvedAt of [undefined, null, 0, Number.NaN]) expect(orphanOutcome(c, { state: "resolved", won: false, finalPrice: 0, source: "gamma", resolvedAt: resolvedAt as never }, now)).toMatchObject({ state: "NO_RESOLVED_TIME", obs: null });
  });
  it("open, unknown, out-of-range payouts and future resolution times are recorded but never written as resolutions", () => {
    expect(orphanOutcome(c, { state: "open" }, now)).toEqual({ state: "OPEN", reason: null, obs: null });
    expect(orphanOutcome(c, { state: "unknown", reason: "resolution_token_index_unknown" }, now)).toEqual({ state: "UNKNOWN", reason: "resolution_token_index_unknown", obs: null });
    expect(orphanOutcome(c, { state: "resolved", won: true, finalPrice: 1.2, source: "x", resolvedAt: T0 }, now)).toMatchObject({ state: "UNKNOWN", reason: "resolution_value_out_of_range", obs: null });
    expect(orphanOutcome(c, { state: "resolved", won: true, finalPrice: 1, source: "x", resolvedAt: now + 3600 }, now)).toMatchObject({ state: "UNKNOWN", reason: "resolved_at_in_future", obs: null });
  });
});

describe("resolveOrphans", () => {
  beforeEach(() => _resetOrphanGuard());
  const answers = () => ({
    tRes: { state: "resolved", won: true, finalPrice: 1, source: "v2-resolutions", resolvedAt: T0 } as Resolution,
    tOpen: { state: "open" } as Resolution,
    tNoTime: { state: "resolved", won: false, finalPrice: 0, source: "gamma" } as Resolution,
    tUnk: { state: "unknown", reason: "resolution_token_index_unknown" } as Resolution,
    tErr: new Error("503 on /v2/resolutions"),
  });
  const cands = () => [cand("tRes", { outcome: "No" }), cand("tOpen"), cand("tNoTime", { condition_id: "0xC-tRes" }), cand("tUnk", { frozen_lots: 2, open_lots: 2 }), cand("tErr")];

  it("asks once per token with one batched prefetch, writes only real resolutions, and records every answer", async () => {
    const { db, raw, calls } = dbWith(cands()); const { src, spy, outcomes } = source(answers());
    const r = await resolveOrphans(db, src, { now: T0 + 86_400, limit: 50, recheckSec: 3600 });
    expect(calls).toEqual([{ name: "orphan_resolution_candidates", args: { p_limit: 50, p_recheck_sec: 3600 } }]);
    expect(spy.prefetch).toHaveBeenCalledTimes(1); expect(spy.prefetch.mock.calls[0][0]).toEqual(["0xC-tRes", "0xC-tOpen", "0xC-tUnk", "0xC-tErr"]); // unique conditions
    expect(outcomes.get("tRes")).toBe("No");                                                                              // Yes/No fallback label
    expect(r).toMatchObject({ candidates: 5, resolved: 1, open: 1, noTime: 1, unknown: 2, failed: 1, frozenLots: 2 });
    expect(raw.T("token_resolution_obs")).toEqual([{ token_id: "tRes", condition_id: "0xc-tres", value: 1, resolved_ts: iso(T0), source: "v2-resolutions" }]);
    const checks = Object.fromEntries(raw.T("token_resolution_checks").map((c) => [c.token_id, c]));
    expect(Object.keys(checks).sort()).toEqual(["tErr", "tNoTime", "tOpen", "tRes", "tUnk"]);
    expect(checks.tRes).toMatchObject({ last_state: "RESOLVED", checks: 1, last_checked_at: iso(T0 + 86_400) });
    expect(checks.tErr).toMatchObject({ last_state: "UNKNOWN" }); expect(checks.tErr.last_reason).toMatch(/lookup_failed: 503/);
    expect(checks.tNoTime).toMatchObject({ last_state: "NO_RESOLVED_TIME" });
    // data-quality: the unexplained answers are logged, a transient lookup failure is not
    expect(raw.T("data_quality_issues").map((i) => [i.kind, i.ref_id]).sort()).toEqual([["missing_resolution", "tNoTime"], ["resolution_unparseable", "tUnk"]]);
  });

  it("re-asking keeps the first observation (a disagreement is left for token_resolution_conflicts) and counts checks", async () => {
    const { db, raw } = dbWith(() => [cand("tRes", { last_checked_at: iso(T0) })]);
    await resolveOrphans(db, source({ tRes: { state: "resolved", won: true, finalPrice: 1, source: "v2-resolutions", resolvedAt: T0 } }).src, { now: T0 + 100 });
    await resolveOrphans(db, source({ tRes: { state: "resolved", won: false, finalPrice: 0, source: "gamma", resolvedAt: T0 + 5 } }).src, { now: T0 + 200 });
    expect(raw.T("token_resolution_obs")).toHaveLength(1); expect(raw.T("token_resolution_obs")[0]).toMatchObject({ value: 1, resolved_ts: iso(T0) });
    expect(raw.T("token_resolution_checks")[0]).toMatchObject({ checks: 2, last_checked_at: iso(T0 + 200) });
  });

  it("no candidates → no API calls; a candidate-query error throws and releases the overlap guard", async () => {
    const { src, spy } = source({});
    expect(await resolveOrphans(dbWith([]).db, src)).toMatchObject({ candidates: 0 }); expect(spy.prefetch).not.toHaveBeenCalled();
    await expect(resolveOrphans(dbWith([], "permission denied").db, src)).rejects.toThrow(/orphan_resolution_candidates failed: permission denied/);
    expect((await resolveOrphans(dbWith([]).db, src)).skipped).toBeUndefined();
  });

  it("refuses to overlap a run still in progress", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const slow = { ...source({}).src, resolution: async () => { await gate; return { state: "open" } as Resolution; } } as MarkSource;
    const first = resolveOrphans(dbWith([cand("t1")]).db, slow);
    await new Promise((r) => setTimeout(r, 0));
    expect(await resolveOrphans(dbWith([cand("t2")]).db, slow)).toMatchObject({ skipped: true });
    release(); expect(await first).toMatchObject({ open: 1 });
  });
});

describe("end to end: an orphaned position is settled by the unchanged Phase 2 sweep once its token resolves", () => {
  // A wallet buys at T0 and exits at T0+20. We detect at T0+30, so REALISTIC fills at T0+40 and CONSERVATIVE at T0+105:
  // both after the wallet's EXIT, which the lifecycle therefore ignores. The ledger row is EXITED (the marker never
  // looks at it again), so without a resolver these positions stay OPEN for ever.
  const E = "00000000-0000-4000-8000-00000000e001", X = "00000000-0000-4000-8000-00000000e002", F = "00000000-0000-4000-8000-00000000f001";
  function world() {
    const db = stressDb();
    db.insertRow("signals", { id: E, kind: "NEW_POSITION", wallet: "w1", condition_id: "c1", token_id: "tok1", price: 0.4, usd: 5000, created_at: iso(T0), evaluated_at: iso(T0 + 30) });
    db.insertRow("signals", { id: X, kind: "EXIT", wallet: "w1", condition_id: "c1", token_id: "tok1", price: 0.45, usd: 5000, created_at: iso(T0 + 20), evaluated_at: iso(T0 + 25) });
    db.insertRow("paper_ledger", { signal_id: E, created_at: iso(T0 + 30), sim_terminal: false, side: "LONG" });
    db.insertRow("paper_ledger", { signal_id: X, created_at: iso(T0 + 25), sim_terminal: true, side: "EXIT_EVENT" });
    // The frozen case (no ledger row, from 18–20 Sep): its stored record is never revisited by the sweep.
    db.insertRow("signals", { id: F, kind: "NEW_POSITION", wallet: "w2", condition_id: "c1", token_id: "tok1", price: 0.4, usd: 900, created_at: iso(T0), evaluated_at: null });
    db.insertRow("paper_executions", { signal_id: F, mode: "REALISTIC", state: "OPEN", coverage_state: "SIMULATED", net_pnl: -1.5, record_hash: "frozen" });
    return db;
  }
  const rec = (db: ReturnType<typeof stressDb>, id: string, mode: string) => db.T("paper_executions").find((r) => r.signal_id === id && r.mode === mode)!;

  it("OPEN for ever without a resolution; RESOLVED with the correct payout once the resolver's answer is visible", async () => {
    const db = world();
    await sweepSimulation(db as never); // enqueues the prices REALISTIC / CONSERVATIVE need
    for (const r of db.T("price_observations")) Object.assign(r, { state: "COMPLETE", obs_ts: r.as_of - 60, price: 0.42, resolution_seconds: 60 });
    await sweepSimulation(db as never);
    expect(rec(db, E, "IDEAL").state).toBe("EXITED");                  // IDEAL fills at T0, before the exit
    for (const m of ["REALISTIC", "CONSERVATIVE"]) { expect(rec(db, E, m).state).toBe("OPEN"); expect(rec(db, E, m).exit_status).toBeNull(); }
    expect(db.T("paper_ledger").find((l) => l.signal_id === E)!.sim_terminal).toBe(false);
    const again = await sweepSimulation(db as never); expect(again.written).toBe(0); // …and nothing would ever change it

    // The resolver finds the market resolved YES at T0 + 1 day and records it.
    const withRpc = { ...db, rpc: async () => ({ data: [cand("tok1", { condition_id: "c1", open_lots: 3, frozen_lots: 1 })], error: null }) };
    const r = await resolveOrphans(withRpc as never, source({ tok1: { state: "resolved", won: true, finalPrice: 1, source: "v2-resolutions", resolvedAt: T0 + 86_400 } }).src, { now: T0 + 2 * 86_400 });
    expect(r).toMatchObject({ resolved: 1, frozenLots: 1 });
    // In Postgres the token_resolutions view unions token_resolution_obs (tests/sql.test.ts); the in-memory DB has no views.
    for (const o of db.T("token_resolution_obs")) db.insertRow("token_resolutions", { token_id: o.token_id, value: o.value, resolved_ts: o.resolved_ts });

    const s = await sweepSimulation(db as never);
    expect(s.newlyTerminal).toBe(1); expect(db.T("paper_ledger").find((l) => l.signal_id === E)!.sim_terminal).toBe(true);
    for (const m of ["REALISTIC", "CONSERVATIVE"]) {
      const x = rec(db, E, m);
      expect(x.state).toBe("RESOLVED"); expect(x.resolution_ts).toBe(iso(T0 + 86_400)); expect(x.resolution_value).toBe(1); expect(x.open_shares).toBe(0);
      expect(x.realized_pnl).toBeCloseTo(x.filled_shares * 1 - x.filled_usd - x.fees_total, 9); expect(x.unrealized_pnl).toBe(0); expect(x.closed_at).toBe(iso(T0 + 86_400));
    }
    expect(rec(db, F, "REALISTIC")).toMatchObject({ state: "OPEN", record_hash: "frozen", net_pnl: -1.5 }); // frozen record untouched
  });
});

describe("impact report arithmetic equals the real Phase 2 simulator", () => {
  // Random positions: entries with and without an exit (fully filled, partly filled by the liquidity cap, unfilled, no
  // price), resolutions before our fill, between fill and exit, at the exit, after it, or none; with and without marks.
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  function scenario(nSignals: number) {
    const inp: SimInputs = { signals: [], ledger: new Map(), marks: new Map(), resolutions: new Map(), markets: new Map(), obs: new Map() };
    const res = new Map<string, { ts: number; value: number }>();
    for (let i = 0; i < nSignals; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`; const tok = `t${i}`; const src = T0 + i * 1000; const ev = src + 5 + Math.floor(rnd() * 120);
      inp.signals.push({ id, kind: "NEW_POSITION", wallet: `w${i}`, condition_id: `c${i}`, token_id: tok, price: 0.2 + rnd() * 0.6, usd: 50 + rnd() * 5000, created_at: iso(src), evaluated_at: iso(ev) });
      inp.ledger.set(id, { signal_id: id, created_at: iso(ev) });
      if (rnd() < 0.7) { const xid = `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`; const xs = src + 50 + Math.floor(rnd() * 3000);
        inp.signals.push({ id: xid, kind: "EXIT", wallet: `w${i}`, condition_id: `c${i}`, token_id: tok, price: 0.1 + rnd() * 0.8, usd: rnd() < 0.4 ? 5 + rnd() * 60 : 500 + rnd() * 5000, created_at: iso(xs), evaluated_at: iso(xs + 3 + Math.floor(rnd() * 30)) }); }
      if (rnd() < 0.5) inp.markets.set(`c${i}`, { feesEnabled: rnd() < 0.5, takerFeeRate: rnd() < 0.5 ? 0.02 : null, tickSize: 0.01, minOrderShares: rnd() < 0.3 ? 400 : 5 });
      if (rnd() < 0.6) inp.marks.set(id, { ts: src + 3600, price: 0.05 + rnd() * 0.9 });
      const u = rnd(); const value = u < 0.45 ? 1 : u < 0.9 ? 0 : 0.5;
      const when = rnd(); const rts = when < 0.1 ? src - 100 : when < 0.3 ? src + 200 : when < 0.45 ? src + 1500 : src + 86_400; // before fill / mid / around exit / later
      res.set(tok, { ts: rts, value });
    }
    const built = buildSignals(inp);
    for (const n of neededObservations(built, inp, [MODES.REALISTIC, MODES.CONSERVATIVE])) inp.obs.set(`${n.tokenId}@${n.asOf}`, rnd() < 0.1 ? null : { ts: n.asOf - 1 - Math.floor(rnd() * 500), price: 0.02 + rnd() * 0.96, resolutionSeconds: 0 });
    return { inp, res };
  }
  it("recompute(before, null) reproduces every stored record, and recompute(before, resolution) equals the re-simulated record", () => {
    const { inp, res } = scenario(400); let checked = 0, incomplete = 0; const states = new Set<string>(); let voided = 0, ignored = 0;
    for (const cfg of [MODES.IDEAL, MODES.REALISTIC, MODES.CONSERVATIVE]) {
      const before = simulateMode(buildSignals(inp), inp, cfg).records as unknown as (ExecRecordLite & { coverage_state: string })[];
      const withRes: SimInputs = { ...inp, resolutions: res };
      const after = new Map((simulateMode(buildSignals(withRes), withRes, cfg).records as unknown as (ExecRecordLite & { coverage_state: string })[]).map((r) => [r.signal_id, r]));
      for (const b of before) {
        if (b.coverage_state !== "SIMULATED") continue;
        expect(reproductionError(b)).toBeLessThan(1e-9);
        const tok = inp.signals.find((s) => s.id === b.signal_id)!.token_id as string; const got = recompute(b, res.get(tok)!); const want = after.get(b.signal_id)!;
        expect(got.state).toBe(want.state); expect(Math.abs(got.openShares - Number(want.open_shares))).toBeLessThan(1e-9);
        if (got.incomplete) { incomplete++; continue; } // P&L needs a mark the closed record never stored: flagged, not guessed
        for (const [k, w] of [["netPnl", want.net_pnl], ["realizedPnl", want.realized_pnl], ["unrealizedPnl", want.unrealized_pnl], ["grossPnl", want.gross_pnl], ["openShares", want.open_shares]] as const) expect(Math.abs((got as never as Record<string, number>)[k] - Number(w))).toBeLessThan(1e-9);
        states.add(`${b.state}->${got.state}`); if (got.exitVoided) voided++; if (got.resolutionIgnored) ignored++; checked++;
      }
    }
    // The scenarios must actually exercise the interesting paths, not just one of them.
    expect(checked).toBeGreaterThan(800);
    for (const t of ["OPEN->RESOLVED", "PARTIALLY_EXITED->RESOLVED", "EXITED->EXITED", "OPEN->OPEN"]) expect(states).toContain(t);
    expect(voided).toBeGreaterThan(0); expect(ignored).toBeGreaterThan(0); expect(incomplete).toBeGreaterThan(0); expect(incomplete).toBeLessThan(checked / 10);
  });
});

describe("ensureTokenOrder: finds closed markets and fills the markets cache", () => {
  const C = (n: number) => `0x${String(n).padStart(64, "a")}`;
  const market = (c: string, tokens: string[]) => ({ conditionId: c, clobTokenIds: JSON.stringify(tokens), closed: true, endDateIso: "2026-09-26" });
  /** Gamma stub: `open` markets appear in the default view, `closed` only when closed=true is asked. */
  function gamma(open: Record<string, string[]>, closed: Record<string, string[]>) {
    const calls: { c: string; closed: unknown }[] = [];
    const get = async (_base: string, _path: string, p: Record<string, unknown>) => { const c = String(p.condition_ids); calls.push({ c, closed: p.closed });
      const hit = open[c] ?? (p.closed === true ? closed[c] : undefined); return { markets: hit ? [market(c, hit)] : [] } as never; };
    return { client: { get } as never, calls };
  }
  it("uses the cache, then Gamma's default view, then closed markets; writes what it finds; reports what it cannot", async () => {
    const db = fakeDb(); db.T("markets").push({ condition_id: C(1), clob_token_ids: ["a1", "b1"] });
    const { client, calls } = gamma({ [C(2)]: ["a2", "b2"] }, { [C(3)]: ["a3", "b3"] });
    const r = await ensureTokenOrder(db as never, [C(1), C(2), C(3).toUpperCase().replace("0X", "0x"), C(4), "0xnot-a-condition", ""], { client, now: () => T0 * 1000 });
    expect(r).toMatchObject({ cached: 1, fetched: 2, missing: [C(4)] });
    expect(Object.fromEntries(r.orders)).toEqual({ [C(1)]: ["a1", "b1"], [C(2)]: ["a2", "b2"], [C(3)]: ["a3", "b3"] });
    expect(calls.filter((x) => x.c === C(1))).toHaveLength(0);                                   // cached: no request
    expect(calls.filter((x) => x.c === C(2))).toEqual([{ c: C(2), closed: undefined }]);         // default view is enough
    expect(calls.filter((x) => x.c === C(3))).toEqual([{ c: C(3), closed: undefined }, { c: C(3), closed: true }]); // closed market
    expect(calls.some((x) => x.c.includes("not-a-condition") || x.c === "")).toBe(false);        // malformed ids never sent
    const rows = Object.fromEntries(db.T("markets").map((m) => [m.condition_id, m]));
    expect(rows[C(3)]).toMatchObject({ clob_token_ids: ["a3", "b3"], end_date: "2026-09-26", meta_fetched_at: iso(T0) }); // same row GammaMarketMeta writes
    expect(rows[C(4)]).toBeUndefined();
  });
  it("write: false never writes (read-only reports), and a Gamma error only marks that condition missing", async () => {
    const db = fakeDb(); const { client } = gamma({}, { [C(5)]: ["a5", "b5"] });
    const failing = { get: async (b: string, p: string, q: Record<string, unknown>) => { if (q.condition_ids === C(6)) throw new Error("502"); return (client as any).get(b, p, q); } };
    const r = await ensureTokenOrder(db as never, [C(5), C(6)], { client: failing as never, write: false });
    expect(r).toMatchObject({ fetched: 1, missing: [C(6)] }); expect(db.T("markets")).toHaveLength(0);
  });
});

describe("resolveOrphans: the token-order step", () => {
  beforeEach(() => _resetOrphanGuard());
  it("runs before the resolution lookups with every candidate condition, and a failure there does not stop the run", async () => {
    const order: string[] = []; const { src } = source({ tRes: { state: "resolved", won: true, finalPrice: 1, source: "v2-resolutions", resolvedAt: T0 } });
    (src as any).prefetch = async () => { order.push("prefetch"); };
    const logs: string[] = [];
    const r = await resolveOrphans(dbWith([cand("tRes"), cand("tOpen")]).db, src, { now: T0 + 100, log: (m) => logs.push(m), prepare: async (c) => { order.push(`prepare:${c.join(",")}`); throw new Error("gamma down"); } });
    expect(order).toEqual(["prepare:0xC-tRes,0xC-tOpen", "prefetch"]);
    expect(r).toMatchObject({ candidates: 2, resolved: 1 }); expect(logs.some((l) => /token-order lookup failed: gamma down/.test(l))).toBe(true);
  });
});

// ───────────────────────────── step 4: PortfolioBook ─────────────────────────────
import { PortfolioBook, entryKey, cmpKey, emptyState, TAKEN_WINDOW_SEC } from "@/lib/paper/portfolio/book";
import { simulatePortfolio, type PortfolioSignal } from "@/lib/paper/sim/portfolio";
import type { PortfolioConfig } from "@/lib/paper/sim/config";
import type { BookSignal, BookOutput } from "@/lib/paper/portfolio/types";

describe("PortfolioBook", () => {
  const PCS: Record<string, PortfolioConfig> = {
    roomy: { startingCapitalUsd: 100_000, positionUsd: 100, maxMarketExposureUsd: 10_000, maxTotalExposurePct: 100, maxOpenPositions: 1000, maxWalletAllocationUsd: 10_000, minCashReserveUsd: 0, allowResize: false },
    tight: { startingCapitalUsd: 1_000, positionUsd: 100, maxMarketExposureUsd: 150, maxTotalExposurePct: 60, maxOpenPositions: 8, maxWalletAllocationUsd: 250, minCashReserveUsd: 50, allowResize: false },
    exposureBound: { startingCapitalUsd: 2_000, positionUsd: 100, maxMarketExposureUsd: 10_000, maxTotalExposurePct: 30, maxOpenPositions: 100, maxWalletAllocationUsd: 10_000, minCashReserveUsd: 0, allowResize: false },
    cashBound: { startingCapitalUsd: 500, positionUsd: 100, maxMarketExposureUsd: 10_000, maxTotalExposurePct: 100, maxOpenPositions: 50, maxWalletAllocationUsd: 10_000, minCashReserveUsd: 120, allowResize: true },
    resize: { startingCapitalUsd: 1_000, positionUsd: 100, maxMarketExposureUsd: 150, maxTotalExposurePct: 60, maxOpenPositions: 8, maxWalletAllocationUsd: 250, minCashReserveUsd: 50, allowResize: true },
  };
  let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  /** Random history: bursts in the same second, duplicate source trades, exits, resolutions, marks, missing prices. */
  function history(n: number, o: { exitsAfter?: number; resolutionsAfter?: number } = {}): BookSignal[] {
    const out: BookSignal[] = [];
    for (let i = 0; i < n; i++) {
      const id = `s${String(i).padStart(5, "0")}`; const src = T0 + Math.floor(i / 3) * 40; const ev = src + 3 + Math.floor(rnd() * 60);
      const price = 0.05 + rnd() * 0.9; const obs = rnd() < 0.08 ? null : { ts: ev - Math.floor(rnd() * 30), price: Math.min(0.99, Math.max(0.01, price + (rnd() - 0.5) * 0.05)), resolutionSeconds: 0 };
      const market = rnd() < 0.5 ? null : { feesEnabled: rnd() < 0.5, takerFeeRate: rnd() < 0.5 ? 0.02 : null, tickSize: 0.01, minOrderShares: rnd() < 0.2 ? 300 : 5 };
      const dup = i > 0 && rnd() < 0.12 ? out[i - 1] : null; // NEW_POSITION + CONSENSUS on one fill
      const xs = Math.max(o.exitsAfter ?? 0, src + 30 + Math.floor(rnd() * 4000));
      const exit = rnd() < 0.5 ? { triggerTs: xs, triggerEvalTs: xs + 5, triggerPrice: 0.05 + rnd() * 0.9, triggerUsd: rnd() < 0.3 ? 10 + rnd() * 40 : 500 + rnd() * 2000, obs: rnd() < 0.1 ? null : { ts: xs, price: 0.05 + rnd() * 0.9, resolutionSeconds: 0 }, market } : null;
      const rts = Math.max(o.resolutionsAfter ?? 0, src + pick([-50, 300, 2000, 9000]));
      out.push({ signalId: id, kind: dup ? "CONSENSUS" : pick(["NEW_POSITION", "NEW_POSITION", "CONVICTION_ADD", "EARLY_ENTRY", "CONSENSUS"]), wallet: `w${Math.floor(rnd() * 6)}`, conditionId: `c${Math.floor(rnd() * 5)}`, tokenId: `t${i}`,
        sourceKey: dup ? dup.sourceKey : `k${i}`, exitId: exit ? `x${i}` : null,
        entry: dup ? { ...dup.entry } : { sourceTs: src, evalTs: ev, signalPrice: price, sourceUsd: 50 + rnd() * 3000, obs, market },
        exit, resolution: rnd() < 0.6 ? { ts: rts, value: pick([0, 1, 1, 0.5]) } : null, mark: rnd() < 0.5 ? { ts: src + 3600, price: rnd() } : null });
    }
    return out;
  }
  const ordered = (sigs: BookSignal[], exec: typeof MODES.IDEAL) => [...sigs].sort((a, b) => cmpKey(entryKey(a, exec), entryKey(b, exec)));
  function runBook(sigs: BookSignal[], exec: typeof MODES.IDEAL, pc: PortfolioConfig) {
    const book = new PortfolioBook(exec, pc); for (const s of ordered(sigs, exec)) book.submit(s); book.advance(null);
    return { book, out: book.take() };
  }
  const seen = new Set<string>(); // every outcome/reason produced across the parity runs
  const ref = (out: BookOutput) => out.decisions.map((d) => ({ signalId: d.signalId, kind: d.kind, outcome: d.outcome, reason: d.reason, requestedUsd: d.requestedUsd, filledUsd: d.filledUsd, ts: d.ts }));

  for (const mode of ["IDEAL", "REALISTIC", "CONSERVATIVE"] as const) for (const pcName of Object.keys(PCS)) {
    it(`equals simulatePortfolio exactly — ${mode}, ${pcName} limits`, () => {
      seed = [...`${mode}/${pcName}`].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 2 ** 31, 7); // own fixed history per run
      const sigs = history(300); const exec = MODES[mode]; const pc = PCS[pcName];
      const want = simulatePortfolio(sigs as PortfolioSignal[], exec, pc); const { book, out } = runBook(sigs, exec, pc);
      expect(ref(out)).toEqual(want.decisions); expect(out.equity).toEqual(want.curve);
      const { decisions: _d, curve: _c, ...totals } = want; expect(book.summary()).toEqual(totals);
      // …and the histories are not trivial: fills, rejections for several reasons, exits, resolutions all happen
      const reasons = new Set(out.decisions.map((d) => d.reason?.replace(/:.*/, "") ?? d.outcome));
      expect(out.decisions.filter((d) => d.filledShares > 0).length).toBeGreaterThan(pcName === "roomy" ? 100 : 5);
      for (const r of reasons) seen.add(r);
      for (const l of out.lots) seen.add(`lot:${l.state}`);
    });
  }

  it("the parity runs above exercised every rejection reason, the non-fill outcomes and every lot state", () => {
    for (const r of ["REJECTED_DUPLICATE_POSITION", "REJECTED_MAX_OPEN_POSITIONS", "REJECTED_MAX_WALLET_ALLOCATION", "REJECTED_MAX_MARKET_EXPOSURE", "REJECTED_INSUFFICIENT_CASH", "REJECTED_MAX_PORTFOLIO_EXPOSURE", "RESIZED", "NO_PRICE_OBSERVATION", "INSUFFICIENT_LIQUIDITY", "lot:OPEN", "lot:PARTIALLY_EXITED", "lot:EXITED", "lot:RESOLVED"]) expect(seen, r).toContain(r);
  });

  it("stopping at any event, checkpointing through JSON, and resuming gives the uninterrupted result", () => {
    const sigs = ordered(history(80), MODES.REALISTIC); const pc = PCS.resize; const exec = MODES.REALISTIC;
    const whole = runBook(sigs, exec, pc);
    for (let k = 0; k <= sigs.length; k++) {
      const a = new PortfolioBook(exec, pc); for (const s of sigs.slice(0, k)) a.submit(s);
      const first = a.take(); const state = JSON.parse(JSON.stringify(a.snapshot()));
      const b = new PortfolioBook(exec, pc, state); for (const s of sigs.slice(k)) b.submit(s); b.advance(null); const second = b.take();
      expect({ d: [...first.decisions, ...second.decisions], e: [...first.equity, ...second.equity], l: [...first.lots, ...second.lots] }).toEqual({ d: whole.out.decisions, e: whole.out.equity, l: whole.out.lots });
      expect(b.summary()).toEqual(whole.book.summary());
    }
  });

  it("refuses entries out of event order; ties in one second resolve by kind, then id, never by arrival", () => {
    const sigs = ordered(history(20), MODES.IDEAL); const book = new PortfolioBook(MODES.IDEAL, PCS.roomy);
    book.submit(sigs[5]); expect(() => book.submit(sigs[2])).toThrow(/out of order/); expect(() => book.submit(sigs[5])).toThrow(/out of order/);
    const same = history(6).map((s, i) => ({ ...s, sourceKey: `u${i}`, entry: { ...s.entry, sourceTs: T0, evalTs: T0 + 5 } }));
    const keys = ordered(same, MODES.REALISTIC).map((s) => [entryKey(s, MODES.REALISTIC).order, s.signalId]);
    expect(keys).toEqual([...keys].sort((a, b) => (a[0] as number) - (b[0] as number) || String(a[1]).localeCompare(String(b[1]))));
  });

  it("state stays bounded: open lots within maxOpenPositions, pending events at most two per open lot, old source keys forgotten", () => {
    const sigs = ordered(history(400), MODES.REALISTIC); const book = new PortfolioBook(MODES.REALISTIC, PCS.tight);
    for (const s of sigs) { book.submit(s); const st = book.snapshot(); expect(st.lots.length).toBeLessThanOrEqual(PCS.tight.maxOpenPositions); expect(st.heap.length).toBeLessThanOrEqual(2 * st.lots.length); }
    const st = book.snapshot(); expect(st.taken.every(([, t]) => t >= st.last!.ts - TAKEN_WINDOW_SEC)).toBe(true);
    expect(emptyState(PCS.tight)).toMatchObject({ cash: 1000, lots: [], heap: [], last: null });
  });

  it("a duplicate source trade is still rejected after a checkpoint, and forgotten once it is older than the window", () => {
    const [a0] = history(1); const a = { ...a0, sourceKey: "same", exit: null, resolution: null };
    const b = { ...a, signalId: "s99999", kind: "CONSENSUS" };
    const book = new PortfolioBook(MODES.IDEAL, PCS.roomy); book.submit(a);
    const restored = new PortfolioBook(MODES.IDEAL, PCS.roomy, book.snapshot()); expect(restored.submit(b)).toMatchObject({ outcome: "REJECTED", reason: "REJECTED_DUPLICATE_POSITION" });
    const later = { ...b, signalId: "s99998", entry: { ...b.entry, sourceTs: b.entry.sourceTs + TAKEN_WINDOW_SEC + 10, evalTs: (b.entry.evalTs ?? 0) + TAKEN_WINDOW_SEC + 10 } };
    const far = new PortfolioBook(MODES.IDEAL, PCS.roomy, book.snapshot()); far.submit({ ...a, signalId: "s99997", sourceKey: "other", entry: later.entry });
    const pruned = new PortfolioBook(MODES.IDEAL, PCS.roomy, far.snapshot()); expect(pruned.submit({ ...later, signalId: "s99999", entry: { ...later.entry, evalTs: (later.entry.evalTs ?? 0) + 1 } }).outcome).not.toBe("REJECTED");
  });

  describe("relink (§B11): a restored lot learns exits and resolutions that arrived after its checkpoint", () => {
    // First half of the history is submitted knowing nothing about exits/resolutions (they had not happened yet);
    // they all occur after the checkpoint, so re-linking must give exactly the book that knew them from the start.
    const exec = MODES.REALISTIC; const pc = PCS.resize;
    function split() {
      const all = ordered(history(120), exec); const cut = 60; const cutTs = entryKey(all[cut], exec).ts;
      const full = ordered(history(120, { exitsAfter: cutTs + 10, resolutionsAfter: cutTs + 10 }), exec); // same seed sequence is not needed: use `full` for both
      return { full, cut };
    }
    it("re-linked book equals the book that knew everything from the start", () => {
      seed = 99; const { full, cut } = split();
      const knew = runBook(full, exec, pc);
      const blind = new PortfolioBook(exec, pc); for (const s of full.slice(0, cut)) blind.submit({ ...s, exit: null, exitId: null, resolution: null }); const early = blind.take();
      const restored = new PortfolioBook(exec, pc, JSON.parse(JSON.stringify(blind.snapshot())));
      const bySig = new Map(full.map((s) => [s.signalId, s]));
      for (const lot of restored.openLots()) { const s = bySig.get(lot.signalId)!; expect(restored.relink(lot.signalId, { exit: s.exit, exitId: s.exitId ?? null, resolution: s.resolution })).toEqual({ ok: true }); }
      for (const s of full.slice(cut)) restored.submit(s); restored.advance(null); const late = restored.take();
      expect([...early.decisions, ...late.decisions]).toEqual(knew.out.decisions);
      expect([...early.equity, ...late.equity]).toEqual(knew.out.equity);
      expect(restored.summary()).toEqual(knew.book.summary());
    });
    it("an event that should already have happened is refused with the time to rewind to, and nothing changes", () => {
      seed = 99; const { full, cut } = split();
      const book = new PortfolioBook(exec, pc); for (const s of full.slice(0, cut)) book.submit({ ...s, exit: null, exitId: null, resolution: null });
      const lot = book.openLots()[0]; const before = JSON.stringify(book.snapshot()); const lastTs = book.lastKey()!.ts;
      expect(book.relink(lot.signalId, { exit: null, exitId: null, resolution: { ts: lastTs - 100, value: 1 } })).toEqual({ ok: false, rewindTo: lastTs - 100 });
      expect(JSON.stringify(book.snapshot())).toBe(before);
      expect(() => book.relink("no-such-lot", { exit: null, exitId: null, resolution: null })).toThrow(/no open lot/);
    });
    it("a lot whose exit already filled keeps it; a different exit, or a resolution before it, asks for a rewind", () => {
      const exitAt = T0 + 500;
      const s: BookSignal = { ...history(1)[0], sourceKey: "solo", exitId: "x-1", exit: { triggerTs: exitAt, triggerEvalTs: exitAt + 5, triggerPrice: 0.5, triggerUsd: 20, obs: { ts: exitAt, price: 0.5, resolutionSeconds: 0 }, market: null }, resolution: null, entry: { sourceTs: T0, evalTs: T0 + 5, signalPrice: 0.4, sourceUsd: 2000, obs: { ts: T0, price: 0.4, resolutionSeconds: 0 }, market: null } };
      const book = new PortfolioBook(exec, PCS.roomy); book.submit(s);
      const next = { ...history(1)[0], signalId: "s77777", sourceKey: "n", exit: null, resolution: null, entry: { ...s.entry, sourceTs: exitAt + 1000, evalTs: exitAt + 1005 } };
      book.submit(next);                                       // advances past the (partial: $20 cap) exit
      const lot = book.openLots().find((l) => l.signalId === s.signalId)!; expect(lot.state).toBe("PARTIALLY_EXITED"); const xTs = lot.exitTs!;
      expect(book.relink(s.signalId, { exit: s.exit, exitId: "x-1", resolution: { ts: xTs + 50_000, value: 1 } })).toEqual({ ok: true });
      expect(book.relink(s.signalId, { exit: s.exit, exitId: "x-2", resolution: null })).toEqual({ ok: false, rewindTo: xTs });
      expect(book.relink(s.signalId, { exit: s.exit, exitId: "x-1", resolution: { ts: xTs - 10, value: 1 } })).toEqual({ ok: false, rewindTo: xTs - 10 });
      book.advance(null); expect(book.take().lots.at(-1)).toMatchObject({ signalId: s.signalId, state: "RESOLVED", resolutionValue: 1 });
    });
    it("an exit that was applied but sold nothing (no price) is not re-scheduled after a restore; a different exit asks for a rewind", () => {
      // Found by the step 6 runner (resume test): such a lot still names its exit but has no exit time, so it looked
      // exactly like a lot whose exit was still pending, and every restore rewound.
      const exitAt = T0 + 500;
      const s: BookSignal = { ...history(1)[0], sourceKey: "solo", exitId: "x-1", exit: { triggerTs: exitAt, triggerEvalTs: exitAt + 5, triggerPrice: 0.5, triggerUsd: 2000, obs: null, market: null }, resolution: null, entry: { sourceTs: T0, evalTs: T0 + 5, signalPrice: 0.4, sourceUsd: 2000, obs: { ts: T0, price: 0.4, resolutionSeconds: 0 }, market: null } };
      const next = (i: number, at: number): BookSignal => ({ ...history(1)[0], signalId: `s7777${i}`, sourceKey: `n${i}`, exit: null, exitId: null, resolution: null, entry: { ...s.entry, sourceTs: at, evalTs: at + 5 } });
      const whole = new PortfolioBook(exec, PCS.roomy); whole.submit(s); whole.submit(next(1, exitAt + 1000));
      const lot = whole.openLots().find((l) => l.signalId === s.signalId)!; expect(lot).toMatchObject({ state: "OPEN", exitId: "x-1", exitTs: null });
      const restored = new PortfolioBook(exec, PCS.roomy, JSON.parse(JSON.stringify(whole.snapshot())));
      expect(restored.relink(s.signalId, { exit: s.exit, exitId: "x-1", resolution: null })).toEqual({ ok: true });
      expect(restored.openLots().find((l) => l.signalId === s.signalId)).toMatchObject({ exitId: "x-1", exitTs: null });
      expect(restored.snapshot().heap.filter((e) => e.id === s.signalId)).toEqual([]);           // not scheduled again
      expect(restored.relink(s.signalId, { exit: s.exit, exitId: "x-2", resolution: null })).toEqual({ ok: false, rewindTo: lot.openedTs });
      const res = { ts: exitAt + 5000, value: 1 };
      expect(restored.relink(s.signalId, { exit: s.exit, exitId: "x-1", resolution: res })).toEqual({ ok: true }); // a resolution learned later still attaches
      for (const b of [whole, restored]) { b.submit(next(2, exitAt + 9000)); b.take(); }
      expect(restored.openLots().some((l) => l.signalId === s.signalId)).toBe(false);
    });
  });
});

// ───────────────────────────── step 5: signals → portfolio requests ─────────────────────────────
import { buildRequests, duplicateKey, orderRequests, frontierOf, fingerprint, rewindPoint } from "@/lib/paper/portfolio/requests";
import { simulateEntry, lifecycle, timeline } from "@/lib/paper/sim/execute";

describe("portfolio requests", () => {
  let seed = 23; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const uidE = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, uidX = (i: number) => `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`;
  /** Inputs shaped exactly like loadBatchInputs' output. `missing` = share of price observations not fetched yet. */
  function inputs(n: number, o: { missing?: number } = {}) {
    const inp: SimInputs = { signals: [], ledger: new Map(), marks: new Map(), resolutions: new Map(), markets: new Map(), obs: new Map() };
    for (let i = 0; i < n; i++) {
      const src = T0 + i * 600; const ev = src + 4 + Math.floor(rnd() * 90);
      inp.signals.push({ id: uidE(i), kind: ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"][i % 4], wallet: `w${i % 5}`, condition_id: `c${i % 7}`, token_id: `t${i}`, price: 0.1 + rnd() * 0.8, usd: 40 + rnd() * 4000, created_at: iso(src), evaluated_at: iso(ev) });
      inp.ledger.set(uidE(i), { signal_id: uidE(i), created_at: iso(ev) });
      if (rnd() < 0.6) { const xs = src + 30 + Math.floor(rnd() * 5000); inp.signals.push({ id: uidX(i), kind: "EXIT", wallet: `w${i % 5}`, condition_id: `c${i % 7}`, token_id: `t${i}`, price: 0.1 + rnd() * 0.8, usd: rnd() < 0.3 ? 20 : 3000, created_at: iso(xs), evaluated_at: iso(xs + 4) }); }
      if (rnd() < 0.5) inp.resolutions.set(`t${i}`, { ts: src + 3000 + Math.floor(rnd() * 9000), value: rnd() < 0.5 ? 1 : 0 });
      if (rnd() < 0.5) inp.marks.set(uidE(i), { ts: src + 3600, price: rnd() });
      if (i % 7 < 4) inp.markets.set(`c${i % 7}`, { feesEnabled: true, takerFeeRate: 0.02, tickSize: 0.01, minOrderShares: 5 });
    }
    for (const x of neededObservations(buildSignals(inp), inp, [MODES.REALISTIC, MODES.CONSERVATIVE])) if (rnd() >= (o.missing ?? 0)) inp.obs.set(`${x.tokenId}@${x.asOf}`, rnd() < 0.08 ? null : { ts: x.asOf - Math.floor(rnd() * 200), price: 0.03 + rnd() * 0.94, resolutionSeconds: 0 });
    return inp;
  }

  for (const mode of ["IDEAL", "REALISTIC", "CONSERVATIVE"] as const) {
    it(`a request carries exactly what simulateMode uses — ${mode}`, () => {
      const inp = inputs(250, { missing: 0.15 }); const cfg = MODES[mode];
      const reqs = new Map(buildRequests(buildSignals(inp), inp, cfg, { startTs: 0 }).map((r) => [r.signal.signalId, r]));
      const recs = simulateMode(buildSignals(inp), inp, cfg).records as any[];
      let simulated = 0, pending = 0;
      for (const rec of recs) {
        const r = reqs.get(rec.signal_id)!;
        expect(r.pendingEntry || r.exitPendingTs != null, rec.signal_id).toBe(rec.coverage_state === "PENDING_DATA");
        if (rec.coverage_state === "PENDING_DATA") { pending++; continue; }
        const e = simulateEntry(r.signal.entry, cfg); const life = lifecycle(e, r.signal.exit ? { input: r.signal.exit } : null, r.signal.resolution, r.signal.mark, cfg);
        expect({ status: e.status, fill: e.fillPrice, shares: e.filledShares, net: life.netPnl, state: life.state }).toEqual({ status: rec.status, fill: rec.fill_price, shares: rec.filled_shares, net: rec.net_pnl, state: rec.state });
        if (life.entry.filledShares > 0) simulated++;
      }
      expect(simulated).toBeGreaterThan(50); if (mode !== "IDEAL") expect(pending).toBeGreaterThan(10); else expect(pending).toBe(0);
    });
  }

  it("duplicate key: the source fill when known, else the legacy key; one fill → one lot, distinct fills → two lots", () => {
    expect(duplicateKey({ sourceKey: "w|t|1|0.4" }, "0xabc:t:w:1:BUY:10:0.4")).toBe("fill:0xabc:t:w:1:BUY:10:0.4");
    expect(duplicateKey({ sourceKey: "w|t|1|0.4" }, null)).toBe("w|t|1|0.4");
    const inp = inputs(1); const s0 = inp.signals.find((s) => s.kind !== "EXIT")!; inp.signals = [s0];
    const twin = { ...s0, id: uidE(900), kind: "CONSENSUS" }; const other = { ...s0, id: uidE(901), kind: "CONVICTION_ADD" }; // same wallet, token, second and price
    inp.signals.push(twin, other); for (const s of [twin, other]) inp.ledger.set(s.id, { signal_id: s.id, created_at: inp.ledger.get(s0.id)!.created_at });
    const pc = { startingCapitalUsd: 10_000, positionUsd: 100, maxMarketExposureUsd: 10_000, maxTotalExposurePct: 100, maxOpenPositions: 100, maxWalletAllocationUsd: 10_000, minCashReserveUsd: 0, allowResize: false };
    const run = (ids: Map<string, string | null>) => { const b = new PortfolioBook(MODES.IDEAL, pc); for (const r of orderRequests(buildRequests(buildSignals(inp), inp, MODES.IDEAL, { startTs: 0, sourceFillIds: ids }))) b.submit(r.signal); return b.take().decisions; };
    // legacy key (no fill ids): all three look like one trade → one lot
    expect(run(new Map()).map((d) => [d.kind, d.outcome])).toEqual([["NEW_POSITION", "FILLED"], ["CONVICTION_ADD", "REJECTED"], ["CONSENSUS", "REJECTED"]]);
    // with fill ids: NEW_POSITION + CONSENSUS share a fill (one lot, credited to NEW_POSITION); the add is its own fill
    const d = run(new Map([[s0.id, "f1"], [twin.id, "f1"], [other.id, "f2"]]));
    expect(d.map((x) => [x.kind, x.outcome, x.reason])).toEqual([["NEW_POSITION", "FILLED", null], ["CONVICTION_ADD", "FILLED", null], ["CONSENSUS", "REJECTED", "REJECTED_DUPLICATE_POSITION"]]);
  });

  it("start boundary (D4): a signal traded or filled before the start is never requested; every mode requests the same signals", () => {
    const inp = inputs(40); const built = buildSignals(inp);
    // (until 28 Sep the rule looked at the fill time only, so a signal traded before the start but filled after it was
    // requested in REALISTIC/CONSERVATIVE and not in IDEAL; tests/stale-signals.test.ts covers that case in depth)
    const start = built[20].entry.sourceTs;
    const ids = (m: keyof typeof MODES) => buildRequests(built, inp, MODES[m], { startTs: start }).map((x) => x.signal.signalId).sort();
    const want = built.filter((b) => b.entry.sourceTs >= start).map((b) => b.id).sort();
    for (const m of ["IDEAL", "REALISTIC", "CONSERVATIVE"] as const) expect(ids(m), m).toEqual(want);
    expect(want).toContain(built[20].id); expect(want.length).toBeLessThan(built.length);
    const r = buildRequests(built, inp, MODES.REALISTIC, { startTs: start }); expect(r.every((x) => x.key.ts >= start)).toBe(true);
    const ideal = buildRequests(built, inp, MODES.IDEAL, { startTs: start }); expect(ideal.some((x) => x.key.ts === start)).toBe(true); // the start second is in
  });

  it("frontier: earliest missing price; a pending exit does not hold back entries before it; IDEAL is never pending", () => {
    const inp = inputs(60, { missing: 0 }); const built = buildSignals(inp);
    expect(frontierOf(buildRequests(built, inp, MODES.REALISTIC, { startTs: 0 }))).toBeNull();
    const reqs = orderRequests(buildRequests(built, inp, MODES.REALISTIC, { startTs: 0 }));
    const withExit = reqs.find((r) => r.signal.exit && reqs.indexOf(r) > 5)!; const exitTs = timeline(withExit.signal.exit!.triggerTs, withExit.signal.exit!.triggerEvalTs, MODES.REALISTIC).fillTs;
    inp.obs.delete(`${withExit.signal.tokenId}@${exitTs}`);                                  // exit price not fetched yet
    const r2 = buildRequests(built, inp, MODES.REALISTIC, { startTs: 0 }); const w = r2.find((r) => r.signal.signalId === withExit.signal.signalId)!;
    expect(w).toMatchObject({ pendingEntry: false, exitPendingTs: exitTs }); expect(w.signal.exit).toBeNull();
    expect(frontierOf(r2)).toEqual({ ts: exitTs, order: 1, id: withExit.signal.signalId });  // entries before exitTs stay decidable
    const late = reqs[reqs.length - 3]; inp.obs.delete(`${late.signal.tokenId}@${late.key.ts}`); // an entry price missing too
    const f = frontierOf(buildRequests(built, inp, MODES.REALISTIC, { startTs: 0 }))!; expect(f.ts).toBe(Math.min(exitTs, late.key.ts));
    expect(frontierOf(buildRequests(built, inp, MODES.IDEAL, { startTs: 0 }))).toBeNull();
  });

  it("orderRequests puts same-second requests in the book's order (kind, then id), unlike the database's (fill_ts, signal_id)", () => {
    const inp = inputs(8, { missing: 0 }); for (const s of inp.signals) if (s.kind !== "EXIT") { s.created_at = iso(T0); s.evaluated_at = iso(T0 + 5); inp.ledger.set(s.id, { signal_id: s.id, created_at: iso(T0 + 5) }); }
    const reqs = buildRequests(buildSignals(inp), inp, MODES.IDEAL, { startTs: 0 });
    const dbOrder = [...reqs].sort((a, b) => a.key.ts - b.key.ts || (a.signal.signalId < b.signal.signalId ? -1 : 1));
    const ordered = orderRequests(dbOrder);
    expect(ordered.map((r) => r.key.order)).toEqual([...ordered.map((r) => r.key.order)].sort((a, b) => a - b));
    expect(ordered.map((r) => r.signal.signalId)).not.toEqual(dbOrder.map((r) => r.signal.signalId)); // the re-sort matters
    const book = new PortfolioBook(MODES.IDEAL, { startingCapitalUsd: 1e6, positionUsd: 100, maxMarketExposureUsd: 1e6, maxTotalExposurePct: 100, maxOpenPositions: 1e3, maxWalletAllocationUsd: 1e6, minCashReserveUsd: 0, allowResize: false });
    expect(() => { for (const r of dbOrder) book.submit(r.signal); }).toThrow(/out of order/);           // the book would refuse DB order
  });

  describe("fingerprint and rewind point (§B2)", () => {
    const one = (mut: (inp: SimInputs) => void = () => {}) => { seed = 5; const inp = inputs(30, { missing: 0 }); mut(inp); return new Map(buildRequests(buildSignals(inp), inp, MODES.REALISTIC, { startTs: 0 }).map((r) => [r.signal.signalId, r])); };
    const base = one(); const target = [...base.values()].find((r) => r.signal.exit && r.signal.resolution)!; const id = target.signal.signalId;
    const exitTs = timeline(target.signal.exit!.triggerTs, target.signal.exit!.triggerEvalTs, MODES.REALISTIC).fillTs;
    it("a new mark changes nothing; unchanged inputs give the same text every time", () => {
      expect(one((inp) => inp.marks.set(id, { ts: T0 + 99_999, price: 0.77 })).get(id)!.fingerprint).toBe(target.fingerprint);
      expect(rewindPoint(target.fingerprint, one().get(id)!)).toBeNull();
      expect(fingerprint({ ...target.signal, entry: Object.fromEntries(Object.entries(target.signal.entry).reverse()) as never }, MODES.REALISTIC, false, null)).toBe(target.fingerprint); // key order irrelevant
    });
    it("rewinds to the entry when the entry changes, to the changed event otherwise, and to the entry when never decided", () => {
      const tok = target.signal.tokenId;
      const priceMoved = one((inp) => inp.obs.set(`${tok}@${target.key.ts}`, { ts: target.key.ts - 1, price: 0.5, resolutionSeconds: 0 })).get(id)!;
      expect(rewindPoint(target.fingerprint, priceMoved)).toBe(target.key.ts);
      const resolvedLater = one((inp) => inp.resolutions.set(tok, { ts: target.signal.resolution!.ts + 5000, value: target.signal.resolution!.value })).get(id)!;
      expect(rewindPoint(target.fingerprint, resolvedLater)).toBe(target.signal.resolution!.ts);                // earlier of old and new
      const flipped = one((inp) => inp.resolutions.set(tok, { ts: target.signal.resolution!.ts, value: 1 - target.signal.resolution!.value })).get(id)!;
      expect(rewindPoint(target.fingerprint, flipped)).toBe(target.signal.resolution!.ts);
      const exitGone = one((inp) => { inp.signals = inp.signals.filter((s) => !(s.kind === "EXIT" && s.token_id === tok)); }).get(id)!;
      expect(rewindPoint(target.fingerprint, exitGone)).toBe(exitTs);
      const exitPriceMissing = one((inp) => inp.obs.delete(`${tok}@${exitTs}`)).get(id)!;
      expect(rewindPoint(target.fingerprint, exitPriceMissing)).toBe(exitTs);
      expect(rewindPoint(null, target)).toBe(target.key.ts);
    });
  });
});
