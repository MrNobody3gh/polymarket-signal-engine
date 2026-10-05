/**
 * A small in-memory database for the Phase 4.1 tests, implementing exactly the query-builder subset the shadow job and report use, WITH ordering,
 * ranges and a Supabase-like 1,000-row cap. It records every call (`calls`) so a test can prove that a code path made none, and every write
 * (`writes`) so a test can prove which tables were touched. `failOn` makes one table throw, to inject failures.
 */
type Row = Record<string, any>;
export function shadowDb(seed: Record<string, Row[]> = {}, o: { failOn?: (table: string, op: string) => Error | null } = {}) {
  const tables: Record<string, Row[]> = {}; for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  const calls: { table: string; op: string }[] = []; const writes: { table: string; op: string; n: number }[] = []; const PK: Record<string, string[]> = { shadow_books: ["signal_id", "offset_s"], cursors: ["key"] };
  const T = (t: string) => (tables[t] ??= []);
  const cmp = (a: any, b: any) => (a === b ? 0 : a === null || a === undefined ? -1 : b === null || b === undefined ? 1 : a < b ? -1 : 1);
  function from(t: string) {
    calls.push({ table: t, op: "from" });
    let op: "select" | "upsert" | "delete" = "select"; let payload: any; let opts: any = {}; let head = false; let count = false; let lim = 1000; let off = 0;
    const filters: ((r: Row) => boolean)[] = []; const orders: [string, boolean][] = [];
    const b: any = {
      select: (_c?: string, x?: any) => { head = !!x?.head; count = !!x?.count; return b; },
      eq: (k: string, v: any) => (filters.push((r) => r[k] === v), b), neq: (k: string, v: any) => (filters.push((r) => r[k] !== v), b),
      gt: (k: string, v: any) => (filters.push((r) => cmp(r[k], v) > 0), b), gte: (k: string, v: any) => (filters.push((r) => cmp(r[k], v) >= 0), b),
      lt: (k: string, v: any) => (filters.push((r) => cmp(r[k], v) < 0), b), lte: (k: string, v: any) => (filters.push((r) => cmp(r[k], v) <= 0), b),
      in: (k: string, vs: any[]) => (filters.push((r) => vs.includes(r[k])), b), like: (k: string, p: string) => (filters.push((r) => String(r[k]).startsWith(p.replace(/%$/, ""))), b),
      order: (k: string, x?: { ascending?: boolean }) => (orders.push([k, x?.ascending !== false]), b), limit: (n: number) => ((lim = Math.min(n, 1000)), b), range: (a: number, z: number) => ((off = a), (lim = Math.min(z - a + 1, 1000)), b),
      upsert: (p: any, x?: any) => ((op = "upsert"), (payload = p), (opts = x ?? {}), b), delete: () => ((op = "delete"), b),
      then: (res: any, rej: any) => { try { res(run()); } catch (e) { rej(e); } },
    };
    function run() {
      calls.push({ table: t, op });
      const injected = o.failOn?.(t, op); if (injected) return { data: null, error: { message: injected.message } };
      const tab = T(t); const match = () => tab.filter((r) => filters.every((f) => f(r)));
      if (op === "select") {
        let rows = match(); if (orders.length) rows = [...rows].sort((a, c) => { for (const [k, asc] of orders) { const d = cmp(a[k], c[k]); if (d) return asc ? d : -d; } return 0; });
        if (head) return { data: null, count: rows.length, error: null };
        return { data: rows.slice(off, off + lim).map((r) => JSON.parse(JSON.stringify(r))), count: count ? rows.length : null, error: null };
      }
      if (op === "delete") { const gone = new Set(match()); tables[t] = tab.filter((r) => !gone.has(r)); writes.push({ table: t, op, n: gone.size }); return { data: null, error: null }; }
      const list: Row[] = Array.isArray(payload) ? payload : [payload]; const cols = String(opts.onConflict ?? "").split(",").filter(Boolean); const key = (r: Row) => (cols.length ? cols : PK[t] ?? []).map((c) => String(r[c])).join("|"); let n = 0;
      for (const raw of list) { const r = JSON.parse(JSON.stringify(raw)); const ex = tab.find((x) => key(x) === key(r)); if (ex) { if (opts.ignoreDuplicates) continue; Object.assign(ex, r); } else tab.push(r); n++; }
      writes.push({ table: t, op, n }); return { data: null, error: null };
    }
    return b;
  }
  return { from, rpc: async () => { calls.push({ table: "*", op: "rpc" }); return { data: null, error: null }; }, tables, calls, writes, T };
}
