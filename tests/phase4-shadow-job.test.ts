import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shadowSetup, CYCLE_BUDGET_MS, DEFAULT_DAILY_REQUESTS, FEE_CACHE_MAX, MAX_PAGES, MAX_SNAPSHOTS_PER_CYCLE, PAGE_SIZE, PRUNE_BATCH, PRUNE_MAX_BATCHES, RETENTION_DAYS } from "@/lib/phase4/shadow/config";
import { ShadowJob, runShadowCycleSafely, makeShadowHttp } from "@/lib/phase4/shadow/job";
import { FeeCache } from "@/lib/phase4/shadow/snapshot";
import { insertRows, loadWindow, pruneBatch, requestsSince } from "@/lib/phase4/shadow/store";
import { missedRow } from "@/lib/phase4/shadow/snapshot";
import { makeSimCycle } from "@/lib/paper/portfolio/job";
import { shadowDb } from "./helpers/shadowDb";
import { T0, bookBody, respond, signal, uid, world } from "./helpers/shadowWorld";

const asDb = (d: ReturnType<typeof shadowDb>) => d as unknown as SupabaseClient;
const ON = { minScore: 0, dailyRequests: DEFAULT_DAILY_REQUESTS };
const mkJob = (db: ReturnType<typeof shadowDb>, w: ReturnType<typeof world>, cfg = ON, logs: string[] = []) => new ShadowJob({ db: asDb(db), config: cfg, http: w.http(), nowSec: w.nowSec, clockMs: w.clockMs, log: (m) => logs.push(m) });

describe("the flag: off by default, and a malformed value is off, never on", () => {
  const run = (env: Record<string, string | undefined>) => { const logs: string[] = []; const s = shadowSetup(env, (m) => logs.push(m)); return { s, logs }; };
  it("unset, empty and 0 are off (one line)", () => { for (const v of [undefined, "", "0"]) { const { s, logs } = run({ SHADOW_BOOKS: v }); expect(s).toEqual({ on: false, config: null }); expect(logs).toHaveLength(1); expect(logs[0]).toMatch(/^shadow books: off/); } });
  it("1 is on, with the documented defaults, and says what it does in one line", () => { const { s, logs } = run({ SHADOW_BOOKS: "1" }); expect(s).toEqual({ on: true, config: { minScore: 0, dailyRequests: 20_000 } }); expect(logs).toHaveLength(1); expect(logs[0]).toMatch(/on .* no orders/); });
  it("anything else for SHADOW_BOOKS is OFF with one line naming the value: true, yes, on, 2, ' 1', 1.0", () => { for (const v of ["true", "yes", "on", "2", " 1", "1.0", "TRUE"]) { const { s, logs } = run({ SHADOW_BOOKS: v }); expect(s.on, v).toBe(false); expect(logs).toHaveLength(1); expect(logs[0]).toContain(JSON.stringify(v)); expect(logs[0]).toMatch(/invalid configuration/); } });
  it("a malformed numeric flag turns the feature off (only when on is requested)", () => {
    for (const [k, v] of [["SHADOW_BOOKS_MIN_SCORE", "abc"], ["SHADOW_BOOKS_MIN_SCORE", "-1"], ["SHADOW_BOOKS_MIN_SCORE", "101"], ["SHADOW_BOOKS_MIN_SCORE", "1e3"], ["SHADOW_BOOKS_DAILY_REQUESTS", "0"], ["SHADOW_BOOKS_DAILY_REQUESTS", "1.5"], ["SHADOW_BOOKS_DAILY_REQUESTS", "abc"], ["SHADOW_BOOKS_DAILY_REQUESTS", "999999"], ["SHADOW_BOOKS_DAILY_REQUESTS", "-5"]] as const) {
      const { s, logs } = run({ SHADOW_BOOKS: "1", [k]: v }); expect(s.on, `${k}=${v}`).toBe(false); expect(logs).toHaveLength(1); expect(logs[0]).toContain(k);
    }
    expect(run({ SHADOW_BOOKS: "0", SHADOW_BOOKS_MIN_SCORE: "abc" }).s.on).toBe(false);
  });
  it("valid numeric flags are used", () => { expect(run({ SHADOW_BOOKS: "1", SHADOW_BOOKS_MIN_SCORE: "68", SHADOW_BOOKS_DAILY_REQUESTS: "5000" }).s).toEqual({ on: true, config: { minScore: 68, dailyRequests: 5000 } }); });
});

