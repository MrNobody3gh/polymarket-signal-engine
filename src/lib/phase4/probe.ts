/**
 * Phase 4.0 (S1b) — the coverage probe, orchestrated. READ-ONLY: it receives a `ReadOnlyDb` (select only) and a
 * `PoliteHttp` (GET of public venue data only). It writes nothing but the files handed to `write`.
 *
 *  1. entry signals since the clean regime (`signals`, select), with `payload.copyScore` as the score at signal time;
 *  2. stored date-level end dates (`markets`, select) for the date-proxy;
 *  3. the execution venue's market list (public GET), matched to the signals' markets (mapping.ts);
 *  4. each candidate's tradability and event time under the S1a recommended fields (timestamps.ts §3.3);
 *  5. the funnel (funnel.ts), the mapping review sample, and the feasibility table from settled paper trades.
 * Every stage the run could not measure is reported as not measured, never as zero.
 */
import { categorize, stratum } from "./categorize";
import { computeFunnel, SCORE_MIN, type FunnelResult, type FunnelRow } from "./funnel";
import { buildFeasibility, type FeasibilityResult, type SettledTrade } from "./feasibility";
import type { SlotVerdict } from "./audit";
import type { PoliteHttp } from "./http";
import { buildVenueIndex, candidatesFor, matchSignalToVenue, reviewRow, REVIEW_HEADER, type MatchResult, type VenueMarketRef } from "./mapping";
import { categoryMix, diagnosticCsv, runDiagnostic, scoreBand, stratifiedRandom, type DiagnosticSummary, type MixRow, type OurMarket } from "./diagnose";
import { selectAll, selectIn, type ReadOnlyDb } from "./readonly-db";
import { toCsv } from "./stats";
import { classifyFieldName, DAY_MS, easternParts, impliedEasternDate, resolveEventTime } from "./timestamps";
import { fetchUs, listingTotals, US_EXCHANGE, usIdOf, usIsResolved, usOutcomes, usTitleOf, tagsOf, type FetchNotes, type ListingTotals, type UsConfig } from "./venues";
import { ENTRY_KINDS } from "../paper/ledger";
import { flatten, instantOf, type RawMarket } from "./audit";

/** The clean regime of docs/PHASE4_PLAN.md §1 (the 27 Sep 2026 re-score completion). */
export const REGIME_START_ISO = "2026-09-27T04:28:38Z";

