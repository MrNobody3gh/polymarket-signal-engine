/**
 * Phase 3 step 6: the portfolio runner (src/lib/paper/portfolio/run.ts, config.ts) against an in-memory database.
 *
 * Every world is built the way production builds it: signals, ledger rows, exits, marks, market metadata and
 * resolutions go in, the unchanged Phase 2 sweep enqueues and then simulates prices into paper_executions (with
 * computed_at from a controlled clock), and the runner streams those rows. "Equals a fresh replay" always means: a
 * second database built from the same final inputs and run once gives the same decisions, lots and equity rows.
 */
import { noLotHashAside } from "./helpers/d24";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stressDb } from "./helpers/stressDb";
import { sweepSimulation, loadBatchInputs, buildSignals } from "@/lib/paper/sim/run";
import { MODES, type ModeName, type PortfolioConfig } from "@/lib/paper/sim/config";
import { simulatePortfolio } from "@/lib/paper/sim/portfolio";
import { timeline } from "@/lib/paper/sim/execute";
import { PortfolioBook, KIND_ORDER } from "@/lib/paper/portfolio/book";
import { buildRequests, fingerprint } from "@/lib/paper/portfolio/requests";
import { runPortfolios, nextBatch, CHECKPOINT_HOURLY_DAYS, EQUITY_DENSE_DAYS, type RunOptions, type PortfolioRunStats } from "@/lib/paper/portfolio/run";
import { validatePortfolioConfig, portfolioRunConfigFromEnv, portfolioDefinitions, portfolioIdFor, PortfolioConfigError, IDEAL_LABEL, type PortfolioRunConfig } from "@/lib/paper/portfolio/config";
import type { BookState } from "@/lib/paper/portfolio/types";

const START = 1_790_000_000; // 2026-09-21T16:53:20Z
const iso = (s: number) => new Date(s * 1000).toISOString();
const sec = (v: string) => Math.floor(Date.parse(v) / 1000);
const pad = (i: number) => String(i).padStart(12, "0");
const E = (i: number) => `00000000-0000-4000-8000-${pad(i)}`, X = (i: number) => `00000000-0000-4000-9000-${pad(i)}`;
const ALL: ModeName[] = ["IDEAL", "REALISTIC", "CONSERVATIVE"];
const OUT_TABLES = ["portfolio_decisions", "portfolio_lots", "portfolio_equity", "portfolio_checkpoints"];

const PCS: Record<string, PortfolioConfig> = {
  // Binding limits of every kind, so decisions depend on history (a change early on moves later decisions).
  tight: { startingCapitalUsd: 1_500, positionUsd: 100, maxMarketExposureUsd: 300, maxTotalExposurePct: 70, maxOpenPositions: 9, maxWalletAllocationUsd: 350, minCashReserveUsd: 50, allowResize: true },
  roomy: { startingCapitalUsd: 1_000_000, positionUsd: 100, maxMarketExposureUsd: 1_000_000, maxTotalExposurePct: 100, maxOpenPositions: 100_000, maxWalletAllocationUsd: 1_000_000, minCashReserveUsd: 0, allowResize: false },
};

// ───────────────────────────── clock ─────────────────────────────
let clock = START;
const setClock = (t: number) => { clock = t; vi.setSystemTime(t * 1000); };
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); setClock(START); });
afterEach(() => { vi.useRealTimers(); delete process.env.PAPER_PORTFOLIO_CONFIG; });

// ───────────────────────────── database with the 0008 lease functions ─────────────────────────────
type Db = ReturnType<typeof stressDb>;
function mkDb(): Db {
  const now = () => Math.floor(Date.now() / 1000);
  const runsRow = (id: string) => db.T("portfolio_runs").find((r) => r.portfolio_id === id);
  const db: Db = stressDb({ rpc: {
    claim_portfolio_lease: ({ p_portfolio_id: id, p_owner: owner, p_seconds: s }: any) => {
      if (!owner) throw new Error("lease owner required"); if (!(s >= 1 && s <= 3600)) throw new Error("lease seconds must be 1..3600");
      let r = runsRow(id); if (!r) { r = { portfolio_id: id, lease_owner: null, lease_until: null, last_run_started_at: null, last_run_finished_at: null, last_watermark_ts: null, last_watermark_key: null, stats: {} }; db.insertRow("portfolio_runs", r); }
      if (r.lease_until == null || sec(r.lease_until) <= now() || r.lease_owner === owner) { r.lease_owner = owner; r.lease_until = iso(now() + s); return true; }
      return false;
    },
    release_portfolio_lease: ({ p_portfolio_id: id, p_owner: owner }: any) => { const r = runsRow(id); if (!r || r.lease_owner !== owner) return false; r.lease_owner = null; r.lease_until = null; return true; },
  } });
  return db;
}

// ───────────────────────────── worlds ─────────────────────────────
interface WorldOpts {
  n: number; seed?: number; gap?: number;
  /** Same-second groups: entries at..at+size-1 share one source and evaluation time; kinds run CONSENSUS → NEW_POSITION
   *  while ids ascend, so the database order (signal_id) is the reverse of the book's (kind). */
  groups?: { at: number; size: number }[];
  /** Entries whose fills fall before START (never requested). */
  before?: number;
  exitShare?: number; resolvedShare?: number; dupShare?: number;
  /** Price observations left unfetched: (tokenId, asOf) → true. */
  missing?: (tok: string, asOf: number) => boolean;
}
interface World { db: Db; o: WorldOpts; entries: { id: string; src: number; ev: number; token: string; kind: string }[] }

function populate(o: WorldOpts): World {
  const db = mkDb(); let seed = o.seed ?? 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const gap = o.gap ?? 60; const entries: World["entries"] = []; const sigs: Record<string, any>[] = []; const led: Record<string, any>[] = []; const exits: Record<string, any>[] = []; const exitLed: Record<string, any>[] = [];
  let t = START - (o.before ?? 0) * gap - gap; let prev: Record<string, any> | null = null; let prevEv = 0;
  const groupKinds = ["CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY", "NEW_POSITION"];
  for (let i = 0; i < o.n; i++) {
    const g = o.groups?.find((x) => i >= x.at && i < x.at + x.size); const inGroup = !!g && i > g.at;
    const dup: boolean = !g && !!prev && rnd() < (o.dupShare ?? 0.08);
    let src: number, ev: number;
    if (inGroup || dup) { src = sec(prev!.created_at); ev = prevEv; } else { t += gap; src = t; ev = src + 3 + Math.floor(rnd() * Math.min(40, gap - 10)); }
    const kind = g ? groupKinds[(i - g.at) % 4] : dup ? "CONSENSUS" : ["NEW_POSITION", "NEW_POSITION", "CONVICTION_ADD", "EARLY_ENTRY", "CONSENSUS"][Math.floor(rnd() * 5)];
    const s: Record<string, any> = dup ? { ...prev!, id: E(i), kind } : { id: E(i), kind, wallet: `w${Math.floor(rnd() * 6)}`, condition_id: `c${Math.floor(rnd() * 9)}`, token_id: `t${i}`, price: 0.1 + rnd() * 0.8, usd: 50 + rnd() * 3000, created_at: iso(src), evaluated_at: iso(ev), source_fill_id: `0xfill${i}` };
    sigs.push(s); led.push({ signal_id: s.id, created_at: iso(ev), sim_terminal: false, side: "LONG" }); entries.push({ id: s.id, src, ev, token: s.token_id, kind });
    if (!dup && rnd() < (o.exitShare ?? 0.5)) { const xs = src + 30 + Math.floor(rnd() * 20_000); exits.push({ id: X(i), kind: "EXIT", wallet: s.wallet, condition_id: s.condition_id, token_id: s.token_id, price: 0.05 + rnd() * 0.9, usd: rnd() < 0.3 ? 10 + rnd() * 30 : 500 + rnd() * 2000, created_at: iso(xs), evaluated_at: iso(xs + 4), source_fill_id: `0xexit${i}` }); exitLed.push({ signal_id: X(i), created_at: iso(xs + 4), sim_terminal: true, side: "EXIT_EVENT" }); }
    if (!dup && rnd() < (o.resolvedShare ?? 0.5)) db.insertRow("token_resolutions", { token_id: s.token_id, value: [0, 1, 1, 0.5][Math.floor(rnd() * 4)], resolved_ts: iso(src + 600 + Math.floor(rnd() * 40_000)) });
    if (rnd() < 0.5) db.insertRow("paper_marks", { signal_id: s.id, horizon: "1h", observed_at: iso(src + 3600), price: rnd() });
    prev = s; prevEv = ev;
  }
  for (const r of [...sigs, ...exits]) db.insertRow("signals", r);
  for (const r of [...led, ...exitLed]) db.insertRow("paper_ledger", r); // ascending signal_id (the sweep's keyset relies on it)
  for (let c = 0; c < 9; c++) if (c % 3) db.insertRow("markets", { condition_id: `c${c}`, fees_enabled: true, taker_fee_rate: 0.02, tick_size: 0.01, min_order_shares: 5, meta_fetched_at: iso(START - 86_400) });
  return { db, o, entries };
}

