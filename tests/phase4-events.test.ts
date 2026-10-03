/**
 * Phase 4.0b — S1a at event level: grouping by event, Eastern-time date placeholders across the daylight-saving change, the implied
 * date, the date-level alternative, the gameStartTime deep dive, participants and the same event on both venues.
 */
import { describe, expect, it } from "vitest";
import { RECOMMEND_RULES, buildInventory, collapseToEvents, dateLevelRows, recommendSlots, stratifiedSample } from "../src/lib/phase4/audit";
import { findEventStartTime, findField, findMarketTypeField, gameStartDeepDive, matchEventsAcrossVenues, participantSimilarity, participantsOf, startFieldFor } from "../src/lib/phase4/events";
import { easternParts, easternPlaceholder, impliedEasternDate, placeholderKind } from "../src/lib/phase4/timestamps";
import { gammaGroupOf, usGroupOf, eventFallbackKey } from "../src/lib/phase4/venues";
import { marketsOfEvents, toMarkets, varied, type EventSpec } from "./helpers/phase4EventWorld";

const verdict = (ms: ReturnType<typeof toMarkets>, slot: 1 | 2, st = "sports:basketball") => recommendSlots("v", ms, buildInventory(ms)).find((r) => r.stratum === st && r.slot === slot)!;

describe("Eastern-time date placeholders (daylight saving)", () => {
  it("00:00 and 23:59 Eastern are recognised in summer (EDT, UTC−4) and winter (EST, UTC−5)", () => {
    expect(easternPlaceholder("2026-10-30T04:00:00Z")).toEqual({ kind: "ET_MIDNIGHT", date: "2026-10-30" });   // EDT
    expect(easternPlaceholder("2026-11-02T05:00:00Z")).toEqual({ kind: "ET_MIDNIGHT", date: "2026-11-02" });   // EST
    expect(easternPlaceholder("2026-10-31T03:59:00Z")).toEqual({ kind: "ET_END_OF_DAY", date: "2026-10-30" }); // 23:59 EDT on the 30th
    expect(easternPlaceholder("2026-11-03T04:59:00Z")).toEqual({ kind: "ET_END_OF_DAY", date: "2026-11-02" }); // 23:59 EST on the 2nd
    expect(easternPlaceholder("2026-11-03T04:59:59Z")?.kind).toBe("ET_END_OF_DAY");
  });
  it("the wrong offset is NOT a placeholder: 04:00Z in winter is 23:00 the evening before, 05:00Z in summer is 01:00", () => {
    expect(easternPlaceholder("2026-11-02T04:00:00Z")).toBeNull(); expect(easternPlaceholder("2026-10-30T05:00:00Z")).toBeNull();
    expect(easternPlaceholder("2026-11-03T03:59:00Z")).toBeNull(); expect(easternPlaceholder("2026-10-31T04:59:00Z")).toBeNull();
  });
  it("on the change days themselves (1 Nov 2026 autumn, 8 Mar 2026 spring) the offset in force at that midnight decides", () => {
    expect(easternPlaceholder("2026-11-01T04:00:00Z")).toEqual({ kind: "ET_MIDNIGHT", date: "2026-11-01" });    // midnight 1 Nov is still EDT
    expect(easternPlaceholder("2026-11-01T05:00:00Z")).toBeNull();                                               // 01:00 EDT
    expect(easternPlaceholder("2026-11-02T05:00:00Z")?.date).toBe("2026-11-02");                                 // first EST midnight
    expect(easternPlaceholder("2026-03-08T05:00:00Z")).toEqual({ kind: "ET_MIDNIGHT", date: "2026-03-08" });    // midnight 8 Mar is still EST
    expect(easternPlaceholder("2026-03-08T04:00:00Z")).toBeNull(); expect(easternPlaceholder("2026-03-09T04:00:00Z")).toEqual({ kind: "ET_MIDNIGHT", date: "2026-03-09" }); // first EDT midnight
    expect(easternParts(Date.parse("2026-10-05T04:00:00Z")).offsetMinutes).toBe(-240); expect(easternParts(Date.parse("2026-12-05T05:00:00Z")).offsetMinutes).toBe(-300);
  });
  it("is also reported by placeholderKind, after the UTC and wall-clock kinds, and a genuine time is untouched", () => {
    expect(placeholderKind("2026-10-05T04:00:00Z")).toBe("ET_MIDNIGHT"); expect(placeholderKind("2026-10-06T03:59:00Z")).toBe("ET_END_OF_DAY"); expect(placeholderKind("2026-10-05T00:00:00Z")).toBe("MIDNIGHT_UTC");
    expect(placeholderKind("2026-10-05T04:00:00-04:00")).toBeNull(); expect(placeholderKind("2026-10-05T19:30:00Z")).toBeNull(); expect(placeholderKind("2026-10-05T04:00:01Z")).toBeNull();
  });
  it("implied calendar date: the Eastern date of the instant, the date that is ending for the end-of-day form, a date-only value as written, null for a time", () => {
    expect(impliedEasternDate("2026-10-05T04:00:00Z")).toBe("2026-10-05"); expect(impliedEasternDate("2026-10-06T03:59:00Z")).toBe("2026-10-05"); expect(impliedEasternDate("2026-11-06T04:59:00Z")).toBe("2026-11-05");
    expect(impliedEasternDate("2026-10-05")).toBe("2026-10-05"); expect(impliedEasternDate("2026-10-05T19:30:00Z")).toBeNull(); expect(impliedEasternDate("junk")).toBeNull(); expect(impliedEasternDate(null)).toBeNull();
  });
});

