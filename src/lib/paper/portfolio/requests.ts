/**
 * Signals → portfolio requests (docs/PHASE3_PLAN.md §B5, §B2, §B3; step 5).
 *
 * Input is what the Phase 2 sweep already loads for a batch (loadBatchInputs → buildSignals). For one execution mode this
 * attaches exactly the price observations simulateMode would use, so a request fills the way that mode's record did,
 * but at the portfolio's own size. It also:
 *  - chooses the duplicate key: `fill:<source_fill_id>` when the signal has one, else the legacy sourceKey (wallet |
 *    token | source second | price), which wrongly merges ~0.7% of distinct fills (plan R4);
 *  - never guesses a missing price: an entry whose price is not fetched yet is `pendingEntry`, and an exit whose price
 *    is not fetched yet is left off the request with `exitPendingTs` — the runner decides nothing at or after either
 *    (the per-event frontier, §B3; a pending exit does not hold back entries before it);
 *  - drops signals whose fill is before the portfolio's start (D4);
 *  - fingerprints the decision inputs (never marks) so the runner can tell what changed and where to rewind to (§B2).
 * D1 needs nothing here: every request is its own lot; two signals from one fill share a duplicate key, so the book
 * takes the first by event order (NEW_POSITION before CONSENSUS) and records the other as REJECTED_DUPLICATE_POSITION.
 */
import { createHash } from "node:crypto";
import type { ExecConfig } from "../sim/config";
import { timeline } from "../sim/execute";
import { exitInputFor, type BuiltSignal, type SimInputs } from "../sim/run";
import { KIND_ORDER, cmpKey, entryKey } from "./book";
import type { BookSignal, EventKey } from "./types";

export interface PortfolioRequest {
  signal: BookSignal;
  key: EventKey;
  /** Entry price not fetched yet: this request (and everything after it) cannot be decided. */
  pendingEntry: boolean;
  /** Linked exit whose price is not fetched yet: its fill time. The exit is left off `signal` until the price arrives. */
  exitPendingTs: number | null;
  /** Decision inputs only, as `entry|exit@ts|resolution@ts` (see fingerprint()). Stored as portfolio_decisions.input_hash. */
  fingerprint: string;
}

/** The duplicate key: the source fill when known, else the legacy key built by buildSignals. */
export function duplicateKey(b: Pick<BuiltSignal, "sourceKey">, sourceFillId: string | null | undefined): string {
  return sourceFillId ? `fill:${sourceFillId}` : b.sourceKey;
}

export function buildRequests(built: BuiltSignal[], inp: SimInputs, exec: ExecConfig, opts: { startTs: number; sourceFillIds?: Map<string, string | null> }): PortfolioRequest[] {
  const out: PortfolioRequest[] = [];
  for (const b of built) {
    const fillTs = timeline(b.entry.sourceTs, b.entry.evalTs, exec).fillTs;
    if (fillTs < opts.startTs) continue;                                   // D4: before the portfolio existed
    const k = `${b.tokenId}@${fillTs}`;
    const pendingEntry = !exec.fillAtSignalPrice && !inp.obs.has(k);
    const entry = { ...b.entry, obs: exec.fillAtSignalPrice ? null : inp.obs.get(k) ?? null };
    let exit: BookSignal["exit"] = null; let exitId: string | null = null; let exitPendingTs: number | null = null;
    if (b.exitSignal) {
      const x = exitInputFor(b.exitSignal, inp, b.entry.market); const xTs = timeline(x.triggerTs, x.triggerEvalTs, exec).fillTs; const xk = `${b.tokenId}@${xTs}`;
      if (!exec.fillAtSignalPrice && !inp.obs.has(xk)) exitPendingTs = xTs;
      else { exit = { ...x, obs: exec.fillAtSignalPrice ? null : inp.obs.get(xk) ?? null }; exitId = String(b.exitSignal.id); }
    }
    const signal: BookSignal = { signalId: b.id, kind: b.kind, wallet: b.wallet, conditionId: b.conditionId, tokenId: b.tokenId,
      sourceKey: duplicateKey(b, opts.sourceFillIds?.get(b.id)), entry, exit, exitId, resolution: b.resolution, mark: b.mark };
    out.push({ signal, key: entryKey(signal, exec), pendingEntry, exitPendingTs, fingerprint: fingerprint(signal, exec, pendingEntry, exitPendingTs) });
  }
  return out;
}

