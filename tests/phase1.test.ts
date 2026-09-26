/**
 * Phase 1 — signal correctness regression tests. Each describe block maps to one numbered fix in the brief.
 */
import { describe, it, expect, vi } from "vitest";
import { fakeDb } from "./helpers/fakeDb";
import { SignalEngine } from "@/lib/signals/engine";
import { applyFill, evaluate, consensusKey, DEFAULT_CONFIG } from "@/lib/signals/rules";
import { explainFill, normalizeFill, withOccurrence, parseRemotePosition } from "@/lib/polymarket/client";
import { parseGammaEndDate, type MarketMetaSource } from "@/lib/polymarket/markets";
import { pollOnce, readSince } from "@/lib/signals/poll";
import type { Fill, Position, WalletProfile } from "@/lib/polymarket/types";

const NOW = 1_790_000_000;
const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), C = "0x" + "c".repeat(40), D = "0x" + "d".repeat(40), E = "0x" + "e".repeat(40), F_ = "0x" + "f".repeat(40);
const profile = (address: string, o: Partial<WalletProfile> = {}): WalletProfile => ({ address, name: address.slice(0, 6), copyScore: 70, pnl90d: 100_000, style: "Selective directional", fillsPerDay: 10, programShare: 0.01, concentration: 0.1, netDd: 20, monthsUp: 3, monthsTotal: 3, daysIdle: 0, tradeCount: 1000, sources: [], ...o });
let seq = 0;
const fill = (o: Partial<Fill> = {}): Fill => { const f = { wallet: A, conditionId: "0xcond", tokenId: "tok1", side: "BUY" as const, size: 10_000, price: 0.3, usd: 3000, ts: NOW, title: "Will X?", slug: "will-x", outcome: "Yes", tx: "0xtx" + ++seq, source: "rest" as const, ...o }; return { id: `${f.tx}:${f.tokenId}:${f.wallet}:${f.ts}:${f.side}:${f.size}:${f.price}`, ...f } as Fill; };
const noMeta: MarketMetaSource = { endDate: async () => null };
function engineOn(db: ReturnType<typeof fakeDb>, wallets: WalletProfile[], o: { markets?: MarketMetaSource; now?: number } = {}) {
  const e = new SignalEngine({ db: db as never, channels: {}, markets: o.markets ?? noMeta, now: () => o.now ?? NOW });
  for (const w of wallets) (e as unknown as { wallets: Map<string, WalletProfile> }).wallets.set(w.address, w);
  return e;
}
const kinds = (xs: { kind: string }[]) => xs.map((x) => x.kind).sort();

