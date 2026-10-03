/**
 * Phase 4.0 — placeholder detection and the S1a analysis, on real-FORMAT fixtures (tests/fixtures/phase4/README.md:
 * the shapes follow what Gamma returns, the values are synthetic with known answers).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RECOMMEND_RULES, buildInventory, candidateEvidence, compareVenues, flatten, formatOf, instantOf, isTimeLike, recommendSlots, relation, stratifiedSample, toAuditMarkets, type RawMarket } from "../src/lib/phase4/audit";
import { placeholderKind, repeatedInstants, timeOfDayProfile } from "../src/lib/phase4/timestamps";
import { gammaGroupOf, gammaIdOf, gammaIsResolved, gammaTitleOf, tagsOf } from "../src/lib/phase4/venues";

const gamma = JSON.parse(readFileSync("tests/fixtures/phase4/synthetic_gamma_markets.json", "utf8")) as RawMarket[];
const markets = toAuditMarkets("polymarket_intl", gamma, { idOf: gammaIdOf, isResolved: gammaIsResolved, titleOf: gammaTitleOf, slugOf: (m) => String(m.slug), tagsOf, groupOf: gammaGroupOf });

describe("placeholderKind", () => {
  it("flags date-only values and exact 00:00:00 / 12:00:00 / 23:59:59 UTC, in every spelling of the same instant", () => {
    expect(placeholderKind("2026-10-05")).toBe("DATE_ONLY");
    expect(placeholderKind("2026-10-05T00:00:00Z")).toBe("MIDNIGHT_UTC");
    expect(placeholderKind("2026-10-05T00:00:00.000Z")).toBe("MIDNIGHT_UTC");
    expect(placeholderKind("2026-10-05 00:00:00+00")).toBe("MIDNIGHT_UTC");
    expect(placeholderKind("2026-10-04T20:00:00-04:00")).toBe("MIDNIGHT_UTC"); // the same instant as 00:00Z
    expect(placeholderKind("2026-10-05T12:00:00Z")).toBe("NOON_UTC");
    expect(placeholderKind("2026-10-05T23:59:59Z")).toBe("END_OF_DAY_UTC");
    expect(placeholderKind("2026-10-05T23:59:59.999Z")).toBe("END_OF_DAY_UTC");
  });
  it("flags a wall-clock midnight / end of day written with a non-UTC offset", () => {
    expect(placeholderKind("2026-10-05T00:00:00-04:00")).toBe("LOCAL_MIDNIGHT");
    expect(placeholderKind("2026-10-05T23:59:59-04:00")).toBe("LOCAL_END_OF_DAY");
  });
  it("does not flag ordinary times, including near misses", () => {
    for (const v of ["2026-10-05T19:30:00Z", "2026-10-05T00:00:01Z", "2026-10-05T12:00:01Z", "2026-10-05T11:59:59Z", "2026-10-05T23:59:00Z", "2026-10-05T00:15:00Z", null, "garbage"]) expect(placeholderKind(v), String(v)).toBeNull();
  });
});

describe("timeOfDayProfile / repeatedInstants", () => {
  it("counts date-only, datetime and missing values and ranks times of day", () => {
    const p = timeOfDayProfile(["2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z", "2026-10-07T19:00:00Z", "2026-10-08", null, "x"]);
    expect(p).toMatchObject({ total: 6, missing: 1, dateOnly: 1, datetime: 3, other: 1 });
    expect(p.byClock[0]).toMatchObject({ clock: "00:00:00", count: 2 }); expect(p.byClock[0].share).toBeCloseTo(2 / 3);
  });
  it("finds one instant shared by many UNRELATED markets, but not by markets of one event", () => {
    const same = "2026-10-05T18:00:00Z"; const items = [...Array.from({ length: 6 }, (_, i) => ({ group: `event-${i}`, raw: same })), ...Array.from({ length: 9 }, () => ({ group: "one-event", raw: "2026-10-06T10:00:00Z" })), { group: "solo", raw: "2026-10-07T10:00:00Z" }];
    const r = repeatedInstants(items); expect(r).toHaveLength(1); expect(r[0]).toMatchObject({ instant: "2026-10-05T18:00:00.000Z", count: 6, distinctGroups: 6 });
    expect(repeatedInstants(items, { minCount: 7 })).toHaveLength(0);
  });
});

describe("flatten / isTimeLike / formatOf", () => {
  it("flattens nested objects and the first element of object arrays, skipping scalar arrays", () => {
    const f = flatten({ a: 1, b: { c: "x", d: { e: 2 } }, events: [{ startTime: "t1" }, { startTime: "t2" }], tags: ["x", "y"] });
    expect(f).toEqual({ a: 1, "b.c": "x", "b.d.e": 2, "events[].startTime": "t1" });
  });
  it("treats a string that starts like a date as time-like, and a number only under a time-like name", () => {
    expect(isTimeLike("x", "2026-10-05T10:00:00Z")).toBe(true); expect(isTimeLike("x", "2026-10-05")).toBe(true); expect(isTimeLike("x", "hello")).toBe(false); expect(isTimeLike("x", "12345.6")).toBe(false);
    expect(isTimeLike("startTs", 1_790_000_000)).toBe(true); expect(isTimeLike("volume", 1_790_000_000)).toBe(false);
  });
  it("labels each format", () => {
    expect(formatOf("2026-10-05")).toBe("date_only"); expect(formatOf("2026-10-05T10:00:00Z")).toBe("datetime_utc"); expect(formatOf("2026-10-05T10:00:00-04:00")).toBe("datetime_offset");
    expect(formatOf("2026-10-05 10:00:00+00")).toBe("datetime_lenient"); expect(formatOf("2026-10-05T10:00:00")).toBe("datetime_no_offset"); expect(formatOf(1_790_000_000)).toBe("epoch_s"); expect(formatOf("zzz")).toBe("invalid");
    expect(instantOf("2026-10-05")).toBeNull(); expect(instantOf("2026-10-05T10:00:00Z")).toBe(Date.parse("2026-10-05T10:00:00Z"));
  });
});

describe("buildInventory on the synthetic Gamma-shaped sample", () => {
  const inv = buildInventory(markets); const by = (p: string) => inv.find((f) => f.path === p)!;
  it("finds every time-like field, with names, formats and presence by stratum", () => {
    expect(inv.map((f) => f.path)).toEqual(expect.arrayContaining(["createdAt", "startDate", "gameStartTime", "endDate", "endDateIso", "closedTime", "umaEndDate", "updatedAt", "events[].startTime", "events[].endDate"]));
    expect(by("gameStartTime").formats).toEqual({ datetime_lenient: 62 + 64 + 64 });   // basketball + soccer + esports
    expect(by("gameStartTime").presence.byStratum["sports:basketball"]).toMatchObject({ present: 62, total: 62, rate: 1 });
    expect(by("gameStartTime").presence.byStratum["politics"].present).toBe(0);
    expect(by("endDateIso").formats).toEqual({ date_only: 382 });
    expect(by("startDate").precision.fraction).toBe(382);
    expect(by("startDate").offsets).toEqual({ "+00:00": 382 });
  });
  it("counts placeholders: endDate is midnight UTC on every sports, esports and deadline-type market, never on short-term crypto", () => {
    const e = by("endDate"); expect(e.placeholders.MIDNIGHT_UTC).toBe(382 - 64);          // all but the 64 crypto markets
    expect(e.placeholderShare).toBeCloseTo(318 / 382); expect(e.timeOfDay.topClocks[0]).toMatchObject({ clock: "00:00:00", count: 318 });
    expect(by("gameStartTime").placeholders).toEqual({}); expect(by("gameStartTime").placeholderShare).toBe(0);
    expect(by("endDateIso").placeholders.DATE_ONLY).toBe(382); expect(by("endDateIso").placeholderShare).toBe(1);
  });
  it("only resolved markets carry closedTime and umaEndDate", () => { expect(by("closedTime").presence.overall.present).toBe(markets.filter((m) => m.resolved).length); expect(by("umaEndDate").role).toBe("RESOLUTION_LIKE"); });
});

describe("relations and recommendations (explicit RECOMMEND_RULES)", () => {
  const inv = buildInventory(markets);
  it("relation: signed difference in minutes, ordering counts, within one hour", () => {
    const r = relation([{ a: 0, b: 60_000 }, { a: 0, b: 0 }, { a: 120_000, b: 0 }, { a: 0, b: 7_200_000 }]);
    expect(r).toMatchObject({ n: 4, before: 2, equal: 1, after: 1, within1hShare: 0.75, p50Min: 0.5 });
  });
  it("evidence: gameStartTime is never after the venue's closedTime; startDate (a listing time) is days before it", () => {
    const ev = candidateEvidence(markets.filter((m) => m.stratum === "sports:basketball"), inv);
    const g = ev.find((e) => e.path === "gameStartTime")!.vsReference.closedTime; expect(g.after).toBe(0); expect(g.p50Min!).toBeGreaterThan(100); expect(g.p50Min!).toBeLessThan(400);
    const s = ev.find((e) => e.path === "startDate")!.vsReference.closedTime; expect(s.p50Min!).toBeGreaterThan(3 * 24 * 60);
  });
  const recs = recommendSlots("polymarket_intl", markets, inv); const pick = (st: string, slot: 1 | 2) => recs.find((r) => r.stratum === st && r.slot === slot)!;
  it("slot 1 for sports and esports: an event-start field is recommended; the listing-time startDate is not", () => {
    for (const st of ["sports:basketball", "sports:soccer", "esports"]) { const r = pick(st, 1); expect(r.verdict, st).toBe("RECOMMEND"); expect(["gameStartTime", "events[].startTime"]).toContain(r.field); expect(r.usableShare).toBe(1); }
  });
  it("slot 1 for short-term crypto and politics: no start-like field passes → unreliable: reject (the listing time is not an event start)", () => {
    expect(pick("crypto_short_term", 1).verdict).toBe("UNRELIABLE_REJECT"); expect(pick("crypto_short_term", 1).failed.join(" ")).toMatch(/median start→resolution/);
    expect(pick("politics", 1).verdict).toBe("UNRELIABLE_REJECT");
  });
  it("slot 2: a midnight-placeholder endDate is rejected for sports and deadline-type markets; a real deadline with a time of day is recommended for short-term crypto (with a human-review flag)", () => {
    for (const st of ["sports:basketball", "esports", "politics", "culture_other"]) { const r = pick(st, 2); expect(r.verdict, st).toBe("UNRELIABLE_REJECT"); expect(r.placeholderShare, st).toBeGreaterThan(RECOMMEND_RULES.maxPlaceholderShare); }
    const c = pick("crypto_short_term", 2); expect(c).toMatchObject({ verdict: "RECOMMEND", needsHumanReview: true }); expect(["endDate", "events[].endDate"]).toContain(c.field);
  });
  it("reports lenient formats so the consumer knows to accept them for that field", () => { expect(pick("sports:basketball", 1).evidence.lenientFormatShare).toBeDefined(); });
  it("insufficient data is reported as such, not as a verdict", () => {
    const few = markets.filter((m) => m.stratum === "esports").slice(0, 10); const r = recommendSlots("polymarket_intl", few, buildInventory(few)).find((x) => x.slot === 1)!; expect(r.verdict).toBe("INSUFFICIENT_DATA");
  });
});

describe("compareVenues and stratifiedSample", () => {
  it("summarises the absolute start-time disagreement by stratum with percentiles and shares within 15 and 60 minutes", () => {
    const pairs = [0, 0, 5, -5, 10, -10, 20, -30, 0, 90].map((d) => ({ stratum: "sports:basketball", aMs: 0, bMs: d * 60_000 }));
    const [s] = compareVenues(pairs); expect(s).toMatchObject({ stratum: "sports:basketball", n: 10, maxAbsMin: 90, within15MinShare: 0.7, within60MinShare: 0.9 }); expect(s.absP50Min).toBe(7.5); expect(s.signedP50Min).toBe(0);
  });
  it("stratifiedSample goes round-robin over the strata, caps each stratum, never exceeds the total, and is deterministic", () => {
    const items = [...Array.from({ length: 10 }, (_, i) => ({ stratum: "a", i })), ...Array.from({ length: 3 }, (_, i) => ({ stratum: "b", i }))];
    const s = stratifiedSample(items, 2, 6); expect(s.map((x) => `${x.stratum}${x.i}`)).toEqual(["a0", "b0", "a1", "b1", "a2", "a3"]); expect(stratifiedSample(items, 2, 6)).toEqual(s);
    const many = Array.from({ length: 10 }, (_, k) => Array.from({ length: 5 }, (_, i) => ({ stratum: `s${k}`, i }))).flat(); const m = stratifiedSample(many, 3, 12);
    expect(m).toHaveLength(12); expect(new Set(m.map((x) => x.stratum)).size).toBe(10); // every stratum is represented before any gets a second market
    expect(stratifiedSample(items, 5, 100)).toHaveLength(13); expect(stratifiedSample([], 2, 5)).toEqual([]);
  });
});

describe("each recommendation rule on its own (thresholds can be overridden so one rule is isolated)", () => {
  // 80 basketball markets, 40 resolved; kick-offs and times of day are never placeholder shapes
  const base = Date.parse("2026-09-01T07:17:00Z"); const at = (i: number, plusMin: number, plusSec = 0) => new Date(base + i * 3 * 3_600_000 + plusMin * 60_000 + plusSec * 1000).toISOString();
  const build = (f: (i: number, resolved: boolean) => RawMarket) => toAuditMarkets("v", Array.from({ length: 80 }, (_, i) => ({ conditionId: `0x${i}`, slug: `nba-x-${i}`, question: `Team ${i} vs Other`, closed: i % 2 === 1, ...f(i, i % 2 === 1) })), { idOf: gammaIdOf, isResolved: gammaIsResolved, titleOf: gammaTitleOf, slugOf: (m) => String(m.slug), tagsOf, groupOf: gammaGroupOf });
  const verdict = (ms: ReturnType<typeof build>, slot: 1 | 2, rules = {}) => recommendSlots("v", ms, buildInventory(ms), rules).find((r) => r.stratum === "sports:basketball" && r.slot === slot)!;
  const good = (i: number, resolved: boolean): RawMarket => ({ gameStartTime: at(i, 0), endDate: at(i, 0, 13).replace(/:\d\d\.\d{3}Z$/, ":13Z"), ...(resolved ? { closedTime: at(i, 150) } : {}) });
  it("a well-behaved field is recommended for both slots (the control for every case below)", () => { const ms = build((i, r) => ({ ...good(i, r), endDate: at(i, 180, 13) })); expect(verdict(ms, 1)).toMatchObject({ verdict: "RECOMMEND", field: "gameStartTime" }); expect(verdict(ms, 2)).toMatchObject({ verdict: "RECOMMEND", field: "endDate" }); });
  it("ordering: a start after the resolution time in 10 % of resolved markets is rejected (needs ≥ 99 % ordered)", () => {
    const ms = build((i, r) => ({ ...good(i, r), endDate: at(i, 180, 13), gameStartTime: r && i % 20 === 1 ? at(i, 200) : at(i, 0) }));  // 4 of 40 resolved start after closedTime
    const v = verdict(ms, 1); expect(v.verdict).toBe("UNRELIABLE_REJECT"); expect(v.failed.join()).toMatch(/start ≤ resolution in 90\.0 %/);
  });
  it("start versus a close time that has a real time of day: a start after the close in half the markets is rejected", () => {
    const ms = build((i, r) => ({ ...good(i, r), endDate: i % 2 ? at(i, 180, 13) : at(i, -60, 13) })); const v = verdict(ms, 1); expect(v.verdict).toBe("UNRELIABLE_REJECT"); expect(v.failed.join()).toMatch(/start ≤ endDate/);
  });
  it("top time of day: one time of day on most values (a hidden placeholder that is not midnight, noon or 23:59:59) is rejected", () => {
    const ms = build((i, r) => ({ ...good(i, r), endDate: new Date(Date.UTC(2026, 8, 1 + Math.floor(i / 2), 18, 30, 0)).toISOString() })); const v = verdict(ms, 2); expect(v.verdict).toBe("UNRELIABLE_REJECT"); expect(v.failed.join()).toMatch(/one time of day \(18:30:00\)/); expect(v.placeholderShare).toBe(0); expect(v.usableShare).toBe(1);
  });
  it("placeholder share alone: with the other value rules switched off, 30 % midnight values still reject the field", () => {
    const ms = build((i, r) => ({ ...good(i, r), endDate: i % 10 < 3 ? new Date(Date.UTC(2026, 8, 1 + (i % 28), 0, 0, 0)).toISOString() : at(i, 180, 13) }));
    const v = verdict(ms, 2, { minUsableShare: 0, maxTopClockShare: 1 }); expect(v.verdict).toBe("UNRELIABLE_REJECT"); expect(v.failed.join()).toMatch(/placeholder share/); expect(v.failed.join()).not.toMatch(/usable share/);
  });
  it("usable share alone: with the other value rules switched off, a field missing from 40 % of the markets is rejected", () => {
    const ms = build((i, r) => ({ ...good(i, r), ...(i % 5 < 2 ? { endDate: undefined } : { endDate: at(i, 180, 13) }) })); const v = verdict(ms, 2, { maxPlaceholderShare: 1, maxTopClockShare: 1 });
    expect(v.verdict).toBe("UNRELIABLE_REJECT"); expect(v.failed.join()).toMatch(/usable share 60\.0 %/);
  });
  it("too few markets with the field: insufficient data, not a verdict", () => { const ms = build((i, r) => ({ ...good(i, r), endDate: i < 10 ? at(i, 180, 13) : undefined })); expect(verdict(ms, 2).verdict).toBe("INSUFFICIENT_DATA"); });
  it("a start-like field with no resolved markets to compare against cannot be recommended: the meaning is not established", () => {
    const ms = build((i) => ({ gameStartTime: at(i, 0), endDate: at(i, 180, 13) })); const v = verdict(ms.map((m) => ({ ...m, resolved: false })), 1); expect(v.verdict).toBe("INSUFFICIENT_DATA"); expect(v.failed.join()).toMatch(/meaning not established/);
  });
});
