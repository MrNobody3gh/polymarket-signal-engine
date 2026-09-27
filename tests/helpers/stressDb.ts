/**
 * Minimal indexed in-memory database implementing exactly the query shapes the simulation sweep and the portfolio
 * runner use. It records how many rows each call materialises, so tests can assert that a working set is bounded no
 * matter how large the table is.
 *
 * Supported: select (incl. { count: "exact", head: true }) / insert / upsert (onConflict, ignoreDuplicates) / update /
 * delete; eq, neq, in, is, gt, gte, lt, lte; order (multi-column) + limit; maybeSingle; rpc via `opts.rpc`; an optional
 * `maxRows` read cap like Supabase's. Tables in SORTED keep a sorted array so a range
 * scan on the first sort column (the portfolio stream, equity ranges) is a binary search, not a table scan.
 */
type Row = Record<string, any>;
const PK: Record<string, string[]> = {
  paper_executions: ["signal_id", "mode"], price_observations: ["token_id", "as_of"], paper_ledger: ["signal_id"], signals: ["id"], markets: ["condition_id"], cursors: ["key"],
  portfolios: ["id"], portfolio_runs: ["portfolio_id"], portfolio_checkpoints: ["portfolio_id", "event_ts", "event_key"], portfolio_decisions: ["portfolio_id", "signal_id"],
  portfolio_lots: ["portfolio_id", "signal_id"], portfolio_equity: ["portfolio_id", "ts", "seq"], token_resolution_obs: ["token_id"],
};
const INDEX: Record<string, string[]> = {
  signals: ["id", "token_id"], paper_ledger: ["signal_id"], paper_marks: ["signal_id"], markets: ["condition_id"], price_observations: ["token_id"], paper_executions: ["signal_id", "fill_ts"], token_resolutions: ["token_id"],
  portfolio_decisions: ["signal_id"], portfolio_lots: ["signal_id"], portfolio_checkpoints: ["portfolio_id"], portfolio_runs: ["portfolio_id"], portfolios: ["id"],
};
const SORTED: Record<string, string[]> = { paper_executions: ["fill_ts", "signal_id"], portfolio_equity: ["ts", "seq"], paper_ledger: ["signal_id"] };
type Range = [string, "gt" | "gte" | "lt" | "lte", any];
const cmpv = (a: any, b: any) => (a === b ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : 1);

