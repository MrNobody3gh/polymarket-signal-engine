/** Phase 2.5 — stabilisation. Memory bounds, bot detection, Telegram delivery health, backlog states, coverage. */
import { describe, it, expect, vi } from "vitest";
import { stressDb } from "./helpers/stressDb";
import { fakeDb } from "./helpers/fakeDb";
import { sweepSimulation, processBacklog, simulateMode, buildSignals, coverageOf, isTerminal, SIM_BATCH_SIZE, MAX_FETCH_ATTEMPTS, type BacklogQueue, type BacklogItem, type SimInputs } from "@/lib/paper/sim/run";
import { MODES } from "@/lib/paper/sim/config";
import { measureActivity, botClass, activityRow } from "@/lib/scoring/activity";
import { buildProfile } from "@/lib/scoring/score";
import { classifyFailure, backoffSec, broadcast, MAX_CONSECUTIVE_FAILURES } from "@/lib/telegram/broadcast";
import { TelegramApi } from "@/lib/telegram/api";
import { handle, type Store, type Subscriber, type SignalRow } from "@/lib/telegram/commands";
import { processUpdate } from "@/lib/telegram/bot";
import { SignalEngine } from "@/lib/signals/engine";
import type { WalletProfile } from "@/lib/polymarket/types";

const T0 = 1_790_000_000;
const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

// ───────────────────────── Priority 1: memory
function populate(db: ReturnType<typeof stressDb>, n: number) {
  for (let i = 1; i <= n; i++) {
    const id = uid(i); const tok = `tok${i % Math.max(1, Math.floor(n / 20))}`; const at = new Date((T0 + i * 7) * 1000).toISOString();
    db.insertRow("signals", { id, kind: i % 4 === 0 ? "CONSENSUS" : "NEW_POSITION", wallet: `w${i % 150}`, condition_id: `c${tok}`, token_id: tok, price: 0.3 + (i % 50) / 100, usd: 500 + (i % 7) * 100, created_at: at, evaluated_at: new Date((T0 + i * 7 + 90) * 1000).toISOString() });
    db.insertRow("paper_ledger", { signal_id: id, created_at: at, sim_terminal: false, side: "LONG" });
  }
}
describe("P1: the simulation sweep's working set is bounded regardless of history size", () => {
  for (const n of [10_000, 50_000, 100_000]) {
    it(`${n.toLocaleString()} signals → every signal gets a record, no call materialises more than a batch's worth of rows`, async () => {
      const db = stressDb({ slimExecutions: true }); populate(db, n);
      const s = await sweepSimulation(db as never, { batchSize: SIM_BATCH_SIZE });
      expect(s.signals).toBe(n); expect(s.batches).toBe(Math.ceil(n / SIM_BATCH_SIZE)); expect(s.maxBatchRows).toBeLessThanOrEqual(SIM_BATCH_SIZE);
      expect(db.T("paper_executions")).toHaveLength(n * 3);
      // bound: a batch's signals (+ their exits) × 3 modes — independent of n
      expect(db.stats.maxRowsPerCall).toBeLessThanOrEqual(SIM_BATCH_SIZE * 3);
      expect(db.stats.maxWritePerCall).toBeLessThanOrEqual(SIM_BATCH_SIZE * 3);
      // everything is PENDING_DATA for REALISTIC/CONSERVATIVE (no prices yet) and the backlog was enqueued, not guessed
      expect(db.T("paper_executions").filter((r) => r.mode === "REALISTIC" && r.coverage_state === "PENDING_DATA")).toHaveLength(n);
      expect(db.T("price_observations").every((r) => r.state === "PENDING")).toBe(true);
    }, 120_000);
  }
  it("a second sweep writes nothing when nothing changed, and terminal signals leave the sweep", async () => {
    const db = stressDb({ slimExecutions: true }); populate(db, 2000);
    await sweepSimulation(db as never); const s2 = await sweepSimulation(db as never);
    expect(s2.written).toBe(0); expect(s2.unchanged).toBe(2000 * 3);
    for (const r of db.T("price_observations")) Object.assign(r, { state: "UNAVAILABLE", price: null }); // REALISTIC/CONSERVATIVE: final (no data)
    for (let t = 0; t < 100; t++) db.insertRow("token_resolutions", { token_id: `tok${t}`, value: 1, resolved_ts: new Date((T0 + 10 * 86400) * 1000).toISOString() }); // IDEAL: resolved
    const s3 = await sweepSimulation(db as never); expect(s3.newlyTerminal).toBe(2000);
    const s4 = await sweepSimulation(db as never); expect(s4.signals).toBe(0);
  });
});

