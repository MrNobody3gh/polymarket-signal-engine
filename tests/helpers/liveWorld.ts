/**
 * Live-world helpers shared by the stale-hash / D24 / D26 / D27 tests: an in-memory database with the lease RPCs, the real
 * sweep (`sweepSimulation`) and the real runner (`runPortfolios`) driven by a fake clock, signals / exits / resolutions
 * added over time, the price backlog, the audit, and "a fresh replay of the final inputs" for equality checks.
 * Extracted from tests/phase3-stale-hash.test.ts unchanged, so several files can drive the same worlds.
 * Each test file calls installClock() once at its top level.
 */
import { vi, expect, beforeEach, afterEach } from "vitest";
import { stressDb } from "./stressDb";
import { sweepSimulation } from "@/lib/paper/sim/run";
import { MODES, type ModeName, type PortfolioConfig } from "@/lib/paper/sim/config";
import { timeline } from "@/lib/paper/sim/execute";
import { runPortfolios } from "@/lib/paper/portfolio/run";
import { validatePortfolioConfig, portfolioDefinitions, type PortfolioRunConfig } from "@/lib/paper/portfolio/config";
import { changeDetectionReadsFrom } from "@/lib/paper/portfolio/requests";
import { auditPortfolios, type DecisionAudit } from "@/lib/paper/portfolio/audit";
void timeline; void MODES;

export const START = 1_790_000_000;
export const iso = (s: number) => new Date(s * 1000).toISOString();
export const sec = (v: string) => Math.floor(Date.parse(v) / 1000);
export const pad = (i: number) => String(i).padStart(12, "0");
export const E = (i: number) => `00000000-0000-4000-8000-${pad(i)}`, X = (i: number) => `00000000-0000-4000-9000-${pad(i)}`;
export const ALL: ModeName[] = ["IDEAL", "REALISTIC", "CONSERVATIVE"];
/** One slot: every entry after the first is REJECTED_MAX_OPEN_POSITIONS, so it never opens a lot. */
export const ONE_SLOT: PortfolioConfig = { startingCapitalUsd: 10_000, positionUsd: 100, maxMarketExposureUsd: 10_000, maxTotalExposurePct: 100, maxOpenPositions: 1, maxWalletAllocationUsd: 10_000, minCashReserveUsd: 0, allowResize: false };
export const TIGHT: PortfolioConfig = { startingCapitalUsd: 1_500, positionUsd: 100, maxMarketExposureUsd: 300, maxTotalExposurePct: 70, maxOpenPositions: 3, maxWalletAllocationUsd: 350, minCashReserveUsd: 50, allowResize: true };
export const ROOMY: PortfolioConfig = { startingCapitalUsd: 1_000_000, positionUsd: 100, maxMarketExposureUsd: 1_000_000, maxTotalExposurePct: 100, maxOpenPositions: 100_000, maxWalletAllocationUsd: 1_000_000, minCashReserveUsd: 0, allowResize: false };

export let clock = START;
export const setClock = (t: number) => { clock = t; vi.setSystemTime(t * 1000); };
/** Call once at the top level of a test file: a fake `Date` (the runner and the sweep read it), reset to START before each test. */
export function installClock() { beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); setClock(START); }); afterEach(() => { vi.useRealTimers(); }); }

