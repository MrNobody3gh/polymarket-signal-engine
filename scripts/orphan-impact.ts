/**
 * Read-only impact report for the orphan resolver (Phase 3 step 3, D3).
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_READ_KEY=<publishable or anon key> npx tsx scripts/orphan-impact.ts [out.md]
 *
 * Writes nothing to the database. It reads the open simulated positions whose token nobody watches (the same rule as
 * orphan_resolution_candidates in migration 0009), asks Polymarket for each token's resolution through the resolver's
 * own decision function, and applies the answers to the stored execution records with the lifecycle arithmetic in
 * src/lib/paper/orphan-impact.ts (checked against simulateMode in tests/phase3.test.ts). Every record must first
 * reproduce its stored P&L exactly, or it is reported and left out.
 */
import { writeFileSync } from "node:fs";
import { PolymarketClient } from "../src/lib/polymarket/client";
import { gammaSource } from "../src/lib/paper/mark";
import { orphanOutcome, type OrphanCheckState } from "../src/lib/paper/resolve-orphans";
import { ensureTokenOrder, gammaMarket } from "../src/lib/polymarket/token-order";
import { parseGammaResolution } from "../src/lib/paper/mark";
import { recompute, reproductionError, type ExecRecordLite } from "../src/lib/paper/orphan-impact";

const URL_ = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL; const KEY = process.env.SUPABASE_READ_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) throw new Error("set SUPABASE_URL and SUPABASE_READ_KEY (the publishable/anon key is enough: every table read here is public-read)");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function get<T>(path: string): Promise<T> {
  for (let a = 1; ; a++) {
    const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: H });
    if (r.ok) return (await r.json()) as T;
    if (a >= 4 || (r.status < 500 && r.status !== 429)) throw new Error(`GET ${path.slice(0, 120)} → ${r.status} ${(await r.text()).slice(0, 200)}`);
    await new Promise((x) => setTimeout(x, 1000 * 2 ** a));
  }
}
async function all<T>(path: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) { const page = await get<T[]>(`${path}${path.includes("?") ? "&" : "?"}order=${order}&limit=1000&offset=${off}`); out.push(...page); if (page.length < 1000) return out; }
}
async function rpc<T>(fn: string, body: unknown): Promise<T> {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`rpc ${fn} → ${r.status} ${(await r.text()).slice(0, 200)}`); return (await r.json()) as T;
}

type Row = ExecRecordLite & { coverage_state: string; signals: { token_id: string; condition_id: string | null; outcome: string | null; paper_ledger: { status: string } | null } };
const FIELDS = "signal_id,mode,state,coverage_state,fill_ts,filled_shares,filled_usd,entry_fee,fees_total,exit_status,exit_fill_ts,exit_sold_shares,exit_fill_price,exit_fee,open_shares,mark_price,mark_ts,gross_pnl,net_pnl,realized_pnl,unrealized_pnl";
const MODES = ["IDEAL", "REALISTIC", "CONSERVATIVE"] as const;
const $ = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pc = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

