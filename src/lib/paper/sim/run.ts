/**
 * Orchestration (I/O). Loads recorded history, fetches point-in-time prices into a cache, runs the pure simulator for
 * IDEAL / REALISTIC / CONSERVATIVE, persists per-signal execution records and an aggregate report.
 *
 * Look-ahead discipline: the only price used for a decision at time t is the cached answer to "last trade at or before
 * t" (price_observations, keyed by token + as_of). Resolution and marks are joined only AFTER the position exists.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PolymarketClient } from "../../polymarket/client";
import { MODES, configHash, portfolioConfigFromEnv, type ExecConfig, type ModeName } from "./config";
import { lifecycle, simulateEntry, timeline, type EntryInput, type ExitInput, type MarketCfg, type PriceObs } from "./execute";
import { byKindReport, execReport, type SimRow } from "./report";
import { simulatePortfolio, type PortfolioSignal } from "./portfolio";

/** paper_ledger rows created in this batch were back-filled from V1 signals: their created_at is NOT an evaluation time. */
export const BACKFILL_INSTANT = { from: Date.parse("2026-09-18T15:16:00Z"), to: Date.parse("2026-09-18T15:17:00Z") };
const sec = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);
const ENTRY_KINDS = new Set(["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"]);

export interface PriceSource { priceAsOf(tokenId: string, asOf: number): Promise<{ ts: number; price: number; resolutionSeconds: number } | null> }

/** Fetch "last trade at or before t", never returning a bucket that extends past t. */
export async function observeAt(src: PriceSource, tokenId: string, t: number): Promise<PriceObs | null> {
  let pt = await src.priceAsOf(tokenId, t);
  if (pt && pt.resolutionSeconds > 0 && pt.ts + pt.resolutionSeconds > t) pt = pt.ts - 1 > 0 ? await src.priceAsOf(tokenId, pt.ts - 1) : null; // step back to the previous complete bucket
  if (!pt || pt.ts > t || (pt.resolutionSeconds > 0 && pt.ts + pt.resolutionSeconds > t)) return null;
  return { ts: pt.ts, price: pt.price, resolutionSeconds: pt.resolutionSeconds };
}

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null }>, page = 1000): Promise<T[]> {
  const out: T[] = []; for (let i = 0; ; i += page) { const { data } = await q(i, i + page - 1); const rows = data ?? []; out.push(...rows); if (rows.length < page) return out; }
}

export interface SimInputs { signals: Record<string, any>[]; ledger: Map<string, Record<string, any>>; marks: Map<string, { ts: number; price: number }>; resolutions: Map<string, { ts: number; value: number }>; markets: Map<string, MarketCfg>; obs: Map<string, PriceObs | null> }

export async function loadInputs(db: SupabaseClient): Promise<SimInputs> {
  const signals = await pageAll<Record<string, any>>((a, b) => db.from("signals").select("id,kind,severity,wallet,condition_id,token_id,outcome,price,usd,payload,created_at,received_at,evaluated_at").order("created_at", { ascending: true }).order("id", { ascending: true }).range(a, b));
  const ledgerRows = await pageAll<Record<string, any>>((a, b) => db.from("paper_ledger").select("signal_id,created_at,status,final_price,resolved_at,token_id").order("signal_id").range(a, b));
  const markRows = await pageAll<Record<string, any>>((a, b) => db.from("paper_marks").select("signal_id,horizon,observed_at,price").order("signal_id").range(a, b));
  const marketRows = await pageAll<Record<string, any>>((a, b) => db.from("markets").select("condition_id,fees_enabled,taker_fee_rate,tick_size,min_order_shares").order("condition_id").range(a, b));
  const obsRows = await pageAll<Record<string, any>>((a, b) => db.from("price_observations").select("token_id,as_of,obs_ts,price,resolution_seconds").order("token_id").order("as_of").range(a, b));
  const ledger = new Map(ledgerRows.map((r) => [r.signal_id, r]));
  const marks = new Map<string, { ts: number; price: number }>(); const resolutions = new Map<string, { ts: number; value: number }>();
  const ledgerToken = new Map(ledgerRows.map((r) => [r.signal_id, r.token_id as string]));
  for (const m of markRows) {
    const ts = sec(m.observed_at)!; const token = ledgerToken.get(m.signal_id);
    if (m.horizon === "resolution") { if (token) { const r = ledger.get(m.signal_id); const rts = sec(r?.resolved_at) ?? ts; const prev = resolutions.get(token); if (!prev || rts < prev.ts) resolutions.set(token, { ts: rts, value: Number(m.price) }); } continue; }
    if (m.horizon === "exit") continue; // an exit fill is not a market mark
    const prev = marks.get(m.signal_id); if (!prev || ts > prev.ts) marks.set(m.signal_id, { ts, price: Number(m.price) });
  }
  const markets = new Map(marketRows.map((r) => [String(r.condition_id).toLowerCase(), { feesEnabled: r.fees_enabled ?? null, takerFeeRate: r.taker_fee_rate == null ? null : Number(r.taker_fee_rate), tickSize: r.tick_size == null ? null : Number(r.tick_size), minOrderShares: r.min_order_shares == null ? null : Number(r.min_order_shares) }]));
  const obs = new Map(obsRows.map((r) => [`${r.token_id}@${r.as_of}`, r.price == null ? null : { ts: Number(r.obs_ts), price: Number(r.price), resolutionSeconds: Number(r.resolution_seconds) }]));
  return { signals, ledger, marks, resolutions, markets, obs };
}

