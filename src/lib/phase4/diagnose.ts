/**
 * Phase 4.0b (S1b diagnostic) — why did nothing map? Pure functions over our signals' markets and the execution venue's listing:
 * the timestamp-free matcher report (candidate counts by similarity band for the score ≥ 68 pairs), the stratified random sample for the
 * owner's eye (`s1b_mapping_diagnostic.csv`) and the category mix of our flow versus the venue's listing.
 * Probe only: every label is PROBABLE or NONE, never EXACT, never verified; the PROBABLE definition used by the funnel is not touched.
 */
import { bandOf, buildDiagIndex, diagnoseSignal, SIMILARITY_BANDS, type DiagResult, type VenueMarketRef } from "./mapping";
import { toCsv } from "./stats";

export interface OurMarket {
  conditionId: string; tokenId: string; title: string | null; slug: string | null; outcome: string | null;
  stratum: string; /** the highest copy score among the signals of this market and outcome (null = none recorded) */ score: number | null;
  signals: number;
}

/** A small deterministic PRNG (mulberry32) seeded from a string, so the "random" sample is reproducible. */
export function seededRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length; for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** `n` items drawn at random but spread over the strata: shuffle each stratum with the seeded PRNG, then take one from each in turn. Never more than `n`; deterministic for a seed. */
export function stratifiedRandom<T>(items: T[], keyOf: (x: T) => string, n: number, seed: string): T[] {
  const rng = seededRng(seed); const groups = new Map<string, T[]>(); for (const x of [...items]) { const k = keyOf(x); const g = groups.get(k); if (g) g.push(x); else groups.set(k, [x]); }
  const keys = [...groups.keys()].sort(); for (const k of keys) { const g = groups.get(k)!; for (let i = g.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [g[i], g[j]] = [g[j], g[i]]; } }
  const out: T[] = []; for (let round = 0; out.length < n; round++) { let any = false; for (const k of keys) { const g = groups.get(k)!; if (round < g.length && out.length < n) { out.push(g[round]); any = true; } } if (!any) break; }
  return out;
}

export const scoreBand = (s: number | null): string => (s !== null && s >= 68 ? "score ≥ 68" : "score < 68 or none");

export interface DiagnosticSummary {
  definition: string;
  /** Pairs (market + outcome) with a copy score ≥ 68 and how many fall in each similarity band by their best candidate. */
  pairs: number; byBestBand: Record<string, number>; candidatesGeneratedByBand: Record<string, number>;
  probable: number; none: number; identifierMatches: number; sameParticipants: number; ambiguous: number;
  /** For the pairs whose best candidate has the same participants (same game): how many have a matching category, and how often the market type differs (title similarity below 0.85). */
  sameParticipantsDifferentTitle: number; categoryMatchOfBest: { yes: number; no: number; unknown: number };
  bestBandByStratum: Record<string, Record<string, number>>;
  note: string;
}
export interface DiagnosticRun { summary: DiagnosticSummary; results: { market: OurMarket; diag: DiagResult }[] }

