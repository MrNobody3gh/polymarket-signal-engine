/**
 * Phase 4.0c, Part A4–A5 — the coverage funnel for Kalshi, exactly as for the US exchange (all entry signals → score ≥ 68 → mapped → tradable → usable
 * timestamp → not started → within 24 h → ≥ MIN_LEAD), from the same signal window, with the same caveats printed; and the category mix of our
 * score ≥ 68 flow against the Kalshi listing and the US listing in one table. READ-ONLY: a `ReadOnlyDb` (select only) and an already-fetched listing.
 * Probe only: no mapping is verified, no field is adopted, no threshold is changed.
 */
import { categorize, stratum } from "./categorize";
import { computeFunnel, SCORE_MIN, type FunnelResult, type FunnelRow } from "./funnel";
import { flatten, instantOf, type RawMarket, type SlotVerdict } from "./audit";
import { buildVenueIndex, candidatesFor, matchSignalToVenue, reviewRow, REVIEW_HEADER, type MatchResult, type VenueMarketRef } from "./mapping";
import { runDiagnostic, type DiagnosticSummary, type OurMarket } from "./diagnose";
import { selectAll, selectIn, type ReadOnlyDb } from "./readonly-db";
import { toCsv } from "./stats";
import { KALSHI, classifyFieldNameFor, easternParts, impliedEasternDate, resolveEventTime } from "./timestamps";
import { kalshiAll, kalshiBucket, kalshiCounts, kalshiSlug, kalshiTags, kalshiTitleOf, type KalshiCounts, type KalshiListing } from "./venue-kalshi";
import type { FetchNotes } from "./venues";
import { kalshiRefOf } from "./title-search";
import { ENTRY_KINDS } from "../paper/ledger";

/** The clean regime of docs/PHASE4_PLAN.md §1 (the 27 Sep 2026 re-score completion): the same constant probe.ts uses. */
export const COVERAGE_REGIME_START_ISO = "2026-09-27T04:28:38Z";

const kalshiStratum = (raw: RawMarket): string => stratum(categorize({ title: kalshiTitleOf(raw), slug: kalshiSlug(raw), tags: kalshiTags(raw) }));

/**
 * Was the Kalshi market tradable at the signal's evaluation time? APPROXIMATION (documented): the market had opened (`open_time` ≤ evaluation) and had not
 * closed (evaluation < `close_time`); with no close time, an open market counts as tradable and anything else is unknown (null, which the funnel counts as a
 * reject once measured). Resolution-like fields are never used here: Kalshi's expected and latest expiration times are forecasts of the settlement.
 */
export function kalshiTradableAt(raw: RawMarket, evalMs: number): boolean | null {
  const o = instantOf(raw.open_time), c = instantOf(raw.close_time);
  if (o !== null && evalMs < o) return false;
  if (c !== null) return evalMs < c;
  return kalshiBucket(raw) === "open" ? true : null;
}
/** The Kalshi market's event time under the recommended fields of its stratum (§3.3 pipeline); null = no usable timestamp (reject). */
export function kalshiEventTimeAt(raw: RawMarket, evalMs: number, recs: SlotVerdict[]): { ms: number | null; why: string } {
  const st = kalshiStratum(raw); const flat = flatten(raw); const rec = (slot: 1 | 2) => recs.find((r) => r.stratum === st && r.slot === slot && r.verdict === "RECOMMEND" && r.field);
  const s = rec(1), c = rec(2); if (!s && !c) return { ms: null, why: `no recommended field for ${st}` };
  const r = resolveEventTime({ start: s ? { field: s.field!, raw: flat[s.field!] } : null, close: c ? { field: c.field!, raw: flat[c.field!] } : null }, evalMs, { acceptLenientFormat: true });
  return r.ok ? { ms: r.eventMs, why: `slot ${r.slot} ${r.source.field}` } : { ms: null, why: r.code };
}
/** The Eastern calendar date a Kalshi market is on at DATE level only (a date-only / Eastern-placeholder close-like field, else the Eastern date of a real close). Never a time. */
export function kalshiDateLevel(raw: RawMarket): { date: string; basis: "implied" | "close_date" } | null {
  const closes = Object.entries(flatten(raw)).filter(([k]) => classifyFieldNameFor(KALSHI, k) === "CLOSE_LIKE").sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [, v] of closes) { const d = impliedEasternDate(v); if (d) return { date: d, basis: "implied" }; }
  for (const [, v] of closes) { const t = instantOf(v); if (t !== null) return { date: easternParts(t).date, basis: "close_date" }; }
  return null;
}

