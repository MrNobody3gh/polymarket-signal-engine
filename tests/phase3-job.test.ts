/**
 * Phase 3 step 8: the portfolio job and the worker cycle (src/lib/paper/portfolio/job.ts), the /execution view
 * (view.ts), D10 (reason label) and D15 (report access, migration 0011), and the R4 rewind measurement on a
 * realistic 15-minute cycle world.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { stressDb } from "./helpers/stressDb";
import { runPortfolioJob, portfolioJobSetup, makeSimCycle, modeLine, type PortfolioJobDeps } from "@/lib/paper/portfolio/job";
import { runPortfolios, type PortfolioRunStats } from "@/lib/paper/portfolio/run";
import { buildPortfolioReport, savePortfolioSnapshot, PORTFOLIO_SNAPSHOT_KEY } from "@/lib/paper/portfolio/report";
import { portfolioView, OFF_MESSAGE, NO_RUN_MESSAGE, IDEAL_COLUMN_NOTE, INSUFFICIENT } from "@/lib/paper/portfolio/view";
import { validatePortfolioConfig, portfolioDefinitions, IDEAL_LABEL } from "@/lib/paper/portfolio/config";
import { PortfolioBook } from "@/lib/paper/portfolio/book";
import { simulatePortfolio, type PortfolioSignal } from "@/lib/paper/sim/portfolio";
import { sweepSimulation } from "@/lib/paper/sim/run";
import { timeline } from "@/lib/paper/sim/execute";
import { MODES, type ModeName, type PortfolioConfig } from "@/lib/paper/sim/config";
import type { BookSignal } from "@/lib/paper/portfolio/types";

const START = 1_790_000_000; const DAY = 86_400; const iso = (s: number) => new Date(s * 1000).toISOString();
const PC: PortfolioConfig = { startingCapitalUsd: 5_000, positionUsd: 100, maxMarketExposureUsd: 600, maxTotalExposurePct: 90, maxOpenPositions: 40, maxWalletAllocationUsd: 800, minCashReserveUsd: 100, allowResize: true };
const MIG = path.resolve(__dirname, "../supabase/migrations");
const setClock = (t: number) => vi.setSystemTime(t * 1000);
afterEach(() => { vi.useRealTimers(); });

type Db = ReturnType<typeof stressDb>;
function leaseDb(o: { maxRows?: number } = {}): Db {
  const rpc: Record<string, (a: any) => any> = {}; const db = stressDb({ rpc, maxRows: o.maxRows });
  rpc.claim_portfolio_lease = ({ p_portfolio_id: id, p_owner: owner, p_seconds: s }: any) => {
    let r = db.T("portfolio_runs").find((x) => x.portfolio_id === id); const now = Math.floor(Date.now() / 1000);
    if (!r) { r = { portfolio_id: id, lease_owner: null, lease_until: null, stats: {} }; db.insertRow("portfolio_runs", r); }
    if (r.lease_until == null || Date.parse(r.lease_until) / 1000 <= now || r.lease_owner === owner) { r.lease_owner = owner; r.lease_until = iso(now + s); return true; } return false;
  };
  rpc.release_portfolio_lease = ({ p_portfolio_id: id, p_owner: owner }: any) => { const r = db.T("portfolio_runs").find((x) => x.portfolio_id === id); if (r && r.lease_owner === owner) { r.lease_owner = null; r.lease_until = null; } return true; };
  rpc.portfolio_report = ({ p_portfolio_id: id }: any) => { // the JS reference over the in-memory rows stands in for the SQL function
    const p = db.T("portfolios").find((x) => x.id === id) ?? null; const mine = (t: string) => db.T(t).filter((x) => x.portfolio_id === id); const lots = mine("portfolio_lots"); const ids = new Set(lots.map((l) => l.signal_id));
    return buildPortfolioReport({ portfolio: p, run: mine("portfolio_runs")[0] ?? null, decisions: mine("portfolio_decisions"), lots, equity: mine("portfolio_equity"), marks: db.T("paper_marks").filter((m) => ids.has(m.signal_id)),
      executionFillTs: p ? db.T("paper_executions").filter((e) => e.mode === p.mode).map((e) => e.fill_ts) : [], now: Math.floor(Date.now() / 1000) });
  };
  return db;
}
const dump = (db: Db) => JSON.stringify(Object.entries(db.tables).filter(([, r]) => r.length).sort(([a], [b]) => a.localeCompare(b)));
const cfg = (now: number, pc = PC) => validatePortfolioConfig({ ...pc, startTs: iso(START) }, now);

// ───────────────────────────── a realistic 15-minute world ─────────────────────────────
/**
 * Signals arrive over `hours` with the observed source→evaluation latency (median 134 s, p90 3,173 s, a tail to hours;
 * plan §A), under random uuids. Each cycle at time C, as in the worker: the price backlog fetches observations whose
 * time has passed; the sweep pages the ledger by signal_id while new signals keep arriving (inserted between its
 * batches, so a signal whose id is below the sweep's cursor waits for the next cycle); then the portfolio runner.
 * Exits arrive at their own evaluation time; resolutions are discovered 10–90 minutes after they happen.
 */
