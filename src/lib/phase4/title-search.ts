/**
 * Phase 4.0c, Part B — title search for EVERY pair, on both US-accessible venues. The 4.0b diagnostic compared our titles with a SAMPLE of each listing;
 * this asks the venue itself, one short normalised query per distinct market+outcome pair behind our signals, and scores what comes back with the existing
 * similarity function (mapping.ts). Read-only: GET of public data through PoliteHttp. Nothing here is verified (`verified` is the literal false): equivalence
 * of resolution rules is a human check, and `EXACT` / `PROBABLE` keep their definitions.
 *
 * Venues:
 *  - US exchange: `GET /v1/search?query=…&limit=…` (documented; response shape UNVERIFIED, so events and markets are both read).
 *  - Kalshi: no free-text market search on the trade API appears in the published documentation as far as search-engine summaries show (UNVERIFIED), so the
 *    "search" is a lookup in the COMPLETE bounded listing fetched in Part A (`mode: "listing"`); where that listing was cut off its result is a lower bound.
 */
import { categorize, stratum } from "./categorize";
import type { RawMarket } from "./audit";
import type { PoliteHttp } from "./http";
import { buildDiagIndex, diagCandidates, diagnoseCandidates, isProposed, normalizeTitle, participantsOf, SIMILARITY_BANDS, type DiagResult, type VenueMarketRef } from "./mapping";
import { flatten } from "./audit";
import { classifyFieldNameFor, KALSHI } from "./timestamps";
import { toCsv } from "./stats";
import { extractRecords, tagsOf, usIdOf, usOutcomes, usTitleOf, type UsConfig } from "./venues";
import { kalshiGroupOf, kalshiIdOf, kalshiOutcomes, kalshiSlug, kalshiTags, kalshiTitleOf } from "./venue-kalshi";
import { selectAll, selectIn, type ReadOnlyDb } from "./readonly-db";
import { ENTRY_KINDS } from "../paper/ledger";
import { HeapBudgetExceeded, evidenceFile, type HeapInfo, type StopInfo, type VenueId } from "./venue-run";
import { SCORE_MIN } from "./funnel";

export interface SearchPair { conditionId: string; tokenId: string; title: string | null; slug: string | null; outcome: string | null; stratum: string; score: number | null; signals: number; wallet: string | null;
  /** 4.0d: our stored DATE-LEVEL end date of the market (`markets.end_date`, a day, not a time); null when we hold none. Shown in the review sheet as the source time. */
  eventDate?: string | null }
/** The key of a market+outcome pair (condition id lower-cased). */
export const pairKey = (p: { conditionId: string; outcome: string | null }): string => `${String(p.conditionId).toLowerCase()}|${p.outcome ?? ""}`;

// ───────────────────────────────────────────── the query ─────────────────────────────────────────────────────

const FILLER = new Set(["the", "a", "an", "of", "in", "on", "at", "to", "for", "by", "and", "or", "be", "is", "will", "does", "do", "game", "match", "vs", "versus", "than", "that", "this", "with", "from", "have", "has", "win", "wins", "winner", "before", "after", "ever", "fc", "cf", "sc", "afc", "club"]);
const GENERIC_OUTCOMES = new Set(["yes", "no", "over", "under", "draw", "up", "down"]);
export const MAX_QUERY_CHARS = 80;
/**
 * A short normalised query from our title, its participants and the outcome. Head-to-head titles ("A vs B: O/U 220.5") become the two sides only (the
 * team names are what identify the game on another venue; the market type words differ between venues); other titles keep their first distinct content
 * words, numbers and years included, in order. The outcome is added when it is a name (not Yes/No/Over/Under) not already present. At most 80 characters.
 */