// ───────────────────────────────── 1. consensus dedupe
describe("1. consensus deduplication is keyed on the participant set", () => {
  const w = profile(A);
  const ctx = (peers: { wallet: string; lastBuyTs: number | null; copyScore: number }[], f = fill()) => ({ fill: f, wallet: w, before: null, consensus: { peers }, medianFillUsd: null, hasOpenSignal: false, endDate: null, now: NOW });
  const cons = (s: ReturnType<typeof evaluate>) => s.find((x) => x.kind === "CONSENSUS")!;
  it("same token + same wallets → same key (deduped)", () => {
    expect(cons(evaluate(ctx([{ wallet: B, lastBuyTs: NOW - 60, copyScore: 60 }, { wallet: C, lastBuyTs: NOW - 90, copyScore: 60 }]))).dedupeKey)
      .toBe(cons(evaluate(ctx([{ wallet: B, lastBuyTs: NOW - 30, copyScore: 60 }, { wallet: C, lastBuyTs: NOW - 10, copyScore: 60 }], fill({ ts: NOW + 600 })))).dedupeKey);
  });
  it("same token + different wallets + same count → different keys", () => {
    const k1 = cons(evaluate(ctx([{ wallet: B, lastBuyTs: NOW - 60, copyScore: 60 }, { wallet: C, lastBuyTs: NOW - 60, copyScore: 60 }]))).dedupeKey;
    const k2 = cons(evaluate(ctx([{ wallet: D, lastBuyTs: NOW - 60, copyScore: 60 }, { wallet: E, lastBuyTs: NOW - 60, copyScore: 60 }]))).dedupeKey;
    expect(k1).not.toBe(k2); expect(consensusKey("tok1", [A, B, C])).not.toBe(consensusKey("tok1", [D, E, F_]));
  });
  it("ordering of wallets does not matter", () => { expect(consensusKey("tok1", [C, A, B])).toBe(consensusKey("tok1", [B, C, A])); expect(consensusKey("tok1", [A.toUpperCase().replace("0X", "0x"), B])).toBe(consensusKey("tok1", [B, A])); });
  it("duplicate rows / repeat fills from one wallet do not inflate participants", () => {
    const s = cons(evaluate(ctx([{ wallet: B, lastBuyTs: NOW - 60, copyScore: 60 }, { wallet: B, lastBuyTs: NOW - 30, copyScore: 60 }])));
    expect(s.payload.wallets).toBe(2); expect(s.dedupeKey).toBe(consensusKey("tok1", [A, B]));
  });
  it("engine: a second group of the same size on the same token fires; the same group firing again does not", async () => {
    const db = fakeDb(); const e = engineOn(db, [A, B, C, D].map((x) => profile(x)));
    await e.ingest(fill({ wallet: A, ts: NOW - 100 })); const s1 = await e.ingest(fill({ wallet: B, ts: NOW - 50 }));
    expect(kinds(s1)).toContain("CONSENSUS"); // {A,B}
    await e.ingest(fill({ wallet: A, side: "SELL", ts: NOW - 40 })); await e.ingest(fill({ wallet: B, side: "SELL", ts: NOW - 40 }));
    await e.ingest(fill({ wallet: C, ts: NOW - 30 })); const s2 = await e.ingest(fill({ wallet: D, ts: NOW - 20 }));
    expect(kinds(s2)).toContain("CONSENSUS"); // {C,D} — previously blocked by CONS:tok1:2
    const again = await e.ingest(fill({ wallet: D, ts: NOW - 10, size: 20_000, usd: 6000 }));
    expect(kinds(again)).not.toContain("CONSENSUS"); // {C,D} already fired
    expect(db.T("signals").filter((s) => s.kind === "CONSENSUS")).toHaveLength(2);
  });
});

// ───────────────────────────────── 2. last BUY vs last fill
describe("2. lastBuyTs is updated by BUYs only", () => {
  it("A: buy at T1, sell at T2 → lastBuyTs stays T1", () => {
    const p1 = applyFill(null, fill({ ts: 100 }), null); const p2 = applyFill(p1, fill({ side: "SELL", size: 2000, ts: 200 }), null);
    expect(p2.lastBuyTs).toBe(100); expect(p2.lastSellTs).toBe(200); expect(p2.lastSeen).toBe(200); expect(p2.size).toBe(8000);
  });
  it("B: a SELL with no BUY never makes a wallet a recent buyer", () => { const p = applyFill(null, fill({ side: "SELL", ts: 100 }), null); expect(p.lastBuyTs).toBeNull(); });
  it("C: two wallets buying inside the window qualify", async () => {
    const db = fakeDb(); const e = engineOn(db, [profile(A), profile(B)]);
    await e.ingest(fill({ wallet: A, ts: NOW - 3600 })); expect(kinds(await e.ingest(fill({ wallet: B, ts: NOW })))).toContain("CONSENSUS");
  });
  it("D: bought outside the window but sold recently → not a recent buyer", async () => {
    const db = fakeDb(); const e = engineOn(db, [profile(A), profile(B)]);
    await e.ingest(fill({ wallet: A, ts: NOW - 100 * 3600, size: 20_000, usd: 6000 }));
    await e.ingest(fill({ wallet: A, side: "SELL", size: 1000, usd: 300, ts: NOW - 60 })); // still holds 19k
    const row = db.T("positions").find((r) => r.wallet === A)!;
    expect(row.last_buy_ts).toBe(new Date((NOW - 100 * 3600) * 1000).toISOString()); expect(row.last_sell_ts).toBe(new Date((NOW - 60) * 1000).toISOString());
    expect(kinds(await e.ingest(fill({ wallet: B, ts: NOW })))).not.toContain("CONSENSUS");
  });
  it("a position known only from reconciliation (no observed buy) does not count as a recent buyer", () => {
    const s = evaluate({ fill: fill(), wallet: profile(A), before: null, consensus: { peers: [{ wallet: B, lastBuyTs: null, copyScore: 60 }] }, medianFillUsd: null, hasOpenSignal: false, endDate: null, now: NOW });
    expect(kinds(s)).not.toContain("CONSENSUS");
  });
});

