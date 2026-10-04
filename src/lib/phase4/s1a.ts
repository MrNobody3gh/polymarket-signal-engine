/**
 * Phase 4.0 (S1a) — the timestamp audit, orchestrated: fetch samples from each reachable venue, analyse them
 * (audit.ts), and produce JSON, a Markdown results page and a compact printed summary. Everything that touches the
 * world is injected (http, clock, file writer, our resolution times), so tests drive it with fixtures and a fake fetch.
 * A venue that cannot be reached is reported with the exact failure and the audit continues with the other.
 */
import { buildInventory, candidateEvidence, compareVenues, instantOf, recommendSlots, sampleRaws, stratifiedSample, toAuditMarkets, type AuditMarket, type CandidateEvidence, type FieldInventory, type RawMarket, type SlotVerdict, type VenueDiffSummary } from "./audit";
import type { PoliteHttp } from "./http";
import { matchSignalToVenue, type VenueMarketRef } from "./mapping";
import { KALSHI, KALSHI_DEFAULT_CAP, KALSHI_DOCS, fetchKalshiListing, fetchKalshiMilestones, resolveKalshiBase, kalshiAll, kalshiCounts, kalshiGroupOf, kalshiIdOf, kalshiIsResolved, kalshiScheduleRows, kalshiSlug, kalshiTags, kalshiTitleOf, type KalshiConfig, type KalshiCounts, type KalshiListing } from "./venue-kalshi";
import { eventFlagRows, fetchUsFlagged, fetchUsSportsTargeted, inPlayReliability, scheduleCompare, usScheduleRows, type InPlayReport, type ScheduleSummary } from "./us-sports";
import { leaf as fieldLabel, writeCompact } from "./compact";
import { categorize, stratum } from "./categorize";
import { INTERNATIONAL, US_EXCHANGE, defaultTargetedQueries, fetchGamma, fetchUs, fetchUsTargeted, gammaGroupOf, gammaIdOf, gammaIsResolved, gammaOutcomes, gammaTitleOf, gammaTokenIds, sanitizeSample, tagsOf, usGroupOf, usIdOf, usIsResolved, usOutcomes, usTitleOf, type FetchNotes, type TargetedQuery, type TargetedResult, type UsConfig } from "./venues";

export interface S1aOptions {
  http: PoliteHttp; us: UsConfig | null;
  /** Target size of each sample per venue (brief: ≥ 300 open, ≥ 300 resolved). */
  sampleOpen?: number; sampleResolved?: number;
  /** Markets fetched per venue and kind = factor × sample size, so the stratified sample can fill thin strata (default 3). Raise it when a stratum is reported with fewer than 30 markets. */
  fetchFactor?: number;
  /** Resolved-market objects of OUR traded markets with our observed resolution time (ms), from token_resolutions; optional. */
  ours?: { raw: RawMarket; resolvedMs: number }[];
  now?: () => number;
  /** Writes `relPath` (relative to the output directory) with `content`. */
  write: (relPath: string, content: string) => void;
  /** US per-sport queries (see venues.ts `defaultTargetedQueries`); each is paged until ≥ 100 markets from ≥ 30 events or the listing ends. */
  usTargeted?: TargetedQuery[];
  fixtureDir?: string; maxFixtureMarkets?: number;
  log?: (m: string) => void;
  /** 4.0c: audit Kalshi as a third venue (null / undefined = not audited). `kalshiMax` caps the listing (default 40,000 markets). */
  kalshi?: KalshiConfig | null; kalshiMax?: number;
  /** 4.0c: per-sport samples from the US sports API (sports, leagues, events by slug), both open and ended events; falls back to the category queries. Also measures the `live` / `ended` indicator and the schedule sources. */
  usSports?: boolean; usSportsMaxRequests?: number;
  /** Reads a result file of the output directory (relative name) for S1_COMPACT.md; omitted = the compact file is written without the funnel table. */
  readFile?: (relPath: string) => string | null;
  /**
   * 4.0d: audit ONLY this venue. The other venues' stages are never entered, the cross-venue comparisons are skipped (they need two listings in memory), and the
   * result is the compact evidence file `v_<venue>_audit.json` (the combined `s1a_summary.json`, `S1a_RESULTS.md` and `S1_COMPACT.md` are left to `phase4:merge`).
   */
  only?: VenueId | null;
  /** Names the stage the process is in for the heap guard; the guard itself is attached to the PoliteHttp client. */
  guard?: Guard | null; scope?: VenueScope | null; heap?: () => HeapInfo | null;
  /** 4.0d, Kalshi only: the category inventory (series / events / category endpoints; no market is loaded) and whether to skip the listing sample (`--kalshi-inventory-only`). */
  kalshiInventory?: ((base: string) => Promise<KalshiInventory>) | null; kalshiInventoryOnly?: boolean;
}

/** The compact per-venue evidence file of a `--venue` audit run (`v_<venue>_audit.json`). `audit` is null for a run that stopped before the audit (see `stopped`). */
export interface VenueAuditFile {
  schema: number; kind: "audit"; venue: VenueId; startedAt: string; finishedAt: string; heap: HeapInfo | null; stopped: StopInfo | null;
  audit: VenueAudit | null; sportsApi: S1aResult["sportsApi"]; inPlay: InPlayReport | null; schedule: { us: ScheduleSummary[]; kalshi: ScheduleSummary[]; notes: string[] } | null; kalshiInventory: KalshiInventory | null;
  http: S1aResult["http"]; endpoints: string[]; docs: string[]; rules: Record<string, number>; notEstablished: string[];
}

export interface VenueAudit {
  venue: string; reachable: boolean;
  fetch: { open: FetchNotes | null; resolved: FetchNotes | null };
  counts: { open: number; resolved: number; ours: number };
  strata: Record<string, { open: number; resolved: number; events: number; markets: number }>;
  /** The date-level alternative rows (shown, never recommended) and the gameStartTime deep dive. */
  dateLevel: DateLevelRow[]; gameStart: GameStartDive; futuresVerdicts: FuturesVerdict[];
  /** Kalshi only: how many open / closed / settled markets the bounded listing holds, by Kalshi category. */
  listing: KalshiCounts | null;
  /** Targeted per-sport fetches and whether each reached its quota (US only). */
  targeted: { sport: string; query: string; markets: number; events: number; reachedQuota: boolean; stoppedBecause: string; errors: string[] }[];
  inventory: FieldInventory[];
  evidence: Record<string, CandidateEvidence[]>;
  recommendations: SlotVerdict[];
}
export interface S1aResult {
  startedAt: string; finishedAt: string;
  venues: VenueAudit[];
  /** The same event on both venues, matched by participant names and Eastern date, and the spread of their start times (D51 input). */
  eventAgreement: (EventAgreement & { reason: string | null }) | null;
  venueAgreement: { available: boolean; reason: string | null; matched: number; byConfidence: Record<string, number>; summary: VenueDiffSummary[] };
  http: { requests: number; ok: number; byKind: Record<string, number>; firstErrors: string[] };
  endpoints: string[]; docs: string[];
  rules: Record<string, number>;
  notEstablished: string[];
  /** 4.0c: the US sports API (discovery and per-sport requests), the `live` / `ended` reliability report (measured, never adopted) and the schedule sources. */
  sportsApi?: { sports: number; leagues: number; requests: number; stoppedBecause: string | null; errors: string[] } | null;
  inPlay?: InPlayReport | null;
  schedule?: { us: ScheduleSummary[]; kalshi: ScheduleSummary[]; notes: string[] };
  /** 4.0d: the Kalshi category inventory of a `--kalshi-inventory` run (no market was loaded for it). */
  kalshiInventory?: KalshiInventory | null;
}

