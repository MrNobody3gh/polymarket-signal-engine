/**
 * Phase 4.0 (S1a) — timestamp parsing, field classification, placeholder detection and the §3.3 / §3.4 rules of
 * docs/PHASE4_PLAN.md. Pure, no I/O, NOT wired into any production path (the live eligibility pipeline is step 4.2).
 *
 * What this file does NOT know: which concrete field name on which venue fills the two hierarchy slots
 * (`event_start_time`, `market_close_time`). That is what the S1a audit measures. Callers pass the field names they
 * have chosen; `classifyFieldName` only refuses names that can never be accepted (resolution / settlement / creation /
 * update times) whatever the audit says.
 */

export const DAY_MS = 86_400_000;
/** §3.3: a valid event time lies between the evaluation time and this far ahead. */
export const MAX_AHEAD_MS = 400 * DAY_MS;
/** §3.6 TIMESTAMP_TOLERANCE, proposed 15 min (D51 is open: the audit's venue-disagreement spread is its input). */
export const TIMESTAMP_TOLERANCE_MS = 15 * 60_000;
/** §3.4 */
export const MAX_HORIZON_MS = 24 * 3_600_000;
/** §3.6 MIN_LEAD, proposed 300 s (calibrated in S2). */
export const MIN_LEAD_MS = 300_000;

// ───────────────────────────────────────────────── parsing ─────────────────────────────────────────────────

export type ParsedTimestamp =
  | { kind: "missing" }
  | { kind: "invalid"; raw: string }
  /** `YYYY-MM-DD` only: no time of day, no zone. */
  | { kind: "date_only"; date: string; ms: number }
  /** A date and time of day without an offset: the instant is unknowable. `ms` is the value read as UTC, for diagnostics only. */
  | { kind: "no_offset"; ms: number }
  /** A number: epoch seconds or milliseconds (the unit is a guess from the magnitude). */
  | { kind: "epoch"; ms: number; unit: "s" | "ms" }
  | {
      kind: "datetime";
      /** The instant, UTC milliseconds. */
      ms: number;
      /** `strict` = RFC 3339 / ISO-8601 with `T` and `Z` or `±HH:MM`/`±HHMM`; `lenient` = a space separator and/or a short `±HH` offset (seen in some Gamma fields). */
      format: "strict" | "lenient";
      offsetMinutes: number;
      precision: "minute" | "second" | "fraction";
      /** The wall-clock time of day as written (before conversion to UTC), `HH:MM:SS`. */
      wallTime: string;
    };

const DT_RE = /^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}

/** Parse any value a venue might put in a time field. Never throws, never guesses a missing offset. */
export function parseTimestamp(raw: unknown): ParsedTimestamp {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return { kind: "missing" };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return { kind: "invalid", raw: String(raw) };
    // seconds (≈ 1.4e9 … 4.1e9) versus milliseconds (≈ 1.4e12 …); anything else is not a plausible epoch
    if (raw >= 1.4e9 && raw < 4.2e9) return { kind: "epoch", ms: raw * 1000, unit: "s" };
    if (raw >= 1.4e12 && raw < 4.2e12) return { kind: "epoch", ms: raw, unit: "ms" };
    return { kind: "invalid", raw: String(raw) };
  }
  if (typeof raw !== "string") return { kind: "invalid", raw: String(raw) };
  const s = raw.trim();
  const dm = DATE_RE.exec(s);
  if (dm) { const y = +dm[1], m = +dm[2], d = +dm[3]; return validDate(y, m, d) ? { kind: "date_only", date: s, ms: Date.UTC(y, m - 1, d) } : { kind: "invalid", raw: s }; }
  const m = DT_RE.exec(s);
  if (!m) return { kind: "invalid", raw: s };
  const y = +m[1], mo = +m[2], d = +m[3], hh = +m[5], mi = +m[6], ss = m[7] === undefined ? 0 : +m[7];
  if (!validDate(y, mo, d) || hh > 23 || mi > 59 || ss > 59) return { kind: "invalid", raw: s };
  const frac = m[8] ? Math.round(Number("0" + m[8]) * 1000) : 0;
  const wall = Date.UTC(y, mo - 1, d, hh, mi, ss, frac);
  const wallTime = `${m[5]}:${m[6]}:${String(ss).padStart(2, "0")}`;
  if (m[9] === undefined) return { kind: "no_offset", ms: wall };
  let offsetMinutes = 0, shortOffset = false;
  if (m[9] !== "Z" && m[9] !== "z") {
    const sign = m[9][0] === "-" ? -1 : 1; const digits = m[9].slice(1).replace(":", "");
    const oh = +digits.slice(0, 2), om = digits.length > 2 ? +digits.slice(2) : 0; shortOffset = digits.length === 2;
    if (oh > 23 || om > 59) return { kind: "invalid", raw: s };
    offsetMinutes = sign * (oh * 60 + om);
  }
  const spaceBeforeOffset = s[s.length - m[9].length - 1] === " ";
  const strict = m[4] === "T" && !shortOffset && m[9] !== "z" && !spaceBeforeOffset;
  return { kind: "datetime", ms: wall - offsetMinutes * 60_000, format: strict ? "strict" : "lenient", offsetMinutes, precision: m[8] ? "fraction" : m[7] === undefined ? "minute" : "second", wallTime };
}

