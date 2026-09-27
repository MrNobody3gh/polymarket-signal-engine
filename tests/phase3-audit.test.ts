/**
 * Phase 3 step 9: the read-only D13 fingerprint audit (src/lib/paper/portfolio/audit.ts, scripts/portfolio-audit.ts) and
 * the docs drift check (docs/PORTFOLIO.md must name every environment variable and every outcome / reason in the code).
 *
 * Worlds are built as production builds them: signals, ledger rows, exits, marks, metadata and resolutions go in, the
 * unchanged Phase 2 sweep simulates them into paper_executions, the unchanged runner decides, and then the world is
 * changed the way production changes (a late resolution, a late exit, a backfilled column) before auditing.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { stressDb } from "./helpers/stressDb";
import { pgDb } from "./helpers/pgDb";
import { sweepSimulation } from "@/lib/paper/sim/run";
import type { ModeName, PortfolioConfig } from "@/lib/paper/sim/config";
import { runPortfolios } from "@/lib/paper/portfolio/run";
import { validatePortfolioConfig, portfolioDefinitions, type PortfolioRunConfig } from "@/lib/paper/portfolio/config";
import { auditDecisionInputs, auditPortfolios, auditExitCode, runAuditCli, fingerprintParts, formatAudit, AUDIT_EXIT, type DecisionAudit } from "@/lib/paper/portfolio/audit";

const START = 1_790_000_000; // 2026-09-21T16:53:20Z
const iso = (s: number) => new Date(s * 1000).toISOString();
const sec = (v: string) => Math.floor(Date.parse(v) / 1000);
const pad = (i: number) => String(i).padStart(12, "0");
const E = (i: number) => `00000000-0000-4000-8000-${pad(i)}`, X = (i: number) => `00000000-0000-4000-9000-${pad(i)}`;
const ALL: ModeName[] = ["IDEAL", "REALISTIC", "CONSERVATIVE"];
const ROOT = path.resolve(__dirname, "..");
const PCS: Record<string, PortfolioConfig> = {
  tight: { startingCapitalUsd: 1_500, positionUsd: 100, maxMarketExposureUsd: 300, maxTotalExposurePct: 70, maxOpenPositions: 9, maxWalletAllocationUsd: 350, minCashReserveUsd: 50, allowResize: true },
  roomy: { startingCapitalUsd: 1_000_000, positionUsd: 100, maxMarketExposureUsd: 1_000_000, maxTotalExposurePct: 100, maxOpenPositions: 100_000, maxWalletAllocationUsd: 1_000_000, minCashReserveUsd: 0, allowResize: false },
};

let clock = START;
const setClock = (t: number) => { clock = t; vi.setSystemTime(t * 1000); };
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); setClock(START); });
afterEach(() => { vi.useRealTimers(); });

// ───────────────────────────── database with the 0008 lease functions ─────────────────────────────
type Db = ReturnType<typeof stressDb>;
function mkDb(): Db {
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

// ───────────────────────────── worlds (as in tests/phase3-run.test.ts) ─────────────────────────────
interface World { db: Db; entries: { id: string; src: number; ev: number; token: string; wallet: string; condition: string }[] }
function populate(n: number, seed0 = 7): World {
  const db = mkDb(); let seed = seed0; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const entries: World["entries"] = []; const sigs: Record<string, any>[] = [], led: Record<string, any>[] = [], exits: Record<string, any>[] = [], exitLed: Record<string, any>[] = [];
  let t = START; let prev: Record<string, any> | null = null; let prevEv = 0;
  for (let i = 0; i < n; i++) {
    const dup = !!prev && rnd() < 0.08; let src: number, ev: number;
    if (dup) { src = sec(prev!.created_at); ev = prevEv; } else { t += 60; src = t; ev = src + 3 + Math.floor(rnd() * 40); }
    const kind = dup ? "CONSENSUS" : ["NEW_POSITION", "NEW_POSITION", "CONVICTION_ADD", "EARLY_ENTRY", "CONSENSUS"][Math.floor(rnd() * 5)];
    const s: Record<string, any> = dup ? { ...prev!, id: E(i), kind } : { id: E(i), kind, wallet: `w${Math.floor(rnd() * 6)}`, condition_id: `c${Math.floor(rnd() * 9)}`, token_id: `t${i}`, price: 0.1 + rnd() * 0.8, usd: 50 + rnd() * 3000, created_at: iso(src), evaluated_at: iso(ev), source_fill_id: `0xfill${i}` };
    sigs.push(s); led.push({ signal_id: s.id, created_at: iso(ev), sim_terminal: false, side: "LONG" }); entries.push({ id: s.id, src, ev, token: s.token_id, wallet: s.wallet, condition: s.condition_id });
    if (!dup && rnd() < 0.5) { const xs = src + 30 + Math.floor(rnd() * 20_000); exits.push({ id: X(i), kind: "EXIT", wallet: s.wallet, condition_id: s.condition_id, token_id: s.token_id, price: 0.05 + rnd() * 0.9, usd: rnd() < 0.3 ? 10 + rnd() * 30 : 500 + rnd() * 2000, created_at: iso(xs), evaluated_at: iso(xs + 4), source_fill_id: `0xexit${i}` }); exitLed.push({ signal_id: X(i), created_at: iso(xs + 4), sim_terminal: true, side: "EXIT_EVENT" }); }
    if (!dup && rnd() < 0.4) db.insertRow("token_resolutions", { token_id: s.token_id, value: [0, 1, 1, 0.5][Math.floor(rnd() * 4)], resolved_ts: iso(src + 600 + Math.floor(rnd() * 40_000)) });
    if (rnd() < 0.5) db.insertRow("paper_marks", { signal_id: s.id, horizon: "1h", observed_at: iso(src + 3600), price: rnd() });
    prev = s; prevEv = ev;
  }
  for (const r of [...sigs, ...exits]) db.insertRow("signals", r);
  for (const r of [...led, ...exitLed]) db.insertRow("paper_ledger", r);
  for (let c = 0; c < 9; c++) if (c % 3) db.insertRow("markets", { condition_id: `c${c}`, fees_enabled: true, taker_fee_rate: 0.02, tick_size: 0.01, min_order_shares: 5, meta_fetched_at: iso(START - 86_400) });
  return { db, entries };
}
/** The unchanged Phase 2 sweep, then every price it asked for (a function of token and time only), then the sweep again. */
async function sweep(db: Db) {
  await sweepSimulation(db as never);
  const unit = (k: string) => { let h = 2166136261; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 2 ** 32; };
  let filled = 0;
  for (const r of db.T("price_observations")) { if (r.state !== "PENDING") continue; const v = unit(`${r.token_id}@${r.as_of}`); Object.assign(r, v < 0.05 ? { state: "UNAVAILABLE" } : { state: "COMPLETE", obs_ts: r.as_of - Math.floor(v * 200), price: 0.05 + ((v * 7919) % 1) * 0.9, resolution_seconds: 0 }); filled++; }
  if (filled) await sweepSimulation(db as never);
}
const cfgOf = (pc: PortfolioConfig, start = START): PortfolioRunConfig => validatePortfolioConfig({ ...pc, startTs: iso(start) }, clock);
const envOf = (pc: PortfolioConfig, start = START) => ({ PAPER_PORTFOLIO_CONFIG: JSON.stringify({ ...pc, startTs: iso(start) }) });
const run = (db: Db, pc: PortfolioConfig) => runPortfolios(db as never, { config: cfgOf(pc), modes: ALL, owner: "worker" });
/** A world swept, priced and decided by the real runner, clock moved past the run (so its lease has expired). */
async function decided(n: number, pc: PortfolioConfig, seed = 7) {
  const w = populate(n, seed); await sweep(w.db); setClock(START + 3 * 86_400); await run(w.db, pc); setClock(START + 3 * 86_400 + 900); return w;
}
const audit = (db: Db, pc: PortfolioConfig) => auditPortfolios(db as never, cfgOf(pc));
const mode = (r: DecisionAudit[], m: ModeName) => r.find((x) => x.mode === m)!;
const def = (pc: PortfolioConfig, m: ModeName) => portfolioDefinitions(cfgOf(pc)).find((d) => d.mode === m)!;
const dump = (db: Db) => JSON.stringify(Object.entries(db.tables).filter(([, rows]) => rows.length).sort(([a], [b]) => a.localeCompare(b)));
const decisionsOf = (db: Db, pid: string) => db.T("portfolio_decisions").filter((d) => d.portfolio_id === pid);
const lotOf = (db: Db, pid: string, id: string) => db.T("portfolio_lots").find((l) => l.portfolio_id === pid && l.signal_id === id);
const ledgerOf = (db: Db, id: string) => db.T("paper_ledger").find((l) => l.signal_id === id)!;
const resolved = (db: Db, token: string) => db.T("token_resolutions").some((r) => r.token_id === token);
const hasExit = (db: Db, e: World["entries"][number]) => db.T("signals").some((s) => s.kind === "EXIT" && s.token_id === e.token && s.wallet === e.wallet);
const cli = async (db: Db | null, env: Record<string, string | undefined>) => {
  const lines: string[] = []; let opened = 0;
  const code = await runAuditCli(env, { db: () => { opened++; if (!db) throw new Error("database opened"); return db as never; }, log: (m) => lines.push(m), now: () => clock });
  const text = lines.join("\n"); const json = text.includes("--- JSON ---") ? JSON.parse(text.split("--- JSON ---\n")[1]) : null;
  return { code, text, json, opened };
};

