/**
 * D13 fingerprint audit (docs/PHASE3_PLAN.md D13; docs/PORTFOLIO.md "Switch-on runbook"). Strictly read-only.
 *
 * D13 accepts that the runner never re-examines a decided signal whose Phase 2 record is final (`sim_terminal`) and
 * whose lot is closed or was never opened: the sweep stops recomputing such a signal, so its `computed_at` never moves
 * and change detection (§B2) never reads it again; rehydration (§B11) only looks at open lots. This audit measures what
 * that costs. For one portfolio it pages through `portfolio_decisions` by signal id, rebuilds every signal's request
 * *now* with the runner's own functions (loadBatchInputs → buildSignals → buildRequests with sourceFillIds), and
 * compares the current fingerprint with the stored `input_hash`.
 *
 * Every difference is put in exactly one class, using the runner's own rules (run.ts), first match wins:
 *   unexplained  (first) an entry whose fill time moved, unless it is the D13 case below: the runner rewinds to the new
 *                fill time, so a lot opened at the old time survives the replay (plan D18; docs/PORTFOLIO.md §11).
 *   nextRun      the next run re-examines it anyway: its execution row was rewritten after the change-detection point,
 *                or its lot is open (every run re-links open lots), or it sits after the watermark of a run that did
 *                not finish (the next run deletes and replays that range), or the sweep would rewrite its execution
 *                row now (its $100 record differs from the stored one, so computed_at will move next cycle).
 *   d13          the D13 case: the sweep never recomputes it (sim_terminal, or no ledger row) and its lot is closed or
 *                was never opened. Accepted by decision D13; reported with the earliest event a rewind would need.
 *   unexplained  anything else: nothing will ever re-examine it, and D13 does not cover it.
 * Decisions whose signal or execution row no longer exists are counted apart.
 *
 * Read-only by construction: only `select` reads (no insert / update / upsert / delete, no RPC, no lease, no cursor).
 * Bounded memory: one page of at most AUDIT_BATCH_MAX decisions and its inputs at a time, every IN list chunked
 * (selectIn), and at most AUDIT_EXAMPLES examples per class.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { MODES, type ModeName } from "../sim/config";
import { buildSignals, loadBatchInputs, recordHash, selectIn, simulateMode } from "../sim/run";
import { PortfolioConfigError, portfolioDefinitions, portfolioRunConfigFromEnv, type PortfolioDefinition, type PortfolioRunConfig } from "./config";
import { buildRequests, rewindPoint } from "./requests";

export const AUDIT_BATCH_MAX = 500;
export const AUDIT_EXAMPLES = 20;
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
}
export interface ClassSummary { count: number; earliestTs: number | null; earliestIso: string | null; examples: AuditExample[] }
export interface MissingSummary { signal: number; execution: number; examples: { signalId: string; kind: string; eventTs: number; missing: "signal" | "execution" }[] }
export interface DecisionAudit {
  portfolioId: string; mode: ModeName;
  /** The portfolios row exists (the runner has run for real at least once with this exact configuration). */
  found: boolean;
  nothingToAudit: boolean; message: string | null;
  watermark: number | null; changeDetectionSince: number | null; previousRunFinished: boolean | null;
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

const emptyClass = (): ClassSummary => ({ count: 0, earliestTs: null, earliestIso: null, examples: [] });