/** Event order for submitting to the book. The database streams by (fill_ts, signal_id); within one second the book
 *  also orders by kind, so rows sharing a fill time must be re-sorted with this before submission. */
export function orderRequests(reqs: PortfolioRequest[]): PortfolioRequest[] { return [...reqs].sort((a, b) => cmpKey(a.key, b.key)); }

/** Earliest event that cannot be decided yet (per-event frontier, §B3), or null when everything is decidable. */
export function frontierOf(reqs: PortfolioRequest[]): EventKey | null {
  let f: EventKey | null = null;
  const take = (k: EventKey) => { if (!f || cmpKey(k, f) < 0) f = k; };
  for (const r of reqs) { if (r.pendingEntry) take(r.key); if (r.exitPendingTs != null) take({ ts: r.exitPendingTs, order: KIND_ORDER.EXIT, id: r.key.id }); }
  return f;
}

// ───────────────────────────── fingerprints (§B2) ─────────────────────────────
/** JSON with keys sorted at every level, so equal inputs always give equal text. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
const h = (v: unknown) => createHash("sha256").update(stable(v)).digest("hex").slice(0, 16);

/**
 * `entry|exit@exitTs|resolution@resolutionTs`. Each part hashes only what can change that part of the decision; the
 * mark (unrealised value only) is never included, so a new 1h/6h/24h mark never causes a rewind or a write.
 */
export function fingerprint(s: BookSignal, exec: ExecConfig, pendingEntry: boolean, exitPendingTs: number | null): string {
  const entry = h({ kind: s.kind, wallet: s.wallet, conditionId: s.conditionId, tokenId: s.tokenId, sourceKey: s.sourceKey, entry: s.entry, pending: pendingEntry });
  const exitTs = s.exit ? timeline(s.exit.triggerTs, s.exit.triggerEvalTs, exec).fillTs : exitPendingTs;
  const exit = s.exit || exitPendingTs != null ? h({ id: s.exitId, exit: s.exit, pendingAt: exitPendingTs }) : "-";
  const res = s.resolution ? h(s.resolution) : "-";
  return `${entry}|${exit}@${exitTs ?? "-"}|${res}@${s.resolution?.ts ?? "-"}`;
}

/**
 * Where to rewind to when a request's inputs changed: the entry's fill time if the entry changed, else the earlier of
 * the old and new times of whatever changed (exit, resolution). null when nothing that affects a decision changed.
 */
export function rewindPoint(oldFp: string | null, next: PortfolioRequest): number | null {
  if (oldFp === next.fingerprint) return null;
  if (oldFp == null) return next.key.ts;                                     // never decided before
  const parse = (fp: string) => { const [entry, exit, res] = fp.split("|"); const [xh, xt] = exit.split("@"); const [rh, rt] = res.split("@"); const n = (t: string) => (t === "-" ? null : Number(t)); return { entry, xh, xt: n(xt), rh, rt: n(rt) }; };
  const a = parse(oldFp), b = parse(next.fingerprint);
  if (a.entry !== b.entry) return next.key.ts;
  const times: number[] = [];
  if (a.xh !== b.xh || a.xt !== b.xt) for (const t of [a.xt, b.xt]) if (t != null) times.push(t);
  if (a.rh !== b.rh || a.rt !== b.rt) for (const t of [a.rt, b.rt]) if (t != null) times.push(t);
  return times.length ? Math.max(next.key.ts, Math.min(...times)) : next.key.ts;
}
