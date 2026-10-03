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