export interface CoverageOptions {
  db: ReadOnlyDb; http: PoliteHttp | null; us: UsConfig | null;
  /** S1a recommendations for the US venue (from docs/phase4/data/s1a_summary.json). null = timestamp stage not measured. */
  recommendations: SlotVerdict[] | null;
  startIso?: string; now?: () => number; mode?: "REALISTIC" | "IDEAL" | "CONSERVATIVE";
  /** Cap on the venue listing (open + closed together). Default 6,000; unlimited (page until the listing ends) in diagnostic mode unless set. */
  maxUsMarkets?: number; reviewTarget?: number;
  /** Diagnostic mode (4.0b): the full listing, the timestamp-free matcher, `s1b_diagnostic.json` and `s1b_mapping_diagnostic.csv`. */
  diagnose?: boolean; diagnosticSample?: number;
  write: (relPath: string, content: string) => void; log?: (m: string) => void;
}
export interface CoverageResult {
  startedAt: string; window: { startIso: string; endIso: string };
  counts: { signals: number; withScore: number; conditions: number };
  venue: { configured: boolean; notes: { open: FetchNotes | null; closed: FetchNotes | null }; candidates: number; measured: { mapping: boolean; tradable: boolean; timestamp: boolean }; reasons: string[] };
  funnel: FunnelResult; mappingBuckets: Record<string, number>;
  /** How the venue date used by the strict matcher was obtained, for the matched candidates. */
  dateBasis: Record<string, number>;
  diagnostic: { listing: Record<string, ListingTotals | null>; summary: DiagnosticSummary | null; categoryMix: MixRow[]; sampled: number } | null;
  feasibility: FeasibilityResult; feasibilityMode: string; settled: { n: number; fillShare: number | null };
  approximations: string[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const SIGNAL_COLS = "id,kind,wallet,condition_id,token_id,outcome,title,slug,price,created_at,evaluated_at,payload";
const dayIndex = (ms: number) => Math.floor(ms / DAY_MS);

interface SignalRow { id: string; kind: string; wallet: string; condition_id: string; token_id: string; outcome: string | null; title: string | null; slug: string | null; price: number; created_at: string; evaluated_at: string | null; payload: Record<string, unknown> | null }

/** Candidate venue markets as VenueMarketRef plus the raw object (kept for timing). */
function toVenueRefs(raws: RawMarket[], usedIds = new Set<string>()): { refs: VenueMarketRef[]; raw: Map<string, RawMarket> } {
  const refs: VenueMarketRef[] = []; const raw = new Map<string, RawMarket>();
  for (const m of raws) {
    const id = usIdOf(m); if (!id || usedIds.has(id)) continue; usedIds.add(id); raw.set(id, m);
    const tok = Array.isArray(m.clobTokenIds) ? (m.clobTokenIds as unknown[]).map(String) : [];
    const cond = [m.conditionId, m.condition_id].filter((x): x is string => typeof x === "string" && !!x);
    refs.push({ venue: US_EXCHANGE, marketId: id, slug: typeof m.slug === "string" ? m.slug : null, url: typeof m.url === "string" ? m.url : null, conditionIds: cond, tokenIds: tok, question: usTitleOf(m), outcomes: usOutcomes(m), eventDate: null, eventSlug: typeof m.eventSlug === "string" ? m.eventSlug : null, categories: tagsOf(m), stratum: stratum(categorize({ title: usTitleOf(m), slug: typeof m.slug === "string" ? m.slug : null, tags: tagsOf(m) })) });
  }
  return { refs, raw };
}

/** Candidate's tradability at the signal's evaluation time (APPROXIMATION, documented): open now; or resolved with a resolution-like time not before the evaluation time. Unknown → null. */
export function tradableAt(raw: RawMarket, evalMs: number): boolean | null {
  if (!usIsResolved(raw)) return true;
  const flat = flatten(raw); const times = Object.entries(flat).filter(([k]) => classifyFieldName(k) === "RESOLUTION_LIKE").map(([, v]) => instantOf(v)).filter((x): x is number => x !== null);
  if (!times.length) return null;
  return Math.min(...times) >= evalMs;
}

/** Event time of a candidate under the recommended fields for its stratum (§3.3 pipeline); null = no usable timestamp (reject). */
export function eventTimeAt(raw: RawMarket, evalMs: number, recs: SlotVerdict[]): { ms: number | null; why: string } {
  const st = stratum(categorize({ title: usTitleOf(raw), slug: typeof raw.slug === "string" ? raw.slug : null, tags: tagsOf(raw) }));
  const flat = flatten(raw);
  const rec = (slot: 1 | 2) => recs.find((r) => r.stratum === st && r.slot === slot && r.verdict === "RECOMMEND" && r.field);
  const s = rec(1), c = rec(2);
  if (!s && !c) return { ms: null, why: `no recommended field for ${st}` };
  const r = resolveEventTime({ start: s ? { field: s.field!, raw: flat[s.field!] } : null, close: c ? { field: c.field!, raw: flat[c.field!] } : null }, evalMs, { acceptLenientFormat: true });
  return r.ok ? { ms: r.eventMs, why: `slot ${r.slot} ${r.source.field}` } : { ms: null, why: r.code };
}

/**
 * The calendar date a venue market is on, at DATE level only: the Eastern date implied by a date-only or Eastern-placeholder close-like
 * field (`implied`), else the Eastern date of any other close-like datetime (`close_date`: a real deadline is still evidence of the day).
 * Never a time, and never a start-like field (those are listing times). null = none.
 */
export function candidateDateLevel(raw: RawMarket): { date: string; basis: "implied" | "close_date" } | null {
  const flat = flatten(raw); const closes = Object.entries(flat).filter(([k]) => classifyFieldName(k) === "CLOSE_LIKE").sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [, v] of closes) { const d = impliedEasternDate(v); if (d) return { date: d, basis: "implied" }; }
  for (const [, v] of closes) { const t = instantOf(v); if (t !== null) return { date: easternParts(t).date, basis: "close_date" }; }
  return null;
}
/** Only the dates a placeholder or date-only value implies (for the date-level funnel row, which is not the V1 policy). */
export const candidateImpliedDate = (raw: RawMarket): string | null => { const d = candidateDateLevel(raw); return d && d.basis === "implied" ? d.date : null; };

export async function runCoverage(o: CoverageOptions): Promise<CoverageResult> {
  const now = o.now ?? (() => Date.now()); const log = o.log ?? (() => {}); const startIso = o.startIso ?? REGIME_START_ISO; const startMs = Date.parse(startIso); const endMs = now(); const endIso = iso(endMs); const mode = o.mode ?? "REALISTIC";
  const approximations = [
    "event time and tradability come from the venue's CURRENT metadata applied to historical signal times (a postponed or re-listed event is not seen)",
    "tradable at signal time = the venue market is open now, or resolved at/after the signal's evaluation time (resolution-like field named by the audit)",
    "market mapping is a probe: EXACT/PROBABLE are candidates for human review, never verified; resolution-rule equivalence is not checked",
    "category comes from title/slug/tags keywords (heuristic, unmeasured error rate)",
    "signal evaluation time = signals.evaluated_at when recorded, else created_at (source trade time)",
  ];

  // 1 — signals (select only); a fixed upper bound so rows inserted while paging cannot move the window
  log("signals");
  const rows = await selectAll<SignalRow>((from, to) => o.db.select("signals", SIGNAL_COLS).in("kind", ENTRY_KINDS).gte("created_at", startIso).lt("created_at", endIso).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to));
  const seen = new Set<string>(); const sigs = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  const base: FunnelRow[] = sigs.map((r) => { const cs = Number((r.payload ?? {}).copyScore); const created = Date.parse(r.created_at); const ev = r.evaluated_at ? Date.parse(r.evaluated_at) : NaN;
    return { signalId: r.id, createdAtMs: created, evalMs: Number.isFinite(ev) ? ev : created, kind: r.kind, wallet: r.wallet, category: stratum(categorize({ title: r.title, slug: r.slug })), copyScore: Number.isFinite(cs) && (r.payload ?? {}).copyScore !== null ? cs : null, mapping: "NOT_MEASURED", tradable: null, eventMs: null, lagObserved: Number.isFinite(ev) }; });
  const scored = sigs.filter((_, i) => base[i].copyScore !== null && base[i].copyScore! >= SCORE_MIN);
  const conds = [...new Set(scored.map((r) => String(r.condition_id).toLowerCase()))];

