/**
 * D13 fingerprint audit (docs/PHASE3_PLAN.md D13; docs/PORTFOLIO.md "Switch-on runbook"). Strictly read-only.
 *
 * D13 accepts that the runner never re-examines a decided signal whose Phase 2 record is final (`sim_terminal`) and
 * whose lot is closed: the sweep stops recomputing such a signal, so its `computed_at` never moves and change detection
 * (§B2) never reads it again; rehydration (§B11) only looks at open lots. This audit measures what that costs. For one
 * portfolio it pages through `portfolio_decisions` by signal id, rebuilds every signal's request *now* with the runner's
 * own functions (loadBatchInputs → buildSignals → buildRequests with sourceFillIds), and compares the current
 * fingerprint with the stored `input_hash` by the runner's own rule (requests.ts decisionInputsChanged, D24): a decision
 * that never opened a lot is compared on its entry part only, every other decision whole. A never-opened decision whose
 * exit or resolution moved is therefore not a difference at all (D13 no longer has to accept it); one whose entry part
 * differs is, and D13 does not cover it.
 *
 * Every difference is put in exactly one class, using the runner's own rules (run.ts), first match wins:
 *   unexplained  (first) an entry whose fill time moved, unless it is the D13 case below: the runner rewinds to the new
 *                fill time, so a lot opened at the old time survives the replay (plan D18; docs/PORTFOLIO.md §11).
 *   nextRun      the next run re-examines it anyway: its execution row was rewritten after the change-detection point
 *                (the last run's start less CHANGE_DETECTION_MARGIN_SEC, D26, exactly as the runner reads it),
 *                or its lot is open (every run re-links open lots), or it sits after the watermark of a run that did
 *                not finish (the next run deletes and replays that range), or the sweep would rewrite its execution
 *                row now (its $100 record differs from the stored one, so computed_at will move next cycle).
 *   d13          the D13 case: the sweep never recomputes it (sim_terminal, or no ledger row) and its lot is closed
 *                (closed lots only since D24). Accepted by decision D13; reported with the earliest event a rewind would need.
 *   unexplained  anything else: nothing will ever re-examine it, and D13 does not cover it.
 * Decisions whose signal or execution row no longer exists are counted apart.
 *
 * Read-only by construction: only `select` reads (no insert / update / upsert / delete, no RPC, no lease, no cursor).
 * Bounded memory: one page of at most AUDIT_BATCH_MAX decisions and its inputs at a time, every IN list chunked
 * (selectIn), and at most AUDIT_EXAMPLES examples per class (AUDIT_EXAMPLES_KEPT for the unexplained ones and the
 * missing rows, which are all printed, one line each).
 *
 * Output is built for a log service that drops lines above a rate (Railway: 500 lines/s): every summary line starts with
 * `[MODE portfolioId]`, each unexplained or missing example is ONE line, the full JSON is opt-in (`--json` /
 * `AUDIT_JSON=1`) and then paced or written to `--out`, and an inconclusive audit retries by itself (3 attempts, 90 s).
 * `--explain <signalId>` prints one signal's stored versus current fingerprint for every mode.
 */
import { writeFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MODES, type ModeName } from "../sim/config";
import { timeline } from "../sim/execute";
import { buildSignals, loadBatchInputs, recordHash, selectIn, simulateMode } from "../sim/run";
import { PortfolioConfigError, portfolioDefinitions, portfolioRunConfigFromEnv, type PortfolioDefinition, type PortfolioRunConfig } from "./config";
import { buildRequests, changeDetectionReadsFrom, comparableStoredHash, decisionInputsChanged, decisionRewindPoint, neverOpenedLot, CHANGE_DETECTION_MARGIN_SEC } from "./requests";

export const AUDIT_BATCH_MAX = 500;
export const AUDIT_EXAMPLES = 20;
/** Unexplained differences and missing rows: every one is reported (one line each), up to this many. */
export const AUDIT_EXAMPLES_KEPT = 50;
export const AUDIT_RETRY = { attempts: 3, gapMs: 90_000, leasePollMs: 5_000, leaseWaitMs: 120_000 } as const;
export const AUDIT_PACE_LINES = 200;
export type FingerprintPart = "entry" | "exit" | "resolution";
export type MismatchClass = "nextRun" | "d13" | "unexplained";
export const MISMATCH_CLASSES: MismatchClass[] = ["d13", "nextRun", "unexplained"];

