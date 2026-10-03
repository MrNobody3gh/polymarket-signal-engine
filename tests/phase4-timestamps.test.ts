/**
 * Phase 4.0 — timestamp parsing, field classification and the §3.3 / §3.4 rules (docs/PHASE4_PLAN.md).
 * Each block is a boundary the plan names; scripts/phase4/mutation-check.ts breaks the implementation on purpose to
 * prove each one fails when the rule is wrong.
 */
import { describe, expect, it } from "vitest";
import { DAY_MS, MAX_AHEAD_MS, MAX_HORIZON_MS, MIN_LEAD_MS, TIMESTAMP_TOLERANCE_MS, classifyFieldName, eligibilityTimeChecks, parseTimestamp, resolveEventTime, roleAllowedForSlot, validateTimestamp } from "../src/lib/phase4/timestamps";

const T0 = Date.parse("2026-10-05T12:00:00Z"); // evaluation time used throughout
const iso = (ms: number) => new Date(ms).toISOString();

describe("parseTimestamp", () => {
  it("converts an offset to UTC (Z, ±HH:MM, ±HHMM) and keeps the wall-clock time as written", () => {
    expect(parseTimestamp("2026-10-05T15:30:00Z")).toMatchObject({ kind: "datetime", ms: Date.parse("2026-10-05T15:30:00Z"), format: "strict", offsetMinutes: 0 });
    expect(parseTimestamp("2026-10-05T19:30:00-04:00")).toMatchObject({ kind: "datetime", ms: Date.parse("2026-10-05T23:30:00Z"), offsetMinutes: -240, wallTime: "19:30:00" });
    expect(parseTimestamp("2026-10-05T21:00:00+05:30")).toMatchObject({ ms: Date.parse("2026-10-05T15:30:00Z"), offsetMinutes: 330 });
    expect(parseTimestamp("2026-10-05T21:00:00+0530")).toMatchObject({ ms: Date.parse("2026-10-05T15:30:00Z"), format: "strict" });
  });
  it("reads fractions and minute precision", () => {
    expect(parseTimestamp("2026-10-05T15:30:00.250Z")).toMatchObject({ precision: "fraction", ms: Date.parse("2026-10-05T15:30:00.250Z") });
    expect(parseTimestamp("2026-10-05T15:30Z")).toMatchObject({ precision: "minute" });
    expect(parseTimestamp("2026-10-05T15:30:07Z")).toMatchObject({ precision: "second" });
  });
  it("marks a space separator or a short offset as lenient (seen in some venue fields), still converting correctly", () => {
    expect(parseTimestamp("2026-10-10 15:15:00+00")).toMatchObject({ kind: "datetime", format: "lenient", ms: Date.parse("2026-10-10T15:15:00Z") });
    expect(parseTimestamp("2026-10-10T15:15:00+02")).toMatchObject({ format: "lenient", ms: Date.parse("2026-10-10T13:15:00Z") });
    expect(parseTimestamp("2026-10-10T15:15:00z")).toMatchObject({ format: "lenient" });
  });
  it("classifies a date without a time of day, and a time without an offset, instead of guessing", () => {
    expect(parseTimestamp("2026-10-05")).toMatchObject({ kind: "date_only", date: "2026-10-05" });
    expect(parseTimestamp("2026-10-05T15:30:00")).toMatchObject({ kind: "no_offset" });
  });
  it("classifies numbers as epoch seconds or milliseconds, and refuses implausible ones", () => {
    expect(parseTimestamp(1_790_000_000)).toMatchObject({ kind: "epoch", unit: "s", ms: 1_790_000_000_000 });
    expect(parseTimestamp(1_790_000_000_000)).toMatchObject({ kind: "epoch", unit: "ms" });
    for (const v of [0, -5, 12345, NaN, Infinity]) expect(parseTimestamp(v).kind).toBe("invalid");
  });
  it("rejects impossible dates and times", () => {
    for (const v of ["2026-02-30T10:00:00Z", "2026-13-01T10:00:00Z", "2026-10-05T24:00:00Z", "2026-10-05T10:60:00Z", "2026-10-05T10:00:60Z", "2026-10-05T10:00:00+25:00", "2026-10-05T10:00:00+05:75", "not a date", "2026-10-5", "2026-02-29"]) expect(parseTimestamp(v).kind, v).toBe("invalid");
    expect(parseTimestamp("2028-02-29T10:00:00Z").kind).toBe("datetime");  // leap day exists
    expect(parseTimestamp("2026-02-29T10:00:00Z").kind).toBe("invalid");   // and does not in 2026
    expect(parseTimestamp("2100-02-29T10:00:00Z").kind).toBe("invalid");   // century rule
  });
  it("treats null, undefined and blank as missing", () => { for (const v of [null, undefined, "", "   "]) expect(parseTimestamp(v)).toEqual({ kind: "missing" }); });
});