// ───────────────────────────────────────────── field classification ─────────────────────────────────────────

/**
 * What a field NAME suggests. This is a hint for the audit's inventory and a hard filter for the roles that may never
 * be used; it is not evidence of what a field means (that is measured against resolution times).
 *   START_LIKE       start / kick-off / game-start names. May fill slot 1 only if the audit shows it is an event start.
 *   CLOSE_LIKE       end / close / deadline names (present tense or noun). May fill slot 2 only if the audit supports it.
 *   RESOLUTION_LIKE  resolved / settled / closed (past tense) / payout / UMA / redeem names: after-the-fact times. NEVER accepted (§3.3).
 *   CREATION_LIKE, UPDATE_LIKE  bookkeeping times. NEVER accepted.
 *   OTHER_TIME       a time-looking name that is none of the above.
 *   NOT_TIME         not a time name.
 */
export type FieldRole = "START_LIKE" | "CLOSE_LIKE" | "RESOLUTION_LIKE" | "CREATION_LIKE" | "UPDATE_LIKE" | "OTHER_TIME" | "NOT_TIME";

/** The last path segment of a dotted/array path, lower-cased with separators removed: `events[].startDate` → `startdate`. */
const leaf = (name: string) => name.split(".").pop()!.replace(/\[\]/g, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

export function classifyFieldName(name: string): FieldRole {
  const n = leaf(name);
  if (!n) return "NOT_TIME";
  if (/resol|settle|payout|redeem|finaliz|^uma|closed(time|at|date|ts|timestamp)?$|closedtime|ended(at|time)|finished|concluded|completed/.test(n)) return "RESOLUTION_LIKE";
  if (/creat|listed|published|deployed|inserted/.test(n)) return "CREATION_LIKE";
  if (/updat|modif|refresh|fetched|synced|lasttrade|lastupdate/.test(n)) return "UPDATE_LIKE";
  if (/gamestart|eventstart|matchstart|kickoff|scheduledstart|startsat|starttime|startdate|startat|^start|start(ts|timestamp)$/.test(n)) return "START_LIKE";
  if (/end|close|clos|deadline|expir|until|cutoff/.test(n) && /(date|time|at|ts|timestamp|iso|^end|^close|deadline|expir|cutoff)/.test(n)) return "CLOSE_LIKE";
  if (/(time|date|timestamp|at|ts)$/.test(n) || /timestamp/.test(n)) return "OTHER_TIME";
  return "NOT_TIME";
}

/** Roles that can never fill a hierarchy slot, whatever the audit measured. */
export const FORBIDDEN_ROLES: ReadonlySet<FieldRole> = new Set<FieldRole>(["RESOLUTION_LIKE", "CREATION_LIKE", "UPDATE_LIKE", "NOT_TIME"]);

/** Whether `role` may fill slot 1 (`event_start_time`) or slot 2 (`market_close_time`). OTHER_TIME is allowed only when the audit named the field explicitly (the caller's decision). */
export function roleAllowedForSlot(role: FieldRole, slot: 1 | 2): boolean {
  if (FORBIDDEN_ROLES.has(role)) return false;
  if (role === "OTHER_TIME") return true;
  return slot === 1 ? role === "START_LIKE" : role === "CLOSE_LIKE";
}

// ───────────────────────────────────────────── placeholder detection ────────────────────────────────────────

export type PlaceholderKind = "DATE_ONLY" | "MIDNIGHT_UTC" | "NOON_UTC" | "END_OF_DAY_UTC" | "LOCAL_MIDNIGHT" | "LOCAL_END_OF_DAY" | "ET_MIDNIGHT" | "ET_END_OF_DAY";

const utcClock = (ms: number) => new Date(ms).toISOString().slice(11, 19);

// ───────────────────────────────────────────── US Eastern time (date-only values in disguise) ─────────────────

const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** The wall-clock date and time of an instant in America/New_York, daylight saving included (EDT = UTC−4, EST = UTC−5). */
export function easternParts(ms: number): { date: string; time: string; offsetMinutes: number } {
  const p: Record<string, string> = {}; for (const x of ET.formatToParts(new Date(ms))) p[x.type] = x.value;
  const date = `${p.year}-${p.month}-${p.day}`; const time = `${p.hour}:${p.minute}:${p.second}`;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second); // the wall clock read as if it were UTC
  return { date, time, offsetMinutes: Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000) };
}
/**
 * A datetime whose Eastern wall clock is exactly 00:00:00 (ET_MIDNIGHT: 04:00Z in summer, 05:00Z in winter) or 23:59:00 / 23:59:59
 * (ET_END_OF_DAY: 03:59Z / 04:59Z of the next UTC day): the signature of a DATE written as a time in Eastern. `date` is the
 * calendar date it implies: the Eastern date of the instant (for the end-of-day form the date that is ending). null otherwise.
 */