export function buildSearchQuery(p: { title: string | null; outcome: string | null }): string {
  const parts = participantsOf(p.title); let words: string[];
  if (parts) words = [...parts[0].slice(0, 3), ...parts[1].slice(0, 3)];
  else words = normalizeTitle(p.title).split(" ").filter((w) => w && !FILLER.has(w));
  const out: string[] = []; for (const w of words) if (!out.includes(w)) out.push(w);
  const oc = normalizeTitle(p.outcome); if (oc && !GENERIC_OUTCOMES.has(oc)) for (const w of oc.split(" ")) if (w && !FILLER.has(w) && !out.includes(w)) out.push(w);
  let q = ""; for (const w of out.slice(0, 10)) { if ((q ? q.length + 1 : 0) + w.length > MAX_QUERY_CHARS) break; q = q ? `${q} ${w}` : w; }
  return q;
}

// ───────────────────────────────────────────── candidate refs from raw objects ─────────────────────────────

const venueRef = (venue: string, o: { id: string; question: string | null; outcomes: string[]; slug: string | null; categories: string[]; stratum: string; eventSlug?: string | null; url?: string | null; times?: { field: string; value: string }[]; rules?: string | null }): VenueMarketRef => ({ venue, marketId: o.id, slug: o.slug, url: o.url ?? null, conditionIds: [], tokenIds: [], question: o.question, outcomes: o.outcomes, eventDate: null, categories: o.categories, stratum: o.stratum, eventSlug: o.eventSlug ?? null, times: o.times ?? [], rules: o.rules ?? null });

/** Order in which a market's time-like fields are shown to the reviewer: start-like first, creation/update bookkeeping never. */
const TIME_ORDER: Record<string, number> = { START_LIKE: 0, OTHER_TIME: 1, CLOSE_LIKE: 2, RESOLUTION_LIKE: 3 };
/**
 * The time-like fields a venue market exposes, for the owner's eye: the field name and its raw value, NO judgement (which field is the event start is
 * decided by the S1a audit and the plan's §3.3, not here). At most `max`, start-like first, creation and update times left out.
 */
