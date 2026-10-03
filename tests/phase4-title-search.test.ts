/**
 * Phase 4.0c, Part B — title search for every pair: the query builder, candidate scoring (a near-match, a different team, the same teams with a date in
 * the title, an esports title, a politics title), the request budget and its message, a refusal, the US search endpoint adapter, the listing lookup (Kalshi),
 * the CSV and the console examples, and our pairs read from the database with select only.
 */
import { describe, expect, it } from "vitest";
import { PoliteHttp } from "../src/lib/phase4/http";
import { readOnly } from "../src/lib/phase4/readonly-db";
import { US_DEFAULTS } from "../src/lib/phase4/venues";
import type { VenueMarketRef } from "../src/lib/phase4/mapping";
import { MAX_QUERY_CHARS, TITLE_SEARCH_HEADER, buildSearchQuery, exampleLine, kalshiRefOf, listingSearchProvider, loadSearchPairs, pickExamples, runTitleSearch, titleSearchCsv, titleSearchSummaryLines, usRefOf, usSearchProvider, type SearchPair, type SearchProvider, type TitleSearchResult } from "../src/lib/phase4/title-search";
import { fakeFetch, json, memDb, virtualClock } from "./helpers/phase4Db";

const pair = (title: string, outcome: string | null, o: Partial<SearchPair> = {}): SearchPair => ({ conditionId: `0x${title.length}${outcome}`, tokenId: "t", title, slug: null, outcome, stratum: "sports:basketball", score: 80, signals: 1, wallet: "0xw", ...o });
const ref = (id: string, question: string, outcomes: string[] = ["Yes", "No"], o: Partial<VenueMarketRef> = {}): VenueMarketRef => ({ venue: "v", marketId: id, slug: null, url: null, conditionIds: [], tokenIds: [], question, outcomes, eventDate: null, categories: ["Sports"], stratum: "sports:basketball", ...o });
const fixed = (cands: VenueMarketRef[], o: { counter?: { n: number } } = {}): SearchProvider => { const c = o.counter ?? { n: 0 }; return { venue: "v", mode: "endpoint", describe: "fixed", requests: () => c.n, async search() { c.n++; return { candidates: cands, error: null, blocked: false }; } }; };
const one = async (p: SearchPair, cands: VenueMarketRef[]) => (await runTitleSearch([p], fixed(cands))).rows[0];

describe("buildSearchQuery", () => {
  it("a head-to-head title becomes the two sides only: the market-type words differ between venues, the team names identify the game", () => {
    expect(buildSearchQuery({ title: "Lakers vs. Celtics: O/U 220.5", outcome: "Over" })).toBe("lakers celtics");
    expect(buildSearchQuery({ title: "Manchester City vs Arsenal FC (Spread: -1.5)", outcome: "Arsenal FC" })).toBe("manchester city arsenal");
    expect(buildSearchQuery({ title: "Warriors @ Knicks", outcome: "Warriors" })).toBe("warriors knicks");
  });
  it("another title keeps its first distinct content words in order, numbers and years included, without filler or duplicates", () => {
    expect(buildSearchQuery({ title: "Will Bitcoin reach $150,000 by December 31, 2026?", outcome: "Yes" })).toBe("bitcoin reach 150 000 december 31 2026");
    expect(buildSearchQuery({ title: "Will Trump win the 2028 election? Trump", outcome: "No" })).toBe("trump 2028 election");
  });
  it("the outcome is added when it is a name not already present, and never when it is Yes / No / Over / Under / Draw / Up / Down", () => {
    expect(buildSearchQuery({ title: "Who will win the 2028 election?", outcome: "Vance" })).toBe("who 2028 election vance");
    for (const o of ["Yes", "No", "Over", "Under", "Draw", "Up", "Down"]) expect(buildSearchQuery({ title: "Who will win the 2028 election?", outcome: o }), o).toBe("who 2028 election");
  });
  it("is at most 80 characters, ends on a whole word, ignores accents and punctuation, and is empty only for an empty title", () => {
    const q = buildSearchQuery({ title: "Will the extraordinarily long-winded committee of international monetary representatives announce a decision on cryptocurrency regulation worldwide?", outcome: null });
    expect(q.length).toBeLessThanOrEqual(MAX_QUERY_CHARS); expect(q).toBe(q.trim()); expect(q.split(" ").every((w) => /^[a-z0-9.]+$/.test(w))).toBe(true);
    expect(buildSearchQuery({ title: "Ångström vs São Paulo", outcome: null })).toBe("angstrom sao paulo"); expect(buildSearchQuery({ title: null, outcome: null })).toBe(""); expect(buildSearchQuery({ title: "", outcome: "Yes" })).toBe("");
  });
  it("an esports title with a format suffix keeps the team names and the game", () => { const q = buildSearchQuery({ title: "T1 vs Gen.G - League of Legends BO3", outcome: "T1" }); expect(q).toContain("t1"); expect(q).toContain("legends"); expect(q).not.toMatch(/\bvs\b/); expect(q.length).toBeLessThanOrEqual(80); });
});

