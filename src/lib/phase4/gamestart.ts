/**
 * Phase 4.0e — are the US exchange's `gameStartTime` values at 00:00:00 UTC placeholders or real evening starts? READ-ONLY, pure analysis over compact per-event records.
 *
 * The question: the S1a rule that classifies exactly 00:00:00Z as the `MIDNIGHT_UTC` placeholder (a date-only value expanded to midnight UTC) may be rejecting genuine
 * evening starts (00:00Z is 8 pm Eastern while daylight saving time is in force, until 1 Nov 2026, and 7 pm Eastern in winter). Whether it is a placeholder or a start
 * time decides whether the exchange can supply slot 1 for sports. THIS MODULE MEASURES AND PRESENTS OPTIONS; it changes no audit rule, threshold or verdict (decision D68):
 * the what-if is a separate re-computation, labelled, and `baseline` is computed by the same code with no exemption (tests prove it equals `recommendSlots`).
 *
 * EVERY EASTERN CONVERSION USES THE IANA ZONE `America/New_York` PER VALUE (`easternParts`): a fixed UTC−4 or UTC−5 is never assumed.
 *
 * THE EVIDENCE RULES ARE FIXED HERE, BEFORE ANY COUNT WAS LOOKED AT (they are evidence rules for this analysis only):
 *  Part A (the discriminator). US leagues schedule in LOCAL time: a genuine 8 pm Eastern start is 00:00Z while daylight saving time is in force (offset −240 min) and
 *   01:00Z after it ends on 1 Nov 2026 (offset −300); a date-only value expanded to midnight UTC stays 00:00Z on every date. Per sport: B = events with a datetime
 *   start under EDT, A = under EST; b00/b01 = those at exactly 00:00:00Z / 01:00:00Z under EDT, a00/a01 under EST. Verdict, in this order:
 *     INSUFFICIENT_AFTER      A < 10 events (too few events after the transition to conclude);
 *     NO_MIDNIGHT_CLUSTER     b00 < 5;
 *     LOCAL_TIME_SHIFT        a01/A > a00/A and a01/A ≥ 0.5 × b00/B   (the cluster moved by one hour);
 *     FIXED_UTC_PLACEHOLDER   a00/A ≥ 0.5 × b00/B and a00 ≥ a01       (00:00Z persisted after the transition);
 *     UNDETERMINED            otherwise.
 *   The same shift test is applied to any other clock c (c+1 h after the transition).
 *  Part B (per-event classification of an event whose gameStartTime is 00:00:00Z; the same rules label a contrast sample). Three INDEPENDENT pieces of evidence decide:
 *     S  schedule (the sports API event's own start): present with a time of day and |Δ| ≤ 15 min → "agree" (exactly 15 agrees, 16 differs); present with a time of day
 *        and |Δ| > 15 min → "differs"; absent or itself a placeholder → none.
 *     R  resolution timing (resolved events only; gap = earliest resolution-like time − gameStartTime): 1 h ≤ gap ≤ 6 h → "real"; gap < 0 or gap > 24 h → "placeholder";
 *        0 ≤ gap < 1 h or 6 h < gap ≤ 24 h → none.
 *     T  market type: a FUTURES-like market type, or an event outside sports and esports → "placeholder"; otherwise none (a game-type market is necessary, not sufficient).
 *   LIKELY_REAL = (S agree or R real) and no placeholder evidence; LIKELY_PLACEHOLDER = (S differs or R placeholder or T placeholder) and no real evidence;
 *   UNDETERMINED = conflicting or no evidence. Creation time (gameStartTime − created ≤ 1 h) and slate sharing are REPORTED, not decisive.
 *  Part C: see `whatIf` and `startCandidate`.
 */
import { categorize, stratum } from "./categorize";
import { flatten, type RawMarket } from "./audit";
import { RECOMMEND_RULES } from "./audit";
import { marketClassOf } from "./events";
import { quantile } from "./stats";
import { seededRng } from "./diagnose";
import { classifyFieldName, easternParts, parseTimestamp, placeholderKind, timeOfDayProfile } from "./timestamps";
import { tagsOf, usGroupOf, usIdOf, usIsResolved, usTitleOf } from "./venues";