export function easternPlaceholder(raw: unknown): { kind: "ET_MIDNIGHT" | "ET_END_OF_DAY"; date: string } | null {
  const p = parseTimestamp(raw); if (p.kind !== "datetime") return null;
  const e = easternParts(p.ms);
  if (e.time === "00:00:00") return { kind: "ET_MIDNIGHT", date: e.date };
  if (e.time === "23:59:00" || e.time === "23:59:59") return { kind: "ET_END_OF_DAY", date: e.date };
  return null;
}
/** The Eastern calendar date a value stands for when it is a date-only value or an Eastern placeholder; null for a genuine time of day. Never a time. */
export function impliedEasternDate(raw: unknown): string | null {
  const p = parseTimestamp(raw); if (p.kind === "date_only") return p.date;
  return easternPlaceholder(raw)?.date ?? null;
}

/**
 * Whether a single value has the shape of a placeholder: no time of day at all, or exactly 00:00:00 / 12:00:00 /
 * 23:59:59 UTC (or, for a non-UTC offset, 00:00:00 / 23:59:59 on the wall clock as written). A single value cannot
 * prove a placeholder (a match really can start at noon UTC); `repeatedInstants` and the share per field do.
 */
export function placeholderKind(raw: unknown): PlaceholderKind | null {
  const p = parseTimestamp(raw);
  if (p.kind === "date_only") return "DATE_ONLY";
  if (p.kind === "datetime") {
    const c = utcClock(p.ms);
    if (c === "00:00:00") return "MIDNIGHT_UTC";
    if (c === "12:00:00") return "NOON_UTC";
    if (c === "23:59:59") return "END_OF_DAY_UTC";
    if (p.offsetMinutes !== 0 && p.wallTime === "00:00:00") return "LOCAL_MIDNIGHT";
    if (p.offsetMinutes !== 0 && p.wallTime === "23:59:59") return "LOCAL_END_OF_DAY";
    const et = easternPlaceholder(raw); if (et) return et.kind;
  }
  return null;
}

/** Time-of-day histogram (UTC, to the second) of the datetime values among `raws`, plus the date-only and unparseable counts. */
export function timeOfDayProfile(raws: unknown[]): { total: number; missing: number; dateOnly: number; datetime: number; other: number; byClock: { clock: string; count: number; share: number }[] } {
  let missing = 0, dateOnly = 0, other = 0, datetime = 0; const by = new Map<string, number>();
  for (const r of raws) {
    const p = parseTimestamp(r);
    if (p.kind === "missing") missing++; else if (p.kind === "date_only") dateOnly++;
    else if (p.kind === "datetime" || p.kind === "no_offset" || p.kind === "epoch") { datetime++; const c = utcClock(p.ms); by.set(c, (by.get(c) ?? 0) + 1); } else other++;
  }
  const byClock = [...by.entries()].map(([clock, count]) => ({ clock, count, share: datetime ? count / datetime : 0 })).sort((a, b) => b.count - a.count || (a.clock < b.clock ? -1 : 1));
  return { total: raws.length, missing, dateOnly, datetime, other, byClock };
}

