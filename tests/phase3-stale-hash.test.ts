/**
 * The one unexplained audit difference of 29 Sep 2026 (docs/PORTFOLIO.md §11, "Stale input_hash on a decision that never
 * opened a lot"; docs/PHASE3_D24_ANALYSIS.md).
 *
 * Production: CONSERVATIVE decision 44ff1fc1 (REJECTED, its $100 execution row UNKNOWN / NOT_ENTERED) kept the input_hash it
 * was given at 22:12 (`…|-@-|-@-`) although a linked exit arrived at 22:19. The runner only re-reads a decision when its
 * `paper_executions.computed_at` moves, and the sweep only rewrites a row when the $100 record changes: a NOT_ENTERED record
 * says nothing about an exit, so the row never moved. The sweep still visits the signal (its ledger row is not
 * `sim_terminal`, because another mode is still partly exited), so the audit cannot call it D13 either.
 *
 * These tests reproduce that in the real sweep + runner, prove it changes no number, and rule out the other ways a hash can
 * go stale (a row rewritten while a run is in progress; a run that dies before it refreshes hashes; a rewind that does not
 * replay the decision).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { stressDb } from "./helpers/stressDb";
import { sweepSimulation } from "@/lib/paper/sim/run";
import { MODES, type ModeName, type PortfolioConfig } from "@/lib/paper/sim/config";
import { timeline } from "@/lib/paper/sim/execute";
import { runPortfolios } from "@/lib/paper/portfolio/run";
import { validatePortfolioConfig, portfolioDefinitions, type PortfolioRunConfig } from "@/lib/paper/portfolio/config";
import { auditPortfolios, explainSignal, type DecisionAudit } from "@/lib/paper/portfolio/audit";

const START = 1_790_000_000;
const iso = (s: number) => new Date(s * 1000).toISOString();
const sec = (v: string) => Math.floor(Date.parse(v) / 1000);
const pad = (i: number) => String(i).padStart(12, "0");
const E = (i: number) => `00000000-0000-4000-8000-${pad(i)}`, X = (i: number) => `00000000-0000-4000-9000-${pad(i)}`;
const ALL: ModeName[] = ["IDEAL", "REALISTIC", "CONSERVATIVE"];
/** One slot: every entry after the first is REJECTED_MAX_OPEN_POSITIONS, so it never opens a lot. */
const ONE_SLOT: PortfolioConfig = { startingCapitalUsd: 10_000, positionUsd: 100, maxMarketExposureUsd: 10_000, maxTotalExposurePct: 100, maxOpenPositions: 1, maxWalletAllocationUsd: 10_000, minCashReserveUsd: 0, allowResize: false };
const TIGHT: PortfolioConfig = { startingCapitalUsd: 1_500, positionUsd: 100, maxMarketExposureUsd: 300, maxTotalExposurePct: 70, maxOpenPositions: 3, maxWalletAllocationUsd: 350, minCashReserveUsd: 50, allowResize: true };
const ROOMY: PortfolioConfig = { startingCapitalUsd: 1_000_000, positionUsd: 100, maxMarketExposureUsd: 1_000_000, maxTotalExposurePct: 100, maxOpenPositions: 100_000, maxWalletAllocationUsd: 1_000_000, minCashReserveUsd: 0, allowResize: false };

let clock = START;
const setClock = (t: number) => { clock = t; vi.setSystemTime(t * 1000); };
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); setClock(START); });
afterEach(() => { vi.useRealTimers(); });