export const DST_TRANSITION_DATE = "2026-11-01";
export const SCHEDULE_TOLERANCE_MIN = 15; export const RES_REAL_MIN_H = 1; export const RES_REAL_MAX_H = 6; export const RES_PLACEHOLDER_MAX_H = 24; export const CREATION_WINDOW_MIN = 60;
export const MIN_AFTER_EVENTS = 10; export const MIN_BEFORE_MIDNIGHT = 5; export const PERSIST_RATIO = 0.5;
export const FLAGGED_CLOCKS = ["00:00:00", "12:00:00", "16:00:00", "23:00:00", "19:30:00", "01:00:00"] as const;
const H = 3_600_000, MIN = 60_000;
export type Period = "EDT" | "EST";
export const periodOf = (ms: number): Period => (easternParts(ms).offsetMinutes === -240 ? "EDT" : "EST");
const utcClock = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const plusHour = (clock: string): string => { const [h, m, s] = clock.split(":"); return `${String((+h + 1) % 24).padStart(2, "0")}:${m}:${s}`; };
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const inst = (v: unknown): number | null => { const p = parseTimestamp(v); return p.kind === "datetime" || p.kind === "epoch" ? p.ms : null; };

// ───────────────────────────────────────────── the compact per-event record ─────────────────────────────────

export interface GsClose { field: string; ms: number | null; placeholder: boolean }
/** One distinct event, taken from its first market (the audit's "one representative market per event"), plus counts over all its markets. About 200 bytes. */
export interface GsEvent {
  id: string; sport: string; category: string; marketType: string; resolved: boolean;
  gsMs: number; createdMs: number | null; resolvedMs: number | null; closes: GsClose[]; scheduleMs: number | null; schedulePlaceholder: boolean;
  markets: number; types: Record<string, number>;
}
export interface GsCounts { markets: number; duplicates: number; noGameStart: number; dateOnly: number; invalid: number; placeholders: Record<string, number>; eventsDropped: number; full: boolean }

/**
 * A STREAMING collector: `add` is called once per market as a page arrives and keeps only the per-event record (≤ `maxEvents`) and a bounded market-id set (≤ `maxMarkets`);
 * the market object is not retained. Nothing here grows with the size of the listing: at the caps `full` is set and the caller stops paging.
 */
export class GsCollector {
  readonly events = new Map<string, GsEvent>(); readonly counts: GsCounts = { markets: 0, duplicates: 0, noGameStart: 0, dateOnly: 0, invalid: 0, placeholders: {}, eventsDropped: 0, full: false };
  private seen = new Set<string>();
  constructor(readonly maxEvents = 12_000, readonly maxMarkets = 40_000) {}
  add(m: RawMarket): void {
    if (this.counts.full) return; const id = usIdOf(m); if (id) { if (this.seen.has(id)) { this.counts.duplicates++; return; } if (this.seen.size >= this.maxMarkets) { this.counts.full = true; return; } this.seen.add(id); }
    this.counts.markets++; const gsRaw = m.gameStartTime; const p = parseTimestamp(gsRaw);
    const ev = m.event && typeof m.event === "object" ? (m.event as RawMarket) : {}; const title = usTitleOf(m) ?? (typeof ev.title === "string" ? ev.title : null);
    const cat = categorize({ title, slug: typeof m.slug === "string" ? m.slug : null, tags: tagsOf(m) }); const type = typeof m.sportsMarketType === "string" && m.sportsMarketType ? m.sportsMarketType.toUpperCase() : "(none)";
    const sched = [ev.gameStartTime, ev.startTime, ev.eventStartTime].find((v) => v !== undefined && v !== null && v !== "");
    if (p.kind === "missing") { this.counts.noGameStart++; return; } if (p.kind === "date_only") { this.counts.dateOnly++; this.counts.placeholders.DATE_ONLY = (this.counts.placeholders.DATE_ONLY ?? 0) + 1; return; } if (p.kind !== "datetime") { this.counts.invalid++; return; }
    const pk = placeholderKind(gsRaw); if (pk) this.counts.placeholders[pk] = (this.counts.placeholders[pk] ?? 0) + 1;
    const eid = usGroupOf(m); const cur = this.events.get(eid);
    if (cur) { cur.markets++; cur.types[type] = (cur.types[type] ?? 0) + 1; if (cur.scheduleMs === null && sched !== undefined) { cur.scheduleMs = inst(sched); cur.schedulePlaceholder = placeholderKind(sched) !== null; } return; }
    if (this.events.size >= this.maxEvents) { this.counts.eventsDropped++; this.counts.full = true; return; }
    const flat = flatten(m); let created: number | null = null, resolved: number | null = null; const closes: GsClose[] = [];
    for (const [k, v] of Object.entries(flat)) { const role = classifyFieldName(k); if (role === "NOT_TIME") continue; const t = inst(v); if (role === "CREATION_LIKE" && t !== null) created = created === null ? t : Math.min(created, t); else if (role === "RESOLUTION_LIKE" && t !== null) resolved = resolved === null ? t : Math.min(resolved, t); else if (role === "CLOSE_LIKE" && closes.length < 3) closes.push({ field: k, ms: t, placeholder: placeholderKind(v) !== null }); }
    this.events.set(eid, { id: eid, sport: stratum(cat), category: cat.category, marketType: type, resolved: usIsResolved(m), gsMs: p.ms, createdMs: created, resolvedMs: resolved, closes, scheduleMs: sched === undefined ? null : inst(sched), schedulePlaceholder: sched !== undefined && placeholderKind(sched) !== null, markets: 1, types: { [type]: 1 } });
  }
}

