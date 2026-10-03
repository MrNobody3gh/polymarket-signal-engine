/**
 * Phase 4.0 — probe-only market mapping (src/lib/phase4/mapping.ts). EXACT / PROBABLE / NONE; nothing is ever verified.
 */
import { describe, expect, it } from "vitest";
import { buildVenueIndex, candidatesFor, matchSignalToVenue, normalizeOutcome, normalizeTitle, reviewRow, REVIEW_HEADER, titleSimilarity, type SignalMarketRef, type VenueMarketRef } from "../src/lib/phase4/mapping";

const cand = (o: Partial<VenueMarketRef> & { marketId: string }): VenueMarketRef => ({ venue: "us", question: null, outcomes: ["Yes", "No"], conditionIds: [], tokenIds: [], eventDate: null, ...o });
const sig = (o: Partial<SignalMarketRef> = {}): SignalMarketRef => ({ conditionId: "0xABC", tokenId: "tok-yes", title: "Lakers vs. Celtics", outcome: "Lakers", eventDate: "2026-10-05", ...o });

describe("normalisation", () => {
  it("lower-cases, strips diacritics and punctuation, unifies vs forms, keeps decimals", () => {
    expect(normalizeTitle("Lakers vs. Celtics (Game 1)")).toBe("lakers vs celtics game 1");
    expect(normalizeTitle("Lakers v Celtics")).toBe("lakers vs celtics"); expect(normalizeTitle("Lakers VERSUS Celtics")).toBe("lakers vs celtics");
    expect(normalizeTitle("Atlético Madrid — Bayern")).toBe("atletico madrid bayern");
    expect(normalizeTitle("Over 2.5 goals?")).toBe("over 2.5 goals"); expect(normalizeTitle("O/U 2.5")).toBe("over under 2.5");
    expect(normalizeTitle(null)).toBe(""); expect(normalizeOutcome("YES")).toBe("yes");
  });
  it("title similarity guards numbers and negations", () => {
    expect(titleSimilarity("Will the Lakers win?", "Lakers will win").exact).toBe(true);
    expect(titleSimilarity("Over 2.5 goals", "Over 3.5 goals").numbersAgree).toBe(false);
    expect(titleSimilarity("Will X win the election", "Will X not win the election").negationsAgree).toBe(false);
  });
});

