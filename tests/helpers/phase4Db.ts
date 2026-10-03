/**
 * Test doubles for the Phase 4.0 scripts: an in-memory database that supports exactly the SELECT query-builder surface
 * the scripts use, wrapped in a SPY that throws (and records) if any write method or RPC is ever touched — the Phase 3
 * audit pattern — and a fake `fetch` that records every request.
 */
type Row = Record<string, any>;
const WRITE_METHODS = ["insert", "upsert", "update", "delete"];

const num = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : v);
const cmp = (a: any, b: any) => { const x: any = num(a), y: any = num(b); return x < y ? -1 : x > y ? 1 : 0; };

export function memDb(tables: Record<string, Row[]>) {
  const reads: { table: string; cols: string; filters: string[] }[] = [];
  const touched: string[] = []; // any write method or rpc that was reached
  function builder(table: string, cols: string) {
    const filters: ((r: Row) => boolean)[] = []; const desc: string[] = []; const orders: { k: string; asc: boolean }[] = []; let lo = 0, hi = Infinity, one = false;
    const f = (name: string, fn: (r: Row) => boolean) => { filters.push(fn); desc.push(name); return b; };
    const b: any = {
      eq: (k: string, v: any) => f(`eq ${k}`, (r) => r[k] === v), neq: (k: string, v: any) => f(`neq ${k}`, (r) => r[k] !== v),
      gt: (k: string, v: any) => f(`gt ${k}`, (r) => cmp(r[k], v) > 0), gte: (k: string, v: any) => f(`gte ${k}`, (r) => cmp(r[k], v) >= 0),
      lt: (k: string, v: any) => f(`lt ${k}`, (r) => cmp(r[k], v) < 0), lte: (k: string, v: any) => f(`lte ${k}`, (r) => cmp(r[k], v) <= 0),
      in: (k: string, vs: any[]) => f(`in ${k}`, (r) => vs.includes(r[k])), is: (k: string, v: any) => f(`is ${k}`, (r) => (r[k] ?? null) === v),
      order: (k: string, o?: { ascending?: boolean }) => (orders.push({ k, asc: o?.ascending !== false }), b), range: (a: number, z: number) => ((lo = a), (hi = z), b), limit: (n: number) => ((hi = lo + n - 1), b), maybeSingle: () => ((one = true), b),
      then(res: any, rej: any) {
        try {
          let rows = (tables[table] ?? []).filter((r) => filters.every((x) => x(r)));
          for (const o of [...orders].reverse()) rows = [...rows].sort((p, q) => (o.asc ? 1 : -1) * cmp(p[o.k], q[o.k]));
          rows = rows.slice(lo, hi === Infinity ? undefined : hi + 1);
          const want = cols === "*" ? null : cols.split(",").map((c) => c.trim().replace(/^.*:/, ""));
          const out = rows.map((r) => (want ? Object.fromEntries(want.map((c) => [c, r[c]])) : { ...r }));
          res({ data: one ? out[0] ?? null : out, error: null });
        } catch (e) { rej(e); }
      },
    };
    reads.push({ table, cols, filters: desc }); return b;
  }
  const db = {
    from: (table: string) => new Proxy({ select: (cols = "*") => builder(table, cols) } as Record<string, unknown>, {
      get(t, p) { if (WRITE_METHODS.includes(String(p))) return () => { touched.push(`${String(p)}:${table}`); throw new Error(`WRITE ${String(p)} on ${table}`); }; return t[p as string]; },
    }),
    rpc: (name: string) => { touched.push(`rpc:${name}`); throw new Error(`RPC ${name}`); },
  };
  return { db, reads, touched, tables };
}

export interface FetchCall { url: string; method: string; headers: Record<string, string>; at: number | null }
/** A fake fetch. The handler returns a Response (or throws). Every call is recorded. */
export function fakeFetch(handler: (url: URL, call: FetchCall) => Response | Promise<Response>, now?: () => number) {
  const calls: FetchCall[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const headers: Record<string, string> = {}; for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: FetchCall = { url: url.toString(), method: String(init?.method ?? "GET"), headers, at: now ? now() : null }; calls.push(call); return handler(url, call);
  };
  return { fetch: f, calls };
}
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A virtual clock: `sleep` advances it, `now` reads it; request start times can be checked against the 2 requests/second ceiling. */
export function virtualClock(start = Date.parse("2026-10-03T00:00:00Z")) {
  let t = start; const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, advance: (ms: number) => { t += ms; } };
}
