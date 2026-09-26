/** Glue: one Telegram update → one reply. Used by the webhook route and the local long-poller. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { TelegramApi, type TgUpdate } from "./api";
import { handle, handleCallback } from "./commands";
import { supabaseStore } from "./store";
import { migrateSubscriber } from "./broadcast";

export async function processUpdate(u: TgUpdate, db: SupabaseClient, api: TelegramApi) {
  const store = supabaseStore(db);
  if (u.callback_query) {
    const cq = u.callback_query; const chatId = cq.message?.chat.id ?? cq.from.id;
    let text = "Done"; try { text = await handleCallback(chatId, cq.data ?? "", store); } catch (e) { text = "Failed"; console.error(e); }
    await api.answerCallback(cq.id, text); return;
  }
  const m = u.message;
  // Telegram announces a group → supergroup upgrade with a service message in the old chat: move the subscription now.
  if (m?.migrate_to_chat_id) {
    const { data } = await db.from("tg_subscribers").select("*").eq("chat_id", m.chat.id).maybeSingle();
    if (data) await migrateSubscriber(db, data as never, m.migrate_to_chat_id, new Date().toISOString());
    return;
  }
  if (!m?.text || !m.text.startsWith("/")) return;
  const username = m.from?.username ?? m.chat.username ?? null;
  let reply; try { reply = await handle(m.chat.id, username, m.text, store); } catch (e) { console.error(e); reply = { html: "Something broke on my side — try again in a minute." }; }
  await api.send(m.chat.id, reply.html, reply.buttons);
}
