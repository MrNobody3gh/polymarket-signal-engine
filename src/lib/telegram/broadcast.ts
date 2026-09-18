/** Fan a persisted signal out to every subscriber whose filters match.
 *  Idempotent per (signal, chat) via tg_deliveries; paced under Telegram's
 *  ~30 msg/s global limit. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { TelegramApi } from "./api";
import { matches, signalButtons, signalHtml, type SignalRow, type Subscriber } from "./commands";
import { heartbeat } from "../health/heartbeat";

export async function broadcast(db: SupabaseClient, api: TelegramApi, signal: SignalRow, opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<{ sent: number; failed: number; skipped: number }> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const { data: subs } = await db.from("tg_subscribers").select("*").eq("active", true);
  const { data: done } = await db.from("tg_deliveries").select("chat_id").eq("signal_id", signal.id);
  const already = new Set((done ?? []).map((d) => Number(d.chat_id)));
  let sent = 0, failed = 0, skipped = 0;
  const html = signalHtml(signal); const buttons = signalButtons(signal);
  for (const sub of (subs ?? []) as Subscriber[]) {
    if (already.has(Number(sub.chat_id)) || !matches(sub, signal)) { skipped++; continue; }
    const r = await api.send(sub.chat_id, html, buttons);
    const ok = !!r.ok; ok ? sent++ : failed++;
    await db.from("tg_deliveries").upsert({ signal_id: signal.id, chat_id: sub.chat_id, ok });
    if (!ok && /blocked|chat not found|deactivated/i.test(r.description ?? "")) await db.from("tg_subscribers").update({ active: false }).eq("chat_id", sub.chat_id);
    if (sent % 25 === 0 && sent > 0) await sleep(1000);
  }
  if (sent > 0) await heartbeat(db, "last_tg_delivery", new Date().toISOString());
  return { sent, failed, skipped };
}