describe("OFF means no request and no database call", () => {
  it("a job with no config makes none, however often it runs, and never builds a client", async () => {
    const w = world(); const db = shadowDb({ signals: [signal(1, 0)] });
    const job = new ShadowJob({ db: asDb(db), config: null, http: w.http(), nowSec: w.nowSec, clockMs: w.clockMs });
    for (let i = 0; i < 5; i++) expect(await job.runCycle()).toMatchObject({ off: true, snapshots: 0, requests: 0 });
    expect(w.calls).toHaveLength(0); expect(db.calls).toHaveLength(0);
  });
  it("the safe wrapper is silent too: no log, no status write, no database call", async () => {
    const w = world(); const db = shadowDb(); const logs: string[] = [];
    const job = new ShadowJob({ db: asDb(db), config: null, http: w.http() });
    expect(await runShadowCycleSafely(job, { db: asDb(db), log: (m) => logs.push(m) })).toMatchObject({ off: true }); expect(logs).toEqual([]); expect(db.calls).toHaveLength(0); expect(w.calls).toHaveLength(0);
  });
  it("shadowSetup itself touches nothing (no database, no network): it only reads the environment", () => { expect(() => shadowSetup({ SHADOW_BOOKS: undefined }, () => {})).not.toThrow(); });
});

