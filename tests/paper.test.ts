import { describe, it, expect, vi } from "vitest";
import { buildPaperRow, sharesFor, pnlFor, returnFor, isValidPrice, recordPaperSignal, closePaperPositions, type SignalForPaper } from "@/lib/paper/ledger";
import { dueHorizons, parseGammaResolution, runMarking, type MarkSource } from "@/lib/paper/mark";
import { computeStats, byKind, byScoreBand, byConsensusDepth, byWallet, currentReturn, type PaperRowLite, type MarkLite } from "@/lib/paper/analytics";
import { assessHealth } from "@/lib/health/assess";

const NOW_ISO = "2026-09-18T12:00:00.000Z"; const NOW = Math.floor(Date.parse(NOW_ISO) / 1000);
const sig = (o: Partial<SignalForPaper> = {}): SignalForPaper => ({ id: "11111111-1111-4111-8111-111111111111", kind: "NEW_POSITION", severity: 3, wallet: "0xabc", wallet_name: "crckr", condition_id: "0xc1", token_id: "tok1", outcome: "3DMAX", title: "CS: BBL vs 3DMAX", slug: "bbl-3dmax", price: 0.56, usd: 5000, payload: { copyScore: 57, wallets: 4 }, created_at: NOW_ISO, ...o });

/** Minimal in-memory Supabase stand-in covering the query shapes the paper modules use. */
function fakeDb(seed: { paper_ledger?: Record<string, unknown>[]; paper_marks?: Record<string, unknown>[] } = {}) {
  const tables: Record<string, Record<string, unknown>[]> = { paper_ledger: seed.paper_ledger ?? [], paper_marks: seed.paper_marks ?? [], data_quality_issues: [], positions: [], consensus_events: [], cursors: [] };
  const pk: Record<string, string[]> = { paper_ledger: ["signal_id"], paper_marks: ["signal_id", "horizon"], consensus_events: ["signal_id"], cursors: ["key"] };
  const keyOf = (t: string, r: Record<string, unknown>) => (pk[t] ?? []).map((k) => String(r[k])).join("|");
  function query(t: string) {
    const filters: ((r: Record<string, unknown>) => boolean)[] = []; let mode: "select" | "update" = "select"; let patch: Record<string, unknown> = {}; let lim = Infinity;
    const q: Record<string, unknown> = {
      select: () => q, order: () => q, limit: (n: number) => { lim = n; return q; }, maybeSingle: async () => { const r = tables[t].filter((x) => filters.every((f) => f(x))); return { data: r[0] ?? null, error: null }; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; }, lt: (k: string, v: string) => { filters.push((r) => String(r[k]) < v); return q; }, in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      update: (p: Record<string, unknown>) => { mode = "update"; patch = p; return q; },
      then: (res: (v: unknown) => void) => { const rows = tables[t].filter((x) => filters.every((f) => f(x))).slice(0, lim); if (mode === "update") { for (const r of rows) Object.assign(r, patch); res({ data: rows, error: null }); } else res({ data: rows, error: null }); },
      insert: async (r: Record<string, unknown>) => { if (pk[t] && tables[t].some((x) => keyOf(t, x) === keyOf(t, r))) return { error: { code: "23505", message: "dup" } }; tables[t].push({ ...r }); return { error: null }; },
      upsert: async (r: Record<string, unknown>) => { const i = tables[t].findIndex((x) => keyOf(t, x) === keyOf(t, r)); if (i >= 0) tables[t][i] = { ...tables[t][i], ...r }; else tables[t].push({ ...r }); return { error: null }; },
    };
    return q;
  }
  return { tables, from: (t: string) => query(t) } as unknown as import("@supabase/supabase-js").SupabaseClient & { tables: typeof tables };
}