describe("event grouping", () => {
  it("collapseToEvents keeps one representative per event, in order", () => {
    const ms = toMarkets(marketsOfEvents(varied("a", 3, { markets: 4 }))); expect(ms).toHaveLength(12); const ev = collapseToEvents(ms); expect(ev).toHaveLength(3); expect(ev.map((m) => m.group)).toEqual(["a0", "a1", "a2"]);
  });
  it("a sample of FEW events with many markets each is not flagged as a placeholder: it is insufficient data (counts shown)", () => {
    // 6 events x 20 markets: one clock time (23:00Z) holds 100 of 120 MARKETS (83 %) because 5 of the 6 events share a tip-off; that is not a placeholder, there are simply too few events
    const base = Date.UTC(2026, 9, 1); const specs: EventSpec[] = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, title: `Club c${i}a vs Club c${i}b`, slug: `nba-c-${i}`, kickMs: base + i * 86_400_000 + (i < 5 ? 23 * 3_600_000 : 19 * 3_600_000 + 30 * 60_000), markets: 20, resolved: i % 2 === 1 }));
    const ms = toMarkets(marketsOfEvents(specs)); const v = verdict(ms, 1);
    expect(v.verdict).toBe("INSUFFICIENT_DATA"); expect(v.decidedBy).toBe("minEvents"); expect(v.failedRules).toEqual(["minEvents"]); expect(v).toMatchObject({ events: 6, markets: 120 }); expect(v.failed[0]).toMatch(/6 < 30 distinct events/);
    expect(v.failedRules).not.toContain("topClock"); expect(v.evidence.presentEvents).toBe(6);
  });
  it("many DISTINCT events sharing one clock time (here 04:59 UTC = 23:59 Eastern) ARE a placeholder: rejected, with the Eastern share shown", () => {
    const specs = varied("p", 60, { markets: 2 }).map((e) => ({ ...e, endDate: new Date(Date.UTC(2026, 8, 2 + Math.floor((e.kickMs - Date.UTC(2026, 8, 1)) / 86_400_000), 3, 59, 0)).toISOString() }));
    const ms = toMarkets(marketsOfEvents(specs)); const v = verdict(ms, 2); expect(v.verdict).toBe("UNRELIABLE_REJECT"); expect(v.failedRules).toEqual(expect.arrayContaining(["placeholderShare", "topClock"])); expect(v.events).toBe(60); expect(v.markets).toBe(120);
    expect(v.etPlaceholderShare).toBe(1); expect(v.evidence.etPlaceholderEvents).toBeGreaterThanOrEqual(50); expect(["usableShare", "placeholderShare", "topClock"]).toContain(v.decidedBy);
  });
  it("many distinct events with genuinely varied kick-offs are recommended, and the row says how many events and markets back it and that every rule passed", () => {
    const ms = toMarkets(marketsOfEvents(varied("g", 60, { markets: 3 }))); const v = verdict(ms, 1);
    expect(v).toMatchObject({ verdict: "RECOMMEND", decidedBy: "allPassed", events: 60, markets: 180 }); expect(v.failedRules).toEqual([]); expect(["gameStartTime", "events[].startTime"]).toContain(v.field);
  });
  it("the minimum is 30 distinct events: 29 are insufficient, 30 are enough", () => {
    expect(RECOMMEND_RULES.minPresent).toBe(30);
    const small = toMarkets(marketsOfEvents(varied("s", 29, { markets: 5, resolved: () => true }))); expect(verdict(small, 1).verdict).toBe("INSUFFICIENT_DATA");
    const enough = toMarkets(marketsOfEvents(varied("t", 30, { markets: 1, resolved: () => true }))); expect(verdict(enough, 1).verdict).toBe("RECOMMEND");
  });
  it("many markets from the same events do not create evidence: 29 events x 10 markets stays insufficient", () => { const ms = toMarkets(marketsOfEvents(varied("u", 29, { markets: 10, resolved: () => true }))); const v = verdict(ms, 1); expect(v).toMatchObject({ verdict: "INSUFFICIENT_DATA", events: 29, markets: 290 }); });
  it("the thresholds are unchanged by this step (owner decision D68)", () => { expect(RECOMMEND_RULES).toMatchObject({ minPresent: 30, minUsableShare: 0.9, maxPlaceholderShare: 0.1, maxTopClockShare: 0.5, minOrderedShare: 0.99, minOrderedSamples: 30, startToleranceVsCloseMin: 15, minStartBeforeCloseShare: 0.95, maxCreationCoincidenceShare: 0.5, creationCoincidenceMin: 60, eventTypeMaxMedianGapHours: 24 }); });
  it("without a venue event id the event is the normalised title and date, never the market's own slug or id", () => {
    expect(eventFallbackKey("Lakers vs. Celtics!", "2026-10-05T00:00:00Z", "m1")).toBe(eventFallbackKey("lakers vs celtics", "2026-10-05", "m2")); expect(eventFallbackKey("", null, "m9")).toBe("market:m9");
    expect(gammaGroupOf({ conditionId: "0x1", question: "A vs B", slug: "own-slug-1", endDateIso: "2026-10-05" })).toBe(gammaGroupOf({ conditionId: "0x2", question: "A vs B", slug: "own-slug-2", endDate: "2026-10-05T00:00:00Z" }));
    expect(gammaGroupOf({ conditionId: "0x1", question: "x", events: [{ id: 77 }] })).toBe("77"); expect(usGroupOf({ id: "a", event: { id: "e1" } })).toBe("e1"); expect(usGroupOf({ id: "a", eventSlug: "slug-1" })).toBe("slug-1"); expect(usGroupOf({ id: "a", question: "A vs B", endDate: "2026-10-05" })).toMatch(/^title:/);
  });
  it("stratifiedSample offers the first market of every distinct event before any second market of an event", () => {
    const items = [...Array.from({ length: 6 }, (_, i) => ({ stratum: "a", group: "e1", i })), ...Array.from({ length: 3 }, (_, i) => ({ stratum: "a", group: `e${i + 2}`, i: 10 + i }))];
    const s = stratifiedSample(items, 4, 4); expect(new Set(s.map((x) => x.group)).size).toBe(4);
  });
});

