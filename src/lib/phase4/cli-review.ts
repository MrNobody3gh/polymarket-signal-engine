/**
 * Phase 4.0d — command-line entry points of the four commands that work on the per-venue evidence files, with every effect injected (as cli.ts):
 *   `npm run phase4:merge`          the evidence files → S1a_RESULTS.md, S1_COMPACT.md, FEASIBILITY_MATRIX.md, S1b_FUNNELS.md   (no network, no database)
 *   `npm run phase4:review-sheet`   v_<venue>_titles.json → s1d_review_<venue>.csv, the stratified sample for the owner               (no network, no database)
 *   `npm run phase4:review-ingest`  the owner's filled sheet → s1d_review_results_<venue>.json                                      (no network, no database)
 *   `npm run phase4:wallet-share`   our entry signals (select only) + v_<venue>_titles.json → per-wallet / per-category proposed share (research only)
 * Exit codes as cli.ts: 0 finished, 1 failed, 2 configuration or input error (nothing computed).
 */
import { EXIT, parseArgs, num, printFiles, type CliDeps } from "./cli";
import { readOnly, type ReadOnlyDb } from "./readonly-db";
import { db as supabaseDb } from "../db";
import { runMerge } from "./merge";
import { parseVenueId, EVIDENCE_SCHEMA, evidenceFile, parseEvidence, type VenueId } from "./venue-run";
import type { VenueTitlesFile } from "./title-search";
import { DEFAULT_SAMPLE, REVIEW_SEED, STRATUM_LABEL, buildReviewSample, ingestLines, ingestReview, quotas, reviewSheetCsv } from "./review";
import { STOP_RULE_PATH, stampOf } from "./stop-rule";
import { loadWalletSignals, renderWalletShare, walletShare, walletShareLines } from "./wallet-share";
import { COVERAGE_REGIME_START_ISO } from "./venue-funnel";
import { reviewResultsFile } from "./merge";
import { parseTimestamp } from "./timestamps";

