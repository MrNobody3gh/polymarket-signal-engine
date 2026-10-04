/**
 * Phase 4.0 (S1a) — analysis of the time fields found on venue market objects (docs/PHASE4_PLAN.md §7 S1a, §3.3).
 * Pure: it takes already-fetched market objects and returns plain JSON. It decides nothing about trading; it produces
 * the evidence from which the owner fills §3.3's two slots with concrete field names or marks them unusable.
 *
 * Method, in one paragraph: flatten every market (and nested event) object to dotted paths; a path is "time-like" when
 * its value looks like a date or datetime (or a plausible epoch number under a time-like name); for every such path
 * inventory the format, precision, offset, presence by stratum and placeholder shapes; then, per stratum, measure how
 * each candidate field is ordered against the other fields and against the venue's own resolution/closure timestamps
 * (and ours), and apply the explicit, exported RECOMMEND_RULES to propose a field per slot or "unreliable: reject".
 */
import { categorize, stratum } from "./categorize";
import { classifyFieldName, classifyFieldNameFor, easternParts, easternPlaceholder, impliedEasternDate, parseTimestamp, placeholderKind, repeatedInstants, timeOfDayProfile, type FieldRole, type PlaceholderKind, type RepeatedInstant } from "./timestamps";
import { quantile } from "./stats";

export type RawMarket = Record<string, unknown>;
export interface AuditMarket {
  venue: string; id: string;
  /** Stratum label: `sports:basketball`, `esports`, `crypto_short_term`, `politics`, `culture_other`, … */
  stratum: string;
  /** Closed / resolved on the venue (the caller decides from the venue's own status fields). */
  resolved: boolean;
  /** Event or title family: markets of one event legitimately share times. */
  group: string;
  flat: Record<string, unknown>;
  /** Our own observed on-chain resolution time (UTC ms) when known (international venue, via token_resolutions). */
  ourResolutionMs?: number | null;
}

// ───────────────────────────────────────────── flattening ─────────────────────────────────────────────────

/** Dotted paths to scalar leaves. Arrays of objects contribute their FIRST element under `path[]`; scalar arrays are skipped. Depth and size bounded. */
export function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  if (depth > 4 || obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) { const first = obj.find((x) => x && typeof x === "object" && !Array.isArray(x)); if (first) flatten(first, `${prefix}[]`, out, depth + 1); return out; }
  if (typeof obj === "object") { for (const [k, v] of Object.entries(obj as Record<string, unknown>)) { const p = prefix ? `${prefix}.${k}` : k; if (v !== null && typeof v === "object") flatten(v, p, out, depth + 1); else out[p] = v; } return out; }
  out[prefix] = obj; return out;
}

const DATEISH = /^\d{4}-\d{2}-\d{2}/;
/** A path/value pair is time-like if the value starts like a date, or is a plausible epoch number under a name that is not a plain non-time name. */
export function isTimeLike(path: string, value: unknown): boolean {
  if (typeof value === "string") return DATEISH.test(value.trim());
  if (typeof value === "number") { const role = classifyFieldName(path); return role !== "NOT_TIME" && parseTimestamp(value).kind === "epoch"; }
  return false;
}

export type FormatLabel = "date_only" | "datetime_utc" | "datetime_offset" | "datetime_lenient" | "datetime_no_offset" | "epoch_s" | "epoch_ms" | "invalid";
export function formatOf(raw: unknown): FormatLabel {
  const p = parseTimestamp(raw);
  switch (p.kind) {
    case "date_only": return "date_only"; case "no_offset": return "datetime_no_offset"; case "invalid": case "missing": return "invalid";
    case "epoch": return p.unit === "s" ? "epoch_s" : "epoch_ms";
    case "datetime": return p.format === "lenient" ? "datetime_lenient" : p.offsetMinutes === 0 ? "datetime_utc" : "datetime_offset";
  }
}
/** The instant of a value when it carries a time of day and a zone (datetime or epoch); null for date-only, offset-less and invalid values. */
export function instantOf(raw: unknown): number | null { const p = parseTimestamp(raw); return p.kind === "datetime" || p.kind === "epoch" ? p.ms : null; }

// ───────────────────────────────────────────── inventory ──────────────────────────────────────────────────

