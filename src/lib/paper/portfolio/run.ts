/**
 * Portfolio runner (docs/PHASE3_PLAN.md §B, §J step 6). One run per execution mode:
 *
 *   lease → previous run (crash?) → change detection (§B2) → restore checkpoint + rehydrate open lots (§B11)
 *   → [rewind: delete outputs after the restored second, re-emit its open lots] → stream paper_executions by
 *   (fill_ts, signal_id) in whole-second batches → PortfolioBook → diff writes → checkpoints → portfolio_runs.
 *
 * Invariants:
 *  - A batch never splits a fill second (the book refuses out-of-order entries; rows sharing a second are re-sorted
 *    into book order by orderRequests).
 *  - Checkpoints sit on second boundaries: a checkpoint at second S holds the state after every event at or before S
 *    (the book is advanced through S first). Restoring S and streaming `fill_ts > S` is therefore exact.
 *  - Nothing at or after the frontier (earliest missing price, carried across batches) is decided or written; the book
 *    is never advanced past it. The watermark W is the last second fully decided.
 *  - Writes are diffs (record_hash), in the order outputs → checkpoints → portfolio_runs. A second run with no input
 *    change writes nothing to the output tables. `dryRun` writes nothing at all.
 *  - Memory: one batch (+ its same-second tail), the open lots and the book's pending events. Nothing proportional to
 *    history is loaded.
 */
import os from "node:os";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MODES, type ModeName } from "../sim/config";
import { SIM_BATCH_SIZE, buildSignals, loadBatchInputs } from "../sim/run";
import { selectIn } from "../../chunk";
import { memSample, type MemSample } from "../../health/memory";
import { KIND_ORDER, PortfolioBook, cmpKey } from "./book";
import { IDEAL_LABEL, portfolioDefinitions, portfolioRunConfigFromEnv, type PortfolioDefinition, type PortfolioRunConfig } from "./config";
import { buildRequests, frontierOf, orderRequests, rewindPoint, stableHash, type PortfolioRequest } from "./requests";
import type { BookDecision, BookLot, BookOutput, BookState, EquityPoint, EventKey } from "./types";

export const LEASE_SEC = 900;
export const CHECKPOINT_HOURLY_DAYS = 10;
export const EQUITY_DENSE_DAYS = 7;
const CK_KEY = "~"; // a checkpoint covers its whole second
const iso = (s: number) => new Date(s * 1000).toISOString();
const sec = (v: string) => Math.floor(Date.parse(v) / 1000);

export type RunStage = "afterStart" | "afterOutputs" | "afterCheckpoints";
export interface RunOptions {
  /** Validated config; default: PAPER_PORTFOLIO_CONFIG (unset → nothing runs). */
  config?: PortfolioRunConfig | null;
  modes?: ModeName[];
  /** Compute everything, write nothing (not even the lease or the portfolios row). */
  dryRun?: boolean;
  now?: () => number;
  owner?: string;
  leaseSec?: number;
  batchSize?: number;
  /** Stop after this many batches (a partial run); the next run continues from the watermark. */
  maxBatches?: number;
  log?: (m: string) => void;
  /** Test hook: called at the named point of a run; throwing there simulates a crash. */
  fault?: (stage: RunStage, mode: ModeName) => void;
}

export interface PortfolioRunStats {
  portfolioId: string; mode: ModeName; skipped?: "LEASE_HELD"; nonCausalBaseline?: string; dryRun: boolean;
  rowsRead: number; batches: number; staleRows: number; decisions: Record<string, number>;
  /** Price observations the portfolio is waiting for that nothing had queued (see enqueueMissing). */
  enqueued: number;
  rewind: { to: number | null; restoredFrom: number | null; reasons: string[] };
  /** R4 (step 8): the previous run's watermark, how far this run went back from it (seconds, 0 without a rewind), and
   *  how many of the last 20 finished runs rewound (a rolling counter kept in portfolio_runs.stats). */
  previousWatermark: number | null; rewindDistanceSec: number; rewindsLast20: number;
  frontier: EventKey | null; watermark: number | null;
  writes: Record<string, number>; deletes: Record<string, number>;
  durationMs: number; memory: { before: MemSample; after: MemSample } | null;
  summary: ReturnType<PortfolioBook["summary"]> | null;
}