/** Observed evaluation time: signals.evaluated_at, else paper_ledger.created_at for live (non-backfilled) signals. */
export function evalTsOf(s: Record<string, any>, ledgerRow: Record<string, any> | undefined): number | null {
  const e = sec(s.evaluated_at); if (e != null) return e;
  const c = ledgerRow?.created_at ? Date.parse(ledgerRow.created_at) : NaN;
  if (!Number.isFinite(c) || (c >= BACKFILL_INSTANT.from && c < BACKFILL_INSTANT.to)) return null;
  return Math.floor(c / 1000);
}

export interface BuiltSignal { id: string; kind: string; wallet: string; conditionId: string; tokenId: string; sourceKey: string; entry: EntryInput; exitSignal: Record<string, any> | null; resolution: { ts: number; value: number } | null; mark: { ts: number; price: number } | null }
export function buildSignals(inp: SimInputs): BuiltSignal[] {
  const exitsByKey = new Map<string, Record<string, any>[]>();
  for (const s of inp.signals) if (s.kind === "EXIT") { const k = `${s.wallet}|${s.token_id}`; (exitsByKey.get(k) ?? exitsByKey.set(k, []).get(k)!).push(s); }
  const out: BuiltSignal[] = [];
  for (const s of inp.signals) {
    if (!ENTRY_KINDS.has(s.kind)) continue;
    const sourceTs = sec(s.created_at)!; const cond = String(s.condition_id ?? "").toLowerCase();
    const exits = (exitsByKey.get(`${s.wallet}|${s.token_id}`) ?? []).filter((x) => sec(x.created_at)! > sourceTs).sort((a, b) => sec(a.created_at)! - sec(b.created_at)! || String(a.id).localeCompare(String(b.id)));
    out.push({ id: s.id, kind: s.kind, wallet: s.wallet, conditionId: cond, tokenId: s.token_id, sourceKey: `${s.wallet}|${s.token_id}|${sourceTs}|${Number(s.price)}`,
      entry: { sourceTs, evalTs: evalTsOf(s, inp.ledger.get(s.id)), signalPrice: Number(s.price), sourceUsd: Number(s.usd), obs: null, market: inp.markets.get(cond) ?? null },
      exitSignal: exits[0] ?? null, resolution: inp.resolutions.get(s.token_id) ?? null, mark: inp.marks.get(s.id) ?? null });
  }
  return out;
}

export function exitInputFor(x: Record<string, any>, inp: SimInputs, market: MarketCfg | null): ExitInput {
  return { triggerTs: sec(x.created_at)!, triggerEvalTs: evalTsOf(x, inp.ledger.get(x.id)), triggerPrice: Number(x.price), triggerUsd: Number(x.usd), obs: null, market };
}

/** Every (token, as_of) the non-IDEAL modes need. */
export function neededObservations(built: BuiltSignal[], inp: SimInputs, modes: ExecConfig[]): { tokenId: string; asOf: number }[] {
  const need = new Map<string, { tokenId: string; asOf: number }>();
  for (const cfg of modes) { if (cfg.fillAtSignalPrice) continue; for (const b of built) {
    const t = timeline(b.entry.sourceTs, b.entry.evalTs, cfg).fillTs; need.set(`${b.tokenId}@${t}`, { tokenId: b.tokenId, asOf: t });
    if (b.exitSignal) { const x = exitInputFor(b.exitSignal, inp, null); const xt = timeline(x.triggerTs, x.triggerEvalTs, cfg).fillTs; need.set(`${b.tokenId}@${xt}`, { tokenId: b.tokenId, asOf: xt }); }
  } }
  return [...need.values()].filter((n) => !inp.obs.has(`${n.tokenId}@${n.asOf}`)).sort((a, b) => a.asOf - b.asOf || a.tokenId.localeCompare(b.tokenId));
}