type Db = ReturnType<typeof stressDb>;
function mkDb(): Db {
  const now = () => Math.floor(Date.now() / 1000);
  const runsRow = (id: string) => db.T("portfolio_runs").find((r) => r.portfolio_id === id);
  const db: Db = stressDb({ rpc: {
    claim_portfolio_lease: ({ p_portfolio_id: id, p_owner: owner, p_seconds: s }: any) => {
      let r = runsRow(id); if (!r) { r = { portfolio_id: id, lease_owner: null, lease_until: null, last_run_started_at: null, last_run_finished_at: null, last_watermark_ts: null, last_watermark_key: null, stats: {} }; db.insertRow("portfolio_runs", r); }
      if (r.lease_until == null || sec(r.lease_until) <= now() || r.lease_owner === owner) { r.lease_owner = owner; r.lease_until = iso(now() + s); return true; }
      return false;
    },
    release_portfolio_lease: ({ p_portfolio_id: id, p_owner: owner }: any) => { const r = runsRow(id); if (!r || r.lease_owner !== owner) return false; r.lease_owner = null; r.lease_until = null; return true; },
  } });
  return db;
}
const cfgOf = (pc: PortfolioConfig): PortfolioRunConfig => validatePortfolioConfig({ ...pc, startTs: iso(START) }, clock);
const defOf = (pc: PortfolioConfig, m: ModeName) => portfolioDefinitions(cfgOf(pc)).find((d) => d.mode === m)!;
const run = (db: Db, pc: PortfolioConfig, extra: Record<string, unknown> = {}) => runPortfolios(db as never, { config: cfgOf(pc), modes: ALL, owner: "worker", ...extra });
const audit = (db: Db, pc: PortfolioConfig) => auditPortfolios(db as never, cfgOf(pc), { now: () => clock });
const byMode = (r: DecisionAudit[], m: ModeName) => r.find((x) => x.mode === m)!;
const unit = (k: string) => { let h = 2166136261; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 2 ** 32; };
/** The price backlog: every PENDING observation becomes COMPLETE (a function of token and time only), except `unavailable`. */
function fetchPrices(db: Db, unavailable: (token: string, asOf: number) => boolean = () => false) {
  for (const r of db.T("price_observations")) {
    if (r.state !== "PENDING") continue;
    Object.assign(r, unavailable(r.token_id, r.as_of) ? { state: "UNAVAILABLE" } : { state: "COMPLETE", obs_ts: r.as_of - Math.floor(unit(`${r.token_id}@${r.as_of}`) * 50), price: 0.3 + unit(`${r.token_id}@${r.as_of}`) * 0.4, resolution_seconds: 0 });
  }
}
const putObs = (db: Db, token: string, asOf: number) => db.insertRow("price_observations", { token_id: token, as_of: asOf, state: "COMPLETE", obs_ts: asOf - 3, price: 0.5, resolution_seconds: 0 });

interface Sig { id: string; kind: string; wallet: string; cond: string; token: string; src: number; ev: number; usd?: number; price?: number }
const addEntry = (db: Db, s: Sig, fill = s.id) => { db.insertRow("signals", { id: s.id, kind: s.kind, wallet: s.wallet, condition_id: s.cond, token_id: s.token, price: s.price ?? 0.5, usd: s.usd ?? 3000, created_at: iso(s.src), evaluated_at: iso(s.ev), source_fill_id: `0xfill${fill}` }); db.insertRow("paper_ledger", { signal_id: s.id, created_at: iso(s.ev), sim_terminal: false, side: "LONG" }); };
const addExit = (db: Db, id: string, wallet: string, cond: string, token: string, src: number, ev: number, usd: number) => { db.insertRow("signals", { id, kind: "EXIT", wallet, condition_id: cond, token_id: token, price: 0.6, usd, created_at: iso(src), evaluated_at: iso(ev), source_fill_id: `0xexit${id}` }); db.insertRow("paper_ledger", { signal_id: id, created_at: iso(ev), sim_terminal: true, side: "EXIT_EVENT" }); };
const addMarkets = (db: Db, conds: string[]) => { for (const c of conds) db.insertRow("markets", { condition_id: c, fees_enabled: true, taker_fee_rate: 0.02, tick_size: 0.01, min_order_shares: 5, meta_fetched_at: iso(START - 86_400) }); };
const decisionOf = (db: Db, pid: string, id: string) => db.T("portfolio_decisions").find((d) => d.portfolio_id === pid && d.signal_id === id);
const execOf = (db: Db, id: string, m: ModeName) => db.T("paper_executions").find((x) => x.signal_id === id && x.mode === m);
const ledgerOf = (db: Db, id: string) => db.T("paper_ledger").find((l) => l.signal_id === id)!;

