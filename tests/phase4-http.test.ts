/**
 * Phase 4.0 — the polite HTTP reader: ≤ 2 requests/second, descriptive User-Agent, no credentials, bounded retries,
 * never a work-around for a refusal, never throws.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT, PoliteHttp } from "../src/lib/phase4/http";
import { fakeFetch, json, virtualClock } from "./helpers/phase4Db";

const setup = (handler: Parameters<typeof fakeFetch>[0], o: ConstructorParameters<typeof PoliteHttp>[0] = {}) => { const c = virtualClock(); const f = fakeFetch(handler, c.now); return { c, f, http: new PoliteHttp({ fetch: f.fetch, now: c.now, sleep: c.sleep, ...o }) }; };

describe("PoliteHttp", () => {
  it("sends a descriptive User-Agent, asks for JSON, uses GET, and never sends credentials of any kind", async () => {
    const { http, f } = setup(() => json({ ok: 1 })); const r = await http.getJson("https://example.test/a?x=1");
    expect(r).toMatchObject({ ok: true, status: 200, json: { ok: 1 }, attempts: 1 });
    const c = f.calls[0]; expect(c.method).toBe("GET"); expect(c.headers["user-agent"]).toBe(DEFAULT_USER_AGENT); expect(DEFAULT_USER_AGENT).toMatch(/read-only/); expect(c.headers.accept).toBe("application/json");
    expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]); // no authorization, cookie, api-key header exists
  });
  it("keeps request starts at least 500 ms apart (2 requests per second), even if asked to go faster", async () => {
    const { http, f } = setup(() => json({}), { minIntervalMs: 1 }); for (let i = 0; i < 6; i++) await http.getJson(`https://example.test/p${i}`);
    const at = f.calls.map((c) => c.at!); for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1], `gap ${i}`).toBeGreaterThanOrEqual(500);
  });
  it("429 and 5xx are retried at most 3 times in total, honouring Retry-After (capped), then reported", async () => {
    const { http, f, c } = setup(() => json({}, 429, { "retry-after": "3" })); const r = await http.getJson("https://example.test/x");
    expect(f.calls).toHaveLength(3); expect(r).toMatchObject({ ok: false, kind: "RATE_LIMITED", status: 429, attempts: 3 }); expect(c.sleeps.some((s) => s >= 3000)).toBe(true);
    const big = setup(() => json({}, 429, { "retry-after": "86400" })); await big.http.getJson("https://example.test/x"); expect(Math.max(...big.c.sleeps)).toBeLessThanOrEqual(30_000);
    const e500 = setup(() => json({}, 503)); expect(await e500.http.getJson("https://example.test/x")).toMatchObject({ ok: false, kind: "SERVER_ERROR" }); expect(e500.f.calls).toHaveLength(3);
  });
  it("even if configured for more attempts, never retries more than 3 times", async () => { const { http, f } = setup(() => json({}, 500), { maxAttempts: 50 }); await http.getJson("https://example.test/x"); expect(f.calls).toHaveLength(3); });
  it("a transient failure that recovers returns the data", async () => { let n = 0; const { http } = setup(() => (++n < 3 ? json({}, 502) : json({ v: 7 }))); expect(await http.getJson("https://example.test/x")).toMatchObject({ ok: true, json: { v: 7 }, attempts: 3 }); });
  it("network errors and timeouts are retried (bounded) and reported with their kind, never thrown", async () => {
    const a = setup(() => { throw new TypeError("fetch failed"); }); expect(await a.http.getJson("https://example.test/x")).toMatchObject({ ok: false, kind: "NETWORK", attempts: 3 }); expect(a.f.calls).toHaveLength(3);
    const t = setup(() => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; }); expect(await t.http.getJson("https://example.test/x")).toMatchObject({ ok: false, kind: "TIMEOUT" });
  });
  it("401 / 403 / 451 are a refusal: reported as BLOCKED, NEVER retried, never worked around", async () => {
    for (const st of [401, 403, 451]) { const { http, f } = setup(() => new Response("denied by policy", { status: st })); const r = await http.getJson("https://blocked.test/x"); expect(r).toMatchObject({ ok: false, kind: "BLOCKED", status: st, attempts: 1 }); expect(f.calls, String(st)).toHaveLength(1); if (!r.ok) expect(r.message).toContain("denied by policy"); }
  });
  it("after two consecutive refusals from an origin it stops asking that origin for the rest of the run, and still serves others", async () => {
    const { http, f } = setup((u) => (u.host === "blocked.test" ? new Response("no", { status: 403 }) : json({ ok: true })));
    await http.getJson("https://blocked.test/a"); await http.getJson("https://blocked.test/b"); const third = await http.getJson("https://blocked.test/c");
    expect(third).toMatchObject({ ok: false, kind: "BLOCKED_SKIPPED", attempts: 0 }); expect(f.calls).toHaveLength(2); expect(http.isStopped("https://blocked.test")).toBe(true);
    expect(await http.getJson("https://fine.test/a")).toMatchObject({ ok: true }); expect(http.summary().byKind).toMatchObject({ BLOCKED: 2, BLOCKED_SKIPPED: 1 });
  });
  it("a success in between resets the refusal count", async () => { let n = 0; const { http } = setup(() => (++n % 2 ? new Response("no", { status: 403 }) : json({}))); for (let i = 0; i < 6; i++) await http.getJson("https://flaky.test/a"); expect(http.isStopped("https://flaky.test")).toBe(false); });
  it("404 and other 4xx are not retried; malformed JSON and an HTML page are reported as MALFORMED without retry", async () => {
    const a = setup(() => new Response("nope", { status: 404 })); expect(await a.http.getJson("https://example.test/x")).toMatchObject({ ok: false, kind: "NOT_FOUND" }); expect(a.f.calls).toHaveLength(1);
    const b = setup(() => new Response("bad", { status: 400 })); expect(await b.http.getJson("https://example.test/x")).toMatchObject({ ok: false, kind: "BAD_REQUEST" }); expect(b.f.calls).toHaveLength(1);
    const m = setup(() => new Response("<html>maintenance</html>", { status: 200 })); const r = await m.http.getJson("https://example.test/x"); expect(r).toMatchObject({ ok: false, kind: "MALFORMED", attempts: 1 }); expect(m.f.calls).toHaveLength(1); if (!r.ok) expect(r.message).toContain("<html>");
  });
  it("summarises outcomes for the printed report", async () => { const { http } = setup((u) => (u.pathname === "/ok" ? json({}) : new Response("x", { status: 404 }))); await http.getJson("https://a.test/ok"); await http.getJson("https://a.test/missing"); expect(http.summary()).toMatchObject({ requests: 2, ok: 1, byKind: { NOT_FOUND: 1 } }); });
});
