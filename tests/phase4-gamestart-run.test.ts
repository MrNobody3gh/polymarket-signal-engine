/**
 * Phase 4.0e — the `phase4:gamestart-check` command end to end against a fake US exchange: only the US host, the 1.1 s pace, the request and sample budgets, a refusal
 * (stop, report, no workaround), the heap budget (exit 3), bounded memory on a listing far larger than the caps, no database at all, output limits, and what the document says.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/lib/phase4/cli";
import { runGamestartCli } from "../src/lib/phase4/cli-gamestart";
import { GS_MD_MAX_LINES, renderGamestartMd, gamestartLines, streamPages, type StreamNote } from "../src/lib/phase4/gamestart-run";
import { PoliteHttp } from "../src/lib/phase4/http";
import { US_DEFAULTS } from "../src/lib/phase4/venues";
import type { GamestartResult } from "../src/lib/phase4/gamestart";
import { fakeFetch, json, virtualClock } from "./helpers/phase4Db";
import { easternInstant, explode, lenient, localSlate, midnightPlaceholders, type UsSpec } from "./helpers/phase4Gamestart";

const NOW = Date.parse("2026-10-05T12:00:00Z"); const OUT = "docs/phase4/data"; const OCT5 = Date.UTC(2026, 9, 5), NOV2 = Date.UTC(2026, 10, 2), DAY = 86_400_000;
const files = () => { const out: Record<string, string> = {}; return { out, writeFile: (p: string, c: string) => { out[p] = c; }, mkdir() {}, readFile: (p: string) => out[p] ?? null }; };

/** A fake US exchange: the sports API (sports, leagues, events by sport with open/ended sides) and the generic listing, all paged by `offset`, answering `{markets: [...]}`. */
function usServer(w: { sports?: string[]; sportEvents?: Record<string, { open: UsSpec[]; ended: UsSpec[] }>; open?: UsSpec[]; closed?: UsSpec[] }, o: { refuseAfter?: number } = {}) {
  let n = 0; const hits: URL[] = []; const page = (all: UsSpec[], u: URL) => { const off = Number(u.searchParams.get("offset") ?? 0), lim = Number(u.searchParams.get("limit") ?? 100); return json({ markets: explode(all).slice(off, off + lim) }); };
  const handler = (u: URL): Response => {
    hits.push(u); n++; if (o.refuseAfter !== undefined && n > o.refuseAfter) return new Response("denied", { status: 403 }); if (u.host !== "gateway.polymarket.us") return new Response("no", { status: 404 });
    if (u.pathname === "/v2/sports") return json({ sports: (w.sports ?? []).map((slug) => ({ slug })) }); if (u.pathname === "/v2/leagues") return json({ leagues: [] });
    const m = /^\/v2\/sports\/([^/]+)\/events$/.exec(u.pathname); if (m) { const e = w.sportEvents?.[m[1]]; return e ? page(u.searchParams.get("closed") === "true" ? e.ended : e.open, u) : new Response("no", { status: 404 }); }
    if (u.pathname === "/v1/markets") return page(u.searchParams.get("closed") === "true" ? w.closed ?? [] : w.open ?? [], u); return new Response("no", { status: 404 });
  };
  return { handler, hits };
}
const run = async (argv: string[], h: (u: URL) => Response, o: { heapUsed?: () => number } = {}) => { const c = virtualClock(NOW); const f = fakeFetch(h, c.now); const w = files(); const lines: string[] = [];
  const code = await runGamestartCli(argv, {}, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: w.writeFile, mkdir: w.mkdir, readFile: w.readFile, log: (l) => lines.push(l), heapUsed: o.heapUsed }); return { code, f, files: w.out, lines, c }; };
const result = (r: { files: Record<string, string> }) => JSON.parse(r.files[`${OUT}/v_polymarket_us_gamestart.json`]) as GamestartResult;

