/**
 * Paper ledger semantics (V2).
 *  - NEW_POSITION / CONSENSUS / CONVICTION_ADD / EARLY_ENTRY  → open a fixed-size hypothetical LONG on the
 *    outcome token at the signal price. Each signal is its own experiment, even an "add".
 *  - EXIT → never a position. It closes every OPEN paper long for the same wallet+token at the exit price,
 *    and is itself recorded as an EXIT_EVENT row (shares 0) so the signal stays reconstructable.
 * Prices are per outcome token (0..1), so binary and multi-outcome markets are handled identically:
 * a long on token X pays 1 if X wins, 0 otherwise.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SignalKind } from "../polymarket/types";

export const DEFAULT_PAPER_SIZE = 100;
export const ENTRY_KINDS: SignalKind[] = ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"];

export interface SignalForPaper { id: string; kind: SignalKind; severity: number; wallet: string; wallet_name: string | null; condition_id: string; token_id: string; outcome: string | null; title: string | null; slug: string | null; price: number; usd: number; payload: Record<string, unknown>; created_at: string }
export interface PaperRow { signal_id: string; wallet: string | null; wallet_name: string | null; kind: SignalKind; token_id: string | null; condition_id: string | null; outcome: string | null; title: string | null; slug: string | null; side: "LONG" | "EXIT_EVENT"; signal_ts: string; size_usd: number; shares: number | null; entry_price: number; copy_score: number | null; severity: number | null; consensus_depth: number | null; trade_usd: number | null; status: PaperStatus; status_reason: string | null; exit_price: number | null; exit_ts: string | null; final_price: number | null; final_pnl: number | null; final_return: number | null; settled_at: string | null }
export type PaperStatus = "OPEN" | "RESOLVED_WIN" | "RESOLVED_LOSS" | "EXITED" | "UNRESOLVED" | "INVALID" | "EXIT_EVENT";
export interface DqIssue { kind: string; ref_type: string; ref_id: string; detail: Record<string, unknown> }

export const isValidPrice = (p: unknown): p is number => typeof p === "number" && Number.isFinite(p) && p > 0 && p < 1;
export const sharesFor = (sizeUsd: number, price: number) => sizeUsd / price;
export const pnlFor = (shares: number, entry: number, now: number) => shares * (now - entry);
export const returnFor = (entry: number, now: number) => (now - entry) / entry;

/** Pure: build the ledger row (and any data-quality issues) for a signal. `null` row means do not insert. */
export function buildPaperRow(s: SignalForPaper, sizeUsd = DEFAULT_PAPER_SIZE): { row: PaperRow | null; issues: DqIssue[] } {
  const issues: DqIssue[] = [];
  const consensus = typeof s.payload?.wallets === "number" ? (s.payload.wallets as number) : null;
  const score = typeof s.payload?.copyScore === "number" ? (s.payload.copyScore as number) : null;
  const base = { signal_id: s.id, wallet: s.wallet || null, wallet_name: s.wallet_name, kind: s.kind, token_id: s.token_id || null, condition_id: s.condition_id || null, outcome: s.outcome, title: s.title, slug: s.slug, signal_ts: s.created_at, size_usd: sizeUsd, entry_price: s.price, copy_score: score, severity: s.severity, consensus_depth: consensus, trade_usd: s.usd, status_reason: null as string | null, exit_price: null, exit_ts: null, final_price: null, final_pnl: null, final_return: null, settled_at: null };
  if (!s.wallet) issues.push({ kind: "missing_wallet", ref_type: "signal", ref_id: s.id, detail: {} });
  if (!s.token_id || !s.condition_id) issues.push({ kind: "missing_market", ref_type: "signal", ref_id: s.id, detail: { token_id: s.token_id, condition_id: s.condition_id } });
  if (!(s.usd > 0)) issues.push({ kind: "invalid_size", ref_type: "signal", ref_id: s.id, detail: { usd: s.usd } });
  if (s.kind === "EXIT") return { row: { ...base, side: "EXIT_EVENT", shares: 0, status: "EXIT_EVENT" }, issues };
  if (!isValidPrice(s.price)) {
    issues.push({ kind: typeof s.price === "number" && Number.isFinite(s.price) ? "price_out_of_bounds" : "invalid_price", ref_type: "signal", ref_id: s.id, detail: { price: s.price } });
    return { row: { ...base, side: "LONG", shares: null, status: "INVALID", status_reason: "entry price not in (0,1)" }, issues };
  }
  if (!s.token_id || !s.condition_id) return { row: { ...base, side: "LONG", shares: sharesFor(sizeUsd, s.price), status: "INVALID", status_reason: "missing market identifiers" }, issues };
  return { row: { ...base, side: "LONG", shares: sharesFor(sizeUsd, s.price), status: "OPEN" }, issues };
}