export interface ModeOutput { mode: ModeName; configHash: string; rows: SimRow[]; pending: number; records: Record<string, unknown>[] }
/** Pure given inputs: simulate one mode for every signal whose observations are present. */
export function simulateMode(built: BuiltSignal[], inp: SimInputs, cfg: ExecConfig): ModeOutput {
  const rows: SimRow[] = []; const records: Record<string, unknown>[] = []; let pending = 0; const hash = configHash(cfg);
  for (const b of built) {
    const fillTs = timeline(b.entry.sourceTs, b.entry.evalTs, cfg).fillTs; const k = `${b.tokenId}@${fillTs}`;
    if (!cfg.fillAtSignalPrice && !inp.obs.has(k)) { pending++; continue; }
    const entry = simulateEntry({ ...b.entry, obs: cfg.fillAtSignalPrice ? null : inp.obs.get(k) ?? null }, cfg);
    let exit: { input: ExitInput } | null = null;
    if (b.exitSignal) { const x = exitInputFor(b.exitSignal, inp, b.entry.market); const xt = timeline(x.triggerTs, x.triggerEvalTs, cfg).fillTs; const xk = `${b.tokenId}@${xt}`;
      if (!cfg.fillAtSignalPrice && !inp.obs.has(xk)) { pending++; continue; } exit = { input: { ...x, obs: cfg.fillAtSignalPrice ? null : inp.obs.get(xk) ?? null } }; }
    const life = lifecycle(entry, exit, b.resolution, b.mark, cfg);
    rows.push({ signalId: b.id, kind: b.kind, closedAt: life.closedAt, life });
    const e = life.entry, x = life.exit;
    records.push({ signal_id: b.id, mode: cfg.mode, kind: b.kind, config_hash: hash,
      source_trade_ts: iso(e.timing.sourceTs), evaluated_ts: iso(e.timing.evalTs), latency_source: e.timing.latencySource, submit_ts: iso(e.timing.submitTs), fill_ts: iso(e.timing.fillTs),
      signal_price: b.entry.signalPrice, market_price: e.marketPrice, market_obs_ts: iso(e.marketObsTs), fill_price: e.fillPrice, tick: e.tick, slippage_ticks: e.slippageTicks,
      status: e.status, reason: e.reason, requested_usd: e.requestedUsd, filled_usd: e.filledUsd, filled_shares: e.filledShares, fill_pct: e.fillPct,
      entry_fee: e.fee, fee_rate: e.feeRate, fee_source: e.feeSource, latency_cost: e.latencyCost, entry_slippage_cost: e.slippageCost,
      exit_trigger_ts: x ? iso(x.timing.sourceTs) : null, exit_decision_ts: x ? iso(x.timing.evalTs) : null, exit_fill_ts: x ? iso(x.timing.fillTs) : null, exit_market_price: x?.marketPrice ?? null, exit_fill_price: x?.fillPrice ?? null,
      exit_slippage_ticks: x?.slippageTicks ?? null, exit_status: x?.status ?? null, exit_reason: x?.reason ?? null, exit_sold_shares: x?.soldShares ?? null, exit_fee: x?.fee ?? null, exit_slippage_cost: x?.slippageCost ?? null,
      resolution_ts: life.resolution ? iso(life.resolution.ts) : null, resolution_value: life.resolution?.value ?? null, resolution_shares: life.resolution?.shares ?? null,
      mark_ts: life.mark ? iso(life.mark.ts) : null, mark_price: life.mark?.price ?? null, open_shares: life.openShares, state: life.state,
      gross_pnl: life.grossPnl, fees_total: life.fees, net_pnl: life.netPnl, realized_pnl: life.realizedPnl, unrealized_pnl: life.unrealizedPnl, closed_at: iso(life.closedAt) });
  }
  return { mode: cfg.mode, configHash: hash, rows, pending, records };
}
const iso = (s: number | null | undefined) => (s == null ? null : new Date(s * 1000).toISOString());

