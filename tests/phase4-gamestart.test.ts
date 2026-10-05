/**
 * Phase 4.0e, Parts A–C — the `gameStartTime` check: the Eastern conversion on both sides of the daylight-saving transition, the discriminator on a world whose local starts
 * shift by one hour and a world whose placeholder stays at 00:00Z, the per-event classification at every boundary, the what-if (the baseline equals the real audit's verdict;
 * nothing real changes), and the bounded memory of the streaming collector.
 */
import { describe, expect, it } from "vitest";
import { RECOMMEND_RULES, buildInventory, recommendSlots, toAuditMarkets, type RawMarket } from "../src/lib/phase4/audit";
import { GsCollector, MIN_AFTER_EVENTS, MIN_BEFORE_MIDNIGHT, analyse, classifyEvent, clockShifts, corroborate, dstBySport, dstVerdict, midnightByType, periodOf, startCandidate, whatIf, type GsEvent } from "../src/lib/phase4/gamestart";
import { easternParts } from "../src/lib/phase4/timestamps";
import { collectGarbage } from "../src/lib/phase4/venue-run";
import { tagsOf, usGroupOf, usIdOf, usIsResolved, usTitleOf } from "../src/lib/phase4/venues";
import { Z, easternInstant, explode, lenient, localSlate, midnightPlaceholders, usEvent, type UsSpec } from "./helpers/phase4Gamestart";

const OCT5 = Date.UTC(2026, 9, 5), NOV2 = Date.UTC(2026, 10, 2), DAY = 86_400_000, H = 3_600_000, MIN = 60_000;
const collect = (specs: UsSpec[], max = [12_000, 40_000] as const): GsCollector => { const c = new GsCollector(max[0], max[1]); for (const m of explode(specs)) c.add(m); return c; };
const evs = (specs: UsSpec[]): GsEvent[] => [...collect(specs).events.values()];

describe("the Eastern conversion uses the IANA zone per value (the transition is 2026-11-01 06:00:00Z)", () => {
  it("23:59Z on 31 Oct and 00:00Z on 1 Nov are both still EDT (UTC−4), 8 pm and 7:59 pm Eastern on 31 Oct", () => {
    expect(easternParts(Date.UTC(2026, 9, 31, 23, 59))).toEqual({ date: "2026-10-31", time: "19:59:00", offsetMinutes: -240 }); expect(easternParts(Date.UTC(2026, 10, 1, 0, 0))).toEqual({ date: "2026-10-31", time: "20:00:00", offsetMinutes: -240 });
  });
  it("the last second of EDT and the first second of EST, and the evening after: 01:00Z on 2 Nov is 8 pm EST", () => {
    expect(easternParts(Date.UTC(2026, 10, 1, 5, 59, 59))).toEqual({ date: "2026-11-01", time: "01:59:59", offsetMinutes: -240 }); expect(easternParts(Date.UTC(2026, 10, 1, 6, 0, 0))).toEqual({ date: "2026-11-01", time: "01:00:00", offsetMinutes: -300 });
    expect(easternParts(Date.UTC(2026, 10, 2, 0, 0))).toEqual({ date: "2026-11-01", time: "19:00:00", offsetMinutes: -300 }); expect(easternParts(Date.UTC(2026, 10, 2, 1, 0))).toEqual({ date: "2026-11-01", time: "20:00:00", offsetMinutes: -300 });
  });
  it("a fixed offset would be wrong on one side: 00:00Z is 20:00 in October and 19:00 in November, 01:00Z is 21:00 and 20:00", () => {
    for (const [ms, t] of [[Date.UTC(2026, 9, 15, 0), "20:00:00"], [Date.UTC(2026, 10, 15, 0), "19:00:00"], [Date.UTC(2026, 9, 15, 1), "21:00:00"], [Date.UTC(2026, 10, 15, 1), "20:00:00"]] as const) expect(easternParts(ms).time).toBe(t);
  });
  it("the period of an event follows the offset, not the calendar date: 00:00Z on 1 Nov is EDT, 06:00Z the same day is EST", () => { expect(periodOf(Date.UTC(2026, 10, 1, 0))).toBe("EDT"); expect(periodOf(Date.UTC(2026, 10, 1, 5, 59, 59))).toBe("EDT"); expect(periodOf(Date.UTC(2026, 10, 1, 6))).toBe("EST"); expect(periodOf(Date.UTC(2026, 9, 31, 23, 59))).toBe("EDT"); });
  it("the fixture's local starts: 8 pm Eastern is 00:00Z under EDT and 01:00Z under EST", () => { expect(Z(easternInstant(2026, 10, 5, 20))).toBe("2026-10-06T00:00:00Z"); expect(Z(easternInstant(2026, 11, 3, 20))).toBe("2026-11-04T01:00:00Z"); expect(Z(easternInstant(2026, 11, 1, 20))).toBe("2026-11-02T01:00:00Z"); });
});

