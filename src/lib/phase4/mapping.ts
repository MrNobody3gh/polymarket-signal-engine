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
  /** Optional context for the timestamp-free diagnostic only (never used by `matchSignalToVenue`). */
  categories?: string[]; stratum?: string | null; eventSlug?: string | null;
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


// ───────────────────────────────────────────── participants (head-to-head titles) ─────────────────────────

const STOP_PART = new Set(["the", "fc", "cf", "sc", "afc", "club"]);
const ptoks = (s: string): string[] => normalizeTitle(s).split(" ").filter((t) => t && !STOP_PART.has(t));
/**
 * The two sides of "A vs B" (also "A v B", "A @ B", "A - B"), taken from the part of the title before any colon, bracket or dash
 * qualifier ("Lakers vs. Celtics: O/U 220.5" → [lakers] vs [celtics]). null when the title is not a head-to-head.
 */
export function participantsOf(title: string | null | undefined): [string[], string[]] | null {
  if (!title) return null;
  const head = title.split(/[:(\[|–—]/)[0].replace(/\s@\s/g, " vs ").replace(/\s[-–]\s/g, " vs ");
  const parts = normalizeTitle(head).split(/\s+vs\s+/); if (parts.length !== 2) return null;
  const a = ptoks(parts[0]), b = ptoks(parts[1]); return a.length && b.length ? [a, b] : null;
}
/** Similarity of two head-to-head titles regardless of which side is home: the better of the straight and the crossed pairing, each limited by its worse side. 0 when either is not a head-to-head. */
export function participantSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const pa = participantsOf(a), pb = participantsOf(b); if (!pa || !pb) return 0;
  const j = (x: string[], y: string[]) => jaccard(new Set(x), new Set(y));
  return Math.max(Math.min(j(pa[0], pb[0]), j(pa[1], pb[1])), Math.min(j(pa[0], pb[1]), j(pa[1], pb[0])));
}

// ───────────────────────────────────────────── timestamp-free diagnostic (probe only) ─────────────────────

/** Similarity bands for the diagnostic report, best first. */
export const SIMILARITY_BANDS = [{ name: "≥ 0.90", min: 0.9 }, { name: "0.70–0.90", min: 0.7 }, { name: "0.50–0.70", min: 0.5 }, { name: "0.30–0.50", min: 0.3 }, { name: "< 0.30", min: 0 }] as const;
export const bandOf = (score: number): string => SIMILARITY_BANDS.find((b) => score >= b.min)!.name;

export interface DiagSignal { conditionId?: string | null; tokenId?: string | null; title: string | null; outcome: string | null; slug?: string | null; eventSlug?: string | null; stratum?: string | null }
export interface DiagCandidate {
  marketId: string; question: string | null; slug: string | null; url: string | null; categories: string[]; stratum: string | null;
  titleSimilarity: number; participantSimilarity: number; sameParticipants: boolean; numbersAgree: boolean; negationsAgree: boolean;
  outcomeMatch: boolean | null; categoryMatch: boolean | null; identifierMatch: boolean;
  /** max(title similarity, participant similarity); 1 for an identifier match. Orders candidates only. */
  score: number;
}
export interface DiagResult {
  /** PROBABLE or NONE ONLY. Never EXACT, never verified. PROBABLE here means: normalised title similarity ≥ 0.85 with equal numbers and negations and a matching outcome, NO DATE CHECKED (`dateChecked` is the literal false); an identifier match is reported in `identifierMatch` and also yields PROBABLE. */
  confidence: "PROBABLE" | "NONE"; verified: false; dateChecked: false;
  identifierMatch: boolean; best: DiagCandidate | null; top: DiagCandidate[];
  /** Band of the best candidate and the number of generated candidates in each band. */
  band: string; candidatesByBand: Record<string, number>; candidatesGenerated: number;
  evidence: string[];
}
export interface DiagIndex extends VenueIndex { bySlug: Map<string, VenueMarketRef[]>; byEventSlug: Map<string, VenueMarketRef[]> }
export function buildDiagIndex(cands: VenueMarketRef[]): DiagIndex {
  const base = buildVenueIndex(cands) as DiagIndex; base.bySlug = new Map(); base.byEventSlug = new Map();
  const add = (m: Map<string, VenueMarketRef[]>, k: string, c: VenueMarketRef) => { const a = m.get(k); if (a) a.push(c); else m.set(k, [c]); };
  for (const c of cands) { if (c.slug) add(base.bySlug, c.slug.toLowerCase(), c); if (c.eventSlug) add(base.byEventSlug, c.eventSlug.toLowerCase(), c); }
  return base;
}
/** Candidates for the diagnostic WITHOUT any timestamp: shared identifiers, and the markets sharing the most content tokens with the title (at most `limit`, ties by market id). */
export function diagCandidates(sig: DiagSignal, idx: DiagIndex, limit = 60): VenueMarketRef[] {
  const out = new Map<string, VenueMarketRef>();
  const cid = (sig.conditionId ?? "").toLowerCase(); if (cid) for (const c of idx.byCondition.get(cid) ?? []) out.set(c.marketId, c);
  if (sig.tokenId) for (const c of idx.byToken.get(sig.tokenId) ?? []) out.set(c.marketId, c);
  if (sig.slug) for (const c of idx.bySlug.get(sig.slug.toLowerCase()) ?? []) out.set(c.marketId, c);
  if (sig.eventSlug) for (const c of idx.byEventSlug.get(sig.eventSlug.toLowerCase()) ?? []) out.set(c.marketId, c);
  const hits = new Map<string, { c: VenueMarketRef; n: number }>();
  for (const t of new Set(tokens(sig.title ?? ""))) { const list = idx.byTitleToken.get(t); if (!list || list.length > 4000) continue; for (const c of list) { const h = hits.get(c.marketId); if (h) h.n++; else hits.set(c.marketId, { c, n: 1 }); } }
  for (const { c } of [...hits.values()].sort((a, b) => b.n - a.n || (a.c.marketId < b.c.marketId ? -1 : 1)).slice(0, limit)) out.set(c.marketId, c);
  return [...out.values()];
}
/** Probe-only diagnostic: how similar is the nearest venue market to a signal's market, with no timestamp required. Deterministic; PROBABLE or NONE only. */
export function diagnoseSignal(sig: DiagSignal, idx: DiagIndex, topN = 3): DiagResult {
  const cid = (sig.conditionId ?? "").toLowerCase(); const cands = diagCandidates(sig, idx);
  const scored: DiagCandidate[] = cands.map((c) => {
    const t = titleSimilarity(sig.title, c.question); const ps = participantSimilarity(sig.title, c.question);
    const identifierMatch = (!!cid && (c.conditionIds ?? []).some((x) => x.toLowerCase() === cid)) || (!!sig.tokenId && (c.tokenIds ?? []).includes(sig.tokenId)) || (!!sig.slug && !!c.slug && c.slug.toLowerCase() === sig.slug.toLowerCase());
    const outcome = matchOutcome(sig.outcome, c);
    return { marketId: c.marketId, question: c.question, slug: c.slug ?? null, url: c.url ?? null, categories: c.categories ?? [], stratum: c.stratum ?? null, titleSimilarity: Math.round((t.exact ? 1 : t.score) * 1000) / 1000, participantSimilarity: Math.round(ps * 1000) / 1000, sameParticipants: ps >= PROBABLE_MIN_SIMILARITY, numbersAgree: t.numbersAgree, negationsAgree: t.negationsAgree, outcomeMatch: !sig.outcome || !c.outcomes?.length ? null : outcome !== null, categoryMatch: sig.stratum && c.stratum ? sig.stratum === c.stratum : null, identifierMatch, score: identifierMatch ? 1 : Math.max(t.exact ? 1 : t.score, ps) };
  }).sort((a, b) => b.score - a.score || Number(b.identifierMatch) - Number(a.identifierMatch) || (a.marketId < b.marketId ? -1 : 1));
  const bands: Record<string, number> = Object.fromEntries(SIMILARITY_BANDS.map((b) => [b.name, 0])); for (const c of scored) bands[bandOf(c.score)]++;
  const best = scored[0] ?? null;
  const qualifies = (c: DiagCandidate) => c.identifierMatch || (c.titleSimilarity >= PROBABLE_MIN_SIMILARITY && c.numbersAgree && c.negationsAgree && c.outcomeMatch === true);
  const winners = scored.filter((c) => qualifies(c) && c.score === best?.score);
  const evidence: string[] = [];
  if (!best) evidence.push("no candidate shares an identifier or a content token");
  else { evidence.push(`nearest: "${best.question ?? ""}" (title ${best.titleSimilarity}, participants ${best.participantSimilarity}${best.sameParticipants ? ", same participants" : ""}${best.identifierMatch ? ", IDENTIFIER MATCH" : ""})`); if (!best.identifierMatch && best.titleSimilarity < PROBABLE_MIN_SIMILARITY) evidence.push(`title similarity ${best.titleSimilarity} < ${PROBABLE_MIN_SIMILARITY}`); if (best.outcomeMatch === false) evidence.push("outcome label not found among the venue outcomes"); }
  const probable = winners.length === 1;
  if (winners.length > 1) evidence.push(`${winners.length} candidates qualify equally: no pick`);
  return { confidence: probable ? "PROBABLE" : "NONE", verified: false, dateChecked: false, identifierMatch: probable && winners[0].identifierMatch, best, top: scored.slice(0, topN), band: best ? bandOf(best.score) : "< 0.30", candidatesByBand: bands, candidatesGenerated: scored.length, evidence };
}