describe("candidate scoring (the existing similarity function, applied to what a search returns)", () => {
  it("a near-match is PROBABLE: same teams, same wording, the outcome is among the venue's outcomes — and it is never verified, its date never checked", async () => {
    const r = await one(pair("Lakers vs. Celtics", "Lakers"), [ref("m1", "Lakers vs Celtics", ["Lakers", "Celtics"]), ref("m2", "Heat vs Bulls", ["Heat", "Bulls"])]);
    expect(r.diag).toMatchObject({ confidence: "PROBABLE", verified: false, dateChecked: false, band: "≥ 0.90" }); expect(r.diag!.best).toMatchObject({ marketId: "m1", titleSimilarity: 1, outcomeMatch: true, categoryMatch: true });
  });
  it("a different team is not a match: the other team's name drops the similarity to 0.5 and the label is NONE", async () => {
    const r = await one(pair("Lakers vs. Celtics", "Lakers"), [ref("m1", "Lakers vs Warriors", ["Lakers", "Warriors"])]);
    expect(r.diag!.confidence).toBe("NONE"); expect(r.diag!.best!.score).toBeCloseTo(0.5, 9); expect(r.diag!.band).toBe("0.50–0.70"); expect(r.diag!.best!.sameParticipants).toBe(false);
  });
  it("the same teams with a date in the title are not PROBABLE (the extra words and numbers break the guards); the same title WITHOUT a date is, and says so: no date was checked", async () => {
    const dated = await one(pair("Lakers vs. Celtics", "Lakers"), [ref("m1", "Lakers vs Celtics 10/09", ["Lakers", "Celtics"])]); expect(dated.diag!.confidence).toBe("NONE"); expect(dated.diag!.best!.numbersAgree).toBe(false); expect(dated.diag!.best!.score).toBeLessThan(0.85);
    const same = await one(pair("Lakers vs. Celtics", "Lakers"), [ref("m1", "Lakers vs Celtics", ["Lakers", "Celtics"])]); expect(same.diag).toMatchObject({ confidence: "PROBABLE", dateChecked: false }); // two different games between the same teams would score the same: resolution rules and dates are a human check
  });
  it("an esports title: identical wording is PROBABLE, a different market type of the same series is a near-miss", async () => {
    const t = "T1 vs Gen.G - League of Legends BO3"; const a = await one(pair(t, "T1", { stratum: "esports" }), [ref("e1", t, ["T1", "Gen.G"], { stratum: "esports" })]); expect(a.diag).toMatchObject({ confidence: "PROBABLE", band: "≥ 0.90" });
    const b = await one(pair(t, "T1", { stratum: "esports" }), [ref("e2", "T1 vs Gen.G - Game 2 Winner", ["T1", "Gen.G"], { stratum: "esports" })]); expect(b.diag!.confidence).toBe("NONE"); expect(b.diag!.best!.score).toBeLessThan(0.85); expect(b.diag!.best!.score).toBeGreaterThan(0.3);
  });
  it("a politics title: a different candidate or a different year is not a match (numbers and names are guarded)", async () => {
    const p = pair("Will Trump win the 2028 election?", "Yes", { stratum: "politics" });
    const same = await one(p, [ref("p1", "Will Trump win the 2028 election?", ["Yes", "No"], { stratum: "politics" })]); expect(same.diag!.confidence).toBe("PROBABLE");
    const other = await one(p, [ref("p2", "Will Vance win the 2028 election?", ["Yes", "No"], { stratum: "politics" })]); expect(other.diag!.confidence).toBe("NONE"); expect(other.diag!.best!.score).toBeCloseTo(0.6, 9);
    const year = await one(p, [ref("p3", "Will Trump win the 2024 election?", ["Yes", "No"], { stratum: "politics" })]); expect(year.diag!.confidence).toBe("NONE"); expect(year.diag!.best!.numbersAgree).toBe(false);
    const neg = await one(p, [ref("p4", "Will Trump not win the 2028 election?", ["Yes", "No"], { stratum: "politics" })]); expect(neg.diag!.confidence).toBe("NONE"); expect(neg.diag!.best!.negationsAgree).toBe(false);
  });
  it("two candidates that qualify equally give no pick (ambiguous), and an outcome the venue does not list blocks PROBABLE", async () => {
    const a = await one(pair("Lakers vs. Celtics", "Lakers"), [ref("m1", "Lakers vs Celtics", ["Lakers", "Celtics"]), ref("m2", "Lakers vs Celtics", ["Lakers", "Celtics"])]); expect(a.diag!.confidence).toBe("NONE"); expect(a.diag!.evidence.join(" ")).toContain("qualify equally");
    const b = await one(pair("Lakers vs. Celtics", "Lakers"), [ref("m1", "Lakers vs Celtics", ["Home", "Away"])]); expect(b.diag!.confidence).toBe("NONE"); expect(b.diag!.best!.outcomeMatch).toBe(false);
  });
  it("no candidate returned: counted as 'none', band < 0.30, and the pair is still reported", async () => { const r = await runTitleSearch([pair("Lakers vs. Celtics", "Lakers")], fixed([])); expect(r.summary).toMatchObject({ searched: 1, withAnyCandidate: 0, noCandidate: 1, probable: 0 }); expect(r.summary.byBestBand["< 0.30"]).toBe(1); expect(r.rows[0].diag!.best).toBeNull(); });
});

