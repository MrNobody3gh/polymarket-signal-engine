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
import { buildDiagIndex, diagCandidates, diagnoseCandidates, normalizeTitle, participantsOf, SIMILARITY_BANDS, type DiagResult, type VenueMarketRef } from "./mapping";
import { toCsv } from "./stats";
import { extractRecords, tagsOf, usIdOf, usOutcomes, usTitleOf, type UsConfig } from "./venues";
import { kalshiGroupOf, kalshiIdOf, kalshiOutcomes, kalshiSlug, kalshiTags, kalshiTitleOf } from "./venue-kalshi";
import { selectAll, type ReadOnlyDb } from "./readonly-db";
import { ENTRY_KINDS } from "../paper/ledger";
import { SCORE_MIN } from "./funnel";

export interface SearchPair { conditionId: string; tokenId: string; title: string | null; slug: string | null; outcome: string | null; stratum: string; score: number | null; signals: number; wallet: string | null }

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

const venueRef = (venue: string, o: { id: string; question: string | null; outcomes: string[]; slug: string | null; categories: string[]; stratum: string; eventSlug?: string | null }): VenueMarketRef => ({ venue, marketId: o.id, slug: o.slug, url: null, conditionIds: [], tokenIds: [], question: o.question, outcomes: o.outcomes, eventDate: null, categories: o.categories, stratum: o.stratum, eventSlug: o.eventSlug ?? null });
export function usRefOf(m: RawMarket): VenueMarketRef | null {
  const id = usIdOf(m); if (!id) return null; const ev = m.event && typeof m.event === "object" ? (m.event as RawMarket) : null; const slug = typeof m.slug === "string" ? m.slug : null; const tags = tagsOf(m);
  const title = usTitleOf(m) ?? (typeof ev?.title === "string" ? ev.title : null);
  return venueRef("polymarket_us", { id, question: title, outcomes: usOutcomes(m), slug, categories: tags, stratum: stratum(categorize({ title, slug, tags })), eventSlug: typeof ev?.slug === "string" ? ev.slug : null });
}
export function kalshiRefOf(m: RawMarket): VenueMarketRef | null {
  const id = kalshiIdOf(m); if (!id) return null; const title = kalshiTitleOf(m); const sub = typeof m.yes_sub_title === "string" ? m.yes_sub_title : null; const tags = kalshiTags(m);
  // the market title plus its side label gives "Winner? Lakers": what a signal's title and outcome are compared with
  const question = title && sub && !title.toLowerCase().includes(sub.toLowerCase()) ? `${title} ${sub}` : title;
  return venueRef("kalshi", { id, question, outcomes: kalshiOutcomes(m), slug: kalshiSlug(m), categories: tags, stratum: stratum(categorize({ title: question, slug: kalshiSlug(m), tags })), eventSlug: kalshiGroupOf(m) });
}

// ───────────────────────────────────────────── providers ─────────────────────────────────────────────────────

export interface SearchOutcome { candidates: VenueMarketRef[]; error: string | null; /** the venue refused: stop asking */ blocked: boolean }
export interface SearchProvider { venue: string; mode: "endpoint" | "listing"; describe: string; requests: () => number; search(query: string, pair: SearchPair): Promise<SearchOutcome> }