// ───────────────────────────── outputs, and "a fresh replay of the final inputs" ─────────────────────────────
const strip = ({ computed_at: _c, record_hash: _r, input_hash: _i, ...r }: Record<string, any>) => r;
const outputs = (db: Db) => ({
  decisions: db.T("portfolio_decisions").map(strip).sort((a, b) => `${a.portfolio_id}${a.signal_id}`.localeCompare(`${b.portfolio_id}${b.signal_id}`)),
  lots: db.T("portfolio_lots").map(strip).sort((a, b) => `${a.portfolio_id}${a.signal_id}`.localeCompare(`${b.portfolio_id}${b.signal_id}`)),
  equity: db.T("portfolio_equity").map((r) => [r.portfolio_id, r.ts, r.seq, r.cash, r.exposure, r.equity]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
});
/** Same signals, marks, metadata, resolutions and price observations in an empty database; sweep once, run once. */
async function freshReplay(db: Db, pc: PortfolioConfig): Promise<Db> {
  const f = mkDb();
  for (const t of ["signals", "paper_ledger", "markets", "token_resolutions", "paper_marks", "price_observations"]) for (const r of db.T(t)) f.insertRow(t, { ...r, ...(t === "paper_ledger" && r.side === "LONG" ? { sim_terminal: false } : {}) });
  await sweepSimulation(f as never); await run(f, pc);
  return f;
}
/** input_hash aside, the incrementally-run database and a from-scratch replay of its final inputs are identical. */
const sameNumbers = async (db: Db, pc: PortfolioConfig, modes: ModeName[] = ALL) => {
  const fresh = await freshReplay(db, pc); const keep = new Set(modes.map((m) => defOf(pc, m).id)); const a = outputs(db), b = outputs(fresh);
  const only = <T extends { portfolio_id?: string }>(rows: T[]) => rows.filter((r) => keep.has(String(r.portfolio_id ?? "")));
  const diffs = (x: Record<string, any>[], y: Record<string, any>[]) => { const kx = new Map(x.map((r) => [`${r.portfolio_id}|${r.signal_id}`, JSON.stringify(r)])), ky = new Map(y.map((r) => [`${r.portfolio_id}|${r.signal_id}`, JSON.stringify(r)])); return [...new Set([...kx.keys(), ...ky.keys()])].filter((k) => kx.get(k) !== ky.get(k)).map((k) => `${k}\n  incremental: ${kx.get(k)}\n  fresh:       ${ky.get(k)}`); };
  expect(diffs(only(a.decisions), only(b.decisions))).toEqual([]); expect(diffs(only(a.lots), only(b.lots))).toEqual([]);
  expect(a.equity.filter((e) => keep.has(String(e[0])))).toEqual(b.equity.filter((e) => keep.has(String(e[0]))));
};

// ───────────────────────────── the production shape ─────────────────────────────
/**
 * Filler F takes the only slot. Wallet W's NEW_POSITION (A) and CONVICTION_ADD (B) on token T are both rejected. In
 * CONSERVATIVE, A's entry price is unavailable (NOT_ENTERED); B fills. A late-evaluated, small exit then arrives whose
 * price observation already exists (B needed the same (token, time) key), and only partly closes the $100 positions, so
 * the signal stays non-terminal in the other modes.
 */
const S = START; const W = "wW", T = "tW", C = "cW";
const F: Sig = { id: E(1), kind: "NEW_POSITION", wallet: "wF", cond: "cF", token: "tF", src: S + 100, ev: S + 110 };
const A: Sig = { id: E(2), kind: "NEW_POSITION", wallet: W, cond: C, token: T, src: S + 1000, ev: S + 1010 };
const B: Sig = { id: E(3), kind: "CONVICTION_ADD", wallet: W, cond: C, token: T, src: S + 1500, ev: S + 1510 };
const XS = S + 4000, XE = S + 4300, XID = X(2); // the exit: source 4000, evaluated 5 minutes later, $5 (a partial exit)
const xFill = (m: ModeName) => timeline(XS, XE, MODES[m]).fillTs;

async function cycle1(db: Db, pc: PortfolioConfig) {
  addMarkets(db, ["cF", C]); for (const s of [F, A, B]) addEntry(db, s);
  setClock(S + 3600);
  await sweepSimulation(db as never); fetchPrices(db, (tok, at) => tok === T && at === timeline(A.src, A.ev, MODES.CONSERVATIVE).fillTs); await sweepSimulation(db as never);
  await run(db, pc); setClock(clock + 900);
}
async function cycle2(db: Db, pc: PortfolioConfig) {
  addExit(db, XID, W, C, T, XS, XE, 5);
  putObs(db, T, xFill("REALISTIC")); putObs(db, T, xFill("CONSERVATIVE")); // already fetched: the (token, time) key is shared with B's exit
  setClock(S + 7200); await sweepSimulation(db as never); setClock(clock + 40); await run(db, pc); setClock(clock + 900);
}

describe("stale input_hash on a decision that never opened a lot (production, 29 Sep 2026)", () => {
  it("reproduces it: a NOT_ENTERED row never moves, so the exit that arrives is never read; the audit reports exactly one unexplained difference, in one mode", async () => {
    const db = mkDb(); const pc = ONE_SLOT; await cycle1(db, pc);
    const cons = defOf(pc, "CONSERVATIVE");
    // precondition: the production state before the exit
    expect(execOf(db, A.id, "CONSERVATIVE")).toMatchObject({ status: "UNKNOWN", state: "NOT_ENTERED" });
    for (const m of ALL) expect(decisionOf(db, defOf(pc, m).id, A.id), m).toMatchObject({ outcome: "REJECTED", reason: "REJECTED_MAX_OPEN_POSITIONS" });
    expect(decisionOf(db, cons.id, A.id)!.input_hash.split("|").slice(1)).toEqual(["-@-", "-@-"]);
    const rowBefore = { ...execOf(db, A.id, "CONSERVATIVE")! };
    expect(byMode(await audit(db, pc), "CONSERVATIVE").mismatches).toBe(0);

    await cycle2(db, pc);

    if (process.env.DBG) console.log("STATES", JSON.stringify(db.T("paper_executions").filter((x) => [A.id, B.id].includes(x.signal_id)).map((x) => `${x.signal_id.slice(-1)} ${x.mode} ${x.status}/${x.state} ${x.exit_status ?? ""} ${x.computed_at}`)), "terminal", ledgerOf(db, A.id).sim_terminal, ledgerOf(db, B.id).sim_terminal);
    // 1. the exit is linked and the sweep rewrote the rows that carry it …
    expect(execOf(db, A.id, "IDEAL")).toMatchObject({ state: "EXITED" }); expect(execOf(db, A.id, "REALISTIC")).toMatchObject({ state: "PARTIALLY_EXITED" });   // REALISTIC keeps the signal in the sweep
    expect(execOf(db, B.id, "CONSERVATIVE")).toMatchObject({ state: "PARTIALLY_EXITED" });
    // 2. … but not A's CONSERVATIVE row: a NOT_ENTERED record has no exit fields, so nothing changed (same hash, same computed_at)
    const rowAfter = execOf(db, A.id, "CONSERVATIVE")!;
    expect({ record_hash: rowAfter.record_hash, computed_at: rowAfter.computed_at }).toEqual({ record_hash: rowBefore.record_hash, computed_at: rowBefore.computed_at });
    expect(ledgerOf(db, A.id).sim_terminal).toBe(false);                       // the sweep still visits it (other modes are open), so it is not D13
    // 3. so the decision kept its old hash while every sibling was refreshed
    expect(decisionOf(db, cons.id, A.id)!.input_hash.split("|").slice(1)).toEqual(["-@-", "-@-"]);
    for (const [m, id] of [["IDEAL", A.id], ["REALISTIC", A.id], ["IDEAL", B.id], ["REALISTIC", B.id], ["CONSERVATIVE", B.id]] as [ModeName, string][])
      expect(decisionOf(db, defOf(pc, m).id, id)!.input_hash.split("|")[1], `${m} ${id}`).toMatch(/^[0-9a-f]{16}@\d+$/);

    // 4. the audit: exactly one unexplained difference in the whole run, the exit part, no lot, with every field the log line needs
    const res = await audit(db, pc);
    expect(res.map((r) => [r.mode, r.classes.unexplained.count])).toEqual([["IDEAL", 0], ["REALISTIC", 0], ["CONSERVATIVE", 1]]);
    const ex = byMode(res, "CONSERVATIVE").classes.unexplained.examples[0];
    expect(ex).toMatchObject({ signalId: A.id, kind: "NEW_POSITION", parts: ["exit"], lot: "none", lotState: null, simTerminal: false, effect: "none", computedAt: iso(sec(rowBefore.computed_at)).replace(".000Z", "Z"), rewindTo: xFill("CONSERVATIVE") });
    expect(ex.why).toMatch(/\$100 record is unchanged.*never opened/);
    expect(byMode(res, "CONSERVATIVE").classes.unexplained.inert).toBe(1);
    expect(byMode(res, "CONSERVATIVE").lastRunStartedAt).toBe(sec(db.T("portfolio_runs").find((r) => r.portfolio_id === cons.id)!.last_run_started_at));

    // 5. nothing ever re-examines it: more cycles change nothing
    for (let i = 0; i < 3; i++) { setClock(clock + 900); await sweepSimulation(db as never); setClock(clock + 40); await run(db, pc); }
    const later = byMode(await audit(db, pc), "CONSERVATIVE");
    expect(later.classes.unexplained.count).toBe(1); expect(later.classes.unexplained.examples[0].signalId).toBe(A.id);
    expect(decisionOf(db, cons.id, A.id)!.input_hash.split("|")[1]).toBe("-@-");
    expect(execOf(db, A.id, "CONSERVATIVE")!.computed_at).toBe(rowBefore.computed_at);
  });

  it("changes no number: decisions, lots and the equity curve equal a from-scratch replay of the same final inputs (input_hash aside)", async () => {
    const db = mkDb(); const pc = ONE_SLOT; await cycle1(db, pc); await cycle2(db, pc);
    expect(byMode(await audit(db, pc), "CONSERVATIVE").classes.unexplained.count).toBe(1);   // the stale hash is really there
    await sameNumbers(db, pc);
    // and the fresh replay is what has the current hash: the only stored difference is that one input_hash
    const fresh = await freshReplay(db, pc);
    const diff = db.T("portfolio_decisions").filter((d) => decisionOf(fresh, d.portfolio_id, d.signal_id)?.input_hash !== d.input_hash).map((d) => `${d.portfolio_id}:${d.signal_id}`);
    expect(diff).toEqual([`${defOf(pc, "CONSERVATIVE").id}:${A.id}`]);
  });

  it("the same class exists in IDEAL: a resolution that arrives after the exit closed the position leaves the $100 record unchanged", async () => {
    const db = mkDb(); const pc = ONE_SLOT;
    const A2: Sig = { id: E(12), kind: "NEW_POSITION", wallet: "wV", cond: "cV", token: "tV", src: S + 1000, ev: S + 1010 };
    addMarkets(db, ["cF", "cV"]); addEntry(db, F); addEntry(db, A2);
    setClock(S + 3600); await sweepSimulation(db as never); fetchPrices(db, (tok) => tok === "tV"); await sweepSimulation(db as never);   // tV's entry price never arrives in REALISTIC / CONSERVATIVE: PENDING keeps the signal in the sweep
    addExit(db, X(12), "wV", "cV", "tV", S + 2000, S + 2004, 50_000); setClock(S + 4000); await sweepSimulation(db as never); await run(db, pc);
    expect(execOf(db, A2.id, "IDEAL")).toMatchObject({ state: "EXITED" }); expect(execOf(db, A2.id, "REALISTIC")).toMatchObject({ state: "PENDING" });
    const ideal = defOf(pc, "IDEAL"); expect(decisionOf(db, ideal.id, A2.id)).toMatchObject({ outcome: "REJECTED" });
    const row = { ...execOf(db, A2.id, "IDEAL")! };
    setClock(S + 5000); db.insertRow("token_resolutions", { token_id: "tV", value: 0, resolved_ts: iso(S + 4500) });   // after the exit fill
    await sweepSimulation(db as never); setClock(clock + 40); await run(db, pc); setClock(clock + 900);
    expect(execOf(db, A2.id, "IDEAL")!.computed_at).toBe(row.computed_at);                                            // the record ignores a resolution after the exit
    const r = byMode(await audit(db, pc), "IDEAL");
    expect(r.classes.unexplained.examples).toMatchObject([{ signalId: A2.id, parts: ["resolution"], lot: "none", effect: "none", simTerminal: false }]);
    await sameNumbers(db, pc);
  });

  // The regression the fix (D24, or any other) must turn green: no decision that never opened a lot may keep a stale hash.
  it.fails("DESIRED, not true yet: a decision that never opened a lot always carries the current fingerprint (remove .fails when D24 or another fix lands)", async () => {
    const db = mkDb(); const pc = ONE_SLOT; await cycle1(db, pc); await cycle2(db, pc);
    expect(byMode(await audit(db, pc), "CONSERVATIVE").classes.unexplained.count).toBe(0);
  });

  it("--explain names the difference: stored versus current, the row the runner would have to read, and why it never will", async () => {
    const db = mkDb(); const pc = ONE_SLOT; await cycle1(db, pc); await cycle2(db, pc);
    const rs = await explainSignal(db as never, cfgOf(pc), A.id, { now: () => clock });
    const cons = rs.find((r) => r.mode === "CONSERVATIVE")!;
    expect(cons).toMatchObject({ cls: "unexplained", effect: "none", simTerminal: false, lotState: null, nextRunReadsRow: false, signalFound: true });
    expect(cons.parts).toEqual([{ part: "exit", stored: "-@-", current: expect.stringMatching(/^[0-9a-f]{16}@\d+$/) }]);
    expect(cons.current).toMatchObject({ exitId: XID, exitFillTs: xFill("CONSERVATIVE"), resolutionTs: null });
    expect(rs.filter((r) => r.mode !== "CONSERVATIVE").map((r) => r.cls)).toEqual(["match", "match"]);
  });
});

// ───────────────────────────── the other ways a hash could go stale: ruled out ─────────────────────────────
describe("what does not leave a stale hash (hypotheses 1 and 2 of the brief, ruled out)", () => {
  /** A world whose IDEAL row for A is rewritten by the exit (so change detection must fix A's hash), plus a new late entry G so a run streams a batch. */
  const G: Sig = { id: E(9), kind: "NEW_POSITION", wallet: "wG", cond: "cG", token: "tG", src: S + 6000, ev: S + 6010 };
  const staleIdeal = (db: Db, pc: PortfolioConfig) => { const d = defOf(pc, "IDEAL"); const dec = decisionOf(db, d.id, A.id); return { dec, exitPart: dec?.input_hash.split("|")[1] }; };

  it("a row the sweep rewrites while a run is in progress is read by the next run (change detection starts at the last run's START)", async () => {
    const db = mkDb(); const pc = ONE_SLOT; await cycle1(db, pc);
    // precompute the sweep's rewrite of A's IDEAL row in a clone, then land it mid-run (on the runner's first stream read)
    const clone = mkDb(); for (const t of Object.keys(db.tables)) for (const r of db.T(t)) clone.insertRow(t, JSON.parse(JSON.stringify(r)));
    addExit(clone, XID, W, C, T, XS, XE, 5); putObs(clone, T, xFill("REALISTIC")); putObs(clone, T, xFill("CONSERVATIVE"));
    setClock(S + 7200); await sweepSimulation(clone as never);
    const rewritten: Record<string, any>[] = clone.T("paper_executions").filter((x) => x.signal_id === A.id || x.signal_id === B.id).map((x) => ({ ...x, computed_at: iso(clock + 30) }));
    addEntry(db, G); addMarkets(db, ["cG"]); await sweepSimulation(db as never); fetchPrices(db); await sweepSimulation(db as never);   // G is in the stream of the next run
    let landed = false;
    const spy = { rpc: db.rpc, from: (t: string) => { const b: any = db.from(t); if (t !== "paper_executions") return b; const gt = b.gt.bind(b); b.gt = (k: string, v: any) => { if (k === "fill_ts" && !landed) { landed = true; setClock(clock + 30);
      addExit(db, XID, W, C, T, XS, XE, 5); putObs(db, T, xFill("REALISTIC")); putObs(db, T, xFill("CONSERVATIVE"));
      for (const x of rewritten) { const cur = execOf(db, x.signal_id, x.mode as ModeName)!; Object.assign(cur, x); } } return gt(k, v); }; return b; } };
    setClock(S + 7200); const startedAt = clock;
    await runPortfolios(spy as never, { config: cfgOf(pc), modes: ["IDEAL"], owner: "worker" });
    expect(landed).toBe(true);
    const runRow = db.T("portfolio_runs").find((r) => r.portfolio_id === defOf(pc, "IDEAL").id)!;
    expect(sec(runRow.last_run_started_at)).toBe(startedAt); expect(sec(execOf(db, A.id, "IDEAL")!.computed_at)).toBeGreaterThan(startedAt);   // rewritten after the run started
    expect(staleIdeal(db, pc).exitPart).toBe("-@-");                                                                     // this run did not see it …
    setClock(clock + 900); await runPortfolios(db as never, { config: cfgOf(pc), modes: ["IDEAL"], owner: "worker" });
    expect(staleIdeal(db, pc).exitPart).toMatch(/^[0-9a-f]{16}@\d+$/);                                                    // … the next one does
    setClock(clock + 900); const after = byMode(await audit(db, pc), "IDEAL");
    if (process.env.DBG) console.log("H1", JSON.stringify([after.classes.d13.examples, after.classes.nextRun.examples, after.classes.unexplained.examples].flat().map((e) => [e.signalId.slice(-2), e.parts, e.lot, e.why.slice(0, 60)])));
    expect(after.mismatches).toBe(0);
  });

  it("a run that dies after streaming a batch but before it refreshes hashes leaves nothing stale: the next run re-reads the same rows", async () => {
    const db = mkDb(); const pc = ONE_SLOT; await cycle1(db, pc); addEntry(db, G); addMarkets(db, ["cG"]);
    addExit(db, XID, W, C, T, XS, XE, 5); putObs(db, T, xFill("REALISTIC")); putObs(db, T, xFill("CONSERVATIVE"));
    setClock(S + 7200); await sweepSimulation(db as never); fetchPrices(db); await sweepSimulation(db as never);
    setClock(clock + 40);
    await expect(runPortfolios(db as never, { config: cfgOf(pc), modes: ["IDEAL"], owner: "worker", fault: (st) => { if (st === "afterOutputs") throw new Error("killed"); } })).rejects.toThrow("killed");
    expect(staleIdeal(db, pc).exitPart).toBe("-@-");                                                   // the dead run refreshed nothing …
    setClock(clock + 900); await runPortfolios(db as never, { config: cfgOf(pc), modes: ["IDEAL"], owner: "worker" });
    expect(staleIdeal(db, pc).exitPart).toMatch(/^[0-9a-f]{16}@\d+$/);                                  // … and the next run repairs it
    setClock(clock + 900); expect(byMode(await audit(db, pc), "IDEAL").mismatches).toBe(0);
    await sameNumbers(db, pc, ["IDEAL"]);
  });

  it("a change before the restored checkpoint (a rewind that does not replay the decision) still refreshes its hash", async () => {
    const db = mkDb(); const pc = ONE_SLOT; await cycle1(db, pc);
    addEntry(db, G); addMarkets(db, ["cG"]); setClock(S + 7000); await sweepSimulation(db as never); fetchPrices(db); await sweepSimulation(db as never); await run(db, pc); setClock(clock + 900); // a checkpoint after A
    const ckAfterA = db.T("portfolio_checkpoints").filter((c) => c.portfolio_id === defOf(pc, "IDEAL").id && sec(c.event_ts) > A.ev).length; expect(ckAfterA).toBeGreaterThan(0);
    await cycle2(db, pc);
    expect(staleIdeal(db, pc).exitPart).toMatch(/^[0-9a-f]{16}@\d+$/);
    expect(byMode(await audit(db, pc), "IDEAL").mismatches).toBe(0);
    await sameNumbers(db, pc, ["IDEAL"]);
  });
});

// ───────────────────────────── the audit's own answer, over many random worlds ─────────────────────────────
/**
 * Random live worlds through the real sweep and runner, in production order and cadence (price backlog → sweep → the
 * three portfolio runs, every 15 minutes; signals, late-evaluated exits and late resolutions arriving over time), audited
 * after every cycle. Two properties:
 *  - LOST never happens: no decision keeps a stale hash although its execution row was rewritten in the window the run
 *    that just finished had to read (computed_at after the previous run's start).
 *  - it changes no number: at the end the incrementally-run database equals a fresh replay of its final inputs.
 * Every unexplained difference that does appear is the invisible kind: row not rewritten since, $100 record unchanged.
 */
async function world(seed: number, pc: PortfolioConfig, n = 30) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const db = mkDb(); const evs: { at: number; f: () => void }[] = []; let t = START + 60;
  for (let i = 0; i < n; i++) {
    t += 30 + Math.floor(rnd() * 90); const src = t; const ev = src + (rnd() < 0.2 ? 60 + Math.floor(rnd() * 500) : 3 + Math.floor(rnd() * 40));
    const wallet = `w${Math.floor(rnd() * 3)}`, cond = `c${Math.floor(rnd() * 5)}`, tok = `t${Math.floor(rnd() * 12)}`;
    const sig = { id: E(i), kind: ["NEW_POSITION", "NEW_POSITION", "CONVICTION_ADD", "EARLY_ENTRY", "CONSENSUS"][Math.floor(rnd() * 5)], wallet, condition_id: cond, token_id: tok, price: 0.1 + rnd() * 0.8, usd: 50 + rnd() * 3000, created_at: iso(src), evaluated_at: iso(ev), source_fill_id: `0xfill${i}` };
    evs.push({ at: ev, f: () => { db.insertRow("signals", sig); db.insertRow("paper_ledger", { signal_id: sig.id, created_at: iso(ev), sim_terminal: false, side: "LONG" }); } });
    if (rnd() < 0.5) { const xs = src + 30 + Math.floor(rnd() * 20_000), xe = xs + (rnd() < 0.5 ? 4 : 60 + Math.floor(rnd() * 500)); const usd = rnd() < 0.3 ? 10 + rnd() * 30 : 500 + rnd() * 2000; const price = 0.05 + rnd() * 0.9;
      evs.push({ at: xe, f: () => { db.insertRow("signals", { id: X(i), kind: "EXIT", wallet, condition_id: cond, token_id: tok, price, usd, created_at: iso(xs), evaluated_at: iso(xe), source_fill_id: `0xexit${i}` }); db.insertRow("paper_ledger", { signal_id: X(i), created_at: iso(xe), sim_terminal: true, side: "EXIT_EVENT" }); } }); }
    if (rnd() < 0.4) { const rt = src + 600 + Math.floor(rnd() * 20_000); const at = rt + Math.floor(rnd() * 8000); const value = [0, 1, 1, 0.5][Math.floor(unit(tok) * 4)]; evs.push({ at, f: () => { if (!db.T("token_resolutions").some((r) => r.token_id === tok)) db.insertRow("token_resolutions", { token_id: tok, value, resolved_ts: iso(rt) }); } }); }
  }
  addMarkets(db, ["c1", "c2", "c4"]); evs.sort((a, b) => a.at - b.at);
  const end = evs[evs.length - 1].at + 4 * 900; let cur = 0; let unexplained = 0, lost = 0, invisible = 0, cycles = 0; const notInert: string[] = [];
  const prevStart = (m: ModeName) => { const id = defOf(pc, m).id; const r = db.T("portfolio_runs").find((x) => x.portfolio_id === id); return r?.last_run_started_at ? sec(r.last_run_started_at) : null; };
  for (let ct = START + 900; ct <= end; ct += 900, cycles++) {
    setClock(ct - 1); while (cur < evs.length && evs[cur].at <= ct - 5) evs[cur++].f(); setClock(ct);
    for (const r of db.T("price_observations")) { if (r.state !== "PENDING" || unit(`lag${r.token_id}@${r.as_of}@${cycles}`) < 0.3) continue; const v = unit(`${r.token_id}@${r.as_of}`); Object.assign(r, v < 0.05 ? { state: "UNAVAILABLE" } : { state: "COMPLETE", obs_ts: r.as_of - Math.floor(v * 200), price: 0.05 + ((v * 7919) % 1) * 0.9, resolution_seconds: 0 }); }
    await sweepSimulation(db as never); setClock(ct + 40 + Math.floor(rnd() * 30));
    const before = Object.fromEntries(ALL.map((m) => [m, prevStart(m)])) as Record<ModeName, number | null>;
    await run(db, pc); setClock(ct + 300);
    for (const r of await audit(db, pc)) for (const e of r.classes.unexplained.examples) {
      if (e.parts.includes("entry")) continue;                                               // a moved entry is D18, not this
      unexplained++; if (e.effect !== "none") notInert.push(`${r.mode} ${e.signalId} ${e.lot}`);
      const pv = before[r.mode]; if (pv != null && e.computedAt && sec(e.computedAt) > pv) lost++; else invisible++;
    }
  }
  // D24 (analysis): what the audit sees at the end, and how much of it never opened a lot and differs only in exit / resolution
  const fin = await audit(db, pc); const tot = { mismatches: 0, removable: 0, byClass: { d13: 0, nextRun: 0, unexplained: 0 }, removableByClass: { d13: 0, nextRun: 0, unexplained: 0 }, checked: 0 };
  for (const r of fin) { tot.checked += r.checked; tot.mismatches += r.mismatches; for (const k of ["d13", "nextRun", "unexplained"] as const) { tot.byClass[k] += r.classes[k].count; tot.removableByClass[k] += r.classes[k].inert; tot.removable += r.classes[k].inert; } }
  return { db, unexplained, lost, invisible, notInert, cycles, tot };
}