// ───────────────────────────────── 3. EARLY_ENTRY
describe("3. EARLY_ENTRY uses authoritative market metadata", () => {
  const early = { price: 0.2, size: 5000, usd: 1000 }; // $1k: early-entry size floor is 4×$50, below NEW_POSITION's $2k
  const inDays = (d: number) => new Date((NOW + d * 86400) * 1000).toISOString().slice(0, 10);
  it("fires when metadata gives an end date inside the window", async () => {
    const meta = { endDate: vi.fn(async () => inDays(10)) };
    const db = fakeDb(); const s = await engineOn(db, [profile(A)], { markets: meta }).ingest(fill(early));
    expect(kinds(s)).toContain("EARLY_ENTRY"); expect(meta.endDate).toHaveBeenCalledWith("0xcond");
    expect(db.T("positions")[0].end_date).toBe(inDays(10)); // persisted for later fills / restarts
  });
  it("missing end date → no EARLY_ENTRY", async () => { expect(kinds(await engineOn(fakeDb(), [profile(A)]).ingest(fill(early)))).not.toContain("EARLY_ENTRY"); });
  it("end date outside the window → no EARLY_ENTRY", async () => { expect(kinds(await engineOn(fakeDb(), [profile(A)], { markets: { endDate: async () => inDays(60) } }).ingest(fill(early)))).not.toContain("EARLY_ENTRY"); });
  it("end date in the past → no EARLY_ENTRY", async () => { expect(kinds(await engineOn(fakeDb(), [profile(A)], { markets: { endDate: async () => inDays(-2) } }).ingest(fill(early)))).not.toContain("EARLY_ENTRY"); });
  it("price above threshold → no EARLY_ENTRY", async () => { expect(kinds(await engineOn(fakeDb(), [profile(A)], { markets: { endDate: async () => inDays(10) } }).ingest(fill({ ...early, price: 0.5, usd: 2500 })))).not.toContain("EARLY_ENTRY"); });
  it("insufficient wallet history (under 2 months) → no EARLY_ENTRY", async () => { expect(kinds(await engineOn(fakeDb(), [profile(A, { monthsUp: 1, monthsTotal: 1 })], { markets: { endDate: async () => inDays(10) } }).ingest(fill(early)))).not.toContain("EARLY_ENTRY"); });
  it("metadata lookup failure is safe (no signal, no crash)", async () => { expect(kinds(await engineOn(fakeDb(), [profile(A)], { markets: { endDate: async () => { throw new Error("gamma down"); } } }).ingest(fill(early)))).not.toContain("EARLY_ENTRY"); });
  it("Gamma end-date parsing never invents a date", () => {
    expect(parseGammaEndDate({ endDateIso: "2026-10-01" })).toBe("2026-10-01"); expect(parseGammaEndDate({ endDate: "2026-10-01T12:00:00Z" })).toBe("2026-10-01");
    expect(parseGammaEndDate({ endDate: "soon" })).toBeNull(); expect(parseGammaEndDate({})).toBeNull(); expect(parseGammaEndDate(null)).toBeNull();
  });
});

