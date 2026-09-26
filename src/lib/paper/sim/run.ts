/**
 * Orchestration (I/O), bounded memory.
 *
 * Memory model: nothing proportional to total history is ever held. The worker
 *   1. drains the price backlog in claimed chunks (database-side queue with explicit states),
 *   2. sweeps non-terminal ledger rows in keyset batches of SIM_BATCH_SIZE, loading only that batch's inputs,
 *      simulating it, writing only changed records, and marking signals whose outcome can no longer change,
 *   3. asks Postgres for the aggregate reports (percentiles, drawdown, robustness are computed in SQL).
 * Peak memory therefore scales with the batch size, not with the size of the database.
 *
 * Look-ahead discipline is unchanged: the only price used for a decision at time t is the cached answer to
 * "last trade at or before t" from a complete bucket; resolutions and marks are applied only after a position exists.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PolymarketClient } from "../../polymarket/client";
import { MODES, configHash, type ExecConfig, type ModeName } from "./config";
import { lifecycle, simulateEntry, timeline, type EntryInput, type ExitInput, type MarketCfg, type PriceObs } from "./execute";
import type { SimRow } from "./report";

/** 500: large enough that per-batch round trips (≈8 queries) are amortised, small enough that a batch's inputs
 *  (≤500 signals, their exits/marks/markets/observations) stay well under ~10 MB. */
export const SIM_BATCH_SIZE = 500;
export const BACKFILL_INSTANT = { from: Date.parse("2026-09-18T15:16:00Z"), to: Date.parse("2026-09-18T15:17:00Z") };
const sec = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);
const iso = (s: number | null | undefined) => (s == null ? null : new Date(s * 1000).toISOString());
export const MAX_FETCH_ATTEMPTS = 6;

export interface PriceSource { priceAsOf(tokenId: string, asOf: number): Promise<{ ts: number; price: number; resolutionSeconds: number } | null> }

/** Fetch "last trade at or before t", never returning a bucket that extends past t. */
export async function observeAt(src: PriceSource, tokenId: string, t: number): Promise<PriceObs | null> {
  let pt = await src.priceAsOf(tokenId, t);
  if (pt && pt.resolutionSeconds > 0 && pt.ts + pt.resolutionSeconds > t) pt = pt.ts - 1 > 0 ? await src.priceAsOf(tokenId, pt.ts - 1) : null;
  if (!pt || pt.ts > t || (pt.resolutionSeconds > 0 && pt.ts + pt.resolutionSeconds > t)) return null;
  return { ts: pt.ts, price: pt.price, resolutionSeconds: pt.resolutionSeconds };
}

// ───────────────────────────── price backlog ─────────────────────────────
export interface BacklogItem { token_id: string; as_of: number; attempts: number }
export interface BacklogQueue {
  claim(n: number): Promise<BacklogItem[]>;
  complete(item: BacklogItem, obs: PriceObs | null): Promise<void>;   // null → UNAVAILABLE (nothing traded at or before as_of)
  fail(item: BacklogItem, error: string): Promise<void>;
}
export function supabaseBacklog(db: SupabaseClient, now = () => Date.now()): BacklogQueue {
  return {
    async claim(n) { const { data, error } = await db.rpc("claim_price_backlog", { p_limit: n }); if (error) throw error; return (data ?? []).map((r: any) => ({ token_id: r.token_id, as_of: Number(r.as_of), attempts: Number(r.attempts) })); },
    async complete(it, o) { await db.from("price_observations").update({ state: o ? "COMPLETE" : "UNAVAILABLE", obs_ts: o?.ts ?? null, price: o?.price ?? null, resolution_seconds: o?.resolutionSeconds ?? null, fetched_at: new Date(now()).toISOString(), processing_started_at: null, last_error: null, next_attempt_at: null }).eq("token_id", it.token_id).eq("as_of", it.as_of); },
    async fail(it, err) {
      const attempts = it.attempts + 1; const final = attempts >= MAX_FETCH_ATTEMPTS;
      await db.from("price_observations").update({ state: "FAILED", attempts, last_error: err.slice(0, 300), processing_started_at: null, next_attempt_at: final ? null : new Date(now() + Math.min(3600, 30 * 2 ** attempts) * 1000).toISOString() }).eq("token_id", it.token_id).eq("as_of", it.as_of);
    },
  };
}
/** Drain up to `budget` items: claimed in chunks, fetched with bounded concurrency, each result persisted immediately. */
export async function processBacklog(q: BacklogQueue, src: PriceSource, opts: { budget?: number; chunk?: number; concurrency?: number } = {}) {
  const budget = opts.budget ?? 3000, chunk = opts.chunk ?? 100, conc = opts.concurrency ?? 4;
  let done = 0, unavailable = 0, failed = 0;
  while (done + failed < budget) {
    const items = await q.claim(Math.min(chunk, budget - done - failed)); if (!items.length) break;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
      while (i < items.length) { const it = items[i++];
        try { const o = await observeAt(src, it.token_id, it.as_of); await q.complete(it, o); done++; if (!o) unavailable++; }
        catch (e) { await q.fail(it, (e as Error).message); failed++; } }
    }));
  }
  return { done, unavailable, failed };
}

