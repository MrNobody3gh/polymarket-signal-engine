/** Phase 4.0b — the timestamp-free diagnostic matcher, the seeded sample, the CSV and the category mix. Probe only: PROBABLE or NONE, never EXACT, never verified. */
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_HEADER, categoryMix, diagnosticCsv, runDiagnostic, seededRng, stratifiedRandom, type OurMarket } from "../src/lib/phase4/diagnose";
import { SIMILARITY_BANDS, bandOf, buildDiagIndex, diagCandidates, diagnoseSignal, type VenueMarketRef } from "../src/lib/phase4/mapping";

const v = (o: Partial<VenueMarketRef> & { marketId: string }): VenueMarketRef => ({ venue: "us", question: null, outcomes: ["Yes", "No"], conditionIds: [], tokenIds: [], eventDate: null, categories: [], stratum: null, ...o });
const our = (o: Partial<OurMarket> = {}): OurMarket => ({ conditionId: "0xc1", tokenId: "tok1", title: "Lakers vs. Celtics", slug: "nba-lal-bos", outcome: "Lakers", stratum: "sports:basketball", score: 80, signals: 1, ...o });
const venue = [v({ marketId: "m1", question: "Lakers vs Celtics", outcomes: ["Lakers", "Celtics"], stratum: "sports:basketball", categories: ["basketball"] }), v({ marketId: "m2", question: "Celtics vs Lakers: Total Over 220.5", outcomes: ["Over", "Under"], stratum: "sports:basketball" }), v({ marketId: "m3", question: "Bitcoin up or down - 5:15 PM ET", stratum: "crypto_short_term" })];