describe("the date-level alternative: shown, never recommended", () => {
  it("counts events whose close-like field implies an Eastern date, by kind, and checks the date against the resolution date", () => {
    const specs = varied("d", 40, { markets: 1, resolved: () => true }).map((e, i) => { const d = easternParts(e.kickMs).date; const dayMs = Date.parse(d + "T00:00:00Z"); return { ...e, endDate: new Date(i % 2 ? dayMs + 4 * 3_600_000 : dayMs + 86_400_000 + 3 * 3_600_000 + 59 * 60_000).toISOString() }; }); // ET midnight / ET 23:59 of the kick-off's Eastern date (September: EDT)
    const ms = toMarkets(marketsOfEvents(specs)); const rows = dateLevelRows("v", ms, buildInventory(ms)); const r = rows.find((x) => x.field === "endDate" || x.field === "events[].endDate")!;
    expect(r).toMatchObject({ stratum: "sports:basketball", events: 40, withImpliedDate: 40, impliedShare: 1, label: "ALTERNATIVE_DATE_LEVEL", recommended: false, inPlayCheck: "cannot be evaluated at date level" }); expect(r.etMidnight + r.etEndOfDay).toBe(40); expect(r.etMidnight).toBe(20); expect(r.etEndOfDay).toBe(20);
    expect(r.orderedChecked).toBe(40); expect(r.impliedDateNotAfterResolutionShare).toBe(1);
  });
  it("a field with fewer than 30 events implying a date is not shown", () => { const ms = toMarkets(marketsOfEvents(varied("e", 10, { markets: 1 }).map((e) => ({ ...e, endDate: "2026-10-05T04:00:00Z" })))); expect(dateLevelRows("v", ms, buildInventory(ms))).toEqual([]); });
});