/** Audit one portfolio. Reads only. */
export async function auditDecisionInputs(db: SupabaseClient, def: PortfolioDefinition, opts: { batchSize?: number; now?: () => number } = {}): Promise<DecisionAudit> {
  const t0 = Date.now(); const now = opts.now ?? (() => Date.now() / 1000);
  const B = Math.max(1, Math.min(AUDIT_BATCH_MAX, opts.batchSize ?? AUDIT_BATCH_MAX)); const exec = MODES[def.mode];
  const out: DecisionAudit = { portfolioId: def.id, mode: def.mode, found: false, nothingToAudit: false, message: null, watermark: null, changeDetectionSince: null, previousRunFinished: null,
    checked: 0, matches: 0, mismatches: 0, classes: { d13: emptyClass(), nextRun: emptyClass(), unexplained: emptyClass() }, missing: { signal: 0, execution: 0, examples: [] }, inconclusive: null, batches: 0, maxBatchRows: 0, durationMs: 0 };
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
  const since = crashed ? (typeof run0?.stats?.runStartedAt === "number" ? run0.stats.runStartedAt : null) : started;
  out.watermark = W0; out.changeDetectionSince = since; out.previousRunFinished = started == null ? null : !crashed;
  const leaseHeld = (r: Record<string, any> | null) => { const u = secs(r?.lease_until); return u != null && u > now() ? `a portfolio run holds the lease (${r?.lease_owner ?? "?"}, until ${iso(Math.floor(u))})` : null; };
  const busy0 = leaseHeld(run0);

  const note = (cls: MismatchClass, ex: AuditExample) => {
    const c = out.classes[cls]; c.count++;
    if (c.earliestTs == null || ex.rewindTo < c.earliestTs) { c.earliestTs = ex.rewindTo; c.earliestIso = iso(ex.rewindTo); }
    if (c.examples.length < AUDIT_EXAMPLES) c.examples.push(ex);
  };

  let last = "";
  for (;;) {
    let q = db.from("portfolio_decisions").select("signal_id,kind,event_ts,input_hash").eq("portfolio_id", def.id);
    if (last) q = q.gt("signal_id", last);
    const page = (must(await q.order("signal_id", { ascending: true }).limit(B), "portfolio_decisions page") ?? []) as { signal_id: string; kind: string; event_ts: unknown; input_hash: string }[];
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
        if (out.missing.examples.length < AUDIT_EXAMPLES) out.missing.examples.push({ signalId: id, kind: d.kind, eventTs, missing });
        continue;
      }
      const r = reqs.get(id) ?? null; const current = r?.fingerprint ?? null;
      if (current === d.input_hash) { out.matches++; continue; }
      out.mismatches++;
      const parts = fingerprintParts(d.input_hash, current);
      // An entry change can move the fill in either direction: the earlier of the stored and the current time.
      const rewindTo = !r ? eventTs : parts.includes("entry") ? Math.min(eventTs, r.key.ts) : rewindPoint(d.input_hash, r) ?? eventTs;
      const x = execs.get(id)!; const l = ledger.get(id); const frozen = !l || l.sim_terminal === true;
      const st = lots.get(id); const lot: AuditExample["lot"] = !st ? "none" : OPEN.has(st) ? "open" : "closed";
      const computed = secs(x.computed_at);
      let cls: MismatchClass; let why: string;
      // A moved entry fill is not something the next run repairs: rewindPoint goes back to the *new* fill time, so a
      // lot opened at the old, earlier time survives in the restored checkpoint (plan D18; docs/PORTFOLIO.md §11).
      const moved = r != null && r.key.ts !== eventTs;
      if (moved && !(frozen && lot !== "open")) { cls = "unexplained"; why = `its entry fill time moved from ${iso(eventTs)} to ${iso(r!.key.ts)}; the runner does not replay a moved entry correctly (known limitation)`; }
      else if (since != null && computed != null && computed > since) { cls = "nextRun"; why = "its execution row was rewritten after the last run started, so the next run's change detection reads it"; }
      else if (lot === "open") { cls = "nextRun"; why = "its lot is open, and every run re-links open lots to their current exit and resolution (B11)"; }
      else if (crashed && (W0 == null || eventTs > W0)) { cls = "nextRun"; why = "it was decided after the watermark by a run that did not finish; the next run deletes and replays that range"; }
      else if (!frozen && simHash.get(id) !== (x.record_hash ?? undefined)) { cls = "nextRun"; why = "the sweep will rewrite its execution row on its next cycle (its $100 record changed); the runner then sees it"; }
      else if (frozen) { cls = "d13"; why = `${l ? "its Phase 2 record is final (sim_terminal)" : "it has no ledger row, so the sweep never recomputes it"} and its lot is ${lot === "closed" ? "closed" : "never opened"}: never re-examined (D13)`; }
      else { cls = "unexplained"; why = `nothing will re-examine it: the sweep's $100 record is unchanged and its lot is ${lot === "closed" ? "closed" : "never opened"}`; }
      note(cls, { signalId: id, kind: d.kind, eventTs, eventIso: iso(eventTs)!, parts, lot, rewindTo, rewindIso: iso(rewindTo)!, why });
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

/** Plain-English summary, one block per portfolio, then the verdict line. */
export function formatAudit(results: DecisionAudit[], exitCode: number): string {
  const L: string[] = ["Portfolio input audit (decision D13) — read-only: nothing was written.", ""];
  for (const r of results) {
    L.push(`${r.mode} (portfolio ${r.portfolioId})`);
    if (r.nothingToAudit) L.push(`  ${r.message}.`);
    else {
      L.push(`  as of watermark ${utc(r.watermark)} · ${n(r.checked)} decisions checked in ${n(r.batches)} page(s) · ${n(r.matches)} match · ${n(r.mismatches)} differ · ${n(r.missing.signal + r.missing.execution)} missing`);
      const cls: [MismatchClass, string][] = [["d13", "(a) D13 — final Phase 2 record, lot closed or never opened; never re-examined (accepted)"], ["nextRun", "(b) other — the next run re-examines these anyway"], ["unexplained", "(b) other — UNEXPLAINED: nothing will re-examine these"]];
      for (const [k, label] of cls) {
        const c = r.classes[k]; if (!c.count) continue;
        const parts = { entry: 0, exit: 0, resolution: 0 }; for (const e of c.examples) for (const p of e.parts) parts[p]++;
        L.push(`  ${label}: ${n(c.count)} · earliest affected event ${utc(c.earliestTs)} (what a replay would have to go back to)`);
        L.push(`    in the ${c.examples.length} example(s) below: entry differs in ${parts.entry}, exit in ${parts.exit}, resolution in ${parts.resolution}`);
        for (const e of c.examples.slice(0, 5)) L.push(`    · ${e.signalId.slice(0, 8)} ${e.kind} at ${utc(e.eventTs)} — ${e.parts.join("+")} differ(s); lot ${e.lot}; replay from ${utc(e.rewindTo)}`);
      }
      if (r.missing.signal) L.push(`  MISSING: ${n(r.missing.signal)} decision(s) whose signal no longer exists`);
      if (r.missing.execution) L.push(`  MISSING: ${n(r.missing.execution)} decision(s) whose ${r.mode} execution row no longer exists`);
    }
    if (r.inconclusive) L.push(`  INCONCLUSIVE: ${r.inconclusive}`);
    L.push("");
  }
  L.push(exitCode === AUDIT_EXIT.OK ? "Result: OK — every difference is explained (exit 0)."
    : exitCode === AUDIT_EXIT.INCONCLUSIVE ? "Result: INCONCLUSIVE — a run was in progress; run the audit again between cycles (exit 3)."
    : "Result: STOP — unexplained differences or missing rows (exit 1). Do not switch the feature on; see docs/PORTFOLIO.md, Troubleshooting.");
  return L.join("\n");
}

/**
 * The `npm run portfolio:audit` entry point. The configuration is validated before the database client is created, so
 * an unset or invalid PAPER_PORTFOLIO_CONFIG exits 2 without touching the database. Returns the exit code.
 */
export async function runAuditCli(env: Record<string, string | undefined>, deps: { db: () => SupabaseClient; log?: (m: string) => void; now?: () => number; batchSize?: number }): Promise<number> {
  const log = deps.log ?? console.log; const now = deps.now ?? (() => Date.now() / 1000);
  let cfg: PortfolioRunConfig | null;
  try { cfg = portfolioRunConfigFromEnv(env, Math.floor(now())); }
  catch (e) { log(`portfolio audit: invalid configuration — ${e instanceof PortfolioConfigError ? e.message : `PAPER_PORTFOLIO_CONFIG: ${(e as Error).message}`}. Nothing was read.`); return AUDIT_EXIT.CONFIG; }
  if (!cfg) { log("portfolio audit: PAPER_PORTFOLIO_CONFIG is not set, so there is no portfolio to audit. Run it with the worker's exact variables (e.g. `railway run npm run portfolio:audit`). Nothing was read."); return AUDIT_EXIT.CONFIG; }
  const dry = env.PAPER_PORTFOLIO_DRY_RUN;
  if (dry === "1") log("note: PAPER_PORTFOLIO_DRY_RUN=1 — a dry run writes no decisions, so this audit can only confirm the configuration and the portfolio ids. Run it again after the first real runs.\n");
  const results = await auditPortfolios(deps.db(), cfg, { now, batchSize: deps.batchSize });
  const code = auditExitCode(results);
  log(formatAudit(results, code));
  log(`\n--- JSON ---\n${JSON.stringify({ startTs: cfg.startIso, exitCode: code, portfolios: results }, null, 2)}`);
  return code;
}
