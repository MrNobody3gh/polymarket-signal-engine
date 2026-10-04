/**
 * Phase 4.0d, Part C — the human-verified sample. Nothing in this repository can mark a pair verified: only the owner's answers can.
 *
 * OPERATIONAL MEANING OF "VERIFIED" (also in docs/phase4/REVIEW_GUIDE.md and docs/phase4/FEASIBILITY.md):
 *   - a candidate is PROPOSED by code: an identifier match, or title similarity ≥ 0.70 with equal numbers and negations and a matching outcome label (`isProposed`);
 *   - it becomes OWNER-CONFIRMED only when the owner marks QUESTION, OUTCOME, TIME and RESOLUTION all "Y" in the review sheet;
 *   - it becomes VERIFIED (the operational word) only when, in addition, the TIME check computed automatically from verified-valid timestamps on BOTH venues
 *     (plan §3.3) says "yes". Where either venue has no verified-valid timestamp the automatic TIME is "unknown", and unknown blocks verification;
 *   - anything unverified counts as NOT TRADABLE. "U" (unsure) counts as not confirmed.
 *
 * `buildReviewSample` / `reviewSheetCsv` build the stratified sheet (default 60 per venue: 30 from similarity ≥ 0.50 spread over its three bands, 15 from
 * 0.30–0.50, 15 random from < 0.30 to estimate what the matcher misses; fixed seed). `ingestReview` reads the owner's filled sheet (no network, no database),
 * validates it, and computes precision per similarity band with Wilson intervals, the false-negative rate of the < 0.30 stratum, and the extrapolation to the
 * whole searched signal set. Pure: strings in, strings out.
 */
import { seededRng } from "./diagnose";
import { SIMILARITY_BANDS, isProposed } from "./mapping";
import { parseCsv, toCsv, wilson, type WilsonInterval } from "./stats";
import { pairKey, proposedOf, type SearchPair, type TitleSearchRow } from "./title-search";
import { TIMESTAMP_TOLERANCE_MS } from "./timestamps";
import { SCORE_MIN } from "./funnel";
import type { RuleStamp } from "./stop-rule";

export const REVIEW_SEED = "phase4-0d-review-v1";
export const DEFAULT_SAMPLE = 60;
export type ReviewStratum = "A" | "B" | "C";
export const STRATUM_LABEL: Record<ReviewStratum, string> = { A: "A: similarity ≥ 0.50", B: "B: similarity 0.30–0.50", C: "C: similarity < 0.30 (random; estimates what the matcher misses)" };
const A_BANDS = ["≥ 0.90", "0.70–0.90", "0.50–0.70"] as const; const B_BAND = "0.30–0.50"; const C_BAND = "< 0.30";
export const stratumOfBand = (band: string): ReviewStratum => ((A_BANDS as readonly string[]).includes(band) ? "A" : band === B_BAND ? "B" : "C");
const BAND_ORDER = SIMILARITY_BANDS.map((b) => b.name as string);

/** Rows per stratum: half from A, a quarter from B, the rest from C (60 → 30 / 15 / 15). */
export function quotas(n: number): { A: number; B: number; C: number } { const A = Math.ceil(n / 2), B = Math.ceil(n / 4); return { A, B, C: Math.max(0, n - A - B) }; }
/**
 * Spread the A quota over its three bands: an equal share each (the higher band first for a remainder), a band with fewer pairs than its share gives the
 * rest to the other bands (higher first). Deterministic. The total is min(quota, pairs available in A).
 */
export function allocateA(quota: number, size: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(A_BANDS.map((b) => [b, 0])); let left = quota; const base = Math.floor(quota / A_BANDS.length);
  A_BANDS.forEach((b, i) => { const want = base + (i < quota - base * A_BANDS.length ? 1 : 0); const take = Math.min(want, size[b] ?? 0); out[b] = take; left -= take; });
  for (let guard = 0; left > 0 && guard < 10_000; guard++) { let moved = false; for (const b of A_BANDS) { if (left > 0 && out[b] < (size[b] ?? 0)) { out[b]++; left--; moved = true; } } if (!moved) break; }
  return out;
}