/** The unchanged Phase 2 sweep at the current clock, then fill every price it asked for (except `missing`). */
async function sweep(w: World, fill = true) {
  await sweepSimulation(w.db as never);
  if (!fill) return;
  // Each price is a function of (token, time) only, so worlds that fetch in a different order see the same prices.
  const unit = (k: string) => { let h = 2166136261; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 2 ** 32; };
  let filled = 0;
  for (const r of w.db.T("price_observations")) {
    if (r.state !== "PENDING") continue; const v = unit(`${r.token_id}@${r.as_of}`);
    if (w.o.missing?.(r.token_id, r.as_of)) continue;
    Object.assign(r, v < 0.05 ? { state: "UNAVAILABLE" } : { state: "COMPLETE", obs_ts: r.as_of - Math.floor(v * 200), price: 0.05 + ((v * 7919) % 1) * 0.9, resolution_seconds: 0 }); filled++;
  }
  if (filled) await sweepSimulation(w.db as never);
}
async function world(o: WorldOpts) { const w = populate(o); await sweep(w); return w; }

const cfgOf = (pc: PortfolioConfig, start = START, now = clock): PortfolioRunConfig => validatePortfolioConfig({ ...pc, startTs: iso(start) }, now);
async function run(w: World | Db, o: RunOptions & { pc?: PortfolioConfig } = {}): Promise<PortfolioRunStats[]> {
  const db = "db" in w ? w.db : w; const { pc, ...rest } = o;
  return runPortfolios(db as never, { config: cfgOf(pc ?? PCS.tight), modes: ALL, owner: "test-runner", ...rest });
}

// ───────────────────────────── reading results ─────────────────────────────
const strip = ({ computed_at: _c, ...r }: Record<string, any>) => r;
function outputs(db: Db, pid: string) {
  const mine = (t: string) => db.T(t).filter((r) => r.portfolio_id === pid).map(strip);
  return {
    decisions: mine("portfolio_decisions").sort((a, b) => (a.signal_id < b.signal_id ? -1 : 1)),
    lots: mine("portfolio_lots").sort((a, b) => (a.signal_id < b.signal_id ? -1 : 1)),
    equity: mine("portfolio_equity").sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq),
  };
}
const byMode = (s: PortfolioRunStats[], m: ModeName) => s.find((x) => x.mode === m)!;
const latestCk = (db: Db, pid: string) => db.T("portfolio_checkpoints").filter((r) => r.portfolio_id === pid).sort((a, b) => a.event_ts.localeCompare(b.event_ts)).at(-1)!;
/** Every table's contents (a read may create an empty table in the in-memory database; that is not a write). */
const dump = (db: Db) => JSON.stringify(Object.entries(db.tables).filter(([, rows]) => rows.length).sort(([a], [b]) => a.localeCompare(b)));
const outWrites = (db: Db) => Object.fromEntries(OUT_TABLES.map((t) => [t, (db.stats.writes[t] ?? 0) + (db.stats.deletes[t] ?? 0)]));

/** Every 0008 table constraint, checked on every row the runner wrote. */
function assert0008(db: Db) {
  for (const d of db.T("portfolio_decisions")) {
    expect(["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"]).toContain(d.kind);
    expect(["FILLED", "PARTIALLY_FILLED", "UNFILLED", "EXPIRED", "INVALID", "UNKNOWN", "REJECTED"]).toContain(d.outcome);
    if (d.outcome === "REJECTED") expect(d.reason).toMatch(/^REJECTED_/);
    expect(d.filled_usd).toBeLessThanOrEqual(d.requested_usd + 1e-6); expect(d.requested_usd).toBeGreaterThanOrEqual(0); expect(d.fee).toBeGreaterThanOrEqual(0);
    expect(["FILLED", "PARTIALLY_FILLED"].includes(d.outcome)).toBe(d.filled_shares > 0);
    if (d.fill_price != null) { expect(d.fill_price).toBeGreaterThan(0); expect(d.fill_price).toBeLessThan(1); }
    expect(d.input_hash).toBeTruthy(); expect(d.record_hash).toBeTruthy();
  }
  const dec = new Set(db.T("portfolio_decisions").map((d) => `${d.portfolio_id}|${d.signal_id}`));
  for (const l of db.T("portfolio_lots")) {
    expect(dec.has(`${l.portfolio_id}|${l.signal_id}`), "lot without decision (FK)").toBe(true);
    expect(l.shares_filled).toBeGreaterThan(0); expect(l.cost_usd).toBeGreaterThan(0); expect(l.shares_open).toBeGreaterThanOrEqual(0); expect(l.cost_open).toBeGreaterThanOrEqual(0);
    expect(["EXITED", "RESOLVED"].includes(l.state)).toBe(l.closed_ts != null);
    if (["EXITED", "RESOLVED"].includes(l.state)) expect(l.shares_open).toBeLessThanOrEqual(1e-9);
    expect(l.shares_open).toBeLessThanOrEqual(l.shares_filled + 1e-9);
    if (l.resolution_value != null) { expect(l.resolution_value).toBeGreaterThanOrEqual(0); expect(l.resolution_value).toBeLessThanOrEqual(1); }
    for (const k of ["exit_shares", "exit_proceeds", "exit_fee", "resolution_proceeds"]) if (l[k] != null) expect(l[k]).toBeGreaterThanOrEqual(0);
  }
  for (const e of db.T("portfolio_equity")) expect(e.exposure).toBeGreaterThanOrEqual(0);
  for (const p of db.T("portfolios")) expect(p.id.length >= 8 && p.id.length <= 64).toBe(true);
}

/** The reference (sim/portfolio.ts) on exactly the requests the runner sees. */
async function reference(db: Db, mode: ModeName, cfg: PortfolioRunConfig) {
  const ids = db.T("paper_ledger").filter((l) => l.side === "LONG").map((l) => l.signal_id);
  const inp = await loadBatchInputs(db as never, ids);
  const fills = new Map(db.T("signals").map((s) => [s.id, s.source_fill_id ?? null]));
  const reqs = buildRequests(buildSignals(inp), inp, MODES[mode], { startTs: cfg.startTs, sourceFillIds: fills });
  return { reqs, ref: simulatePortfolio(reqs.map((r) => r.signal), MODES[mode], cfg.portfolio) };
}

/** A second database with the same final inputs, run once. */
async function freshReplay(o: WorldOpts, mutate: (w: World) => void | Promise<void>, runOpts: RunOptions & { pc?: PortfolioConfig } = {}) {
  const t = clock; setClock(START); const w = await world(o); await mutate(w); setClock(t); await sweep(w);
  const s = await run(w, runOpts); return { w, s };
}

