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
import { describe, it, expect } from "vitest";
import { sweepSimulation } from "@/lib/paper/sim/run";
import { MODES, type ModeName, type PortfolioConfig } from "@/lib/paper/sim/config";
import { timeline } from "@/lib/paper/sim/execute";
import { runPortfolios } from "@/lib/paper/portfolio/run";
import { explainSignal, formatExplain } from "@/lib/paper/portfolio/audit";
import { buildRequests, decisionRewindPoint } from "@/lib/paper/portfolio/requests";
import { buildSignals, loadBatchInputs } from "@/lib/paper/sim/run";
import { ALL, E, ONE_SLOT, ROOMY, START, TIGHT, X, addEntry, addExit, addMarkets, audit, byMode, cfgOf, clock, decisionOf, defOf, execOf, fetchPrices, freshReplay, installClock, iso, ledgerOf, mkDb, putObs, run, sameNumbers, sec, setClock, unit, world, type Db, type Sig } from "./helpers/liveWorld";

installClock();


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
  setClock(clock + 600);                                                        // the portfolio job runs minutes after the sweep (in production, hours after this row was stamped): outside the D26 margin
  await run(db, pc); setClock(clock + 900);
}
async function cycle2(db: Db, pc: PortfolioConfig) {
  addExit(db, XID, W, C, T, XS, XE, 5);
  putObs(db, T, xFill("REALISTIC")); putObs(db, T, xFill("CONSERVATIVE")); // already fetched: the (token, time) key is shared with B's exit
  setClock(S + 7200); await sweepSimulation(db as never); setClock(clock + 40); await run(db, pc); setClock(clock + 900);
}

