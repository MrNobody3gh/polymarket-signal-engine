/**
 * Phase 4.0 (S1b) — probe-only mapping from a signal's market on the international venue to a candidate market on the
 * execution venue (docs/PHASE4_PLAN.md §3.2 E2, D46). Pure and deterministic.
 *
 * TRUST: no result of this file is trusted for trading. `verified` and `resolutionRulesVerified` are the literal `false`
 * on every result, including EXACT: whether the two markets resolve identically is a human check (the review CSV).
 * PROBABLE is a candidate for that check, never a verified mapping (E2: `MAPPING_UNVERIFIED`).
 */

export type Confidence = "EXACT" | "PROBABLE" | "NONE";

export interface SignalMarketRef {
  conditionId?: string | null; tokenId?: string | null;
  /** The market question as the signal venue states it (`signals.title`). */
  title: string | null; outcome: string | null;
  eventSlug?: string | null;
  /** The signal venue's event time if it has one: an ISO date (`YYYY-MM-DD`) or datetime. Date-level agreement is enough for PROBABLE. */
  eventDate?: string | null;
}
export interface VenueMarketRef {
  venue: string; marketId: string; slug?: string | null; url?: string | null;
  /** Identifiers the venue exposes that may equal the signal venue's (an empty or missing list means the venue shares none). */
  conditionIds?: string[]; tokenIds?: string[];
  question: string | null; outcomes?: string[] | null;
  /** The venue's event time as an ISO date or datetime (any field the audit chose; used only for date-level agreement here). */
  eventDate?: string | null;
}
export interface MatchResult {
  confidence: Confidence;
  /** Always false: no mapping is trusted for trading in this step. */
  verified: false;
  /** Always false: equivalence of resolution rules is a human check. */
  resolutionRulesVerified: false;
  candidate: VenueMarketRef | null;
  /** The venue's label for the signal's outcome when it could be matched. */
  venueOutcome: string | null;
  evidence: string[];
  /** True when more than one distinct candidate qualified at the best level, so none was chosen (confidence NONE). */
  ambiguous: boolean;
}

// ───────────────────────────────────────────────── normalisation ────────────────────────────────────────────

const STOP = new Set(["the", "a", "an", "of", "in", "on", "at", "to", "for", "by", "and", "or", "be", "is", "will", "does", "do", "game", "match"]);
/** Lower-case, strip diacritics and punctuation, unify "vs" forms and "o/u", collapse spaces. */
export function normalizeTitle(s: string | null | undefined): string {
  if (!s) return "";
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\b(versus|vs|v)\b\.?/g, " vs ").replace(/o\/u/g, " over under ").replace(/&/g, " and ")
    .replace(/[^a-z0-9.\s]/g, " ").replace(/(?<!\d)\.|\.(?!\d)/g, " ").replace(/\s+/g, " ").trim();
}
const tokenMemo = new Map<string, string[]>();
/** Memoised: the probe compares each signal title with thousands of candidates. The memo is bounded and cleared when full (a cache, never state). */
const tokens = (s: string): string[] => {
  const hit = tokenMemo.get(s); if (hit) return hit;
  const t = normalizeTitle(s).split(" ").filter((x) => x && !STOP.has(x));
  if (tokenMemo.size > 100_000) tokenMemo.clear(); tokenMemo.set(s, t); return t;
};
const NEG = new Set(["not", "no", "never", "without", "fail", "fails"]);
const jaccard = (a: Set<string>, b: Set<string>) => { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; };
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Title similarity in [0, 1] and whether the guards hold: identical numbers (2.5 vs 3.5 must differ) and identical negations. */
export function titleSimilarity(a: string | null | undefined, b: string | null | undefined): { score: number; numbersAgree: boolean; negationsAgree: boolean; exact: boolean } {
  const ta = new Set(tokens(a ?? "")), tb = new Set(tokens(b ?? ""));
  const nums = (t: Set<string>) => new Set([...t].filter((x) => /\d/.test(x))); const negs = (t: Set<string>) => new Set([...t].filter((x) => NEG.has(x)));
  return { score: jaccard(ta, tb), numbersAgree: sameSet(nums(ta), nums(tb)), negationsAgree: sameSet(negs(ta), negs(tb)), exact: ta.size > 0 && sameSet(ta, tb) };
}
export const normalizeOutcome = (s: string | null | undefined) => normalizeTitle(s).replace(/^(yes|y)$/, "yes").replace(/^(no|n)$/, "no");

const dayOf = (s: string | null | undefined): number | null => {
  if (!s) return null; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim()); if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]); return Number.isFinite(t) ? t / 86_400_000 : null;
};
/** Title similarity needed for PROBABLE (with every guard holding). */
export const PROBABLE_MIN_SIMILARITY = 0.85;
/** Event dates may differ by this many UTC days (time zones move a late match to the next date). */
export const PROBABLE_MAX_DATE_DIFF_DAYS = 1;