describe("diagnoseSignal (no timestamp required)", () => {
  const idx = buildDiagIndex(venue);
  it("PROBABLE for an identical normalised title with a matching outcome, with NO date checked and nothing verified", () => {
    const d = diagnoseSignal({ title: "Lakers vs. Celtics", outcome: "Lakers", stratum: "sports:basketball" }, idx);
    expect(d).toMatchObject({ confidence: "PROBABLE", verified: false, dateChecked: false, identifierMatch: false, band: "≥ 0.90" }); expect(d.best).toMatchObject({ marketId: "m1", titleSimilarity: 1, participantSimilarity: 1, sameParticipants: true, outcomeMatch: true, categoryMatch: true });
  });
  it("same game, different market type: shown as same participants with a low title similarity, and labelled NONE", () => {
    const d = diagnoseSignal({ title: "Celtics vs Lakers: Total Over 220.5", outcome: "Under", stratum: "sports:basketball" }, buildDiagIndex([venue[0]]));
    expect(d.confidence).toBe("NONE"); expect(d.best).toMatchObject({ marketId: "m1", sameParticipants: true }); expect(d.best!.titleSimilarity).toBeLessThan(0.85); expect(d.evidence.join()).toMatch(/title similarity/);
  });
  it("NEVER emits EXACT: without identifiers the label is PROBABLE or NONE, and an identifier match is reported as such, still PROBABLE", () => {
    for (const sig of [{ title: "Lakers vs. Celtics", outcome: "Lakers" }, { title: "unrelated words entirely", outcome: "Yes" }, { title: null, outcome: null }]) { const d = diagnoseSignal(sig, idx); expect(["PROBABLE", "NONE"]).toContain(d.confidence); expect(d.confidence).not.toBe("EXACT" as never); expect(d.identifierMatch).toBe(false); expect(d.verified).toBe(false); }
    const withId = diagnoseSignal({ conditionId: "0xABC", title: "Totally different", outcome: "x" }, buildDiagIndex([v({ marketId: "z", question: "Something else", conditionIds: ["0xabc"] })])); expect(withId).toMatchObject({ confidence: "PROBABLE", identifierMatch: true, verified: false, dateChecked: false });
  });
  it("numbers and negations still guard the title route (Over 2.5 is not Over 3.5)", () => {
    const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima"; const i2 = buildDiagIndex([v({ marketId: "n", question: `${words} over 3.5`, outcomes: ["Yes", "No"] })]);
    expect(diagnoseSignal({ title: `${words} over 2.5`, outcome: "Yes" }, i2).confidence).toBe("NONE"); expect(diagnoseSignal({ title: `${words} over 3.5`, outcome: "Yes" }, i2).confidence).toBe("PROBABLE");
    const i3 = buildDiagIndex([v({ marketId: "q", question: `${words} not win`, outcomes: ["Yes", "No"] })]); expect(diagnoseSignal({ title: `${words} win`, outcome: "Yes" }, i3).confidence).toBe("NONE"); expect(diagnoseSignal({ title: `${words} not win`, outcome: "Yes" }, i3).confidence).toBe("PROBABLE");
  });
  it("two candidates that qualify equally give NONE (no arbitrary pick), and the result does not depend on listing order", () => {
    const twins = [v({ marketId: "b", question: "Lakers vs Celtics", outcomes: ["Lakers"] }), v({ marketId: "a", question: "Lakers vs Celtics", outcomes: ["Lakers"] })];
    const d1 = diagnoseSignal({ title: "Lakers vs Celtics", outcome: "Lakers" }, buildDiagIndex(twins)); const d2 = diagnoseSignal({ title: "Lakers vs Celtics", outcome: "Lakers" }, buildDiagIndex([...twins].reverse())); expect(d1.confidence).toBe("NONE"); expect(d1.evidence.join()).toContain("qualify equally"); expect(d2).toEqual(d1);
  });
  it("similarity bands and the candidate counts by band", () => {
    expect(SIMILARITY_BANDS.map((b) => b.name)).toEqual(["≥ 0.90", "0.70–0.90", "0.50–0.70", "0.30–0.50", "< 0.30"]); expect([1, 0.9, 0.89, 0.7, 0.5, 0.3, 0.29, 0].map(bandOf)).toEqual(["≥ 0.90", "≥ 0.90", "0.70–0.90", "0.70–0.90", "0.50–0.70", "0.30–0.50", "< 0.30", "< 0.30"]);
    const d = diagnoseSignal({ title: "Lakers vs. Celtics", outcome: "Lakers" }, buildDiagIndex(venue)); expect(Object.values(d.candidatesByBand).reduce((a, b) => a + b, 0)).toBe(d.candidatesGenerated); expect(d.top).toHaveLength(2); expect(d.top[0].marketId).toBe("m1");
  });
  it("when more than 60 candidates tie, the 60 kept do not depend on the order of the listing", () => {
    const many = Array.from({ length: 100 }, (_, i) => v({ marketId: `m${String(i).padStart(3, "0")}`, question: "alpha bravo" })); const a = diagCandidates({ title: "alpha bravo", outcome: null }, buildDiagIndex(many)).map((c) => c.marketId).sort(); const b = diagCandidates({ title: "alpha bravo", outcome: null }, buildDiagIndex([...many].reverse())).map((c) => c.marketId).sort();
    expect(a).toHaveLength(60); expect(b).toEqual(a); expect(a[0]).toBe("m000"); expect(a[59]).toBe("m059");
  });
  it("candidates come from identifiers and shared content tokens, never from a timestamp", () => { const c = diagCandidates({ title: "Lakers vs. Celtics", outcome: "Lakers" }, buildDiagIndex(venue)); expect(c.map((x) => x.marketId).sort()).toEqual(["m1", "m2"]); expect(diagCandidates({ title: "zzz qqq", outcome: null }, buildDiagIndex(venue))).toEqual([]); });
});

describe("runDiagnostic over our markets", () => {
  it("counts pairs by best band, candidates by band, PROBABLE, same participants and category agreement", () => {
    const ours = [our(), our({ conditionId: "0xc2", title: "Celtics vs Lakers: Total Over 220.5", outcome: "Over", signals: 2 }), our({ conditionId: "0xc3", title: "Will it snow in Oslo?", outcome: "Yes", stratum: "culture_other" })];
    const run = runDiagnostic(ours, venue); const s = run.summary;
    expect(s.pairs).toBe(3); expect(s.probable).toBeGreaterThanOrEqual(1); expect(s.none).toBe(3 - s.probable); expect(s.identifierMatches).toBe(0); expect(Object.values(s.byBestBand).reduce((a, b) => a + b, 0)).toBe(3); expect(s.byBestBand["< 0.30"]).toBeGreaterThanOrEqual(1);
    expect(s.sameParticipants).toBe(2); expect(s.categoryMatchOfBest.yes + s.categoryMatchOfBest.no + s.categoryMatchOfBest.unknown).toBe(3); expect(s.definition).toMatch(/NO DATE CHECKED/); expect(run.results.every((r) => r.diag.verified === false && r.diag.dateChecked === false)).toBe(true);
  });
  it("an empty venue listing gives NONE for everything, in the lowest band", () => { const run = runDiagnostic([our()], []); expect(run.summary).toMatchObject({ probable: 0, none: 1 }); expect(run.summary.byBestBand["< 0.30"]).toBe(1); });
  it("is deterministic", () => { expect(runDiagnostic([our(), our({ conditionId: "0xc2" })], venue)).toEqual(runDiagnostic([our(), our({ conditionId: "0xc2" })], [...venue].reverse())); });
});