export interface AuditExample {
  signalId: string; kind: string; eventTs: number; eventIso: string;
  /** Which part of the fingerprint differs (`entry|exit@ts|resolution@ts`); ["entry"] when no request can be rebuilt. */
  parts: FingerprintPart[];
  lot: "open" | "closed" | "none";
  /** The earliest event a replay would have to go back to for this signal. */
  rewindTo: number; rewindIso: string;
  why: string;
  /** The stored `input_hash` and the fingerprint the runner would compute now (null: no request can be built). */
  stored: string; current: string | null;
  /** The mode's `paper_executions.computed_at` (what change detection reads), `paper_ledger.sim_terminal`, the lot's state. */
  computedAt: string | null; simTerminal: boolean | null; lotState: string | null;
  /** `none`: the decision never opened a lot and only its exit / resolution differ, so those inputs cannot change any
   *  decision, lot or equity number (docs/PORTFOLIO.md §11, D24 analysis). `possible`: anything else. Since D24 such a
   *  difference is not reported at all, so a reported difference is `possible`; the field is kept so that a future
   *  regression of the rule shows up as `none` in the output instead of silently. */
  effect: "none" | "possible";
}
export interface ClassSummary { count: number; earliestTs: number | null; earliestIso: string | null; examples: AuditExample[]; /** how many of `count` have effect "none" */ inert: number }
export interface MissingExample { signalId: string; kind: string; eventTs: number; eventIso: string; missing: "signal" | "execution" }
export interface MissingSummary { signal: number; execution: number; examples: MissingExample[] }
export interface DecisionAudit {
  portfolioId: string; mode: ModeName;
  /** The portfolios row exists (the runner has run for real at least once with this exact configuration). */
  found: boolean;
  nothingToAudit: boolean; message: string | null;
  watermark: number | null; changeDetectionSince: number | null; previousRunFinished: boolean | null;
  /** Where the runner's change detection reads from: `changeDetectionSince` less the D26 margin. */
  changeDetectionReadsFrom: number | null;
  /** portfolio_runs.last_run_started_at (seconds), read at the start of the audit. */
  lastRunStartedAt: number | null;
  checked: number; matches: number; mismatches: number;
  classes: Record<MismatchClass, ClassSummary>;
  missing: MissingSummary;
  /** Set when a run was in progress during the audit: its figures may be half-written. Re-run between cycles. */
  inconclusive: string | null;
  batches: number; maxBatchRows: number; durationMs: number;
}

