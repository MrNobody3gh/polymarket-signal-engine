/**
 * Phase 4.0 — command-line entry points of the two read-only scripts, with every effect injected so tests can run them
 * end to end: `npm run phase4:ts-audit` (S1a) and `npm run phase4:coverage` (S1b).
 *
 * Needs NO secret except, for the database parts, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (as
 * scripts/portfolio-audit.ts). The database is reached only through `readOnly()` (select only). The network is reached
 * only through `PoliteHttp` (public GET, ≤ 2 requests/s, bounded retries, no credentials).
 *
 * Exit codes: 0 finished (partial results are normal and are listed under "NOT ESTABLISHED"/"NOT MEASURED"); 1 an unexpected
 * failure; 2 a database variable is missing where the database is needed (the database is not touched).
 */
import { PoliteHttp } from "./http";
import { readOnly, selectIn, type ReadOnlyDb } from "./readonly-db";
import { runS1a, s1aSummaryLines } from "./s1a";
import { coverageSummaryLines, runCoverage } from "./probe";
import { GAMMA_API } from "../polymarket/client";
import { db as supabaseDb } from "../db";
import { US_DEFAULTS, US_EXCHANGE, gammaIdOf, type UsConfig } from "./venues";
import type { RawMarket, SlotVerdict } from "./audit";
import { parseTimestamp } from "./timestamps";

export interface CliDeps {
  fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number;
  /** Lazily creates the read-only database; only called when a database stage runs. Throws if the variables are missing. */
  db?: () => ReadOnlyDb;
  writeFile?: (path: string, content: string) => void; readFile?: (path: string) => string | null; mkdir?: (dir: string) => void;
  log?: (line: string) => void;
}
export const EXIT = { OK: 0, FAILED: 1, CONFIG: 2 } as const;

function parseArgs(argv: string[]): { flags: Set<string>; opts: Record<string, string> } {
  const flags = new Set<string>(); const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith("--")) continue; const k = a.slice(2); const nxt = argv[i + 1]; if (nxt !== undefined && !nxt.startsWith("--")) { opts[k] = nxt; i++; } else flags.add(k); }
  return { flags, opts };
}
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
const usConfig = (opts: Record<string, string>, flags: Set<string>): UsConfig | null => flags.has("no-us") ? null : { ...US_DEFAULTS, base: opts["us-base"] ?? US_DEFAULTS.base, marketsPath: opts["us-markets-path"] ?? US_DEFAULTS.marketsPath, openQuery: opts["us-open-query"] ?? US_DEFAULTS.openQuery, closedQuery: opts["us-closed-query"] ?? US_DEFAULTS.closedQuery, pageSize: num(opts["us-page-size"], US_DEFAULTS.pageSize) };
const dbEnvOk = (env: Record<string, string | undefined>) => !!env.NEXT_PUBLIC_SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;

export const TS_AUDIT_USAGE = "usage: npm run phase4:ts-audit -- [--out-dir docs/phase4/data] [--fixtures-dir tests/fixtures/phase4 | --no-fixtures] [--sample-open 300] [--sample-resolved 300] [--fetch-factor 3] [--no-us] [--us-base URL] [--us-markets-path /v1/markets] [--us-open-query 'a=b'] [--us-closed-query 'a=b'] [--with-db]";
export const COVERAGE_USAGE = "usage: npm run phase4:coverage -- [--out-dir docs/phase4/data] [--recommendations docs/phase4/data/s1a_summary.json] [--no-venue] [--mode REALISTIC|IDEAL|CONSERVATIVE] [--us-base URL] [--us-markets-path /v1/markets] [--us-open-query 'a=b'] [--us-closed-query 'a=b'] [--us-max 6000] [--start 2026-09-27T04:28:38Z]";

/** Our own resolved markets (read-only): the most recent resolutions in `token_resolutions`, their markets fetched from Gamma, so field times can be compared with OUR observed on-chain resolution times. */
export async function loadOurs(rdb: ReadOnlyDb, http: PoliteHttp, max: number): Promise<{ raw: RawMarket; resolvedMs: number }[]> {
  const { data, error } = await rdb.select("token_resolutions", "token_id,resolved_ts").order("resolved_ts", { ascending: false }).limit(1000);
  if (error) throw new Error(`token_resolutions: ${error.message}`);
  const tokens = (data ?? []).map((r: any) => ({ token: String(r.token_id), ms: Date.parse(r.resolved_ts) })).filter((r: { ms: number }) => Number.isFinite(r.ms));
  const led = await selectIn<{ token_id: string; condition_id: string }>(tokens.map((t: { token: string }) => t.token), (c) => rdb.select("paper_ledger", "token_id,condition_id").in("token_id", c as string[]));
  const cond = new Map<string, number>(); const tokCond = new Map(led.map((l) => [String(l.token_id), String(l.condition_id).toLowerCase()]));
  for (const t of tokens) { const c = tokCond.get(t.token); if (c) cond.set(c, Math.min(cond.get(c) ?? Infinity, t.ms)); }
  const out: { raw: RawMarket; resolvedMs: number }[] = [];
  for (const [c, ms] of [...cond.entries()].slice(0, max)) {
    if (http.isStopped(new URL(GAMMA_API).origin)) break;
    const r = await http.getJson<{ markets?: RawMarket[] }>(`${GAMMA_API}/markets/keyset?condition_ids=${encodeURIComponent(c)}&limit=5`);
    if (!r.ok) continue; const m = (r.json.markets ?? []).find((x) => gammaIdOf(x).toLowerCase() === c); if (m) out.push({ raw: m, resolvedMs: ms });
  }
  return out;
}

