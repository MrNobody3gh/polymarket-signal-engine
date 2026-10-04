/**
 * Phase 4.0d, Parts A2 and B — the merge and the feasibility matrix:
 *  - the arithmetic (timestamp share by stratum, window share, expected executable per day, required per day) against hand-computed values;
 *  - the whole pipeline through the real commands: per-venue audits, coverage and title searches → review → ingest → merge;
 *  - a missing venue is "not run", never zero; the verdict appears only under an approved rule that preceded the ingest; line limits;
 *  - the merge reads only files: no network, no database.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SlotVerdict } from "../src/lib/phase4/audit";
import { composeS1a, loadVenueFiles, renderFunnels, reviewResultsFile, runMerge } from "../src/lib/phase4/merge";
import { buildMatrix, expectedPerDay, renderMatrix, requiredBasis, stratumTime, timestampCoverage, windowShare, MATRIX_MAX_LINES } from "../src/lib/phase4/matrix";
import { requiredPerDayTable } from "../src/lib/phase4/feasibility";
import { parseStopRule } from "../src/lib/phase4/stop-rule";
import type { ReviewResults } from "../src/lib/phase4/review";
import { diagnoseCandidates } from "../src/lib/phase4/mapping";
import type { TitleSearchRow, VenueTitlesFile } from "../src/lib/phase4/title-search";
import { APPROVED_RULE, OUT, RULE, SHIPPED_RULE, buildVenueFiles, pipe, runMergeCli, runReviewIngestCli, runReviewSheetCli } from "./helpers/phase4Pipeline";
import { parseCsv, toCsv } from "../src/lib/phase4/stats";

const rec = (stratum: string, slot: 1 | 2, verdict: SlotVerdict["verdict"]): SlotVerdict => ({ venue: "kalshi", stratum, slot, field: verdict === "RECOMMEND" ? "f" : null, verdict, usableShare: 1, presentShare: 1, placeholderShare: 0, failed: [], evidence: {}, needsHumanReview: false, events: 100, markets: 100, etPlaceholderShare: 0, decidedBy: "allPassed", failedRules: [] });
const titleRow = (i: number, stratum: string, signals: number, o: { score?: number; proposed?: boolean } = {}): TitleSearchRow => { const same = o.proposed !== false; const pair = { conditionId: `0xc${i}`, tokenId: `t${i}`, title: "alpha bravo charlie", slug: null, outcome: "Yes", stratum: "x", score: o.score ?? 80, signals, wallet: "0xw", eventDate: null };
  return { pair, query: "q", error: null, diag: diagnoseCandidates({ conditionId: pair.conditionId, tokenId: pair.tokenId, title: pair.title, outcome: "Yes", slug: null, stratum: "x" }, [{ venue: "kalshi", marketId: `m${i}`, question: same ? "alpha bravo charlie" : "zulu yankee xray", outcomes: ["Yes", "No"], categories: [], stratum, slug: null, url: null, times: [], rules: null }]) }; };
const titles = (rows: TitleSearchRow[]): VenueTitlesFile => ({ schema: 1, kind: "titles", venue: "kalshi", startedAt: "a", finishedAt: "b", window: { startIso: "a", endIso: "b" }, allScores: false, listingCutOff: false, listingMarkets: 10, unsearched: { pairs: 0, signals: 0 }, summary: {} as never, stopped: null, heap: null, rows });

describe("timestamp share by stratum", () => {
  it("a stratum passes when a slot is RECOMMEND, fails when every judged slot is rejected, and is UNKNOWN when it has too little data or no row", () => {
    const r = [rec("a", 1, "RECOMMEND"), rec("a", 2, "UNRELIABLE_REJECT"), rec("b", 1, "UNRELIABLE_REJECT"), rec("b", 2, "UNRELIABLE_REJECT"), rec("c", 1, "UNRELIABLE_REJECT"), rec("c", 2, "INSUFFICIENT_DATA")];
    expect(stratumTime(r, "a")).toBe("passes"); expect(stratumTime(r, "b")).toBe("fails"); expect(stratumTime(r, "c")).toBe("unknown"); expect(stratumTime(r, "zzz")).toBe("unknown");
  });
  it("lower and point count passes only; the upper bound adds the unknown strata; weighted by the signals behind each proposed pair", () => {
    const recs = [rec("a", 1, "RECOMMEND"), rec("b", 1, "UNRELIABLE_REJECT"), rec("b", 2, "UNRELIABLE_REJECT"), rec("c", 1, "INSUFFICIENT_DATA")];
    const t = titles([titleRow(1, "a", 6), titleRow(2, "b", 2), titleRow(3, "c", 2), titleRow(4, "a", 100, { proposed: false }), titleRow(5, "a", 100, { score: 50 })]); const c = timestampCoverage(recs, t);
    expect(c).toMatchObject({ status: "measured", pairs: 3, passes: 6, fails: 2, unknown: 2 }); expect(c.tri.lower).toBeCloseTo(0.6, 12); expect(c.tri.point).toBeCloseTo(0.6, 12); expect(c.tri.upper).toBeCloseTo(0.8, 12);
  });
  it("no field passes anywhere: 'no field passes', lower and point 0 BY CONSTRUCTION, the unknown strata still in the upper bound (not evidence about the venue)", () => {
    const c = timestampCoverage([rec("a", 1, "UNRELIABLE_REJECT"), rec("a", 2, "UNRELIABLE_REJECT"), rec("c", 1, "INSUFFICIENT_DATA")], titles([titleRow(1, "a", 3), titleRow(2, "c", 1)])); expect(c.status).toBe("no field passes"); expect(c.tri).toEqual({ lower: 0, point: 0, upper: 0.25 }); expect(c.note).toContain("by construction");
  });
  it("no audit file: lower 0, point n/m, upper 1 (unknown, not zero); no proposed pairs: the same", () => {
    expect(timestampCoverage(null, titles([titleRow(1, "a", 3)]))).toMatchObject({ status: "audit not run", tri: { lower: 0, point: null, upper: 1 } }); expect(timestampCoverage([rec("a", 1, "RECOMMEND")], titles([titleRow(1, "a", 3, { proposed: false })]))).toMatchObject({ status: "no proposed pairs", tri: { lower: 0, point: null, upper: 1 } });
  });
});

describe("expected verified-executable eligible signals per day", () => {
  const review = (share: { lo: number; point: number | null; hi: number }, fn = 15): ReviewResults => ({ falseNegatives: { sampled: fn }, extrapolation: { share } } as unknown as ReviewResults);
  const tri = (lower: number | null, point: number | null, upper: number | null) => ({ lower, point, upper });
  it("is the product of the signal rate and the per-factor bounds", () => {
    const e = expectedPerDay({ score68PerDay: 200, review: review({ lo: 0.2, point: 0.3, hi: 0.5 }), window: tri(0.1, 0.2, 0.4), ts: tri(0.5, 0.6, 0.9), cutOff: false, minFalseNegativeRows: 15 });
    expect(e.tri.lower).toBeCloseTo(200 * 0.2 * 0.1 * 0.5, 12); expect(e.tri.point).toBeCloseTo(200 * 0.3 * 0.2 * 0.6, 12); expect(e.tri.upper).toBeCloseTo(200 * 0.5 * 0.4 * 0.9, 12); expect(e.upperOpen).toBe(false);
  });
  it("an unmeasured factor is n/m in the point, 0 in the lower bound and 1 in the upper bound — never a zero point", () => {
    const base = { score68PerDay: 100, window: tri(0, null, 1), ts: tri(0, null, 1), cutOff: false, minFalseNegativeRows: 15 };
    const none = expectedPerDay({ ...base, review: null }); expect(none.tri).toEqual({ lower: 0, point: null, upper: 100 }); expect(none.notes.join()).toContain("no review ingested");
    const unmeasured = expectedPerDay({ ...base, review: review({ lo: 0.2, point: null, hi: 0.5 }), window: tri(0.1, 0.2, 0.4), ts: tri(0.5, 0.6, 0.9) }); expect(unmeasured.tri.point).toBeNull(); expect(unmeasured.tri.lower).toBeGreaterThan(0);
    expect(expectedPerDay({ ...base, review: review({ lo: 0.2, point: 0.3, hi: 0.5 }), window: tri(0.1, null, 0.4), ts: tri(0.5, 0.6, 0.9) }).tri.point).toBeNull(); expect(expectedPerDay({ ...base, review: review({ lo: 0.2, point: 0.3, hi: 0.5 }), window: tri(0.1, 0.2, 0.4), ts: tri(0.5, null, 0.9) }).tri.point).toBeNull();
  });
  it("a cut-off listing leaves the upper bound OPEN unless enough below-0.30 rows were reviewed (the owner searched the venue by hand)", () => {
    const f = { score68PerDay: 100, window: tri(0.1, 0.2, 0.4), ts: tri(0.5, 0.6, 0.9), minFalseNegativeRows: 15 };
    const open = expectedPerDay({ ...f, review: review({ lo: 0.2, point: 0.3, hi: 0.5 }, 14), cutOff: true }); expect(open.upperOpen).toBe(true); expect(open.tri.upper).toBeNull(); expect(open.tri.lower).not.toBeNull(); expect(open.notes.join()).toContain("OPEN");
    const closed = expectedPerDay({ ...f, review: review({ lo: 0.2, point: 0.3, hi: 0.5 }, 15), cutOff: true }); expect(closed.upperOpen).toBe(false); expect(closed.tri.upper).not.toBeNull(); expect(expectedPerDay({ ...f, review: null, cutOff: true }).upperOpen).toBe(true); expect(expectedPerDay({ ...f, review: review({ lo: 0.2, point: 0.3, hi: 0.5 }, 0), cutOff: false }).upperOpen).toBe(false);
  });
  it("no signal rate (no coverage run) gives all n/m", () => { expect(expectedPerDay({ score68PerDay: null, review: null, window: tri(0, null, 1), ts: tri(0, null, 1), cutOff: false, minFalseNegativeRows: 15 }).tri).toEqual({ lower: null, point: null, upper: null }); });
});

describe("the window share", () => {
  const cov = (counts: (number | null)[], proxy: number | null, withScore: number) => ({ counts: { withScore }, funnel: { variants: { EXACT_PLUS_PROBABLE: { counts } }, proxy: { scoreAndProxy: proxy } } }) as never;
  it("measured survival needs at least 30 dated signals; below that the lower bound is 0 and the proxy gives the point and the upper bound", () => {
    expect(windowShare(cov([100, 80, 50, 40, 30, 20, 15, 12], 40, 80)).tri).toEqual({ lower: 0.4, point: 0.4, upper: 0.5 }); expect(windowShare(cov([100, 80, 50, 40, 29, 20, 15, 12], 40, 80)).tri).toEqual({ lower: 0, point: 0.5, upper: 0.5 }); expect(windowShare(cov([100, 80, 50, 40, null, null, null, null], null, 80)).tri).toEqual({ lower: 0, point: null, upper: 1 });
    expect(windowShare(null).tri).toEqual({ lower: 0, point: null, upper: 1 }); expect(windowShare(cov([1, 1, 0, 0, 0, 0, 0, 0], 99, 10)).tri.upper).toBe(1); // a proxy cannot exceed 1
  });
  it("another venue's coverage file supplies the proxy when this one has none (it comes from the database)", () => { expect(windowShare(cov([100, 80, 0, 0, 0, 0, 0, 0], null, 80), cov([], 20, 80)).tri.upper).toBe(0.25); });
});

describe("required per day (the feasibility library, known answers)", () => {
  it("SD 89, DEFF 1, no lag, 84 days: 1,244 per arm at 10 points and 29.62 / 59.24 / 148.10 signals per day at 50 / 25 / 10 % acceptance; 553 per arm at 15 points", () => {
    const rows = requiredPerDayTable({ sd: 89, deff: 1, lagDays: 0 }); expect(rows).toHaveLength(6); const get = (e: number, a: number) => rows.find((r) => r.effectPts === e && r.acceptRate === a)!;
    expect(get(10, 0.5).perArm).toBe(1244); expect(get(10, 0.5).requiredEligiblePerDay).toBeCloseTo(1244 / (84 * 0.5), 9); expect(get(10, 0.25).requiredEligiblePerDay).toBeCloseTo(1244 / (84 * 0.25), 9); expect(get(10, 0.1).requiredEligiblePerDay).toBeCloseTo(1244 / (84 * 0.1), 9); expect(get(15, 0.5).perArm).toBe(553); expect(get(15, 0.25).requiredEligiblePerDay).toBeCloseTo(553 / 21, 9);
  });
  it("the design effect multiplies the sample, the settlement lag shortens the usable window, the settled share lowers the yield, a lag beyond the window gives null", () => {
    const a = requiredPerDayTable({ sd: 89, deff: 2, lagDays: 14, windowDays: 84, settledShare: 0.8, effects: [10], acceptRates: [0.5] })[0]; expect(a.perArm).toBe(2487); expect(a.usableDays).toBe(70); expect(a.requiredEligiblePerDay).toBeCloseTo(2487 / (70 * 0.5 * 0.8), 9);
    expect(requiredPerDayTable({ sd: 89, deff: 1, lagDays: 84, effects: [10], acceptRates: [0.5] })[0].requiredEligiblePerDay).toBeNull(); expect(requiredPerDayTable({ sd: 89, deff: 1, lagDays: 90, effects: [10], acceptRates: [0.5] })[0].requiredEligiblePerDay).toBeNull();
  });
  it("an acceptance rate above 50 % uses the scarcer REJECT arm (symmetric)", () => { const r = requiredPerDayTable({ sd: 89, deff: 1, lagDays: 0, effects: [10], acceptRates: [0.9, 0.1] }); expect(r[0].requiredEligiblePerDay).toBeCloseTo(r[1].requiredEligiblePerDay!, 9); });
  it("requiredBasis takes the eligible-like subset only when it has enough trades, else all settled trades", () => {
    const sub = (name: string, n: number, sd: number) => ({ stats: { name, n, sdPts: sd, deff: 1.5, holdP90Days: 2 } });
    const file = (el: number) => ({ result: { feasibility: { subsets: [sub("all settled trades", 500, 80), sub("eligible-like subset (proxy)", el, 60)] }, settled: { fillShare: 0.5 } } }) as never; const rule = { windowDays: 84, effectsPts: [10, 15], acceptRates: [0.25, 0.5], minTrades: 100 };
    expect(requiredBasis([file(100)], rule)!.subset).toContain("eligible-like"); expect(requiredBasis([file(99)], rule)!.subset).toBe("all settled trades"); expect(requiredBasis([file(100)], rule)!.settledShare).toBe(0.5); expect(requiredBasis([null, { result: null } as never], rule)).toBeNull();
    expect(requiredBasis([file(100)], rule)!.rows.find((r) => r.effectPts === 10 && r.acceptRate === 0.5)!.requiredEligiblePerDay).toBeCloseTo(requiredPerDayTable({ sd: 60, deff: 1.5, lagDays: 2, effects: [10], acceptRates: [0.5], settledShare: 0.5 })[0].requiredEligiblePerDay!, 9);
  });
});

describe("the whole pipeline through the real commands", () => {
  it("per-venue files → merge: four documents, ≤ 60 console lines, the matrix ≤ 100 lines, the compact file ≤ 80 lines, an unapproved rule prints numbers and no verdict", async () => {
    const p = pipe(); await buildVenueFiles(p, { allScores: true }); expect(Object.values(p.codes).every((c) => c === 0)).toBe(true);
    expect(await p.run("merge", runMergeCli, [])).toBe(0); expect(p.lines.merge.length).toBeLessThanOrEqual(60); for (const f of ["S1a_RESULTS.md", "S1_COMPACT.md", "FEASIBILITY_MATRIX.md", "S1b_FUNNELS.md"]) expect(p.fs[`${OUT}/${f}`], f).toBeTruthy();
    expect(p.fs[`${OUT}/FEASIBILITY_MATRIX.md`].trim().split("\n").length).toBeLessThanOrEqual(MATRIX_MAX_LINES); expect(p.fs[`${OUT}/S1_COMPACT.md`].trim().split("\n").length).toBeLessThanOrEqual(80);
    const m = p.fs[`${OUT}/FEASIBILITY_MATRIX.md`]; expect(m).toContain("**NOT approved**"); expect(m).toContain("UNDETERMINED: stop rule not approved"); expect(m).not.toMatch(/\*\*(FEASIBLE|INFEASIBLE)\*\*/); expect(m).toContain("| US | execution candidate |"); expect(m).toContain("| Kalshi | execution candidate |"); expect(m).toContain("| Intl | signal source |");
    expect(p.lines.merge.join("\n")).toContain("NOT approved: no verdict will be printed"); expect(p.lines.merge.join("\n")).toMatch(/required eligible signals\/day \(all settled trades, n 8/);
  });
  it("the S1a document is composed from the audit files, with every missing venue listed as NOT RUN and the merged runs tabulated", async () => {
    const p = pipe(); await buildVenueFiles(p); await p.run("merge", runMergeCli, []); const md = p.fs[`${OUT}/S1a_RESULTS.md`]; expect(md).toContain("## polymarket_us"); expect(md).toContain("## kalshi"); expect(md).not.toContain("## polymarket_intl"); expect(md).toContain("polymarket_intl: NOT RUN (no v_polymarket_intl_audit.json"); expect(md).toContain("separate processes"); expect(md).toContain("| kalshi | v_kalshi_audit.json | run |"); expect(md).toContain("| polymarket_intl | v_polymarket_intl_audit.json | not run |");
  });
  it("a venue whose files are missing is 'not run' everywhere and never a zero: the matrix, the compact table, the funnels, the console", async () => {
    const p = pipe(); await buildVenueFiles(p); for (const k of Object.keys(p.fs)) if (k.includes("v_kalshi_")) delete p.fs[k]; await p.run("merge", runMergeCli, []);
    const m = p.fs[`${OUT}/FEASIBILITY_MATRIX.md`]; const kRow = m.split("\n").find((l) => l.startsWith("| Kalshi |"))!; expect(kRow).toContain("not run"); expect(kRow).not.toMatch(/\b0\.0\b/); expect(kRow).toContain("not run · all scores: not run"); expect(kRow.split("|").slice(-4, -1).map((x) => x.trim())).toEqual(["not run", "not run", "not run"]); expect(m).toContain("files: audit not run · coverage not run · titles not run · review not run");
    const c = p.fs[`${OUT}/S1_COMPACT.md`]; expect(c).toContain("| Kalshi | (venue) | — | — | NOT RUN | n/m |"); expect(c).toMatch(/\| stage \| US \| Kalshi \|/); expect(c).toMatch(/\| all entry signals \| 8 \/ 8 \| not run \|/); expect(c).toContain("Kalshi not run"); expect(p.fs[`${OUT}/S1b_FUNNELS.md`]).toContain(`Coverage: **not run** (no v_kalshi_coverage.json)`); expect(p.lines.merge.join("\n")).toMatch(/kalshi\s+audit not run · coverage not run · titles not run · review not run/);
    expect(p.lines.merge.join("\n")).toMatch(/kalshi: expected verified-executable eligible\/day not run/);
  });
  it("a STOPPED run (heap budget) is shown as stopped, not as not run and not as zero", async () => {
    const p = pipe(); await buildVenueFiles(p); const f = JSON.parse(p.fs[`${OUT}/v_kalshi_audit.json`]); p.fs[`${OUT}/v_kalshi_audit.json`] = JSON.stringify({ ...f, audit: null, stopped: { reason: "heap_budget", stage: "listing, request 41", message: "STOPPED (heap budget): venue kalshi" } }); await p.run("merge", runMergeCli, []);
    expect(p.fs[`${OUT}/S1_COMPACT.md`]).toContain("| Kalshi | (venue) | — | — | STOPPED |"); expect(p.fs[`${OUT}/S1a_RESULTS.md`]).toContain('kalshi: STOPPED at stage "listing, request 41"'); expect(p.lines.merge.join("\n")).toContain("STOPPED (heap_budget)");
  });
  it("unreadable or foreign files are treated as missing, never as data", async () => {
    const p = pipe(); await buildVenueFiles(p); p.fs[`${OUT}/v_kalshi_titles.json`] = "{not json"; p.fs[`${OUT}/v_polymarket_us_coverage.json`] = JSON.stringify({ schema: 1, kind: "coverage", venue: "kalshi" }); await p.run("merge", runMergeCli, []);
    expect(p.lines.merge.join("\n")).toMatch(/kalshi\s+audit run · coverage run · titles not run/); expect(p.lines.merge.join("\n")).toMatch(/polymarket_us\s+audit run · coverage not run · titles run/);
  });
  it("end to end under an approved rule that was committed BEFORE the ingest: the verdict is issued; after an edit it is withheld", async () => {
    const p = pipe(); await buildVenueFiles(p, { allScores: true }); p.fs[RULE] = APPROVED_RULE;
    expect(await p.run("sheet", runReviewSheetCli, ["--venue", "kalshi", "--n", "10"], { db: null, env: {} })).toBe(0); expect(p.fs[`${OUT}/s1d_review_kalshi.csv`]).toBeTruthy();
    const t = parseCsv(p.fs[`${OUT}/s1d_review_kalshi.csv`]); const h = t[0]; const filled = toCsv(h, t.slice(1).map((r) => r.map((x, k) => (/^(QUESTION|OUTCOME|TIME|RESOLUTION) /.test(h[k]) ? "Y" : x)))); p.fs["/tmp/filled.csv"] = filled;
    expect(await p.run("ingest", runReviewIngestCli, ["--file", "/tmp/filled.csv"], { db: null, env: {} })).toBe(0); expect(p.fs[`${OUT}/${reviewResultsFile("kalshi")}`]).toBeTruthy();
    await p.run("merge", runMergeCli, []); const m = p.fs[`${OUT}/FEASIBILITY_MATRIX.md`]; expect(m).toContain("**approved**"); const kRow = m.split("\n").find((l) => l.startsWith("| Kalshi |"))!; expect(kRow).toMatch(/\*\*(FEASIBLE|INFEASIBLE|UNDETERMINED)\*\*/); expect(kRow).not.toContain("not approved"); expect(kRow).toMatch(/\| 3 \/ 0 \/ 0 of 3 \|/.test(kRow) ? /x/ : /\|/);
    p.fs[RULE] = JSON.stringify({ ...JSON.parse(APPROVED_RULE), infeasible: { effectPts: 15, acceptRate: 0.1, when: "upper_bound_below_required" } }); await p.run("merge2", runMergeCli, []); const k2 = p.fs[`${OUT}/FEASIBILITY_MATRIX.md`].split("\n").find((l) => l.startsWith("| Kalshi |"))!; expect(k2).toContain("changed after the review results were ingested"); expect(k2).not.toMatch(/\*\*(FEASIBLE|INFEASIBLE|UNDETERMINED)\*\*/);
  });
  it("review ingested BEFORE the rule was approved: no verdict even though the rule is now approved (ingest again)", async () => {
    const p = pipe(); await buildVenueFiles(p, { allScores: true }); await p.run("sheet", runReviewSheetCli, ["--venue", "kalshi", "--n", "10"], { db: null, env: {} });
    const t = parseCsv(p.fs[`${OUT}/s1d_review_kalshi.csv`]); const h = t[0]; p.fs["/tmp/filled.csv"] = toCsv(h, t.slice(1).map((r) => r.map((x, k) => (/^(QUESTION|OUTCOME|TIME|RESOLUTION) /.test(h[k]) ? "N" : x)))); await p.run("ingest", runReviewIngestCli, ["--file", "/tmp/filled.csv"], { db: null, env: {} });
    p.fs[RULE] = APPROVED_RULE; await p.run("merge", runMergeCli, []); const k = p.fs[`${OUT}/FEASIBILITY_MATRIX.md`].split("\n").find((l) => l.startsWith("| Kalshi |"))!; expect(k).toContain("ingested before the stop rule was approved");
  });
  it("an invalid stop rule file is reported and no verdict is printed", async () => { const p = pipe(); await buildVenueFiles(p); p.fs[RULE] = "{}"; await p.run("merge", runMergeCli, []); expect(p.fs[`${OUT}/FEASIBILITY_MATRIX.md`]).toContain("INVALID"); expect(p.lines.merge.join("\n")).toContain("INVALID"); });
});

