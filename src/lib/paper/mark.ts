/**
 * Price marking and settlement. Idempotent: (signal_id, horizon) is the PK of paper_marks and settlement
 * only touches rows still OPEN. Never fabricates a price: a missing observation is logged, not zeroed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PolymarketClient, GAMMA_API, type PricePoint } from "../polymarket/client";
import { isValidPrice, logIssues, pnlFor, returnFor, type DqIssue } from "./ledger";
import { heartbeat } from "../health/heartbeat";

export const HORIZONS: { key: "1h" | "6h" | "24h"; seconds: number }[] = [{ key: "1h", seconds: 3600 }, { key: "6h", seconds: 6 * 3600 }, { key: "24h", seconds: 24 * 3600 }];
/** Only settle by "stale" fallback if the market is well past its end and Gamma says closed. */
export const RESOLUTION_MIN_AGE_SEC = 3600;

export interface OpenPaper { signal_id: string; token_id: string; condition_id: string; entry_price: number; shares: number; signal_ts: string; end_date?: string | null }
export interface MarkSource { priceAsOf(tokenId: string, asOf: number): Promise<PricePoint | null>; resolution(conditionId: string, tokenId: string): Promise<Resolution> }
export type Resolution = { state: "resolved"; won: boolean; finalPrice: 0 | 1; source: string } | { state: "open" } | { state: "unknown"; reason: string; raw?: unknown };

/** Pure: which horizons are due for this position and not yet marked. */
export function dueHorizons(p: OpenPaper, existing: Set<string>, now: number) {
  const ts = Math.floor(Date.parse(p.signal_ts) / 1000);
  return HORIZONS.filter((h) => ts + h.seconds <= now && !existing.has(h.key)).map((h) => ({ ...h, at: ts + h.seconds }));
}

/** Pure: interpret a Gamma market row for a specific token. */
export function parseGammaResolution(market: Record<string, unknown> | null | undefined, tokenId: string): Resolution {
  if (!market) return { state: "unknown", reason: "market_not_found" };
  const closed = market.closed === true || market.closed === "true";
  const status = String(market.umaResolutionStatus ?? market.resolutionStatus ?? "");
  const parseArr = (v: unknown): string[] | null => { if (Array.isArray(v)) return v.map(String); if (typeof v === "string") { try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(String) : null; } catch { return null; } } return null; };
  const tokens = parseArr(market.clobTokenIds); const prices = parseArr(market.outcomePrices)?.map(Number);
  if (!closed && status !== "resolved") return { state: "open" };
  if (!tokens || !prices || tokens.length !== prices.length) return { state: "unknown", reason: "resolution_unparseable", raw: { closed, status, clobTokenIds: market.clobTokenIds, outcomePrices: market.outcomePrices } };
  const idx = tokens.indexOf(tokenId);
  if (idx < 0) return { state: "unknown", reason: "token_not_in_market", raw: { tokenId, tokens } };
  const p = prices[idx];
  if (p === 1 || p === 0) return { state: "resolved", won: p === 1, finalPrice: p as 0 | 1, source: "gamma" };
  if (closed && prices.every((x) => x === 0.5)) return { state: "unknown", reason: "resolved_50_50_or_void", raw: { prices } };
  return { state: "unknown", reason: "closed_but_prices_not_final", raw: { prices } };
}

export function gammaSource(client = new PolymarketClient()): MarkSource {
  return {
    priceAsOf: (t, asOf) => client.priceAsOf(t, asOf),
    async resolution(conditionId, tokenId) {
      let viaGamma: Resolution;
      try {
        const b = await client.get<{ markets?: Record<string, unknown>[] }>(GAMMA_API, "/markets/keyset", { condition_ids: conditionId, limit: 5 });
        const m = (b.markets ?? []).find((x) => String(x.conditionId ?? x.condition_id ?? "").toLowerCase() === conditionId.toLowerCase()) ?? b.markets?.[0];
        viaGamma = parseGammaResolution(m, tokenId);
      } catch (e) { viaGamma = { state: "unknown", reason: `gamma_error: ${(e as Error).message}` }; }
      if (viaGamma.state === "resolved") return viaGamma;
      // Second source: a resolved market's price series ends with an on-chain settlement tick (resolution_seconds 0, price exactly 0 or 1).
      try {
        const pt = await client.priceAsOf(tokenId, Math.floor(Date.now() / 1000) + 86_400);
        if (pt && pt.resolutionSeconds === 0 && (pt.price === 0 || pt.price === 1)) return { state: "resolved", won: pt.price === 1, finalPrice: pt.price, source: "prices-history-settlement" };
      } catch { /* fall through */ }
      return viaGamma;
    },
  };
}

export interface MarkRunResult { positions: number; marks: number; settled: number; unresolved: number; failed: number }

