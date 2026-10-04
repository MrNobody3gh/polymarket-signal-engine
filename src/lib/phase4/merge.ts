/**
 * Phase 4.0d, Part A2 — `npm run phase4:merge`. Reads ONLY the per-venue evidence files in the output directory (`v_<venue>_audit|coverage|titles.json`,
 * `s1d_review_results_<venue>.json`) and the stop rule; produces `S1a_RESULTS.md`, `S1_COMPACT.md` (≤ 80 lines), `FEASIBILITY_MATRIX.md` (≤ 100 lines) and
 * `S1b_FUNNELS.md` (the funnel tables). NO NETWORK AND NO DATABASE: this module imports neither (tests/phase4-merge.test.ts checks the imports). A venue with no
 * file is "not run", a venue whose run stopped is "stopped"; neither is ever shown as zero.
 */
import { renderS1aMarkdown, type S1aResult, type VenueAudit, type VenueAuditFile } from "./s1a";
import { renderCompact, type CompactInput, type S1aSummaryLike } from "./compact";
import type { CoverageResult, VenueCoverageFile } from "./probe";
import type { KalshiCoverageResult } from "./venue-funnel";
import type { VenueTitlesFile } from "./title-search";
import type { ReviewResults } from "./review";
import { buildMatrix, renderMatrix, type MatrixResult, type VenueFiles } from "./matrix";
import { parseStopRule, STOP_RULE_PATH } from "./stop-rule";
import { EVIDENCE_SCHEMA, VENUE_IDS, VENUE_LABEL, evidenceFile, parseEvidence, type VenueId } from "./venue-run";
import { inventoryMarkdown } from "./kalshi-inventory";
import { STAGES } from "./funnel";
import { SIMILARITY_BANDS } from "./mapping";
import { RECOMMEND_RULES } from "./audit";

export const reviewResultsFile = (venue: VenueId) => `s1d_review_results_${venue}.json`;
const parseReview = (text: string | null, venue: VenueId): ReviewResults | null => { if (!text) return null; try { const j = JSON.parse(text) as ReviewResults; return j && j.kind === "review" && j.schema === EVIDENCE_SCHEMA && j.venue === venue ? j : null; } catch { return null; } };

export interface MergeInput { read: (path: string) => string | null; outDir: string; stopRulePath?: string }
export interface MergeOutput { files: Record<string, string>; lines: string[]; matrix: MatrixResult; venues: VenueFiles[] }

/** The files of every venue (missing = null). */
export function loadVenueFiles(read: (p: string) => string | null, outDir: string): VenueFiles[] {
  return VENUE_IDS.map((venue) => ({ venue, audit: parseEvidence<VenueAuditFile>(read(`${outDir}/${evidenceFile(venue, "audit")}`), "audit", venue), coverage: parseEvidence<VenueCoverageFile>(read(`${outDir}/${evidenceFile(venue, "coverage")}`), "coverage", venue), titles: parseEvidence<VenueTitlesFile>(read(`${outDir}/${evidenceFile(venue, "titles")}`), "titles", venue), review: parseReview(read(`${outDir}/${reviewResultsFile(venue)}`), venue) }));
}

