/** Phase 4.1 guarantees that are about the repository rather than a function: what the new code may touch, and what it may not. */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PoliteHttp } from "@/lib/phase4/http";

const dir = join("src", "lib", "phase4", "shadow"); const files = readdirSync(dir).filter((f) => f.endsWith(".ts")); const src = (f: string) => readFileSync(join(dir, f), "utf8");
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("what the recorder may write", () => {
  it("store.ts is the only file with a write method, and it writes only shadow_books", () => {
    for (const f of files.filter((x) => x !== "store.ts")) expect(code(f), f).not.toMatch(/\.(insert|upsert|update|delete|rpc)\s*\(/);
    const t = code("store.ts"); const writes = [...t.matchAll(/from\("([a-z_]+)"\)(?:(?!;)[\s\S])*?\.(upsert|delete)\(/g)].map((m) => m[1]); expect(writes.length).toBeGreaterThan(0); expect(new Set(writes)).toEqual(new Set(["shadow_books"]));
    const reads = new Set([...t.matchAll(/from\("([a-z_]+)"\)/g)].map((m) => m[1])); expect([...reads].sort()).toEqual(["shadow_books", "signals"]);
  });
  it("the job's only other database write is the status heartbeat, which is the existing health mechanism (cursors, key health:last_shadow_books)", () => {
    const j = code("job.ts"); expect(j).toContain('heartbeat(db, "last_shadow_books", v)'); expect(j).not.toMatch(/\.from\(/);
  });
  it("the report reads through the select-only wrapper and never imports a write path", () => {
    const r = code("report-cli.ts"); expect(r).toContain("readOnly(supabaseDb())"); expect(r).not.toMatch(/\.(insert|upsert|update|delete|rpc)\s*\(/);
    for (const f of ["report.ts", "book.ts", "fill.ts", "fee.ts", "schedule.ts"]) expect(code(f), f).not.toMatch(/supabase|\.from\(|fetch\(/i);
  });
  it("the migration creates one table and alters nothing else", () => {
    const m = readFileSync("supabase/migrations/0012_shadow_books.sql", "utf8").replace(/--.*$/gm, "");
    expect([...m.matchAll(/create table(?: if not exists)? (\w+)/gi)].map((x) => x[1])).toEqual(["shadow_books"]);
    expect([...m.matchAll(/alter table (\w+)/gi)].map((x) => x[1])).toEqual(["shadow_books"]);
    expect([...m.matchAll(/create (?:unique )?index(?: if not exists)?\s+\w+\s+on\s+(\w+)/gi)].map((x) => x[1])).toEqual(["shadow_books", "shadow_books"]);
    expect(m).toMatch(/alter table shadow_books enable row level security;/); expect(m).toMatch(/revoke all on table shadow_books from public, anon, authenticated;/); expect(m).toMatch(/grant select, insert, delete on table shadow_books to service_role;/);
    expect([...m.matchAll(/\bgrant\b/gi)]).toHaveLength(1); // one grant, to the service role only
    expect(m).not.toMatch(/\bdrop\s+(?!table if exists shadow_books)|create (or replace )?function|create (or replace )?view|create policy|create trigger|alter (function|policy|view)/i);
  });
});

describe("what the recorder may ask the network", () => {
  it("only the two public CLOB read paths, assembled from one base constant; no other URL, no POST", () => {
    const all = files.map(code).join("\n"); const urls = [...all.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]); expect(urls).toEqual(["https://clob.polymarket.com"]);
    expect([...all.matchAll(/\$\{CLOB_BASE\}(\/[a-z-]+)/g)].map((m) => m[1]).sort()).toEqual(["/book", "/fee-rate"]);
    expect(all).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"|\bfetch\(|XMLHttpRequest|WebSocket/);
  });
  it("no credential, signing, wallet or order vocabulary anywhere in the recorder", () => { for (const f of files) expect(code(f), f).not.toMatch(/api[-_ ]?key|secret|passphrase|private[-_ ]?key|mnemonic|wallet[-_ ]?(key|address|file)|bearer|authorization|createOrder|postOrder|placeOrder|cancelOrder|\/order\b|\/orders\b|\bhmac\b|eip712|signTypedData/i); });
  it("it never changes a signal, a score, an alert, a paper result or the portfolio: nothing in the recorder imports their writers", () => {
    for (const f of files) for (const m of code(f).matchAll(/from "(\.\.\/\.\.\/[^"]+|\.\.\/[^"]+)"/g)) expect(m[1], `${f} imports ${m[1]}`).toMatch(/^\.\.\/(\.\.\/paper\/sim\/(execute|config)|\.\.\/health\/heartbeat|\.\.\/chunk|http|stats|cli|readonly-db|categorize|\.\.\/db)$|^\.\.\/\.\.\/(health\/heartbeat|chunk|db|paper\/sim\/(execute|config))$|^\.\.\/(http|stats|cli|readonly-db|categorize)$/);
  });
});

describe("the polite client keeps its old behaviour unless asked", () => {
  const mk = (statuses: number[], o: ConstructorParameters<typeof PoliteHttp>[0] = {}) => { let i = 0; const calls: number[] = []; const f = (async () => { calls.push(1); const s = statuses[Math.min(i++, statuses.length - 1)]; return new Response(s === 200 ? "{}" : "x", { status: s, headers: s === 429 ? { "retry-after": "2" } : {} }); }) as unknown as typeof fetch; return { calls, http: new PoliteHttp({ fetch: f, sleep: async () => {}, now: () => 0, ...o }) }; };
  it("default: a 429 is retried (up to 3 attempts); with retryRateLimited false it is returned at once, with the server's Retry-After uncapped", async () => {
    const a = mk([429, 429, 200]); expect((await a.http.getJson("https://x.test/a")).ok).toBe(true); expect(a.calls).toHaveLength(3);
    const b = mk([429, 200], { retryRateLimited: false }); const r = await b.http.getJson("https://x.test/a"); expect(b.calls).toHaveLength(1); expect(r).toMatchObject({ ok: false, kind: "RATE_LIMITED", status: 429, retryAfterMs: 2000 });
    const c = mk([429, 200], { retryRateLimited: false, maxRetryAfterMs: 500 }); expect(await c.http.getJson("https://x.test/a")).toMatchObject({ retryAfterMs: 2000 });
  });
  it("default: events are recorded; with recordEvents false they are not, and requests still count", async () => {
    const a = mk([200]); await a.http.getJson("https://x.test/a"); expect(a.http.events).toHaveLength(1);
    const b = mk([200], { recordEvents: false }); await b.http.getJson("https://x.test/a"); expect(b.http.events).toHaveLength(0); expect(b.http.requests).toBe(1);
  });
  it("a 5xx is still retried with Retry-After honoured up to the cap (the sleep is capped, the reported value is not)", async () => {
    const slept: number[] = []; let n = 0; const f = (async () => (n++ ? new Response("{}") : new Response("x", { status: 503, headers: { "retry-after": "999" } }))) as unknown as typeof fetch;
    const h = new PoliteHttp({ fetch: f, sleep: async (ms) => { slept.push(ms); }, now: () => 0 }); expect((await h.getJson("https://x.test/a")).ok).toBe(true); expect(Math.max(...slept)).toBe(30_000);
  });
  it("the global gap can never be shortened below 500 ms", () => { expect((new PoliteHttp({ minIntervalMs: 1 }) as any).gap).toBe(500); expect((new PoliteHttp({ minIntervalMs: 900 }) as any).gap).toBe(900); });
});