describe("a normal run", () => {
  it("records offset 0 now, offset 60 a minute later, offset 300 five minutes later, once each, with data", async () => {
    const w = world(); const db = shadowDb({ signals: [signal(1, 0)] }); const job = mkJob(db, w);
    const s0 = await job.runCycle(); expect(s0).toMatchObject({ snapshots: 1, missed: 0, statuses: { OK: 1 } });
    w.set(T0 + 60); const s1 = await job.runCycle(); expect(s1.snapshots).toBe(1);
    w.set(T0 + 300); const s2 = await job.runCycle(); expect(s2.snapshots).toBe(1);
    const rows = db.T("shadow_books"); expect(rows.map((r) => r.offset_s).sort((a, b) => a - b)).toEqual([0, 60, 300]);
    const r = rows.find((x) => x.offset_s === 0)!;
    expect(r).toMatchObject({ signal_id: uid(1), token_id: "tok1", side: "BUY", status: "OK", source_price: 0.49, best_bid: 0.48, best_ask: 0.5, mid: 0.49, fee_rate_bps: 200, fee_source: "OBSERVED_RATE", schema_version: 1, http_status: 200, request_count: 2 });
    expect(r.spread).toBeCloseTo(0.02, 9); expect(r.due_at).toBe(new Date(T0 * 1000).toISOString()); expect(r.bids).toEqual([[0.48, 500], [0.47, 900]]); expect(r.asks[0]).toEqual([0.5, 400]);
    expect(Object.keys(r.fills.by_usd)).toEqual(["10", "25", "100"]); expect(r.fills.by_usd["25"]).toMatchObject({ shares: 50, avg_price: 0.5, filled_share: 1 });
    expect(r.fills.by_usd["25"].fee_usd).toBeCloseTo(50 * 0.02 * 0.5 * 0.5, 5);
  });
  it("running a cycle twice records once, and the second run makes no request (idempotent)", async () => {
    const w = world(); const db = shadowDb({ signals: [signal(1, 0)] }); const job = mkJob(db, w);
    await job.runCycle(); const n = w.calls.length; const again = await job.runCycle();
    expect(again).toMatchObject({ snapshots: 0, missed: 0, requests: 0 }); expect(w.calls).toHaveLength(n); expect(db.T("shadow_books")).toHaveLength(1);
  });
  it("a restart (a new process over the same database) repeats nothing and loses nothing", async () => {
    const w = world(); const db = shadowDb({ signals: [signal(1, 0), signal(2, 10)] });
    await mkJob(db, w).runCycle(); const before = JSON.stringify(db.T("shadow_books")); const callsBefore = w.calls.length;
    const fresh = mkJob(db, w); await fresh.runCycle(); expect(JSON.stringify(db.T("shadow_books"))).toBe(before); expect(w.calls.length).toBe(callsBefore);
    w.set(T0 + 75); await fresh.runCycle(); expect(db.T("shadow_books").map((r) => `${r.signal_id}@${r.offset_s}`).sort()).toEqual([`${uid(1)}@0`, `${uid(1)}@60`, `${uid(2)}@0`, `${uid(2)}@60`].sort());
  });
  it("an outage: snapshots more than 120 s late are MISSED rows with no data and no request, never late snapshots", async () => {
    const w = world(); const db = shadowDb({ signals: [signal(1, 400)] }); // created 400 s ago: 0 and 60 are long past, 300 is 100 s late
    const job = mkJob(db, w); const s = await job.runCycle();
    const by = Object.fromEntries(db.T("shadow_books").map((r) => [r.offset_s, r]));
    expect(by[0].status).toBe("MISSED"); expect(by[60].status).toBe("MISSED"); expect(by[300].status).toBe("OK"); expect(s).toMatchObject({ missed: 2, snapshots: 1 });
    for (const k of [0, 60]) expect(by[k]).toMatchObject({ bids: null, asks: null, fills: null, best_bid: null, best_ask: null, request_count: 0 });
    expect(w.calls.filter((c) => c.path === "/book")).toHaveLength(1);
  });
  it("signals older than the look-back are ignored (a fresh enable does not back-fill history), EXIT signals and low scores are skipped", async () => {
    const w = world(); const db = shadowDb({ signals: [signal(1, 3 * 3600), signal(2, 0, { kind: "EXIT" }), signal(3, 0, { score: 40 }), signal(4, 0, { score: 80 })] });
    await mkJob(db, w, { ...ON, minScore: 68 }).runCycle(); expect(db.T("shadow_books").map((r) => r.signal_id)).toEqual([uid(4)]);
  });
  it("book states and failures map to the documented statuses", async () => {
    const cases: [string, (p: string) => any, string, number | null][] = [
      ["EMPTY_BOOK", () => ({ status: 200, body: { bids: [], asks: [] } }), "EMPTY_BOOK", 200],
      ["ONE_SIDED", (p) => (p === "/book" ? { status: 200, body: bookBody({ bid: "" }) } : undefined), "ONE_SIDED", 200],
      ["CROSSED", () => ({ status: 200, body: { bids: [{ price: "0.6", size: "10" }], asks: [{ price: "0.5", size: "10" }] } }), "CROSSED", 200],
      ["NOT_FOUND", () => ({ status: 404, body: { error: "No orderbook exists for the requested token id" } }), "NOT_FOUND", 404],
      ["ERROR 500", () => ({ status: 500, body: "boom" }), "ERROR", 500],
      ["ERROR 400", () => ({ status: 400, body: { error: "Invalid token id" } }), "ERROR", 400],
      ["ERROR not json", () => ({ status: 200, body: "<html>" }), "ERROR", 200],
      ["ERROR not a book", () => ({ status: 200, body: { hello: "world" } }), "ERROR", 200],
    ];
    for (const [name, route, status, http] of cases) {
      const w = world((p) => route(p)); const db = shadowDb({ signals: [signal(1, 0)] }); await mkJob(db, w).runCycle();
      const r = db.T("shadow_books")[0]; expect(r.status, name).toBe(status); expect(r.http_status, name).toBe(http);
      if (status === "CROSSED") { expect(r.fills).toBeNull(); expect(r.fee_rate_bps).toBeNull(); expect(w.calls.map((c) => c.path)).toEqual(["/book"]); } // nothing is filled from a crossed book, so its fee rate is not even asked
      if (status === "EMPTY_BOOK") expect(r.bids).toBeNull();
      if (status === "ONE_SIDED") { expect(r.spread).toBeNull(); expect(r.fills.by_usd["10"].filled_share).toBe(1); }
    }
  });
  it("an unknown fee rate is recorded as ASSUMED_UNKNOWN at the paper fallback, with the raw bps null", async () => {
    const w = world((p) => (p === "/fee-rate" ? { status: 200, body: { nope: 1 } } : undefined)); const db = shadowDb({ signals: [signal(1, 0)] }); await mkJob(db, w).runCycle();
    expect(db.T("shadow_books")[0]).toMatchObject({ fee_rate_bps: null, fee_source: "ASSUMED_UNKNOWN", status: "OK" });
  });
  it("a fee-free token is OBSERVED_FEE_FREE with a zero fee in every fill", async () => {
    const w = world((p) => (p === "/fee-rate" ? { status: 200, body: { fee_rate_bps: 0 } } : undefined)); const db = shadowDb({ signals: [signal(1, 0)] }); await mkJob(db, w).runCycle();
    const r = db.T("shadow_books")[0]; expect(r).toMatchObject({ fee_rate_bps: 0, fee_source: "OBSERVED_FEE_FREE" }); for (const f of Object.values<any>(r.fills.by_usd)) expect(f.fee_usd).toBe(0);
  });
  it("only the top 10 levels are stored, but the fill walk uses the whole book", async () => {
    const asks = Array.from({ length: 15 }, (_, i) => ({ price: (0.5 + i / 100).toFixed(2), size: "10" })); const bids = Array.from({ length: 15 }, (_, i) => ({ price: (0.49 - i / 100).toFixed(2), size: "10" }));
    const w = world((p) => (p === "/book" ? { status: 200, body: { bids, asks, tick_size: "0.01", min_order_size: "5" } } : undefined)); const db = shadowDb({ signals: [signal(1, 0)] }); await mkJob(db, w).runCycle();
    const r = db.T("shadow_books")[0]; expect(r.asks).toHaveLength(10); expect(r.bids).toHaveLength(10); expect(r.asks[0]).toEqual([0.5, 10]); expect(r.asks[9]).toEqual([0.59, 10]);
    // 15 levels of 10 shares from 0.50 to 0.64 hold about $85: $100 is only partly fillable, and the walk reached beyond the stored 10 levels (the first 10 hold about $54)
    expect(r.fills.by_usd["100"].filled_share).toBeGreaterThan(0.8); expect(r.fills.by_usd["100"].filled_share).toBeLessThan(1); expect(r.fills.by_usd["100"].limit_price).toBe(0.64);
  });
  it("a snapshot that became late while the cycle was running is recorded as MISSED, with no request", async () => {
    const w = world(); const db = shadowDb({ signals: [signal(1, 0)] }); let calls = 0; const job = new ShadowJob({ db: asDb(db), config: ON, http: w.http(), clockMs: w.clockMs, nowSec: () => (calls++ < 1 ? T0 : T0 + 500), log: () => {} });
    const s = await job.runCycle(); expect(s).toMatchObject({ snapshots: 0, missed: 1 }); expect(w.calls).toHaveLength(0); expect(db.T("shadow_books")[0]).toMatchObject({ status: "MISSED", request_count: 0 });
  });
  it("insertRows is insert-if-absent: a second write of the same (signal, offset) changes nothing", async () => {
    const db = shadowDb(); const a = missedRow({ signalId: uid(1), tokenId: "t", sourcePrice: 0.5, offsetS: 0, dueAtSec: T0 }, T0 + 1); const b = { ...a, status: "ERROR" as const, http_status: 500 };
    await insertRows(asDb(db), [a]); await insertRows(asDb(db), [b]); expect(db.T("shadow_books")).toHaveLength(1); expect(db.T("shadow_books")[0].status).toBe("MISSED");
  });
  it("the fee rate of a token is asked once and reused at the next offsets (cache)", async () => {
    const w = world(); const db = shadowDb({ signals: [signal(1, 0)] }); const job = mkJob(db, w);
    await job.runCycle(); w.set(T0 + 60); await job.runCycle(); w.set(T0 + 300); await job.runCycle();
    expect(w.calls.filter((c) => c.path === "/fee-rate")).toHaveLength(1); expect(w.calls.filter((c) => c.path === "/book")).toHaveLength(3);
    expect(db.T("shadow_books").map((r) => r.request_count).sort()).toEqual([1, 1, 2]);
  });
});