export function timeFieldsOf(m: RawMarket, venue: string, max = 5): { field: string; value: string }[] {
  const out: { field: string; value: string; rank: number }[] = [];
  for (const [k, v] of Object.entries(flatten(m))) { if (typeof v !== "string" && typeof v !== "number") continue; if (typeof v === "string" && !/^\d{4}-\d{2}-\d{2}/.test(v.trim())) continue; const role = classifyFieldNameFor(venue, k); if (!(role in TIME_ORDER)) continue; out.push({ field: k, value: String(v), rank: TIME_ORDER[role] }); }
  return out.sort((a, b) => a.rank - b.rank || (a.field < b.field ? -1 : 1)).slice(0, max).map(({ field, value }) => ({ field, value }));
}
/** The start of the venue's rule text (the slimmed listing keeps at most 200 characters; the full text is on the venue's page). */
export function rulesOf(m: RawMarket): string | null { for (const k of ["rules_primary", "rules", "description", "rules_secondary"]) { const v = m[k]; if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").trim().slice(0, 240); } return null; }
/** UNVERIFIED URL patterns (the owner confirms them in docs/phase4/REVIEW_GUIDE.md): used only to give the reviewer a place to start; the venue's own `url` field wins when the listing has one. */
export const KALSHI_URL_BASE = "https://kalshi.com/markets/";
export const US_URL_BASE = "https://polymarket.us/event/";
export function usRefOf(m: RawMarket): VenueMarketRef | null {
  const id = usIdOf(m); if (!id) return null; const ev = m.event && typeof m.event === "object" ? (m.event as RawMarket) : null; const slug = typeof m.slug === "string" ? m.slug : null; const tags = tagsOf(m);
  const title = usTitleOf(m) ?? (typeof ev?.title === "string" ? ev.title : null);
  const evSlug = typeof ev?.slug === "string" ? ev.slug : null; const own = typeof m.url === "string" && m.url ? m.url : null;
  return venueRef("polymarket_us", { id, question: title, outcomes: usOutcomes(m), slug, categories: tags, stratum: stratum(categorize({ title, slug, tags })), eventSlug: evSlug, url: own ?? (evSlug ?? slug ? `${US_URL_BASE}${evSlug ?? slug}` : null), times: timeFieldsOf(m, "polymarket_us"), rules: rulesOf(m) });
}
export function kalshiRefOf(m: RawMarket): VenueMarketRef | null {
  const id = kalshiIdOf(m); if (!id) return null; const title = kalshiTitleOf(m); const sub = typeof m.yes_sub_title === "string" ? m.yes_sub_title : null; const tags = kalshiTags(m);
  // the market title plus its side label gives "Winner? Lakers": what a signal's title and outcome are compared with
  const question = title && sub && !title.toLowerCase().includes(sub.toLowerCase()) ? `${title} ${sub}` : title;
  const series = (typeof m.series_ticker === "string" ? m.series_ticker : (m.event as RawMarket | undefined)?.series_ticker); const own = typeof m.url === "string" && m.url ? m.url : null;
  return venueRef("kalshi", { id, question, outcomes: kalshiOutcomes(m), slug: kalshiSlug(m), categories: tags, stratum: stratum(categorize({ title: question, slug: kalshiSlug(m), tags })), eventSlug: kalshiGroupOf(m), url: own ?? (typeof series === "string" && series ? `${KALSHI_URL_BASE}${series.toLowerCase()}` : null), times: timeFieldsOf(m, KALSHI), rules: rulesOf(m) });
}

// ───────────────────────────────────────────── providers ─────────────────────────────────────────────────────

export interface SearchOutcome { candidates: VenueMarketRef[]; error: string | null; /** the venue refused: stop asking */ blocked: boolean; /** the HTTP status of a failed request, when there was one (a refusal is 401/403/451) */ status?: number | null }
export interface SearchProvider { venue: string; mode: "endpoint" | "listing"; describe: string; requests: () => number; search(query: string, pair: SearchPair): Promise<SearchOutcome> }

/** The US exchange's documented `GET <searchPath>?query=…`: events (exploded into their markets) and markets in the answer are all candidates, de-duplicated. */
export function usSearchProvider(http: PoliteHttp, cfg: UsConfig, o: { limit?: number } = {}): SearchProvider {
  return {
    venue: "polymarket_us", mode: "endpoint", describe: `GET ${cfg.base}${cfg.searchPath}?query=…&limit=${o.limit ?? 10}`, requests: () => http.requests,
    async search(query) {
      const r = await http.getJson(`${cfg.base}${cfg.searchPath}?${new URLSearchParams({ query, limit: String(o.limit ?? 10) })}`);
      if (!r.ok) return { candidates: [], error: `${r.kind}${r.status ? ` ${r.status}` : ""}`, blocked: r.kind === "BLOCKED" || r.kind === "BLOCKED_SKIPPED", status: r.status };
      const raws: RawMarket[] = []; const root = r.json && typeof r.json === "object" ? (r.json as Record<string, unknown>) : {};
      for (const k of ["events", "markets", "results", "data", "items"]) if (Array.isArray(root[k])) raws.push(...extractRecords({ [k]: root[k] }).records);
      if (Array.isArray(r.json)) raws.push(...extractRecords(r.json).records);
      const seen = new Set<string>(); const out: VenueMarketRef[] = []; for (const m of raws) { const ref = usRefOf(m); if (ref && !seen.has(ref.marketId)) { seen.add(ref.marketId); out.push(ref); } }
      return { candidates: out, error: null, blocked: false };
    },
  };
}
/** Lookup in a complete bounded listing (Kalshi: no documented search endpoint): the 60 markets sharing the most content words with the title, plus identifier / slug matches. No requests. */
export function listingSearchProvider(venue: string, refs: VenueMarketRef[], describe: string): SearchProvider {
  const idx = buildDiagIndex(refs);
  const content = (t: string | null) => new Set(normalizeTitle(t).split(" ").filter((w) => w && !FILLER.has(w)));
  return { venue, mode: "listing", describe, requests: () => 0, async search(_q, pair) {
    // a candidate that shares only filler words ("vs", "will", …) with the title is noise, not a candidate; an identifier or slug match always is one
    const mine = content(pair.title); const cands = diagCandidates({ conditionId: pair.conditionId, tokenId: pair.tokenId, title: pair.title, slug: pair.slug, outcome: pair.outcome }, idx).filter((c) => (!!pair.slug && !!c.slug && c.slug.toLowerCase() === pair.slug.toLowerCase()) || [...content(c.question)].some((w) => mine.has(w)));
    return { candidates: cands, error: null, blocked: false };
  } };
}

// ───────────────────────────────────────────── the run ───────────────────────────────────────────────────────

export interface TitleSearchRow { pair: SearchPair; query: string; diag: DiagResult | null; error: string | null }
export interface TitleSearchSummary {
  venue: string; mode: SearchProvider["mode"]; describe: string; pairs: number; searched: number; notSearched: number; requests: number; budget: number;
  /** a clear message when the request budget or a refusal ended the run early; null otherwise */
  stoppedBecause: string | null;
  /** best-candidate band per pair (pairs searched without error), and how many returned ANY candidate */
  byBestBand: Record<string, number>; withAnyCandidate: number; noCandidate: number; errors: number; errorKinds: Record<string, number>; probable: number;
  /** the same bands for the score ≥ 68 pairs only */
  score68: { pairs: number; byBestBand: Record<string, number>; withAnyCandidate: number; probable: number };
  /** 4.0d: pairs with a PROPOSED candidate (identifier match, or similarity ≥ 0.70 with equal numbers and negations and a matching outcome): all pairs and score ≥ 68, and the pairs searched without error */
  proposed: { all: number; score68: number; byBand: Record<string, number>; byBandScore68: Record<string, number> };
  /** 4.0d: how far the run got. `reachedPairs` = pairs answered without error (including those carried over by --resume); `refusal` is set when the venue refused: the run stops there and tries nothing else. */
  reachedPairs: number; carriedOver: number; refusal: { status: number | null; message: string; afterPairs: number } | null;
  /** 4.0d: the pace the run used against the venue (ms between request starts; null for a listing lookup that sends no request) */
  paceMs: number | null; requestsPerMinute: number | null;
  verified: false; note: string;
}
export interface TitleSearchResult { rows: TitleSearchRow[]; summary: TitleSearchSummary; /** set when the heap budget ended the run (the rows searched so far are kept) */ stopped?: StopInfo | null }
const bandZero = () => Object.fromEntries(SIMILARITY_BANDS.map((b) => [b.name, 0])) as Record<string, number>;
export const DEFAULT_SEARCH_BUDGET = 2000;
/** The best PROPOSED candidate of a pair's top candidates, or null (a row without a result, or with no proposed candidate). */
export const proposedOf = (r: TitleSearchRow) => r.diag?.top.filter(isProposed).sort((a, b) => b.score - a.score)[0] ?? null;

/**
 * Search every pair (score ≥ 68 first, the rest only while the budget lasts), score each candidate list with the existing similarity function, and
 * stop with a clear message when `maxRequests` is reached or the venue refuses. Pairs are never skipped silently: `notSearched` counts them.
 * `prior` (4.0d, `--resume`): rows of an earlier run of the same venue; a pair already answered without error is carried over and not asked again, so a later run
 * (legitimately slower) continues where a refused one stopped. A refusal ends THIS run at once: no retry, no other header or origin, no automatic slowing.
 */
export async function runTitleSearch(pairs: SearchPair[], provider: SearchProvider, o: { maxRequests?: number; topN?: number; onProgress?: (done: number, total: number) => void; prior?: TitleSearchRow[]; paceMs?: number | null } = {}): Promise<TitleSearchResult> {
  const budget = o.maxRequests ?? DEFAULT_SEARCH_BUDGET; const start = provider.requests(); const ordered = [...pairs].sort((a, b) => Number((b.score ?? -1) >= SCORE_MIN) - Number((a.score ?? -1) >= SCORE_MIN) || (a.conditionId + (a.outcome ?? "") < b.conditionId + (b.outcome ?? "") ? -1 : 1));
  const wanted = new Set(ordered.map(pairKey)); const kept = new Map<string, TitleSearchRow>(); for (const r of o.prior ?? []) { const k = pairKey(r.pair); if (wanted.has(k) && r.diag && !r.error && !kept.has(k)) kept.set(k, r); }
  const rows: TitleSearchRow[] = [...kept.values()]; const carriedOver = rows.length; let stoppedBecause: string | null = null; let done = carriedOver; let refusal: TitleSearchSummary["refusal"] = null; let heapStop: StopInfo | null = null;
  for (const pair of ordered) {
    if (kept.has(pairKey(pair))) continue;
    if (provider.requests() - start >= budget) { stoppedBecause = `request budget of ${budget} reached after ${done} of ${ordered.length} pairs (${ordered.length - done} not searched); raise --search-max-requests to continue`; break; }
    const query = buildSearchQuery(pair); let out: SearchOutcome;
    if (!query) out = { candidates: [], error: "empty query", blocked: false };
    else { try { out = await provider.search(query, pair); } catch (e) { if (!(e instanceof HeapBudgetExceeded)) throw e; heapStop = { reason: "heap_budget", stage: e.stage, message: e.message }; stoppedBecause = `${e.message} (${done} of ${ordered.length} pairs answered)`; break; } }
    o.onProgress?.(done + 1, ordered.length);
    if (out.blocked) { done++; rows.push({ pair, query, diag: null, error: out.error }); refusal = { status: out.status ?? null, message: out.error ?? "refused", afterPairs: done - 1 }; stoppedBecause = `${provider.venue} refused access (${out.error}) after ${done - 1} of ${ordered.length} pairs were answered; this run stops there and tries no workaround (no retry, no other header or origin, no slower pace within the same run)`; break; }
    done++; rows.push({ pair, query, diag: out.error ? null : diagnoseCandidates({ conditionId: pair.conditionId, tokenId: pair.tokenId, title: pair.title, outcome: pair.outcome, slug: pair.slug, stratum: pair.stratum }, out.candidates, o.topN ?? 3), error: out.error });
  }
  const ok = rows.filter((r) => r.diag); const errorKinds: Record<string, number> = {}; for (const r of rows) if (r.error) errorKinds[r.error] = (errorKinds[r.error] ?? 0) + 1;
  const band = (rs: TitleSearchRow[]) => { const b = bandZero(); for (const r of rs) if (r.diag) b[r.diag.band]++; return b; };
  const s68 = ok.filter((r) => (r.pair.score ?? -1) >= SCORE_MIN);
  const propBand = (rs: TitleSearchRow[]) => { const b = bandZero(); for (const r of rs) { const c = proposedOf(r); if (c) b[bandOfScore(c.score)]++; } return b; };
  const pp = ok.filter((r) => proposedOf(r)); const pp68 = s68.filter((r) => proposedOf(r));
  const summary: TitleSearchSummary = { venue: provider.venue, mode: provider.mode, describe: provider.describe, pairs: pairs.length, searched: rows.length, notSearched: pairs.length - rows.length, requests: provider.requests() - start, budget, stoppedBecause,
    byBestBand: band(ok), withAnyCandidate: ok.filter((r) => r.diag!.best !== null).length, noCandidate: ok.filter((r) => r.diag!.best === null).length, errors: rows.filter((r) => r.error).length, errorKinds, probable: ok.filter((r) => r.diag!.confidence === "PROBABLE").length,
    score68: { pairs: rows.filter((r) => (r.pair.score ?? -1) >= SCORE_MIN).length, byBestBand: band(s68), withAnyCandidate: s68.filter((r) => r.diag!.best !== null).length, probable: s68.filter((r) => r.diag!.confidence === "PROBABLE").length },
    proposed: { all: pp.length, score68: pp68.length, byBand: propBand(pp), byBandScore68: propBand(pp68) },
    reachedPairs: ok.length, carriedOver, refusal, paceMs: o.paceMs ?? null, requestsPerMinute: o.paceMs ? Math.round((60_000 / o.paceMs) * 10) / 10 : null,
    verified: false, note: "A high band is a candidate for the owner's eye, never a mapping: nothing is verified, no date is checked, and resolution-rule equivalence is a human check. 'No candidate' means the venue returned nothing for the query (or, in listing mode, the cut-off listing has nothing sharing a word). 'Proposed' = identifier match, or similarity ≥ 0.70 with equal numbers and negations and a matching outcome label; proposed is NOT verified." };
  return { rows, summary, stopped: heapStop };
}
/** The pairs of `pairs` that have no answered row in `rows` (an errored or missing row is unknown), and the signals behind them. */
export function unsearchedOf(pairs: SearchPair[], rows: TitleSearchRow[]): { pairs: number; signals: number } {
  const answered = new Set(rows.filter((r) => r.diag && !r.error).map((r) => pairKey(r.pair))); let n = 0, sig = 0;
  for (const p of pairs) if (!answered.has(pairKey(p))) { n++; sig += p.signals; }
  return { pairs: n, signals: sig };
}
/** A summary for a run that stopped before it searched anything (the heap budget): zeros everywhere, the reason in `stoppedBecause`. */
export function emptyTitleSummary(venue: string, stoppedBecause: string): TitleSearchSummary {
  const z = bandZero(); return { venue, mode: "listing", describe: "stopped before any search", pairs: 0, searched: 0, notSearched: 0, requests: 0, budget: 0, stoppedBecause, byBestBand: { ...z }, withAnyCandidate: 0, noCandidate: 0, errors: 0, errorKinds: {}, probable: 0, score68: { pairs: 0, byBestBand: { ...z }, withAnyCandidate: 0, probable: 0 }, proposed: { all: 0, score68: 0, byBand: { ...z }, byBandScore68: { ...z } }, reachedPairs: 0, carriedOver: 0, refusal: null, paceMs: null, requestsPerMinute: null, verified: false, note: "the run stopped before it searched anything" };
}
const bandOfScore = (score: number): string => SIMILARITY_BANDS.find((b) => score >= b.min)!.name;

// ───────────────────────────────────────────── outputs ───────────────────────────────────────────────────────

export const TITLE_SEARCH_HEADER = ["our_title", "our_outcome", "our_stratum", "our_score", "signals", "wallet", "query", "best_band", "label (PROBABLE/NONE; never verified)", "candidates_returned", "error",
  "1_title", "1_similarity", "1_category", "1_id", "2_title", "2_similarity", "2_category", "2_id", "3_title", "3_similarity", "3_category", "3_id"];
export function titleSearchCsv(rows: TitleSearchRow[]): string {
  return toCsv(TITLE_SEARCH_HEADER, rows.map((r) => { const top = r.diag?.top ?? []; const cells: unknown[] = []; for (let i = 0; i < 3; i++) { const c = top[i]; cells.push(c?.question ?? "", c ? c.score : "", c ? [c.stratum, ...c.categories].filter(Boolean).join("; ") : "", c?.marketId ?? ""); }
    return [r.pair.title, r.pair.outcome, r.pair.stratum, r.pair.score, r.pair.signals, r.pair.wallet, r.query, r.diag?.band ?? "", r.diag?.confidence ?? "", r.diag?.candidatesGenerated ?? "", r.error ?? "", ...cells]; }));
}

const clip = (s: string | null | undefined, n: number) => { const t = (s ?? "").replace(/\s+/g, " "); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
/** The best matches (highest similarity; PROBABLE first) and the near-misses (highest similarity among the pairs that did not qualify, ≥ 0.5): for the owner to judge by eye. */
export function pickExamples(rows: TitleSearchRow[], bestN = 15, nearN = 10): { best: TitleSearchRow[]; near: TitleSearchRow[] } {
  const withBest = rows.filter((r) => r.diag?.best); const cmp = (a: TitleSearchRow, b: TitleSearchRow) => b.diag!.best!.score - a.diag!.best!.score || ((a.pair.title ?? "") < (b.pair.title ?? "") ? -1 : 1);
  const best = [...withBest].sort((a, b) => Number(b.diag!.confidence === "PROBABLE") - Number(a.diag!.confidence === "PROBABLE") || cmp(a, b)).slice(0, bestN);
  const taken = new Set(best);
  const near = withBest.filter((r) => !taken.has(r) && r.diag!.confidence !== "PROBABLE" && r.diag!.best!.score >= 0.5).sort(cmp).slice(0, nearN);
  return { best, near };
}
export const exampleLine = (r: TitleSearchRow): string => { const c = r.diag!.best!; return clip(`${c.score.toFixed(2)} ${r.diag!.confidence === "PROBABLE" ? "PROB" : "none"} [${r.pair.stratum}] "${clip(r.pair.title, 52)}" (${clip(r.pair.outcome, 14)}) ⇄ "${clip(c.question, 52)}" [${clip(c.stratum, 16)}]`, 200); };

/** ≤ 60 printed lines for BOTH venues: per venue 2 lines of bands and coverage, the 15 best matches and the 10 near-misses; the rest is in the CSV files. */
export function titleSearchSummaryLines(results: TitleSearchResult[], outDir: string, only: VenueId | null = null): string[] {
  const L: string[] = [`S1b title search: every market+outcome pair behind our signals, looked up on the venue itself (nothing verified; resolution rules are a human check)`, `files in ${outDir}: ${results.map((r) => `s1b_title_search_${r.summary.venue}.csv`).join(" ")}${only ? ` ${evidenceFile(only, "titles")}` : ""}`];
  const bands = (b: Record<string, number>) => SIMILARITY_BANDS.map((x) => `${x.name} ${b[x.name] ?? 0}`).join(" · ");
  for (const { rows, summary: s } of results) {
    L.push(`[${s.venue}] ${s.mode === "endpoint" ? "search endpoint" : "listing lookup"}: ${s.searched}/${s.pairs} pairs searched in ${s.requests} requests · any candidate ${s.withAnyCandidate} · none ${s.noCandidate} · errors ${s.errors}${s.stoppedBecause ? ` · STOPPED: ${s.stoppedBecause}` : ""}`);
    L.push(`  best band, all pairs: ${bands(s.byBestBand)}  |  score ≥ 68 (${s.score68.pairs} pairs; any candidate ${s.score68.withAnyCandidate}; PROBABLE ${s.score68.probable}): ${bands(s.score68.byBestBand)}`);
    L.push(`  reached ${s.reachedPairs}/${s.pairs} pairs${s.carriedOver ? ` (${s.carriedOver} carried over by --resume)` : ""}${s.paceMs ? ` · pace ${s.paceMs} ms (${s.requestsPerMinute}/min)` : ""}`);
    L.push(`  PROPOSED (not verified): all ${s.proposed.all} · score ≥ 68 ${s.proposed.score68}: ${bands(s.proposed.byBandScore68)}`);
    if (s.refusal) L.push(`  REFUSED: ${s.refusal.message} after ${s.refusal.afterPairs} pairs answered; nothing else was tried in this run (no retry, no header or origin change)`);
    const { best, near } = pickExamples(rows); L.push(`  ${best.length} best matches:`); for (const r of best) L.push(`   ${exampleLine(r)}`); L.push(`  ${near.length} near-misses (0.50 ≤ similarity, not PROBABLE):`); for (const r of near) L.push(`   ${exampleLine(r)}`);
  }
  return L.map((l) => (l.length > 220 ? l.slice(0, 217) + "..." : l)).slice(0, 60);
}

// ───────────────────────────────────────────── our pairs (read-only) ─────────────────────────────────────────

interface SignalRow { id: string; wallet: string; condition_id: string; token_id: string; outcome: string | null; title: string | null; slug: string | null; created_at: string; payload: Record<string, unknown> | null }
/** Distinct market+outcome pairs behind our entry signals since `startIso` (select only): the highest copy score of each, its signal count and the wallet of that highest-scoring signal. */
export async function loadSearchPairs(db: ReadOnlyDb, startIso: string, endIso: string): Promise<SearchPair[]> {
  const rows = await selectAll<SignalRow>((from, to) => db.select("signals", "id,wallet,condition_id,token_id,outcome,title,slug,created_at,payload").in("kind", ENTRY_KINDS).gte("created_at", startIso).lt("created_at", endIso).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to));
  const by = new Map<string, SearchPair>(); const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) continue; seen.add(r.id); const raw = (r.payload ?? {}).copyScore; const sc = raw === null || raw === undefined ? null : Number(raw); const score = sc !== null && Number.isFinite(sc) ? sc : null; const k = `${String(r.condition_id).toLowerCase()}|${r.outcome ?? ""}`; const cur = by.get(k);
    if (cur) { cur.signals++; if (score !== null && (cur.score === null || score > cur.score)) { cur.score = score; cur.wallet = r.wallet; } }
    else by.set(k, { conditionId: r.condition_id, tokenId: r.token_id, title: r.title, slug: r.slug, outcome: r.outcome, stratum: stratum(categorize({ title: r.title, slug: r.slug })), score, signals: 1, wallet: r.wallet });
  }
  // our stored date-level end dates (select only): the SOURCE time shown to the reviewer; a date, never a verified timestamp
  const conds = [...new Set([...by.values()].map((p) => String(p.conditionId).toLowerCase()))];
  const ends = new Map<string, string>(); for (const m of await selectIn<{ condition_id: string; end_date: string | null }>(conds, (c) => db.select("markets", "condition_id,end_date").in("condition_id", c as string[]))) if (m.end_date) ends.set(String(m.condition_id).toLowerCase(), String(m.end_date).slice(0, 10));
  for (const p of by.values()) p.eventDate = ends.get(String(p.conditionId).toLowerCase()) ?? null;
  return [...by.values()].sort((a, b) => (a.conditionId + (a.outcome ?? "") < b.conditionId + (b.outcome ?? "") ? -1 : 1));
}

// ───────────────────────────────────────────── the per-venue evidence file (4.0d) ───────────────────────────

/** `v_<venue>_titles.json`: every searched pair with its top candidates (the review sheet, the wallet share and the merge read this; nothing here is verified). */
export interface VenueTitlesFile {
  schema: number; kind: "titles"; venue: string; startedAt: string; finishedAt: string; window: { startIso: string; endIso: string }; allScores: boolean;
  /** the Kalshi listing lookup was cut at the cap (a lower bound), else false; null for an endpoint search */
  listingCutOff: boolean | null; listingMarkets: number | null;
  /** pairs (and the signals behind them) of the searched set that were NOT answered (budget, refusal, heap): unknown, never "no match" */
  unsearched: { pairs: number; signals: number };
  summary: TitleSearchSummary; stopped: StopInfo | null; heap: HeapInfo | null; rows: TitleSearchRow[];
}