/** Record a signal as a paper experiment. Idempotent (signal_id is the PK). Returns what happened. */
export async function recordPaperSignal(db: SupabaseClient, s: SignalForPaper, sizeUsd = DEFAULT_PAPER_SIZE): Promise<{ inserted: boolean; closed: number; issues: DqIssue[] }> {
  const { row, issues } = buildPaperRow(s, sizeUsd);
  let inserted = false, closed = 0;
  if (row) {
    const { error } = await db.from("paper_ledger").insert(row);
    if (error) { if (error.code === "23505") issues.push({ kind: "duplicate_paper", ref_type: "signal", ref_id: s.id, detail: {} }); else throw error; } else inserted = true;
  }
  if (s.kind === "EXIT" && s.wallet && s.token_id) closed = await closePaperPositions(db, s.wallet, s.token_id, s.price, s.created_at, s.id);
  await logIssues(db, issues);
  return { inserted, closed, issues };
}

/** EXIT semantics: settle every OPEN paper long of this wallet on this token at the exit price. */
export async function closePaperPositions(db: SupabaseClient, wallet: string, tokenId: string, exitPrice: number, exitTs: string, bySignalId: string): Promise<number> {
  if (!isValidPrice(exitPrice) && !(exitPrice === 0 || exitPrice === 1)) return 0;
  const { data: open } = await db.from("paper_ledger").select("signal_id,shares,entry_price").eq("wallet", wallet).eq("token_id", tokenId).eq("status", "OPEN").lt("signal_ts", exitTs);
  let n = 0;
  for (const p of open ?? []) {
    const shares = Number(p.shares), entry = Number(p.entry_price);
    const pnl = pnlFor(shares, entry, exitPrice), ret = returnFor(entry, exitPrice);
    const { error } = await db.from("paper_ledger").update({ status: "EXITED", status_reason: `closed by EXIT signal ${bySignalId}`, exit_price: exitPrice, exit_ts: exitTs, final_price: exitPrice, final_pnl: pnl, final_return: ret, settled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("signal_id", p.signal_id).eq("status", "OPEN");
    if (error) continue;
    await db.from("paper_marks").upsert({ signal_id: p.signal_id, horizon: "exit", observed_at: exitTs, price: exitPrice, pnl, return_pct: ret, source: "fill" }, { onConflict: "signal_id,horizon", ignoreDuplicates: true });
    n++;
  }
  return n;
}

export async function logIssues(db: SupabaseClient, issues: DqIssue[]) {
  for (const i of issues) {
    const { error } = await db.from("data_quality_issues").insert(i);
    if (error && error.code !== "23505") console.error("dq log failed", error.message);
  }
}

/** Consensus context for a CONSENSUS signal: participants, spread, entry prices. */
export async function recordConsensusEvent(db: SupabaseClient, s: SignalForPaper): Promise<boolean> {
  if (s.kind !== "CONSENSUS") return false;
  const peers = Array.isArray(s.payload?.peers) ? (s.payload.peers as string[]) : [];
  const peerTs = Array.isArray(s.payload?.peerLastBuyTs) ? (s.payload.peerLastBuyTs as number[]) : [];
  const participants = [s.wallet, ...peers];
  const thisTs = Math.floor(Date.parse(s.created_at) / 1000);
  const firstTs = peerTs.length ? Math.min(...peerTs, thisTs) : null;
  const { data: pos } = await db.from("positions").select("wallet,cost_usd,avg_price").eq("token_id", s.token_id).in("wallet", participants);
  const combined = (pos ?? []).reduce((a, p) => a + Number(p.cost_usd), 0);
  const entries = [s.price, ...(pos ?? []).filter((p) => p.wallet !== s.wallet).map((p) => Number(p.avg_price))].filter((x) => Number.isFinite(x));
  const { error } = await db.from("consensus_events").upsert({ signal_id: s.id, token_id: s.token_id, condition_id: s.condition_id, outcome: s.outcome, depth: participants.length, participants, combined_usd: pos?.length ? combined : null, first_buy_ts: firstTs ? new Date(firstTs * 1000).toISOString() : null, this_buy_ts: s.created_at, spread_seconds: firstTs ? thisTs - firstTs : null, entry_prices: entries }, { onConflict: "signal_id", ignoreDuplicates: true });
  return !error;
}
