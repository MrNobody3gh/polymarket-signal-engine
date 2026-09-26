/**
 * Orphan resolver (Phase 3 step 3, decision D3; docs/PHASE3_PLAN.md).
 *
 * The marker only settles paper_ledger rows that are OPEN. Once every ledger row on a token is EXITED or INVALID, no
 * process asks whether that market resolved, yet a simulated position can still hold shares on it (the wallet's EXIT
 * came before our simulated fill, the exit was partly filled or had no usable price) and, from Phase 3, so can a
 * portfolio lot. This job asks, using the marker's own resolution source (gammaSource: /v2/resolutions, then Gamma,
 * then the price-history settlement tick), and records the answer in token_resolution_obs. The token_resolutions view
 * already unions that table in (migration 0008), so the next simulation sweep settles those positions with no change
 * to the sweep or the marker.
 *
 * Token order comes from the `markets` cache; the worker fills it first with ensureTokenOrder (polymarket/token-order.ts),
 * which also finds markets that are already closed.
 *
 * Rules (never fabricate):
 *  - A resolution is written only with its on-chain resolved_at (D2 releases capital at that instant). A source that
 *    says "resolved" without a time is recorded as NO_RESOLVED_TIME and re-asked later.
 *  - The first observation for a token is kept (ignoreDuplicates). A later disagreement shows up in the
 *    token_resolution_conflicts view instead of silently replacing it.
 *  - Every candidate asked gets a token_resolution_checks row, so the next run moves on to the least recently asked.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logIssues, type DqIssue } from "./ledger";
import type { MarkSource, Resolution } from "./mark";
import { selectIn } from "../chunk";

export interface OrphanCandidate { token_id: string; condition_id: string; outcome: string | null; open_lots: number; frozen_lots: number; oldest_fill_ts: string | null; last_checked_at: string | null }
export type OrphanCheckState = "OPEN" | "UNKNOWN" | "NO_RESOLVED_TIME" | "RESOLVED";
export interface OrphanObsRow { token_id: string; condition_id: string; value: number; resolved_ts: string; source: string }
export interface OrphanCheckRow { token_id: string; condition_id: string; last_checked_at: string; last_state: OrphanCheckState; last_reason: string | null }

/** Pure: what one resolution answer means for one candidate token. */
export function orphanOutcome(c: Pick<OrphanCandidate, "token_id" | "condition_id">, r: Resolution, nowSec: number): { state: OrphanCheckState; reason: string | null; obs: OrphanObsRow | null } {
  if (r.state === "open") return { state: "OPEN", reason: null, obs: null };
  if (r.state === "unknown") return { state: "UNKNOWN", reason: r.reason, obs: null };
  if (!(Number.isFinite(r.finalPrice) && r.finalPrice >= 0 && r.finalPrice <= 1)) return { state: "UNKNOWN", reason: "resolution_value_out_of_range", obs: null };
  const at = r.resolvedAt;
  if (at == null || !Number.isFinite(at) || at <= 0) return { state: "NO_RESOLVED_TIME", reason: `resolved via ${r.source} without an on-chain resolution time`, obs: null };
  if (at > nowSec + 60) return { state: "UNKNOWN", reason: "resolved_at_in_future", obs: null };
  return { state: "RESOLVED", reason: null, obs: { token_id: c.token_id, condition_id: c.condition_id.toLowerCase(), value: r.finalPrice, resolved_ts: new Date(at * 1000).toISOString(), source: r.source } };
}

export interface OrphanRunResult { candidates: number; resolved: number; open: number; unknown: number; noTime: number; failed: number; frozenLots: number; skipped?: boolean }

let running = false;
export function _resetOrphanGuard() { running = false; }

