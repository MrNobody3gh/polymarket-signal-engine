import { describe, it, expect, vi } from "vitest";
import { PolymarketClient, PolymarketError, normalizeFill, DATA_API } from "@/lib/polymarket/client";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("buildUrl", () => {
  const c = new PolymarketClient();
  it("whitelists params and lowercases booleans", () => {
    expect(c.buildUrl(DATA_API, "/v2/trades", { user: "0xabc", taker_only: false, start: 0 })).toBe(`${DATA_API}/v2/trades?user=0xabc&taker_only=false&start=0`);
  });
  it("throws on a param Polymarket would silently ignore", () => { expect(() => c.buildUrl(DATA_API, "/v2/leaderboard", { window: "all" })).toThrow(PolymarketError); });
});

describe("paginate", () => {
  it("follows next_cursor and re-sends filters", async () => {
    const calls: string[] = [];
    const f = vi.fn(async (url: string) => { calls.push(url); const u = new URL(url); const cur = u.searchParams.get("cursor");
      if (!cur) return json({ data: [{ i: 1 }, { i: 2 }], pagination: { next_cursor: "c2", has_more: true } });
      return json({ data: [{ i: 3 }], pagination: { next_cursor: null, has_more: false } }); });
    const c = new PolymarketClient({ fetch: f as unknown as typeof fetch });
    const rows: unknown[] = []; for await (const r of c.paginate("/v2/trades", { user: "0xabc", taker_only: false }, { page: 2 })) rows.push(r);
    expect(rows).toHaveLength(3); expect(calls).toHaveLength(2); expect(calls[1]).toContain("cursor=c2"); expect(calls[1]).toContain("taker_only=false");
  });
  it("honours cap", async () => {
    const f = vi.fn(async () => json({ data: [{ i: 1 }, { i: 2 }, { i: 3 }], pagination: { next_cursor: "x" } }));
    const c = new PolymarketClient({ fetch: f as unknown as typeof fetch });
    const rows: unknown[] = []; for await (const r of c.paginate("/v2/trades", {}, { cap: 2 })) rows.push(r); expect(rows).toHaveLength(2); expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("retry", () => {
  it("retries 429 with Retry-After then succeeds", async () => {
    let n = 0; const sleeps: number[] = [];
    const f = vi.fn(async () => (++n === 1 ? json({ error: "rate_limited" }, 429, { "retry-after": "2" }) : json({ data: { proxy_wallet: "0xabc", trades: 1, biggest_win: 0, views: 0 } })));
    const c = new PolymarketClient({ fetch: f as unknown as typeof fetch, sleep: async (ms) => { sleeps.push(ms); } });
    const s = await c.userStats("0xabc"); expect(s?.trades).toBe(1); expect(sleeps).toEqual([2000]);
  });
  it("does not retry a 400", async () => {
    const f = vi.fn(async () => json({ error: "bad" }, 400));
    const c = new PolymarketClient({ fetch: f as unknown as typeof fetch, sleep: async () => {} });
    await expect(c.userStats("nope")).rejects.toThrow(/HTTP 400/); expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("priceAsOf", () => {
  it("parses the v2 array shape and reports observation time + resolution", async () => {
    const f = vi.fn(async () => json({ data: [{ timestamp: 1789726400, price: 0.57, resolution_seconds: 60 }], pagination: { limit: 1, offset: 0, has_more: false, next_cursor: null } }));
    const c = new PolymarketClient({ fetch: f as unknown as typeof fetch });
    expect(await c.priceAsOf("tok", 1789726459)).toEqual({ price: 0.57, ts: 1789726400, resolutionSeconds: 60 });
  });
  it("returns null on an empty series instead of a fake price", async () => {
    const f = vi.fn(async () => json({ data: [], pagination: { limit: 0, offset: 0, has_more: false } }));
    expect(await new PolymarketClient({ fetch: f as unknown as typeof fetch }).priceAsOf("tok", 1)).toBeNull();
  });
});

describe("normalizeFill", () => {
  it("accepts the websocket/v1 camelCase payload", () => {
    const f = normalizeFill({ proxyWallet: "0xABC", side: "buy", size: "25", price: 0.999, timestamp: 1789658260, asset: "tok", conditionId: "0xc", title: "T", slug: "s", outcome: "No", transactionHash: "0xtx" }, "ws");
    expect(f).toMatchObject({ wallet: "0xabc", side: "BUY", size: 25, usd: 24.98, tokenId: "tok", source: "ws" }); expect(f!.id).toBe("0xtx:tok:0xabc:1789658260:BUY:25");
  });
  it("accepts the v2 snake_case payload and rejects incomplete rows", () => {
    expect(normalizeFill({ proxy_wallet: "0xabc", side: "SELL", size: 10, price: 0.5, timestamp: 1, token_id: "t", condition_id: "c" })).toMatchObject({ side: "SELL", usd: 5 });
    expect(normalizeFill({ proxy_wallet: "0xabc", side: "SELL", size: 10, price: 0.5 })).toBeNull();
    expect(normalizeFill({ proxy_wallet: "0xabc", side: "HOLD", size: 10, price: 0.5, timestamp: 1, token_id: "t" })).toBeNull();
  });
});