describe("paper ledger: sizing and semantics", () => {
  it("sizes a $100 long correctly and records the entry", () => {
    const { row, issues } = buildPaperRow(sig()); expect(issues).toEqual([]); expect(row!.status).toBe("OPEN"); expect(row!.side).toBe("LONG");
    expect(row!.shares).toBeCloseTo(100 / 0.56, 6); expect(row!.entry_price).toBe(0.56); expect(row!.size_usd).toBe(100); expect(row!.copy_score).toBe(57); expect(row!.consensus_depth).toBe(4); expect(row!.trade_usd).toBe(5000);
  });
  it("honours a custom size", () => { expect(buildPaperRow(sig(), 250).row!.shares).toBeCloseTo(250 / 0.56, 6); });
  it("records an EXIT as an exit event, not a position", () => { const { row } = buildPaperRow(sig({ kind: "EXIT" })); expect(row!.side).toBe("EXIT_EVENT"); expect(row!.shares).toBe(0); expect(row!.status).toBe("EXIT_EVENT"); });
  it("flags invalid and out-of-bounds prices instead of sizing them", () => {
    const a = buildPaperRow(sig({ price: 0 })); expect(a.row!.status).toBe("INVALID"); expect(a.issues.map((i) => i.kind)).toContain("price_out_of_bounds");
    const b = buildPaperRow(sig({ price: Number.NaN })); expect(b.row!.status).toBe("INVALID"); expect(b.issues.map((i) => i.kind)).toContain("invalid_price");
    expect(isValidPrice(1)).toBe(false); expect(isValidPrice(0.5)).toBe(true);
  });
  it("flags missing wallet, missing market and zero size", () => {
    const { row, issues } = buildPaperRow(sig({ wallet: "", token_id: "", usd: 0 }));
    expect(issues.map((i) => i.kind).sort()).toEqual(["invalid_size", "missing_market", "missing_wallet"]); expect(row!.status).toBe("INVALID");
  });
  it("prevents duplicate paper entries and logs the duplicate", async () => {
    const db = fakeDb(); const a = await recordPaperSignal(db, sig()); const b = await recordPaperSignal(db, sig());
    expect(a.inserted).toBe(true); expect(b.inserted).toBe(false); expect(b.issues.map((i) => i.kind)).toContain("duplicate_paper"); expect(db.tables.paper_ledger).toHaveLength(1); expect(db.tables.data_quality_issues.some((i) => i.kind === "duplicate_paper")).toBe(true);
  });
  it("EXIT closes earlier open longs of the same wallet+token at the exit price", async () => {
    const db = fakeDb(); await recordPaperSignal(db, sig({ id: "aaaaaaaa-1111-4111-8111-111111111111", created_at: "2026-09-18T10:00:00.000Z", price: 0.5 }));
    const r = await recordPaperSignal(db, sig({ id: "bbbbbbbb-1111-4111-8111-111111111111", kind: "EXIT", price: 0.6, created_at: "2026-09-18T11:00:00.000Z" }));
    expect(r.closed).toBe(1); const closed = db.tables.paper_ledger.find((p) => p.signal_id === "aaaaaaaa-1111-4111-8111-111111111111")!;
    expect(closed.status).toBe("EXITED"); expect(Number(closed.final_pnl)).toBeCloseTo(200 * 0.1, 6); expect(Number(closed.final_return)).toBeCloseTo(0.2, 6);
    expect(db.tables.paper_marks.find((m) => m.horizon === "exit")).toBeTruthy();
    expect(await closePaperPositions(db, "0xabc", "tok1", Number.NaN, NOW_ISO, "x")).toBe(0);
  });
});

describe("P&L math", () => {
  const sh = sharesFor(100, 0.56);
  it("positive, negative, zero", () => { expect(pnlFor(sh, 0.56, 0.6)).toBeCloseTo(sh * 0.04, 6); expect(pnlFor(sh, 0.56, 0.5)).toBeLessThan(0); expect(pnlFor(sh, 0.56, 0.56)).toBe(0); expect(returnFor(0.56, 0.6)).toBeCloseTo(0.0714, 3); });
  it("resolution to 1 and 0", () => { expect(pnlFor(sh, 0.56, 1)).toBeCloseTo(100 / 0.56 - 100, 4); expect(pnlFor(sh, 0.56, 0)).toBeCloseTo(-100, 4); });
});

