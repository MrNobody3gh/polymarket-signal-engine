/**
 * Phase 4.1 Part B — `npm run phase4:shadow-report`: the read-only database side of the shadow-book report. The database is reached ONLY through
 * `readOnly()` (a select-only wrapper: no insert, update, delete or rpc can even be typed). No network. Streams `shadow_books` in pages of PAGE rows
 * and keeps only numbers (report.ts), so memory does not grow with the number of snapshots.
 *
 *   npm run phase4:shadow-report -- [--days 14] [--since 2026-10-06T00:00:00Z] [--out-dir docs/phase4/data] [--print-files shadow_report.md,shadow_groups.csv]
 *
 * Exit: 0 finished, 1 failed, 2 database variables missing (the database is not touched).
 * Files (in --out-dir): shadow_report.json (everything), shadow_report.md (the console text), shadow_groups.csv, shadow_paired.csv. `npm run phase4:bundle` returns them from a log-only host.
 */
import { EXIT, parseArgs, num, printFiles, type CliDeps } from "../cli";
import { readOnly, selectIn, type ReadOnlyDb } from "../readonly-db";
import { categorize } from "../categorize";
import { db as supabaseDb } from "../../db";
import { OFFSETS_S, SIZES_USD } from "./config";
import { ReportAcc, buildReport, consoleLines, groupsCsv, nearestOffset, pairedCsv, type PaperLite, type RowLite, type SignalMeta } from "./report";

export const SHADOW_REPORT_USAGE = "usage: npm run phase4:shadow-report -- [--days 14] [--since ISO] [--out-dir docs/phase4/data] [--max-rows 400000] [--print-files a,b]";
export const REPORT_PAGE = 500;
const N = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const COLS = "signal_id,offset_s,due_at,status,source_price,best_bid,best_ask,spread,mid,bids,asks,fills,fee_rate_bps,fee_source";
const levels = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map((l) => [Number((l as number[])[0]), Number((l as number[])[1])] as [number, number]) : null);
const fillsOf = (v: any) => (v && v.by_usd ? v : null);

export async function readReport(rdb: ReadOnlyDb, o: { sinceIso: string; days: number; maxRows: number; nowIso: string }) {
  const acc = new ReportAcc({ sizes: SIZES_USD, pairOffset: nearestOffset(OFFSETS_S) });
  let seen = 0;
  for (let from = 0; seen < o.maxRows; from += REPORT_PAGE) {
    const { data, error } = await rdb.select("shadow_books", COLS).gte("due_at", o.sinceIso).order("due_at", { ascending: true }).order("signal_id", { ascending: true }).order("offset_s", { ascending: true }).range(from, from + REPORT_PAGE - 1);
    if (error) throw new Error(`shadow_books: ${error.message}`);
    const rows = (data ?? []) as Record<string, any>[]; if (!rows.length) break;
    const ids = [...new Set(rows.map((r) => String(r.signal_id)))];
    const sigs = new Map((await selectIn<Record<string, any>>(ids, (c) => rdb.select("signals", "id,kind,title,slug,condition_id,created_at").in("id", c as string[]))).map((s) => [String(s.id), s]));
    const paper = new Map((await selectIn<Record<string, any>>(ids, (c) => rdb.select("paper_executions", "signal_id,status,signal_price,market_price,fill_price,filled_usd,entry_fee,fee_source,evaluated_ts").eq("mode", "REALISTIC").in("signal_id", c as string[]))).map((p) => [String(p.signal_id), p]));
    for (const r of rows) {
      const s = sigs.get(String(r.signal_id)); if (!s) continue; // the signal was deleted after the row was written (cascade makes this impossible; skipped, never guessed)
      const meta: SignalMeta = { kind: String(s.kind), category: categorize({ title: s.title, slug: s.slug }).category, conditionId: String(s.condition_id) };
      const p = paper.get(String(r.signal_id)); const created = Date.parse(s.created_at) / 1000; const ev = p?.evaluated_ts ? Date.parse(p.evaluated_ts) / 1000 : null;
      const pl: PaperLite | null = p ? { status: String(p.status), signal_price: N(p.signal_price), market_price: N(p.market_price), fill_price: N(p.fill_price), filled_usd: N(p.filled_usd), entry_fee: N(p.entry_fee), fee_source: p.fee_source ?? null, evaluated_gap_s: ev === null ? null : created - ev } : null;
      const row: RowLite = { signal_id: String(r.signal_id), offset_s: Number(r.offset_s), status: String(r.status), source_price: N(r.source_price), best_bid: N(r.best_bid), best_ask: N(r.best_ask), spread: N(r.spread), mid: N(r.mid), bids: levels(r.bids), asks: levels(r.asks), fills: fillsOf(r.fills), fee_rate_bps: N(r.fee_rate_bps), fee_source: r.fee_source ?? null, bytes: JSON.stringify([r.bids, r.asks, r.fills]).length + 220 };
      acc.add(row, meta, Date.parse(r.due_at) / 1000, pl); seen++;
    }
    if (rows.length < REPORT_PAGE) break;
  }
  if (seen >= o.maxRows) throw new Error(`more than ${o.maxRows} rows in the window; narrow it with --days or --since`);
  let entry: number | null = null;
  if (Number.isFinite(acc.minDue)) {
    const { count, error } = await rdb.select("signals", "id", { count: "exact", head: true }).gte("created_at", new Date(acc.minDue * 1000).toISOString()).lte("created_at", new Date(acc.maxDue * 1000).toISOString()).neq("kind", "EXIT");
    if (!error) entry = count ?? null;
  }
  return buildReport(acc, { generatedAt: o.nowIso, days: o.days, entrySignalsInPeriod: entry });
}

