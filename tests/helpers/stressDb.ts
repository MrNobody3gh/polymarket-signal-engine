/**
 * Minimal indexed in-memory database implementing exactly the query shapes the simulation sweep uses.
 * It records how many rows each call materialises, so tests can assert the sweep's working set is bounded
 * no matter how large the table is.
 */
type Row = Record<string, any>;
const PK: Record<string, string[]> = { paper_executions: ["signal_id", "mode"], price_observations: ["token_id", "as_of"], paper_ledger: ["signal_id"], signals: ["id"], markets: ["condition_id"], cursors: ["key"] };
const INDEX: Record<string, string[]> = { signals: ["id", "token_id"], paper_ledger: ["signal_id"], paper_marks: ["signal_id"], markets: ["condition_id"], price_observations: ["token_id"], paper_executions: ["signal_id"], token_resolutions: ["token_id"] };
export function stressDb(opts: { slimExecutions?: boolean } = {}) {
  const tables: Record<string, Row[]> = {}; const idx: Record<string, Map<string, Map<unknown, Row[]>>> = {}; const pkMap: Record<string, Map<string, Row>> = {};
  const stats = { maxRowsPerCall: 0, maxWritePerCall: 0, calls: 0 };
  const T = (t: string) => (tables[t] ??= []);
  const key = (t: string, r: Row, cols = PK[t]) => (cols ?? []).map((c) => String(r[c])).join("|");
  const addIdx = (t: string, r: Row) => { for (const c of INDEX[t] ?? []) { const m = ((idx[t] ??= new Map()).get(c) ?? idx[t].set(c, new Map()).get(c)!); (m.get(r[c]) ?? m.set(r[c], []).get(r[c])!).push(r); } };
  function insertRow(t: string, r: Row) { T(t).push(r); addIdx(t, r); if (PK[t]) (pkMap[t] ??= new Map()).set(key(t, r), r); }
  function q(t: string) {
    let op = "select"; let payload: any; let opts: any = {}; const eq: [string, any][] = []; const ins: [string, any[]][] = []; let gt: [string, any] | null = null; let lim = Infinity; let single = false;
    const b: any = {
      select: () => b, order: () => b, limit: (n: number) => ((lim = n), b), maybeSingle: () => ((single = true), b),
      eq: (k: string, v: any) => (eq.push([k, v]), b), in: (k: string, v: any[]) => (ins.push([k, v]), b), gt: (k: string, v: any) => ((gt = [k, v]), b),
      upsert: (p: any, o?: any) => ((op = "upsert"), (payload = p), (opts = o ?? {}), b), update: (p: any) => ((op = "update"), (payload = p), b), insert: (p: any) => ((op = "insert"), (payload = p), b),
      then(res: any, rej: any) { try { res(exec()); } catch (e) { rej(e); } },
    };
    function candidates(): Row[] {
      for (const [k, vs] of ins) { const m = idx[t]?.get(k); if (m) return vs.flatMap((v) => m.get(v) ?? []); }
      for (const [k, v] of eq) { const m = idx[t]?.get(k); if (m) return m.get(v) ?? []; }
      if (gt && t === "paper_ledger") { const arr = T(t); let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].signal_id <= gt[1]) lo = mid + 1; else hi = mid; } return arr.slice(lo); }
      return T(t);
    }
    const match = (r: Row) => eq.every(([k, v]) => r[k] === v) && ins.every(([k, vs]) => vs.includes(r[k])) && (!gt || r[gt[0]] > gt[1]);
    function exec() {
      stats.calls++;
      if (op === "select") { const out: Row[] = []; for (const r of candidates()) { if (match(r)) { out.push(r); if (out.length >= lim) break; } } stats.maxRowsPerCall = Math.max(stats.maxRowsPerCall, out.length); return { data: single ? out[0] ?? null : out, error: null }; }
      if (op === "update") { let n = 0; for (const r of candidates()) if (match(r)) { Object.assign(r, payload); n++; } stats.maxWritePerCall = Math.max(stats.maxWritePerCall, n); return { data: null, error: null }; }
      const list = Array.isArray(payload) ? payload : [payload]; stats.maxWritePerCall = Math.max(stats.maxWritePerCall, list.length);
      for (const raw of list) {
        const r = t === "paper_executions" && opts.slim !== false && slim ? { signal_id: raw.signal_id, mode: raw.mode, record_hash: raw.record_hash, coverage_state: raw.coverage_state, state: raw.state } : { ...raw };
        const ex = PK[t] ? pkMap[t]?.get(key(t, r)) : undefined;
        if (ex) { if (op === "insert") return { data: null, error: { code: "23505" } }; if (!opts.ignoreDuplicates) Object.assign(ex, r); } else insertRow(t, r);
      }
      return { data: null, error: null };
    }
    return b;
  }
  const slim = !!opts.slimExecutions;
  return { tables, stats, T, insertRow, from: (t: string) => q(t), rpc: async () => ({ data: null, error: null }) };
}