export interface Picked { row: TitleSearchRow; band: string; stratum: ReviewStratum }
export interface BandPop { band: string; pairs: number; signals: number; sampled: number }
export interface SampleResult { picked: Picked[]; bands: BandPop[]; pool: number; short: { stratum: ReviewStratum; wanted: number; got: number }[] }
/**
 * The stratified sample. The pool is the pairs searched without error with a copy score ≥ 68 (`includeBelow68` adds the rest). Within a band the pairs are
 * ordered by key, shuffled with a PRNG seeded by (seed, venue, band) and cut to the quota, so the same input and seed always give the same sheet. The picked
 * rows are then shuffled together so the reviewer does not meet all the high-similarity rows first.
 */
export function buildReviewSample(rows: TitleSearchRow[], o: { venue: string; n?: number; seed?: string; includeBelow68?: boolean }): SampleResult {
  const n = o.n ?? DEFAULT_SAMPLE; const seed = o.seed ?? REVIEW_SEED; const q = quotas(n);
  const pool = rows.filter((r) => r.diag && !r.error && (o.includeBelow68 || (r.pair.score ?? -1) >= SCORE_MIN)).sort((a, b) => (pairKey(a.pair) < pairKey(b.pair) ? -1 : 1));
  const byBand = new Map<string, TitleSearchRow[]>(); for (const b of BAND_ORDER) byBand.set(b, []); for (const r of pool) byBand.get(r.diag!.band)!.push(r);
  const size = Object.fromEntries(BAND_ORDER.map((b) => [b, byBand.get(b)!.length]));
  const want: Record<string, number> = { ...allocateA(q.A, size), [B_BAND]: Math.min(q.B, size[B_BAND]), [C_BAND]: Math.min(q.C, size[C_BAND]) };
  const picked: Picked[] = [];
  for (const b of BAND_ORDER) {
    const list = [...byBand.get(b)!]; const rng = seededRng(`${seed}|${o.venue}|${b}`);
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    for (const row of list.slice(0, want[b] ?? 0)) picked.push({ row, band: b, stratum: stratumOfBand(b) });
  }
  const rng = seededRng(`${seed}|${o.venue}|order`); const order = [...picked].sort((a, b) => (pairKey(a.row.pair) < pairKey(b.row.pair) ? -1 : 1));
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const bands: BandPop[] = BAND_ORDER.map((b) => ({ band: b, pairs: byBand.get(b)!.length, signals: byBand.get(b)!.reduce((a, r) => a + r.pair.signals, 0), sampled: order.filter((p) => p.band === b).length }));
  const got = (s: ReviewStratum) => order.filter((p) => p.stratum === s).length; const short = (["A", "B", "C"] as const).filter((s) => got(s) < q[s]).map((s) => ({ stratum: s, wanted: q[s], got: got(s) }));
  return { picked: order, bands, pool: pool.length, short };
}

// ───────────────────────────────────────────── the sheet ────────────────────────────────────────────────────

/** The automatic TIME check: "unknown" unless BOTH venues have a verified-valid timestamp (plan §3.3); then "yes" within TIMESTAMP_TOLERANCE (exactly the tolerance agrees), else "no". */
export function autoTime(sourceMs: number | null, venueMs: number | null, toleranceMs = TIMESTAMP_TOLERANCE_MS): "yes" | "no" | "unknown" {
  if (sourceMs === null || venueMs === null || !Number.isFinite(sourceMs) || !Number.isFinite(venueMs)) return "unknown";
  return Math.abs(sourceMs - venueMs) <= toleranceMs ? "yes" : "no";
}

