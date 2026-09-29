/**
 * D24, compare side (docs/PHASE3_D24_ANALYSIS.md §3; docs/PORTFOLIO.md §11): for a decision that never opened a lot the runner and
 * the audit compare the ENTRY part of `input_hash` only; every other decision is compared whole. One rule, in one place
 * (requests.ts `comparableStoredHash` / `decisionInputsChanged` / `decisionRewindPoint`), used by change detection, rehydration,
 * the hash refresh and the audit.
 *
 *  A. the rule itself, on fingerprints: every outcome, every field of the entry part, the exit and the resolution;
 *  B. through the real sweep + runner: an entry change still rewinds and replays; a no-lot decision that a changed entry now
 *     lets open a lot is replayed to FILLED with the whole hash; a decision with a lot keeps whole-hash comparison; the mixed state
 *     (old-format hashes) causes no rewind and no write; a rewind caused by another lot's exit still re-decides a rejected signal;
 *  C. the hash refresh writes nothing for a no-lot decision whose entry part is unchanged.
 * tests/phase3-d24.test.ts (the invariant D24 relies on) is untouched.
 */
import { describe, it, expect } from "vitest";
import { sweepSimulation } from "@/lib/paper/sim/run";
import { MODES, type ModeName } from "@/lib/paper/sim/config";
import { timeline } from "@/lib/paper/sim/execute";
import { entryKey } from "@/lib/paper/portfolio/book";
import { inputHashRefreshes } from "@/lib/paper/portfolio/run";
import { comparableStoredHash, decisionInputsChanged, decisionRewindPoint, fingerprint, neverOpenedLot, type PortfolioRequest } from "@/lib/paper/portfolio/requests";
import type { BookSignal } from "@/lib/paper/portfolio/types";
import { ALL, E, ONE_SLOT, ROOMY, START, X, addEntry, addExit, addMarkets, audit, byMode, clock, decisionOf, defOf, execOf, installClock, iso, mkDb, putObs, run, sameNumbers, sec, setClock, fetchPrices, freshReplay, type Db, type Sig } from "./helpers/liveWorld";

installClock();
const T0 = START;

// ───────────────────────────── A. the rule, on fingerprints ─────────────────────────────
const exec = MODES.REALISTIC;
const base = (): BookSignal => ({ signalId: "s1", kind: "NEW_POSITION", wallet: "w1", conditionId: "c1", tokenId: "t1", sourceKey: "fill:f1", exitId: null,
  entry: { sourceTs: T0, evalTs: T0 + 10, signalPrice: 0.5, sourceUsd: 1000, obs: { ts: T0 + 12, price: 0.5, resolutionSeconds: 0 }, market: { feesEnabled: true, takerFeeRate: 0.02, tickSize: 0.01, minOrderShares: 5 } },
  exit: null, resolution: null, mark: null });
const withExit = (s: BookSignal, id = "x1", ts = T0 + 500): BookSignal => ({ ...s, exitId: id, exit: { triggerTs: ts, triggerEvalTs: ts + 4, triggerPrice: 0.6, triggerUsd: 900, obs: { ts: ts + 8, price: 0.6, resolutionSeconds: 0 }, market: s.entry.market } });
const req = (s: BookSignal, pendingEntry = false, exitPendingTs: number | null = null): PortfolioRequest => ({ signal: s, key: entryKey(s, exec), pendingEntry, exitPendingTs, fingerprint: fingerprint(s, exec, pendingEntry, exitPendingTs) });