  // 2 — stored date-level end dates (select only), for the proxy and the eligible-like subset
  log("end dates");
  const ends = new Map<string, string>(); for (const m of await selectIn<{ condition_id: string; end_date: string | null }>(conds, (c) => o.db.select("markets", "condition_id,end_date").in("condition_id", c as string[]))) if (m.end_date) ends.set(String(m.condition_id).toLowerCase(), String(m.end_date).slice(0, 10));
  const proxy = (i: number): boolean | undefined => { if (base[i].copyScore === null || base[i].copyScore! < SCORE_MIN) return undefined; const e = ends.get(String(sigs[i].condition_id).toLowerCase()); if (!e) return false; const d = Date.parse(e + "T00:00:00Z") / DAY_MS, c = dayIndex(base[i].createdAtMs); return d >= c && d <= c + 1; };
  base.forEach((r, i) => { r.proxyWithin24h = proxy(i); });

  // 3–4 — the execution venue
  const reasons: string[] = []; const measured = { mapping: false, tradable: false, timestamp: false }; let notes: { open: FetchNotes | null; closed: FetchNotes | null } = { open: null, closed: null }; let candidates = 0; const buckets: Record<string, number> = { EXACT: 0, PROBABLE: 0, NONE: 0 };
  const matches = new Map<string, { m: MatchResult; raw: RawMarket | null }>();
  let venueLists: { open: RawMarket[]; closed: RawMarket[]; archived: RawMarket[] | null } | null = null; let venueRefs: VenueMarketRef[] = []; const dateBasis: Record<string, number> = {};
  if (!o.us || !o.http) reasons.push("execution venue not configured: stages after the copy-score stage are not measured");
  else {
    log("venue crawl"); const cap = o.maxUsMarkets ?? (o.diagnose ? Infinity : 6000); const half = cap === Infinity ? Infinity : Math.ceil(cap / 2);
    const open = await fetchUs(o.http, o.us, { closed: false, max: half }); const closed = await fetchUs(o.http, o.us, { closed: true, max: half }); notes = { open: open.notes, closed: closed.notes };
    const archived = o.diagnose && o.us.archivedQuery ? await fetchUs(o.http, o.us, { closed: true, max: half, query: o.us.archivedQuery }) : null;
    if (archived?.notes.errors.length) reasons.push(`archived listing: ${archived.notes.errors[0]}`);
    venueLists = { open: open.markets, closed: closed.markets, archived: archived?.markets ?? null };
    const { refs, raw } = toVenueRefs([...open.markets, ...closed.markets, ...(archived?.markets ?? [])]); candidates = refs.length; venueRefs = refs;
    for (const [name, n] of [["open", open.notes], ["closed", closed.notes]] as const) if (n.records > 0 && /sample size reached|page limit reached/.test(n.stoppedBecause)) reasons.push(`the venue's ${name} listing was cut off at ${n.records} markets (${n.stoppedBecause}): mapped counts are a LOWER BOUND; raise --us-max`);
    if (!refs.length) reasons.push(`execution venue returned no markets (${[...open.notes.errors, ...closed.notes.errors][0] ?? "empty"}): stages after the copy-score stage are not measured`);
    else {
      measured.mapping = true; measured.tradable = true;
      // The venue's event date (under the S1a recommended fields) lets PROBABLE compare dates; without recommendations only identifier matches can be found.
      if (o.recommendations) measured.timestamp = true; else reasons.push("no S1a recommendations supplied (docs/phase4/data/s1a_summary.json): usable-timestamp and later stages are not measured, and PROBABLE matches (which need a venue date) cannot be found; only identifier matches");
      const dated = refs.map((c) => { const rw = raw.get(c.marketId)!; const t = o.recommendations ? eventTimeAt(rw, startMs, o.recommendations) : { ms: null as number | null }; if (t.ms !== null) return { ...c, eventDate: iso(t.ms) }; const d = candidateDateLevel(rw); return d ? { ...c, eventDate: d.date } : c; });
      // the DATE the strict matcher compares is a date (within one day), taken from the recommended field when there is one, else from a close-like field's Eastern date: the PROBABLE rule itself is unchanged
      const idx = buildVenueIndex(dated);
      // the signal side's date is the stored date-level end date, the only date we hold; date-level agreement is enough for PROBABLE
      for (const r of scored) {
        const key = `${String(r.condition_id).toLowerCase()}|${r.outcome ?? ""}`; if (matches.has(key)) continue;
        const sig = { conditionId: r.condition_id, tokenId: r.token_id, title: r.title, outcome: r.outcome, eventDate: ends.get(String(r.condition_id).toLowerCase()) ?? null };
        const m = matchSignalToVenue(sig, candidatesFor(sig, idx)); matches.set(key, { m, raw: m.candidate ? raw.get(m.candidate.marketId) ?? null : null });
      }
      for (const { m, raw: rw } of matches.values()) { buckets[m.confidence]++; if (m.confidence !== "NONE" && rw) { const d = candidateDateLevel(rw); const k = d?.basis ?? "none"; dateBasis[k] = (dateBasis[k] ?? 0) + 1; } }
      base.forEach((r, i) => {
        if (r.copyScore === null || r.copyScore < SCORE_MIN) return;
        const hit = matches.get(`${String(sigs[i].condition_id).toLowerCase()}|${sigs[i].outcome ?? ""}`); if (!hit) return;
        r.mapping = hit.m.confidence;
        if (hit.raw) { r.impliedDateEt = candidateImpliedDate(hit.raw); r.tradable = tradableAt(hit.raw, r.evalMs); if (o.recommendations) r.eventMs = eventTimeAt(hit.raw, r.evalMs, o.recommendations).ms; }
      });
      for (const r of base) if (r.mapping === "NOT_MEASURED" && (r.copyScore ?? -1) >= SCORE_MIN) r.mapping = "NONE";
    }
  }
  const funnel = computeFunnel(base, { startMs, endMs, measured });