const clip = (s: string | null | undefined, n: number) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const CAND = ["title", "similarity", "proposed", "outcomes", "category", "event_time_fields", "rules_start", "venue_id", "url"] as const;
/** Columns of the sheet, in order. Owner columns are empty in the file; computed columns are filled by review-ingest. */
export const REVIEW_COLUMNS = [
  "row_id", "stratum", "band", "pair_key",
  "src_title", "src_outcome", "src_category", "src_copy_score", "src_signals", "src_event_time (date only: markets.end_date)", "src_url",
  ...[1, 2, 3].flatMap((i) => CAND.map((c) => `c${i}_${c}`)),
  "proposed_candidate", "time_auto (computed: unknown unless both venues have a verified-valid timestamp)",
  "candidate_used (1/2/3, or F = found_url; empty = the proposed candidate, else 1)", "found_url (same market on the venue but not listed above)",
  "QUESTION (Y/N/U)", "OUTCOME (Y/N/U)", "TIME (Y/N/U)", "RESOLUTION (Y/N/U)", "NOTES",
  "VERIFIED (computed on ingest; leave empty)", "REJECTION_REASON (computed on ingest; leave empty)",
  "venue", "seed", "population (do not edit)", "unsearched_pairs", "unsearched_signals",
] as const;
export const OWNER_COLUMNS = { question: "QUESTION (Y/N/U)", outcome: "OUTCOME (Y/N/U)", time: "TIME (Y/N/U)", resolution: "RESOLUTION (Y/N/U)", used: "candidate_used (1/2/3, or F = found_url; empty = the proposed candidate, else 1)", found: "found_url (same market on the venue but not listed above)", notes: "NOTES" } as const;

const SRC_URL = (p: SearchPair) => (p.slug ? `https://polymarket.com/event/${p.slug}` : "");
/** The sheet as CSV text. `unsearched` is the titles file's count of pairs and signals the run did not reach (unknown, extrapolated as 0–100 %). */
export function reviewSheetCsv(s: SampleResult, o: { venue: string; seed?: string; unsearched?: { pairs: number; signals: number } }): string {
  const seed = o.seed ?? REVIEW_SEED; const un = o.unsearched ?? { pairs: 0, signals: 0 };
  const popJson = JSON.stringify(s.bands.map((b) => ({ band: b.band, pairs: b.pairs, signals: b.signals, sampled: b.sampled })));
  const rows = s.picked.map((p, i) => {
    const d = p.row.diag!; const prop = proposedOf(p.row); const propIdx = prop ? d.top.findIndex((c) => c.marketId === prop.marketId) + 1 : 0; const cells: unknown[] = [];
    for (let k = 0; k < 3; k++) { const c = d.top[k]; cells.push(c?.question ?? "", c ? c.score : "", c ? (isProposed(c) ? "Y" : "N") : "", c ? c.outcomes.join(" / ") : "", c ? [c.stratum, ...c.categories].filter(Boolean).join("; ") : "", c ? c.times.map((t) => `${t.field}=${t.value}`).join("; ") : "", clip(c?.rules, 240), c?.marketId ?? "", c?.url ?? ""); }
    return [`r${String(i + 1).padStart(3, "0")}`, STRATUM_LABEL[p.stratum].slice(0, 1), p.band, pairKey(p.row.pair), p.row.pair.title, p.row.pair.outcome, p.row.pair.stratum, p.row.pair.score, p.row.pair.signals, p.row.pair.eventDate ?? "", SRC_URL(p.row.pair),
      ...cells, propIdx || "", "unknown", "", "", "", "", "", "", "", "", "", o.venue, seed, popJson, un.pairs, un.signals];
  });
  return toCsv([...REVIEW_COLUMNS], rows);
}

// ───────────────────────────────────────────── ingest ───────────────────────────────────────────────────────