const NO_LOT = ["REJECTED", "UNFILLED", "EXPIRED", "INVALID", "UNKNOWN"], LOT = ["FILLED", "PARTIALLY_FILLED"];
/** Every field of the entry part, changed one at a time. */
const ENTRY_CHANGES: [string, (s: BookSignal) => BookSignal][] = [
  ["kind", (s) => ({ ...s, kind: "CONSENSUS" })], ["wallet", (s) => ({ ...s, wallet: "w2" })], ["market (condition)", (s) => ({ ...s, conditionId: "c2" })], ["token", (s) => ({ ...s, tokenId: "t2" })],
  ["source key (source_fill_id)", (s) => ({ ...s, sourceKey: "fill:f2" })], ["source key (legacy → fill)", (s) => ({ ...s, sourceKey: "legacy|key" })],
  ["source time", (s) => ({ ...s, entry: { ...s.entry, sourceTs: T0 - 5 } })], ["evaluation time (entry timing, D18)", (s) => ({ ...s, entry: { ...s.entry, evalTs: T0 + 3600 } })],
  ["signal price", (s) => ({ ...s, entry: { ...s.entry, signalPrice: 0.51 } })], ["source size", (s) => ({ ...s, entry: { ...s.entry, sourceUsd: 999 } })],
  ["observation (price)", (s) => ({ ...s, entry: { ...s.entry, obs: { ts: T0 + 12, price: 0.52, resolutionSeconds: 0 } } })], ["observation (time)", (s) => ({ ...s, entry: { ...s.entry, obs: { ts: T0 + 11, price: 0.5, resolutionSeconds: 0 } } })],
  ["observation (arrives)", (s) => ({ ...s, entry: { ...s.entry, obs: null } })],
  ["market metadata (fees)", (s) => ({ ...s, entry: { ...s.entry, market: { ...s.entry.market!, feesEnabled: false } } })], ["market metadata (fee rate)", (s) => ({ ...s, entry: { ...s.entry, market: { ...s.entry.market!, takerFeeRate: 0.03 } } })],
  ["market metadata (tick)", (s) => ({ ...s, entry: { ...s.entry, market: { ...s.entry.market!, tickSize: 0.001 } } })], ["market metadata (min order)", (s) => ({ ...s, entry: { ...s.entry, market: { ...s.entry.market!, minOrderShares: 300 } } })],
  ["market metadata (appears)", (s) => ({ ...s, entry: { ...s.entry, market: null } })],
];

describe("D24 (A): the comparison rule", () => {
  it("what is a decision that never opened a lot: exactly the outcomes without shares; an unknown or missing outcome is compared whole", () => {
    for (const o of NO_LOT) expect(neverOpenedLot(o), o).toBe(true);
    for (const o of LOT) expect(neverOpenedLot(o), o).toBe(false);
    for (const o of [null, undefined, "", "SOMETHING_NEW", "filled", "rejected"]) expect(neverOpenedLot(o), String(o)).toBe(false);
  });

  it("a stored hash with a different exit and/or resolution part is NOT a change for a no-lot decision, and IS one for a decision with a lot", () => {
    const now = withExit({ ...base(), resolution: { ts: T0 + 900, value: 1 } }); const r = req(now);
    const olds = ["-@-|-@-", "-@-|res@1", "aaaaaaaaaaaaaaaa@5|-@-", "aaaaaaaaaaaaaaaa@5|bbbbbbbbbbbbbbbb@9"].map((rest) => `${r.fingerprint.split("|")[0]}|${rest}`);
    for (const old of olds) {
      for (const o of NO_LOT) { expect(decisionInputsChanged(o, old, r.fingerprint), `${o} ${old}`).toBe(false); expect(decisionRewindPoint(o, old, r), `${o} ${old}`).toBeNull(); expect(comparableStoredHash(o, old, r.fingerprint)).toBe(r.fingerprint); }
      for (const o of [...LOT, null, undefined, "SOMETHING_NEW"]) { expect(decisionInputsChanged(o, old, r.fingerprint), `${o} ${old}`).toBe(true); expect(decisionRewindPoint(o, old, r), `${o} ${old}`).not.toBeNull(); expect(comparableStoredHash(o, old, r.fingerprint)).toBe(old); }
    }
  });

  it("every field of the entry part is still compared for a no-lot decision: any change is a change, with the rewind point the whole-hash rule gives (the entry's own fill time)", () => {
    const before = base(); const stored = req(before).fingerprint;
    for (const [name, change] of ENTRY_CHANGES) {
      const next = req(change(before));
      expect(next.fingerprint, name).not.toBe(stored);
      for (const o of [...NO_LOT, ...LOT]) {
        expect(decisionInputsChanged(o, stored, next.fingerprint), `${name} / ${o}`).toBe(true);
        expect(decisionRewindPoint(o, stored, next), `${name} / ${o}`).toBe(next.key.ts);                                  // identical to the rule before D24
      }
    }
    // the pending flag is part of the entry (a price that arrives)
    expect(decisionInputsChanged("REJECTED", req(before, true).fingerprint, req(before).fingerprint)).toBe(true);
  });

  it("an entry change together with an exit / resolution change is a change for a no-lot decision too, rewound exactly as before D24", () => {
    const before = withExit({ ...base(), resolution: { ts: T0 + 900, value: 1 } }); const stored = req(before).fingerprint;
    for (const [name, change] of ENTRY_CHANGES) {
      const next = req({ ...change(before), exit: null, exitId: null, resolution: null });
      expect(decisionInputsChanged("EXPIRED", stored, next.fingerprint), name).toBe(true);
      expect(decisionRewindPoint("EXPIRED", stored, next), name).toBe(next.key.ts);
    }
  });

  it("for a decision with a lot the whole hash decides, and the rewind point is the exit's / resolution's time, as before D24", () => {
    const plain = base(); const stored = req(plain).fingerprint;
    const ex = req(withExit(plain, "x1", T0 + 2000)); const rs = req({ ...plain, resolution: { ts: T0 + 3000, value: 1 } });
    for (const o of LOT) {
      expect(decisionRewindPoint(o, stored, ex), o).toBe(timeline(T0 + 2000, T0 + 2004, exec).fillTs);
      expect(decisionRewindPoint(o, stored, rs), o).toBe(T0 + 3000);
      expect(decisionRewindPoint(o, ex.fingerprint, ex), o).toBeNull();
    }
    // …and a mark alone is never a change (the fingerprint has no mark)
    expect(req({ ...plain, mark: { ts: T0 + 10, price: 0.7 } }).fingerprint).toBe(stored);
  });

  it("a decision that is not decided yet (no stored hash) is compared as before: null → the entry's fill time", () => {
    for (const o of [...NO_LOT, ...LOT, null, undefined]) expect(decisionRewindPoint(o, null, req(base())), String(o)).toBe(req(base()).key.ts);
    expect(decisionInputsChanged("REJECTED", null, req(base()).fingerprint)).toBe(true);
  });
});