// ───────────────────────────────── 4. startup bootstrap
describe("4. startup reconciliation from /v2/positions", () => {
  const remote = (o: Partial<Record<string, unknown>> = {}) => parseRemotePosition({ proxy_wallet: A, condition_id: "0xcond", token_id: "tok1", outcome: "Yes", title: "Will X?", status: "OPEN", current_size: 10_000, avg_price: 0.35, entry_cost_usdc: 3500, last_event_at: NOW - 86400, ...o }, A)!;
  it("existing position + new BUY → CONVICTION_ADD, not NEW_POSITION", async () => {
    const db = fakeDb(); const e = engineOn(db, [profile(A)]);
    expect(await e.reconcileWallet(A, [remote()], { freshSec: 0 })).toMatchObject({ upserted: 1, zeroed: 0 });
    const s = await e.ingest(fill({ size: 6000, price: 0.33, usd: 1980 }));
    expect(kinds(s)).toEqual(["CONVICTION_ADD"]); expect(db.T("positions")[0].size).toBe(16_000);
  });
  it("no existing position + new BUY → NEW_POSITION", async () => {
    const db = fakeDb(); const e = engineOn(db, [profile(A)]); await e.reconcileWallet(A, [], { freshSec: 0 });
    expect(kinds(await e.ingest(fill()))).toContain("NEW_POSITION"); expect(db.T("positions")).toHaveLength(1);
  });
  it("existing position + SELL → reduced size", async () => {
    const db = fakeDb(); const e = engineOn(db, [profile(A)]); await e.reconcileWallet(A, [remote()], { freshSec: 0 });
    await e.ingest(fill({ side: "SELL", size: 4000, price: 0.4, usd: 1600 })); expect(db.T("positions")[0].size).toBe(6000);
  });
  it("restart with the same positions → no duplication, second pass is a no-op", async () => {
    const db = fakeDb(); await engineOn(db, [profile(A)]).reconcileWallet(A, [remote()], { freshSec: 0 });
    const r2 = await engineOn(db, [profile(A)]).reconcileWallet(A, [remote()], { freshSec: 0 });
    expect(r2).toMatchObject({ upserted: 0, zeroed: 0 }); expect(db.T("positions")).toHaveLength(1);
  });
  it("reconciliation itself never creates a signal, and does not fake a buy time", async () => {
    const db = fakeDb(); await engineOn(db, [profile(A)]).reconcileWallet(A, [remote(), remote({ token_id: "tok2", condition_id: "0xc2" })], { freshSec: 0 });
    expect(db.T("signals")).toHaveLength(0); expect(db.T("paper_ledger")).toHaveLength(0); expect(db.T("positions").every((r) => r.last_buy_ts == null)).toBe(true);
  });
  it("a locally-open position that is gone remotely is zeroed; a freshly-traded one is left alone", async () => {
    const db = fakeDb(); const e = engineOn(db, [profile(A)]);
    await e.ingest(fill({ tokenId: "tokX", ts: NOW - 5 })); await e.reconcileWallet(A, [], { freshSec: 0 }); expect(db.T("positions")[0].size).toBe(0);
    await e.ingest(fill({ tokenId: "tokY", ts: NOW - 5 })); const r = await e.reconcileWallet(A, [], { freshSec: 600 });
    expect(r.skippedFresh).toBe(1); expect(db.T("positions").find((p) => p.token_id === "tokY")!.size).toBe(10_000);
  });
  it("a token repeated across API pages is written once (no ON CONFLICT double-hit)", async () => {
    const db = fakeDb(); const r = await engineOn(db, [profile(A)]).reconcileWallet(A, [remote(), remote(), remote({ token_id: "tok2" })], { freshSec: 0 });
    expect(r.upserted).toBe(2); expect(db.T("positions")).toHaveLength(2);
  });
  it("ignores redeemable/closed and empty rows", () => {
    expect(parseRemotePosition({ token_id: "t", condition_id: "c", status: "REDEEMABLE", current_size: 5, avg_price: 0.5 }, A)).toBeNull();
    expect(parseRemotePosition({ token_id: "t", condition_id: "c", status: "OPEN", current_size: 0, avg_price: 0.5 }, A)).toBeNull();
  });
});