function cycleWorld(o: { hours: number; perHour: number; seed: number }) {
  const db = leaseDb(); let seed = o.seed; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join("");
  let serial = 0; const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${String(++serial).padStart(12, "0")}`; // random order, never repeats
  const latency = () => { const u = rnd(); return u < 0.5 ? 20 + Math.floor(rnd() * 114) : u < 0.9 ? 134 + Math.floor(rnd() * 3040) : 3173 + Math.floor(rnd() * 20_000); };
  type Ev = { at: number; apply: () => void };
  const events: Ev[] = []; const n = Math.floor(o.hours * o.perHour);
  for (let i = 0; i < n; i++) {
    const src = START + Math.floor(rnd() * o.hours * 3600); const ev = src + latency(); const id = uuid(); const tok = `t${i}`; const wallet = `w${Math.floor(rnd() * 12)}`;
    const s = { id, kind: ["NEW_POSITION", "NEW_POSITION", "CONVICTION_ADD", "EARLY_ENTRY", "CONSENSUS"][Math.floor(rnd() * 5)], wallet, condition_id: `c${Math.floor(rnd() * 25)}`, token_id: tok, price: 0.1 + rnd() * 0.8, usd: 50 + rnd() * 3000, created_at: iso(src), evaluated_at: iso(ev), source_fill_id: `f-${id}` };
    events.push({ at: ev, apply: () => { db.insertRow("signals", s); db.insertRow("paper_ledger", { signal_id: id, created_at: iso(ev), sim_terminal: false, side: "LONG" }); } });
    if (rnd() < 0.45) { const xs = src + 120 + Math.floor(rnd() * 6 * 3600); const xe = xs + latency(); const xid = uuid();
      events.push({ at: xe, apply: () => { db.insertRow("signals", { id: xid, kind: "EXIT", wallet, condition_id: s.condition_id, token_id: tok, price: 0.1 + rnd() * 0.8, usd: rnd() < 0.3 ? 20 : 3000, created_at: iso(xs), evaluated_at: iso(xe) }); db.insertRow("paper_ledger", { signal_id: xid, created_at: iso(xe), sim_terminal: true, side: "EXIT_EVENT" }); } }); }
    if (rnd() < 0.35) { const rt = src + 600 + Math.floor(rnd() * 8 * 3600); const seen = rt + 600 + Math.floor(rnd() * 4800); const value = rnd() < 0.5 ? 1 : 0;
      events.push({ at: seen, apply: () => db.insertRow("token_resolutions", { token_id: tok, value, resolved_ts: iso(rt) }) }); }
    if (rnd() < 0.5) { const mt = src + 3600; events.push({ at: mt + 300, apply: () => db.insertRow("paper_marks", { signal_id: id, horizon: "1h", observed_at: iso(mt), price: rnd() }) }); }
  }
  events.sort((a, b) => a.at - b.at);
  for (let c = 0; c < 9; c++) db.insertRow("markets", { condition_id: `c${c}`, fees_enabled: true, taker_fee_rate: 0.02, tick_size: 0.01, min_order_shares: 5, meta_fetched_at: iso(START - DAY) });
  let next = 0; const arriveUntil = (until: number) => { while (next < events.length && events[next].at <= until) events[next++].apply(); };
  const unit = (k: string) => { let h = 2166136261; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 2 ** 32; };
  /** One worker cycle at time C: backlog (prices whose time has passed) → sweep (arrivals continue during it) → portfolios. */
  async function cycle(C: number, run: (now: number) => Promise<PortfolioRunStats[]>, o: { arrivals?: boolean } = {}) {
    const arrive = o.arrivals === false ? () => {} : arriveUntil; setClock(C); arrive(C);
    for (const r of db.T("price_observations")) if (r.state === "PENDING" && r.as_of <= C) { const v = unit(`${r.token_id}@${r.as_of}`); Object.assign(r, v < 0.04 ? { state: "UNAVAILABLE" } : { state: "COMPLETE", obs_ts: r.as_of - Math.floor(v * 120), price: 0.05 + ((v * 7919) % 1) * 0.9, resolution_seconds: 0 }); }
    let t = C; await sweepSimulation(db as never, { batchSize: 40, onBatch: () => { t += 8; setClock(t); arrive(t); } }); // ~8 s per batch
    t += 5; setClock(t); return run(t);
  }
  return { db, cycle, arriveAll: () => arriveUntil(Infinity), events };
}

describe("R4: rewinds on a realistic 15-minute cycle (no safety lag)", () => {
  for (const seed of [17, 29]) it(`counts rewinds per mode, keeps the rolling 20-run counter, and ends equal to a fresh replay (world ${seed})`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const w = cycleWorld({ hours: 12, perHour: 45, seed }); const hist: Record<string, boolean[]> = { IDEAL: [], REALISTIC: [], CONSERVATIVE: [] };
    const dist: Record<string, number[]> = { IDEAL: [], REALISTIC: [], CONSERVATIVE: [] }; const reasons: Record<string, Record<string, number>> = { IDEAL: {}, REALISTIC: {}, CONSERVATIVE: {} };
    const rows: Record<string, { rewound: number[]; plain: number[] }> = { IDEAL: { rewound: [], plain: [] }, REALISTIC: { rewound: [], plain: [] }, CONSERVATIVE: { rewound: [], plain: [] } };
    const conf = cfg(START + 30 * DAY); let runs = 0;
    for (let C = START + 15 * 60; C <= START + 14 * 3600; C += 15 * 60) {
      const out = await w.cycle(C, (now) => runPortfolios(w.db as never, { config: conf, owner: "worker", now: () => now })); runs++;
      for (const s of out) {
        const rewound = s.rewind.to != null || s.rewind.reasons.length > 0; hist[s.mode].push(rewound); rows[s.mode][rewound ? "rewound" : "plain"].push(s.rowsRead);
        if (rewound) { dist[s.mode].push(s.rewindDistanceSec); const k = (s.rewind.reasons[0] ?? "?").replace(/ [0-9a-f]{8} at .*| at \d{4}-.*/, ""); reasons[s.mode][k] = (reasons[s.mode][k] ?? 0) + 1; }
        expect(s.rewindsLast20, s.mode).toBe(hist[s.mode].slice(-20).filter(Boolean).length);                // rolling counter
        const stored = w.db.T("portfolio_runs").find((r) => r.portfolio_id === s.portfolioId)!.stats;
        expect(stored.rewindHistory).toEqual(hist[s.mode].slice(-20)); expect(stored.rewindsLast20).toBe(s.rewindsLast20);
      }
    }
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null);
    const summary = Object.fromEntries(Object.keys(hist).map((m) => [m, { runs: hist[m].length, rewound: hist[m].filter(Boolean).length, lastTwenty: hist[m].slice(-20).filter(Boolean).length, medianDistanceSec: med(dist[m]), maxDistanceSec: dist[m].length ? Math.max(...dist[m]) : null, reasons: reasons[m],
      meanRowsRewound: rows[m].rewound.length ? Math.round(rows[m].rewound.reduce((a, b) => a + b, 0) / rows[m].rewound.length) : null, meanRowsOtherwise: rows[m].plain.length ? Math.round(rows[m].plain.reduce((a, b) => a + b, 0) / rows[m].plain.length) : null }]));
    if (process.env.REWIND_OUT) require("node:fs").writeFileSync(`${process.env.REWIND_OUT}.${seed}.json`, JSON.stringify(summary, null, 1));
    expect(runs).toBeGreaterThan(50); for (const m of Object.keys(hist)) expect(hist[m].length).toBe(runs);
    // correctness under realistic ordering: after a few more ordinary cycles (backlog → sweep → runner, no new signals),
    // the incrementally maintained portfolios equal a fresh replay of the final data (itself run until its queued
    // prices are fetched)
    let now = START + 14 * 3600; let again: PortfolioRunStats[] = [];
    for (let k = 0; k < 3; k++) { now += 15 * 60; again = await w.cycle(now, (t) => runPortfolios(w.db as never, { config: conf, owner: "worker", now: () => t })); }
    const fresh = leaseDb(); for (const t of ["signals", "paper_ledger", "paper_marks", "token_resolutions", "markets", "price_observations", "paper_executions"]) for (const r of w.db.T(t)) fresh.insertRow(t, { ...r });
    let f: PortfolioRunStats[] = [];
    for (let k = 0; k < 4; k++) {
      now += 60; setClock(now);
      for (const r of fresh.T("price_observations")) if (r.state === "PENDING" && r.as_of <= now) { const v = ((r.as_of * 2654435761) % 1000) / 1000; Object.assign(r, { state: "COMPLETE", obs_ts: r.as_of - 30, price: 0.05 + v * 0.9, resolution_seconds: 0 }); }
      f = await runPortfolios(fresh as never, { config: conf, owner: "worker", now: () => now });
      if (k === 0) for (const s of f) expect(s.rowsRead, s.mode).toBeGreaterThan(300);                   // the first fresh run is a full replay
    }
    // the incremental side gets the same prices (the fresh replay may have queued ones the sweep never asked for), then one more run
    for (const r of fresh.T("price_observations")) if (!w.db.T("price_observations").some((x) => x.token_id === r.token_id && x.as_of === r.as_of)) w.db.insertRow("price_observations", { ...r });
    for (const r of w.db.T("price_observations")) { const x = fresh.T("price_observations").find((y) => y.token_id === r.token_id && y.as_of === r.as_of); if (x) Object.assign(r, x); }
    now += 60; again = await w.cycle(now, (t) => runPortfolios(w.db as never, { config: conf, owner: "worker", now: () => t }), { arrivals: false }); // the sweep sees those prices; no new data after the copy
    for (const s of f) expect(s.frontier, s.mode).toBeNull();                                          // a fresh replay never stays stuck
    // (input_hash is compared separately: a record the sweep does not rewrite — e.g. a $100 position that exited before a
    // later resolution — keeps the old hash by design of change detection (§B2); see the targeted test below)
    // decisions compared without their hashes: a decided signal whose $100 record is sim_terminal and whose lot has closed
    // keeps its old input_hash when a resolution is learned later (not re-examined, D13); every figure is the same
    const out = (db: Db, pid: string) => ["portfolio_decisions", "portfolio_lots"].map((t) => db.T(t).filter((r) => r.portfolio_id === pid)
      .map(({ computed_at: _c, ...r }) => (t === "portfolio_decisions" ? (({ input_hash: _i, record_hash: _r, ...x }) => x)(r) : r)).sort((a, b) => (a.signal_id < b.signal_id ? -1 : 1)));
    const j = (x: unknown) => JSON.parse(JSON.stringify(x)); // as stored: −0 and 0 are one number in Postgres and in the record hashes
    // REALISTIC / CONSERVATIVE: identical. IDEAL may differ only through decision D13 (accepted): an exit detected after
    // its entry's $100 record went terminal and after the lot closed is never re-examined; IDEAL fills an exit at its
    // source time, so such a late exit can lie in the past. (REALISTIC / CONSERVATIVE fill it after detection.)
    const terminal = new Set(w.db.T("paper_ledger").filter((l) => l.sim_terminal).map((l) => l.signal_id)); const d13: string[] = [];
    for (const s of f) {
      const [a, b] = [j(out(w.db, s.portfolioId)), j(out(fresh, s.portfolioId))];
      if (s.mode !== "IDEAL") { expect(a, s.mode).toEqual(b); continue; }
      const lotsA = new Map<string, string>(a[1].map((l: any) => [l.signal_id, JSON.stringify(l)])), lotsB = new Map<string, string>(b[1].map((l: any) => [l.signal_id, JSON.stringify(l)]));
      const firstDiff = [...new Set([...lotsA.keys(), ...lotsB.keys()])].filter((k) => lotsA.get(k) !== lotsB.get(k)).sort((x, y) => (JSON.parse((lotsA.get(x) ?? lotsB.get(x))!).opened_ts < JSON.parse((lotsA.get(y) ?? lotsB.get(y))!).opened_ts ? -1 : 1))[0];
      if (firstDiff) { expect(terminal.has(firstDiff), `IDEAL first differing lot ${firstDiff} must be a D13 case`).toBe(true); d13.push(firstDiff); } else expect(a).toEqual(b);
    }
    if (process.env.REWIND_OUT) require("node:fs").writeFileSync(`${process.env.REWIND_OUT}.${seed}.d13.json`, JSON.stringify(d13));
    for (const s of f) if (!(s.mode === "IDEAL" && d13.length)) expect(j(again.find((x) => x.mode === s.mode)!.summary), s.mode).toEqual(j(s.summary));
  }, 240_000);
});

describe("runner: prices it waits for (found by the R4 world)", () => {
  // A signal whose $100 record is terminal is never swept again, so an exit that arrives later is never priced by the
  // sweep. An exit after the lot's resolution never matters (the book does not schedule it); one before it must be priced.
  async function world(exitAfterResolution: boolean) {
    vi.useFakeTimers({ toFake: ["Date"] }); const db = leaseDb(); const exec = MODES.REALISTIC;
    const E = "00000000-0000-4000-8000-000000000001", X = "00000000-0000-4000-9000-000000000001";
    const src = START + 600, ev = src + 40; const fill = timeline(src, ev, exec).fillTs; const res = fill + 3600; const xs = exitAfterResolution ? res + 600 : fill + 600; const xFill = timeline(xs, xs + 5, exec).fillTs;
    db.insertRow("signals", { id: E, kind: "NEW_POSITION", wallet: "w", condition_id: "c1", token_id: "tk", price: 0.4, usd: 3000, created_at: iso(src), evaluated_at: iso(ev), source_fill_id: "f1" });
    db.insertRow("signals", { id: X, kind: "EXIT", wallet: "w", condition_id: "c1", token_id: "tk", price: 0.5, usd: 3000, created_at: iso(xs), evaluated_at: iso(xs + 5) });
    db.insertRow("paper_ledger", { signal_id: E, created_at: iso(ev), sim_terminal: true, side: "LONG" }); db.insertRow("paper_ledger", { signal_id: X, created_at: iso(xs + 5), sim_terminal: true, side: "EXIT_EVENT" });
    db.insertRow("paper_executions", { signal_id: E, mode: "REALISTIC", fill_ts: iso(fill), computed_at: iso(START), state: "RESOLVED", coverage_state: "SIMULATED", record_hash: "x" });
    db.insertRow("price_observations", { token_id: "tk", as_of: fill, state: "COMPLETE", obs_ts: fill - 10, price: 0.41, resolution_seconds: 0 });
    db.insertRow("token_resolutions", { token_id: "tk", value: 1, resolved_ts: iso(res) });
    const now = START + DAY; setClock(now);
    const [s] = await runPortfolios(db as never, { config: cfg(now), modes: ["REALISTIC"], owner: "t", now: () => now });
    return { db, s, xFill, fill };
  }
  it("an exit after the lot's resolution never holds the frontier and is not queued", async () => {
    const { db, s, fill } = await world(true);
    expect(s.frontier).toBeNull(); expect(s.watermark).toBe(fill); expect(s.enqueued).toBe(0); expect(db.T("price_observations")).toHaveLength(1);
  });
  it("an exit before it is waited for — and queued for the backlog, so the replay continues next cycle", async () => {
    const { db, s, xFill } = await world(false);
    expect(s.frontier).toMatchObject({ ts: xFill, order: 1 }); expect(s.enqueued).toBe(1);
    expect(db.T("price_observations").find((r) => r.as_of === xFill)).toMatchObject({ token_id: "tk", state: "PENDING" });
    const dry = leaseDb(); for (const t of ["signals", "paper_ledger", "paper_executions", "price_observations", "token_resolutions"]) for (const r of db.T(t)) if (!(t === "price_observations" && r.as_of === xFill)) dry.insertRow(t, { ...r });
    const [d] = await runPortfolios(dry as never, { config: cfg(START + DAY), modes: ["REALISTIC"], owner: "t", dryRun: true, now: () => START + DAY });
    expect(d.enqueued).toBe(1); expect(dry.T("price_observations").some((r) => r.as_of === xFill)).toBe(false);                  // dry run: counted, not written
  });
  // Review (step 8): the tests above stop once the price is queued. Replay correctness needs the other half.
  const inputsOnly = (db: Db) => { const fresh = leaseDb(); for (const t of ["signals", "paper_ledger", "paper_executions", "price_observations", "token_resolutions", "markets", "paper_marks"]) for (const r of db.T(t)) fresh.insertRow(t, { ...r }); return fresh; };
  const laterSignal = (db: Db, src: number) => { const id = "00000000-0000-4000-a000-000000000009"; const ev = src + 40; const fill = timeline(src, ev, MODES.REALISTIC).fillTs;
    db.insertRow("signals", { id, kind: "NEW_POSITION", wallet: "w2", condition_id: "c2", token_id: "tk2", price: 0.3, usd: 3000, created_at: iso(src), evaluated_at: iso(ev), source_fill_id: "f9" });
    db.insertRow("paper_ledger", { signal_id: id, created_at: iso(ev), sim_terminal: true, side: "LONG" });
    db.insertRow("paper_executions", { signal_id: id, mode: "REALISTIC", fill_ts: iso(fill), computed_at: iso(START + DAY + 1), state: "OPEN", coverage_state: "SIMULATED", record_hash: "y" });
    db.insertRow("price_observations", { token_id: "tk2", as_of: fill, state: "COMPLETE", obs_ts: fill - 10, price: 0.31, resolution_seconds: 0 }); return fill; };
  const outputs = (db: Db) => JSON.stringify(["portfolio_decisions", "portfolio_lots", "portfolio_equity"].map((t) => db.T(t).map(({ computed_at: _c, ...r }) => r).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
  it("review: when the queued exit price arrives, the next run applies the exit, releases the frontier, and equals a fresh replay", async () => {
    const { db, xFill } = await world(false);
    Object.assign(db.T("price_observations").find((r) => r.as_of === xFill)!, { state: "COMPLETE", obs_ts: xFill - 5, price: 0.55, resolution_seconds: 0 }); // the backlog fetched it
    const later = laterSignal(db, xFill + 7200); // D12: the watermark moves past the exit only when a later entry is decided
    const now = START + DAY + 900; setClock(now);
    const [s2] = await runPortfolios(db as never, { config: cfg(START + DAY), modes: ["REALISTIC"], owner: "t", now: () => now });
    expect(s2.frontier).toBeNull(); expect(s2.enqueued).toBe(0); expect(s2.watermark).toBe(later);
    const lot = db.T("portfolio_lots")[0]; expect(lot.state).toBe("EXITED"); expect(Number(lot.exit_proceeds)).toBeGreaterThan(0); expect(Number(lot.shares_open)).toBeCloseTo(0, 9);
    const fresh = inputsOnly(db); const [f] = await runPortfolios(fresh as never, { config: cfg(START + DAY), modes: ["REALISTIC"], owner: "t", now: () => now });
    expect(outputs(db)).toBe(outputs(fresh)); expect(JSON.stringify(s2.summary)).toBe(JSON.stringify(f.summary));
  });
  it("review: an exit price that never existed (UNAVAILABLE) releases the frontier; the lot is held to its resolution, and equals a fresh replay", async () => {
    const { db, xFill } = await world(false);
    Object.assign(db.T("price_observations").find((r) => r.as_of === xFill)!, { state: "UNAVAILABLE", price: null, obs_ts: null });
    laterSignal(db, xFill + 7200); // past the resolution (fill + 3600), so the resolution is applied
    const now = START + DAY + 900; setClock(now);
    const [s2] = await runPortfolios(db as never, { config: cfg(START + DAY), modes: ["REALISTIC"], owner: "t", now: () => now });
    expect(s2.frontier).toBeNull();
    const lot = db.T("portfolio_lots")[0]; expect(lot.state).toBe("RESOLVED"); expect(Number(lot.resolution_value)).toBe(1); expect(lot.exit_ts ?? null).toBeNull();
    const fresh = inputsOnly(db); await runPortfolios(fresh as never, { config: cfg(START + DAY), modes: ["REALISTIC"], owner: "t", now: () => now });
    expect(outputs(db)).toBe(outputs(fresh));
  });
  it("review: while the exit price is still PENDING nothing after it is decided, and a retry that is still pending changes nothing", async () => {
    const { db, s, xFill } = await world(false); laterSignal(db, xFill + 7200); const before = outputs(db); // a later entry exists, yet must not be decided
    const now = START + DAY + 900; setClock(now);
    const [s2] = await runPortfolios(db as never, { config: cfg(START + DAY), modes: ["REALISTIC"], owner: "t", now: () => now });
    expect(s2.frontier).toEqual(s.frontier); expect(s2.watermark).toBe(s.watermark); expect(outputs(db)).toBe(before); expect(db.T("portfolio_lots")[0].state).toBe("OPEN");
  });
});

describe("runner: input_hash of decisions a rewind does not replay (D24)", () => {
  /** A fills; B (60 s later) is rejected with one slot, or fills with room; then one signal per hour. B's market resolves 3 h in, after a checkpoint. */
  const scenario = async (pcB: typeof PC) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mk = () => { const db = leaseDb(); const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      for (let i = 0; i < 8; i++) { const t = START + 60 + (i === 0 ? 0 : i === 1 ? 60 : (i - 1) * 3600);
        db.insertRow("signals", { id: id(i), kind: "NEW_POSITION", wallet: `w${i}`, condition_id: `c${i}`, token_id: `t${i}`, price: 0.5, usd: 2000, created_at: iso(t), evaluated_at: iso(t + 30), source_fill_id: `f${i}` });
        db.insertRow("paper_ledger", { signal_id: id(i), created_at: iso(t + 30), sim_terminal: false, side: "LONG" });
        db.insertRow("paper_executions", { signal_id: id(i), mode: "IDEAL", fill_ts: iso(t), computed_at: iso(START), state: "OPEN", coverage_state: "SIMULATED", record_hash: "x" }); }
      return { db, B: id(1) }; };
    const now = START + 8 * 3600; setClock(now); const w = mk();
    const [s1] = await runPortfolios(w.db as never, { config: cfg(now, pcB), modes: ["IDEAL"], owner: "t", now: () => now });
    const before = { ...w.db.T("portfolio_decisions").find((r) => r.signal_id === w.B)! };                              // a copy: rows are updated in place
    const late = (db: Db) => { db.insertRow("token_resolutions", { token_id: "t1", value: 1, resolved_ts: iso(START + 3 * 3600) }); for (const r of db.T("paper_executions")) if (r.signal_id === w.B) r.computed_at = iso(now + 30); };
    late(w.db); setClock(now + 60); const writesBefore = JSON.stringify(w.db.stats.writes);
    const [s2] = await runPortfolios(w.db as never, { config: cfg(now, pcB), modes: ["IDEAL"], owner: "t", now: () => now + 60 });
    const f = mk(); late(f.db); const [sf] = await runPortfolios(f.db as never, { config: cfg(now, pcB), modes: ["IDEAL"], owner: "t", now: () => now + 60 });
    const after = w.db.T("portfolio_decisions").find((r) => r.signal_id === w.B)!, fresh = f.db.T("portfolio_decisions").find((r) => r.signal_id === w.B)!;
    setClock(now + 120); const [s3] = await runPortfolios(w.db as never, { config: cfg(now, pcB), modes: ["IDEAL"], owner: "t", now: () => now + 120 });
    return { s1, s2, s3, sf, before, after, fresh, w, writesBefore };
  };

  it("a late resolution on a decision that never opened a lot is not a change: no rewind, no write, the stored hash stays", async () => {
    const r = await scenario({ ...PC, maxOpenPositions: 1 });
    expect(r.before.outcome).toBe("REJECTED");
    expect(r.s2.rewind.to).toBeNull(); expect(r.s2.rewind.reasons).toEqual([]); expect(r.s2.writes).toEqual({}); expect(r.s2.deletes).toEqual({});
    expect(r.after.input_hash).toBe(r.before.input_hash); expect(r.after.record_hash).toBe(r.before.record_hash);           // stored values stay as they are
    expect(r.after.input_hash).not.toBe(r.fresh.input_hash);                                                                   // (a fresh replay stores the whole current hash)
    expect(r.after.input_hash.split("|")[0]).toBe(r.fresh.input_hash.split("|")[0]);                                           // the entry part is the same
    const { input_hash: _a, record_hash: _b, ...x } = r.after, { input_hash: _c, record_hash: _d, ...y } = r.fresh; void [_a, _b, _c, _d]; expect(x).toEqual(y);   // every other column identical
    expect(r.s3.rewind.to).toBeNull(); expect(r.s3.writes).toEqual({});
  });

  it("…while the same late resolution on a decision that opened a lot is still detected, replayed or re-linked, and its whole hash kept current (no stale hash, no repeat rewind)", async () => {
    const r = await scenario(PC);
    expect(r.before.outcome).toBe("FILLED");
    expect(r.s2.rewind.to).toBe(START + 3 * 3600); expect(r.s2.rewind.restoredFrom!).toBeGreaterThan(START + 120);          // B's decision lies before the restored checkpoint
    expect(r.after.input_hash).not.toBe(r.before.input_hash); expect(r.after.input_hash).toBe(r.fresh.input_hash); expect(r.after.record_hash).toBe(r.fresh.record_hash);
    expect(r.s3.rewind.to).toBeNull(); expect(r.s3.writes).toEqual({});                                                        // nothing is left to rewind for: the next run is quiet
  });
});

describe("portfolio job (R1, R2)", () => {
  const fakeStats = (mode: ModeName, o: Partial<PortfolioRunStats> = {}): PortfolioRunStats => ({ portfolioId: `p-${mode}`, mode, dryRun: false, rowsRead: 10, batches: 1, staleRows: 0, enqueued: 0, decisions: { FILLED: 2 }, rewind: { to: null, restoredFrom: null, reasons: [] },
    previousWatermark: null, rewindDistanceSec: 0, rewindsLast20: 0, frontier: null, watermark: START + 100, writes: { portfolio_decisions: 2 }, deletes: {}, durationMs: 3, memory: null, summary: null, ...o });
  const spyDb = () => { const calls: string[] = []; return { calls, db: { from: (t: string) => { calls.push(`from:${t}`); throw new Error("no table access expected"); }, rpc: (f: string) => { calls.push(`rpc:${f}`); throw new Error("no rpc expected"); } } }; };

  it("test 1: order is runPortfolios (each mode) → snapshot → heartbeat; the result is compact; no snapshot when every mode throws", async () => {
    const order: string[] = []; const conf = cfg(START + DAY);
    const deps: PortfolioJobDeps = { config: conf, now: () => START + DAY, log: () => {},
      run: (async (_db: unknown, o: any) => { order.push(`run:${o.modes[0]}`); return [fakeStats(o.modes[0], o.modes[0] === "REALISTIC" ? { rewind: { to: START + 50, restoredFrom: START + 40, reasons: ["late signal 1234abcd at x"] }, rewindDistanceSec: 60, rewindsLast20: 3 } : {})]; }) as never,
      snapshot: (async () => { order.push("snapshot"); return null; }) as never, beat: async () => { order.push("beat"); } };
    const r = await runPortfolioJob({} as never, deps);
    expect(order).toEqual(["run:IDEAL", "run:REALISTIC", "run:CONSERVATIVE", "snapshot", "beat"]);
    if (r.off) throw new Error("unexpected");
    expect(r.snapshotSaved).toBe(true); expect(r.modes.map((m) => m.mode)).toEqual(["IDEAL", "REALISTIC", "CONSERVATIVE"]);
    expect(r.modes[1]).toMatchObject({ rewound: true, rewindTo: START + 50, rewindDistanceSec: 60, firstReason: "late signal 1234abcd at x", rewindsLast20: 3, watermark: START + 100, rowsRead: 10, decisions: { FILLED: 2 } });
    expect(r.modes[0]).toMatchObject({ rewound: false, rewindDistanceSec: 0, firstReason: null });
    // every mode throws → no snapshot, no heartbeat, the job throws (the cycle logs it)
    order.length = 0;
    await expect(runPortfolioJob({} as never, { ...deps, run: (async () => { order.push("run"); throw new Error("lease lost"); }) as never })).rejects.toThrow(/every mode failed.*lease lost/);
    expect(order).toEqual(["run", "run", "run"]);
    // one mode throws → the others still run and the snapshot is saved, the failure reported
    order.length = 0;
    const r2 = await runPortfolioJob({} as never, { ...deps, run: (async (_d: unknown, o: any) => { order.push(`run:${o.modes[0]}`); if (o.modes[0] === "REALISTIC") throw new Error("rewind did not converge"); return [fakeStats(o.modes[0])]; }) as never });
    expect(order).toEqual(["run:IDEAL", "run:REALISTIC", "run:CONSERVATIVE", "snapshot", "beat"]);
    if (r2.off) throw new Error("unexpected"); expect(r2.modes[1]).toMatchObject({ mode: "REALISTIC", failed: "rewind did not converge" });
    expect(modeLine(r2.modes[1])).toBe("REALISTIC: FAILED — rewind did not converge"); expect(modeLine(r.modes[1])).toMatch(/^REALISTIC: watermark .* rewound 60s \(late signal 1234abcd at x\) · rewinds in last 20 runs: 3/);
  });

  it("test 1 (end to end): a real run writes the snapshot and the health:last_portfolio heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); const w = cycleWorld({ hours: 3, perHour: 30, seed: 5 }); w.arriveAll(); await w.cycle(START + 5 * 3600, async () => []); await w.cycle(START + 6 * 3600, async () => []);
    const now = START + 6 * 3600 + 100; setClock(now); const logs: string[] = [];
    const r = await runPortfolioJob(w.db as never, { config: cfg(now), now: () => now, log: (m) => logs.push(m) });
    if (r.off) throw new Error("unexpected"); expect(r.snapshotSaved).toBe(true);
    const snap = JSON.parse(w.db.T("cursors").find((c) => c.key === PORTFOLIO_SNAPSHOT_KEY)!.value); expect(snap.portfolios).toHaveLength(3); expect(snap.portfolios[1].report.asOf.ts).toBe(r.modes[1].watermark);
    const hb = JSON.parse(w.db.T("cursors").find((c) => c.key === "health:last_portfolio")!.value); expect(hb.modes.map((m: any) => m.mode)).toEqual(["IDEAL", "REALISTIC", "CONSERVATIVE"]);
    expect(logs.filter((l) => l.startsWith("[portfolio] "))).toHaveLength(3); expect(r.modes.every((m) => m.rowsRead > 0 && m.heapAfterMb != null)).toBe(true);
  });

  it("test 2: unset config — the job does nothing, writes nothing, makes no requests; boot logs one line", async () => {
    const { db, calls } = spyDb(); expect(await runPortfolioJob(db as never, { config: null })).toEqual({ off: true }); expect(calls).toEqual([]);
    const logs: string[] = []; const setup = portfolioJobSetup({}, START, (m) => logs.push(m));
    expect(setup.config).toBeNull(); expect(logs).toEqual(["portfolio: off (PAPER_PORTFOLIO_CONFIG unset)"]);
    expect(await runPortfolioJob(db as never, setup)).toEqual({ off: true }); expect(calls).toEqual([]);
  });

  it("test 3: invalid config — logged once at boot, feature off, never throws; the rest of the cycle keeps running", async () => {
    const logs: string[] = [];
    for (const bad of ["{not json", JSON.stringify({ ...PC, startTs: iso(START), maxTotalExposurePct: 150 }), JSON.stringify({ ...PC })]) {
      logs.length = 0; const setup = portfolioJobSetup({ PAPER_PORTFOLIO_CONFIG: bad }, START + DAY, (m) => logs.push(m));
      expect(setup.config).toBeNull(); expect(logs).toHaveLength(1); expect(logs[0]).toMatch(/^portfolio: off \(invalid configuration\) — PAPER_PORTFOLIO_CONFIG: /);
    }
    const setup = portfolioJobSetup({ PAPER_PORTFOLIO_CONFIG: "{bad" }, START, (m) => logs.push(m)); logs.length = 0;
    const seen: string[] = []; const cycle = makeSimCycle({ orphans: async () => { seen.push("orphans"); }, sim: async () => { seen.push("sim"); return "swept"; }, portfolio: setup.config ? async () => runPortfolioJob({} as never, setup) : null, error: (w) => seen.push(`error:${w}`) });
    for (let i = 0; i < 3; i++) expect(await cycle()).toEqual({ ran: true, sim: "swept", portfolio: null });
    expect(seen).toEqual(["orphans", "sim", "orphans", "sim", "orphans", "sim"]); expect(logs).toEqual([]);          // nothing more logged per cycle
  });

  it("test 4: PAPER_PORTFOLIO_DRY_RUN=1 — computed, logged, nothing written (no outputs, lease, runs row, snapshot or heartbeat)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); const w = cycleWorld({ hours: 3, perHour: 30, seed: 6 }); w.arriveAll(); await w.cycle(START + 5 * 3600, async () => []); await w.cycle(START + 6 * 3600, async () => []);
    const now = START + 6 * 3600 + 100; setClock(now);
    const logs: string[] = []; const setup = portfolioJobSetup({ PAPER_PORTFOLIO_CONFIG: JSON.stringify({ ...PC, startTs: iso(START) }), PAPER_PORTFOLIO_DRY_RUN: "1" }, now, (m) => logs.push(m));
    expect(setup.dryRun).toBe(true); expect(logs[0]).toMatch(/portfolio: on \(dry run: nothing written\)/);
    const before = dump(w.db); const r = await runPortfolioJob(w.db as never, { ...setup, now: () => now, log: (m) => logs.push(m) });
    expect(dump(w.db)).toBe(before);
    if (r.off) throw new Error("unexpected"); expect(r).toMatchObject({ dryRun: true, snapshotSaved: false }); expect(r.modes.every((m) => m.rowsRead > 0 && (m.writes.portfolio_decisions ?? 0) > 0)).toBe(true); // what it would write
    expect(logs).toContain("[portfolio] dry run: nothing written; snapshot and heartbeat not saved");
  });
});

describe("worker cycle (R3)", () => {
  it("test 5: a throwing portfolio job is logged; the sweep result is still returned and the next cycle runs", async () => {
    const seen: string[] = []; let n = 0;
    const cycle = makeSimCycle({ orphans: async () => { seen.push("orphans"); throw new Error("gamma down"); }, sim: async () => { seen.push("sim"); return { swept: ++n }; },
      portfolio: async () => { seen.push("portfolio"); throw new Error("lease lost during run"); }, error: (what, e) => seen.push(`error:${what}:${(e as Error).message}`) });
    expect(await cycle()).toEqual({ ran: true, sim: { swept: 1 }, portfolio: null });
    expect(await cycle()).toEqual({ ran: true, sim: { swept: 2 }, portfolio: null });
    expect(seen).toEqual(["orphans", "error:orphans:gamma down", "sim", "portfolio", "error:portfolio:lease lost during run", "orphans", "error:orphans:gamma down", "sim", "portfolio", "error:portfolio:lease lost during run"]);
  });

  it("test 6: no overlap — the portfolio job starts only after the sweep finished, and a cycle never starts while one is running", async () => {
    const seen: string[] = []; let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const cycle = makeSimCycle({ orphans: async () => { seen.push("orphans"); }, sim: async () => { seen.push("sim:start"); await gate; seen.push("sim:end"); }, portfolio: async () => { seen.push("portfolio:start"); await Promise.resolve(); seen.push("portfolio:end"); } });
    const first = cycle(); await Promise.resolve(); await Promise.resolve();
    expect(cycle.busy()).toBe(true); expect(await cycle()).toEqual({ ran: false });                                  // the interval fires again mid-sweep
    expect(seen).toEqual(["orphans", "sim:start"]);
    release(); await first; expect(cycle.busy()).toBe(false);
    expect(seen).toEqual(["orphans", "sim:start", "sim:end", "portfolio:start", "portfolio:end"]);
    // a portfolio job still running also holds the guard
    let rel2!: () => void; const g2 = new Promise<void>((r) => (rel2 = r));
    const c2 = makeSimCycle({ orphans: async () => {}, sim: async () => {}, portfolio: async () => { await g2; } });
    const p2 = c2(); await new Promise((r) => setTimeout(r, 0)); expect(c2.busy()).toBe(true); expect(await c2()).toEqual({ ran: false }); rel2(); await p2;
  });

  it("unset config: the cycle is exactly the pre-Phase-3 one (orphans → sim, nothing else)", async () => {
    const seen: string[] = []; const setup = portfolioJobSetup({}, START, () => {});
    const cycle = makeSimCycle({ orphans: async () => { seen.push("orphans"); }, sim: async () => { seen.push("sim"); }, portfolio: setup.config ? async () => seen.push("portfolio") : null });
    await cycle(); expect(seen).toEqual(["orphans", "sim"]);
    const worker = readFileSync(path.resolve(__dirname, "../worker/ws-listener.ts"), "utf8");                       // and the worker wires it that way
    expect(worker).toMatch(/portfolio: portfolio\.config \? \(\) => withMemLog\("portfolio", \(\) => runPortfolioJob\(db\(\), \{ \.\.\.portfolio/); expect(worker).toMatch(/makeSimCycle\(\{\s*orphans:[^\n]*withMemLog\("orphans"/);
  });
});

// ───────────────────────────── /execution view ─────────────────────────────
describe("portfolioView (R5, test 8)", () => {
  const verdict = /\b(best|worst|winner|winners|loser|top performer|outperform|underperform|recommend)\b/i;
  const flat = (v: ReturnType<typeof portfolioView>) => JSON.stringify(v);
  it("off, configured-but-no-run, and a full snapshot", async () => {
    const off = portfolioView(null, START); expect(off).toMatchObject({ state: "off", message: OFF_MESSAGE, sections: [] });
    const conf = cfg(START + DAY); const defs = portfolioDefinitions(conf);
    const noRun = portfolioView({ generatedAt: iso(START), portfolios: defs.map((d) => ({ portfolioId: d.id, mode: d.mode, report: null })) }, START); expect(noRun).toMatchObject({ state: "no-run", message: NO_RUN_MESSAGE });
    // a real snapshot from a real run
    vi.useFakeTimers({ toFake: ["Date"] }); const w = cycleWorld({ hours: 4, perHour: 30, seed: 8 }); w.arriveAll(); await w.cycle(START + 6 * 3600, async () => []); await w.cycle(START + 7 * 3600, async () => []);
    const now = START + 7 * 3600 + 60; setClock(now); await runPortfolioJob(w.db as never, { config: conf, now: () => now, log: () => {} });
    const snap = JSON.parse(w.db.T("cursors").find((c) => c.key === PORTFOLIO_SNAPSHOT_KEY)!.value); const v = portfolioView(snap, now + 60);
    expect(v.state).toBe("ready"); expect(v.modes).toEqual(["IDEAL", "REALISTIC", "CONSERVATIVE"]); expect(v.staleNote).toBeNull();
    expect(v.columnNotes).toEqual([IDEAL_COLUMN_NOTE, null, null]); expect(IDEAL_COLUMN_NOTE).toBe("non-causal baseline — not a strategy that could have been run");
    const sec = (t: string) => v.sections.find((s) => s.title === t)!; const rowOf = (t: string, l: string) => sec(t).rows.find((r) => r.label === l)!.values;
    expect(rowOf("Portfolio", "As of").every((x) => /^as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/.test(x))).toBe(true);
    expect(rowOf("Portfolio", "Baseline note")).toEqual([IDEAL_LABEL, "—", "—"]);
    for (const t of ["Capital (cost basis)", "P&L (cost basis)", "Market value (separate basis)", "Risk (cost basis, equity curve)", "Decisions", "Rejections by reason", "By signal kind", "Exposure", "Lots", "Robustness (settled lots, net of fees)", "Health"]) expect(sec(t), t).toBeTruthy();
    expect(sec("Market value (separate basis)").rows.map((r) => r.label)).toContain("Open lots without a mark (at cost)");
    expect(sec("Risk (cost basis, equity curve)").note).toMatch(/thinned to the last point per hour/); expect(sec("By signal kind").note).toMatch(/CONSENSUS is under-attributed/);
    expect(sec("Rejections by reason").note).toMatch(/not a risk limit/); expect(sec("Lots").rows.map((r) => r.label)).toContain("Locked unresolved (open 30+ days, no resolution)");
    expect(flat(v)).toContain(INSUFFICIENT);                                                                             // small samples say so
    expect(rowOf("By signal kind", "EARLY_ENTRY: win rate (settled lots)").every((x) => x.startsWith(INSUFFICIENT) || /%$/.test(x))).toBe(true);
    expect(flat(v)).not.toMatch(verdict); expect(flat(off) + flat(noRun)).not.toMatch(verdict);
    for (const s of v.sections) for (const r of s.rows) expect(r.values).toHaveLength(3);
    // a snapshot that stopped being refreshed says so
    expect(portfolioView(snap, now + 2 * 3600).staleNote).toMatch(/has not been refreshed for 2\.0 h/);
    // one mode not run yet, the others shown
    const partial = { ...snap, portfolios: snap.portfolios.map((p: any) => (p.mode === "CONSERVATIVE" ? { ...p, report: null } : p)) };
    expect(portfolioView(partial, now).sections[0].rows[0].values[2]).toBe("no run has finished yet");
  }, 60_000);
});

// ───────────────────────────── D10 ─────────────────────────────
describe("D10: REJECTED_BELOW_MIN_ORDER only for orders resized below the minimum (test 9)", () => {
  const exec = MODES.REALISTIC;
  /** Cash room forces a resize to $50 (reserve 100 of 150); the entry then fails for the given reason. */
  function sig(id: string, kind: "min" | "noAsk" | "noPrice" | "fits", i: number): BookSignal {
    const src = START + i * 600, ev = src + 30; const fill = timeline(src, ev, exec).fillTs;
    const price = kind === "noAsk" ? 0.9995 : 0.5; // above 0.96 the tick is 0.001: one tick of spread reaches $1
    return { signalId: id, kind: "NEW_POSITION", wallet: `w${i}`, conditionId: `c${i}`, tokenId: `t${i}`, sourceKey: `k${i}`, exitId: null, exit: null, resolution: null, mark: null,
      entry: { sourceTs: src, evalTs: ev, signalPrice: price, sourceUsd: 5000, obs: kind === "noPrice" ? null : { ts: fill - 5, price, resolutionSeconds: 0 },
        market: { feesEnabled: false, takerFeeRate: null, tickSize: 0.01, minOrderShares: kind === "min" ? 1000 : kind === "fits" ? 10 : 5 } } };
  }
  const pc: PortfolioConfig = { startingCapitalUsd: 150, positionUsd: 100, maxMarketExposureUsd: 1e6, maxTotalExposurePct: 100, maxOpenPositions: 100, maxWalletAllocationUsd: 1e6, minCashReserveUsd: 100, allowResize: true };
  const cases: [BookSignal["signalId"], "min" | "noAsk" | "noPrice", { outcome: string; reason: string }][] = [
    ["a", "min", { outcome: "REJECTED", reason: "REJECTED_BELOW_MIN_ORDER" }],     // resized below the minimum: a rejection
    ["b", "noAsk", { outcome: "UNFILLED", reason: "NO_ASK_BELOW_ONE" }],           // resized, then no ask: its own reason (was REJECTED_BELOW_MIN_ORDER)
    ["c", "noPrice", { outcome: "UNKNOWN", reason: "NO_PRICE_OBSERVATION" }],
  ];
  for (const [id, kind, want] of cases) it(`${kind}: ${want.outcome} / ${want.reason} — book and reference agree`, () => {
    const s = sig(id, kind, 1);
    const ref = simulatePortfolio([s as PortfolioSignal], exec, pc).decisions[0];
    const book = new PortfolioBook(exec, pc); book.submit(s); const d = book.take().decisions[0];
    expect({ outcome: ref.outcome, reason: ref.reason }).toEqual(want); expect({ outcome: d.outcome, reason: d.reason }).toEqual(want); expect(d.resized).toBe(true);
    expect(ref).toMatchObject({ requestedUsd: 100, filledUsd: 0 });
  });
  it("not resized: an order too small for the market's minimum stays UNFILLED / INSUFFICIENT_LIQUIDITY", () => {
    const s = sig("d", "min", 2); const roomy = { ...pc, startingCapitalUsd: 10_000, minCashReserveUsd: 0 };
    const ref = simulatePortfolio([s as PortfolioSignal], exec, roomy).decisions[0]; const book = new PortfolioBook(exec, roomy); book.submit(s); const d = book.take().decisions[0];
    for (const x of [ref, d]) expect({ outcome: x.outcome, reason: x.reason }).toEqual({ outcome: "UNFILLED", reason: "INSUFFICIENT_LIQUIDITY" });
    expect(d.resized).toBe(false);
  });
  it("a history mixing every branch: book = reference, and REJECTED_BELOW_MIN_ORDER never appears without REJECTED", () => {
    const sigs = (["min", "noAsk", "noPrice", "fits", "min", "noAsk", "fits", "noPrice"] as const).map((k, i) => sig(`m${i}`, k, i + 3));
    for (const p of [pc, { ...pc, allowResize: false }, { ...pc, startingCapitalUsd: 400 }]) {
      const ref = simulatePortfolio(sigs as PortfolioSignal[], exec, p); const book = new PortfolioBook(exec, p); for (const s of sigs) book.submit(s); book.advance(null);
      const out = book.take();
      expect(out.decisions.map((d) => ({ signalId: d.signalId, kind: d.kind, outcome: d.outcome, reason: d.reason, requestedUsd: d.requestedUsd, filledUsd: d.filledUsd, ts: d.ts }))).toEqual(ref.decisions);
      for (const d of [...ref.decisions, ...out.decisions]) if (d.reason === "REJECTED_BELOW_MIN_ORDER") expect(d.outcome).toBe("REJECTED");
    }
  });
});

// ───────────────────────────── D15 + migrations (real Postgres) ─────────────────────────────
const PGURL = process.env.PG_TEST_URL; const d = PGURL ? describe : describe.skip;
d("D15 and migrations 0001–0011 (real Postgres, own database)", () => {
  const name = `step8_${process.pid}_${Date.now()}`; let url = "";
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: PGURL }); await admin.connect(); await admin.query(`create database ${name}`); await admin.end();
    const u = new URL(PGURL!); u.pathname = `/${name}`; url = u.toString();
  });
  afterAll(async () => { const admin = new pg.Client({ connectionString: PGURL }); await admin.connect(); await admin.query(`drop database if exists ${name} with (force)`); await admin.end(); });

  it("test 11 + 10: 0001–0011 apply from scratch; 0011 re-runs; service role may call the report functions, anon and authenticated may not", async () => {
    const c = new pg.Client({ connectionString: url }); await c.connect();
    try {
      const files = readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort(); expect(files.map((f) => f.slice(0, 4))).toEqual(["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011"]);
      for (const f of files) await c.query(readFileSync(path.join(MIG, f), "utf8"));
      await c.query(readFileSync(path.join(MIG, "0011_portfolio_report_access.sql"), "utf8")); await c.query(readFileSync(path.join(MIG, "0011_portfolio_report_access.sql"), "utf8"));
      // as on Supabase: the API roles can use the schema and read tables (RLS decides rows); execute is the question here
      await c.query("grant usage on schema public to anon, authenticated, service_role; grant select on all tables in schema public to anon, authenticated, service_role");
      await c.query("insert into portfolios (id, mode, exec_config_hash, config, config_hash, start_ts) values ('d15-portfolio','REALISTIC','e','{\"startingCapitalUsd\":1000}','c',now())");
      const as = async (role: string, sql: string) => { await c.query(`set role ${role}`); try { return await c.query(sql); } finally { await c.query("reset role"); } };
      for (const role of ["anon", "authenticated"]) {
        await expect(as(role, "select portfolio_report('d15-portfolio')")).rejects.toThrow(/permission denied for function portfolio_report/);
        await expect(as(role, "select portfolio_pending_ahead('REALISTIC', now())")).rejects.toThrow(/permission denied for function portfolio_pending_ahead/);
      }
      expect((await as("service_role", "select portfolio_report('d15-portfolio') is not null as ok")).rows[0].ok).toBe(true);
      expect((await as("service_role", "select portfolio_pending_ahead('REALISTIC', now()) as n")).rows[0].n).toBe("0");
      // 0007's report functions are untouched: still callable by anon
      expect((await as("anon", "select paper_exec_report('REALISTIC') is not null as ok")).rows[0].ok).toBe(true);
      const acl = (await c.query("select proname, proacl::text from pg_proc where proname in ('portfolio_report','portfolio_pending_ahead') order by proname")).rows;
      for (const r of acl) { expect(r.proacl).toContain("service_role=X"); expect(r.proacl).not.toMatch(/(^|[{,])=X|anon=X|authenticated=X/); }
    } finally { await c.end(); }
  }, 120_000);
});


// ───────────────────────────── Step 8 review: partial-mode reporting, strict dry-run switch ─────────────────────────────
describe("review: partial-mode failures are visible on the page", () => {
  it("a mode that fails while the others complete is reported per mode in the snapshot and the view", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); const w = cycleWorld({ hours: 3, perHour: 20, seed: 11 }); w.arriveAll();
    const now = START + 6 * 3600; const conf = cfg(now);
    await w.cycle(now, (t) => runPortfolios(w.db as never, { config: conf, owner: "t", now: () => t })); // a first successful run for every mode
    const real = runPortfolios; const logs: string[] = [];
    const r = await runPortfolioJob(w.db as never, { config: conf, now: () => now + 900, log: (m) => logs.push(m),
      run: (async (db: unknown, o: any) => { if (o.modes[0] === "CONSERVATIVE") throw new Error("lease RPC timed out"); return real(db as never, o); }) as never });
    if (r.off) throw new Error("unexpected"); expect(r.snapshotSaved).toBe(true);
    expect(r.modes.map((m) => [m.mode, m.failed ?? null])).toEqual([["IDEAL", null], ["REALISTIC", null], ["CONSERVATIVE", "lease RPC timed out"]]);
    const snap = JSON.parse(w.db.T("cursors").find((c) => c.key === PORTFOLIO_SNAPSHOT_KEY)!.value);
    expect(snap.lastJob.modes.find((m: any) => m.mode === "CONSERVATIVE")).toEqual({ mode: "CONSERVATIVE", failed: "lease RPC timed out", skipped: null });
    const v = portfolioView(snap, now + 900); const row = v.sections.flatMap((x) => x.rows).find((x) => x.label === "This cycle")!;
    expect(row.values[0]).toBe("completed"); expect(row.values[1]).toBe("completed"); expect(row.values[2]).toMatch(/^FAILED this cycle — lease RPC timed out/);
  });
  it("a run that started and never finished is flagged on that mode only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); const w = cycleWorld({ hours: 3, perHour: 20, seed: 12 }); w.arriveAll();
    const now = START + 6 * 3600; const conf = cfg(now);
    await w.cycle(now, (t) => runPortfolios(w.db as never, { config: conf, owner: "t", now: () => t }));
    const ideal = portfolioDefinitions(conf).find((d) => d.mode === "IDEAL")!;
    const run = w.db.T("portfolio_runs").find((x) => x.portfolio_id === ideal.id)!; run.last_run_started_at = iso(now + 600); // started, crashed before finishing
    const snap = await savePortfolioSnapshot(w.db as never, { config: conf, now: () => now + 900 });
    const warn = portfolioView(snap, now + 900).sections.flatMap((x) => x.rows).find((x) => x.label === "Warnings")!;
    expect(warn.values[0]).toContain("did not finish"); expect(warn.values[1]).not.toContain("did not finish"); expect(warn.values[2]).not.toContain("did not finish");
  });
  it("if no mode has finished a run yet and the job failed, the empty state says so", () => {
    const v = portfolioView({ generatedAt: iso(START), portfolios: [], lastJob: { at: iso(START), modes: [{ mode: "REALISTIC", failed: "boom", skipped: null }] } }, START + 60);
    expect(v.state).toBe("no-run"); expect(v.message).toContain("The last job failed: REALISTIC — boom");
  });
});

describe("review: invalid configuration — the dry-run switch is strict", () => {
  const conf = JSON.stringify({ ...PC, startTs: iso(START) });
  it("a dry-run value other than 0 or 1 turns the feature off (never silently writes), with one line", () => {
    for (const bad of ["true", "yes", "2", " 1", "on"]) {
      const logs: string[] = []; const s = portfolioJobSetup({ PAPER_PORTFOLIO_CONFIG: conf, PAPER_PORTFOLIO_DRY_RUN: bad }, START + DAY, (m) => logs.push(m));
      expect(s.config, bad).toBeNull(); expect(logs).toHaveLength(1); expect(logs[0]).toMatch(/^portfolio: off \(invalid configuration\) — PAPER_PORTFOLIO_DRY_RUN must be 0 or 1/);
    }
  });
  it("0, empty and unset mean real runs; 1 means dry run", () => {
    for (const [v, dry] of [["0", false], ["", false], [undefined, false], ["1", true]] as const) {
      const s = portfolioJobSetup({ PAPER_PORTFOLIO_CONFIG: conf, ...(v === undefined ? {} : { PAPER_PORTFOLIO_DRY_RUN: v }) }, START + DAY, () => {});
      expect(s.config, String(v)).not.toBeNull(); expect(s.dryRun, String(v)).toBe(dry);
    }
  });
  it("with the config unset, a bad dry-run value changes nothing (still one 'off' line)", () => {
    const logs: string[] = []; expect(portfolioJobSetup({ PAPER_PORTFOLIO_DRY_RUN: "true" }, START, (m) => logs.push(m)).config).toBeNull();
    expect(logs).toEqual(["portfolio: off (PAPER_PORTFOLIO_CONFIG unset)"]);
  });
});

// ───────────────────────────── Step 8 review: D15 under Supabase-style default privileges ─────────────────────────────
d("review: D15 holds where new functions are granted to the API roles by default (as on Supabase)", () => {
  const name = `step8dp_${process.pid}_${Date.now()}`; let url = "";
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: PGURL }); await admin.connect(); await admin.query(`create database ${name}`); await admin.end();
    const u = new URL(PGURL!); u.pathname = `/${name}`; url = u.toString();
  });
  afterAll(async () => { const admin = new pg.Client({ connectionString: PGURL }); await admin.connect(); await admin.query(`drop database if exists ${name} with (force)`); await admin.end(); });
  it("every signature of portfolio_report / portfolio_pending_ahead denies anon and authenticated; service_role may execute", async () => {
    const c = new pg.Client({ connectionString: url }); await c.connect();
    try {
      // Supabase grants EXECUTE on new public functions to the API roles directly, not only via PUBLIC.
      await c.query("alter default privileges in schema public grant execute on functions to anon, authenticated, service_role");
      for (const f of readdirSync(MIG).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) await c.query(readFileSync(path.join(MIG, f), "utf8"));
      const rows = (await c.query(`select p.oid::regprocedure::text as sig,
          has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth,
          has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('portfolio_report', 'portfolio_pending_ahead') order by 1`)).rows;
      expect(rows.map((r) => r.sig)).toEqual(["portfolio_pending_ahead(text,timestamp with time zone)", "portfolio_report(text)"]); // exactly the signatures 0011 names
      for (const r of rows) { expect(r.anon, r.sig).toBe(false); expect(r.auth, r.sig).toBe(false); expect(r.svc, r.sig).toBe(true); }
    } finally { await c.end(); }
  }, 120_000);
});