/** One pass: ask about up to `limit` candidate tokens (least recently asked first) and record every answer. */
export async function resolveOrphans(db: SupabaseClient, src: MarkSource, opts: { limit?: number; recheckSec?: number; now?: number; log?: (m: string) => void; prepare?: (conditionIds: string[]) => Promise<unknown> } = {}): Promise<OrphanRunResult> {
  const res: OrphanRunResult = { candidates: 0, resolved: 0, open: 0, unknown: 0, noTime: 0, failed: 0, frozenLots: 0 };
  const log = opts.log ?? (() => {});
  if (running) { log("orphans: previous run still in progress, skipping"); return { ...res, skipped: true }; }
  running = true;
  try {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    const { data, error } = await db.rpc("orphan_resolution_candidates", { p_limit: opts.limit ?? 200, p_recheck_sec: opts.recheckSec ?? 6 * 3600 });
    if (error) throw new Error(`orphan_resolution_candidates failed: ${error.message}`);
    const cands = ((data ?? []) as OrphanCandidate[]).map((c) => ({ ...c, open_lots: Number(c.open_lots), frozen_lots: Number(c.frozen_lots) }));
    res.candidates = cands.length; res.frozenLots = cands.reduce((a, c) => a + c.frozen_lots, 0);
    if (!cands.length) return res;
    // Same hooks the marker uses: Yes/No labels for the token-index fallback, then one batched /v2/resolutions read.
    const labels = (src as unknown as { _outcomes?: Map<string, string> })._outcomes;
    if (labels) for (const c of cands) if (c.outcome) labels.set(c.token_id, c.outcome);
    const conditions = [...new Set(cands.map((c) => c.condition_id))];
    // Token order first (the worker passes ensureTokenOrder): without it a resolved market whose outcome is not literally
    // Yes/No cannot be mapped to its payout. A failure here only degrades answers to UNKNOWN; it never aborts the run.
    if (opts.prepare) { try { await opts.prepare(conditions); } catch (e) { log(`orphans: token-order lookup failed: ${(e as Error).message}`); } }
    if (src.prefetch) await src.prefetch(conditions);
    const obs: OrphanObsRow[] = []; const checks: OrphanCheckRow[] = []; const issues: DqIssue[] = []; const stamp = new Date(now * 1000).toISOString();
    for (const c of cands) {
      let o: ReturnType<typeof orphanOutcome>;
      try { o = orphanOutcome(c, await src.resolution(c.condition_id, c.token_id), now); }
      catch (e) { o = { state: "UNKNOWN", reason: `lookup_failed: ${(e as Error).message.slice(0, 160)}`, obs: null }; res.failed++; }
      if (o.obs) obs.push(o.obs);
      if (o.state === "RESOLVED") res.resolved++; else if (o.state === "OPEN") res.open++; else if (o.state === "NO_RESOLVED_TIME") res.noTime++; else res.unknown++;
      if (o.state === "NO_RESOLVED_TIME" || (o.state === "UNKNOWN" && !o.reason?.startsWith("lookup_failed"))) issues.push({ kind: o.state === "NO_RESOLVED_TIME" ? "missing_resolution" : "resolution_unparseable", ref_type: "token", ref_id: c.token_id, detail: { reason: o.reason, condition_id: c.condition_id, open_lots: c.open_lots } });
      checks.push({ token_id: c.token_id, condition_id: c.condition_id.toLowerCase(), last_checked_at: stamp, last_state: o.state, last_reason: o.reason });
    }
    // Observations first: a crash between the two writes leaves a token re-asked, never a check without its answer.
    for (let i = 0; i < obs.length; i += 100) { const { error: e } = await db.from("token_resolution_obs").upsert(obs.slice(i, i + 100), { onConflict: "token_id", ignoreDuplicates: true }); if (e) throw new Error(`token_resolution_obs write failed: ${e.message}`); }
    const prev = new Map(cands.map((c) => [c.token_id, c.last_checked_at]));
    const counts = await selectIn<{ token_id: string; checks: number }>(checks.map((c) => c.token_id).filter((t) => prev.get(t) != null), (ch) => db.from("token_resolution_checks").select("token_id,checks").in("token_id", ch as string[]));
    const n = new Map(counts.map((r) => [r.token_id, Number(r.checks)]));
    for (let i = 0; i < checks.length; i += 100) { const { error: e } = await db.from("token_resolution_checks").upsert(checks.slice(i, i + 100).map((c) => ({ ...c, checks: (n.get(c.token_id) ?? 0) + 1 })), { onConflict: "token_id" }); if (e) throw new Error(`token_resolution_checks write failed: ${e.message}`); }
    await logIssues(db, issues.slice(0, 25));
    log(`orphans: ${res.candidates} tokens asked (${res.frozenLots} frozen positions among them) · ${res.resolved} resolved · ${res.open} still open · ${res.noTime} resolved without a time · ${res.unknown} unknown`);
    return res;
  } finally { running = false; }
}