export interface RepeatedInstant { instant: string; count: number; distinctGroups: number; sampleGroups: string[] }
/**
 * Identical instants shared by many unrelated markets: an instant that appears on at least `minCount` items spread over
 * at least `minDistinctGroups` different groups (a group is an event or a title family; markets of one event legitimately share a time).
 */
export function repeatedInstants(items: { group: string; raw: unknown }[], opts: { minCount?: number; minDistinctGroups?: number } = {}): RepeatedInstant[] {
  const minCount = opts.minCount ?? 5, minGroups = opts.minDistinctGroups ?? 3; const by = new Map<number, { n: number; groups: Set<string> }>();
  for (const it of items) { const p = parseTimestamp(it.raw); if (p.kind !== "datetime") continue; const e = by.get(p.ms) ?? { n: 0, groups: new Set<string>() }; e.n++; e.groups.add(it.group); by.set(p.ms, e); }
  return [...by.entries()].filter(([, e]) => e.n >= minCount && e.groups.size >= minGroups)
    .map(([ms, e]) => ({ instant: new Date(ms).toISOString(), count: e.n, distinctGroups: e.groups.size, sampleGroups: [...e.groups].sort().slice(0, 3) }))
    .sort((a, b) => b.count - a.count || (a.instant < b.instant ? -1 : 1));
}

// ───────────────────────────────────────────── §3.3 validation ──────────────────────────────────────────────

export type TimestampReject =
  | "MISSING" | "FORMAT_DATE_ONLY" | "FORMAT_NO_OFFSET" | "FORMAT_EPOCH" | "FORMAT_NONSTANDARD" | "FORMAT_INVALID"
  | "FIELD_ROLE_FORBIDDEN" | "FIELD_ROLE_WRONG_SLOT" | "KNOWN_PLACEHOLDER_FIELD" | "PLACEHOLDER_VALUE" | "PAST" | "BEYOND_400D";

export type Validated = { ok: true; ms: number; iso: string; format: "strict" | "lenient"; placeholder: PlaceholderKind | null } | { ok: false; reason: TimestampReject };

export interface ValidateOptions {
  /** The slot the field is meant to fill. Required: a field is judged by its role for that slot. */
  slot: 1 | 2;
  /** `lenient` formats (space separator, short offset) are rejected unless the audit showed the field is reliably in that format. Default false. */
  acceptLenientFormat?: boolean;
  /** True when the audit found this field to hold placeholder values for this market type (§3.3): the whole field is rejected. */
  knownPlaceholderField?: boolean;
  /** Accept a time that is already in the past (kept as valid so the caller can report EVENT_STARTED, §3.4). Default false. */
  allowPast?: boolean;
  /** Reject exact placeholder-shaped values (midnight / noon / end-of-day UTC). Default false: one value cannot prove a placeholder; the per-field share does (`knownPlaceholderField`). */
  rejectPlaceholderShapedValues?: boolean;
}

/**
 * §3.3 validation of one field: role allowed for the slot; ISO-8601 datetime WITH offset (date-only, offset-less and
 * epoch numbers are rejected); converted to UTC; between the evaluation time and 400 days ahead (both ends inclusive).
 * A resolution / settlement / creation / update field is rejected by name before its value is even read.
 */