describe("classifyFieldName", () => {
  it("never lets a resolution / settlement / creation / update time fill a slot, whatever its value", () => {
    for (const f of ["resolvedAt", "resolutionTime", "resolved_ts", "settledAt", "settlementTime", "closedTime", "closed_time", "umaEndDate", "payoutTime", "redeemedAt", "finalizedAt", "endedAt", "events[].closedTime", "market.resolution_timestamp"]) { expect(classifyFieldName(f), f).toBe("RESOLUTION_LIKE"); expect(roleAllowedForSlot(classifyFieldName(f), 1), f).toBe(false); expect(roleAllowedForSlot(classifyFieldName(f), 2), f).toBe(false); }
    for (const f of ["createdAt", "created_at", "listedAt", "publishedAt"]) expect(classifyFieldName(f), f).toBe("CREATION_LIKE");
    for (const f of ["updatedAt", "lastUpdated", "modifiedAt", "fetched_at"]) expect(classifyFieldName(f), f).toBe("UPDATE_LIKE");
  });
  it("recognises start-like and close-like names, including nested paths", () => {
    for (const f of ["gameStartTime", "startDate", "events[].startTime", "eventStartTime", "kickoff_time", "startsAt", "start_time"]) expect(classifyFieldName(f), f).toBe("START_LIKE");
    for (const f of ["endDate", "endDateIso", "closeTime", "close_time", "events[].endDate", "deadline", "expiresAt", "expirationTime"]) expect(classifyFieldName(f), f).toBe("CLOSE_LIKE");
    expect(classifyFieldName("acceptingOrdersTimestamp")).toBe("OTHER_TIME");
    for (const f of ["volume", "question", "slug", "liquidity", "outcomes"]) expect(classifyFieldName(f), f).toBe("NOT_TIME");
  });
  it("allows start-like names only in slot 1 and close-like names only in slot 2", () => {
    expect(roleAllowedForSlot("START_LIKE", 1)).toBe(true); expect(roleAllowedForSlot("START_LIKE", 2)).toBe(false);
    expect(roleAllowedForSlot("CLOSE_LIKE", 2)).toBe(true); expect(roleAllowedForSlot("CLOSE_LIKE", 1)).toBe(false);
    expect(roleAllowedForSlot("NOT_TIME", 1)).toBe(false);
  });
});

