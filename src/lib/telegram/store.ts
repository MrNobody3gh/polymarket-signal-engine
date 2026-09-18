/** Supabase-backed Store for the bot. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Store, Subscriber } from "./commands";

export function supabaseStore(db: SupabaseClient): Store {
  return {
    async getSub(chatId) { const { data } = await db.from("tg_subscribers").select("*").eq("chat_id", chatId).maybeSingle(); return (data as Subscriber | null) ?? null; },
    async upsertSub(s) {
      const { data, error } = await db.from("tg_subscribers").upsert({ ...s, updated_at: new Date().toISOString() }, { onConflict: "chat_id" }).select("*").single();
      if (error) throw error; return data as Subscriber;
    },
    async recentSignals(n) { const { data } = await db.from("signals").select("*").order("created_at", { ascending: false }).limit(n); return (data ?? []) as never; },
    async consensus(n) { const { data } = await db.from("consensus_now").select("*").order("wallets", { ascending: false }).order("weighted_score", { ascending: false }).limit(n); return (data ?? []) as never; },
    async topWallets(n) { const { data } = await db.from("wallets").select("*").eq("tracked", true).order("copy_score", { ascending: false }).limit(n); return (data ?? []) as never; },
    async findWallet(q) {
      const t = q.trim();
      if (/^0x[0-9a-f]{40}$/i.test(t)) { const { data } = await db.from("wallets").select("*").eq("address", t.toLowerCase()).maybeSingle(); return (data as never) ?? null; }
      const { data } = await db.from("wallets").select("*").eq("tracked", true).ilike("name", `%${t.replace(/[%_]/g, "")}%`).order("copy_score", { ascending: false }).limit(1);
      return (data?.[0] as never) ?? null;
    },
    async openBook(wallet, n) { const { data } = await db.from("positions").select("token_id,title,slug,outcome,size,avg_price,cost_usd,last_seen").eq("wallet", wallet).gt("size", 0).order("cost_usd", { ascending: false }).limit(n); return (data ?? []) as never; },
    async status() {
      const [{ count: tracked }, { count: signals24h }, { data: r }, { data: f }] = await Promise.all([
        db.from("wallets").select("address", { count: "exact", head: true }).eq("tracked", true),
        db.from("signals").select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 86_400_000).toISOString()),
        db.from("cursors").select("value").eq("key", "refresh:last").maybeSingle(),
        db.from("fills").select("ts").order("ts", { ascending: false }).limit(1).maybeSingle(),
      ]);
      return { tracked: tracked ?? 0, signals24h: signals24h ?? 0, lastRefresh: r?.value ? new Date(Number(r.value) * 1000).toUTCString().slice(5, 22) + " UTC" : null, lastFill: f?.ts ?? null };
    },
  };
}