export async function runMarking(db: SupabaseClient, src: MarkSource, opts: { now?: number; limit?: number; log?: (m: string) => void } = {}): Promise<MarkRunResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000); const log = opts.log ?? (() => {});
  const res: MarkRunResult = { positions: 0, marks: 0, settled: 0, unresolved: 0, failed: 0 };
  const { data: open } = await db.from("paper_ledger").select("signal_id,token_id,condition_id,entry_price,shares,signal_ts").eq("status", "OPEN").order("signal_ts", { ascending: true }).limit(opts.limit ?? 400);
  const rows = (open ?? []).map((r) => ({ ...r, entry_price: Number(r.entry_price), shares: Number(r.shares) })) as OpenPaper[];
  res.positions = rows.length; if (!rows.length) { await heartbeat(db, "last_mark"); return res; }
  const { data: marks } = await db.from("paper_marks").select("signal_id,horizon").in("signal_id", rows.map((r) => r.signal_id));
  const have = new Map<string, Set<string>>(); for (const m of marks ?? []) { if (!have.has(m.signal_id)) have.set(m.signal_id, new Set()); have.get(m.signal_id)!.add(m.horizon); }
  const issues: DqIssue[] = []; const resolutionCache = new Map<string, Resolution>();
  for (const p of rows) {
    // 1) horizon marks
    for (const h of dueHorizons(p, have.get(p.signal_id) ?? new Set(), now)) {
      try {
        const pt = await src.priceAsOf(p.token_id, h.at);
        if (pt == null) { issues.push({ kind: "mark_failed", ref_type: "paper", ref_id: `${p.signal_id}:${h.key}`, detail: { reason: "no_price_returned", at: h.at } }); res.failed++; continue; }
        const price = pt.price;
        if (!(price >= 0 && price <= 1)) { issues.push({ kind: "price_out_of_bounds", ref_type: "paper", ref_id: `${p.signal_id}:${h.key}`, detail: { price } }); res.failed++; continue; }
        // The observation must post-date the signal; an as_of read that falls back to a tick before entry is not a mark.
        const entryTs = Math.floor(Date.parse(p.signal_ts) / 1000);
        if (pt.ts < entryTs) { issues.push({ kind: "stale_market", ref_type: "paper", ref_id: `${p.signal_id}:${h.key}`, detail: { reason: "latest_observation_predates_signal", observed: pt.ts, signal: entryTs } }); res.failed++; continue; }
        const { error } = await db.from("paper_marks").upsert({ signal_id: p.signal_id, horizon: h.key, observed_at: new Date(pt.ts * 1000).toISOString(), price, pnl: pnlFor(p.shares, p.entry_price, price), return_pct: returnFor(p.entry_price, price), source: pt.resolutionSeconds >= 0 ? `prices-history:${pt.resolutionSeconds}s` : "prices-history" }, { onConflict: "signal_id,horizon", ignoreDuplicates: true });
        if (error) { issues.push({ kind: "mark_failed", ref_type: "paper", ref_id: `${p.signal_id}:${h.key}`, detail: { error: error.message } }); res.failed++; } else res.marks++;
      } catch (e) { issues.push({ kind: "mark_failed", ref_type: "paper", ref_id: `${p.signal_id}:${h.key}`, detail: { error: (e as Error).message } }); res.failed++; }
    }
    // 2) resolution (only once the position is at least an hour old — markets rarely resolve faster)
    const age = now - Math.floor(Date.parse(p.signal_ts) / 1000);
    if (age < RESOLUTION_MIN_AGE_SEC) continue;
    const key = `${p.condition_id}:${p.token_id}`;
    let r = resolutionCache.get(key); if (!r) { r = await src.resolution(p.condition_id, p.token_id); resolutionCache.set(key, r); }
    if (r.state === "resolved") {
      const pnl = pnlFor(p.shares, p.entry_price, r.finalPrice), ret = returnFor(p.entry_price, r.finalPrice);
      const { error } = await db.from("paper_ledger").update({ status: r.won ? "RESOLVED_WIN" : "RESOLVED_LOSS", final_price: r.finalPrice, final_pnl: pnl, final_return: ret, resolved: true, payout: r.finalPrice, pnl_per_100: pnl, settled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("signal_id", p.signal_id).eq("status", "OPEN");
      if (!error) { res.settled++; await db.from("paper_marks").upsert({ signal_id: p.signal_id, horizon: "resolution", observed_at: new Date(now * 1000).toISOString(), price: r.finalPrice, pnl, return_pct: ret, source: r.source }, { onConflict: "signal_id,horizon", ignoreDuplicates: true }); }
    } else if (r.state === "unknown") {
      res.unresolved++;
      if (r.reason !== "market_not_found" || age > 7 * 86400) issues.push({ kind: r.reason === "market_not_found" ? "missing_market" : (r.reason.startsWith("gamma_error") ? "missing_resolution" : "resolution_unparseable"), ref_type: "paper", ref_id: p.signal_id, detail: { reason: r.reason, raw: r.raw ?? null } });
      if (age > 30 * 86400) await db.from("paper_ledger").update({ status: "UNRESOLVED", status_reason: r.reason, updated_at: new Date().toISOString() }).eq("signal_id", p.signal_id).eq("status", "OPEN");
    }
  }
  await logIssues(db, issues);
  await heartbeat(db, "last_mark");
  log(`mark: ${res.positions} open, ${res.marks} marks, ${res.settled} settled, ${res.unresolved} unresolved, ${res.failed} failed`);
  return res;
}