export async function runSimulation(db: SupabaseClient, opts: { client?: PriceSource; fetchBudget?: number; log?: (m: string) => void; persistRecords?: boolean } = {}) {
  const log = opts.log ?? (() => {}); const client = opts.client ?? new PolymarketClient();
  const inp = await loadInputs(db); const built = buildSignals(inp); const modes = [MODES.IDEAL, MODES.REALISTIC, MODES.CONSERVATIVE];
  // 1) fetch missing observations (bounded per run; cached forever — a past "as of" answer never changes)
  const need = neededObservations(built, inp, modes).slice(0, opts.fetchBudget ?? 1500); let fetched = 0;
  for (const n of need) {
    let o: PriceObs | null = null; try { o = await observeAt(client, n.tokenId, n.asOf); } catch { continue; } // transient: retry next run
    inp.obs.set(`${n.tokenId}@${n.asOf}`, o); fetched++;
    await db.from("price_observations").upsert({ token_id: n.tokenId, as_of: n.asOf, obs_ts: o?.ts ?? null, price: o?.price ?? null, resolution_seconds: o?.resolutionSeconds ?? null, fetched_at: new Date().toISOString() }, { onConflict: "token_id,as_of", ignoreDuplicates: true });
  }
  // 2) simulate each mode (pure), 3) persist
  const outputs = modes.map((m) => simulateMode(built, inp, m));
  if (opts.persistRecords !== false) for (const o of outputs) for (let i = 0; i < o.records.length; i += 500) await db.from("paper_executions").upsert(o.records.slice(i, i + 500).map((r) => ({ ...r, computed_at: new Date().toISOString() })), { onConflict: "signal_id,mode" });
  const report = Object.fromEntries(outputs.map((o) => [o.mode, { configHash: o.configHash, pending: o.pending, overall: execReport(o.rows), byKind: byKindReport(o.rows) }]));
  // 4) portfolio — only when the operator has configured limits
  const pc = portfolioConfigFromEnv(); let portfolio: Record<string, unknown> | null = null;
  if (pc) {
    portfolio = {};
    for (const cfg of modes) {
      const ps: PortfolioSignal[] = built.filter((b) => cfg.fillAtSignalPrice || inp.obs.has(`${b.tokenId}@${timeline(b.entry.sourceTs, b.entry.evalTs, cfg).fillTs}`)).map((b) => {
        const fk = `${b.tokenId}@${timeline(b.entry.sourceTs, b.entry.evalTs, cfg).fillTs}`; const x = b.exitSignal ? exitInputFor(b.exitSignal, inp, b.entry.market) : null;
        const xk = x ? `${b.tokenId}@${timeline(x.triggerTs, x.triggerEvalTs, cfg).fillTs}` : null;
        return { signalId: b.id, kind: b.kind, wallet: b.wallet, conditionId: b.conditionId, tokenId: b.tokenId, sourceKey: b.sourceKey, entry: { ...b.entry, obs: cfg.fillAtSignalPrice ? null : inp.obs.get(fk) ?? null }, exit: x ? { ...x, obs: cfg.fillAtSignalPrice || !xk ? null : inp.obs.get(xk) ?? null } : null, resolution: b.resolution, mark: b.mark };
      });
      const r = simulatePortfolio(ps, cfg, pc); const counts: Record<string, number> = {}; for (const d of r.decisions) { const k = d.outcome === "REJECTED" ? d.reason! : d.outcome; counts[k] = (counts[k] ?? 0) + 1; }
      const { decisions: _d, curve, ...summary } = r; void _d;
      (portfolio as Record<string, unknown>)[cfg.mode] = { ...summary, decisions: counts, curvePoints: curve.length };
      await db.from("paper_portfolio_runs").upsert({ mode: cfg.mode, exec_config_hash: configHash(cfg), portfolio_config: pc, summary: { ...summary, decisions: counts }, decisions: r.decisions, computed_at: new Date().toISOString() }, { onConflict: "mode" });
    }
  }
  const snapshot = { builtAt: new Date().toISOString(), observationsFetched: fetched, observationsPending: neededObservations(built, inp, modes).length, modes: report, portfolio, portfolioConfigured: !!pc };
  await db.from("cursors").upsert({ key: "paper:execution", value: JSON.stringify(snapshot), updated_at: new Date().toISOString() });
  log(`sim: ${built.length} entry signals, fetched ${fetched} observations, pending ${snapshot.observationsPending}`);
  return snapshot;
}