export interface StratumPresence { present: number; total: number; rate: number }
export interface FieldInventory {
  path: string; role: FieldRole;
  presence: { overall: StratumPresence; byStratum: Record<string, StratumPresence> };
  formats: Partial<Record<FormatLabel, number>>;
  precision: { minute: number; second: number; fraction: number };
  offsets: Record<string, number>;
  placeholders: Partial<Record<PlaceholderKind, number>>;
  /** Share of present values (any format) that are a placeholder shape (date-only, midnight, noon or end-of-day) */
  placeholderShare: number;
  timeOfDay: { datetime: number; dateOnly: number; topClocks: { clock: string; count: number; share: number }[] };
  repeated: RepeatedInstant[];
  examples: string[];
}

const share = (a: number, b: number) => (b ? a / b : 0);
export function buildInventory(markets: AuditMarket[]): FieldInventory[] {
  const totals = new Map<string, number>(); for (const m of markets) totals.set(m.stratum, (totals.get(m.stratum) ?? 0) + 1);
  const paths = new Map<string, { m: AuditMarket; v: unknown }[]>();
  for (const m of markets) for (const [p, v] of Object.entries(m.flat)) if (isTimeLike(p, v)) { const a = paths.get(p); if (a) a.push({ m, v }); else paths.set(p, [{ m, v }]); }
  const out: FieldInventory[] = [];
  for (const [path, rows] of [...paths.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const bySt: Record<string, number> = {}; for (const r of rows) bySt[r.m.stratum] = (bySt[r.m.stratum] ?? 0) + 1;
    const byStratum: Record<string, StratumPresence> = {}; for (const [st, tot] of [...totals.entries()].sort()) byStratum[st] = { present: bySt[st] ?? 0, total: tot, rate: share(bySt[st] ?? 0, tot) };
    const formats: FieldInventory["formats"] = {}; const precision = { minute: 0, second: 0, fraction: 0 }; const offsets: Record<string, number> = {}; const placeholders: FieldInventory["placeholders"] = {};
    let ph = 0;
    for (const { v } of rows) {
      const f = formatOf(v); formats[f] = (formats[f] ?? 0) + 1;
      const p = parseTimestamp(v);
      if (p.kind === "datetime") { precision[p.precision]++; const o = p.offsetMinutes; const key = o === 0 ? "+00:00" : `${o < 0 ? "-" : "+"}${String(Math.floor(Math.abs(o) / 60)).padStart(2, "0")}:${String(Math.abs(o) % 60).padStart(2, "0")}`; offsets[key] = (offsets[key] ?? 0) + 1; }
      const k = placeholderKind(v); if (k) { placeholders[k] = (placeholders[k] ?? 0) + 1; ph++; }
    }
    const prof = timeOfDayProfile(rows.map((r) => r.v));
    out.push({
      path, role: classifyFieldNameFor(markets[0]?.venue, path), presence: { overall: { present: rows.length, total: markets.length, rate: share(rows.length, markets.length) }, byStratum },
      formats, precision, offsets, placeholders, placeholderShare: share(ph, rows.length),
      timeOfDay: { datetime: prof.datetime, dateOnly: prof.dateOnly, topClocks: prof.byClock.slice(0, 5) },
      repeated: repeatedInstants(rows.map((r) => ({ group: r.m.group, raw: r.v }))).slice(0, 10),
      examples: [...new Set(rows.slice(0, 40).map((r) => String(r.v)))].slice(0, 3),
    });
  }
  return out;
}

// ───────────────────────────────────────────── relations between fields ───────────────────────────────────

export interface Relation { n: number; before: number; equal: number; after: number; p10Min: number | null; p50Min: number | null; p90Min: number | null; within1hShare: number | null }
/** Signed difference B − A in minutes over the markets where BOTH are instants. `before` = A is earlier than B. */
export function relation(pairs: { a: number; b: number }[]): Relation {
  const d = pairs.map((p) => (p.b - p.a) / 60_000);
  const q = (p: number) => { const x = quantile(d, p); return x === null ? null : Math.round(x * 10) / 10; };
  return { n: d.length, before: d.filter((x) => x > 0).length, equal: d.filter((x) => x === 0).length, after: d.filter((x) => x < 0).length, p10Min: q(0.1), p50Min: q(0.5), p90Min: q(0.9), within1hShare: d.length ? d.filter((x) => Math.abs(x) <= 60).length / d.length : null };
}
const pairsOf = (ms: AuditMarket[], a: string, b: string) => ms.flatMap((m) => { const x = instantOf(m.flat[a]), y = instantOf(m.flat[b]); return x !== null && y !== null ? [{ a: x, b: y }] : []; });

export interface ResolutionReference { name: string; get: (m: AuditMarket) => number | null }
/** The references a candidate is compared with for RESOLVED markets: every RESOLUTION_LIKE field the venue provides, and our observed resolution time when known. */
export function resolutionReferences(inv: FieldInventory[]): ResolutionReference[] {
  const refs: ResolutionReference[] = inv.filter((f) => f.role === "RESOLUTION_LIKE").map((f) => ({ name: f.path, get: (m: AuditMarket) => instantOf(m.flat[f.path]) }));
  refs.push({ name: "ours:token_resolutions.resolved_ts", get: (m) => m.ourResolutionMs ?? null });
  return refs;
}

export interface CandidateEvidence {
  path: string; role: FieldRole;
  /** Candidate versus each reference: candidate earlier than the reference ⇒ `before`. Resolved markets only. */
  vsReference: Record<string, Relation>;
  /** Candidate versus every other candidate field (ordering, disagreement), all markets of the stratum. */
  vsField: Record<string, Relation>;
}
export function candidateEvidence(ms: AuditMarket[], inv: FieldInventory[]): CandidateEvidence[] {
  const resolved = ms.filter((m) => m.resolved); const refs = resolutionReferences(inv);
  const cands = inv.filter((f) => f.role === "START_LIKE" || f.role === "CLOSE_LIKE" || f.role === "OTHER_TIME");
  return cands.map((c) => {
    const vsReference: Record<string, Relation> = {}; for (const r of refs) { const pairs = resolved.flatMap((m) => { const x = instantOf(m.flat[c.path]), y = r.get(m); return x !== null && y !== null ? [{ a: x, b: y }] : []; }); if (pairs.length) vsReference[r.name] = relation(pairs); }
    const vsField: Record<string, Relation> = {}; for (const o of cands) { if (o.path === c.path) continue; const pairs = pairsOf(ms, c.path, o.path); if (pairs.length) vsField[o.path] = relation(pairs); }
    return { path: c.path, role: c.role, vsReference, vsField };
  });
}

// ───────────────────────────────────────────── recommendation rules ───────────────────────────────────────

/**
 * PROPOSED thresholds (not decisions): the owner may change them, the output prints them next to every verdict.
 * A field is recommended for a slot only when ALL of its rules hold in a stratum; otherwise "unreliable: reject"
 * (enough data, a rule failed) or "insufficient data" (fewer than `minPresent` markets carry it).
 */
export const RECOMMEND_RULES = {
  minPresent: 30,               // DISTINCT EVENTS (not markets) carrying the field, and distinct resolved events for the ordering evidence (step 4.0b)
  minUsableShare: 0.9,          // share of the stratum's markets with a datetime (time of day and zone) that is not a placeholder shape
  maxPlaceholderShare: 0.1,     // share of present values that are date-only / 00:00:00 / 12:00:00 / 23:59:59 UTC
  maxTopClockShare: 0.5,        // no single UTC time of day may hold more than this share of the values (a hidden placeholder)
  minOrderedShare: 0.99,        // slot 1: start ≤ the earliest reference (resolution/closure) in at least this share of resolved markets
  minOrderedSamples: 30,
  startToleranceVsCloseMin: 15, // slot 1: start ≤ close + tolerance in at least minStartBeforeCloseShare of markets with both
  minStartBeforeCloseShare: 0.95,
  maxCreationCoincidenceShare: 0.5, // slot 1: the field must not coincide (within `creationCoincidenceMin` minutes) with a creation-like field in more than this share of markets: that is a listing time, not an event start
  creationCoincidenceMin: 60,
  eventTypeMaxMedianGapHours: 24, // slot 1, event-type strata (sports, esports, short-term crypto): the median distance from start to resolution is at most this (events last hours)
} as const;
const EVENT_TYPE = (st: string) => st.startsWith("sports") || st === "esports" || st === "crypto_short_term";

export type Verdict = "RECOMMEND" | "UNRELIABLE_REJECT" | "INSUFFICIENT_DATA";
/** The rule that decided a verdict (the first that failed, in this order), or `allPassed`. */
export type RuleKey = "noField" | "minEvents" | "usableShare" | "placeholderShare" | "topClock" | "orderedShare" | "creationCoincidence" | "eventTypeGap" | "startBeforeClose" | "evidenceGap" | "allPassed";
export interface SlotVerdict {
  slot: 1 | 2; stratum: string; venue: string; field: string | null; verdict: Verdict;
  /** Shares are over DISTINCT EVENTS of the stratum (one representative market per event). */
  usableShare: number | null; presentShare: number | null; placeholderShare: number | null;
  failed: string[]; evidence: Record<string, number | string | null>; needsHumanReview: boolean;
  /** Evidence counts on every row: distinct events and markets in the stratum. */
  events: number; markets: number;
  /** Share of present event values that are an Eastern-time date placeholder (00:00 / 23:59 America/New_York). */
  etPlaceholderShare: number | null;
  /** Which rule decided the verdict, and every rule that failed. */
  decidedBy: RuleKey; failedRules: RuleKey[];
  /** EVERY candidate field judged for this slot (4.0c), each with its own verdict and deciding rule; the best passing one first. `field` above keeps the single field the older reports printed. */
  candidates?: CandidateVerdict[];
  /** The best PASSING candidate (RECOMMEND), or null when none passes. This, not `field`, is the answer to "which field fills the slot". */
  bestField?: string | null;
}
/** One candidate field's verdict for one slot of one stratum (the same rules, thresholds and per-event evaluation as `SlotVerdict`). */
export interface CandidateVerdict {
  field: string; role: FieldRole; verdict: Verdict; decidedBy: RuleKey; failedRules: RuleKey[]; failed: string[];
  presentEvents: number; usableShare: number | null; presentShare: number | null; placeholderShare: number | null; etPlaceholderShare: number | null;
  evidence: Record<string, number | string | null>; best: boolean;
}

const RANK: Record<Verdict, number> = { RECOMMEND: 0, INSUFFICIENT_DATA: 1, UNRELIABLE_REJECT: 2 };
const earliestRefMs = (m: AuditMarket, refs: ResolutionReference[]): number | null => { const v = refs.map((r) => r.get(m)).filter((x): x is number => x !== null); return v.length ? Math.min(...v) : null; };

/**
 * One representative market per distinct event (the first in input order). Markets of one event (moneyline, spread, totals,
 * props) share their event's times, so counting them as separate observations would let a few events pass for many and make
 * a genuine kick-off time look like a placeholder. Every reliability rule below is evaluated on these representatives.
 */
export function collapseToEvents(ms: AuditMarket[]): AuditMarket[] {
  const seen = new Map<string, AuditMarket>(); for (const m of ms) if (!seen.has(m.group)) seen.set(m.group, m);
  return [...seen.values()];
}

/** The best candidate per slot per stratum, with every rule's outcome, evaluated per distinct event. */
export function recommendSlots(venue: string, ms: AuditMarket[], inv: FieldInventory[], rules: Partial<Record<keyof typeof RECOMMEND_RULES, number>> = {}): SlotVerdict[] {
  const R = { ...RECOMMEND_RULES, ...rules } as Record<keyof typeof RECOMMEND_RULES, number>; const refs = resolutionReferences(inv); const out: SlotVerdict[] = [];
  for (const st of [...new Set(ms.map((m) => m.stratum))].sort()) {
    const allMarkets = ms.filter((m) => m.stratum === st); const sm = collapseToEvents(allMarkets); const counts = { events: sm.length, markets: allMarkets.length };
    for (const slot of [1, 2] as const) {
      const role: FieldRole = slot === 1 ? "START_LIKE" : "CLOSE_LIKE";
      // slot 1 also judges neutrally named time fields (OTHER_TIME, e.g. an event's `strike_date`): they pass only by the same rules, none is assumed
      const cands = inv.filter((f) => f.role === role || (slot === 1 && f.role === "OTHER_TIME"));
      if (!cands.length) { out.push({ venue, stratum: st, slot, field: null, verdict: "UNRELIABLE_REJECT", usableShare: null, presentShare: null, placeholderShare: null, failed: [`no ${role} field exists on the venue's objects`], evidence: {}, needsHumanReview: false, ...counts, etPlaceholderShare: null, decidedBy: "noField", failedRules: ["noField"], candidates: [], bestField: null }); continue; }
      const scored = cands.map((f) => {
        const vals = sm.map((m) => m.flat[f.path]).filter((v) => v !== undefined && v !== null && v !== "");
        const usable = vals.filter((v) => { const p = parseTimestamp(v); return (p.kind === "datetime") && !placeholderKind(v); }).length;
        const phs = vals.filter((v) => placeholderKind(v) !== null).length; const prof = timeOfDayProfile(vals);
        const et = vals.filter((v) => easternPlaceholder(v) !== null).length;
        const topClock = prof.byClock[0]?.share ?? 0;
        const failed: string[] = []; const failedRules: RuleKey[] = []; let gap: string | null = null;
        const fail = (key: RuleKey, msg: string) => { failed.push(msg); failedRules.push(key); };
        const evidence: SlotVerdict["evidence"] = { presentEvents: vals.length, stratumEvents: sm.length, stratumMarkets: allMarkets.length, topClock: prof.byClock[0]?.clock ?? null, topClockShare: Math.round(topClock * 1000) / 1000, lenientFormatShare: Math.round(share(vals.filter((v) => formatOf(v) === "datetime_lenient").length, vals.length) * 1000) / 1000, etPlaceholderEvents: et, etPlaceholderShare: Math.round(share(et, vals.length) * 1000) / 1000 };
        const base = { f, usable, vals, phs, evidence, et };
        if (vals.length < R.minPresent) return { ...base, failed: [`present on ${vals.length} < ${R.minPresent} distinct events`], failedRules: ["minEvents"] as RuleKey[], insufficient: true };
        if (share(usable, sm.length) < R.minUsableShare) fail("usableShare", `usable share ${(share(usable, sm.length) * 100).toFixed(1)} % < ${R.minUsableShare * 100} % of events`);
        if (share(phs, vals.length) > R.maxPlaceholderShare) fail("placeholderShare", `placeholder share ${(share(phs, vals.length) * 100).toFixed(1)} % > ${R.maxPlaceholderShare * 100} % of events`);
        if (topClock > R.maxTopClockShare && vals.length >= R.minPresent) fail("topClock", `one time of day (${prof.byClock[0]?.clock}) holds ${(topClock * 100).toFixed(0)} % of events > ${R.maxTopClockShare * 100} %`);
        if (slot === 1) {
          const resolved = sm.filter((m) => m.resolved);
          const ord = resolved.flatMap((m) => { const a = instantOf(m.flat[f.path]), r = earliestRefMs(m, refs); return a !== null && r !== null ? [{ a, r }] : []; });
          if (ord.length >= R.minOrderedSamples) { const okShare = share(ord.filter((x) => x.a <= x.r).length, ord.length); evidence.startNotAfterResolutionShare = Math.round(okShare * 1000) / 1000; evidence.orderedEvents = ord.length; if (okShare < R.minOrderedShare) fail("orderedShare", `start ≤ resolution in ${(okShare * 100).toFixed(1)} % < ${R.minOrderedShare * 100} % of ${ord.length} resolved events`); if (EVENT_TYPE(st)) { const gaps = ord.map((x) => (x.r - x.a) / 3_600_000); const med = quantile(gaps, 0.5)!; evidence.medianStartToResolutionHours = Math.round(med * 10) / 10; if (med > R.eventTypeMaxMedianGapHours) fail("eventTypeGap", `median start→resolution ${med.toFixed(1)} h > ${R.eventTypeMaxMedianGapHours} h: looks like a listing time, not an event start`); } }
          else { evidence.orderedEvents = ord.length; gap = `only ${ord.length} resolved events with a reference time (< ${R.minOrderedSamples}): meaning not established`; }
          // a start-like field that coincides with a creation-like field is a listing time
          let coincide = 0; for (const cf of inv.filter((x) => x.role === "CREATION_LIKE")) { const prs = pairsOf(sm, f.path, cf.path); if (prs.length >= R.minPresent) coincide = Math.max(coincide, share(prs.filter((x) => Math.abs(x.b - x.a) <= R.creationCoincidenceMin * 60_000).length, prs.length)); }
          evidence.coincidesWithCreationShare = Math.round(coincide * 1000) / 1000;
          if (coincide > R.maxCreationCoincidenceShare) fail("creationCoincidence", `${(coincide * 100).toFixed(0)} % of events have a value within ${R.creationCoincidenceMin} min of a creation-like field: a listing time, not an event start`);
          // compare with close-like fields only where THAT field carries a real time of day: a placeholder close (midnight of the event date) would precede almost every kick-off
          for (const c2 of inv.filter((x) => x.role === "CLOSE_LIKE")) { const prs = sm.flatMap((m) => { const a = instantOf(m.flat[f.path]), b = instantOf(m.flat[c2.path]); return a !== null && b !== null && !placeholderKind(m.flat[c2.path]) ? [{ a, b }] : []; }); if (prs.length >= R.minPresent) { const okc = share(prs.filter((x) => x.a <= x.b + R.startToleranceVsCloseMin * 60_000).length, prs.length); evidence[`startNotAfter(${c2.path})`] = Math.round(okc * 1000) / 1000; if (okc < R.minStartBeforeCloseShare) fail("startBeforeClose", `start ≤ ${c2.path} (+${R.startToleranceVsCloseMin} min) in ${(okc * 100).toFixed(1)} % < ${R.minStartBeforeCloseShare * 100} % of events`); } }
        }
        if (!failed.length && gap) return { ...base, failed: [gap], failedRules: ["evidenceGap"] as RuleKey[], insufficient: true };
        return { ...base, failed, failedRules, insufficient: false };
      });
      const ok = scored.filter((s) => !s.insufficient && !s.failed.length).sort((a, b) => b.usable - a.usable || (a.f.path < b.f.path ? -1 : 1));
      const pick = ok[0] ?? [...scored].sort((a, b) => Number(a.insufficient) - Number(b.insufficient) || a.failed.length - b.failed.length || b.usable - a.usable || (a.f.path < b.f.path ? -1 : 1))[0];
      const verdict: Verdict = ok[0] ? "RECOMMEND" : pick.insufficient ? "INSUFFICIENT_DATA" : "UNRELIABLE_REJECT";
      const rd = (x: number) => Math.round(x * 1000) / 1000;
      const candidates: CandidateVerdict[] = scored.map((c) => { const passed = !c.insufficient && !c.failed.length; return { field: c.f.path, role: c.f.role, verdict: (passed ? "RECOMMEND" : c.insufficient ? "INSUFFICIENT_DATA" : "UNRELIABLE_REJECT") as Verdict, decidedBy: c.failedRules[0] ?? "allPassed", failedRules: c.failedRules, failed: c.failed, presentEvents: c.vals.length, usableShare: rd(share(c.usable, sm.length)), presentShare: rd(share(c.vals.length, sm.length)), placeholderShare: c.vals.length ? rd(share(c.phs, c.vals.length)) : null, etPlaceholderShare: c.vals.length ? rd(share(c.et, c.vals.length)) : null, evidence: c.evidence, best: ok[0] === c }; })
        .sort((a, b) => Number(b.best) - Number(a.best) || (RANK[a.verdict] - RANK[b.verdict]) || b.presentEvents - a.presentEvents || (a.field < b.field ? -1 : 1));
      out.push({ venue, stratum: st, slot, field: pick.f.path, verdict, usableShare: Math.round(share(pick.usable, sm.length) * 1000) / 1000, presentShare: Math.round(share(pick.vals.length, sm.length) * 1000) / 1000, placeholderShare: pick.vals.length ? Math.round(share(pick.phs, pick.vals.length) * 1000) / 1000 : null, failed: pick.failed, evidence: pick.evidence,
        // slot 2 has no ordering rule that can be asserted without evidence of what the venue's deadline means: a human reads the relations
        needsHumanReview: slot === 2 && verdict === "RECOMMEND", ...counts, etPlaceholderShare: pick.vals.length ? Math.round(share(pick.et, pick.vals.length) * 1000) / 1000 : null,
        decidedBy: pick.failedRules[0] ?? "allPassed", failedRules: pick.failedRules, candidates, bestField: ok[0]?.f.path ?? null });
    }
  }
  return out;
}

// ───────────────────────────────────────────── the date-level alternative (shown, never recommended) ──────

export interface DateLevelRow {
  venue: string; stratum: string; field: string; events: number;
  /** Events whose value is a date-only value or an Eastern 00:00 / 23:59 placeholder: the event's Eastern calendar date is known, its time is not. */
  withImpliedDate: number; impliedShare: number; etMidnight: number; etEndOfDay: number; dateOnly: number;
  /** Resolved events with a reference time: how often the implied date is not after the resolution's Eastern date, and the median gap in days. */
  orderedChecked: number; impliedDateNotAfterResolutionShare: number | null; medianDaysBeforeResolution: number | null;
  label: "ALTERNATIVE_DATE_LEVEL";
  /** A date cannot say whether an event has started, nor how long before it an order would fill. */
  inPlayCheck: "cannot be evaluated at date level";
  recommended: false;
}
/**
 * "What would a date-level rule pass": for each stratum, the close-like (and start-like) field whose values most often imply an
 * Eastern calendar date, and how many distinct events that covers. A SHOWN ALTERNATIVE, not a recommendation: `recommended` is the literal
 * false and the verdict rules above are untouched.
 */
export function dateLevelRows(venue: string, ms: AuditMarket[], inv: FieldInventory[], minEvents = RECOMMEND_RULES.minPresent): DateLevelRow[] {
  const refs = resolutionReferences(inv); const out: DateLevelRow[] = [];
  for (const st of [...new Set(ms.map((m) => m.stratum))].sort()) {
    const sm = collapseToEvents(ms.filter((m) => m.stratum === st)); let best: DateLevelRow | null = null;
    for (const f of inv.filter((x) => x.role === "CLOSE_LIKE" || x.role === "START_LIKE")) {
      let implied = 0, etM = 0, etE = 0, dOnly = 0; const gaps: number[] = []; let checked = 0, ok = 0;
      for (const m of sm) {
        const v = m.flat[f.path]; if (v === undefined || v === null || v === "") continue; const d = impliedEasternDate(v); if (!d) continue;
        implied++; const e = easternPlaceholder(v); if (e?.kind === "ET_MIDNIGHT") etM++; else if (e?.kind === "ET_END_OF_DAY") etE++; else dOnly++;
        if (m.resolved) { const r = earliestRefMs(m, refs); if (r !== null) { checked++; const rd = easternParts(r).date; if (d <= rd) ok++; gaps.push((Date.parse(rd + "T00:00:00Z") - Date.parse(d + "T00:00:00Z")) / 86_400_000); } }
      }
      if (implied < minEvents) continue;
      const row: DateLevelRow = { venue, stratum: st, field: f.path, events: sm.length, withImpliedDate: implied, impliedShare: Math.round(share(implied, sm.length) * 1000) / 1000, etMidnight: etM, etEndOfDay: etE, dateOnly: dOnly, orderedChecked: checked, impliedDateNotAfterResolutionShare: checked ? Math.round(share(ok, checked) * 1000) / 1000 : null, medianDaysBeforeResolution: gaps.length ? quantile(gaps, 0.5) : null, label: "ALTERNATIVE_DATE_LEVEL", inPlayCheck: "cannot be evaluated at date level", recommended: false };
      if (!best || row.withImpliedDate > best.withImpliedDate || (row.withImpliedDate === best.withImpliedDate && row.field < best.field)) best = row;
    }
    if (best) out.push(best);
  }
  return out;
}

// ───────────────────────────────────────────── venue agreement (D51 input) ────────────────────────────────

export interface VenueDiffSummary { stratum: string; n: number; absP50Min: number | null; absP90Min: number | null; absP95Min: number | null; absP99Min: number | null; maxAbsMin: number | null; within15MinShare: number | null; within60MinShare: number | null; signedP50Min: number | null }
/** Start-time disagreement between the two venues for matched events (UTC ms each), by stratum. Input to D51 (TIMESTAMP_TOLERANCE, proposed 15 min). */
export function compareVenues(pairs: { stratum: string; aMs: number; bMs: number }[]): VenueDiffSummary[] {
  const by = new Map<string, number[]>(); for (const p of pairs) { const a = by.get(p.stratum) ?? []; a.push((p.bMs - p.aMs) / 60_000); by.set(p.stratum, a); }
  const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([st, d]) => { const abs = d.map(Math.abs); return { stratum: st, n: d.length, absP50Min: r1(quantile(abs, 0.5)), absP90Min: r1(quantile(abs, 0.9)), absP95Min: r1(quantile(abs, 0.95)), absP99Min: r1(quantile(abs, 0.99)), maxAbsMin: r1(Math.max(...abs)), within15MinShare: abs.filter((x) => x <= 15).length / abs.length, within60MinShare: abs.filter((x) => x <= 60).length / abs.length, signedP50Min: r1(quantile(d, 0.5)) }; });
}

