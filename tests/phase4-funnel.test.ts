/**
 * Phase 4.0 — funnel arithmetic on a fixture world whose every answer was derived by hand (comments give the derivation).
 * Window: Mon 28 Sep 2026 00:00 UTC → Thu 1 Oct 2026 00:00 UTC = three complete UTC days (Mon, Tue, Wed).
 */
import { describe, expect, it } from "vitest";
import { STAGES, computeFunnel, deepestStage, perDayStats, type FunnelRow } from "../src/lib/phase4/funnel";

const START = Date.parse("2026-09-28T00:00:00Z"), END = Date.parse("2026-10-01T00:00:00Z"), DAY = 86_400_000, H = 3_600_000;
type Spec = { id: number; day: 0 | 1 | 2; kind?: string; wallet: string; cat?: string; score: number | null; map?: FunnelRow["mapping"]; tradable?: boolean | null; ev?: number | null; proxy?: boolean };
// ev = event time relative to the evaluation time in ms (null = no usable timestamp)
const SPECS: Spec[] = [
  // day A (Mon)                                                                                      deepest stage (EXACT / EXACT+PROBABLE)
  { id: 1, day: 0, wallet: "w1", score: 70, ev: 2 * H, proxy: true },                                //  7 eligible
  { id: 2, day: 0, wallet: "w1", score: 67, ev: 2 * H },                                              //  0 score 67 < 68
  { id: 3, day: 0, wallet: "w2", score: 68, ev: 24 * H, proxy: true },                                //  7 score 68 and exactly 24:00:00 are inclusive
  { id: 4, day: 0, wallet: "w2", kind: "CONSENSUS", cat: "esports", score: 90, map: "PROBABLE", ev: 3 * H, proxy: true }, //  1 / 7
  { id: 5, day: 0, wallet: "w3", cat: "politics", score: 80, map: "NONE", ev: 3 * H },                //  1 not mapped
  { id: 6, day: 0, wallet: "w3", score: 80, tradable: false, ev: H },                                 //  2 not tradable
  { id: 7, day: 0, wallet: "w4", kind: "CONVICTION_ADD", score: 80, ev: null },                       //  3 no usable timestamp
  { id: 8, day: 0, wallet: "w4", score: 80, ev: -10 * 60_000 },                                       //  4 event already started
  { id: 9, day: 0, wallet: "w5", score: 80, ev: 24 * H + 1000 },                                      //  5 24 h + 1 s
  { id: 10, day: 0, wallet: "w5", kind: "EARLY_ENTRY", score: 80, ev: 299_000 },                      //  6 299 s < MIN_LEAD
  // day B (Tue)
  { id: 11, day: 1, wallet: "w1", score: 100, ev: 300_000 },                                          //  7 exactly MIN_LEAD
  { id: 12, day: 1, wallet: "w1", cat: "crypto_short_term", score: 100, ev: 0 },                      //  4 time_to_event = 0 is not "not started"
  { id: 13, day: 1, wallet: "w1", score: null, ev: 2 * H },                                           //  0 missing score
  { id: 14, day: 1, wallet: "w6", score: 68, ev: H, proxy: true },                                    //  7
  { id: 15, day: 1, wallet: "w6", score: 68, ev: H, proxy: true },                                    //  7
  { id: 16, day: 1, wallet: "w6", cat: "politics", score: 95, map: "PROBABLE", tradable: false, ev: H }, //  1 / 2
  { id: 17, day: 1, wallet: "w7", cat: "esports", score: 70, ev: 5 * H },                             //  7
  { id: 18, day: 1, wallet: "w7", kind: "CONSENSUS", score: 40, map: "NONE", ev: H },                 //  0
  { id: 19, day: 1, wallet: "w8", score: 75, ev: 23 * H },                                            //  7
  { id: 20, day: 1, wallet: "w8", score: 75, map: "NONE", ev: H },                                    //  1
  // day C (Wed)
  { id: 21, day: 2, wallet: "w1", score: 80, ev: H }, { id: 22, day: 2, wallet: "w1", score: 80, ev: H }, //  7, 7
  { id: 23, day: 2, wallet: "w1", kind: "CONSENSUS", score: 80, ev: H }, { id: 24, day: 2, wallet: "w2", kind: "CONVICTION_ADD", score: 80, ev: H }, // 7, 7
  ...[25, 26, 27, 28, 29, 30].map((id): Spec => ({ id, day: 2, wallet: "w9", score: 50, ev: H })),   //  0 × 6
];
const mkRow = (s: Spec): FunnelRow => { const created = START + s.day * DAY + 6 * H + s.id * 60_000; return { signalId: `s${s.id}`, createdAtMs: created, evalMs: created, kind: s.kind ?? "NEW_POSITION", wallet: s.wallet, category: s.cat ?? "sports:basketball", copyScore: s.score, mapping: s.map ?? "EXACT", tradable: s.tradable === undefined ? true : s.tradable, eventMs: s.ev === null || s.ev === undefined ? null : created + s.ev, proxyWithin24h: s.score !== null && s.score >= 68 ? !!s.proxy : undefined }; };
const outside: FunnelRow[] = [
  { ...mkRow({ id: 0, day: 0, wallet: "wx", score: 99, ev: H }), createdAtMs: START - 1000, evalMs: START - 1000, eventMs: START - 1000 + H },        // a second before the window
  { ...mkRow({ id: 31, day: 0, wallet: "wx", score: 99, ev: H }), createdAtMs: END, evalMs: END, eventMs: END + H },                                  // exactly the end (half-open)
];
const ROWS = [...outside, ...SPECS.map(mkRow)];
const ALL = { mapping: true, tradable: true, timestamp: true };

