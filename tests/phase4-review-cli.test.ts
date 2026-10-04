/**
 * Phase 4.0d, Part C and the US title-search pace/resume/refusal rules, through the command-line entry points:
 *  - review-sheet and review-ingest need no network and no database, validate, write the documented files, print ≤ 60 lines, and return exit 2 on a bad sheet;
 *  - the US title search never goes faster than the polite floor, may go slower (recorded), stops at a refusal without retry or any workaround,
 *    records how many pairs were reached, and --resume continues exactly where a refused run stopped.
 */
import { describe, expect, it } from "vitest";
import { EXIT, runTitleSearchCli } from "../src/lib/phase4/cli";
import { runReviewIngestCli, runReviewSheetCli } from "../src/lib/phase4/cli-review";
import { readOnly } from "../src/lib/phase4/readonly-db";
import { parseCsv, toCsv } from "../src/lib/phase4/stats";
import type { VenueTitlesFile } from "../src/lib/phase4/title-search";
import { fakeFetch, json, memDb, virtualClock } from "./helpers/phase4Db";
import { APPROVED_RULE, ENV, NOW, OUT, RULE, SHIPPED_RULE, buildVenueFiles, pipe } from "./helpers/phase4Pipeline";

const z = (s: string) => new Date(Date.parse(s)).toISOString();
describe("review-sheet and review-ingest", () => {
  const prepare = async () => { const p = pipe(); await buildVenueFiles(p, { allScores: true }); return p; };
  it("review-sheet: no network, no database; writes the CSV, prints the strata and bands, ≤ 60 lines; --print-files prints the sheet paced", async () => {
    const p = await prepare(); let touched = 0; const before = p.calls.length;
    expect(await p.run("sheet", runReviewSheetCli, ["--venue", "kalshi", "--print-files"], { db: null, env: {}, extra: { fetch: (() => { touched++; throw new Error("network"); }) as never } })).toBe(0); expect(touched).toBe(0); expect(p.calls.length).toBe(before);
    const l = p.lines.sheet; expect(l.length).toBeGreaterThan(5); expect(l.filter((x) => !x.startsWith("=====") && !x.startsWith("r0") && !x.includes(",")).length).toBeLessThanOrEqual(60); expect(l[0]).toContain("review sheet for kalshi"); expect(l.join("\n")).toContain("=====FILE s1d_review_kalshi.csv"); expect(l.join("\n")).toContain("=====END s1d_review_kalshi.csv");
    const csv = p.fs[`${OUT}/s1d_review_kalshi.csv`]; expect(parseCsv(csv)[0][0]).toBe("row_id"); expect(parseCsv(csv).length).toBeGreaterThan(1);
  });
  it("review-sheet: --n and --seed are honoured; a venue without a titles file is refused with the command to run", async () => {
    const p = await prepare(); await p.run("a", runReviewSheetCli, ["--venue", "kalshi", "--n", "2", "--seed", "x"], { db: null, env: {} }); expect(parseCsv(p.fs[`${OUT}/s1d_review_kalshi.csv`]).length - 1).toBeLessThanOrEqual(2); expect(parseCsv(p.fs[`${OUT}/s1d_review_kalshi.csv`])[1][parseCsv(p.fs[`${OUT}/s1d_review_kalshi.csv`])[0].indexOf("seed")]).toBe("x");
    const q = pipe(); expect(await q.run("b", runReviewSheetCli, ["--venue", "kalshi"], { db: null, env: {} })).toBe(EXIT.CONFIG); expect(q.lines.b.join(" ")).toContain("phase4:title-search -- --venue kalshi"); expect(await q.run("c", runReviewSheetCli, ["--venue", "polymarket_intl"], { db: null, env: {} })).toBe(EXIT.CONFIG); expect(await q.run("d", runReviewSheetCli, [], { db: null, env: {} })).toBe(EXIT.CONFIG);
  });
  it("review-sheet records the pairs the title search did NOT reach as unknown in the sheet", async () => {
    const p = await prepare(); const f = JSON.parse(p.fs[`${OUT}/v_kalshi_titles.json`]) as VenueTitlesFile; f.unsearched = { pairs: 7, signals: 19 }; p.fs[`${OUT}/v_kalshi_titles.json`] = JSON.stringify(f); await p.run("s", runReviewSheetCli, ["--venue", "kalshi"], { db: null, env: {} });
    expect(p.lines.s.join(" ")).toContain("7 pairs (19 signals) were NOT searched"); const t = parseCsv(p.fs[`${OUT}/s1d_review_kalshi.csv`]); expect(t[1][t[0].indexOf("unsearched_pairs")]).toBe("7"); expect(t[1][t[0].indexOf("unsearched_signals")]).toBe("19");
  });
  const fillAll = (csv: string, ans: (i: number) => string) => { const t = parseCsv(csv); const h = t[0]; return toCsv(h, t.slice(1).map((r, i) => r.map((x, k) => (/^(QUESTION|OUTCOME|TIME|RESOLUTION) /.test(h[k]) ? ans(i) : x)))); };
  it("review-ingest: reads a local file, writes the results JSON and CSV, prints ≤ 60 lines, records the stop rule stamp; no network, no database", async () => {
    const p = await prepare(); await p.run("sheet", runReviewSheetCli, ["--venue", "kalshi"], { db: null, env: {} }); p.fs["/home/me/filled.csv"] = fillAll(p.fs[`${OUT}/s1d_review_kalshi.csv`], () => "Y"); const before = p.calls.length;
    expect(await p.run("ingest", runReviewIngestCli, ["--file", "/home/me/filled.csv", "--print-files"], { db: null, env: {} })).toBe(0); expect(p.calls.length).toBe(before); expect(p.lines.ingest.slice(0, p.lines.ingest.indexOf("=====FILE s1d_review_results_kalshi.json")).length).toBeLessThanOrEqual(60);
    const r = JSON.parse(p.fs[`${OUT}/s1d_review_results_kalshi.json`]); expect(r).toMatchObject({ kind: "review", venue: "kalshi", file: "/home/me/filled.csv", stopRule: { path: RULE, approved: false } }); expect(r.stopRule.sha256).toMatch(/^[0-9a-f]{64}$/); expect(p.fs[`${OUT}/s1d_review_results_kalshi.csv`]).toContain("TIME_AUTO unknown"); expect(p.lines.ingest.join("\n")).toContain("=====FILE s1d_review_results_kalshi.json");
  });
  it("review-ingest records an APPROVED rule's hash when the rule was approved first", async () => {
    const p = await prepare(); p.fs[RULE] = APPROVED_RULE; await p.run("sheet", runReviewSheetCli, ["--venue", "kalshi"], { db: null, env: {} }); p.fs["/f.csv"] = fillAll(p.fs[`${OUT}/s1d_review_kalshi.csv`], () => "Y"); await p.run("ingest", runReviewIngestCli, ["--file", "/f.csv"], { db: null, env: {} });
    expect(JSON.parse(p.fs[`${OUT}/s1d_review_results_kalshi.json`]).stopRule).toMatchObject({ approved: true }); expect(SHIPPED_RULE).not.toBe(APPROVED_RULE);
  });
  it("review-ingest: a sheet with missing or unknown answers is refused with exit 2, the rows named, NOTHING written", async () => {
    const p = await prepare(); await p.run("sheet", runReviewSheetCli, ["--venue", "kalshi"], { db: null, env: {} }); const keys = Object.keys(p.fs).length;
    p.fs["/bad.csv"] = fillAll(p.fs[`${OUT}/s1d_review_kalshi.csv`], (i) => (i === 0 ? "maybe" : "Y")); expect(await p.run("ingest", runReviewIngestCli, ["--file", "/bad.csv"], { db: null, env: {} })).toBe(EXIT.CONFIG); expect(p.lines.ingest.join("\n")).toContain('r001: QUESTION is "maybe" (allowed: Y, N, U)'); expect(p.lines.ingest.join("\n")).toContain("nothing was computed or written");
    p.fs["/empty.csv"] = p.fs[`${OUT}/s1d_review_kalshi.csv`]; expect(await p.run("ingest2", runReviewIngestCli, ["--file", "/empty.csv"], { db: null, env: {} })).toBe(EXIT.CONFIG); expect(p.lines.ingest2.length).toBeLessThanOrEqual(45);
    expect(Object.keys(p.fs).length).toBe(keys + 2); expect(p.fs[`${OUT}/s1d_review_results_kalshi.json`]).toBeUndefined(); // only the two files this test itself added
    expect(await p.run("ingest3", runReviewIngestCli, [], { db: null, env: {} })).toBe(EXIT.CONFIG); expect(await p.run("ingest4", runReviewIngestCli, ["--file", "/nope.csv"], { db: null, env: {} })).toBe(EXIT.CONFIG); expect(p.lines.ingest4.join(" ")).toContain("cannot read");
  });
});

