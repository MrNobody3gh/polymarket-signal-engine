/** Regressions for the 2026-09-26 audit: /signal prefix lookup, chunked marker reads, break-even labels, re-score scheduling. */
import { describe, it, expect, beforeEach } from "vitest";
import { fakeDb } from "./helpers/fakeDb";
import { loadSignalDetail, loadPaper, uuidPrefixRange } from "@/lib/paper/queries";
import { runMarking, settledStatus, _resetMarkGuards, type MarkSource } from "@/lib/paper/mark";
import { refreshDue, REFRESH_RETRY_SEC } from "@/lib/scoring/refresh";
import { IN_CHUNK } from "@/lib/chunk";

const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const T0 = 1_790_000_000; const iso = (s: number) => new Date(s * 1000).toISOString();

/** Wrap a fake db: record the size of every `.in()` list, and optionally fail every query on one table. */
function instrument(db: ReturnType<typeof fakeDb>, failTable?: string) {
  const inSizes: number[] = [];
  const from = (t: string) => {
    const b = db.from(t); const origIn = b.in;
    b.in = (k: string, vs: unknown[]) => { inSizes.push(vs.length); return origIn(k, vs); };
    if (t === failTable) b.then = (res: (v: unknown) => void) => res({ data: null, error: { message: "414 URI Too Long" } });
    return b;
  };
  return { db: { ...db, from } as never, inSizes };
}

describe("/signal <ref>: uuid prefix lookup (Postgres has no ILIKE on uuid)", () => {
  it("uuidPrefixRange covers exactly the ids with that prefix, dashes optional, and rejects non-hex input", () => {
    expect(uuidPrefixRange("ABCD1234")).toEqual({ lo: "abcd1234-0000-0000-0000-000000000000", hi: "abcd1234-ffff-ffff-ffff-ffffffffffff" });
    expect(uuidPrefixRange("abcd1234-12")).toEqual({ lo: "abcd1234-1200-0000-0000-000000000000", hi: "abcd1234-12ff-ffff-ffff-ffffffffffff" });
    for (const bad of ["", "xyz", "abcd%", "abcd_1", "a".repeat(33)]) expect(uuidPrefixRange(bad)).toBeNull();
  });
  const seed = () => { const db = fakeDb();
    for (const id of ["3f2a9c10-0000-4000-8000-000000000001", "3f2a9c10-ffff-4000-8000-000000000002", "3f2a9c11-0000-4000-8000-000000000003", "3f2a9c0f-ffff-4fff-bfff-ffffffffffff"])
      db.T("paper_ledger").push({ signal_id: id, kind: "NEW_POSITION", signal_ts: iso(T0) });
    db.T("paper_marks").push({ signal_id: "3f2a9c11-0000-4000-8000-000000000003", horizon: "1h", observed_at: iso(T0 + 3600), price: 0.6 });
    return db; };
  it("the 8-character ref printed on every alert resolves to its signal, with its marks", async () => {
    const d = await loadSignalDetail(seed() as never, "3f2a9c11");
    expect(d.row?.signal_id).toBe("3f2a9c11-0000-4000-8000-000000000003"); expect(d.marks).toHaveLength(1); expect(d.ambiguous).toBe(false);
  });
  it("a prefix shared by two signals is ambiguous; neighbours just outside the range never match", async () => {
    expect((await loadSignalDetail(seed() as never, "3f2a9c10")).ambiguous).toBe(true);
    expect((await loadSignalDetail(seed() as never, "3F2A9C10-FFFF")).row?.signal_id).toBe("3f2a9c10-ffff-4000-8000-000000000002");
  });
  it("a full id matches exactly (case-insensitive); unknown and non-hex refs return no record", async () => {
    expect((await loadSignalDetail(seed() as never, "3F2A9C0F-FFFF-4FFF-BFFF-FFFFFFFFFFFF")).row?.signal_id).toBe("3f2a9c0f-ffff-4fff-bfff-ffffffffffff");
    expect((await loadSignalDetail(seed() as never, "deadbeef")).row).toBeNull();
    expect((await loadSignalDetail(seed() as never, "hello")).row).toBeNull();
  });
  it("a failed database query is an error, never reported as 'no record'", async () => {
    const { db } = instrument(seed(), "paper_ledger");
    await expect(loadSignalDetail(db, "3f2a9c11")).rejects.toThrow(/414/);
  });
});