describe("funnel counts, every stage (EXACT mappings)", () => {
  const f = computeFunnel(ROWS, { startMs: START, endMs: END, measured: ALL }); const e = f.variants.EXACT;
  it("cumulative stage counts", () => { expect(e.counts).toEqual([30, 21, 17, 16, 15, 13, 12, 11]); expect(f.stages.map((s) => s.key)).toEqual(["all", "score", "mapped", "tradable", "timestamp", "notStarted", "within24h", "minLead"]); });
  it("counts only the half-open window: a signal one second before the start, and one exactly at the end, are out", () => { expect(e.counts[0]).toBe(30); });
  it("where signals leave the funnel (first failing stage; sums to the signals that did not reach the end)", () => {
    expect(e.exits).toEqual({ score: 9, mapped: 4, tradable: 1, timestamp: 1, notStarted: 2, within24h: 1, minLead: 1 }); expect(Object.values(e.exits).reduce((a, b) => a + b, 0)).toBe(30 - 11);
  });
  it("wallets remaining at each stage, and the share of the final flow from the top three", () => {
    expect(e.wallets).toEqual([9, 8, 8, 7, 7, 6, 6, 5]); expect(e.topWallets.map((w) => [w.wallet, w.count])).toEqual([["w1", 5], ["w2", 2], ["w6", 2], ["w7", 1], ["w8", 1]]); expect(e.top3Share).toBeCloseTo(9 / 11, 12);
  });
  it("by signal kind and by category (cumulative per stage; each column sums to the stage total)", () => {
    expect(e.byKind).toEqual({ NEW_POSITION: [24, 16, 13, 12, 12, 10, 9, 9], CONSENSUS: [3, 2, 1, 1, 1, 1, 1, 1], CONVICTION_ADD: [2, 2, 2, 2, 1, 1, 1, 1], EARLY_ENTRY: [1, 1, 1, 1, 1, 1, 1, 0] });
    expect(e.byCategory).toEqual({ "sports:basketball": [25, 16, 15, 14, 13, 12, 11, 10], esports: [2, 2, 1, 1, 1, 1, 1, 1], politics: [2, 2, 0, 0, 0, 0, 0, 0], crypto_short_term: [1, 1, 1, 1, 1, 0, 0, 0] });
    for (const table of [e.byKind, e.byCategory]) for (let s = 0; s < 8; s++) expect(Object.values(table).reduce((a, c) => a + (c[s] as number), 0)).toBe(e.counts[s]);
  });
  it("per-day arithmetic: whole UTC days only for min / max / mean, exact elapsed time for the rate", () => {
    const pd = e.perDay.minLead!; expect(pd.completeDays).toMatchObject({ n: 3, min: 2, max: 5 }); expect(pd.completeDays.mean).toBeCloseTo(11 / 3, 12); expect(pd.perElapsedDay).toBeCloseTo(11 / 3, 12); expect(pd.elapsedDays).toBe(3);
    expect(pd.byWeekday).toMatchObject({ Mon: { days: 1, mean: 2, min: 2, max: 2 }, Tue: { days: 1, mean: 5 }, Wed: { days: 1, mean: 4 } });
    const sc = e.perDay.score!; expect(sc.completeDays).toMatchObject({ n: 3, min: 4, max: 9 }); expect(sc.completeDays.mean).toBe(7);
  });
  it("the date-level proxy counts score ≥ 68 with a same-day or next-day end date", () => { expect(f.proxy.scoreAndProxy).toBe(5); expect(f.proxy.perDay!.completeDays).toMatchObject({ n: 3, min: 0, max: 3 }); });
});