describe("US title search: pace, refusal, resume", () => {
  const sigs = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, kind: "NEW_POSITION", wallet: `0xw${i}`, condition_id: `0xc${String(i).padStart(2, "0")}`, token_id: `t${i}`, outcome: "Yes", title: `Team${i}a vs Team${i}b`, slug: `s${i}`, created_at: z("2026-10-02T10:00:00Z"), payload: { copyScore: 70 + i } }));
  const answer = (q: string) => json({ events: [{ title: q, slug: "e", markets: [{ id: `u-${q}`, question: q, outcomes: '["Yes","No"]' }] }] });
  const run = async (argv: string[], h: (u: URL, n: number) => Response, prior?: Record<string, string>) => {
    const c = virtualClock(NOW); let n = 0; const f = fakeFetch((u) => { if (u.pathname !== "/v1/search") return new Response("no", { status: 404 }); n++; return h(u, n); }, c.now); const out: Record<string, string> = { ...(prior ?? {}) }; const lines: string[] = [];
    const code = await runTitleSearchCli(argv, ENV, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: (p, x) => { out[p] = x; }, mkdir() {}, readFile: (p) => out[p] ?? null, log: (l) => lines.push(l), db: () => readOnly(memDb({ signals: sigs.map((s) => ({ ...s })) }).db as never) }); return { code, f, out, lines };
  };
  const titles = (r: { out: Record<string, string> }) => JSON.parse(r.out[`${OUT}/v_polymarket_us_titles.json`]) as VenueTitlesFile;
  const gaps = (f: { calls: { at: number | null }[] }) => f.calls.slice(1).map((c, i) => c.at! - f.calls[i].at!);

  it("the default pace is the polite floor (1,100 ms), recorded; a request below the floor is raised to it with a note; a slower pace is honoured and recorded", async () => {
    const a = await run(["--venue", "us"], (u) => answer(u.searchParams.get("query")!)); expect(titles(a).summary).toMatchObject({ paceMs: 1100, requestsPerMinute: 54.5 }); for (const g of gaps(a.f)) expect(g).toBeGreaterThanOrEqual(1100);
    const b = await run(["--venue", "us", "--us-search-pace-ms", "300"], (u) => answer(u.searchParams.get("query")!)); expect(titles(b).summary.paceMs).toBe(1100); expect(b.lines.join("\n")).toContain("below the polite floor: using 1100 ms"); for (const g of gaps(b.f)) expect(g).toBeGreaterThanOrEqual(1100);
    const c = await run(["--venue", "us", "--us-search-pace-ms", "3000"], (u) => answer(u.searchParams.get("query")!)); expect(titles(c).summary).toMatchObject({ paceMs: 3000, requestsPerMinute: 20 }); for (const g of gaps(c.f)) expect(g).toBeGreaterThanOrEqual(3000); expect(c.lines.join("\n")).toContain("pace 3000 ms (20/min)");
    expect((await run(["--venue", "us", "--us-search-pace-ms", "abc"], () => answer("x"))).code).toBe(EXIT.CONFIG); expect((await run(["--venue", "us", "--us-search-pace-ms", "-5"], () => answer("x"))).code).toBe(EXIT.CONFIG);
  });
  it("a 403 stops THIS run at once: no retry, no second request to that host, the pairs reached are recorded, the rest are unknown, no slower attempt in the same run", async () => {
    const r = await run(["--venue", "us"], (u, n) => (n <= 3 ? answer(u.searchParams.get("query")!) : new Response("denied", { status: 403 }))); expect(r.code).toBe(EXIT.OK);
    expect(r.f.calls.filter((c) => c.url.includes("/v1/search")).length).toBe(4); // three answered, one refused, nothing after
    const f = titles(r); expect(f.summary.refusal).toMatchObject({ status: 403, afterPairs: 3 }); expect(f.summary.reachedPairs).toBe(3); expect(f.summary.stoppedBecause).toContain("after 3 of 10 pairs were answered"); expect(f.summary.stoppedBecause).toContain("no workaround"); expect(f.unsearched.pairs).toBe(7); expect(f.rows.filter((x) => x.diag)).toHaveLength(3);
    expect(r.lines.join("\n")).toMatch(/REFUSED: BLOCKED 403 after 3 pairs answered/); for (const c of r.f.calls) expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]); for (const g of gaps(r.f)) expect(g).toBeGreaterThanOrEqual(1100);
  });
  it("a 429 (rate limited) is retried by the client at most three times with backoff, then the pair is an error row; the run goes on (a refusal is 401/403/451 only)", async () => {
    const r = await run(["--venue", "us"], (u, n) => (n <= 3 ? new Response("slow down", { status: 429 }) : answer(u.searchParams.get("query")!))); expect(r.code).toBe(EXIT.OK); const f = titles(r); expect(f.summary.errors).toBe(1); expect(f.summary.refusal).toBeNull(); expect(f.summary.reachedPairs).toBe(9);
  });
  it("--resume continues where a refused run stopped: the answered pairs are carried over (no request for them), the rest are searched, the pace may be slower", async () => {
    const first = await run(["--venue", "us"], (u, n) => (n <= 3 ? answer(u.searchParams.get("query")!) : new Response("denied", { status: 403 }))); const second = await run(["--venue", "us", "--resume", "--us-search-pace-ms", "2500"], (u) => answer(u.searchParams.get("query")!), first.out);
    expect(second.f.calls.length).toBe(7); const f = titles(second); expect(f.summary).toMatchObject({ pairs: 10, reachedPairs: 10, carriedOver: 3, requests: 7, refusal: null, paceMs: 2500, stoppedBecause: null }); expect(f.unsearched).toEqual({ pairs: 0, signals: 0 }); expect(f.rows).toHaveLength(10); expect(new Set(f.rows.map((x) => x.pair.conditionId)).size).toBe(10); expect(second.lines.join("\n")).toContain("3 carried over by --resume");
    const asked = second.f.calls.map((c) => new URL(c.url).searchParams.get("query")); const firstAsked = first.f.calls.slice(0, 3).map((c) => new URL(c.url).searchParams.get("query")); for (const q of firstAsked) expect(asked).not.toContain(q);
  });
  it("--resume with no usable file starts from the first pair and says so; --resume-from reads another path", async () => {
    const a = await run(["--venue", "us", "--resume"], () => answer("x")); expect(a.f.calls.length).toBe(10); expect(a.lines.join("\n")).toContain("--resume: no usable v_polymarket_us_titles.json found");
    const first = await run(["--venue", "us", "--search-max-requests", "4"], (u) => answer(u.searchParams.get("query")!)); const b = await run(["--venue", "us", "--resume-from", "/elsewhere/titles.json"], (u) => answer(u.searchParams.get("query")!), { "/elsewhere/titles.json": first.out[`${OUT}/v_polymarket_us_titles.json`] }); expect(b.f.calls.length).toBe(6); expect(titles(b).summary.carriedOver).toBe(4);
  });
  it("a refusal on the very first request: zero pairs reached, everything unknown, still exit 0 with a written file", async () => {
    const r = await run(["--venue", "us"], () => new Response("denied", { status: 403 })); expect(r.code).toBe(EXIT.OK); const f = titles(r); expect(f.summary.refusal).toMatchObject({ afterPairs: 0 }); expect(f.summary.reachedPairs).toBe(0); expect(f.unsearched.pairs).toBe(10); expect(r.f.calls.length).toBe(1);
  });
});