describe("the request budget, a refusal and the summary", () => {
  const ten = Array.from({ length: 10 }, (_, i) => pair(`Team A${i} vs Team B${i}`, `Team A${i}`, { score: i < 6 ? 80 : 50 }));
  it("a hard request budget stops the run with a clear message: how many pairs were searched, how many were not, and what to raise", async () => {
    const c = { n: 0 }; const r = await runTitleSearch(ten, fixed([], { counter: c }), { maxRequests: 3 });
    expect(r.summary).toMatchObject({ pairs: 10, searched: 3, notSearched: 7, requests: 3, budget: 3 }); expect(r.summary.stoppedBecause).toBe("request budget of 3 reached after 3 of 10 pairs (7 not searched); raise --search-max-requests to continue"); expect(c.n).toBe(3);
  });
  it("score ≥ 68 pairs are searched first, so a budget never spends itself on the rest while a high-score pair waits", async () => {
    const mixed = [...ten].reverse(); const r = await runTitleSearch(mixed, fixed([]), { maxRequests: 6 }); expect(r.rows).toHaveLength(6); expect(r.rows.every((x) => (x.pair.score ?? 0) >= 68)).toBe(true); expect(r.summary.score68.pairs).toBe(6);
  });
  // Review addition (mutation Q6 survived): the test above passes by luck, because reversing the list also puts the high-score pairs first by name.
  it("priority is by score, not by name: when the low-score pairs sort first alphabetically the high-score pairs are still searched first", async () => {
    const opposed = Array.from({ length: 10 }, (_, i) => pair(`Team A${i} vs Team B${i}`, `Team A${i}`, { score: i >= 6 ? 80 : 50 }));
    const r = await runTitleSearch(opposed, fixed([]), { maxRequests: 4 });
    expect(r.rows).toHaveLength(4); expect(r.rows.every((x) => (x.pair.score ?? 0) >= 68)).toBe(true); expect(r.summary.score68.pairs).toBe(4);
  });
  it("within the budget everything is searched and no stop message is set; the default budget is 2,000", async () => { const r = await runTitleSearch(ten, fixed([]), { maxRequests: 10 }); expect(r.summary.stoppedBecause).toBeNull(); expect(r.summary.searched).toBe(10); expect((await import("../src/lib/phase4/title-search")).DEFAULT_SEARCH_BUDGET).toBe(2000); });
  it("a refusal ends the run at once, names the venue and the pair count, and attempts no workaround", async () => {
    let n = 0; const p: SearchProvider = { venue: "polymarket_us", mode: "endpoint", describe: "x", requests: () => n, async search() { n++; return n === 2 ? { candidates: [], error: "BLOCKED 403", blocked: true } : { candidates: [], error: null, blocked: false }; } };
    const r = await runTitleSearch(ten, p); expect(r.summary.searched).toBe(2); expect(r.summary.notSearched).toBe(8); expect(r.summary.stoppedBecause).toBe("polymarket_us refused access (BLOCKED 403) after 2 of 10 pairs; no workaround is attempted"); expect(n).toBe(2); expect(r.summary.errors).toBe(1);
  });
  it("an empty query is an error row, not a request; transient errors are counted by kind and the run continues", async () => {
    const c = { n: 0 }; const r = await runTitleSearch([pair("", null), pair("Lakers vs Celtics", "Lakers")], { venue: "v", mode: "endpoint", describe: "x", requests: () => c.n, async search() { c.n++; return { candidates: [], error: "SERVER_ERROR 503", blocked: false }; } });
    expect(c.n).toBe(1); expect(r.summary.errorKinds).toEqual({ "empty query": 1, "SERVER_ERROR 503": 1 }); expect(r.summary.errors).toBe(2); expect(r.summary.searched).toBe(2);
  });
  it("bands and 'any candidate' are counted per pair, for all pairs and for score ≥ 68", async () => {
    const world = [ref("a", "Alpha Team vs Beta Team", ["Alpha Team", "Beta Team"]), ref("b", "Gamma Team vs Delta Team", ["Gamma Team", "Delta Team"])];
    const pairs = [pair("Alpha Team vs Beta Team", "Alpha Team", { score: 90 }), pair("Gamma Team vs Epsilon Team", "Gamma Team", { score: 70 }), pair("Zeta vs Eta", "Zeta", { score: 40 })];
    const prov = listingSearchProvider("v", world, "listing"); const r = await runTitleSearch(pairs, prov);
    expect(r.summary.byBestBand).toEqual({ "≥ 0.90": 1, "0.70–0.90": 0, "0.50–0.70": 1, "0.30–0.50": 0, "< 0.30": 1 }); expect(r.summary.withAnyCandidate).toBe(2); expect(r.summary.noCandidate).toBe(1); expect(r.summary.score68).toMatchObject({ pairs: 2, withAnyCandidate: 2, probable: 1 }); expect(r.summary.score68.byBestBand["≥ 0.90"]).toBe(1);
    expect(r.summary).toMatchObject({ verified: false, mode: "listing", requests: 0 });
  });
});

