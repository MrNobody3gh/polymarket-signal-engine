/**
 * Phase 4.0b — event-level analysis for S1a: participants parsed from titles, the `gameStartTime` deep dive and the matching of the
 * same event across the two venues by participant names and date. Pure; no I/O.
 * Nothing here recommends a field: it measures and shows (the owner decides).
 */
import { easternParts } from "./timestamps";
import { participantsOf, participantSimilarity } from "./mapping";
export { participantsOf, participantSimilarity };
import { collapseToEvents, compareVenues, instantOf, relation, resolutionReferences, type AuditMarket, type FieldInventory, type Relation, type VenueDiffSummary } from "./audit";
import { quantile } from "./stats";

// ───────────────────────────────────────────── field lookup ─────────────────────────────────────────────

const leaf = (p: string) => p.split(".").pop()!.replace(/\[\]/g, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
/** The inventory path whose last segment is `name` (case-insensitive), preferring a top-level one over a nested one. */
export function findField(inv: FieldInventory[], name: string): string | null {
  const hits = inv.filter((f) => leaf(f.path) === name.toLowerCase()).map((f) => f.path).sort((a, b) => a.split(".").length - b.split(".").length || (a < b ? -1 : 1)); return hits[0] ?? null;
}
/** The paths named `startTime` under an event (`events[].startTime`, `event.startTime`): an event-level start, distinct from `startDate`. */
export function findEventStartTime(inv: FieldInventory[]): string | null {
  return inv.map((f) => f.path).filter((p) => leaf(p) === "starttime" && /(^|\.)events?(\[\])?\./.test(p)).sort()[0] ?? null;
}
/** The market-type field if the venue has one (searched in the market objects: it is not a time field, so it is not in the inventory): `sportsMarketType`, `sportsMarketTypes`, `marketType`, `market_type`. */
export function findMarketTypeField(ms: AuditMarket[]): string | null { const keys = new Set<string>(); for (const m of ms.slice(0, 500)) for (const k of Object.keys(m.flat)) keys.add(k); for (const n of ["sportsMarketType", "sportsMarketTypes", "marketType", "market_type"]) { const hit = [...keys].filter((k) => leaf(k) === leaf(n)).sort((a, b) => a.split(".").length - b.split(".").length || (a < b ? -1 : 1))[0]; if (hit) return hit; } return null; }
const rawMarketType = (m: AuditMarket, path: string | null): string => { if (!path) return "(unknown)"; const v = m.flat[path]; return typeof v === "string" && v ? v.toUpperCase() : "(none)"; };

// ───────────────────────────────────────────── gameStartTime deep dive ──────────────────────────────────

export interface PresenceRow { sport: string; marketType: string; markets: number; withField: number; presenceShare: number; events: number; eventsWithField: number }
export interface ClockRow { sport: string; events: number; distinctClocks: number; topClock: string | null; topClockEvents: number; topClockShare: number | null }
export interface GameStartDive {
  venue: string; field: string | null; eventStartField: string | null; marketTypeField: string | null;
  /** Presence by sport and by market type (markets and distinct events). */
  presence: PresenceRow[];
  /** Distinct events per sport and whether the stratum can reach the ≥ 100 markets / ≥ 30 events the brief asks for. */
  reach: { sport: string; markets: number; events: number; reaches100MarketsFrom30Events: boolean }[];
  /** gameStartTime against events[].startTime where both exist (one pair per event). */
  vsEventStart: { events: number; agreeWithin1Min: number; agreeShare: number | null; relation: Relation | null } | null;
  /** gameStartTime minus the creation-like fields, per event. */
  vsCreation: Record<string, Relation>;
  /** Resolution minus game start per sport: it should be positive and bounded by a game's length. */
  resolutionMinusStart: { sport: string; events: number; positiveShare: number | null; within12hShare: number | null; within24hShare: number | null; p10Hours: number | null; p50Hours: number | null; p90Hours: number | null }[];
  /** Time of day per DISTINCT EVENT (UTC and Eastern), by sport. */
  clockPerEvent: ClockRow[]; clockPerEventEastern: ClockRow[];
  /** `gameStartTime` on single-game market types (MONEYLINE, SPREAD, TOTAL, PROP, …) versus FUTURES markets, per sport (4.0c, Part D2). */
  futures: FuturesRow[];
}
/** The classes of market type the comparison separates. */
export type MarketClass = "single_game" | "futures" | "unclassified";
export const marketClassOf = (type: string): MarketClass => (/FUTURE/.test(type) ? "futures" : type === "(unknown)" || type === "(none)" ? "unclassified" : "single_game");
export interface FuturesRow {
  sport: string; class: MarketClass; events: number; withField: number; distinctClocks: number; topClock: string | null; topClockShare: number | null;
  /** gameStartTime minus the creation-like field, hours (positive = the game starts after the market was created), per event */
  startMinusCreationHours: { p10: number | null; p50: number | null; p90: number | null } | null;
  /** Share of events whose gameStartTime is within 60 minutes of a creation-like field (a listing time, not a kick-off). */
  withinHourOfCreationShare: number | null;
  /** resolution − gameStartTime, hours, per resolved event */
  resolutionMinusStartHours: { n: number; p10: number | null; p50: number | null; p90: number | null; within24hShare: number | null } | null;
}
export interface FuturesVerdict { sport: string; verdict: "SINGLE_GAME_ONLY" | "NO_DIFFERENCE_OBSERVED" | "INSUFFICIENT_DATA"; rule: string }
/** The fixed rule for the verdict (a report of what differs, not a policy): see `futuresVerdicts`. */
export const FUTURES_RULE = { minEventsPerClass: 30, maxMedianResolutionGapHoursSingleGame: 24, listingTimeShare: 0.5 } as const;
const round = (x: number | null, d = 1) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
const clockRows = (rows: { sport: string; clock: string }[]): ClockRow[] => {
  const by = new Map<string, Map<string, number>>(); for (const r of rows) { const m = by.get(r.sport) ?? new Map<string, number>(); m.set(r.clock, (m.get(r.clock) ?? 0) + 1); by.set(r.sport, m); }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([sport, m]) => { const top = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]; const n = [...m.values()].reduce((a, b) => a + b, 0); return { sport, events: n, distinctClocks: m.size, topClock: top?.[0] ?? null, topClockEvents: top?.[1] ?? 0, topClockShare: n ? round(top[1] / n, 3) : null }; });
};
/** `gameStartTime` (and its relation to the event start time, creation time and the venue's resolution/closure time) by sport and market type, at event level. */
export function gameStartDeepDive(venue: string, ms: AuditMarket[], inv: FieldInventory[]): GameStartDive {
  const field = findField(inv, "gameStartTime"); const evStart = findEventStartTime(inv); const mt = findMarketTypeField(ms); const refs = resolutionReferences(inv);
  const sportOf = (m: AuditMarket) => m.stratum; const sports = [...new Set(ms.map(sportOf))].filter((s) => s.startsWith("sports") || s === "esports").sort();
  const presence: PresenceRow[] = []; const reach: GameStartDive["reach"] = [];
  for (const sp of sports) {
    const sm = ms.filter((m) => sportOf(m) === sp); const types = [...new Set(sm.map((m) => rawMarketType(m, mt)))].sort();
    for (const t of ["(all)", ...types]) {
      const sel = t === "(all)" ? sm : sm.filter((m) => rawMarketType(m, mt) === t); const has = sel.filter((m) => field && m.flat[field] !== undefined && m.flat[field] !== null && m.flat[field] !== "");
      presence.push({ sport: sp, marketType: t, markets: sel.length, withField: has.length, presenceShare: sel.length ? round(has.length / sel.length, 3)! : 0, events: new Set(sel.map((m) => m.group)).size, eventsWithField: new Set(has.map((m) => m.group)).size });
    }
    const evs = new Set(sm.map((m) => m.group)).size; reach.push({ sport: sp, markets: sm.length, events: evs, reaches100MarketsFrom30Events: sm.length >= 100 && evs >= 30 });
  }
  const evMs = collapseToEvents(ms.filter((m) => sports.includes(sportOf(m)))); const withField = field ? evMs.filter((m) => instantOf(m.flat[field]) !== null) : [];
  const pairsStart = evStart && field ? evMs.flatMap((m) => { const a = instantOf(m.flat[field]), b = instantOf(m.flat[evStart]); return a !== null && b !== null ? [{ a, b }] : []; }) : [];
  const vsEventStart = field && evStart ? { events: pairsStart.length, agreeWithin1Min: pairsStart.filter((p) => Math.abs(p.a - p.b) <= 60_000).length, agreeShare: pairsStart.length ? round(pairsStart.filter((p) => Math.abs(p.a - p.b) <= 60_000).length / pairsStart.length, 3) : null, relation: pairsStart.length ? relation(pairsStart) : null } : null;
  const vsCreation: Record<string, Relation> = {}; for (const cf of inv.filter((f) => f.role === "CREATION_LIKE")) { const prs = field ? withField.flatMap((m) => { const b = instantOf(m.flat[cf.path]); return b !== null ? [{ a: instantOf(m.flat[field])!, b }] : []; }) : []; if (prs.length) vsCreation[cf.path] = relation(prs); }
  const rm = sports.map((sp) => { const rows = withField.filter((m) => sportOf(m) === sp && m.resolved).flatMap((m) => { const refMs = (() => { const v = refs.map((r) => r.get(m)).filter((x): x is number => x !== null); return v.length ? Math.min(...v) : null; })(); return refMs === null ? [] : [(refMs - instantOf(m.flat[field!])!) / 3_600_000]; });
    return { sport: sp, events: rows.length, positiveShare: rows.length ? round(rows.filter((h) => h > 0).length / rows.length, 3) : null, within12hShare: rows.length ? round(rows.filter((h) => h > 0 && h <= 12).length / rows.length, 3) : null, within24hShare: rows.length ? round(rows.filter((h) => h > 0 && h <= 24).length / rows.length, 3) : null, p10Hours: round(quantile(rows, 0.1)), p50Hours: round(quantile(rows, 0.5)), p90Hours: round(quantile(rows, 0.9)) }; }).filter((r) => r.events > 0);
  const clocks = withField.map((m) => { const ms0 = instantOf(m.flat[field!])!; return { sport: sportOf(m), utc: new Date(ms0).toISOString().slice(11, 19), et: easternParts(ms0).time }; });
  return { venue, field, eventStartField: evStart, marketTypeField: mt, presence, reach, vsEventStart, vsCreation, resolutionMinusStart: rm, clockPerEvent: clockRows(clocks.map((c) => ({ sport: c.sport, clock: c.utc }))), clockPerEventEastern: clockRows(clocks.map((c) => ({ sport: c.sport, clock: c.et }))), futures: futuresComparison(ms, inv, field, mt, sports) };
}