export async function runTimestampAuditCli(argv: string[], env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const log = d.log ?? ((l: string) => console.log(l)); const { flags, opts } = parseArgs(argv);
  if (flags.has("help")) { log(TS_AUDIT_USAGE); return EXIT.OK; }
  const outDir = opts["out-dir"] ?? "docs/phase4/data"; const fixtureDir = flags.has("no-fixtures") ? undefined : opts["fixtures-dir"] ?? "tests/fixtures/phase4";
  const write = d.writeFile ?? (() => { throw new Error("no writer"); }); const mkdir = d.mkdir ?? (() => {});
  const http = new PoliteHttp({ fetch: d.fetch, sleep: d.sleep, now: d.now });
  try {
    let ours: { raw: RawMarket; resolvedMs: number }[] | undefined;
    if (flags.has("with-db")) {
      if (!dbEnvOk(env) && !d.db) { log("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --with-db; the database was not touched."); return EXIT.CONFIG; }
      try { ours = await loadOurs(d.db ? d.db() : readOnly(supabaseDb()), http, 150); } catch (e) { log(`database comparison skipped: ${(e as Error).message}`); }
    }
    mkdir(outDir); if (fixtureDir) mkdir(fixtureDir);
    const res = await runS1a({ http, us: usConfig(opts, flags), sampleOpen: num(opts["sample-open"], 300), sampleResolved: num(opts["sample-resolved"], 300), fetchFactor: num(opts["fetch-factor"], 3), ours, now: d.now, fixtureDir, write: (rel, content) => write(rel.startsWith(fixtureDir ?? "\u0000") ? rel : `${outDir}/${rel}`, content) });
    for (const l of s1aSummaryLines(res, outDir)) log(l);
    return EXIT.OK;
  } catch (e) { log(`timestamp audit failed: ${(e as Error).message}`); return EXIT.FAILED; }
}

export async function runCoverageCli(argv: string[], env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const log = d.log ?? ((l: string) => console.log(l)); const { flags, opts } = parseArgs(argv);
  if (flags.has("help")) { log(COVERAGE_USAGE); return EXIT.OK; }
  if (!dbEnvOk(env) && !d.db) { log("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set; the database was not touched."); return EXIT.CONFIG; }
  const outDir = opts["out-dir"] ?? "docs/phase4/data"; const write = d.writeFile ?? (() => { throw new Error("no writer"); }); const mkdir = d.mkdir ?? (() => {});
  const mode = (["REALISTIC", "IDEAL", "CONSERVATIVE"].includes(opts.mode ?? "") ? opts.mode : "REALISTIC") as "REALISTIC" | "IDEAL" | "CONSERVATIVE";
  let startIso: string | undefined;
  if (opts.start !== undefined) { const p = parseTimestamp(opts.start); if (p.kind !== "datetime") { log(`--start must be an ISO-8601 datetime with a time zone, e.g. 2026-09-27T04:28:38Z (got ${JSON.stringify(opts.start)}); the database was not touched.`); return EXIT.CONFIG; } startIso = new Date(p.ms).toISOString(); }
  try {
    let recs: SlotVerdict[] | null = null; const recPath = opts.recommendations ?? "docs/phase4/data/s1a_summary.json";
    const txt = d.readFile ? d.readFile(recPath) : null;
    if (txt) { try { const j = JSON.parse(txt) as { venues?: { venue: string; recommendations?: SlotVerdict[] }[] }; recs = j.venues?.find((v) => v.venue === US_EXCHANGE)?.recommendations ?? null; if (recs && !recs.length) recs = null; } catch { log(`could not read ${recPath}: recommendations ignored`); } }
    const useVenue = !flags.has("no-venue"); const http = useVenue ? new PoliteHttp({ fetch: d.fetch, sleep: d.sleep, now: d.now }) : null;
    mkdir(outDir);
    const res = await runCoverage({ db: d.db ? d.db() : readOnly(supabaseDb()), http, us: useVenue ? usConfig(opts, flags) : null, recommendations: recs, now: d.now, mode, startIso, maxUsMarkets: num(opts["us-max"], 6000), write: (rel, c) => write(`${outDir}/${rel}`, c) });
    for (const l of coverageSummaryLines(res, outDir)) log(l);
    return EXIT.OK;
  } catch (e) { log(`coverage probe failed: ${(e as Error).message}`); return EXIT.FAILED; }
}