describe("marking", () => {
  const open = { signal_id: "s1", token_id: "tok1", condition_id: "0xc1", entry_price: 0.56, shares: sharesFor(100, 0.56), signal_ts: "2026-09-18T00:00:00.000Z" };
  it("dueHorizons only returns elapsed, un-marked horizons", () => {
    const t0 = Math.floor(Date.parse(open.signal_ts) / 1000);
    expect(dueHorizons(open, new Set(), t0 + 30 * 60).map((h) => h.key)).toEqual([]);
    expect(dueHorizons(open, new Set(), t0 + 2 * 3600).map((h) => h.key)).toEqual(["1h"]);
    expect(dueHorizons(open, new Set(["1h"]), t0 + 7 * 3600).map((h) => h.key)).toEqual(["6h"]);
    expect(dueHorizons(open, new Set(), t0 + 25 * 3600).map((h) => h.key)).toEqual(["1h", "6h", "24h"]);
  });
  it("records 1h/6h/24h marks with P&L, is idempotent, and logs a missing price instead of writing zero", async () => {
    const db = fakeDb({ paper_ledger: [{ ...open, status: "OPEN" }] });
    const prices: Record<number, number | null> = { 3600: 0.57, 21600: null, 86400: 0.63 };
    const src: MarkSource = { priceAsOf: vi.fn(async (_t, at) => prices[at - Math.floor(Date.parse(open.signal_ts) / 1000)] ?? null), resolution: async () => ({ state: "open" }) };
    const r1 = await runMarking(db, src, { now: Math.floor(Date.parse(open.signal_ts) / 1000) + 25 * 3600 });
    expect(r1.marks).toBe(2); expect(r1.failed).toBe(1);
    const m1 = db.tables.paper_marks.find((m) => m.horizon === "1h")!; expect(Number(m1.price)).toBe(0.57); expect(Number(m1.pnl)).toBeCloseTo(sharesFor(100, 0.56) * 0.01, 6);
    expect(db.tables.data_quality_issues.some((i) => i.kind === "mark_failed")).toBe(true);
    const r2 = await runMarking(db, src, { now: Math.floor(Date.parse(open.signal_ts) / 1000) + 25 * 3600 });
    expect(r2.marks).toBe(0); expect(db.tables.paper_marks).toHaveLength(2); // second run adds nothing
  });
  it("settles a resolved market as WIN/LOSS and never re-settles", async () => {
    const db = fakeDb({ paper_ledger: [{ ...open, status: "OPEN" }] });
    const src: MarkSource = { priceAsOf: async () => 0.9, resolution: async () => ({ state: "resolved", won: true, finalPrice: 1, source: "gamma" }) };
    const r = await runMarking(db, src, { now: Math.floor(Date.parse(open.signal_ts) / 1000) + 30 * 3600 });
    expect(r.settled).toBe(1); const row = db.tables.paper_ledger[0]; expect(row.status).toBe("RESOLVED_WIN"); expect(Number(row.final_pnl)).toBeCloseTo(100 / 0.56 - 100, 4);
    expect(db.tables.paper_marks.find((m) => m.horizon === "resolution")).toBeTruthy();
    const r2 = await runMarking(db, src, { now: Math.floor(Date.parse(open.signal_ts) / 1000) + 31 * 3600 }); expect(r2.settled).toBe(0); expect(r2.positions).toBe(0);
  });
  it("keeps an unresolvable market OPEN with a logged reason (no silent zero)", async () => {
    const db = fakeDb({ paper_ledger: [{ ...open, status: "OPEN" }] });
    const src: MarkSource = { priceAsOf: async () => 0.5, resolution: async () => ({ state: "unknown", reason: "resolution_unparseable", raw: { x: 1 } }) };
    const r = await runMarking(db, src, { now: Math.floor(Date.parse(open.signal_ts) / 1000) + 2 * 3600 });
    expect(r.unresolved).toBe(1); expect(db.tables.paper_ledger[0].status).toBe("OPEN"); expect(db.tables.data_quality_issues.some((i) => i.kind === "resolution_unparseable")).toBe(true);
  });
  it("marks a stale (>30d unresolved) position UNRESOLVED", async () => {
    const db = fakeDb({ paper_ledger: [{ ...open, status: "OPEN" }] });
    const src: MarkSource = { priceAsOf: async () => 0.5, resolution: async () => ({ state: "unknown", reason: "market_not_found" }) };
    await runMarking(db, src, { now: Math.floor(Date.parse(open.signal_ts) / 1000) + 31 * 86400 });
    expect(db.tables.paper_ledger[0].status).toBe("UNRESOLVED"); expect(db.tables.paper_ledger[0].status_reason).toBe("market_not_found");
  });
  it("parses Gamma resolution for the right token, and refuses to guess", () => {
    const m = { closed: true, clobTokenIds: '["tokA","tokB"]', outcomePrices: '["1","0"]' };
    expect(parseGammaResolution(m, "tokA")).toMatchObject({ state: "resolved", won: true, finalPrice: 1 });
    expect(parseGammaResolution(m, "tokB")).toMatchObject({ state: "resolved", won: false, finalPrice: 0 });
    expect(parseGammaResolution({ closed: false, clobTokenIds: '["tokA"]', outcomePrices: '["0.6"]' }, "tokA")).toEqual({ state: "open" });
    expect(parseGammaResolution({ closed: true, clobTokenIds: '["tokA","tokB"]', outcomePrices: '["0.5","0.5"]' }, "tokA").state).toBe("unknown");
    expect(parseGammaResolution(m, "tokZ").state).toBe("unknown"); expect(parseGammaResolution(null, "tokA")).toMatchObject({ state: "unknown", reason: "market_not_found" });
  });
});