// ═════════════════════════════ tests ═════════════════════════════
describe("config (R1)", () => {
  const good = { ...PCS.tight, startTs: "2026-09-27T04:26:41Z" }; const now = sec("2026-10-01T00:00:00Z");
  it("validates every field with clear errors; no defaults; unknown keys and a future or zone-less start are refused", () => {
    expect(validatePortfolioConfig(good, now)).toMatchObject({ startTs: sec("2026-09-27T04:26:41Z"), startIso: "2026-09-27T04:26:41.000Z" });
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ ...good, startingCapitalUsd: 0 }, /startingCapitalUsd must be > 0/], [{ ...good, positionUsd: -1 }, /positionUsd must be > 0/],
      [{ ...good, positionUsd: 2_000 }, /cannot exceed startingCapitalUsd/], [{ ...good, maxTotalExposurePct: 0 }, /\(0, 100\]/], [{ ...good, maxTotalExposurePct: 101 }, /\(0, 100\]/],
      [{ ...good, maxOpenPositions: 2.5 }, /integer ≥ 1/], [{ ...good, maxOpenPositions: 0 }, /integer ≥ 1/], [{ ...good, minCashReserveUsd: -5 }, /≥ 0/], [{ ...good, minCashReserveUsd: 1_500 }, /below startingCapitalUsd/],
      [{ ...good, maxMarketExposureUsd: 0 }, /maxMarketExposureUsd/], [{ ...good, maxWalletAllocationUsd: 0 }, /maxWalletAllocationUsd/], [{ ...good, allowResize: "yes" }, /allowResize must be true or false/],
      [{ ...good, positionUsd: "100" }, /finite number/], [{ ...good, positionUsd: Infinity }, /finite number/],
      [{ ...good, maxOpenPosition: 3 }, /unknown key\(s\) maxOpenPosition/], [(({ startTs: _s, ...r }) => r)(good), /missing startTs; there are no defaults/], [(({ positionUsd: _p, ...r }) => r)(good), /missing positionUsd/],
      [{ ...good, startTs: "2026-09-27 04:26:41" }, /ISO timestamp with a timezone/], [{ ...good, startTs: 1790000000 }, /ISO timestamp/], [{ ...good, startTs: "2026-13-45T99:99:99Z" }, /not a valid time/],
      [{ ...good, startTs: "2026-10-02T00:00:00Z" }, /in the future/],
    ];
    for (const [raw, re] of bad) { expect(() => validatePortfolioConfig(raw, now), JSON.stringify(raw)).toThrow(PortfolioConfigError); expect(() => validatePortfolioConfig(raw, now)).toThrow(re); }
  });
  it("env: unset → null (feature off); invalid JSON or a non-object throws; the Phase 2 parser must agree", () => {
    expect(portfolioRunConfigFromEnv({}, now)).toBeNull();
    expect(() => portfolioRunConfigFromEnv({ PAPER_PORTFOLIO_CONFIG: "{nope" }, now)).toThrow(/not valid JSON/);
    expect(() => portfolioRunConfigFromEnv({ PAPER_PORTFOLIO_CONFIG: "[1]" }, now)).toThrow(/JSON object/);
    expect(portfolioRunConfigFromEnv({ PAPER_PORTFOLIO_CONFIG: JSON.stringify(good) }, now)!.portfolio).toEqual(PCS.tight);
  });
  it("unset config → runPortfolios returns [] and touches nothing", async () => {
    const w = await world({ n: 30 }); const before = dump(w.db); const calls = w.db.stats.calls;
    expect(await runPortfolios(w.db as never, {})).toEqual([]);                 // reads PAPER_PORTFOLIO_CONFIG (unset)
    expect(await runPortfolios(w.db as never, { config: null })).toEqual([]);
    expect(w.db.stats.calls).toBe(calls); expect(dump(w.db)).toBe(before);
    process.env.PAPER_PORTFOLIO_CONFIG = JSON.stringify({ ...PCS.tight, startTs: iso(START) }); setClock(START + 86_400);
    const s = await runPortfolios(w.db as never, { modes: ["IDEAL"] }); expect(s).toHaveLength(1); expect(s[0].batches).toBeGreaterThan(0);
  });
  it("one portfolio per mode; the id is 8–64 chars and changes with mode, execution config, portfolio config and start; IDEAL is labelled non-causal", () => {
    const cfg = validatePortfolioConfig(good, now); const defs = portfolioDefinitions(cfg);
    expect(defs.map((d) => d.mode)).toEqual(ALL); expect(new Set(defs.map((d) => d.id)).size).toBe(3);
    for (const d of defs) { expect(d.id).toMatch(/^[0-9a-f]{32}$/); expect(d.config.startTs).toBe("2026-09-27T04:26:41.000Z"); }
    expect(defs[0].config).toMatchObject({ nonCausalBaseline: true, note: IDEAL_LABEL }); expect(defs[1].config.nonCausalBaseline).toBeUndefined();
    const id = (o: Partial<typeof good>) => portfolioDefinitions(validatePortfolioConfig({ ...good, ...o }, now), ["REALISTIC"])[0].id;
    expect(id({})).toBe(defs[1].id);
    expect(id({ startTs: "2026-09-27T04:26:42Z" })).not.toBe(defs[1].id);   // different start → different portfolio
    expect(id({ positionUsd: 101 })).not.toBe(defs[1].id);
    expect(portfolioIdFor("REALISTIC", "other-exec-hash", defs[1].configHash, cfg.startTs)).not.toBe(defs[1].id);
  });
});

describe("R8: fingerprint provenance", () => {
  it("a metadata re-fetch with the same values (only observedAt moves) keeps the fingerprint; a changed value does not", async () => {
    const w = await world({ n: 40 }); const ids = w.entries.map((e) => e.id);
    const fp = async () => { const inp = await loadBatchInputs(w.db as never, ids); return new Map(buildRequests(buildSignals(inp), inp, MODES.REALISTIC, { startTs: 0 }).map((r) => [r.signal.signalId, r])); };
    const a = await fp(); const withMarket = [...a.values()].filter((r) => r.signal.entry.market); expect(withMarket.length).toBeGreaterThan(5);
    expect(withMarket.some((r) => r.signal.exit?.market)).toBe(true);
    for (const m of w.db.T("markets")) m.meta_fetched_at = iso(START + 5 * 86_400);
    const b = await fp(); for (const r of withMarket) expect(b.get(r.signal.signalId)!.fingerprint).toBe(r.fingerprint);
    expect(b.get(withMarket[0].signal.signalId)!.signal.entry.market).not.toEqual(withMarket[0].signal.entry.market); // observedAt did move
    for (const m of w.db.T("markets")) m.taker_fee_rate = 0.03;
    const c = await fp(); for (const r of withMarket) expect(c.get(r.signal.signalId)!.fingerprint).not.toBe(r.fingerprint);
    const r0 = withMarket[0]; expect(fingerprint(r0.signal, MODES.REALISTIC, r0.pendingEntry, r0.exitPendingTs)).toBe(r0.fingerprint);
  });
});

