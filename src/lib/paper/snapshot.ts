/**
 * Precomputed performance snapshot. The worker rebuilds it after every marking run and stores it as JSON in
 * `cursors` (key paper:snapshot), so the bot and dashboard read one small row instead of scanning the ledger.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Stats } from "./analytics";

export interface KindStat { key: string; stats: Stats }
export interface WindowSnapshot { stats: Stats; byKind: KindStat[]; byScoreBand: KindStat[]; byConsensusDepth: KindStat[]; sizeUsd: number }
export interface WalletSnapshot { stats: Stats; byKind: KindStat[]; name: string | null }
export interface PaperSnapshot { builtAt: string; windows: { all: WindowSnapshot; d7: WindowSnapshot; d30: WindowSnapshot }; wallets: Record<string, WalletSnapshot> }
export const SNAPSHOT_KEY = "paper:snapshot";

/** Built entirely by Postgres (paper_group_stats): memory is independent of ledger size. */
export async function buildSnapshot(db: SupabaseClient): Promise<PaperSnapshot> {
  const now = Date.now();
  const grp = async (since: number | null, g: string) => {
    const { data, error } = await db.rpc("paper_group_stats", { p_since: since == null ? null : new Date(since).toISOString(), p_group: g }); if (error) throw error;
    return (data ?? []) as { key: string; name: string | null; sizeUsd: number | null; stats: Stats }[];
  };
  const win = async (days: number | null): Promise<WindowSnapshot> => {
    const since = days ? now - days * 86_400_000 : null; const [all, kind, band, depth] = await Promise.all([grp(since, "all"), grp(since, "kind"), grp(since, "band"), grp(since, "depth")]);
    const empty: Stats = { signals: 0, open: 0, resolved: 0, exited: 0, unresolved: 0, invalid: 0, observed: 0, pnl: 0, avgReturn: null, medianReturn: null, winRate: null, lossRate: null, avgWin: null, avgLoss: null, best: null, worst: null, insufficient: true };
    const bandOrder = ["0–39", "40–59", "60–79", "80–100", "unscored"], depthOrder = ["2 wallets", "3 wallets", "4 wallets", "5+ wallets", "unknown"];
    const ord = (xs: { key: string; stats: Stats }[], order: string[]) => [...xs].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    return { stats: all[0]?.stats ?? empty, byKind: kind.map(({ key, stats }) => ({ key, stats })), byScoreBand: ord(band, bandOrder), byConsensusDepth: ord(depth, depthOrder), sizeUsd: Number(all[0]?.sizeUsd ?? 100) };
  };
  const [all, d7, d30, wallets, walletKinds] = await Promise.all([win(null), win(7), win(30), grp(null, "wallet"), grp(null, "wallet_kind")]);
  const wmap: Record<string, WalletSnapshot> = {};
  for (const w of wallets) wmap[w.key] = { stats: w.stats, byKind: [], name: w.name };
  for (const wk of walletKinds) { const [addr, kind] = wk.key.split("|"); wmap[addr]?.byKind.push({ key: kind, stats: wk.stats }); }
  return { builtAt: new Date(now).toISOString(), windows: { all, d7, d30 }, wallets: wmap };
}
export async function saveSnapshot(db: SupabaseClient, snap: PaperSnapshot) {
  const { error } = await db.from("cursors").upsert({ key: SNAPSHOT_KEY, value: JSON.stringify(snap), updated_at: new Date().toISOString() }); if (error) throw error;
}
export async function readSnapshot(db: SupabaseClient): Promise<PaperSnapshot | null> {
  const { data } = await db.from("cursors").select("value").eq("key", SNAPSHOT_KEY).maybeSingle();
  if (!data?.value) return null; try { return JSON.parse(data.value) as PaperSnapshot; } catch { return null; }
}