export function validateTimestamp(field: string, raw: unknown, evalMs: number, o: ValidateOptions): Validated {
  const role = classifyFieldName(field);
  if (FORBIDDEN_ROLES.has(role)) return { ok: false, reason: "FIELD_ROLE_FORBIDDEN" };
  if (!roleAllowedForSlot(role, o.slot)) return { ok: false, reason: "FIELD_ROLE_WRONG_SLOT" };
  if (o.knownPlaceholderField) return { ok: false, reason: "KNOWN_PLACEHOLDER_FIELD" };
  const p = parseTimestamp(raw);
  switch (p.kind) {
    case "missing": return { ok: false, reason: "MISSING" };
    case "invalid": return { ok: false, reason: "FORMAT_INVALID" };
    case "date_only": return { ok: false, reason: "FORMAT_DATE_ONLY" };
    case "no_offset": return { ok: false, reason: "FORMAT_NO_OFFSET" };
    case "epoch": return { ok: false, reason: "FORMAT_EPOCH" };
  }
  if (p.format === "lenient" && !o.acceptLenientFormat) return { ok: false, reason: "FORMAT_NONSTANDARD" };
  const ph = placeholderKind(raw);
  if (ph && o.rejectPlaceholderShapedValues) return { ok: false, reason: "PLACEHOLDER_VALUE" };
  if (p.ms < evalMs && !o.allowPast) return { ok: false, reason: "PAST" };
  if (p.ms > evalMs + MAX_AHEAD_MS) return { ok: false, reason: "BEYOND_400D" };
  return { ok: true, ms: p.ms, iso: new Date(p.ms).toISOString(), format: p.format, placeholder: ph };
}

// ───────────────────────────────────────────── §3.3 hierarchy ───────────────────────────────────────────────

export interface FieldValue { field: string; raw: unknown }
export interface ResolveInput {
  /** Slot 1 candidate: the venue's scheduled start of the real-world event. */
  start?: FieldValue | null;
  /** Slot 2 candidate: the venue's trading deadline with time of day. */
  close?: FieldValue | null;
  /** Optional: the signal venue's own time for the same event, used only for the agreement check (§3.3 "Venue authority"). */
  signalVenue?: FieldValue | null;
}
export interface ResolveConfig {
  toleranceMs?: number;
  acceptLenientFormat?: boolean;
  /** Fields (by slot) the audit found to hold placeholders for this market type. */
  knownPlaceholderFields?: { start?: boolean; close?: boolean };
  /**
   * Default false. §3.3 says slot 2 is used "only when (1) is absent". A start that is PRESENT BUT INVALID (date-only,
   * placeholder, wrong format) is not absent: falling back to the close time would usually put the event later than it
   * is (a match's deadline is after kick-off) and let an in-play market through. Fail closed unless the owner decides otherwise.
   */
  fallbackToCloseWhenStartInvalid?: boolean;
}
export type EventTimeCode = "TIMESTAMP_MISSING" | "TIMESTAMP_AMBIGUOUS" | "TIMESTAMP_VENUE_MISMATCH";
export type VenueCheck = "NOT_REQUESTED" | "AGREES" | "NOT_COMPARABLE";
export type ResolveResult =
  | { ok: true; eventMs: number; eventIso: string; slot: 1 | 2; source: FieldValue; used: FieldValue[]; venueCheck: VenueCheck; detail: string[] }
  | { ok: false; code: EventTimeCode; reasons: string[]; used: FieldValue[] };

const absent = (v?: FieldValue | null) => !v || parseTimestamp(v.raw).kind === "missing";

/**
 * Resolve the event time of the execution venue's mapped market (§3.3):
 *  1. start (slot 1) if present and valid; else
 *  2. close (slot 2) if (1) is absent and (2) is valid; else REJECT `TIMESTAMP_MISSING`.
 * If both are valid and the start is later than the close by MORE than the tolerance → `TIMESTAMP_AMBIGUOUS`
 * (exactly the tolerance is accepted). If a signal-venue time is given and valid it must agree with the chosen time
 * within the tolerance (exactly the tolerance agrees) or `TIMESTAMP_VENUE_MISMATCH`. A time in the past is returned as
 * valid so that `eligibilityTimeChecks` reports EVENT_STARTED. Every raw value consulted is returned in `used`.
 */