const SHORT_STATUS = (f: { stopped?: { reason: string } | null } | null) => (!f ? "not run" : f.stopped ? `STOPPED (${f.stopped.reason})` : "run");
/** S1a_RESULTS.md from the audit files: the existing renderer, over the venues that finished, with every other venue listed as not run or stopped. */
export function composeS1a(venues: VenueFiles[], outDir: string): { result: S1aResult; markdown: string; summary: S1aSummaryLike } {
  const audits = venues.map((v) => ({ venue: v.venue, f: v.audit })); const done = audits.filter((a) => a.f?.audit).map((a) => a.f!.audit as VenueAudit);
  const notEstablished: string[] = [];
  for (const { venue, f } of audits) { if (!f) notEstablished.push(`${venue}: NOT RUN (no ${evidenceFile(venue, "audit")} in ${outDir}); not a zero`); else if (f.stopped) notEstablished.push(`${venue}: STOPPED at stage "${f.stopped.stage}": ${f.stopped.message}`); else if (!f.audit) notEstablished.push(`${venue}: audit file without a venue audit (${f.notEstablished[0] ?? "inventory-only run"})`); else for (const x of f.notEstablished) if (x.startsWith(`${venue}:`) && !x.includes("not run in this process")) notEstablished.push(x); }
  const present = audits.filter((a) => a.f).map((a) => a.f!); const http = { requests: 0, ok: 0, byKind: {} as Record<string, number>, firstErrors: [] as string[] };
  for (const f of present) { http.requests += f.http.requests; http.ok += f.http.ok; for (const [k, n] of Object.entries(f.http.byKind)) http.byKind[k] = (http.byKind[k] ?? 0) + n; http.firstErrors.push(...f.http.firstErrors); } http.firstErrors = http.firstErrors.slice(0, 5);
  const us = venues.find((v) => v.venue === "polymarket_us")?.audit, ka = venues.find((v) => v.venue === "kalshi")?.audit;
  const startedAt = present.map((f) => f.startedAt).sort()[0] ?? "n/m", finishedAt = present.map((f) => f.finishedAt).sort().slice(-1)[0] ?? "n/m";
  const result: S1aResult = { startedAt, finishedAt, venues: done, eventAgreement: null, venueAgreement: { available: false, reason: "the venues were audited in separate processes (4.0d, one venue per process): the cross-venue start-time comparison needs two listings in one process and is not made", matched: 0, byConfidence: {}, summary: [] }, http, endpoints: [...new Set(present.flatMap((f) => f.endpoints))], docs: [...new Set(present.flatMap((f) => f.docs))], rules: { ...RECOMMEND_RULES }, notEstablished, sportsApi: us?.sportsApi ?? null, inPlay: us?.inPlay ?? null, schedule: { us: us?.schedule?.us ?? [], kalshi: ka?.schedule?.kalshi ?? [], notes: [...(us?.schedule?.notes ?? []), ...(ka?.schedule?.notes ?? [])] }, kalshiInventory: ka?.kalshiInventory ?? null };
  let markdown = renderS1aMarkdown(result);
  if (result.kalshiInventory) markdown += "\n" + inventoryMarkdown(result.kalshiInventory);
  markdown += `\n## Venue runs merged\n\n| venue | audit file | status |\n|---|---|---|\n${audits.map((a) => `| ${a.venue} | ${evidenceFile(a.venue, "audit")} | ${SHORT_STATUS(a.f)} |`).join("\n")}\n`;
  const summary: S1aSummaryLike = { startedAt, finishedAt, venues: audits.map(({ venue, f }) => (f?.audit ? { venue, reachable: f.audit.reachable, recommendations: f.audit.recommendations, status: "run" as const } : { venue, reachable: false, status: f?.stopped ? ("stopped" as const) : ("not_run" as const) })) };
  return { result, markdown, summary };
}

