/**
 * Phase 4.0d, Part E — the weak spots the 4.0c mutation checker found (survivors with no test): G2 (display order of candidates), Q9 (near-miss similarity
 * range), U12 (an `ended` event counted as agreeing when only one of event and markets is resolved), U22 (targeted ENDED markets must reach the resolved side of
 * the audit) and X2 (thin strata listed before informative ones in S1_COMPACT.md). Each test fails when its mutation is applied (`npm run phase4:mutations`).
 */
import { describe, expect, it } from "vitest";
import { buildInventory, recommendSlots, toAuditMarkets, type RawMarket } from "../src/lib/phase4/audit";
import { EXIT, runTimestampAuditCli } from "../src/lib/phase4/cli";
import { renderCompact } from "../src/lib/phase4/compact";
import { pickExamples, type TitleSearchRow } from "../src/lib/phase4/title-search";
import { inPlayReliability, type EventFlagRow } from "../src/lib/phase4/us-sports";
import { gammaGroupOf, gammaIdOf, gammaIsResolved, gammaTitleOf, tagsOf } from "../src/lib/phase4/venues";
import type { SlotVerdict } from "../src/lib/phase4/audit";
import { fakeFetch, json, virtualClock } from "./helpers/phase4Db";

describe("G2: the best passing candidate is listed first, even when another passing candidate is present on more events", () => {
  const Z = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"); const BASE = Date.UTC(2026, 9, 5);
  // 60 events, one market each. `endDate` is present on 58 events, all usable; `closeTime` on all 60, but 6 of them are date-only placeholders (exactly the 10 % allowed).
  // Both fields pass every slot-2 rule; the best one is the field with MORE USABLE values (endDate: 58 > 54) although it is present on FEWER events (58 < 60).
  const raws: RawMarket[] = Array.from({ length: 60 }, (_, i) => { const t = BASE + i * 7 * 3_600_000 + 17 * 60_000 + (i % 4) * 15 * 60_000; const m: RawMarket = { conditionId: `0x${i}`, question: `Will thing ${i} happen`, slug: `thing-${i}`, closed: false, events: [{ id: `ev${i}` }], closeTime: i < 6 ? Z(t).slice(0, 10) : Z(t) }; if (i >= 2) m.endDate = Z(t + 3_600_000); return m; });
  const ms = toAuditMarkets("v", raws, { idOf: gammaIdOf, isResolved: gammaIsResolved, titleOf: gammaTitleOf, slugOf: (m) => String(m.slug), tagsOf, groupOf: gammaGroupOf });
  const v = recommendSlots("v", ms, buildInventory(ms)).find((r) => r.slot === 2)!;
  it("both candidates pass, the best is the one with more usable values, and it is first in the list", () => {
    const c = Object.fromEntries(v.candidates!.map((x) => [x.field, x])); expect(c.endDate).toMatchObject({ verdict: "RECOMMEND", presentEvents: 58, best: true }); expect(c.closeTime).toMatchObject({ verdict: "RECOMMEND", presentEvents: 60, best: false });
    expect(c.endDate.usableShare).toBeCloseTo(58 / 60, 3); expect(c.closeTime.usableShare).toBeCloseTo(54 / 60, 3); expect(v.bestField).toBe("endDate");
    expect(v.candidates!.map((x) => x.field)).toEqual(["endDate", "closeTime"]); // best first, although closeTime is present on more events (the next sort key)
  });
});

describe("Q9: the near-misses start at similarity 0.5", () => {
  const rowOf = (title: string, score: number): TitleSearchRow => ({ pair: { conditionId: title, tokenId: "t", title, slug: null, outcome: "Yes", stratum: "x", score: 80, signals: 1, wallet: "0xw" }, query: "q", error: null, diag: { confidence: "NONE", verified: false, dateChecked: false, identifierMatch: false, best: { marketId: `m-${title}`, question: `venue ${title}`, slug: null, url: null, categories: [], stratum: "x", outcomes: [], times: [], rules: null, titleSimilarity: score, participantSimilarity: 0, sameParticipants: false, numbersAgree: true, negationsAgree: true, outcomeMatch: true, categoryMatch: null, identifierMatch: false, score }, top: [], band: "0.30–0.50", candidatesByBand: {}, candidatesGenerated: 1, evidence: [] } });
  it("0.50 is a near-miss, 0.49 and 0.30 are not, a PROBABLE row is never a near-miss, and they are listed highest first", () => {
    const rows = [rowOf("a", 0.5), rowOf("b", 0.49), rowOf("c", 0.3), rowOf("d", 0.7), rowOf("e", 0.45), { ...rowOf("f", 0.95), diag: { ...rowOf("f", 0.95).diag!, confidence: "PROBABLE" as const } }];
    const { best, near } = pickExamples(rows, 1, 10); expect(near.map((r) => r.pair.title)).toEqual(["d", "a"]); expect(best[0].pair.title).toBe("f"); expect(near.map((r) => r.diag!.best!.score)).toEqual([0.7, 0.5]);
  });
});

