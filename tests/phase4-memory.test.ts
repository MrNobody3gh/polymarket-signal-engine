import { describe, expect, it } from "vitest";
import { flatten } from "@/lib/phase4/audit";
import { classifyFieldName } from "@/lib/phase4/timestamps";
import { ARCHIVED_CAP, DIAGNOSE_DEFAULT_CAP, NORMAL_CAP, slimRaw, usFetchPlan } from "@/lib/phase4/venues";

// Found on the first production run of the 4.0b coverage diagnostic: with the cap removed and every raw market kept, the full US listing
// exhausted a ~500 MB heap after about 12 minutes of paging (exit 134). The diagnostic now has a finite default cap and slims each market on arrival.

describe("diagnostic memory bound", () => {
  it("diagnostic mode has a finite default cap, a smaller archived cap, and slims; normal mode is unchanged", () => {
    const d = usFetchPlan({ diagnose: true });
    expect(d.cap).toBe(DIAGNOSE_DEFAULT_CAP); expect(Number.isFinite(d.cap)).toBe(true); expect(d.half).toBe(DIAGNOSE_DEFAULT_CAP / 2);
    expect(d.archivedMax).toBe(ARCHIVED_CAP); expect(d.slim).toBe(true);
    const n = usFetchPlan({});
    expect(n.cap).toBe(NORMAL_CAP); expect(n.half).toBe(NORMAL_CAP / 2); expect(n.slim).toBe(false);
  });
  it("an explicit --us-max wins in both modes, and the archived cap never exceeds the half", () => {
    expect(usFetchPlan({ diagnose: true, maxUsMarkets: 2 })).toEqual({ cap: 2, half: 1, archivedMax: 1, slim: true });
    expect(usFetchPlan({ maxUsMarkets: 100_000 }).half).toBe(50_000);
    expect(usFetchPlan({ diagnose: true, maxUsMarkets: 100_000 }).archivedMax).toBe(ARCHIVED_CAP);
  });
});

describe("slimRaw", () => {
  const big = "x".repeat(5000);
  const market = {
    id: "m1", slug: "nfl-a-b-2026-10-05", question: "Will A beat B?", outcomes: "[\"Yes\",\"No\"]", description: big, rules: big,
    endDate: "2026-10-05T04:00:00Z", gameStartTime: "2026-10-05T20:20:00Z", startDate: "2026-09-30T18:00:00Z", sportsMarketType: "MONEYLINE", active: true, closed: false, volumeNum: 1234.5,
    tags: Array.from({ length: 80 }, (_, i) => ({ slug: "t" + i, label: "Tag " + i })),
    events: [{ id: 7, title: "A vs B", startTime: "2026-10-05T20:20:00Z", endDate: "2026-10-05T04:00:00Z", description: big, markets: Array.from({ length: 40 }, (_, i) => ({ id: "n" + i, description: big })) }],
  };
  const timeish = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(flatten(o)).filter(([k]) => classifyFieldName(k) !== "NOT_TIME"));

  it("truncates free text, cuts long arrays, and drops nested market lists, shrinking the object by an order of magnitude", () => {
    const s = slimRaw(market) as Record<string, unknown>;
    expect((s.description as string).length).toBe(200); expect((s.rules as string).length).toBe(200);
    expect((s.tags as unknown[]).length).toBe(30);
    const ev = (s.events as Record<string, unknown>[])[0]; expect("markets" in ev).toBe(false); expect((ev.description as string).length).toBe(200);
    expect(JSON.stringify(s).length).toBeLessThan(JSON.stringify(market).length / 10);
  });
  it("keeps everything the audits and the matcher read: titles, identifiers, flags, numbers and every time-like field, so classification is unchanged", () => {
    const s = slimRaw(market) as Record<string, unknown>;
    expect(s.question).toBe("Will A beat B?"); expect(s.slug).toBe(market.slug); expect(s.id).toBe("m1"); expect(s.active).toBe(true); expect(s.volumeNum).toBe(1234.5); expect(s.sportsMarketType).toBe("MONEYLINE");
    expect(timeish(s)).toEqual(timeish(market));
    expect((s.events as Record<string, unknown>[])[0].title).toBe("A vs B");
  });
  it("is total: nulls, numbers, booleans, empty objects and deep nesting never throw", () => {
    expect(slimRaw(null)).toBeNull(); expect(slimRaw(3)).toBe(3); expect(slimRaw(false)).toBe(false); expect(slimRaw({})).toEqual({});
    let deep: Record<string, unknown> = { leaf: "x" }; for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(() => slimRaw(deep)).not.toThrow();
  });
});

// Found on the first Kalshi production run (4.0c): the audit flattened all 40,000 listing markets and only then sampled 1,200, exhausting a ~500 MB heap.
import { sampleRaws, stratifiedSample, toAuditMarkets, type RawMarket } from "@/lib/phase4/audit";
import { auditVenue } from "@/lib/phase4/s1a";