// ───────────────────────────── tests ─────────────────────────────
describe("D13 audit", () => {
  it("fingerprintParts names exactly the parts that differ", () => {
    expect(fingerprintParts("a|b@1|c@2", "a|b@1|c@2")).toEqual([]);
    expect(fingerprintParts("a|b@1|c@2", "z|b@1|c@2")).toEqual(["entry"]);
    expect(fingerprintParts("a|b@1|c@2", "a|b@9|c@2")).toEqual(["exit"]);
    expect(fingerprintParts("a|-@-|-@-", "a|-@-|r@5")).toEqual(["resolution"]);
    expect(fingerprintParts("a|b@1|c@2", "z|y@1|x@3")).toEqual(["entry", "exit", "resolution"]);
    expect(fingerprintParts("a|b@1|c@2", null)).toEqual(["entry"]);
  });

  it("test 1: a world with no changes — every decision in every mode matches, exit 0", async () => {
    const w = await decided(220, PCS.tight);
    const { code, json, text } = await cli(w.db, envOf(PCS.tight));
    expect(code).toBe(AUDIT_EXIT.OK); expect(text).toContain("Result: OK");
    for (const m of ALL) {
      const r = json.portfolios.find((x: DecisionAudit) => x.mode === m) as DecisionAudit; const n = decisionsOf(w.db, r.portfolioId).length;
      expect(n, m).toBeGreaterThan(100);
      expect({ checked: r.checked, matches: r.matches, mismatches: r.mismatches, found: r.found, nothing: r.nothingToAudit, inconclusive: r.inconclusive }).toEqual({ checked: n, matches: n, mismatches: 0, found: true, nothing: false, inconclusive: null });
      expect(r.missing).toEqual({ signal: 0, execution: 0, examples: [] });
      expect(r.watermark).toBe(sec(w.db.T("portfolio_runs").find((x) => x.portfolio_id === r.portfolioId)!.last_watermark_ts));
    }
    expect(mode(json.portfolios, "REALISTIC").batches).toBe(1);
    // paging: the same answer 17 decisions at a time
    const small = await auditDecisionInputs(w.db as never, def(PCS.tight, "REALISTIC"), { batchSize: 17 });
    expect(small.batches).toBeGreaterThan(5); expect(small.matches).toBe(small.checked); expect(small.checked).toBe(mode(json.portfolios, "REALISTIC").checked);
  });

  it("test 2: a late resolution on a sim_terminal record whose lot is closed → the D13 class, with the right earliest time; the runner indeed never re-examines it", async () => {
    const pc = PCS.roomy; const w = await decided(260, pc); const d = def(pc, "REALISTIC");
    // an entry whose $100 record is final in every mode (sim_terminal), whose REALISTIC lot was closed by its exit, and
    // whose token has no resolution yet
    const e = w.entries.find((x) => ledgerOf(w.db, x.id).sim_terminal === true && lotOf(w.db, d.id, x.id)?.state === "EXITED" && !resolved(w.db, x.token))!;
    expect(e).toBeTruthy();
    const opened = sec(lotOf(w.db, d.id, e.id)!.opened_ts); const R = opened + 1234;
    w.db.insertRow("token_resolutions", { token_id: e.token, value: 1, resolved_ts: iso(R) }); // discovered late (D2: at on-chain time)
    const r = mode(await audit(w.db, pc), "REALISTIC");
    expect(r.mismatches).toBe(1); expect(r.classes.d13.count).toBe(1); expect(r.classes.nextRun.count + r.classes.unexplained.count).toBe(0);
    expect(r.classes.d13.earliestTs).toBe(R); expect(r.classes.d13.earliestIso).toBe(iso(R).replace(".000Z", "Z"));
    expect(r.classes.d13.examples[0]).toMatchObject({ signalId: e.id, parts: ["resolution"], lot: "closed", rewindTo: R });
    expect(r.classes.d13.examples[0].why).toMatch(/sim_terminal.*closed.*D13/);
    expect(auditExitCode([r])).toBe(AUDIT_EXIT.OK);                        // accepted by D13: explained
    // D13 is real: another sweep and another run leave it exactly as it was
    setClock(clock + 900); await sweepSimulation(w.db as never); setClock(clock + 60); await run(w.db, pc); setClock(clock + 900);
    const again = mode(await audit(w.db, pc), "REALISTIC");
    expect(again.classes.d13.count).toBe(1); expect(again.classes.d13.earliestTs).toBe(R);
  });

  it("test 3: a late exit on a non-terminal signal → class 'other' with the exit named; it stays 'next run' through the sweep and is gone after the next run", async () => {
    const pc = PCS.tight; const w = await decided(260, pc); const d = def(pc, "REALISTIC");
    // (i) open lot, non-terminal, no exit yet
    const a = w.entries.find((x) => ledgerOf(w.db, x.id).sim_terminal === false && lotOf(w.db, d.id, x.id)?.state === "OPEN" && !hasExit(w.db, x) && !resolved(w.db, x.token))!;
    // (ii) never filled (rejected by a limit), non-terminal, no exit yet
    const b = w.entries.find((x) => x !== a && ledgerOf(w.db, x.id).sim_terminal === false && !lotOf(w.db, d.id, x.id) && decisionsOf(w.db, d.id).find((y) => y.signal_id === x.id)?.outcome === "REJECTED" && !hasExit(w.db, x) && !resolved(w.db, x.token))!;
    expect(a).toBeTruthy(); expect(b).toBeTruthy();
    const addExit = (e: World["entries"][number], k: number) => { const xs = e.src + 500; w.db.insertRow("signals", { id: X(9000 + k), kind: "EXIT", wallet: e.wallet, condition_id: e.condition, token_id: e.token, price: 0.5, usd: 2000, created_at: iso(xs), evaluated_at: iso(xs + 4) }); w.db.insertRow("paper_ledger", { signal_id: X(9000 + k), created_at: iso(xs + 4), sim_terminal: true, side: "EXIT_EVENT" }); };
    addExit(a, 1); addExit(b, 2);
    let r = mode(await audit(w.db, pc), "REALISTIC");
    expect(r.classes.d13.count).toBe(0); expect(r.classes.unexplained.count).toBe(0); expect(r.classes.nextRun.count).toBe(2);
    const ex = new Map(r.classes.nextRun.examples.map((x) => [x.signalId, x]));
    expect(ex.get(a.id)).toMatchObject({ parts: ["exit"], lot: "open" }); expect(ex.get(a.id)!.why).toMatch(/lot is open/);
    expect(ex.get(b.id)).toMatchObject({ parts: ["exit"], lot: "none" }); expect(ex.get(b.id)!.why).toMatch(/sweep will rewrite/);
    expect(ex.get(a.id)!.rewindTo).toBeGreaterThanOrEqual(a.src + 500);        // the exit's own fill time, not the entry's
    expect(auditExitCode([r])).toBe(AUDIT_EXIT.OK);
    expect(formatAudit([r], 0)).toMatch(/\(b\) other — the next run re-examines these anyway: 2/);
    // the sweep rewrites both rows: now change detection will read them
    setClock(clock + 60); await sweep(w.db); setClock(clock + 60);
    r = mode(await audit(w.db, pc), "REALISTIC");
    expect(r.classes.nextRun.count).toBe(2); for (const x of r.classes.nextRun.examples) expect(x.why).toMatch(/rewritten after the last run started/);
    // the next run acts on them: nothing differs any more
    await run(w.db, pc); setClock(clock + 900);
    r = mode(await audit(w.db, pc), "REALISTIC"); expect(r.mismatches).toBe(0); expect(r.matches).toBe(r.checked);
  });

  it("test 4a: an input nothing will re-examine (a backfilled source_fill_id on a decided, never-filled signal) → unexplained, exit 1", async () => {
    const pc = PCS.tight; const w = await decided(220, pc); const d = def(pc, "CONSERVATIVE");
    const e = w.entries.find((x) => !lotOf(w.db, d.id, x.id) && decisionsOf(w.db, d.id).some((y) => y.signal_id === x.id))!;
    w.db.T("signals").find((s) => s.id === e.id)!.source_fill_id = "0xbackfilled";   // the $100 record does not contain it
    const res = await audit(w.db, pc); const r = mode(res, "CONSERVATIVE");
    expect(r.classes.unexplained.count).toBe(1); expect(r.classes.unexplained.examples[0]).toMatchObject({ signalId: e.id, parts: ["entry"], lot: "none" });
    expect(r.classes.unexplained.earliestTs).toBe(sec(decisionsOf(w.db, d.id).find((y) => y.signal_id === e.id)!.event_ts));
    expect(auditExitCode(res)).toBe(AUDIT_EXIT.UNEXPECTED);
    const { code, text } = await cli(w.db, envOf(pc)); expect(code).toBe(1); expect(text).toContain("UNEXPLAINED"); expect(text).toContain("Result: STOP");
  });

  it("an entry whose fill time moved later (an evaluation-time correction) is unexplained, not 'next run': the runner keeps the old lot", async () => {
    const pc = PCS.tight; const w = await decided(200, pc, 21); const d = def(pc, "REALISTIC");
    const lot = w.db.T("portfolio_lots").find((l) => l.portfolio_id === d.id && l.state === "OPEN" && ledgerOf(w.db, l.signal_id).sim_terminal === false && sec(l.opened_ts) < START + 90 * 60)!;
    const e = w.entries.find((x) => x.id === lot.signal_id)!; const s = w.db.T("signals").find((x) => x.id === e.id)!; s.evaluated_at = iso(e.ev + 3 * 3600);
    setClock(clock + 60); await sweep(w.db);
    // stressDb updates rows in place; re-insert the rewritten execution rows so the stream sees their new fill time, as Postgres would
    for (const x of w.db.T("paper_executions").filter((r) => r.signal_id === e.id).map((r) => ({ ...r }))) { await (w.db.from("paper_executions").delete().eq("signal_id", x.signal_id).eq("mode", x.mode) as any); w.db.insertRow("paper_executions", x); }
    const before = mode(await audit(w.db, pc), "REALISTIC");
    const ex = before.classes.unexplained.examples.find((x) => x.signalId === e.id)!;
    expect(ex).toMatchObject({ parts: ["entry"], lot: "open", rewindTo: sec(lot.opened_ts) }); expect(ex.why).toMatch(/entry fill time moved/);
    expect(auditExitCode([before])).toBe(AUDIT_EXIT.UNEXPECTED);
    // why it is not 'next run': after the next run the old lot is still open at the old time, next to a duplicate rejection
    setClock(clock + 60); await run(w.db, pc);
    expect(lotOf(w.db, d.id, e.id)).toMatchObject({ state: "OPEN", opened_ts: lot.opened_ts });
    expect(decisionsOf(w.db, d.id).find((x) => x.signal_id === e.id)).toMatchObject({ outcome: "REJECTED", reason: "REJECTED_DUPLICATE_POSITION" });
  });

  it("test 4b: decisions whose execution row or signal no longer exists are counted and give a non-zero exit", async () => {
    const pc = PCS.tight; const w = await decided(200, pc); const d = def(pc, "IDEAL");
    const [d1, d2] = decisionsOf(w.db, d.id).slice(3, 5).map((x) => x.signal_id);
    const ex = w.db.T("paper_executions").find((x) => x.signal_id === d1 && x.mode === "IDEAL")!;
    await (w.db.from("paper_executions").delete().eq("signal_id", ex.signal_id).eq("mode", "IDEAL") as any);
    await (w.db.from("signals").delete().eq("id", d2) as any);
    const res = await audit(w.db, pc); const r = mode(res, "IDEAL");
    expect({ signal: r.missing.signal, execution: r.missing.execution }).toEqual({ signal: 1, execution: 1 });
    expect(r.missing.examples.map((x) => [x.signalId, x.missing]).sort()).toEqual([[d1, "execution"], [d2, "signal"]].sort());
    expect(r.checked).toBe(r.matches + r.mismatches + 2);
    expect(auditExitCode(res)).toBe(AUDIT_EXIT.UNEXPECTED);
    const { code, text } = await cli(w.db, envOf(pc)); expect(code).toBe(1); expect(text).toMatch(/MISSING: 1 decision\(s\) whose signal no longer exists/); expect(text).toMatch(/MISSING: 1 decision\(s\) whose IDEAL execution row/);
  });

  it("test 5: strictly read-only — a database that throws on every write method and every RPC is never tripped, and nothing changes", async () => {
    const pc = PCS.tight; const w = await decided(240, pc);
    // make every class non-empty first (a late resolution, a late exit, a backfill, a missing row)
    const d = def(pc, "REALISTIC");
    const t = w.entries.find((x) => ledgerOf(w.db, x.id).sim_terminal === true && !resolved(w.db, x.token) && decisionsOf(w.db, d.id).some((y) => y.signal_id === x.id) && !["OPEN", "PARTIALLY_EXITED"].includes(lotOf(w.db, d.id, x.id)?.state))!;
    w.db.insertRow("token_resolutions", { token_id: t.token, value: 0, resolved_ts: iso(t.src + 99_999) });
    const o = w.entries.find((x) => lotOf(w.db, d.id, x.id)?.state === "OPEN" && !hasExit(w.db, x))!;
    w.db.insertRow("signals", { id: X(7777), kind: "EXIT", wallet: o.wallet, condition_id: o.condition, token_id: o.token, price: 0.4, usd: 900, created_at: iso(o.src + 700), evaluated_at: iso(o.src + 704) });
    const u = w.entries.find((x) => x !== t && x !== o && !lotOf(w.db, d.id, x.id) && decisionsOf(w.db, d.id).some((y) => y.signal_id === x.id) && ledgerOf(w.db, x.id).sim_terminal === false)!;
    w.db.T("signals").find((s) => s.id === u.id)!.source_fill_id = "0xlater";
    const before = dump(w.db); const writes = JSON.stringify(w.db.stats.writes) + JSON.stringify(w.db.stats.deletes);
    const calls: string[] = [];
    const spy = {
      rpc: (name: string) => { calls.push(`rpc:${name}`); throw new Error(`write-capable RPC ${name} called`); },
      from: (table: string) => {
        const inner = w.db.from(table);
        return new Proxy(inner, { get(target, prop, recv) {
          if (["insert", "upsert", "update", "delete"].includes(String(prop))) return () => { calls.push(`${String(prop)}:${table}`); throw new Error(`write ${String(prop)} on ${table}`); };
          const v = Reflect.get(target, prop, recv); return typeof v === "function" ? v.bind(target) : v;
        } });
      },
    };
    const res = await auditPortfolios(spy as never, cfgOf(pc));
    expect(calls).toEqual([]);
    const r = mode(res, "REALISTIC"); expect(r.classes.d13.count).toBeGreaterThanOrEqual(1); expect(r.classes.nextRun.count).toBeGreaterThanOrEqual(1); expect(r.classes.unexplained.count).toBeGreaterThanOrEqual(1);
    expect(dump(w.db)).toBe(before); expect(JSON.stringify(w.db.stats.writes) + JSON.stringify(w.db.stats.deletes)).toBe(writes);
    // and through the CLI, with the same spy
    const lines: string[] = []; const code = await runAuditCli(envOf(pc), { db: () => spy as never, log: (m) => lines.push(m), now: () => clock });
    expect(code).toBe(AUDIT_EXIT.UNEXPECTED); expect(calls).toEqual([]); expect(dump(w.db)).toBe(before);
  });

  it("test 6: bounded — 20,000 decisions: pages of at most 500, no query returns more than one page", async () => {
    const db = mkDb(); const N = 20_000; let t = START;
    let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < N; i++) {
      if (rnd() < 0.8) t += 4; const id = E(i);
      db.insertRow("signals", { id, kind: ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"][i % 4], wallet: `w${i % 50}`, condition_id: `c${i % 300}`, token_id: `t${i}`, price: 0.2 + rnd() * 0.6, usd: 1000, created_at: iso(t), evaluated_at: iso(t + 2), source_fill_id: `f${i}` });
      db.insertRow("paper_ledger", { signal_id: id, created_at: iso(t + 2), sim_terminal: true, side: "LONG" });
      db.insertRow("paper_executions", { signal_id: id, mode: "IDEAL", fill_ts: iso(t), computed_at: iso(START), state: "OPEN", coverage_state: "SIMULATED", record_hash: "x" });
      if (i % 3 === 0) db.insertRow("token_resolutions", { token_id: `t${i}`, value: i % 2, resolved_ts: iso(t + 600) });
    }
    setClock(t + 3600); const cfg = cfgOf(PCS.roomy);
    await runPortfolios(db as never, { config: cfg, modes: ["IDEAL"], owner: "t" }); setClock(t + 7200);
    const d = portfolioDefinitions(cfg, ["IDEAL"])[0]; expect(decisionsOf(db, d.id).length).toBe(N);
    db.stats.maxRowsPerCall = 0; const heap0 = process.memoryUsage().heapUsed;
    const r = await auditDecisionInputs(db as never, d, { batchSize: 5_000 });              // asks for more: capped at 500
    expect(r.checked).toBe(N); expect(r.matches).toBe(N); expect(r.batches).toBe(N / 500); expect(r.maxBatchRows).toBe(500);
    expect(db.stats.maxRowsPerCall).toBeLessThanOrEqual(500);
    expect((process.memoryUsage().heapUsed - heap0) / 1048576).toBeLessThan(200);
    // 30 stale input hashes on closed (resolved) lots: all counted, at most 20 examples kept
    const closed = db.T("portfolio_lots").filter((l) => l.portfolio_id === d.id && l.state === "RESOLVED").slice(0, 30).map((l) => l.signal_id);
    for (const id of closed) decisionsOf(db, d.id).find((x) => x.signal_id === id)!.input_hash = "stale|-@-|-@-";
    const r2 = await auditDecisionInputs(db as never, d);
    expect(r2.classes.d13.count).toBe(30); expect(r2.classes.d13.examples).toHaveLength(20); expect(r2.matches).toBe(N - 30);
  }, 240_000);

  it("test 7: no decisions yet → 'nothing to audit', exit 0 (never run · only dry runs · a portfolio with nothing decided)", async () => {
    const w = populate(80); await sweep(w.db); setClock(START + 86_400);
    let c = await cli(w.db, envOf(PCS.tight));                                  // the feature has never run
    expect(c.code).toBe(0); expect(c.text).toContain("nothing to audit: this portfolio has never run for real");
    for (const r of c.json.portfolios) expect(r).toMatchObject({ found: false, nothingToAudit: true, checked: 0 });
    await runPortfolios(w.db as never, { config: cfgOf(PCS.tight), modes: ALL, dryRun: true });      // a dry run writes nothing
    c = await cli(w.db, { ...envOf(PCS.tight), PAPER_PORTFOLIO_DRY_RUN: "1" });
    expect(c.code).toBe(0); expect(c.text).toContain("a dry run writes no decisions"); expect(c.json.portfolios.every((r: DecisionAudit) => r.nothingToAudit)).toBe(true);
    const late = START + 40_000;                                                 // starts after every signal: a real run decides nothing
    await runPortfolios(w.db as never, { config: cfgOf(PCS.tight, late), modes: ALL, owner: "w" }); setClock(clock + 900);
    c = await cli(w.db, envOf(PCS.tight, late));
    expect(c.code).toBe(0); expect(c.text).toContain("nothing to audit: this portfolio has no decisions yet");
    for (const r of c.json.portfolios) expect(r).toMatchObject({ found: true, nothingToAudit: true, checked: 0 });
  });

  it("test 8: unset or invalid configuration → says so, exit 2, the database is never opened", async () => {
    for (const env of [{}, { PAPER_PORTFOLIO_CONFIG: "" }, { PAPER_PORTFOLIO_CONFIG: "{not json" }, { PAPER_PORTFOLIO_CONFIG: JSON.stringify({ ...PCS.tight }) }, { PAPER_PORTFOLIO_CONFIG: JSON.stringify({ ...PCS.tight, startTs: iso(START), maxOpenPosition: 3 }) }]) {
      const c = await cli(null, env);
      expect(c.code, JSON.stringify(env)).toBe(AUDIT_EXIT.CONFIG); expect(c.opened).toBe(0); expect(c.text).toMatch(/is not set|invalid configuration/); expect(c.text).toContain("Nothing was read");
    }
  });

  it("test 8 (script): `npm run portfolio:audit` with the configuration unset or invalid exits 2 before any database access", () => {
    const bin = path.join(ROOT, "node_modules/.bin/tsx"); const base: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const unset = spawnSync(bin, ["scripts/portfolio-audit.ts"], { cwd: ROOT, env: base, encoding: "utf8", timeout: 60_000 });
    expect(unset.status).toBe(2); expect(unset.stdout).toContain("PAPER_PORTFOLIO_CONFIG is not set"); expect(unset.stderr).not.toContain("SUPABASE");
    const bad = spawnSync(bin, ["scripts/portfolio-audit.ts"], { cwd: ROOT, env: { ...base, PAPER_PORTFOLIO_CONFIG: '{"positionUsd":100}' }, encoding: "utf8", timeout: 60_000 });
    expect(bad.status).toBe(2); expect(bad.stdout).toMatch(/invalid configuration — PAPER_PORTFOLIO_CONFIG: missing/);
    expect(JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts["portfolio:audit"]).toBe("tsx scripts/portfolio-audit.ts");
  }, 120_000);

  it("a run in progress (lease held) makes the audit inconclusive: exit 3", async () => {
    const pc = PCS.tight; const w = await decided(120, pc); const d = def(pc, "IDEAL");
    const runRow = w.db.T("portfolio_runs").find((r) => r.portfolio_id === d.id)!; runRow.lease_owner = "worker"; runRow.lease_until = iso(clock + 600);
    const res = await audit(w.db, pc); expect(mode(res, "IDEAL").inconclusive).toMatch(/holds the lease/); expect(mode(res, "REALISTIC").inconclusive).toBeNull();
    expect(auditExitCode(res)).toBe(AUDIT_EXIT.INCONCLUSIVE);
    runRow.lease_until = iso(clock - 1); expect(auditExitCode(await audit(w.db, pc))).toBe(AUDIT_EXIT.OK);
  });

  it("after a run that did not finish, decisions past its watermark are 'next run' (they are replayed)", async () => {
    const pc = PCS.tight; const w = populate(200); await sweep(w.db); setClock(START + 3 * 86_400);
    await runPortfolios(w.db as never, { config: cfgOf(pc), modes: ["IDEAL"], owner: "w", maxBatches: 1, batchSize: 60 }); setClock(clock + 900);
    let n = 0; await expect(runPortfolios(w.db as never, { config: cfgOf(pc), modes: ["IDEAL"], owner: "w", batchSize: 60, fault: (s) => { if (s === "afterOutputs" && ++n === 2) throw new Error("killed"); } })).rejects.toThrow("killed");
    setClock(clock + 900); const d = def(pc, "IDEAL"); const W0 = sec(w.db.T("portfolio_runs").find((r) => r.portfolio_id === d.id)!.last_watermark_ts);
    // a late resolution on a decision the dead run wrote after its recorded watermark
    const dd = decisionsOf(w.db, d.id).filter((x) => sec(x.event_ts) > W0).map((x) => w.entries.find((e) => e.id === x.signal_id)!).find((e) => !resolved(w.db, e.token) && !["OPEN", "PARTIALLY_EXITED"].includes(lotOf(w.db, d.id, e.id)?.state))!;
    expect(dd).toBeTruthy(); w.db.insertRow("token_resolutions", { token_id: dd.token, value: 1, resolved_ts: iso(dd.src + 50_000) });
    const r = await auditDecisionInputs(w.db as never, d);
    expect(r.previousRunFinished).toBe(false); expect(r.classes.nextRun.examples.find((x) => x.signalId === dd.id)?.why).toMatch(/did not finish/);
  });
});

// ───────────────────────────── test 9: the docs cannot silently drift from the code ─────────────────────────────
describe("docs/PORTFOLIO.md names everything the code can emit or read", () => {
  const doc = readFileSync(path.join(ROOT, "docs/PORTFOLIO.md"), "utf8");
  const src = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
  const portfolioFiles = readdirSync(path.join(ROOT, "src/lib/paper/portfolio")).filter((f) => f.endsWith(".ts")).map((f) => `src/lib/paper/portfolio/${f}`);
  it("every environment variable read by the portfolio code, its audit script and the settings it depends on", () => {
    const files = [...portfolioFiles, "scripts/portfolio-audit.ts", "src/lib/db.ts", "src/lib/paper/sim/config.ts"];
    const vars = new Set<string>();
    for (const f of files) for (const m of src(f).matchAll(/(?:process\.)?env(?:\?)?\.([A-Z][A-Z0-9_]{2,})|env\[["']([A-Z][A-Z0-9_]{2,})["']\]/g)) vars.add(m[1] ?? m[2]);
    expect([...vars]).toEqual(expect.arrayContaining(["PAPER_PORTFOLIO_CONFIG", "PAPER_PORTFOLIO_DRY_RUN", "PAPER_SIZE_USD", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]));
    for (const v of vars) expect(doc, `docs/PORTFOLIO.md does not mention ${v}`).toContain(`\`${v}\``);
  });
  it("every configuration field, with its validation rule stated", () => {
    const fields = [...src("src/lib/paper/portfolio/config.ts").match(/const FIELDS[^=]*= \[([^\]]+)\]/)![1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(fields.length).toBe(8);
    for (const f of [...fields, "startTs"]) expect(doc, f).toMatch(new RegExp(`\\|\\s*\`${f}\``));
  });
  it("every outcome, every REJECTED_* reason, every execution reason a decision can carry, and the RESIZED: prefix", () => {
    const outcomes = [...src("src/lib/paper/sim/portfolio.ts").match(/export type PortfolioOutcome = ([^;]+);/)![1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    const rejected = new Set<string>(); for (const f of ["src/lib/paper/sim/portfolio.ts", ...portfolioFiles]) for (const m of src(f).matchAll(/"(REJECTED_[A-Z_]+)"/g)) rejected.add(m[1]);
    const execReasons = new Set<string>(); for (const m of src("src/lib/paper/sim/execute.ts").matchAll(/(?:reason: |empty\("[A-Z]+", |none\("[A-Z]+", )"([A-Z_]{3,})"/g)) execReasons.add(m[1]);
    expect(outcomes).toEqual(["FILLED", "PARTIALLY_FILLED", "UNFILLED", "EXPIRED", "INVALID", "UNKNOWN", "REJECTED"]);
    expect(rejected.size).toBe(7); expect(execReasons.size).toBeGreaterThanOrEqual(12);
    // each one has its own row in the §4 tables (not just a mention somewhere)
    for (const k of [...outcomes, ...rejected, ...execReasons]) expect(doc, `docs/PORTFOLIO.md §4 has no row for ${k}`).toMatch(new RegExp(`^\\| \`${k}\` \\|`, "m"));
    expect(doc).toContain("`RESIZED:");
  });
  it("the log lines and dashboard messages the runbook and troubleshooting table quote exist in the code", () => {
    const code = [...portfolioFiles, "worker/ws-listener.ts", "src/lib/health/memory.ts"].map(src).join("\n");
    for (const s of ["portfolio: off (PAPER_PORTFOLIO_CONFIG unset)", "portfolio: off (invalid configuration)", "(dry run: nothing written)", "dry run: nothing written; snapshot and heartbeat not saved", "skipped (lease held by another runner)", "every mode failed", "FAILED this cycle", "the last run for this mode did not finish", "rewinds in last 20 runs", "queued ", "has not been refreshed for", "no run has finished yet"])
      { expect(code, s).toContain(s); expect(doc, s).toContain(s); }
  });
  it("the worked example is valid once startTs is filled in, and refused as printed (so an unedited copy cannot start a portfolio)", () => {
    const block = doc.match(/```json\n([^`]+)```/)![1]; const ex = JSON.parse(block);
    expect(() => validatePortfolioConfig(ex, START)).toThrow(/startTs must be an ISO timestamp/);
    const ok = validatePortfolioConfig({ ...ex, startTs: "2026-09-27T04:26:41Z" }, Date.parse("2026-09-28T00:00:00Z") / 1000);
    expect(ok.startIso).toBe("2026-09-27T04:26:41.000Z");
    expect(doc).toContain("example values, not a recommendation");
  });
  it("README, PAPER_EXECUTION and DEPLOY link to it", () => {
    expect(src("README.md")).toContain("](docs/PORTFOLIO.md)"); expect(src("docs/PAPER_EXECUTION.md")).toContain("](PORTFOLIO.md)");
    expect(src("DEPLOY.md")).toMatch(/docs\/PORTFOLIO\.md` §8/);                                   // the switch-on runbook itself
    expect(src("DEPLOY.md")).toContain("PAPER_PORTFOLIO_CONFIG"); expect(src("DEPLOY.md")).toContain("PAPER_PORTFOLIO_DRY_RUN");
  });
});

// ───────────────────────────── real Postgres: the same audit over the real schema ─────────────────────────────
const PGURL = process.env.PG_TEST_URL; const dpg = PGURL ? describe : describe.skip;
dpg("D13 audit against real Postgres (all migrations, own database)", () => {
  const name = `step9_${process.pid}_${Date.now()}`; let url = "";
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: PGURL }); await admin.connect(); await admin.query(`create database ${name}`); await admin.end();
    const u = new URL(PGURL!); u.pathname = `/${name}`; url = u.toString();
    const c = new pg.Client({ connectionString: url }); await c.connect();
    try { for (const f of readdirSync(path.join(ROOT, "supabase/migrations")).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) await c.query(readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8")); } finally { await c.end(); }
  }, 120_000);
  afterAll(async () => { const admin = new pg.Client({ connectionString: PGURL }); await admin.connect(); await admin.query(`drop database if exists ${name} with (force)`); await admin.end(); });

  it("a world decided in memory and loaded into the real tables audits identically; a late resolution lands in D13 in both", async () => {
    const pc = PCS.roomy; const w = await decided(150, pc, 23);
    const c = new pg.Client({ connectionString: url }); await c.connect();
    try {
      const ins = async (table: string, rows: Record<string, any>[]) => { for (const r of rows) { const k = Object.keys(r); await c.query(`insert into ${table} (${k.join(",")}) values (${k.map((_, i) => `$${i + 1}`).join(",")})`, k.map((x) => (r[x] !== null && typeof r[x] === "object" ? JSON.stringify(r[x]) : r[x]))); } };
      const sigs = w.db.T("signals");
      await ins("signals", sigs.map((s) => ({ id: s.id, kind: s.kind, severity: 3, wallet: s.wallet, condition_id: s.condition_id, token_id: s.token_id, price: s.price, usd: s.usd, dedupe_key: `a9:${s.id}`, created_at: s.created_at, evaluated_at: s.evaluated_at ?? null, source_fill_id: s.source_fill_id ?? null })));
      const price = new Map(sigs.map((s) => [s.id, s.price]));
      await ins("paper_ledger", w.db.T("paper_ledger").map((l) => ({ signal_id: l.signal_id, entry_price: price.get(l.signal_id), created_at: l.created_at, sim_terminal: l.sim_terminal, side: l.side })));
      await ins("paper_marks", w.db.T("paper_marks").map((m) => ({ ...m, pnl: 0, return_pct: 0, source: "prices-history" })));
      await ins("markets", w.db.T("markets").map((m) => ({ condition_id: m.condition_id, fees_enabled: m.fees_enabled, taker_fee_rate: m.taker_fee_rate, tick_size: m.tick_size, min_order_shares: m.min_order_shares, meta_fetched_at: m.meta_fetched_at })));
      await ins("price_observations", w.db.T("price_observations").map((r) => ({ token_id: r.token_id, as_of: r.as_of, state: r.state, obs_ts: r.obs_ts ?? null, price: r.price ?? null, resolution_seconds: r.resolution_seconds ?? null })));
      // resolutions: the view unions token_resolution_obs (D3), which is where the in-memory table's rows go
      await ins("token_resolution_obs", w.db.T("token_resolutions").map((r) => ({ token_id: r.token_id, condition_id: "c", value: r.value, resolved_ts: r.resolved_ts, source: "test" })));
      await ins("paper_executions", w.db.T("paper_executions"));
      for (const t of ["portfolios", "portfolio_runs", "portfolio_decisions", "portfolio_lots"]) await ins(t, w.db.T(t));
      const real = () => auditPortfolios(pgDb(c) as never, cfgOf(pc), { now: () => clock });
      const strip = (rs: DecisionAudit[]) => rs.map(({ durationMs: _d, ...r }) => r);
      const mem = await audit(w.db, pc); const sql = await real();
      expect(strip(sql)).toEqual(strip(mem));
      for (const r of sql) { expect(r.checked, r.mode).toBeGreaterThan(100); expect(r.matches).toBe(r.checked); }
      // the D13 case, through the real token_resolutions view
      const d = def(pc, "REALISTIC");
      const e = w.entries.find((x) => w.db.T("paper_ledger").find((l) => l.signal_id === x.id)!.sim_terminal === true && lotOf(w.db, d.id, x.id)?.state === "EXITED" && !resolved(w.db, x.token))!;
      const R = sec(lotOf(w.db, d.id, e.id)!.opened_ts) + 777;
      w.db.insertRow("token_resolutions", { token_id: e.token, value: 1, resolved_ts: iso(R) });
      await ins("token_resolution_obs", [{ token_id: e.token, condition_id: e.condition, value: 1, resolved_ts: iso(R), source: "test" }]);
      const after = await real(); expect(strip(after)).toEqual(strip(await audit(w.db, pc)));
      expect(mode(after, "REALISTIC").classes.d13).toMatchObject({ count: 1, earliestTs: R }); expect(auditExitCode(after)).toBe(0);
    } finally { await c.end(); }
  }, 180_000);
});