describe("runner", () => {
  it("R3: a same-second group straddling the 500-row boundary replays identically to one big batch (and does not throw)", async () => {
    // entries 494..502 share one second; the database orders them by id, the book by kind (CONSENSUS ids come first)
    const o: WorldOpts = { n: 700, groups: [{ at: 494, size: 9 }, { at: 120, size: 7 }, { at: 610, size: 9 }], exitShare: 0.4, dupShare: 0 };
    const w = await world(o); setClock(START + 3 * 86_400);
    for (const m of ALL) {
      const rows = w.db.T("paper_executions").filter((r) => r.mode === m && r.fill_ts >= iso(START)).sort((a, b) => a.fill_ts.localeCompare(b.fill_ts) || (a.signal_id < b.signal_id ? -1 : 1));
      const g = new Set(w.entries.slice(494, 503).map((e) => e.id)); const pos = rows.flatMap((r, i) => (g.has(r.signal_id) ? [i] : []));
      expect(pos[0]).toBeLessThan(500); expect(pos.at(-1)).toBeGreaterThanOrEqual(500);        // the group really straddles row 500
      const b = await nextBatch(w.db as never, m, iso(START - 1), 500);
      expect(b.length).toBe(500 + pos.filter((p) => p >= 500).length); expect(new Set(b.map((r) => r.fill_ts)).size).toBe(new Set(rows.slice(0, 500).map((r) => r.fill_ts)).size);
    }
    const s500 = await run(w);
    const one = populate(o); setClock(START); await sweep(one); setClock(START + 3 * 86_400); const sBig = await run(one, { batchSize: 100_000 });
    const tiny = populate(o); setClock(START); await sweep(tiny); setClock(START + 3 * 86_400); const s7 = await run(tiny, { batchSize: 7 });
    for (const m of ALL) {
      const pid = byMode(s500, m).portfolioId; expect(byMode(s500, m).batches).toBeGreaterThan(1); expect(byMode(s7, m).batches).toBeGreaterThan(50);
      expect(outputs(w.db, pid)).toEqual(outputs(one.db, pid)); expect(outputs(tiny.db, pid)).toEqual(outputs(one.db, pid));
      expect(byMode(s500, m).summary).toEqual(byMode(sBig, m).summary); expect(byMode(s7, m).summary).toEqual(byMode(sBig, m).summary);
      expect(outputs(w.db, pid).decisions.length).toBeGreaterThan(600);
    }
    assert0008(w.db);
  });

  for (const pcName of ["tight", "roomy"] as const) it(`a full run equals simulatePortfolio (the reference), all 3 modes — ${pcName} limits`, async () => {
    // seed 5 for "tight": under the D4 source-time rule (28 Sep fix) seed 3's CONSERVATIVE run no longer exercised
    // REJECTED_DUPLICATE_POSITION (its one duplicate was a twin traded before the start); seed 5 covers every branch
    const w = await world({ n: 600, seed: pcName === "tight" ? 5 : 4, before: 20 }); setClock(START + 3 * 86_400);
    const stats = await run(w, { pc: PCS[pcName] }); const cfg = cfgOf(PCS[pcName]);
    for (const m of ALL) {
      const st = byMode(stats, m); const pid = st.portfolioId; const { ref, reqs } = await reference(w.db, m, cfg);
      expect(st.frontier).toBeNull(); expect(reqs.length).toBeGreaterThan(550);
      const dec = w.db.T("portfolio_decisions").filter((d) => d.portfolio_id === pid).sort((a, b) => a.event_ts.localeCompare(b.event_ts) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.signal_id < b.signal_id ? -1 : a.signal_id > b.signal_id ? 1 : 0))
        .map((d) => ({ signalId: d.signal_id, kind: d.kind, outcome: d.outcome, reason: d.reason, requestedUsd: d.requested_usd, filledUsd: d.filled_usd, ts: sec(d.event_ts) }));
      expect(dec).toEqual(ref.decisions);
      const W = st.watermark!; expect(W).toBe(Math.max(...reqs.map((r) => r.key.ts)));
      expect(outputs(w.db, pid).equity.map((e) => ({ ts: sec(e.ts), equity: e.equity, cash: e.cash, exposure: e.exposure }))).toEqual(ref.curve.filter((p) => p.ts <= W));
      // the book stops at the watermark; continuing the final checkpoint to the end gives the rest of the reference
      const ck = latestCk(w.db, pid); expect(sec(ck.event_ts)).toBe(W);
      const rest = new PortfolioBook(MODES[m], PCS[pcName], JSON.parse(JSON.stringify(ck.state))); rest.advance(null);
      expect(rest.take().equity).toEqual(ref.curve.filter((p) => p.ts > W));
      const { decisions: _d, curve: _c, ...totals } = ref; expect(rest.summary()).toEqual(totals);
      if (pcName === "tight") { const reasons = new Set(dec.map((d) => d.reason?.replace(/:.*/, "") ?? d.outcome)); for (const r of ["REJECTED_DUPLICATE_POSITION", "REJECTED_MAX_OPEN_POSITIONS", "RESIZED"]) expect(reasons, `${m} ${r}`).toContain(r); }
      const lots = outputs(w.db, pid).lots; expect(new Set(lots.map((l) => l.state))).toEqual(new Set(["OPEN", "EXITED", "RESOLVED", "PARTIALLY_EXITED"].filter((s) => lots.some((l) => l.state === s))));
      expect(lots.some((l) => l.state === "EXITED") && lots.some((l) => l.state === "RESOLVED")).toBe(true);
      expect(st.decisions).toEqual(dec.reduce((a, d) => ({ ...a, [d.outcome]: (a[d.outcome] ?? 0) + 1 }), {} as Record<string, number>));
    }
    expect(byMode(stats, "IDEAL").nonCausalBaseline).toBe(IDEAL_LABEL);
    const stored = w.db.T("portfolio_runs").find((r) => r.portfolio_id === byMode(stats, "IDEAL").portfolioId)!;
    expect(stored.stats).toMatchObject({ portfolioId: byMode(stats, "IDEAL").portfolioId, nonCausalBaseline: IDEAL_LABEL, watermark: byMode(stats, "IDEAL").watermark });
    expect(stored.lease_owner).toBeNull(); expect(sec(stored.last_run_finished_at)).toBeGreaterThanOrEqual(sec(stored.last_run_started_at));
    assert0008(w.db);
  });

  it("R12/R13 stats; dry run computes everything and writes nothing — not even the lease or the portfolios row", async () => {
    const w = await world({ n: 200 }); setClock(START + 86_400);
    const before = dump(w.db); const wr = JSON.stringify(w.db.stats.writes);
    const dry = await run(w, { dryRun: true });
    expect(dump(w.db)).toBe(before); expect(JSON.stringify(w.db.stats.writes)).toBe(wr); expect(w.db.stats.deletes).toEqual({});
    const real = await run(w);
    for (const m of ALL) {
      const d = byMode(dry, m), r = byMode(real, m);
      expect(d.dryRun).toBe(true); expect(d.summary).toEqual(r.summary); expect(d.decisions).toEqual(r.decisions); expect(d.watermark).toBe(r.watermark);
      expect(d.writes.portfolio_decisions).toBe(r.writes.portfolio_decisions); expect(d.writes.portfolio_decisions).toBeGreaterThan(100);
      expect(r).toMatchObject({ portfolioId: expect.any(String), rowsRead: expect.any(Number), rewind: { to: null, restoredFrom: null }, frontier: null, durationMs: expect.any(Number) });
      expect(r.memory!.after.heapUsedMb).toBeGreaterThan(0);
    }
    // a dry run over an existing portfolio that would rewind: still nothing written or deleted
    // an entry input changes (a backfilled source_fill_id) and the sweep has rewritten that signal's rows: an entry change
    // rewinds for every decision (D24 leaves a no-lot decision's exit / resolution out of the comparison, never its entry)
    const e20 = w.entries[20]; w.db.T("signals").find((r) => r.id === e20.id)!.source_fill_id = "0xbackfilled";
    for (const x of w.db.T("paper_executions").filter((r) => r.signal_id === e20.id)) x.computed_at = iso(START + 2 * 86_400 - 60);
    setClock(START + 2 * 86_400); await sweep(w);
    const snap = dump(w.db); const d2 = await run(w, { dryRun: true });
    expect(dump(w.db)).toBe(snap); expect(d2.some((s) => s.rewind.to != null)).toBe(true); expect(d2.some((s) => Object.keys(s.deletes).length > 0)).toBe(true);
  });

  it("R2: stopping after any batch and resuming equals an uninterrupted run (decisions, lots, equity, summary)", async () => {
    const o: WorldOpts = { n: 240, seed: 11, groups: [{ at: 40, size: 6 }] };
    const whole = await world(o); setClock(START + 86_400); const ws = await run(whole, { batchSize: 25 });
    for (const k of [1, 3]) {
      setClock(START); const w = await world(o); let t = START + 86_400; let last: PortfolioRunStats[] = []; let runs = 0;
      for (;;) { setClock(t += 60); last = await run(w, { batchSize: 25, maxBatches: k }); runs++; if (last.every((s) => s.batches === 0)) break; expect(runs).toBeLessThan(40); }
      expect(runs).toBeGreaterThan(4);
      for (const m of ALL) { const pid = byMode(ws, m).portfolioId; expect(outputs(w.db, pid)).toEqual(outputs(whole.db, pid)); expect(byMode(last, m).summary).toEqual(byMode(ws, m).summary); }
      assert0008(w.db);
    }
  });

  for (const stage of ["afterOutputs", "afterCheckpoints"] as const) it(`R2: a crash ${stage === "afterOutputs" ? "after outputs, before checkpoints and the watermark" : "after checkpoints, before the watermark"} → the next run gives the same final result`, async () => {
    const o: WorldOpts = { n: 240, seed: 12 }; const whole = await world(o); setClock(START + 86_400); const ws = await run(whole, { batchSize: 25 });
    for (const [first, crashAt] of [[0, 3], [2, 4]] as const) {
      setClock(START); const w = await world(o); let t = START + 86_400;
      if (first) { setClock(t += 60); await run(w, { batchSize: 25, maxBatches: first }); }
      setClock(t += 60); let n = 0;
      await expect(run(w, { batchSize: 25, fault: (s) => { if (s === stage && ++n === (stage === "afterOutputs" ? crashAt : 1)) throw new Error("boom"); } })).rejects.toThrow("boom");
      expect(w.db.T("portfolio_runs").every((r) => r.lease_owner == null)).toBe(true);                   // released in finally
      const crashedRows = w.db.T("portfolio_decisions").length; expect(crashedRows).toBeGreaterThan(0);
      setClock(t += 60); const s = await run(w, { batchSize: 25 });
      expect(s.some((x) => x.rewind.reasons.includes("previous run did not finish"))).toBe(true);
      for (const m of ALL) { const pid = byMode(ws, m).portfolioId; expect(outputs(w.db, pid)).toEqual(outputs(whole.db, pid)); expect(byMode(s, m).summary).toEqual(byMode(ws, m).summary); }
      setClock(t += 60); const again = await run(w, { batchSize: 25 }); for (const x of again) expect(Object.keys(x.writes).filter((k) => OUT_TABLES.includes(k))).toEqual([]);
    }
  });

  it("R2/R6: a run that dies before acting on a change does not lose it — the next run reads changes from the last finished run's start", async () => {
    const o: WorldOpts = { n: 240, seed: 23, resolvedShare: 0.3 }; const w = await world(o); setClock(START + 86_400);
    const s1 = await run(w, { modes: ["REALISTIC"] }); const pid = s1[0].portfolioId;
    const lot = outputs(w.db, pid).lots.find((l) => l.state === "OPEN" && sec(l.opened_ts) < START + 3 * 3600 && !w.db.T("token_resolutions").some((r) => r.token_id === l.token_id) && !w.db.T("paper_ledger").find((r) => r.signal_id === l.signal_id)!.sim_terminal)!;
    const mutate = (x: World) => { x.db.insertRow("token_resolutions", { token_id: lot.token_id, value: 0, resolved_ts: iso(sec(lot.opened_ts) + 900) }); };
    mutate(w); setClock(START + 86_400 + 600); await sweep(w);
    setClock(START + 86_400 + 900); await expect(run(w, { modes: ["REALISTIC"], fault: (st) => { if (st === "afterStart") throw new Error("died early"); } })).rejects.toThrow("died early");
    setClock(START + 86_400 + 1200); const s3 = (await run(w, { modes: ["REALISTIC"] }))[0];
    expect(s3.rewind.reasons.join()).toMatch(/inputs changed/);
    expect(outputs(w.db, pid).lots.find((l) => l.signal_id === lot.signal_id)).toMatchObject({ state: "RESOLVED", resolution_value: 0 });
    const f = await freshReplay(o, mutate, { modes: ["REALISTIC"] }); expect(outputs(w.db, pid)).toEqual(outputs(f.w.db, pid)); expect(s3.summary).toEqual(f.s[0].summary);
  });

  it("R6/R9: a late resolution rewinds and equals a fresh replay; a second unchanged run writes zero rows", async () => {
    const o: WorldOpts = { n: 300, seed: 21, resolvedShare: 0.3 }; const w = await world(o); setClock(START + 86_400);
    const s1 = await run(w); const pidR = byMode(s1, "REALISTIC").portfolioId;
    // a lot filled early on, not resolved yet: its market resolves (late) at a time well before the watermark
    // (and its signal is still swept, so the sweep rewrites its record: the R6 path; R7 covers swept-out records)
    const lot = outputs(w.db, pidR).lots.find((l) => l.state === "OPEN" && sec(l.opened_ts) < START + 3 * 3600 && !w.db.T("token_resolutions").some((r) => r.token_id === l.token_id) && !w.db.T("paper_ledger").find((r) => r.signal_id === l.signal_id)!.sim_terminal)!;
    const mutate = (x: World) => { x.db.insertRow("token_resolutions", { token_id: lot.token_id, value: 1, resolved_ts: iso(sec(lot.opened_ts) + 900) }); };
    mutate(w); setClock(START + 86_400 + 600); await sweep(w);
    const w0 = outWrites(w.db); setClock(START + 86_400 + 1200); const s2 = await run(w);
    const st = byMode(s2, "REALISTIC"); expect(st.rewind.to).toBe(sec(lot.opened_ts) + 900); expect(st.rewind.reasons.join()).toMatch(/inputs changed/); expect(st.rewind.restoredFrom).toBeLessThan(st.rewind.to!);
    expect(outWrites(w.db).portfolio_decisions).toBeGreaterThanOrEqual(w0.portfolio_decisions);
    expect(outputs(w.db, pidR).lots.find((l) => l.signal_id === lot.signal_id)).toMatchObject({ state: "RESOLVED", resolution_value: 1 });
    setClock(START + 86_400 + 1200); const f = await freshReplay(o, mutate);
    for (const m of ALL) { const pid = byMode(s1, m).portfolioId; const a = outputs(w.db, pid), b = outputs(f.w.db, pid);
      expect(a).toEqual(b); expect(byMode(s2, m).summary).toEqual(byMode(f.s, m).summary); }
    // R9: nothing changed since → zero rows written or deleted in every output table
    const before = outWrites(w.db); setClock(START + 86_400 + 1800); const s3 = await run(w);
    expect(outWrites(w.db)).toEqual(before); for (const x of s3) { expect(x.writes).toEqual({}); expect(x.deletes).toEqual({}); expect(x.rewind.to).toBeNull(); }
    assert0008(w.db);
  });

  it("R6: late exit price and late entry price (REALISTIC frontier) → the missing part is decided later and equals a fresh replay", async () => {
    let world0!: World;
    const missing = new Set<string>(); const o: WorldOpts = { n: 260, seed: 31, missing: (t, a) => missing.has(`${t}@${a}`) };
    // pick an exit (of an early entry) and a later entry, and hold back their REALISTIC prices
    setClock(START); world0 = populate(o);
    const exits = world0.db.T("signals").filter((s) => s.kind === "EXIT").sort((a, b) => a.created_at.localeCompare(b.created_at));
    const x = exits.find((s) => sec(s.created_at) > START + 3 * 3600 && sec(s.created_at) < START + 5 * 3600)!;
    const xFill = timeline(sec(x.created_at), sec(x.evaluated_at), MODES.REALISTIC).fillTs; missing.add(`${x.token_id}@${xFill}`);
    const late = world0.entries[230]; const eFill = timeline(late.src, late.ev, MODES.REALISTIC).fillTs; missing.add(`${late.token}@${eFill}`);
    await sweep(world0); setClock(START + 86_400); const s1 = await run(world0, { batchSize: 40 });
    const st = byMode(s1, "REALISTIC"); const pid = st.portfolioId;
    expect(st.frontier).toMatchObject({ ts: xFill, order: KIND_ORDER.EXIT });
    const out = outputs(world0.db, pid);
    expect(st.watermark).toBe(Math.max(...out.decisions.map((d) => sec(d.event_ts)))); expect(st.watermark).toBeLessThan(xFill); // the last second fully decided
    expect(out.decisions.every((d) => sec(d.event_ts) < xFill)).toBe(true); expect(out.equity.every((e) => sec(e.ts) < xFill)).toBe(true);
    expect(out.lots.every((l) => sec(l.opened_ts) < xFill && (l.closed_ts == null || sec(l.closed_ts) < xFill))).toBe(true);
    const entryOf = world0.entries.find((e) => e.token === x.token_id)!;
    expect(out.decisions.filter((d) => sec(d.event_ts) > timeline(entryOf.src, entryOf.ev, MODES.REALISTIC).fillTs).length).toBeGreaterThan(10); // a pending exit does not block entries before it
    expect(byMode(s1, "IDEAL").frontier).toBeNull();                                                                       // IDEAL never waits for prices
    // the exit price arrives: decided up to the missing entry price
    missing.delete(`${x.token_id}@${xFill}`); setClock(START + 86_400 + 600); await sweep(world0); setClock(START + 86_400 + 900);
    const s2 = byMode(await run(world0, { batchSize: 40 }), "REALISTIC"); expect(s2.frontier).toMatchObject({ ts: eFill, order: KIND_ORDER[late.kind] }); expect(s2.watermark).toBeLessThan(eFill); expect(s2.watermark).toBeGreaterThan(xFill);
    expect(outputs(world0.db, pid).decisions.every((d) => sec(d.event_ts) < eFill)).toBe(true);
    // …and the entry price: complete, and equal to a fresh replay with every price present
    missing.clear(); setClock(START + 86_400 + 1200); await sweep(world0); setClock(START + 86_400 + 1500);
    const s3 = await run(world0, { batchSize: 40 }); expect(byMode(s3, "REALISTIC").frontier).toBeNull();
    const f = await freshReplay({ ...o, missing: () => false }, () => {});
    const aside = (o: ReturnType<typeof outputs>) => ({ ...o, decisions: o.decisions.map(noLotHashAside) });   // D24: a no-lot decision keeps the hash it was stored with
    for (const m of ALL) { const p = byMode(s1, m).portfolioId;
      expect(aside(outputs(world0.db, p))).toEqual(aside(outputs(f.w.db, p))); expect(byMode(s3, m).summary).toEqual(byMode(f.s, m).summary); }
    assert0008(world0.db);
  });

  it("R5/R9 (test 15): a late signal with no price yet rewinds, deletes stale rows and re-emits lots open in the restored state", async () => {
    let hold = true; const o: WorldOpts = { n: 200, seed: 41 };
    const w = await world(o); setClock(START + 86_400); const s1 = await run(w, { modes: ["REALISTIC"], pc: PCS.roomy }); const pid = s1[0].portfolioId;
    // a lot that the first run closed by an exit at time t3
    // …across a checkpoint, so the rewind restores a state in which it is open (re-emitted, not replayed)
    const cks = w.db.T("portfolio_checkpoints").filter((c) => c.portfolio_id === pid).map((c) => sec(c.event_ts)).sort((a, b) => a - b);
    const ckIn = (l: Record<string, any>) => cks.find((t) => t > sec(l.opened_ts) && t < sec(l.exit_ts) - 300);
    const closed = outputs(w.db, pid).lots.find((l) => l.state === "EXITED" && sec(l.opened_ts) > START + 600 && ckIn(l) != null)!;
    const t2 = ckIn(closed)! + 60; // a signal (arriving late, price not fetched) filling between that checkpoint and the exit
    const addLate = (x: World) => {
      const ev = t2 - MODES.REALISTIC.decisionLatencySec - MODES.REALISTIC.executionLatencySec; const id = E(9_000);
      x.db.insertRow("signals", { id, kind: "NEW_POSITION", wallet: "wLate", condition_id: "cLate", token_id: "tLate", price: 0.5, usd: 900, created_at: iso(ev - 5), evaluated_at: iso(ev), source_fill_id: "0xlate" });
      x.db.insertRow("paper_ledger", { signal_id: id, created_at: iso(ev), sim_terminal: false, side: "LONG" });
      x.o.missing = (t) => hold && t === "tLate";
    };
    addLate(w); setClock(START + 86_400 + 600); await sweep(w); setClock(START + 86_400 + 900);
    expect(timeline(t2 - 100, t2 - MODES.REALISTIC.decisionLatencySec - MODES.REALISTIC.executionLatencySec, MODES.REALISTIC).fillTs).toBe(t2);
    const s2 = (await run(w, { modes: ["REALISTIC"], pc: PCS.roomy }))[0];
    expect(s2.rewind.to).toBe(t2); expect(s2.rewind.reasons.join()).toMatch(/late signal/); expect(s2.frontier!.ts).toBe(t2); expect(s2.watermark).toBeLessThan(t2);
    expect(s2.rewind.restoredFrom!).toBeGreaterThan(sec(closed.opened_ts)); expect(s2.rewind.restoredFrom!).toBeLessThan(t2);
    expect(s2.deletes.portfolio_decisions).toBeGreaterThan(0); expect(s2.deletes.portfolio_equity).toBeGreaterThan(0);
    const out = outputs(w.db, pid);
    expect(out.decisions.every((d) => sec(d.event_ts) < t2)).toBe(true); expect(out.equity.every((e) => sec(e.ts) < t2)).toBe(true);
    expect(out.lots.find((l) => l.signal_id === closed.signal_id)).toMatchObject({ state: "OPEN", exit_ts: null, closed_ts: null }); // re-emitted, not a stale "EXITED"
    expect(out.lots.every((l) => l.closed_ts == null || sec(l.closed_ts) < t2)).toBe(true);
    expect(w.db.T("portfolio_checkpoints").filter((c) => c.portfolio_id === pid).every((c) => sec(c.event_ts) < t2)).toBe(true);
    // the price arrives → the whole history, equal to a fresh replay
    hold = false; setClock(START + 86_400 + 1200); await sweep(w); setClock(START + 86_400 + 1500); const s3 = (await run(w, { modes: ["REALISTIC"], pc: PCS.roomy }))[0];
    const f = await freshReplay(o, addLate, { modes: ["REALISTIC"], pc: PCS.roomy });
    expect(outputs(w.db, pid)).toEqual(outputs(f.w.db, pid)); expect(s3.summary).toEqual(f.s[0].summary);
    expect(outputs(w.db, pid).decisions.find((d) => d.signal_id === E(9_000))).toBeTruthy();
    assert0008(w.db);
  });

  it("R6: a rewind point exactly on a checkpoint's second restores the checkpoint before it (that one already applied the second)", async () => {
    const o: WorldOpts = { n: 240, seed: 55, resolvedShare: 0.2 }; const w = await world(o); setClock(START + 86_400);
    const s1 = (await run(w, { modes: ["REALISTIC"], pc: PCS.roomy }))[0]; const pid = s1.portfolioId;
    const cks = w.db.T("portfolio_checkpoints").filter((c) => c.portfolio_id === pid).map((c) => sec(c.event_ts)).sort((a, b) => a - b);
    const lot = outputs(w.db, pid).lots.find((l) => l.state === "OPEN" && !w.db.T("paper_ledger").find((r) => r.signal_id === l.signal_id)!.sim_terminal && !w.db.T("token_resolutions").some((r) => r.token_id === l.token_id) && cks.some((t) => t > sec(l.opened_ts) && t < s1.watermark!))!;
    const at = cks.find((t) => t > sec(lot.opened_ts))!;
    const mutate = (x: World) => { x.db.insertRow("token_resolutions", { token_id: lot.token_id, value: 1, resolved_ts: iso(at) }); };
    mutate(w); setClock(START + 86_400 + 600); await sweep(w); setClock(START + 86_400 + 900);
    const s2 = (await run(w, { modes: ["REALISTIC"], pc: PCS.roomy }))[0];
    expect(s2.rewind.to).toBe(at); expect(s2.rewind.restoredFrom!).toBeLessThan(at);
    expect(outputs(w.db, pid).lots.find((l) => l.signal_id === lot.signal_id)).toMatchObject({ state: "RESOLVED", resolution_ts: iso(at) });
    const f = await freshReplay(o, mutate, { modes: ["REALISTIC"], pc: PCS.roomy });
    expect(outputs(w.db, pid)).toEqual(outputs(f.w.db, pid)); expect(s2.summary).toEqual(f.s[0].summary);
  });

  it("R7: a restored lot whose entry inputs changed while its record is swept out (sim_terminal) is replayed from its entry", async () => {
    const o: WorldOpts = { n: 240, seed: 57 }; const w = await world(o); setClock(START + 86_400);
    const s1 = (await run(w, { modes: ["REALISTIC"], pc: PCS.roomy }))[0]; const pid = s1.portfolioId;
    const lot = outputs(w.db, pid).lots.find((l) => l.state === "OPEN" && sec(l.opened_ts) > START + 3600 && l.cost_usd >= 99)!;
    const mutate = (x: World) => {
      Object.assign(x.db.T("signals").find((q) => q.id === lot.signal_id)!, { usd: 30 });   // the source trade was far smaller: less liquidity
      x.db.T("paper_ledger").find((r) => r.signal_id === lot.signal_id)!.sim_terminal = true; // …and the sweep never recomputes it
    };
    const computed = w.db.T("paper_executions").filter((r) => r.signal_id === lot.signal_id).map((r) => r.computed_at);
    mutate(w); setClock(START + 86_400 + 600); await sweep(w);
    expect(w.db.T("paper_executions").filter((r) => r.signal_id === lot.signal_id).map((r) => r.computed_at)).toEqual(computed);
    setClock(START + 86_400 + 900); const s2 = (await run(w, { modes: ["REALISTIC"], pc: PCS.roomy }))[0];
    expect(s2.rewind.to).toBe(sec(lot.opened_ts)); expect(s2.rewind.reasons.join()).toMatch(/before that checkpoint/);
    const after = outputs(w.db, pid).decisions.find((d) => d.signal_id === lot.signal_id)!; expect(after.filled_usd).toBeLessThan(lot.cost_usd);
    const f = await freshReplay(o, mutate, { modes: ["REALISTIC"], pc: PCS.roomy });
    expect(outputs(w.db, pid)).toEqual(outputs(f.w.db, pid)); expect(s2.summary).toEqual(f.s[0].summary);
  });

  it("R7: rehydration — a restored lot learns a resolution the sweep never recomputes (sim_terminal, token_resolution_obs); one before the checkpoint forces an earlier checkpoint", async () => {
    const o: WorldOpts = { n: 300, seed: 51, resolvedShare: 0.2 };
    const w = await world(o); setClock(START + 86_400); const s1 = await run(w, { modes: ["REALISTIC"] }); const pid = s1[0].portfolioId; const W = s1[0].watermark!;
    const open = outputs(w.db, pid).lots.filter((l) => l.state === "OPEN" && !w.db.T("token_resolutions").some((r) => r.token_id === l.token_id)).sort((a, b) => a.opened_ts.localeCompare(b.opened_ts));
    expect(open.length).toBeGreaterThan(3);
    const early = open[0], recent = open.at(-1)!; // resolved before the checkpoint / after the watermark
    const mutate = (x: World) => {
      for (const [l, ts] of [[early, sec(early.opened_ts) + 600], [recent, W + 3600]] as const) {
        x.db.insertRow("token_resolution_obs", { token_id: l.token_id, condition_id: l.condition_id, value: 0, resolved_ts: iso(ts), source: "v2-resolutions" });
        x.db.insertRow("token_resolutions", { token_id: l.token_id, value: 0, resolved_ts: iso(ts) });     // the view, as in Postgres
        x.db.T("paper_ledger").find((r) => r.signal_id === l.signal_id)!.sim_terminal = true;            // the sweep never looks at it again
      }
    };
    mutate(w); const computed = w.db.T("paper_executions").filter((r) => r.signal_id === early.signal_id).map((r) => r.computed_at);
    setClock(START + 86_400 + 600); await sweep(w);
    expect(w.db.T("paper_executions").filter((r) => r.signal_id === early.signal_id).map((r) => r.computed_at)).toEqual(computed); // R6 cannot see it
    setClock(START + 86_400 + 900); const s2 = (await run(w, { modes: ["REALISTIC"] }))[0];
    expect(s2.rewind.reasons.join()).toMatch(/before that checkpoint/); expect(s2.rewind.restoredFrom!).toBeLessThan(sec(early.opened_ts) + 600);
    const out = outputs(w.db, pid);
    expect(out.lots.find((l) => l.signal_id === early.signal_id)).toMatchObject({ state: "RESOLVED", resolution_value: 0, resolution_ts: iso(sec(early.opened_ts) + 600) });
    expect(out.lots.find((l) => l.signal_id === recent.signal_id)).toMatchObject({ state: "OPEN" });              // after the watermark: scheduled, not applied
    const ck = latestCk(w.db, pid).state as BookState; expect(ck.heap.some((e) => e.id === recent.signal_id && e.type === "RESOLUTION" && e.ts === W + 3600)).toBe(true);
    const f = await freshReplay(o, mutate, { modes: ["REALISTIC"] });
    expect(outputs(w.db, pid)).toEqual(outputs(f.w.db, pid)); expect(s2.summary).toEqual(f.s[0].summary);
    assert0008(w.db);
  });

  it("R6/R8 (test 9): new marks and a metadata re-fetch → no rewind and zero output writes", async () => {
    const w = await world({ n: 200, seed: 61 }); setClock(START + 86_400); await run(w);
    for (const e of w.entries.slice(0, 120)) w.db.insertRow("paper_marks", { signal_id: e.id, horizon: "24h", observed_at: iso(e.src + 86_400), price: 0.33 });
    for (const m of w.db.T("markets")) m.meta_fetched_at = iso(START + 86_400);
    setClock(START + 86_400 + 600); const changed = w.db.T("paper_executions").length; await sweep(w);
    expect(w.db.T("paper_executions").filter((r) => sec(r.computed_at) === START + 86_400 + 600).length).toBeGreaterThan(50); // the sweep did rewrite them
    const before = outWrites(w.db); setClock(START + 86_400 + 900); const s = await run(w);
    for (const x of s) { expect(x.rewind).toEqual({ to: null, restoredFrom: expect.any(Number), reasons: [] }); expect(x.writes).toEqual({}); expect(x.deletes).toEqual({}); }
    expect(outWrites(w.db)).toEqual(before);
  });

  it("R2: a lease held by another owner → portfolio skipped, nothing written", async () => {
    const w = await world({ n: 80 }); setClock(START + 86_400);
    const defs = portfolioDefinitions(cfgOf(PCS.tight));
    for (const d of defs) { w.db.insertRow("portfolios", { id: d.id, mode: d.mode }); expect((await w.db.rpc("claim_portfolio_lease", { p_portfolio_id: d.id, p_owner: "other-host:1:abcd", p_seconds: 900 })).data).toBe(true); }
    const before = dump(w.db); const s = await run(w);
    for (const x of s) expect(x).toMatchObject({ skipped: "LEASE_HELD", rowsRead: 0, summary: null });
    expect(dump(w.db)).toBe(before);
    setClock(START + 86_400 + 901); const s2 = await run(w);                  // the other owner's lease expired
    for (const x of s2) { expect(x.skipped).toBeUndefined(); expect(x.batches).toBeGreaterThan(0); }
    // a lease lost mid-run stops the run (another runner took over): nothing after that point is written by this one
    setClock(START + 2 * 86_400); const w2 = await world({ n: 120 }); setClock(START + 3 * 86_400);
    await expect(run(w2, { modes: ["IDEAL"], batchSize: 20, fault: () => { const r = w2.db.T("portfolio_runs")[0]; r.lease_owner = "thief"; r.lease_until = iso(START + 4 * 86_400); } })).rejects.toThrow(/lease lost/);
    expect(w2.db.T("portfolio_runs")[0].lease_owner).toBe("thief");        // release only frees our own lease
  });

  it("R3/D4 (test 12): the start boundary — signals traded or filled before startTs are never requested, one exactly at it is; a different start is a different portfolio", async () => {
    const w = await world({ n: 120, before: 30, seed: 71 }); setClock(START + 86_400);
    const s = await run(w);
    for (const m of ALL) {
      const d = outputs(w.db, byMode(s, m).portfolioId).decisions; expect(d.every((x) => sec(x.event_ts) >= START)).toBe(true);
      const want = w.entries.filter((e) => e.src >= START && timeline(e.src, e.ev, MODES[m]).fillTs >= START).length; expect(d.length).toBe(want); expect(want).toBeLessThan(120);
      expect(d.every((x) => sec(w.db.T("signals").find((s) => s.id === x.signal_id)!.created_at) >= START)).toBe(true);        // source time too
    }
    // the sweep rewrites records from before the start (new marks): not the portfolio's business, nothing rewinds
    for (const e of w.entries.filter((x) => x.src < START - 300)) w.db.insertRow("paper_marks", { signal_id: e.id, horizon: "6h", observed_at: iso(e.src + 6 * 3600), price: 0.9 });
    setClock(START + 86_400 + 600); await sweep(w); const before = outWrites(w.db); setClock(START + 86_400 + 900);
    for (const x of await run(w)) { expect(x.rewind.to).toBeNull(); expect(x.writes).toEqual({}); } expect(outWrites(w.db)).toEqual(before);
    // a start exactly at one entry's source trade (the D4 rule looks at source and fill time): that entry is in
    const r = w.entries.find((e) => e.src > START + 600)!; const at = r.src;
    const s2 = await runPortfolios(w.db as never, { config: cfgOf(PCS.tight, at), modes: ["REALISTIC"], owner: "t" });
    expect(s2[0].portfolioId).not.toBe(byMode(s, "REALISTIC").portfolioId);
    const d2 = outputs(w.db, s2[0].portfolioId).decisions; expect(d2.every((x) => sec(x.event_ts) >= at)).toBe(true); expect(d2.some((x) => x.signal_id === r.id && sec(x.event_ts) === timeline(r.src, r.ev, MODES.REALISTIC).fillTs)).toBe(true);
    expect(d2.every((x) => sec(w.db.T("signals").find((y) => y.id === x.signal_id)!.created_at) >= at)).toBe(true);
    expect(outputs(w.db, byMode(s, "REALISTIC").portfolioId).decisions.length).toBeGreaterThan(d2.length); // the old portfolio is untouched
    await expect(runPortfolios(w.db as never, { config: validatePortfolioConfig({ ...PCS.tight, startTs: iso(clock + 60) }, clock + 60), modes: ["IDEAL"], owner: "t" })).resolves.toBeDefined();
  });

  it("R4 (test 14): source_fill_id — one fill → one lot (credited to NEW_POSITION); two distinct fills sharing the legacy key → two lots", async () => {
    const db = mkDb(); const src = START + 100, ev = START + 130;
    const base = { wallet: "wA", condition_id: "c1", token_id: "tA", price: 0.4, usd: 900, created_at: iso(src), evaluated_at: iso(ev) };
    // ids chosen so the database order (id) differs from the book's (kind)
    const rows = [{ id: E(1), kind: "CONSENSUS", source_fill_id: "0xF1" }, { id: E(2), kind: "NEW_POSITION", source_fill_id: "0xF1" }, { id: E(3), kind: "CONVICTION_ADD", source_fill_id: "0xF2" }];
    for (const r of rows) { db.insertRow("signals", { ...base, ...r }); }
    for (const r of rows) db.insertRow("paper_ledger", { signal_id: r.id, created_at: iso(ev), sim_terminal: false, side: "LONG" });
    const w: World = { db, o: { n: 0 }, entries: [] }; await sweep(w, false);
    for (const r of db.T("price_observations")) Object.assign(r, { state: "COMPLETE", obs_ts: r.as_of - 5, price: 0.4, resolution_seconds: 0 });
    await sweepSimulation(db as never); setClock(START + 86_400);
    const s = await runPortfolios(db as never, { config: cfgOf(PCS.roomy), modes: ["IDEAL", "REALISTIC"], owner: "t" });
    for (const x of s) {
      const out = outputs(db, x.portfolioId); const k = (id: string) => out.decisions.find((d) => d.signal_id === id)!;
      expect([k(E(2)).outcome, k(E(3)).outcome]).toEqual(["FILLED", "FILLED"]); expect(k(E(1))).toMatchObject({ outcome: "REJECTED", reason: "REJECTED_DUPLICATE_POSITION", source_key: "fill:0xF1" });
      expect(out.lots.map((l) => l.signal_id)).toEqual([E(2), E(3)]);
    }
  });

  it("R9/R10 (test 16): equity older than 7 days keeps the last point per hour; checkpoints: ≤1 per hour for 10 days, ≤1 per day before, one at the watermark", async () => {
    const o: WorldOpts = { n: 700, seed: 81, gap: 2_700 }; const w = await world(o);       // ~22 days of history
    const end = START + 700 * 2_700; const now = end + 86_400; setClock(now);
    const s = await run(w, { modes: ["IDEAL"], batchSize: 50 }); const st = s[0]; const pid = st.portfolioId;
    const { ref } = await reference(w.db, "IDEAL", cfgOf(PCS.tight)); const W = st.watermark!;
    const cutoff = Math.floor((now - EQUITY_DENSE_DAYS * 86_400) / 3600) * 3600;
    const curve = ref.curve.filter((p) => p.ts <= W).map((p, i, a) => ({ ...p, seq: a.slice(0, i).filter((q) => q.ts === p.ts).length }));
    const lastPerHour = new Map<number, (typeof curve)[number]>(); for (const p of curve) if (p.ts < cutoff) lastPerHour.set(Math.floor(p.ts / 3600), p);
    const want = [...curve.filter((p) => p.ts < cutoff && lastPerHour.get(Math.floor(p.ts / 3600)) === p), ...curve.filter((p) => p.ts >= cutoff)];
    const got = outputs(w.db, pid).equity.map((e) => ({ ts: sec(e.ts), equity: e.equity, cash: e.cash, exposure: e.exposure, seq: e.seq }));
    expect(got).toEqual(want); expect(curve.length - want.length).toBeGreaterThan(50);
    const cks = w.db.T("portfolio_checkpoints").filter((c) => c.portfolio_id === pid).map((c) => sec(c.event_ts)).sort((a, b) => a - b);
    const recent = cks.filter((t) => t >= now - CHECKPOINT_HOURLY_DAYS * 86_400), old = cks.filter((t) => t < now - CHECKPOINT_HOURLY_DAYS * 86_400);
    expect(new Set(recent.map((t) => Math.floor(t / 3600))).size).toBe(recent.length); expect(recent.length).toBeGreaterThan(50);
    expect(new Set(old.map((t) => Math.floor(t / 86_400))).size).toBe(old.length); expect(old.length).toBeGreaterThan(5);
    expect(cks.at(-1)).toBe(W);
    // every surviving checkpoint is a correct restart point: restore it, replay the rest, same result
    for (const t of [old[0], old.at(-1)!, recent[5]]) {
      const ck = w.db.T("portfolio_checkpoints").find((c) => c.portfolio_id === pid && sec(c.event_ts) === t)!;
      const b = new PortfolioBook(MODES.IDEAL, PCS.tight, JSON.parse(JSON.stringify(ck.state)));
      const { reqs } = await reference(w.db, "IDEAL", cfgOf(PCS.tight)); for (const r of reqs.filter((r) => r.key.ts > t).sort((a, c) => a.key.ts - c.key.ts || a.key.order - c.key.order || (a.key.id < c.key.id ? -1 : 1))) b.submit(r.signal);
      b.advance(null); const { decisions: _d, curve: _c, ...totals } = ref; expect(b.summary()).toEqual(totals);
    }
    // a later run a day on re-thins only what aged, and a run with nothing new writes nothing
    // unchanged inputs at the same time: nothing at all; a day later: only aging (thinning), never a rewrite
    setClock(now); const again = await run(w, { modes: ["IDEAL"] }); expect(again[0].writes).toEqual({}); expect(again[0].deletes).toEqual({});
    setClock(now + 86_400); const later = await run(w, { modes: ["IDEAL"] }); expect(later[0].writes).toEqual({});
    expect(Object.keys(later[0].deletes).length).toBeGreaterThan(0); for (const t of Object.keys(later[0].deletes)) expect(["portfolio_checkpoints", "portfolio_equity"]).toContain(t);
    const cut2 = Math.floor((now + 86_400 - EQUITY_DENSE_DAYS * 86_400) / 3600) * 3600; const eq2 = outputs(w.db, pid).equity.filter((e) => sec(e.ts) < cut2);
    expect(new Set(eq2.map((e) => Math.floor(sec(e.ts) / 3600))).size).toBe(eq2.length);
    const ck2 = w.db.T("portfolio_checkpoints").filter((c) => c.portfolio_id === pid).map((c) => sec(c.event_ts));
    const old2 = ck2.filter((t) => t < now + 86_400 - CHECKPOINT_HOURLY_DAYS * 86_400); expect(new Set(old2.map((t) => Math.floor(t / 86_400))).size).toBe(old2.length);
  });

  it("R11 (test 18): 100,000 executions — every query returns at most one batch plus its same-second tail; open lots stay bounded", async () => {
    const db = mkDb(); const N = 100_000; const G = 9; const pc = { ...PCS.tight, maxOpenPositions: 40, startingCapitalUsd: 100_000, maxMarketExposureUsd: 100_000, maxWalletAllocationUsd: 100_000 };
    let seed = 5; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let t = START; const sigs: any[] = [], led: any[] = [], ex: any[] = [];
    for (let i = 0; i < N; i++) {
      if (i % G === 0 || rnd() < 0.8) t += 4;                                  // many same-second groups, up to 9 rows
      const id = E(i); sigs.push({ id, kind: ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"][i % 4], wallet: `w${i % 50}`, condition_id: `c${i % 300}`, token_id: `t${i}`, price: 0.2 + rnd() * 0.6, usd: 1000, created_at: iso(t), evaluated_at: iso(t + 2), source_fill_id: `f${i}` });
      led.push({ signal_id: id, created_at: iso(t + 2), sim_terminal: true, side: "LONG" });
      ex.push({ signal_id: id, mode: "IDEAL", fill_ts: iso(t), computed_at: iso(START), state: "OPEN", coverage_state: "SIMULATED", record_hash: "x" });
      if (i % 3 === 0) db.insertRow("token_resolutions", { token_id: `t${i}`, value: i % 2, resolved_ts: iso(t + 600 + (i % 7) * 300) });
    }
    for (const r of sigs) db.insertRow("signals", r); for (const r of led) db.insertRow("paper_ledger", r); for (const r of ex) db.insertRow("paper_executions", r);
    const maxGroup = Math.max(...[...ex.reduce((m, r) => m.set(r.fill_ts, (m.get(r.fill_ts) ?? 0) + 1), new Map<string, number>()).values()]); expect(maxGroup).toBeGreaterThan(3);
    setClock(t + 3600); db.stats.maxRowsPerCall = 0;
    const s = (await runPortfolios(db as never, { config: cfgOf(pc), modes: ["IDEAL"], owner: "t" }))[0];
    expect(s.rowsRead).toBe(N); expect(s.batches).toBeGreaterThanOrEqual(N / 500 - 1);
    expect(db.stats.maxRowsPerCall).toBeLessThanOrEqual(500 + maxGroup); expect(db.stats.maxWritePerCall).toBeLessThanOrEqual(500);
    const ck = latestCk(db, s.portfolioId).state as BookState; expect(ck.lots.length).toBeLessThanOrEqual(40); expect(ck.heap.length).toBeLessThanOrEqual(80);
    expect(ck.taken.length).toBeLessThan(N / 2);
    expect(s.decisions.REJECTED).toBeGreaterThan(1000);
    // an unchanged second run reads no execution row twice and writes nothing
    db.stats.maxRowsPerCall = 0; setClock(t + 7200); const s2 = (await runPortfolios(db as never, { config: cfgOf(pc), modes: ["IDEAL"], owner: "t" }))[0];
    expect(s2.rowsRead).toBe(0); expect(s2.writes).toEqual({}); expect(db.stats.maxRowsPerCall).toBeLessThanOrEqual(500 + maxGroup);
  }, 240_000);

  // Test 19 against the real schema: every row the runner wrote (after rewinds, crashes, pruning) loads into 0008's
  // tables with all constraints and foreign keys in force. Skipped unless PG_TEST_URL is set (see tests/sql.test.ts).
  (process.env.PG_TEST_URL ? it : it.skip)("every row written satisfies the 0008 constraints in real Postgres", async () => {
    const o: WorldOpts = { n: 260, seed: 91, groups: [{ at: 30, size: 8 }] }; const w = await world(o); let t = START + 86_400;
    setClock(t); await run(w, { batchSize: 40, maxBatches: 2 });
    let n = 0; await expect(run(w, { batchSize: 40, fault: (s) => { if (s === "afterOutputs" && ++n === 2) throw new Error("boom"); } })).rejects.toThrow();
    const e = w.entries[60]; w.db.insertRow("token_resolutions", { token_id: e.token, value: 0, resolved_ts: iso(e.src + 2000) });
    w.db.insertRow("token_resolution_obs", { token_id: e.token, condition_id: "c-late", value: 0, resolved_ts: iso(e.src + 2000), source: "v2-resolutions" });
    setClock(t += 600); await sweep(w); setClock(t += 600); await run(w, { batchSize: 40 }); setClock(t + 20 * 86_400); await run(w);
    assert0008(w.db);
    const c = new pg.Client({ connectionString: process.env.PG_TEST_URL }); await c.connect();
    try {
      await c.query("begin");                                                // everything below is rolled back
      if (!(await c.query("select to_regclass('portfolios') as t")).rows[0].t) await c.query(readFileSync(path.resolve(__dirname, "../supabase/migrations/0008_portfolio.sql"), "utf8"));
      // ids and tokens moved to a namespace no other SQL test uses (the files run in parallel)
      const ns = (r: Record<string, any>) => JSON.parse(JSON.stringify(r).replaceAll('"00000000-0000-4000-', '"19000000-0000-4000-').replace(/"token_id":"t(\d+)"/g, '"token_id":"pg19-t$1"'));
      const ins = async (table: string, raw: Record<string, any>[]) => {
        const rows = raw.map(ns);
        for (const r of rows) { const cols = Object.keys(r); await c.query(`insert into ${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((k) => (r[k] !== null && typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k]))); }
        return rows.length;
      };
      const ids = new Set([...w.db.T("portfolio_decisions"), ...w.db.T("portfolio_lots")].map((r) => r.signal_id));
      await ins("signals", w.db.T("signals").filter((s) => ids.has(s.id)).map((s) => ({ id: s.id, kind: s.kind, severity: 3, wallet: s.wallet, condition_id: s.condition_id, token_id: s.token_id, price: s.price, usd: s.usd, dedupe_key: `pg19:${s.id}`, created_at: s.created_at })));
      const counts = {
        portfolios: await ins("portfolios", w.db.T("portfolios")), portfolio_runs: await ins("portfolio_runs", w.db.T("portfolio_runs")),
        portfolio_checkpoints: await ins("portfolio_checkpoints", w.db.T("portfolio_checkpoints")), portfolio_decisions: await ins("portfolio_decisions", w.db.T("portfolio_decisions")),
        portfolio_lots: await ins("portfolio_lots", w.db.T("portfolio_lots")), portfolio_equity: await ins("portfolio_equity", w.db.T("portfolio_equity")), token_resolution_obs: await ins("token_resolution_obs", w.db.T("token_resolution_obs")),
      };
      for (const [k, v] of Object.entries(counts)) expect(v, k).toBeGreaterThan(0);
      // Only this test's portfolios: the database is shared with other files running in parallel (and may hold their rows).
      const mine = w.db.T("portfolios").map((p) => p.id);
      expect(Number((await c.query("select count(*) from portfolio_lots l join portfolio_decisions d using (portfolio_id, signal_id) where d.outcome in ('FILLED','PARTIALLY_FILLED') and l.portfolio_id = any($1)", [mine])).rows[0].count)).toBe(counts.portfolio_lots);
      const ck = (await c.query("select state from portfolio_checkpoints where portfolio_id = any($1) order by event_ts desc limit 1", [mine])).rows[0].state as BookState; expect(ck.v).toBe(1);
      expect(() => new PortfolioBook(MODES.IDEAL, PCS.tight, ck)).not.toThrow();                    // a checkpoint survives jsonb
    } finally { await c.query("rollback"); await c.end(); }
  });
});