describe("validateTimestamp (§3.3)", () => {
  const ok = (raw: unknown, o: Partial<Parameters<typeof validateTimestamp>[3]> = {}, f = "gameStartTime") => validateTimestamp(f, raw, T0, { slot: 1, ...o });
  it("accepts an ISO-8601 datetime with an offset and returns the UTC instant", () => {
    const r = ok("2026-10-05T19:30:00+02:00"); expect(r).toMatchObject({ ok: true, ms: Date.parse("2026-10-05T17:30:00Z"), iso: "2026-10-05T17:30:00.000Z", format: "strict" });
  });
  it("rejects a date-only value, a value without an offset, an epoch number and garbage", () => {
    expect(ok("2026-10-06")).toEqual({ ok: false, reason: "FORMAT_DATE_ONLY" });
    expect(ok("2026-10-06T10:00:00")).toEqual({ ok: false, reason: "FORMAT_NO_OFFSET" });
    expect(ok(1_790_000_000)).toEqual({ ok: false, reason: "FORMAT_EPOCH" });
    expect(ok("soon")).toEqual({ ok: false, reason: "FORMAT_INVALID" });
    expect(ok(null)).toEqual({ ok: false, reason: "MISSING" });
  });
  it("rejects a lenient format unless the audit explicitly accepted it for the field", () => {
    expect(ok("2026-10-06 10:00:00+00")).toEqual({ ok: false, reason: "FORMAT_NONSTANDARD" });
    expect(ok("2026-10-06 10:00:00+00", { acceptLenientFormat: true })).toMatchObject({ ok: true, format: "lenient", ms: Date.parse("2026-10-06T10:00:00Z") });
  });
  it("NEVER accepts a resolution-time field, even with a perfect future value", () => {
    for (const f of ["resolvedAt", "closedTime", "umaEndDate", "settledAt", "resolutionTimestamp"]) for (const slot of [1, 2] as const) expect(validateTimestamp(f, "2026-10-06T10:00:00Z", T0, { slot, acceptLenientFormat: true }), `${f}/${slot}`).toEqual({ ok: false, reason: "FIELD_ROLE_FORBIDDEN" });
    expect(validateTimestamp("createdAt", "2026-10-06T10:00:00Z", T0, { slot: 1 })).toEqual({ ok: false, reason: "FIELD_ROLE_FORBIDDEN" });
    expect(validateTimestamp("updatedAt", "2026-10-06T10:00:00Z", T0, { slot: 2 })).toEqual({ ok: false, reason: "FIELD_ROLE_FORBIDDEN" });
  });
  it("keeps a start-like field out of slot 2 and a close-like field out of slot 1", () => {
    expect(validateTimestamp("gameStartTime", "2026-10-06T10:00:00Z", T0, { slot: 2 })).toEqual({ ok: false, reason: "FIELD_ROLE_WRONG_SLOT" });
    expect(validateTimestamp("endDate", "2026-10-06T10:00:00Z", T0, { slot: 1 })).toEqual({ ok: false, reason: "FIELD_ROLE_WRONG_SLOT" });
  });
  it("rejects a whole field the audit found to hold placeholders for the market type", () => {
    expect(ok("2026-10-06T10:00:00Z", { knownPlaceholderField: true })).toEqual({ ok: false, reason: "KNOWN_PLACEHOLDER_FIELD" });
  });
  it("optionally rejects placeholder-shaped values (midnight, noon, end of day UTC)", () => {
    for (const v of ["2026-10-06T00:00:00Z", "2026-10-06T12:00:00Z", "2026-10-06T23:59:59Z"]) { expect(ok(v, { rejectPlaceholderShapedValues: true })).toEqual({ ok: false, reason: "PLACEHOLDER_VALUE" }); expect(ok(v)).toMatchObject({ ok: true }); }
  });
  it("window: the evaluation time and 400 days ahead are valid; one millisecond outside either end is not", () => {
    expect(ok(iso(T0))).toMatchObject({ ok: true });
    expect(ok(iso(T0 - 1))).toEqual({ ok: false, reason: "PAST" });
    expect(ok(iso(T0 - 1), { allowPast: true })).toMatchObject({ ok: true });
    expect(ok(iso(T0 + MAX_AHEAD_MS))).toMatchObject({ ok: true });
    expect(ok(iso(T0 + MAX_AHEAD_MS + 1))).toEqual({ ok: false, reason: "BEYOND_400D" });
    expect(MAX_AHEAD_MS).toBe(400 * DAY_MS);
  });
});