// ───────────────────────────── batch inputs ─────────────────────────────
export interface SimInputs { signals: Record<string, any>[]; ledger: Map<string, Record<string, any>>; marks: Map<string, { ts: number; price: number }>; resolutions: Map<string, { ts: number; value: number }>; markets: Map<string, MarketCfg & { observedAt?: string | null }>; obs: Map<string, PriceObs | null> }

/** Observed evaluation time: signals.evaluated_at, else paper_ledger.created_at for live (non-backfilled) signals. */
export function evalTsOf(s: Record<string, any>, ledgerRow: Record<string, any> | undefined): number | null {
  const e = sec(s.evaluated_at); if (e != null) return e;
  const c = ledgerRow?.created_at ? Date.parse(ledgerRow.created_at) : NaN;
  if (!Number.isFinite(c) || (c >= BACKFILL_INSTANT.from && c < BACKFILL_INSTANT.to)) return null;
  return Math.floor(c / 1000);
}

const ENTRY_KINDS = new Set(["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"]);
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
/** (token, as_of) keys the non-IDEAL modes need for these signals. */
export function neededObservations(built: BuiltSignal[], inp: SimInputs, modes: ExecConfig[]): { tokenId: string; asOf: number }[] {
  const need = new Map<string, { tokenId: string; asOf: number }>();
  for (const cfg of modes) { if (cfg.fillAtSignalPrice) continue; for (const b of built) {
    const t = timeline(b.entry.sourceTs, b.entry.evalTs, cfg).fillTs; need.set(`${b.tokenId}@${t}`, { tokenId: b.tokenId, asOf: t });
    if (b.exitSignal) { const x = exitInputFor(b.exitSignal, inp, null); const xt = timeline(x.triggerTs, x.triggerEvalTs, cfg).fillTs; need.set(`${b.tokenId}@${xt}`, { tokenId: b.tokenId, asOf: xt }); }
  } }
  return [...need.values()].filter((n) => !inp.obs.has(`${n.tokenId}@${n.asOf}`)).sort((a, b) => a.asOf - b.asOf || a.tokenId.localeCompare(b.tokenId));
}

export type CoverageState = "SIMULATED" | "PENDING_DATA" | "UNAVAILABLE_DATA" | "INVALID" | "UNFILLED";
export function coverageOf(status: string): CoverageState {
  return status === "FILLED" || status === "PARTIALLY_FILLED" ? "SIMULATED" : status === "UNKNOWN" ? "UNAVAILABLE_DATA" : status === "INVALID" ? "INVALID" : status === "PENDING" ? "PENDING_DATA" : "UNFILLED";
}
/** A record can still change while data is pending or a simulated position is open. */
export function isTerminal(coverage: CoverageState, state: string): boolean { return coverage === "SIMULATED" ? state === "RESOLVED" || state === "EXITED" : coverage !== "PENDING_DATA"; }