interface SignalRow { id: string; kind: string; wallet: string; condition_id: string; token_id: string; outcome: string | null; title: string | null; slug: string | null; created_at: string; evaluated_at: string | null; payload: Record<string, unknown> | null }
const SIGNAL_COLS = "id,kind,wallet,condition_id,token_id,outcome,title,slug,created_at,evaluated_at,payload";
const iso = (ms: number) => new Date(ms).toISOString();

export interface KalshiCoverageOptions {
  db: ReadOnlyDb; listing: KalshiListing | null;
  /** S1a recommendations for Kalshi (docs/phase4/data/s1a_summary.json, venue "kalshi"). null = the timestamp stage is not measured. */
  recommendations: SlotVerdict[] | null;
  startIso?: string; /** the end of the window; pass the US run's end so both funnels use the same signals */ endIso?: string; now?: () => number; reviewTarget?: number; diagnosticPairs?: boolean;
  write: (relPath: string, content: string) => void; log?: (m: string) => void;
}
export interface KalshiCoverageResult {
  venue: "kalshi"; startedAt: string; window: { startIso: string; endIso: string };
  counts: { signals: number; withScore: number; conditions: number };
  listing: { base: string | null; tried: KalshiListing["tried"]; notes: { open: FetchNotes | null; closed: FetchNotes | null; settled: FetchNotes | null }; candidates: number; counts: KalshiCounts | null; cap: number; cutOff: boolean };
  measured: { mapping: boolean; tradable: boolean; timestamp: boolean }; reasons: string[];
  funnel: FunnelResult; mappingBuckets: Record<string, number>; dateBasis: Record<string, number>;
  diagnostic: { pairs: number; byBestBand: Record<string, number>; probable: number; sameParticipants: number } | null;
  /** Our score ≥ 68 flow by stratum, with the Kalshi listing's markets by the same strata (shares are of each side's total). */
  mix: { stratum: string; oursScore68Signals: number; oursShare68: number; kalshiMarkets: number; kalshiShare: number }[];
  approximations: string[];
}