// ───────────────────────────────────────────────── matching ─────────────────────────────────────────────────

interface Scored { cand: VenueMarketRef; level: Confidence; evidence: string[]; venueOutcome: string | null; rank: number }

function matchOutcome(signalOutcome: string | null, cand: VenueMarketRef): string | null {
  const want = normalizeOutcome(signalOutcome); if (!want || !cand.outcomes?.length) return null;
  const hits = cand.outcomes.filter((o) => normalizeOutcome(o) === want); return hits.length === 1 ? hits[0] : null;
}

function scoreOne(sig: SignalMarketRef, cand: VenueMarketRef): Scored {
  const ev: string[] = []; const cid = (sig.conditionId ?? "").toLowerCase(); const tid = sig.tokenId ?? "";
  const idCond = !!cid && (cand.conditionIds ?? []).some((c) => c.toLowerCase() === cid);
  const idTok = !!tid && (cand.tokenIds ?? []).includes(tid);
  const outcome = matchOutcome(sig.outcome, cand);
  if (idCond || idTok) {
    if (idCond) ev.push(`condition id ${cid} is listed on ${cand.venue} market ${cand.marketId}`);
    if (idTok) ev.push(`token id ${tid} is listed on ${cand.venue} market ${cand.marketId}`);
    // A token id names the outcome itself; a condition id names the market, so the outcome label must also match.
    if (idTok) return { cand, level: "EXACT", evidence: ev, venueOutcome: outcome, rank: 3 };
    if (outcome) { ev.push(`outcome "${sig.outcome}" matches venue outcome "${outcome}"`); return { cand, level: "EXACT", evidence: ev, venueOutcome: outcome, rank: 3 }; }
    ev.push(`outcome "${sig.outcome ?? ""}" matches none of the venue outcomes: identifier match only`);
    return { cand, level: "PROBABLE", evidence: ev, venueOutcome: null, rank: 2 };
  }
  const t = titleSimilarity(sig.title, cand.question);
  if (t.score < PROBABLE_MIN_SIMILARITY && !t.exact) return { cand, level: "NONE", evidence: [`title similarity ${t.score.toFixed(2)} < ${PROBABLE_MIN_SIMILARITY}`], venueOutcome: null, rank: 0 };
  if (!t.numbersAgree) return { cand, level: "NONE", evidence: ["numbers in the titles differ"], venueOutcome: null, rank: 0 };
  if (!t.negationsAgree) return { cand, level: "NONE", evidence: ["negation words in the titles differ"], venueOutcome: null, rank: 0 };
  ev.push(t.exact ? "normalised titles are identical" : `normalised titles are similar (${t.score.toFixed(2)})`);
  const d1 = dayOf(sig.eventDate), d2 = dayOf(cand.eventDate);
  if (d1 === null || d2 === null) return { cand, level: "NONE", evidence: [...ev, "event date unknown on one side: cannot be PROBABLE"], venueOutcome: null, rank: 0 };
  if (Math.abs(d1 - d2) > PROBABLE_MAX_DATE_DIFF_DAYS) return { cand, level: "NONE", evidence: [...ev, `event dates differ by ${Math.abs(d1 - d2)} days`], venueOutcome: null, rank: 0 };
  ev.push(`event dates agree within ${PROBABLE_MAX_DATE_DIFF_DAYS} day (${Math.abs(d1 - d2)})`);
  if (!outcome) return { cand, level: "NONE", evidence: [...ev, `outcome "${sig.outcome ?? ""}" not found uniquely among the venue outcomes`], venueOutcome: null, rank: 0 };
  ev.push(`outcome "${sig.outcome}" matches venue outcome "${outcome}"`);
  return { cand, level: "PROBABLE", evidence: ev, venueOutcome: outcome, rank: t.exact ? 2 : 1 };
}

/**
 * Match one signal market against the candidate execution-venue markets.
 *   EXACT     a shared identifier (token id, or condition id plus a matching outcome label).
 *   PROBABLE  no shared identifier (or an identifier without an outcome match), but the normalised titles are identical or
 *             ≥ 0.85 similar with equal numbers and negations, the event dates agree within 1 day, and the outcome label
 *             matches exactly one venue outcome.
 *   NONE      anything else, including ties between different candidates at the best level (`ambiguous`).
 * Deterministic: candidates are ordered by market id, and equal best scores are never broken arbitrarily.
 */