export async function runShadowReportCli(argv: string[], env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const log = d.log ?? ((l: string) => console.log(l)); const { flags, opts } = parseArgs(argv);
  if (flags.has("help")) { log(SHADOW_REPORT_USAGE); return EXIT.OK; }
  if (!d.db && !(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)) { log("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required; the database was not touched."); return EXIT.CONFIG; }
  const nowMs = (d.now ?? Date.now)(); const days = num(opts.days, 14);
  const since = opts.since ?? new Date(nowMs - days * 86400_000).toISOString(); if (!Number.isFinite(Date.parse(since))) { log(`--since must be an ISO date, got ${JSON.stringify(opts.since)}; the database was not touched.`); return EXIT.CONFIG; }
  const outDir = opts["out-dir"] ?? "docs/phase4/data"; const write = d.writeFile ?? (() => { throw new Error("no writer"); });
  try {
    const rdb = d.db ? d.db() : readOnly(supabaseDb());
    const report = await readReport(rdb, { sinceIso: new Date(Date.parse(since)).toISOString(), days, maxRows: num(opts["max-rows"], 400_000), nowIso: new Date(nowMs).toISOString() });
    const files = ["shadow_report.md", "shadow_report.json", "shadow_groups.csv", "shadow_paired.csv"]; d.mkdir?.(outDir);
    const lines = consoleLines(report, outDir, files);
    write(`${outDir}/shadow_report.json`, JSON.stringify(report)); write(`${outDir}/shadow_groups.csv`, groupsCsv(report)); write(`${outDir}/shadow_paired.csv`, pairedCsv(report)); write(`${outDir}/shadow_report.md`, ["# Phase 4.1 shadow order-book report", "", "```", ...lines, "```", ""].join("\n"));
    for (const l of lines) log(l);
    await printFiles((opts["print-files"] ?? "").split(",").map((x) => x.trim()).filter(Boolean), { outDir, readFile: d.readFile, log, sleep: d.sleep });
    return EXIT.OK;
  } catch (e) { log(`shadow report failed: ${(e as Error).message}`); return EXIT.FAILED; }
}
