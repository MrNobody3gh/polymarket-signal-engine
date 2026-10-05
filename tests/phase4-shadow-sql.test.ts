/**
 * Phase 4.1 against a REAL Postgres. Skipped unless PG_TEST_URL is set (see tests/sql.test.ts). It creates a scratch database, applies migrations
 * 0001–0012 from scratch (0012 twice), checks the table, its constraints, RLS and grants, proves that no existing table or function changed, and runs
 * the job and the report over the real schema. The scratch database is dropped at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ShadowJob } from "@/lib/phase4/shadow/job";
import { pruneBatch, requestsSince } from "@/lib/phase4/shadow/store";
import { readReport } from "@/lib/phase4/shadow/report-cli";
import { readOnly } from "@/lib/phase4/readonly-db";
import { pgDb } from "./helpers/pgDb";
import { T0, signal, uid, world } from "./helpers/shadowWorld";

const URL_ = process.env.PG_TEST_URL; const d = URL_ ? describe : describe.skip;
const dir = "supabase/migrations"; const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const scratch = `shadow_t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const urlFor = (db: string) => { const u = new URL(URL_!); u.pathname = `/${db}`; return u.toString(); };
let admin: pg.Client; let c: pg.Client; let jc: pg.Client;
const shape = async (cl: pg.Client) => ({
  cols: (await cl.query("select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name <> 'shadow_books' order by 1, 2")).rows,
  fns: (await cl.query("select p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(p.prosrc) as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1, 2")).rows,
  pol: (await cl.query("select tablename, policyname from pg_policies where schemaname = 'public' and tablename <> 'shadow_books' order by 1, 2")).rows,
  idx: (await cl.query("select tablename, indexname from pg_indexes where schemaname = 'public' and tablename <> 'shadow_books' order by 1, 2")).rows,
});
let before: Awaited<ReturnType<typeof shape>>;

d("Phase 4.1 (real Postgres)", () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`create database ${scratch}`);
    c = new pg.Client({ connectionString: urlFor(scratch) }); await c.connect();
    for (const f of files.filter((x) => x < "0012")) await c.query(readFileSync(`${dir}/${f}`, "utf8")); // 0001–0011, from scratch
    before = await shape(c);
    await c.query(readFileSync(`${dir}/0012_shadow_books.sql`, "utf8")); await c.query(readFileSync(`${dir}/0012_shadow_books.sql`, "utf8")); // applied twice: idempotent
  }, 120_000);
  afterAll(async () => { await jc?.end(); await c?.end(); if (admin) { await admin.query(`drop database if exists ${scratch} with (force)`); await admin.end(); } });

describe("migration 0012", () => {
  it("there is exactly one new migration, numbered 0012, on top of 0001–0011", () => { expect(files.slice(-2)).toEqual(["0011_portfolio_report_access.sql", "0012_shadow_books.sql"]); expect(files).toHaveLength(12); });
  it("no existing table, column, function, policy or index changed", async () => { expect(await shape(c)).toEqual(before); });
  it("the table has the columns the brief lists, and the primary key is (signal_id, offset_s)", async () => {
    const cols = (await c.query("select column_name from information_schema.columns where table_name = 'shadow_books' order by ordinal_position")).rows.map((r) => r.column_name);
    for (const k of ["signal_id", "offset_s", "due_at", "taken_at", "token_id", "side", "source_price", "best_bid", "best_ask", "spread", "mid", "bids", "asks", "fills", "fee_rate_bps", "fee_source", "status", "http_status", "latency_ms", "request_count"]) expect(cols, k).toContain(k);
    const pk = (await c.query("select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = 'shadow_books'::regclass and i.indisprimary order by array_position(i.indkey::int[], a.attnum::int)")).rows.map((r) => r.attname); expect(pk).toEqual(["signal_id", "offset_s"]);
  });
  it("RLS is on, there is no policy, and the privileges are the service role's only: select, insert, delete (no update); anon and authenticated have none", async () => {
    expect((await c.query("select relrowsecurity from pg_class where oid = 'shadow_books'::regclass")).rows[0].relrowsecurity).toBe(true);
    expect((await c.query("select count(*)::int as n from pg_policies where tablename = 'shadow_books'")).rows[0].n).toBe(0);
    const priv = async (role: string, p: string) => (await c.query("select has_table_privilege($1, 'shadow_books', $2) as ok", [role, p])).rows[0].ok;
    for (const role of ["anon", "authenticated", "public"]) for (const p of ["select", "insert", "update", "delete"]) expect(await priv(role, p), `${role} ${p}`).toBe(false);
    expect([await priv("service_role", "select"), await priv("service_role", "insert"), await priv("service_role", "delete"), await priv("service_role", "update")]).toEqual([true, true, true, false]);
  });
  it("as the roles: anon cannot read or write (permission denied), the service role can insert, read and delete but not update", async () => {
    const sid = uid(7); await c.query("insert into signals (id, kind, severity, wallet, condition_id, token_id, dedupe_key) values ($1, 'NEW_POSITION', 3, 'w', 'c', 't', 'k7')", [sid]);
    await c.query("set role anon"); await expect(c.query("select * from shadow_books")).rejects.toThrow(/permission denied/); await expect(c.query("insert into shadow_books (signal_id, offset_s, due_at, taken_at, token_id, status) values ($1, 0, now(), now(), 't', 'MISSED')", [sid])).rejects.toThrow(/permission denied/); await c.query("reset role");
    await c.query("set role service_role"); await c.query("insert into shadow_books (signal_id, offset_s, due_at, taken_at, token_id, status) values ($1, 0, now(), now(), 't', 'MISSED')", [sid]);
    expect((await c.query("select count(*)::int as n from shadow_books")).rows[0].n).toBe(1); await expect(c.query("update shadow_books set http_status = 1")).rejects.toThrow(/permission denied/); await c.query("delete from shadow_books"); await c.query("reset role");
  });
  it("the constraints hold: status vocabulary, side, offset range, price bounds, OK needs a sane two-sided book, MISSED carries no data, the key is unique, the signal must exist, deletion cascades", async () => {
    const sid = uid(8); await c.query("insert into signals (id, kind, severity, wallet, condition_id, token_id, dedupe_key) values ($1, 'NEW_POSITION', 3, 'w', 'c', 't', 'k8')", [sid]);
    const ins = (cols: string, vals: string) => c.query(`insert into shadow_books (signal_id, offset_s, due_at, taken_at, token_id, ${cols}) values ('${sid}', ${vals})`);
    await expect(ins("status", "0, now(), now(), 't', 'BOGUS'")).rejects.toThrow(/status_check/);
    await expect(ins("status, side", "0, now(), now(), 't', 'MISSED', 'SELL'")).rejects.toThrow(/side_check/);
    await expect(ins("status", "-1, now(), now(), 't', 'MISSED'")).rejects.toThrow(/offset_s_check/); await expect(ins("status", "3601, now(), now(), 't', 'MISSED'")).rejects.toThrow(/offset_s_check/);
    await expect(ins("status, source_price", "0, now(), now(), 't', 'MISSED', 1")).rejects.toThrow(/source_price_check/); await expect(ins("status, best_bid", "0, now(), now(), 't', 'OK', 1.5")).rejects.toThrow(/best_bid_check/);
    await expect(ins("status", "0, now(), now(), 't', 'OK'")).rejects.toThrow(/ok_has_two_sides/); await expect(ins("status, best_bid, best_ask", "0, now(), now(), 't', 'OK', 0.6, 0.5")).rejects.toThrow(/ok_has_two_sides/);
    await expect(ins("status, bids", "0, now(), now(), 't', 'MISSED', '[[0.5,1]]'")).rejects.toThrow(/missed_has_no_data/); await expect(ins("status, request_count", "0, now(), now(), 't', 'MISSED', 1")).rejects.toThrow(/missed_has_no_data/);
    await expect(ins("status, fee_source", "0, now(), now(), 't', 'ERROR', 'MADE_UP'")).rejects.toThrow(/fee_source_check/);
    await ins("status, best_bid, best_ask", "0, now(), now(), 't', 'OK', 0.5, 0.5"); // a locked book is allowed
    await expect(ins("status", "0, now(), now(), 't', 'ERROR'")).rejects.toThrow(/duplicate key/);
    await expect(c.query("insert into shadow_books (signal_id, offset_s, due_at, taken_at, token_id, status) values ($1, 0, now(), now(), 't', 'ERROR')", [uid(9999)])).rejects.toThrow(/foreign key/);
    await c.query("delete from signals where id = $1", [sid]); expect((await c.query("select count(*)::int as n from shadow_books where signal_id = $1", [sid])).rows[0].n).toBe(0);
  });
  it("rolling back is one statement: drop table shadow_books removes everything this step added", async () => {
    const r = await c.query("begin"); await c.query("drop table shadow_books"); expect((await c.query("select to_regclass('public.shadow_books') as t")).rows[0].t).toBeNull(); await c.query("rollback"); expect((await c.query("select to_regclass('public.shadow_books') as t")).rows[0].t).toBe("shadow_books"); void r;
  });
});

describe("the job and the report over the real schema", () => {
  const ins = async (i: number, ageS: number, o: { score?: number; token?: string } = {}) => { const s = signal(i, ageS, { score: o.score, token: o.token }); await jc.query("insert into signals (id, kind, severity, wallet, condition_id, token_id, title, slug, price, payload, dedupe_key, created_at) values ($1, 'NEW_POSITION', 3, 'w', $2, $3, $4, $5, $6, $7, $8, $9)", [s.id, s.condition_id, s.token_id, s.title, s.slug, s.price, JSON.stringify(s.payload), `k${i}`, s.created_at]); };
  beforeAll(async () => { jc = new pg.Client({ connectionString: urlFor(scratch) }); await jc.connect(); await jc.query("truncate signals cascade"); });

  it("records, is idempotent, and survives a restart, with the real column types and constraints", async () => {
    for (let i = 1; i <= 6; i++) await ins(i, 0); await ins(7, 400); // 7 was created 400 s ago: offsets 0 and 60 are MISSED
    const db = pgDb(jc, { jsonArrays: true }) as unknown as SupabaseClient; const w = world(); const cfg = { minScore: 0, dailyRequests: 20_000 };
    const mk = () => new ShadowJob({ db, config: cfg, http: w.http(), nowSec: w.nowSec, clockMs: w.clockMs, log: () => {} });
    const s = await mk().runCycle(); expect(s.snapshots).toBe(7); expect(s.missed).toBe(2);
    const n = w.calls.length; const again = await mk().runCycle(); expect(again).toMatchObject({ snapshots: 0, missed: 0 }); expect(w.calls.length).toBe(n);
    const rows = (await jc.query("select * from shadow_books order by signal_id, offset_s")).rows; expect(rows).toHaveLength(9);
    const ok = rows.find((r) => r.signal_id === uid(1))!; expect(ok.status).toBe("OK"); expect(Number(ok.best_ask)).toBe(0.5); expect(ok.bids[0]).toEqual([0.48, 500]); expect(ok.fills.by_usd["25"].shares).toBe(50); expect(ok.fee_source).toBe("OBSERVED_RATE");
    expect(rows.filter((r) => r.status === "MISSED").map((r) => r.offset_s).sort()).toEqual([0, 60]);
    w.set(T0 + 60); await mk().runCycle(); expect((await jc.query("select count(*)::int as n from shadow_books")).rows[0].n).toBe(15); // 6 more offset-60 rows; signal 7's 60 was MISSED already
  });
  it("requestsSince and pruneBatch work on the real table", async () => {
    const db = pgDb(jc) as unknown as SupabaseClient; const day = new Date(T0 * 1000).toISOString().slice(0, 10);
    const used = await requestsSince(db, `${day}T00:00:00.000Z`); const direct = Number((await jc.query("select coalesce(sum(request_count), 0) as s from shadow_books where taken_at >= $1", [`${day}T00:00:00.000Z`])).rows[0].s); expect(used).toBe(direct); expect(used).toBeGreaterThan(0);
    await jc.query("update shadow_books set due_at = due_at - interval '60 days' where signal_id in ($1, $2)", [uid(1), uid(2)]);
    const cutoff = new Date((T0 - 45 * 86400) * 1000).toISOString(); expect(await pruneBatch(db, cutoff, 3)).toBeGreaterThan(0); while (await pruneBatch(db, cutoff, 3)) { /* bounded batches until none */ }
    expect((await jc.query("select count(*)::int as n from shadow_books where signal_id in ($1, $2)", [uid(1), uid(2)])).rows[0].n).toBe(0); expect((await jc.query("select count(*)::int as n from shadow_books where signal_id = $1", [uid(3)])).rows[0].n).toBeGreaterThan(0);
  });
  it("the report reads the real schema (numeric columns arrive as strings) read-only, and pairs with paper_executions", async () => {
    for (let i = 1; i <= 7; i++) await jc.query("insert into paper_executions (signal_id, mode, kind, config_hash, status, state, signal_price, market_price, fill_price, filled_usd, entry_fee, fee_source, evaluated_ts) values ($1, 'REALISTIC', 'NEW_POSITION', 'h', 'FILLED', 'OPEN', 0.49, 0.5, 0.51, 100, 1, 'OBSERVED_RATE', $2) on conflict do nothing", [uid(i), new Date((T0 - 3) * 1000).toISOString()]);
    const log: string[] = []; const spy = pgDb(jc) as any; const ro = readOnly({ from: (t: string) => { log.push(t); return spy.from(t); } } as any);
    const r = await readReport(ro, { sinceIso: new Date((T0 - 86400) * 1000).toISOString(), days: 1, maxRows: 10_000, nowIso: "x" });
    expect(r.coverage.rows).toBeGreaterThan(5); expect(r.paired.paperRowsSeen).toBeGreaterThan(0); expect(r.paired.metrics.every((m) => Number.isFinite(m.n))).toBe(true); expect(new Set(log)).toEqual(new Set(["shadow_books", "signals", "paper_executions"]));
    const g = r.groups.find((x) => x.key === "ALL")!; expect(g.spreadPts["0"].p50).toBeCloseTo(2, 6);
  });
});
});