const iso = (s: number | null) => (s == null ? null : new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
/** Seconds (with fractions) from an ISO string or a Date (the pg driver returns Dates). */
const secs = (v: unknown): number | null => (v == null ? null : v instanceof Date ? v.getTime() / 1000 : Date.parse(String(v)) / 1000);
const OPEN = new Set(["OPEN", "PARTIALLY_EXITED"]);

/** Which parts of `entry|exit@ts|resolution@ts` differ. A missing fingerprint differs in the entry. */
export function fingerprintParts(stored: string, current: string | null): FingerprintPart[] {
  if (current == null) return ["entry"];
  const [ae, ax, ar] = stored.split("|"), [be, bx, br] = current.split("|");
  const out: FingerprintPart[] = [];
  if (ae !== be) out.push("entry"); if (ax !== bx) out.push("exit"); if (ar !== br) out.push("resolution");
  return out;
}

/** Per part, what is stored and what is current, for the parts that differ (`entry` is a hash, the others `hash@time`). */
export interface PartDiff { part: FingerprintPart; stored: string; current: string }
export function fingerprintPartDiffs(stored: string, current: string | null): PartDiff[] {
  const a = stored.split("|"), b = (current ?? "|-@-|-@-").split("|"); const names: FingerprintPart[] = ["entry", "exit", "resolution"];
  return fingerprintParts(stored, current).map((part) => { const i = names.indexOf(part); return { part, stored: a[i] ?? "?", current: current == null ? "(no request)" : b[i] ?? "?" }; });
}

const emptyClass = (): ClassSummary => ({ count: 0, earliestTs: null, earliestIso: null, examples: [], inert: 0 });


/** What the audit knows about one decision when it classes a difference (shared with --explain). */
interface ClassifyCtx {
  eventTs: number; request: { key: { ts: number } } | null; lot: AuditExample["lot"];
  computed: number | null; frozen: boolean; simHashDiffers: boolean;
  /** Where change detection reads from (already less the D26 margin). */
  since: number | null; crashed: boolean; W0: number | null;
}
/** The runner's own rules (run.ts), first match wins. Pure. */
function classify(c: ClassifyCtx): { cls: MismatchClass; why: string } {
  // A moved entry fill is not something the next run repairs: rewindPoint goes back to the *new* fill time, so a
  // lot opened at the old, earlier time survives in the restored checkpoint (plan D18; docs/PORTFOLIO.md §11).
  const moved = c.request != null && c.request.key.ts !== c.eventTs;
  const tail = c.lot === "closed" ? "closed" : "never opened";
  if (moved && !(c.frozen && c.lot === "closed")) return { cls: "unexplained", why: `its entry fill time moved from ${iso(c.eventTs)} to ${iso(c.request!.key.ts)}; the runner does not replay a moved entry correctly (known limitation)` };
  if (c.since != null && c.computed != null && c.computed > c.since) return { cls: "nextRun", why: `its execution row was rewritten after the last run started (less a ${CHANGE_DETECTION_MARGIN_SEC} s safety margin), so the next run's change detection reads it` };
  if (c.lot === "open") return { cls: "nextRun", why: "its lot is open, and every run re-links open lots to their current exit and resolution (B11)" };
  if (c.crashed && (c.W0 == null || c.eventTs > c.W0)) return { cls: "nextRun", why: "it was decided after the watermark by a run that did not finish; the next run deletes and replays that range" };
  if (!c.frozen && c.simHashDiffers) return { cls: "nextRun", why: "the sweep will rewrite its execution row on its next cycle (its $100 record changed); the runner then sees it" };
  if (c.frozen && c.lot === "closed") return { cls: "d13", why: "its Phase 2 record is final (sim_terminal) or it has no ledger row (never recomputed), and its lot is closed: never re-examined (D13)" };
  if (c.frozen) return { cls: "unexplained", why: `its Phase 2 record is final (or it has no ledger row) so it is never recomputed, and its lot is ${tail}; the entry part of its inputs changed, which D13 (closed lots only) does not cover` };
  return { cls: "unexplained", why: `nothing will re-examine it: the sweep's $100 record is unchanged (so computed_at never moves) and its lot is ${tail}; the changed input is one the $100 record does not contain` };
}

/** Audit one portfolio. Reads only. */
export async function auditDecisionInputs(db: SupabaseClient, def: PortfolioDefinition, opts: { batchSize?: number; now?: () => number } = {}): Promise<DecisionAudit> {
  const t0 = Date.now(); const now = opts.now ?? (() => Date.now() / 1000);
  const B = Math.max(1, Math.min(AUDIT_BATCH_MAX, opts.batchSize ?? AUDIT_BATCH_MAX)); const exec = MODES[def.mode];
  const out: DecisionAudit = { portfolioId: def.id, mode: def.mode, found: false, nothingToAudit: false, message: null, watermark: null, changeDetectionSince: null, previousRunFinished: null, changeDetectionReadsFrom: null,
    lastRunStartedAt: null, checked: 0, matches: 0, mismatches: 0, classes: { d13: emptyClass(), nextRun: emptyClass(), unexplained: emptyClass() }, missing: { signal: 0, execution: 0, examples: [] }, inconclusive: null, batches: 0, maxBatchRows: 0, durationMs: 0 };
  const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };

  const { data: p, error: pe } = await db.from("portfolios").select("id").eq("id", def.id).maybeSingle();
  if (pe) throw new Error(`portfolios read: ${pe.message}`);
  out.found = !!p;
  const readRun = async () => must(await db.from("portfolio_runs").select("lease_owner,lease_until,last_run_started_at,last_run_finished_at,last_watermark_ts,stats").eq("portfolio_id", def.id).maybeSingle(), "portfolio_runs read") as Record<string, any> | null;
  const run0 = await readRun();

  // The runner's own change-detection point (run.ts runOne): the last run's start, or — if that run did not finish —
  // the start of the last run that did. A crashed run's range after its recorded watermark is replayed wholesale.
  const started = secs(run0?.last_run_started_at), finished = secs(run0?.last_run_finished_at), W0 = secs(run0?.last_watermark_ts);
  const crashed = started != null && (finished == null || finished < started);
  const sinceStart = crashed ? (typeof run0?.stats?.runStartedAt === "number" ? run0.stats.runStartedAt : null) : started;
  const since = changeDetectionReadsFrom(sinceStart);                                          // D26: the runner reads from here
  out.lastRunStartedAt = started; out.watermark = W0; out.changeDetectionSince = sinceStart; out.changeDetectionReadsFrom = since; out.previousRunFinished = started == null ? null : !crashed;
  const leaseHeld = (r: Record<string, any> | null) => { const u = secs(r?.lease_until); return u != null && u > now() ? `a portfolio run holds the lease (${r?.lease_owner ?? "?"}, until ${iso(Math.floor(u))})` : null; };
  const busy0 = leaseHeld(run0);

  const note = (cls: MismatchClass, ex: AuditExample) => {
    const c = out.classes[cls]; c.count++; if (ex.effect === "none") c.inert++;
    if (c.earliestTs == null || ex.rewindTo < c.earliestTs) { c.earliestTs = ex.rewindTo; c.earliestIso = iso(ex.rewindTo); }
    if (c.examples.length < (cls === "unexplained" ? AUDIT_EXAMPLES_KEPT : AUDIT_EXAMPLES)) c.examples.push(ex);
  };

  let last = "";
  for (;;) {
    let q = db.from("portfolio_decisions").select("signal_id,kind,event_ts,outcome,input_hash").eq("portfolio_id", def.id);
    if (last) q = q.gt("signal_id", last);
    const page = (must(await q.order("signal_id", { ascending: true }).limit(B), "portfolio_decisions page") ?? []) as { signal_id: string; kind: string; event_ts: unknown; outcome: string; input_hash: string }[];
    if (!page.length) break;
    out.batches++; out.maxBatchRows = Math.max(out.maxBatchRows, page.length); last = String(page[page.length - 1].signal_id);
    const ids = page.map((d) => String(d.signal_id));

    // The runner's request builder, exactly (run.ts requestsFor): the sweep's loaders plus source_fill_id.
    const inp = await loadBatchInputs(db, ids);
    const fills = await selectIn<{ id: string; source_fill_id: string | null }>(ids, (c) => db.from("signals").select("id,source_fill_id").in("id", c as string[]));
    const sourceFillIds = new Map(fills.map((r) => [String(r.id), r.source_fill_id ?? null]));
    const built = buildSignals(inp);
    const reqs = new Map(buildRequests(built, inp, exec, { startTs: def.startTs, sourceFillIds }).map((r) => [r.signal.signalId, r]));
    const present = new Set(inp.signals.map((s) => String(s.id)));
    const execs = new Map((await selectIn<{ signal_id: string; computed_at: unknown; record_hash: string | null }>(ids, (c) => db.from("paper_executions").select("signal_id,computed_at,record_hash").eq("mode", def.mode).in("signal_id", c as string[]))).map((r) => [String(r.signal_id), r]));
    const ledger = new Map((await selectIn<{ signal_id: string; sim_terminal: boolean | null }>(ids, (c) => db.from("paper_ledger").select("signal_id,sim_terminal").in("signal_id", c as string[]))).map((r) => [String(r.signal_id), r]));
    const lots = new Map((await selectIn<{ signal_id: string; state: string }>(ids, (c) => db.from("portfolio_lots").select("signal_id,state").eq("portfolio_id", def.id).in("signal_id", c as string[]))).map((r) => [String(r.signal_id), r.state]));
    // What the sweep would write for this mode now (pure; the sweep's own function and hash), for rows it still visits.
    const swept = new Set(ids.filter((id) => { const l = ledger.get(id); return !!l && l.sim_terminal !== true; }));
    const simHash = new Map(simulateMode(built.filter((b) => swept.has(b.id)), inp, exec).records.map((r) => [String(r.signal_id), recordHash(r)]));

    for (const d of page) {
      const id = String(d.signal_id); const eventTs = Math.floor(secs(d.event_ts)!); out.checked++;
      if (!present.has(id) || !execs.has(id)) {
        const missing = !present.has(id) ? "signal" : "execution"; out.missing[missing]++;
        if (out.missing.examples.length < AUDIT_EXAMPLES_KEPT) out.missing.examples.push({ signalId: id, kind: d.kind, eventTs, eventIso: iso(eventTs)!, missing });
        continue;
      }
      const r = reqs.get(id) ?? null; const current = r?.fingerprint ?? null;
      if (current != null && !decisionInputsChanged(d.outcome, d.input_hash, current)) { out.matches++; continue; }   // the runner's rule (D24)
      out.mismatches++;
      const parts = fingerprintParts(comparableStoredHash(d.outcome, d.input_hash, current ?? "|-@-|-@-") ?? d.input_hash, current);
      // An entry change can move the fill in either direction: the earlier of the stored and the current time.
      const rewindTo = !r ? eventTs : parts.includes("entry") ? Math.min(eventTs, r.key.ts) : decisionRewindPoint(d.outcome, d.input_hash, r) ?? eventTs;
      const x = execs.get(id)!; const l = ledger.get(id); const frozen = !l || l.sim_terminal === true;
      const stLot = lots.get(id) ?? null; const lot: AuditExample["lot"] = !stLot ? "none" : OPEN.has(stLot) ? "open" : "closed";
      const computed = secs(x.computed_at);
      const { cls, why } = classify({ eventTs, request: r, lot, computed, frozen, simHashDiffers: !frozen && simHash.get(id) !== (x.record_hash ?? undefined), since, crashed, W0 });
      const effect: AuditExample["effect"] = neverOpenedLot(d.outcome) && lot === "none" && parts.every((p) => p !== "entry") ? "none" : "possible";
      note(cls, { signalId: id, kind: d.kind, eventTs, eventIso: iso(eventTs)!, parts, lot, rewindTo, rewindIso: iso(rewindTo)!, why, stored: d.input_hash, current, computedAt: computed == null ? null : iso(Math.floor(computed)), simTerminal: l ? l.sim_terminal === true : null, lotState: stLot, effect });
    }
    if (page.length < B) break;
  }

  const run1 = await readRun();
  const moved = secs(run1?.last_run_started_at) !== secs(run0?.last_run_started_at);
  const busy = busy0 ?? leaseHeld(run1) ?? (moved ? "a portfolio run started while the audit was reading" : null);
  if (busy) out.inconclusive = `${busy}; its rows may be half-written. Re-run the audit between two worker cycles.`;
  if (out.checked === 0) {
    out.nothingToAudit = true;
    out.message = out.found ? "nothing to audit: this portfolio has no decisions yet" : "nothing to audit: this portfolio has never run for real (no portfolios row). Either the feature is off or in dry run (a dry run writes nothing), or this configuration differs from the worker's (PAPER_PORTFOLIO_CONFIG and PAPER_SIZE_USD must match exactly)";
  }
  out.durationMs = Date.now() - t0;
  return out;
}

