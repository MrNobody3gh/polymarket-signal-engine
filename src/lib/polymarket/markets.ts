/**
 * Authoritative market metadata (currently: end date) for rule evaluation.
 * Source of truth is Gamma (`/markets/keyset?condition_ids=`). Results are cached in memory and in the `markets`
 * table so a restart doesn't refetch. A market we cannot resolve yields null — callers must treat null as
 * "unknown", never as a date. Negative results are re-asked after an hour.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { GAMMA_API, PolymarketClient } from "./client";

export interface MarketMetaSource { endDate(conditionId: string): Promise<string | null> }

/** Execution-relevant market configuration. Every field is null when the source did not provide it. */
export interface MarketExecMeta { conditionId: string; feesEnabled: boolean | null; takerFeeRate: number | null; tickSize: number | null; minOrderShares: number | null; clobTokenIds: string[] | null; endDate: string | null }
/** Pure: read execution metadata from a Gamma market row. Never infers a missing value. */
export function parseGammaExecMeta(conditionId: string, m: Record<string, unknown> | null | undefined): MarketExecMeta {
  const num = (...ks: string[]) => { for (const k of ks) { const v = Number(m?.[k]); if (m?.[k] !== undefined && m?.[k] !== null && m?.[k] !== "" && Number.isFinite(v)) return v; } return null; };
  const bool = (k: string) => (m?.[k] === true || m?.[k] === "true" ? true : m?.[k] === false || m?.[k] === "false" ? false : null);
  const raw = m?.clobTokenIds; const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
  let rate = num("takerFeeRate", "taker_fee_rate", "feeRate", "takerBaseFee");
  if (rate != null && rate > 1) rate = rate / 10_000; // basis points → fraction
  return { conditionId: conditionId.toLowerCase(), feesEnabled: bool("feesEnabled"), takerFeeRate: rate, tickSize: num("orderPriceMinTickSize"), minOrderShares: num("orderMinSize"), clobTokenIds: Array.isArray(arr) ? arr.map(String) : null, endDate: parseGammaEndDate(m) };
}

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
      const meta = parseGammaExecMeta(key, m); v = meta.endDate;
      if (m && this.db) await this.db.from("markets").upsert(execMetaRow(meta, this.now()), { onConflict: "condition_id" });
    } catch { v = null; }
    this.mem.set(key, { v, at: this.now() });
    return v;
  }
}

export function execMetaRow(meta: MarketExecMeta, nowMs: number) {
  return { condition_id: meta.conditionId, end_date: meta.endDate, fees_enabled: meta.feesEnabled, taker_fee_rate: meta.takerFeeRate, tick_size: meta.tickSize, min_order_shares: meta.minOrderShares, clob_token_ids: meta.clobTokenIds, meta_fetched_at: new Date(nowMs).toISOString(), fetched_at: new Date(nowMs).toISOString() };
}