describe("the 29 Sep 2026 shape, with D24 (compare side): a decision that never opened a lot is compared on its entry part only", () => {
  const hashes = (db: Db, pc: PortfolioConfig, ids: string[]) => ALL.flatMap((m) => ids.map((id) => { const d = decisionOf(db, defOf(pc, m).id, id)!; return [m, id, d.input_hash, d.record_hash]; }));

  it("flips: the late exit that never moved a NOT_ENTERED row is no difference; the audit finds nothing, in any mode, and nothing was rewritten", async () => {
    const db = mkDb(); const pc = ONE_SLOT; await cycle1(db, pc);
    const cons = defOf(pc, "CONSERVATIVE");
    // precondition: the production state before the exit
    expect(execOf(db, A.id, "CONSERVATIVE")).toMatchObject({ status: "UNKNOWN", state: "NOT_ENTERED" });
    for (const m of ALL) expect(decisionOf(db, defOf(pc, m).id, A.id), m).toMatchObject({ outcome: "REJECTED", reason: "REJECTED_MAX_OPEN_POSITIONS" });
    expect(decisionOf(db, cons.id, A.id)!.input_hash.split("|").slice(1)).toEqual(["-@-", "-@-"]);
    const rowBefore = { ...execOf(db, A.id, "CONSERVATIVE")! }; const stored = hashes(db, pc, [A.id, B.id]);
    for (const r of await audit(db, pc)) expect(r.mismatches, r.mode).toBe(0);

    await cycle2(db, pc);

    // 1. the exit is linked and the sweep rewrote the rows that carry it …
    expect(execOf(db, A.id, "IDEAL")).toMatchObject({ state: "EXITED" }); expect(execOf(db, A.id, "REALISTIC")).toMatchObject({ state: "PARTIALLY_EXITED" });
    expect(execOf(db, B.id, "CONSERVATIVE")).toMatchObject({ state: "PARTIALLY_EXITED" });
    // 2. … but not A's CONSERVATIVE row (a NOT_ENTERED record has no exit fields), exactly as in production
    const rowAfter = execOf(db, A.id, "CONSERVATIVE")!;
    expect({ record_hash: rowAfter.record_hash, computed_at: rowAfter.computed_at }).toEqual({ record_hash: rowBefore.record_hash, computed_at: rowBefore.computed_at });
    expect(ledgerOf(db, A.id).sim_terminal).toBe(false);
    // 3. no decision that never opened a lot has its stored hash rewritten, in any mode (D24: stored values stay as they are), whether or not its row moved
    expect(hashes(db, pc, [A.id, B.id])).toEqual(stored);
    // 4. the audit: every decision matches by the runner's rule; nothing is unexplained
    const res = await audit(db, pc);
    for (const r of res) { expect(r.mismatches, r.mode).toBe(0); expect(r.classes.unexplained.count, r.mode).toBe(0); expect(r.matches, r.mode).toBe(r.checked); }
    // 5. more cycles change nothing
    for (let i = 0; i < 3; i++) { setClock(clock + 900); await sweepSimulation(db as never); setClock(clock + 40); await run(db, pc); }
    for (const r of await audit(db, pc)) expect(r.mismatches, r.mode).toBe(0);
    expect(hashes(db, pc, [A.id, B.id])).toEqual(stored);
    expect(execOf(db, A.id, "CONSERVATIVE")!.computed_at).toBe(rowBefore.computed_at);
  });

  it("changes no number: decisions, lots and the equity curve equal a from-scratch replay of the same final inputs (input_hash aside)", async () => {
    const db = mkDb(); const pc = ONE_SLOT; await cycle1(db, pc); await cycle2(db, pc);
    await sameNumbers(db, pc);
    // the fresh replay stores the whole current hash; the only stored differences are input_hash of decisions that never opened a lot, whose entry part is equal
    const fresh = await freshReplay(db, pc);
    const diff = db.T("portfolio_decisions").filter((d) => decisionOf(fresh, d.portfolio_id, d.signal_id)?.input_hash !== d.input_hash);
    expect(diff.length).toBeGreaterThan(0);
    for (const d of diff) { expect(Number(d.filled_shares), `${d.portfolio_id}:${d.signal_id}`).toBe(0); expect(d.input_hash.split("|")[0]).toBe(decisionOf(fresh, d.portfolio_id, d.signal_id)!.input_hash.split("|")[0]); }
    expect(diff.some((d) => d.portfolio_id === defOf(pc, "CONSERVATIVE").id && d.signal_id === A.id)).toBe(true);           // the production decision is one of them
  });

  it("the same class in IDEAL (a resolution that arrives after the exit closed the position leaves the $100 record unchanged) is no difference either", async () => {
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
    expect(r.mismatches).toBe(0); expect(r.classes.unexplained.examples).toEqual([]);
    await sameNumbers(db, pc);
  });

  // The regression the fix had to turn green (was `it.fails` until D24): no decision that never opened a lot is reported for its exit / resolution.
  it("DESIRED, true since D24: a decision that never opened a lot never makes the audit report an unexplained difference", async () => {
    const db = mkDb(); const pc = ONE_SLOT; await cycle1(db, pc); await cycle2(db, pc);
    expect(byMode(await audit(db, pc), "CONSERVATIVE").classes.unexplained.count).toBe(0);
  });

  it("a decision that never opened a lot whose ENTRY part changes is still a difference: unexplained, exit 1 (the entry is what the D24 rule keeps comparing)", async () => {
    const db = mkDb(); const pc = ONE_SLOT; await cycle1(db, pc); await cycle2(db, pc);
    db.T("signals").find((x) => x.id === A.id)!.source_fill_id = "0xbackfilled";                                        // an entry input the $100 record does not contain
    const r = byMode(await audit(db, pc), "CONSERVATIVE");
    expect(r.classes.unexplained.examples).toMatchObject([{ signalId: A.id, parts: ["entry"], lot: "none", effect: "possible" }]);
  });

  it("--explain: the exit that differs is shown as NOT COMPARED, and the verdict is 'match'", async () => {
    const db = mkDb(); const pc = ONE_SLOT; await cycle1(db, pc); await cycle2(db, pc);
    const rs = await explainSignal(db as never, cfgOf(pc), A.id, { now: () => clock });
    const cons = rs.find((r) => r.mode === "CONSERVATIVE")!;
    expect(cons).toMatchObject({ cls: "match", effect: null, simTerminal: false, lotState: null, nextRunReadsRow: false, signalFound: true, parts: [] });
    expect(cons.notCompared).toEqual([{ part: "exit", stored: "-@-", current: expect.stringMatching(/^[0-9a-f]{16}@\d+$/) }]);
    expect(cons.why).toMatch(/never opened a lot.*entry part is unchanged.*D24/);
    expect(cons.current).toMatchObject({ exitId: XID, exitFillTs: xFill("CONSERVATIVE"), resolutionTs: null });
    expect(rs.filter((r) => r.mode !== "CONSERVATIVE").map((r) => r.cls)).toEqual(["match", "match"]);
    expect(formatExplain(A.id, rs)).toMatch(/not compared \(the decision never opened a lot, D24\) exit: stored=-@- current=[0-9a-f]{16}@\d+/);
  });
});