describe("resolveEventTime (§3.3 hierarchy)", () => {
  const start = (raw: unknown, field = "gameStartTime") => ({ field, raw }); const close = (raw: unknown, field = "endDate") => ({ field, raw });
  const S = "2026-10-05T20:00:00Z", C = "2026-10-05T23:00:00Z";
  it("uses the start time whenever it is present and valid, even when a later close time exists", () => {
    const r = resolveEventTime({ start: start(S), close: close(C) }, T0); expect(r).toMatchObject({ ok: true, slot: 1, eventIso: "2026-10-05T20:00:00.000Z" });
    if (r.ok) expect(r.used.map((u) => u.field)).toEqual(["gameStartTime", "endDate"]);
  });
  it("falls back to the close time only when the start is absent (deadline-type markets)", () => {
    for (const s of [undefined, null, start(null), start(""), start(undefined)]) expect(resolveEventTime({ start: s as never, close: close(C) }, T0), String(JSON.stringify(s))).toMatchObject({ ok: true, slot: 2, eventIso: "2026-10-05T23:00:00.000Z" });
  });
  it("rejects TIMESTAMP_MISSING when neither is present", () => {
    expect(resolveEventTime({}, T0)).toMatchObject({ ok: false, code: "TIMESTAMP_MISSING" });
    expect(resolveEventTime({ start: start(null), close: close("") }, T0)).toMatchObject({ ok: false, code: "TIMESTAMP_MISSING" });
  });
  it("a resolution-time field offered as the close time is never used", () => {
    expect(resolveEventTime({ close: { field: "closedTime", raw: C } }, T0)).toMatchObject({ ok: false, code: "TIMESTAMP_MISSING" });
    expect(resolveEventTime({ start: { field: "resolvedAt", raw: S }, close: { field: "umaEndDate", raw: C } }, T0)).toMatchObject({ ok: false, code: "TIMESTAMP_MISSING" });
  });
  it("a start that is present but unusable (date-only, no offset) does NOT fall back to the close time: fail closed", () => {
    expect(resolveEventTime({ start: start("2026-10-05"), close: close(C) }, T0)).toMatchObject({ ok: false, code: "TIMESTAMP_MISSING" });
    expect(resolveEventTime({ start: start("2026-10-05T20:00:00"), close: close(C) }, T0)).toMatchObject({ ok: false, code: "TIMESTAMP_MISSING" });
    expect(resolveEventTime({ start: start("2026-10-05"), close: close(C) }, T0, { fallbackToCloseWhenStartInvalid: true })).toMatchObject({ ok: true, slot: 2 });
  });
  it("start-after-close is AMBIGUOUS only when it exceeds the tolerance: exactly the tolerance is accepted", () => {
    const c = Date.parse(C); const tol = TIMESTAMP_TOLERANCE_MS;
    expect(resolveEventTime({ start: start(iso(c + tol)), close: close(C) }, T0)).toMatchObject({ ok: true, slot: 1 });
    expect(resolveEventTime({ start: start(iso(c + tol + 1000)), close: close(C) }, T0)).toMatchObject({ ok: false, code: "TIMESTAMP_AMBIGUOUS" });
    expect(resolveEventTime({ start: start(iso(c - 3_600_000)), close: close(C) }, T0)).toMatchObject({ ok: true }); // start well before close is normal
    expect(resolveEventTime({ start: start(iso(c + 60_000)), close: close(C) }, T0, { toleranceMs: 30_000 })).toMatchObject({ ok: false, code: "TIMESTAMP_AMBIGUOUS" });
  });
  it("venue authority: the signal venue's time must agree within the tolerance; exactly the tolerance agrees", () => {
    const s = Date.parse(S); const tol = TIMESTAMP_TOLERANCE_MS; const sv = (ms: number) => ({ field: "startDate", raw: iso(ms) });
    expect(resolveEventTime({ start: start(S), signalVenue: sv(s + tol) }, T0)).toMatchObject({ ok: true, venueCheck: "AGREES" });
    expect(resolveEventTime({ start: start(S), signalVenue: sv(s - tol) }, T0)).toMatchObject({ ok: true, venueCheck: "AGREES" });
    expect(resolveEventTime({ start: start(S), signalVenue: sv(s + tol + 1000) }, T0)).toMatchObject({ ok: false, code: "TIMESTAMP_VENUE_MISMATCH" });
    expect(resolveEventTime({ start: start(S), signalVenue: sv(s - tol - 1000) }, T0)).toMatchObject({ ok: false, code: "TIMESTAMP_VENUE_MISMATCH" });
    expect(resolveEventTime({ start: start(S) }, T0)).toMatchObject({ ok: true, venueCheck: "NOT_REQUESTED" });
  });
  it("a signal-venue time that cannot be compared (date-only) is recorded, never used as the event time", () => {
    const r = resolveEventTime({ start: start(S), signalVenue: { field: "endDateIso", raw: "2026-10-05" } }, T0); expect(r).toMatchObject({ ok: true, venueCheck: "NOT_COMPARABLE", eventIso: "2026-10-05T20:00:00.000Z" });
    expect(resolveEventTime({ signalVenue: { field: "startDate", raw: S } }, T0)).toMatchObject({ ok: false, code: "TIMESTAMP_MISSING" }); // the other venue's time alone is never enough
  });
  it("a known-placeholder field is treated as unusable", () => {
    expect(resolveEventTime({ start: start(S), close: close(C) }, T0, { knownPlaceholderFields: { start: true } })).toMatchObject({ ok: false, code: "TIMESTAMP_MISSING" });
    expect(resolveEventTime({ close: close("2026-10-06T00:00:00Z") }, T0, { knownPlaceholderFields: { close: true } })).toMatchObject({ ok: false, code: "TIMESTAMP_MISSING" });
  });
  it("rejects a time more than 400 days ahead as unusable, and returns a past time as valid so the caller reports EVENT_STARTED", () => {
    expect(resolveEventTime({ start: start(iso(T0 + MAX_AHEAD_MS + 1000)) }, T0)).toMatchObject({ ok: false, code: "TIMESTAMP_MISSING" });
    const past = resolveEventTime({ start: start(iso(T0 - 600_000)) }, T0); expect(past).toMatchObject({ ok: true });
    if (past.ok) expect(eligibilityTimeChecks(past.eventMs, T0).failures).toContain("EVENT_STARTED");
  });
  it("returns the source field name and the raw value of every timestamp used (journal requirement)", () => {
    const r = resolveEventTime({ start: start(S), close: close(C) }, T0); expect(r.used).toEqual([{ field: "gameStartTime", raw: S }, { field: "endDate", raw: C }]);
  });
  it("accepts a lenient format only when configured", () => {
    expect(resolveEventTime({ start: start("2026-10-05 20:00:00+00") }, T0)).toMatchObject({ ok: false, code: "TIMESTAMP_MISSING" });
    expect(resolveEventTime({ start: start("2026-10-05 20:00:00+00") }, T0, { acceptLenientFormat: true })).toMatchObject({ ok: true, eventIso: "2026-10-05T20:00:00.000Z" });
  });
});

