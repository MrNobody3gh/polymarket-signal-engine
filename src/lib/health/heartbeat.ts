/** Health heartbeats live in the existing `cursors` table under health:* keys. Writes are throttled per key. */
import type { SupabaseClient } from "@supabase/supabase-js";
export type HeartbeatKey = "ws_connected" | "last_trade" | "last_db_write" | "last_eval" | "last_tg_delivery" | "last_mark" | "worker_boot";
const last = new Map<string, number>();
export async function heartbeat(db: SupabaseClient, key: HeartbeatKey, value?: string, minIntervalMs = 15_000) {
  const now = Date.now(); const prev = last.get(key) ?? 0;
  if (value === undefined && now - prev < minIntervalMs) return;
  last.set(key, now);
  try { await db.from("cursors").upsert({ key: `health:${key}`, value: value ?? new Date(now).toISOString(), updated_at: new Date(now).toISOString() }); } catch { /* health must never break the pipeline */ }
}
export async function readHeartbeats(db: SupabaseClient): Promise<Record<string, string>> {
  const { data } = await db.from("cursors").select("key,value").like("key", "health:%");
  return Object.fromEntries((data ?? []).map((r) => [r.key.slice(7), r.value ?? ""]));
}
