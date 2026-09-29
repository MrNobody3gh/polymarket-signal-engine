/**
 * D26 — change detection reads the rows the sweep stamped after the previous run's START minus 120 s (docs/PORTFOLIO.md §11).
 *
 * `computed_at` is stamped by the sweep in the worker before its write commits, so a row stamped just before a run starts can
 * become visible just after it. The margin re-reads a few rows; re-reading is idempotent. The runner (`detectChanges`) and the
 * audit (its "rewritten after the last run started" class) use the same constant and the same rule.
 *
 * The subject is an entry change on a decision that never opened a lot (a backfilled source_fill_id): it is a change under D24
 * (the entry part is compared), the $100 record does not contain it (so the sweep never moves the row by itself), and it is
 * detected only if the runner reads the row — which the test decides by stamping the row 119 s / 121 s before the last run's start.
 */
import { describe, it, expect } from "vitest";
import { sweepSimulation } from "@/lib/paper/sim/run";
import { CHANGE_DETECTION_MARGIN_SEC, changeDetectionReadsFrom } from "@/lib/paper/portfolio/requests";
import { ONE_SLOT, ROOMY, START, E, addEntry, addMarkets, audit, byMode, clock, decisionOf, defOf, fetchPrices, installClock, iso, mkDb, run, sameNumbers, sec, setClock, world, type Db, type Sig } from "./helpers/liveWorld";
import { explainSignal } from "@/lib/paper/portfolio/audit";
import { cfgOf } from "./helpers/liveWorld";

installClock();
const S = START;
const F: Sig = { id: E(1), kind: "NEW_POSITION", wallet: "wF", cond: "cf", token: "tF", src: S + 100, ev: S + 110 };
/** Rejected in every mode (F holds the only slot): they never open a lot. */
// (the one that IS read comes last: a rewind to it replays only what follows it, so the others keep the hash they had)
const A121: Sig = { id: E(3), kind: "NEW_POSITION", wallet: "wB", cond: "cb", token: "tB", src: S + 1000, ev: S + 1010 };
const A120: Sig = { id: E(4), kind: "NEW_POSITION", wallet: "wC", cond: "cc", token: "tC", src: S + 1200, ev: S + 1210 };
const A119: Sig = { id: E(2), kind: "NEW_POSITION", wallet: "wA", cond: "ca", token: "tA", src: S + 4000, ev: S + 4010 };   // decided by a later run, so a checkpoint lies before it
const ALL_A = [A119, A121, A120];

async function world1(db: Db) {
  addMarkets(db, ["cf", "ca", "cb", "cc"]); addEntry(db, F); addEntry(db, A121); addEntry(db, A120);
  setClock(S + 3600); await sweepSimulation(db as never); fetchPrices(db); await sweepSimulation(db as never); await run(db, ONE_SLOT);
  addEntry(db, A119); setClock(S + 7200); await sweepSimulation(db as never); fetchPrices(db); await sweepSimulation(db as never);            // a second cycle decides A119: a checkpoint now lies before it
  await run(db, ONE_SLOT); setClock(clock + 900);
}
const started = (db: Db, m: "IDEAL" | "REALISTIC" | "CONSERVATIVE", pc = ONE_SLOT) => sec(db.T("portfolio_runs").find((r) => r.portfolio_id === defOf(pc, m).id)!.last_run_started_at);
const stamp = (db: Db, id: string, at: number) => { for (const x of db.T("paper_executions").filter((r) => r.signal_id === id)) x.computed_at = iso(at); };
const fix = (db: Db, id: string) => { db.T("signals").find((x) => x.id === id)!.source_fill_id = `0xbackfilled-${id.slice(-2)}`; };
const entryPart = (db: Db, m: "IDEAL" | "REALISTIC" | "CONSERVATIVE", id: string) => decisionOf(db, defOf(ONE_SLOT, m).id, id)!.input_hash.split("|")[0];