import { RECOMMEND_RULES } from "./audit";
import { EVIDENCE_SCHEMA, VENUE_IDS, evidenceFile, type Guard, type HeapInfo, type StopInfo, type VenueId, type VenueScope } from "./venue-run";
import type { KalshiInventory } from "./kalshi-inventory";
import { INTL_DOCS, US_DOCS } from "./venues";
import { dateLevelRows, collapseToEvents, type DateLevelRow } from "./audit";
import { futuresVerdicts, gameStartDeepDive, matchEventsAcrossVenues, type EventAgreement, type FuturesVerdict, type GameStartDive } from "./events";

const iso = (ms: number) => new Date(ms).toISOString();
const SIZE_CAP = 380_000; // bytes per fixture file

export function auditVenue(venue: string, open: RawMarket[], resolved: RawMarket[], notes: VenueAudit["fetch"], acc: { idOf: (m: RawMarket) => string; isResolved: (m: RawMarket) => boolean; titleOf: (m: RawMarket) => string | null; groupOf: (m: RawMarket) => string; slugOf?: (m: RawMarket) => string | null; tagsOf?: (m: RawMarket) => string[] }, ours: S1aOptions["ours"], o: { sampleOpen: number; sampleResolved: number; extraOpen?: RawMarket[]; extraResolved?: RawMarket[]; targeted?: VenueAudit["targeted"]; listing?: KalshiCounts | null }): { audit: VenueAudit; markets: AuditMarket[] } {
  const mk = (raws: RawMarket[], forceResolved: boolean | null, ourMs?: (m: RawMarket) => number | null) => toAuditMarkets(venue, raws, { idOf: acc.idOf, isResolved: (m) => (forceResolved === null ? acc.isResolved(m) : forceResolved), titleOf: acc.titleOf, slugOf: acc.slugOf ?? ((m) => (typeof m.slug === "string" ? m.slug : null)), tagsOf: acc.tagsOf ?? tagsOf, groupOf: acc.groupOf, ourResolutionMs: ourMs });
  const per = (n: number) => Math.ceil(n / 6);
  // pick on cheap fields first, flatten only what is picked (a 40,000-market listing was flattened whole before sampling and exhausted the heap)
  const light = { idOf: acc.idOf, titleOf: acc.titleOf, slugOf: acc.slugOf ?? ((m: RawMarket) => (typeof m.slug === "string" ? m.slug : null)), tagsOf: acc.tagsOf ?? tagsOf, groupOf: acc.groupOf };
  const openM = stratifiedSample(mk(sampleRaws(open, light, per(o.sampleOpen), o.sampleOpen), false), per(o.sampleOpen), o.sampleOpen);
  const resM = stratifiedSample(mk(sampleRaws(resolved, light, per(o.sampleResolved), o.sampleResolved), true), per(o.sampleResolved), o.sampleResolved);
  const oursMap = new Map((ours ?? []).map((x) => [gammaIdOf(x.raw), x.resolvedMs]));
  const oursM = venue === INTERNATIONAL && ours?.length ? mk(ours.map((x) => x.raw), true, (m) => oursMap.get(gammaIdOf(m)) ?? null) : [];
  // targeted per-sport markets are added whole (they exist to reach the per-sport quota); markets already sampled are not repeated
  const have = new Set(openM.map((m) => m.id)); const extraM = mk(o.extraOpen ?? [], false).filter((m) => !have.has(m.id)); const openAll = [...openM, ...extraM];
  // targeted ENDED markets are added whole too: they carry the resolution times the ordering rules need
  const haveRes = new Set(resM.map((m) => m.id)); const extraResM = mk(o.extraResolved ?? [], true).filter((m) => !haveRes.has(m.id)); const resAll = [...resM, ...extraResM];
  const markets = [...openAll, ...resAll, ...oursM]; const inventory = buildInventory(markets);
  const strata: VenueAudit["strata"] = {}; for (const m of markets) { const s = (strata[m.stratum] ??= { open: 0, resolved: 0, events: 0, markets: 0 }); s.markets++; if (m.resolved) s.resolved++; else s.open++; }
  for (const st of Object.keys(strata)) strata[st].events = collapseToEvents(markets.filter((m) => m.stratum === st)).length;
  const evidence: VenueAudit["evidence"] = {}; for (const st of Object.keys(strata).sort()) { const sm = markets.filter((m) => m.stratum === st); if (sm.length >= 10) evidence[st] = candidateEvidence(sm, inventory); }
  const gameStart = gameStartDeepDive(venue, markets, inventory);
  return { audit: { venue, reachable: markets.length > 0, fetch: notes, counts: { open: openAll.length, resolved: resAll.length, ours: oursM.length }, strata, dateLevel: markets.length ? dateLevelRows(venue, markets, inventory) : [], gameStart, futuresVerdicts: futuresVerdicts(gameStart.futures), listing: o.listing ?? null, targeted: o.targeted ?? [], inventory, evidence, recommendations: markets.length ? recommendSlots(venue, markets, inventory) : [] }, markets };
}

/** The recommended field for a market's stratum: slot 1 if recommended, else slot 2 if recommended, else null. */
const bestField = (recs: SlotVerdict[], st: string): string | null => recs.find((r) => r.stratum === st && r.slot === 1 && r.verdict === "RECOMMEND")?.field ?? recs.find((r) => r.stratum === st && r.slot === 2 && r.verdict === "RECOMMEND")?.field ?? null;