const printList = (opts: Record<string, string>) => (opts["print-files"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const dbEnvOk = (env: Record<string, string | undefined>) => !!env.NEXT_PUBLIC_SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;
const writer = (d: CliDeps) => d.writeFile ?? (() => { throw new Error("no writer"); });

export const MERGE_USAGE = "usage: npm run phase4:merge -- [--out-dir docs/phase4/data] [--stop-rule docs/phase4/stop_rule.json] [--print-files a,b]   (reads the per-venue files only; no network, no database)";
export const REVIEW_SHEET_USAGE = "usage: npm run phase4:review-sheet -- --venue polymarket_us|kalshi [--n 60] [--seed STRING] [--include-below-68] [--out-dir docs/phase4/data] [--print-files]   (no network, no database)";
export const REVIEW_INGEST_USAGE = "usage: npm run phase4:review-ingest -- --file <filled csv> [--out-dir docs/phase4/data] [--stop-rule docs/phase4/stop_rule.json] [--print-files]   (no network, no database)";
export const WALLET_SHARE_USAGE = "usage: npm run phase4:wallet-share -- --venue polymarket_us|kalshi [--out-dir docs/phase4/data] [--start 2026-09-27T04:28:38Z] [--min-signals 5] [--print-files]   (reads our database with select only; research: not a strategy change and not a recommendation)";

export async function runMergeCli(argv: string[], _env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const log = d.log ?? ((l: string) => console.log(l)); const { flags, opts } = parseArgs(argv); if (flags.has("help")) { log(MERGE_USAGE); return EXIT.OK; }
  const outDir = opts["out-dir"] ?? "docs/phase4/data"; const write = writer(d); const read = d.readFile ?? (() => null);
  try {
    const m = runMerge({ read, outDir, stopRulePath: opts["stop-rule"] ?? STOP_RULE_PATH }); d.mkdir?.(outDir);
    for (const [name, text] of Object.entries(m.files)) write(`${outDir}/${name}`, text);
    for (const l of m.lines) log(l);
    await printFiles(printList(opts), { outDir, readFile: (p) => (read(p) ?? m.files[p.replace(`${outDir}/`, "")] ?? null), log, sleep: d.sleep });
    return EXIT.OK;
  } catch (e) { log(`merge failed: ${(e as Error).message}`); return EXIT.FAILED; }
}

export async function runReviewSheetCli(argv: string[], _env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const log = d.log ?? ((l: string) => console.log(l)); const { flags, opts } = parseArgs(argv); if (flags.has("help")) { log(REVIEW_SHEET_USAGE); return EXIT.OK; }
  const venue = parseVenueId(opts.venue); if (!venue || venue === "polymarket_intl") { log("--venue must be polymarket_us or kalshi (the venues a title search runs on)."); return EXIT.CONFIG; }
  const outDir = opts["out-dir"] ?? "docs/phase4/data"; const n = num(opts.n, DEFAULT_SAMPLE); const seed = opts.seed ?? REVIEW_SEED; const write = writer(d);
  const f = parseEvidence<VenueTitlesFile>(d.readFile ? d.readFile(`${outDir}/${evidenceFile(venue, "titles")}`) : null, "titles", venue);
  if (!f) { log(`no usable ${outDir}/${evidenceFile(venue, "titles")}: run \`npm run phase4:title-search -- --venue ${venue}\` first (in the same container if the files are not kept).`); return EXIT.CONFIG; }
  try {
    const s = buildReviewSample(f.rows, { venue, n, seed, includeBelow68: flags.has("include-below-68") }); const name = `s1d_review_${venue}.csv`;
    d.mkdir?.(outDir); write(`${outDir}/${name}`, reviewSheetCsv(s, { venue, seed, unsearched: f.unsearched }));
    const q = quotas(n); const L = [`review sheet for ${venue}: ${s.picked.length} rows (wanted ${n}: ${STRATUM_LABEL.A.slice(0, 2)} ${q.A}, B ${q.B}, C ${q.C}) from ${s.pool} pairs searched${f.unsearched.pairs ? `; ${f.unsearched.pairs} pairs (${f.unsearched.signals} signals) were NOT searched and are treated as unknown` : ""}; seed ${JSON.stringify(seed)}`, "band         pairs  signals  sampled"];
    for (const b of s.bands) L.push(`${b.band.padEnd(11)} ${String(b.pairs).padStart(6)} ${String(b.signals).padStart(8)} ${String(b.sampled).padStart(8)}`);
    for (const x of s.short) L.push(`SHORT: stratum ${x.stratum} wanted ${x.wanted}, only ${x.got} pairs available`);
    L.push(`file: ${outDir}/${name} (fill QUESTION, OUTCOME, TIME, RESOLUTION with Y / N / U on every row; see docs/phase4/REVIEW_GUIDE.md), then \`npm run phase4:review-ingest -- --file <your file>\``); for (const l of L) log(l);
    if (flags.has("print-files") || opts["print-files"] !== undefined) await printFiles(opts["print-files"] ? printList(opts) : [name], { outDir, readFile: (p) => (d.readFile ? d.readFile(p) : null), log, sleep: d.sleep });
    return EXIT.OK;
  } catch (e) { log(`review sheet failed: ${(e as Error).message}`); return EXIT.FAILED; }
}

export async function runReviewIngestCli(argv: string[], _env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const log = d.log ?? ((l: string) => console.log(l)); const { flags, opts } = parseArgs(argv); if (flags.has("help")) { log(REVIEW_INGEST_USAGE); return EXIT.OK; }
  if (!opts.file) { log("--file <filled csv> is required."); return EXIT.CONFIG; }
  const text = d.readFile ? d.readFile(opts.file) : null; if (text === null) { log(`cannot read ${opts.file}`); return EXIT.CONFIG; }
  const outDir = opts["out-dir"] ?? "docs/phase4/data"; const rulePath = opts["stop-rule"] ?? STOP_RULE_PATH; const write = writer(d); const now = new Date((d.now ?? Date.now)()).toISOString();
  try {
    const out = ingestReview(text, { file: opts.file, now, stopRule: stampOf(rulePath, d.readFile ? d.readFile(rulePath) : null) });
    if (!out.ok) { log(`the sheet was not accepted; nothing was computed or written (${out.errors.length} problem${out.errors.length === 1 ? "" : "s"}):`); for (const e of out.errors.slice(0, 40)) log(`  ${e}`); return EXIT.CONFIG; }
    const v = parseVenueId(out.results.venue) as VenueId; d.mkdir?.(outDir); write(`${outDir}/${reviewResultsFile(v)}`, JSON.stringify(out.results, null, 1)); write(`${outDir}/s1d_review_results_${v}.csv`, out.csv);
    for (const l of ingestLines(out.results)) log(l); log(`files in ${outDir}: ${reviewResultsFile(v)} s1d_review_results_${v}.csv (read by phase4:merge)`);
    if (flags.has("print-files") || opts["print-files"] !== undefined) await printFiles(opts["print-files"] ? printList(opts) : [reviewResultsFile(v)], { outDir, readFile: (p) => (d.readFile ? d.readFile(p) : null), log, sleep: d.sleep });
    return EXIT.OK;
  } catch (e) { log(`review ingest failed: ${(e as Error).message}`); return EXIT.FAILED; }
}

export async function runWalletShareCli(argv: string[], env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const log = d.log ?? ((l: string) => console.log(l)); const { flags, opts } = parseArgs(argv); if (flags.has("help")) { log(WALLET_SHARE_USAGE); return EXIT.OK; }
  const venue = parseVenueId(opts.venue); if (!venue || venue === "polymarket_intl") { log("--venue must be polymarket_us or kalshi."); return EXIT.CONFIG; }
  if (!dbEnvOk(env) && !d.db) { log("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set; the database was not touched."); return EXIT.CONFIG; }
  const outDir = opts["out-dir"] ?? "docs/phase4/data"; const write = writer(d);
  const f = parseEvidence<VenueTitlesFile>(d.readFile ? d.readFile(`${outDir}/${evidenceFile(venue, "titles")}`) : null, "titles", venue);
  if (!f) { log(`no usable ${outDir}/${evidenceFile(venue, "titles")}: run the title search for this venue first (with --all-scores, so every wallet's signals are searched); the database was not touched.`); return EXIT.CONFIG; }
  let startIso = f.window.startIso || COVERAGE_REGIME_START_ISO; if (opts.start !== undefined) { const p = parseTimestamp(opts.start); if (p.kind !== "datetime") { log(`--start must be an ISO-8601 datetime with a time zone (got ${JSON.stringify(opts.start)}); the database was not touched.`); return EXIT.CONFIG; } startIso = new Date(p.ms).toISOString(); }
  const endIso = f.window.endIso || new Date((d.now ?? Date.now)()).toISOString();
  try {
    const rdb: ReadOnlyDb = d.db ? d.db() : readOnly(supabaseDb()); const signals = await loadWalletSignals(rdb, startIso, endIso);
    const r = walletShare({ venue, signals, rows: f.rows, elapsedDays: (Date.parse(endIso) - Date.parse(startIso)) / 86_400_000, minSignals: num(opts["min-signals"], 5) });
    if (!f.allScores) r.notes.push("the title search covered only the score ≥ 68 pairs (it was run without --all-scores): wallets' other signals are unknown, not zero.");
    d.mkdir?.(outDir); write(`${outDir}/v_${venue}_wallets.json`, JSON.stringify({ schema: EVIDENCE_SCHEMA, kind: "wallets", ...r }, null, 1)); write(`${outDir}/WALLET_SHARE_${venue}.md`, renderWalletShare(r));
    for (const l of walletShareLines(r, outDir)) log(l);
    if (flags.has("print-files") || opts["print-files"] !== undefined) await printFiles(opts["print-files"] ? printList(opts) : [`WALLET_SHARE_${venue}.md`], { outDir, readFile: (p) => (d.readFile ? d.readFile(p) : null), log, sleep: d.sleep });
    return EXIT.OK;
  } catch (e) { log(`wallet share failed: ${(e as Error).message}`); return EXIT.FAILED; }
}
