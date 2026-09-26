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
export interface MarkSource {
  priceAsOf(tokenId: string, asOf: number): Promise<PricePoint | null>;
  resolution(conditionId: string, tokenId: string): Promise<Resolution>;
  /** Optional: warm a batch of conditions in one request before per-position lookups. */
  prefetch?(conditionIds: string[]): Promise<void>;
}
/** finalPrice is the token's settlement value per share in [0,1] (usually 0 or 1; 0.5 for a 50/50 resolution).
 *  resolvedAt is the authoritative on-chain resolution time when the source provides it. */
export type Resolution = { state: "resolved"; won: boolean; finalPrice: number; source: string; resolvedAt?: number | null } | { state: "open" } | { state: "unknown"; reason: string; raw?: unknown };

/** Pure: interpret one /v2/resolutions row for a token, given the market's ordered token ids (outcome index order). */
export function parseV2Resolution(row: Record<string, unknown> | undefined, tokenId: string, tokenOrder: string[] | null, outcome?: string | null): Resolution {
  if (!row) return { state: "unknown", reason: "resolution_not_found" };
  const status = String(row.status ?? "").toLowerCase();
  if (status !== "resolved") return { state: "open" };
  const payouts = Array.isArray(row.payouts) ? (row.payouts as unknown[]).map(Number) : null;
  let idx = tokenOrder ? tokenOrder.indexOf(tokenId) : -1;
  if (idx < 0 && payouts?.length === 2 && outcome) { const o = outcome.trim().toLowerCase(); if (o === "yes") idx = 0; else if (o === "no") idx = 1; }
  if (!payouts || idx < 0 || idx >= payouts.length || !Number.isFinite(payouts[idx])) return { state: "unknown", reason: "resolution_token_index_unknown", raw: { payouts, tokenOrder } };
  const v = payouts[idx] / 1_000_000;
  if (!(v >= 0 && v <= 1)) return { state: "unknown", reason: "resolution_payout_out_of_range", raw: { payouts } };
  const at = typeof row.resolved_at === "string" ? Math.floor(Date.parse(row.resolved_at) / 1000) : null;
  return { state: "resolved", won: v >= 0.5, finalPrice: v, source: "v2-resolutions", resolvedAt: Number.isFinite(at as number) ? at : null };
}

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
  if (p === 1 || p === 0) return { state: "resolved", won: p === 1, finalPrice: p, source: "gamma" };
  if (closed && prices.every((x) => x === 0.5)) return { state: "unknown", reason: "resolved_50_50_or_void", raw: { prices } };
  return { state: "unknown", reason: "closed_but_prices_not_final", raw: { prices } };
}

/**
 * Resolution + price source. Resolution hierarchy (first answer wins):
 *   1. Data API /v2/resolutions — authoritative lifecycle + per-outcome payouts + resolved_at (batched, 20 conditions/call)
 *   2. Gamma market (closed + outcomePrices) — secondary
 *   3. prices-history settlement tick (resolution_seconds 0 at exactly 0 or 1) — last resort, never in the future
 * Token → outcome index comes from Gamma clobTokenIds (cached in `markets`), else a literal Yes/No label.
 */
