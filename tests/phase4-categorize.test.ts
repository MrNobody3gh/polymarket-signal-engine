/** Phase 4.0 — the stratification heuristic and the probe's two venue helpers (tradability, event time). */
import { describe, expect, it } from "vitest";
import { categorize, stratum } from "../src/lib/phase4/categorize";
import { eventTimeAt, tradableAt } from "../src/lib/phase4/probe";
import type { SlotVerdict } from "../src/lib/phase4/audit";

describe("categorize (heuristic; basis recorded)", () => {
  const c = (title: string, slug?: string, tags?: string[]) => stratum(categorize({ title, slug, tags }));
  it("sports by sport, from the slug prefix or the title", () => {
    expect(c("Lakers vs. Celtics", "nba-lal-bos-2026-10-05")).toBe("sports:basketball"); expect(c("Chiefs vs. Bills", "nfl-kc-buf")).toBe("sports:american_football"); expect(c("Arsenal vs Chelsea - Premier League")).toBe("sports:soccer");
    expect(c("Sinner vs Alcaraz", "atp-sinner-alcaraz")).toBe("sports:tennis"); expect(c("UFC 320: Jones vs Aspinall")).toBe("sports:combat"); expect(c("Who wins the Ryder Cup?")).toBe("sports:golf");
  });
  it("esports before sports, so a 'vs' match in League of Legends is not a generic sport", () => { expect(c("T1 vs Gen.G - League of Legends BO3")).toBe("esports"); expect(c("NAVI vs FaZe - CS2 Major", "cs2-navi-faze")).toBe("esports"); });
  it("crypto: short-term price questions are separated from other crypto questions", () => {
    expect(c("Bitcoin up or down - 5:15 PM ET", "btc-updown-15m-1")).toBe("crypto_short_term"); expect(c("Will Bitcoin hit $150k in 2026?")).toBe("crypto_other"); expect(c("Ethereum above $4,000 on October 5?")).toBe("crypto_short_term");
  });
  it("politics and everything else", () => { expect(c("Will Trump sign the bill by October 31?")).toBe("politics"); expect(c("Senate election 2026: who wins Ohio?")).toBe("politics"); expect(c("Will the movie gross over $100M opening weekend?")).toBe("culture_other"); expect(c("")).toBe("culture_other"); });
  it("venue tags win over keywords, and the basis is reported", () => {
    expect(categorize({ title: "Something unrelated", slug: "x", tags: ["Politics", "Elections"] })).toEqual({ category: "politics", sport: null, basis: "tags" });
    expect(categorize({ title: "x", tags: ["Esports"] }).category).toBe("esports"); expect(categorize({ title: "Lakers vs Celtics", slug: "nba-a-b" }).basis).toBe("slug"); expect(categorize({ title: "movie" }).basis).toBe("default");
  });
});

describe("tradableAt (approximation, documented)", () => {
  const eval1 = Date.parse("2026-10-02T12:00:00Z");
  it("open now → tradable; resolved after the evaluation time → tradable then; resolved before → not; resolved with no time → unknown (null)", () => {
    expect(tradableAt({ status: "open" }, eval1)).toBe(true);
    expect(tradableAt({ status: "settled", settledAt: "2026-10-02T15:00:00+00:00" }, eval1)).toBe(true);
    expect(tradableAt({ status: "settled", settledAt: "2026-10-02T11:59:59+00:00" }, eval1)).toBe(false);
    expect(tradableAt({ status: "settled" }, eval1)).toBeNull();
    expect(tradableAt({ closed: true, closedTime: "2026-10-02T12:00:00Z" }, eval1)).toBe(true); // exactly at the evaluation time: still open then
  });
});

describe("eventTimeAt (the §3.3 pipeline under the audit's recommended fields)", () => {
  const rec = (slot: 1 | 2, field: string): SlotVerdict => ({ venue: "v", stratum: "sports:basketball", slot, field, verdict: "RECOMMEND", usableShare: 1, presentShare: 1, placeholderShare: 0, failed: [], evidence: {}, needsHumanReview: false, events: 100, markets: 100, etPlaceholderShare: 0, decidedBy: "allPassed", failedRules: [] });
  const raw = { slug: "nba-a-b", question: "A vs B", eventStartTime: "2026-10-02T14:00:00+00:00", closeTime: "2026-10-02T17:00:00+00:00" }; const t0 = Date.parse("2026-10-02T10:00:00Z");
  it("uses the recommended start, and the close only when the start is absent", () => {
    expect(eventTimeAt(raw, t0, [rec(1, "eventStartTime"), rec(2, "closeTime")])).toMatchObject({ ms: Date.parse("2026-10-02T14:00:00Z"), why: "slot 1 eventStartTime" });
    expect(eventTimeAt({ ...raw, eventStartTime: undefined }, t0, [rec(1, "eventStartTime"), rec(2, "closeTime")])).toMatchObject({ ms: Date.parse("2026-10-02T17:00:00Z"), why: "slot 2 closeTime" });
  });
  it("rejects (null) when the stratum has no recommended field, or the value is unusable, or start and close are ambiguous", () => {
    expect(eventTimeAt(raw, t0, []).ms).toBeNull(); expect(eventTimeAt({ ...raw, eventStartTime: "2026-10-02" }, t0, [rec(1, "eventStartTime"), rec(2, "closeTime")])).toMatchObject({ ms: null, why: "TIMESTAMP_MISSING" });
    expect(eventTimeAt({ ...raw, eventStartTime: "2026-10-02T18:00:00+00:00" }, t0, [rec(1, "eventStartTime"), rec(2, "closeTime")])).toMatchObject({ ms: null, why: "TIMESTAMP_AMBIGUOUS" });
  });
});
