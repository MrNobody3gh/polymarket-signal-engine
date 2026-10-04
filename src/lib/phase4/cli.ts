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
import { coverageSummaryLines, runCoverage, type VenueCoverageFile } from "./probe";
import { GAMMA_API } from "../polymarket/client";
import { db as supabaseDb } from "../db";
import { US_DEFAULTS, US_EXCHANGE, US_MIN_INTERVAL_MS, gammaIdOf, parseTargeted, type UsConfig } from "./venues";
import { KALSHI, KALSHI_DEFAULTS, KALSHI_DEFAULT_CAP, fetchKalshiListing, type KalshiConfig, type KalshiListing } from "./venue-kalshi";
import { categoryMix3, kalshiCoverageSummaryLines, mix3Lines, runKalshiCoverage, type KalshiCoverageResult } from "./venue-funnel";
import type { CoverageResult } from "./probe";
import { writeCompact } from "./compact";
import { DEFAULT_SEARCH_BUDGET, emptyTitleSummary, pairKey, unsearchedOf, type SearchPair, kalshiRefOf, listingSearchProvider, loadSearchPairs, runTitleSearch, titleSearchCsv, titleSearchSummaryLines, usSearchProvider, type SearchProvider, type TitleSearchResult, type TitleSearchRow, type TitleSearchSummary } from "./title-search";
import { COVERAGE_REGIME_START_ISO } from "./venue-funnel";
import { kalshiAll as kalshiAllMarkets } from "./venue-kalshi";
import type { RawMarket, SlotVerdict } from "./audit";
import { parseTimestamp } from "./timestamps";
import { DEFAULT_HEAP_BUDGET_MB, EVIDENCE_SCHEMA, EXIT_BUDGET, HeapBudgetExceeded, MemoryGuard, VenueScope, evidenceFile, heapInfo, parseEvidence, parseVenueId, type StopInfo, type VenueId } from "./venue-run";
import { DEFAULT_INVENTORY_BUDGET, fetchKalshiInventory, inventoryLines } from "./kalshi-inventory";
import type { VenueAuditFile } from "./s1a";
import type { VenueTitlesFile } from "./title-search";
import { INTERNATIONAL } from "./venues";

export interface CliDeps {
  fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number;
  /** Lazily creates the read-only database; only called when a database stage runs. Throws if the variables are missing. */
  db?: () => ReadOnlyDb;
  writeFile?: (path: string, content: string) => void; readFile?: (path: string) => string | null; mkdir?: (dir: string) => void;
  log?: (line: string) => void;
  /** 4.0d: the heap meter (bytes in use); tests inject one, the scripts use process.memoryUsage(). */
  heapUsed?: () => number;
}
export const EXIT = { OK: 0, FAILED: 1, CONFIG: 2, BUDGET: EXIT_BUDGET } as const;

export const PRINT_PACE_LINES = 200;
export const PRINT_MAX_LINE = 3000;
/**
 * `--print-files a,b,c`: print the named result files after a run, so a log-only host (Railway) can return them without a shell loop.
 * Each file sits between `=====FILE name` and `=====END name`; at most 200 lines are printed per second (a one-second pause after every
 * 200); a line longer than 3,000 characters is split into 3,000-character pieces. A name is looked up in the output directory, then as a path.
 */