// the local world: 8 pm Eastern games in October (00:00Z) and November (01:00Z) with a schedule two minutes off the field, some resolved; plus UTC-midnight placeholders on politics
const WORLD = { sports: ["nba"], sportEvents: { nba: { open: [...localSlate("o", 12, Date.UTC(2026, 9, 25)), ...localSlate("q", 16, NOV2)], ended: localSlate("e", 24, OCT5, { resolved: true }) } }, open: midnightPlaceholders("p", 40, Date.UTC(2026, 9, 20)), closed: midnightPlaceholders("r", 35, Date.UTC(2026, 8, 1), { resolved: true }) };

describe("phase4:gamestart-check --venue polymarket_us", () => {
  it("fetches the sports API and both listings from the US host only, at the 1.1 s pace, writes the JSON and the document, prints at most 60 lines", async () => {
    const srv = usServer(WORLD); const r = await run(["--venue", "polymarket_us"], srv.handler); expect(r.code).toBe(EXIT.OK);
    for (const c of r.f.calls) { expect(new URL(c.url).host).toBe("gateway.polymarket.us"); expect(c.method).toBe("GET"); expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]); } for (let i = 1; i < r.f.calls.length; i++) expect(r.f.calls[i].at! - r.f.calls[i - 1].at!).toBeGreaterThanOrEqual(1100);
    expect(Object.keys(r.files).sort()).toEqual([`${OUT}/S1e_GAMESTART.md`, `${OUT}/v_polymarket_us_gamestart.json`]); expect(r.lines.length).toBeLessThanOrEqual(60); expect(r.files[`${OUT}/S1e_GAMESTART.md`].trim().split("\n").length).toBeLessThanOrEqual(GS_MD_MAX_LINES);
    const j = result(r); expect(j).toMatchObject({ kind: "gamestart", venue: "polymarket_us", transition: "2026-11-01", stopped: null }); expect(j.events).toBe(12 + 16 + 24 + 40 + 35); expect(j.eventsAfterTransition).toBe(16 + 5 + 27); // 16 November games, 5 of the 12 late-October games (those on or after 1 Nov), 27 of the 40 UTC-midnight placeholders (2 Nov onwards) expect(j.fetch.sources.map((s) => s.name)).toEqual(["sports API: nba open", "sports API: nba ended", "listing: open", "listing: closed"]);
    expect(j.dst.find((s) => s.sport === "sports:basketball")!.verdict).toBe("LOCAL_TIME_SHIFT"); expect(j.heap!.budgetMb).toBe(350);
  });
  it("the verdicts of the real audit are not part of the result: the what-if is labelled and no option is recommended", async () => {
    const r = await run(["--venue", "polymarket_us"], usServer(WORLD).handler); const md = r.files[`${OUT}/S1e_GAMESTART.md`]; expect(md).toContain("LABELLED"); expect(md).toContain("nothing is applied"); expect(md).toContain("(a) keep the placeholder rule"); expect(md).toContain("(b) exempt 00:00:00Z only where independent evidence corroborates it per event"); expect(md).toContain("(c) slot 1 for sports from the schedule endpoint");
    expect(md).toContain("no recommendation"); expect(md.toLowerCase()).not.toMatch(/we recommend|i recommend|should adopt|recommended option/); expect(md).toContain("America/New_York"); expect(r.lines.join("\n")).toContain("no verdict of the real audit changed"); expect(r.lines.join("\n")).toContain("none is recommended");
  });
  it("a what-if cell names the rule that still rejects: exempting 00:00Z fixes the usable share but a stratum whose starts cluster on one time of day still fails topClock", async () => {
    const r = await run(["--venue", "polymarket_us"], usServer(WORLD).handler); const j = result(r); const b = j.whatIf.find((w) => w.stratum === "sports:basketball")!; expect(b.baseline.failedKeys).toContain("usableShare"); expect(b.likelyReal.usableShare).toBe(1); expect(b.likelyReal.failedKeys).toContain("topClock"); expect(b.likelyReal.failedKeys).not.toContain("usableShare");
    expect(r.files[`${OUT}/S1e_GAMESTART.md`]).toMatch(/\| sports:basketball \|.*REJECT \(.*topClock.*\)/); expect(r.files[`${OUT}/S1e_GAMESTART.md`]).toContain("NOT affected by the exemption");
  });
  it("a refusal stops the whole run at once, is reported, and nothing else is tried (no retry, no other host, no header change)", async () => {
    const srv = usServer(WORLD, { refuseAfter: 3 }); const r = await run(["--venue", "polymarket_us"], srv.handler); expect(r.code).toBe(EXIT.OK); const j = result(r); expect(j.fetch.refused).toBe(true); expect(j.stopped).toMatchObject({ reason: "refused" }); expect(j.stopped!.message).toContain("tries nothing else"); expect(r.lines.join("\n")).toContain("REFUSED");
    expect(r.f.calls.length).toBeLessThanOrEqual(5); for (const c of r.f.calls) expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]); expect(new Set(r.f.calls.map((c) => new URL(c.url).host))).toEqual(new Set(["gateway.polymarket.us"])); expect(j.fetch.sources.some((s) => s.name === "listing: open")).toBe(false);
  });
  it("a refusal on the very first request still writes a (partial) result", async () => { const r = await run(["--venue", "polymarket_us"], () => new Response("denied", { status: 403 })); expect(r.code).toBe(EXIT.OK); expect(r.f.calls.length).toBeLessThanOrEqual(3); expect(result(r).events).toBe(0); expect(result(r).fetch.refused || result(r).fetch.requests > 0).toBe(true); });
  it("--max-requests bounds the requests (the budget includes the discovery) and says so", async () => { const r = await run(["--venue", "polymarket_us", "--max-requests", "6"], usServer(WORLD).handler); expect(r.f.calls.length).toBeLessThanOrEqual(6); const j = result(r); expect(j.fetch.requests).toBeLessThanOrEqual(6); expect(j.fetch.stoppedBecause).toBe("request budget reached"); });
  it("--max-markets and --max-events stop the paging at the cap and flag the sample as cut", async () => {
    const a = await run(["--venue", "polymarket_us", "--max-markets", "60"], usServer(WORLD).handler); expect(result(a).counts.markets).toBeLessThanOrEqual(60); expect(result(a).counts.full).toBe(true); expect(result(a).fetch.stoppedBecause).toContain("sample cap reached");
    const b = await run(["--venue", "polymarket_us", "--max-events", "10"], usServer(WORLD).handler); expect(result(b).events).toBeLessThanOrEqual(10); expect(result(b).counts.eventsDropped).toBeGreaterThan(0);
  });
  it("the venue flag is required: nothing is fetched without it, nor for another venue", async () => { for (const argv of [[], ["--venue", "kalshi"], ["--venue", "bing"]]) { const r = await run(argv, usServer(WORLD).handler); expect(r.code, argv.join(" ")).toBe(EXIT.CONFIG); expect(r.f.calls).toHaveLength(0); expect(r.lines[0]).toContain("--venue polymarket_us is required"); } });
  it("the heap budget stops the run with the venue and stage named, exit 3, a partial file", async () => {
    const r = await run(["--venue", "polymarket_us"], usServer(WORLD).handler, { heapUsed: () => 400 * 1024 * 1024 }); expect(r.code).toBe(EXIT.BUDGET); expect(r.lines[0]).toContain("STOPPED (heap budget): venue polymarket_us"); expect(r.f.calls).toHaveLength(0); expect(JSON.parse(r.files[`${OUT}/v_polymarket_us_gamestart.json`]).stopped).toMatchObject({ reason: "heap_budget" });
  });
  it("a region with no market at all gives an empty, honest result (counts zero, every table empty), not an error", async () => { const r = await run(["--venue", "polymarket_us"], usServer({ sports: [] }).handler); expect(r.code).toBe(EXIT.OK); const j = result(r); expect(j.events).toBe(0); expect(j.dst).toEqual([]); expect(r.files[`${OUT}/S1e_GAMESTART.md`].split("\n").length).toBeLessThanOrEqual(GS_MD_MAX_LINES); });
  it("--print-files returns the document paced", async () => { const r = await run(["--venue", "polymarket_us", "--print-files", "S1e_GAMESTART.md"], usServer(WORLD).handler); expect(r.lines).toContain("=====FILE S1e_GAMESTART.md"); expect(r.lines).toContain("=====END S1e_GAMESTART.md"); });
});

