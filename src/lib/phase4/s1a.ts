/**
 * Phase 4.0 (S1a) — the timestamp audit, orchestrated: fetch samples from each reachable venue, analyse them
 * (audit.ts), and produce JSON, a Markdown results page and a compact printed summary. Everything that touches the
 * world is injected (http, clock, file writer, our resolution times), so tests drive it with fixtures and a fake fetch.
 * A venue that cannot be reached is reported with the exact failure and the audit continues with the other.
 */
import { buildInventory, candidateEvidence, compareVenues, instantOf, recommendSlots, stratifiedSample, toAuditMarkets, type AuditMarket, type CandidateEvidence, type FieldInventory, type RawMarket, type SlotVerdict, type VenueDiffSummary } from "./audit";
import type { PoliteHttp } from "./http";
import { matchSignalToVenue, type VenueMarketRef } from "./mapping";
import { INTERNATIONAL, US_EXCHANGE, fetchGamma, fetchUs, fetchUsTargeted, gammaGroupOf, gammaIdOf, gammaIsResolved, gammaOutcomes, gammaTitleOf, gammaTokenIds, sanitizeSample, tagsOf, usGroupOf, usIdOf, usIsResolved, usOutcomes, usTitleOf, type FetchNotes, type TargetedQuery, type TargetedResult, type UsConfig } from "./venues";

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
}

export interface VenueAudit {
  venue: string; reachable: boolean;
  fetch: { open: FetchNotes | null; resolved: FetchNotes | null };
  counts: { open: number; resolved: number; ours: number };
  strata: Record<string, { open: number; resolved: number; events: number; markets: number }>;
  /** The date-level alternative rows (shown, never recommended) and the gameStartTime deep dive. */
  dateLevel: DateLevelRow[]; gameStart: GameStartDive;
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
}

import { RECOMMEND_RULES } from "./audit";
import { INTL_DOCS, US_DOCS } from "./venues";
import { dateLevelRows, collapseToEvents, type DateLevelRow } from "./audit";
import { gameStartDeepDive, matchEventsAcrossVenues, type EventAgreement, type GameStartDive } from "./events";

const iso = (ms: number) => new Date(ms).toISOString();
const SIZE_CAP = 380_000; // bytes per fixture file

function auditVenue(venue: string, open: RawMarket[], resolved: RawMarket[], notes: VenueAudit["fetch"], acc: { idOf: (m: RawMarket) => string; isResolved: (m: RawMarket) => boolean; titleOf: (m: RawMarket) => string | null; groupOf: (m: RawMarket) => string }, ours: S1aOptions["ours"], o: { sampleOpen: number; sampleResolved: number; extraOpen?: RawMarket[]; targeted?: VenueAudit["targeted"] }): { audit: VenueAudit; markets: AuditMarket[] } {
  const mk = (raws: RawMarket[], forceResolved: boolean | null, ourMs?: (m: RawMarket) => number | null) => toAuditMarkets(venue, raws, { idOf: acc.idOf, isResolved: (m) => (forceResolved === null ? acc.isResolved(m) : forceResolved), titleOf: acc.titleOf, slugOf: (m) => (typeof m.slug === "string" ? m.slug : null), tagsOf, groupOf: acc.groupOf, ourResolutionMs: ourMs });
  const per = (n: number) => Math.ceil(n / 6);
  const openM = stratifiedSample(mk(open, false), per(o.sampleOpen), o.sampleOpen);
  const resM = stratifiedSample(mk(resolved, true), per(o.sampleResolved), o.sampleResolved);
  const oursMap = new Map((ours ?? []).map((x) => [gammaIdOf(x.raw), x.resolvedMs]));
  const oursM = venue === INTERNATIONAL && ours?.length ? mk(ours.map((x) => x.raw), true, (m) => oursMap.get(gammaIdOf(m)) ?? null) : [];
  // targeted per-sport markets are added whole (they exist to reach the per-sport quota); markets already sampled are not repeated
  const have = new Set(openM.map((m) => m.id)); const extraM = mk(o.extraOpen ?? [], false).filter((m) => !have.has(m.id)); const openAll = [...openM, ...extraM];
  const markets = [...openAll, ...resM, ...oursM]; const inventory = buildInventory(markets);
  const strata: VenueAudit["strata"] = {}; for (const m of markets) { const s = (strata[m.stratum] ??= { open: 0, resolved: 0, events: 0, markets: 0 }); s.markets++; if (m.resolved) s.resolved++; else s.open++; }
  for (const st of Object.keys(strata)) strata[st].events = collapseToEvents(markets.filter((m) => m.stratum === st)).length;
  const evidence: VenueAudit["evidence"] = {}; for (const st of Object.keys(strata).sort()) { const sm = markets.filter((m) => m.stratum === st); if (sm.length >= 10) evidence[st] = candidateEvidence(sm, inventory); }
  return { audit: { venue, reachable: markets.length > 0, fetch: notes, counts: { open: openAll.length, resolved: resM.length, ours: oursM.length }, strata, dateLevel: markets.length ? dateLevelRows(venue, markets, inventory) : [], gameStart: gameStartDeepDive(venue, markets, inventory), targeted: o.targeted ?? [], inventory, evidence, recommendations: markets.length ? recommendSlots(venue, markets, inventory) : [] }, markets };
}