describe("the merge reads files only", () => {
  const src = (p: string) => readFileSync(p, "utf8"); const imports = (p: string) => [...src(p).matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  it("merge.ts, matrix.ts, review.ts and stop-rule.ts import no network client and no database", () => {
    for (const f of ["merge", "matrix", "review", "stop-rule"]) for (const i of imports(`src/lib/phase4/${f}.ts`)) { expect(i, f).not.toMatch(/\/http$|readonly-db|\.\.\/db$|supabase|cli$|venues$/); }
    expect(src("src/lib/phase4/merge.ts")).not.toMatch(/fetch\(|getJson|\.select\(|PoliteHttp/);
  });
  it("runMerge asks only for files under the output directory and the stop rule", () => {
    const asked: string[] = []; runMerge({ read: (p) => { asked.push(p); return null; }, outDir: "x/out", stopRulePath: "x/rule.json" }); expect(asked.every((p) => p.startsWith("x/out/") || p === "x/rule.json")).toBe(true); expect(asked).toContain("x/out/v_kalshi_audit.json"); expect(asked).toContain("x/rule.json");
  });
  it("with no file at all everything is 'not run' and the merge still finishes", () => {
    const m = runMerge({ read: () => null, outDir: "o" }); expect(m.lines.length).toBeLessThanOrEqual(60); expect(m.files["FEASIBILITY_MATRIX.md"]).toContain("not run"); expect(m.files["S1a_RESULTS.md"]).toContain("NOT RUN"); expect(renderFunnels(loadVenueFiles(() => null, "o"))).toContain("not run"); expect(composeS1a(loadVenueFiles(() => null, "o"), "o").result.venues).toEqual([]);
    expect(buildMatrix(loadVenueFiles(() => null, "o"), parseStopRule(null), null, RULE).rows.every((r) => r.evaluation === null || r.evaluation.issued === false)).toBe(true); expect(renderMatrix(buildMatrix(loadVenueFiles(() => null, "o"), parseStopRule(SHIPPED_RULE), SHIPPED_RULE, RULE))).toContain("not run: the required signals per day are not computed");
  });
});