  // 5 — the mapping review sample (≥ 50 pairs, stratified by category) for the owner
  const review = [...new Map(sigs.map((r, i) => [`${String(r.condition_id).toLowerCase()}|${r.outcome ?? ""}`, { r, cat: base[i].category }] as const)).values()]
    .map(({ r, cat }) => ({ r, cat, hit: matches.get(`${String(r.condition_id).toLowerCase()}|${r.outcome ?? ""}`) })).filter((x) => x.hit && x.hit.m.confidence !== "NONE").sort((a, b) => (a.r.id < b.r.id ? -1 : 1));
  const target = o.reviewTarget ?? 60; const cats = [...new Set(review.map((x) => x.cat))].sort(); const perCat = Math.max(1, Math.ceil(target / Math.max(1, cats.length))); const taken: typeof review = []; const count: Record<string, number> = {};
  for (const x of review) { if ((count[x.cat] ?? 0) < perCat) { count[x.cat] = (count[x.cat] ?? 0) + 1; taken.push(x); } }
  for (const x of review) { if (taken.length >= target) break; if (!taken.includes(x)) taken.push(x); }
  o.write("s1b_mapping_review.csv", toCsv(REVIEW_HEADER, taken.map((x) => reviewRow(x.cat, { conditionId: x.r.condition_id, tokenId: x.r.token_id, title: x.r.title, outcome: x.r.outcome, eventDate: ends.get(String(x.r.condition_id).toLowerCase()) ?? null, url: x.r.slug ? `https://polymarket.com/event/${x.r.slug}` : null }, x.hit!.m))));