describe("analytics", () => {
  const row = (o: Partial<PaperRowLite>): PaperRowLite => ({ signal_id: "x", wallet: "0xabc", wallet_name: "crckr", kind: "NEW_POSITION", token_id: "t", title: "M", outcome: "Yes", signal_ts: NOW_ISO, entry_price: 0.5, shares: 200, size_usd: 100, copy_score: 57, consensus_depth: null, status: "OPEN", final_pnl: null, final_return: null, ...o });
  const rows: PaperRowLite[] = [
    row({ signal_id: "a", status: "RESOLVED_WIN", final_pnl: 100, final_return: 1 }), row({ signal_id: "b", status: "RESOLVED_LOSS", final_pnl: -100, final_return: -1, kind: "CONSENSUS", consensus_depth: 3, copy_score: 72 }),
    row({ signal_id: "c", status: "EXITED", final_pnl: 20, final_return: 0.2, wallet: "0xdef", wallet_name: "whig", kind: "CONVICTION_ADD", copy_score: 85 }), row({ signal_id: "d" }), row({ signal_id: "e", status: "EXIT_EVENT", kind: "EXIT", shares: 0 }), row({ signal_id: "f", kind: "CONSENSUS", consensus_depth: 5, copy_score: null }),
  ];
  const marks: MarkLite[] = [{ signal_id: "d", horizon: "1h", observed_at: NOW_ISO, price: 0.55, pnl: 10, return_pct: 0.1 }, { signal_id: "a", horizon: "1h", observed_at: NOW_ISO, price: 0.4, pnl: -20, return_pct: -0.2 }];
  it("aggregates: settled beats mark, EXIT events excluded, win rate on settled only", () => {
    const s = computeStats(rows, marks);
    expect(s.signals).toBe(5); expect(s.open).toBe(2); expect(s.resolved).toBe(2); expect(s.exited).toBe(1); expect(s.observed).toBe(4);
    expect(s.pnl).toBeCloseTo(100 - 100 + 20 + 10, 6); expect(s.winRate).toBeCloseTo(2 / 3, 6); expect(s.lossRate).toBeCloseTo(1 / 3, 6);
    expect(s.avgWin).toBeCloseTo(0.6, 6); expect(s.avgLoss).toBe(-1); expect(s.medianReturn).toBeCloseTo(0.15, 6); expect(s.best!.id).toBe("a"); expect(s.worst!.id).toBe("b"); expect(s.insufficient).toBe(true);
    expect(currentReturn(rows[0], marks)!.basis).toBe("settled"); expect(currentReturn(rows[3], marks)!.basis).toBe("mark"); expect(currentReturn(rows[5], marks)).toBeNull();
  });
  it("breaks down by kind, score band, consensus depth and wallet", () => {
    expect(byKind(rows, marks).map((k) => [k.key, k.stats.signals])).toEqual(expect.arrayContaining([["NEW_POSITION", 2], ["CONSENSUS", 2], ["CONVICTION_ADD", 1]]));
    const sb = byScoreBand(rows, marks); expect(sb.map((k) => k.key)).toEqual(["40–59", "60–79", "80–100", "unscored"]); expect(sb[0].stats.signals).toBe(2);
    const cd = byConsensusDepth(rows, marks); expect(cd.map((k) => [k.key, k.stats.signals])).toEqual([["3 wallets", 1], ["5+ wallets", 1]]);
    const bw = byWallet(rows, marks); expect(bw[0].key).toBe("0xabc"); expect(bw[0].name).toBe("crckr"); expect(bw[0].stats.signals).toBe(4); expect(bw[1].stats.pnl).toBe(20); expect(bw[0].kinds.length).toBeGreaterThan(0);
  });
  it("empty input yields nulls, not zeros", () => { const s = computeStats([], []); expect(s.avgReturn).toBeNull(); expect(s.winRate).toBeNull(); expect(s.best).toBeNull(); expect(s.pnl).toBe(0); });
});