// ───────────────────────────────────────────── Part A: the daylight-saving discriminator ─────────────────────

export interface ClockCell { clock: string; events: number; markets: number }
export interface SportPeriod { events: number; markets: number; midnightEvents: number; midnightMarkets: number; at0100Events: number; clocks: ClockCell[] }
export type DstVerdict = "INSUFFICIENT_AFTER" | "NO_MIDNIGHT_CLUSTER" | "LOCAL_TIME_SHIFT" | "FIXED_UTC_PLACEHOLDER" | "UNDETERMINED";
export interface SportDst { sport: string; EDT: SportPeriod; EST: SportPeriod; verdict: DstVerdict; why: string }
const sumTypes = (e: GsEvent) => e.markets;

function periodStats(evs: GsEvent[]): SportPeriod {
  const by = new Map<string, { events: number; markets: number }>(); let m00 = 0, mk00 = 0, e01 = 0;
  for (const e of evs) { const c = utcClock(e.gsMs); const x = by.get(c) ?? { events: 0, markets: 0 }; x.events++; x.markets += sumTypes(e); by.set(c, x); if (c === "00:00:00") { m00++; mk00 += sumTypes(e); } if (c === "01:00:00") e01++; }
  const clocks = [...by.entries()].map(([clock, v]) => ({ clock, ...v })).sort((a, b) => b.events - a.events || (a.clock < b.clock ? -1 : 1)).slice(0, 8);
  return { events: evs.length, markets: evs.reduce((a, e) => a + sumTypes(e), 0), midnightEvents: m00, midnightMarkets: mk00, at0100Events: e01, clocks };
}
/** The shift verdict for one sport from its two periods (the rules in the file header). */
export function dstVerdict(b: { events: number; at00: number }, a: { events: number; at00: number; at01: number }): { verdict: DstVerdict; why: string } {
  if (a.events < MIN_AFTER_EVENTS) return { verdict: "INSUFFICIENT_AFTER", why: `only ${a.events} events after the transition (< ${MIN_AFTER_EVENTS}): too few to conclude` };
  if (b.at00 < MIN_BEFORE_MIDNIGHT) return { verdict: "NO_MIDNIGHT_CLUSTER", why: `only ${b.at00} events at 00:00:00Z under EDT (< ${MIN_BEFORE_MIDNIGHT})` };
  const sb = b.at00 / b.events, sa00 = a.at00 / a.events, sa01 = a.at01 / a.events;
  if (sa01 > sa00 && sa01 >= PERSIST_RATIO * sb) return { verdict: "LOCAL_TIME_SHIFT", why: `01:00Z share after ${r3(sa01)} > 00:00Z share after ${r3(sa00)}, and ≥ ${PERSIST_RATIO} × the 00:00Z share before (${r3(sb)})` };
  if (sa00 >= PERSIST_RATIO * sb && a.at00 >= a.at01) return { verdict: "FIXED_UTC_PLACEHOLDER", why: `00:00Z share after ${r3(sa00)} ≥ ${PERSIST_RATIO} × the share before (${r3(sb)}) and not below the 01:00Z count` };
  return { verdict: "UNDETERMINED", why: `00:00Z share before ${r3(sb)}, after ${r3(sa00)}; 01:00Z after ${r3(sa01)}` };
}
export function dstBySport(events: GsEvent[]): SportDst[] {
  const sports = [...new Set(events.map((e) => e.sport))].sort(); const out: SportDst[] = [];
  for (const s of sports) { const mine = events.filter((e) => e.sport === s); const edt = mine.filter((e) => periodOf(e.gsMs) === "EDT"), est = mine.filter((e) => periodOf(e.gsMs) === "EST"); const B = periodStats(edt), A = periodStats(est);
    const v = dstVerdict({ events: B.events, at00: B.midnightEvents }, { events: A.events, at00: A.midnightEvents, at01: A.at0100Events }); out.push({ sport: s, EDT: B, EST: A, ...v }); }
  return out.sort((a, b) => b.EDT.events + b.EST.events - (a.EDT.events + a.EST.events) || (a.sport < b.sport ? -1 : 1));
}
export interface MidnightRow { sport: string; marketType: string; period: Period; events: number; markets: number }
/** Events (and markets) at exactly 00:00:00Z, per sport and market type, before and after the transition. A market type counts an event once per type it has. */
export function midnightByType(events: GsEvent[]): MidnightRow[] {
  const m = new Map<string, MidnightRow>();
  for (const e of events) { if (utcClock(e.gsMs) !== "00:00:00") continue; const per = periodOf(e.gsMs); for (const [t, n] of Object.entries(e.types)) { const k = `${e.sport}|${t}|${per}`; const r = m.get(k) ?? { sport: e.sport, marketType: t, period: per, events: 0, markets: 0 }; r.events++; r.markets += n; m.set(k, r); } }
  return [...m.values()].sort((a, b) => b.events - a.events || (a.sport + a.marketType < b.sport + b.marketType ? -1 : 1));
}
export interface ClockShift { scope: string; clock: string; kind: string; EDTevents: number; ESTevents: number; EDTshare: number | null; ESTshare: number | null; ESTshiftedShare: number | null; verdict: "SHIFTS_WITH_DST" | "FIXED_UTC" | "UNDETERMINED" | "INSUFFICIENT_AFTER" | "TOO_FEW" }
/** Which recurring clocks shift with daylight saving (the clock + 1 h after the transition) and which do not, over all events. */
export function clockShifts(events: GsEvent[], scope = "all"): ClockShift[] {
  const edt = events.filter((e) => periodOf(e.gsMs) === "EDT"), est = events.filter((e) => periodOf(e.gsMs) === "EST"); const cnt = (evs: GsEvent[], c: string) => evs.filter((e) => utcClock(e.gsMs) === c).length;
  const kinds: Record<string, string> = { "00:00:00": "MIDNIGHT_UTC", "12:00:00": "NOON_UTC" };
  const rows: ClockShift[] = FLAGGED_CLOCKS.map((c) => { const b = cnt(edt, c), a = cnt(est, c), a1 = cnt(est, plusHour(c)); const sb = edt.length ? b / edt.length : null, sa = est.length ? a / est.length : null, sa1 = est.length ? a1 / est.length : null;
    let verdict: ClockShift["verdict"] = "UNDETERMINED"; if (est.length < MIN_AFTER_EVENTS) verdict = "INSUFFICIENT_AFTER"; else if (b < MIN_BEFORE_MIDNIGHT) verdict = "TOO_FEW"; else if (sa1! > sa! && sa1! >= PERSIST_RATIO * sb!) verdict = "SHIFTS_WITH_DST"; else if (sa! >= PERSIST_RATIO * sb! && a >= a1) verdict = "FIXED_UTC";
    return { scope, clock: c, kind: kinds[c] ?? "recurring clock", EDTevents: b, ESTevents: a, EDTshare: sb === null ? null : r3(sb), ESTshare: sa === null ? null : r3(sa), ESTshiftedShare: sa1 === null ? null : r3(sa1), verdict }; });
  // Eastern-local flagged shapes: by construction their UTC clock shifts with the offset; counted per period
  const et = (evs: GsEvent[], f: (t: string) => boolean) => evs.filter((e) => f(easternParts(e.gsMs).time)).length;
  for (const [kind, f] of [["ET_MIDNIGHT", (t: string) => t === "00:00:00"], ["ET_END_OF_DAY", (t: string) => t === "23:59:00" || t === "23:59:59"]] as const) rows.push({ scope, clock: `Eastern ${kind === "ET_MIDNIGHT" ? "00:00:00" : "23:59:xx"}`, kind, EDTevents: et(edt, f), ESTevents: et(est, f), EDTshare: edt.length ? r3(et(edt, f) / edt.length) : null, ESTshare: est.length ? r3(et(est, f) / est.length) : null, ESTshiftedShare: null, verdict: "UNDETERMINED" });
  return rows;
}
export const ETA = (ms: number) => easternParts(ms);