// ───────────────────────────────── 5. WS + REST duplicates
describe("5. the same fill through two paths is processed once", () => {
  it("two engines (WS + REST) racing on one fill → 1 fill, 1 position update, 1 signal, 1 paper row", async () => {
    const db = fakeDb(); const ws = engineOn(db, [profile(A)]); const rest = engineOn(db, [profile(A)]);
    const f = fill(); const [a, b] = await Promise.all([ws.ingest({ ...f, source: "ws" }), rest.ingest({ ...f, source: "rest" })]);
    expect(a.length + b.length).toBe(1);
    expect(db.T("fills")).toHaveLength(1); expect(db.T("positions")[0].size).toBe(10_000);
    expect(db.writes.filter((w) => w.table === "positions" && w.op === "upsert")).toHaveLength(1);
    expect(db.T("signals")).toHaveLength(1); expect(db.T("paper_ledger")).toHaveLength(1);
  });
  it("sequential re-delivery (restart / later poll) is also a no-op", async () => {
    const db = fakeDb(); const f = fill(); await engineOn(db, [profile(A)]).ingest(f);
    expect(await engineOn(db, [profile(A)]).ingest(f)).toEqual([]); expect(db.T("positions")[0].size).toBe(10_000); expect(db.T("paper_ledger")).toHaveLength(1);
  });
  it("different fills for the same wallet are serialised (no lost position update)", async () => {
    const db = fakeDb(); const e = engineOn(db, [profile(A)]);
    await Promise.all([e.ingest(fill({ ts: NOW - 3 })), e.ingest(fill({ ts: NOW - 2, size: 5000, usd: 1500 })), e.ingest(fill({ ts: NOW - 1, size: 5000, usd: 1500 }))]);
    expect(db.T("positions")[0].size).toBe(20_000);
  });
});