describe("over random live worlds (production order and cadence)", () => {
  it("no hash is ever lost; every unexplained difference is the invisible kind; and a fresh replay of the final inputs always equals the incremental run", async () => {
    let unexplained = 0, invisible = 0, lost = 0, worlds = 0, withStale = 0; const notInert: string[] = []; const tot = { checked: 0, mismatches: 0, removable: 0 };
    for (const [name, pc] of [["tight", TIGHT], ["roomy", ROOMY]] as [string, PortfolioConfig][]) {
      for (let seed = 1; seed <= 8; seed++) {
        const w = await world(seed, pc); worlds++; if (w.unexplained) withStale++;
        tot.checked += w.tot.checked; tot.mismatches += w.tot.mismatches; tot.removable += w.tot.removable;
        unexplained += w.unexplained; invisible += w.invisible; lost += w.lost; notInert.push(...w.notInert.map((x) => `${name}#${seed} ${x}`));
        await sameNumbers(w.db, pc);
      }
    }
    expect(worlds).toBe(16); expect(lost).toBe(0);
    expect(unexplained).toBeGreaterThan(0); expect(withStale).toBeGreaterThanOrEqual(8);       // the class is common, not a curiosity
    expect(invisible).toBe(unexplained);
    // where a stale hash sits on a decision that did open a lot, the numbers are still the fresh replay's (asserted above)
    expect(notInert.length).toBeLessThanOrEqual(unexplained);
    if (process.env.DBG) console.log("D24-MEASURE", JSON.stringify({ worlds, unexplainedEvents: unexplained, ...tot }));
  }, 300_000);
});
