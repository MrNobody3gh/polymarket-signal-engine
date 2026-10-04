/**
 * Phase 4.0d, Part A4 — the Kalshi category inventory counts events per category and status by STREAMING, reads series per category, looks for esports, and never
 * loads a market: `with_nested_markets` is never requested, `/markets` is asked for one record, and an event's `markets` member is never read (a proxy throws on access).
 */
import { describe, expect, it } from "vitest";
import { EXIT, runTimestampAuditCli } from "../src/lib/phase4/cli";
import { ESPORTS_RE, fetchKalshiInventory, inventoryLines, inventoryMarkdown } from "../src/lib/phase4/kalshi-inventory";
import { PoliteHttp } from "../src/lib/phase4/http";
import { fakeFetch, json, virtualClock } from "./helpers/phase4Db";
import { KALSHI_BASE } from "./helpers/phase4Kalshi";

type Raw = Record<string, unknown>;
/**
 * Wraps every object of a parsed answer so that READING a `markets` member (at any depth) throws: the venue is made to return nested markets although the
 * inventory never asks for them, and the test fails if the code looks at one. This is the proxy test of "markets are never enumerated".
 */
const trap = (v: unknown): unknown => (v && typeof v === "object" ? new Proxy(v as object, { get(t, p, r) { if (p === "markets") throw new Error("the inventory read a `markets` member: markets must never be loaded"); return trap(Reflect.get(t, p, r)); } }) : v);
const NESTED = [{ ticker: "never-read-1" }, { ticker: "never-read-2" }];

const CATS: Record<string, { open: number; unopened: number; closed: number; settled: number }> = { Sports: { open: 5, unopened: 1, closed: 3, settled: 11 }, Politics: { open: 2, unopened: 0, closed: 1, settled: 6 }, Crypto: { open: 4, unopened: 0, closed: 0, settled: 9 }, "Esports": { open: 1, unopened: 0, closed: 0, settled: 2 } };
const SERIES = [{ ticker: "KXNBAGAME", title: "Pro basketball game", category: "Sports", tags: ["Basketball"] }, { ticker: "KXNFLGAME", title: "Pro football game", category: "Sports", tags: ["Football"] }, { ticker: "KXPRES", title: "Presidential election", category: "Politics", tags: [] }, { ticker: "KXBTC", title: "Bitcoin price", category: "Crypto", tags: ["BTC"] }, { ticker: "KXLOLGAME", title: "League of Legends match", category: "Esports", tags: ["LoL", "esports"] }];

function server(o: { page?: number; withTotals?: boolean; noSeries?: boolean; noTags?: boolean; status?: Record<string, number> } = {}) {
  const hits: URL[] = []; const page = o.page ?? 4;
  const events = (status: string): Raw[] => Object.entries(CATS).flatMap(([cat, c]) => Array.from({ length: (c as Record<string, number>)[status] }, (_, i) => ({ event_ticker: `${cat.slice(0, 3).toUpperCase()}-${status}-${i}`, series_ticker: cat === "Esports" ? "KXLOLGAME" : `KX${cat.toUpperCase()}`, title: cat === "Esports" ? `T1 vs Gen.G ${i}` : `${cat} event ${i}`, category: cat, markets: NESTED })));
  const handler = (u: URL): Response => {
    hits.push(u); if (u.host !== new URL(KALSHI_BASE).host) return new Response("no", { status: 404 });
    if (u.pathname.endsWith("/search/tags_by_categories")) return o.noTags ? new Response("no", { status: 404 }) : json({ tags_by_categories: { Sports: ["Basketball", "Football"], Politics: [], Crypto: ["BTC"], Esports: ["LoL"] } });
    if (u.pathname.endsWith("/series")) return o.noSeries ? new Response("no", { status: 404 }) : json({ series: SERIES });
    if (u.pathname.endsWith("/events")) {
      const status = u.searchParams.get("status") ?? "open"; const limit = Number(u.searchParams.get("limit") ?? 200); const all = events(status); const off = Number(u.searchParams.get("cursor") ?? 0); const size = Math.min(limit, page);
      return json({ events: all.slice(off, off + size), cursor: off + size < all.length ? String(off + size) : "", ...(o.withTotals ? { total: all.length } : {}) });
    }
    if (u.pathname.endsWith("/markets")) return json({ markets: [{ ticker: "one" }], cursor: "abc", ...(o.withTotals ? { total: 12345 } : {}) });
    return new Response("no", { status: 404 });
  };
  return { handler, hits };
}
/** A client whose answers are wrapped by the trap above. */
const http = (h: (u: URL) => Response) => { const c = virtualClock(); const f = fakeFetch(h, c.now); const real = new PoliteHttp({ fetch: f.fetch, sleep: c.sleep, now: c.now }); const spy = { getJson: async (url: string) => { const r = await real.getJson(url); return r.ok ? { ...r, json: trap(r.json) } : r; } } as unknown as PoliteHttp; return { http: spy, f }; };

