/**
 * D27 — a checkpoint is never written at a second the book has already passed (found while implementing D24).
 *
 * The runner closes a run at the watermark W = min(last decided second, frontier − 1) and stores the book's state there as the
 * checkpoint of second W: "the state after every event at or before W", so that restoring it and streaming `fill_ts > W`
 * is exact. The frontier can lie BEHIND the book: a linked exit whose price is not fetched yet and whose fill time is
 * earlier than entries the book has already taken (an exit detected quickly, an entry evaluated late: REALISTIC and
 * CONSERVATIVE fill an exit at its own, earlier, time). The exit is found in the batch that holds its entry, after the
 * entries between the two were submitted. Before D27 the run stored that later state under the earlier W. A later rewind that
 * restored it found a book that had events after its own second: every open lot "already past" the exit, the rewind point
 * never moved, and the runner stopped with "rehydration did not converge" on every run from then on.
 *
 * Nothing in production ever needed that checkpoint to be right until D24 (compare side) removed the rewinds that used to
 * go back beyond it (a rejected decision whose exit / resolution part differed was rewound to the exit's time, before W):
 * tests/phase3-job.test.ts "R4 … (world 29)" is the reproduction, and failed with D24 alone.
 */
import { describe, it, expect } from "vitest";
import { sweepSimulation } from "@/lib/paper/sim/run";
import { MODES, type ModeName } from "@/lib/paper/sim/config";
import { timeline } from "@/lib/paper/sim/execute";
import { E, ROOMY, START, TIGHT, X, addEntry, addExit, addMarkets, clock, fetchPrices, installClock, iso, mkDb, run, sameNumbers, sec, setClock, world, type Db, type Sig } from "./helpers/liveWorld";

installClock();
const S = START;
/** A checkpoint holds no event after its own second. */
const beyond = (db: Db) => db.T("portfolio_checkpoints").filter((c) => (c.state.last?.ts ?? -Infinity) > sec(c.event_ts)).map((c) => `${c.portfolio_id}@${c.event_ts} last=${iso(c.state.last.ts)}`);

// Q1 is decided first (batch 1), Q2 second (batch 2); P fills last and is linked to an exit that fills BEFORE Q1 (its price never arrives in the first run).
const Q1: Sig = { id: E(1), kind: "NEW_POSITION", wallet: "w1", cond: "c1", token: "t1", src: S + 1200, ev: S + 1210 };
const Q2: Sig = { id: E(2), kind: "NEW_POSITION", wallet: "w2", cond: "c2", token: "t2", src: S + 1400, ev: S + 1410 };
const P: Sig = { id: E(3), kind: "NEW_POSITION", wallet: "wP", cond: "cP", token: "tP", src: S + 1000, ev: S + 1600 };   // detected 10 minutes late
const XP = { src: S + 1050, ev: S + 1060 };                                                                              // the exit: filled long before P's entry
const xFill = (m: ModeName) => timeline(XP.src, XP.ev, MODES[m]).fillTs;

async function cycle1(db: Db, batchSize: number) {
  addMarkets(db, ["c1", "c2", "cP"]); for (const s of [Q1, Q2, P]) addEntry(db, s);
  addExit(db, X(3), P.wallet, P.cond, P.token, XP.src, XP.ev, 3000);
  setClock(S + 3600); await sweepSimulation(db as never); fetchPrices(db, undefined, (tok, at) => tok === P.token && [xFill("REALISTIC"), xFill("CONSERVATIVE")].includes(at)); await sweepSimulation(db as never);
  return run(db, ROOMY, { batchSize });
}

describe("D27: a checkpoint never holds a state past its own second", () => {
  it("the frontier (an unpriced exit) lies behind entries the book already took: no checkpoint is written past the watermark", async () => {
    const db = mkDb(); const stats = await cycle1(db, 1);
    for (const m of ["REALISTIC", "CONSERVATIVE"] as ModeName[]) {
      const st = stats.find((x) => x.mode === m)!;
      expect(st.frontier, m).toMatchObject({ ts: xFill(m) }); expect(xFill(m)).toBeLessThan(timeline(Q1.src, Q1.ev, MODES[m]).fillTs);   // the shape: exit before the entries taken
      expect(st.watermark, m).toBe(xFill(m) - 1);
    }
    expect(beyond(db)).toEqual([]);
  });

  it("…and the same on every cycle of a live world, then a rewind that goes back past the watermark still converges and equals a fresh replay", async () => {
    const db = mkDb(); await cycle1(db, 1);
    setClock(clock + 900); fetchPrices(db); await sweepSimulation(db as never);        // the exit price arrives
    setClock(clock + 40); await run(db, ROOMY, { batchSize: 1 });
    expect(beyond(db)).toEqual([]);
    // a late resolution on Q1 forces a rewind to a checkpoint
    db.insertRow("token_resolutions", { token_id: Q1.token, value: 1, resolved_ts: iso(S + 2000) });
    setClock(clock + 900); await sweepSimulation(db as never); setClock(clock + 40); await run(db, ROOMY, { batchSize: 1 });
    expect(beyond(db)).toEqual([]);
    await sameNumbers(db, ROOMY);
  });

  it("over random live worlds (the generator of the stale-hash tests): no checkpoint is past its own second", async () => {
    let checked = 0;
    for (const [pc, seeds] of [[TIGHT, [3, 5, 8]], [ROOMY, [2, 6]]] as const) for (const seed of seeds) {
      const w = (await world(seed, pc, 60)).db; expect(beyond(w)).toEqual([]); checked += w.T("portfolio_checkpoints").length;
    }
    expect(checked).toBeGreaterThan(15);                                                  // not vacuous
  }, 240_000);
});
