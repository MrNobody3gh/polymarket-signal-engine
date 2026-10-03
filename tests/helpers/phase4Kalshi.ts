/**
 * SYNTHETIC Kalshi objects for the Phase 4.0c tests: NOT real samples and NOT evidence about Kalshi. The field names follow what search-engine summaries of
 * Kalshi's documentation list for GET /events (with nested markets) and are UNVERIFIED; the real, sanitised samples are written by `npm run phase4:ts-audit
 * -- --kalshi` to tests/fixtures/phase4/ when it is run where the venue is reachable. Every answer is known by construction.
 */
import { json } from "./phase4Db";

export type Raw = Record<string, unknown>;
const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
export const KALSHI_BASE = BASE_URL;
const Z = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export interface KMarketSpec { ticker: string; title?: string; yes?: string; no?: string; status?: string; open?: string; close?: string; expected?: string; latest?: string; extra?: Raw }
export interface KEventSpec { ticker: string; series: string; title: string; category: string; strike?: string | null; markets: KMarketSpec[]; extra?: Raw }
export const kMarket = (e: KEventSpec, m: KMarketSpec): Raw => ({ ticker: m.ticker, event_ticker: e.ticker, market_type: "binary", title: m.title ?? e.title, subtitle: "", yes_sub_title: m.yes ?? "Yes", no_sub_title: m.no ?? "No", status: m.status ?? "active", created_time: "2026-09-20T10:00:00.123456Z", updated_time: "2026-10-01T10:00:00Z", open_time: m.open ?? "2026-09-25T14:00:00Z", close_time: m.close, expected_expiration_time: m.expected, latest_expiration_time: m.latest, ...(m.extra ?? {}) });
export const kEvent = (e: KEventSpec): Raw => ({ event_ticker: e.ticker, series_ticker: e.series, title: e.title, sub_title: "", category: e.category, strike_date: e.strike, mutually_exclusive: true, ...(e.extra ?? {}), markets: e.markets.map((m) => kMarket(e, m)) });

/** A fake Kalshi `GET /events`: filters by market status bucket, pages by `cursor` (an offset), `limit` ≤ 200, an empty cursor at the end. `pages` collects each request's query. */
export function kalshiServer(events: { open?: Raw[]; closed?: Raw[]; settled?: Raw[]; unopened?: Raw[] }, o: { base?: string; requirePath?: string; onRequest?: (u: URL) => void; milestones?: Raw[] } = {}) {
  const hits: URL[] = [];
  const handler = (u: URL): Response => {
    hits.push(u); o.onRequest?.(u);
    if (u.host !== new URL(o.base ?? BASE_URL).host) return new Response("not here", { status: 404 });
    if (u.pathname.endsWith("/events")) {
      const status = (u.searchParams.get("status") ?? "open") as keyof typeof events; const all = events[status] ?? [];
      const limit = Math.min(Number(u.searchParams.get("limit") ?? 200), 200); const off = Number(u.searchParams.get("cursor") ?? 0); const page = all.slice(off, off + limit);
      return json({ events: page, cursor: off + limit < all.length ? String(off + limit) : "" });
    }
    if (u.pathname.endsWith("/milestones")) { const all = o.milestones ?? []; const off = Number(u.searchParams.get("cursor") ?? 0); const page = all.slice(off, off + 200); return json({ milestones: page, cursor: off + 200 < all.length ? String(off + 200) : "" }); }
    return new Response("no", { status: 404 });
  };
  return { handler, hits };
}

/** The funnel world: the same four games as the US-exchange fixture (Lakers/Celtics, Warriors/Knicks, Bulls/Heat, Nets/Suns), on Kalshi, with no identifier shared with Polymarket. */
export function funnelEvents(): { open: Raw[]; settled: Raw[] } {
  const game = (id: string, a: string, b: string, o: Partial<KEventSpec> & { strike?: string | null } & { close?: string; status?: string }): KEventSpec => ({ ticker: `KXNBAGAME-${id}`, series: "KXNBAGAME", title: `${a} vs ${b}`, category: "Sports", strike: o.strike ?? null, markets: [{ ticker: `KXNBAGAME-${id}-${a.slice(0, 3).toUpperCase()}`, yes: a, no: `Not ${a}`, close: o.close, status: o.status ?? "active", expected: o.strike ? Z(Date.parse(o.strike) + 3 * 3_600_000) : undefined, latest: "2026-10-16T00:00:00Z" }] });
  return {
    open: [
      kEvent(game("26OCT02LALBOS", "Lakers", "Celtics", { strike: "2026-10-02T14:00:00Z", close: "2026-10-02T17:00:00Z" })),
      kEvent(game("26OCT04GSWNYK", "Warriors", "Knicks", { strike: "2026-10-04T20:00:00Z", close: "2026-10-04T23:00:00Z" })),
      kEvent(game("26OCT02CHIMIA", "Bulls", "Heat", { strike: null })),            // no strike date and no close time: no usable timestamp and no date at all
    ],
    settled: [kEvent(game("26OCT02BKNPHX", "Nets", "Suns", { strike: "2026-10-02T12:00:00Z", close: "2026-10-02T15:00:00Z", status: "finalized" }))],
  };
}

/** `n` NBA-game events with kick-offs on a 15-minute grid that never hits a placeholder, one every 7 hours; settled before `2026-10-03`, open after it. */
export function nbaEvents(prefix: string, n: number, settled: boolean): Raw[] {
  const base = settled ? Date.UTC(2026, 8, 1) : Date.UTC(2026, 9, 5);
  return Array.from({ length: n }, (_, i) => { const kick = base + i * 7 * 3_600_000 + 17 * 60_000 + (i % 4) * 15 * 60_000; const id = `${prefix}${i}`;
    return kEvent({ ticker: `KXNBAGAME-${id}`, series: "KXNBAGAME", title: `Team ${id}a vs Team ${id}b`, category: "Sports", strike: Z(kick), markets: ["a", "b"].map((side) => ({ ticker: `KXNBAGAME-${id}-${side.toUpperCase()}`, yes: `Team ${id}${side}`, status: settled ? "finalized" : "active", close: Z(kick + 3 * 3_600_000), expected: Z(kick + 3 * 3_600_000), latest: Z(kick + 14 * 86_400_000), open: Z(kick - 4 * 86_400_000), extra: { created_time: Z(kick - 5 * 86_400_000) } })) }); });
}
