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
import { uuidPrefixRange } from "@/lib/paper/queries";
import { readFileSync } from "node:fs";
import path from "node:path";

const URL = process.env.PG_TEST_URL; const d = URL ? describe : describe.skip;
let c: pg.Client; let c2: pg.Client;
const T0 = 1_790_000_000;
const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

d("SQL (real Postgres)", () => {
  beforeAll(async () => { c = new pg.Client({ connectionString: URL }); c2 = new pg.Client({ connectionString: URL }); await c.connect(); await c2.connect();
    await c.query("truncate paper_executions, paper_marks, paper_ledger, price_observations, signals cascade"); });
  afterAll(async () => { await c?.end(); await c2?.end(); });

  it("/signal prefix lookup: ILIKE on uuid is an error; the uuid range returns exactly the text-prefix matches", async () => {
    await expect(c.query("select 1 from paper_ledger where signal_id::uuid ilike 'ab%'")).rejects.toThrow(/operator does not exist/);
    await c.query("create temp table u (id uuid primary key)"); await c.query("insert into u select gen_random_uuid() from generate_series(1, 3000)");
    const ids = (await c.query("select id::text from u")).rows.map((r) => r.id as string);
    for (const len of [1, 2, 3, 8, 11, 13]) for (const id of ids.slice(0, 40)) {
      const prefix = id.slice(0, len); const r = uuidPrefixRange(prefix)!;
      const got = (await c.query("select id::text from u where id between $1 and $2 order by id", [r.lo, r.hi])).rows.map((x) => x.id);
      expect(got).toEqual(ids.filter((x) => x.startsWith(prefix)).sort());
    }
  });

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

// ───────────────────────── Phase 3.1: migration 0008 (portfolio schema) ─────────────────────────
// Same file as the tests above on purpose: vitest runs files in parallel, and those tests truncate shared tables.
d("SQL Phase 3.1 — migration 0008", () => {
  let a: pg.Client; let b: pg.Client;
  const MIG = readFileSync(path.resolve(__dirname, "../supabase/migrations/0008_portfolio.sql"), "utf8");
  const P = "p31test0001"; let sigN = 0;
  const sig = async (token = "tok-p31") => { const id = `31000000-0000-4000-8000-${String(++sigN).padStart(12, "0")}`;
    await a.query("insert into signals (id, kind, severity, wallet, condition_id, token_id, dedupe_key, created_at) values ($1,'NEW_POSITION',2,'0xw','c-p31',$2,$3,now())", [id, token, `p31:${id}`]); return id; };
  const decision = (id: string, o: Record<string, unknown> = {}) => { const r = { outcome: "FILLED", reason: null, requested_usd: 100, filled_usd: 100, filled_shares: 250, ...o };
    return a.query("insert into portfolio_decisions (portfolio_id, signal_id, kind, source_key, event_ts, outcome, reason, requested_usd, filled_usd, filled_shares, input_hash, record_hash) values ($1,$2,'NEW_POSITION','k',now(),$3,$4,$5,$6,$7,'i','r')",
      [P, id, r.outcome, r.reason, r.requested_usd, r.filled_usd, r.filled_shares]); };
  const lot = (id: string, o: Record<string, unknown> = {}) => { const r = { state: "OPEN", shares_open: 250, closed_ts: null, ...o };
    return a.query("insert into portfolio_lots (portfolio_id, signal_id, wallet, token_id, condition_id, opened_ts, shares_filled, cost_usd, shares_open, cost_open, state, closed_ts, record_hash) values ($1,$2,'0xw','tok-p31','c-p31',now(),250,100,$3,100,$4,$5,'r')",
      [P, id, r.shares_open, r.state, r.closed_ts]); };
  beforeAll(async () => {
    a = new pg.Client({ connectionString: URL }); b = new pg.Client({ connectionString: URL }); await a.connect(); await b.connect();
    await a.query(MIG); await a.query(MIG); // applies cleanly, and a second run is a no-op (idempotent)
    await a.query("delete from portfolios where id like 'p31test%'"); await a.query("delete from signals where dedupe_key like 'p31:%'"); await a.query("delete from token_resolution_obs where token_id like 'tok-p31%'");
    await a.query("insert into portfolios (id, mode, exec_config_hash, config, config_hash, start_ts) values ($1,'REALISTIC','e1','{}','c1','2026-09-27T04:26:41Z')", [P]);
  });
  afterAll(async () => { await a?.query("delete from portfolios where id like 'p31test%'"); await a?.query("delete from signals where dedupe_key like 'p31:%'"); await a?.query("delete from token_resolution_obs where token_id like 'tok-p31%'"); await a?.end(); await b?.end(); });

  it("creates every table, index and function, with RLS on and public read only where intended", async () => {
    const tables = (await a.query("select tablename, rowsecurity from pg_tables where schemaname='public' and tablename in ('portfolios','portfolio_runs','portfolio_checkpoints','portfolio_decisions','portfolio_lots','portfolio_equity','token_resolution_obs')")).rows;
    expect(tables).toHaveLength(7); expect(tables.every((t) => t.rowsecurity)).toBe(true);
    const idx = (await a.query("select indexname from pg_indexes where indexname in ('paper_executions_mode_fill_idx','paper_executions_mode_computed_idx','portfolio_decisions_event_idx','portfolio_lots_open_idx')")).rows;
    expect(idx).toHaveLength(4);
    const pol = (await a.query("select tablename from pg_policies where tablename like 'portfolio%' or tablename = 'token_resolution_obs' order by 1")).rows.map((r) => r.tablename);
    expect(pol).toEqual(["portfolio_decisions", "portfolio_equity", "portfolio_lots", "portfolios", "token_resolution_obs"]); // no policy on runs / checkpoints
    for (const fn of ["claim_portfolio_lease(text,text,integer)", "release_portfolio_lease(text,text)"]) {
      expect((await a.query("select has_function_privilege('anon', $1, 'execute') x", [fn])).rows[0].x).toBe(false);
      expect((await a.query("select has_function_privilege('service_role', $1, 'execute') x", [fn])).rows[0].x).toBe(true);
    }
  });

  it("the stream query walks paper_executions by (mode, fill_ts, signal_id) through the new index", async () => {
    // Tiny test tables make a sort look cheap; forbid seq scans and sorts so the plan shows whether an index can serve the ordered walk.
    await a.query("set enable_seqscan = off"); await a.query("set enable_sort = off");
    const plan = (await a.query("explain select signal_id from paper_executions where mode = 'REALISTIC' and (fill_ts, signal_id) > ('2026-09-27T00:00:00Z', '00000000-0000-0000-0000-000000000000') order by fill_ts, signal_id limit 500")).rows.map((r) => r["QUERY PLAN"]).join("\n");
    await a.query("reset enable_seqscan"); await a.query("reset enable_sort");
    expect(plan).toMatch(/paper_executions_mode_fill_idx/); expect(plan).not.toMatch(/Sort/);
  });

  it("lease: exactly one of many concurrent claimants wins; renew, expiry, release and bad input behave", async () => {
    const clients = await Promise.all(Array.from({ length: 8 }, async () => { const x = new pg.Client({ connectionString: URL }); await x.connect(); return x; }));
    try {
      const wins = await Promise.all(clients.map((x, i) => x.query("select claim_portfolio_lease($1, $2, 60) ok", [P, `owner-${i}`]).then((r) => r.rows[0].ok)));
      expect(wins.filter(Boolean)).toHaveLength(1);
      const owner = `owner-${wins.indexOf(true)}`; const other = owner === "owner-0" ? "owner-1" : "owner-0";
      expect((await a.query("select claim_portfolio_lease($1, $2, 60) ok", [P, owner])).rows[0].ok).toBe(true);   // renew
      expect((await a.query("select claim_portfolio_lease($1, $2, 60) ok", [P, other])).rows[0].ok).toBe(false);  // still held
      expect((await a.query("select release_portfolio_lease($1, $2) ok", [P, other])).rows[0].ok).toBe(false);    // not yours
      await a.query("update portfolio_runs set lease_until = now() - interval '1 second' where portfolio_id = $1", [P]);
      expect((await a.query("select claim_portfolio_lease($1, $2, 60) ok", [P, other])).rows[0].ok).toBe(true);   // expired → takeover
      expect((await a.query("select release_portfolio_lease($1, $2) ok", [P, other])).rows[0].ok).toBe(true);
      expect((await a.query("select lease_owner, lease_until from portfolio_runs where portfolio_id = $1", [P])).rows[0]).toEqual({ lease_owner: null, lease_until: null });
      await expect(a.query("select claim_portfolio_lease($1, 'x', 0)", [P])).rejects.toThrow(/1\.\.3600/);
      await expect(a.query("select claim_portfolio_lease($1, '', 60)", [P])).rejects.toThrow(/owner required/);
      await expect(a.query("select claim_portfolio_lease('p31test-missing', 'x', 60)")).rejects.toThrow(/foreign key/);
    } finally { await Promise.all(clients.map((x) => x.end())); }
  });

  it("token_resolutions: unchanged for ledger tokens, gains orphan tokens, earliest wins deterministically, conflicts surfaced", async () => {
    const cols = (await a.query("select column_name, data_type from information_schema.columns where table_name = 'token_resolutions' order by ordinal_position")).rows;
    expect(cols).toEqual([{ column_name: "token_id", data_type: "text" }, { column_name: "value", data_type: "numeric" }, { column_name: "resolved_ts", data_type: "timestamp with time zone" }]);
    const ledger = async (token: string, value: number, at: string) => { const id = await sig(token);
      await a.query("insert into paper_ledger (signal_id, entry_price, token_id, status, final_price, resolved_at, settled_at) values ($1, 0.4, $2, $3, $4, $5, now())", [id, token, value >= 0.5 ? "RESOLVED_WIN" : "RESOLVED_LOSS", value, at]); };
    const obs = (token: string, value: number, at: string) => a.query("insert into token_resolution_obs (token_id, condition_id, value, resolved_ts, source) values ($1,'c-p31',$2,$3,'test')", [token, value, at]);
    const row = async (token: string) => (await a.query("select value::float8 v, resolved_ts from token_resolutions where token_id = $1", [token])).rows;
    await ledger("tok-p31-ledger", 1, "2026-09-27T10:00:00Z");
    expect(await row("tok-p31-ledger")).toEqual([{ v: 1, resolved_ts: new Date("2026-09-27T10:00:00Z") }]);        // as before 0008
    await obs("tok-p31-orphan", 0, "2026-09-27T11:00:00Z");
    expect(await row("tok-p31-orphan")).toEqual([{ v: 0, resolved_ts: new Date("2026-09-27T11:00:00Z") }]);        // new: orphan token
    await ledger("tok-p31-both", 1, "2026-09-27T12:00:00Z"); await obs("tok-p31-both", 1, "2026-09-27T09:00:00Z");
    expect(await row("tok-p31-both")).toEqual([{ v: 1, resolved_ts: new Date("2026-09-27T09:00:00Z") }]);          // earliest wins
    await ledger("tok-p31-tie", 1, "2026-09-27T12:00:00Z"); await obs("tok-p31-tie", 0, "2026-09-27T12:00:00Z");
    expect((await row("tok-p31-tie"))[0].v).toBe(0);                                                                 // tie → lower value, every time
    const conflicts = (await a.query("select token_id, values::float8[] vs from token_resolution_conflicts where token_id like 'tok-p31%' order by 1")).rows;
    expect(conflicts).toEqual([{ token_id: "tok-p31-tie", vs: [0, 1] }]);
    await expect(obs("tok-p31-bad", 1.5, "2026-09-27T12:00:00Z")).rejects.toThrow(/check constraint/);
  });

  it("decision and lot constraints reject impossible rows", async () => {
    const reject = (q: Promise<unknown>, re: RegExp) => expect(q).rejects.toThrow(re);
    await reject(decision(await sig(), { outcome: "MAYBE" }), /check constraint/);
    await reject(decision(await sig(), { outcome: "REJECTED", reason: "too big", filled_usd: 0, filled_shares: 0 }), /rejected_reason/);
    await reject(decision(await sig(), { filled_usd: 150 }), /filled_le_requested/);
    await reject(decision(await sig(), { filled_shares: 0 }), /fill_needs_shares/);
    const ok = await sig(); await decision(ok, { outcome: "REJECTED", reason: "REJECTED_MAX_OPEN_POSITIONS", filled_usd: 0, filled_shares: 0 });
    const f = await sig(); await decision(f);
    await reject(lot(f, { state: "EXITED", shares_open: 0, closed_ts: null }), /closed_consistent/);
    await reject(lot(f, { state: "RESOLVED", shares_open: 10, closed_ts: "2026-09-28T00:00:00Z" }), /closed_empty/);
    await reject(lot(f, { shares_open: 300 }), /open_le_filled/);
    await reject(lot(await sig()), /foreign key/);                                                                   // a lot needs its decision
    await lot(f);
    await reject(a.query("insert into portfolios (id, mode, exec_config_hash, config, config_hash, start_ts) values ('p31test0002','LIVE','e','{}','c',now())"), /check constraint/);
  });

  it("deleting a portfolio removes everything it owns, and nothing else", async () => {
    const Q = "p31test0003"; await a.query("insert into portfolios (id, mode, exec_config_hash, config, config_hash, start_ts) values ($1,'IDEAL','e','{}','c',now())", [Q]);
    const id = await sig();
    await a.query("insert into portfolio_decisions (portfolio_id, signal_id, kind, source_key, event_ts, outcome, requested_usd, filled_usd, filled_shares, input_hash, record_hash) values ($1,$2,'NEW_POSITION','k',now(),'FILLED',100,100,250,'i','r')", [Q, id]);
    await a.query("insert into portfolio_lots (portfolio_id, signal_id, wallet, token_id, condition_id, opened_ts, shares_filled, cost_usd, shares_open, cost_open, state, record_hash) values ($1,$2,'0xw','t','c',now(),250,100,250,100,'OPEN','r')", [Q, id]);
    await a.query("insert into portfolio_equity (portfolio_id, ts, seq, cash, exposure, equity) values ($1, now(), 0, 900, 100, 1000)", [Q]);
    await a.query("insert into portfolio_checkpoints (portfolio_id, event_ts, event_key, state) values ($1, now(), '2|x|0', '{}')", [Q]);
    await a.query("select claim_portfolio_lease($1, 'o', 60)", [Q]);
    await a.query("delete from portfolios where id = $1", [Q]);
    for (const t of ["portfolio_decisions", "portfolio_lots", "portfolio_equity", "portfolio_checkpoints", "portfolio_runs"]) expect((await a.query(`select count(*)::int n from ${t} where portfolio_id = $1`, [Q])).rows[0].n).toBe(0);
    expect((await a.query("select count(*)::int n from signals where id = $1", [id])).rows[0].n).toBe(1);           // signals untouched
    expect((await a.query("select count(*)::int n from portfolios where id = $1", [P])).rows[0].n).toBe(1);         // other portfolios untouched
  });
});