describe("matchSignalToVenue", () => {
  it("EXACT by a shared token id (the token names the outcome itself)", () => {
    const m = matchSignalToVenue(sig({ outcome: "whatever" }), [cand({ marketId: "m1", tokenIds: ["tok-yes", "tok-no"], question: "unrelated" })]);
    expect(m).toMatchObject({ confidence: "EXACT", candidate: { marketId: "m1" } }); expect(m.evidence.join()).toContain("token id tok-yes");
  });
  it("EXACT by a shared condition id when the outcome label also matches (case-insensitive condition id)", () => {
    const m = matchSignalToVenue(sig({ tokenId: null, conditionId: "0xABC" }), [cand({ marketId: "m1", conditionIds: ["0xabc"], outcomes: ["Celtics", "Lakers"] })]);
    expect(m).toMatchObject({ confidence: "EXACT", venueOutcome: "Lakers" });
  });
  it("an identifier match whose outcome label cannot be matched is only PROBABLE", () => {
    const m = matchSignalToVenue(sig({ tokenId: null }), [cand({ marketId: "m1", conditionIds: ["0xabc"], outcomes: ["Home", "Away"] })]);
    expect(m.confidence).toBe("PROBABLE"); expect(m.evidence.join()).toContain("identifier match only");
  });
  it("PROBABLE by normalised title, event date within a day, and outcome", () => {
    const m = matchSignalToVenue(sig({ conditionId: null, tokenId: null }), [cand({ marketId: "m2", question: "Lakers v Celtics", outcomes: ["Lakers", "Celtics"], eventDate: "2026-10-05T23:30:00Z" })]);
    expect(m).toMatchObject({ confidence: "PROBABLE", venueOutcome: "Lakers" }); expect(m.evidence.join()).toContain("titles are identical"); expect(m.evidence.join()).toContain("event dates agree");
  });
  it("event date one day apart still matches (time zones); two days apart is NONE", () => {
    const base = { marketId: "m", question: "Lakers vs Celtics", outcomes: ["Lakers", "Celtics"] };
    expect(matchSignalToVenue(sig({ conditionId: null, tokenId: null }), [cand({ ...base, eventDate: "2026-10-06" })]).confidence).toBe("PROBABLE");
    expect(matchSignalToVenue(sig({ conditionId: null, tokenId: null }), [cand({ ...base, eventDate: "2026-10-07" })]).confidence).toBe("NONE");
  });
  it("NONE when the event date is unknown on either side, the outcome is not found, or the numbers differ", () => {
    const base = { marketId: "m", question: "Lakers vs Celtics", outcomes: ["Lakers", "Celtics"] }; const s = sig({ conditionId: null, tokenId: null });
    expect(matchSignalToVenue(s, [cand({ ...base, eventDate: null })]).confidence).toBe("NONE");
    expect(matchSignalToVenue({ ...s, eventDate: null }, [cand({ ...base, eventDate: "2026-10-05" })]).confidence).toBe("NONE");
    expect(matchSignalToVenue({ ...s, outcome: "Draw" }, [cand({ ...base, eventDate: "2026-10-05" })]).confidence).toBe("NONE");
    expect(matchSignalToVenue({ ...s, title: "Over 2.5 goals", outcome: "Yes" }, [cand({ marketId: "n", question: "Over 3.5 goals", eventDate: "2026-10-05" })]).confidence).toBe("NONE");
    expect(matchSignalToVenue({ ...s, title: "Will X win", outcome: "Yes" }, [cand({ marketId: "n", question: "Will X not win", eventDate: "2026-10-05" })]).confidence).toBe("NONE");
  });
  it("the number and negation guards decide when everything else says 'same market' (long titles, Jaccard ≥ 0.85)", () => {
    const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima"; const s = sig({ conditionId: null, tokenId: null, outcome: "Yes", eventDate: "2026-10-05" }); const c = (q: string) => cand({ marketId: "m", question: q, eventDate: "2026-10-05" });
    expect(titleSimilarity(`${words} over 2.5`, `${words} over 3.5`).score).toBeGreaterThan(0.85); expect(matchSignalToVenue({ ...s, title: `${words} over 2.5` }, [c(`${words} over 3.5`)]).confidence).toBe("NONE"); expect(matchSignalToVenue({ ...s, title: `${words} over 2.5` }, [c(`${words} over 2.5`)]).confidence).toBe("PROBABLE");
    expect(titleSimilarity(`${words} win`, `${words} not win`).score).toBeGreaterThan(0.85); expect(matchSignalToVenue({ ...s, title: `${words} win` }, [c(`${words} not win`)]).confidence).toBe("NONE"); expect(matchSignalToVenue({ ...s, title: `${words} win` }, [c(`${words} win`)]).confidence).toBe("PROBABLE");
  });
  it("an event date unknown on BOTH sides is not a date match", () => { expect(matchSignalToVenue(sig({ conditionId: null, tokenId: null, eventDate: null }), [cand({ marketId: "m", question: "Lakers vs Celtics", outcomes: ["Lakers"], eventDate: null })]).confidence).toBe("NONE"); });
  it("NONE for an unrelated market and for no candidates", () => {
    expect(matchSignalToVenue(sig(), [cand({ marketId: "z", question: "Will it rain in Paris", eventDate: "2026-10-05" })]).confidence).toBe("NONE");
    expect(matchSignalToVenue(sig(), []).confidence).toBe("NONE");
  });
  it("two different candidates that qualify equally give NONE with ambiguous = true, never an arbitrary pick", () => {
    const base = { question: "Lakers vs Celtics", outcomes: ["Lakers", "Celtics"], eventDate: "2026-10-05" };
    const m = matchSignalToVenue(sig({ conditionId: null, tokenId: null }), [cand({ marketId: "b", ...base }), cand({ marketId: "a", ...base })]);
    expect(m).toMatchObject({ confidence: "NONE", ambiguous: true, candidate: null }); expect(m.evidence[0]).toContain("a, b");
  });
  it("an identifier match outranks a title match", () => {
    const m = matchSignalToVenue(sig(), [cand({ marketId: "title", question: "Lakers vs Celtics", outcomes: ["Lakers", "Celtics"], eventDate: "2026-10-05" }), cand({ marketId: "id", tokenIds: ["tok-yes"] })]);
    expect(m).toMatchObject({ confidence: "EXACT", candidate: { marketId: "id" } });
  });
  it("PROBABLE and EXACT are NEVER reported as verified, and resolution-rule equivalence is never claimed", () => {
    const results = [
      matchSignalToVenue(sig(), [cand({ marketId: "m1", tokenIds: ["tok-yes"] })]),
      matchSignalToVenue(sig({ conditionId: null, tokenId: null }), [cand({ marketId: "m2", question: "Lakers vs Celtics", outcomes: ["Lakers"], eventDate: "2026-10-05" })]),
      matchSignalToVenue(sig(), []),
    ];
    expect(results.map((r) => r.confidence)).toEqual(["EXACT", "PROBABLE", "NONE"]);
    for (const r of results) { expect(r.verified).toBe(false); expect(r.resolutionRulesVerified).toBe(false); }
  });
  it("is deterministic: the same inputs in any candidate order give the same result", () => {
    const cs = ["d", "c", "b", "a"].map((id, i) => cand({ marketId: id, question: i === 2 ? "Lakers vs Celtics" : `Other game ${i}`, outcomes: ["Lakers", "Celtics"], eventDate: "2026-10-05" }));
    const s = sig({ conditionId: null, tokenId: null }); const a = matchSignalToVenue(s, cs); const b = matchSignalToVenue(s, [...cs].reverse()); const c = matchSignalToVenue(s, [cs[1], cs[3], cs[0], cs[2]]);
    expect(b).toEqual(a); expect(c).toEqual(a); expect(a).toMatchObject({ confidence: "PROBABLE", candidate: { marketId: "b" } });
  });
});

