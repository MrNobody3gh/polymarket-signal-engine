/**
 * Fix for the stale signals found in the step 10 dry run (28 Sep 2026).
 *  A. The portfolio start rule (D4) applies to the signal's source trade time as well as its simulated fill time, so a
 *     trade made before the start but detected after it never enters any mode's portfolio (requests.ts buildRequests;
 *     the runner and the D13 audit inherit it).
 *  B. Cursor hygiene: loading the watchlist deletes the poll cursors of wallets that are no longer tracked, so a wallet
 *     that returns at a later re-score is polled from the lookback window, not from where it left off
 *     (poll.ts pruneUntrackedCursors, called by SignalEngine.loadWallets).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fakeDb } from "./helpers/fakeDb";
import { stressDb } from "./helpers/stressDb";
import { pgDb } from "./helpers/pgDb";
import { buildSignals, loadBatchInputs, sweepSimulation, type SimInputs } from "@/lib/paper/sim/run";
import { MODES, type ModeName, type PortfolioConfig } from "@/lib/paper/sim/config";
import { timeline } from "@/lib/paper/sim/execute";
import { buildRequests } from "@/lib/paper/portfolio/requests";
import { runPortfolios } from "@/lib/paper/portfolio/run";
import { validatePortfolioConfig, portfolioDefinitions } from "@/lib/paper/portfolio/config";
import { auditDecisionInputs } from "@/lib/paper/portfolio/audit";
import { pollOnce, pruneUntrackedCursors } from "@/lib/signals/poll";
import { SignalEngine } from "@/lib/signals/engine";

const START = 1_790_000_000; const H = 3600;
const iso = (s: number) => new Date(s * 1000).toISOString();
const E = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ALL: ModeName[] = ["IDEAL", "REALISTIC", "CONSERVATIVE"];
afterEach(() => { vi.useRealTimers(); });

// ───────────────────────────── A. the start rule ─────────────────────────────
/** One entry signal: source trade at `src`, evaluated at `ev` (null = not recorded). */
const sig = (i: number, src: number, ev: number | null) => ({ id: E(i), kind: "NEW_POSITION", wallet: `w${i % 5}`, condition_id: `c${i % 7}`, token_id: `t${i}`, price: 0.4, usd: 2000, created_at: iso(src), evaluated_at: ev == null ? null : iso(ev) });
const inputs = (rows: Record<string, any>[]): SimInputs => ({ signals: rows, ledger: new Map(), marks: new Map(), resolutions: new Map(), markets: new Map(), obs: new Map() });
const requested = (rows: Record<string, any>[], mode: ModeName, startTs = START) => { const inp = inputs(rows); return buildRequests(buildSignals(inp), inp, MODES[mode], { startTs }).map((r) => r.signal.signalId).sort(); };