describe("providers", () => {
  const setup = (handler: Parameters<typeof fakeFetch>[0], o: { originGapMs?: Record<string, number> } = {}) => { const c = virtualClock(); const f = fakeFetch(handler, c.now); return { c, f, http: new PoliteHttp({ fetch: f.fetch, now: c.now, sleep: c.sleep, ...o }) }; };
  const usAnswer = { events: [{ id: "e1", title: "Lakers vs Celtics", slug: "nba-lal-bos", tags: [{ label: "Sports" }], markets: [{ id: "m1", slug: "nba-lal-bos-ml", question: "Lakers vs Celtics", outcomes: '["Lakers","Celtics"]' }, { id: "m2", slug: "nba-lal-bos-tot", question: "Lakers vs Celtics: O/U 220.5", outcomes: '["Over","Under"]' }] }], markets: [{ id: "m1", question: "Lakers vs Celtics", outcomes: '["Lakers","Celtics"]' }] };
  it("the US adapter asks GET /v1/search?query=…&limit=10, reads events (exploded into markets) and markets, de-duplicates, and sends no credential", async () => {
    const { http, f } = setup(() => json(usAnswer)); const p = usSearchProvider(http, US_DEFAULTS); const r = await p.search("lakers celtics", pair("Lakers vs. Celtics", "Lakers"));
    expect(r.error).toBeNull(); expect(r.candidates.map((c) => c.marketId)).toEqual(["m1", "m2"]); expect(r.candidates[0]).toMatchObject({ venue: "polymarket_us", question: "Lakers vs Celtics", outcomes: ["Lakers", "Celtics"], stratum: "sports:basketball" });
    const u = new URL(f.calls[0].url); expect(u.host).toBe("gateway.polymarket.us"); expect(u.pathname).toBe("/v1/search"); expect(u.searchParams.get("query")).toBe("lakers celtics"); expect(u.searchParams.get("limit")).toBe("10"); expect(f.calls[0].method).toBe("GET"); expect(Object.keys(f.calls[0].headers).sort()).toEqual(["accept", "user-agent"]);
    expect(p.mode).toBe("endpoint"); expect(p.describe).toContain("/v1/search"); expect(p.requests()).toBe(1);
  });
  it("a root array, `results` or `data` are read too; an empty answer is no candidates, not an error", async () => {
    for (const body of [[usAnswer.markets[0]], { results: usAnswer.markets }, { data: usAnswer.markets }]) { const { http } = setup(() => json(body)); const r = await usSearchProvider(http, US_DEFAULTS).search("x", pair("x", null)); expect(r.candidates.map((c) => c.marketId), JSON.stringify(body).slice(0, 20)).toEqual(["m1"]); }
    const { http } = setup(() => json({ events: [] })); expect(await usSearchProvider(http, US_DEFAULTS).search("x", pair("x", null))).toMatchObject({ candidates: [], error: null, blocked: false });
  });
  it("errors map to a kind; a refusal is flagged `blocked`; a custom search path is honoured", async () => {
    const a = setup(() => new Response("no", { status: 404 })); expect(await usSearchProvider(a.http, US_DEFAULTS).search("x", pair("x", null))).toMatchObject({ error: "NOT_FOUND 404", blocked: false });
    const b = setup(() => new Response("denied", { status: 403 })); expect(await usSearchProvider(b.http, US_DEFAULTS).search("x", pair("x", null))).toMatchObject({ error: "BLOCKED 403", blocked: true });
    const c = setup(() => json({})); await usSearchProvider(c.http, { ...US_DEFAULTS, searchPath: "/v9/find" }).search("x", pair("x", null)); expect(new URL(c.f.calls[0].url).pathname).toBe("/v9/find");
  });
  it("the US origin is paced at its slower documented limit (≥ 1.1 s between requests) while the brief's 500 ms floor holds everywhere", async () => {
    const { http, f } = setup(() => json({ events: [] }), { originGapMs: { "https://gateway.polymarket.us": 1100 } }); const p = usSearchProvider(http, US_DEFAULTS); for (let i = 0; i < 5; i++) await p.search(`q${i}`, pair("x", null));
    const at = f.calls.map((c) => c.at!); for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(1100);
    const fast = setup(() => json({}), { originGapMs: { "https://gateway.polymarket.us": 1 } }); await fast.http.getJson("https://gateway.polymarket.us/a"); await fast.http.getJson("https://gateway.polymarket.us/b"); expect(fast.f.calls[1].at! - fast.f.calls[0].at!).toBeGreaterThanOrEqual(500);
  });
  it("the listing provider (Kalshi has no documented search): no request, candidates sharing words, an identifier or slug match is found too", async () => {
    const refs = [ref("k1", "Lakers vs Celtics", ["Yes", "No", "Lakers"], { venue: "kalshi", slug: "nba-game" }), ref("k2", "Senate bill passes", ["Yes", "No"], { venue: "kalshi" })]; const p = listingSearchProvider("kalshi", refs, "lookup"); const r = await p.search("ignored", pair("Lakers vs. Celtics", "Lakers"));
    expect(r.candidates.map((c) => c.marketId)).toContain("k1"); expect(p.requests()).toBe(0); expect(p.mode).toBe("listing"); const none = await p.search("x", pair("Zebra quartz", null)); expect(none.candidates).toEqual([]);
  });
  it("raw objects become refs: US (market, else event title) and Kalshi (title plus the side label), with the stratum and category the venue gives", () => {
    expect(usRefOf({ id: "u", event: { title: "Event title", slug: "ev" }, outcomes: '["A","B"]' })).toMatchObject({ marketId: "u", question: "Event title", eventSlug: "ev" }); expect(usRefOf({})).toBeNull();
    const k = kalshiRefOf({ ticker: "KXNBAGAME-1-LAL", title: "Who wins?", yes_sub_title: "Lakers", event: { category: "Sports", series_ticker: "KXNBAGAME", event_ticker: "KXNBAGAME-1" } }); expect(k).toMatchObject({ venue: "kalshi", marketId: "KXNBAGAME-1-LAL", question: "Who wins? Lakers", categories: ["Sports"], eventSlug: "KXNBAGAME-1" }); expect(k!.outcomes).toContain("Lakers");
    expect(kalshiRefOf({ ticker: "T", title: "Lakers vs Celtics", yes_sub_title: "Lakers" })!.question).toBe("Lakers vs Celtics"); expect(kalshiRefOf({})).toBeNull();
  });
});