describe("public, unauthenticated, polite", () => {
  it("only GETs of /book and /fee-rate on the CLOB host, a descriptive User-Agent, no credential header, no cookie", async () => {
    const w = world(); const db = shadowDb({ signals: [signal(1, 0), signal(2, 1)] }); await mkJob(db, w).runCycle();
    expect(w.calls.length).toBeGreaterThan(0);
    for (const c of w.calls) { expect(c.method).toBe("GET"); expect(new URL(c.url).origin).toBe("https://clob.polymarket.com"); expect(["/book", "/fee-rate"]).toContain(c.path); expect(Object.keys(c.headers).map((k) => k.toLowerCase()).sort()).toEqual(["accept", "user-agent"]); expect(c.headers["User-Agent"]).toMatch(/polymarket-signal-engine-shadow-books.*read-only.*no orders/); }
  });
  it("never faster than the floor: at least 500 ms between request starts, across every signal and offset, and retries included", async () => {
    let n = 0; const w = world((p) => (p === "/book" && ++n % 4 === 0 ? { status: 500, body: "x" } : undefined));
    const db = shadowDb({ signals: Array.from({ length: 12 }, (_, i) => signal(i + 1, i)) }); await mkJob(db, w).runCycle();
    expect(w.calls.length).toBeGreaterThan(15); const gaps = w.calls.slice(1).map((c, i) => c.at - w.calls[i].at); expect(Math.min(...gaps)).toBeGreaterThanOrEqual(500);
  });
  it("makeShadowHttp cannot be made faster than 2 requests per second", () => { expect((makeShadowHttp() as any).gap).toBeGreaterThanOrEqual(500); });
});