describe("A. the portfolio start rule applies to the source trade time and the fill time", () => {
  it("a signal traded before the start but evaluated (so filled) after it is excluded in every mode", () => {
    // the production shape: traded 4.6 days before the start, detected 1 h after it
    const stale = sig(1, START - Math.round(4.6 * 86_400), START + H); const fresh = sig(2, START + 60, START + 65);
    for (const m of ALL) {
      const inp = inputs([stale]); const b = buildSignals(inp)[0];
      if (m !== "IDEAL") expect(timeline(b.entry.sourceTs, b.entry.evalTs, MODES[m]).fillTs, m).toBeGreaterThan(START); // the old rule let it in
      expect(requested([stale, fresh], m), m).toEqual([E(2)]);
    }
    // also when the evaluation time was not recorded (CONSERVATIVE assumes 3,173 s of detection latency)
    const unrecorded = sig(3, START - 1000, null);
    expect(timeline(START - 1000, null, MODES.CONSERVATIVE).fillTs).toBeGreaterThan(START);
    for (const m of ALL) expect(requested([unrecorded], m), m).toEqual([]);
  });

  it("the boundary is exact: a trade in the start second is included in every mode, one second earlier is excluded", () => {
    for (const m of ALL) {
      expect(requested([sig(1, START, START + 5)], m), m).toEqual([E(1)]);
      expect(requested([sig(1, START - 1, START + 5)], m), m).toEqual([]);
      expect(requested([sig(1, START - 1, START - 1)], m), m).toEqual([]);
    }
    // the fill-time check is kept, and it is exactly `fill >= start`: IDEAL fills at the source time, so a source at
    // the start second fills at the start second and is in; at START + 1 with the source at the start it is also in
    expect(timeline(START, START, MODES.IDEAL).fillTs).toBe(START);
    expect(requested([sig(1, START, null)], "IDEAL", START + 1)).toEqual([]);
  });

  it("on the same inputs the three modes request exactly the same signals (random sources and detection lags around the start)", () => {
    let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const rows = Array.from({ length: 600 }, (_, i) => { const src = START + Math.floor((rnd() - 0.5) * 20 * 86_400); const lag = rnd() < 0.2 ? null : Math.floor(rnd() ** 3 * 211 * H); return sig(i, src, lag == null ? null : src + lag); });
    const sets = ALL.map((m) => requested(rows, m));
    expect(sets[1]).toEqual(sets[0]); expect(sets[2]).toEqual(sets[0]);
    const expected = rows.filter((r) => Math.floor(Date.parse(r.created_at) / 1000) >= START).map((r) => r.id).sort();
    expect(sets[0]).toEqual(expected); expect(expected.length).toBeGreaterThan(200); expect(expected.length).toBeLessThan(400);
    // why the fill check can never be the one that excludes: in every mode the fill is at or after the source trade
    for (const r of rows) { const b = buildSignals(inputs([r]))[0]; for (const m of ALL) expect(timeline(b.entry.sourceTs, b.entry.evalTs, MODES[m]).fillTs).toBeGreaterThanOrEqual(b.entry.sourceTs); }
  });
});

// ───────────────────────────── A through the runner and the audit ─────────────────────────────
function leaseDb() {
  const rpc: Record<string, (a: any) => any> = {}; const db = stressDb({ rpc });
  rpc.claim_portfolio_lease = ({ p_portfolio_id: id, p_owner: owner, p_seconds: s }: any) => { let r = db.T("portfolio_runs").find((x) => x.portfolio_id === id); const now = Math.floor(Date.now() / 1000);
    if (!r) { r = { portfolio_id: id, lease_owner: null, lease_until: null, stats: {} }; db.insertRow("portfolio_runs", r); }
    if (r.lease_until == null || Date.parse(r.lease_until) / 1000 <= now || r.lease_owner === owner) { r.lease_owner = owner; r.lease_until = iso(now + s); return true; } return false; };
  rpc.release_portfolio_lease = ({ p_portfolio_id: id, p_owner: owner }: any) => { const r = db.T("portfolio_runs").find((x) => x.portfolio_id === id); if (r && r.lease_owner === owner) { r.lease_owner = null; r.lease_until = null; } return true; };
  return db;
}
const ROOMY: PortfolioConfig = { startingCapitalUsd: 1_000_000, positionUsd: 25, maxMarketExposureUsd: 1_000_000, maxTotalExposurePct: 100, maxOpenPositions: 100_000, maxWalletAllocationUsd: 1_000_000, minCashReserveUsd: 0, allowResize: false };

/** 120 fresh signals after the start and 40 stale ones: traded 1–9 days before the start, evaluated 5–200 min after it. */
async function staleWorld() {
  const db = leaseDb(); let seed = 5; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); const stale: string[] = [], fresh: string[] = [];
  for (let i = 0; i < 160; i++) {
    const isStale = i % 4 === 0; const ev = START + 300 + i * 70; const src = isStale ? START - Math.floor((1 + rnd() * 8) * 86_400) : ev - 5 - Math.floor(rnd() * 40);
    db.insertRow("signals", { ...sig(i, src, ev), kind: ["NEW_POSITION", "CONVICTION_ADD", "CONSENSUS"][i % 3], source_fill_id: `f${i}` });
    db.insertRow("paper_ledger", { signal_id: E(i), created_at: iso(ev), sim_terminal: false, side: "LONG" }); (isStale ? stale : fresh).push(E(i));
  }
  for (let c = 0; c < 7; c++) db.insertRow("markets", { condition_id: `c${c}`, fees_enabled: true, taker_fee_rate: 0.02, tick_size: 0.01, min_order_shares: 5, meta_fetched_at: iso(START - 86_400) });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime((START + 2 * 86_400) * 1000);
  await sweepSimulation(db as never);
  for (const r of db.T("price_observations")) if (r.state === "PENDING") Object.assign(r, { state: "COMPLETE", obs_ts: r.as_of - 20, price: 0.3 + ((r.as_of * 7919) % 100) / 250, resolution_seconds: 0 });
  await sweepSimulation(db as never);
  return { db, stale, fresh };
}

