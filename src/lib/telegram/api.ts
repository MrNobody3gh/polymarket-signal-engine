/** Minimal Telegram Bot API wrapper. HTML parse mode everywhere. */
export interface TgButton { text: string; url?: string; callback_data?: string }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string } }
export interface TgMessage { message_id: number; chat: { id: number; type: string; username?: string; title?: string }; from?: TgUser; text?: string }
export interface TgUser { id: number; username?: string; first_name?: string }

export class TelegramApi {
  constructor(private token: string, private f: typeof fetch = fetch) {}
  private async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: T; description?: string }> {
    const r = await this.f(`https://api.telegram.org/bot${this.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try { return (await r.json()) as { ok: boolean; result?: T; description?: string }; } catch { return { ok: false, description: `HTTP ${r.status}` }; }
  }
  send(chatId: number | string, html: string, buttons?: TgButton[][]) {
    return this.call("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });
  }
  answerCallback(id: string, text?: string) { return this.call("answerCallbackQuery", { callback_query_id: id, text }); }
  setWebhook(url: string, secret: string) { return this.call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }); }
  deleteWebhook() { return this.call("deleteWebhook", { drop_pending_updates: false }); }
  setCommands(cmds: { command: string; description: string }[]) { return this.call("setMyCommands", { commands: cmds }); }
  getUpdates(offset: number, timeoutSec = 25) { return this.call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }); }
}
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
export const money = (v: number) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}k` : `$${v.toFixed(0)}`);
export const BOT_COMMANDS = [
  { command: "start", description: "Subscribe to alerts" },
  { command: "signals", description: "Latest signals" },
  { command: "consensus", description: "Markets where 2+ tracked wallets agree" },
  { command: "wallets", description: "Top of the watchlist" },
  { command: "wallet", description: "Profile + open book for a wallet or name" },
  { command: "filters", description: "Show your alert filters" },
  { command: "kinds", description: "Choose signal kinds, e.g. /kinds new consensus exit" },
  { command: "severity", description: "Minimum severity 1–5" },
  { command: "min", description: "Minimum fill size in USD" },
  { command: "score", description: "Minimum copy score" },
  { command: "only", description: "Only alert on these wallets (or /only all)" },
  { command: "mute", description: "Mute for N hours, or mute a wallet" },
  { command: "unmute", description: "Clear mutes" },
  { command: "stop", description: "Unsubscribe" },
  { command: "status", description: "Engine health" },
];