// ───────────────────────────────── 6. poller pagination
describe("6. the poller reads the whole window", () => {
  const raw = (i: number, ts: number, o: Record<string, unknown> = {}) => ({ proxy_wallet: A, side: "BUY", size: 1000, price: 0.3, timestamp: ts, token_id: "tok1", condition_id: "0xcond", transaction_hash: "0x" + i, ...o });
  /** Keyset feed, newest first, honouring `start` and page size like /v2/trades. */
  function feed(rows: Record<string, unknown>[]) {
    const desc = [...rows].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    return { calls: 0, async *paginate(_p: string, params: Record<string, unknown>, o: { page?: number } = {}) { this.calls++; const start = Number(params.start ?? 0); for (const r of desc) { if (Number(r.timestamp) < start) return; yield r; } void o; } };
  }
  const cursorDb = (since: number) => { const db = fakeDb(); db.T("cursors").push({ key: `poll:${A}`, value: String(since) }); return db; };
  const recorder = (throwAt?: number) => { const ids: string[] = []; let n = 0; return { ids, trackedAddresses: () => [A], async ingest(f: Fill) { if (throwAt != null && ++n === throwAt) throw new Error("db blip"); ids.push(f.id); return []; } }; };
  it("350 fills with page size 200 → all 350 processed, oldest first, cursor at newest", async () => {
    const rows = Array.from({ length: 350 }, (_, i) => raw(i, NOW - 1000 + i)); const db = cursorDb(NOW - 2000); const eng = recorder();
    const r = await pollOnce(db as never, eng, feed(rows) as never, { pageSize: 200, now: NOW });
    expect(r.fills).toBe(350); expect(new Set(eng.ids).size).toBe(350); expect(db.T("cursors")[0].value).toBe(String(NOW - 1000 + 349));
  });
  it("fills sharing a timestamp — including one that arrives after the cursor reached that second — are not skipped", async () => {
    const t = NOW - 500; const db = cursorDb(t - 10); const eng = recorder();
    await pollOnce(db as never, eng, feed([raw(1, t), raw(2, t)]) as never, { now: NOW });
    await pollOnce(db as never, eng, feed([raw(1, t), raw(2, t), raw(3, t)]) as never, { now: NOW }); // late-indexed fill, same second
    expect(eng.ids.filter((x) => x.startsWith("0x3:"))).toHaveLength(1);
  });
  it("identical rows in one transaction keep distinct ids", () => {
    const f = normalizeFill(raw(9, NOW))!; const out = withOccurrence([f, f, f]);
    expect(out.map((x) => x.id)).toEqual([f.id, `${f.id}#2`, `${f.id}#3`]);
  });
  it("a failure mid-walk leaves the cursor before the failed second; the restart finishes the job", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => raw(i, NOW - 100 + i)); const db = cursorDb(NOW - 200);
    const first = recorder(6); await pollOnce(db as never, first, feed(rows) as never, { now: NOW });
    expect(first.ids).toHaveLength(5); expect(Number(db.T("cursors")[0].value)).toBe(NOW - 100 + 4);
    const second = recorder(); await pollOnce(db as never, second, feed(rows) as never, { now: NOW });
    expect(new Set([...first.ids, ...second.ids]).size).toBe(10); expect(db.T("cursors")[0].value).toBe(String(NOW - 91));
  });
  it("REST + WS overlap: fills already claimed via WS are claimed-once through the real engine", async () => {
    const db = cursorDb(NOW - 100); const e = engineOn(db, [profile(A)]); const rows = [raw(1, NOW - 50, { size: 10_000 }), raw(2, NOW - 40, { size: 10_000 })];
    await e.ingest({ ...normalizeFill(rows[0], "ws")!, source: "ws" }); // WS got the first one
    await pollOnce(db as never, e, feed(rows) as never, { now: NOW });
    expect(db.T("fills")).toHaveLength(2); expect(db.T("positions")[0].size).toBe(20_000);
  });
  it("runaway walks stop at the ceiling and are reported, never silently", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => raw(i, NOW - 100 + i)); const db = cursorDb(NOW - 200);
    const r = await pollOnce(db as never, recorder(), feed(rows) as never, { now: NOW, maxRowsPerWallet: 20 });
    expect(r.gaps).toBe(1); expect(db.T("data_quality_issues")[0]).toMatchObject({ kind: "poll_gap", ref_id: A });
  });
  it("readSince stops at the first row older than the window", async () => {
    const f = feed([raw(1, NOW - 10), raw(2, NOW - 20), raw(3, NOW - 500)]); const r = await readSince(f as never, A, NOW - 100, 200, 1000);
    expect(r.rows).toHaveLength(2); expect(r.truncated).toBe(false);
  });
});

// ───────────────────────────────── 7. fill identity + validation
describe("7. fill identity and validation", () => {
  const good = { proxy_wallet: A, side: "BUY", size: 10, price: 0.5, timestamp: NOW, token_id: "t", condition_id: "c", transaction_hash: "0xtx" };
  const reason = (o: Record<string, unknown>) => { const r = explainFill({ ...good, ...o }, "rest", NOW); return "reject" in r ? r.reject : "ok"; };
  it("rejects malformed price", () => { expect(reason({ price: 0 })).toBe("bad_price"); expect(reason({ price: 1.2 })).toBe("bad_price"); expect(reason({ price: "abc" })).toBe("bad_price"); expect(reason({ price: 1 })).toBe("ok"); });
  it("rejects zero / negative size", () => { expect(reason({ size: 0 })).toBe("bad_size"); expect(reason({ size: -5 })).toBe("bad_size"); });
  it("rejects missing identifiers and bad wallets/timestamps", () => {
    expect(reason({ token_id: "" })).toBe("missing_token"); expect(reason({ condition_id: undefined })).toBe("missing_market");
    expect(reason({ proxy_wallet: "0x123" })).toBe("missing_wallet"); expect(reason({ timestamp: 12 })).toBe("bad_timestamp"); expect(reason({ timestamp: NOW + 10 * 86400 })).toBe("bad_timestamp");
  });
  it("the same legitimate fill always gets the same id", () => { expect(normalizeFill(good)!.id).toBe(normalizeFill({ ...good })!.id); });
  it("two fills in one transaction at different prices do not collide", () => { expect(normalizeFill(good)!.id).not.toBe(normalizeFill({ ...good, price: 0.51 })!.id); });
});