  // 5b — diagnostic (4.0b): why did nothing map? timestamp-free candidates, a sample for the owner's eye, the category mix
  let diagnostic: CoverageResult["diagnostic"] = null;
  if (o.diagnose) {
    log("diagnostic");
    const pairMap = new Map<string, OurMarket>();
    sigs.forEach((r, i) => { const k = `${String(r.condition_id).toLowerCase()}|${r.outcome ?? ""}`; const sc = base[i].copyScore; const cur = pairMap.get(k);
      if (cur) { cur.signals++; if (sc !== null && (cur.score === null || sc > cur.score)) cur.score = sc; } else pairMap.set(k, { conditionId: r.condition_id, tokenId: r.token_id, title: r.title, slug: r.slug, outcome: r.outcome, stratum: base[i].category, score: sc, signals: 1 }); });
    const allPairs = [...pairMap.values()].sort((a, b) => (a.conditionId + a.outcome! < b.conditionId + b.outcome! ? -1 : 1)); const pairs68 = allPairs.filter((m) => m.score !== null && m.score >= SCORE_MIN);
    const listing: Record<string, ListingTotals | null> = { open: venueLists ? listingTotals(venueLists.open) : null, closed: venueLists ? listingTotals(venueLists.closed) : null, archived: venueLists?.archived ? listingTotals(venueLists.archived) : null, all: venueLists ? listingTotals([...venueLists.open, ...venueLists.closed, ...(venueLists.archived ?? [])]) : null };
    let summary: DiagnosticSummary | null = null; let sampled = 0; const mix: MixRow[] = [];
    const ours = sigs.map((r, i) => ({ stratum: base[i].category, score: base[i].copyScore, condition: String(r.condition_id).toLowerCase() }));
    if (venueRefs.length) {
      const run68 = runDiagnostic(pairs68, venueRefs); summary = run68.summary;
      // 100 distinct markets (condition), stratified random over category x score band, seeded by the window start (reproducible)
      const byCond = new Map<string, OurMarket>(); for (const m of allPairs) { const k = m.conditionId.toLowerCase(); const cur = byCond.get(k); if (!cur || (m.score ?? -1) > (cur.score ?? -1)) byCond.set(k, m); }
      const pick = stratifiedRandom([...byCond.values()].sort((a, b) => (a.conditionId < b.conditionId ? -1 : 1)), (m) => `${m.stratum}|${scoreBand(m.score)}`, o.diagnosticSample ?? 100, startIso);
      const runSample = runDiagnostic(pick, venueRefs); sampled = pick.length;
      o.write("s1b_mapping_diagnostic.csv", diagnosticCsv(runSample.results));
      const venueStrata = [...(venueLists?.open ?? []).map((m) => ({ m, closed: false })), ...(venueLists?.closed ?? []).map((m) => ({ m, closed: true })), ...(venueLists?.archived ?? []).map((m) => ({ m, closed: true }))].map(({ m, closed }) => ({ stratum: stratum(categorize({ title: usTitleOf(m), slug: typeof m.slug === "string" ? m.slug : null, tags: tagsOf(m) })), closed }));
      mix.push(...categoryMix(ours, venueStrata));
    } else mix.push(...categoryMix(ours, []));
    diagnostic = { listing, summary, categoryMix: mix, sampled };
    o.write("s1b_diagnostic.json", JSON.stringify({ window: { startIso, endIso }, listing, diagnostic: summary, categoryMix: mix, sampled, dateBasis, notes: venueRefs.length ? [] : ["the venue listing was not available: nothing to compare with"] }, null, 1));
  }