describe("gameStartTime deep dive", () => {
  const specs = [...varied("bk", 40, { markets: 6, resolved: () => true }), ...varied("so", 12, { markets: 3, resolved: () => true }).map((e) => ({ ...e, slug: `epl-so-${e.id}`, title: `Club ${e.id}a vs Club ${e.id}b - Premier League` }))];
  const raws = marketsOfEvents(specs); const ms = toMarkets(raws); const inv = buildInventory(ms); const dive = gameStartDeepDive("v", ms, inv);
  it("finds the fields and reports presence by sport and by market type (markets and distinct events)", () => {
    expect(dive.field).toBe("gameStartTime"); expect(dive.eventStartField).toBe("events[].startTime"); expect(dive.marketTypeField).toBe("sportsMarketType");
    const all = dive.presence.find((p) => p.sport === "sports:basketball" && p.marketType === "(all)")!; expect(all).toMatchObject({ markets: 240, withField: 240, presenceShare: 1, events: 40, eventsWithField: 40 });
    const money = dive.presence.find((p) => p.sport === "sports:basketball" && p.marketType === "MONEYLINE")!; expect(money).toMatchObject({ markets: 40, events: 40 }); expect(dive.presence.find((p) => p.sport === "sports:basketball" && p.marketType === "PROP")!.markets).toBe(40);
  });
  it("a sport with many markets but few events does NOT reach the quota (both thresholds are required)", () => {
    const m2 = toMarkets(marketsOfEvents([...varied("tn", 10, { markets: 12 }).map((e) => ({ ...e, slug: `atp-${e.id}`, title: `Player ${e.id}a vs Player ${e.id}b` })), ...varied("bb", 35, { markets: 1 })]));
    const d = gameStartDeepDive("v", m2, buildInventory(m2)); expect(d.reach.find((r) => r.sport === "sports:tennis")).toEqual({ sport: "sports:tennis", markets: 120, events: 10, reaches100MarketsFrom30Events: false }); expect(d.reach.find((r) => r.sport === "sports:basketball")!.reaches100MarketsFrom30Events).toBe(false);
  });
  it("says which sports reach 100 markets from 30 distinct events", () => { expect(dive.reach).toEqual(expect.arrayContaining([{ sport: "sports:basketball", markets: 240, events: 40, reaches100MarketsFrom30Events: true }])); const so = dive.reach.find((r) => r.sport === "sports:soccer")!; expect(so.reaches100MarketsFrom30Events).toBe(false); expect(so.events).toBe(12); });
  it("agreement with events[].startTime is counted per event; the relation to creation and resolution is measured", () => {
    expect(dive.vsEventStart).toMatchObject({ events: 52, agreeWithin1Min: 52, agreeShare: 1 }); expect(dive.vsCreation.createdAt.before).toBe(0); expect(dive.vsCreation.createdAt.after).toBe(52); expect(dive.vsCreation.createdAt.p50Min!).toBeLessThan(-(5 * 24 * 60 - 5)); // created is five days BEFORE the game
    const bk = dive.resolutionMinusStart.find((r) => r.sport === "sports:basketball")!; expect(bk).toMatchObject({ events: 40, positiveShare: 1, within12hShare: 1, within24hShare: 1 }); expect(bk.p50Hours!).toBeGreaterThan(2.4); expect(bk.p50Hours!).toBeLessThan(2.7);
  });
  it("time of day is counted per distinct event, in UTC and in Eastern", () => {
    const bk = dive.clockPerEvent.find((c) => c.sport === "sports:basketball")!; expect(bk.events).toBe(40); expect(bk.distinctClocks).toBeGreaterThan(3); expect(bk.topClockShare!).toBeLessThan(0.5);
    expect(dive.clockPerEventEastern.find((c) => c.sport === "sports:basketball")!.events).toBe(40);
  });
  it("when the field disagrees with the event start, the share of agreement says so; when the venue has no gameStartTime, the dive says so", () => {
    const skewed = marketsOfEvents(varied("k", 40, { markets: 1, resolved: () => true })).map((m, i) => (i % 4 === 0 ? { ...m, gameStartTime: String(m.gameStartTime).replace(/\d\d:\d\d:\d\d/, "10:11:12") } : m)); const m2 = toMarkets(skewed); const d2 = gameStartDeepDive("v", m2, buildInventory(m2)); expect(d2.vsEventStart!.agreeShare!).toBeLessThan(0.8);
    const none = toMarkets(marketsOfEvents(varied("n", 40, { markets: 1 }), { gameStartField: false })); const d3 = gameStartDeepDive("v", none, buildInventory(none)); expect(d3.field).toBeNull(); expect(d3.presence.every((p) => p.withField === 0)).toBe(true);
  });
  it("field lookup prefers a top-level path and finds the event-level start, never startDate", () => { expect(findField(inv, "gameStartTime")).toBe("gameStartTime"); expect(findEventStartTime(inv)).toBe("events[].startTime"); expect(findMarketTypeField(ms)).toBe("sportsMarketType"); expect(startFieldFor(inv)).toBe("gameStartTime"); });
});