// ───────────────────────────────────────────── Part B: per-event corroboration ───────────────────────────────

export type Label = "LIKELY_REAL" | "LIKELY_PLACEHOLDER" | "UNDETERMINED";
export interface Classified { label: Label; rule: string; schedule: "agree" | "differs" | "none"; resolution: "real" | "placeholder" | "none"; type: "placeholder" | "none"; gapH: number | null; scheduleDeltaMin: number | null }
const GAME_CATEGORIES = new Set(["sports", "esports"]);
/** The Part B rules (file header). Boundaries: schedule |Δ| 15 min agrees, 16 differs; resolution gap 1 h and 6 h are real, 0 and 24 h are not decisive, below 0 and above 24 h are placeholder evidence. */
export function classifyEvent(e: GsEvent): Classified {
  let schedule: Classified["schedule"] = "none", delta: number | null = null;
  // a schedule value that has the SAME placeholder shape (for example it is also exactly 00:00:00Z) is not independent evidence: it is no evidence
  if (e.scheduleMs !== null && !e.schedulePlaceholder) { delta = Math.abs(e.gsMs - e.scheduleMs) / MIN; schedule = delta <= SCHEDULE_TOLERANCE_MIN ? "agree" : "differs"; }
  let resolution: Classified["resolution"] = "none", gapH: number | null = null;
  if (e.resolved && e.resolvedMs !== null) { gapH = (e.resolvedMs - e.gsMs) / H; if (gapH >= RES_REAL_MIN_H && gapH <= RES_REAL_MAX_H) resolution = "real"; else if (gapH < 0 || gapH > RES_PLACEHOLDER_MAX_H) resolution = "placeholder"; }
  const type: Classified["type"] = marketClassOf(e.marketType) === "futures" || !GAME_CATEGORIES.has(e.category) ? "placeholder" : "none";
  const real = schedule === "agree" || resolution === "real", ph = schedule === "differs" || resolution === "placeholder" || type === "placeholder";
  const why: string[] = []; if (schedule === "agree") why.push(`schedule agrees (Δ ${r1(delta)} min ≤ ${SCHEDULE_TOLERANCE_MIN})`); if (schedule === "differs") why.push(`schedule differs (Δ ${r1(delta)} min > ${SCHEDULE_TOLERANCE_MIN})`);
  if (resolution === "real") why.push(`resolution ${r1(gapH)} h after the start (${RES_REAL_MIN_H}–${RES_REAL_MAX_H} h)`); if (resolution === "placeholder") why.push(`resolution ${r1(gapH)} h after the start (< 0 or > ${RES_PLACEHOLDER_MAX_H} h)`);
  if (type === "placeholder") why.push(marketClassOf(e.marketType) === "futures" ? `futures-like market type ${e.marketType}` : `category ${e.category} is not a game category`);
  const label: Label = real && !ph ? "LIKELY_REAL" : ph && !real ? "LIKELY_PLACEHOLDER" : "UNDETERMINED";
  return { label, rule: label === "UNDETERMINED" ? (real && ph ? `conflict: ${why.join("; ")}` : "no independent evidence (no usable schedule, no resolution timing, a game-type market)") : why.join("; "), schedule, resolution, type, gapH, scheduleDeltaMin: delta };
}

