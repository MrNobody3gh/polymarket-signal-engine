/**
 * The subset of the Supabase query builder the portfolio code uses, over a real Postgres connection, with Supabase's
 * read cap (a plain read returns at most `maxRows` rows, 1,000 by default; a head count is exact). Lets real-Postgres
 * tests run library code unchanged. Supported: select (incl. { count: "exact", head: true }), delete, update, upsert,
 * insert; eq, neq, is, in, gt, gte, lt, lte; order; limit; maybeSingle; rpc (a function returning one value).
 */
import type pg from "pg";

export function pgDb(c: pg.Client | pg.PoolClient, opts: { maxRows?: number } = {}) {
  const cap = opts.maxRows ?? 1000;
  const ident = (s: string) => s.split(",").map((x) => x.trim()).map((x) => (x === "*" ? x : `"${x.replace(/"/g, "")}"`)).join(",");
  function from(table: string) {
    let op: "select" | "delete" | "update" | "upsert" | "insert" = "select"; let cols = "*"; let head = false; let count = false; let payload: any; let conflict: string | null = null;
    let lim: number | null = null; let single = false; const where: [string, string, any][] = []; const orders: string[] = [];
    const b: any = {
      select: (c0 = "*", x?: { count?: string; head?: boolean }) => { cols = c0; head = !!x?.head; count = !!x?.count; return b; },
      eq: (k: string, v: any) => (where.push([k, "=", v]), b), neq: (k: string, v: any) => (where.push([k, "<>", v]), b),
      gt: (k: string, v: any) => (where.push([k, ">", v]), b), gte: (k: string, v: any) => (where.push([k, ">=", v]), b),
      lt: (k: string, v: any) => (where.push([k, "<", v]), b), lte: (k: string, v: any) => (where.push([k, "<=", v]), b),
      is: (k: string, v: any) => (where.push([k, "is", v]), b), like: (k: string, v: string) => (where.push([k, "like", v]), b), in: (k: string, v: any[]) => (where.push([k, "in", v]), b),
      order: (k: string, x?: { ascending?: boolean }) => (orders.push(`"${k}" ${x?.ascending === false ? "desc" : "asc"}`), b),
      limit: (n: number) => ((lim = n), b), maybeSingle: () => ((single = true), b),
      delete: () => ((op = "delete"), b), update: (p: any) => ((op = "update"), (payload = p), b),
      upsert: (p: any, x?: { onConflict?: string }) => ((op = "upsert"), (payload = p), (conflict = x?.onConflict ?? null), b), insert: (p: any) => ((op = "insert"), (payload = p), b),
      then: (res: any, rej: any) => run().then(res, rej),
    };
    async function run() {
      const vals: any[] = []; const $ = (v: any) => (vals.push(v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v), `$${vals.length}`);
      const cond = where.map(([k, o, v]) => (o === "in" ? `"${k}" = any(${$(v)})` : o === "is" ? `"${k}" is ${v === null ? "null" : v ? "true" : "false"}` : `"${k}" ${o} ${$(v)}`));
      const w = cond.length ? ` where ${cond.join(" and ")}` : "";
      try {
        if (op === "select") {
          if (head) { const r = await c.query(`select count(*)::int as n from "${table}"${w}`, vals); return { data: null, count: r.rows[0].n, error: null }; }
          const n = Math.min(lim ?? Infinity, cap);
          const r = await c.query(`select ${ident(cols)} from "${table}"${w}${orders.length ? ` order by ${orders.join(",")}` : ""}${Number.isFinite(n) ? ` limit ${n}` : ""}`, vals);
          return { data: single ? r.rows[0] ?? null : r.rows, count: count ? r.rowCount : null, error: null };
        }
        if (op === "delete") { await c.query(`delete from "${table}"${w}`, vals); return { data: null, error: null }; }
        if (op === "update") { const ks = Object.keys(payload); await c.query(`update "${table}" set ${ks.map((k) => `"${k}" = ${$(payload[k])}`).join(",")}${w}`, vals); return { data: null, error: null }; }
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const row of rows) {
          const ks = Object.keys(row); const vs = ks.map((k) => $(row[k]));
          const on = op === "upsert" ? ` on conflict (${conflict ?? ks[0]}) do update set ${ks.map((k) => `"${k}" = excluded."${k}"`).join(",")}` : "";
          await c.query(`insert into "${table}" (${ks.map((k) => `"${k}"`).join(",")}) values (${vs.join(",")})${on}`, vals.splice(0));
        }
        return { data: null, error: null };
      } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
    }
    return b;
  }
  const rpc = async (fn: string, args: Record<string, any>) => {
    const ks = Object.keys(args);
    try { const r = await c.query(`select ${fn}(${ks.map((k, i) => `${k} => $${i + 1}`).join(",")}) as v`, ks.map((k) => args[k])); return { data: r.rows[0].v, error: null }; }
    catch (e) { return { data: null, error: { message: (e as Error).message } }; }
  };
  return { from, rpc };
}