/** Run every configured portfolio. Unset config → returns [] and touches nothing. */
export async function runPortfolios(db: SupabaseClient, opts: RunOptions = {}): Promise<PortfolioRunStats[]> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const cfg = opts.config === undefined ? portfolioRunConfigFromEnv(process.env, now()) : opts.config;
  if (!cfg) return [];
  const owner = opts.owner ?? `${os.hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
  const out: PortfolioRunStats[] = [];
  for (const def of portfolioDefinitions(cfg, opts.modes)) out.push(await runOne(db, def, cfg, { ...opts, now, owner }));
  return out;
}

// ───────────────────────────── one portfolio ─────────────────────────────
async function runOne(db: SupabaseClient, def: PortfolioDefinition, cfg: PortfolioRunConfig, opts: RunOptions & { now: () => number; owner: string }): Promise<PortfolioRunStats> {
  const t0 = Date.now(); const before = memSample(); const exec = MODES[def.mode]; const pc = cfg.portfolio; const dry = !!opts.dryRun;
  const log = opts.log ?? (() => {}); const leaseSec = opts.leaseSec ?? LEASE_SEC; const B = opts.batchSize ?? SIM_BATCH_SIZE;
  const st: PortfolioRunStats = { portfolioId: def.id, mode: def.mode, dryRun: dry, rowsRead: 0, batches: 0, staleRows: 0, enqueued: 0, decisions: {}, rewind: { to: null, restoredFrom: null, reasons: [] }, previousWatermark: null, rewindDistanceSec: 0, rewindsLast20: 0, frontier: null, watermark: null, writes: {}, deletes: {}, durationMs: 0, memory: null, summary: null,
    ...(def.mode === "IDEAL" ? { nonCausalBaseline: IDEAL_LABEL } : {}) };
  const w = writer(db, def.id, dry, st);

  if (!dry) {
    await must(db.from("portfolios").upsert({ id: def.id, mode: def.mode, exec_config_hash: def.execConfigHash, config: def.config, config_hash: def.configHash, start_ts: iso(def.startTs) }, { onConflict: "id", ignoreDuplicates: true }), "portfolios upsert");
    const { data: ok, error } = await db.rpc("claim_portfolio_lease", { p_portfolio_id: def.id, p_owner: opts.owner, p_seconds: leaseSec });
    if (error) throw new Error(`claim_portfolio_lease: ${error.message}`);
    if (!ok) { log(`${def.mode}: lease held by another runner, skipped`); return { ...st, skipped: "LEASE_HELD", durationMs: Date.now() - t0 }; }
  }
  try {
    const now = opts.now();
    // 1. previous run
    const { data: prev, error: pe } = await db.from("portfolio_runs").select("last_run_started_at,last_run_finished_at,last_watermark_ts,stats").eq("portfolio_id", def.id).maybeSingle();
    if (pe) throw new Error(`portfolio_runs read: ${pe.message}`);
    const prevStarted = prev?.last_run_started_at ? sec(prev.last_run_started_at) : null, prevFinished = prev?.last_run_finished_at ? sec(prev.last_run_finished_at) : null;
    const W0 = prev?.last_watermark_ts ? sec(prev.last_watermark_ts) : null;
    const prevStats = (prev?.stats ?? {}) as { equityDownsampledTo?: number; runStartedAt?: number; rewindHistory?: boolean[] };
    let equityCursor: number = prevStats.equityDownsampledTo ?? def.startTs;
    if (!dry) await must(db.from("portfolio_runs").update({ last_run_started_at: iso(now), updated_at: iso(now) }).eq("portfolio_id", def.id), "portfolio_runs start");
    opts.fault?.("afterStart", def.mode);

    // 2. where to replay from
    let T = Infinity; const reasons: string[] = [];
    // A run that died may have written outputs and checkpoints past its (unrecorded) watermark: go back to the last
    // recorded one (or to the start if none was ever recorded) and delete everything after the restored checkpoint.
    const crashed = prevStarted != null && (prevFinished == null || prevFinished < prevStarted);
    if (crashed) { T = W0 != null ? W0 + 1 : def.startTs; reasons.push("previous run did not finish"); }
    // Changes are read from the start of the last run that finished: a run that died may not have acted on them.
    const since = crashed ? prevStats.runStartedAt ?? null : prevStarted;
    const hashFixes = new Map<string, string>(); // decided signals whose inputs changed without needing a rewind
    if (W0 != null && since != null) {
      const cd = await detectChanges(db, def, exec, cfg, iso(since), W0, B);
      if (cd.rewindTs < T) { T = cd.rewindTs; } if (cd.rewindTs !== Infinity) reasons.push(...cd.reasons);
      for (const [k, v] of cd.hashFixes) hashFixes.set(k, v);
    }

    // 3. restore + rehydrate (§B11); an event before the checkpoint sends us to an earlier one
    let book!: PortfolioBook; let S!: number; let restored: { event_ts: string; state: BookState } | null = null; let lotFrontier: EventKey | null = null;
    for (let guard = 0; ; guard++) {
      if (guard > 50) throw new Error("rehydration did not converge");
      restored = await latestCheckpoint(db, def.id, T);
      book = restored ? new PortfolioBook(exec, pc, restored.state) : new PortfolioBook(exec, pc);
      S = restored ? sec(restored.event_ts) : def.startTs - 1;
      const lots = book.openLots(); let rewindTo = Infinity; lotFrontier = null;
      if (lots.length) {
        const ids = lots.map((l) => l.signalId); const reqs = await requestsFor(db, exec, cfg, ids); await enqueueMissing(db, dry, [...reqs.values()], st);
        const stored = new Map((await selectIn<{ signal_id: string; input_hash: string }>(ids, (c) => db.from("portfolio_decisions").select("signal_id,input_hash").eq("portfolio_id", def.id).in("signal_id", c as string[]))).map((d) => [d.signal_id, d.input_hash]));
        for (const l of lots) {
          const r = reqs.get(l.signalId); if (!r) continue;
          const rp = stored.has(l.signalId) ? rewindPoint(stored.get(l.signalId)!, r) : null;
          if (rp != null && rp <= S) { rewindTo = Math.min(rewindTo, rp); continue; }             // e.g. its entry inputs changed
          const xw = exitWait(r);
          if (xw != null && xw <= S) { rewindTo = Math.min(rewindTo, xw); continue; } // the book already passed an exit it could not price
          const res = book.relink(l.signalId, { exit: r.signal.exit, exitId: r.signal.exitId ?? null, resolution: r.signal.resolution, mark: r.signal.mark });
          if (!res.ok) { rewindTo = Math.min(rewindTo, res.rewindTo); continue; }
          hashFixes.set(l.signalId, r.fingerprint);
          if (xw != null) { const k: EventKey = { ts: xw, order: KIND_ORDER.EXIT, id: l.signalId }; if (!lotFrontier || cmpKey(k, lotFrontier) < 0) lotFrontier = k; }
        }
      }
      if (rewindTo === Infinity) break;
      reasons.push(`an open lot at ${iso(S)} has an exit, resolution or entry change at ${iso(rewindTo)}, before that checkpoint`);
      T = Math.min(T, rewindTo);
    }
    const rewound = crashed || (W0 != null && S < W0);
    st.rewind = { to: rewound ? (T === Infinity ? null : T) : null, restoredFrom: restored ? S : null, reasons: rewound ? reasons : [] };
    const rewindHistory = [...(Array.isArray(prevStats.rewindHistory) ? prevStats.rewindHistory : []), rewound].slice(-20);
    st.previousWatermark = W0; st.rewindDistanceSec = rewound && W0 != null ? W0 - S : 0; st.rewindsLast20 = rewindHistory.filter(Boolean).length;

    // 4. rewind: remove what came after S, and put back the lots that are open in the restored state
    if (rewound) {
      await w.del("portfolio_decisions", (q) => q.gt("event_ts", iso(S)));
      await w.del("portfolio_lots", (q) => q.gt("opened_ts", iso(S)));
      await w.del("portfolio_equity", (q) => q.gt("ts", iso(S)));
      await w.del("portfolio_checkpoints", (q) => q.gt("event_ts", iso(S)));
      equityCursor = Math.min(equityCursor, S);
    }
    // Lots open in the restored state, as rehydrated: after a rewind this replaces rows the old run closed later; every
    // run it records a newly linked exit (exit_signal_id). A diff, so an unchanged run writes nothing.
    await w.lots(book.openLots());

    // 5. stream
    const eq = { ts: -1, seq: 0 }; const fps = new Map<string, string>();
    const bucket = (ts: number) => (ts >= now - CHECKPOINT_HOURLY_DAYS * 86_400 ? `h${Math.floor(ts / 3600)}` : `d${Math.floor(ts / 86_400)}`);
    let lastCk = restored ? bucket(S) : ""; let lastDone = S; let F: EventKey | null = lotFrontier; let cursor = iso(S); let stop = false;
    const pendingCk: { ts: number; state: BookState }[] = [];
    const flush = async () => { await w.output(book.take(), fps, eq); for (const c of pendingCk.splice(0)) await w.checkpoint(c.ts, c.state); };
    while (!stop) {
      const rows = await nextBatch(db, def.mode, cursor, B); if (!rows.length) break;
      st.batches++; st.rowsRead += rows.length; cursor = rows[rows.length - 1].fill_ts;
      // A request whose fill time no longer matches its stored row (the sweep has not recomputed it yet) is left for
      // change detection, which sees the row when the sweep rewrites it.
      const streamedAt = new Map(rows.map((r) => [r.signal_id, sec(r.fill_ts)]));
      const all = [...(await requestsFor(db, exec, cfg, rows.map((r) => r.signal_id))).values()];
      const reqs = orderRequests(all.filter((r) => r.key.ts === streamedAt.get(r.signal.signalId))); st.staleRows += all.length - reqs.length;
      await enqueueMissing(db, dry, reqs, st);
      const f = frontierOf(reqs.map((r) => (r.exitPendingTs != null && exitWait(r) == null ? { ...r, exitPendingTs: null } : r))); if (f && (!F || cmpKey(f, F) < 0)) F = f;
      for (const r of reqs) {
        if (F && r.key.ts >= F.ts) { stop = true; break; }         // nothing in the frontier's second or later
        if (r.key.ts > lastDone) {                                   // lastDone's second is complete
          if (lastDone > S && bucket(lastDone) !== lastCk) { book.advance(endOf(lastDone)); pendingCk.push({ ts: lastDone, state: book.snapshot() }); lastCk = bucket(lastDone); }
          lastDone = r.key.ts;
        }
        const d = book.submit(r.signal); fps.set(r.signal.signalId, r.fingerprint); st.decisions[d.outcome] = (st.decisions[d.outcome] ?? 0) + 1;
      }
      await flush();
      opts.fault?.("afterOutputs", def.mode);
      if (!dry) { const { data: ok, error } = await db.rpc("claim_portfolio_lease", { p_portfolio_id: def.id, p_owner: opts.owner, p_seconds: leaseSec }); if (error || !ok) throw new Error(`lease lost during run (${error?.message ?? "held by another runner"})`); }
      if (opts.maxBatches != null && st.batches >= opts.maxBatches) break;
    }

    // 6. close the run at the watermark: everything up to W is decided
    const W = F ? Math.min(lastDone, F.ts - 1) : lastDone;
    book.advance(endOf(W));
    st.frontier = F; st.watermark = W >= def.startTs ? W : null;
    await flush();
    await w.fixInputHashes(hashFixes, fps);                                   // outputs first, then the checkpoint
    const changedSinceRestore = W !== S || !restored || canonical(book.snapshot()) !== canonical(restored.state);
    if (W >= def.startTs && changedSinceRestore) await w.checkpoint(W, book.snapshot());
    opts.fault?.("afterCheckpoints", def.mode);
    await pruneCheckpoints(w, db, def.id, now, W);
    equityCursor = await downsampleEquity(w, db, def.id, equityCursor, now);

    st.summary = book.summary(); st.durationMs = Date.now() - t0; st.memory = { before, after: memSample() };
    if (!dry) await must(db.from("portfolio_runs").update({ last_run_finished_at: iso(opts.now()), last_watermark_ts: st.watermark == null ? null : iso(st.watermark), last_watermark_key: st.watermark == null ? null : CK_KEY,
      stats: { ...st, equityDownsampledTo: equityCursor, runStartedAt: now, rewindHistory }, updated_at: iso(opts.now()) }).eq("portfolio_id", def.id), "portfolio_runs finish");
    log(`${def.mode}: ${st.rowsRead} rows in ${st.batches} batches · watermark ${st.watermark == null ? "—" : iso(st.watermark)} · frontier ${F ? iso(F.ts) : "none"}${rewound ? ` · rewound to ${iso(S)} (${reasons.join("; ")})` : ""} · wrote ${JSON.stringify(st.writes)} · heap ${before.heapUsedMb}→${st.memory.after.heapUsedMb} MB`);
    return st;
  } finally {
    if (!dry) await db.rpc("release_portfolio_lease", { p_portfolio_id: def.id, p_owner: opts.owner });
  }
}

const endOf = (ts: number): EventKey => ({ ts: ts + 1, order: -1, id: "" }); // advance(endOf(S)) applies every event at or before S

/** A checkpoint's state without what does not affect results: scheduled-event insertion counters, lot marks, and when
 *  a scheduled exit's market metadata was fetched (provenance, as in the fingerprint, R8). */
function canonical(s: BookState): string {
  const cmp = (a: { ts: number; order: number; id: string }, b: typeof a) => a.ts - b.ts || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const noFetchTime = (m: unknown) => { if (!m || typeof m !== "object") return m ?? null; const { observedAt: _o, ...rest } = m as Record<string, unknown>; return rest; };
  const heap = [...s.heap].map((e) => ({ ...e, seq: 0, ...(e.exit ? { exit: { ...e.exit, market: noFetchTime(e.exit.market) } } : {}) })).sort(cmp);
  return stableHash({ ...s, seq: 0, heap, lots: s.lots.map((l) => ({ ...l, mark: null })), taken: [...s.taken].sort() }, 64);
}

// ───────────────────────────── reads ─────────────────────────────
async function must<T extends { error: { message: string } | null }>(p: PromiseLike<T>, what: string): Promise<T> { const r = await p; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r; }

/** Rows with fill_ts after `cursor`, never splitting a fill second: a full batch is extended to the end of its last second. */
export async function nextBatch(db: SupabaseClient, mode: ModeName, cursor: string, size: number): Promise<{ signal_id: string; fill_ts: string }[]> {
  const { data, error } = await db.from("paper_executions").select("signal_id,fill_ts").eq("mode", mode).gt("fill_ts", cursor).order("fill_ts", { ascending: true }).order("signal_id", { ascending: true }).limit(size);
  if (error) throw new Error(`paper_executions stream: ${error.message}`);
  const rows = (data ?? []) as { signal_id: string; fill_ts: string }[];
  if (rows.length < size) return rows;
  const last = rows[rows.length - 1].fill_ts;
  const { data: tail, error: te } = await db.from("paper_executions").select("signal_id,fill_ts").eq("mode", mode).eq("fill_ts", last);
  if (te) throw new Error(`paper_executions same-second tail: ${te.message}`);
  const have = new Set(rows.map((r) => r.signal_id));
  return [...rows, ...((tail ?? []) as typeof rows).filter((r) => !have.has(r.signal_id)).sort((a, b) => (a.signal_id < b.signal_id ? -1 : 1))];
}

/** A linked exit still waiting for its price matters only if the book would schedule it: not when the lot's resolution
 *  comes at or before the exit's fill (book.eventsFor). Such an exit never holds the frontier. */
const exitWait = (r: PortfolioRequest): number | null => (r.exitPendingTs != null && !(r.signal.resolution && r.signal.resolution.ts <= r.exitPendingTs) ? r.exitPendingTs : null);

/**
 * Queue the prices this portfolio is waiting for (entry prices, exit prices that matter), exactly as the Phase 2 sweep
 * queues its own: PENDING rows in price_observations, existing rows untouched. Needed because the sweep stops looking
 * at a signal once its $100 record is terminal, so an exit that arrives later is never priced for the portfolio, and a
 * replay would wait for it for ever. The backlog fetches them on the next cycle. Dry run: counted, not written.
 */
async function enqueueMissing(db: SupabaseClient, dry: boolean, reqs: PortfolioRequest[], st: PortfolioRunStats) {
  const need = new Map<string, { token_id: string; as_of: number; state: string }>();
  for (const r of reqs) {
    if (r.pendingEntry) need.set(`${r.signal.tokenId}@${r.key.ts}`, { token_id: r.signal.tokenId, as_of: r.key.ts, state: "PENDING" });
    const xw = exitWait(r); if (xw != null) need.set(`${r.signal.tokenId}@${xw}`, { token_id: r.signal.tokenId, as_of: xw, state: "PENDING" });
  }
  if (!need.size) return; st.enqueued += need.size; if (dry) return;
  const rows = [...need.values()];
  for (let i = 0; i < rows.length; i += 500) await must(db.from("price_observations").upsert(rows.slice(i, i + 500), { onConflict: "token_id,as_of", ignoreDuplicates: true }), "price_observations enqueue");
}

/** Current requests for these signals (the sweep's own loaders, plus source_fill_id which they do not select). */
async function requestsFor(db: SupabaseClient, exec: (typeof MODES)["IDEAL"], cfg: PortfolioRunConfig, ids: string[]): Promise<Map<string, PortfolioRequest>> {
  const out = new Map<string, PortfolioRequest>(); if (!ids.length) return out;
  const inp = await loadBatchInputs(db, ids);
  const fills = await selectIn<{ id: string; source_fill_id: string | null }>(ids, (c) => db.from("signals").select("id,source_fill_id").in("id", c as string[]));
  const sourceFillIds = new Map(fills.map((r) => [r.id, r.source_fill_id ?? null]));
  for (const r of buildRequests(buildSignals(inp), inp, exec, { startTs: cfg.startTs, sourceFillIds })) out.set(r.signal.signalId, r);
  return out;
}

async function latestCheckpoint(db: SupabaseClient, id: string, before: number): Promise<{ event_ts: string; state: BookState } | null> {
  let q = db.from("portfolio_checkpoints").select("event_ts,state").eq("portfolio_id", id);
  if (before !== Infinity) q = q.lt("event_ts", iso(before));
  const { data, error } = await q.order("event_ts", { ascending: false }).limit(1);
  if (error) throw new Error(`portfolio_checkpoints read: ${error.message}`);
  return ((data ?? [])[0] as { event_ts: string; state: BookState } | undefined) ?? null;
}

/** §B2: rows the sweep rewrote since the last run. Rewind to the earliest change that touches something already decided. */
async function detectChanges(db: SupabaseClient, def: PortfolioDefinition, exec: (typeof MODES)["IDEAL"], cfg: PortfolioRunConfig, since: string, W: number, size: number) {
  let rewindTs = Infinity; const reasons: string[] = []; const hashFixes = new Map<string, string>(); let last = "";
  for (;;) {
    let q = db.from("paper_executions").select("signal_id").eq("mode", def.mode).gt("computed_at", since);
    if (last) q = q.gt("signal_id", last);
    const { data, error } = await q.order("signal_id", { ascending: true }).limit(size);
    if (error) throw new Error(`change detection: ${error.message}`);
    const ids = ((data ?? []) as { signal_id: string }[]).map((r) => r.signal_id); if (!ids.length) break; last = ids[ids.length - 1];
    const reqs = await requestsFor(db, exec, cfg, ids);
    const decided = new Map((await selectIn<{ signal_id: string; input_hash: string }>(ids, (c) => db.from("portfolio_decisions").select("signal_id,input_hash").eq("portfolio_id", def.id).in("signal_id", c as string[]))).map((d) => [d.signal_id, d.input_hash]));
    for (const r of reqs.values()) {
      const old = decided.get(r.signal.signalId) ?? null;
      if (old == null && r.key.ts > W) continue;                    // not decided yet: the stream will reach it
      const rp = rewindPoint(old, r);
      if (rp == null) continue;                                     // mark-only (or no) change
      if (rp <= W) { if (rp < rewindTs) rewindTs = rp; reasons.push(`${old == null ? "late signal" : "inputs changed"} ${r.signal.signalId.slice(0, 8)} at ${iso(rp)}`); }
      // Keep input_hash current either way: a decision before the restored checkpoint is not replayed by the rewind, and
      // a stale hash would make every later change look like this one again.
      hashFixes.set(r.signal.signalId, r.fingerprint);
    }
    if (ids.length < size) break;
  }
  return { rewindTs, reasons: reasons.slice(0, 20), hashFixes };
}

// ───────────────────────────── writes ─────────────────────────────
const decisionRow = (pid: string, d: BookDecision, inputHash: string) => {
  const r = { portfolio_id: pid, signal_id: d.signalId, kind: d.kind, source_key: d.sourceKey, event_ts: iso(d.ts), outcome: d.outcome, reason: d.reason, requested_usd: d.requestedUsd, filled_usd: d.filledUsd, filled_shares: d.filledShares, fill_price: d.fillPrice, fee: d.fee, resized: d.resized, input_hash: inputHash };
  return { ...r, record_hash: stableHash(r) };
};
const lotRow = (pid: string, l: BookLot) => {
  const r = { portfolio_id: pid, signal_id: l.signalId, wallet: l.wallet, token_id: l.tokenId, condition_id: l.conditionId, opened_ts: iso(l.openedTs), shares_filled: l.sharesFilled, cost_usd: l.costFilled, entry_fee: l.entryFee,
    shares_open: l.shares, cost_open: l.cost, exit_signal_id: l.exitId, exit_ts: l.exitTs == null ? null : iso(l.exitTs), exit_shares: l.exitShares, exit_proceeds: l.exitProceeds, exit_fee: l.exitFee,
    resolution_ts: l.resolutionTs == null ? null : iso(l.resolutionTs), resolution_value: l.resolutionValue, resolution_proceeds: l.resolutionProceeds, state: l.state, locked_unresolved: false, realized_pnl: l.realizedPnl, closed_ts: l.closedTs == null ? null : iso(l.closedTs) };
  return { ...r, record_hash: stableHash(r) };
};

function writer(db: SupabaseClient, pid: string, dry: boolean, st: PortfolioRunStats) {
  const count = (m: Record<string, number>, t: string, n: number) => { if (n) m[t] = (m[t] ?? 0) + n; };
  async function put(table: string, rows: Record<string, unknown>[], onConflict: string) {
    if (!rows.length) return; count(st.writes, table, rows.length); if (dry) return;
    for (let i = 0; i < rows.length; i += 500) await must(db.from(table).upsert(rows.slice(i, i + 500), { onConflict }), `${table} write`);
  }
  /** Upsert only rows whose record_hash differs from the stored one. */
  async function diff(table: string, rows: { signal_id: string; record_hash: string }[]) {
    if (!rows.length) return;
    const have = new Map((await selectIn<{ signal_id: string; record_hash: string }>(rows.map((r) => r.signal_id), (c) => db.from(table).select("signal_id,record_hash").eq("portfolio_id", pid).in("signal_id", c as string[]))).map((r) => [r.signal_id, r.record_hash]));
    await put(table, rows.filter((r) => have.get(r.signal_id) !== r.record_hash), "portfolio_id,signal_id");
  }
  return {
    async del(table: string, where: (q: any) => any) { count(st.deletes, table, await countAndDelete(db, table, pid, where, dry)); },
    async lots(lots: BookLot[]) { await diff("portfolio_lots", lots.map((l) => lotRow(pid, l))); },
    async output(o: BookOutput, fps: Map<string, string>, eq: { ts: number; seq: number }) {
      await diff("portfolio_decisions", o.decisions.map((d) => decisionRow(pid, d, fps.get(d.signalId) ?? "")));
      const lastLot = new Map<string, BookLot>(); for (const l of o.lots) lastLot.set(l.signalId, l);
      await diff("portfolio_lots", [...lastLot.values()].map((l) => lotRow(pid, l)));
      if (!o.equity.length) return;
      const rows = o.equity.map((p: EquityPoint) => { if (p.ts === eq.ts) eq.seq++; else { eq.ts = p.ts; eq.seq = 0; } return { portfolio_id: pid, ts: iso(p.ts), seq: eq.seq, cash: p.cash, exposure: p.exposure, equity: p.equity }; });
      for (let i = 0; i < rows.length; i += 500) {                 // bounded reads: one slice at a time
        const part = rows.slice(i, i + 500);
        const { data, error } = await db.from("portfolio_equity").select("ts,seq,cash,exposure,equity").eq("portfolio_id", pid).gte("ts", part[0].ts).lte("ts", part[part.length - 1].ts);
        if (error) throw new Error(`portfolio_equity read: ${error.message}`);
        const have = new Map(((data ?? []) as { ts: string; seq: number; cash: number; exposure: number; equity: number }[]).map((r) => [`${sec(r.ts)}|${r.seq}`, r]));
        await put("portfolio_equity", part.filter((r) => { const h = have.get(`${sec(r.ts)}|${r.seq}`); return !h || Number(h.cash) !== r.cash || Number(h.exposure) !== r.exposure || Number(h.equity) !== r.equity; }), "portfolio_id,ts,seq");
      }
    },
    async checkpoint(ts: number, state: BookState) { await put("portfolio_checkpoints", [{ portfolio_id: pid, event_ts: iso(ts), event_key: CK_KEY, state }], "portfolio_id,event_ts,event_key"); },
    /** Keep input_hash current for decided signals whose inputs changed without needing a replay. */
    async fixInputHashes(fixes: Map<string, string>, replayed: Map<string, string>) {
      const ids = [...fixes.keys()].filter((id) => !replayed.has(id)); if (!ids.length) return;
      const rows = await selectIn<Record<string, any>>(ids, (c) => db.from("portfolio_decisions").select("*").eq("portfolio_id", pid).in("signal_id", c as string[]));
      const changed = rows.filter((r) => r.input_hash !== fixes.get(r.signal_id)).map((r) => { const { record_hash: _h, computed_at: _c, ...rest } = r; void _h; void _c;
        const d = { ...rest, input_hash: fixes.get(r.signal_id)! }; return { ...d, record_hash: stableHash(d) }; });
      await put("portfolio_decisions", changed, "portfolio_id,signal_id");
    },
  };
}
type Writer = ReturnType<typeof writer>;

/** Delete this portfolio's rows matching `where` (unless dry) and return how many there were. The count is a head count:
 *  exact however many rows match (a plain read is capped at 1,000 rows by Supabase, so it would undercount). */
export async function countAndDelete(db: SupabaseClient, table: string, pid: string, where: (q: any) => any, dry: boolean): Promise<number> {
  const { count, error } = await where(db.from(table).select("portfolio_id", { count: "exact", head: true }).eq("portfolio_id", pid));
  if (error) throw new Error(`${table} count: ${error.message}`);
  if (!dry && count) await must(where(db.from(table).delete().eq("portfolio_id", pid)), `${table} delete`);
  return count ?? 0;
}

/** R10: one checkpoint per hour for the last 10 days, one per day before that; the watermark's is always kept. */
async function pruneCheckpoints(w: Writer, db: SupabaseClient, pid: string, now: number, W: number) {
  const { data, error } = await db.from("portfolio_checkpoints").select("event_ts").eq("portfolio_id", pid);
  if (error) throw new Error(`portfolio_checkpoints list: ${error.message}`);
  const ts = ((data ?? []) as { event_ts: string }[]).map((r) => sec(r.event_ts)).sort((a, b) => b - a);
  const seen = new Set<string>(); const drop: number[] = [];
  for (const t of ts) { const b = t >= now - CHECKPOINT_HOURLY_DAYS * 86_400 ? `h${Math.floor(t / 3600)}` : `d${Math.floor(t / 86_400)}`; if (t === W || !seen.has(b)) seen.add(b); else drop.push(t); }
  for (let i = 0; i < drop.length; i += 100) { const chunk = drop.slice(i, i + 100).map(iso); await w.del("portfolio_checkpoints", (q) => q.in("event_ts", chunk)); }
}

/** R9: equity points older than 7 days are reduced to the last point of each hour. Only the not-yet-reduced range is read. */
async function downsampleEquity(w: Writer, db: SupabaseClient, pid: string, from: number, now: number): Promise<number> {
  const cutoff = Math.floor((now - EQUITY_DENSE_DAYS * 86_400) / 3600) * 3600; // whole hours only
  if (cutoff <= from) return from;
  for (let h0 = Math.floor(from / 3600) * 3600; h0 < cutoff; h0 += 3600) {  // one hour at a time: bounded reads
    const { data, error } = await db.from("portfolio_equity").select("ts,seq").eq("portfolio_id", pid).gte("ts", iso(h0)).lt("ts", iso(h0 + 3600));
    if (error) throw new Error(`portfolio_equity range: ${error.message}`);
    const rows = ((data ?? []) as { ts: string; seq: number }[]).map((r) => ({ t: sec(r.ts), seq: r.seq, iso: r.ts }));
    if (rows.length < 2) continue;
    const keep = rows.reduce((k, r) => (r.t > k.t || (r.t === k.t && r.seq > k.seq) ? r : k));
    const drop = rows.filter((r) => r !== keep);
    for (const t of [...new Set(drop.map((r) => r.iso))]) { const seqs = drop.filter((r) => r.iso === t).map((r) => r.seq); await w.del("portfolio_equity", (q) => q.eq("ts", t).in("seq", seqs)); }
  }
  return cutoff;
}