export interface GroupStats {
  events: number; labels: Record<Label, number>;
  schedule: { present: number; withTimeOfDay: number; agree: number; differs: number; absent: number };
  resolution: { n: number; p10h: number | null; p50h: number | null; p90h: number | null; real: number; placeholder: number; none: number };
  creation: { n: number; within1h: number; p50days: number | null };
}
export function groupStats(evs: GsEvent[]): GroupStats {
  const cl = evs.map((e) => ({ e, c: classifyEvent(e) })); const labels: Record<Label, number> = { LIKELY_REAL: 0, LIKELY_PLACEHOLDER: 0, UNDETERMINED: 0 }; for (const x of cl) labels[x.c.label]++;
  const gaps = cl.filter((x) => x.c.gapH !== null).map((x) => x.c.gapH!); const cre = evs.filter((e) => e.createdMs !== null).map((e) => (e.gsMs - e.createdMs!) / MIN);
  return { events: evs.length, labels, schedule: { present: evs.filter((e) => e.scheduleMs !== null).length, withTimeOfDay: evs.filter((e) => e.scheduleMs !== null && !e.schedulePlaceholder).length, agree: cl.filter((x) => x.c.schedule === "agree").length, differs: cl.filter((x) => x.c.schedule === "differs").length, absent: evs.filter((e) => e.scheduleMs === null).length },
    resolution: { n: gaps.length, p10h: r1(quantile(gaps, 0.1)), p50h: r1(quantile(gaps, 0.5)), p90h: r1(quantile(gaps, 0.9)), real: cl.filter((x) => x.c.resolution === "real").length, placeholder: cl.filter((x) => x.c.resolution === "placeholder").length, none: cl.filter((x) => x.c.gapH !== null && x.c.resolution === "none").length },
    creation: { n: cre.length, within1h: cre.filter((m) => m <= CREATION_WINDOW_MIN).length, p50days: r1(quantile(cre.map((m) => m / 1440), 0.5)) } };
}
export interface Corroboration {
  midnight: { all: GroupStats; bySport: { sport: string; stats: GroupStats }[] }; control: { all: GroupStats; bySport: { sport: string; stats: GroupStats }[]; sampleSize: number; seed: string };
  byMarketType: { marketType: string; events: number; atMidnight: number; share: number | null }[]; byCategory: { category: string; events: number; atMidnight: number; share: number | null }[];
  slate: { sport: string; instantsAt0000: number; maxEventsOnOneInstant: number; instantsSharedBy3Plus: number; categoriesAtMidnightInstants: number }[];
}
/** Midnight group vs a same-size contrast sample at other clock times (seeded, spread over sports). */
export function corroborate(events: GsEvent[], seed = "phase4-0e-control-v1"): Corroboration {
  const mid = events.filter((e) => utcClock(e.gsMs) === "00:00:00"), others = events.filter((e) => utcClock(e.gsMs) !== "00:00:00");
  const rng = seededRng(seed); const bySport = new Map<string, GsEvent[]>(); for (const e of [...others].sort((a, b) => (a.id < b.id ? -1 : 1))) { const a = bySport.get(e.sport); if (a) a.push(e); else bySport.set(e.sport, [e]); }
  for (const a of bySport.values()) for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  const ctl: GsEvent[] = []; const keys = [...bySport.keys()].sort(); for (let round = 0; ctl.length < Math.min(mid.length, others.length); round++) { let any = false; for (const k of keys) { const a = bySport.get(k)!; if (round < a.length && ctl.length < mid.length) { ctl.push(a[round]); any = true; } } if (!any) break; }
  const split = (evs: GsEvent[]) => [...new Set(evs.map((e) => e.sport))].sort().map((sport) => ({ sport, stats: groupStats(evs.filter((e) => e.sport === sport)) }));
  const tally = (key: (e: GsEvent) => string[]) => { const m = new Map<string, { events: number; atMidnight: number }>(); for (const e of events) for (const k of new Set(key(e))) { const x = m.get(k) ?? { events: 0, atMidnight: 0 }; x.events++; if (utcClock(e.gsMs) === "00:00:00") x.atMidnight++; m.set(k, x); } return m; };
  const mt = [...tally((e) => Object.keys(e.types)).entries()].map(([marketType, v]) => ({ marketType, ...v, share: v.events ? r3(v.atMidnight / v.events) : null })).sort((a, b) => b.events - a.events);
  const cat = [...tally((e) => [e.category]).entries()].map(([category, v]) => ({ category, ...v, share: v.events ? r3(v.atMidnight / v.events) : null })).sort((a, b) => b.events - a.events);
  const sports = [...new Set(events.filter((e) => GAME_CATEGORIES.has(e.category)).map((e) => e.sport))].sort(); const instantCats = new Map<number, Set<string>>(); for (const e of mid) { const s = instantCats.get(e.gsMs) ?? new Set(); s.add(e.category); instantCats.set(e.gsMs, s); }
  const slate = sports.map((sport) => { const per = new Map<number, number>(); for (const e of events.filter((x) => x.sport === sport)) per.set(e.gsMs, (per.get(e.gsMs) ?? 0) + 1); const at0 = [...per.entries()].filter(([ms]) => utcClock(ms) === "00:00:00"); return { sport, instantsAt0000: at0.length, maxEventsOnOneInstant: per.size ? Math.max(...per.values()) : 0, instantsSharedBy3Plus: [...per.values()].filter((n) => n >= 3).length, categoriesAtMidnightInstants: new Set(mid.filter((e) => e.sport === sport).flatMap((e) => [...(instantCats.get(e.gsMs) ?? [])])).size }; });
  return { midnight: { all: groupStats(mid), bySport: split(mid) }, control: { all: groupStats(ctl), bySport: split(ctl), sampleSize: ctl.length, seed }, byMarketType: mt, byCategory: cat, slate };
}