describe("the collector reads US markets into compact event records", () => {
  it("one record per distinct event (first market), counts every market and its type; schedule, creation, resolution and close times are taken from the right fields", () => {
    const gs = easternInstant(2026, 10, 5, 20); const c = collect([{ id: "e1", gs, createdMs: gs - 5 * DAY, resolved: true, resolvedMs: gs + 3 * H, markets: 3, endDate: gs + 3 * H, schedule: gs + 2 * MIN }]); const e = [...c.events.values()][0];
    expect(c.events.size).toBe(1); expect(e).toMatchObject({ id: "e1", sport: "sports:basketball", category: "sports", resolved: true, gsMs: gs, createdMs: gs - 5 * DAY, resolvedMs: gs + 3 * H, scheduleMs: gs + 2 * MIN, schedulePlaceholder: false, markets: 3 }); expect(Object.values(e.types).reduce((a, b) => a + b, 0)).toBe(3); expect(e.closes.map((x) => x.field)).toContain("endDate"); expect(c.counts.markets).toBe(3);
  });
  it("a market without a start, with a date-only start or an unparsable one is counted and kept out of the events", () => {
    const base = usEvent({ id: "a", gs: 1 })[0]; const c = new GsCollector(); c.add({ ...base, id: "x1", gameStartTime: undefined, event: { id: "n1" } }); c.add({ ...base, id: "x2", gameStartTime: "2026-10-10", event: { id: "n2" } }); c.add({ ...base, id: "x3", gameStartTime: "soon", event: { id: "n3" } });
    expect(c.events.size).toBe(0); expect(c.counts).toMatchObject({ markets: 3, noGameStart: 1, dateOnly: 1, invalid: 1 }); expect(c.counts.placeholders.DATE_ONLY).toBe(1);
  });
  it("a repeated market id is a duplicate, not a second market; placeholder shapes are counted by kind", () => {
    const m = usEvent({ id: "d", gs: Date.UTC(2026, 9, 6, 0) })[0]; const c = new GsCollector(); c.add(m); c.add(m); expect(c.counts).toMatchObject({ markets: 1, duplicates: 1 }); expect(c.counts.placeholders.MIDNIGHT_UTC).toBe(1);
  });
});