export async function printFiles(names: string[], o: { outDir: string; readFile?: (p: string) => string | null; log: (l: string) => void; sleep?: (ms: number) => Promise<void> }): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))); let printed = 0;
  const emit = async (l: string) => { o.log(l); if (++printed % PRINT_PACE_LINES === 0) await sleep(1000); };
  for (const name of names) {
    await emit(`=====FILE ${name}`);
    const text = o.readFile ? (o.readFile(`${o.outDir}/${name}`) ?? o.readFile(name)) : null;
    if (text === null) await emit("(file not found)");
    else for (const line of text.replace(/\n$/, "").split("\n")) { if (line.length <= PRINT_MAX_LINE) await emit(line); else for (let i = 0; i < line.length; i += PRINT_MAX_LINE) await emit(line.slice(i, i + PRINT_MAX_LINE)); }
    await emit(`=====END ${name}`);
  }
}
const printList = (opts: Record<string, string>) => (opts["print-files"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export function parseArgs(argv: string[]): { flags: Set<string>; opts: Record<string, string> } {
  const flags = new Set<string>(); const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith("--")) continue; const k = a.slice(2); const nxt = argv[i + 1]; if (nxt !== undefined && !nxt.startsWith("--")) { opts[k] = nxt; i++; } else flags.add(k); }
  return { flags, opts };
}
export const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
const usConfig = (opts: Record<string, string>, flags: Set<string>): UsConfig | null => flags.has("no-us") ? null : { ...US_DEFAULTS, base: opts["us-base"] ?? US_DEFAULTS.base, marketsPath: opts["us-markets-path"] ?? US_DEFAULTS.marketsPath, openQuery: opts["us-open-query"] ?? US_DEFAULTS.openQuery, closedQuery: opts["us-closed-query"] ?? US_DEFAULTS.closedQuery, archivedQuery: opts["us-archived-query"] === "none" ? null : opts["us-archived-query"] ?? US_DEFAULTS.archivedQuery, pageSize: num(opts["us-page-size"], US_DEFAULTS.pageSize) };
const kalshiConfig = (opts: Record<string, string>): KalshiConfig => ({ ...KALSHI_DEFAULTS, bases: opts["kalshi-base"] ? [opts["kalshi-base"]] : KALSHI_DEFAULTS.bases });
/** One polite client: ≤ 2 requests/second everywhere, and the US origin at its slower documented limit (60 requests/minute, UNVERIFIED). */
function makeHttp(d: CliDeps, us: UsConfig | null, o: { guard?: MemoryGuard | null; usPaceMs?: number } = {}): PoliteHttp { let origin: string | null = null; try { origin = us ? new URL(us.base).origin : null; } catch { origin = null; } return new PoliteHttp({ fetch: d.fetch, sleep: d.sleep, now: d.now, guard: o.guard ?? undefined, originGapMs: origin ? { [origin]: Math.max(US_MIN_INTERVAL_MS, o.usPaceMs ?? 0) } : undefined }); }
/** The venue named by `--venue`: null = the all-in-one mode (flag absent); `"invalid"` for anything else. */
function venueOpt(opts: Record<string, string>): VenueId | null | "invalid" { if (opts.venue === undefined) return null; return parseVenueId(opts.venue) ?? "invalid"; }
const VENUE_HELP = "--venue must be polymarket_intl, polymarket_us or kalshi (aliases: intl, us)";
/** One guard per process: a `--venue` run is named after its venue, an all-in-one run follows its stages. `--heap-budget-mb` (default 350). */
const makeGuard = (d: CliDeps, opts: Record<string, string>, only: VenueId | null): MemoryGuard => new MemoryGuard({ venue: only ?? "all-in-one run", budgetMb: opts["heap-budget-mb"] !== undefined ? num(opts["heap-budget-mb"], DEFAULT_HEAP_BUDGET_MB) : undefined, heapUsed: d.heapUsed });
const dbEnvOk = (env: Record<string, string | undefined>) => !!env.NEXT_PUBLIC_SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;

