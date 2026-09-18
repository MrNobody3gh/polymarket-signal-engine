/** One-time: register the webhook + command menu.
 *  npm run tg:setup -- https://your-app.vercel.app   (omit the URL to switch to local long-polling) */
import { BOT_COMMANDS, TelegramApi } from "../src/lib/telegram/api";
(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN; const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing"); const api = new TelegramApi(token);
  console.log("commands:", (await api.setCommands(BOT_COMMANDS)).ok);
  const base = process.argv[2];
  if (base) { if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET missing"); console.log("webhook:", await api.setWebhook(`${base.replace(/\/$/, "")}/api/telegram/webhook`, secret)); }
  else console.log("webhook removed (long-polling mode):", (await api.deleteWebhook()).ok);
})().catch((e) => { console.error(e); process.exit(1); });