// ───────────────────────── Priority 4: backlog states
describe("P4: price backlog", () => {
  function memQueue(items: BacklogItem[]) {
    const state = new Map(items.map((i) => [`${i.token_id}@${i.as_of}`, { ...i, state: "PENDING", price: undefined as number | null | undefined }]));
    const q: BacklogQueue & { state: typeof state } = { state,
      async claim(n) { const out = [...state.values()].filter((x) => x.state === "PENDING").slice(0, n); out.forEach((x) => (x.state = "PROCESSING")); return out.map(({ token_id, as_of, attempts }) => ({ token_id, as_of, attempts })); },
      async complete(it, o) { const x = state.get(`${it.token_id}@${it.as_of}`)!; x.state = o ? "COMPLETE" : "UNAVAILABLE"; x.price = o?.price ?? null; },
      async fail(it, _e) { const x = state.get(`${it.token_id}@${it.as_of}`)!; x.attempts++; x.state = x.attempts >= MAX_FETCH_ATTEMPTS ? "FAILED_FINAL" : "PENDING"; } };
    return q;
  }
  it("completes, marks permanently-unavailable history distinctly, retries transient failures, never fabricates a price", async () => {
    const q = memQueue([{ token_id: "a", as_of: T0, attempts: 0 }, { token_id: "b", as_of: T0, attempts: 0 }, { token_id: "c", as_of: T0, attempts: 0 }]);
    let flaky = 0;
    const src = { async priceAsOf(t: string, asOf: number) { if (t === "a") return { ts: asOf - 5, price: 0.4, resolutionSeconds: 0 }; if (t === "b") return null; if (flaky++ < 1) throw new Error("503"); return { ts: asOf - 5, price: 0.6, resolutionSeconds: 0 }; } };
    const r = await processBacklog(q, src, { budget: 10, chunk: 2 });
    expect(q.state.get(`a@${T0}`)).toMatchObject({ state: "COMPLETE", price: 0.4 }); expect(q.state.get(`b@${T0}`)).toMatchObject({ state: "UNAVAILABLE", price: null });
    expect(q.state.get(`c@${T0}`)).toMatchObject({ state: "COMPLETE", price: 0.6, attempts: 1 }); expect(r).toMatchObject({ unavailable: 1, failed: 1 });
  });
  it("budget bounds the work per run; progress persists so the next run continues", async () => {
    const q = memQueue(Array.from({ length: 25 }, (_, i) => ({ token_id: `t${i}`, as_of: T0, attempts: 0 })));
    const src = { async priceAsOf(_t: string, asOf: number) { return { ts: asOf, price: 0.5, resolutionSeconds: 0 }; } };
    expect((await processBacklog(q, src, { budget: 10, chunk: 4 })).done).toBe(10); expect((await processBacklog(q, src, { budget: 100 })).done).toBe(15);
    expect([...q.state.values()].every((x) => x.state === "COMPLETE")).toBe(true);
  });
});