describe("candidate index", () => {
  it("returns the same match as comparing against every candidate (exhaustive check on a generated world)", () => {
    let seed = 7; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const teams = ["Lakers", "Celtics", "Bulls", "Heat", "Suns", "Nets", "Spurs", "Jazz"]; const cands: VenueMarketRef[] = [];
    for (let i = 0; i < 300; i++) { const a = teams[Math.floor(rnd() * 8)], b = teams[Math.floor(rnd() * 8)]; cands.push(cand({ marketId: `m${String(i).padStart(3, "0")}`, question: `${a} vs ${b} ${Math.floor(rnd() * 4)}`, outcomes: [a, b], eventDate: `2026-10-0${1 + Math.floor(rnd() * 5)}`, tokenIds: i % 7 === 0 ? [`t${i}`] : [], conditionIds: i % 11 === 0 ? [`0xc${i}`] : [] })); }
    const idx = buildVenueIndex(cands);
    for (let i = 0; i < 120; i++) {
      const c = cands[Math.floor(rnd() * cands.length)]; const s: SignalMarketRef = { conditionId: i % 5 === 0 ? (c.conditionIds?.[0] ?? "x") : null, tokenId: i % 3 === 0 ? (c.tokenIds?.[0] ?? null) : null, title: i % 4 === 0 ? `${c.question} extra` : c.question, outcome: c.outcomes![0], eventDate: c.eventDate };
      const viaIndex = matchSignalToVenue(s, candidatesFor(s, idx)), all = matchSignalToVenue(s, cands);
      expect({ ...viaIndex, evidence: viaIndex.confidence === "NONE" && !viaIndex.ambiguous ? [] : viaIndex.evidence }, `signal ${i}`).toEqual({ ...all, evidence: all.confidence === "NONE" && !all.ambiguous ? [] : all.evidence }); // a NONE's evidence names whichever candidate came closest, which depends on the candidate set
    }
  });
});

describe("review export", () => {
  it("one CSV row per pair, with titles, outcomes, times and urls, and empty reviewer columns", () => {
    const m = matchSignalToVenue(sig(), [cand({ marketId: "m1", tokenIds: ["tok-yes"], question: "Lakers vs Celtics", url: "https://venue/m1", eventDate: "2026-10-05T23:30:00Z" })]);
    const row = reviewRow("sports:basketball", { ...sig(), url: "https://polymarket.com/event/x" }, m);
    expect(row).toHaveLength(REVIEW_HEADER.length); expect(row.slice(0, 3)).toEqual(["sports:basketball", "EXACT", "Lakers vs. Celtics"]); expect(row.slice(-2)).toEqual(["", ""]); expect(row).toContain("https://venue/m1");
  });
});
