/** In-memory stand-in for the subset of the Supabase query builder the engine/poller use. Single-threaded JS makes
 *  each terminal operation atomic, exactly like a single SQL statement — which is what the claim logic relies on. */
type Row = Record<string, any>;
const PK: Record<string, string[]> = { fills: ["id"], positions: ["wallet", "token_id"], signals: ["dedupe_key"], paper_ledger: ["signal_id"], paper_marks: ["signal_id", "horizon"], consensus_events: ["signal_id"], cursors: ["key"], markets: ["condition_id"] };
let uuid = 0;
export function fakeDb() {
  const tables: Record<string, Row[]> = {};
  const T = (t: string) => (tables[t] ??= []);
  const keyOf = (t: string, r: Row, cols = PK[t]) => (cols ?? []).map((c) => String(r[c])).join("|");
  const writes: { table: string; op: string; n: number }[] = [];
  function q(t: string) {
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select"; let payload: any; let opts: any = {};
    const filters: ((r: Row) => boolean)[] = []; let head = false; let single = false; let lim = Infinity; let returning = false;
    const b: any = {
      select(_c?: string, o?: any) { if (op === "select") { if (o?.head) head = true; } else returning = true; return b; },
      eq: (k: string, v: any) => (filters.push((r) => r[k] === v), b), neq: (k: string, v: any) => (filters.push((r) => r[k] !== v), b),
      gt: (k: string, v: any) => (filters.push((r) => r[k] > v), b), gte: (k: string, v: any) => (filters.push((r) => r[k] >= v), b), lt: (k: string, v: any) => (filters.push((r) => r[k] < v), b),
      is: (k: string, v: any) => (filters.push((r) => (r[k] ?? null) === v), b), in: (k: string, vs: any[]) => (filters.push((r) => vs.includes(r[k])), b),
      like: (k: string, p: string) => (filters.push((r) => String(r[k]).startsWith(p.replace(/%$/, ""))), b),
      order: () => b, limit: (n: number) => ((lim = n), b), maybeSingle: () => ((single = true), b),
      insert: (p: any) => ((op = "insert"), (payload = p), b), upsert: (p: any, o?: any) => ((op = "upsert"), (payload = p), (opts = o ?? {}), b),
      update: (p: any) => ((op = "update"), (payload = p), b), delete: () => ((op = "delete"), b),
      then(res: any, rej: any) { try { res(exec()); } catch (e) { rej(e); } },
    };
    function exec() {
      const tab = T(t); const match = () => tab.filter((r) => filters.every((f) => f(r)));
      if (op === "select") { const rows = match().slice(0, lim).map((r) => ({ ...r })); if (head) return { data: null, count: rows.length, error: null }; return { data: single ? rows[0] ?? null : rows, error: null }; }
      if (op === "update") { const rows = match(); rows.forEach((r) => Object.assign(r, payload)); writes.push({ table: t, op, n: rows.length }); return { data: null, error: null }; }
      if (op === "delete") { const rows = new Set(match()); tables[t] = tab.filter((r) => !rows.has(r)); return { data: null, error: null }; }
      const list = Array.isArray(payload) ? payload : [payload]; const out: Row[] = [];
      for (const raw of list) {
        const r = { ...raw }; if (t === "signals" && !r.id) r.id = `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`;
        const conflictCols = op === "upsert" && opts.onConflict ? String(opts.onConflict).split(",") : PK[t];
        const existing = conflictCols ? tab.find((x) => keyOf(t, x, conflictCols) === keyOf(t, r, conflictCols)) : undefined;
        if (existing) {
          if (op === "insert") return { data: null, error: { code: "23505", message: "duplicate key" } };
          if (opts.ignoreDuplicates) continue; Object.assign(existing, r); out.push({ ...existing });
        } else { tab.push(r); out.push({ ...r }); }
      }
      writes.push({ table: t, op, n: out.length });
      return { data: returning ? (single ? out[0] ?? null : out) : null, error: null };
    }
    return b;
  }
  return { tables, writes, T, from: (t: string) => q(t), rpc: async () => ({ data: null, error: null }) };
}