// ───────────────────────────────────────────── building the sample ────────────────────────────────────────

/** Turn raw venue market objects into AuditMarkets. `isResolved` and `idOf` are venue-specific and supplied by the caller (the audit records which fields it used). */
export function toAuditMarkets(venue: string, raws: RawMarket[], o: { idOf: (m: RawMarket) => string; isResolved: (m: RawMarket) => boolean; titleOf: (m: RawMarket) => string | null; slugOf: (m: RawMarket) => string | null; tagsOf?: (m: RawMarket) => string[]; groupOf?: (m: RawMarket) => string; ourResolutionMs?: (m: RawMarket) => number | null }): AuditMarket[] {
  return raws.map((raw) => {
    const title = o.titleOf(raw), slug = o.slugOf(raw);
    return { venue, id: o.idOf(raw), stratum: stratum(categorize({ title, slug, tags: o.tagsOf?.(raw) })), resolved: o.isResolved(raw), group: o.groupOf?.(raw) ?? (slug ?? title ?? o.idOf(raw)), flat: flatten(raw), ourResolutionMs: o.ourResolutionMs?.(raw) ?? null };
  });
}

/**
 * Round-robin over the strata (in order of first appearance, items in input order): one market from each stratum in turn, at
 * most `perStratum` per stratum, until `total` markets are chosen; then, if the per-stratum cap kept it below `total`, fill
 * from what is left in input order. Never returns more than `total`; deterministic.
 * When items carry a `group` (their event), each stratum offers the FIRST market of every distinct event before any second market
 * of an event, so a quota is spent on as many different events as the listing contains (event-level rules need distinct events).
 */