/** Run the timestamp-free matcher over our markets (typically those behind score ≥ 68 signals) against the venue's markets. */
export function runDiagnostic(ours: OurMarket[], venue: VenueMarketRef[]): DiagnosticRun {
  const idx = buildDiagIndex(venue); const results = ours.map((market) => ({ market, diag: diagnoseSignal({ conditionId: market.conditionId, tokenId: market.tokenId, title: market.title, outcome: market.outcome, slug: market.slug, stratum: market.stratum }, idx) }));
  const byBestBand: Record<string, number> = Object.fromEntries(SIMILARITY_BANDS.map((b) => [b.name, 0])); const cand: Record<string, number> = { ...byBestBand };
  const byStratum: Record<string, Record<string, number>> = {}; let probable = 0, ident = 0, sameP = 0, sameDiff = 0, amb = 0; const cat = { yes: 0, no: 0, unknown: 0 };
  for (const { market, diag } of results) {
    byBestBand[diag.band]++; for (const [b, n] of Object.entries(diag.candidatesByBand)) cand[b] += n;
    (byStratum[market.stratum] ??= Object.fromEntries(SIMILARITY_BANDS.map((b) => [b.name, 0])))[diag.band]++;
    if (diag.confidence === "PROBABLE") probable++; if (diag.identifierMatch) ident++; if (diag.evidence.some((e) => e.includes("qualify equally"))) amb++;
    if (diag.best?.sameParticipants) { sameP++; if (diag.best.titleSimilarity < 0.85) sameDiff++; }
    if (diag.best) { if (diag.best.categoryMatch === true) cat.yes++; else if (diag.best.categoryMatch === false) cat.no++; else cat.unknown++; } else cat.unknown++;
  }
  return { results, summary: { definition: "timestamp-free: candidates by shared identifier or content tokens; PROBABLE = identifier match, or title similarity ≥ 0.85 with equal numbers and negations and a matching outcome, NO DATE CHECKED. Never EXACT, never verified. The funnel's PROBABLE (which requires dates within a day) is unchanged.", pairs: results.length, byBestBand, candidatesGeneratedByBand: cand, probable, none: results.length - probable, identifierMatches: ident, sameParticipants: sameP, ambiguous: amb, sameParticipantsDifferentTitle: sameDiff, categoryMatchOfBest: cat, bestBandByStratum: byStratum,
    note: "A pair in a high band is a candidate for the owner's eye, not a mapping. A low best band for most pairs means the venues' listings do not contain these markets under similar titles (or the venue's titles are worded differently): look at s1b_mapping_diagnostic.csv." } };
}

export const DIAGNOSTIC_HEADER = ["our_stratum", "our_score_band", "signals", "our_title", "our_outcome", "our_slug", "our_url", "best_band", "diag_label (PROBABLE/NONE; never verified)", "rank", "venue_title", "venue_market_id", "venue_url", "venue_stratum", "venue_categories", "title_similarity", "participant_similarity", "category_match", "outcome_match", "identifier_match", "reviewer_note"];
/** One row per (our market × one of its nearest `topN` venue titles); markets with no candidate get one row with empty venue columns. */
export function diagnosticCsv(sample: { market: OurMarket; diag: DiagResult }[]): string {
  const rows: unknown[][] = [];
  for (const { market, diag } of sample) {
    const base = [market.stratum, scoreBand(market.score), market.signals, market.title, market.outcome, market.slug, market.slug ? `https://polymarket.com/event/${market.slug}` : "", diag.band, diag.confidence];
    if (!diag.top.length) rows.push([...base, "", "", "", "", "", "", "", "", "", "", "", ""]);
    diag.top.forEach((c, i) => rows.push([...base, i + 1, c.question, c.marketId, c.url ?? "", c.stratum ?? "", c.categories.join("; "), c.titleSimilarity, c.participantSimilarity, c.categoryMatch === null ? "" : c.categoryMatch, c.outcomeMatch === null ? "" : c.outcomeMatch, c.identifierMatch, ""]));
  }
  return toCsv(DIAGNOSTIC_HEADER, rows);
}

export interface MixRow { stratum: string; oursAllSignals: number; oursScore68Signals: number; oursMarkets68: number; venueMarkets: number; venueOpen: number; venueClosed: number; oursShareAll: number; oursShare68: number; venueShare: number }
/** Category mix of our flow versus the venue's listing (counts and shares), by stratum. */
export function categoryMix(ours: { stratum: string; score: number | null; condition: string }[], venueStrata: { stratum: string; closed: boolean }[]): MixRow[] {
  const keys = [...new Set([...ours.map((o) => o.stratum), ...venueStrata.map((v) => v.stratum)])].sort(); const nAll = ours.length || 1; const n68 = ours.filter((o) => o.score !== null && o.score >= 68).length || 1; const nv = venueStrata.length || 1;
  return keys.map((k) => { const o = ours.filter((x) => x.stratum === k); const o68 = o.filter((x) => x.score !== null && x.score >= 68); const v = venueStrata.filter((x) => x.stratum === k); const r3 = (x: number) => Math.round(x * 1000) / 1000;
    return { stratum: k, oursAllSignals: o.length, oursScore68Signals: o68.length, oursMarkets68: new Set(o68.map((x) => x.condition)).size, venueMarkets: v.length, venueOpen: v.filter((x) => !x.closed).length, venueClosed: v.filter((x) => x.closed).length, oursShareAll: r3(o.length / nAll), oursShare68: r3(o68.length / n68), venueShare: r3(v.length / nv) }; });
}
export { bandOf };
