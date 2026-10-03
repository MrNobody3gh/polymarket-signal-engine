/**
 * Phase 4.0 — read-only database access by construction.
 *
 * `ReadOnlyDb` exposes exactly one operation: `select(table, columns, options)`. It returns the Supabase filter builder
 * of a SELECT, which has filters, ordering and ranges but no insert / upsert / update / delete, and the wrapper has no
 * `rpc` (a function call could write). Phase 4.0 code receives this type, never a SupabaseClient, so a write is not
 * merely avoided, it cannot be typed. tests/phase4-readonly.test.ts additionally runs every script path against a
 * database that throws on any write method or RPC (the Phase 3 audit pattern).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectIn } from "../chunk";

export interface ReadOnlyDb {
  select(table: string, columns?: string, options?: { count?: "exact" | "planned" | "estimated"; head?: boolean }): ReturnType<ReturnType<SupabaseClient["from"]>["select"]>;
}
export function readOnly(db: Pick<SupabaseClient, "from">): ReadOnlyDb {
  return { select: (table, columns = "*", options) => db.from(table).select(columns, options) };
}

export const PAGE = 1000; // Supabase's per-request row cap
/** Read every row of a query, one page of PAGE rows at a time (`.range`), failing loudly on any page error: never a silent partial result. */
export async function selectAll<T = Record<string, any>>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>, maxRows = 500_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`query failed: ${(error as { message?: string }).message ?? String(error)}`);
    const rows = (data ?? []) as T[]; out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  throw new Error(`query returned more than ${maxRows} rows; narrow the window`);
}
export { selectIn };