export async function runKalshiCoverage(o: KalshiCoverageOptions): Promise<KalshiCoverageResult> {
  const now = o.now ?? (() => Date.now()); const log = o.log ?? (() => {}); const startIso = o.startIso ?? COVERAGE_REGIME_START_ISO; const startMs = Date.parse(startIso); const endMs = o.endIso ? Date.parse(o.endIso) : now(); const endIso = iso(endMs);
  const approximations = [
    "event time and tradability come from Kalshi's CURRENT metadata applied to historical signal times (a postponed or re-listed event is not seen)",
    "tradable at signal time = opened (open_time ≤ evaluation) and not closed (evaluation < close_time); an open market with no close time counts as tradable; resolution-like fields (expected and latest expiration) are never used",
    "market mapping is a probe: Kalshi shares no identifier with Polymarket, so only PROBABLE exists (title ≥ 0.85, equal numbers and negations, dates within a day, outcome label); never verified; resolution-rule equivalence is not checked",
    "category comes from Kalshi's event category plus title/slug keywords (heuristic, unmeasured error rate)",
    "signal evaluation time = signals.evaluated_at when recorded, else created_at (source trade time)",
  ];
  log("kalshi: signals");
  const rows = await selectAll<SignalRow>((from, to) => o.db.select("signals", SIGNAL_COLS).in("kind", ENTRY_KINDS).gte("created_at", startIso).lt("created_at", endIso).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to));
  const seen = new Set<string>(); const sigs = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  const base: FunnelRow[] = sigs.map((r) => { const cs = Number((r.payload ?? {}).copyScore); const created = Date.parse(r.created_at); const ev = r.evaluated_at ? Date.parse(r.evaluated_at) : NaN;
    return { signalId: r.id, createdAtMs: created, evalMs: Number.isFinite(ev) ? ev : created, kind: r.kind, wallet: r.wallet, category: stratum(categorize({ title: r.title, slug: r.slug })), copyScore: Number.isFinite(cs) && (r.payload ?? {}).copyScore !== null ? cs : null, mapping: "NOT_MEASURED", tradable: null, eventMs: null, lagObserved: Number.isFinite(ev) }; });
  const scored = sigs.filter((_, i) => base[i].copyScore !== null && base[i].copyScore! >= SCORE_MIN); const conds = [...new Set(scored.map((r) => String(r.condition_id).toLowerCase()))];
  const ends = new Map<string, string>(); for (const m of await selectIn<{ condition_id: string; end_date: string | null }>(conds, (c) => o.db.select("markets", "condition_id,end_date").in("condition_id", c as string[]))) if (m.end_date) ends.set(String(m.condition_id).toLowerCase(), String(m.end_date).slice(0, 10));

  const reasons: string[] = []; const measured = { mapping: false, tradable: false, timestamp: false }; const buckets: Record<string, number> = { EXACT: 0, PROBABLE: 0, NONE: 0 }; const dateBasis: Record<string, number> = {};
  const matches = new Map<string, { m: MatchResult; raw: RawMarket | null }>(); let diagnostic: KalshiCoverageResult["diagnostic"] = null; let candidates = 0; let counts: KalshiCounts | null = null; let strata: string[] = [];
  const L = o.listing; const cutOff = !!L && [L.open, L.closed, L.settled].some((f) => f && f.notes.records > 0 && /sample size reached|page limit reached/.test(f.notes.stoppedBecause));
  if (!L || !L.base) reasons.push(`Kalshi unreachable or not configured${L ? ` (${L.tried.map((t) => `${t.base}: ${t.outcome}`).join("; ")})` : ""}: stages after the copy-score stage are not measured`);
  else {
    const all = kalshiAll(L); const refs: VenueMarketRef[] = []; const raw = new Map<string, RawMarket>(); for (const m of all) { const r = kalshiRefOf(m); if (r && !raw.has(r.marketId)) { raw.set(r.marketId, m); refs.push(r); } }
    candidates = refs.length; counts = kalshiCounts(all); strata = all.map(kalshiStratum);
    for (const [name, f] of [["open", L.open], ["closed", L.closed], ["settled", L.settled]] as const) if (f?.notes.errors.length) reasons.push(`${name} listing: ${f.notes.errors[0]}`);
    if (cutOff) reasons.push(`the Kalshi listing was cut off at ${L.cap} markets: mapped counts are a LOWER BOUND; raise --kalshi-max`);
    if (!refs.length) reasons.push("Kalshi returned no markets: stages after the copy-score stage are not measured");
    else {
      measured.mapping = true; measured.tradable = true; if (o.recommendations) measured.timestamp = true; else reasons.push("no S1a recommendations for kalshi (docs/phase4/data/s1a_summary.json): usable-timestamp and later stages are not measured, and PROBABLE matches (which need a venue date) rely on a close-like date only");
      const dated = refs.map((c) => { const rw = raw.get(c.marketId)!; const t = o.recommendations ? kalshiEventTimeAt(rw, startMs, o.recommendations) : { ms: null as number | null }; if (t.ms !== null) return { ...c, eventDate: iso(t.ms) }; const d = kalshiDateLevel(rw); return d ? { ...c, eventDate: d.date } : c; });
      const idx = buildVenueIndex(dated);
      for (const r of scored) { const key = `${String(r.condition_id).toLowerCase()}|${r.outcome ?? ""}`; if (matches.has(key)) continue; const sig = { conditionId: r.condition_id, tokenId: r.token_id, title: r.title, outcome: r.outcome, eventDate: ends.get(String(r.condition_id).toLowerCase()) ?? null }; const m = matchSignalToVenue(sig, candidatesFor(sig, idx)); matches.set(key, { m, raw: m.candidate ? raw.get(m.candidate.marketId) ?? null : null }); }
      for (const { m, raw: rw } of matches.values()) { buckets[m.confidence]++; if (m.confidence !== "NONE" && rw) { const k = kalshiDateLevel(rw)?.basis ?? "none"; dateBasis[k] = (dateBasis[k] ?? 0) + 1; } }
      base.forEach((r, i) => { if (r.copyScore === null || r.copyScore < SCORE_MIN) return; const hit = matches.get(`${String(sigs[i].condition_id).toLowerCase()}|${sigs[i].outcome ?? ""}`); if (!hit) return; r.mapping = hit.m.confidence; if (hit.raw) { r.tradable = kalshiTradableAt(hit.raw, r.evalMs); if (o.recommendations) r.eventMs = kalshiEventTimeAt(hit.raw, r.evalMs, o.recommendations).ms; } });
      for (const r of base) if (r.mapping === "NOT_MEASURED" && (r.copyScore ?? -1) >= SCORE_MIN) r.mapping = "NONE";
      if (o.diagnosticPairs !== false) {
        const pm = new Map<string, OurMarket>(); sigs.forEach((r, i) => { const k = `${String(r.condition_id).toLowerCase()}|${r.outcome ?? ""}`; const sc = base[i].copyScore; const cur = pm.get(k); if (cur) { cur.signals++; if (sc !== null && (cur.score === null || sc > cur.score)) cur.score = sc; } else pm.set(k, { conditionId: r.condition_id, tokenId: r.token_id, title: r.title, slug: r.slug, outcome: r.outcome, stratum: base[i].category, score: sc, signals: 1 }); });
        const run = runDiagnostic([...pm.values()].filter((m) => m.score !== null && m.score >= SCORE_MIN), refs); const sm: DiagnosticSummary = run.summary; diagnostic = { pairs: sm.pairs, byBestBand: sm.byBestBand, probable: sm.probable, sameParticipants: sm.sameParticipants };
      }
    }
  }
  const funnel = computeFunnel(base, { startMs, endMs, measured });
  // the mapping review sample (≥ 50 pairs, by category) for the owner's eye
  const review = [...new Map(sigs.map((r, i) => [`${String(r.condition_id).toLowerCase()}|${r.outcome ?? ""}`, { r, cat: base[i].category }] as const)).values()].map(({ r, cat }) => ({ r, cat, hit: matches.get(`${String(r.condition_id).toLowerCase()}|${r.outcome ?? ""}`) })).filter((x) => x.hit && x.hit.m.confidence !== "NONE").sort((a, b) => (a.r.id < b.r.id ? -1 : 1)).slice(0, o.reviewTarget ?? 60);
  o.write("s1b_mapping_review_kalshi.csv", toCsv(REVIEW_HEADER, review.map((x) => reviewRow(x.cat, { conditionId: x.r.condition_id, tokenId: x.r.token_id, title: x.r.title, outcome: x.r.outcome, eventDate: ends.get(String(x.r.condition_id).toLowerCase()) ?? null, url: x.r.slug ? `https://polymarket.com/event/${x.r.slug}` : null }, x.hit!.m))));
  const ours = sigs.map((r, i) => ({ stratum: base[i].category, score: base[i].copyScore })); const n68 = ours.filter((x) => x.score !== null && x.score >= SCORE_MIN).length || 1; const nk = strata.length || 1; const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const mix = [...new Set([...ours.map((x) => x.stratum), ...strata])].sort().map((k) => { const o68 = ours.filter((x) => x.stratum === k && x.score !== null && x.score >= SCORE_MIN).length; const km = strata.filter((x) => x === k).length; return { stratum: k, oursScore68Signals: o68, oursShare68: r3(o68 / n68), kalshiMarkets: km, kalshiShare: r3(km / nk) }; });
  const result: KalshiCoverageResult = { venue: "kalshi", startedAt: iso(endMs), window: { startIso, endIso }, counts: { signals: sigs.length, withScore: scored.length, conditions: conds.length },
    listing: { base: L?.base ?? null, tried: L?.tried ?? [], notes: { open: L?.open?.notes ?? null, closed: L?.closed?.notes ?? null, settled: L?.settled?.notes ?? null }, candidates, counts, cap: L?.cap ?? 0, cutOff }, measured, reasons, funnel, mappingBuckets: buckets, dateBasis, diagnostic, mix, approximations };
  o.write("s1b_funnel_kalshi.json", JSON.stringify(result, null, 1));
  return result;
}