// ───────────────────────────────────────────── Part C: the what-if (labelled; never applied) ─────────────────

export type StartVerdict = "RECOMMEND" | "UNRELIABLE_REJECT" | "INSUFFICIENT_DATA";
export interface StartEval { failedKeys: string[]; events: number; present: number; usable: number; usableShare: number | null; placeholderShare: number | null; topClockShare: number | null; ordered: number; orderedShare: number | null; medianGapH: number | null; coincideShare: number | null; failed: string[]; verdict: StartVerdict }
const RULE_KEYS: [RegExp, string][] = [[/^present on/, "minEvents"], [/^usable share/, "usableShare"], [/^placeholder share/, "placeholderShare"], [/^one time of day/, "topClock"], [/^start ≤ resolution/, "orderedShare"], [/^median start/, "eventTypeGap"], [/within \d+ min of a creation/, "creationCoincidence"], [/^start ≤ \S+ \(\+/, "startBeforeClose"], [/^only \d+ resolved events/, "evidenceGap"]];
/** The audit's rule key of a failure message (the rule that decided). */
export const ruleKey = (msg: string): string => RULE_KEYS.find(([re]) => re.test(msg))?.[1] ?? "other";
const EVENT_TYPE = (st: string) => st.startsWith("sports") || st === "esports" || st === "crypto_short_term";
const share = (a: number, b: number) => (b ? a / b : 0);
/**
 * The audit's per-candidate rules for a SLOT-1 candidate, re-implemented over event records (same thresholds `RECOMMEND_RULES`, same order, same arithmetic) so the baseline
 * can be compared with `recommendSlots` (tests/phase4-gamestart.test.ts proves they agree) and a what-if can change ONE thing: `exempt(e)` makes a MIDNIGHT_UTC value of event
 * `e` count as usable and not as a placeholder. `value(e)` is the candidate's value (gameStartTime, or the schedule start for option c). Nothing here touches the real audit.
 */
export function startCandidate(events: GsEvent[], stratumName: string, value: (e: GsEvent) => number | null, exempt: (e: GsEvent) => boolean = () => false): StartEval {
  const R = RECOMMEND_RULES; const vals = events.map((e) => ({ e, v: value(e) })).filter((x): x is { e: GsEvent; v: number } => x.v !== null); const failed: string[] = [];
  const base = (ex: Partial<StartEval>): StartEval => ({ failedKeys: failed.map(ruleKey), events: events.length, present: vals.length, usable: 0, usableShare: null, placeholderShare: null, topClockShare: null, ordered: 0, orderedShare: null, medianGapH: null, coincideShare: null, failed, verdict: "UNRELIABLE_REJECT", ...ex });
  if (vals.length < R.minPresent) { failed.push(`present on ${vals.length} < ${R.minPresent} distinct events`); return base({ verdict: "INSUFFICIENT_DATA" }); }
  const isPh = (x: { e: GsEvent; v: number }) => { const pk = placeholderKind(new Date(x.v).toISOString()); return pk === "MIDNIGHT_UTC" && exempt(x.e) ? null : pk; };
  const usable = vals.filter((x) => isPh(x) === null).length, phs = vals.filter((x) => isPh(x) !== null).length; const prof = timeOfDayProfile(vals.map((x) => new Date(x.v).toISOString())); const topClock = prof.byClock[0]?.share ?? 0; let gap: string | null = null;
  if (share(usable, events.length) < R.minUsableShare) failed.push(`usable share ${(share(usable, events.length) * 100).toFixed(1)} % < ${R.minUsableShare * 100} % of events`);
  if (share(phs, vals.length) > R.maxPlaceholderShare) failed.push(`placeholder share ${(share(phs, vals.length) * 100).toFixed(1)} % > ${R.maxPlaceholderShare * 100} % of events`);
  if (topClock > R.maxTopClockShare && vals.length >= R.minPresent) failed.push(`one time of day (${prof.byClock[0]?.clock}) holds ${(topClock * 100).toFixed(0)} % of events > ${R.maxTopClockShare * 100} %`);
  const ord = vals.filter((x) => x.e.resolved && x.e.resolvedMs !== null).map((x) => ({ a: x.v, r: x.e.resolvedMs! })); let okShare: number | null = null, med: number | null = null;
  if (ord.length >= R.minOrderedSamples) { okShare = share(ord.filter((x) => x.a <= x.r).length, ord.length); if (okShare < R.minOrderedShare) failed.push(`start ≤ resolution in ${(okShare * 100).toFixed(1)} % < ${R.minOrderedShare * 100} % of ${ord.length} resolved events`); if (EVENT_TYPE(stratumName)) { med = quantile(ord.map((x) => (x.r - x.a) / H), 0.5)!; if (med > R.eventTypeMaxMedianGapHours) failed.push(`median start→resolution ${med.toFixed(1)} h > ${R.eventTypeMaxMedianGapHours} h: looks like a listing time, not an event start`); } }
  else gap = `only ${ord.length} resolved events with a reference time (< ${R.minOrderedSamples}): meaning not established`;
  const cre = vals.filter((x) => x.e.createdMs !== null).map((x) => ({ a: x.v, b: x.e.createdMs! })); let coincide: number | null = null;
  if (cre.length >= R.minPresent) { coincide = share(cre.filter((x) => Math.abs(x.b - x.a) <= R.creationCoincidenceMin * MIN).length, cre.length); if (coincide > R.maxCreationCoincidenceShare) failed.push(`${(coincide * 100).toFixed(0)} % of events have a value within ${R.creationCoincidenceMin} min of a creation-like field: a listing time, not an event start`); }
  const closeFields = [...new Set(vals.flatMap((x) => x.e.closes.map((c) => c.field)))]; for (const f of closeFields) { const prs = vals.flatMap((x) => { const c = x.e.closes.find((y) => y.field === f); return c && c.ms !== null && !c.placeholder ? [{ a: x.v, b: c.ms }] : []; }); if (prs.length >= R.minPresent) { const okc = share(prs.filter((x) => x.a <= x.b + R.startToleranceVsCloseMin * MIN).length, prs.length); if (okc < R.minStartBeforeCloseShare) failed.push(`start ≤ ${f} (+${R.startToleranceVsCloseMin} min) in ${(okc * 100).toFixed(1)} % < ${R.minStartBeforeCloseShare * 100} % of events`); } }
  const ev = { usable, usableShare: r3(share(usable, events.length)), placeholderShare: r3(share(phs, vals.length)), topClockShare: r3(topClock), ordered: ord.length, orderedShare: okShare === null ? null : r3(okShare), medianGapH: r1(med), coincideShare: coincide === null ? null : r3(coincide) };
  if (!failed.length && gap) { failed.push(gap); return base({ ...ev, verdict: "INSUFFICIENT_DATA" }); }
  return base({ ...ev, verdict: failed.length ? "UNRELIABLE_REJECT" : "RECOMMEND" });
}
export interface WhatIfRow { stratum: string; events: number; baseline: StartEval; likelyReal: StartEval; scheduleAgrees: StartEval; schedule: StartEval; midnightEvents: number; likelyRealEvents: number; scheduleAgreeEvents: number }
/** Per stratum: the baseline (no exemption), the what-if exempting LIKELY_REAL midnight events, the what-if exempting midnight events the schedule corroborates, and option (c): the schedule start as the candidate. Verdicts of the real audit are NOT changed. */
export function whatIf(events: GsEvent[], minEvents = 30): WhatIfRow[] {
  const strata = [...new Set(events.map((e) => e.sport))].sort(); const cls = new Map(events.map((e) => [e.id, classifyEvent(e)] as const));
  return strata.map((s) => { const evs = events.filter((e) => e.sport === s); const mid = evs.filter((e) => utcClock(e.gsMs) === "00:00:00"); const gs = (e: GsEvent) => e.gsMs;
    return { stratum: s, events: evs.length, baseline: startCandidate(evs, s, gs), likelyReal: startCandidate(evs, s, gs, (e) => cls.get(e.id)!.label === "LIKELY_REAL"), scheduleAgrees: startCandidate(evs, s, gs, (e) => cls.get(e.id)!.schedule === "agree"), schedule: startCandidate(evs, s, (e) => (e.schedulePlaceholder ? null : e.scheduleMs)),
      midnightEvents: mid.length, likelyRealEvents: mid.filter((e) => cls.get(e.id)!.label === "LIKELY_REAL").length, scheduleAgreeEvents: mid.filter((e) => cls.get(e.id)!.schedule === "agree").length }; }).filter((r) => r.events >= minEvents || r.midnightEvents > 0).sort((a, b) => b.events - a.events);
}

// ───────────────────────────────────────────── the result ────────────────────────────────────────────────────

export interface GamestartResult {
  schema: number; kind: "gamestart"; venue: "polymarket_us"; startedAt: string; finishedAt: string; transition: string; counts: GsCounts; events: number; midnightEvents: number;
  fetch: { requests: number; sources: { name: string; markets: number; pages: number; stoppedBecause: string }[]; stoppedBecause: string | null; refused: boolean };
  dst: SportDst[]; midnightByType: MidnightRow[]; clocks: ClockShift[]; corroboration: Corroboration; whatIf: WhatIfRow[];
  eventsAfterTransition: number; eventsBeforeTransition: number; sampleNote: string; heap: { budgetMb: number; peakMb: number } | null; stopped: { reason: string; stage: string; message: string } | null;
}
export function analyse(events: GsEvent[]): Pick<GamestartResult, "dst" | "midnightByType" | "clocks" | "corroboration" | "whatIf" | "eventsAfterTransition" | "eventsBeforeTransition" | "midnightEvents" | "events" | "sampleNote"> {
  const after = events.filter((e) => periodOf(e.gsMs) === "EST").length, before = events.length - after;
  return { events: events.length, midnightEvents: events.filter((e) => utcClock(e.gsMs) === "00:00:00").length, eventsBeforeTransition: before, eventsAfterTransition: after, dst: dstBySport(events), midnightByType: midnightByType(events), clocks: [...clockShifts(events.filter((e) => GAME_CATEGORIES.has(e.category)), "sports and esports"), ...clockShifts(events.filter((e) => !GAME_CATEGORIES.has(e.category)), "other categories")], corroboration: corroborate(events), whatIf: whatIf(events),
    sampleNote: after < MIN_AFTER_EVENTS ? `only ${after} events fall after the ${DST_TRANSITION_DATE} transition (< ${MIN_AFTER_EVENTS}): the discriminator cannot conclude` : `${before} events under EDT and ${after} under EST` };
}