describe("U12: an `ended` event agrees with its markets only when ALL of them are resolved", () => {
  const row = (id: string, o: Partial<EventFlagRow>): EventFlagRow => ({ id, startMs: null, live: false, ended: true, allMarketsResolved: true, anyMarketResolved: true, ...o });
  it("an ended event with only some markets resolved counts as 'any market open', not as agreeing", () => {
    const r = inPlayReliability([row("a", {}), row("b", { allMarketsResolved: false, anyMarketResolved: true }), row("c", { allMarketsResolved: false, anyMarketResolved: false }), row("d", { ended: false, allMarketsResolved: true })], Date.parse("2026-10-03T00:00:00Z"));
    expect(r.ended).toMatchObject({ flagged: 3, allMarketsResolved: 1, anyMarketOpen: 2, resolvedButNotFlagged: 1, resolvedEvents: 2 });
  });
});

describe("U22: markets of targeted ENDED events reach the resolved side of the audit", () => {
  const lenient = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "+00"); const Z = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const ended = Array.from({ length: 45 }, (_, i) => { const kick = Date.UTC(2026, 8, 20) + i * 7 * 3_600_000 + 17 * 60_000 + (i % 4) * 15 * 60_000; const id = `e${i}`;
    return { id, slug: `nba-${id}`, title: `Team ${id}a vs Team ${id}b`, startDate: Z(kick - 5 * 86_400_000), live: false, ended: true, markets: [0, 1].map((k) => ({ id: `${id}-m${k}`, slug: `nba-${id}-m${k}`, question: k ? `Team ${id}a vs Team ${id}b: TOTAL` : `Team ${id}a vs Team ${id}b`, outcomes: '["Yes","No"]', gameStartTime: lenient(kick), closed: true, status: "settled", closedTime: lenient(kick + 2.5 * 3_600_000) })) }; });
  // the venue's generic listing holds NO resolved market: the only resolved markets come from the sports API's ended events
  const handler = (u: URL): Response => {
    if (u.host !== "gateway.polymarket.us") return new Response("no", { status: 404 });
    if (u.pathname === "/v2/sports") return json({ sports: [{ slug: "nba" }] }); if (u.pathname === "/v2/leagues") return json({ leagues: [] });
    if (u.pathname === "/v2/sports/nba/events") { const end = u.searchParams.get("closed") === "true"; const off = Number(u.searchParams.get("offset") ?? 0); return json({ events: end ? ended.slice(off, off + 100) : [] }); }
    if (u.pathname === "/v1/markets") return json({ markets: [] }); return new Response("no", { status: 404 });
  };
  it("the audit's resolved sample holds the targeted ended markets, and the per-candidate verdict has the ordering evidence it needs", async () => {
    const c = virtualClock(Date.parse("2026-10-03T00:00:00Z")); const f = fakeFetch(handler, c.now); const out: Record<string, string> = {};
    const code = await runTimestampAuditCli(["--venue", "polymarket_us", "--no-fixtures"], {}, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: (p, x) => { out[p] = x; }, mkdir() {}, log() {} }); expect(code).toBe(EXIT.OK);
    const a = JSON.parse(out["docs/phase4/data/v_polymarket_us_audit.json"]).audit; expect(a.counts.resolved).toBeGreaterThanOrEqual(45); expect(a.counts.open).toBe(0);
    const s1 = a.recommendations.find((r: SlotVerdict) => r.stratum === "sports:basketball" && r.slot === 1); expect(s1.bestField).toBe("gameStartTime"); expect(s1.candidates.find((x: any) => x.field === "gameStartTime").verdict).toBe("RECOMMEND");
  });
});

describe("X2: informative rows come before thin strata in S1_COMPACT.md, whatever the venue order", () => {
  const rec = (venue: string, stratum: string, events: number, field: string | null): SlotVerdict => ({ venue, stratum, slot: 1, field, verdict: field ? "RECOMMEND" : "INSUFFICIENT_DATA", usableShare: 1, presentShare: 1, placeholderShare: 0, failed: [], evidence: {}, needsHumanReview: false, events, markets: events, etPlaceholderShare: 0, decidedBy: field ? "allPassed" : "minEvents", failedRules: [], bestField: field });
  it("a Kalshi row with 40 events is listed before a US row with 5 (the US venue sorts first by name)", () => {
    const text = renderCompact({ s1a: { startedAt: "a", finishedAt: "b", venues: [{ venue: "polymarket_us", reachable: true, recommendations: [rec("polymarket_us", "thin", 5, null)] }, { venue: "kalshi", reachable: true, recommendations: [rec("kalshi", "informative", 40, "close_time")] }] }, funnels: [] });
    const lines = text.split("\n"); const inf = lines.findIndex((l) => l.includes("| informative |")), thin = lines.findIndex((l) => l.includes("| thin |")); expect(inf).toBeGreaterThan(-1); expect(thin).toBeGreaterThan(-1); expect(inf).toBeLessThan(thin);
  });
  it("thin strata are the ones dropped first when the 80-line limit bites", () => {
    const venues = [{ venue: "polymarket_us", reachable: true, recommendations: Array.from({ length: 90 }, (_, i) => rec("polymarket_us", `thin${i}`, 3, null)) }, { venue: "kalshi", reachable: true, recommendations: [rec("kalshi", "informative", 40, "close_time")] }];
    const text = renderCompact({ s1a: { startedAt: "a", finishedAt: "b", venues }, funnels: [] }); expect(text.trim().split("\n").length).toBeLessThanOrEqual(80); expect(text).toContain("| informative |"); expect(text).toMatch(/… \d+ more rows/);
  });
});