export const TS_AUDIT_USAGE = "usage: npm run phase4:ts-audit -- [--out-dir docs/phase4/data] [--fixtures-dir tests/fixtures/phase4 | --no-fixtures] [--sample-open 300] [--sample-resolved 300] [--fetch-factor 3] [--us-targeted default|\"name=query|name=query\"] [--us-sports-max-requests 400] [--kalshi] [--kalshi-max 40000] [--kalshi-base URL] [--print-files a,b] [--no-us] [--us-base URL] [--us-markets-path /v1/markets] [--us-open-query 'a=b'] [--us-closed-query 'a=b'] [--with-db] [--venue polymarket_intl|polymarket_us|kalshi] [--heap-budget-mb 350] [--kalshi-inventory | --kalshi-inventory-only] [--kalshi-inventory-max-requests 600]";
export const COVERAGE_USAGE = "usage: npm run phase4:coverage -- [--out-dir docs/phase4/data] [--recommendations docs/phase4/data/s1a_summary.json] [--no-venue] [--mode REALISTIC|IDEAL|CONSERVATIVE] [--us-base URL] [--us-markets-path /v1/markets] [--us-open-query 'a=b'] [--us-closed-query 'a=b'] [--us-max 6000] [--start 2026-09-27T04:28:38Z] [--diagnose] [--diagnostic-sample 100] [--us-archived-query 'a=b'|none] [--kalshi] [--kalshi-max 40000] [--kalshi-base URL] [--print-files a,b] [--venue polymarket_intl|polymarket_us|kalshi] [--heap-budget-mb 350]";
export const TITLE_SEARCH_USAGE = "usage: npm run phase4:title-search -- [--out-dir docs/phase4/data] [--venue us|kalshi|both] [--search-max-requests 2000] [--all-scores] [--start 2026-09-27T04:28:38Z] [--kalshi-max 40000] [--kalshi-base URL] [--us-base URL] [--us-search-path /v1/search] [--us-search-pace-ms 1100] [--resume] [--resume-from FILE] [--heap-budget-mb 350] [--print-files a,b]  (--venue also takes polymarket_us|kalshi, one venue per process)";

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
  const only = venueOpt(opts); if (only === "invalid") { log(`${VENUE_HELP} (got ${JSON.stringify(opts.venue)}); nothing was fetched.`); return EXIT.CONFIG; }
  if (only === US_EXCHANGE && flags.has("no-us")) { log("--venue polymarket_us contradicts --no-us; nothing was fetched."); return EXIT.CONFIG; }
  const outDir = opts["out-dir"] ?? "docs/phase4/data"; const fixtureDir = flags.has("no-fixtures") ? undefined : opts["fixtures-dir"] ?? "tests/fixtures/phase4";
  const write = d.writeFile ?? (() => { throw new Error("no writer"); }); const mkdir = d.mkdir ?? (() => {});
  const guard = makeGuard(d, opts, only); const scope = only ? new VenueScope(only) : null;
  // a `--venue` run builds only that venue's stages and client: the other venues' hosts are never asked
  const usCfg = only && only !== US_EXCHANGE ? null : usConfig(opts, flags); const http = makeHttp(d, usCfg, { guard });
  const wantKalshi = only ? only === KALSHI : flags.has("kalshi"); const inventoryOnly = flags.has("kalshi-inventory-only"); const wantInventory = wantKalshi && (flags.has("kalshi-inventory") || inventoryOnly);
  if ((flags.has("kalshi-inventory") || inventoryOnly) && !wantKalshi) { log("--kalshi-inventory needs --kalshi or --venue kalshi; nothing was fetched."); return EXIT.CONFIG; }
  const targetedSpec = opts["us-targeted"] ?? (only === US_EXCHANGE ? "default" : undefined); // a US-only run reaches the per-sport quotas by default
  try {
    let ours: { raw: RawMarket; resolvedMs: number }[] | undefined;
    if (flags.has("with-db") && only && only !== INTERNATIONAL) log(`--with-db applies to polymarket_intl only (our resolution times are compared with ITS markets); ignored for --venue ${only}.`);
    else if (flags.has("with-db")) {
      if (!dbEnvOk(env) && !d.db) { log("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --with-db; the database was not touched."); return EXIT.CONFIG; }
      try { guard.setStage("our resolved markets (database + Gamma)", INTERNATIONAL); ours = await loadOurs(d.db ? d.db() : readOnly(supabaseDb()), http, 150); } catch (e) { if (e instanceof HeapBudgetExceeded) throw e; log(`database comparison skipped: ${(e as Error).message}`); }
    }
    mkdir(outDir); if (fixtureDir) mkdir(fixtureDir);
    const res = await runS1a({ http, us: usCfg, sampleOpen: num(opts["sample-open"], 300), sampleResolved: num(opts["sample-resolved"], 300), fetchFactor: num(opts["fetch-factor"], 3), usSports: targetedSpec === "default", usSportsMaxRequests: num(opts["us-sports-max-requests"], 400), usTargeted: targetedSpec === undefined || targetedSpec === "default" ? undefined : parseTargeted(targetedSpec), kalshi: wantKalshi ? kalshiConfig(opts) : null, kalshiMax: num(opts["kalshi-max"], KALSHI_DEFAULT_CAP), ours, now: d.now, fixtureDir, readFile: d.readFile ? (rel) => d.readFile!(`${outDir}/${rel}`) : undefined, write: (rel, content) => write(rel.startsWith(fixtureDir ?? "\u0000") ? rel : `${outDir}/${rel}`, content),
      only, guard, scope, heap: () => heapInfo(guard), kalshiInventory: wantInventory ? (base) => fetchKalshiInventory(http, base, { maxRequests: num(opts["kalshi-inventory-max-requests"], DEFAULT_INVENTORY_BUDGET) }) : null, kalshiInventoryOnly: inventoryOnly });
    for (const l of [...s1aSummaryLines(res, outDir, only), ...(res.kalshiInventory ? inventoryLines(res.kalshiInventory) : [])].slice(0, 60)) log(l);
    await printFiles(printList(opts), { outDir, readFile: d.readFile, log, sleep: d.sleep });
    return EXIT.OK;
  } catch (e) {
    if (e instanceof HeapBudgetExceeded) {
      log(e.message);
      if (only) { const stop: StopInfo = { reason: "heap_budget", stage: e.stage, message: e.message }; const now = new Date((d.now ?? Date.now)()).toISOString(); const stub: VenueAuditFile = { schema: EVIDENCE_SCHEMA, kind: "audit", venue: only, startedAt: now, finishedAt: now, heap: heapInfo(guard), stopped: stop, audit: null, sportsApi: null, inPlay: null, schedule: null, kalshiInventory: null, http: http.summary(), endpoints: [], docs: [], rules: {}, notEstablished: [`${only}: ${e.message}`] }; try { mkdir(outDir); write(`${outDir}/${evidenceFile(only, "audit")}`, JSON.stringify(stub)); log(`partial evidence file: ${outDir}/${evidenceFile(only, "audit")} (stopped; no audit result)`); } catch { /* the message above is the record */ } }
      return EXIT.BUDGET;
    }
    log(`timestamp audit failed: ${(e as Error).message}`); return EXIT.FAILED;
  }
}