// ───────────────────────────────────────────── the three-way category table ───────────────────────────────

export interface Mix3Row { stratum: string; ours68: number; oursShare: number; kalshiMarkets: number | null; kalshiShare: number | null; usMarkets: number | null; usShare: number | null }
/**
 * One table: our score ≥ 68 signals against the Kalshi listing and the US-exchange listing, by stratum (counts per stratum; a listing that was not fetched is null
 * and prints as n/m). Shares are of each side's own total.
 */
export function categoryMix3(ours68: Record<string, number>, kalshi: Record<string, number> | null, us: Record<string, number> | null): Mix3Row[] {
  const tot = (o: Record<string, number> | null) => (o ? Object.values(o).reduce((a, b) => a + b, 0) || 1 : 1); const n68 = tot(ours68), kT = tot(kalshi), uT = tot(us); const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const keys = [...new Set([...Object.keys(ours68), ...Object.keys(kalshi ?? {}), ...Object.keys(us ?? {})])].sort();
  return keys.map((k) => { const o = ours68[k] ?? 0; const km = kalshi ? kalshi[k] ?? 0 : null; const um = us ? us[k] ?? 0 : null;
    return { stratum: k, ours68: o, oursShare: r3(o / n68), kalshiMarkets: km, kalshiShare: km === null ? null : r3(km / kT), usMarkets: um, usShare: um === null ? null : r3(um / uT) }; }).sort((a, b) => b.ours68 - a.ours68 || (a.stratum < b.stratum ? -1 : 1));
}
const pc = (x: number | null) => (x === null ? "n/m" : `${(x * 100).toFixed(0)}%`);
export const mix3Lines = (rows: Mix3Row[], limit = 9): string[] => ["category mix, our score ≥ 68 flow vs listings (markets): stratum | ours | Kalshi | US exchange", ...rows.slice(0, limit).map((r) => `  ${r.stratum.padEnd(22)} ${pc(r.oursShare).padStart(4)} (${r.ours68}) | ${pc(r.kalshiShare).padStart(4)} (${r.kalshiMarkets ?? "n/m"}) | ${pc(r.usShare).padStart(4)} (${r.usMarkets ?? "n/m"})`)];