describe("Part A: the discriminator (rules fixed before the counts)", () => {
  const local = [...localSlate("a", 20, OCT5), ...localSlate("b", 15, NOV2)]; // 8 pm Eastern games in October (00:00Z) and November (01:00Z)
  const placeholder = [...midnightPlaceholders("a", 20, OCT5, { sport: "nfl" }), ...midnightPlaceholders("b", 15, NOV2, { sport: "nfl" })];
  it("local-time starts shift by one hour: 00:00Z before, 01:00Z after → LOCAL_TIME_SHIFT, with the counts", () => {
    const d = dstBySport(evs(local)).find((s) => s.sport === "sports:basketball")!; expect(d.EDT).toMatchObject({ events: 20, midnightEvents: 20, at0100Events: 0 }); expect(d.EST).toMatchObject({ events: 15, midnightEvents: 0, at0100Events: 15 }); expect(d.verdict).toBe("LOCAL_TIME_SHIFT"); expect(d.EST.clocks[0]).toMatchObject({ clock: "01:00:00", events: 15 });
  });
  it("a value that stays at 00:00Z on every date → FIXED_UTC_PLACEHOLDER", () => { const d = dstBySport(evs(placeholder)).find((s) => s.sport === "sports:american_football")!; expect(d.EDT.midnightEvents).toBe(20); expect(d.EST.midnightEvents).toBe(15); expect(d.EST.at0100Events).toBe(0); expect(d.verdict).toBe("FIXED_UTC_PLACEHOLDER"); });
  it("both worlds together are judged per sport, never pooled", () => { const v = dstBySport(evs([...local, ...placeholder.map((p) => ({ ...p, id: `p${p.id}` }))])); expect(v.find((s) => s.sport === "sports:basketball")!.verdict).toBe("LOCAL_TIME_SHIFT"); expect(v.find((s) => s.sport === "sports:american_football")!.verdict).toBe("FIXED_UTC_PLACEHOLDER"); });
  it("too few events after 1 Nov: INSUFFICIENT_AFTER, said explicitly with the count (9 < 10); 10 is enough", () => {
    const nine = dstBySport(evs([...localSlate("a", 20, OCT5), ...localSlate("b", 9, NOV2)]))[0]; expect(nine.verdict).toBe("INSUFFICIENT_AFTER"); expect(nine.why).toBe("only 9 events after the transition (< 10): too few to conclude"); expect(dstBySport(evs([...localSlate("a", 20, OCT5), ...localSlate("b", 10, NOV2)]))[0].verdict).toBe("LOCAL_TIME_SHIFT"); expect(MIN_AFTER_EVENTS).toBe(10);
    const only = analyse(evs(localSlate("a", 25, OCT5))); expect(only.eventsAfterTransition).toBe(0); expect(only.sampleNote).toContain("only 0 events fall after"); expect(only.dst[0].verdict).toBe("INSUFFICIENT_AFTER");
  });
  it("no cluster at 00:00Z before the transition: NO_MIDNIGHT_CLUSTER (4 < 5; 5 is a cluster)", () => {
    const mk = (n: number) => dstBySport(evs([...localSlate("a", n, OCT5), ...localSlate("c", 20 - n, OCT5, { hour: 19, minute: 30 }), ...localSlate("b", 15, NOV2)]))[0]; expect(mk(4).verdict).toBe("NO_MIDNIGHT_CLUSTER"); expect(mk(5).verdict).not.toBe("NO_MIDNIGHT_CLUSTER"); expect(MIN_BEFORE_MIDNIGHT).toBe(5);
  });
  it("the boundaries of the shift test: the cluster must persist at half its share (exactly 0.5 persists), and the 01:00Z share must exceed the 00:00Z share", () => {
    expect(dstVerdict({ events: 20, at00: 10 }, { events: 20, at00: 5, at01: 0 }).verdict).toBe("FIXED_UTC_PLACEHOLDER"); // 0.25 = 0.5 × 0.5 persists
    expect(dstVerdict({ events: 20, at00: 10 }, { events: 20, at00: 4, at01: 0 }).verdict).toBe("UNDETERMINED"); // 0.2 < 0.25
    expect(dstVerdict({ events: 20, at00: 10 }, { events: 20, at00: 0, at01: 5 }).verdict).toBe("LOCAL_TIME_SHIFT"); expect(dstVerdict({ events: 20, at00: 10 }, { events: 20, at00: 0, at01: 4 }).verdict).toBe("UNDETERMINED");
    expect(dstVerdict({ events: 20, at00: 10 }, { events: 20, at00: 6, at01: 6 }).verdict).toBe("FIXED_UTC_PLACEHOLDER"); expect(dstVerdict({ events: 20, at00: 10 }, { events: 20, at00: 5, at01: 6 }).verdict).toBe("LOCAL_TIME_SHIFT"); // a tie at 00:00Z = 01:00Z counts as fixed; 01:00Z ahead is a shift
  });
  it("by sport and market type: the 00:00Z events and markets before and after", () => {
    const rows = midnightByType(evs([...localSlate("a", 6, OCT5, { markets: 4 }), ...localSlate("b", 3, NOV2)])); const edtMl = rows.find((r) => r.marketType === "MONEYLINE" && r.period === "EDT")!; expect(edtMl).toMatchObject({ sport: "sports:basketball", events: 6 }); expect(rows.every((r) => r.period === "EDT")).toBe(true); // after the transition nothing is at 00:00Z
    expect(rows.reduce((a, r) => a + r.markets, 0)).toBe(24);
  });
  it("other clocks: a fixed 16:00Z clock does not shift; a local noon-Eastern clock (16:00Z, then 17:00Z) shifts with daylight saving; the other flagged clocks and the Eastern shapes are reported too", () => {
    const fixed = (p: string, n: number, start: number) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, sport: "nhl" as const, gs: start + i * DAY + 16 * H, markets: 1 }));
    const f = clockShifts(evs([...fixed("f", 20, OCT5), ...fixed("g", 15, NOV2)])).find((c) => c.clock === "16:00:00")!; expect(f).toMatchObject({ EDTevents: 20, ESTevents: 15, verdict: "FIXED_UTC" });
    const all = clockShifts(evs([...localSlate("l", 20, OCT5, { hour: 12 }), ...localSlate("m", 15, NOV2, { hour: 12 })])); const l = all.find((c) => c.clock === "16:00:00")!; expect(l).toMatchObject({ EDTevents: 20, ESTevents: 0, ESTshiftedShare: 1, verdict: "SHIFTS_WITH_DST" });
    expect(all.map((c) => c.clock)).toEqual(expect.arrayContaining(["00:00:00", "12:00:00", "16:00:00", "23:00:00", "19:30:00", "01:00:00", "Eastern 00:00:00", "Eastern 23:59:xx"])); expect(clockShifts(evs(localSlate("l", 20, OCT5, { hour: 12 }))).find((c) => c.clock === "16:00:00")!.verdict).toBe("INSUFFICIENT_AFTER");
  });
});