export async function runS1a(opt: S1aOptions): Promise<S1aResult> {
  const now = opt.now ?? (() => Date.now()); const log = opt.log ?? (() => {}); const startedAt = iso(now());
  const so = opt.sampleOpen ?? 300, sr = opt.sampleResolved ?? 300; const ff = Math.max(1, opt.fetchFactor ?? 3); const venues: VenueAudit[] = []; const mkts: Record<string, AuditMarket[]> = {}; const raws: Record<string, { open: RawMarket[]; resolved: RawMarket[] }> = {};

  const only = opt.only ?? null; const want = (v: VenueId) => !only || only === v; const stage = (v: VenueId, name: string) => { opt.scope?.enter(v, name); opt.guard?.setStage(name, v); log(`${v}: ${name}`); };
  // 1 — international venue
  if (want(INTERNATIONAL)) {
    stage(INTERNATIONAL, "markets"); log("intl: open markets"); const o = await fetchGamma(opt.http, { closed: false, max: so * ff });
    log("intl: resolved markets"); let r = await fetchGamma(opt.http, { closed: true, max: sr * ff, order: { order: "closedTime", ascending: false } });
    if (!r.markets.length || r.notes.filterHonoured === false) { const r2 = await fetchGamma(opt.http, { closed: true, max: sr * ff }); r2.notes.errors.unshift(`ordered query: ${r.notes.errors[0] ?? (r.notes.filterHonoured === false ? "closed filter not honoured" : "no records")}`); if (r2.markets.length) r = r2; }
    const resolvedOnly = r.markets.filter((m) => gammaIsResolved(m));
    const { audit, markets } = auditVenue(INTERNATIONAL, o.markets.filter((m) => !gammaIsResolved(m)), resolvedOnly, { open: o.notes, resolved: r.notes }, { idOf: gammaIdOf, isResolved: gammaIsResolved, titleOf: gammaTitleOf, groupOf: gammaGroupOf }, opt.ours, { sampleOpen: so, sampleResolved: sr });
    venues.push(audit); mkts[INTERNATIONAL] = markets; raws[INTERNATIONAL] = { open: o.markets, resolved: resolvedOnly };
  }
  // 2 — US venue
  let sportsApi: S1aResult["sportsApi"] = null; let inPlay: InPlayReport | null = null; const schedule: NonNullable<S1aResult["schedule"]> = { us: [], kalshi: [], notes: [] };
  if (opt.us && want(US_EXCHANGE)) {
    stage(US_EXCHANGE, "listing"); log("us: open markets"); const o = await fetchUs(opt.http, opt.us, { closed: false, max: so * ff });
    log("us: resolved markets"); const r = await fetchUs(opt.http, opt.us, { closed: true, max: sr * ff });
    const targeted: TargetedResult[] = [];
    if (opt.usSports) {
      log("us: sports API"); const sp = await fetchUsSportsTargeted(opt.http, opt.us, { maxRequests: opt.usSportsMaxRequests ?? 400 }); targeted.push(...sp.results);
      sportsApi = { sports: sp.discovery.sports, leagues: sp.discovery.leagues, requests: sp.requests, stoppedBecause: sp.stoppedBecause, errors: sp.discovery.errors };
      // the sports API unreachable or empty: the corrected category-slug queries (open and ended) stand in for it
      if (!sp.results.some((x) => x.markets.length)) { sportsApi.errors.push("the sports API returned no markets: falling back to the category-slug queries"); for (const q of defaultTargetedQueries()) { log(`us: targeted ${q.sport}`); targeted.push(await fetchUsTargeted(opt.http, opt.us, q)); } }
    }
    for (const q of opt.usTargeted ?? []) { log(`us: targeted ${q.sport}`); targeted.push(await fetchUsTargeted(opt.http, opt.us, q)); }
    const targetedSummary = targeted.map((t) => ({ sport: t.sport, query: t.query, markets: t.markets.length, events: t.events, reachedQuota: t.reachedQuota, stoppedBecause: t.notes.stoppedBecause, errors: t.notes.errors.slice(0, 2) }));
    const tMarkets = targeted.flatMap((t) => t.markets);
    const { audit, markets } = auditVenue(US_EXCHANGE, o.markets.filter((m) => !usIsResolved(m)), r.markets.filter((m) => usIsResolved(m)), { open: o.notes, resolved: r.notes }, { idOf: usIdOf, isResolved: usIsResolved, titleOf: usTitleOf, groupOf: usGroupOf }, undefined, { sampleOpen: so, sampleResolved: sr, extraOpen: tMarkets.filter((m) => !usIsResolved(m)), extraResolved: tMarkets.filter((m) => usIsResolved(m)), targeted: targetedSummary });
    venues.push(audit); mkts[US_EXCHANGE] = markets; raws[US_EXCHANGE] = { open: [...o.markets, ...tMarkets.filter((m) => !usIsResolved(m))], resolved: [...r.markets, ...tMarkets.filter((m) => usIsResolved(m))] };
    if (opt.usSports && tMarkets.length) {
      // in-play indicator: the sampled events plus the events the venue itself flags live and ended; MEASURED, never adopted
      log("us: live / ended flags"); const fl = await fetchUsFlagged(opt.http, opt.us); const rowsF = eventFlagRows([...tMarkets, ...fl.live, ...fl.ended]); inPlay = inPlayReliability(rowsF, now());
      if (fl.notes.live.errors.length || fl.notes.ended.errors.length) schedule.notes.push(`live/ended fetch: ${[...fl.notes.live.errors, ...fl.notes.ended.errors][0]}`);
      schedule.us = scheduleCompare(usScheduleRows(tMarkets, (m) => stratum(categorize({ title: usTitleOf(m), slug: typeof m.slug === "string" ? m.slug : null, tags: tagsOf(m) }))));
    }
  }
  // 2b — Kalshi (third venue)
  let kalshiInv: KalshiInventory | null = null; let kalshiAudited = false;
  if (opt.kalshi && want(KALSHI)) {
    stage(KALSHI, "listing"); log("kalshi: listing");
    // the category inventory streams events and counts them, so it runs BEFORE the listing is fetched: the 40,000-market listing is never alive while it runs
    if (opt.kalshiInventory) { const res = await resolveKalshiBase(opt.http, opt.kalshi); if (res.base) { stage(KALSHI, "category inventory"); kalshiInv = await opt.kalshiInventory(res.base); } }
    if (!opt.kalshiInventoryOnly) {
      stage(KALSHI, "listing"); let L: KalshiListing | null = await fetchKalshiListing(opt.http, opt.kalshi, opt.kalshiMax ?? KALSHI_DEFAULT_CAP); kalshiAudited = true;
      opt.guard?.setStage("audit of the listing", KALSHI);
      const all = kalshiAll(L); const openM = [...(L.open?.markets ?? [])].filter((m) => !kalshiIsResolved(m)); const resM = all.filter(kalshiIsResolved);
      const { audit, markets } = auditVenue(KALSHI, openM, resM, { open: L.open?.notes ?? null, resolved: L.settled?.notes ?? L.closed?.notes ?? null }, { idOf: kalshiIdOf, isResolved: kalshiIsResolved, titleOf: kalshiTitleOf, groupOf: kalshiGroupOf, slugOf: kalshiSlug, tagsOf: kalshiTags }, undefined, { sampleOpen: so, sampleResolved: sr, listing: all.length ? kalshiCounts(all) : null });
      if (!L.base) audit.fetch.open = { endpoint: opt.kalshi.bases.join(" | "), pages: 0, records: 0, cursorKey: null, filterHonoured: null, stoppedBecause: "no base URL answered", errors: L.tried.map((t) => `${t.base}: ${t.outcome}`) };
      // only the first `maxFixtureMarkets` raws of each side are ever read again (fixtures); keeping all 40,000 listing markets alive exhausted the heap on the 4.0c production run
      const fx = Math.max(40, opt.maxFixtureMarkets ?? 40); venues.push(audit); mkts[KALSHI] = markets; raws[KALSHI] = { open: openM.slice(0, fx), resolved: resM.slice(0, fx) };
      if (L.base) { stage(KALSHI, "milestones"); log("kalshi: milestones"); const ms = await fetchKalshiMilestones(opt.http, L.base, {}); if (ms.notes.errors.length) schedule.notes.push(`kalshi milestones: ${ms.notes.errors[0]}`); schedule.kalshi = scheduleCompare(kalshiScheduleRows(all, ms.milestones)); if (!ms.milestones.length && !ms.notes.errors.length) schedule.notes.push("kalshi milestones: none returned"); }
      L = null; // release the bounded listing
    }
  }

  // 3 — venue agreement on matched events
  const agreement: S1aResult["venueAgreement"] = { available: false, reason: null, matched: 0, byConfidence: {}, summary: [] };
  const a = venues.find((v) => v.venue === INTERNATIONAL), b = venues.find((v) => v.venue === US_EXCHANGE);
  if (only) agreement.reason = `single-venue run (--venue ${only}): the cross-venue comparison needs two listings in one process and is not made`;
  else if (!a?.reachable || !b?.reachable) agreement.reason = !b ? "the US venue was not audited (not configured or not reachable)" : "a venue returned no markets";
  else {
    const cands: (VenueMarketRef & { ms: number | null; field: string | null })[] = mkts[US_EXCHANGE].map((m) => {
      const f = bestField(b.recommendations, m.stratum); const ms = f ? instantOf(m.flat[f]) : null; const rawM = [...raws[US_EXCHANGE].open, ...raws[US_EXCHANGE].resolved].find((x) => usIdOf(x) === m.id);
      return { venue: US_EXCHANGE, marketId: m.id, question: rawM ? usTitleOf(rawM) : null, outcomes: rawM ? usOutcomes(rawM) : [], conditionIds: [String(rawM?.conditionId ?? rawM?.condition_id ?? "")].filter(Boolean), tokenIds: Array.isArray(rawM?.clobTokenIds) ? (rawM!.clobTokenIds as unknown[]).map(String) : [], eventDate: ms === null ? null : iso(ms), ms, field: f };
    });
    const pairs: { stratum: string; aMs: number; bMs: number }[] = []; const byConf: Record<string, number> = {};
    for (const m of mkts[INTERNATIONAL]) {
      const f = bestField(a.recommendations, m.stratum); const ams = f ? instantOf(m.flat[f]) : null; if (ams === null) continue;
      const rawM = [...raws[INTERNATIONAL].open, ...raws[INTERNATIONAL].resolved].find((x) => gammaIdOf(x) === m.id); if (!rawM) continue;
      let best: ReturnType<typeof matchSignalToVenue> | null = null;
      for (const outcome of gammaOutcomes(rawM).slice(0, 2)) { const res = matchSignalToVenue({ conditionId: gammaIdOf(rawM), tokenId: gammaTokenIds(rawM)[0] ?? null, title: gammaTitleOf(rawM), outcome, eventDate: iso(ams) }, cands); if (!best || res.confidence === "EXACT" || (best.confidence === "NONE" && res.confidence !== "NONE")) best = res; }
      if (!best) continue; byConf[best.confidence] = (byConf[best.confidence] ?? 0) + 1;
      const cand = best.candidate && cands.find((c) => c.marketId === best!.candidate!.marketId); if (best.confidence !== "NONE" && cand?.ms != null) pairs.push({ stratum: m.stratum, aMs: ams, bMs: cand.ms });
    }
    agreement.available = true; agreement.matched = pairs.length; agreement.byConfidence = byConf; agreement.summary = compareVenues(pairs);
    if (!pairs.length) agreement.reason = "no market could be matched with confidence EXACT or PROBABLE (or no recommended field on one side)";
  }

  // 3b — the same event on both venues by participant names and Eastern date (start-time spread: D51 input)
  let eventAgreement: S1aResult["eventAgreement"] = null;
  if (!only && a?.reachable && b?.reachable) {
    const titleOf = (m: AuditMarket) => { const v = m.flat.question ?? m.flat.title ?? m.flat.name; return typeof v === "string" ? v : null; };
    const ea = matchEventsAcrossVenues({ ms: mkts[INTERNATIONAL], inv: a.inventory, titleOf }, { ms: mkts[US_EXCHANGE], inv: b.inventory, titleOf });
    eventAgreement = { ...ea, reason: ea.matched === 0 ? "no event matched by participant names and date" : ea.withBothStarts === 0 ? "events matched, but no matched pair has a start time on both venues (gameStartTime or event startTime)" : null };
  }

  // 4 — files: JSON per venue, fixtures, results page
  const finishedAt = iso(now()); const sum = opt.http.summary();
  const result: S1aResult = { startedAt, finishedAt, venues, eventAgreement, venueAgreement: agreement, http: sum, endpoints: venues.flatMap((v) => [v.fetch.open?.endpoint, v.fetch.resolved?.endpoint]).filter((x, i, arr): x is string => !!x && arr.indexOf(x) === i), docs: [...INTL_DOCS, ...(opt.us ? US_DOCS : []), ...(opt.kalshi ? KALSHI_DOCS : [])], rules: { ...RECOMMEND_RULES }, notEstablished: [], sportsApi, inPlay, schedule, kalshiInventory: kalshiInv };
  for (const v of venues) result.notEstablished.push(...(v.reachable ? [] : [`${v.venue}: no markets could be fetched (${[v.fetch.open?.errors[0], v.fetch.resolved?.errors[0]].filter(Boolean).join("; ") || "empty response"})`]));
  if (only) {
    for (const v of VENUE_IDS) if (v !== only) result.notEstablished.push(`${v}: not run in this process (single-venue run, --venue ${only})`);
    const f: VenueAuditFile = { schema: EVIDENCE_SCHEMA, kind: "audit", venue: only, startedAt, finishedAt, heap: opt.heap?.() ?? null, stopped: null, audit: venues.find((v) => v.venue === only) ?? null, sportsApi, inPlay, schedule: only === US_EXCHANGE || only === KALSHI ? schedule : null, kalshiInventory: kalshiInv, http: sum, endpoints: result.endpoints, docs: result.docs, rules: result.rules, notEstablished: result.notEstablished.filter((x) => x.startsWith(`${only}:`) || !VENUE_IDS.some((v) => x.startsWith(`${v}:`))) };
    if (!f.audit && !kalshiInv) f.notEstablished.push(`${only}: no markets could be fetched`);
    opt.write(evidenceFile(only, "audit"), JSON.stringify(f));
    if (opt.fixtureDir) writeFixtures(venues, raws, opt, opt.fixtureDir);
    return result;
  }
  if (!opt.us) result.notEstablished.push(`${US_EXCHANGE}: not audited in this run`);
  if (!opt.kalshi) result.notEstablished.push(`${KALSHI}: not audited in this run (--kalshi)`);
  for (const v of venues) opt.write(`s1a_${v.venue}.json`, JSON.stringify(v, null, 1));
  const summary = { ...result, venues: venues.map((v) => ({ venue: v.venue, reachable: v.reachable, counts: v.counts, fetch: v.fetch, listing: v.listing, futuresVerdicts: v.futuresVerdicts, recommendations: v.recommendations })) };
  opt.write("s1a_summary.json", JSON.stringify(summary, null, 1));
  if (inPlay) opt.write("s1a_inplay_us.json", JSON.stringify(inPlay, null, 1));
  if (opt.fixtureDir) writeFixtures(venues, raws, opt, opt.fixtureDir);
  opt.write("S1a_RESULTS.md", renderS1aMarkdown(result));
  writeCompact((rel) => opt.readFile?.(rel) ?? null, opt.write, { s1a: summary });
  return result;
}