describe("eligibilityTimeChecks (§3.4)", () => {
  const H = 3_600_000;
  it("plan examples: 23 h eligible, 25 h beyond the horizon", () => {
    expect(eligibilityTimeChecks(T0 + 23 * H, T0)).toMatchObject({ eligible: true, failures: [] });
    expect(eligibilityTimeChecks(T0 + 25 * H, T0)).toMatchObject({ eligible: false, failures: ["BEYOND_HORIZON"], primary: "BEYOND_HORIZON" });
  });
  it("exactly 24:00:00 is eligible; 24 h + 1 s is not", () => {
    expect(eligibilityTimeChecks(T0 + MAX_HORIZON_MS, T0).eligible).toBe(true);
    expect(eligibilityTimeChecks(T0 + MAX_HORIZON_MS + 1000, T0)).toMatchObject({ eligible: false, failures: ["BEYOND_HORIZON"] });
    expect(eligibilityTimeChecks(T0 + MAX_HORIZON_MS + 1, T0).eligible).toBe(false);
  });
  it("time_to_event ≤ 0 is EVENT_STARTED (a started event or a passed deadline)", () => {
    expect(eligibilityTimeChecks(T0, T0).failures).toContain("EVENT_STARTED");
    expect(eligibilityTimeChecks(T0 - 1, T0).failures).toContain("EVENT_STARTED");
    expect(eligibilityTimeChecks(T0 - 30 * 60_000, T0).primary).toBe("EVENT_STARTED");
    expect(eligibilityTimeChecks(T0 + 1, T0).failures).not.toContain("EVENT_STARTED");
  });
  it("MIN_LEAD: exactly 300 s is eligible, 1 ms less is TOO_CLOSE_TO_START; a started event also reports it (all checks are recorded)", () => {
    expect(eligibilityTimeChecks(T0 + MIN_LEAD_MS, T0).eligible).toBe(true);
    expect(eligibilityTimeChecks(T0 + MIN_LEAD_MS - 1, T0)).toMatchObject({ eligible: false, failures: ["TOO_CLOSE_TO_START"] });
    expect(eligibilityTimeChecks(T0 - 1000, T0).failures).toEqual(["EVENT_STARTED", "TOO_CLOSE_TO_START"]);
    expect(eligibilityTimeChecks(T0 + 100_000, T0, 60_000).eligible).toBe(true); // MIN_LEAD is a parameter
  });
  it("plan example: Man U v Man City at 4 pm — a signal at 3:30 pm is eligible, at 4:30 pm it is not", () => {
    const kick = Date.parse("2026-10-05T16:00:00Z");
    expect(eligibilityTimeChecks(kick, Date.parse("2026-10-05T15:30:00Z")).eligible).toBe(true);
    expect(eligibilityTimeChecks(kick, Date.parse("2026-10-05T16:30:00Z")).primary).toBe("EVENT_STARTED");
  });
});
