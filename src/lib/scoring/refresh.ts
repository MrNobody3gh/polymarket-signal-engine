/**
 * Daily cohort refresh: (1) discover every wallet on any board, (2) score each
 * with three API reads, (3) upsert, (4) mark the watchlist.
 *
 * Discovery = 11 categories × 4 windows × 2 sorts × up to 100 rows ≈ 88 calls,
 * then ~3 calls per unique wallet. ~1,400 wallets ≈ 4,300 calls; at the
 * documented general limit that is comfortable inside a 5-minute serverless
 * budget with concurrency 8, but the job is also resumable via `cursors`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PolymarketClient } from "../polymarket/client";
import { buildProfile, type MeasuredActivity } from "./score";
import type { WalletProfile } from "../polymarket/types";

export const CATEGORIES = ["overall", "politics", "sports", "esports", "crypto", "culture", "mentions", "weather", "economics", "tech", "finance"];
export const WINDOWS = ["day", "week", "month", "all"] as const;

export async function discover(client: PolymarketClient, perBoard = 100, log: (m: string) => void = () => {}): Promise<Map<string, { name: string | null; sources: string[] }>> {
  const found = new Map<string, { name: string | null; sources: string[] }>();
  for (const cat of CATEGORIES) for (const win of WINDOWS) for (const sort of ["PNL", "VOLUME"] as const) {
    try {
      const rows = await client.leaderboard({ timePeriod: win, sortBy: sort, category: cat === "overall" ? undefined : cat, limit: perBoard });
      for (const r of rows) {
        const a = String(r.user_id).toLowerCase(); const e = found.get(a) ?? { name: r.user_name || null, sources: [] };
        e.sources.push(`lb:${cat}:${win}:${sort.toLowerCase()}`); if (!e.name && r.user_name) e.name = r.user_name; found.set(a, e);
      }
    } catch (e) { log(`board ${cat}/${win}/${sort} failed: ${(e as Error).message}`); }
  }
  // Recent size, regardless of standing: the only route that surfaces a wallet before it ranks anywhere.
  try {
    for (const t of await client.bigTrades(10_000, 2000)) {
      const a = String(t.proxy_wallet ?? t.proxyWallet ?? "").toLowerCase(); if (!a) continue;
      const e = found.get(a) ?? { name: (t.name as string) || null, sources: [] }; if (!e.sources.includes("big-trades")) e.sources.push("big-trades"); found.set(a, e);
    }
  } catch (e) { log(`big-trades failed: ${(e as Error).message}`); }
  return found;
}

export async function scoreWallet(client: PolymarketClient, address: string, name: string | null, sources: string[], now: number, activity: MeasuredActivity | null = null): Promise<WalletProfile> {
  const [stats, points] = await Promise.all([client.userStats(address), client.userPnl(address, "max")]);
  return buildProfile(address, name ?? (stats?.["name"] as string | undefined) ?? null, stats, points, now, sources, activity);
}

export async function refresh(db: SupabaseClient, client = new PolymarketClient(), opts: { concurrency?: number; limit?: number; minCopyScore?: number; topByPnl?: number; log?: (m: string) => void } = {}) {
  const log = opts.log ?? ((m) => console.log(m));
  const now = Math.floor(Date.now() / 1000);
  const found = await discover(client, 100, log);
  // include anything currently tracked, so a wallet that drops off the boards is still re-scored
  const { data: tracked } = await db.from("wallets").select("address,name,sources").eq("tracked", true);
  for (const t of tracked ?? []) if (!found.has(t.address)) found.set(t.address, { name: t.name, sources: t.sources ?? [] });
  const list = [...found.entries()].slice(0, opts.limit ?? 5000);
  // Activity is measured by the worker (scoring/activity.ts); use it, never re-derive or overwrite it here.
  const activity = new Map<string, MeasuredActivity>();
  for (let i = 0; ; i += 1000) { const { data } = await db.from("wallets").select("address,activity_status,fills_per_day").not("activity_status", "is", null).range(i, i + 999); for (const r of data ?? []) activity.set(r.address, { status: r.activity_status, fillsPerDay: r.fills_per_day == null ? null : Number(r.fills_per_day) }); if (!data || data.length < 1000) break; }
  log(`scoring ${list.length} wallets`);
  const profiles: WalletProfile[] = []; let i = 0; const conc = opts.concurrency ?? 8;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < list.length) {
      const [addr, meta] = list[i++];
      try { profiles.push(await scoreWallet(client, addr, meta.name, meta.sources, now, activity.get(addr) ?? null)); } catch (e) { log(`score ${addr}: ${(e as Error).message}`); }
    }
  }));
  const minScore = opts.minCopyScore ?? 40; const topN = opts.topByPnl ?? 50;
  const human = profiles.filter((p) => p.style !== "Market maker / bot");
  const byScore = [...human].sort((a, b) => b.copyScore - a.copyScore || b.pnl90d - a.pnl90d);
  const byPnl = [...human].sort((a, b) => b.pnl90d - a.pnl90d);
  const track = new Set<string>([...byScore.filter((p) => p.copyScore >= minScore).slice(0, 150).map((p) => p.address), ...byPnl.slice(0, topN).map((p) => p.address)]);
  const rows = profiles.map((p) => ({ address: p.address, name: p.name, copy_score: p.copyScore, pnl_90d: p.pnl90d, style: p.style, program_share: p.programShare, concentration: p.concentration, net_dd: p.netDd, months_up: p.monthsUp, months_total: p.monthsTotal, days_idle: p.daysIdle, trade_count: p.tradeCount, sources: p.sources, tracked: track.has(p.address), scored_at: new Date().toISOString() }));
  for (let j = 0; j < rows.length; j += 500) { const { error } = await db.from("wallets").upsert(rows.slice(j, j + 500), { onConflict: "address" }); if (error) throw error; }
  await db.from("cursors").upsert({ key: "refresh:last", value: String(now), updated_at: new Date().toISOString() });
  log(`scored ${profiles.length}, tracking ${track.size}`);
  return { scored: profiles.length, tracked: track.size };
}

/** One-off bootstrap from config/watchlist.json (the published snapshot), so the
 *  engine is useful before the first full refresh has run. */
export async function seedFromSnapshot(db: SupabaseClient, snapshot: { wallets: { wallet: string; name: string | null; copy_score: number; pnl_90d: number; style: string; fills_per_day: number | null; program_share: number | null; concentration: number | null; net_dd: number | null; months_up: number; months_total: number }[] }) {
  const rows = snapshot.wallets.map((w) => ({ address: w.wallet.toLowerCase(), name: w.name, copy_score: w.copy_score, pnl_90d: w.pnl_90d, style: w.style, fills_per_day: w.fills_per_day, program_share: w.program_share, concentration: w.concentration, net_dd: w.net_dd, months_up: w.months_up, months_total: w.months_total, sources: ["snapshot:2026-09-17"], tracked: true }));
  const { error } = await db.from("wallets").upsert(rows, { onConflict: "address" }); if (error) throw error;
  return rows.length;
}