/** The recommendations of one venue: its own `v_<venue>_audit.json` first, else the combined `s1a_summary.json` of an all-in-one run; null when neither holds any. */
function recommendationsFor(venue: VenueId, readFile: ((p: string) => string | null) | undefined, outDir: string, summaryPath: string, log: (l: string) => void): SlotVerdict[] | null {
  const own = parseEvidence<VenueAuditFile>(readFile ? readFile(`${outDir}/${evidenceFile(venue, "audit")}`) : null, "audit", venue);
  if (own?.audit?.recommendations?.length) return own.audit.recommendations;
  const txt = readFile ? readFile(summaryPath) : null; if (!txt) return null;
  try { const j = JSON.parse(txt) as { venues?: { venue: string; recommendations?: SlotVerdict[] }[] }; const r = j.venues?.find((v) => v.venue === venue)?.recommendations ?? null; return r && r.length ? r : null; } catch { log(`could not read ${summaryPath}: recommendations ignored`); return null; }
}

export async function runCoverageCli(argv: string[], env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const log = d.log ?? ((l: string) => console.log(l)); const { flags, opts } = parseArgs(argv);
  if (flags.has("help")) { log(COVERAGE_USAGE); return EXIT.OK; }
  const only = venueOpt(opts); if (only === "invalid") { log(`${VENUE_HELP} (got ${JSON.stringify(opts.venue)}); the database was not touched.`); return EXIT.CONFIG; }
  if (only && (flags.has("kalshi") || flags.has("no-venue") || flags.has("no-us"))) { log(`--venue ${only} contradicts --kalshi / --no-venue / --no-us (the venue flag decides what is fetched); the database was not touched.`); return EXIT.CONFIG; }
  if (!dbEnvOk(env) && !d.db) { log("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set; the database was not touched."); return EXIT.CONFIG; }
  const outDir = opts["out-dir"] ?? "docs/phase4/data"; const write = d.writeFile ?? (() => { throw new Error("no writer"); }); const mkdir = d.mkdir ?? (() => {});
  const mode = (["REALISTIC", "IDEAL", "CONSERVATIVE"].includes(opts.mode ?? "") ? opts.mode : "REALISTIC") as "REALISTIC" | "IDEAL" | "CONSERVATIVE";
  let startIso: string | undefined;
  if (opts.start !== undefined) { const p = parseTimestamp(opts.start); if (p.kind !== "datetime") { log(`--start must be an ISO-8601 datetime with a time zone, e.g. 2026-09-27T04:28:38Z (got ${JSON.stringify(opts.start)}); the database was not touched.`); return EXIT.CONFIG; } startIso = new Date(p.ms).toISOString(); }
  const guard = makeGuard(d, opts, only); const recPath = opts.recommendations ?? "docs/phase4/data/s1a_summary.json"; const scope = only ? new VenueScope(only) : null;
  let stage = "start";
  try {
    if (only) {
      // ───────── one venue, one process: only that venue's listing is ever fetched or held
      mkdir(outDir); const rdb = d.db ? d.db() : readOnly(supabaseDb()); const startedAt = new Date((d.now ?? Date.now)()).toISOString(); const recs = recommendationsFor(only, d.readFile, outDir, recPath, log);
      // the venue's own CSVs get the venue in their name; the JSON goes into the evidence file, not into the combined s1b_*.json files
      const writeCsv = (rel: string, c: string) => { if (rel.endsWith(".csv")) write(`${outDir}/v_${only}_${rel}`, c); };
      let result: CoverageResult | KalshiCoverageResult; let lines: string[];
      scope!.enter(only, "coverage");
      if (only === KALSHI) {
        const khttp = makeHttp(d, null, { guard }); guard.setStage("listing", KALSHI); const listing = await fetchKalshiListing(khttp, kalshiConfig(opts), num(opts["kalshi-max"], KALSHI_DEFAULT_CAP));
        result = await runKalshiCoverage({ db: rdb, listing, recommendations: recs, startIso, now: d.now, write: writeCsv, guard }); lines = kalshiCoverageSummaryLines(result, outDir);
      } else {
        const usCfg = only === US_EXCHANGE ? usConfig(opts, flags) : null; const http = usCfg ? makeHttp(d, usCfg, { guard }) : null;
        // the international platform is the signal source: its coverage run is the database side only (the signal window, the category mix, the settled paper trades), no venue listing
        result = await runCoverage({ db: rdb, http, us: usCfg, recommendations: recs, now: d.now, mode, startIso, maxUsMarkets: opts["us-max"] === undefined ? undefined : num(opts["us-max"], 6000), diagnose: only === INTERNATIONAL ? true : flags.has("diagnose"), diagnosticSample: num(opts["diagnostic-sample"], 100), write: writeCsv, guard }); lines = coverageSummaryLines(result, outDir);
      }
      const file: VenueCoverageFile = { schema: EVIDENCE_SCHEMA, kind: "coverage", venue: only, startedAt, finishedAt: new Date((d.now ?? Date.now)()).toISOString(), heap: heapInfo(guard), stopped: null, result };
      write(`${outDir}/${evidenceFile(only, "coverage")}`, JSON.stringify(file)); for (const l of [...lines.slice(0, 58), `file in ${outDir}: ${evidenceFile(only, "coverage")} (single-venue run; combine with npm run phase4:merge)`]) log(l);
      await printFiles(printList(opts), { outDir, readFile: d.readFile, log, sleep: d.sleep }); return EXIT.OK;
    }
    const recs = recommendationsFor(US_EXCHANGE, d.readFile, outDir, recPath, log);
    const useVenue = !flags.has("no-venue"); const usCfg = useVenue ? usConfig(opts, flags) : null; const http = useVenue ? makeHttp(d, usCfg, { guard }) : null;
    mkdir(outDir); const rdb = d.db ? d.db() : readOnly(supabaseDb());
    stage = "us coverage"; const res = await runCoverage({ db: rdb, http, us: usCfg, recommendations: recs, now: d.now, mode, startIso, maxUsMarkets: opts["us-max"] === undefined ? undefined : num(opts["us-max"], 6000), diagnose: flags.has("diagnose"), diagnosticSample: num(opts["diagnostic-sample"], 100), write: (rel, c) => write(`${outDir}/${rel}`, c), guard });
    let kres: KalshiCoverageResult | null = null;
    if (flags.has("kalshi")) {
      // Kalshi, from the SAME signal window as the US run
      const krecs = recommendationsFor(KALSHI, d.readFile, outDir, recPath, log);
      stage = "kalshi coverage"; const khttp = makeHttp(d, null, { guard }); guard.setStage("listing", KALSHI); const listing = await fetchKalshiListing(khttp, kalshiConfig(opts), num(opts["kalshi-max"], KALSHI_DEFAULT_CAP));
      kres = await runKalshiCoverage({ db: rdb, listing, recommendations: krecs, startIso, endIso: res.window.endIso, now: d.now, write: (rel, c) => write(`${outDir}/${rel}`, c), guard });
    }
    if (kres) for (const l of coverageCombinedLines(res, kres, outDir)) log(l); else for (const l of coverageSummaryLines(res, outDir)) log(l);
    // S1_COMPACT.md: the slot rows come from s1a_summary.json, the funnels from this run's files
    const rf = (rel: string): string | null => (d.readFile ? d.readFile(`${outDir}/${rel}`) : null); writeCompact(rf, (rel, c) => write(`${outDir}/${rel}`, c));
    await printFiles(printList(opts), { outDir, readFile: d.readFile, log, sleep: d.sleep });
    return EXIT.OK;
  } catch (e) {
    if (e instanceof HeapBudgetExceeded) {
      log(e.message);
      if (only) { const now = new Date((d.now ?? Date.now)()).toISOString(); const file: VenueCoverageFile = { schema: EVIDENCE_SCHEMA, kind: "coverage", venue: only, startedAt: now, finishedAt: now, heap: heapInfo(guard), stopped: { reason: "heap_budget", stage: e.stage, message: e.message }, result: null }; try { mkdir(outDir); write(`${outDir}/${evidenceFile(only, "coverage")}`, JSON.stringify(file)); log(`partial evidence file: ${outDir}/${evidenceFile(only, "coverage")} (stopped; no coverage result)`); } catch { /* the message above is the record */ } }
      else log(`(all-in-one run, ${stage}): run each venue in its own process with --venue`);
      return EXIT.BUDGET;
    }
    log(`coverage probe failed: ${(e as Error).message}`); return EXIT.FAILED;
  }
}