describe("a refusal stops the job for the cycle, is recorded, and is never retried or worked around", () => {
  for (const status of [401, 403, 451]) it(`HTTP ${status}: one request, a REFUSED row, no retry, the rest of the cycle is not asked, and the job pauses`, async () => {
    const w = world(() => ({ status, body: { error: "forbidden" } })); const logs: string[] = []; const db = shadowDb({ signals: [signal(1, 0), signal(2, 1), signal(3, 2)] }); const job = mkJob(db, w, ON, logs);
    const s = await job.runCycle();
    expect(w.calls).toHaveLength(1); expect(s).toMatchObject({ refused: true, snapshots: 1 }); expect(db.T("shadow_books")).toHaveLength(1);
    expect(db.T("shadow_books")[0]).toMatchObject({ status: "REFUSED", http_status: status, bids: null, fills: null }); expect(logs.join("\n")).toMatch(/refused.*Not retried, not worked around; paused 60s/);
    const next = await job.runCycle(); expect(next.skipped).toBe("PAUSED"); expect(w.calls).toHaveLength(1); // still paused: no request
  });
  it("HTTP 429 is not retried or slept on; a Retry-After longer than the pause is honoured", async () => {
    const w = world(() => ({ status: 429, body: "slow down", headers: { "retry-after": "180" } })); const db = shadowDb({ signals: [signal(1, 0), signal(2, 1)] }); const job = mkJob(db, w);
    const t = w.nowSec(); const s = await job.runCycle();
    expect(w.calls).toHaveLength(1); expect(db.T("shadow_books")[0]).toMatchObject({ status: "REFUSED", http_status: 429 }); expect(s.pausedUntilSec! - t).toBeGreaterThanOrEqual(180); expect(s.pausedUntilSec! - t).toBeLessThanOrEqual(183); // Retry-After 180 s beats the 60 s default pause
  });
  it("after the pause the job asks again, once; a second consecutive refusal doubles the pause (to a cap), and a success resets it", async () => {
    let refuse = true; const w = world(() => (refuse ? { status: 403, body: "no" } : undefined)); const logs: string[] = [];
    const db = shadowDb({ signals: [signal(1, 0)] }); const job = mkJob(db, w, ON, logs);
    await job.runCycle(); expect(logs.at(-1)).toMatch(/paused 60s/); w.set(T0 + 61); await job.runCycle(); expect(logs.at(-1)).toMatch(/paused 120s/); expect(w.calls).toHaveLength(2);
    w.set(T0 + 61 + 121); refuse = false; const ok = await job.runCycle(); expect(ok.refused).toBe(false);
  });
  it("a success resets the refusal count: the next refusal pauses 60 s again, not 120 s", async () => {
    let mode: "no" | "ok" = "no"; const w = world(() => (mode === "no" ? { status: 403, body: "no" } : undefined)); const logs: string[] = [];
    const db = shadowDb({ signals: [signal(1, 0), signal(2, 0)] }); const job = mkJob(db, w, ON, logs);
    await job.runCycle(); expect(logs.at(-1)).toMatch(/paused 60s/); mode = "ok"; w.set(T0 + 61); await job.runCycle(); // a success
    db.T("signals").push({ ...signal(3, 0), created_at: new Date((T0 + 61) * 1000).toISOString() }); mode = "no"; w.set(T0 + 62); await job.runCycle(); expect(logs.at(-1)).toMatch(/paused 60s/);
  });
  it("the signal query itself leaves EXIT signals out", async () => {
    const db = shadowDb({ signals: [signal(1, 0), signal(2, 0, { kind: "EXIT" })] }); const got = await loadWindow(asDb(db), T0 + 1, () => false); expect(got.map((g) => g.id)).toEqual([uid(1)]);
  });
  it("a refusal on the fee-rate request ends the cycle too (the book row is kept, with an unknown fee)", async () => {
    const w = world((p) => (p === "/fee-rate" ? { status: 403, body: "no" } : undefined)); const db = shadowDb({ signals: [signal(1, 0), signal(2, 1)] }); const s = await mkJob(db, w).runCycle();
    expect(s.refused).toBe(true); expect(w.calls.map((c) => c.path)).toEqual(["/book", "/fee-rate"]); expect(db.T("shadow_books")).toHaveLength(1); expect(db.T("shadow_books")[0]).toMatchObject({ status: "OK", fee_source: "ASSUMED_UNKNOWN" });
  });
  it("a transient server error is retried at most once (maxAttempts 2) and then recorded as ERROR; it does not stop the cycle", async () => {
    const w = world((p, t) => (p === "/book" && t === "tok1" ? { status: 503, body: "x" } : undefined)); const db = shadowDb({ signals: [signal(1, 0), signal(2, 1)] }); const s = await mkJob(db, w).runCycle();
    expect(w.calls.filter((c) => c.token === "tok1" && c.path === "/book")).toHaveLength(2); expect(s.refused).toBe(false);
    expect(db.T("shadow_books").map((r) => r.status).sort()).toEqual(["ERROR", "OK"]); expect(db.T("shadow_books").find((r) => r.status === "ERROR")!.request_count).toBe(2);
  });
});