/** Audit every configured portfolio (one per mode). */
export async function auditPortfolios(db: SupabaseClient, cfg: PortfolioRunConfig, opts: { modes?: ModeName[]; batchSize?: number; now?: () => number } = {}): Promise<DecisionAudit[]> {
  const out: DecisionAudit[] = [];
  for (const def of portfolioDefinitions(cfg, opts.modes)) out.push(await auditDecisionInputs(db, def, opts));
  return out;
}

/** 0 clean · 1 unexplained differences or missing rows · 2 configuration unset/invalid · 3 inconclusive (run in progress). */
export const AUDIT_EXIT = { OK: 0, UNEXPECTED: 1, CONFIG: 2, INCONCLUSIVE: 3 } as const;
export function auditExitCode(results: DecisionAudit[]): number {
  if (results.some((r) => r.inconclusive)) return AUDIT_EXIT.INCONCLUSIVE;
  if (results.some((r) => r.classes.unexplained.count > 0 || r.missing.signal + r.missing.execution > 0)) return AUDIT_EXIT.UNEXPECTED;
  return AUDIT_EXIT.OK;
}

const n = (v: number) => v.toLocaleString("en-US");
const utc = (s: number | null) => (s == null ? "—" : `${new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
/** Every summary line starts with the mode and the whole portfolio id, so interleaved logs can be told apart. */
const tag = (r: { mode: string; portfolioId: string }) => `[${r.mode} ${r.portfolioId}]`;
const short = (v: string | null) => (v == null ? "-" : v);

/** One unexplained example, as one line. */
export function exampleLine(r: DecisionAudit, e: AuditExample): string {
  const diffs = fingerprintPartDiffs(e.stored, e.current).map((d) => `${d.part}: stored=${d.stored} current=${d.current}`).join(" ; ");
  return `${tag(r)} UNEXPLAINED signal=${e.signalId} kind=${e.kind} event=${e.eventIso} differs=${e.parts.join("+")} (${diffs}) row_computed_at=${short(e.computedAt)} sim_terminal=${e.simTerminal ?? "no-ledger-row"} lot=${e.lotState ?? "none"} last_run_started_at=${short(iso(r.lastRunStartedAt))} replay_from=${e.rewindIso} effect=${e.effect}`;
}
export function missingLine(r: DecisionAudit, e: MissingExample): string {
  return `${tag(r)} MISSING signal=${e.signalId} kind=${e.kind} event=${e.eventIso} missing=${e.missing} last_run_started_at=${short(iso(r.lastRunStartedAt))}`;
}

/** Compact summary: a few prefixed lines per portfolio, then every unexplained and missing example on one line, then the verdict. */
export function formatAudit(results: DecisionAudit[], exitCode: number): string {
  const L: string[] = ["[audit] Portfolio input audit (decision D13) — read-only: nothing was written."];
  for (const r of results) {
    const t = tag(r);
    if (r.nothingToAudit) L.push(`${t} ${r.message}.`);
    else {
      L.push(`${t} as of watermark ${utc(r.watermark)} · ${n(r.checked)} checked in ${n(r.batches)} page(s) · ${n(r.matches)} match · ${n(r.mismatches)} differ · ${n(r.missing.signal + r.missing.execution)} missing · last run started ${short(iso(r.lastRunStartedAt))}`);
      const cls: [MismatchClass, string][] = [["d13", "(a) D13 — final Phase 2 record, lot closed; never re-examined (accepted)"], ["nextRun", "(b) other — the next run re-examines these anyway"], ["unexplained", "(b) other — UNEXPLAINED: nothing will re-examine these"]];
      for (const [k, label] of cls) {
        const c = r.classes[k]; if (!c.count) continue;
        L.push(`${t} ${label}: ${n(c.count)} · earliest affected event ${utc(c.earliestTs)}${k === "unexplained" ? ` · no effect on any number (no lot ever opened, only exit/resolution differ; D24 should make this 0): ${n(c.inert)} of ${n(c.count)}` : ""}`);
      }
      if (r.missing.signal) L.push(`${t} MISSING: ${n(r.missing.signal)} decision(s) whose signal no longer exists`);
      if (r.missing.execution) L.push(`${t} MISSING: ${n(r.missing.execution)} decision(s) whose ${r.mode} execution row no longer exists`);
      for (const e of r.classes.unexplained.examples) L.push(exampleLine(r, e));
      if (r.classes.unexplained.count > r.classes.unexplained.examples.length) L.push(`${t} … ${n(r.classes.unexplained.count - r.classes.unexplained.examples.length)} more unexplained not listed (cap ${AUDIT_EXAMPLES_KEPT}); run with --json --out <file> for the rest`);
      for (const e of r.missing.examples) L.push(missingLine(r, e));
      if (r.missing.signal + r.missing.execution > r.missing.examples.length) L.push(`${t} … ${n(r.missing.signal + r.missing.execution - r.missing.examples.length)} more missing not listed (cap ${AUDIT_EXAMPLES_KEPT})`);
    }
    if (r.inconclusive) L.push(`${t} INCONCLUSIVE: ${r.inconclusive}`);
  }
  L.push(exitCode === AUDIT_EXIT.OK ? "[audit] Result: OK — every difference is explained (exit 0)."
    : exitCode === AUDIT_EXIT.INCONCLUSIVE ? "[audit] Result: INCONCLUSIVE — a run was in progress on every attempt; run the audit again between cycles (exit 3)."
    : "[audit] Result: STOP — unexplained differences or missing rows (exit 1). Do not switch the feature on; see docs/PORTFOLIO.md, Troubleshooting.");
  return L.join("\n");
}

// ───────────────────────────── --explain ─────────────────────────────
export interface ExplainMode {
  mode: ModeName; portfolioId: string; signalFound: boolean;
  decision: { outcome: string; reason: string | null; eventTs: number; eventIso: string; inputHash: string } | null;
  /** The fingerprint the runner would compute now, with what it is made of. */
  current: { fingerprint: string; pendingEntry: boolean; exitPendingTs: number | null; exitId: string | null; exitFillTs: number | null; resolutionTs: number | null; entryFillTs: number } | null;
  /** The parts that differ AND are compared (what the runner compares, D24). */
  parts: PartDiff[];
  /** Parts that differ but are not compared: the exit / resolution of a decision that never opened a lot (D24). Information only. */
  notCompared: PartDiff[];
  row: { computedAt: string | null; recordHash: string | null; status: string | null; state: string | null; fillTs: string | null } | null;
  simTerminal: boolean | null; lotState: string | null; lastRunStartedAt: number | null; lastRunFinishedAt: number | null; watermark: number | null;
  /** Would the runner's change detection read this row next run? (computed_at after the last run's start) */
  nextRunReadsRow: boolean | null;
  cls: MismatchClass | "match" | null; why: string; effect: AuditExample["effect"] | null;
}

/** One signal, every mode: stored input_hash versus the current request fingerprint. Reads only. */
export async function explainSignal(db: SupabaseClient, cfg: PortfolioRunConfig, signalId: string, opts: { modes?: ModeName[]; now?: () => number } = {}): Promise<ExplainMode[]> {
  const out: ExplainMode[] = [];
  const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  const inp = await loadBatchInputs(db, [signalId]);
  const fills = await selectIn<{ id: string; source_fill_id: string | null }>([signalId], (c) => db.from("signals").select("id,source_fill_id").in("id", c as string[]));
  const sourceFillIds = new Map(fills.map((r) => [String(r.id), r.source_fill_id ?? null]));
  const built = buildSignals(inp); const present = inp.signals.some((x) => String(x.id) === signalId);
  const ledgerRow = (await selectIn<{ signal_id: string; sim_terminal: boolean | null }>([signalId], (c) => db.from("paper_ledger").select("signal_id,sim_terminal").in("signal_id", c as string[])))[0] ?? null;
  for (const def of portfolioDefinitions(cfg, opts.modes)) {
    const exec = MODES[def.mode];
    const req = buildRequests(built, inp, exec, { startTs: def.startTs, sourceFillIds }).find((q) => q.signal.signalId === signalId) ?? null;
    const dec = must(await db.from("portfolio_decisions").select("kind,event_ts,outcome,reason,input_hash").eq("portfolio_id", def.id).eq("signal_id", signalId).maybeSingle(), "portfolio_decisions read") as Record<string, any> | null;
    const x = must(await db.from("paper_executions").select("signal_id,computed_at,record_hash,status,state,fill_ts").eq("mode", def.mode).eq("signal_id", signalId).maybeSingle(), "paper_executions read") as Record<string, any> | null;
    const lots = await selectIn<{ signal_id: string; state: string }>([signalId], (c) => db.from("portfolio_lots").select("signal_id,state").eq("portfolio_id", def.id).in("signal_id", c as string[]));
    const run = must(await db.from("portfolio_runs").select("last_run_started_at,last_run_finished_at,last_watermark_ts,stats").eq("portfolio_id", def.id).maybeSingle(), "portfolio_runs read") as Record<string, any> | null;
    const started = secs(run?.last_run_started_at), finished = secs(run?.last_run_finished_at), W0 = secs(run?.last_watermark_ts);
    const crashed = started != null && (finished == null || finished < started);
    const since = changeDetectionReadsFrom(crashed ? (typeof run?.stats?.runStartedAt === "number" ? run.stats.runStartedAt : null) : started);   // D26
    const stLot = lots[0]?.state ?? null; const lot: AuditExample["lot"] = !stLot ? "none" : OPEN.has(stLot) ? "open" : "closed";
    const computed = secs(x?.computed_at);
    const frozen = !ledgerRow || ledgerRow.sim_terminal === true;
    const base: ExplainMode = { mode: def.mode, portfolioId: def.id, signalFound: present, decision: null, current: null, parts: [], notCompared: [], row: null, simTerminal: ledgerRow ? ledgerRow.sim_terminal === true : null, lotState: stLot,
      lastRunStartedAt: started, lastRunFinishedAt: finished, watermark: W0, nextRunReadsRow: since != null && computed != null ? computed > since : null, cls: null, why: "", effect: null };
    if (x) base.row = { computedAt: computed == null ? null : iso(Math.floor(computed)), recordHash: x.record_hash ?? null, status: x.status ?? null, state: x.state ?? null, fillTs: x.fill_ts == null ? null : String(x.fill_ts) };
    if (req) base.current = { fingerprint: req.fingerprint, pendingEntry: req.pendingEntry, exitPendingTs: req.exitPendingTs, exitId: req.signal.exitId ?? null, exitFillTs: req.signal.exit ? timeline(req.signal.exit.triggerTs, req.signal.exit.triggerEvalTs, exec).fillTs : req.exitPendingTs, resolutionTs: req.signal.resolution?.ts ?? null, entryFillTs: req.key.ts };
    if (!present) { base.why = "the signal no longer exists"; out.push(base); continue; }
    if (!dec) { base.why = req ? "no decision stored for this signal in this portfolio (not decided yet, or excluded by D4)" : "no request can be built (excluded by D4: traded or filled before the start) and no decision is stored"; out.push(base); continue; }
    const eventTs = Math.floor(secs(dec.event_ts)!); base.decision = { outcome: dec.outcome, reason: dec.reason ?? null, eventTs, eventIso: iso(eventTs)!, inputHash: dec.input_hash };
    const stored = req ? comparableStoredHash(dec.outcome, dec.input_hash, req.fingerprint) ?? dec.input_hash : dec.input_hash;     // D24: the parts the runner compares
    base.parts = fingerprintParts(stored, req?.fingerprint ?? null).length ? fingerprintPartDiffs(stored, req?.fingerprint ?? null) : [];
    if (req) base.notCompared = fingerprintPartDiffs(dec.input_hash, req.fingerprint).filter((d) => !base.parts.some((p) => p.part === d.part));
    if (req && !decisionInputsChanged(dec.outcome, dec.input_hash, req.fingerprint)) { base.cls = "match"; base.why = req.fingerprint === dec.input_hash ? "the stored input_hash equals the current fingerprint" : `the decision never opened a lot (${dec.outcome}) and its entry part is unchanged; its exit / resolution parts are not compared (D24)`; out.push(base); continue; }
    let simDiffers = false;
    if (x && !frozen) simDiffers = simulateMode(built.filter((b) => b.id === signalId), inp, exec).records.map((r) => recordHash(r))[0] !== (x.record_hash ?? undefined);
    const { cls, why } = classify({ eventTs, request: req, lot, computed, frozen, simHashDiffers: simDiffers, since, crashed, W0 });
    base.cls = cls; base.why = why;
    base.effect = neverOpenedLot(dec.outcome) && lot === "none" && base.parts.every((d) => d.part !== "entry") ? "none" : "possible";
    out.push(base);
  }
  return out;
}

/** Explain output: one line per fact, each starting with the mode and portfolio id. */
export function formatExplain(signalId: string, rs: ExplainMode[]): string {
  const L: string[] = [`[explain] signal ${signalId} — read-only`];
  for (const r of rs) {
    const t = tag(r);
    if (!r.signalFound) { L.push(`${t} the signal does not exist`); continue; }
    L.push(`${t} decision: ${r.decision ? `${r.decision.outcome}${r.decision.reason ? ` (${r.decision.reason})` : ""} at ${r.decision.eventIso}` : "none stored"}`);
    if (r.decision) L.push(`${t} stored  input_hash: ${r.decision.inputHash}`);
    if (r.current) L.push(`${t} current fingerprint: ${r.current.fingerprint} · entry fill ${iso(r.current.entryFillTs)}${r.current.exitId ? ` · linked exit ${r.current.exitId} fills ${iso(r.current.exitFillTs)}${r.current.exitPendingTs != null ? " (price pending)" : ""}` : " · no linked exit"}${r.current.resolutionTs != null ? ` · resolution at ${iso(r.current.resolutionTs)}` : " · no resolution"}${r.current.pendingEntry ? " · entry price pending" : ""}`);
    else L.push(`${t} current fingerprint: none (no request can be built)`);
    for (const d of r.parts) L.push(`${t} differs in ${d.part}: stored=${d.stored} current=${d.current}`);
    for (const d of r.notCompared) L.push(`${t} not compared (the decision never opened a lot, D24) ${d.part}: stored=${d.stored} current=${d.current}`);
    L.push(`${t} execution row: ${r.row ? `${r.row.status}/${r.row.state} fill_ts=${r.row.fillTs} computed_at=${short(r.row.computedAt)} record_hash=${short(r.row.recordHash)}` : "none"} · sim_terminal=${r.simTerminal ?? "no-ledger-row"} · lot=${r.lotState ?? "none"} · last_run_started_at=${short(iso(r.lastRunStartedAt))} · next run reads this row: ${r.nextRunReadsRow == null ? "unknown" : r.nextRunReadsRow ? "yes" : "no"}`);
    L.push(`${t} verdict: ${r.cls ?? "n/a"}${r.effect ? ` · effect=${r.effect}` : ""} — ${r.why}`);
  }
  return L.join("\n");
}

// ───────────────────────────── the CLI ─────────────────────────────
export interface AuditCliOptions {
  json: boolean; out: string | null; explain: string | null; help: boolean; error: string | null;
}
/** `--json`, `--out <file>`, `--explain <signalId>`; `AUDIT_JSON=1` is `--json`. Unknown arguments are an error (exit 2), never ignored. */
export function parseAuditArgs(argv: string[], env: Record<string, string | undefined> = {}): AuditCliOptions {
  const o: AuditCliOptions = { json: env.AUDIT_JSON === "1", out: null, explain: null, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const eq = a.indexOf("="); const [flag, inline] = eq > 0 && a.startsWith("--") ? [a.slice(0, eq), a.slice(eq + 1)] : [a, null];
    const value = () => { if (inline != null) return inline; const v = argv[i + 1]; if (v == null || v.startsWith("--")) { o.error = `${flag} needs a value`; return null; } i++; return v; };
    if (flag === "--json") o.json = true;
    else if (flag === "--out") o.out = value();
    else if (flag === "--explain") o.explain = value();
    else if (flag === "--help" || flag === "-h") o.help = true;
    else o.error = `unknown argument ${JSON.stringify(a)}`;
  }
  if (!o.error && o.out && !o.json && !o.explain) o.json = true;          // --out only makes sense for the JSON
  return o;
}
export const AUDIT_USAGE = "usage: npm run portfolio:audit -- [--json] [--out <file>] [--explain <signalId>]   (AUDIT_JSON=1 is --json)";

/** Print lines in chunks of `pace` lines, one chunk per second, so a log service that drops bursts keeps every line. */
async function emit(log: (m: string) => void, lines: string[], pace: number, sleep: (ms: number) => Promise<void>) {
  for (let i = 0; i < lines.length; i += pace) { if (i > 0) await sleep(1000); log(lines.slice(i, i + pace).join("\n")); }
}

/** Wait (bounded polls, read only) until none of these portfolios holds a lease. */
async function waitForLease(db: SupabaseClient, ids: string[], now: () => number, sleep: (ms: number) => Promise<void>) {
  const polls = Math.ceil(AUDIT_RETRY.leaseWaitMs / AUDIT_RETRY.leasePollMs);
  for (let i = 0; i < polls; i++) {
    let held = false;
    for (const id of ids) { const { data } = await db.from("portfolio_runs").select("lease_until").eq("portfolio_id", id).maybeSingle(); const u = secs((data as Record<string, any> | null)?.lease_until); if (u != null && u > now()) held = true; }
    if (!held) return; await sleep(AUDIT_RETRY.leasePollMs);
  }
}

export interface AuditCliDeps {
  db: () => SupabaseClient; log?: (m: string) => void; now?: () => number; batchSize?: number;
  argv?: string[]; sleep?: (ms: number) => Promise<void>; writeFile?: (path: string, text: string) => void;
  /** Test hooks: attempts and gap between them (defaults: 3 attempts, 90 s). */
  attempts?: number; retryGapMs?: number; pace?: number;
}

/**
 * The `npm run portfolio:audit` entry point. The configuration is validated before the database client is created, so
 * an unset or invalid PAPER_PORTFOLIO_CONFIG exits 2 without touching the database. Returns the exit code.
 */
export async function runAuditCli(env: Record<string, string | undefined>, deps: AuditCliDeps): Promise<number> {
  const log = deps.log ?? console.log; const now = deps.now ?? (() => Date.now() / 1000);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const writeFile = deps.writeFile ?? ((p: string, t: string) => writeFileSync(p, t));
  const pace = deps.pace ?? AUDIT_PACE_LINES;
  const args = parseAuditArgs(deps.argv ?? [], env);
  if (args.error || args.help) { log(`${args.error ? `portfolio audit: ${args.error}. ` : ""}${AUDIT_USAGE}. Nothing was read.`); return args.error ? AUDIT_EXIT.CONFIG : AUDIT_EXIT.OK; }
  let cfg: PortfolioRunConfig | null;
  try { cfg = portfolioRunConfigFromEnv(env, Math.floor(now())); }
  catch (e) { log(`portfolio audit: invalid configuration — ${e instanceof PortfolioConfigError ? e.message : `PAPER_PORTFOLIO_CONFIG: ${(e as Error).message}`}. Nothing was read.`); return AUDIT_EXIT.CONFIG; }
  if (!cfg) { log("portfolio audit: PAPER_PORTFOLIO_CONFIG is not set, so there is no portfolio to audit. Run it with the worker's exact variables (e.g. `railway run npm run portfolio:audit`). Nothing was read."); return AUDIT_EXIT.CONFIG; }
  const dry = env.PAPER_PORTFOLIO_DRY_RUN;
  if (dry === "1") log("note: PAPER_PORTFOLIO_DRY_RUN=1 — a dry run writes no decisions, so this audit can only confirm the configuration and the portfolio ids. Run it again after the first real runs.");
  const db = deps.db();

  if (args.explain) {
    const rs = await explainSignal(db, cfg, args.explain, { now });
    const lines = formatExplain(args.explain, rs).split("\n");
    if (args.json) lines.push(...JSON.stringify({ signalId: args.explain, modes: rs }, null, 2).split("\n"));
    await emit(log, lines, pace, sleep);
    return rs.some((r) => r.signalFound) ? AUDIT_EXIT.OK : AUDIT_EXIT.UNEXPECTED;
  }

  // An audit that overlapped a worker cycle is inconclusive by design: retry those modes, up to `attempts` times, waiting
  // for the lease to be free. Exit 3 only if every attempt was inconclusive.
  const attempts = Math.max(1, deps.attempts ?? AUDIT_RETRY.attempts); const gap = deps.retryGapMs ?? AUDIT_RETRY.gapMs;
  let results = await auditPortfolios(db, cfg, { now, batchSize: deps.batchSize }); let attempt = 1;
  while (results.some((r) => r.inconclusive) && attempt < attempts) {
    const pending = results.filter((r) => r.inconclusive);
    log(`[audit] attempt ${attempt}/${attempts}: ${pending.map((r) => `${r.mode} inconclusive`).join(", ")} (a run held the lease or started while the audit was reading); retrying in ${Math.round(gap / 1000)} s`);
    await sleep(gap); await waitForLease(db, pending.map((r) => r.portfolioId), now, sleep);
    const again = await auditPortfolios(db, cfg, { now, batchSize: deps.batchSize, modes: pending.map((r) => r.mode) });
    results = results.map((r) => again.find((a) => a.mode === r.mode) ?? r); attempt++;
  }
  const code = auditExitCode(results);
  const lines = formatAudit(results, code).split("\n"); lines.splice(lines.length - 1, 0, `[audit] attempts: ${attempt} of ${attempts}`);
  const payload = JSON.stringify({ startTs: cfg.startIso, exitCode: code, attempts: attempt, portfolios: results }, null, 2);
  if (args.json && args.out) { writeFile(args.out, payload + "\n"); lines.splice(lines.length - 1, 0, `[audit] full JSON written to ${args.out}`); }
  else if (args.json) lines.push("--- JSON ---", ...payload.split("\n"));
  else lines.splice(lines.length - 1, 0, "[audit] full JSON not printed: add --json (paced) or --json --out <file>");
  await emit(log, lines, pace, sleep);
  return code;
}