  // 6 — feasibility from settled paper trades (select only)
  log("settled paper trades");
  const ex = await selectAll<{ signal_id: string; coverage_state: string | null; state: string | null; fill_ts: string | null; closed_at: string | null; net_pnl: number | null; filled_usd: number | null }>((from, to) => o.db.select("paper_executions", "signal_id,coverage_state,state,fill_ts,closed_at,net_pnl,filled_usd").eq("mode", mode).gte("source_trade_ts", startIso).lt("source_trade_ts", endIso).order("signal_id", { ascending: true }).range(from, to));
  const bySig = new Map(sigs.map((r, i) => [r.id, { r, f: base[i] }])); const trades: SettledTrade[] = []; let sim = 0, unfilled = 0;
  for (const e of ex) {
    if (e.coverage_state === "SIMULATED") sim++; else if (e.coverage_state === "UNFILLED") unfilled++;
    const s = bySig.get(e.signal_id); if (!s || e.coverage_state !== "SIMULATED" || (e.state !== "RESOLVED" && e.state !== "EXITED")) continue;
    const usd = Number(e.filled_usd), pnl = Number(e.net_pnl), t0 = e.fill_ts ? Date.parse(e.fill_ts) : NaN, t1 = e.closed_at ? Date.parse(e.closed_at) : NaN;
    if (!(usd > 0) || !Number.isFinite(pnl) || !Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) continue;
    trades.push({ signalId: e.signal_id, conditionId: String(s.r.condition_id).toLowerCase(), wallet: s.r.wallet, returnPts: (pnl / usd) * 100, holdDays: (t1 - t0) / DAY_MS, eligibleLike: s.f.proxyWithin24h === true });
  }
  const fin = funnel.variants.EXACT.perDay.minLead; const px = funnel.proxy.perDay;
  const eligiblePerDay = fin?.completeDays.mean != null ? { value: fin.completeDays.mean, basis: "venue funnel, EXACT mappings only, mean of complete UTC days (after score, mapping, tradable, timestamp, in-play, 24 h and lead rules; before Grok's acceptance)" }
    : px?.completeDays.mean != null ? { value: px.completeDays.mean, basis: "DATE-LEVEL PROXY (score ≥ 68 and end date today/tomorrow); an UPPER BOUND: includes started events, unmapped and untradable markets, before Grok's acceptance" } : null;
  const fillShare = sim + unfilled > 0 ? sim / (sim + unfilled) : null;
  const feasibility = buildFeasibility(trades, { eligiblePerDay, settledShare: fillShare && fillShare > 0 ? fillShare : 1 });