describe("budgets", () => {
  it("at most MAX_SNAPSHOTS_PER_CYCLE snapshots per cycle; the rest wait for the next cycle", async () => {
    const w = world(); const db = shadowDb({ signals: Array.from({ length: 45 }, (_, i) => signal(i + 1, 0, { token: "shared" })) }); const s = await mkJob(db, w).runCycle(); // one token: the fee rate is cached, one request per snapshot
    expect(s.snapshots).toBe(MAX_SNAPSHOTS_PER_CYCLE); expect(db.T("shadow_books")).toHaveLength(MAX_SNAPSHOTS_PER_CYCLE);
  });
  it("a time budget per cycle: no new snapshot starts after CYCLE_BUDGET_MS", async () => {
    const w = world(undefined, { perRequestMs: 4000 }); const db = shadowDb({ signals: Array.from({ length: 30 }, (_, i) => signal(i + 1, 0)) }); const t0 = w.clockMs(); const s = await mkJob(db, w).runCycle();
    expect(s.snapshots).toBeLessThan(MAX_SNAPSHOTS_PER_CYCLE); expect(s.snapshots).toBeGreaterThan(0); expect(w.clockMs() - t0).toBeLessThan(CYCLE_BUDGET_MS + 2 * (4000 + 500) + 1000);
  });
  it("the daily request budget stops snapshots with one clear log line per day, and later snapshots become MISSED", async () => {
    const w = world(); const logs: string[] = []; const db = shadowDb({ signals: Array.from({ length: 10 }, (_, i) => signal(i + 1, 0)) }); const job = mkJob(db, w, { ...ON, dailyRequests: 7 }, logs);
    const s = await job.runCycle(); expect(w.calls.length).toBeLessThanOrEqual(7); expect(s.skipped).toBe("DAILY_BUDGET"); expect(logs.filter((l) => /daily request budget reached/.test(l))).toHaveLength(1);
    await job.runCycle(); expect(logs.filter((l) => /daily request budget reached/.test(l))).toHaveLength(1); expect(w.calls.length).toBeLessThanOrEqual(7);
    w.set(T0 + 200); await job.runCycle(); expect(db.T("shadow_books").filter((r) => r.status === "MISSED").length).toBeGreaterThan(0); expect(w.calls.length).toBeLessThanOrEqual(7);
  });
  it("the daily count survives a restart: it is read back from the rows of the same UTC day", async () => {
    const w = world(); const db = shadowDb({ signals: Array.from({ length: 10 }, (_, i) => signal(i + 1, 0)) }); await mkJob(db, w, { ...ON, dailyRequests: 6 }).runCycle(); const used = w.calls.length;
    const fresh = mkJob(db, w, { ...ON, dailyRequests: 6 }, []); const s = await fresh.runCycle(); expect(used).toBeGreaterThan(0); expect(used).toBeLessThanOrEqual(6); expect(w.calls.length).toBe(used); expect(s.snapshots).toBe(0); // the restarted job knows the budget is spent and asks for nothing more
  });
  it("requestsSince reads in pages and sums only today's rows", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ signal_id: uid(i), offset_s: 0, taken_at: new Date((T0 + i) * 1000).toISOString(), request_count: 2 })); const db = shadowDb({ shadow_books: rows });
    expect(await requestsSince(asDb(db), new Date(T0 * 1000).toISOString())).toBe(5000); expect(await requestsSince(asDb(db), new Date((T0 + 2000) * 1000).toISOString())).toBe(1000);
  });
});

