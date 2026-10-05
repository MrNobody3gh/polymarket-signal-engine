/** A fake venue and a fake clock for the Phase 4.1 tests. Time only moves when a test or the polite client's sleep moves it. */
import { PoliteHttp } from "@/lib/phase4/http";
import { makeShadowHttp } from "@/lib/phase4/shadow/job";

export const T0 = 1_790_000_000; // an arbitrary "now" in epoch seconds
export const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
export interface Call { url: string; path: string; token: string | null; at: number; headers: Record<string, string>; method: string }
export type Route = (path: string, token: string | null, n: number) => Response | { status: number; body?: unknown; headers?: Record<string, string> } | Promise<Response> | undefined;
export const bookBody = (o: { bid?: string; ask?: string; askSize?: string; depth?: boolean } = {}) => ({
  market: "0xabc", asset_id: "t", timestamp: "1", hash: "h", tick_size: "0.01", min_order_size: "5", neg_risk: false, last_trade_price: "0.50",
  bids: o.bid === "" ? [] : [{ price: o.bid ?? "0.48", size: "500" }, { price: "0.47", size: "900" }],
  asks: o.ask === "" ? [] : [{ price: o.ask ?? "0.50", size: o.askSize ?? "400" }, { price: "0.51", size: "800" }, { price: "0.55", size: "5000" }],
});
export const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

export function world(route?: Route, o: { perRequestMs?: number } = {}) {
  const clock = { ms: T0 * 1000 }; const calls: Call[] = []; let n = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(url); const c: Call = { url, path: u.pathname, token: u.searchParams.get("token_id"), at: clock.ms, headers: { ...((init?.headers as Record<string, string>) ?? {}) }, method: init?.method ?? "GET" }; calls.push(c); n++;
    clock.ms += o.perRequestMs ?? 0;
    const r = route ? await route(c.path, c.token, n) : undefined;
    if (r instanceof Response) return r;
    if (r) return respond(r.status, r.body ?? {}, r.headers);
    return c.path === "/book" ? respond(200, bookBody()) : respond(200, { fee_rate_bps: 200 });
  }) as unknown as typeof fetch;
  const sleep = async (ms: number) => { clock.ms += ms; };
  const http = (): PoliteHttp => makeShadowHttp({ fetch: fetchFn, sleep, now: () => clock.ms });
  return { clock, calls, fetch: fetchFn, sleep, http, nowSec: () => Math.floor(clock.ms / 1000), clockMs: () => clock.ms, set: (sec: number) => { clock.ms = sec * 1000; } };
}
export const signal = (i: number, ageS: number, o: { kind?: string; token?: string; price?: number | null; score?: number | null } = {}) => ({
  id: uid(i), kind: o.kind ?? "NEW_POSITION", token_id: o.token ?? `tok${i}`, price: o.price === undefined ? 0.49 : o.price, created_at: new Date((T0 - ageS) * 1000).toISOString(),
  payload: o.score === null ? {} : { copyScore: o.score ?? 70 }, condition_id: `c${i}`, title: `Will event ${i} happen?`, slug: `event-${i}`,
});