describe("health", () => {
  const iso = (secAgo: number) => new Date((NOW - secAgo) * 1000).toISOString();
  it("healthy when everything is fresh", () => { const h = assessHealth({ hb: { ws_connected: "true", last_trade: iso(18), last_eval: iso(12), last_db_write: iso(12), last_tg_delivery: iso(20), last_mark: iso(480) }, dbOk: true, now: NOW }); expect(h.healthy).toBe(true); expect(h.lines.find((l) => l.name === "Last trade")!.detail).toBe("18 sec ago"); });
  it("warns on a connected-but-silent websocket", () => { const h = assessHealth({ hb: { ws_connected: "true", last_trade: iso(5 * 60 + 1), last_eval: iso(12), last_db_write: iso(12), last_mark: iso(60) }, dbOk: true, now: NOW }); expect(h.healthy).toBe(false); expect(h.lines.find((l) => l.name === "WebSocket")!.level).toBe("warn"); });
  it("flags a disconnected websocket, failed db and stale marker", () => {
    const h = assessHealth({ hb: { ws_connected: "false", last_trade: iso(10), last_eval: iso(10), last_db_write: iso(10), last_mark: iso(3 * 3600) }, dbOk: false, now: NOW });
    expect(h.lines.find((l) => l.name === "WebSocket")!.level).toBe("down"); expect(h.lines.find((l) => l.name === "Database")!.level).toBe("down"); expect(h.lines.find((l) => l.name === "Last paper mark")!.level).toBe("warn");
  });
  it("missing heartbeats read as never, not ok", () => { const h = assessHealth({ hb: {}, dbOk: true, now: NOW }); expect(h.healthy).toBe(false); expect(h.lines.find((l) => l.name === "Last paper mark")!.detail).toBe("never"); });
});
