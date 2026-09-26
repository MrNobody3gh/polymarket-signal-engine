/**
 * Token order (which outcome index each token is) for resolution lookups.
 *
 * /v2/resolutions reports payouts by outcome index, so settling a token needs the market's ordered clobTokenIds. The
 * marker's source (paper/mark.ts gammaSource) reads them from the `markets` cache, else asks Gamma's /markets/keyset
 * without a `closed` filter — and Gamma omits closed markets unless `closed=true` is passed. For a market first seen
 * after it closed (exactly the markets that need resolving) that lookup returns nothing, and the token is reported
 * as "resolution_token_index_unknown" unless its outcome is literally Yes/No.
 *
 * This helper fills the cache for the given conditions, asking Gamma with `closed=true` when the default query finds
 * nothing, and writes the same row GammaMarketMeta writes (execMetaRow). Gamma matches one condition per request (a
 * comma-separated list returns nothing), so requests run with bounded concurrency.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { GAMMA_API, PolymarketClient } from "./client";
import { execMetaRow, parseGammaExecMeta } from "./markets";
import { selectIn } from "../chunk";

export interface TokenOrderResult { cached: number; fetched: number; missing: string[]; orders: Map<string, string[]> }

/** Fetch one market's metadata, trying Gamma's default view first and then closed markets. */
export async function gammaMarket(client: Pick<PolymarketClient, "get">, conditionId: string): Promise<Record<string, unknown> | null> {
  const key = conditionId.toLowerCase();
  for (const closed of [undefined, true] as const) {
    const b = await client.get<{ markets?: Record<string, unknown>[] }>(GAMMA_API, "/markets/keyset", { condition_ids: conditionId, limit: 5, closed });
    const m = (b.markets ?? []).find((x) => String(x.conditionId ?? x.condition_id ?? "").toLowerCase() === key);
    if (m) return m;
  }
  return null;
}

/**
 * Make sure `markets.clob_token_ids` is known for each condition. `write: false` only reads the cache and returns what
 * Gamma says (for read-only reports).
 */
export async function ensureTokenOrder(db: SupabaseClient | null, conditionIds: string[], opts: { client?: Pick<PolymarketClient, "get">; concurrency?: number; write?: boolean; now?: () => number } = {}): Promise<TokenOrderResult> {
  const client = opts.client ?? new PolymarketClient(); const write = opts.write ?? true; const now = opts.now ?? (() => Date.now());
  const conds = [...new Set(conditionIds.map((c) => c.toLowerCase()).filter((c) => /^0x[0-9a-f]{64}$/.test(c)))];
  const orders = new Map<string, string[]>();
  if (db && conds.length) {
    const rows = await selectIn<{ condition_id: string; clob_token_ids: string[] | null }>(conds, (c) => db.from("markets").select("condition_id,clob_token_ids").in("condition_id", c as string[]));
    for (const r of rows) if (Array.isArray(r.clob_token_ids) && r.clob_token_ids.length) orders.set(r.condition_id, r.clob_token_ids.map(String));
  }
  const cached = orders.size; const todo = conds.filter((c) => !orders.has(c)); const missing: string[] = []; let fetched = 0; let i = 0;
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, todo.length) }, async () => {
    while (i < todo.length) {
      const c = todo[i++];
      let m: Record<string, unknown> | null = null;
      try { m = await gammaMarket(client, c); } catch { /* counted as missing; asked again next run */ }
      const meta = parseGammaExecMeta(c, m);
      if (!m || !meta.clobTokenIds?.length) { missing.push(c); continue; }
      orders.set(c, meta.clobTokenIds); fetched++;
      if (write && db) { const { error } = await db.from("markets").upsert(execMetaRow(meta, now()), { onConflict: "condition_id" }); if (error) throw new Error(`markets write failed: ${error.message}`); }
    }
  }));
  return { cached, fetched, missing: missing.sort(), orders };
}