describe("A through the runner and the D13 audit", () => {
  it("the runner decides only signals traded at or after the start, and the same ones in every mode", async () => {
    const { db, stale, fresh } = await staleWorld();
    // the stale rows really are in the stream for REALISTIC and CONSERVATIVE (their fill is after the start)
    for (const m of ["REALISTIC", "CONSERVATIVE"] as const) expect(db.T("paper_executions").filter((x) => x.mode === m && stale.includes(x.signal_id) && Date.parse(x.fill_ts) / 1000 > START).length, m).toBe(stale.length);
    const cfg = validatePortfolioConfig({ ...ROOMY, startTs: iso(START) }, START + 2 * 86_400);
    const out = await runPortfolios(db as never, { config: cfg, modes: ALL, owner: "t" });
    const decided = (m: ModeName) => db.T("portfolio_decisions").filter((d) => d.portfolio_id === out.find((s) => s.mode === m)!.portfolioId).map((d) => d.signal_id).sort();
    for (const m of ALL) { expect(decided(m), m).toEqual([...fresh].sort()); expect(out.find((s) => s.mode === m)!.staleRows, m).toBe(0); }
  });

  it("the D13 audit rebuilds requests with the same rule: a decision stored for a stale signal (as the old rule wrote it) is reported, the rest match", async () => {
    const { db, stale } = await staleWorld();
    const cfg = validatePortfolioConfig({ ...ROOMY, startTs: iso(START) }, START + 2 * 86_400);
    await runPortfolios(db as never, { config: cfg, modes: ["REALISTIC"], owner: "t" }); vi.setSystemTime((START + 2 * 86_400 + 900) * 1000);
    const def = portfolioDefinitions(cfg, ["REALISTIC"])[0];
    const clean = await auditDecisionInputs(db as never, def); expect(clean.mismatches).toBe(0); expect(clean.matches).toBe(clean.checked);
    // exactly what the old (fill-time-only) rule would have stored for a stale signal: its request built with no source
    // check, with that request's own fingerprint and fill time. Under the old rule the audit would find it matching.
    const inp = await loadBatchInputs(db as never, [stale[0]]);
    const old = buildRequests(buildSignals(inp), inp, MODES.REALISTIC, { startTs: START - 30 * 86_400, sourceFillIds: new Map([[stale[0], "f0"]]) })[0];
    expect(old.key.ts).toBeGreaterThan(START); expect(old.signal.entry.sourceTs).toBeLessThan(START);
    const template = db.T("portfolio_decisions").find((d) => d.portfolio_id === def.id)!;
    db.insertRow("portfolio_decisions", { ...template, signal_id: stale[0], kind: old.signal.kind, source_key: old.signal.sourceKey, event_ts: iso(old.key.ts), input_hash: old.fingerprint });
    const r = await auditDecisionInputs(db as never, def);
    expect(r.checked).toBe(clean.checked + 1); expect(r.mismatches).toBe(1); expect(r.matches).toBe(clean.matches);
    const ex = [...r.classes.d13.examples, ...r.classes.nextRun.examples, ...r.classes.unexplained.examples].find((e) => e.signalId === stale[0])!;
    expect(ex.parts).toEqual(["entry"]); expect(ex.rewindTo).toBe(old.key.ts);                                    // no current request: nothing to rebuild
  });
});

// ───────────────────────────── B. cursor hygiene ─────────────────────────────
const NOW = 1_790_500_000; const W = (c: string) => `0x${c.repeat(40)}`;
const A = W("a"), B = W("b"), C = W("c");
function watchlistDb(tracked: string[], untracked: string[], cursors: Record<string, number>) {
  const db = fakeDb();
  for (const w of tracked) db.T("wallets").push({ address: w, tracked: true, copy_score: 60, sources: [] });
  for (const w of untracked) db.T("wallets").push({ address: w, tracked: false, copy_score: 30, sources: [] });
  for (const [w, v] of Object.entries(cursors)) db.T("cursors").push({ key: `poll:${w}`, value: String(v), updated_at: iso(v) });
  db.T("cursors").push({ key: "refresh:last", value: String(NOW - 3600) }, { key: "paper:portfolio", value: "{}" }, { key: "health:last_portfolio", value: "{}" });
  return db;
}
const engineOn = (db: ReturnType<typeof fakeDb>, log: string[] = []) => new SignalEngine({ db: db as never, channels: {}, markets: { endDate: async () => null }, now: () => NOW, log: (m) => log.push(m) });
const cursorKeys = (db: ReturnType<typeof fakeDb>) => db.T("cursors").map((c) => c.key).sort();