const f1 = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "n/m" : x.toFixed(d));
/** ≤ 60 printed lines for the Kalshi funnel. */
export function kalshiCoverageSummaryLines(r: KalshiCoverageResult, outDir: string): string[] {
  const L: string[] = [`S1b Kalshi coverage  ${r.window.startIso} → ${r.window.endIso}  (${r.funnel.window.elapsedDays.toFixed(1)} days)`, `signals ${r.counts.signals} · score ≥ 68: ${r.counts.withScore} · Kalshi candidates ${r.listing.candidates} (base ${r.listing.base ?? "none"})`];
  for (const x of r.reasons) L.push(`NOT MEASURED: ${x}`.slice(0, 200));
  if (r.listing.counts) { const c = r.listing.counts; L.push(`Kalshi listing: ${c.total} markets, ${c.distinctEvents} events; ${Object.entries(c.byBucket).map(([k, n]) => `${k} ${n}`).join(" · ")}`); }
  L.push("stage                                   EXACT   /day (min–max)  | +PROBABLE");
  const ex = r.funnel.variants.EXACT, pr = r.funnel.variants.EXACT_PLUS_PROBABLE;
  r.funnel.stages.forEach((s, i) => { const pd = ex.perDay[s.key]; L.push(`${s.label.slice(0, 38).padEnd(38)} ${String(ex.counts[i] ?? "n/m").padStart(6)}  ${pd?.perElapsedDay == null ? "n/m" : f1(pd.perElapsedDay)}${pd?.completeDays.min != null ? ` (${pd.completeDays.min}–${pd.completeDays.max})` : ""}`.padEnd(70) + `| ${pr.counts[i] ?? "n/m"}`); });
  L.push(`mapping (score ≥ 68, by market+outcome): EXACT ${r.mappingBuckets.EXACT} · PROBABLE ${r.mappingBuckets.PROBABLE} · NONE ${r.mappingBuckets.NONE}`);
  if (r.diagnostic) L.push(`timestamp-free diagnostic (${r.diagnostic.pairs} pairs): best band ${Object.entries(r.diagnostic.byBestBand).map(([b, n]) => `${b} ${n}`).join(" · ")} · same participants ${r.diagnostic.sameParticipants}`);
  const top = [...r.mix].sort((a, b) => b.oursScore68Signals - a.oursScore68Signals).slice(0, 5); if (top.length) L.push(`category mix ours(≥68) vs Kalshi: ${top.map((x) => `${x.stratum} ${(x.oursShare68 * 100).toFixed(0)}% vs ${(x.kalshiShare * 100).toFixed(0)}%`).join(" · ")}`);
  L.push(`final stage: wallets ${ex.wallets[ex.wallets.length - 1] ?? "n/m"} · top-3 wallet share ${ex.top3Share === null ? "n/m" : (ex.top3Share * 100).toFixed(0) + " %"}`);
  L.push(`files in ${outDir}: s1b_funnel_kalshi.json s1b_mapping_review_kalshi.csv`);
  return L.map((l) => (l.length > 220 ? l.slice(0, 217) + "..." : l)).slice(0, 60);
}