  const result: CoverageResult = { startedAt: iso(endMs), window: { startIso, endIso }, counts: { signals: sigs.length, withScore: scored.length, conditions: conds.length }, venue: { configured: !!o.us, notes, candidates, measured, reasons }, funnel, mappingBuckets: buckets, dateBasis, diagnostic, feasibility, feasibilityMode: mode, settled: { n: trades.length, fillShare }, approximations };
  o.write("s1b_funnel.json", JSON.stringify({ window: result.window, counts: result.counts, venue: result.venue, funnel, mappingBuckets: buckets, dateBasis, approximations }, null, 1));
  o.write("s1b_feasibility.json", JSON.stringify({ mode, settled: result.settled, feasibility }, null, 1));
  return result;
}

const f1 = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "n/m" : x.toFixed(d));
/** ≤ 60 printed lines. */
export function coverageSummaryLines(r: CoverageResult, outDir: string): string[] {
  const L: string[] = [`S1b coverage probe  ${r.window.startIso} → ${r.window.endIso}  (${r.funnel.window.elapsedDays.toFixed(1)} days, ${r.funnel.window.completeUtcDays} complete UTC days)`, `signals ${r.counts.signals} · score ≥ 68: ${r.counts.withScore} · venue candidates ${r.venue.candidates}`];
  for (const x of r.venue.reasons) L.push(`NOT MEASURED: ${x}`.slice(0, 200));
  for (const e of [...(r.venue.notes.open?.errors ?? []), ...(r.venue.notes.closed?.errors ?? [])].slice(0, 2)) L.push(`  ! ${e}`.slice(0, 200));
  L.push("stage                                   EXACT   /day (min–max)  | +PROBABLE");
  const ex = r.funnel.variants.EXACT, pr = r.funnel.variants.EXACT_PLUS_PROBABLE;
  r.funnel.stages.forEach((s, i) => { const pd = ex.perDay[s.key]; L.push(`${s.label.slice(0, 38).padEnd(38)} ${String(ex.counts[i] ?? "n/m").padStart(6)}  ${pd?.perElapsedDay == null ? "n/m" : f1(pd.perElapsedDay)}${pd?.completeDays.min != null ? ` (${pd.completeDays.min}–${pd.completeDays.max})` : ""}`.padEnd(70) + `| ${pr.counts[i] ?? "n/m"}`); });
  L.push(`date-level proxy (score ≥ 68, end date today/tomorrow): ${r.funnel.proxy.scoreAndProxy ?? "n/m"}  ${f1(r.funnel.proxy.perDay?.perElapsedDay)} /day`);
  L.push(`mapping (score ≥ 68, by market+outcome): EXACT ${r.mappingBuckets.EXACT} · PROBABLE ${r.mappingBuckets.PROBABLE} · NONE ${r.mappingBuckets.NONE}`);
  { const dl = r.funnel.dateLevel; const e = dl.variants.EXACT, p = dl.variants.EXACT_PLUS_PROBABLE; L.push(`date-level row (${dl.label}; in-play and lead ${dl.inPlayCheck}): implied date ${e.counts[4] ?? "n/m"} → today/tomorrow ET ${e.counts[5] ?? "n/m"} (${f1(e.perDay?.perElapsedDay)} /day) | +PROBABLE ${p.counts[5] ?? "n/m"}`); }
  if (Object.keys(r.dateBasis).length) L.push(`venue date used for matching: ${Object.entries(r.dateBasis).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  if (r.diagnostic) {
    const d = r.diagnostic; const li = d.listing.all; if (li) L.push(`US listing (all): ${li.markets} markets, ${li.distinctEvents} events; status ${JSON.stringify(li.byStatus).slice(0, 120)}; open ${d.listing.open?.markets ?? "n/m"} closed ${d.listing.closed?.markets ?? "n/m"} archived ${d.listing.archived?.markets ?? "n/m"}`);
    if (d.summary) { const sm = d.summary; L.push(`diagnostic (${sm.pairs} pairs, score ≥ 68): best-candidate band ${Object.entries(sm.byBestBand).map(([b, n]) => `${b} ${n}`).join(" · ")}`); L.push(`  PROBABLE ${sm.probable} · identifier ${sm.identifierMatches} · same participants ${sm.sameParticipants} (title differs ${sm.sameParticipantsDifferentTitle}) · category of best matches ${sm.categoryMatchOfBest.yes}/${sm.categoryMatchOfBest.no}/${sm.categoryMatchOfBest.unknown} (yes/no/unknown)`); }
    const mixTop = [...d.categoryMix].sort((a, b) => b.oursScore68Signals - a.oursScore68Signals).slice(0, 5); if (mixTop.length) L.push(`category mix ours(≥68) vs venue: ${mixTop.map((x) => `${x.stratum} ${(x.oursShare68 * 100).toFixed(0)}% vs ${(x.venueShare * 100).toFixed(0)}%`).join(" · ")}`);
    L.push(`  sample of ${d.sampled} markets with nearest 3 venue titles: s1b_mapping_diagnostic.csv`);
  }
  L.push(`final stage: wallets ${ex.wallets[ex.wallets.length - 1] ?? "n/m"} · top-3 wallet share ${ex.top3Share === null ? "n/m" : (ex.top3Share * 100).toFixed(0) + " %"}`);
  if (ex.freshAtFinal) L.push(`E1 (supplementary): of ${ex.freshAtFinal.finalCount} final signals, ${ex.freshAtFinal.withinAge} had an observed detection lag ≤ ${ex.freshAtFinal.maxSignalAgeMs / 1000} s (lag observed for ${ex.freshAtFinal.lagObserved}); ${f1(ex.freshAtFinal.perDay.perElapsedDay)} /day`);
  const k = Object.entries(ex.byKind).map(([n, c]) => `${n} ${c[c.length - 1] ?? "n/m"}`).join(" · "); if (k) L.push(`by kind (final): ${k}`.slice(0, 200));
  const cat = Object.entries(ex.byCategory).map(([n, c]) => `${n} ${c[c.length - 1] ?? "n/m"}`).slice(0, 8).join(" · "); if (cat) L.push(`by category (final): ${cat}`.slice(0, 200));
  const fe = r.feasibility; L.push(`feasibility (${r.feasibilityMode}; ${r.settled.n} settled; fill share ${f1(r.settled.fillShare === null ? null : r.settled.fillShare * 100, 0)} %); window ${fe.windowDays} d; eligible/day ${fe.eligiblePerDay ? f1(fe.eligiblePerDay.value) : "n/m"} (${fe.eligiblePerDay ? (fe.eligiblePerDay.basis.startsWith("DATE") ? "proxy, upper bound" : "venue funnel") : "—"})`);
  for (const s of fe.subsets) { L.push(`  ${s.stats.name}: n ${s.stats.n} markets ${s.stats.markets} SD ${f1(s.stats.sdPts)} pts DEFF ${f1(s.stats.deff, 2)} hold p50/p90 ${f1(s.stats.holdP50Days)}/${f1(s.stats.holdP90Days)} d`); for (const e of s.sampleSize) L.push(`    effect ${e.effectPts} pts → per arm ${e.perArmIndependent ?? "n/m"} (independent) · ${e.perArmClustered ?? "n/m"} (clustered)`); const d = s.days.filter((x) => x.lag === "p90" && x.effectPts === 10); if (d.length) L.push(`    days @10 pts, p90 lag, accept ${d.map((x) => `${x.acceptRate * 100}%: ${x.days === null ? "n/m" : Math.round(x.days)}${x.feasibleWithinWindow === false ? "✗" : x.feasibleWithinWindow ? "✓" : ""}`).join(" ")}`); }
  L.push(`files in ${outDir}: s1b_funnel.json s1b_feasibility.json s1b_mapping_review.csv${r.diagnostic ? " s1b_diagnostic.json s1b_mapping_diagnostic.csv" : ""}`);
  return L.map((l) => (l.length > 220 ? l.slice(0, 217) + "..." : l)).slice(0, 60);
}