describe("Part A: clocks are judged per scope, never pooled across sports and other categories", () => {
  it("a world with local-time sports and UTC-midnight politics: the 00:00Z clock SHIFTS for sports and esports and is FIXED for the other categories", () => {
    const world = [...localSlate("a", 20, OCT5), ...localSlate("b", 15, NOV2), ...midnightPlaceholders("p", 20, OCT5), ...midnightPlaceholders("q", 15, NOV2)]; const clocks = analyse(evs(world)).clocks;
    const g = clocks.find((c) => c.scope === "sports and esports" && c.clock === "00:00:00")!, o = clocks.find((c) => c.scope === "other categories" && c.clock === "00:00:00")!; expect(g).toMatchObject({ EDTevents: 20, ESTevents: 0, verdict: "SHIFTS_WITH_DST" }); expect(o).toMatchObject({ EDTevents: 20, ESTevents: 15, verdict: "FIXED_UTC" });
    expect(clockShifts(evs(world)).find((c) => c.clock === "00:00:00")!.scope).toBe("all");
  });
});

describe("Part B: the per-event classification, at every boundary", () => {
  const base = (o: Partial<GsEvent> = {}): GsEvent => ({ id: "e", sport: "sports:basketball", category: "sports", marketType: "MONEYLINE", resolved: false, gsMs: Date.UTC(2026, 9, 6, 0), createdMs: null, resolvedMs: null, closes: [], scheduleMs: null, schedulePlaceholder: false, markets: 1, types: { MONEYLINE: 1 }, ...o });
  const t0 = Date.UTC(2026, 9, 6, 0);
  it("schedule agreement: 14 and 15 minutes agree (LIKELY_REAL), 16 differs (LIKELY_PLACEHOLDER); the sign does not matter", () => {
    for (const d of [0, 14, 15, -14, -15]) expect(classifyEvent(base({ scheduleMs: t0 + d * MIN })), `${d}`).toMatchObject({ label: "LIKELY_REAL", schedule: "agree" });
    for (const d of [16, -16, 120]) expect(classifyEvent(base({ scheduleMs: t0 + d * MIN })), `${d}`).toMatchObject({ label: "LIKELY_PLACEHOLDER", schedule: "differs" });
    expect(classifyEvent(base({ scheduleMs: t0 + 15 * MIN })).rule).toContain("schedule agrees (Δ 15 min ≤ 15)"); expect(classifyEvent(base({ scheduleMs: t0 + 16 * MIN })).rule).toContain("schedule differs (Δ 16 min > 15)");
  });
  it("a schedule that is absent or itself a placeholder is no evidence", () => { expect(classifyEvent(base()).label).toBe("UNDETERMINED"); expect(classifyEvent(base({ scheduleMs: t0, schedulePlaceholder: true })).schedule).toBe("none"); });
  it("resolution gap: 0 and 59 minutes and 6 h 1 min and 24 h are not decisive; exactly 1 h and exactly 6 h are real; below 0 and 24 h 1 min are placeholder evidence", () => {
    const g = (h: number) => classifyEvent(base({ resolved: true, resolvedMs: t0 + h * H })); for (const h of [1, 1.5, 6]) expect(g(h), `${h}`).toMatchObject({ label: "LIKELY_REAL", resolution: "real" });
    for (const h of [0, 59 / 60, 6 + 1 / 60, 12, 24]) expect(g(h), `${h}`).toMatchObject({ label: "UNDETERMINED", resolution: "none" }); for (const h of [-1 / 3600, -5, 24 + 1 / 60, 72]) expect(g(h), `${h}`).toMatchObject({ label: "LIKELY_PLACEHOLDER", resolution: "placeholder" });
    expect(g(-5).rule).toContain("resolution -5 h after the start"); expect(g(1).gapH).toBe(1); expect(classifyEvent(base({ resolved: false, resolvedMs: t0 + 2 * H })).resolution).toBe("none"); // an open event has no resolution evidence
  });
  it("market type and category: futures-like or a non-game category is placeholder evidence; a game-type market alone is not enough", () => {
    expect(classifyEvent(base({ marketType: "FUTURES" }))).toMatchObject({ label: "LIKELY_PLACEHOLDER", type: "placeholder" }); expect(classifyEvent(base({ category: "politics" }))).toMatchObject({ label: "LIKELY_PLACEHOLDER", type: "placeholder" }); expect(classifyEvent(base({ category: "esports" })).type).toBe("none"); expect(classifyEvent(base({ marketType: "(none)" })).type).toBe("none");
    expect(classifyEvent(base({ marketType: "CHAMPIONSHIP_FUTURES" })).type).toBe("placeholder");
  });
  it("conflicting evidence is UNDETERMINED with both sides in the rule; real evidence outweighs nothing it conflicts with", () => {
    const c = classifyEvent(base({ scheduleMs: t0 + 5 * MIN, category: "politics" })); expect(c.label).toBe("UNDETERMINED"); expect(c.rule).toMatch(/^conflict: schedule agrees .*; category politics is not a game category/);
    expect(classifyEvent(base({ scheduleMs: t0, resolved: true, resolvedMs: t0 + 2 * H })).rule).toBe("schedule agrees (Δ 0 min ≤ 15); resolution 2 h after the start (1–6 h)"); expect(classifyEvent(base({ scheduleMs: t0 + 40 * MIN, resolved: true, resolvedMs: t0 + 2 * H })).label).toBe("UNDETERMINED");
  });
  it("creation time and slate sharing are reported, not decisive: the label is the same with or without them", () => { const a = classifyEvent(base({ scheduleMs: t0 })), b = classifyEvent(base({ scheduleMs: t0, createdMs: t0 - 10 * MIN })); expect(a.label).toBe(b.label); });
  it("midnight group versus a same-size contrast sample at other clocks, deterministic, disjoint, spread over sports; the tallies by market type and category", () => {
    const world = [...midnightPlaceholders("p", 12, OCT5, { type: "FUTURES" }), ...localSlate("n", 30, OCT5, { sched: true }).map((s) => ({ ...s, gs: (s.gs as number) + 1 * H, schedule: (s.gs as number) + 1 * H })), ...localSlate("h", 8, OCT5, { sport: "nhl" }), ...localSlate("k", 6, OCT5, { sport: "nhl", hour: 19 })];
    const e = evs(world); const c = corroborate(e); const mid = e.filter((x) => new Date(x.gsMs).toISOString().slice(11, 19) === "00:00:00"); expect(c.midnight.all.events).toBe(mid.length); expect(c.control.sampleSize).toBe(mid.length); expect(c.control.all.events).toBe(mid.length);
    expect(corroborate(e)).toEqual(c); expect(c.byMarketType.find((x) => x.marketType === "FUTURES")).toMatchObject({ events: 12, atMidnight: 12, share: 1 }); expect(c.byCategory.find((x) => x.category === "politics")).toMatchObject({ share: 1 }); expect(c.byCategory.find((x) => x.category === "sports")!.atMidnight).toBe(8);
    expect(c.midnight.all.labels.LIKELY_PLACEHOLDER).toBe(12); expect(c.midnight.all.labels.LIKELY_REAL).toBe(8); expect(c.midnight.all.schedule.agree).toBe(8); expect(c.control.bySport.length).toBeGreaterThan(1);
  });
});