// ───────────────────────────── C. the hash refresh ─────────────────────────────
describe("D24 (C): fixInputHashes writes nothing for a no-lot decision whose entry part is unchanged", () => {
  const row = (id: string, outcome: string, hash: string) => ({ portfolio_id: "p", signal_id: id, outcome, input_hash: hash, record_hash: "old", computed_at: "x", filled_shares: LOT.includes(outcome) ? 1 : 0 });
  it("only rows that changed by the runner's rule are refreshed, whole, with a new record_hash; a stored old-format hash of a no-lot decision is left alone", () => {
    const cur = req(withExit(base())).fingerprint; const entry = cur.split("|")[0];
    const rows = [row("a", "REJECTED", `${entry}|-@-|-@-`), row("b", "FILLED", `${entry}|-@-|-@-`), row("c", "REJECTED", `other|-@-|-@-`), row("d", "PARTIALLY_FILLED", cur), row("e", "UNKNOWN", `${entry}|zzzzzzzzzzzzzzzz@1|-@-`)];
    const out = inputHashRefreshes(rows, new Map(rows.map((r) => [r.signal_id, cur])));
    expect(out.map((r) => r.signal_id).sort()).toEqual(["b", "c"]);                               // a, e: no-lot, entry equal → untouched; d: equal
    for (const r of out) { expect(r.input_hash).toBe(cur); expect(r.record_hash).not.toBe("old"); expect(r).not.toHaveProperty("computed_at"); }
  });
});