const f1c = (x: number | null | undefined) => (x === null || x === undefined ? "n/m" : x.toFixed(1));
/** ≤ 60 printed lines when the US exchange and Kalshi are measured in one run: one funnel table with both venues, the mapping and diagnostic lines, the three-way category table. */
export function coverageCombinedLines(us: CoverageResult, k: KalshiCoverageResult, outDir: string): string[] {
  const L: string[] = [`S1b coverage  ${us.window.startIso} → ${us.window.endIso}  (${us.funnel.window.elapsedDays.toFixed(1)} days; both venues, same signals)`, `signals ${us.counts.signals} · score ≥ 68: ${us.counts.withScore} · US candidates ${us.venue.candidates} · Kalshi candidates ${k.listing.candidates} (${k.listing.base ?? "no base answered"})`];
  for (const x of us.venue.reasons.slice(0, 3)) L.push(`US NOT MEASURED: ${x}`.slice(0, 200)); for (const x of k.reasons.slice(0, 3)) L.push(`KALSHI NOT MEASURED: ${x}`.slice(0, 200));
  const ue = us.funnel.variants.EXACT, up = us.funnel.variants.EXACT_PLUS_PROBABLE, ke = k.funnel.variants.EXACT, kp = k.funnel.variants.EXACT_PLUS_PROBABLE;
  L.push("stage (cumulative)                      US exact / +prob (per day)      | Kalshi exact / +prob (per day)");
  us.funnel.stages.forEach((st, i) => L.push(`${st.label.slice(0, 38).padEnd(38)} ${`${ue.counts[i] ?? "n/m"} / ${up.counts[i] ?? "n/m"} (${f1c(ue.perDay[st.key]?.perElapsedDay)})`.padEnd(30)}| ${ke.counts[i] ?? "n/m"} / ${kp.counts[i] ?? "n/m"} (${f1c(ke.perDay[st.key]?.perElapsedDay)})`));
  L.push(`mapping (score ≥ 68 pairs): US EXACT ${us.mappingBuckets.EXACT} PROBABLE ${us.mappingBuckets.PROBABLE} NONE ${us.mappingBuckets.NONE} | Kalshi EXACT ${k.mappingBuckets.EXACT} PROBABLE ${k.mappingBuckets.PROBABLE} NONE ${k.mappingBuckets.NONE}`);
  if (us.diagnostic?.summary) L.push(`US timestamp-free diagnostic best band: ${Object.entries(us.diagnostic.summary.byBestBand).map(([b, n]) => `${b} ${n}`).join(" · ")}`);
  if (k.diagnostic) L.push(`Kalshi timestamp-free diagnostic best band: ${Object.entries(k.diagnostic.byBestBand).map(([b, n]) => `${b} ${n}`).join(" · ")}`);
  if (k.listing.counts) L.push(`Kalshi listing: ${k.listing.counts.total} markets, ${k.listing.counts.distinctEvents} events; ${Object.entries(k.listing.counts.byBucket).map(([a, n]) => `${a} ${n}`).join(" · ")}${k.listing.cutOff ? " · CUT OFF at the cap (lower bounds)" : ""}`);
  const ours68 = Object.fromEntries(k.mix.map((x) => [x.stratum, x.oursScore68Signals])); const kC = k.listing.base ? Object.fromEntries(k.mix.map((x) => [x.stratum, x.kalshiMarkets])) : null; const uC = us.diagnostic ? Object.fromEntries(us.diagnostic.categoryMix.map((x) => [x.stratum, x.venueMarkets])) : null;
  L.push(...mix3Lines(categoryMix3(ours68, kC, uC)));
  L.push(`final stage wallets: US ${ue.wallets[ue.wallets.length - 1] ?? "n/m"} · Kalshi ${ke.wallets[ke.wallets.length - 1] ?? "n/m"}; E1 and feasibility: see s1b_funnel.json / s1b_feasibility.json`);
  L.push(`files in ${outDir}: s1b_funnel.json s1b_funnel_kalshi.json s1b_feasibility.json s1b_mapping_review*.csv S1_COMPACT.md`);
  return L.map((l) => (l.length > 220 ? l.slice(0, 217) + "..." : l)).slice(0, 60);
}