describe("Kalshi category inventory", () => {
  it("counts events per category and status exactly, by streaming pages, without ever reading a market", async () => {
    const s = server(); const { http: h } = http(s.handler); const inv = await fetchKalshiInventory(h, KALSHI_BASE);
    for (const [cat, c] of Object.entries(CATS)) expect(inv.events.byCategory[cat], cat).toEqual({ ...c, total: c.open + c.unopened + c.closed + c.settled });
    expect(inv.events.total).toEqual({ open: 12, unopened: 1, closed: 4, settled: 28, total: 45 }); expect(inv.complete).toBe(true); expect(inv.stoppedBecause).toBeNull(); expect(Object.values(inv.events.perStatus).every((p) => p.stoppedBecause === "listing ended")).toBe(true);
    // every answer carried nested markets and the trap throws on any read of one: reaching here means the inventory never looked at a market
    for (const u of s.hits) { expect(u.searchParams.get("with_nested_markets")).not.toBe("true"); if (u.pathname.endsWith("/markets")) expect(u.searchParams.get("limit")).toBe("1"); }
    expect(s.hits.filter((u) => u.pathname.endsWith("/markets"))).toHaveLength(1); expect(inv.markets.counted).toBe(false); expect(inv.markets.note).toContain("NOT AVAILABLE");
  });
  it("reads series per category and the category names", async () => {
    const inv = await fetchKalshiInventory(http(server().handler).http, KALSHI_BASE); expect(inv.series).toMatchObject({ read: true, total: 5, byCategory: { Sports: 2, Politics: 1, Crypto: 1, Esports: 1 } }); expect(inv.categories.source).toBe("/search/tags_by_categories"); expect(inv.categories.names.sort()).toEqual(["Crypto", "Esports", "Politics", "Sports"]);
  });
  it("falls back to the series list for the category names when the tags endpoint is missing, and to events when the series list is missing; every miss is recorded", async () => {
    const a = await fetchKalshiInventory(http(server({ noTags: true }).handler).http, KALSHI_BASE); expect(a.categories.source).toBe("/series"); expect(a.doesNotAllow.join(" ")).toContain("tags_by_categories");
    const b = await fetchKalshiInventory(http(server({ noTags: true, noSeries: true }).handler).http, KALSHI_BASE); expect(b.series.read).toBe(false); expect(b.series.byCategory).toEqual({}); expect(b.events.total.total).toBe(45); expect(b.doesNotAllow.join(" ")).toContain("GET /series");
  });
  it("finds esports by category name, series title or tag, and event title; an inventory with no esports says none was found, never a guess", async () => {
    const inv = await fetchKalshiInventory(http(server().handler).http, KALSHI_BASE); expect(inv.esports.categoryExists).toBe(true); expect(inv.esports.matchedCategories).toEqual(["Esports"]); expect(inv.esports.seriesMatched).toBe(1); expect(inv.esports.examples[0]).toContain("KXLOLGAME"); expect(inv.esports.eventsMatched).toBeGreaterThanOrEqual(3);
    for (const t of ["esports", "League of Legends", "Counter-Strike 2", "CS2", "Dota 2", "Valorant", "Rocket League"]) expect(ESPORTS_RE.test(t), t).toBe(true); for (const t of ["Basketball", "Politics", "Crypto", "Elections", "Climate"]) expect(ESPORTS_RE.test(t), t).toBe(false);
  });
  it("a world without esports: the category name does not exist and the title matches are zero", async () => {
    const hits: URL[] = []; const h = (u: URL): Response => { hits.push(u); if (u.pathname.endsWith("/series")) return json({ series: [{ ticker: "KXNBAGAME", title: "Pro basketball game", category: "Sports", tags: [] }] }); if (u.pathname.endsWith("/events")) return json({ events: u.searchParams.get("status") === "open" ? [{ event_ticker: "A", title: "Lakers vs Celtics", category: "Sports" }] : [], cursor: "" }); if (u.pathname.endsWith("/markets")) return json({ markets: [] }); return new Response("no", { status: 404 }); };
    const inv = await fetchKalshiInventory(http(h).http, KALSHI_BASE); expect(inv.esports).toMatchObject({ categoryExists: false, seriesMatched: 0, eventsMatched: 0, matchedCategories: [] });
  });
  it("a venue that answers nothing gives esports UNKNOWN (null), not false", async () => {
    const inv = await fetchKalshiInventory(http(() => new Response("nope", { status: 404 })).http, KALSHI_BASE); expect(inv.esports.categoryExists).toBeNull(); expect(inv.events.total.total).toBe(0); expect(inv.complete).toBe(false);
  });
  it("the request budget cuts the count with a clear message and every count is then a lower bound", async () => {
    const s = server(); const inv = await fetchKalshiInventory(http(s.handler).http, KALSHI_BASE, { maxRequests: 6 }); expect(inv.requests).toBeLessThanOrEqual(6); expect(inv.complete).toBe(false); expect(inv.stoppedBecause).toMatch(/request budget of 6 reached/); expect(inv.events.note).toContain("LOWER BOUNDS"); expect(inv.events.total.total).toBeLessThan(45);
  });
  it("a venue that repeats its cursor does not loop forever", async () => {
    let n = 0; const h = (u: URL): Response => { if (u.pathname.endsWith("/events")) { n++; return json({ events: [{ event_ticker: `E${n}`, category: "Sports", title: "x" }], cursor: "same" }); } return new Response("no", { status: 404 }); };
    const inv = await fetchKalshiInventory(http(h).http, KALSHI_BASE, { maxRequests: 200 }); expect(n).toBeLessThan(20); expect(inv.complete).toBe(false);
  });
  it("records whether the venue documents a total: none (a cursor only) is a stated limit, a total is noted and still not used to guess", async () => {
    const a = await fetchKalshiInventory(http(server().handler).http, KALSHI_BASE); expect(a.totals.every((t) => t.totalKeys.length === 0)).toBe(true); expect(a.doesNotAllow.join(" ")).toMatch(/limit=1 page returns a cursor but no total/);
    const b = await fetchKalshiInventory(http(server({ withTotals: true }).handler).http, KALSHI_BASE); expect(b.totals.find((t) => t.endpoint === "/markets")!.totalKeys).toEqual(["total"]); expect(b.markets.note).toContain("documents a total"); expect(b.markets.counted).toBe(false);
  });
  it("the printed and Markdown forms are bounded and say what the endpoints did and did not allow", async () => {
    const inv = await fetchKalshiInventory(http(server().handler).http, KALSHI_BASE); const lines = inventoryLines(inv); expect(lines.length).toBeLessThanOrEqual(24); expect(lines.join("\n")).toContain("esports: category name EXISTS"); expect(lines.join("\n")).toContain("markets per category");
    const md = inventoryMarkdown(inv); expect(md).toContain("| Sports | 2 | 5 | 1 | 3 | 11 | 20 |"); expect(md).toContain("What they did not allow"); expect(md).toContain("NOT AVAILABLE");
  });
});