/** Sanitised, bounded raw samples of each reachable venue, for the next run's fixtures (tests/fixtures/phase4). */
function writeFixtures(venues: VenueAudit[], raws: Record<string, { open: RawMarket[]; resolved: RawMarket[] }>, opt: S1aOptions, dir: string): void {
  for (const v of venues) if (v.reachable) for (const kind of ["open", "resolved"] as const) {
    let list = raws[v.venue][kind].slice(0, opt.maxFixtureMarkets ?? 40).map((m) => sanitizeSample(m)); let text = JSON.stringify(list, null, 1);
    while (text.length > SIZE_CAP && list.length > 1) { list = list.slice(0, Math.floor(list.length / 2)); text = JSON.stringify(list, null, 1); }
    opt.write(`${dir}/s1a_${v.venue}_${kind}.json`, text);
  }
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(0)} %`);
export function renderS1aMarkdown(r: S1aResult): string {
  const L: string[] = ["# S1a timestamp audit — generated results", "", `Run: ${r.startedAt} → ${r.finishedAt}. Requests: ${r.http.requests} (ok ${r.http.ok}; failures ${JSON.stringify(r.http.byKind)}).`, "", "Endpoints used: " + (r.endpoints.map((e) => "`" + e + "`").join(", ") || "none"), "", "Documentation to confirm field meanings against: " + r.docs.join(", "), "", "All reliability rules are evaluated per **distinct event** (one representative market per event); the thresholds are `RECOMMEND_RULES` (owner decision D68) and are unchanged.", ""];
  if (r.notEstablished.length) L.push("## Not established in this run", "", ...r.notEstablished.map((x) => `- ${x}`), "");
  for (const v of r.venues) {
    L.push(`## ${v.venue}`, "", `Open sample ${v.counts.open}, resolved sample ${v.counts.resolved}${v.counts.ours ? `, our traded markets ${v.counts.ours}` : ""}. Fetch: open ${v.fetch.open ? `${v.fetch.open.records} markets in ${v.fetch.open.pages} pages (${v.fetch.open.stoppedBecause})` : "n/a"}; resolved ${v.fetch.resolved ? `${v.fetch.resolved.records} in ${v.fetch.resolved.pages} pages (${v.fetch.resolved.stoppedBecause})` : "n/a"}.`, "");
    if (!v.reachable) { L.push("**Unreachable or empty.** Errors: " + [...(v.fetch.open?.errors ?? []), ...(v.fetch.resolved?.errors ?? [])].join("; "), ""); continue; }
    L.push("### Strata: markets and distinct events", "", "| stratum | markets | distinct events | open | resolved |", "|---|---|---|---|---|");
    for (const [k, c] of Object.entries(v.strata).sort()) L.push(`| ${k} | ${c.markets} | ${c.events} | ${c.open} | ${c.resolved} |`);
    if (v.targeted.length) { L.push("", "### Targeted per-sport fetches (US filters are UNVERIFIED defaults)", "", "| sport | markets | distinct events | quota (≥ 100 markets, ≥ 30 events) | stopped because | errors |", "|---|---|---|---|---|---|"); for (const t of v.targeted) L.push(`| ${t.sport} | ${t.markets} | ${t.events} | ${t.reachedQuota ? "reached" : "NOT reached"} | ${t.stoppedBecause} | ${t.errors.join("; ") || "—"} |`); }
    L.push("", "### Time-field inventory", "", "| field | name suggests | present | formats | placeholder share | top times of day |", "|---|---|---|---|---|---|");
    for (const f of v.inventory) L.push(`| \`${f.path}\` | ${f.role} | ${(f.presence.overall.rate * 100).toFixed(0)} % | ${Object.entries(f.formats).map(([k, n]) => `${k}:${n}`).join(" ")} | ${(f.placeholderShare * 100).toFixed(0)} % | ${f.timeOfDay.topClocks.slice(0, 3).map((c) => `${c.clock} ${(c.share * 100).toFixed(0)}%`).join(", ")} |`);
    L.push("", "### Verdict per stratum and slot (per distinct event; the rule that decided is shown)", "", "| stratum | slot | field | verdict | decided by | events / markets | usable | Eastern-date placeholders | failed rules / evidence |", "|---|---|---|---|---|---|---|---|---|");
    for (const s of v.recommendations) L.push(`| ${s.stratum} | ${s.slot} | ${s.field ? "`" + s.field + "`" : "—"} | ${s.verdict}${s.needsHumanReview ? " (human review)" : ""} | ${s.decidedBy} | ${s.events} / ${s.markets} | ${pct(s.usableShare)} | ${pct(s.etPlaceholderShare)} | ${s.failed.join("; ") || JSON.stringify(s.evidence)} |`);
    L.push("", "### Every candidate field judged per stratum and slot (same rules and thresholds; the best passing field, if any, is marked)", "", "| stratum | slot | candidate field | name suggests | verdict | decided by | events with the field | usable | failed rules |", "|---|---|---|---|---|---|---|---|---|");
    for (const s of v.recommendations) for (const c of s.candidates ?? []) L.push(`| ${s.stratum} | ${s.slot} | \`${c.field}\` | ${c.role} | ${c.best ? "**" : ""}${c.verdict}${c.best ? "** (best)" : ""} | ${c.decidedBy} | ${c.presentEvents} / ${s.events} | ${pct(c.usableShare)} | ${c.failed.join("; ") || "—"} |`);
    if (v.listing) { L.push("", `### Listing (bounded): ${v.listing.total} markets, ${v.listing.distinctEvents} events; by status ${JSON.stringify(v.listing.byBucket)}`, "", "| Kalshi category | open | unopened | closed | settled | total |", "|---|---|---|---|---|---|"); for (const [k, c] of Object.entries(v.listing.byCategory).sort((a, b) => b[1].total - a[1].total)) L.push(`| ${k} | ${c.open} | ${c.unopened} | ${c.closed} | ${c.settled} | ${c.total} |`); }
    if (v.gameStart.futures?.length) { L.push("", "### `gameStartTime`: single-game market types versus FUTURES (per distinct event)", "", "| sport | class | events | with field | distinct clocks | top clock (share) | start − creation h (p10/p50/p90) | within 1 h of creation | resolution − start h (n; p10/p50/p90; ≤ 24 h) |", "|---|---|---|---|---|---|---|---|---|");
      for (const f of v.gameStart.futures) L.push(`| ${f.sport} | ${f.class} | ${f.events} | ${f.withField} | ${f.distinctClocks} | ${f.topClock ?? "—"} (${pct(f.topClockShare)}) | ${f.startMinusCreationHours ? `${f.startMinusCreationHours.p10} / ${f.startMinusCreationHours.p50} / ${f.startMinusCreationHours.p90}` : "—"} | ${pct(f.withinHourOfCreationShare)} | ${f.resolutionMinusStartHours ? `${f.resolutionMinusStartHours.n}; ${f.resolutionMinusStartHours.p10} / ${f.resolutionMinusStartHours.p50} / ${f.resolutionMinusStartHours.p90}; ${pct(f.resolutionMinusStartHours.within24hShare)}` : "—"} |`);
      L.push("", "Verdict per sport (rule: both classes ≥ 30 events with the field; SINGLE_GAME_ONLY when single-game median resolution−start is within 24 h and futures is not, or most futures values sit within an hour of creation):", "", ...(v.futuresVerdicts ?? []).map((x) => `- ${x.sport}: **${x.verdict}** (${x.rule})`)); }
    L.push("", "### Date-level alternative (SHOWN, NOT RECOMMENDED; the in-play check cannot be evaluated at date level)", "", "| stratum | field | events | with an implied Eastern date | ET midnight | ET end of day | date-only | implied date ≤ resolution date (checked) | median days before resolution |", "|---|---|---|---|---|---|---|---|---|");
    for (const d of v.dateLevel) L.push(`| ${d.stratum} | \`${d.field}\` | ${d.events} | ${d.withImpliedDate} (${pct(d.impliedShare)}) | ${d.etMidnight} | ${d.etEndOfDay} | ${d.dateOnly} | ${pct(d.impliedDateNotAfterResolutionShare)} (${d.orderedChecked}) | ${d.medianDaysBeforeResolution ?? "—"} |`);
    const g = v.gameStart; L.push("", `### \`gameStartTime\` deep dive (field: ${g.field ? "`" + g.field + "`" : "not present on this venue"}; event start field: ${g.eventStartField ? "`" + g.eventStartField + "`" : "none"}; market type field: ${g.marketTypeField ? "`" + g.marketTypeField + "`" : "none"})`, "");
    if (g.field) {
      L.push("| sport | market type | markets | with field | presence | events | events with field |", "|---|---|---|---|---|---|---|"); for (const p of g.presence) L.push(`| ${p.sport} | ${p.marketType} | ${p.markets} | ${p.withField} | ${pct(p.presenceShare)} | ${p.events} | ${p.eventsWithField} |`);
      L.push("", "Reach (≥ 100 markets from ≥ 30 events): " + g.reach.map((x) => `${x.sport} ${x.markets}/${x.events} ${x.reaches100MarketsFrom30Events ? "yes" : "NO"}`).join(" · "), "");
      if (g.vsEventStart) L.push(`Against \`${g.eventStartField}\`: ${g.vsEventStart.events} events with both, ${g.vsEventStart.agreeWithin1Min} equal within a minute (${pct(g.vsEventStart.agreeShare)}).`, "");
      L.push("| sport | events | resolution − game start: positive | ≤ 12 h | ≤ 24 h | p10 / p50 / p90 (h) |", "|---|---|---|---|---|---|"); for (const x of g.resolutionMinusStart) L.push(`| ${x.sport} | ${x.events} | ${pct(x.positiveShare)} | ${pct(x.within12hShare)} | ${pct(x.within24hShare)} | ${x.p10Hours} / ${x.p50Hours} / ${x.p90Hours} |`);
      L.push("", "Time of day per distinct event (UTC · Eastern): " + g.clockPerEvent.map((c, i) => `${c.sport} ${c.topClock} ${pct(c.topClockShare)} of ${c.events} (${c.distinctClocks} distinct) · ET ${g.clockPerEventEastern[i]?.topClock} ${pct(g.clockPerEventEastern[i]?.topClockShare)}`).join("; "), "");
    }
  }
  if (r.sportsApi) L.push("## US sports API", "", `Discovered ${r.sportsApi.sports} sports and ${r.sportsApi.leagues} leagues; ${r.sportsApi.requests} requests${r.sportsApi.stoppedBecause ? `; stopped: ${r.sportsApi.stoppedBecause}` : ""}. ${r.sportsApi.errors.join("; ")}`, "");
  if (r.inPlay) { const p = r.inPlay; L.push("## The `live` / `ended` indicator (MEASURED, NOT ADOPTED; plan §3.4 keeps its own in-play rule)", "", `Snapshot ${p.nowIso}: ${p.events} events, ${p.withStart} with a scheduled start, \`live\` on ${p.withLiveFlag}, \`ended\` on ${p.withEndedFlag}.`, "", "| time to scheduled start | events | live | ended | live share |", "|---|---|---|---|---|", ...p.buckets.map((b) => `| ${b.bucket} | ${b.events} | ${b.live} | ${b.ended} | ${pct(b.liveShare)} |`), "",
    `- live while the start is more than ${p.liveBeforeStart.toleranceMin} min away (false positive for "in play"): ${p.liveBeforeStart.count} (${pct(p.liveBeforeStart.shareOfLive)} of live; up to ${p.liveBeforeStart.maxLeadMin ?? "—"} min early)`, `- live events that had started: ${p.liveAfterStartAgeMin.n}; minutes since start p10/p50/p90/max ${p.liveAfterStartAgeMin.p10 ?? "—"} / ${p.liveAfterStartAgeMin.p50 ?? "—"} / ${p.liveAfterStartAgeMin.p90 ?? "—"} / ${p.liveAfterStartAgeMin.max ?? "—"}`,
    `- started ${p.liveBeforeStart.toleranceMin}–${p.startedNotLive.windowMin} min ago, neither live nor ended (flag missing, or finished unflagged; false negatives): ${p.startedNotLive.count} (${pct(p.startedNotLive.shareOfRecentlyStarted)}); age p10/p50/p90 ${p.startedNotLive.ageMin.p10 ?? "—"} / ${p.startedNotLive.ageMin.p50 ?? "—"} / ${p.startedNotLive.ageMin.p90 ?? "—"} min`,
    `- \`ended\` events: ${p.ended.flagged}; all their markets resolved ${p.ended.allMarketsResolved}; some market not resolved ${p.ended.anyMarketOpen}; events whose markets are all resolved: ${p.ended.resolvedEvents}, of which not flagged ended ${p.ended.resolvedButNotFlagged}; live and ended at once ${p.ended.liveAndEnded}; live with all markets resolved ${p.ended.liveAndAllResolved}`, ""); }
  if (r.schedule && (r.schedule.us.length || r.schedule.kalshi.length || r.schedule.notes.length)) { L.push("## Schedule sources (event-level start with a time of day versus the other start field)", "");
    const tbl = (name: string, rows: ScheduleSummary[]) => { if (!rows.length) return; L.push(`### ${name}`, "", "| group | events | source has a time of day | other has a time of day | both | equal within 1 min | within 15 min | |diff| p50 / p90 / max (min) | source placeholders |", "|---|---|---|---|---|---|---|---|---|", ...rows.map((x) => `| ${x.sport} | ${x.events} | ${x.sourceWithTimeOfDay} | ${x.otherWithTimeOfDay} | ${x.both} | ${x.agreeWithin1Min} (${pct(x.agreeShare)}) | ${x.agreeWithin15Min} | ${x.absDiffMin.p50 ?? "—"} / ${x.absDiffMin.p90 ?? "—"} / ${x.absDiffMin.max ?? "—"} | ${x.sourcePlaceholders} |`), ""); };
    tbl("US: sports-endpoint event start versus market gameStartTime", r.schedule.us); tbl("Kalshi: milestone start_date versus event strike_date", r.schedule.kalshi); for (const n of r.schedule.notes) L.push(`- ${n}`); L.push(""); }
  L.push("## The same event on both venues (participant names + Eastern date; D51 input)", "");
  const e = r.eventAgreement; if (!e) L.push("Not available (a venue was not audited).", ""); else {
    L.push(`Events: ${e.eventsA} vs ${e.eventsB} (head-to-head ${e.headToHeadA} vs ${e.headToHeadB}); matched ${e.matched}; ambiguous (skipped) ${e.ambiguous}; matched with a start time on both: ${e.withBothStarts}. Start fields used: ${e.fieldsUsed.a ?? "none"} vs ${e.fieldsUsed.b ?? "none"}. ${e.reason ?? ""}`, "");
    if (e.overall) L.push("| scope | n | |diff| p50 min | p90 | p95 | p99 | max | within 15 min | within 60 min |", "|---|---|---|---|---|---|---|---|---|", ...[...e.summary, e.overall].map((s) => `| ${s.stratum} | ${s.n} | ${s.absP50Min} | ${s.absP90Min} | ${s.absP95Min} | ${s.absP99Min} | ${s.maxAbsMin} | ${pct(s.within15MinShare)} | ${pct(s.within60MinShare)} |`), "");
  }
  L.push("## Venue agreement by recommended fields (D51 input)", "");
  if (!r.venueAgreement.available) L.push(`Not available: ${r.venueAgreement.reason}`, ""); else {
    L.push(`Matched events: ${r.venueAgreement.matched} (match confidence ${JSON.stringify(r.venueAgreement.byConfidence)}). ${r.venueAgreement.reason ?? ""}`, "", "| stratum | n | |diff| p50 min | p90 | p95 | p99 | max | within 15 min | within 60 min |", "|---|---|---|---|---|---|---|---|---|");
    for (const s of r.venueAgreement.summary) L.push(`| ${s.stratum} | ${s.n} | ${s.absP50Min} | ${s.absP90Min} | ${s.absP95Min} | ${s.absP99Min} | ${s.maxAbsMin} | ${pct(s.within15MinShare)} | ${pct(s.within60MinShare)} |`);
    L.push("");
  }
  return L.join("\n");
}