/** The US exchange's documented `GET <searchPath>?query=…`: events (exploded into their markets) and markets in the answer are all candidates, de-duplicated. */
export function usSearchProvider(http: PoliteHttp, cfg: UsConfig, o: { limit?: number } = {}): SearchProvider {
  return {
    venue: "polymarket_us", mode: "endpoint", describe: `GET ${cfg.base}${cfg.searchPath}?query=…&limit=${o.limit ?? 10}`, requests: () => http.requests,
    async search(query) {
      const r = await http.getJson(`${cfg.base}${cfg.searchPath}?${new URLSearchParams({ query, limit: String(o.limit ?? 10) })}`);
      if (!r.ok) return { candidates: [], error: `${r.kind}${r.status ? ` ${r.status}` : ""}`, blocked: r.kind === "BLOCKED" || r.kind === "BLOCKED_SKIPPED" };
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
  verified: false; note: string;
}
export interface TitleSearchResult { rows: TitleSearchRow[]; summary: TitleSearchSummary }
const bandZero = () => Object.fromEntries(SIMILARITY_BANDS.map((b) => [b.name, 0])) as Record<string, number>;
export const DEFAULT_SEARCH_BUDGET = 2000;

/**
 * Search every pair (score ≥ 68 first, the rest only while the budget lasts), score each candidate list with the existing similarity function, and
 * stop with a clear message when `maxRequests` is reached or the venue refuses. Pairs are never skipped silently: `notSearched` counts them.
 */
export async function runTitleSearch(pairs: SearchPair[], provider: SearchProvider, o: { maxRequests?: number; topN?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<TitleSearchResult> {
  const budget = o.maxRequests ?? DEFAULT_SEARCH_BUDGET; const start = provider.requests(); const ordered = [...pairs].sort((a, b) => Number((b.score ?? -1) >= SCORE_MIN) - Number((a.score ?? -1) >= SCORE_MIN) || (a.conditionId + (a.outcome ?? "") < b.conditionId + (b.outcome ?? "") ? -1 : 1));
  const rows: TitleSearchRow[] = []; let stoppedBecause: string | null = null; let done = 0;
  for (const pair of ordered) {
    if (provider.requests() - start >= budget) { stoppedBecause = `request budget of ${budget} reached after ${done} of ${ordered.length} pairs (${ordered.length - done} not searched); raise --search-max-requests to continue`; break; }
    const query = buildSearchQuery(pair); let out: SearchOutcome;
    if (!query) out = { candidates: [], error: "empty query", blocked: false }; else out = await provider.search(query, pair);
    done++; o.onProgress?.(done, ordered.length);
    if (out.blocked) { rows.push({ pair, query, diag: null, error: out.error }); stoppedBecause = `${provider.venue} refused access (${out.error}) after ${done} of ${ordered.length} pairs; no workaround is attempted`; break; }
    rows.push({ pair, query, diag: out.error ? null : diagnoseCandidates({ conditionId: pair.conditionId, tokenId: pair.tokenId, title: pair.title, outcome: pair.outcome, slug: pair.slug, stratum: pair.stratum }, out.candidates, o.topN ?? 3), error: out.error });
  }
  const ok = rows.filter((r) => r.diag); const errorKinds: Record<string, number> = {}; for (const r of rows) if (r.error) errorKinds[r.error] = (errorKinds[r.error] ?? 0) + 1;
  const band = (rs: TitleSearchRow[]) => { const b = bandZero(); for (const r of rs) if (r.diag) b[r.diag.band]++; return b; };
  const s68 = ok.filter((r) => (r.pair.score ?? -1) >= SCORE_MIN);
  const summary: TitleSearchSummary = { venue: provider.venue, mode: provider.mode, describe: provider.describe, pairs: pairs.length, searched: rows.length, notSearched: pairs.length - rows.length, requests: provider.requests() - start, budget, stoppedBecause,
    byBestBand: band(ok), withAnyCandidate: ok.filter((r) => r.diag!.best !== null).length, noCandidate: ok.filter((r) => r.diag!.best === null).length, errors: rows.filter((r) => r.error).length, errorKinds, probable: ok.filter((r) => r.diag!.confidence === "PROBABLE").length,
    score68: { pairs: rows.filter((r) => (r.pair.score ?? -1) >= SCORE_MIN).length, byBestBand: band(s68), withAnyCandidate: s68.filter((r) => r.diag!.best !== null).length, probable: s68.filter((r) => r.diag!.confidence === "PROBABLE").length },
    verified: false, note: "A high band is a candidate for the owner's eye, never a mapping: nothing is verified, no date is checked, and resolution-rule equivalence is a human check. 'No candidate' means the venue returned nothing for the query (or, in listing mode, the cut-off listing has nothing sharing a word)." };
  return { rows, summary };
}

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
export function titleSearchSummaryLines(results: TitleSearchResult[], outDir: string): string[] {
  const L: string[] = [`S1b title search: every market+outcome pair behind our signals, looked up on the venue itself (nothing verified; resolution rules are a human check)`, `files in ${outDir}: ${results.map((r) => `s1b_title_search_${r.summary.venue}.csv`).join(" ")}`];
  const bands = (b: Record<string, number>) => SIMILARITY_BANDS.map((x) => `${x.name} ${b[x.name] ?? 0}`).join(" · ");
  for (const { rows, summary: s } of results) {
    L.push(`[${s.venue}] ${s.mode === "endpoint" ? "search endpoint" : "listing lookup"}: ${s.searched}/${s.pairs} pairs searched in ${s.requests} requests · any candidate ${s.withAnyCandidate} · none ${s.noCandidate} · errors ${s.errors}${s.stoppedBecause ? ` · STOPPED: ${s.stoppedBecause}` : ""}`);
    L.push(`  best band, all pairs: ${bands(s.byBestBand)}  |  score ≥ 68 (${s.score68.pairs} pairs; any candidate ${s.score68.withAnyCandidate}; PROBABLE ${s.score68.probable}): ${bands(s.score68.byBestBand)}`);
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
  return [...by.values()].sort((a, b) => (a.conditionId + (a.outcome ?? "") < b.conditionId + (b.outcome ?? "") ? -1 : 1));
}
