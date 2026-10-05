import { describe, expect, it } from "vitest";
import { isMeasured, isTooLate, planWork, rowKey, type SignalLite } from "@/lib/phase4/shadow/schedule";
import { MAX_LATE_S, OFFSETS_S } from "@/lib/phase4/shadow/config";

const S = (id: string, createdAtSec: number, o: Partial<SignalLite> = {}): SignalLite => ({ id, tokenId: `t-${id}`, kind: "NEW_POSITION", price: 0.5, createdAtSec, copyScore: 70, ...o });
const plan = (signals: SignalLite[], have: string[], now: number, o: Partial<Parameters<typeof planWork>[3]> = {}) => planWork(signals, new Set(have), now, { minScore: 0, maxSnapshots: 20, maxMissed: 200, ...o });
const ids = (d: { signalId: string; offsetS: number }[]) => d.map((x) => `${x.signalId}@${x.offsetS}`);

describe("the offsets and the lateness rule are the proposed constants (D106)", () => {
  it("0 / 60 / 300 seconds, and a snapshot more than 120 s late is MISSED", () => { expect([...OFFSETS_S]).toEqual([0, 60, 300]); expect(MAX_LATE_S).toBe(120); });
});

describe("planWork: what is due, late or done", () => {
  it("nothing is due before created_at + offset; each offset becomes due exactly at its time", () => {
    expect(plan([S("a", 1000)], [], 999).snapshots).toEqual([]);
    expect(ids(plan([S("a", 1000)], [], 1000).snapshots)).toEqual(["a@0"]);
    expect(ids(plan([S("a", 1000)], [], 1059).snapshots)).toEqual(["a@0"]); // offset 60 not yet due at 1059
    expect(ids(plan([S("a", 1000)], [], 1060).snapshots)).toEqual(["a@0", "a@60"]);
    expect(ids(plan([S("a", 1000)], [rowKey("a", 0), rowKey("a", 60)], 1300).snapshots)).toEqual(["a@300"]);
  });
  it("exactly 120 s late is still a snapshot; 121 s late is MISSED with no data", () => {
    const p = plan([S("a", 1000)], [rowKey("a", 60), rowKey("a", 300)], 1000 + 120); expect(ids(p.snapshots)).toEqual(["a@0"]); expect(p.missed).toEqual([]);
    const q = plan([S("a", 1000)], [rowKey("a", 60), rowKey("a", 300)], 1000 + 121); expect(q.snapshots).toEqual([]); expect(ids(q.missed)).toEqual(["a@0"]);
    expect(isTooLate(1000, 1120)).toBe(false); expect(isTooLate(1000, 1121)).toBe(true);
  });
  it("a row that exists is never planned again (idempotent), whatever its status", () => {
    const have = [rowKey("a", 0), rowKey("a", 60)]; const p = plan([S("a", 1000)], have, 1100); expect(p.snapshots).toEqual([]); expect(p.missed).toEqual([]);
    const all = plan([S("a", 1000)], [], 1100); const after = plan([S("a", 1000)], [...ids(all.snapshots).map((x) => rowKey(x.split("@")[0], Number(x.split("@")[1])))], 1100); expect(after.snapshots).toEqual([]);
  });
  it("a restart (empty memory, same database rows) plans exactly what the first process would have", () => {
    const sig = [S("a", 1000), S("b", 1030)]; const have = [rowKey("a", 0)]; const first = plan(sig, have, 1100); const second = plan(sig, have, 1100);
    expect(second).toEqual(first); expect(ids(first.snapshots)).toEqual(["b@0", "a@60", "b@60"]);
  });
  it("a long outage becomes MISSED rows (never late snapshots), and the missed list is capped per cycle", () => {
    const sig = Array.from({ length: 10 }, (_, i) => S(`s${i}`, 1000 + i)); const p = plan(sig, [], 5000, { maxMissed: 7 });
    expect(p.snapshots).toEqual([]); expect(p.missed).toHaveLength(7); expect(ids(p.missed)[0]).toBe("s0@0");
  });
  it("oldest due first, snapshots capped per cycle; the cap never turns a due snapshot into data from a later time", () => {
    const sig = Array.from({ length: 30 }, (_, i) => S(`s${String(i).padStart(2, "0")}`, 1000 + i)); const p = plan(sig, [], 1030, { maxSnapshots: 20 });
    expect(p.snapshots).toHaveLength(20); expect(p.snapshots.map((d) => d.dueAtSec)).toEqual([...p.snapshots.map((d) => d.dueAtSec)].sort((a, b) => a - b)); expect(ids(p.snapshots)[0]).toBe("s00@0");
  });
  it("EXIT signals are never measured; the minimum score is inclusive, and a signal without a score is excluded only when a minimum is set", () => {
    expect(isMeasured(S("a", 0, { kind: "EXIT" }), 0)).toBe(false);
    expect(isMeasured(S("a", 0, { copyScore: 68 }), 68)).toBe(true); expect(isMeasured(S("a", 0, { copyScore: 67.9 }), 68)).toBe(false);
    expect(isMeasured(S("a", 0, { copyScore: null }), 0)).toBe(true); expect(isMeasured(S("a", 0, { copyScore: null }), 1)).toBe(false);
    for (const kind of ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"]) expect(isMeasured(S("a", 0, { kind }), 0)).toBe(true);
    expect(plan([S("a", 1000, { kind: "EXIT" })], [], 1100).snapshots).toEqual([]);
  });
});
