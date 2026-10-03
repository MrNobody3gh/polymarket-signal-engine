/**
 * Phase 4.0 (S1a) — the timestamp audit, orchestrated: fetch samples from each reachable venue, analyse them
 * (audit.ts), and produce JSON, a Markdown results page and a compact printed summary. Everything that touches the
 * world is injected (http, clock, file writer, our resolution times), so tests drive it with fixtures and a fake fetch.
 * A venue that cannot be reached is reported with the exact failure and the audit continues with the other.
 */
import { buildInventory, candidateEvidence, compareVenues, instantOf, recommendSlots, stratifiedSample, toAuditMarkets, type AuditMarket, type CandidateEvidence, type FieldInventory, type RawMarket, type SlotVerdict, type VenueDiffSummary } from "./audit";
import type { PoliteHttp } from "./http";
import { matchSignalToVenue, type VenueMarketRef } from "./mapping";
import { INTERNATIONAL, US_EXCHANGE, fetchGamma, fetchUs, gammaGroupOf, gammaIdOf, gammaIsResolved, gammaOutcomes, gammaTitleOf, gammaTokenIds, sanitizeSample, tagsOf, usGroupOf, usIdOf, usIsResolved, usOutcomes, usTitleOf, type FetchNotes, type UsConfig } from "./venues";

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
  fixtureDir?: string; maxFixtureMarkets?: number;
  log?: (m: string) => void;
}

export interface VenueAudit {
  venue: string; reachable: boolean;
  fetch: { open: FetchNotes | null; resolved: FetchNotes | null };
  counts: { open: number; resolved: number; ours: number };
  strata: Record<string, { open: number; resolved: number }>;
  inventory: FieldInventory[];
  evidence: Record<string, CandidateEvidence[]>;
  recommendations: SlotVerdict[];
}
export interface S1aResult {
  startedAt: string; finishedAt: string;
  venues: VenueAudit[];
  venueAgreement: { available: boolean; reason: string | null; matched: number; byConfidence: Record<string, number>; summary: VenueDiffSummary[] };
  http: { requests: number; ok: number; byKind: Record<string, number>; firstErrors: string[] };
  endpoints: string[]; docs: string[];
  rules: Record<string, number>;
  notEstablished: string[];
}

import { RECOMMEND_RULES } from "./audit";
import { INTL_DOCS, US_DOCS } from "./venues";

const iso = (ms: number) => new Date(ms).toISOString();
const SIZE_CAP = 380_000; // bytes per fixture file