// ───────────────────────────── B. through the sweep and the runner ─────────────────────────────
const S = START;
/** Filler F takes the only slot; W's NEW_POSITION (A) is REJECTED_MAX_OPEN_POSITIONS in every mode. */
// (condition ids are lower case: the sweep's loader lower-cases them when it reads the markets table)
const F: Sig = { id: E(1), kind: "NEW_POSITION", wallet: "wF", cond: "cf", token: "tF", src: S + 100, ev: S + 110 };
const A: Sig = { id: E(2), kind: "NEW_POSITION", wallet: "wA", cond: "ca", token: "tA", src: S + 1000, ev: S + 1010 };
async function oneSlot(db: Db) {
  addMarkets(db, ["cf", "ca"]); addEntry(db, F); addEntry(db, A);
  setClock(S + 3600); await sweepSimulation(db as never); fetchPrices(db); await sweepSimulation(db as never);
  const st = await run(db, ONE_SLOT); setClock(clock + 900); return st;
}
/** What the sweep does when it rewrites a row: stamp it (the runner reads rows by computed_at). */
const touch = (db: Db, id: string) => { for (const x of db.T("paper_executions").filter((r) => r.signal_id === id)) x.computed_at = iso(clock); };
const hashOf = (db: Db, pc: typeof ONE_SLOT, m: ModeName, id: string) => decisionOf(db, defOf(pc, m).id, id)!.input_hash;
const rewound = (st: Awaited<ReturnType<typeof run>>) => st.filter((s) => s.rewind.to != null).map((s) => s.mode);
const outWrites = (st: Awaited<ReturnType<typeof run>>) => st.map((s) => s.writes.portfolio_decisions ?? 0);

