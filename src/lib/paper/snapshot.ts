/**
 * Precomputed performance snapshot. The worker rebuilds it after every marking run and stores it as JSON in
 * `cursors` (key paper:snapshot), so the bot and dashboard read one small row instead of scanning the ledger.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPaper } from "./queries";
import { computeStats, byKind, byScoreBand, byConsensusDepth, byWallet, type Stats } from "./analytics";

export interface KindStat { key: string; stats: Stats }
export interface WindowSnapshot { stats: Stats; byKind: KindStat[]; byScoreBand: KindStat[]; byConsensusDepth: KindStat[]; sizeUsd: number }
export interface WalletSnapshot { stats: Stats; byKind: KindStat[]; name: string | null }
export interface PaperSnapshot { builtAt: string; windows: { all: WindowSnapshot; d7: WindowSnapshot; d30: WindowSnapshot }; wallets: Record<string, WalletSnapshot> }
export const SNAPSHOT_KEY = "paper:snapshot";

export async function buildSnapshot(db: SupabaseClient): Promise<PaperSnapshot> {
  const { rows, marks } = await loadPaper(db, { limit: 20000 });
  const now = Date.now();
  const win = (days: number | null): WindowSnapshot => {
    const r = days ? rows.filter((x) => Date.parse(x.signal_ts) >= now - days * 86_400_000) : rows;
    return { stats: computeStats(r, marks), byKind: byKind(r, marks), byScoreBand: byScoreBand(r, marks), byConsensusDepth: byConsensusDepth(r, marks), sizeUsd: r[0]?.size_usd ?? 100 };
  };
  const wallets: Record<string, WalletSnapshot> = {};
  for (const w of byWallet(rows, marks)) wallets[w.key] = { stats: w.stats, byKind: w.kinds, name: w.name };
  return { builtAt: new Date(now).toISOString(), windows: { all: win(null), d7: win(7), d30: win(30) }, wallets };
}
export async function saveSnapshot(db: SupabaseClient, snap: PaperSnapshot) {
  const { error } = await db.from("cursors").upsert({ key: SNAPSHOT_KEY, value: JSON.stringify(snap), updated_at: new Date().toISOString() }); if (error) throw error;
}
export async function readSnapshot(db: SupabaseClient): Promise<PaperSnapshot | null> {
  const { data } = await db.from("cursors").select("value").eq("key", SNAPSHOT_KEY).maybeSingle();
  if (!data?.value) return null; try { return JSON.parse(data.value) as PaperSnapshot; } catch { return null; }
}
