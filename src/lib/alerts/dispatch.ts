/** Fan a signal out to every configured channel. Failures are per-channel and
 *  recorded on the signal row; they never block the engine. */
import type { Signal } from "../polymarket/types";
import { formatSignal, marketUrl } from "../signals/format";

export interface Channels { telegram?: { token: string; chatId: string }; discord?: { webhookUrl: string }; email?: { resendKey: string; to: string; from: string } }
export function channelsFromEnv(env: Record<string, string | undefined> = process.env): Channels {
  const c: Channels = {};
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) c.telegram = { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
  if (env.DISCORD_WEBHOOK_URL) c.discord = { webhookUrl: env.DISCORD_WEBHOOK_URL };
  if (env.RESEND_API_KEY && env.ALERT_EMAIL_TO) c.email = { resendKey: env.RESEND_API_KEY, to: env.ALERT_EMAIL_TO, from: env.ALERT_EMAIL_FROM ?? "signals@example.com" };
  return c;
}
const COLOR: Record<Signal["kind"], number> = { NEW_POSITION: 0x2451cf, CONSENSUS: 0x8c6bc8, CONVICTION_ADD: 0x178a5e, EARLY_ENTRY: 0xd98a1f, EXIT: 0xc2432b };

export async function dispatch(s: Signal, ch: Channels, f: typeof fetch = fetch): Promise<Record<string, boolean>> {
  const text = formatSignal(s); const out: Record<string, boolean> = {};
  const jobs: Promise<void>[] = [];
  if (ch.telegram) jobs.push(f(`https://api.telegram.org/bot${ch.telegram.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: ch.telegram.chatId, text, disable_web_page_preview: true }) }).then((r) => { out.telegram = r.ok; }, () => { out.telegram = false; }));
  if (ch.discord) jobs.push(f(ch.discord.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ embeds: [{ title: `${s.kind.replace("_", " ")} · ${"★".repeat(s.severity)}`, description: text, url: marketUrl(s), color: COLOR[s.kind] }] }) }).then((r) => { out.discord = r.ok; }, () => { out.discord = false; }));
  if (ch.email) jobs.push(f("https://api.resend.com/emails", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ch.email.resendKey}` }, body: JSON.stringify({ from: ch.email.from, to: [ch.email.to], subject: `[Polymarket] ${s.kind.replace("_", " ")}: ${s.title || s.slug}`, text }) }).then((r) => { out.email = r.ok; }, () => { out.email = false; }));
  await Promise.all(jobs);
  return out;
}