export type Answer = "Y" | "N" | "U";
export interface BandResult {
  band: string; popPairs: number; popSignals: number; sampled: number;
  /** owner-confirmed (all four Y) among the sampled pairs, and of those the ones whose confirmed candidate was PROPOSED by code */
  confirmedAny: number; confirmedProposed: number; proposedRows: number; unsure: number; verifiedOperational: number;
  /** the share of the band's pairs that are confirmed AND proposed (joint) and that are confirmed at all, with Wilson intervals; null when nothing was sampled */
  jointProposed: WilsonInterval | null; anyConfirmed: WilsonInterval | null;
  /** precision of the proposals: confirmed ÷ proposed rows */
  precisionOfProposed: WilsonInterval | null;
}
export interface Triple { lo: number; point: number | null; hi: number }
export interface ReviewResults {
  schema: number; kind: "review"; venue: string; file: string; ingestedAt: string; seed: string; stopRule: RuleStamp;
  rows: number; answered: number; ownerConfirmed: number; verifiedOperational: number; unsure: number; timeAutoUnknown: number;
  /** the owner's answers per question (Y / N / U counts); RESOLUTION "Y" is the count of resolution rules the owner judged the same */
  answerCounts: Record<"QUESTION" | "OUTCOME" | "TIME" | "RESOLUTION", { Y: number; N: number; U: number }>;
  bands: BandResult[];
  falseNegatives: { band: string; sampled: number; confirmed: number; interval: WilsonInterval | null };
  unsearched: { pairs: number; signals: number };
  /** extrapolation to the whole searched signal set (score ≥ 68 entry signals behind the searched pairs, plus the unsearched ones as 0–100 %) */
  extrapolation: {
    totalSignals: number; totalPairs: number; z: number;
    /** share of signals with an owner-confirmed PROPOSED candidate (lower, point, upper); the upper bound counts every owner-confirmed pair, proposed or not, and the unsearched pairs fully */
    share: Triple; signals: Triple; pairs: Triple;
    /** matcher misses: owner-confirmed pairs the code did not propose, as a share of signals (point, upper) */
    matcherMisses: { point: number | null; hi: number };
    basis: string;
  };
  perRow: { rowId: string; pairKey: string; band: string; stratum: string; confirmed: boolean; verified: boolean; proposedByCode: boolean; reason: string }[];
}
export type IngestOutcome = { ok: true; results: ReviewResults; csv: string } | { ok: false; errors: string[] };

const count = (xs: Answer[]) => ({ Y: xs.filter((x) => x === "Y").length, N: xs.filter((x) => x === "N").length, U: xs.filter((x) => x === "U").length });
const norm = (s: string | undefined) => (s ?? "").trim();
const col = (header: string[], name: string) => header.indexOf(name);
const ANSWER = /^[YNU]$/i;
export const MAX_REPORTED_ERRORS = 20;

/**
 * Read the owner's filled sheet. Rejects (nothing is computed) when a required column is missing, a row lacks any of the four answers, an answer is not
 * Y / N / U, `candidate_used` is not 1/2/3/F, F has no `found_url`, or the populations embedded in the rows disagree. Every error names the row.
 */