const f1 = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "n/m" : x.toFixed(d));
const pc = (x: number | null | undefined) => (x === null || x === undefined ? "n/m" : `${(x * 100).toFixed(0)} %`);
/** S1b_FUNNELS.md: per execution venue the cumulative funnel (EXACT / +PROBABLE and per day), the mapping buckets, the title-search bands, the listing counts and the category mix; "not run" where a file is missing. */
export function renderFunnels(venues: VenueFiles[]): string {
  const L = ["# S1b funnels and title-search bands per venue (generated by `npm run phase4:merge`)", "", "Cumulative counts; n/m = a stage that was not measured; **not run** = no evidence file (never a zero). EXACT/PROBABLE need a venue date on both sides: while no time field passes the funnel is zero by construction, so the similarity bands below are the informative numbers. Every mapping is a candidate for review, never verified.", ""];
  for (const v of venues) {
    L.push(`## ${VENUE_LABEL[v.venue]}`, "");
    const res = v.coverage?.result ?? null;
    if (!v.coverage) L.push(`Coverage: **not run** (no ${evidenceFile(v.venue, "coverage")}).`, ""); else if (v.coverage.stopped || !res) L.push(`Coverage: **STOPPED** at stage "${v.coverage.stopped?.stage}": ${v.coverage.stopped?.message}`, "");
    else {
      const fn = res.funnel; const ex = fn.variants.EXACT, pr = fn.variants.EXACT_PLUS_PROBABLE;
      L.push(`Window ${new Date(fn.window.startMs).toISOString()} → ${new Date(fn.window.endMs).toISOString()} (${f1(fn.window.elapsedDays)} days) · signals ${res.counts.signals} · score ≥ 68: ${res.counts.withScore} · mapped buckets (score ≥ 68 pairs): EXACT ${res.mappingBuckets.EXACT} · PROBABLE ${res.mappingBuckets.PROBABLE} · NONE ${res.mappingBuckets.NONE}.`, "");
      if (v.venue !== "polymarket_intl") { L.push("| stage | EXACT | /day | + PROBABLE |", "|---|---|---|---|"); STAGES.forEach((s, i) => L.push(`| ${s.label} | ${ex.counts[i] ?? "n/m"} | ${f1(ex.perDay[s.key]?.perElapsedDay)} | ${pr.counts[i] ?? "n/m"} |`)); L.push(""); }
      const reasons = "reasons" in res ? (res as KalshiCoverageResult).reasons : (res as CoverageResult).venue.reasons; for (const x of reasons.slice(0, 4)) L.push(`- NOT MEASURED / NOTE: ${x}`);
      if ("listing" in res && (res as KalshiCoverageResult).listing.counts) { const c = (res as KalshiCoverageResult).listing; L.push(`- Kalshi listing: ${c.counts!.total} markets, ${c.counts!.distinctEvents} events; ${Object.entries(c.counts!.byBucket).map(([k, n]) => `${k} ${n}`).join(" · ")}${c.cutOff ? " · CUT OFF at the cap (every count is a lower bound)" : ""}`); }
      const mix = "mix" in res ? (res as KalshiCoverageResult).mix.map((m) => ({ s: m.stratum, o: m.oursScore68Signals, os: m.oursShare68, v: m.kalshiMarkets, vs: m.kalshiShare })) : (res as CoverageResult).diagnostic?.categoryMix.map((m) => ({ s: m.stratum, o: m.oursScore68Signals, os: m.oursShare68, v: m.venueMarkets, vs: m.venueShare })) ?? [];
      if (mix.length) { L.push("", "| category | our score ≥ 68 signals | share | venue listing markets | share |", "|---|---|---|---|---|"); for (const m of [...mix].sort((a, b) => b.o - a.o).slice(0, 10)) L.push(`| ${m.s} | ${m.o} | ${pc(m.os)} | ${v.venue === "polymarket_intl" ? "n/a" : m.v} | ${v.venue === "polymarket_intl" ? "n/a" : pc(m.vs)} |`); }
      L.push("");
    }
    if (v.venue === "polymarket_intl") continue;
    const s = v.titles?.summary;
    if (!v.titles) L.push(`Title search: **not run** (no ${evidenceFile(v.venue, "titles")}).`, "");
    else if (!s) L.push("Title search: no summary.", "");
    else {
      const bands = SIMILARITY_BANDS.map((b) => b.name as string); L.push(`Title search (${s.mode === "endpoint" ? "venue search endpoint" : "lookup in the bounded listing"}${v.titles.listingCutOff ? ", listing CUT OFF: lower bounds" : ""}): ${s.reachedPairs}/${s.pairs} pairs answered${s.stoppedBecause ? ` · STOPPED: ${s.stoppedBecause}` : ""}${s.paceMs ? ` · pace ${s.paceMs} ms` : ""}.`, "", `| best-candidate band | ${bands.join(" | ")} |`, `|---|${bands.map(() => "---").join("|")}|`, `| all pairs searched | ${bands.map((b) => s.byBestBand[b] ?? 0).join(" | ")} |`, `| score ≥ 68 | ${bands.map((b) => s.score68.byBestBand[b] ?? 0).join(" | ")} |`, `| proposed, score ≥ 68 (not verified) | ${bands.map((b) => s.proposed.byBandScore68[b] ?? 0).join(" | ")} |`, "");
    }
  }
  return L.join("\n") + "\n";
}