// ───────────────────────── Priority 6: coverage states
describe("P6: simulation coverage states", () => {
  it("maps outcomes to coverage; pending is not a loss and terminal only when final", () => {
    expect(["FILLED", "PARTIALLY_FILLED", "UNKNOWN", "INVALID", "UNFILLED", "EXPIRED", "PENDING"].map(coverageOf)).toEqual(["SIMULATED", "SIMULATED", "UNAVAILABLE_DATA", "INVALID", "UNFILLED", "UNFILLED", "PENDING_DATA"]);
    expect(isTerminal("PENDING_DATA", "PENDING")).toBe(false); expect(isTerminal("SIMULATED", "OPEN")).toBe(false); expect(isTerminal("SIMULATED", "RESOLVED")).toBe(true); expect(isTerminal("UNAVAILABLE_DATA", "NOT_ENTERED")).toBe(true);
  });
  it("pending signals get an explicit PENDING_DATA record with zero P&L; unavailable history is UNAVAILABLE_DATA", () => {
    const sig = { id: "s1", kind: "NEW_POSITION", wallet: "w", condition_id: "c", token_id: "t", price: 0.4, usd: 5000, created_at: new Date(T0 * 1000).toISOString(), evaluated_at: new Date((T0 + 60) * 1000).toISOString() };
    const inp: SimInputs = { signals: [sig], ledger: new Map(), marks: new Map(), resolutions: new Map(), markets: new Map(), obs: new Map() };
    const pending = simulateMode(buildSignals(inp), inp, MODES.REALISTIC).records[0];
    expect(pending).toMatchObject({ coverage_state: "PENDING_DATA", status: "PENDING", filled_usd: 0 }); expect(pending.net_pnl).toBeUndefined();
    inp.obs.set(`t@${T0 + 70}`, null); expect(simulateMode(buildSignals(inp), inp, MODES.REALISTIC).records[0]).toMatchObject({ coverage_state: "UNAVAILABLE_DATA", net_pnl: 0 });
  });
  it("P7: latency without an evaluation time is labelled ESTIMATED, never OBSERVED", () => {
    const sig = { id: "s1", kind: "NEW_POSITION", wallet: "w", condition_id: "c", token_id: "t", price: 0.4, usd: 5000, created_at: new Date(T0 * 1000).toISOString() };
    const inp: SimInputs = { signals: [sig], ledger: new Map(), marks: new Map(), resolutions: new Map(), markets: new Map(), obs: new Map() };
    expect(simulateMode(buildSignals(inp), inp, MODES.REALISTIC).records[0].latency_source).toBe("ESTIMATED");
  });
});

// ───────────────────────── Priority 2: bot detection
const feed = (n: number, spanSec: number, now: number) => ({ async *paginate() { for (let i = 0; i < n; i++) yield { timestamp: now - Math.floor((i * spanSec) / Math.max(1, n)) }; } });
describe("P2: bot detection from the live trade feed", () => {
  const now = T0;
  it("1. very high fill frequency → LOWER_BOUND and bot-like", async () => {
    const a = await measureActivity(feed(50_000, 3 * 86400, now) as never, "0xw", now);
    expect(a.status).toBe("LOWER_BOUND"); expect(a.fillsPerDay!).toBeGreaterThan(500); expect(botClass(a, 0.01)).toBe("BOT_HIGH_FREQUENCY");
  });
  it("2. moderate activity is not a bot", async () => {
    const a = await measureActivity(feed(140, 7 * 86400 - 60, now) as never, "0xw", now);
    expect(a).toMatchObject({ status: "OK", fills: 140 }); expect(a.fillsPerDay).toBeCloseTo(20, 9); expect(botClass(a, 0.01)).toBe("ACTIVE");
    expect(botClass({ status: "OK", fillsPerDay: 300 }, 0)).toBe("HIGH_FREQUENCY");
  });
  it("3. no fills / failed fetch → INSUFFICIENT_DATA, never zero", async () => {
    const empty = await measureActivity(feed(0, 0, now) as never, "0xw", now); expect(empty).toMatchObject({ status: "INSUFFICIENT_DATA", reason: "NO_FILLS_IN_WINDOW", fillsPerDay: null });
    const broken = await measureActivity({ async *paginate() { throw new Error("503"); } } as never, "0xw", now); expect(broken.status).toBe("INSUFFICIENT_DATA"); expect(broken.fillsPerDay).toBeNull();
    expect(botClass(empty, 0.01)).toBe("INSUFFICIENT_DATA"); expect(activityRow(empty, 0.01)).toMatchObject({ fills_per_day: null, bot_class: "INSUFFICIENT_DATA" });
  });
  it("4–5. market-maker programme income is still decisive, with or without activity data", () => {
    expect(botClass({ status: "OK", fillsPerDay: 5 }, 0.4)).toBe("MARKET_MAKER"); expect(botClass({ status: "INSUFFICIENT_DATA", fillsPerDay: null }, 0.4)).toBe("MARKET_MAKER");
  });
  it("6. insufficient history never scores better than the same wallet measured as a normal trader", () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({ timestamp: T0 - (199 - i) * 86400, position_pnl: i * 1000 }));
    const stats = { proxy_wallet: "0xw", trades: 50, biggest_win: 20_000, views: 0, volume_usdc: 2_000_000, trade_count: 3000, all_time_pnl: { realized_market_pnl: 180_000, realized_combo_pnl: 0, maker_rebate: 1000, reward_income: 0 } };
    const measured = buildProfile("0xw", "w", stats, pts, T0, [], { status: "OK", fillsPerDay: 20 });
    const unknown = buildProfile("0xw", "w", stats, pts, T0, [], { status: "INSUFFICIENT_DATA", fillsPerDay: null });
    const bot = buildProfile("0xw", "w", stats, pts, T0, [], { status: "LOWER_BOUND", fillsPerDay: 5000 });
    expect(unknown.copyScore).toBeLessThanOrEqual(measured.copyScore); expect(unknown.fillsPerDay).toBeNull();
    expect(bot.style).toBe("Market maker / bot"); expect(bot.copyScore).toBeLessThan(measured.copyScore);
  });
  it("7. a measured bot-like wallet generates no signals", async () => {
    const db = fakeDb(); const e = new SignalEngine({ db: db as never, channels: {}, markets: { endDate: async () => null }, now: () => T0 });
    const w: WalletProfile = { address: "0x" + "b".repeat(40), name: "rn1", copyScore: 64.7, pnl90d: 3e6, style: "Selective directional", fillsPerDay: 10_801, programShare: 0.11, concentration: 0.01, netDd: 38, monthsUp: 3, monthsTotal: 3, daysIdle: 0, tradeCount: null, sources: [] };
    (e as unknown as { wallets: Map<string, WalletProfile> }).wallets.set(w.address, w);
    const s = await e.ingest({ id: "x", wallet: w.address, conditionId: "c", tokenId: "t", side: "BUY", size: 10_000, price: 0.3, usd: 3000, ts: T0, title: "", slug: "", outcome: "Yes", tx: "0x", source: "ws" });
    expect(s).toEqual([]); expect(db.T("fills")).toHaveLength(0);
  });
});