describe("bounded memory on a listing far larger than the caps", () => {
  it("a 400,000-market listing with a 5,000-market cap: the run stops at the cap, keeps at most the capped records, and its peak heap stays far under the 350 MB budget", async () => {
    let served = 0; const total = 400_000; const handler = (u: URL): Response => { if (u.pathname === "/v2/sports") return json({ sports: [] }); if (u.pathname === "/v2/leagues") return json({ leagues: [] }); if (u.pathname !== "/v1/markets") return new Response("no", { status: 404 }); const off = Number(u.searchParams.get("offset") ?? 0); const lim = Number(u.searchParams.get("limit") ?? 100);
      const markets = Array.from({ length: Math.max(0, Math.min(lim, total - off)) }, (_, k) => { const i = off + k; served++; return { id: `m${i}`, slug: `nba-e${i}`, question: `Team ${i}a vs Team ${i}b`, description: "x".repeat(2000), gameStartTime: lenient(Date.UTC(2026, 9, 6) + i * 60_000), sportsMarketType: "TOTAL", event: { id: `e${i}`, title: "t".repeat(500) } }; }); return json({ markets }); };
    const r = await run(["--venue", "polymarket_us", "--max-markets", "5000", "--max-events", "4000", "--listing-pages", "10000", "--max-requests", "10000"], handler); expect(r.code).toBe(EXIT.OK); const j = result(r); expect(j.counts.markets).toBeLessThanOrEqual(5000); expect(j.events).toBeLessThanOrEqual(4000); expect(served).toBeLessThan(5_300); expect(j.counts.full).toBe(true); expect(j.heap!.peakMb).toBeLessThan(150);
    expect(r.files[`${OUT}/v_polymarket_us_gamestart.json`].length).toBeLessThan(400_000); // the result file does not grow with the listing either
  }, 120_000);
});