export interface ModeOutput { mode: ModeName; configHash: string; rows: SimRow[]; pending: number; records: Record<string, unknown>[] }
/** Pure given inputs: every signal gets exactly one record — simulated, or explicitly PENDING_DATA. */
export function simulateMode(built: BuiltSignal[], inp: SimInputs, cfg: ExecConfig): ModeOutput {
  const rows: SimRow[] = []; const records: Record<string, unknown>[] = []; let pending = 0; const hash = configHash(cfg);
  for (const b of built) {
    const t = timeline(b.entry.sourceTs, b.entry.evalTs, cfg); const k = `${b.tokenId}@${t.fillTs}`;
    const market = inp.markets.get(b.conditionId);
    const base = { signal_id: b.id, mode: cfg.mode, kind: b.kind, config_hash: hash, source_trade_ts: iso(t.sourceTs), evaluated_ts: iso(t.evalTs), latency_source: t.latencySource, submit_ts: iso(t.submitTs), fill_ts: iso(t.fillTs), signal_price: b.entry.signalPrice, fee_observed_at: market?.observedAt ?? null };
    let exit: { input: ExitInput } | null = null; let isPending = !cfg.fillAtSignalPrice && !inp.obs.has(k);
    if (b.exitSignal && !isPending) { const x = exitInputFor(b.exitSignal, inp, b.entry.market); const xk = `${b.tokenId}@${timeline(x.triggerTs, x.triggerEvalTs, cfg).fillTs}`;
      if (!cfg.fillAtSignalPrice && !inp.obs.has(xk)) isPending = true; else exit = { input: { ...x, obs: cfg.fillAtSignalPrice ? null : inp.obs.get(xk) ?? null } }; }
    if (isPending) { pending++; records.push({ ...base, status: "PENDING", reason: "PRICE_DATA_PENDING", coverage_state: "PENDING_DATA", state: "PENDING", requested_usd: cfg.paperSizeUsd, filled_usd: 0, filled_shares: 0 }); continue; }
    const entry = simulateEntry({ ...b.entry, obs: cfg.fillAtSignalPrice ? null : inp.obs.get(k) ?? null }, cfg);
    const life = lifecycle(entry, exit, b.resolution, b.mark, cfg);
    rows.push({ signalId: b.id, kind: b.kind, closedAt: life.closedAt, life });
    const e = life.entry, x = life.exit;
    records.push({ ...base, latency_source: e.timing.latencySource,
      market_price: e.marketPrice, market_obs_ts: iso(e.marketObsTs), fill_price: e.fillPrice, tick: e.tick, slippage_ticks: e.slippageTicks,
      status: e.status, reason: e.reason, coverage_state: coverageOf(e.status), requested_usd: e.requestedUsd, filled_usd: e.filledUsd, filled_shares: e.filledShares, fill_pct: e.fillPct,
      entry_fee: e.fee, fee_rate: e.feeRate, fee_source: e.feeSource, latency_cost: e.latencyCost, entry_slippage_cost: e.slippageCost,
      exit_trigger_ts: x ? iso(x.timing.sourceTs) : null, exit_decision_ts: x ? iso(x.timing.evalTs) : null, exit_fill_ts: x ? iso(x.timing.fillTs) : null, exit_market_price: x?.marketPrice ?? null, exit_fill_price: x?.fillPrice ?? null,
      exit_slippage_ticks: x?.slippageTicks ?? null, exit_status: x?.status ?? null, exit_reason: x?.reason ?? null, exit_sold_shares: x?.soldShares ?? null, exit_fee: x?.fee ?? null, exit_slippage_cost: x?.slippageCost ?? null,
      resolution_ts: life.resolution ? iso(life.resolution.ts) : null, resolution_value: life.resolution?.value ?? null, resolution_shares: life.resolution?.shares ?? null,
      mark_ts: life.mark ? iso(life.mark.ts) : null, mark_price: life.mark?.price ?? null, open_shares: life.openShares, state: life.state,
      gross_pnl: life.grossPnl, fees_total: life.fees, net_pnl: life.netPnl, realized_pnl: life.realizedPnl, unrealized_pnl: life.unrealizedPnl, closed_at: iso(life.closedAt) });
  }
  return { mode: cfg.mode, configHash: hash, rows, pending, records };
}

export function recordHash(r: Record<string, unknown>): string {
  const s = JSON.stringify(r, Object.keys(r).sort()); let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16);
}