export function gammaSource(client = new PolymarketClient(), db: SupabaseClient | null = null): MarkSource {
  const v2 = new Map<string, Record<string, unknown> | undefined>();
  const tokens = new Map<string, string[] | null>();
  const outcomes = new Map<string, string>();
  async function tokenOrder(conditionId: string): Promise<string[] | null> {
    const k = conditionId.toLowerCase(); if (tokens.has(k)) return tokens.get(k)!;
    let order: string[] | null = null;
    if (db) { const { data } = await db.from("markets").select("clob_token_ids").eq("condition_id", k).maybeSingle(); if (Array.isArray(data?.clob_token_ids) && data!.clob_token_ids.length) order = data!.clob_token_ids as string[]; }
    if (!order) {
      try {
        const b = await client.get<{ markets?: Record<string, unknown>[] }>(GAMMA_API, "/markets/keyset", { condition_ids: conditionId, limit: 5 });
        const m = (b.markets ?? []).find((x) => String(x.conditionId ?? x.condition_id ?? "").toLowerCase() === k);
        const raw = m?.clobTokenIds; const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
        order = Array.isArray(arr) ? arr.map(String) : null;
        if (order && db) await db.from("markets").upsert({ condition_id: k, clob_token_ids: order, fetched_at: new Date().toISOString() }, { onConflict: "condition_id" });
      } catch { order = null; }
    }
    tokens.set(k, order); return order;
  }
  return {
    priceAsOf: (t, asOf) => client.priceAsOf(t, Math.min(asOf, Math.floor(Date.now() / 1000))),
    async prefetch(conditionIds) {
      const todo = [...new Set(conditionIds.map((c) => c.toLowerCase()))].filter((c) => !v2.has(c));
      for (let i = 0; i < todo.length; i += 20) {
        const batch = todo.slice(i, i + 20);
        try { const rows = await client.resolutions(batch); for (const c of batch) v2.set(c, rows.find((r) => String(r.condition_id ?? "").toLowerCase() === c)); }
        catch { /* leave unset: per-condition path will retry via fallbacks */ }
      }
    },
    async resolution(conditionId, tokenId) {
      const k = conditionId.toLowerCase();
      if (!v2.has(k)) await this.prefetch!([k]);
      const row = v2.get(k);
      if (row) {
        const r = parseV2Resolution(row, tokenId, await tokenOrder(k), outcomes.get(tokenId));
        if (r.state !== "unknown") return r;
      }
      let viaGamma: Resolution;
      try {
        const b = await client.get<{ markets?: Record<string, unknown>[] }>(GAMMA_API, "/markets/keyset", { condition_ids: conditionId, limit: 5 });
        const m = (b.markets ?? []).find((x) => String(x.conditionId ?? x.condition_id ?? "").toLowerCase() === k) ?? b.markets?.[0];
        viaGamma = parseGammaResolution(m, tokenId);
      } catch (e) { viaGamma = { state: "unknown", reason: `gamma_error: ${(e as Error).message}` }; }
      if (viaGamma.state === "resolved") return viaGamma;
      if (row && String(row.status ?? "").toLowerCase() === "resolved") {
        try {
          const pt = await client.priceAsOf(tokenId, Math.floor(Date.now() / 1000) - 60);
          if (pt && pt.resolutionSeconds === 0 && (pt.price === 0 || pt.price === 1)) return { state: "resolved", won: pt.price === 1, finalPrice: pt.price, source: "prices-history-settlement", resolvedAt: typeof row.resolved_at === "string" ? Math.floor(Date.parse(row.resolved_at) / 1000) : null };
        } catch { /* fall through */ }
        return { state: "unknown", reason: "resolved_but_token_value_unknown" };
      }
      return row ? { state: "open" } : viaGamma;
    },
    // expose so the marker can pass outcome labels for the Yes/No fallback
    ...( { _outcomes: outcomes } as object),
  } as MarkSource;
}

export interface MarkRunResult { positions: number; marks: number; settled: number; unresolved: number; failed: number; skipped?: boolean }

// Process-local guards so one worker never stacks runs or hammers the same dead lookup every cycle.
let running = false;
const resolutionMemo = new Map<string, { r: Resolution; at: number }>();   // unresolved/open answers are re-asked at most every 6h
const failedMarks = new Map<string, number>();                              // (signal:horizon) → last failed attempt (retry hourly)
/** Bounded memo: evict oldest insertions past `cap` so process memory never grows with history. */
export const MEMO_CAP = 20_000;
function capSet<K, V>(m: Map<K, V>, k: K, v: V) { m.delete(k); m.set(k, v); while (m.size > MEMO_CAP) { const first = m.keys().next().value as K; m.delete(first); } }
export function _memoSizes() { return { resolutionMemo: resolutionMemo.size, failedMarks: failedMarks.size }; }
const RESOLUTION_RECHECK_SEC = 6 * 3600, MARK_RETRY_SEC = 3600, MAX_ISSUES_PER_RUN = 25;
export function _resetMarkGuards() { running = false; resolutionMemo.clear(); failedMarks.clear(); }