/** Everything `phase4:merge` writes, plus the ≤ 60 console lines. */
export function runMerge(i: MergeInput): MergeOutput {
  const rulePath = i.stopRulePath ?? STOP_RULE_PATH; const venues = loadVenueFiles(i.read, i.outDir); const ruleText = i.read(rulePath); const check = parseStopRule(ruleText);
  const s1a = composeS1a(venues, i.outDir); const matrix = buildMatrix(venues, check, ruleText, rulePath);
  const compactIn: CompactInput = { s1a: s1a.summary, funnels: venues.filter((v) => v.venue !== "polymarket_intl").map((v) => ({ venue: v.venue, notRun: !v.coverage, file: v.coverage?.result ? { window: { startIso: new Date(v.coverage.result.funnel.window.startMs).toISOString(), endIso: new Date(v.coverage.result.funnel.window.endMs).toISOString() }, funnel: v.coverage.result.funnel } : null })) };
  const files: Record<string, string> = { "S1a_RESULTS.md": s1a.markdown, "S1_COMPACT.md": renderCompact(compactIn), "FEASIBILITY_MATRIX.md": renderMatrix(matrix), "S1b_FUNNELS.md": renderFunnels(venues) };
  const L: string[] = [`phase4:merge  ${i.outDir}  (reads the per-venue files only: no network, no database)`];
  for (const v of venues) L.push(`${v.venue.padEnd(16)} audit ${SHORT_STATUS(v.audit)} · coverage ${SHORT_STATUS(v.coverage)} · titles ${SHORT_STATUS(v.titles)} · review ${v.review ? "ingested" : "not run"}`);
  const r = matrix.rule; L.push(`stop rule ${r.stamp.path}: ${r.check.ok ? (r.check.rule!.approved ? `approved (sha ${r.stamp.sha256?.slice(0, 8)})` : "NOT approved: no verdict will be printed") : `INVALID: ${r.check.errors[0]}`}`);
  if (matrix.required) { const q = matrix.required; L.push(`required eligible signals/day (${q.subset}, n ${q.n}, SD ${f1(q.sdPts)}, DEFF ${f1(q.deff, 2)}, lag p90 ${f1(q.lagP90Days)} d, ${q.windowDays} d window):`); for (const e of [...new Set(q.rows.map((x) => x.effectPts))]) L.push(`  effect ${e} pts: ${q.rows.filter((x) => x.effectPts === e).map((x) => `accept ${(x.acceptRate * 100).toFixed(0)} % → ${f1(x.requiredEligiblePerDay)}`).join(" · ")}`); } else L.push(`required signals/day: not run (${matrix.notes[0] ?? "no settled-trade statistics"})`);
  for (const x of matrix.rows.filter((m) => m.role === "execution candidate")) { const e = x.expected; L.push(`${x.venue}: expected verified-executable eligible/day ${e ? `${f1(e.tri.lower)} · ${f1(e.tri.point)} · ${e.upperOpen ? "open" : f1(e.tri.upper)}` : "not run"} (lower · point · upper); ${x.evaluation ? (x.evaluation.issued ? `VERDICT ${x.evaluation.verdict}` : x.evaluation.reason) : "no verdict"}`); }
  L.push(`files in ${i.outDir}: ${Object.keys(files).join(" ")}`);
  return { files, lines: L.map((l) => (l.length > 220 ? l.slice(0, 217) + "..." : l)).slice(0, 60), matrix, venues };
}