describe("D24 (B): the runner", () => {
  it("test 2: the ENTRY part of a no-lot decision is still compared — a backfilled source_fill_id, a metadata change: rewind and replay, as before D24", async () => {
    for (const [what, change] of [
      ["source_fill_id", (db: Db) => { db.T("signals").find((x) => x.id === A.id)!.source_fill_id = "0xbackfilled"; }],
      ["market metadata", (db: Db) => { db.T("markets").find((x) => x.condition_id === "ca")!.tick_size = 0.001; }],
    ] as [string, (db: Db) => void][]) {
      const db = mkDb(); await oneSlot(db); for (const m of ALL) expect(decisionOf(db, defOf(ONE_SLOT, m).id, A.id), m).toMatchObject({ outcome: "REJECTED" });
      const stored = ALL.map((m) => hashOf(db, ONE_SLOT, m, A.id).split("|")[0]);
      change(db); touch(db, A.id); setClock(clock + 40);
      const st = await run(db, ONE_SLOT);
      expect(rewound(st).sort(), what).toEqual([...ALL].sort());                                                       // every mode rewinds to A and replays it
      for (const s of st) expect(s.rewind.reasons.join(" "), `${what} ${s.mode}`).toMatch(new RegExp(`inputs changed ${A.id.slice(0, 8)}`));
      ALL.forEach((m, i) => { expect(hashOf(db, ONE_SLOT, m, A.id).split("|")[0], `${what} ${m}`).not.toBe(stored[i]); });   // the new entry part is stored
      await sameNumbers(db, ONE_SLOT);
      for (const r of await audit(db, ONE_SLOT)) expect(r.mismatches, `${what} ${r.mode}`).toBe(0);
    }
  });

  it("test 3: a no-lot decision whose entry change makes it open a lot is replayed to FILLED, with the whole hash stored", async () => {
    const db = mkDb(); const pc = ROOMY;
    // B repeats A's source fill: REJECTED_DUPLICATE_POSITION (the first by event order takes it). The fill id is then corrected.
    const B: Sig = { id: E(3), kind: "CONSENSUS", wallet: A.wallet, cond: A.cond, token: A.token, src: A.src, ev: A.ev };
    addMarkets(db, ["ca"]); addEntry(db, A, "dup"); addEntry(db, B, "dup");
    setClock(S + 3600); await sweepSimulation(db as never); fetchPrices(db); await sweepSimulation(db as never); await run(db, pc); setClock(clock + 900);
    for (const m of ALL) expect(decisionOf(db, defOf(pc, m).id, B.id), m).toMatchObject({ outcome: "REJECTED", reason: "REJECTED_DUPLICATE_POSITION" });
    for (const m of ALL) expect(hashOf(db, pc, m, B.id).split("|").slice(1)).toEqual(["-@-", "-@-"]);
    db.T("signals").find((x) => x.id === B.id)!.source_fill_id = "0xfillB-corrected"; touch(db, B.id); setClock(clock + 40);
    const st = await run(db, pc);
    expect(rewound(st).sort()).toEqual([...ALL].sort());
    for (const m of ALL) {
      const d = decisionOf(db, defOf(pc, m).id, B.id)!; expect(d, m).toMatchObject({ outcome: expect.stringMatching(/^(FILLED|PARTIALLY_FILLED)$/) }); expect(Number(d.filled_shares)).toBeGreaterThan(0);
      expect(db.T("portfolio_lots").some((l) => l.portfolio_id === defOf(pc, m).id && l.signal_id === B.id), m).toBe(true);
    }
    // the whole hash is the fresh replay's, in every mode; and every number equals a from-scratch replay
    const fresh = await freshReplay(db, pc); for (const m of ALL) expect(hashOf(db, pc, m, B.id), m).toBe(hashOf(fresh, pc, m, B.id));
    await sameNumbers(db, pc); for (const r of await audit(db, pc)) expect(r.mismatches, r.mode).toBe(0);
  });

  it("test 4: a decision that opened a lot keeps whole-hash comparison — a late exit and a late resolution on it are still detected and replayed", async () => {
    const db = mkDb(); const pc = ROOMY; const P: Sig = { id: E(4), kind: "NEW_POSITION", wallet: "wP", cond: "cp", token: "tP", src: S + 200, ev: S + 210 }; const Q: Sig = { id: E(5), kind: "NEW_POSITION", wallet: "wQ", cond: "cq", token: "tQ", src: S + 300, ev: S + 310 };
    const Z: Sig = { id: E(6), kind: "NEW_POSITION", wallet: "wZ", cond: "cz", token: "tZ", src: S + 3000, ev: S + 3010 };   // decided later: the watermark is past the exit and the resolution, so they rewind
    addMarkets(db, ["cp", "cq", "cz"]); addEntry(db, P); addEntry(db, Q); addEntry(db, Z);
    setClock(S + 3600); await sweepSimulation(db as never); fetchPrices(db); await sweepSimulation(db as never); await run(db, pc); setClock(clock + 900);
    for (const m of ALL) for (const id of [P.id, Q.id]) expect(decisionOf(db, defOf(pc, m).id, id), `${m} ${id}`).toMatchObject({ outcome: expect.stringMatching(/^(FILLED|PARTIALLY_FILLED)$/) });
    const before = ALL.map((m) => [hashOf(db, pc, m, P.id), hashOf(db, pc, m, Q.id)]);
    addExit(db, X(4), P.wallet, P.cond, P.token, S + 600, S + 604, 5000); for (const m of ALL) putObs(db, P.token, timeline(S + 600, S + 604, MODES[m]).fillTs);
    db.insertRow("token_resolutions", { token_id: Q.token, value: 1, resolved_ts: iso(S + 2500) });
    setClock(S + 7200); await sweepSimulation(db as never); setClock(clock + 40);
    const st = await run(db, pc);
    ALL.forEach((m, i) => { expect(hashOf(db, pc, m, P.id), `${m} P exit`).not.toBe(before[i][0]); expect(hashOf(db, pc, m, Q.id), `${m} Q resolution`).not.toBe(before[i][1]); });
    expect(rewound(st).length).toBeGreaterThan(0);
    for (const m of ALL) { const lot = (id: string) => db.T("portfolio_lots").find((l) => l.portfolio_id === defOf(pc, m).id && l.signal_id === id)!; expect(lot(P.id).state, `${m} P`).toMatch(/EXITED/); expect(lot(Q.id).state, `${m} Q`).toBe("RESOLVED"); }
    await sameNumbers(db, pc); for (const r of await audit(db, pc)) expect(r.mismatches, r.mode).toBe(0);
  });

  it("test 5: mixed state — old-format hashes of no-lot decisions cause no rewind, no write and no audit difference, even when every row moves; nothing is re-hashed", async () => {
    const db = mkDb(); await oneSlot(db);
    // the exit arrives later (the 29 Sep shape), so the CURRENT fingerprint of A has an exit while its stored hash is the old format
    addExit(db, X(2), A.wallet, A.cond, A.token, S + 1300, S + 1304, 30); for (const m of ALL) putObs(db, A.token, timeline(S + 1300, S + 1304, MODES[m]).fillTs);
    setClock(S + 7200); await sweepSimulation(db as never);
    const stored = ALL.map((m) => hashOf(db, ONE_SLOT, m, A.id)); for (const h of stored) expect(h.split("|").slice(1)).toEqual(["-@-", "-@-"]);
    // every row moves (what a marks refresh does to a whole mode)
    for (const x of db.T("paper_executions")) x.computed_at = iso(clock);
    const dec = JSON.stringify(db.T("portfolio_decisions")); setClock(clock + 40);
    const st = await run(db, ONE_SLOT);
    expect(rewound(st)).toEqual([]);                                                                                   // nothing rewinds
    for (const s of st) { expect(s.rewind.reasons, s.mode).toEqual([]); expect(s.deletes, s.mode).toEqual({}); }
    // F's lot has the exit? no: the exit is A's (rejected), so no lot changed and the run writes nothing at all
    expect(outWrites(st)).toEqual([0, 0, 0]);
    expect(JSON.stringify(db.T("portfolio_decisions"))).toBe(dec);                                                    // not one stored decision row changed (hash included)
    expect(ALL.map((m) => hashOf(db, ONE_SLOT, m, A.id))).toEqual(stored);
    for (const r of await audit(db, ONE_SLOT)) { expect(r.mismatches, r.mode).toBe(0); expect(r.classes.unexplained.count).toBe(0); }
    await sameNumbers(db, ONE_SLOT);
  });

  it("test 6: a rewind caused by ANOTHER lot's exit still re-decides a rejected signal that depends on that lot", async () => {
    const db = mkDb(); const st1 = await oneSlot(db); void st1;
    for (const m of ALL) expect(decisionOf(db, defOf(ONE_SLOT, m).id, A.id), m).toMatchObject({ outcome: "REJECTED", reason: "REJECTED_MAX_OPEN_POSITIONS" });
    const storedA = ALL.map((m) => hashOf(db, ONE_SLOT, m, A.id));
    // F's linked exit arrives late, but fills long before A does: in a replay F's slot is free when A comes
    const XF = { src: S + 500, ev: S + 504 }; addExit(db, X(1), F.wallet, F.cond, F.token, XF.src, XF.ev, 5000); for (const m of ALL) putObs(db, F.token, timeline(XF.src, XF.ev, MODES[m]).fillTs);
    setClock(S + 7200); await sweepSimulation(db as never); setClock(clock + 40);
    const st = await run(db, ONE_SLOT);
    expect(rewound(st).sort()).toEqual([...ALL].sort());
    for (const m of ALL) {
      expect(decisionOf(db, defOf(ONE_SLOT, m).id, F.id), m).toMatchObject({ outcome: expect.stringMatching(/^(FILLED|PARTIALLY_FILLED)$/) });
      const d = decisionOf(db, defOf(ONE_SLOT, m).id, A.id)!; expect(d, m).toMatchObject({ outcome: expect.stringMatching(/^(FILLED|PARTIALLY_FILLED)$/) });   // re-decided: it now opens a lot
    }
    ALL.forEach((m, i) => { expect(hashOf(db, ONE_SLOT, m, A.id), `${m}: A's own inputs did not change`).toBe(storedA[i]); });   // the replay re-decides it regardless of its hash
    await sameNumbers(db, ONE_SLOT); for (const r of await audit(db, ONE_SLOT)) expect(r.mismatches, r.mode).toBe(0);
  });

  it("the runner and the audit apply the same rule: an entry change on a no-lot decision is one difference in both, an exit change is none in both", async () => {
    const db = mkDb(); await oneSlot(db);
    addExit(db, X(2), A.wallet, A.cond, A.token, S + 1300, S + 1304, 30); for (const m of ALL) putObs(db, A.token, timeline(S + 1300, S + 1304, MODES[m]).fillTs); setClock(S + 7200); await sweepSimulation(db as never);
    for (const r of await audit(db, ONE_SLOT)) expect(r.mismatches, `exit only, ${r.mode}`).toBe(0);
    db.T("signals").find((x) => x.id === A.id)!.source_fill_id = "0xbackfilled";
    for (const r of await audit(db, ONE_SLOT)) { expect(r.mismatches, `entry, ${r.mode}`).toBe(1); expect([...r.classes.unexplained.examples, ...r.classes.nextRun.examples, ...r.classes.d13.examples]).toMatchObject([{ signalId: A.id, parts: ["entry"] }]); }
    void execOf; void byMode; void sec;
  });
});