export async function runMarking(db: SupabaseClient, src: MarkSource, opts: { now?: number; limit?: number; log?: (m: string) => void } = {}): Promise<MarkRunResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000); const log = opts.log ?? (() => {});
  const res: MarkRunResult = { positions: 0, marks: 0, settled: 0, unresolved: 0, failed: 0 };
  if (running) { log("mark: previous run still in progress, skipping"); return { ...res, skipped: true }; }
  running = true;
  try {
  // Round-robin: least-recently-checked first, so no position is starved by an older one that never resolves.
  const { data: open } = await db.from("paper_ledger").select("signal_id,token_id,condition_id,entry_price,shares,signal_ts,outcome").eq("status", "OPEN").order("mark_checked_at", { ascending: true, nullsFirst: true }).order("signal_ts", { ascending: true }).limit(opts.limit ?? 600);
  const rows = (open ?? []).map((r) => ({ ...r, entry_price: Number(r.entry_price), shares: Number(r.shares) })) as (OpenPaper & { outcome?: string | null })[];
  const outcomeMap = (src as unknown as { _outcomes?: Map<string, string> })._outcomes; if (outcomeMap) for (const r of rows) if (r.outcome) outcomeMap.set(r.token_id, r.outcome);
  if (src.prefetch) { const age = (r: OpenPaper) => now - Math.floor(Date.parse(r.signal_ts) / 1000); await src.prefetch([...new Set(rows.filter((r) => age(r) >= RESOLUTION_MIN_AGE_SEC).map((r) => r.condition_id))]); }
  res.positions = rows.length; if (!rows.length) { await heartbeat(db, "last_mark"); return res; }
  const { data: marks } = await db.from("paper_marks").select("signal_id,horizon").in("signal_id", rows.map((r) => r.signal_id));
  const have = new Map<string, Set<string>>(); for (const m of marks ?? []) { if (!have.has(m.signal_id)) have.set(m.signal_id, new Set()); have.get(m.signal_id)!.add(m.horizon); }
  const issues: DqIssue[] = []; const resolutionCache = new Map<string, Resolution>();
  for (const p of rows) {
    // 1) horizon marks
    for (const h of dueHorizons(p, have.get(p.signal_id) ?? new Set(), now)) {
      const fk = `${p.signal_id}:${h.key}`; const lastFail = failedMarks.get(fk);
      if (lastFail != null && now - lastFail < MARK_RETRY_SEC) continue;
      try {
        let pt = await src.priceAsOf(p.token_id, h.at);
        if (pt && pt.resolutionSeconds > 0 && pt.ts + pt.resolutionSeconds > h.at) pt = await src.priceAsOf(p.token_id, pt.ts - 1); // step back to a complete bucket
        if (pt && (pt.ts > h.at || (pt.resolutionSeconds > 0 && pt.ts + pt.resolutionSeconds > h.at))) pt = null;
        if (pt == null) { capSet(failedMarks, fk, now); issues.push({ kind: "mark_failed", ref_type: "paper", ref_id: fk, detail: { reason: "no_price_returned", at: h.at } }); res.failed++; continue; }
        const price = pt.price;
        if (!(price >= 0 && price <= 1)) { issues.push({ kind: "price_out_of_bounds", ref_type: "paper", ref_id: `${p.signal_id}:${h.key}`, detail: { price } }); res.failed++; continue; }
        // The observation must post-date the signal; an as_of read that falls back to a tick before entry is not a mark.
        const entryTs = Math.floor(Date.parse(p.signal_ts) / 1000);
        if (pt.ts < entryTs) { issues.push({ kind: "stale_market", ref_type: "paper", ref_id: `${p.signal_id}:${h.key}`, detail: { reason: "latest_observation_predates_signal", observed: pt.ts, signal: entryTs } }); res.failed++; continue; }
        const { error } = await db.from("paper_marks").upsert({ signal_id: p.signal_id, horizon: h.key, observed_at: new Date(pt.ts * 1000).toISOString(), price, pnl: pnlFor(p.shares, p.entry_price, price), return_pct: returnFor(p.entry_price, price), source: pt.resolutionSeconds >= 0 ? `prices-history:${pt.resolutionSeconds}s` : "prices-history" }, { onConflict: "signal_id,horizon", ignoreDuplicates: true });
        if (error) { issues.push({ kind: "mark_failed", ref_type: "paper", ref_id: `${p.signal_id}:${h.key}`, detail: { error: error.message } }); res.failed++; } else res.marks++;
      } catch (e) { capSet(failedMarks, fk, now); issues.push({ kind: "mark_failed", ref_type: "paper", ref_id: fk, detail: { error: (e as Error).message } }); res.failed++; }
    }
    // 2) resolution (only once the position is at least an hour old — markets rarely resolve faster)
    const age = now - Math.floor(Date.parse(p.signal_ts) / 1000);
    if (age < RESOLUTION_MIN_AGE_SEC) continue;
    const key = `${p.condition_id}:${p.token_id}`;
    let r = resolutionCache.get(key);
    if (!r) {
      const memo = resolutionMemo.get(key);
      if (memo && memo.r.state !== "resolved" && now - memo.at < RESOLUTION_RECHECK_SEC) r = memo.r;
      else { r = await src.resolution(p.condition_id, p.token_id); capSet(resolutionMemo, key, { r, at: now }); }
      resolutionCache.set(key, r);
    }
    if (r.state === "resolved") {
      const pnl = pnlFor(p.shares, p.entry_price, r.finalPrice), ret = returnFor(p.entry_price, r.finalPrice);
      const resolvedIso = new Date(((r.resolvedAt ?? null) ?? now) * 1000).toISOString();
      const { error } = await db.from("paper_ledger").update({ status: pnl > 0 ? "RESOLVED_WIN" : "RESOLVED_LOSS", final_price: r.finalPrice, final_pnl: pnl, final_return: ret, resolved: true, payout: r.finalPrice, pnl_per_100: pnl, resolved_at: r.resolvedAt ? resolvedIso : null, settled_at: new Date(now * 1000).toISOString(), updated_at: new Date(now * 1000).toISOString() }).eq("signal_id", p.signal_id).eq("status", "OPEN");
      if (!error) { res.settled++; await db.from("paper_marks").upsert({ signal_id: p.signal_id, horizon: "resolution", observed_at: resolvedIso, price: r.finalPrice, pnl, return_pct: ret, source: r.source }, { onConflict: "signal_id,horizon", ignoreDuplicates: true }); }
    } else if (r.state === "unknown") {
      res.unresolved++;
      if (r.reason !== "market_not_found" || age > 7 * 86400) issues.push({ kind: r.reason === "market_not_found" ? "missing_market" : (r.reason.startsWith("gamma_error") ? "missing_resolution" : "resolution_unparseable"), ref_type: "paper", ref_id: p.signal_id, detail: { reason: r.reason, raw: r.raw ?? null } });
      if (age > 30 * 86400) await db.from("paper_ledger").update({ status: "UNRESOLVED", status_reason: r.reason, updated_at: new Date().toISOString() }).eq("signal_id", p.signal_id).eq("status", "OPEN");
    }
  }
  // Stamp every visited position so the next run moves on to the least-recently-checked ones.
  const ids = rows.map((r) => r.signal_id); const stamp = new Date(now * 1000).toISOString();
  for (let i = 0; i < ids.length; i += 200) await db.from("paper_ledger").update({ mark_checked_at: stamp }).in("signal_id", ids.slice(i, i + 200));
  const head = issues.slice(0, MAX_ISSUES_PER_RUN);
  if (issues.length > MAX_ISSUES_PER_RUN) head.push({ kind: "mark_failed", ref_type: "worker", ref_id: `run:${now}`, detail: { summary: true, total_issues: issues.length, by_kind: issues.reduce<Record<string, number>>((a, i) => { a[i.kind] = (a[i.kind] ?? 0) + 1; return a; }, {}) } });
  await logIssues(db, head);
  await heartbeat(db, "last_mark");
  log(`mark: ${res.positions} open, ${res.marks} marks, ${res.settled} settled, ${res.unresolved} unresolved, ${res.failed} failed`);
  return res;
  } finally { running = false; }
}