describe("EXACT + PROBABLE variant", () => {
  const f = computeFunnel(ROWS, { startMs: START, endMs: END, measured: ALL }).variants.EXACT_PLUS_PROBABLE;
  it("a PROBABLE mapping is counted only here: signal 4 reaches the end, signal 16 stops at the tradable stage", () => { expect(f.counts).toEqual([30, 21, 19, 17, 16, 14, 13, 12]); });
});

describe("unmeasured stages are null, never zero, and everything after them too", () => {
  it("no venue: only the first two stages are known", () => {
    const f = computeFunnel(ROWS, { startMs: START, endMs: END, measured: { mapping: false, tradable: false, timestamp: false } }).variants.EXACT;
    expect(f.counts).toEqual([30, 21, null, null, null, null, null, null]); expect(f.wallets).toEqual([9, 8, null, null, null, null, null, null]); expect(f.perDay.mapped).toBeNull(); expect(f.top3Share).toBeNull(); expect(f.topWallets).toEqual([]); expect(f.exits).toEqual({ score: 9 });
  });
  it("mapping and tradability measured but no timestamp field: stages 0–3 known", () => {
    const f = computeFunnel(ROWS, { startMs: START, endMs: END, measured: { mapping: true, tradable: true, timestamp: false } }).variants.EXACT;
    expect(f.counts).toEqual([30, 21, 17, 16, null, null, null, null]); expect(f.exits).toEqual({ score: 9, mapped: 4, tradable: 1 });
  });
});

describe("deepestStage boundaries", () => {
  const c = { scoreMin: 68, minLeadMs: 300_000, horizonMs: 24 * H, measured: ALL }; const base = mkRow({ id: 1, day: 0, wallet: "w", score: 80, ev: H });
  it("score 67 / 68", () => { expect(deepestStage({ ...base, copyScore: 67 }, "EXACT", c)).toBe(0); expect(deepestStage({ ...base, copyScore: 68 }, "EXACT", c)).toBe(7); expect(deepestStage({ ...base, copyScore: null }, "EXACT", c)).toBe(0); });
  it("tradable null counts as not tradable; an unknown timestamp counts as reject", () => { expect(deepestStage({ ...base, tradable: null }, "EXACT", c)).toBe(2); expect(deepestStage({ ...base, eventMs: null }, "EXACT", c)).toBe(3); });
  it("lead time: 0 → started, 1 ms → too close, 299.999 s → too close, 300 s → ok, 24 h → ok, 24 h + 1 ms → beyond", () => {
    const at = (t: number) => deepestStage({ ...base, eventMs: base.evalMs + t }, "EXACT", c);
    expect([at(-1), at(0), at(1), at(299_999), at(300_000), at(24 * H), at(24 * H + 1)]).toEqual([4, 4, 6, 6, 7, 7, 5]);
  });
});