/** `gameStartTime` per sport for single-game market types versus FUTURES markets: time-of-day spread, relation to creation and to resolution (events are counted once per class). */
export function futuresComparison(ms: AuditMarket[], inv: FieldInventory[], field: string | null, marketTypeField: string | null, sports: string[]): FuturesRow[] {
  if (!field) return []; const refs = resolutionReferences(inv); const creations = inv.filter((f) => f.role === "CREATION_LIKE"); const out: FuturesRow[] = [];
  for (const sp of sports) for (const cls of ["single_game", "futures", "unclassified"] as MarketClass[]) {
    const sel = ms.filter((m) => m.stratum === sp && marketClassOf(rawMarketType(m, marketTypeField)) === cls); if (!sel.length) continue;
    const evs = collapseToEvents(sel); const has = evs.filter((m) => instantOf(m.flat[field]) !== null); const clock = new Map<string, number>(); for (const m of has) { const c = new Date(instantOf(m.flat[field])!).toISOString().slice(11, 19); clock.set(c, (clock.get(c) ?? 0) + 1); }
    const top = [...clock.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    const cre = has.flatMap((m) => { const t = instantOf(m.flat[field])!; const c = creations.map((f) => instantOf(m.flat[f.path])).filter((x): x is number => x !== null); return c.length ? [{ gap: (t - Math.min(...c)) / 3_600_000 }] : []; });
    const res = has.filter((m) => m.resolved).flatMap((m) => { const v = refs.map((r) => r.get(m)).filter((x): x is number => x !== null); return v.length ? [(Math.min(...v) - instantOf(m.flat[field])!) / 3_600_000] : []; });
    out.push({ sport: sp, class: cls, events: evs.length, withField: has.length, distinctClocks: clock.size, topClock: top?.[0] ?? null, topClockShare: top ? round(top[1] / has.length, 3) : null,
      startMinusCreationHours: cre.length ? { p10: round(quantile(cre.map((x) => x.gap), 0.1)), p50: round(quantile(cre.map((x) => x.gap), 0.5)), p90: round(quantile(cre.map((x) => x.gap), 0.9)) } : null,
      withinHourOfCreationShare: cre.length ? round(cre.filter((x) => Math.abs(x.gap) <= 1).length / cre.length, 3) : null,
      resolutionMinusStartHours: res.length ? { n: res.length, p10: round(quantile(res, 0.1)), p50: round(quantile(res, 0.5)), p90: round(quantile(res, 0.9)), within24hShare: round(res.filter((h) => h > 0 && h <= 24).length / res.length, 3) } : null });
  }
  return out;
}
/**
 * Per sport: can `gameStartTime` be trusted only for single-game market types? A rule, stated so it can be argued with:
 *  - INSUFFICIENT_DATA when either class has fewer than 30 events carrying the field;
 *  - SINGLE_GAME_ONLY when the single-game class looks like a start (median resolution − start within 24 h) and the futures class does not
 *    (median resolution − start above 24 h, or more than half of the futures events have a value within an hour of creation);
 *  - NO_DIFFERENCE_OBSERVED otherwise.
 */
export function futuresVerdicts(rows: FuturesRow[]): FuturesVerdict[] {
  const R = FUTURES_RULE; const out: FuturesVerdict[] = [];
  for (const sp of [...new Set(rows.map((r) => r.sport))].sort()) {
    const sg = rows.find((r) => r.sport === sp && r.class === "single_game"), fu = rows.find((r) => r.sport === sp && r.class === "futures");
    if (!sg || !fu || sg.withField < R.minEventsPerClass || fu.withField < R.minEventsPerClass) { out.push({ sport: sp, verdict: "INSUFFICIENT_DATA", rule: `needs ≥ ${R.minEventsPerClass} events with the field in both classes (single-game ${sg?.withField ?? 0}, futures ${fu?.withField ?? 0})` }); continue; }
    const sgOk = sg.resolutionMinusStartHours !== null && sg.resolutionMinusStartHours.p50 !== null && sg.resolutionMinusStartHours.p50 <= R.maxMedianResolutionGapHoursSingleGame && sg.resolutionMinusStartHours.p50 > 0;
    const fuBad = (fu.resolutionMinusStartHours?.p50 ?? 0) > R.maxMedianResolutionGapHoursSingleGame || (fu.withinHourOfCreationShare ?? 0) > R.listingTimeShare;
    out.push(sgOk && fuBad ? { sport: sp, verdict: "SINGLE_GAME_ONLY", rule: `single-game median resolution−start ${sg.resolutionMinusStartHours!.p50} h ≤ ${R.maxMedianResolutionGapHoursSingleGame} h; futures median ${fu.resolutionMinusStartHours?.p50 ?? "n/m"} h, ${((fu.withinHourOfCreationShare ?? 0) * 100).toFixed(0)} % within an hour of creation` } : { sport: sp, verdict: "NO_DIFFERENCE_OBSERVED", rule: `single-game median ${sg.resolutionMinusStartHours?.p50 ?? "n/m"} h; futures median ${fu.resolutionMinusStartHours?.p50 ?? "n/m"} h, ${((fu.withinHourOfCreationShare ?? 0) * 100).toFixed(0)} % within an hour of creation` });
  }
  return out;
}

// ───────────────────────────────────────────── the same event on both venues ────────────────────────────

export interface EventSide { key: string; title: string | null; stratum: string; startMs: number | null; etDate: string | null }
export interface EventPair { stratum: string; aTitle: string | null; bTitle: string | null; participantSimilarity: number; aMs: number; bMs: number; dateDiffDays: number }
export interface EventAgreement { eventsA: number; eventsB: number; withStartA: number; withStartB: number; headToHeadA: number; headToHeadB: number; matched: number; ambiguous: number; withBothStarts: number; pairs: EventPair[]; summary: VenueDiffSummary[]; overall: VenueDiffSummary | null; fieldsUsed: { a: string | null; b: string | null } }

/** Start-time field for event matching: `gameStartTime`, else an event-level `startTime`, else `eventStartTime`; never `startDate` (a listing time). */
export function startFieldFor(inv: FieldInventory[]): string | null { return findField(inv, "gameStartTime") ?? findEventStartTime(inv) ?? findField(inv, "eventStartTime"); }

const eventSides = (ms: AuditMarket[], titleOf: (m: AuditMarket) => string | null, field: string | null): EventSide[] => collapseToEvents(ms).map((m) => { const t = field ? instantOf(m.flat[field]) : null; return { key: m.group, title: titleOf(m), stratum: m.stratum, startMs: t, etDate: t === null ? null : easternParts(t).date }; });
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000;
/**
 * Match the same event on two venues by participant names (both sides, either home/away order, similarity ≥ `minSimilarity`) and
 * Eastern date (within `maxDays`); compare the start times of the matched pairs. A tie between two equally good candidates is
 * `ambiguous` and skipped (never an arbitrary pick). Events without both start times are matched but not compared.
 */
export function matchEventsAcrossVenues(a: { ms: AuditMarket[]; inv: FieldInventory[]; titleOf: (m: AuditMarket) => string | null }, b: { ms: AuditMarket[]; inv: FieldInventory[]; titleOf: (m: AuditMarket) => string | null }, opt: { minSimilarity?: number; maxDays?: number } = {}): EventAgreement {
  const minSim = opt.minSimilarity ?? 0.8, maxDays = opt.maxDays ?? 1; const fa = startFieldFor(a.inv), fb = startFieldFor(b.inv);
  const A = eventSides(a.ms, a.titleOf, fa), B = eventSides(b.ms, b.titleOf, fb);
  const h2h = (e: EventSide) => participantsOf(e.title) !== null; const pairs: EventPair[] = []; let matched = 0, ambiguous = 0;
  for (const ea of A) {
    if (!h2h(ea)) continue; const cands = B.filter(h2h).map((eb) => ({ eb, sim: participantSimilarity(ea.title, eb.title) })).filter((c) => c.sim >= minSim).filter((c) => ea.etDate === null || c.eb.etDate === null || dayDiff(ea.etDate, c.eb.etDate) <= maxDays);
    if (!cands.length) continue; const best = Math.max(...cands.map((c) => c.sim)); const top = cands.filter((c) => c.sim === best);
    if (top.length > 1) { ambiguous++; continue; }
    matched++; const eb = top[0].eb; if (ea.startMs !== null && eb.startMs !== null) pairs.push({ stratum: ea.stratum, aTitle: ea.title, bTitle: eb.title, participantSimilarity: round(best, 3)!, aMs: ea.startMs, bMs: eb.startMs, dateDiffDays: ea.etDate && eb.etDate ? dayDiff(ea.etDate, eb.etDate) : NaN });
  }
  const sum = compareVenues(pairs.map((p) => ({ stratum: p.stratum, aMs: p.aMs, bMs: p.bMs }))); const all = compareVenues(pairs.map((p) => ({ stratum: "ALL", aMs: p.aMs, bMs: p.bMs })))[0] ?? null;
  return { eventsA: A.length, eventsB: B.length, withStartA: A.filter((e) => e.startMs !== null).length, withStartB: B.filter((e) => e.startMs !== null).length, headToHeadA: A.filter(h2h).length, headToHeadB: B.filter(h2h).length, matched, ambiguous, withBothStarts: pairs.length, pairs: pairs.slice(0, 200), summary: sum, overall: all, fieldsUsed: { a: fa, b: fb } };
}