describe("seeded stratified sample", () => {
  const items = [...Array.from({ length: 30 }, (_, i) => ({ k: "a", i })), ...Array.from({ length: 5 }, (_, i) => ({ k: "b", i })), ...Array.from({ length: 2 }, (_, i) => ({ k: "c", i }))];
  it("the same seed gives the same sample, another seed a different one; never more than n; every stratum before a second of any", () => {
    const s1 = stratifiedRandom(items, (x) => x.k, 10, "2026-09-27T04:28:38Z"); expect(stratifiedRandom(items, (x) => x.k, 10, "2026-09-27T04:28:38Z")).toEqual(s1); expect(stratifiedRandom(items, (x) => x.k, 10, "other")).not.toEqual(s1);
    expect(s1).toHaveLength(10); expect(new Set(s1.map((x) => x.k))).toEqual(new Set(["a", "b", "c"])); expect(stratifiedRandom(items, (x) => x.k, 100, "s")).toHaveLength(37); expect(stratifiedRandom(items, (x) => x.k, 3, "s").map((x) => x.k).sort()).toEqual(["a", "b", "c"]);
  });
  it("the PRNG is in [0, 1) and reproducible", () => { const r = seededRng("x"), r2 = seededRng("x"); for (let i = 0; i < 100; i++) { const a = r(); expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThan(1); expect(r2()).toBe(a); } });
});

describe("export and category mix", () => {
  it("one CSV row per nearest venue title, with our title and outcome, similarity and categories, and a row even when nothing is near", () => {
    const run = runDiagnostic([our(), our({ conditionId: "0xc3", title: "zzz", outcome: "Yes", stratum: "culture_other", score: 50 })], venue); const csv = diagnosticCsv(run.results).trim().split("\n");
    expect(csv[0].split(",")).toHaveLength(DIAGNOSTIC_HEADER.length); expect(csv[0]).toContain("our_title"); expect(csv[0]).toContain("title_similarity"); expect(csv.length).toBe(1 + run.results.reduce((a, r) => a + Math.max(1, r.diag.top.length), 0));
    expect(csv[1]).toContain("Lakers vs. Celtics"); expect(csv[1]).toContain("score ≥ 68"); expect(csv.some((l) => l.includes("score < 68 or none"))).toBe(true);
  });
  it("category mix: counts and shares of our flow (all, ≥ 68) against the venue listing", () => {
    const ours = [{ stratum: "crypto_short_term", score: 90, condition: "a" }, { stratum: "crypto_short_term", score: 70, condition: "a" }, { stratum: "crypto_short_term", score: 10, condition: "b" }, { stratum: "sports:nba", score: 80, condition: "c" }];
    const mix = categoryMix(ours, [{ stratum: "sports:nba", closed: false }, { stratum: "sports:nba", closed: true }, { stratum: "sports:nba", closed: false }, { stratum: "politics", closed: false }]); const by = Object.fromEntries(mix.map((m) => [m.stratum, m]));
    expect(by.crypto_short_term).toMatchObject({ oursAllSignals: 3, oursScore68Signals: 2, oursMarkets68: 1, venueMarkets: 0, oursShareAll: 0.75, oursShare68: 0.667, venueShare: 0 }); expect(by["sports:nba"]).toMatchObject({ oursAllSignals: 1, oursScore68Signals: 1, venueMarkets: 3, venueOpen: 2, venueClosed: 1, venueShare: 0.75 }); expect(by.politics.venueMarkets).toBe(1);
  });
});