export function matchSignalToVenue(sig: SignalMarketRef, candidates: VenueMarketRef[]): MatchResult {
  const base: Omit<MatchResult, "confidence" | "candidate" | "venueOutcome" | "evidence" | "ambiguous"> = { verified: false, resolutionRulesVerified: false };
  const none = (evidence: string[], ambiguous = false): MatchResult => ({ ...base, confidence: "NONE", candidate: null, venueOutcome: null, evidence, ambiguous });
  if (!candidates.length) return none(["no candidate markets"]);
  const scored = [...candidates].sort((a, b) => (a.marketId < b.marketId ? -1 : a.marketId > b.marketId ? 1 : 0)).map((c) => scoreOne(sig, c));
  const top = Math.max(...scored.map((s) => s.rank)); const best = scored.filter((s) => s.rank === top && s.level !== "NONE");
  if (!best.length) { const near = scored.filter((s) => s.evidence.length > 1)[0] ?? scored[0]; return none(near ? near.evidence : ["no candidate"]); }
  const distinct = new Set(best.map((b) => b.cand.marketId));
  if (distinct.size > 1) return none([`${distinct.size} distinct candidates qualify equally: ${[...distinct].slice(0, 5).join(", ")}`], true);
  const w = best[0]; return { ...base, confidence: w.level, candidate: w.cand, venueOutcome: w.venueOutcome, evidence: w.evidence, ambiguous: false };
}

/** Rows for docs/phase4/data/s1b_mapping_review.csv: what the owner needs to compare two markets' rules by eye. */
export const REVIEW_HEADER = ["category", "confidence", "signal_title", "signal_outcome", "signal_event_time", "signal_url", "venue", "venue_market_id", "venue_question", "venue_outcome", "venue_event_time", "venue_url", "evidence", "reviewer_verdict (SAME_RULES / DIFFERENT / UNSURE)", "reviewer_notes"];
export function reviewRow(category: string, sig: SignalMarketRef & { url?: string | null; eventTime?: string | null }, m: MatchResult & { venueEventTime?: string | null }): unknown[] {
  return [category, m.confidence, sig.title, sig.outcome, sig.eventTime ?? sig.eventDate ?? "", sig.url ?? "", m.candidate?.venue ?? "", m.candidate?.marketId ?? "", m.candidate?.question ?? "", m.venueOutcome ?? "", m.venueEventTime ?? m.candidate?.eventDate ?? "", m.candidate?.url ?? "", m.evidence.join(" | "), "", ""];
}

// ───────────────────────────────────────────────── candidate index ──────────────────────────────────────────

export interface VenueIndex { all: VenueMarketRef[]; byCondition: Map<string, VenueMarketRef[]>; byToken: Map<string, VenueMarketRef[]>; byTitleToken: Map<string, VenueMarketRef[]> }
/** Inverted indexes over the candidates so the probe does not compare every signal with every market. */
export function buildVenueIndex(cands: VenueMarketRef[]): VenueIndex {
  const idx: VenueIndex = { all: cands, byCondition: new Map(), byToken: new Map(), byTitleToken: new Map() };
  const add = (m: Map<string, VenueMarketRef[]>, k: string, c: VenueMarketRef) => { const a = m.get(k); if (a) a.push(c); else m.set(k, [c]); };
  for (const c of cands) { for (const x of c.conditionIds ?? []) add(idx.byCondition, x.toLowerCase(), c); for (const x of c.tokenIds ?? []) add(idx.byToken, x, c); for (const t of new Set(tokens(c.question ?? ""))) add(idx.byTitleToken, t, c); }
  return idx;
}
/**
 * The candidates that CAN match `sig`: those sharing an identifier, and those sharing at least half of the signal title's
 * tokens (PROBABLE needs Jaccard ≥ 0.85, which implies sharing well over half). Gives exactly the same result as matching
 * against all candidates (tests/phase4-mapping.test.ts proves it on a fixture world) at a fraction of the cost.
 */
export function candidatesFor(sig: SignalMarketRef, idx: VenueIndex): VenueMarketRef[] {
  const out = new Map<string, VenueMarketRef>();
  const cid = (sig.conditionId ?? "").toLowerCase(); if (cid) for (const c of idx.byCondition.get(cid) ?? []) out.set(c.marketId, c);
  if (sig.tokenId) for (const c of idx.byToken.get(sig.tokenId) ?? []) out.set(c.marketId, c);
  const toks = [...new Set(tokens(sig.title ?? ""))]; const need = Math.max(1, Math.ceil(toks.length / 2)); const hits = new Map<string, { c: VenueMarketRef; n: number }>();
  for (const t of toks) for (const c of idx.byTitleToken.get(t) ?? []) { const h = hits.get(c.marketId); if (h) h.n++; else hits.set(c.marketId, { c, n: 1 }); }
  for (const { c, n } of hits.values()) if (n >= need) out.set(c.marketId, c);
  return [...out.values()];
}