export function stressDb(opts: { slimExecutions?: boolean; rpc?: Record<string, (args: any) => any>; maxRows?: number } = {}) {
  const tables: Record<string, Row[]> = {}; const idx: Record<string, Map<string, Map<unknown, Row[]>>> = {}; const pkMap: Record<string, Map<string, Row>> = {}; const sorted: Record<string, Row[]> = {};
  const stats = { maxRowsPerCall: 0, maxWritePerCall: 0, calls: 0, writes: {} as Record<string, number>, deletes: {} as Record<string, number> };
  const T = (t: string) => (tables[t] ??= []);
  const key = (t: string, r: Row, cols = PK[t]) => (cols ?? []).map((c) => String(r[c])).join("|");
  const cmpRow = (t: string) => (a: Row, b: Row) => { for (const c of SORTED[t]) { const x = cmpv(a[c], b[c]); if (x) return x; } return 0; };
  const addIdx = (t: string, r: Row) => { for (const c of INDEX[t] ?? []) { const m = ((idx[t] ??= new Map()).get(c) ?? idx[t].set(c, new Map()).get(c)!); (m.get(r[c]) ?? m.set(r[c], []).get(r[c])!).push(r); } };
  function addSorted(t: string, r: Row) {
    if (!SORTED[t]) return; const arr = (sorted[t] ??= []); const c = cmpRow(t); let lo = 0, hi = arr.length;
    if (!arr.length || c(arr[arr.length - 1], r) <= 0) { arr.push(r); return; } // append fast path (inserts are mostly in order)
    while (lo < hi) { const mid = (lo + hi) >> 1; if (c(arr[mid], r) <= 0) lo = mid + 1; else hi = mid; } arr.splice(lo, 0, r);
  }
  function insertRow(t: string, r: Row) { T(t).push(r); addIdx(t, r); addSorted(t, r); if (PK[t]) (pkMap[t] ??= new Map()).set(key(t, r), r); }
  function removeRows(t: string, dead: Set<Row>) {
    if (!dead.size) return; tables[t] = T(t).filter((r) => !dead.has(r));
    for (const m of idx[t]?.values() ?? []) for (const [v, rows] of m) { const keep = rows.filter((r) => !dead.has(r)); if (keep.length) m.set(v, keep); else m.delete(v); }
    if (sorted[t]) sorted[t] = sorted[t].filter((r) => !dead.has(r));
    for (const r of dead) pkMap[t]?.delete(key(t, r));
  }
  function q(t: string) {
    let op = "select"; let payload: any; let o: any = {}; const eq: [string, any][] = []; const neq: [string, any][] = []; const ins: [string, any[]][] = []; const ranges: Range[] = []; const orders: [string, boolean][] = [];
    let lim = Infinity; let single = false; let head = false; let wantCount = false;
    const b: any = {
      select: (_c?: string, x?: { count?: string; head?: boolean }) => { if (x?.head) head = true; if (x?.count) wantCount = true; return b; }, limit: (n: number) => ((lim = n), b), maybeSingle: () => ((single = true), b), single: () => ((single = true), b),
      order: (c: string, x?: { ascending?: boolean }) => (orders.push([c, x?.ascending !== false]), b),
      eq: (k: string, v: any) => (eq.push([k, v]), b), neq: (k: string, v: any) => (neq.push([k, v]), b), is: (k: string, v: any) => (eq.push([k, v]), b), in: (k: string, v: any[]) => (ins.push([k, v]), b),
      gt: (k: string, v: any) => (ranges.push([k, "gt", v]), b), gte: (k: string, v: any) => (ranges.push([k, "gte", v]), b), lt: (k: string, v: any) => (ranges.push([k, "lt", v]), b), lte: (k: string, v: any) => (ranges.push([k, "lte", v]), b),
      upsert: (p: any, x?: any) => ((op = "upsert"), (payload = p), (o = x ?? {}), b), update: (p: any) => ((op = "update"), (payload = p), b), insert: (p: any) => ((op = "insert"), (payload = p), b), delete: () => ((op = "delete"), b),
      then(res: any, rej: any) { try { res(exec()); } catch (e) { rej(e); } },
    };
    /** Rows to test, and whether they are already in the requested order. */
    function candidates(): { rows: Row[]; ordered: boolean } {
      const s = SORTED[t]; const r0: Range[] = s ? [...ranges.filter((r) => r[0] === s[0]), ...eq.filter(([k]) => k === s[0]).flatMap(([k, v]): Range[] => [[k, "gte", v], [k, "lte", v]])] : [];
      const sameOrder = s && orders.length > 0 && orders.every(([c, asc], i) => c === s[i] && asc);
      if (s && r0.length && (sameOrder || !orders.length)) {
        const arr = sorted[t] ?? []; let lo = 0, hi = arr.length;
        for (const [, opn, v] of r0) {
          const lb = (strict: boolean) => { let a = 0, z = arr.length; while (a < z) { const m = (a + z) >> 1; const x = cmpv(arr[m][s[0]], v); if (x < 0 || (strict && x === 0)) a = m + 1; else z = m; } return a; };
          if (opn === "gt") lo = Math.max(lo, lb(true)); else if (opn === "gte") lo = Math.max(lo, lb(false)); else if (opn === "lt") hi = Math.min(hi, lb(false)); else hi = Math.min(hi, lb(true));
        }
        return { rows: lo < hi ? arr.slice(lo, hi) : [], ordered: true };
      }
      for (const [k, vs] of ins) { const m = idx[t]?.get(k); if (m) return { rows: vs.flatMap((v) => m.get(v) ?? []), ordered: false }; }
      for (const [k, v] of eq) { const m = idx[t]?.get(k); if (m) return { rows: m.get(v) ?? [], ordered: false }; }
      const g = ranges.find((r) => r[1] === "gt");
      if (g && t === "paper_ledger" && g[0] === "signal_id") { const arr = T(t); let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].signal_id <= g[2]) lo = mid + 1; else hi = mid; } return { rows: arr.slice(lo), ordered: false }; }
      return { rows: T(t), ordered: false };
    }
    const inRange = (r: Row) => ranges.every(([k, opn, v]) => { const x = cmpv(r[k], v); return opn === "gt" ? x > 0 : opn === "gte" ? x >= 0 : opn === "lt" ? x < 0 : x <= 0; });
    const match = (r: Row) => eq.every(([k, v]) => (v === null ? r[k] == null : r[k] === v)) && neq.every(([k, v]) => r[k] !== v) && ins.every(([k, vs]) => vs.includes(r[k])) && inRange(r);
    function exec() {
      stats.calls++;
      if (op === "select") {
        const { rows, ordered } = candidates(); let out: Row[] = [];
        if (head || wantCount) { const n = rows.filter(match).length; if (head) return { data: null, count: n, error: null }; }
        lim = Math.min(lim, opts.maxRows ?? Infinity);                  // Supabase caps every read (1,000 rows by default)
        const early = ordered || !orders.length;
        for (const r of rows) { if (match(r)) { out.push(r); if (early && out.length >= lim) break; } }
        if (!early) { out.sort((a, b) => { for (const [c, asc] of orders) { const x = cmpv(a[c], b[c]); if (x) return asc ? x : -x; } return 0; }); out = out.slice(0, lim); }
        stats.maxRowsPerCall = Math.max(stats.maxRowsPerCall, out.length);
        const copy = out.map((r) => ({ ...r }));
        return { data: single ? copy[0] ?? null : copy, error: null };
      }
      if (op === "update") { let n = 0; for (const r of candidates().rows) if (match(r)) { Object.assign(r, payload); n++; } stats.maxWritePerCall = Math.max(stats.maxWritePerCall, n); stats.writes[t] = (stats.writes[t] ?? 0) + n; return { data: null, error: null }; }
      if (op === "delete") { const dead = new Set(candidates().rows.filter(match)); removeRows(t, dead); stats.deletes[t] = (stats.deletes[t] ?? 0) + dead.size; return { data: null, error: null }; }
      const list = Array.isArray(payload) ? payload : [payload]; stats.maxWritePerCall = Math.max(stats.maxWritePerCall, list.length);
      const conflict = o.onConflict ? String(o.onConflict).split(",") : PK[t];
      for (const raw of list) {
        const r = t === "paper_executions" && o.slim !== false && slim ? { signal_id: raw.signal_id, mode: raw.mode, record_hash: raw.record_hash, coverage_state: raw.coverage_state, state: raw.state } : { ...raw };
        const samePk = !!PK[t] && conflict?.join(",") === PK[t].join(",");
        const ex = !conflict ? undefined : samePk ? pkMap[t]?.get(key(t, r)) : T(t).find((x) => key(t, x, conflict) === key(t, r, conflict));
        if (ex) { if (op === "insert") return { data: null, error: { code: "23505" } }; if (!o.ignoreDuplicates) Object.assign(ex, r); } else insertRow(t, r);
      }
      stats.writes[t] = (stats.writes[t] ?? 0) + list.length;
      return { data: null, error: null };
    }
    return b;
  }
  const slim = !!opts.slimExecutions;
  const rpc = async (name: string, args: any) => { const f = opts.rpc?.[name]; if (!f) return { data: null, error: null }; try { return { data: await f(args), error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; } };
  return { tables, stats, T, insertRow, from: (t: string) => q(t), rpc };
}