describe("paper reads never put more than IN_CHUNK ids in one URL, and never swallow a failed read", () => {
  const open = (n: number) => { const db = fakeDb();
    for (let i = 1; i <= n; i++) db.T("paper_ledger").push({ signal_id: uid(i), token_id: `t${i}`, condition_id: `c${i}`, entry_price: 0.5, shares: 200, signal_ts: iso(T0), status: "OPEN", mark_checked_at: null });
    return db; };
  const src: MarkSource = { priceAsOf: async (_t, at) => ({ price: 0.55, ts: at - 60, resolutionSeconds: 60 }), resolution: async () => ({ state: "open" }) };
  beforeEach(() => _resetMarkGuards());
  it("marker: 600 open positions → every mark read and stamp chunked, every position marked and stamped once", async () => {
    const base = open(600); const { db, inSizes } = instrument(base);
    const r = await runMarking(db, src, { now: T0 + 2 * 3600 });
    expect(r.positions).toBe(600); expect(r.marks).toBe(600); expect(Math.max(...inSizes)).toBeLessThanOrEqual(IN_CHUNK);
    expect(base.T("paper_ledger").every((x) => x.mark_checked_at === iso(T0 + 2 * 3600))).toBe(true);
    // Second run: existing marks are seen (not re-fetched) because the chunked read returned all of them.
    _resetMarkGuards(); expect((await runMarking(db, src, { now: T0 + 2 * 3600 + 60 })).marks).toBe(0);
  });
  it("marker: if the existing-marks read fails the run aborts — no blind re-fetch, no 'healthy' heartbeat", async () => {
    const base = open(5); const { db } = instrument(base, "paper_marks");
    await expect(runMarking(db, src, { now: T0 + 2 * 3600 })).rejects.toThrow(/414/);
    expect(base.T("cursors").find((c) => c.key === "health:last_mark")).toBeUndefined();
    // …and the process-local overlap guard is released, so the next cycle can run.
    expect((await runMarking(instrument(open(1)).db, src, { now: T0 + 2 * 3600 })).skipped).toBeUndefined();
  });
  it("marker: a failed open-positions read aborts instead of reporting an empty, healthy run", async () => {
    const { db } = instrument(open(3), "paper_ledger");
    await expect(runMarking(db, src, { now: T0 + 2 * 3600 })).rejects.toThrow(/open-positions/);
  });
  it("dashboard loadPaper: 1,200 rows → marks read in chunks of IN_CHUNK; a failed chunk throws", async () => {
    const base = open(1200); for (let i = 1; i <= 1200; i++) base.T("paper_marks").push({ signal_id: uid(i), horizon: "1h", observed_at: iso(T0 + 3600), price: 0.5, pnl: 0, return_pct: 0 });
    const { db, inSizes } = instrument(base); const r = await loadPaper(db);
    expect(r.rows).toHaveLength(1200); expect(r.marks).toHaveLength(1200); expect(Math.max(...inSizes)).toBeLessThanOrEqual(IN_CHUNK);
    await expect(loadPaper(instrument(base, "paper_marks").db)).rejects.toThrow(/414/);
  });
});

describe("settled status", () => {
  it("follows the sign of P&L; exact break-even takes the market outcome instead of defaulting to a loss", () => {
    expect(settledStatus(12.5, false)).toBe("RESOLVED_WIN"); expect(settledStatus(-3, true)).toBe("RESOLVED_LOSS");
    expect(settledStatus(0, true)).toBe("RESOLVED_WIN"); expect(settledStatus(0, false)).toBe("RESOLVED_LOSS");
  });
});

describe("daily re-score scheduling (runs in the worker, 04:15 UTC)", () => {
  const at = (s: string) => Date.parse(s) / 1000;
  it("due once per day after the slot; a restart never repeats a finished day", () => {
    const done = at("2026-09-26T04:20:00Z");
    expect(refreshDue(done, at("2026-09-26T13:00:00Z"))).toBe(false);          // same day, already done
    expect(refreshDue(done, at("2026-09-27T04:14:00Z"))).toBe(false);          // before tomorrow's slot
    expect(refreshDue(done, at("2026-09-27T04:15:00Z"))).toBe(true);           // tomorrow's slot
    expect(refreshDue(at("2026-09-26T03:00:00Z"), at("2026-09-26T05:00:00Z"))).toBe(true); // last run predates today's slot
  });
  it("never run → due now; after a failed attempt, wait REFRESH_RETRY_SEC before retrying", () => {
    const now = at("2026-09-26T10:00:00Z");
    expect(refreshDue(null, now)).toBe(true);
    expect(refreshDue(null, now, now - REFRESH_RETRY_SEC + 60)).toBe(false);
    expect(refreshDue(null, now, now - REFRESH_RETRY_SEC)).toBe(true);
  });
});
