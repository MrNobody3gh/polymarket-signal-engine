/** Local dev: long-poll Telegram instead of a webhook.  npm run bot */
import { db } from "../src/lib/db";
import { TelegramApi } from "../src/lib/telegram/api";
import { processUpdate } from "../src/lib/telegram/bot";
(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const api = new TelegramApi(token); await api.deleteWebhook(); let offset = 0; console.log("polling…");
  for (;;) {
    const r = await api.getUpdates(offset); if (!r.ok || !r.result) { await new Promise((x) => setTimeout(x, 2000)); continue; }
    for (const u of r.result) { offset = u.update_id + 1; await processUpdate(u, db(), api).catch(console.error); }
  }
})().catch((e) => { console.error(e); process.exit(1); });
