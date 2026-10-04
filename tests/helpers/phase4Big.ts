/**
 * LAZY synthetic listings of 40,000 markets for the Phase 4.0d memory tests: a page is generated when it is requested and nothing is kept, so the fixture
 * itself never occupies the heap (the test measures the code under test, not its own data). SYNTHETIC: not evidence about any venue.
 */
import { json } from "./phase4Db";
import { kEvent, type Raw } from "./phase4Kalshi";

export const KALSHI_HOST = "api.elections.kalshi.com";
const Z = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A Kalshi `GET /events` over `total` markets (two per event) split by status like the fetch plan (50 % open, 10 % closed, the rest settled). Events are generated per page. */
export function bigKalshi(total = 40_000, o: { onRequest?: (u: URL) => void } = {}) {
  const per = { open: Math.ceil(total * 0.5), closed: Math.floor(total * 0.1), settled: 0 }; per.settled = total - per.open - per.closed; const hits = { n: 0, nested: 0 };
  const eventAt = (status: "open" | "closed" | "settled", i: number): Raw => {
    const sport = ["KXNBAGAME", "KXNFLGAME", "KXMLBGAME", "KXBTC", "KXPRES"][i % 5]; const cat = ["Sports", "Sports", "Sports", "Crypto", "Politics"][i % 5]; const kick = Date.UTC(2026, status === "open" ? 9 : 8, 5) + i * 7 * 3_600_000 + 17 * 60_000 + (i % 4) * 15 * 60_000; const id = `${status[0].toUpperCase()}${i}`;
    return kEvent({ ticker: `${sport}-${id}`, series: sport, title: `Team ${id}a vs Team ${id}b`, category: cat, strike: Z(kick), markets: ["a", "b"].map((s) => ({ ticker: `${sport}-${id}-${s}`, yes: `Team ${id}${s}`, status: status === "open" ? "active" : status === "closed" ? "closed" : "finalized", close: Z(kick + 3 * 3_600_000), expected: Z(kick + 4 * 3_600_000) })) });
  };
  const handler = (u: URL): Response => {
    o.onRequest?.(u); hits.n++;
    if (u.host !== KALSHI_HOST) return new Response("not here", { status: 404 });
    if (u.pathname.endsWith("/events")) {
      if (u.searchParams.get("with_nested_markets") === "true") hits.nested++;
      const status = (u.searchParams.get("status") ?? "open") as "open" | "closed" | "settled"; const events = Math.ceil((per[status] ?? 0) / 2); const limit = Math.min(Number(u.searchParams.get("limit") ?? 200), 200); const off = Number(u.searchParams.get("cursor") ?? 0);
      const page = Array.from({ length: Math.max(0, Math.min(limit, events - off)) }, (_, k) => eventAt(status, off + k));
      return json({ events: page, cursor: off + limit < events ? String(off + limit) : "" });
    }
    return new Response("no", { status: 404 });
  };
  return { handler, hits, per };
}

export const US_HOST = "gateway.polymarket.us";
/** A US `GET /v1/markets` with offset paging over `total` markets: the open query returns the first half, the closed query the second (a page is 100 markets). */
export function bigUs(total = 40_000, o: { onRequest?: (u: URL) => void } = {}) {
  const half = total / 2; const hits = { n: 0 };
  const marketAt = (closed: boolean, i: number): Raw => { const kick = Date.UTC(2026, closed ? 8 : 9, 5) + i * 5 * 3_600_000 + 17 * 60_000 + (i % 4) * 15 * 60_000; const id = `${closed ? "c" : "o"}${i}`;
    return { id, slug: `${["nba", "nfl", "mlb", "btc", "politics"][i % 5]}-team-${id}a-team-${id}b-2026-10-05`, question: `Team ${id}a vs Team ${id}b`, outcomes: JSON.stringify([`Team ${id}a`, `Team ${id}b`]), closed, active: !closed, status: closed ? "settled" : "open", gameStartTime: Z(kick), endDate: Z(kick + 3 * 3_600_000), category: ["sports", "sports", "sports", "crypto", "politics"][i % 5], description: "x".repeat(900), events: [{ id: `e${id}`, slug: `ev-${id}`, title: `Team ${id}a vs Team ${id}b`, startTime: Z(kick), description: "y".repeat(900) }] }; };
  const handler = (u: URL): Response => {
    o.onRequest?.(u); hits.n++;
    if (u.host !== US_HOST) return new Response("not here", { status: 404 });
    if (u.pathname === "/v1/markets") { const closed = u.searchParams.get("closed") === "true"; const off = Number(u.searchParams.get("offset") ?? 0); const limit = Number(u.searchParams.get("limit") ?? 100);
      return json({ markets: Array.from({ length: Math.max(0, Math.min(limit, half - off)) }, (_, k) => marketAt(closed, off + k)) }); }
    return new Response("no", { status: 404 });
  };
  return { handler, hits };
}