export type Db = ReturnType<typeof stressDb>;
export function mkDb(): Db {
  const now = () => Math.floor(Date.now() / 1000);
  const runsRow = (id: string) => db.T("portfolio_runs").find((r) => r.portfolio_id === id);
  const db: Db = stressDb({ rpc: {
    claim_portfolio_lease: ({ p_portfolio_id: id, p_owner: owner, p_seconds: s }: any) => {
      let r = runsRow(id); if (!r) { r = { portfolio_id: id, lease_owner: null, lease_until: null, last_run_started_at: null, last_run_finished_at: null, last_watermark_ts: null, last_watermark_key: null, stats: {} }; db.insertRow("portfolio_runs", r); }
      if (r.lease_until == null || sec(r.lease_until) <= now() || r.lease_owner === owner) { r.lease_owner = owner; r.lease_until = iso(now() + s); return true; }
      return false;
    },
    release_portfolio_lease: ({ p_portfolio_id: id, p_owner: owner }: any) => { const r = runsRow(id); if (!r || r.lease_owner !== owner) return false; r.lease_owner = null; r.lease_until = null; return true; },
  } });
  return db;
}
export const cfgOf = (pc: PortfolioConfig): PortfolioRunConfig => validatePortfolioConfig({ ...pc, startTs: iso(START) }, clock);
export const defOf = (pc: PortfolioConfig, m: ModeName) => portfolioDefinitions(cfgOf(pc)).find((d) => d.mode === m)!;
export const run = (db: Db, pc: PortfolioConfig, extra: Record<string, unknown> = {}) => runPortfolios(db as never, { config: cfgOf(pc), modes: ALL, owner: "worker", ...extra });
export const audit = (db: Db, pc: PortfolioConfig) => auditPortfolios(db as never, cfgOf(pc), { now: () => clock });
export const byMode = (r: DecisionAudit[], m: ModeName) => r.find((x) => x.mode === m)!;
export const unit = (k: string) => { let h = 2166136261; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 2 ** 32; };
/** The price backlog: every PENDING observation becomes COMPLETE (a function of token and time only), except `unavailable`. */
export function fetchPrices(db: Db, unavailable: (token: string, asOf: number) => boolean = () => false, hold: (token: string, asOf: number) => boolean = () => false) {
  for (const r of db.T("price_observations")) {
    if (r.state !== "PENDING" || hold(r.token_id, r.as_of)) continue;                       // `hold`: not fetched yet, stays PENDING
    Object.assign(r, unavailable(r.token_id, r.as_of) ? { state: "UNAVAILABLE" } : { state: "COMPLETE", obs_ts: r.as_of - Math.floor(unit(`${r.token_id}@${r.as_of}`) * 50), price: 0.3 + unit(`${r.token_id}@${r.as_of}`) * 0.4, resolution_seconds: 0 });
  }
}
export const putObs = (db: Db, token: string, asOf: number) => db.insertRow("price_observations", { token_id: token, as_of: asOf, state: "COMPLETE", obs_ts: asOf - 3, price: 0.5, resolution_seconds: 0 });

export interface Sig { id: string; kind: string; wallet: string; cond: string; token: string; src: number; ev: number; usd?: number; price?: number }
export const addEntry = (db: Db, s: Sig, fill = s.id) => { db.insertRow("signals", { id: s.id, kind: s.kind, wallet: s.wallet, condition_id: s.cond, token_id: s.token, price: s.price ?? 0.5, usd: s.usd ?? 3000, created_at: iso(s.src), evaluated_at: iso(s.ev), source_fill_id: `0xfill${fill}` }); db.insertRow("paper_ledger", { signal_id: s.id, created_at: iso(s.ev), sim_terminal: false, side: "LONG" }); };
export const addExit = (db: Db, id: string, wallet: string, cond: string, token: string, src: number, ev: number, usd: number) => { db.insertRow("signals", { id, kind: "EXIT", wallet, condition_id: cond, token_id: token, price: 0.6, usd, created_at: iso(src), evaluated_at: iso(ev), source_fill_id: `0xexit${id}` }); db.insertRow("paper_ledger", { signal_id: id, created_at: iso(ev), sim_terminal: true, side: "EXIT_EVENT" }); };
export const addMarkets = (db: Db, conds: string[]) => { for (const c of conds) db.insertRow("markets", { condition_id: c, fees_enabled: true, taker_fee_rate: 0.02, tick_size: 0.01, min_order_shares: 5, meta_fetched_at: iso(START - 86_400) }); };
export const decisionOf = (db: Db, pid: string, id: string) => db.T("portfolio_decisions").find((d) => d.portfolio_id === pid && d.signal_id === id);
export const execOf = (db: Db, id: string, m: ModeName) => db.T("paper_executions").find((x) => x.signal_id === id && x.mode === m);
export const ledgerOf = (db: Db, id: string) => db.T("paper_ledger").find((l) => l.signal_id === id)!;