describe("perDayStats", () => {
  it("excludes the two partial edge days from min / max / mean and divides the rate by the exact elapsed time", () => {
    const s = Date.parse("2026-09-27T12:00:00Z"), e = Date.parse("2026-09-30T18:00:00Z"); // partial Sun, whole Mon + Tue, partial Wed
    const ts = [s + 1000, s + 2000, START + H, START + 2 * H, START + 3 * H, START + DAY + H, e - 1000];
    const r = perDayStats(ts, s, e); expect(r.completeDays).toMatchObject({ n: 2, min: 1, max: 3 }); expect(r.completeDays.mean).toBe(2); expect(r.elapsedDays).toBe(3.25); expect(r.perElapsedDay).toBeCloseTo(7 / 3.25, 12); expect(Object.keys(r.byWeekday).sort()).toEqual(["Mon", "Tue"]);
  });
  it("a window shorter than a full day has no complete days and says so with nulls", () => { const r = perDayStats([START + H], START + H / 2, START + 5 * H); expect(r.completeDays).toEqual({ n: 0, mean: null, min: null, max: null }); expect(r.perElapsedDay).toBeCloseTo(1 / (4.5 / 24), 9); });
  it("a day with no signals counts as zero, so the minimum is honest", () => { const r = perDayStats([START + H, START + 2 * DAY + H], START, END); expect(r.completeDays).toMatchObject({ n: 3, min: 0, max: 1 }); });
});

describe("supplementary E1: detection lag within MAX_SIGNAL_AGE among the final-stage signals", () => {
  const lagRow = (id: number, lagS: number | null): FunnelRow => { const r = mkRow({ id, day: 0, wallet: "w1", score: 80, ev: 2 * H }); const eval2 = r.createdAtMs + (lagS ?? 0) * 1000; return { ...r, evalMs: eval2, eventMs: eval2 + 2 * H, lagObserved: lagS !== null }; };
  it("counts observed lags up to and including 600 s; unobserved lags are neither fresh nor stale", () => {
    const rows = [lagRow(1, 100), lagRow(2, 600), lagRow(3, 601), lagRow(4, null), lagRow(5, 3173), { ...lagRow(6, 100), lagObserved: undefined }]; // 6: a row from a caller that does not say
    const f = computeFunnel(rows, { startMs: START, endMs: END, measured: ALL }).variants.EXACT.freshAtFinal!;
    expect(f).toMatchObject({ maxSignalAgeMs: 600_000, finalCount: 6, lagObserved: 4, withinAge: 2 });
  });
  it("is null while the final stage is unmeasured, and the window / stage counts are unchanged by it", () => {
    expect(computeFunnel(ROWS, { startMs: START, endMs: END, measured: { mapping: true, tradable: true, timestamp: false } }).variants.EXACT.freshAtFinal).toBeNull();
    expect(computeFunnel(ROWS, { startMs: START, endMs: END, measured: ALL }).variants.EXACT.counts).toEqual([30, 21, 17, 16, 15, 13, 12, 11]);
  });
  it("a custom maximum age is honoured", () => { const f = computeFunnel([lagRow(1, 100), lagRow(2, 200)], { startMs: START, endMs: END, measured: ALL, maxSignalAgeMs: 150_000 }).variants.EXACT.freshAtFinal!; expect(f.withinAge).toBe(1); });
});