/** ≤ 60 printed lines: what ran, what failed, and the verdict per stratum and slot with its evidence counts and deciding rule. Details are in the files. */
export function s1aSummaryLines(r: S1aResult, outDir: string, only: VenueId | null = null): string[] {
  const L: string[] = [`S1a timestamp audit  ${r.startedAt} → ${r.finishedAt}`, `requests ${r.http.requests} ok ${r.http.ok} failed ${JSON.stringify(r.http.byKind)}`];
  for (const e of r.http.firstErrors.slice(0, 3)) L.push(`  ! ${e}`);
  const rank = (s: SlotVerdict) => (s.verdict === "RECOMMEND" ? 0 : s.verdict === "UNRELIABLE_REJECT" ? 1 : 2);
  for (const v of r.venues) {
    L.push(`[${v.venue}] ${v.reachable ? `open ${v.counts.open} · resolved ${v.counts.resolved}${v.counts.ours ? ` · ours ${v.counts.ours}` : ""} · ${v.inventory.length} time-like fields` : "NOT REACHED — " + ([...(v.fetch.open?.errors ?? []), ...(v.fetch.resolved?.errors ?? [])][0] ?? "no markets")}`);
    if (!v.reachable) continue;
    const st = Object.entries(v.strata).map(([k, c]) => `${k} ${c.open}/${c.resolved}`).join(" · "); if (st) L.push(`  strata open/resolved: ${st}`);
    const ev = Object.entries(v.strata).map(([k, c]) => `${k} ${c.events}`).join(" · "); if (ev) L.push(`  distinct events: ${ev}`);
    const rows = [...v.recommendations].sort((a, b) => rank(a) - rank(b) || b.events - a.events || (a.stratum < b.stratum ? -1 : 1) || a.slot - b.slot);
    const show = rows.slice(0, 5);
    // the best PASSING field (or none), then every candidate judged for the slot with the rule that decided it
    for (const s of show) { const best = s.bestField !== undefined ? s.bestField : s.verdict === "RECOMMEND" ? s.field : null; const cands = (s.candidates ?? []).slice(0, 3).map((c) => `${fieldLabel(c.field)}:${c.verdict === "RECOMMEND" ? "OK" : c.decidedBy}`).join(" "); L.push(`  ${s.stratum.padEnd(20)} s${s.slot} ${best ? "OK    " : s.verdict === "INSUFFICIENT_DATA" ? "?DATA " : "REJECT"} ${(best ?? "none").slice(0, 22)} ev ${s.events} [${cands || s.decidedBy}]`); }
    if (rows.length > show.length) L.push(`  … ${rows.length - show.length} more verdict rows in s1a_${v.venue}.json and S1_COMPACT.md`);
    if (v.listing) L.push(`  listing: ${v.listing.total} markets, ${v.listing.distinctEvents} events; ${Object.entries(v.listing.byBucket).map(([k, n]) => `${k} ${n}`).join(" · ")}; top categories ${Object.entries(v.listing.byCategory).sort((a, b) => b[1].total - a[1].total).slice(0, 4).map(([k, c]) => `${k} ${c.open}/${c.closed}/${c.settled}`).join(", ")} (open/closed/settled)`);
    const fv = v.futuresVerdicts ?? []; if (fv.length) L.push(`  gameStartTime futures vs single-game: ${fv.slice(0, 5).map((x) => `${x.sport.replace("sports:", "")} ${x.verdict === "SINGLE_GAME_ONLY" ? "single-game only" : x.verdict === "INSUFFICIENT_DATA" ? "?" : "no difference"}`).join(" · ")}`);
    const g = v.gameStart; if (g.field) { const all = g.presence.filter((p) => p.marketType === "(all)"); L.push(`  gameStartTime (${g.field}): present on ${all.reduce((a, p) => a + p.withField, 0)}/${all.reduce((a, p) => a + p.markets, 0)} sports markets; strata reaching 100 markets/30 events: ${g.reach.filter((x) => x.reaches100MarketsFrom30Events).length}/${g.reach.length}${g.vsEventStart ? `; equals event start in ${pct(g.vsEventStart.agreeShare)} of ${g.vsEventStart.events} events` : ""}`); }
    if (v.targeted.length) L.push(`  targeted US queries: ${v.targeted.map((t) => `${t.sport} ${t.markets}/${t.events}${t.reachedQuota ? "" : "!"}`).join(" ")}`);
    if (v.dateLevel.length) L.push(`  date-level alternative (not recommended): ${v.dateLevel.slice(0, 4).map((d) => `${d.stratum} ${pct(d.impliedShare)} of ${d.events} ev`).join("; ")}`);
  }
  if (r.sportsApi) L.push(`US sports API: ${r.sportsApi.sports} sports, ${r.sportsApi.leagues} leagues, ${r.sportsApi.requests} requests${r.sportsApi.stoppedBecause ? ` (STOPPED: ${r.sportsApi.stoppedBecause})` : ""}${r.sportsApi.errors.length ? `; ${r.sportsApi.errors[0]}` : ""}`);
  if (r.inPlay) { const p = r.inPlay; L.push(`live/ended (measured, not adopted): ${p.events} events (${p.withStart} with a start); live before start ${p.liveBeforeStart.count} (max ${p.liveBeforeStart.maxLeadMin ?? "—"} min early); live ${p.liveAfterStartAgeMin.p50 ?? "—"} min after start (p50, p90 ${p.liveAfterStartAgeMin.p90 ?? "—"}); started-not-live ${p.startedNotLive.count}${p.startedNotLive.shareOfRecentlyStarted === null ? "" : ` (${pct(p.startedNotLive.shareOfRecentlyStarted)})`}; ended&all-resolved ${p.ended.allMarketsResolved}/${p.ended.flagged}`); }
  if (r.schedule && r.schedule.us.length) L.push(`US schedule (sports endpoint event start vs gameStartTime): ${r.schedule.us.slice(0, 4).map((x) => `${x.sport.replace("sports:", "")} ${x.both} pairs ${pct(x.agreeShare)} equal`).join(" · ")}`);
  if (r.schedule && r.schedule.kalshi.length) L.push(`Kalshi schedule (milestone start vs strike_date): ${r.schedule.kalshi.slice(0, 4).map((x) => `${x.sport} ${x.both} pairs ${pct(x.agreeShare)} equal`).join(" · ")}`);
  for (const n of r.schedule?.notes.slice(0, 2) ?? []) L.push(`  ! ${n}`);
  const ea = r.eventAgreement; L.push(ea ? `same event on both venues: matched ${ea.matched} (ambiguous ${ea.ambiguous}); start times on both ${ea.withBothStarts}${ea.overall ? `; |diff| p50 ${ea.overall.absP50Min} / p95 ${ea.overall.absP95Min} / max ${ea.overall.maxAbsMin} min; within 15 min ${pct(ea.overall.within15MinShare)}` : ""}${ea.reason ? ` (${ea.reason})` : ""}` : "same event on both venues: not available");
  L.push(r.venueAgreement.available ? `venue agreement (recommended fields): ${r.venueAgreement.matched} matched; ${r.venueAgreement.summary.map((s) => `${s.stratum} p95 ${s.absP95Min} min`).slice(0, 3).join("; ")}` : `venue agreement (recommended fields): not available (${r.venueAgreement.reason})`);
  for (const n of r.notEstablished.slice(0, 3)) L.push(`NOT ESTABLISHED: ${n}`);
  L.push(only ? `file in ${outDir}: ${evidenceFile(only, "audit")} (single-venue run; combine with npm run phase4:merge)` : `files in ${outDir}: s1a_*.json, S1a_RESULTS.md, S1_COMPACT.md`);
  while (L.length > 60) L.splice(L.length - 2, 1); // an over-long run drops the later detail lines, never the file list
  return L.map((l) => (l.length > 220 ? l.slice(0, 217) + "..." : l)).slice(0, 60);
}