describe("D26: the margin", () => {
  it("the constant is 120 s, and 'where change detection reads from' is the previous run's start less that", () => {
    expect(CHANGE_DETECTION_MARGIN_SEC).toBe(120);
    expect(changeDetectionReadsFrom(null)).toBeNull(); expect(changeDetectionReadsFrom(1_790_003_600)).toBe(1_790_003_480);
  });

  it("a row stamped 119 s before the last run's start is re-read; one stamped 121 s before is not; 120 s exactly is not (strictly after); the audit classifies them the same way", async () => {
    const db = mkDb(); await world1(db);
    const modes = ["IDEAL", "REALISTIC", "CONSERVATIVE"] as const;
    for (const m of modes) for (const a of ALL_A) expect(decisionOf(db, defOf(ONE_SLOT, m).id, a.id), `${m} ${a.id}`).toMatchObject({ outcome: "REJECTED" });
    const before = Object.fromEntries(modes.map((m) => [m, ALL_A.map((a) => entryPart(db, m, a.id))]));
    for (const a of ALL_A) fix(db, a.id);                                                                                     // a real entry change on each
    const P = started(db, "IDEAL"); expect(modes.every((m) => started(db, m) >= P)).toBe(true); const P0 = Math.min(...modes.map((m) => started(db, m)));
    // stamp per mode (the three runs start a few seconds apart: use each mode's own last start)
    for (const m of modes) void m;
    stampPerMode(db, A119.id, -119); stampPerMode(db, A121.id, -121); stampPerMode(db, A120.id, -120);
    // the audit before the run: 119 s → the next run reads it ('next run'); 121 s and 120 s → nothing re-examines it ('unexplained')
    const res = await audit(db, ONE_SLOT);
    for (const r of res) {
      const cls = (id: string) => (["nextRun", "unexplained", "d13"] as const).find((c) => r.classes[c].examples.some((e) => e.signalId === id));
      expect(cls(A119.id), `${r.mode} 119 s`).toBe("nextRun"); expect(cls(A121.id), `${r.mode} 121 s`).toBe("unexplained"); expect(cls(A120.id), `${r.mode} 120 s`).toBe("unexplained");
      expect(r.classes.nextRun.examples.find((e) => e.signalId === A119.id)!.why).toMatch(/rewritten after the last run started \(less a 120 s safety margin\)/);
      expect(r.changeDetectionSince).toBe(started(db, r.mode)); expect(r.changeDetectionReadsFrom).toBe(started(db, r.mode) - 120);
    }
    const ex = (await explainSignal(db as never, cfgOf(ONE_SLOT), A119.id, { now: () => clock })).map((x) => x.nextRunReadsRow); expect(ex).toEqual([true, true, true]);
    const ex121 = (await explainSignal(db as never, cfgOf(ONE_SLOT), A121.id, { now: () => clock })).map((x) => x.nextRunReadsRow); expect(ex121).toEqual([false, false, false]);
    void P0;
    // the run: only the 119 s signal is re-read, found changed, and replayed (its stored entry part is the new one); the others keep the old one
    setClock(clock + 40);
    const st = await run(db, ONE_SLOT);
    for (const m of modes) {
      expect(entryPart(db, m, A119.id), `${m} 119 s read`).not.toBe(before[m][0]);
      expect(entryPart(db, m, A121.id), `${m} 121 s not read`).toBe(before[m][1]);
      expect(entryPart(db, m, A120.id), `${m} 120 s not read`).toBe(before[m][2]);
    }
    for (const s of st) expect(s.rewind.reasons.filter((r) => r.startsWith("inputs changed")), s.mode).toHaveLength(1);       // exactly one signal was found changed: the 119 s one
    // and the audit agrees with what the run did: the 119 s one is gone, the others are still reported
    for (const r of await audit(db, ONE_SLOT)) { expect(r.mismatches, r.mode).toBe(2); expect(r.classes.unexplained.examples.map((e) => e.signalId).sort()).toEqual([A121.id, A120.id].sort()); }
    function stampPerMode(d: Db, id: string, deltaSec: number) { for (const x of d.T("paper_executions").filter((r) => r.signal_id === id)) x.computed_at = iso(started(d, x.mode) + deltaSec); }
  });

  it("the margin changes no number: after re-reading, decisions, lots and the equity curve equal a from-scratch replay of the same inputs", async () => {
    const db = mkDb(); await world1(db); for (const a of ALL_A) fix(db, a.id);
    for (const a of ALL_A) for (const x of db.T("paper_executions").filter((r) => r.signal_id === a.id)) x.computed_at = iso(started(db, x.mode) - 100);
    setClock(clock + 40); await run(db, ONE_SLOT); await sameNumbers(db, ONE_SLOT);
  });

  it("re-reading rows that did not change is idempotent: no decision, lot, equity value or stored hash changes, and nothing is written", async () => {
    for (const pc of [ONE_SLOT, ROOMY]) {
      const db = mkDb(); addMarkets(db, ["cf", "ca", "cb", "cc"]); addEntry(db, F); for (const a of ALL_A) addEntry(db, a);
      setClock(S + 3600); await sweepSimulation(db as never); fetchPrices(db); await sweepSimulation(db as never); await run(db, pc); setClock(clock + 900);
      const tables = () => JSON.stringify(["portfolio_decisions", "portfolio_lots", "portfolio_equity", "portfolio_checkpoints"].map((t) => db.T(t)));
      const snap = tables();
      // every row of every mode is stamped inside the margin (as after a marks refresh, or two workers overlapping in a deploy)
      for (const x of db.T("paper_executions")) x.computed_at = iso(started(db, x.mode, pc) - 90);
      const w0 = JSON.stringify(db.stats.writes); setClock(clock + 40);
      const st = await run(db, pc); setClock(clock + 900);
      for (const s of st) { expect(s.rewind.to, s.mode).toBeNull(); expect(s.rewind.reasons, s.mode).toEqual([]); expect(s.deletes, s.mode).toEqual({}); for (const t of ["portfolio_decisions", "portfolio_lots", "portfolio_equity", "portfolio_checkpoints"]) expect(s.writes[t] ?? 0, `${s.mode} ${t}`).toBe(0); }
      expect(tables()).toBe(snap);
      void w0;
      // …and a second identical re-read still writes nothing
      for (const x of db.T("paper_executions")) x.computed_at = iso(started(db, x.mode, pc) - 30); setClock(clock + 40);
      for (const s of await run(db, pc)) for (const t of ["portfolio_decisions", "portfolio_lots", "portfolio_equity"]) expect(s.writes[t] ?? 0, `${s.mode} ${t}`).toBe(0);
      expect(tables()).toBe(snap);
      for (const r of await audit(db, pc)) expect(byMode([r], r.mode).mismatches).toBe(0);
    }
  });

  it("over random live worlds the margin changes nothing observable: a fresh replay equals the incremental run, and no row is ever lost inside the window", async () => {
    for (const [seed, pc] of [[4, ONE_SLOT], [9, ROOMY]] as const) { const w = await world(seed, pc, 30); expect(w.lost).toBe(0); await sameNumbers(w.db, pc); }
  }, 120_000);
});