describe("the date-level row (NOT the V1 policy): Eastern calendar date implied by placeholder fields", () => {
  const noon = (day: number) => Date.UTC(2026, 8, day, 12, 0, 0); // 12:00Z = 08:00 Eastern: the same calendar date in both zones
  const row = (id: number, o: Partial<FunnelRow> = {}): FunnelRow => ({ signalId: `d${id}`, createdAtMs: noon(29), evalMs: noon(29), kind: "NEW_POSITION", wallet: `w${id}`, category: "sports:basketball", copyScore: 80, mapping: "EXACT", tradable: true, eventMs: null, impliedDateEt: "2026-09-29", ...o });
  const rows: FunnelRow[] = [
    row(1),                                         // date = the evaluation's Eastern date                         → 5
    row(2, { impliedDateEt: "2026-09-30" }),        // the next day                                                  → 5
    row(3, { impliedDateEt: "2026-10-01" }),        // two days ahead                                                → 4
    row(4, { impliedDateEt: "2026-09-28" }),        // the day before                                                → 4
    row(5, { impliedDateEt: null }),                // no date implied                                               → 3
    row(6, { tradable: false }),                    // not tradable                                                  → 2
    row(7, { mapping: "NONE" }),                    // not mapped                                                    → 1
    row(8, { copyScore: 50 }),                      // score below 68                                                → 0
    row(9, { mapping: "PROBABLE" }),                // PROBABLE with a date today: only in the +PROBABLE variant     → 1 / 5
    // evaluation at 02:00Z on 30 Sep = 22:00 Eastern on 29 Sep: the Eastern date is the 29th, not the UTC 30th
    row(10, { createdAtMs: Date.UTC(2026, 8, 30, 2, 0, 0), evalMs: Date.UTC(2026, 8, 30, 2, 0, 0), impliedDateEt: "2026-09-29" }),   // today (Eastern)   → 5
    row(11, { createdAtMs: Date.UTC(2026, 8, 30, 2, 0, 0), evalMs: Date.UTC(2026, 8, 30, 2, 0, 0), impliedDateEt: "2026-10-02" }),   // Eastern today + 3  → 4 (outside under either reading of "today")
  ];
  const f = computeFunnel(rows, { startMs: START, endMs: END, measured: ALL }); const dl = f.dateLevel;
  it("is labelled, and says that in-play and lead time cannot be evaluated at date level", () => { expect(dl.label).toBe("NOT THE V1 POLICY"); expect(dl.inPlayCheck).toBe("cannot be evaluated at date level"); expect(dl.leadCheck).toBe("cannot be evaluated at date level"); expect(dl.definition).toMatch(/no timestamp is verified/); expect(dl.stages.map((s) => s.key)).toEqual(["all", "score", "mapped", "tradable", "impliedDate", "dateToday"]); });
  it("counts each stage on a world with hand-derived answers, using the EASTERN date of the evaluation", () => {
    // score >= 68: all but 8 = 10; mapped (EXACT): 1-6, 10, 11 = 8; tradable: all but 6 = 7; implied date: all but 5 = 6; today/tomorrow Eastern: 1, 2, 10 = 3
    expect(dl.variants.EXACT.counts).toEqual([11, 10, 8, 7, 6, 3]);
    expect(dl.variants.EXACT_PLUS_PROBABLE.counts).toEqual([11, 10, 9, 8, 7, 4]);
  });
  it("gives eligible signals per day for the date-level row, from whole UTC days", () => { const pd = dl.variants.EXACT.perDay!; expect(pd.perElapsedDay).toBeCloseTo(3 / 3, 12); expect(pd.completeDays.n).toBe(3); expect(pd.completeDays.max).toBe(2); });
  it("is independent of the V1 funnel: with no usable timestamp the V1 final stage is 0 while the date-level row is not", () => { expect(f.variants.EXACT.counts[7]).toBe(0); expect(dl.variants.EXACT.counts[5]).toBe(3); });
  it("unmeasured stages are null here too", () => { const g = computeFunnel(rows, { startMs: START, endMs: END, measured: { mapping: false, tradable: false, timestamp: false } }).dateLevel.variants.EXACT; expect(g.counts).toEqual([11, 10, null, null, null, null]); expect(g.perDay).toBeNull(); });
});

describe("stage table", () => { it("is the brief's order", () => { expect(STAGES.map((s) => s.key)).toEqual(["all", "score", "mapped", "tradable", "timestamp", "notStarted", "within24h", "minLead"]); }); });