function auditVenue(venue: string, open: RawMarket[], resolved: RawMarket[], notes: VenueAudit["fetch"], acc: { idOf: (m: RawMarket) => string; isResolved: (m: RawMarket) => boolean; titleOf: (m: RawMarket) => string | null; groupOf: (m: RawMarket) => string }, ours: S1aOptions["ours"], o: { sampleOpen: number; sampleResolved: number }): { audit: VenueAudit; markets: AuditMarket[] } {
  const mk = (raws: RawMarket[], forceResolved: boolean | null, ourMs?: (m: RawMarket) => number | null) => toAuditMarkets(venue, raws, { idOf: acc.idOf, isResolved: (m) => (forceResolved === null ? acc.isResolved(m) : forceResolved), titleOf: acc.titleOf, slugOf: (m) => (typeof m.slug === "string" ? m.slug : null), tagsOf, groupOf: acc.groupOf, ourResolutionMs: ourMs });
  const per = (n: number) => Math.ceil(n / 6);
  const openM = stratifiedSample(mk(open, false), per(o.sampleOpen), o.sampleOpen);
  const resM = stratifiedSample(mk(resolved, true), per(o.sampleResolved), o.sampleResolved);
  const oursMap = new Map((ours ?? []).map((x) => [gammaIdOf(x.raw), x.resolvedMs]));
  const oursM = venue === INTERNATIONAL && ours?.length ? mk(ours.map((x) => x.raw), true, (m) => oursMap.get(gammaIdOf(m)) ?? null) : [];
  const markets = [...openM, ...resM, ...oursM]; const inventory = buildInventory(markets);
  const strata: VenueAudit["strata"] = {}; for (const m of markets) { const s = (strata[m.stratum] ??= { open: 0, resolved: 0 }); if (m.resolved) s.resolved++; else s.open++; }
  const evidence: VenueAudit["evidence"] = {}; for (const st of Object.keys(strata).sort()) { const sm = markets.filter((m) => m.stratum === st); if (sm.length >= 10) evidence[st] = candidateEvidence(sm, inventory); }
  return { audit: { venue, reachable: markets.length > 0, fetch: notes, counts: { open: openM.length, resolved: resM.length, ours: oursM.length }, strata, inventory, evidence, recommendations: markets.length ? recommendSlots(venue, markets, inventory) : [] }, markets };
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
    const { audit, markets } = auditVenue(US_EXCHANGE, o.markets.filter((m) => !usIsResolved(m)), r.markets.filter((m) => usIsResolved(m)), { open: o.notes, resolved: r.notes }, { idOf: usIdOf, isResolved: usIsResolved, titleOf: usTitleOf, groupOf: usGroupOf }, undefined, { sampleOpen: so, sampleResolved: sr });
    venues.push(audit); mkts[US_EXCHANGE] = markets; raws[US_EXCHANGE] = { open: o.markets, resolved: r.markets };
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

  // 4 — files: JSON per venue, fixtures, results page
  const finishedAt = iso(now()); const sum = opt.http.summary();
  const result: S1aResult = { startedAt, finishedAt, venues, venueAgreement: agreement, http: sum, endpoints: venues.flatMap((v) => [v.fetch.open?.endpoint, v.fetch.resolved?.endpoint]).filter((x, i, arr): x is string => !!x && arr.indexOf(x) === i), docs: [...INTL_DOCS, ...(opt.us ? US_DOCS : [])], rules: { ...RECOMMEND_RULES }, notEstablished: [] };
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

export function renderS1aMarkdown(r: S1aResult): string {
  const L: string[] = ["# S1a timestamp audit — generated results", "", `Run: ${r.startedAt} → ${r.finishedAt}. Requests: ${r.http.requests} (ok ${r.http.ok}; failures ${JSON.stringify(r.http.byKind)}).`, "", "Endpoints used: " + (r.endpoints.map((e) => "`" + e + "`").join(", ") || "none"), "", "Documentation to confirm field meanings against: " + r.docs.join(", "), ""];
  if (r.notEstablished.length) L.push("## Not established in this run", "", ...r.notEstablished.map((x) => `- ${x}`), "");
  for (const v of r.venues) {
    L.push(`## ${v.venue}`, "", `Open sample ${v.counts.open}, resolved sample ${v.counts.resolved}${v.counts.ours ? `, our traded markets ${v.counts.ours}` : ""}. Fetch: open ${v.fetch.open ? `${v.fetch.open.records} markets in ${v.fetch.open.pages} pages (${v.fetch.open.stoppedBecause})` : "n/a"}; resolved ${v.fetch.resolved ? `${v.fetch.resolved.records} in ${v.fetch.resolved.pages} pages (${v.fetch.resolved.stoppedBecause})` : "n/a"}.`, "");
    if (!v.reachable) { L.push("**Unreachable or empty.** Errors: " + [...(v.fetch.open?.errors ?? []), ...(v.fetch.resolved?.errors ?? [])].join("; "), ""); continue; }
    L.push("### Time-field inventory", "", "| field | name suggests | present | formats | placeholder share | top times of day |", "|---|---|---|---|---|---|");
    for (const f of v.inventory) L.push(`| \`${f.path}\` | ${f.role} | ${(f.presence.overall.rate * 100).toFixed(0)} % | ${Object.entries(f.formats).map(([k, n]) => `${k}:${n}`).join(" ")} | ${(f.placeholderShare * 100).toFixed(0)} % | ${f.timeOfDay.topClocks.slice(0, 3).map((c) => `${c.clock} ${(c.share * 100).toFixed(0)}%`).join(", ")} |`);
    L.push("", "### Recommendation per stratum (rules in `RECOMMEND_RULES`, printed in the JSON)", "", "| stratum | slot | field | verdict | usable | failed rules / evidence |", "|---|---|---|---|---|---|");
    for (const s of v.recommendations) L.push(`| ${s.stratum} | ${s.slot} | ${s.field ? "`" + s.field + "`" : "—"} | ${s.verdict}${s.needsHumanReview ? " (human review)" : ""} | ${s.usableShare === null ? "—" : (s.usableShare * 100).toFixed(0) + " %"} | ${s.failed.join("; ") || JSON.stringify(s.evidence)} |`);
    L.push("");
  }
  L.push("## Venue agreement (D51 input)", "");
  if (!r.venueAgreement.available) L.push(`Not available: ${r.venueAgreement.reason}`, ""); else {
    L.push(`Matched events: ${r.venueAgreement.matched} (match confidence ${JSON.stringify(r.venueAgreement.byConfidence)}). ${r.venueAgreement.reason ?? ""}`, "", "| stratum | n | |diff| p50 min | p90 | p95 | p99 | max | within 15 min | within 60 min |", "|---|---|---|---|---|---|---|---|---|");
    for (const s of r.venueAgreement.summary) L.push(`| ${s.stratum} | ${s.n} | ${s.absP50Min} | ${s.absP90Min} | ${s.absP95Min} | ${s.absP99Min} | ${s.maxAbsMin} | ${s.within15MinShare === null ? "—" : (s.within15MinShare * 100).toFixed(0) + " %"} | ${s.within60MinShare === null ? "—" : (s.within60MinShare * 100).toFixed(0) + " %"} |`);
    L.push("");
  }
  return L.join("\n");
}

/** ≤ 60 printed lines: what ran, what failed, and the verdict per stratum and slot. Details are in the files. */
export function s1aSummaryLines(r: S1aResult, outDir: string): string[] {
  const L: string[] = [`S1a timestamp audit  ${r.startedAt} → ${r.finishedAt}`, `requests ${r.http.requests} ok ${r.http.ok} failed ${JSON.stringify(r.http.byKind)}`];
  for (const e of r.http.firstErrors) L.push(`  ! ${e}`);
  for (const v of r.venues) {
    L.push(`[${v.venue}] ${v.reachable ? `open ${v.counts.open} · resolved ${v.counts.resolved}${v.counts.ours ? ` · ours ${v.counts.ours}` : ""} · ${v.inventory.length} time-like fields` : "NOT REACHED — " + ([...(v.fetch.open?.errors ?? []), ...(v.fetch.resolved?.errors ?? [])][0] ?? "no markets")}`);
    const st = Object.entries(v.strata).map(([k, c]) => `${k} ${c.open}/${c.resolved}`).join(" · "); if (st) L.push(`  strata open/resolved: ${st}`);
    for (const s of v.recommendations.slice(0, 26)) L.push(`  ${s.stratum.padEnd(22)} slot${s.slot} ${s.verdict === "RECOMMEND" ? "OK    " : s.verdict === "INSUFFICIENT_DATA" ? "?DATA " : "REJECT"} ${(s.field ?? "—").slice(0, 34)}${s.usableShare === null ? "" : ` usable ${(s.usableShare * 100).toFixed(0)}%`}`);
    if (v.recommendations.length > 26) L.push(`  … ${v.recommendations.length - 26} more rows in the JSON`);
  }
  L.push(r.venueAgreement.available ? `venue agreement: ${r.venueAgreement.matched} matched events; ${r.venueAgreement.summary.map((s) => `${s.stratum} p95 ${s.absP95Min} min`).slice(0, 4).join("; ")}` : `venue agreement: not available (${r.venueAgreement.reason})`);
  for (const n of r.notEstablished.slice(0, 4)) L.push(`NOT ESTABLISHED: ${n}`);
  L.push(`files in ${outDir}: s1a_*.json, S1a_RESULTS.md`);
  return L.map((l) => (l.length > 220 ? l.slice(0, 217) + "..." : l)).slice(0, 60);
}