// ───────────────────────────────── 8. rule ordering
describe("8. rule ordering", () => {
  const before: Position = { wallet: A, tokenId: "tok1", conditionId: "0xcond", outcome: "Yes", title: "", slug: "", size: 10_000, avgPrice: 0.35, costUsd: 3500, peakSize: 10_000, firstSeen: NOW - 1000, lastSeen: NOW - 1000, lastBuyTs: NOW - 1000, lastSellTs: null, endDate: null };
  const base = { wallet: profile(A), consensus: { peers: [] }, medianFillUsd: 100, hasOpenSignal: true, endDate: null, now: NOW };
  it("a SELL never produces a BUY-side signal", () => {
    const s = evaluate({ ...base, before, fill: fill({ side: "SELL", size: 8000, price: 0.3, usd: 2400 }), consensus: { peers: [{ wallet: B, lastBuyTs: NOW, copyScore: 70 }] } });
    expect(kinds(s)).toEqual(["EXIT"]);
  });
  it("an existing position never yields NEW_POSITION, and does not block CONVICTION_ADD", () => { expect(kinds(evaluate({ ...base, before, fill: fill({ size: 6000, price: 0.3, usd: 1800 }) }))).toEqual(["CONVICTION_ADD"]); });
  it("EXIT requires an open alerted position", () => { expect(evaluate({ ...base, hasOpenSignal: false, before, fill: fill({ side: "SELL", size: 8000, usd: 2400 }) })).toEqual([]); });
  it("invalid fills never reach the book: the engine rejects sub-threshold and bot fills before any write", async () => {
    const db = fakeDb(); const e = engineOn(db, [profile(A), profile(B, { style: "Market maker / bot" })]);
    await e.ingest(fill({ usd: 10, size: 30 })); await e.ingest(fill({ wallet: B })); expect(db.T("fills")).toHaveLength(0); expect(db.T("positions")).toHaveLength(0);
  });
});

// ───────────────────────────────── 9. paper ledger safety
describe("9. paper ledger has one row per signal, never per delivery", () => {
  it("a replayed fill that already produced a signal adds no paper rows or marks", async () => {
    const db = fakeDb(); const f = fill(); await engineOn(db, [profile(A)]).ingest(f); await engineOn(db, [profile(A)]).ingest(f); await engineOn(db, [profile(A)]).ingest({ ...f, source: "ws" });
    expect(db.T("signals")).toHaveLength(1); expect(db.T("paper_ledger")).toHaveLength(1); expect(db.T("paper_ledger")[0].signal_id).toBe(db.T("signals")[0].id);
  });
  it("NEW_POSITION + CONSENSUS on the same fill are two distinct signals (documented V2 semantics, unchanged)", async () => {
    const db = fakeDb(); const e = engineOn(db, [profile(A), profile(B)]); await e.ingest(fill({ wallet: A, ts: NOW - 10 }));
    expect(kinds(await e.ingest(fill({ wallet: B })))).toEqual(["CONSENSUS", "NEW_POSITION"]); expect(db.T("paper_ledger")).toHaveLength(3);
  });
});

void DEFAULT_CONFIG;