describe("sampling before flattening (the Kalshi out-of-memory defect)", () => {
  const acc = { idOf: (m: RawMarket) => String(m.id), titleOf: (m: RawMarket) => (typeof m.title === "string" ? m.title : null), slugOf: (m: RawMarket) => (typeof m.slug === "string" ? m.slug : null), tagsOf: () => [] as string[], groupOf: (m: RawMarket) => String(m.event) };
  const world = (n: number) => Array.from({ length: n }, (_, i) => ({ id: "m" + i, event: "e" + (i % 400), title: ["Lakers vs Celtics", "Will the senate pass the bill", "Bitcoin above 100k", "Team Liquid vs NaVi CS2"][i % 4] + " " + i, slug: ["nba-", "politics-", "crypto-", "cs2-"][i % 4] + i, endDate: "2026-10-05T04:00:00Z" })) as RawMarket[];
  it("chooses exactly the markets that sampling the fully flattened listing would choose", () => {
    const raws = world(1000); const o = { ...acc, isResolved: () => false };
    const heavy = stratifiedSample(toAuditMarkets("v", raws, o), 20, 60).map((m) => m.id);
    const light = sampleRaws(raws, acc, 20, 60).map((r) => String(r.id));
    expect(light).toEqual(heavy); expect(light.length).toBe(60);
  });
  it("never enumerates the fields of a market it does not pick (flattening is what exhausted the heap)", () => {
    let enumerated = 0;
    const raws = world(1000).map((r) => new Proxy(r, { ownKeys(t) { enumerated++; return Reflect.ownKeys(t); } })) as RawMarket[];
    const picked = sampleRaws(raws, acc, 20, 60);
    expect(picked.length).toBe(60); expect(enumerated).toBe(0);
    toAuditMarkets("v", picked, { ...acc, isResolved: () => false }); expect(enumerated).toBe(60);
  });
});

describe("the audit itself flattens only what it samples", () => {
  const acc = { idOf: (m: RawMarket) => String(m.id), titleOf: (m: RawMarket) => (typeof m.title === "string" ? m.title : null), groupOf: (m: RawMarket) => String(m.event), isResolved: (m: RawMarket) => m.closed === true };
  it("a 4,000-market listing audited with a 60 + 60 sample enumerates the fields of at most 120 markets, not 4,000", () => {
    let enumerated = 0;
    const mk = (i: number, closed: boolean) => new Proxy({ id: (closed ? "r" : "o") + i, event: "e" + (i % 300), closed, title: ["Lakers vs Celtics", "Will the senate pass the bill", "Bitcoin above 100k", "Team Liquid vs NaVi CS2"][i % 4] + " " + i, slug: ["nba-", "politics-", "crypto-", "cs2-"][i % 4] + i, endDate: "2026-10-05T04:00:00Z" } as RawMarket, { ownKeys(t) { enumerated++; return Reflect.ownKeys(t); } });
    const open = Array.from({ length: 2000 }, (_, i) => mk(i, false)), resolved = Array.from({ length: 2000 }, (_, i) => mk(i, true));
    const r = auditVenue("test", open, resolved, { open: null, resolved: null } as never, acc, undefined, { sampleOpen: 60, sampleResolved: 60 });
    expect(r.markets.length).toBe(120); expect(enumerated).toBeLessThanOrEqual(120);
  });
});

// Found on the first one-venue-per-process production run (4.0d): the US audit died out of memory at ~465 MB after fetching only ~5,000 markets, because the audit's
// own fetches kept each market whole (nested event copies and long rule text); only the coverage diagnostic slimmed on arrival. Every audit fetch now slims.
import { runTimestampAuditCli, EXIT } from "@/lib/phase4/cli";
import { fakeFetch, json, virtualClock } from "./helpers/phase4Db";

describe("every audit fetch slims on arrival (US and international)", () => {
  const NOW = Date.parse("2026-10-03T00:00:00Z"); const BIG = "x".repeat(60_000);
  const mkt = (i: number, extra: Record<string, unknown>) => ({ id: "m" + i, conditionId: "0xc" + i, slug: "nba-game-" + i, question: "Lakers vs Celtics " + i, outcomes: '["Lakers","Celtics"]', closed: false, status: "open", endDate: "2026-10-05T04:00:00Z", gameStartTime: "2026-10-05T20:00:00Z", description: BIG, rules: BIG,
    events: [{ id: "e" + i, title: "Lakers vs Celtics", startTime: "2026-10-05T20:00:00Z", description: BIG, markets: [{ id: "n" + i, endDate: "2026-10-05T04:00:00Z", closeTime: "2026-10-05T05:00:00Z" }] }], ...extra });
  const handler = (u: URL): Response => {
    const closed = u.searchParams.get("closed") === "true"; const off = Number(u.searchParams.get("offset") ?? u.searchParams.get("after_cursor") ?? 0);
    const all = closed ? [] : Array.from({ length: 150 }, (_, i) => mkt(i, {}));
    if (u.host === "gamma-api.polymarket.com") return json({ markets: all.slice(off, off + 100), next_cursor: off + 100 < all.length ? String(off + 100) : null });
    if (u.pathname === "/v1/markets") return json({ markets: all.slice(off, off + 100) });
    return new Response("no", { status: 404 });
  };
  const run = async (venue: string) => {
    const c = virtualClock(NOW); const f = fakeFetch(handler, c.now); const out: Record<string, string> = {}; const lines: string[] = [];
    const code = await runTimestampAuditCli(["--venue", venue, "--no-fixtures", "--sample-open", "60", "--sample-resolved", "30"], {}, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: (p: string, t: string) => { out[p] = t; }, mkdir: () => {}, readFile: (p: string) => out[p] ?? null, log: (l: string) => lines.push(l) } as never);
    return { code, text: out[`docs/phase4/data/v_${venue}_audit.json`] ?? "" };
  };
  for (const venue of ["polymarket_us", "polymarket_intl"]) {
    it(`${venue}: nested market lists and long free text never reach the audit, while the event times still do`, async () => {
      const r = await run(venue); expect(r.code).toBe(EXIT.OK); expect(r.text.length).toBeGreaterThan(0);
      expect(r.text).not.toContain("events[].markets[]");        // the nested copy of the event's markets is dropped on arrival
      expect(r.text).toContain("events[].startTime");            // the event's own time field is still audited
    });
  }
});