describe("phase4:ts-audit --venue kalshi --kalshi-inventory", () => {
  const run = async (argv: string[], h: (u: URL) => Response) => { const c = virtualClock(); const f = fakeFetch(h, c.now); const out: Record<string, string> = {}; const lines: string[] = []; const code = await runTimestampAuditCli(argv, {}, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: (p, x) => { out[p] = x; }, mkdir() {}, readFile: (p) => out[p] ?? null, log: (l) => lines.push(l) }); return { code, f, out, lines }; };
  it("--kalshi-inventory-only: no listing is fetched at all (no nested markets, no /markets paging), the file holds the inventory and no audit", async () => {
    const s = server(); const r = await run(["--venue", "kalshi", "--kalshi-inventory-only", "--no-fixtures"], s.handler); expect(r.code).toBe(EXIT.OK);
    const f = JSON.parse(r.out["docs/phase4/data/v_kalshi_audit.json"]); expect(f.audit).toBeNull(); expect(f.kalshiInventory.events.total.total).toBe(45); expect(s.hits.some((u) => u.searchParams.get("with_nested_markets") === "true")).toBe(false);
    expect(r.lines.join("\n")).toContain("Kalshi category inventory"); expect(r.lines.length).toBeLessThanOrEqual(60);
  });
  it("--kalshi-inventory with the listing: the inventory is taken first, the listing sample after it, both in one file", async () => {
    const s = server(); const base = (u: URL) => (u.pathname.endsWith("/events") && u.searchParams.get("with_nested_markets") === "true" ? json({ events: [], cursor: "" }) : s.handler(u));
    const r = await run(["--venue", "kalshi", "--kalshi-inventory", "--no-fixtures"], base); expect(r.code).toBe(EXIT.OK); const f = JSON.parse(r.out["docs/phase4/data/v_kalshi_audit.json"]); expect(f.kalshiInventory).not.toBeNull(); expect(f.audit).not.toBeNull();
    const firstNested = r.f.calls.findIndex((c) => c.url.includes("with_nested_markets=true")); const lastInventoryEvents = r.f.calls.map((c) => c.url).lastIndexOf(r.f.calls.filter((c) => c.url.includes("/events") && !c.url.includes("nested"))[0].url); expect(firstNested).toBeGreaterThan(lastInventoryEvents - 1);
  });
  it("--kalshi-inventory without Kalshi (all-in-one without --kalshi) is refused before any request", async () => {
    const r = await run(["--kalshi-inventory"], server().handler); expect(r.code).toBe(EXIT.CONFIG); expect(r.f.calls).toHaveLength(0);
  });
});