export function ingestReview(csvText: string, o: { file: string; now: string; stopRule: RuleStamp; z?: number }): IngestOutcome {
  const z = o.z ?? 1.96; const table = parseCsv(csvText); const errors: string[] = []; const err = (m: string) => { if (errors.length < MAX_REPORTED_ERRORS) errors.push(m); else if (errors.length === MAX_REPORTED_ERRORS) errors.push("… more errors not listed"); };
  if (table.length < 2) return { ok: false, errors: ["the file has no data rows"] };
  const header = table[0].map((h) => h.trim()); const need = [...REVIEW_COLUMNS]; const missing = need.filter((c) => col(header, c) < 0);
  if (missing.length) return { ok: false, errors: [`columns missing: ${missing.slice(0, 6).join(" | ")}${missing.length > 6 ? " …" : ""} (use the sheet exactly as written by review-sheet; keep the header row)`] };
  const ix = Object.fromEntries(need.map((c) => [c, col(header, c)])) as Record<string, number>; const get = (r: string[], c: string) => norm(r[ix[c]]);
  type Row = { id: string; key: string; band: string; stratum: string; q: Answer; o: Answer; t: Answer; r: Answer; used: string; found: string; props: boolean[]; timeAuto: string; venue: string; seed: string; pop: string; unp: number; uns: number; propIdx: number };
  const rows: Row[] = []; const venues = new Set<string>();
  for (let i = 1; i < table.length; i++) {
    const r = table[i]; if (r.every((c) => !c.trim())) continue; const id = get(r, "row_id") || `line ${i + 1}`; const ans: Answer[] = [];
    for (const [k, name] of [["QUESTION", OWNER_COLUMNS.question], ["OUTCOME", OWNER_COLUMNS.outcome], ["TIME", OWNER_COLUMNS.time], ["RESOLUTION", OWNER_COLUMNS.resolution]] as const) {
      const v = get(r, name); if (!v) err(`${id}: ${k} is empty (every row needs all four answers: Y, N or U)`); else if (!ANSWER.test(v)) err(`${id}: ${k} is "${v}" (allowed: Y, N, U)`); ans.push((ANSWER.test(v) ? v.toUpperCase() : "U") as Answer);
    }
    const used = get(r, OWNER_COLUMNS.used).toUpperCase(); const found = get(r, OWNER_COLUMNS.found);
    if (used && !/^[123F]$/.test(used)) err(`${id}: candidate_used is "${used}" (allowed: 1, 2, 3, F, or empty)`); if (used === "F" && !found) err(`${id}: candidate_used is F but found_url is empty`);
    const num = (c: string) => { const x = Number(get(r, c)); return Number.isFinite(x) && get(r, c) !== "" ? x : NaN; }; const unp = num("unsearched_pairs"), uns = num("unsearched_signals");
    if ([unp, uns].some((x) => Number.isNaN(x))) err(`${id}: the population columns (unsearched_pairs, unsearched_signals) were changed or removed; they must keep the values the sheet was written with`);
    const venue = get(r, "venue"); venues.add(venue);
    rows.push({ id, key: get(r, "pair_key"), band: get(r, "band"), stratum: get(r, "stratum"), q: ans[0], o: ans[1], t: ans[2], r: ans[3], used, found, props: [1, 2, 3].map((k) => get(r, `c${k}_proposed`) === "Y"), timeAuto: get(r, "time_auto (computed: unknown unless both venues have a verified-valid timestamp)").toLowerCase() || "unknown", venue, seed: get(r, "seed"), pop: get(r, "population (do not edit)"), unp, uns, propIdx: Number(get(r, "proposed_candidate")) || 0 });
    if (!BAND_ORDER.includes(rows[rows.length - 1].band)) err(`${id}: band "${rows[rows.length - 1].band}" is not a similarity band`);
  }
  if (!rows.length) return { ok: false, errors: ["the file has no data rows"] }; if (venues.size !== 1) err(`the rows name ${venues.size} different venues (${[...venues].join(", ")}); one sheet is one venue`);
  const seeds = new Set(rows.map((r) => r.seed)); if (seeds.size > 1) err("the rows carry different seeds: the sheet was edited or two sheets were joined");
  const pop = new Map<string, { pairs: number; signals: number }>(); let popOk = rows.every((r) => r.pop === rows[0].pop);
  if (!popOk) err("the population column differs between rows: the sheet was edited or two sheets were joined");
  else { try { const arr = JSON.parse(rows[0].pop) as { band: string; pairs: number; signals: number }[]; if (!Array.isArray(arr)) throw new Error("not a list"); for (const x of arr) { if (!BAND_ORDER.includes(x.band) || !Number.isFinite(x.pairs) || !Number.isFinite(x.signals)) throw new Error("bad entry"); pop.set(x.band, { pairs: x.pairs, signals: x.signals }); } } catch { popOk = false; err("the population column (do not edit) cannot be read; use the sheet exactly as review-sheet wrote it"); } }
  const un = { pairs: rows[0].unp, signals: rows[0].uns }; if (rows.some((r) => r.unp !== un.pairs || r.uns !== un.signals)) err("the unsearched counts differ between rows");
  for (const r of rows) if (popOk && !pop.has(r.band)) err(`${r.id}: band ${r.band} is not in the population column`);
  if (errors.length) return { ok: false, errors };

  // per row: confirmed (owner), proposed-by-code for the candidate the owner judged, verified (operational)
  const perRow = rows.map((r) => {
    const confirmed = r.q === "Y" && r.o === "Y" && r.t === "Y" && r.r === "Y"; const used = r.used || (r.propIdx ? String(r.propIdx) : "1");
    const proposedByCode = used === "F" ? false : r.props[Number(used) - 1] === true; const verified = confirmed && r.timeAuto === "yes";
    const bad = ([["QUESTION", r.q], ["OUTCOME", r.o], ["TIME", r.t], ["RESOLUTION", r.r]] as const).filter(([, v]) => v !== "Y").map(([k, v]) => `${k}: ${v === "N" ? "no" : "unsure (counts as not confirmed)"}`);
    const reason = !confirmed ? bad.join("; ") : r.timeAuto === "yes" ? "" : r.timeAuto === "no" ? "TIME_AUTO no: the verified timestamps of the two venues disagree beyond the tolerance" : "TIME_AUTO unknown: no verified-valid timestamp on both venues (plan §3.3), which blocks verification";
    return { rowId: r.id, pairKey: r.key, band: r.band, stratum: r.stratum, confirmed, verified, proposedByCode, reason, unsure: [r.q, r.o, r.t, r.r].includes("U") };
  });
  const bands: BandResult[] = BAND_ORDER.filter((b) => (pop.get(b)?.pairs ?? 0) > 0 || rows.some((r) => r.band === b)).map((b) => {
    const idx = rows.map((r, i) => (r.band === b ? i : -1)).filter((i) => i >= 0); const p = pop.get(b)!; const n = idx.length;
    const k = idx.filter((i) => perRow[i].confirmed).length, kp = idx.filter((i) => perRow[i].confirmed && perRow[i].proposedByCode).length, np = idx.filter((i) => perRow[i].proposedByCode).length;
    return { band: b, popPairs: p.pairs, popSignals: p.signals, sampled: n, confirmedAny: k, confirmedProposed: kp, proposedRows: np, unsure: idx.filter((i) => perRow[i].unsure).length, verifiedOperational: idx.filter((i) => perRow[i].verified).length, jointProposed: wilson(kp, n, z), anyConfirmed: wilson(k, n, z), precisionOfProposed: wilson(kp, np, z) };
  });
  const totalSignals = bands.reduce((a, b) => a + b.popSignals, 0) + un.signals, totalPairs = bands.reduce((a, b) => a + b.popPairs, 0) + un.pairs;
  // shares of ALL signals: the lower bound counts only confirmed AND proposed pairs at their Wilson lower bound; the point only when every band with signals was reviewed; the upper counts every confirmed pair at its upper bound, an unreviewed band or the unsearched pairs fully
  let lo = 0, pt: number | null = 0, hi = 0, missPt: number | null = 0, missHi = 0; let loP = 0, ptP: number | null = 0, hiP = 0;
  for (const b of bands) {
    const w = totalSignals ? b.popSignals / totalSignals : 0; const wp = totalPairs ? b.popPairs / totalPairs : 0;
    if (!b.jointProposed || !b.anyConfirmed) { hi += w; hiP += wp; missHi += w; if (b.popSignals > 0) { pt = null; missPt = null; } if (b.popPairs > 0) ptP = null; continue; }
    lo += w * b.jointProposed.lo; hi += w * b.anyConfirmed.hi; if (pt !== null) pt += w * b.jointProposed.point; loP += wp * b.jointProposed.lo; hiP += wp * b.anyConfirmed.hi; if (ptP !== null) ptP += wp * b.jointProposed.point;
    if (missPt !== null) missPt += w * (b.anyConfirmed.point - b.jointProposed.point); missHi += w * Math.max(0, b.anyConfirmed.hi - b.jointProposed.lo);
  }
  if (un.signals > 0 && totalSignals) { const w = un.signals / totalSignals; hi += w; missHi += w; pt = null; missPt = null; } if (un.pairs > 0 && totalPairs) { hiP += un.pairs / totalPairs; ptP = null; }
  const cBand = bands.find((b) => b.band === C_BAND); const fn = { band: C_BAND, sampled: cBand?.sampled ?? 0, confirmed: cBand?.confirmedAny ?? 0, interval: cBand ? cBand.anyConfirmed : null };
  const results: ReviewResults = { schema: 1, kind: "review", venue: rows[0].venue, file: o.file, ingestedAt: o.now, seed: rows[0].seed, stopRule: o.stopRule, rows: rows.length, answered: rows.length, ownerConfirmed: perRow.filter((r) => r.confirmed).length, verifiedOperational: perRow.filter((r) => r.verified).length, unsure: perRow.filter((r) => r.unsure).length, timeAutoUnknown: rows.filter((r) => r.timeAuto === "unknown").length,
    answerCounts: { QUESTION: count(rows.map((r) => r.q)), OUTCOME: count(rows.map((r) => r.o)), TIME: count(rows.map((r) => r.t)), RESOLUTION: count(rows.map((r) => r.r)) },
    bands, falseNegatives: fn, unsearched: un,
    extrapolation: { totalSignals, totalPairs, z, share: { lo, point: pt, hi }, signals: { lo: lo * totalSignals, point: pt === null ? null : pt * totalSignals, hi: hi * totalSignals }, pairs: { lo: loP * totalPairs, point: ptP === null ? null : ptP * totalPairs, hi: hiP * totalPairs }, matcherMisses: { point: missPt, hi: missHi },
      basis: "per similarity band: the sampled pairs' owner-confirmed share with a Wilson interval (z " + z + "), times the band's signals (and pairs); bands summed. Lower = confirmed AND proposed at each band's lower bound; upper = any confirmed pair at each band's upper bound, an unreviewed band or the unsearched pairs counted fully; point only when every band was reviewed and nothing was unsearched. The per-band bounds are summed, which is wider than a joint interval. Assumes verification does not depend on how many signals a pair has within a band." },
    perRow: perRow.map(({ unsure: _u, ...r }) => r) };
  const resultCsv = toCsv(["row_id", "pair_key", "band", "stratum", "owner_confirmed", "proposed_by_code", "VERIFIED", "REJECTION_REASON"], perRow.map((r) => [r.rowId, r.pairKey, r.band, r.stratum, r.confirmed ? "Y" : "N", r.proposedByCode ? "Y" : "N", r.verified ? "Y" : "N", r.reason]));
  return { ok: true, results, csv: resultCsv };
}