describe("streamPages", () => {
  const setup = (h: (u: URL) => Response) => { const c = virtualClock(NOW); const f = fakeFetch(h, c.now); return { http: new PoliteHttp({ fetch: f.fetch, now: c.now, sleep: c.sleep }), f }; };
  it("hands each market to the sink as its page arrives and keeps nothing; stops at an empty page, a repeated page, the page limit, and the budget", async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}`, gameStartTime: "2026-10-06T00:00:00Z" })); const { http } = setup((u) => { const off = Number(u.searchParams.get("offset") ?? 0); return json({ markets: all.slice(off, off + 100) }); }); const got: string[] = [];
    const n = await streamPages(http, US_DEFAULTS, { name: "t", path: "/v1/markets", query: "a=b", maxPages: 10, budget: { left: 10 }, sink: (m) => got.push(String(m.id)), stop: () => false }); expect(got).toHaveLength(250); expect(n).toMatchObject({ pages: 4, markets: 250, stoppedBecause: "empty page" });
    const lim = await streamPages(setup((u) => json({ markets: all.slice(Number(u.searchParams.get("offset") ?? 0), Number(u.searchParams.get("offset") ?? 0) + 100) })).http, US_DEFAULTS, { name: "t", path: "/v1/markets", query: "a=b", maxPages: 2, budget: { left: 10 }, sink: () => {}, stop: () => false }); expect(lim.stoppedBecause).toBe("page limit reached"); expect(lim.pages).toBe(2);
    const rep = await streamPages(setup(() => json({ markets: all.slice(0, 100) })).http, US_DEFAULTS, { name: "t", path: "/v1/markets", query: "a=b", maxPages: 10, budget: { left: 10 }, sink: () => {}, stop: () => false }); expect(rep.stoppedBecause).toContain("page repeated"); expect(rep.pages).toBe(2);
    const bud = await streamPages(setup((u) => json({ markets: all.slice(Number(u.searchParams.get("offset") ?? 0), Number(u.searchParams.get("offset") ?? 0) + 100) })).http, US_DEFAULTS, { name: "t", path: "/v1/markets", query: "a=b", maxPages: 10, budget: { left: 1 }, sink: () => {}, stop: () => false }); expect(bud).toMatchObject({ pages: 1, stoppedBecause: "request budget reached" }); void (null as unknown as StreamNote);
  });
  it("a refusal is flagged; a server error stops the source without flagging a refusal", async () => {
    const a = await streamPages(setup(() => new Response("no", { status: 403 })).http, US_DEFAULTS, { name: "t", path: "/p", query: "a=b", maxPages: 5, budget: { left: 5 }, sink: () => {}, stop: () => false }); expect(a.refused).toBe(true); expect(a.pages).toBe(1);
    const b = await streamPages(setup(() => new Response("no", { status: 404 })).http, US_DEFAULTS, { name: "t", path: "/p", query: "a=b", maxPages: 5, budget: { left: 5 }, sink: () => {}, stop: () => false }); expect(b.refused).toBe(false); expect(b.stoppedBecause).toContain("NOT_FOUND");
  });
});

describe("read-only by construction", () => {
  it("the check has no database: none of its modules imports the database, the select-only wrapper or the Supabase client, and its dependencies have no `db`", () => {
    for (const f of ["gamestart", "gamestart-run", "cli-gamestart", "bundle"]) { const src = readFileSync(`src/lib/phase4/${f}.ts`, "utf8"); expect(src, f).not.toMatch(/readonly-db|from "\.\.\/db"|supabase|\.select\(|\.insert\(|\.upsert\(|\.update\(|\.delete\(|\.rpc\(/); }
    expect(readFileSync("src/lib/phase4/cli-gamestart.ts", "utf8")).not.toMatch(/\bdb\b/);
  });
  it("only GET: the run uses the polite client and nothing else for the network", () => { const src = readFileSync("src/lib/phase4/gamestart-run.ts", "utf8"); expect(src).not.toMatch(/\bfetch\(|method:\s*"(POST|PUT|PATCH|DELETE)"/); expect(readFileSync("src/lib/phase4/cli-gamestart.ts", "utf8")).toContain("new PoliteHttp"); });
});

describe("the printed forms are bounded whatever the data", () => {
  it("a result with 60 sports and long names still renders in at most 80 lines and prints at most 60", async () => {
    const sports = ["nba", "nfl", "nhl", "mlb", "ufc", "soccer", "tennis", "golf", "f1", "cricket"]; const specs: UsSpec[] = sports.flatMap((s, i) => localSlate(`s${i}`, 14, OCT5, { sport: (["nba", "nhl", "nfl"][i % 3]) as UsSpec["sport"] }).map((e) => ({ ...e, id: `${s}-${e.id}` })));
    const r = await run(["--venue", "polymarket_us"], usServer({ sports: [], open: specs }).handler); const j = result(r); expect(renderGamestartMd(j).trim().split("\n").length).toBeLessThanOrEqual(GS_MD_MAX_LINES); expect(gamestartLines(j, OUT).length).toBeLessThanOrEqual(60); expect(Math.max(...gamestartLines(j, OUT).map((l) => l.length))).toBeLessThanOrEqual(220);
  });
});
void easternInstant; void DAY;