/** `npm run phase4:title-search`: every distinct market+outcome pair behind our entry signals, looked up on each US-accessible venue (read-only). `--venue polymarket_us|kalshi` runs ONE venue in its own process. */
export async function runTitleSearchCli(argv: string[], env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const log = d.log ?? ((l: string) => console.log(l)); const { flags, opts } = parseArgs(argv);
  if (flags.has("help")) { log(TITLE_SEARCH_USAGE); return EXIT.OK; }
  if (!dbEnvOk(env) && !d.db) { log("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set; the database was not touched."); return EXIT.CONFIG; }
  const outDir = opts["out-dir"] ?? "docs/phase4/data"; const write = d.writeFile ?? (() => { throw new Error("no writer"); }); const mkdir = d.mkdir ?? (() => {});
  const which = opts.venue ?? "both"; const only: VenueId | null = which === "both" ? null : parseVenueId(which);
  if (which !== "both" && !only) { log(`--venue must be polymarket_us, kalshi or both (got ${JSON.stringify(which)}); the database was not touched.`); return EXIT.CONFIG; }
  if (only === INTERNATIONAL) { log("polymarket_intl is the signal source: there is nothing to search on it (the title search looks our markets up on the execution venues); the database was not touched."); return EXIT.CONFIG; }
  let startIso = COVERAGE_REGIME_START_ISO; if (opts.start !== undefined) { const p = parseTimestamp(opts.start); if (p.kind !== "datetime") { log(`--start must be an ISO-8601 datetime with a time zone, e.g. 2026-09-27T04:28:38Z (got ${JSON.stringify(opts.start)}); the database was not touched.`); return EXIT.CONFIG; } startIso = new Date(p.ms).toISOString(); }
  const budget = num(opts["search-max-requests"], DEFAULT_SEARCH_BUDGET); const now = d.now ?? (() => Date.now()); const guard = makeGuard(d, opts, only); const scope = only ? new VenueScope(only) : null;
  // the US pace: never below the polite floor; a slower pace is allowed for a LATER run, and the pace used is recorded
  const paceAsked = opts["us-search-pace-ms"] === undefined ? null : Number(opts["us-search-pace-ms"]); if (paceAsked !== null && !(Number.isFinite(paceAsked) && paceAsked > 0)) { log(`--us-search-pace-ms must be a positive number of milliseconds (got ${JSON.stringify(opts["us-search-pace-ms"])}); the database was not touched.`); return EXIT.CONFIG; }
  const usPace = Math.max(US_MIN_INTERVAL_MS, paceAsked ?? 0); if (paceAsked !== null && paceAsked < US_MIN_INTERVAL_MS) log(`--us-search-pace-ms ${paceAsked} is below the polite floor: using ${US_MIN_INTERVAL_MS} ms`);
  let pairs: SearchPair[] = []; const startedAt = new Date(now()).toISOString(); const venuesRun: VenueId[] = only ? [only] : [US_EXCHANGE, KALSHI]; let currentVenue: VenueId = venuesRun[0];
  const results: { r: TitleSearchResult; listingCutOff: boolean | null; listingMarkets: number | null }[] = []; let stopped: StopInfo | null = null; let windowEnd = startedAt;
  try {
    mkdir(outDir); const rdb = d.db ? d.db() : readOnly(supabaseDb());
    pairs = await loadSearchPairs(rdb, startIso, windowEnd); if (!flags.has("all-scores")) pairs = pairs.filter((p) => p.score !== null && p.score >= 68);
    for (const v of venuesRun) {
      currentVenue = v; scope?.enter(v, "title search");
      if (v === US_EXCHANGE) {
        const cfg: UsConfig = { ...US_DEFAULTS, base: opts["us-base"] ?? US_DEFAULTS.base, searchPath: opts["us-search-path"] ?? US_DEFAULTS.searchPath }; guard.setStage("title search", US_EXCHANGE);
        let prior: TitleSearchRow[] | undefined;
        if (flags.has("resume") || opts["resume-from"] !== undefined) { const f = parseEvidence<VenueTitlesFile>(d.readFile ? d.readFile(opts["resume-from"] ?? `${outDir}/${evidenceFile(v, "titles")}`) : null, "titles", v); if (f) prior = f.rows; else log(`--resume: no usable ${evidenceFile(v, "titles")} found; starting from the first pair`); }
        results.push({ r: await runTitleSearch(pairs, usSearchProvider(makeHttp(d, cfg, { guard, usPaceMs: usPace }), cfg), { maxRequests: budget, prior, paceMs: usPace }), listingCutOff: null, listingMarkets: null });
      } else {
        guard.setStage("listing", KALSHI); let listing: KalshiListing | null = await fetchKalshiListing(makeHttp(d, null, { guard }), kalshiConfig(opts), num(opts["kalshi-max"], KALSHI_DEFAULT_CAP));
        guard.setStage("matching", KALSHI); const refs = listing.base ? kalshiAllMarkets(listing).map(kalshiRefOf).filter((x): x is NonNullable<typeof x> => !!x) : [];
        const cut = [listing.open, listing.closed, listing.settled].some((f) => f && f.notes.records > 0 && /sample size reached|page limit reached/.test(f.notes.stoppedBecause)); const tried = listing.tried; const base = listing.base; listing = null; // the raw listing is no longer needed: the refs carry what the lookup reads
        const provider: SearchProvider = listingSearchProvider("kalshi", refs, `lookup in the bounded Kalshi listing (${refs.length} markets${cut ? ", CUT OFF at the cap: a lower bound" : ", complete"}); no documented free-text search endpoint`);
        const r = await runTitleSearch(pairs, provider, { maxRequests: budget }); if (!base) r.summary.stoppedBecause = `Kalshi unreachable (${tried.map((t) => `${t.base}: ${t.outcome}`).join("; ")}): nothing to look up in`; results.push({ r, listingCutOff: cut, listingMarkets: refs.length });
      }
      if (results[results.length - 1].r.stopped) { stopped = results[results.length - 1].r.stopped!; break; }
    }
  } catch (e) {
    if (!(e instanceof HeapBudgetExceeded)) { log(`title search failed: ${(e as Error).message}`); return EXIT.FAILED; }
    log(e.message); stopped = { reason: "heap_budget", stage: e.stage, message: e.message };
    if (only) { const empty: TitleSearchSummary = emptyTitleSummary(only, e.message); results.push({ r: { rows: [], summary: empty, stopped }, listingCutOff: null, listingMarkets: null }); }
  }
  for (const { r } of results) write(`${outDir}/s1b_title_search_${r.summary.venue}.csv`, titleSearchCsv(r.rows));
  for (const { r, listingCutOff, listingMarkets } of results) { if (!only) break; const f: VenueTitlesFile = { schema: EVIDENCE_SCHEMA, kind: "titles", venue: only, startedAt, finishedAt: new Date(now()).toISOString(), window: { startIso, endIso: windowEnd }, allScores: flags.has("all-scores"), listingCutOff, listingMarkets, unsearched: unsearchedOf(pairs, r.rows), summary: r.summary, stopped: r.stopped ?? stopped, heap: heapInfo(guard), rows: r.rows }; write(`${outDir}/${evidenceFile(only, "titles")}`, JSON.stringify(f)); }
  if (!only) write(`${outDir}/s1b_title_search_summary.json`, JSON.stringify(results.map(({ r }) => r.summary), null, 1));
  for (const l of titleSearchSummaryLines(results.map((x) => x.r), outDir, only)) log(l);
  if (stopped?.reason === "heap_budget") { log(`(stopped at ${currentVenue}: the rows searched so far were written${only ? ` to ${evidenceFile(only, "titles")}` : ""})`); await printFiles(printList(opts), { outDir, readFile: d.readFile, log, sleep: d.sleep }); return EXIT.BUDGET; }
  await printFiles(printList(opts), { outDir, readFile: d.readFile, log, sleep: d.sleep });
  return EXIT.OK;
}