// ───────────────────────── Priority 3: Telegram
const sig: SignalRow = { id: "s1", kind: "NEW_POSITION", severity: 3, wallet: "0xabc", wallet_name: "w", outcome: "Yes", title: "T", slug: "t", price: 0.4, usd: 5000, payload: {}, created_at: new Date().toISOString(), closed_at: null };
const sub = (o: Partial<Subscriber> = {}): Subscriber => ({ chat_id: 1, username: null, kinds: ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY", "EXIT"], min_severity: 1, min_usd: 0, min_score: 0, only_wallets: [], muted_wallets: [], muted_until: null, active: true, consecutive_failures: 0, next_attempt_at: null, ...o });
const tg = (responder: (chatId: number) => object) => { const calls: number[] = []; const f = vi.fn(async (_u: string, init?: RequestInit) => { const b = JSON.parse(String(init?.body)); calls.push(b.chat_id); return new Response(JSON.stringify(responder(b.chat_id))); }); return { api: new TelegramApi("t", f as unknown as typeof fetch), calls }; };
describe("P3: Telegram delivery health", () => {
  it("classifies failures", () => {
    expect(classifyFailure({ ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -100123 } })).toEqual({ kind: "MIGRATED", to: -100123 });
    expect(classifyFailure({ ok: false, error_code: 400, description: "Bad Request: chat not found" }).kind).toBe("PERMANENT");
    expect(classifyFailure({ ok: false, error_code: 403, description: "Forbidden: bot was kicked from the group chat" }).kind).toBe("PERMANENT");
    expect(classifyFailure({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } })).toMatchObject({ kind: "TRANSIENT", retryAfterSec: 7 });
    expect(backoffSec(1, null)).toBe(30); expect(backoffSec(20, null)).toBe(3600); expect(backoffSec(1, 90)).toBe(90);
  });
  it("supergroup upgrade: the subscription moves to the new id (filters kept), the alert is re-sent there, the old id stops", async () => {
    const db = fakeDb(); db.T("tg_subscribers").push(sub({ chat_id: -5, min_severity: 2 }));
    const { api, calls } = tg((id) => (id === -5 ? { ok: false, error_code: 400, description: "group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1005 } } : { ok: true }));
    const r = await broadcast(db as never, api, sig, { sleep: async () => {} });
    expect(r).toMatchObject({ sent: 1, migrated: 1 }); expect(calls).toEqual([-5, -1005]);
    expect(db.T("tg_subscribers").find((s) => s.chat_id === -5)).toMatchObject({ active: false, disabled_reason: "MIGRATED", migrated_to: -1005 });
    expect(db.T("tg_subscribers").find((s) => s.chat_id === -1005)).toMatchObject({ active: true, min_severity: 2 });
    const r2 = await broadcast(db as never, api, { ...sig, id: "s2" }, { sleep: async () => {} }); expect(r2.sent).toBe(1); expect(calls.slice(2)).toEqual([-1005]);
  });
  it("invalid old chat id is disabled, not retried", async () => {
    const db = fakeDb(); db.T("tg_subscribers").push(sub({ chat_id: -7 }));
    const { api, calls } = tg(() => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }));
    await broadcast(db as never, api, sig, { sleep: async () => {} }); await broadcast(db as never, api, { ...sig, id: "s2" }, { sleep: async () => {} });
    expect(calls).toEqual([-7]); expect(db.T("tg_subscribers")[0]).toMatchObject({ active: false, disabled_reason: "PERMANENT_ERROR" });
  });
  it("repeated transient failure backs off, then disables after the limit", async () => {
    const db = fakeDb(); db.T("tg_subscribers").push(sub({ chat_id: 9 })); let clock = Date.parse("2026-09-26T00:00:00Z");
    const { api, calls } = tg(() => ({ ok: false, error_code: 502, description: "Bad Gateway" }));
    await broadcast(db as never, api, sig, { sleep: async () => {}, now: () => clock });
    await broadcast(db as never, api, { ...sig, id: "s2" }, { sleep: async () => {}, now: () => clock }); expect(calls).toHaveLength(1); // backing off
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) { clock += 3601_000; await broadcast(db as never, api, { ...sig, id: `r${i}` }, { sleep: async () => {}, now: () => clock }); }
    expect(db.T("tg_subscribers")[0]).toMatchObject({ active: false, disabled_reason: "REPEATED_FAILURE" }); expect(calls.length).toBe(MAX_CONSECUTIVE_FAILURES);
  });
  it("unsubscribed chats receive nothing; /start (re)subscribes and clears any failure state", async () => {
    const db = fakeDb(); db.T("tg_subscribers").push(sub({ chat_id: 3, active: false, disabled_reason: "REPEATED_FAILURE", consecutive_failures: 8, next_attempt_at: "2099-01-01T00:00:00Z" }));
    const { api, calls } = tg(() => ({ ok: true })); await broadcast(db as never, api, sig, { sleep: async () => {} }); expect(calls).toHaveLength(0);
    const subs = db.T("tg_subscribers"); const store = { getSub: async (id: number) => subs.find((s) => s.chat_id === id) ?? null, upsertSub: async (s: Partial<Subscriber> & { chat_id: number }) => { const cur = subs.find((x) => x.chat_id === s.chat_id); if (cur) Object.assign(cur, s); else subs.push(sub(s)); return subs.find((x) => x.chat_id === s.chat_id)!; } } as unknown as Store;
    await handle(3, null, "/start", store); expect(subs[0]).toMatchObject({ active: true, consecutive_failures: 0, next_attempt_at: null, disabled_reason: null });
    await broadcast(db as never, api, { ...sig, id: "s2" }, { sleep: async () => {} }); expect(calls).toEqual([3]);
    await handle(3, null, "/stop", store); expect(subs[0]).toMatchObject({ active: false, disabled_reason: "USER_STOP" });
  });
  it("/start in a brand-new supergroup registers its current id; the service message migrates an existing one", async () => {
    const db = fakeDb(); db.T("tg_subscribers").push(sub({ chat_id: -42, min_usd: 2000 }));
    const { api } = tg(() => ({ ok: true }));
    await processUpdate({ update_id: 1, message: { message_id: 1, chat: { id: -42, type: "group" }, migrate_to_chat_id: -10042 } }, db as never, api);
    expect(db.T("tg_subscribers").find((s) => s.chat_id === -10042)).toMatchObject({ active: true, min_usd: 2000 });
    expect(db.T("tg_subscribers").find((s) => s.chat_id === -42)).toMatchObject({ active: false, migrated_to: -10042 });
  });
});