export function resolveEventTime(input: ResolveInput, evalMs: number, cfg: ResolveConfig = {}): ResolveResult {
  const tol = cfg.toleranceMs ?? TIMESTAMP_TOLERANCE_MS; const used: FieldValue[] = []; const reasons: string[] = [];
  const common = { acceptLenientFormat: cfg.acceptLenientFormat, allowPast: true };
  const s = absent(input.start) ? null : validateTimestamp(input.start!.field, input.start!.raw, evalMs, { ...common, slot: 1, knownPlaceholderField: cfg.knownPlaceholderFields?.start });
  const c = absent(input.close) ? null : validateTimestamp(input.close!.field, input.close!.raw, evalMs, { ...common, slot: 2, knownPlaceholderField: cfg.knownPlaceholderFields?.close });
  if (input.start && s) used.push(input.start); if (input.close && c) used.push(input.close);

  let chosen: { slot: 1 | 2; v: Extract<Validated, { ok: true }>; src: FieldValue } | null = null;
  if (s && s.ok) {
    chosen = { slot: 1, v: s, src: input.start! };
    if (c && c.ok && s.ms - c.ms > tol) return { ok: false, code: "TIMESTAMP_AMBIGUOUS", reasons: [`start ${s.iso} is later than close ${c.iso} by ${Math.round((s.ms - c.ms) / 1000)} s (tolerance ${Math.round(tol / 1000)} s)`], used };
  } else if (s && !s.ok) {
    reasons.push(`start ${input.start!.field}: ${s.reason}`);
    if (!cfg.fallbackToCloseWhenStartInvalid) return { ok: false, code: "TIMESTAMP_MISSING", reasons, used };
  }
  if (!chosen) {
    if (c && c.ok) chosen = { slot: 2, v: c, src: input.close! };
    else { if (c && !c.ok) reasons.push(`close ${input.close!.field}: ${c.reason}`); if (!s && !c) reasons.push("no start or close time"); return { ok: false, code: "TIMESTAMP_MISSING", reasons, used }; }
  }
  let venueCheck: VenueCheck = "NOT_REQUESTED"; const detail: string[] = [...reasons];
  if (input.signalVenue && !absent(input.signalVenue)) {
    // the other venue's time is evidence for the agreement check only; its role must still be a start or close time
    const sv = validateTimestamp(input.signalVenue.field, input.signalVenue.raw, evalMs, { slot: chosen.slot, acceptLenientFormat: cfg.acceptLenientFormat, allowPast: true });
    if (sv.ok) {
      used.push(input.signalVenue);
      if (Math.abs(sv.ms - chosen.v.ms) > tol) return { ok: false, code: "TIMESTAMP_VENUE_MISMATCH", reasons: [`signal venue ${sv.iso} vs execution venue ${chosen.v.iso}: differ by ${Math.round(Math.abs(sv.ms - chosen.v.ms) / 1000)} s (tolerance ${Math.round(tol / 1000)} s)`], used };
      venueCheck = "AGREES";
    } else { venueCheck = "NOT_COMPARABLE"; detail.push(`signal venue ${input.signalVenue.field}: ${sv.reason}`); }
  }
  if (!used.includes(chosen.src)) used.unshift(chosen.src);
  return { ok: true, eventMs: chosen.v.ms, eventIso: chosen.v.iso, slot: chosen.slot, source: chosen.src, used, venueCheck, detail };
}

// ───────────────────────────────────────────── §3.4 eligibility arithmetic ──────────────────────────────────

export type TimeCheckCode = "EVENT_STARTED" | "BEYOND_HORIZON" | "TOO_CLOSE_TO_START";
export interface TimeChecks { timeToEventMs: number; eligible: boolean; /** every failing check, in E5, E6, E7 order */ failures: TimeCheckCode[]; primary: TimeCheckCode | null }
/**
 * §3.4, exactly. time_to_event = event − evaluation.
 *   ≤ 0                 → EVENT_STARTED (E5)
 *   > 24 h              → BEYOND_HORIZON (E6)  (exactly 24:00:00 is eligible; 24 h + 1 s is not)
 *   < MIN_LEAD          → TOO_CLOSE_TO_START (E7) (exactly MIN_LEAD is eligible)
 * All checks are evaluated and every failure is returned ("all checks evaluated and every failure recorded", §3.2), so a
 * started event reports both EVENT_STARTED and TOO_CLOSE_TO_START; `primary` is the first.
 */
export function eligibilityTimeChecks(eventMs: number, evalMs: number, minLeadMs = MIN_LEAD_MS): TimeChecks {
  const t = eventMs - evalMs; const failures: TimeCheckCode[] = [];
  if (t <= 0) failures.push("EVENT_STARTED");
  if (t > MAX_HORIZON_MS) failures.push("BEYOND_HORIZON");
  if (t < minLeadMs) failures.push("TOO_CLOSE_TO_START");
  return { timeToEventMs: t, eligible: failures.length === 0, failures, primary: failures[0] ?? null };
}
