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