describe("B. loading the watchlist removes the poll cursors of wallets no longer tracked", () => {
  it("a wallet that left the watchlist loses its cursor; tracked wallets' cursors and every other cursor are untouched", async () => {
    const db = watchlistDb([A, B], [C], { [A]: NOW - 600, [B]: NOW - 9 * 86_400, [C]: NOW - 10 * 86_400 });
    const tracked = { a: db.T("cursors").find((c) => c.key === `poll:${A}`)!, b: db.T("cursors").find((c) => c.key === `poll:${B}`)! }; const before = { a: { ...tracked.a }, b: { ...tracked.b } };
    const log: string[] = []; await engineOn(db, log).loadWallets();
    expect(cursorKeys(db)).toEqual(["health:last_portfolio", "paper:portfolio", `poll:${A}`, `poll:${B}`, "refresh:last"].sort());
    expect(db.T("cursors").find((c) => c.key === `poll:${A}`)).toEqual(before.a); expect(db.T("cursors").find((c) => c.key === `poll:${B}`)).toEqual(before.b); // even a 9-day-old tracked cursor
    expect(log).toEqual(["cursors: removed 1 poll cursor(s) of wallets no longer tracked"]);
  });

  it("a wallet that returns at a later re-score is polled from now − lookback, not from its old cursor", async () => {
    const db = watchlistDb([A], [C], { [A]: NOW - 600, [C]: NOW - 10 * 86_400 });
    const engine = engineOn(db); await engine.loadWallets();                                  // C leaves: its cursor goes
    db.T("wallets").find((w) => w.address === C)!.tracked = true; await engine.loadWallets(); // C returns at the next re-score
    const starts = new Map<string, number>(); const ingested: string[] = [];
    // C traded during its absence (3 days ago) and recently (1 h ago); A has nothing new
    const feed = { async *paginate(_p: string, params: Record<string, any>) { starts.set(params.user, Number(params.start)); if (params.user !== C) return;
      for (const t of [NOW - 3600, NOW - 3 * 86_400]) { if (t < Number(params.start)) return; yield { proxy_wallet: C, side: "BUY", size: 1000, price: 0.3, timestamp: t, token_id: "tok", condition_id: "0xcond", transaction_hash: `0x${t}` }; } } };
    await pollOnce(db as never, { trackedAddresses: () => engine.trackedAddresses(), async ingest(f) { ingested.push(f.id); return []; } }, feed as never, { now: NOW });
    expect(starts.get(C)).toBe(NOW - 6 * 3600); expect(starts.get(A)).toBe(NOW - 600);
    expect(ingested).toHaveLength(1); expect(ingested[0]).toContain(`0x${NOW - 3600}`);           // the 3-day-old fill is not replayed
    expect(db.T("cursors").find((c) => c.key === `poll:${C}`)!.value).toBe(String(NOW - 3600));
  });

  it("running it twice changes nothing; an empty tracked set deletes nothing; a failing prune never fails the load", async () => {
    const db = watchlistDb([A], [B, C], { [A]: NOW - 60, [B]: NOW - 86_400, [C]: NOW - 2 * 86_400 });
    expect(await pruneUntrackedCursors(db as never, [A])).toEqual({ scanned: 3, deleted: 2 });
    const after = JSON.stringify(db.T("cursors"));
    expect(await pruneUntrackedCursors(db as never, [A])).toEqual({ scanned: 1, deleted: 0 }); expect(JSON.stringify(db.T("cursors"))).toBe(after);
    const db2 = watchlistDb([], [A, B], { [A]: NOW - 60, [B]: NOW - 60 });
    expect(await pruneUntrackedCursors(db2 as never, [])).toMatchObject({ deleted: 0, skipped: "no tracked wallets" }); await engineOn(db2).loadWallets();
    expect(cursorKeys(db2).filter((k) => k.startsWith("poll:"))).toHaveLength(2);
    // a database that fails the cursor read: the wallets still load, the failure is logged
    const db3 = watchlistDb([A], [B], { [A]: NOW - 60, [B]: NOW - 60 }); const from = db3.from; const log: string[] = [];
    (db3 as any).from = (t: string) => (t === "cursors" ? { select: () => ({ like: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "timeout" } }) }) }) }) } : from(t));
    const loaded = await engineOn(db3, log).loadWallets(); expect([...loaded.keys()]).toEqual([A]); expect(log).toEqual(["cursors: prune failed (cursors read: timeout); will retry at the next wallet load"]);
  });

  it("bounded: 2,500 cursors are read in keyset pages and deleted in chunks of at most 100, and only untracked ones go", async () => {
    const db = stressDb(); const tracked: string[] = [];
    for (let i = 0; i < 2500; i++) { const w = `0x${String(i).padStart(40, "0")}`; if (i % 5 === 0) tracked.push(w); db.insertRow("cursors", { key: `poll:${w}`, value: String(NOW - i) }); }
    db.insertRow("cursors", { key: "refresh:last", value: "1" }); db.insertRow("cursors", { key: "poll", value: "not a wallet cursor" });
    const deletes: number[] = []; const from = db.from;
    (db as any).from = (t: string) => { const q = from(t); const del = q.delete; q.delete = () => { const d = del(); const inn = d.in; d.in = (k: string, v: any[]) => { deletes.push(v.length); return inn(k, v); }; return d; }; return q; };
    db.stats.maxRowsPerCall = 0;
    const r = await pruneUntrackedCursors(db as never, tracked, { page: 300 });
    expect(r).toEqual({ scanned: 2500, deleted: 2000 }); expect(db.stats.maxRowsPerCall).toBeLessThanOrEqual(300); expect(Math.max(...deletes)).toBeLessThanOrEqual(100);
    expect(db.T("cursors").map((c) => c.key).sort()).toEqual(["poll", "refresh:last", ...tracked.map((w) => `poll:${w}`)].sort());
  });
});