(async () => {
  const now = Math.floor(Date.now() / 1000); const t0 = Date.now();
  // 1. what is watched or already resolved, and every open simulated position
  const watched = new Set((await all<{ token_id: string }>("paper_ledger?select=token_id&status=eq.OPEN", "signal_id")).map((r) => r.token_id));
  const resolvedAlready = new Set((await all<{ token_id: string }>("token_resolutions?select=token_id", "token_id")).map((r) => r.token_id));
  const open = await all<Row>(`paper_executions?select=${FIELDS},signals(token_id,condition_id,outcome,paper_ledger(status))&coverage_state=eq.SIMULATED&state=in.(OPEN,PARTIALLY_EXITED)`, "signal_id,mode");
  const orphans = open.filter((r) => r.signals && !watched.has(r.signals.token_id) && !resolvedAlready.has(r.signals.token_id));
  console.log(`read ${open.length} open simulated positions; ${orphans.length} on ${new Set(orphans.map((o) => o.signals.token_id)).size} unwatched, unresolved tokens`);

  // 2. ask Polymarket, exactly as the resolver does
  const tokens = new Map<string, { condition: string | null; outcome: string | null }>();
  for (const o of orphans) if (!tokens.has(o.signals.token_id)) tokens.set(o.signals.token_id, { condition: o.signals.condition_id?.toLowerCase() || null, outcome: o.signals.outcome });
  // Token order exactly as the worker gets it (ensureTokenOrder), but read-only: served to gammaSource from memory, never written.
  const pm = new PolymarketClient(); const valid0 = (c: string | null) => !!c && /^0x[0-9a-f]{64}$/.test(c);
  const order = await ensureTokenOrder(null, [...tokens.values()].map((v) => v.condition).filter(valid0) as string[], { client: pm, write: false, concurrency: 6 });
  console.log(`token order: ${order.fetched} markets found on Gamma, ${order.missing.length} not found`);
  const cache = { from: () => ({ select: () => ({ eq: (_k: string, v: string) => ({ maybeSingle: async () => ({ data: order.orders.has(v) ? { clob_token_ids: order.orders.get(v) } : null, error: null }) }) }), upsert: async () => ({ error: null }) }) };
  const src = gammaSource(pm, cache as never); const labels = (src as unknown as { _outcomes: Map<string, string> })._outcomes;
  for (const [t, v] of tokens) if (v.outcome) labels.set(t, v.outcome);
  const valid = (c: string | null) => !!c && /^0x[0-9a-f]{64}$/.test(c);
  await src.prefetch!([...new Set([...tokens.values()].map((v) => v.condition).filter(valid) as string[])]);
  const answer = new Map<string, { state: OrphanCheckState | "NO_CONDITION_ID"; reason: string | null; value?: number; ts?: number }>();
  const list = [...tokens.entries()]; let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (i < list.length) { const [t, v] = list[i++];
    if (!valid(v.condition)) { answer.set(t, { state: "NO_CONDITION_ID", reason: v.condition ? `malformed condition id ${v.condition}` : "condition id missing on the signal" }); continue; }
    try { const o = orphanOutcome({ token_id: t, condition_id: v.condition! }, await src.resolution(v.condition!, t), now); answer.set(t, { state: o.state, reason: o.reason, value: o.obs?.value, ts: o.obs ? Math.floor(Date.parse(o.obs.resolved_ts) / 1000) : undefined }); }
    catch (e) { answer.set(t, { state: "UNKNOWN", reason: `lookup_failed: ${(e as Error).message.slice(0, 100)}` }); } } }));

  // 2b. sensitivity only (not what the resolver does): neg-risk markets settled by UMA come back from /v2/resolutions with
  // status "resolved" but no payouts and no resolved_at. Gamma's closed-market record has the final outcome prices and
  // umaEndDate. D2 as approved needs an on-chain resolved_at, so the resolver leaves these unsettled; this computes what
  // accepting Gamma's UMA time would change, and how far that time is from the v2 row's last_update_timestamp.
  const gammaAlt = new Map<string, { value: number; ts: number; driftSec: number | null }>();
  const needAlt = [...answer.entries()].filter(([, a]) => a.state === "UNKNOWN" && a.reason === "resolved_but_token_value_unknown").map(([t]) => t);
  const v2Rows = new Map<string, Record<string, unknown>>();
  const altConds = [...new Set(needAlt.map((t) => tokens.get(t)!.condition!))];
  for (let k = 0; k < altConds.length; k += 20) for (const r of await pm.resolutions(altConds.slice(k, k + 20))) v2Rows.set(String(r.condition_id).toLowerCase(), r);
  let j = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (j < needAlt.length) { const t = needAlt[j++]; const c = tokens.get(t)!.condition!;
    try { const m = await gammaMarket(pm, c); const g = parseGammaResolution(m, t); const at = Date.parse(String(m?.umaEndDate ?? "")) / 1000;
      if (g.state === "resolved" && String(m?.umaResolutionStatus) === "resolved" && Number.isFinite(at)) {
        const lu = Number(v2Rows.get(c)?.last_update_timestamp); gammaAlt.set(t, { value: g.finalPrice, ts: Math.floor(at), driftSec: Number.isFinite(lu) ? Math.round(at - lu) : null }); }
    } catch { /* stays unanswered */ } } }));

  // 3. apply to every orphaned record, once per scenario
  type Ans = { state: string; value?: number; ts?: number };
  type Agg = { rows: number; notReproduced: number; resolvedRows: number; settled: number; wins: number; losses: number; stillOpen: number; resolvedBeforeFill: number; exitVoided: number; incomplete: number; netBefore: number; netAfter: number; realizedDelta: number; unrealizedDelta: number };
  const blank = (): Agg => ({ rows: 0, notReproduced: 0, resolvedRows: 0, settled: 0, wins: 0, losses: 0, stillOpen: 0, resolvedBeforeFill: 0, exitVoided: 0, incomplete: 0, netBefore: 0, netAfter: 0, realizedDelta: 0, unrealizedDelta: 0 });
  let maxErr = 0; for (const r of orphans) maxErr = Math.max(maxErr, reproductionError(r));
  function project(ans: (token: string) => Ans) {
    const agg: Record<string, { live: Agg; frozen: Agg }> = Object.fromEntries(MODES.map((m) => [m, { live: blank(), frozen: blank() }]));
    for (const r of orphans) {
      const a = agg[r.mode][r.signals.paper_ledger ? "live" : "frozen"]; a.rows++;
      if (reproductionError(r) > 1e-6) { a.notReproduced++; continue; }
      const x = ans(r.signals.token_id); if (x.state !== "RESOLVED") { a.stillOpen++; continue; }
      a.resolvedRows++;
      const after = recompute(r, { ts: x.ts!, value: x.value! }); const before = recompute(r, null);
      if (after.resolutionIgnored) a.resolvedBeforeFill++; if (after.exitVoided) a.exitVoided++;
      if (after.incomplete) { a.incomplete++; continue; }
      a.netBefore += before.netPnl; a.netAfter += after.netPnl; a.realizedDelta += after.realizedPnl - before.realizedPnl; a.unrealizedDelta += after.unrealizedPnl - before.unrealizedPnl;
      if (after.state === "RESOLVED") { a.settled++; if (after.netPnl > 0) a.wins++; else if (after.netPnl < 0) a.losses++; } else a.stillOpen++;
    }
    return agg;
  }
  const strict = project((t) => answer.get(t) as Ans);
  const withUma = project((t) => { const g = gammaAlt.get(t); return g ? { state: "RESOLVED", value: g.value, ts: g.ts } : (answer.get(t) as Ans); });

  // 4. mode totals: today's report plus the change on records the sweep will revisit (not the frozen ones)
  const reports: Record<string, any> = {}; for (const m of MODES) reports[m] = (await rpc<{ overall: any }>("paper_exec_report", { p_mode: m })).overall;
  const totals = (agg: ReturnType<typeof project>) => Object.fromEntries(MODES.map((m) => { const o = reports[m], d = agg[m].live; const settled = Number(o.settled); const winsBefore = o.winRate == null ? 0 : Math.round(Number(o.winRate) * settled);
    return [m, { before: { netPnl: Number(o.netPnl), realizedPnl: Number(o.realizedPnl), unrealizedPnl: Number(o.unrealizedPnl), settled, winRate: o.winRate == null ? null : Number(o.winRate) },
      after: { netPnl: Number(o.netPnl) + (d.netAfter - d.netBefore), realizedPnl: Number(o.realizedPnl) + d.realizedDelta, unrealizedPnl: Number(o.unrealizedPnl) + d.unrealizedDelta, settled: settled + d.settled, winRate: settled + d.settled ? (winsBefore + d.wins) / (settled + d.settled) : null } }]; })) as Record<string, { before: any; after: any }>;
  const tStrict = totals(strict), tUma = totals(withUma);

  // 5. report
  const tokState: Record<string, number> = {}; for (const v of answer.values()) tokState[v.state] = (tokState[v.state] ?? 0) + 1;
  const reasons: Record<string, number> = {}; for (const v of answer.values()) if (v.state === "UNKNOWN" || v.state === "NO_RESOLVED_TIME") { const k = `${v.state}: ${(v.reason ?? "-").replace(/: .*/, "")}`; reasons[k] = (reasons[k] ?? 0) + 1; }
  const drifts = [...gammaAlt.values()].map((g) => g.driftSec).filter((d): d is number => d != null).map(Math.abs).sort((a, b) => a - b);
  const q = (p: number) => (drifts.length ? drifts[Math.min(drifts.length - 1, Math.floor(p * drifts.length))] : null);
  const posTable = (agg: ReturnType<typeof project>) => {
    const L = [`| Mode | Group | Positions | Token resolved | Settled | Wins / losses | Net P&L before | Net P&L after | Change | Resolved before our fill (stays open) | Exit voided |`, `|---|---|---|---|---|---|---|---|---|---|---|`];
    for (const m of MODES) for (const g of ["live", "frozen"] as const) { const a = agg[m][g]; if (!a.rows) continue;
      L.push(`| ${m} | ${g === "live" ? "**Revisited**" : "Frozen"} | ${a.rows} | ${a.resolvedRows} | ${a.settled} | ${a.wins} / ${a.losses} | ${$(a.netBefore)} | ${$(a.netAfter)} | ${$(a.netAfter - a.netBefore)} | ${a.resolvedBeforeFill} | ${a.exitVoided} |`); }
    return L; };
  const totTable = (t: Record<string, { before: any; after: any }>) => [`| Mode | Net P&L | Realised | Unrealised | Settled trades | Win rate |`, `|---|---|---|---|---|---|`,
    ...MODES.map((m) => { const b = t[m].before, a = t[m].after; return `| ${m} | ${$(b.netPnl)} → ${$(a.netPnl)} (${$(a.netPnl - b.netPnl)}) | ${$(b.realizedPnl)} → ${$(a.realizedPnl)} | ${$(b.unrealizedPnl)} → ${$(a.unrealizedPnl)} | ${b.settled} → ${a.settled} | ${pc(b.winRate)} → ${pc(a.winRate)} |`; })];
  const incomplete = MODES.reduce((s, m) => s + strict[m].live.incomplete + strict[m].frozen.incomplete + withUma[m].live.incomplete + withUma[m].frozen.incomplete, 0);
  const md: string[] = [];
  md.push(`# Orphan resolution: impact on Phase 2 results`, ``, `Generated ${new Date().toISOString()} from production, read-only (nothing was written). ${open.length.toLocaleString("en-US")} open simulated positions read; ${orphans.length.toLocaleString("en-US")} sit on ${tokens.size} tokens that no process checks for resolution. Every one of them reproduces its stored P&L exactly with the report's arithmetic (largest difference ${maxErr.toExponential(1)}); that arithmetic is tested against the Phase 2 simulator itself.${incomplete ? ` ${incomplete} position(s) re-open shares whose value the stored record cannot give and are left out.` : ""}`, ``);
  md.push(`## What Polymarket says about the ${tokens.size} tokens`, ``, `| Answer | Tokens |`, `|---|---|`, ...Object.entries(tokState).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`), ``);
  if (Object.keys(reasons).length) md.push(`| Unanswered because | Tokens |`, `|---|---|`, ...Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`), ``);
  md.push(`\`resolved_but_token_value_unknown\` is one market type: neg-risk markets settled by UMA. \`/v2/resolutions\` reports them resolved but gives no payouts and no \`resolved_at\`. Gamma's closed-market record has the final prices and \`umaEndDate\` for ${gammaAlt.size} of the ${needAlt.length}; that time is within ${q(0.5) ?? "—"} s (median) / ${q(0.9) ?? "—"} s (p90) of the v2 row's \`last_update_timestamp\`.`, ``);
  md.push(`## A. Resolver as built (D2: settle only at an on-chain \`resolved_at\`)`, ``, `*Revisited* positions have a ledger row, so the sweep recomputes them once their token resolves; only these change the Phase 2 results. *Frozen* positions (no ledger row, signals from 18–20 Sep) are never recomputed: their rows show what a resolution would mean, but their stored results stay as they are.`, ``, ...posTable(strict), ``, `Mode totals (\`paper_exec_report\`), before → after:`, ``, ...totTable(tStrict), ``);
  md.push(`## B. Sensitivity: also accept Gamma's UMA settlement time for neg-risk markets (needs a decision)`, ``, ...posTable(withUma), ``, ...totTable(tUma), ``);
  md.push(`Max drawdown and the robustness figures depend on closing order and are not projected; the next sweep recomputes them.`, ``);
  const bad = [...answer.entries()].filter(([, v]) => v.state === "NO_CONDITION_ID");
  if (bad.length) md.push(`## Tokens with no usable condition id (${bad.length})`, ``, `Their signals carry an empty or malformed \`condition_id\` (the malformed ones end in long runs of zeros, which looks like a lost-precision conversion upstream), so they cannot be looked up:`, ``, ...bad.map(([t, v]) => `- \`${t.slice(0, 20)}…\` — ${v.reason}`), ``);
  md.push(`_Run time ${((Date.now() - t0) / 1000).toFixed(0)} s._`);
  const out = process.argv[2] ?? "orphan-impact.md"; writeFileSync(out, md.join("\n") + "\n");
  writeFileSync(out.replace(/\.md$/, ".json"), JSON.stringify({ generatedAt: new Date().toISOString(), tokens: tokState, reasons, strict, withUma, totals: { strict: tStrict, withUma: tUma }, answers: Object.fromEntries([...answer.entries()].map(([t, a]) => [t, { ...a, condition: tokens.get(t)?.condition ?? null, gammaUma: gammaAlt.get(t) ?? null }])) }, null, 2));
  console.log(md.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
