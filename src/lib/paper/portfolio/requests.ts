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
 *  - drops signals from before the portfolio's start (D4): a signal is excluded when its source trade (the wallet's
 *    own fill) OR its simulated fill is before `startTs`. The source time is the one that matters: a trade made before
 *    the start but detected (and so filled, in REALISTIC / CONSERVATIVE) after it is an old signal, and IDEAL, which
 *    fills at the source time, already excluded it. Checking both keeps every mode on the same set of signals;
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
    if (b.entry.sourceTs < opts.startTs || fillTs < opts.startTs) continue; // D4: traded or filled before the start
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
/** Short, stable content hash (sorted-key JSON → sha256). Also used by the runner for record hashes. */
export const stableHash = (v: unknown, len = 16) => createHash("sha256").update(stable(v)).digest("hex").slice(0, len);
const h = (v: unknown) => stableHash(v);

/** Market metadata as a decision input: `observedAt` (when it was fetched) is provenance, so a re-fetch with unchanged
 *  values must not look like a change (step 6 review, R8). Applies to the entry and to the exit, which reuses it. */
function decisionMarket(m: unknown): unknown {
  if (!m || typeof m !== "object") return m ?? null;
  const { observedAt: _fetched, ...rest } = m as Record<string, unknown>; return rest;
}

/**
 * `entry|exit@exitTs|resolution@resolutionTs`. Each part hashes only what can change that part of the decision; the
 * mark (unrealised value only) is never included, so a new 1h/6h/24h mark never causes a rewind or a write.
 */
export function fingerprint(s: BookSignal, exec: ExecConfig, pendingEntry: boolean, exitPendingTs: number | null): string {
  const entry = h({ kind: s.kind, wallet: s.wallet, conditionId: s.conditionId, tokenId: s.tokenId, sourceKey: s.sourceKey, entry: { ...s.entry, market: decisionMarket(s.entry.market) }, pending: pendingEntry });
  const exitTs = s.exit ? timeline(s.exit.triggerTs, s.exit.triggerEvalTs, exec).fillTs : exitPendingTs;
  const exit = s.exit || exitPendingTs != null ? h({ id: s.exitId, exit: s.exit ? { ...s.exit, market: decisionMarket(s.exit.market) } : null, pendingAt: exitPendingTs }) : "-";
  const res = s.resolution ? h(s.resolution) : "-";
  return `${entry}|${exit}@${exitTs ?? "-"}|${res}@${s.resolution?.ts ?? "-"}`;
}

// ───────────────────────────── D24: what "changed" means for a decision (compare side) ─────────────────────────────
/**
 * Decision D24 (docs/PHASE3_D24_ANALYSIS.md). A decision opens a lot iff it filled shares, i.e. its outcome is FILLED or
 * PARTIALLY_FILLED (`portfolio_decisions_fill_needs_shares`, migration 0008, states the same thing). Every other outcome
 * (REJECTED, UNFILLED, EXPIRED, INVALID, UNKNOWN) never opened a lot, and then the signal's own exit and resolution
 * cannot change any decision, lot or equity number (tests/phase3-d24.test.ts is the guard of that invariant).
 * An unknown or missing outcome is not "never opened": it is compared whole.
 */
export const LOT_OUTCOMES: ReadonlySet<string> = new Set(["FILLED", "PARTIALLY_FILLED"]);
const NO_LOT_OUTCOMES: ReadonlySet<string> = new Set(["REJECTED", "UNFILLED", "EXPIRED", "INVALID", "UNKNOWN"]);
export const neverOpenedLot = (outcome: string | null | undefined): boolean => outcome != null && NO_LOT_OUTCOMES.has(outcome);

/**
 * The stored `input_hash` as it is compared with a current fingerprint. For a decision that never opened a lot only the
 * entry part is compared, so its exit and resolution parts are taken from the current fingerprint (they cannot differ);
 * every other decision is compared whole. The stored value itself is never changed: an old-format hash (`…|-@-|-@-`) and
 * a whole hash agree on the entry part, so nothing needs re-hashing when this rule starts to apply.
 * THE one rule: the runner (change detection, rehydration, hash refresh) and the audit all go through it.
 */
export function comparableStoredHash(storedOutcome: string | null | undefined, storedHash: string | null, currentFingerprint: string): string | null {
  if (storedHash == null || !neverOpenedLot(storedOutcome)) return storedHash;
  const entry = storedHash.split("|", 1)[0], rest = currentFingerprint.slice(currentFingerprint.indexOf("|"));
  return `${entry}${rest}`;
}
/** Did the inputs of a stored decision change? Outcome-aware (D24): false for a no-lot decision whose entry part is equal. */
export function decisionInputsChanged(storedOutcome: string | null | undefined, storedHash: string | null, currentFingerprint: string): boolean {
  return comparableStoredHash(storedOutcome, storedHash, currentFingerprint) !== currentFingerprint;
}
/** `rewindPoint` for a stored decision: outcome-aware (D24). null when nothing that can affect it changed. */
export function decisionRewindPoint(storedOutcome: string | null | undefined, storedHash: string | null, next: PortfolioRequest): number | null {
  return rewindPoint(comparableStoredHash(storedOutcome, storedHash, next.fingerprint), next);
}

// ───────────────────────────── D26: change-detection safety margin ─────────────────────────────
/**
 * Change detection reads the rows the sweep stamped after the previous run's start, less this margin. `computed_at` is
 * stamped in the worker when the sweep builds the row, before the write commits, so a row stamped just before a run
 * starts can become visible just after it (two workers overlapping in a deploy). Re-reading a row is idempotent: it
 * changes no decision, lot, equity value or stored hash when nothing changed. Shared by the runner and the audit.
 */
export const CHANGE_DETECTION_MARGIN_SEC = 120;
/** The instant (seconds) after which `computed_at` is read by change detection, or null when there is no previous run. */
export const changeDetectionReadsFrom = (previousRunStart: number | null): number | null => (previousRunStart == null ? null : previousRunStart - CHANGE_DETECTION_MARGIN_SEC);

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