const PGURL = process.env.PG_TEST_URL; const dpg = PGURL ? describe : describe.skip;
dpg("B in real Postgres (all migrations, own database)", () => {
  it("prunes exactly the untracked wallets' poll cursors through the real cursors table (LIKE, keyset order, chunked IN delete)", async () => {
    const name = `stale_${process.pid}_${Date.now()}`; const admin = new pg.Client({ connectionString: PGURL }); await admin.connect(); await admin.query(`create database ${name}`); await admin.end();
    const u = new URL(PGURL!); u.pathname = `/${name}`; const c = new pg.Client({ connectionString: u.toString() }); await c.connect();
    try {
      const MIG = path.resolve(__dirname, "../supabase/migrations"); for (const f of readdirSync(MIG).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) await c.query(readFileSync(path.join(MIG, f), "utf8"));
      const tracked: string[] = [];
      for (let i = 0; i < 1300; i++) { const w = `0x${String(i).padStart(40, "0")}`; if (i % 3 === 0) tracked.push(w); await c.query("insert into cursors (key, value) values ($1, $2)", [`poll:${w}`, String(NOW - i)]); }
      await c.query("insert into cursors (key, value) values ('refresh:last', '1'), ('pollster', 'x'), ('paper:portfolio', '{}')");
      const db = pgDb(c);                                                             // Supabase-like 1,000-row read cap
      expect(await pruneUntrackedCursors(db as never, tracked)).toEqual({ scanned: 1300, deleted: 1300 - tracked.length });
      expect(await pruneUntrackedCursors(db as never, tracked)).toEqual({ scanned: tracked.length, deleted: 0 });
      const keys = (await c.query("select key from cursors order by key")).rows.map((r) => r.key);
      expect(keys.sort()).toEqual(["paper:portfolio", "pollster", "refresh:last", ...tracked.map((w) => `poll:${w}`)].sort());
    } finally { await c.end(); const a2 = new pg.Client({ connectionString: PGURL }); await a2.connect(); await a2.query(`drop database if exists ${name} with (force)`); await a2.end(); }
  }, 120_000);
});
