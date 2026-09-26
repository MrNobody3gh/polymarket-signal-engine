/**
 * Database-side logic against a REAL Postgres (all migrations applied). Skipped unless PG_TEST_URL is set:
 *   PG_TEST_URL=postgres://postgres@localhost:55432/t npx vitest run tests/sql.test.ts
 * Parity tests assert the SQL reports equal the (already-tested) JS implementations on the same random data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { MODES } from "@/lib/paper/sim/config";
import { simulateMode, buildSignals, recordHash, type SimInputs } from "@/lib/paper/sim/run";
import { execReport } from "@/lib/paper/sim/report";
import { computeStats, byKind, type PaperRowLite, type MarkLite } from "@/lib/paper/analytics";

const URL = process.env.PG_TEST_URL; const d = URL ? describe : describe.skip;
let c: pg.Client; let c2: pg.Client;
const T0 = 1_790_000_000;
const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

d("SQL (real Postgres)", () => {
  beforeAll(async () => { c = new pg.Client({ connectionString: URL }); c2 = new pg.Client({ connectionString: URL }); await c.connect(); await c2.connect();
    await c.query("truncate paper_executions, paper_marks, paper_ledger, price_observations, signals cascade"); });
  afterAll(async () => { await c?.end(); await c2?.end(); });

  it("claim_price_backlog: claims pending, never double-claims concurrently, reclaims abandoned work, honours back-off", async () => {
    for (let i = 0; i < 50; i++) await c.query("insert into price_observations (token_id, as_of) values ($1, $2)", [`t${i}`, T0 + i]);
    const [a, b] = await Promise.all([c.query("select * from claim_price_backlog(30)"), c2.query("select * from claim_price_backlog(30)")]);
    const ids = [...a.rows, ...b.rows].map((r) => `${r.token_id}@${r.as_of}`); expect(ids).toHaveLength(50); expect(new Set(ids).size).toBe(50);
    expect((await c.query("select * from claim_price_backlog(10)")).rows).toHaveLength(0); // all PROCESSING, none stale
    await c.query("update price_observations set processing_started_at = now() - interval '11 minutes' where token_id = 't0'");
    await c.query("update price_observations set state = 'FAILED', next_attempt_at = now() + interval '5 minutes' where token_id = 't1'");
    await c.query("update price_observations set state = 'FAILED', next_attempt_at = now() - interval '1 minute' where token_id = 't2'");
    await c.query("update price_observations set state = 'FAILED', next_attempt_at = null where token_id = 't3'"); // final failure
    const again = (await c.query("select token_id from claim_price_backlog(10) order by token_id")).rows.map((r) => r.token_id); expect(again).toEqual(["t0", "t2"]);
    await expect(c.query("update price_observations set state = 'BOGUS' where token_id = 't4'")).rejects.toThrow(/state_chk/);
  });

  it("paper_exec_stats equals the JS report on the same simulated records", async () => {
    const signals: Record<string, any>[] = []; const obs = new Map(); const resolutions = new Map(); const marks = new Map();
    for (let i = 1; i <= 400; i++) {
      const id = uid(i); const tok = `k${i % 37}`; const src = T0 + i * 60; const ev = src + 30 + Math.floor(rnd() * 600);
      signals.push({ id, kind: ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD"][i % 3], wallet: `w${i % 9}`, condition_id: `c${tok}`, token_id: tok, price: 0.1 + rnd() * 0.8, usd: 20 + rnd() * 2000, created_at: new Date(src * 1000).toISOString(), evaluated_at: i % 5 ? new Date(ev * 1000).toISOString() : null });
      for (const cfg of [MODES.REALISTIC]) { const fill = (i % 5 ? ev : src + cfg.assumedDetectionLatencySec) + cfg.decisionLatencySec + cfg.executionLatencySec; if (i % 11) obs.set(`${tok}@${fill}`, i % 13 ? { ts: fill - 5, price: Math.min(0.97, Math.max(0.03, 0.1 + rnd() * 0.8)), resolutionSeconds: 0 } : null); }
      if (i % 2) resolutions.set(tok, { ts: T0 + 400 * 60 + (i % 37) * 97, value: i % 4 < 2 ? 1 : 0 }); else if (i % 3) marks.set(id, { ts: src + 3600, price: 0.2 + rnd() * 0.6 });
    }
    const inp: SimInputs = { signals, ledger: new Map(), marks, resolutions, markets: new Map(), obs };
    const out = simulateMode(buildSignals(inp), inp, MODES.REALISTIC);
    for (const s of signals) await c.query("insert into signals (id, kind, severity, wallet, condition_id, token_id, dedupe_key, created_at) values ($1,$2,2,$3,$4,$5,$6,$7)", [s.id, s.kind, s.wallet, s.condition_id, s.token_id, "k" + s.id, s.created_at]);
    for (const r of out.records) { const row: Record<string, any> = { ...r, record_hash: recordHash(r) }; const cols = Object.keys(row); await c.query(`insert into paper_executions (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")})`, cols.map((k) => row[k])); }
    const sql = (await c.query("select paper_exec_stats('REALISTIC') s")).rows[0].s; const js = execReport(out.rows);
    expect(sql.total).toBe(400); expect(sql.coverage.PENDING_DATA).toBe(out.pending); expect(sql.coverage.SIMULATED).toBe(js.filled + js.partial);
    for (const [a, b] of [[sql.netPnl, js.netPnl], [sql.grossPnl, js.grossPnl], [sql.fees, js.fees], [sql.slippageCost, js.slippageCost], [sql.latencyCost, js.latencyCost], [sql.unrealizedPnl, js.unrealizedPnl],
      [sql.winRate, js.winRate], [sql.medianReturn, js.medReturn], [sql.avgReturn, js.avgReturn], [sql.maxDrawdown, js.maxDrawdown], [sql.endingEquity, js.endingEquity], [sql.entrySlipTicks.median, js.medEntrySlipTicks],
      [sql.robustness.exBest1, js.robustness.exBest1], [sql.robustness.exBest5, js.robustness.exBest5], [sql.robustness.exBest10, js.robustness.exBest10], [sql.robustness.profitFactor, js.robustness.profitFactor], [sql.robustness.expectancy, js.robustness.expectancy]] as [number | null, number | null][])
      if (b == null) expect(a).toBeNull(); else expect(Number(a)).toBeCloseTo(b, 6);
    expect(sql.settled).toBe(js.settled); expect(sql.latency.estimated).toBeGreaterThan(0); expect(sql.latency.observed).toBeGreaterThan(0);
  });

  it("paper_group_stats equals the JS computeStats (overall and by kind)", async () => {
    await c.query("truncate paper_marks, paper_ledger");
    const rows: PaperRowLite[] = []; const marks: MarkLite[] = []; const statuses = ["OPEN", "OPEN", "RESOLVED_WIN", "RESOLVED_LOSS", "EXITED", "INVALID", "EXIT_EVENT"] as const;
    for (let i = 1; i <= 300; i++) {
      const st = statuses[i % statuses.length]; const settled = st === "RESOLVED_WIN" || st === "RESOLVED_LOSS" || st === "EXITED"; const ret = settled ? (st === "RESOLVED_LOSS" ? -1 : rnd() * 2 - 0.5) : null;
      const r: PaperRowLite = { signal_id: uid(i), wallet: `w${i % 5}`, wallet_name: `n${i % 5}`, kind: ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EXIT"][st === "EXIT_EVENT" ? 3 : i % 3], token_id: `k${i % 7}`, title: `m${i}`, outcome: "Yes", signal_ts: new Date((T0 + i * 60) * 1000).toISOString(), entry_price: 0.4, shares: 250, size_usd: 100, copy_score: i % 4 ? 30 + (i % 70) : null, consensus_depth: i % 3 === 1 ? 2 + (i % 5) : null, status: st as never, final_pnl: ret == null ? null : ret * 100, final_return: ret };
      rows.push(r);
      await c.query("insert into paper_ledger (signal_id, wallet, wallet_name, kind, token_id, title, outcome, signal_ts, entry_price, shares, size_usd, copy_score, consensus_depth, status, final_pnl, final_return, side) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
        [r.signal_id, r.wallet, r.wallet_name, r.kind, r.token_id, r.title, r.outcome, r.signal_ts, r.entry_price, r.shares, r.size_usd, r.copy_score, r.consensus_depth, r.status, r.final_pnl, r.final_return, st === "EXIT_EVENT" ? "EXIT_EVENT" : "LONG"]);
      if (st === "OPEN" && i % 2) for (const [h, k] of [["1h", 1], ["6h", 6]] as const) { const m = { signal_id: r.signal_id, horizon: h, observed_at: new Date((T0 + i * 60 + k * 3600) * 1000).toISOString(), price: 0.45, pnl: 12.5 * k, return_pct: 0.125 * k }; marks.push(m); await c.query("insert into paper_marks (signal_id, horizon, observed_at, price, pnl, return_pct, source) values ($1,$2,$3,$4,$5,$6,'t')", [m.signal_id, m.horizon, m.observed_at, m.price, m.pnl, m.return_pct]); }
    }
    const js = computeStats(rows, marks); const sql = (await c.query("select paper_group_stats(null, 'all') s")).rows[0].s[0].stats;
    for (const k of ["signals", "open", "resolved", "exited", "invalid", "observed"] as const) expect(sql[k]).toBe(js[k]);
    for (const k of ["pnl", "avgReturn", "medianReturn", "winRate", "lossRate", "avgWin", "avgLoss"] as const) { if (js[k] == null) expect(sql[k]).toBeNull(); else expect(Number(sql[k])).toBeCloseTo(js[k] as number, 6); }
    expect(sql.best.id).toBe(js.best!.id); expect(sql.worst.id).toBe(js.worst!.id); expect(sql.insufficient).toBe(js.insufficient);
    const sqlKinds = (await c.query("select paper_group_stats(null, 'kind') s")).rows[0].s as { key: string; stats: any }[];
    for (const k of byKind(rows, marks).filter((x) => x.stats.signals > 0)) { const s = sqlKinds.find((x) => x.key === k.key)!; /* JS also lists an empty EXIT group; SQL omits empty groups */ expect(s.stats.signals).toBe(k.stats.signals); expect(Number(s.stats.pnl)).toBeCloseTo(k.stats.pnl, 6); }
  });

  it("data_quality_report counts every category and reports simulation coverage per mode", async () => {
    const dq = (await c.query("select data_quality_report() r")).rows[0].r;
    expect(dq.signals).toBe(400); expect(dq.simulation.REALISTIC.PENDING_DATA + dq.simulation.REALISTIC.SIMULATED + (dq.simulation.REALISTIC.UNAVAILABLE_DATA ?? 0) + (dq.simulation.REALISTIC.INVALID ?? 0) + (dq.simulation.REALISTIC.UNFILLED ?? 0)).toBe(400);
    expect(dq.prices).toHaveProperty("PROCESSING"); expect(dq.marks["1h"]).toBeGreaterThan(0); expect(dq).toHaveProperty("fees.signalMarketsWithoutMetadata");
  });
});