// ───────────────────────────── outputs, and "a fresh replay of the final inputs" ─────────────────────────────
export const strip = ({ computed_at: _c, record_hash: _r, input_hash: _i, ...r }: Record<string, any>) => r;
export const outputs = (db: Db) => ({
  decisions: db.T("portfolio_decisions").map(strip).sort((a, b) => `${a.portfolio_id}${a.signal_id}`.localeCompare(`${b.portfolio_id}${b.signal_id}`)),
  lots: db.T("portfolio_lots").map(strip).sort((a, b) => `${a.portfolio_id}${a.signal_id}`.localeCompare(`${b.portfolio_id}${b.signal_id}`)),
  equity: db.T("portfolio_equity").map((r) => [r.portfolio_id, r.ts, r.seq, r.cash, r.exposure, r.equity]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
});
/** Same signals, marks, metadata, resolutions and price observations in an empty database; sweep once, run once. */
export async function freshReplay(db: Db, pc: PortfolioConfig): Promise<Db> {
  const f = mkDb();
  for (const t of ["signals", "paper_ledger", "markets", "token_resolutions", "paper_marks", "price_observations"]) for (const r of db.T(t)) f.insertRow(t, { ...r, ...(t === "paper_ledger" && r.side === "LONG" ? { sim_terminal: false } : {}) });
  await sweepSimulation(f as never); await run(f, pc);
  return f;
}
/** input_hash aside, the incrementally-run database and a from-scratch replay of its final inputs are identical. */
export const sameNumbers = async (db: Db, pc: PortfolioConfig, modes: ModeName[] = ALL) => {
  const fresh = await freshReplay(db, pc); const keep = new Set(modes.map((m) => defOf(pc, m).id)); const a = outputs(db), b = outputs(fresh);
  const only = <T extends { portfolio_id?: string }>(rows: T[]) => rows.filter((r) => keep.has(String(r.portfolio_id ?? "")));
  const diffs = (x: Record<string, any>[], y: Record<string, any>[]) => { const kx = new Map(x.map((r) => [`${r.portfolio_id}|${r.signal_id}`, JSON.stringify(r)])), ky = new Map(y.map((r) => [`${r.portfolio_id}|${r.signal_id}`, JSON.stringify(r)])); return [...new Set([...kx.keys(), ...ky.keys()])].filter((k) => kx.get(k) !== ky.get(k)).map((k) => `${k}\n  incremental: ${kx.get(k)}\n  fresh:       ${ky.get(k)}`); };
  expect(diffs(only(a.decisions), only(b.decisions))).toEqual([]); expect(diffs(only(a.lots), only(b.lots))).toEqual([]);
  expect(a.equity.filter((e) => keep.has(String(e[0])))).toEqual(b.equity.filter((e) => keep.has(String(e[0]))));
};

/**
 * Random live worlds through the real sweep and runner, in production order and cadence (price backlog → sweep → the
 * three portfolio runs, every 15 minutes; signals, late-evaluated exits and late resolutions arriving over time), audited
 * after every cycle. Two properties:
 *  - LOST never happens: no decision keeps a stale hash although its execution row was rewritten in the window the run
 *    that just finished had to read (computed_at after the previous run's start).
 *  - it changes no number: at the end the incrementally-run database equals a fresh replay of its final inputs.
 * Every unexplained difference that does appear is the invisible kind: row not rewritten since, $100 record unchanged.
 */
export async function world(seed: number, pc: PortfolioConfig, n = 30, opts: { onCycle?: (db: Db) => Promise<void> } = {}) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const db = mkDb(); const evs: { at: number; f: () => void }[] = []; let t = START + 60;
  for (let i = 0; i < n; i++) {
    t += 30 + Math.floor(rnd() * 90); const src = t; const ev = src + (rnd() < 0.2 ? 60 + Math.floor(rnd() * 500) : 3 + Math.floor(rnd() * 40));
    const wallet = `w${Math.floor(rnd() * 3)}`, cond = `c${Math.floor(rnd() * 5)}`, tok = `t${Math.floor(rnd() * 12)}`;
    const sig = { id: E(i), kind: ["NEW_POSITION", "NEW_POSITION", "CONVICTION_ADD", "EARLY_ENTRY", "CONSENSUS"][Math.floor(rnd() * 5)], wallet, condition_id: cond, token_id: tok, price: 0.1 + rnd() * 0.8, usd: 50 + rnd() * 3000, created_at: iso(src), evaluated_at: iso(ev), source_fill_id: `0xfill${i}` };
    evs.push({ at: ev, f: () => { db.insertRow("signals", sig); db.insertRow("paper_ledger", { signal_id: sig.id, created_at: iso(ev), sim_terminal: false, side: "LONG" }); } });
    if (rnd() < 0.5) { const xs = src + 30 + Math.floor(rnd() * 20_000), xe = xs + (rnd() < 0.5 ? 4 : 60 + Math.floor(rnd() * 500)); const usd = rnd() < 0.3 ? 10 + rnd() * 30 : 500 + rnd() * 2000; const price = 0.05 + rnd() * 0.9;
      evs.push({ at: xe, f: () => { db.insertRow("signals", { id: X(i), kind: "EXIT", wallet, condition_id: cond, token_id: tok, price, usd, created_at: iso(xs), evaluated_at: iso(xe), source_fill_id: `0xexit${i}` }); db.insertRow("paper_ledger", { signal_id: X(i), created_at: iso(xe), sim_terminal: true, side: "EXIT_EVENT" }); } }); }
    if (rnd() < 0.4) { const rt = src + 600 + Math.floor(rnd() * 20_000); const at = rt + Math.floor(rnd() * 8000); const value = [0, 1, 1, 0.5][Math.floor(unit(tok) * 4)]; evs.push({ at, f: () => { if (!db.T("token_resolutions").some((r) => r.token_id === tok)) db.insertRow("token_resolutions", { token_id: tok, value, resolved_ts: iso(rt) }); } }); }
  }
  addMarkets(db, ["c1", "c2", "c4"]); evs.sort((a, b) => a.at - b.at);
  const end = evs[evs.length - 1].at + 4 * 900; let cur = 0; let unexplained = 0, lost = 0, invisible = 0, cycles = 0; const runStats = { runs: 0, rewinds: 0, rewindSec: 0, rowsRead: 0, writes: 0 }; const notInert: string[] = [];
  const prevStart = (m: ModeName) => { const id = defOf(pc, m).id; const r = db.T("portfolio_runs").find((x) => x.portfolio_id === id); return r?.last_run_started_at ? sec(r.last_run_started_at) : null; };
  for (let ct = START + 900; ct <= end; ct += 900, cycles++) {
    setClock(ct - 1); while (cur < evs.length && evs[cur].at <= ct - 5) evs[cur++].f(); setClock(ct);
    for (const r of db.T("price_observations")) { if (r.state !== "PENDING" || unit(`lag${r.token_id}@${r.as_of}@${cycles}`) < 0.3) continue; const v = unit(`${r.token_id}@${r.as_of}`); Object.assign(r, v < 0.05 ? { state: "UNAVAILABLE" } : { state: "COMPLETE", obs_ts: r.as_of - Math.floor(v * 200), price: 0.05 + ((v * 7919) % 1) * 0.9, resolution_seconds: 0 }); }
    await sweepSimulation(db as never); setClock(ct + 40 + Math.floor(rnd() * 30));
    const before = Object.fromEntries(ALL.map((m) => [m, prevStart(m)])) as Record<ModeName, number | null>;
    for (const st of await run(db, pc)) { runStats.runs++; if (st.rewind.to != null) runStats.rewinds++; runStats.rewindSec += st.rewindDistanceSec; runStats.rowsRead += st.rowsRead; runStats.writes += Object.values(st.writes).reduce((a, b) => a + b, 0); }
    setClock(ct + 300);
    for (const r of await audit(db, pc)) for (const e of r.classes.unexplained.examples) {
      if (e.parts.includes("entry")) continue;                                               // a moved entry is D18, not this
      unexplained++; if (e.effect !== "none") notInert.push(`${r.mode} ${e.signalId} ${e.lot}`);
      const pv = changeDetectionReadsFrom(before[r.mode]); if (pv != null && e.computedAt && sec(e.computedAt) > pv) lost++; else invisible++;   // rewritten inside the window the run had to read (D26: with its margin)
    }
    await opts.onCycle?.(db);
  }
  // D24 (analysis): what the audit sees at the end, and how much of it never opened a lot and differs only in exit / resolution
  const fin = await audit(db, pc); const tot = { mismatches: 0, removable: 0, byClass: { d13: 0, nextRun: 0, unexplained: 0 }, removableByClass: { d13: 0, nextRun: 0, unexplained: 0 }, checked: 0 };
  for (const r of fin) { tot.checked += r.checked; tot.mismatches += r.mismatches; for (const k of ["d13", "nextRun", "unexplained"] as const) { tot.byClass[k] += r.classes[k].count; tot.removableByClass[k] += r.classes[k].inert; tot.removable += r.classes[k].inert; } }
  return { db, unexplained, lost, invisible, notInert, cycles, tot, runStats };
}