describe("participants and the same event on both venues", () => {
  it("head-to-head titles in every common spelling, ignoring qualifiers after a colon or bracket", () => {
    expect(participantsOf("Lakers vs. Celtics")).toEqual([["lakers"], ["celtics"]]); expect(participantsOf("Lakers v Celtics: O/U 220.5")).toEqual([["lakers"], ["celtics"]]); expect(participantsOf("Celtics @ Lakers (Game 1)")).toEqual([["celtics"], ["lakers"]]);
    expect(participantsOf("FC Barcelona - Real Madrid")).toEqual([["barcelona"], ["real", "madrid"]]); expect(participantsOf("Will it rain?")).toBeNull(); expect(participantsOf(null)).toBeNull(); expect(participantsOf("A vs B vs C")).toBeNull();
  });
  it("similarity ignores home/away order and market type, and is limited by the worse side", () => {
    expect(participantSimilarity("Lakers vs. Celtics", "Celtics vs Lakers: Spread -3.5")).toBe(1); expect(participantSimilarity("Lakers vs Celtics", "Lakers vs Bulls")).toBe(0); expect(participantSimilarity("Lakers vs Celtics", "Will it rain")).toBe(0);
    expect(participantSimilarity("Man City vs Arsenal", "Manchester City vs Arsenal")).toBeCloseTo(1 / 3, 9); // one shared token of three: below the 0.8 matching threshold, so such names are not matched without an alias list
  });
  const mk = (venue: string, specs: EventSpec[], field: boolean) => toMarkets(marketsOfEvents(specs, { gameStartField: field }), venue);
  const titleOf = (m: { flat: Record<string, unknown> }) => String(m.flat.question ?? "") || null;
  it("matches the same event by participants and Eastern date and measures the start-time spread", () => {
    const a = varied("m", 40, { markets: 2, resolved: () => true }); const diffs = [0, 0, 5, -5, 10, -10, 20, -30]; const b: EventSpec[] = a.map((e, i) => ({ ...e, id: `us${i}`, title: e.title.replace("Team", "Team"), slug: `us-${i}`, kickMs: e.kickMs + diffs[i % 8] * 60_000, markets: 1 }));
    const A = mk("a", a, true), B = mk("b", b, true); const r = matchEventsAcrossVenues({ ms: A, inv: buildInventory(A), titleOf }, { ms: B, inv: buildInventory(B), titleOf });
    expect(r).toMatchObject({ eventsA: 40, eventsB: 40, matched: 40, ambiguous: 0, withBothStarts: 40 }); expect(r.overall).toMatchObject({ n: 40, maxAbsMin: 30, within15MinShare: 0.75, within60MinShare: 1 }); expect(r.overall!.absP50Min).toBe(7.5);
  });
  it("a tie between two equally good candidates is ambiguous and skipped; a different date does not match; an event without start times is matched but not compared", () => {
    const a = varied("x", 3, { markets: 1 }); const b: EventSpec[] = [{ ...a[0], id: "y0a", slug: "y0a" }, { ...a[0], id: "y0b", slug: "y0b" }, { ...a[1], id: "y1", slug: "y1", kickMs: a[1].kickMs + 3 * 86_400_000 }, { ...a[2], id: "y2", slug: "y2" }];
    const A = mk("a", a, true), B = [...mk("b", b.slice(0, 3), true), ...mk("b", b.slice(3), false)]; const r = matchEventsAcrossVenues({ ms: A, inv: buildInventory(A), titleOf }, { ms: B, inv: buildInventory(B), titleOf });
    expect(r.ambiguous).toBe(1); expect(r.matched).toBe(1); expect(r.withBothStarts).toBe(0); // x0 ambiguous, x1 wrong date, x2 matched but its venue-b market has no gameStartTime
  });
});
