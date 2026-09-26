/**
 * Authoritative market metadata (currently: end date) for rule evaluation.
 * Source of truth is Gamma (`/markets/keyset?condition_ids=`). Results are cached in memory and in the `markets`
 * table so a restart doesn't refetch. A market we cannot resolve yields null — callers must treat null as
 * "unknown", never as a date. Negative results are re-asked after an hour.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { GAMMA_API, PolymarketClient } from "./client";

export interface MarketMetaSource { endDate(conditionId: string): Promise<string | null> }

/** Pure: read an end date from a Gamma market row. Prefers the date-only field; never infers. */
export function parseGammaEndDate(m: Record<string, unknown> | null | undefined): string | null {
  if (!m) return null;
  for (const k of ["endDateIso", "end_date_iso", "endDate", "end_date"]) {
    const v = m[k]; if (typeof v !== "string") continue;
    const d = v.slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d + "T00:00:00Z"))) return d;
  }
  return null;
}

export class GammaMarketMeta implements MarketMetaSource {
  private mem = new Map<string, { v: string | null; at: number }>();
  constructor(private db: SupabaseClient | null, private client = new PolymarketClient(), private now = () => Date.now()) {}
  async endDate(conditionId: string): Promise<string | null> {
    if (!conditionId) return null;
    const key = conditionId.toLowerCase(); const hit = this.mem.get(key);
    if (hit && (hit.v !== null || this.now() - hit.at < 3600_000)) return hit.v;
    if (this.db && !hit) {
      const { data } = await this.db.from("markets").select("end_date").eq("condition_id", key).maybeSingle();
      if (data?.end_date) { const v = String(data.end_date).slice(0, 10); this.mem.set(key, { v, at: this.now() }); return v; }
    }
    let v: string | null = null;
    try {
      const b = await this.client.get<{ markets?: Record<string, unknown>[] }>(GAMMA_API, "/markets/keyset", { condition_ids: conditionId, limit: 5 });
      const m = (b.markets ?? []).find((x) => String(x.conditionId ?? x.condition_id ?? "").toLowerCase() === key);
      v = parseGammaEndDate(m);
    } catch { v = null; }
    this.mem.set(key, { v, at: this.now() });
    if (v && this.db) await this.db.from("markets").upsert({ condition_id: key, end_date: v, fetched_at: new Date(this.now()).toISOString() }, { onConflict: "condition_id" });
    return v;
  }
}