/** PostgREST puts `in.(…)` lists in the URL. 500 uuids ≈ 19 KB and 300 token ids ≈ 23 KB — past common URL limits.
 *  Every IN list is therefore split into chunks of IN_CHUNK values (≈ 4–8 KB), and every chunk's error is surfaced. */
export const IN_CHUNK = 100;
/** Rows for exact (token, as_of) pairs, fetched in chunks of IN_CHUNK pairs (both columns filtered in the database). */
export async function selectPairs<T = Record<string, any>>(pairs: { tokenId: string; asOf: number }[], run: (tokens: string[], asOfs: number[]) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const wanted = new Set(pairs.map((p) => `${p.tokenId}@${p.asOf}`)); const sorted = [...pairs].sort((a, b) => a.tokenId.localeCompare(b.tokenId) || a.asOf - b.asOf); const out: T[] = [];
  for (let i = 0; i < sorted.length; i += IN_CHUNK) {
    const chunk = sorted.slice(i, i + IN_CHUNK);
    const { data, error } = await run([...new Set(chunk.map((p) => p.tokenId))], [...new Set(chunk.map((p) => p.asOf))]);
    if (error) throw new Error(`query failed: ${(error as { message?: string }).message ?? String(error)}`);
    for (const r of (data ?? []) as any[]) if (wanted.has(`${r.token_id}@${Number(r.as_of)}`)) out.push(r as T);
  }
  return out;
}
export async function selectIn<T = Record<string, any>>(values: unknown[], run: (chunk: unknown[]) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const { data, error } = await run(values.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`query failed: ${(error as { message?: string }).message ?? String(error)}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

/** Load only what one batch of ledger rows needs. Every query is bounded by the batch's ids/tokens/markets. */
export async function loadBatchInputs(db: SupabaseClient, ids: string[]): Promise<SimInputs> {
  const cols = "id,kind,wallet,condition_id,token_id,price,usd,created_at,evaluated_at";
  const signals = await selectIn<Record<string, any>>(ids, (c) => db.from("signals").select(cols).in("id", c as string[]));
  const tokens = [...new Set(signals.map((s) => s.token_id))]; const conds = [...new Set(signals.map((s) => String(s.condition_id ?? "").toLowerCase()))];
  const wallets = new Set(signals.map((s) => s.wallet));
  const exits = (await selectIn<Record<string, any>>(tokens, (c) => db.from("signals").select(cols).eq("kind", "EXIT").in("token_id", c as string[]))).filter((x) => wallets.has(x.wallet));
  const led = await selectIn<Record<string, any>>([...ids, ...exits.map((x) => x.id)], (c) => db.from("paper_ledger").select("signal_id,created_at").in("signal_id", c as string[]));
  const mk = await selectIn<Record<string, any>>(ids, (c) => db.from("paper_marks").select("signal_id,horizon,observed_at,price").in("signal_id", c as string[]).in("horizon", ["1h", "6h", "24h"]));
  const rs = await selectIn<Record<string, any>>(tokens, (c) => db.from("token_resolutions").select("token_id,value,resolved_ts").in("token_id", c as string[]));
  const mt = await selectIn<Record<string, any>>(conds, (c) => db.from("markets").select("condition_id,fees_enabled,taker_fee_rate,tick_size,min_order_shares,meta_fetched_at").in("condition_id", c as string[]));
  const inp: SimInputs = { signals: [...signals, ...exits], ledger: new Map(((led ?? []) as any[]).map((r) => [r.signal_id, r])), marks: new Map(), resolutions: new Map(), markets: new Map(), obs: new Map() };
  for (const m of (mk ?? []) as any[]) { const ts = sec(m.observed_at)!; const prev = inp.marks.get(m.signal_id); if (!prev || ts > prev.ts) inp.marks.set(m.signal_id, { ts, price: Number(m.price) }); }
  for (const r of (rs ?? []) as any[]) if (r.resolved_ts != null && r.value != null) inp.resolutions.set(r.token_id, { ts: sec(r.resolved_ts)!, value: Number(r.value) });
  for (const r of (mt ?? []) as any[]) inp.markets.set(String(r.condition_id).toLowerCase(), { feesEnabled: r.fees_enabled ?? null, takerFeeRate: r.taker_fee_rate == null ? null : Number(r.taker_fee_rate), tickSize: r.tick_size == null ? null : Number(r.tick_size), minOrderShares: r.min_order_shares == null ? null : Number(r.min_order_shares), observedAt: r.meta_fetched_at ?? null });
  const built = buildSignals(inp); const need = neededObservations(built, inp, [MODES.REALISTIC, MODES.CONSERVATIVE]);
  if (need.length) {
    const ob = await selectPairs<Record<string, any>>(need, (t, a) => db.from("price_observations").select("token_id,as_of,obs_ts,price,resolution_seconds,state,attempts").in("token_id", t).in("as_of", a));
    for (const r of ob) {
      const key = `${r.token_id}@${Number(r.as_of)}`;
      if (r.state === "COMPLETE") inp.obs.set(key, { ts: Number(r.obs_ts), price: Number(r.price), resolutionSeconds: Number(r.resolution_seconds) });
      else if (r.state === "UNAVAILABLE" || (r.state === "FAILED" && Number(r.attempts) >= MAX_FETCH_ATTEMPTS)) inp.obs.set(key, null); // permanently unavailable
      // PENDING / PROCESSING / retrying FAILED: absent → PENDING_DATA
    }
  }
  return inp;
}

export interface SweepStats { lastBatchMs?: number; batches: number; signals: number; written: number; unchanged: number; enqueued: number; newlyTerminal: number; maxBatchRows: number; peakHeapMb: number; missingMarkets: string[] }
/** Sweep every non-terminal entry row in keyset batches. */
export async function sweepSimulation(db: SupabaseClient, opts: { batchSize?: number; maxBatches?: number; onBatch?: (s: SweepStats) => void } = {}): Promise<SweepStats> {
  const B = opts.batchSize ?? SIM_BATCH_SIZE; const modes = [MODES.IDEAL, MODES.REALISTIC, MODES.CONSERVATIVE];
  const st: SweepStats = { batches: 0, signals: 0, written: 0, unchanged: 0, enqueued: 0, newlyTerminal: 0, maxBatchRows: 0, peakHeapMb: 0, missingMarkets: [] };
  const missing = new Set<string>(); let last = "";
  for (;;) {
    if (opts.maxBatches != null && st.batches >= opts.maxBatches) break;
    const q = db.from("paper_ledger").select("signal_id").eq("sim_terminal", false).eq("side", "LONG").order("signal_id", { ascending: true }).limit(B);
    const { data: page, error } = await (last ? q.gt("signal_id", last) : q); if (error) throw error;
    const ids = ((page ?? []) as any[]).map((r) => r.signal_id as string); if (!ids.length) break;
    const tb = Date.now(); last = ids[ids.length - 1]; st.batches++; st.signals += ids.length; st.maxBatchRows = Math.max(st.maxBatchRows, ids.length);
    const inp = await loadBatchInputs(db, ids); const built = buildSignals(inp);
    for (const b of built) if (!inp.markets.has(b.conditionId) && missing.size < 200) missing.add(b.conditionId);
    // enqueue what this batch still needs (idempotent: existing rows are left alone)
    const need = neededObservations(built, inp, modes).filter((n) => !inp.obs.has(`${n.tokenId}@${n.asOf}`));
    if (need.length) { const existing = await selectPairs<Record<string, any>>(need, (t, a) => db.from("price_observations").select("token_id,as_of").in("token_id", t).in("as_of", a));
      const have = new Set(existing.map((r) => `${r.token_id}@${Number(r.as_of)}`)); const fresh = need.filter((n) => !have.has(`${n.tokenId}@${n.asOf}`));
      if (fresh.length) { const { error: qe } = await db.from("price_observations").upsert(fresh.map((n) => ({ token_id: n.tokenId, as_of: n.asOf, state: "PENDING" })), { onConflict: "token_id,as_of", ignoreDuplicates: true }); if (qe) throw qe; st.enqueued += fresh.length; } }
    // simulate, write only changed records
    const outs = modes.map((m) => simulateMode(built, inp, m)); const records: Record<string, any>[] = outs.flatMap((o) => o.records).map((r) => ({ ...r, record_hash: recordHash(r) }));
    const prev = await selectIn<Record<string, any>>(ids, (c) => db.from("paper_executions").select("signal_id,mode,record_hash").in("signal_id", c as string[]));
    const prevHash = new Map(prev.map((r) => [`${r.signal_id}|${r.mode}`, r.record_hash]));
    const changed = records.filter((r) => prevHash.get(`${r.signal_id}|${r.mode}`) !== r.record_hash);
    for (let i = 0; i < changed.length; i += 500) { const { error: we } = await db.from("paper_executions").upsert(changed.slice(i, i + 500).map((r) => ({ ...r, computed_at: new Date().toISOString() })), { onConflict: "signal_id,mode" }); if (we) throw we; }
    st.written += changed.length; st.unchanged += records.length - changed.length;
    // signals whose outcome is final in every mode leave the sweep for good
    const byId = new Map<string, boolean>(); for (const r of records) byId.set(r.signal_id as string, (byId.get(r.signal_id as string) ?? true) && isTerminal(r.coverage_state as CoverageState, r.state as string));
    const done = [...byId].filter(([, t]) => t).map(([id]) => id);
    if (done.length) { await selectIn(done, (c) => db.from("paper_ledger").update({ sim_terminal: true }).in("signal_id", c as string[])); st.newlyTerminal += done.length; }
    st.peakHeapMb = Math.max(st.peakHeapMb, process.memoryUsage().heapUsed / 1048576); st.lastBatchMs = Date.now() - tb; opts.onBatch?.(st);
    if (ids.length < B) break;
  }
  st.missingMarkets = [...missing];
  return st;
}

/** Full cycle: backlog → metadata backfill → sweep → database-side reports → snapshot. */
export async function runSimulation(db: SupabaseClient, opts: { client?: PriceSource & Partial<PolymarketClient>; fetchBudget?: number; log?: (m: string) => void; metaFetcher?: (conditionId: string) => Promise<unknown> } = {}) {
  const log = opts.log ?? (() => {}); const client = opts.client ?? new PolymarketClient(); const t0 = Date.now();
  const backlog = await processBacklog(supabaseBacklog(db), client, { budget: opts.fetchBudget ?? 3000 });
  log(`sim: backlog ${backlog.done} fetched (${backlog.unavailable} unavailable, ${backlog.failed} failed); sweeping`);
  const sweep = await sweepSimulation(db, { onBatch: (s) => { if (s.batches === 1 || s.batches % 10 === 0) log(`sim: batch ${s.batches} (size ${SIM_BATCH_SIZE}, ${s.lastBatchMs} ms), ${s.signals} signals, wrote ${s.written}, heap peak ${s.peakHeapMb.toFixed(0)} MB`); } });
  if (opts.metaFetcher) for (const c of sweep.missingMarkets.slice(0, 50)) { try { await opts.metaFetcher(c); } catch { /* next run */ } }
  const reports: Record<string, unknown> = {};
  for (const m of ["IDEAL", "REALISTIC", "CONSERVATIVE"]) { const { data, error } = await db.rpc("paper_exec_report", { p_mode: m }); if (error) throw error; reports[m] = { configHash: configHash(MODES[m as ModeName]), ...(data as object) }; }
  const { data: dq } = await db.rpc("data_quality_report");
  const snapshot = { builtAt: new Date().toISOString(), backlog, sweep: { ...sweep, missingMarkets: sweep.missingMarkets.length }, modes: reports, dataQuality: dq, portfolioConfigured: false, durationSec: (Date.now() - t0) / 1000 };
  await db.from("cursors").upsert({ key: "paper:execution", value: JSON.stringify(snapshot), updated_at: new Date().toISOString() });
  log(`sim: backlog ${backlog.done} done (${backlog.unavailable} unavailable, ${backlog.failed} failed) · swept ${sweep.signals} in ${sweep.batches} batches · wrote ${sweep.written}, unchanged ${sweep.unchanged}, +${sweep.newlyTerminal} final · peak heap ${sweep.peakHeapMb.toFixed(0)} MB · ${snapshot.durationSec.toFixed(0)} s`);
  return snapshot;
}