describe("failure isolation", () => {
  it("a database error is caught, logged once, recorded as a status; the wrapper never throws", async () => {
    const w = world(); const db = shadowDb({ signals: [signal(1, 0)] }, { failOn: (t) => (t === "signals" ? new Error("db down") : null) }); const logs: string[] = []; const beats: string[] = [];
    const job = mkJob(db, w); const r = await runShadowCycleSafely(job, { db: asDb(db), log: (m) => logs.push(m), beat: async (_d, v) => { beats.push(v); } });
    expect(r).toEqual({ failed: expect.stringContaining("db down") }); expect(logs).toHaveLength(1); expect(logs[0]).toMatch(/cycle failed.*not affected/); expect(JSON.parse(beats[0])).toMatchObject({ ok: false }); expect(w.calls).toHaveLength(0);
  });
  it("a failing log function, a failing status write and a network that throws are all contained", async () => {
    const w = world(() => { throw new Error("socket exploded"); }); const db = shadowDb({ signals: [signal(1, 0)] });
    const r = await runShadowCycleSafely(mkJob(db, w), { db: asDb(db), log: () => { throw new Error("log broke"); }, beat: async () => { throw new Error("beat broke"); } }); expect(r).toBeDefined();
    const w2 = world(); const db2 = shadowDb({ signals: [signal(1, 0)] }, { failOn: () => new Error("everything fails") }); await expect(runShadowCycleSafely(mkJob(db2, w2), { db: asDb(db2), log: () => { throw new Error("log broke"); }, beat: async () => { throw new Error("beat broke"); } })).resolves.toEqual({ failed: expect.any(String) });
  });
  it("an error in the job never reaches the signal sweep, paper simulation or portfolio cycle: they are separate timers, and the cycle keeps running", async () => {
    let sim = 0, orphans = 0, portfolio = 0; const cycle = makeSimCycle({ orphans: async () => { orphans++; }, sim: async () => { sim++; }, portfolio: async () => { portfolio++; }, error: () => {} });
    const w = world(); const db = shadowDb({}, { failOn: () => new Error("shadow db failure") }); const job = mkJob(db, w); const logs: string[] = [];
    for (let i = 0; i < 3; i++) { await Promise.all([runShadowCycleSafely(job, { db: asDb(db), log: (m) => logs.push(m), beat: async () => {} }), cycle()]); }
    expect({ sim, orphans, portfolio }).toEqual({ sim: 3, orphans: 3, portfolio: 3 }); expect(logs).toHaveLength(3);
  });
  it("the worker wires the job on its own timer, outside makeSimCycle, only when the flag is on", async () => {
    const { readFileSync } = await import("node:fs"); const src = readFileSync("worker/ws-listener.ts", "utf8");
    const hook = src.split("\n").filter((l) => /shadow/i.test(l)); expect(hook.length).toBeLessThanOrEqual(9);
    const line = src.split("\n").find((l) => l.includes("if (shadow.on)"))!; expect(line).toBeDefined(); expect([line.indexOf("new ShadowJob"), line.indexOf("runShadowCycleSafely"), line.indexOf("setInterval(tick, SHADOW_CYCLE_MS)")].every((i, k, a) => i > 0 && (k === 0 || i > a[k - 1]))).toBe(true);
    const sim = src.slice(src.indexOf("makeSimCycle({"), src.indexOf("setTimeout(simulate")); expect(sim).not.toMatch(/shadow/i);
  });
  it("a cycle that starts while one is running returns at once (own busy guard)", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => (release = r)); const w = world(async () => { await gate; return respond(200, bookBody()); });
    const db = shadowDb({ signals: [signal(1, 0)] }); const job = mkJob(db, w); const first = job.runCycle(); await new Promise((r) => setTimeout(r, 20)); expect(job.isBusy()).toBe(true);
    expect(await job.runCycle()).toMatchObject({ skipped: "BUSY" }); release(); await first; expect(job.isBusy()).toBe(false);
  });
});

describe("memory stays bounded", () => {
  it("a huge signal backlog is read in bounded pages: never more than PAGE_SIZE × MAX_PAGES signals in one cycle", async () => {
    const sig = Array.from({ length: 6000 }, (_, i) => signal(i + 1, 3000 - Math.floor(i / 3)));
    const w = world(); const db = shadowDb({ signals: sig }); let returned = 0; const orig = db.from; (db as any).from = (t: string) => { const b = orig(t); if (t === "signals") { const then = b.then; b.then = (res: any, rej: any) => then((r: any) => { returned += r.data?.length ?? 0; return res(r); }, rej); } return b; };
    await mkJob(db, w, { ...ON, minScore: 99 }).runCycle(); expect(returned).toBe(PAGE_SIZE * MAX_PAGES); // nothing measurable, so the job pages to its limit and no further
  });
  it("the fee cache never holds more than FEE_CACHE_MAX tokens, and ignores an entry older than its TTL", () => {
    const c = new FeeCache(3600, FEE_CACHE_MAX); for (let i = 0; i < FEE_CACHE_MAX * 4; i++) c.set(`t${i}`, 100, T0); expect(c.size).toBeLessThanOrEqual(FEE_CACHE_MAX);
    c.set("x", 50, T0); expect(c.get("x", T0 + 3599)).toBe(50); expect(c.get("x", T0 + 3600)).toBeNull();
  });
  it("the polite client keeps no per-request event list in the worker (a long-lived process would grow it for ever)", async () => {
    const w = world(); const http = w.http(); for (let i = 0; i < 50; i++) await http.getJson("https://clob.polymarket.com/book?token_id=x"); expect(http.events).toHaveLength(0); expect(http.requests).toBe(50);
  });
  it("one hundred cycles over a steady stream leave no growth in the job's own state", async () => {
    const w = world(); const db = shadowDb({ signals: [] }); const job = mkJob(db, w); const heap0 = process.memoryUsage().heapUsed;
    for (let c = 0; c < 100; c++) { const sigs = Array.from({ length: 5 }, (_, i) => signal(c * 10 + i + 1, 0)); sigs.forEach((s) => db.T("signals").push({ ...s, created_at: new Date(w.nowSec() * 1000).toISOString() })); await job.runCycle(); w.set(w.nowSec() + 15); }
    expect(job.fees.size).toBeLessThanOrEqual(FEE_CACHE_MAX); expect(process.memoryUsage().heapUsed - heap0).toBeLessThan(80 * 1024 * 1024); expect((w.http() as any).events).toHaveLength(0);
  });
});