/**
 * The raws a stratified sample would choose, picked WITHOUT flattening any of them: only the stratum and the event group are computed for each raw, then the
 * same `stratifiedSample` runs on those light records. (Found on the first Kalshi production run: flattening all 40,000 listing markets before sampling
 * 1,200 exhausted a ~500 MB heap. Selection is identical to `stratifiedSample(toAuditMarkets(raws))`.)
 */
export function sampleRaws(raws: RawMarket[], o: { idOf: (m: RawMarket) => string; titleOf: (m: RawMarket) => string | null; slugOf: (m: RawMarket) => string | null; tagsOf?: (m: RawMarket) => string[]; groupOf?: (m: RawMarket) => string }, perStratum: number, total: number): RawMarket[] {
  const light = raws.map((raw, i) => { const title = o.titleOf(raw), slug = o.slugOf(raw); return { i, stratum: stratum(categorize({ title, slug, tags: o.tagsOf?.(raw) })), group: o.groupOf?.(raw) ?? (slug ?? title ?? o.idOf(raw)) }; });
  return stratifiedSample(light, perStratum, total).map((x) => raws[x.i]);
}
export function stratifiedSample<T extends { stratum: string; group?: string }>(items: T[], perStratum: number, total: number): T[] {
  const groups = new Map<string, T[]>(); for (const it of items) { const g = groups.get(it.stratum); if (g) g.push(it); else groups.set(it.stratum, [it]); }
  for (const [k, g] of groups) { if (g.every((x) => x.group === undefined)) continue; const seen = new Set<string>(); const firsts: T[] = [], rest: T[] = []; for (const x of g) { if (!seen.has(x.group ?? "")) { seen.add(x.group ?? ""); firsts.push(x); } else rest.push(x); } groups.set(k, [...firsts, ...rest]); }
  const out: T[] = []; const used = new Set<T>();
  for (let round = 0; round < perStratum && out.length < total; round++) for (const g of groups.values()) { if (out.length >= total) break; if (round < g.length) { out.push(g[round]); used.add(g[round]); } }
  for (const it of items) { if (out.length >= total) break; if (!used.has(it)) { used.add(it); out.push(it); } }
  return out;
}