/** The recommended field for a market's stratum: slot 1 if recommended, else slot 2 if recommended, else null. */
const bestField = (recs: SlotVerdict[], st: string): string | null => recs.find((r) => r.stratum === st && r.slot === 1 && r.verdict === "RECOMMEND")?.field ?? recs.find((r) => r.stratum === st && r.slot === 2 && r.verdict === "RECOMMEND")?.field ?? null;

export async function runS1a(opt: S1aOptions): Promise<S1aResult> {
  const now = opt.now ?? (() => Date.now()); const log = opt.log ?? (() => {}); const startedAt = iso(now());
  const so = opt.sampleOpen ?? 300, sr = opt.sampleResolved ?? 300; const ff = Math.max(1, opt.fetchFactor ?? 3); const venues: VenueAudit[] = []; const mkts: Record<string, AuditMarket[]> = {}; const raws: Record<string, { open: RawMarket[]; resolved: RawMarket[] }> = {};

  // 1 — international venue
  {
    log("intl: open markets"); const o = await fetchGamma(opt.http, { closed: false, max: so * ff });
    log("intl: resolved markets"); let r = await fetchGamma(opt.http, { closed: true, max: sr * ff, order: { order: "closedTime", ascending: false } });
    if (!r.markets.length || r.notes.filterHonoured === false) { const r2 = await fetchGamma(opt.http, { closed: true, max: sr * ff }); r2.notes.errors.unshift(`ordered query: ${r.notes.errors[0] ?? (r.notes.filterHonoured === false ? "closed filter not honoured" : "no records")}`); if (r2.markets.length) r = r2; }
    const resolvedOnly = r.markets.filter((m) => gammaIsResolved(m));
    const { audit, markets } = auditVenue(INTERNATIONAL, o.markets.filter((m) => !gammaIsResolved(m)), resolvedOnly, { open: o.notes, resolved: r.notes }, { idOf: gammaIdOf, isResolved: gammaIsResolved, titleOf: gammaTitleOf, groupOf: gammaGroupOf }, opt.ours, { sampleOpen: so, sampleResolved: sr });
    venues.push(audit); mkts[INTERNATIONAL] = markets; raws[INTERNATIONAL] = { open: o.markets, resolved: resolvedOnly };
  }
  // 2 — US venue
  if (opt.us) {
    log("us: open markets"); const o = await fetchUs(opt.http, opt.us, { closed: false, max: so * ff });
    log("us: resolved markets"); const r = await fetchUs(opt.http, opt.us, { closed: true, max: sr * ff });
    const targeted: TargetedResult[] = []; for (const q of opt.usTargeted ?? []) { log(`us: targeted ${q.sport}`); targeted.push(await fetchUsTargeted(opt.http, opt.us, q)); }
    const targetedSummary = targeted.map((t) => ({ sport: t.sport, query: t.query, markets: t.markets.length, events: t.events, reachedQuota: t.reachedQuota, stoppedBecause: t.notes.stoppedBecause, errors: t.notes.errors.slice(0, 2) }));
    const { audit, markets } = auditVenue(US_EXCHANGE, o.markets.filter((m) => !usIsResolved(m)), r.markets.filter((m) => usIsResolved(m)), { open: o.notes, resolved: r.notes }, { idOf: usIdOf, isResolved: usIsResolved, titleOf: usTitleOf, groupOf: usGroupOf }, undefined, { sampleOpen: so, sampleResolved: sr, extraOpen: targeted.flatMap((t) => t.markets).filter((m) => !usIsResolved(m)), targeted: targetedSummary });
    venues.push(audit); mkts[US_EXCHANGE] = markets; raws[US_EXCHANGE] = { open: [...o.markets, ...targeted.flatMap((t) => t.markets)], resolved: r.markets };
  }

  // 3 — venue agreement on matched events
  const agreement: S1aResult["venueAgreement"] = { available: false, reason: null, matched: 0, byConfidence: {}, summary: [] };
  const a = venues.find((v) => v.venue === INTERNATIONAL), b = venues.find((v) => v.venue === US_EXCHANGE);
  if (!a?.reachable || !b?.reachable) agreement.reason = !b ? "the US venue was not audited (not configured or not reachable)" : "a venue returned no markets";
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
  if (a?.reachable && b?.reachable) {
    const titleOf = (m: AuditMarket) => { const v = m.flat.question ?? m.flat.title ?? m.flat.name; return typeof v === "string" ? v : null; };
    const ea = matchEventsAcrossVenues({ ms: mkts[INTERNATIONAL], inv: a.inventory, titleOf }, { ms: mkts[US_EXCHANGE], inv: b.inventory, titleOf });
    eventAgreement = { ...ea, reason: ea.matched === 0 ? "no event matched by participant names and date" : ea.withBothStarts === 0 ? "events matched, but no matched pair has a start time on both venues (gameStartTime or event startTime)" : null };
  }

  // 4 — files: JSON per venue, fixtures, results page
  const finishedAt = iso(now()); const sum = opt.http.summary();
  const result: S1aResult = { startedAt, finishedAt, venues, eventAgreement, venueAgreement: agreement, http: sum, endpoints: venues.flatMap((v) => [v.fetch.open?.endpoint, v.fetch.resolved?.endpoint]).filter((x, i, arr): x is string => !!x && arr.indexOf(x) === i), docs: [...INTL_DOCS, ...(opt.us ? US_DOCS : [])], rules: { ...RECOMMEND_RULES }, notEstablished: [] };
  for (const v of venues) result.notEstablished.push(...(v.reachable ? [] : [`${v.venue}: no markets could be fetched (${[v.fetch.open?.errors[0], v.fetch.resolved?.errors[0]].filter(Boolean).join("; ") || "empty response"})`]));
  if (!opt.us) result.notEstablished.push(`${US_EXCHANGE}: not audited in this run`);
  for (const v of venues) opt.write(`s1a_${v.venue}.json`, JSON.stringify(v, null, 1));
  opt.write("s1a_summary.json", JSON.stringify({ ...result, venues: venues.map((v) => ({ venue: v.venue, reachable: v.reachable, counts: v.counts, fetch: v.fetch, recommendations: v.recommendations })) }, null, 1));
  if (opt.fixtureDir) for (const v of venues) if (v.reachable) for (const kind of ["open", "resolved"] as const) {
    let list = raws[v.venue][kind].slice(0, opt.maxFixtureMarkets ?? 40).map((m) => sanitizeSample(m)); let text = JSON.stringify(list, null, 1);
    while (text.length > SIZE_CAP && list.length > 1) { list = list.slice(0, Math.floor(list.length / 2)); text = JSON.stringify(list, null, 1); }
    opt.write(`${opt.fixtureDir}/s1a_${v.venue}_${kind}.json`, text);
  }
  opt.write("S1a_RESULTS.md", renderS1aMarkdown(result));
  return result;
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
export function s1aSummaryLines(r: S1aResult, outDir: string): string[] {
  const L: string[] = [`S1a timestamp audit  ${r.startedAt} → ${r.finishedAt}`, `requests ${r.http.requests} ok ${r.http.ok} failed ${JSON.stringify(r.http.byKind)}`];
  for (const e of r.http.firstErrors.slice(0, 3)) L.push(`  ! ${e}`);
  const rank = (s: SlotVerdict) => (s.verdict === "RECOMMEND" ? 0 : s.verdict === "UNRELIABLE_REJECT" ? 1 : 2);
  for (const v of r.venues) {
    L.push(`[${v.venue}] ${v.reachable ? `open ${v.counts.open} · resolved ${v.counts.resolved}${v.counts.ours ? ` · ours ${v.counts.ours}` : ""} · ${v.inventory.length} time-like fields` : "NOT REACHED — " + ([...(v.fetch.open?.errors ?? []), ...(v.fetch.resolved?.errors ?? [])][0] ?? "no markets")}`);
    if (!v.reachable) continue;
    const st = Object.entries(v.strata).map(([k, c]) => `${k} ${c.open}/${c.resolved}`).join(" · "); if (st) L.push(`  strata open/resolved: ${st}`);
    const ev = Object.entries(v.strata).map(([k, c]) => `${k} ${c.events}`).join(" · "); if (ev) L.push(`  distinct events: ${ev}`);
    const rows = [...v.recommendations].sort((a, b) => rank(a) - rank(b) || b.events - a.events || (a.stratum < b.stratum ? -1 : 1) || a.slot - b.slot);
    const show = rows.slice(0, 10);
    for (const s of show) L.push(`  ${s.stratum.padEnd(22)} slot${s.slot} ${s.verdict === "RECOMMEND" ? "OK    " : s.verdict === "INSUFFICIENT_DATA" ? "?DATA " : "REJECT"} ${(s.field ?? "—").slice(0, 26)} ev ${s.events}/mk ${s.markets} usable ${s.usableShare === null ? "—" : (s.usableShare * 100).toFixed(0) + "%"} ET ${s.etPlaceholderShare === null ? "—" : (s.etPlaceholderShare * 100).toFixed(0) + "%"} by ${s.decidedBy}`);
    if (rows.length > show.length) L.push(`  … ${rows.length - show.length} more verdict rows in s1a_${v.venue}.json`);
    const g = v.gameStart; if (g.field) { const all = g.presence.filter((p) => p.marketType === "(all)"); L.push(`  gameStartTime (${g.field}): present on ${all.reduce((a, p) => a + p.withField, 0)}/${all.reduce((a, p) => a + p.markets, 0)} sports markets; strata reaching 100 markets/30 events: ${g.reach.filter((x) => x.reaches100MarketsFrom30Events).length}/${g.reach.length}${g.vsEventStart ? `; equals event start in ${pct(g.vsEventStart.agreeShare)} of ${g.vsEventStart.events} events` : ""}`); }
    if (v.targeted.length) L.push(`  targeted US queries: ${v.targeted.map((t) => `${t.sport} ${t.markets}/${t.events}${t.reachedQuota ? "" : "!"}`).join(" ")}`);
    if (v.dateLevel.length) L.push(`  date-level alternative (not recommended): ${v.dateLevel.slice(0, 4).map((d) => `${d.stratum} ${pct(d.impliedShare)} of ${d.events} ev`).join("; ")}`);
  }
  const ea = r.eventAgreement; L.push(ea ? `same event on both venues: matched ${ea.matched} (ambiguous ${ea.ambiguous}); start times on both ${ea.withBothStarts}${ea.overall ? `; |diff| p50 ${ea.overall.absP50Min} / p95 ${ea.overall.absP95Min} / max ${ea.overall.maxAbsMin} min; within 15 min ${pct(ea.overall.within15MinShare)}` : ""}${ea.reason ? ` (${ea.reason})` : ""}` : "same event on both venues: not available");
  L.push(r.venueAgreement.available ? `venue agreement (recommended fields): ${r.venueAgreement.matched} matched; ${r.venueAgreement.summary.map((s) => `${s.stratum} p95 ${s.absP95Min} min`).slice(0, 3).join("; ")}` : `venue agreement (recommended fields): not available (${r.venueAgreement.reason})`);
  for (const n of r.notEstablished.slice(0, 3)) L.push(`NOT ESTABLISHED: ${n}`);
  L.push(`files in ${outDir}: s1a_*.json, S1a_RESULTS.md`);
  return L.map((l) => (l.length > 220 ? l.slice(0, 217) + "..." : l)).slice(0, 60);
}