describe("outputs: the CSV, the examples and the console summary", () => {
  const results = async (n: number, shape: (i: number) => string | null) => { const pairs = Array.from({ length: n }, (_, i) => pair(`Alpha${i} Team vs Beta${i} Team`, `Alpha${i} Team`, { score: 90 })); const prov: SearchProvider = { venue: "v", mode: "listing", describe: "d", requests: () => 0, async search(_q, p) { const i = pairs.indexOf(p); const t = shape(i); return { candidates: t ? [ref(`c${i}`, t, [p.outcome!, "x"])] : [], error: null, blocked: false }; } }; return runTitleSearch(pairs, prov); };
  it("CSV: one row per pair with our title, outcome, band, label, wallet and the best three candidates with similarity and category; commas and quotes are escaped", async () => {
    const r = await runTitleSearch([pair('He said, "go" vs. them', "Yes", { wallet: "0xabc" })], fixed([ref("a", 'He said, "go" vs them', ["Yes"]), ref("b", "He said go", ["Yes"]), ref("c", "Other", ["Yes"]), ref("d", "Fourth", ["Yes"])]));
    const csv = titleSearchCsv(r.rows); const lines = csv.trim().split("\n"); expect(lines[0].split(",")).toEqual(TITLE_SEARCH_HEADER); expect(TITLE_SEARCH_HEADER.slice(11)).toEqual(["1_title", "1_similarity", "1_category", "1_id", "2_title", "2_similarity", "2_category", "2_id", "3_title", "3_similarity", "3_category", "3_id"]);
    expect(csv).toContain('"He said, ""go"" vs. them"'); expect(csv).toContain("0xabc"); expect(csv).toContain("sports:basketball; Sports"); expect(csv).not.toContain("Fourth"); expect(csv).toContain(",Other,"); expect(csv).toContain("never verified");
    const empty = titleSearchCsv((await runTitleSearch([pair("Zzz", null)], fixed([]))).rows); expect(empty.trim().split("\n")).toHaveLength(2);
  });
  it("examples: the 15 best matches (PROBABLE first, then by similarity) and the 10 near-misses (not PROBABLE, similarity ≥ 0.5), deterministic and disjoint", async () => {
    const r = await results(60, (i) => (i < 20 ? `Alpha${i} Team vs Beta${i} Team` : i < 45 ? `Alpha${i} Team vs Gamma${i} Team` : `Unrelated${i} words entirely`)); const { best, near } = pickExamples(r.rows);
    expect(best).toHaveLength(15); expect(near).toHaveLength(10); expect(best.every((x) => x.diag!.confidence === "PROBABLE")).toBe(true); expect(near.every((x) => x.diag!.confidence !== "PROBABLE" && x.diag!.best!.score >= 0.5)).toBe(true);
    expect(best.some((x) => near.includes(x))).toBe(false); expect(pickExamples(r.rows)).toEqual({ best, near }); expect(pickExamples(r.rows, 3, 2)).toMatchObject({ best: expect.any(Array) }); expect(pickExamples(r.rows, 3, 2).best).toHaveLength(3);
    const few = pickExamples((await results(4, () => null)).rows); expect(few).toEqual({ best: [], near: [] });
  });
  it("an example line carries similarity, label, our stratum, our title and outcome, the venue's title and its stratum, within 200 characters", async () => {
    const r = await results(1, () => "Alpha0 Team vs Beta0 Team"); const l = exampleLine(r.rows[0]); expect(l).toMatch(/^1\.00 PROB \[sports:basketball\] "Alpha0 Team vs Beta0 Team" \(Alpha0 Team\) ⇄ "Alpha0 Team vs Beta0 Team" \[sports:basketba…\]$/); expect(l.length).toBeLessThanOrEqual(200);
    const long = await runTitleSearch([pair("alpha ".repeat(60), "beta ".repeat(60))], fixed([ref("a", "alpha ".repeat(60) + "z".repeat(300))])); expect(exampleLine(long.rows[0]).length).toBeLessThanOrEqual(200);
  });
  it("the console summary for BOTH venues is at most 60 lines whatever the data: bands, coverage, 15 + 10 examples each, and the stop message when there is one", async () => {
    const a = await results(80, (i) => (i < 30 ? `Alpha${i} Team vs Beta${i} Team` : i < 70 ? `Alpha${i} Team vs Gamma${i} Team` : null)); const b = await results(80, (i) => (i < 40 ? `Alpha${i} Team vs Beta${i} Team` : `Alpha${i} Team vs Gamma${i} Team`)); b.summary.venue = "kalshi"; b.summary.stoppedBecause = "request budget of 5 reached after 5 of 80 pairs (75 not searched); raise --search-max-requests to continue";
    const lines = titleSearchSummaryLines([a, b], "out"); expect(lines.length).toBeLessThanOrEqual(60); expect(lines.length).toBeGreaterThanOrEqual(55); expect(lines.join("\n")).toContain("15 best matches"); expect(lines.join("\n")).toContain("10 near-misses"); expect(lines.join("\n")).toContain("STOPPED: request budget of 5"); expect(lines.join("\n")).toContain("s1b_title_search_v.csv"); expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(220);
    expect(lines[0]).toMatch(/nothing verified/);
    expect(titleSearchSummaryLines([a, b, a, b], "out").length).toBeLessThanOrEqual(60); // however many venues are given
  });
});