const pc = (x: number | null | undefined) => (x === null || x === undefined ? "n/m" : `${(x * 100).toFixed(0)} %`);
const wi = (w: WilsonInterval | null) => (w ? `${w.k}/${w.n} = ${pc(w.point)} [${pc(w.lo)}–${pc(w.hi)}]` : "not reviewed");
/** ≤ 40 printed lines of an ingest. */
export function ingestLines(r: ReviewResults): string[] {
  const L = [`review ingested: ${r.venue} · ${r.rows} rows · owner-confirmed ${r.ownerConfirmed} · unsure rows ${r.unsure} · VERIFIED (operational: needs automatic TIME = yes) ${r.verifiedOperational} · automatic TIME unknown on ${r.timeAutoUnknown} rows`,
    `stop rule at ingest: ${r.stopRule.path} · approved ${r.stopRule.approved === null ? "unreadable" : r.stopRule.approved} · sha256 ${r.stopRule.sha256?.slice(0, 12) ?? "n/m"}`, "band         pairs  signals  sampled  confirmed∧proposed (Wilson)       any confirmed (Wilson)            precision of proposals"];
  for (const b of r.bands) L.push(`${b.band.padEnd(11)} ${String(b.popPairs).padStart(6)} ${String(b.popSignals).padStart(8)} ${String(b.sampled).padStart(8)}  ${wi(b.jointProposed).padEnd(32)}  ${wi(b.anyConfirmed).padEnd(32)}  ${wi(b.precisionOfProposed)}`);
  L.push(`false negatives (< 0.30 stratum, owner found the same market): ${wi(r.falseNegatives.interval)}`);
  const e = r.extrapolation; L.push(`extrapolated to ${e.totalPairs} pairs / ${e.totalSignals} signals (${r.unsearched.pairs} pairs / ${r.unsearched.signals} signals not searched): confirmed∧proposed signals ${e.signals.lo.toFixed(0)} – ${e.signals.point === null ? "n/m" : e.signals.point.toFixed(0)} – ${e.signals.hi.toFixed(0)} (lower – point – upper); share ${pc(e.share.lo)} – ${pc(e.share.point)} – ${pc(e.share.hi)}`);
  L.push("proposed and confirmed are NOT executable by themselves: a verified pair also needs a machine-verified timestamp (plan §3.3); this is research, not a decision");
  return L.map((l) => (l.length > 220 ? l.slice(0, 217) + "..." : l)).slice(0, 40);
}