// ───────────────────────────── the other ways a hash could go stale: ruled out ─────────────────────────────
// With room for every entry, A opens a lot in every mode, so its whole hash is compared (D24 leaves those alone): a late exit on it must
// still be detected, re-read and its hash refreshed by every path below.
describe("what does not leave a stale hash on a decision that opened a lot (hypotheses 1 and 2 of the brief, ruled out; unchanged by D24)", () => {
  /** A world whose IDEAL row for A is rewritten by the exit (so change detection must fix A's hash), plus a new late entry G so a run streams a batch. */
  const G: Sig = { id: E(9), kind: "NEW_POSITION", wallet: "wG", cond: "cG", token: "tG", src: S + 6000, ev: S + 6010 };
  const staleIdeal = (db: Db, pc: PortfolioConfig) => { const d = defOf(pc, "IDEAL"); const dec = decisionOf(db, d.id, A.id); return { dec, exitPart: dec?.input_hash.split("|")[1] }; };

  it("a row the sweep rewrites while a run is in progress is read by the next run (change detection starts at the last run's START)", async () => {
    const db = mkDb(); const pc = ROOMY; await cycle1(db, pc);
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
    const db = mkDb(); const pc = ROOMY; await cycle1(db, pc); addEntry(db, G); addMarkets(db, ["cG"]);
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
    const db = mkDb(); const pc = ROOMY; await cycle1(db, pc);
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
 * The runner's answer for every stored decision, by the rule it uses (requests.ts decisionRewindPoint, fed with the requests it
 * builds: loadBatchInputs → buildSignals → buildRequests with source_fill_id): how many decisions it would treat as changed.
 */
async function runnerChanged(db: Db, pc: PortfolioConfig, mode: ModeName) {
  const d = defOf(pc, mode); const decs = db.T("portfolio_decisions").filter((x) => x.portfolio_id === d.id); const ids = decs.map((x) => x.signal_id);
  const inp = await loadBatchInputs(db as never, ids); const fills = new Map(db.T("signals").map((x) => [x.id, x.source_fill_id ?? null]));
  const reqs = new Map(buildRequests(buildSignals(inp), inp, MODES[mode], { startTs: d.startTs, sourceFillIds: fills }).map((r) => [r.signal.signalId, r]));
  let changed = 0, checked = 0; const changedIds: string[] = [];
  for (const x of decs) { const r = reqs.get(x.signal_id); if (!inp.signals.some((sg) => String(sg.id) === x.signal_id)) continue; checked++; if (!r || decisionRewindPoint(x.outcome, x.input_hash, r) != null) { changed++; changedIds.push(x.signal_id); } }
  return { changed, checked, changedIds };
}

describe("over random live worlds (production order and cadence), D24 on", () => {
  it("no exit / resolution difference on a decision that never opened a lot is ever reported; nothing is ever lost; the runner and the audit agree on every decision after every cycle; and a fresh replay of the final inputs always equals the incremental run", async () => {
    let unexplained = 0, lost = 0, worlds = 0, agreed = 0, cycles = 0, residual = 0; const measure = { runs: 0, rewinds: 0, rewindSec: 0, rowsRead: 0, writes: 0, checked: 0, mismatches: 0 };
    for (const [, pc] of [["tight", TIGHT], ["roomy", ROOMY]] as [string, PortfolioConfig][]) {
      for (let seed = 1; seed <= 8; seed++) {
        // (the audit's answer versus the runner's, for every mode, after every cycle)
        const w = await world(seed, pc, 30, { onCycle: async (db) => { cycles++;
          for (const r of await audit(db, pc)) { const rc = await runnerChanged(db, pc, r.mode); expect(rc.changed, `${r.mode} runner vs audit (world ${seed})`).toBe(r.mismatches); expect(rc.checked).toBe(r.checked - r.missing.signal - r.missing.execution); agreed += rc.checked;
            // What is still reported as unexplained is NOT the D24 class: only a decision that opened a lot, whose lot a resolution closed before an exit that arrived
            // later (the $100 record does not contain that exit, so its row never moves). D24 keeps the whole hash for a decision that has a lot.
            for (const e of r.classes.unexplained.examples) { if (e.parts.includes("entry")) continue; residual++;
              const lot = db.T("portfolio_lots").find((l) => l.portfolio_id === defOf(pc, r.mode).id && l.signal_id === e.signalId)!;
              expect(e, `${r.mode} ${e.signalId}`).toMatchObject({ lot: "closed", effect: "possible", parts: ["exit"] }); expect(lot.state).toBe("RESOLVED");
              expect(Number(e.current!.split("|")[1].split("@")[1]), "the exit fills after the resolution").toBeGreaterThanOrEqual(sec(lot.resolution_ts)); } } } });
        worlds++; unexplained += w.unexplained; lost += w.lost;
        for (const k of ["runs", "rewinds", "rewindSec", "rowsRead", "writes"] as const) measure[k] += w.runStats[k]; measure.checked += w.tot.checked; measure.mismatches += w.tot.mismatches;
        await sameNumbers(w.db, pc);
      }
    }
    expect(worlds).toBe(16); expect(lost).toBe(0);
    expect(residual).toBe(unexplained);                            // every unexplained exit / resolution difference in every cycle is that residual class (before D24: in at least 8 of the 16 worlds, mostly on decisions that never opened a lot)
    expect(agreed).toBeGreaterThan(10_000);                        // not vacuous
    if (process.env.DBG) console.log("D24-MEASURE", JSON.stringify({ worlds, cycles, unexplainedEvents: unexplained, residual, lost, agreed, ...measure }));
  }, 600_000);
});