describe("Part C: the what-if leaves every real verdict unchanged", () => {
  const rawsOf = (specs: UsSpec[]): RawMarket[] => explode(specs.map((s) => ({ ...s, markets: 1 })));
  const audit = (raws: RawMarket[]) => { const ms = toAuditMarkets("polymarket_us", raws, { idOf: usIdOf, isResolved: usIsResolved, titleOf: usTitleOf, slugOf: (m) => String(m.slug), tagsOf, groupOf: usGroupOf }); return recommendSlots("polymarket_us", ms, buildInventory(ms)).find((r) => r.stratum === "sports:basketball" && r.slot === 1)!; };
  const RULES: [RegExp, string][] = [[/^present on/, "minEvents"], [/^usable share/, "usableShare"], [/^placeholder share/, "placeholderShare"], [/^one time of day/, "topClock"], [/^start ≤ resolution/, "orderedShare"], [/^median start/, "eventTypeGap"], [/within \d+ min of a creation/, "creationCoincidence"], [/^start ≤ \S+ \(\+/, "startBeforeClose"], [/^only \d+ resolved events/, "evidenceGap"]];
  const keys = (failed: string[]) => [...new Set(failed.map((f) => RULES.find(([re]) => re.test(f))?.[1] ?? `?${f}`))].sort();
  const world = (n: number, f: (i: number, s: UsSpec) => UsSpec = (_, s) => s): UsSpec[] => Array.from({ length: n }, (_, i) => { const gs = Date.UTC(2026, 8, 1) + i * 7 * H + 17 * MIN + (i % 4) * 15 * MIN; return f(i, { id: `g${i}`, gs, createdMs: gs - 5 * DAY, resolved: i % 2 === 1, resolvedMs: gs + 2.5 * H + (i % 7) * 5 * MIN, endDate: gs + 3 * H, schedule: gs }); });
  const SCENARIOS: [string, UsSpec[]][] = [
    ["clean", world(60)], ["a third are midnight placeholders", world(60, (i, s) => (i % 3 === 0 ? { ...s, gs: Date.UTC(2026, 8, 1 + (i % 20), 0), endDate: undefined } : s))], ["every resolved event starts after it resolves", world(60, (i, s) => (s.resolved ? { ...s, resolvedMs: (s.gs as number) - 3 * H } : s))],
    ["the start is the listing time", world(60, (_, s) => ({ ...s, createdMs: (s.gs as number) - 10 * MIN }))], ["too few events", world(20)], ["too few resolved events", world(60, (i, s) => ({ ...s, resolved: i < 20 && i % 2 === 1 }))], ["start after the close", world(60, (_, s) => ({ ...s, endDate: (s.gs as number) - 2 * H }))],
  ];
  for (const [name, specs] of SCENARIOS) it(`the baseline equals the real audit's verdict and failed rules: ${name}`, () => {
    const real = audit(rawsOf(specs)); const gs = evs(specs.map((s) => ({ ...s, markets: 1 }))); const mine = startCandidate(gs, "sports:basketball", (e) => e.gsMs); const cand = real.candidates!.find((c) => c.field === "gameStartTime")!;
    expect(mine.verdict, name).toBe(cand.verdict); expect(keys(mine.failed), name).toEqual([...new Set(cand.failedRules)].sort()); expect([...mine.failedKeys].sort(), name).toEqual([...new Set(cand.failedRules)].sort()); if (mine.usableShare !== null) expect(mine.usableShare).toBeCloseTo(cand.usableShare ?? 0, 3);
  });
  it("the scenarios cover pass, fail and insufficient (the comparison is not vacuous)", () => { const vs = SCENARIOS.map(([, s]) => audit(rawsOf(s)).candidates!.find((c) => c.field === "gameStartTime")!.verdict); expect(new Set(vs)).toEqual(new Set(["RECOMMEND", "UNRELIABLE_REJECT", "INSUFFICIENT_DATA"])); });
  it("exempting MIDNIGHT_UTC for chosen events raises the what-if usable share and can flip the verdict — in the what-if only", () => {
    const specs = world(60, (i, s) => (i % 3 === 0 ? { ...s, gs: Date.UTC(2026, 8, 1 + (i % 20), 0) } : s)).map((s) => ({ ...s, markets: 1 })); const e = evs(specs); const base = startCandidate(e, "sports:basketball", (x) => x.gsMs); const ex = startCandidate(e, "sports:basketball", (x) => x.gsMs, () => true);
    expect(base.verdict).toBe("UNRELIABLE_REJECT"); expect(base.usableShare).toBeCloseTo(40 / 60, 3); expect(ex.usableShare).toBe(1); expect(ex.placeholderShare).toBe(0); expect(ex.failed.some((f) => f.startsWith("usable share"))).toBe(false);
    const none = startCandidate(e, "sports:basketball", (x) => x.gsMs, () => false); expect(none).toEqual(base); const some = startCandidate(e, "sports:basketball", (x) => x.gsMs, (x) => x.id.endsWith("0")); expect(some.usableShare!).toBeGreaterThan(base.usableShare!); expect(some.usableShare!).toBeLessThan(1);
  });
  it("whatIf never changes the real audit: the real verdicts and RECOMMEND_RULES are identical before and after, and the events are not modified", () => {
    const specs = world(60, (i, s) => (i % 3 === 0 ? { ...s, gs: Date.UTC(2026, 8, 1 + (i % 20), 0) } : s)); const raws = rawsOf(specs); const before = JSON.stringify(audit(raws)); const rulesBefore = JSON.stringify(RECOMMEND_RULES); const e = evs(specs.map((s) => ({ ...s, markets: 1 }))); const snap = JSON.stringify(e);
    const w = whatIf(e); expect(JSON.stringify(audit(raws))).toBe(before); expect(JSON.stringify(RECOMMEND_RULES)).toBe(rulesBefore); expect(JSON.stringify(e)).toBe(snap); expect(w[0].baseline.verdict).toBe("UNRELIABLE_REJECT");
    expect(RECOMMEND_RULES).toEqual({ minPresent: 30, minUsableShare: 0.9, maxPlaceholderShare: 0.1, maxTopClockShare: 0.5, minOrderedShare: 0.99, minOrderedSamples: 30, startToleranceVsCloseMin: 15, minStartBeforeCloseShare: 0.95, maxCreationCoincidenceShare: 0.5, creationCoincidenceMin: 60, eventTypeMaxMedianGapHours: 24 });
  });
  it("per stratum: events at 00:00Z, how many are LIKELY_REAL and schedule-corroborated, and option (c): the schedule start as its own candidate with its own verdict", () => {
    const specs = [...localSlate("a", 40, OCT5, { resolved: true }), ...localSlate("b", 20, Date.UTC(2026, 9, 25), { resolved: false })]; const w = whatIf(evs(specs.map((s) => ({ ...s, markets: 1 }))))[0]; expect(w).toMatchObject({ stratum: "sports:basketball", events: 60 });
    expect(w.midnightEvents).toBeGreaterThan(0); expect(w.likelyRealEvents).toBe(w.midnightEvents); expect(w.scheduleAgreeEvents).toBe(w.midnightEvents); expect(w.baseline.verdict).toBe("UNRELIABLE_REJECT"); expect(w.likelyReal.usableShare).toBeGreaterThan(w.baseline.usableShare!); expect(w.schedule.verdict).toBe("UNRELIABLE_REJECT"); // the schedule start is the same instant, so it fails the same placeholder-shape rule: reported as measured
  });
});

describe("bounded memory: nothing the collector keeps grows with the listing", () => {
  it("the caps hold however long the listing is: ≤ maxMarkets market ids and ≤ maxEvents event records are kept, the run is flagged full, the rest is not retained", () => {
    const c = new GsCollector(1_000, 5_000); for (let i = 0; i < 60_000; i++) { c.add({ id: `m${i}`, slug: `nba-e${i}`, question: `Team ${i}a vs Team ${i}b`, gameStartTime: lenient(i), sportsMarketType: "MONEYLINE", event: { id: `e${i}` } }); }
    expect(c.counts.markets).toBeLessThanOrEqual(5_000); expect(c.events.size).toBeLessThanOrEqual(1_000); expect(c.counts.full).toBe(true); expect(c.counts.eventsDropped).toBeGreaterThan(0); const c2 = new GsCollector(1_000, 5_000); for (let i = 0; i < 6_000; i++) c2.add({ id: `m${i}`, question: "x", gameStartTime: lenient(i), event: { id: `e${i}` } }); expect(c2.events.size).toBe(c.events.size);
  });
  it("40,000 markets of about 2 KB each (80 MB if kept) leave the heap almost where it was: the market objects are not retained", () => {
    collectGarbage(); const before = process.memoryUsage().heapUsed; const c = new GsCollector(12_000, 40_000);
    for (let i = 0; i < 40_000; i++) c.add({ id: `m${i}`, slug: `nba-e${i % 9000}`, question: `Team ${i % 9000}a vs Team ${i % 9000}b`, description: "d".repeat(1500), gameStartTime: lenient(Date.UTC(2026, 9, 6) + (i % 9000) * H), sportsMarketType: "TOTAL", rules: "r".repeat(500), event: { id: `e${i % 9000}`, title: "t".repeat(400) } });
    collectGarbage(); const grown = (process.memoryUsage().heapUsed - before) / 1_048_576; expect(c.counts.markets).toBe(40_000); expect(c.events.size).toBe(9000); expect(grown).toBeLessThan(25);
  });
  it("an event with thousands of markets is one record: its markets are counted, not kept", () => { const c = new GsCollector(); for (let i = 0; i < 5_000; i++) c.add({ id: `m${i}`, question: "x", gameStartTime: lenient(Date.UTC(2026, 9, 6)), sportsMarketType: i % 2 ? "SPREAD" : "TOTAL", event: { id: "one" } }); const e = [...c.events.values()]; expect(e).toHaveLength(1); expect(e[0].markets).toBe(5_000); expect(Object.keys(e[0].types).sort()).toEqual(["SPREAD", "TOTAL"]); });
  it("the clock table is bounded by the clock values, not by the listing: analysing 10,000 events with 24 distinct clocks keeps 8 cells per period", () => { const specs = Array.from({ length: 10_000 }, (_, i) => ({ id: `x${i}`, sport: "nba" as const, gs: Date.UTC(2026, 9, 6, i % 24, 0), markets: 1 })); const a = analyse(evs(specs)); expect(a.dst[0].EDT.clocks.length).toBeLessThanOrEqual(8); });
});