describe("retention: pruned by the job, in bounded deletes", () => {
  const old = (i: number, days: number) => ({ signal_id: uid(i), offset_s: 0, due_at: new Date((T0 - days * 86400) * 1000).toISOString(), taken_at: new Date((T0 - days * 86400) * 1000).toISOString(), request_count: 1 });
  it("pruneBatch removes at most `batch` rows per call, oldest first, and never a row inside the retention window", async () => {
    const rows = [...Array.from({ length: 250 }, (_, i) => old(i + 1, 50 + i / 1000)), ...Array.from({ length: 20 }, (_, i) => old(1000 + i, 5))]; const db = shadowDb({ shadow_books: rows });
    const cutoff = new Date((T0 - RETENTION_DAYS * 86400) * 1000).toISOString();
    expect(await pruneBatch(asDb(db), cutoff, PRUNE_BATCH)).toBe(PRUNE_BATCH); expect(db.T("shadow_books")).toHaveLength(270 - PRUNE_BATCH);
    expect(await pruneBatch(asDb(db), cutoff, PRUNE_BATCH)).toBe(PRUNE_BATCH); expect(await pruneBatch(asDb(db), cutoff, PRUNE_BATCH)).toBe(50); expect(await pruneBatch(asDb(db), cutoff, PRUNE_BATCH)).toBe(0);
    expect(db.T("shadow_books")).toHaveLength(20); for (const w of db.writes.filter((x) => x.op === "delete")) expect(w.n).toBeLessThanOrEqual(PRUNE_BATCH);
  });
  it("a signal whose offsets straddle the cutoff loses only the rows older than it", async () => {
    const cutoff = T0 - RETENTION_DAYS * 86400; const row = (off: number, due: number) => ({ signal_id: uid(1), offset_s: off, due_at: new Date(due * 1000).toISOString(), taken_at: new Date(due * 1000).toISOString(), request_count: 1 });
    const db = shadowDb({ shadow_books: [row(0, cutoff - 1), row(300, cutoff + 299)] }); await pruneBatch(asDb(db), new Date(cutoff * 1000).toISOString(), PRUNE_BATCH); expect(db.T("shadow_books").map((r) => r.offset_s)).toEqual([300]);
  });
  it("a cycle prunes at most PRUNE_MAX_BATCHES batches, and at most once an hour", async () => {
    const rows = Array.from({ length: PRUNE_BATCH * (PRUNE_MAX_BATCHES + 3) }, (_, i) => old(i + 1, 60)); const db = shadowDb({ shadow_books: rows }); const w = world(); const job = mkJob(db, w);
    const s = await job.runCycle(); expect(s.pruned).toBe(PRUNE_BATCH * PRUNE_MAX_BATCHES); expect(db.T("shadow_books")).toHaveLength(PRUNE_BATCH * 3);
    w.set(T0 + 15); expect((await job.runCycle()).pruned).toBe(0); w.set(T0 + 3601); expect((await job.runCycle()).pruned).toBe(PRUNE_BATCH * 3);
  });
  it("a pruning failure is logged and does not fail the cycle", async () => {
    const w = world(); const logs: string[] = []; const db = shadowDb({ signals: [signal(1, 0)], shadow_books: [old(99, 60)] }, { failOn: (t, op) => (t === "shadow_books" && op === "delete" ? new Error("no delete for you") : null) }); const s = await mkJob(db, w, ON, logs).runCycle();
    expect(s.snapshots).toBe(1); expect(logs.join("\n")).toMatch(/pruning failed/);
  });
});