describe("our pairs, read with select only", () => {
  const sig = (id: string, o: Record<string, unknown>) => ({ id, kind: "NEW_POSITION", wallet: "0xw1", condition_id: "0xC1", token_id: "tok1", outcome: "Lakers", title: "Lakers vs. Celtics", slug: "nba-lal-bos", created_at: "2026-10-02T10:00:00Z", payload: { copyScore: 70 }, ...o });
  it("groups entry signals by market+outcome: the highest copy score, its wallet, the signal count; EXIT and out-of-window signals are excluded; nothing is written", async () => {
    const d = memDb({ signals: [sig("a", {}), sig("b", { wallet: "0xw2", payload: { copyScore: 91 }, condition_id: "0xc1" }), sig("c", { wallet: "0xw3", payload: { copyScore: 80 } }), sig("x", { kind: "EXIT", wallet: "0xwx" }), sig("old", { created_at: "2026-09-27T04:28:37Z" }), sig("n", { condition_id: "0xc2", outcome: "Yes", title: "Will it rain?", slug: "rain", payload: {} }), sig("a", {})] });
    const pairs = await loadSearchPairs(readOnly(d.db as never), "2026-09-27T04:28:38Z", "2026-10-03T00:00:00Z");
    expect(pairs).toHaveLength(2); const lal = pairs.find((p) => p.outcome === "Lakers")!; expect(lal).toMatchObject({ score: 91, wallet: "0xw2", signals: 3, title: "Lakers vs. Celtics", stratum: "sports:basketball" }); expect(pairs.find((p) => p.outcome === "Yes")).toMatchObject({ score: null, signals: 1 });
    expect(d.touched).toEqual([]); expect([...new Set(d.reads.map((r) => r.table))]).toEqual(["signals"]);
  });
});
