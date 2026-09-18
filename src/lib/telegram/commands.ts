/**
 * Bot command layer. Pure with respect to Telegram: every handler takes a
 * `Store` (a thin data interface, mocked in tests) and returns HTML + buttons.
 */
import { esc, money, type TgButton } from "./api";
import type { SignalKind } from "../polymarket/types";

export interface Subscriber { chat_id: number; username: string | null; kinds: string[]; min_severity: number; min_usd: number; min_score: number; only_wallets: string[]; muted_wallets: string[]; muted_until: string | null; active: boolean }
export interface SignalRow { id: string; kind: SignalKind; severity: number; wallet: string; wallet_name: string | null; outcome: string | null; title: string | null; slug: string | null; price: number; usd: number; payload: Record<string, unknown>; created_at: string; closed_at: string | null }
export interface WalletRow { address: string; name: string | null; copy_score: number; pnl_90d: number; style: string; net_dd: number | null; months_up: number; months_total: number; fills_per_day: number | null; days_idle: number | null }
export interface PositionRow { token_id: string; title: string | null; slug: string | null; outcome: string | null; size: number; avg_price: number; cost_usd: number; last_seen: string }
export interface ConsensusRow { token_id: string; title: string | null; slug: string | null; outcome: string | null; wallets: number; cost_usd: number; weighted_score: number; avg_entry: number; names: string[]; end_date: string | null }

export interface Store {
  getSub(chatId: number): Promise<Subscriber | null>;
  upsertSub(s: Partial<Subscriber> & { chat_id: number }): Promise<Subscriber>;
  recentSignals(n: number): Promise<SignalRow[]>;
  consensus(n: number): Promise<ConsensusRow[]>;
  topWallets(n: number): Promise<WalletRow[]>;
  findWallet(q: string): Promise<WalletRow | null>;
  openBook(wallet: string, n: number): Promise<PositionRow[]>;
  status(): Promise<{ tracked: number; signals24h: number; lastRefresh: string | null; lastFill: string | null }>;
}

export const KINDS: SignalKind[] = ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY", "EXIT"];
const KIND_ALIAS: Record<string, SignalKind> = { new: "NEW_POSITION", position: "NEW_POSITION", new_position: "NEW_POSITION", consensus: "CONSENSUS", add: "CONVICTION_ADD", conviction: "CONVICTION_ADD", conviction_add: "CONVICTION_ADD", early: "EARLY_ENTRY", early_entry: "EARLY_ENTRY", exit: "EXIT", exits: "EXIT" };
export const KIND_LABEL: Record<SignalKind, string> = { NEW_POSITION: "New position", CONSENSUS: "Consensus", CONVICTION_ADD: "Conviction add", EARLY_ENTRY: "Early entry", EXIT: "Exit" };
export const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);
const ago = (iso: string) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const who = (name: string | null, addr: string) => esc(name ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`);
const isAddr = (s: string) => /^0x[0-9a-f]{40}$/i.test(s);

export interface Reply { html: string; buttons?: TgButton[][] }

export function parse(text: string): { cmd: string; args: string[] } {
  const t = text.trim(); if (!t.startsWith("/")) return { cmd: "", args: [] };
  const [head, ...rest] = t.split(/\s+/); return { cmd: head.slice(1).split("@")[0].toLowerCase(), args: rest };
}

/** Format one signal the way the bot shows it (also used for pushed alerts). */
export function signalHtml(s: SignalRow): string {
  const verb = s.kind === "EXIT" ? "sold" : "bought";
  const extras: string[] = [];
  const p = s.payload ?? {};
  if (typeof p.copyScore === "number") extras.push(`score ${p.copyScore}`);
  if (typeof p.wallets === "number") extras.push(`${p.wallets} wallets same side`);
  if (typeof p.daysToEnd === "number") extras.push(`${p.daysToEnd}d to resolution`);
  if (typeof p.soldFraction === "number") extras.push(`sold ${Math.round(Number(p.soldFraction) * 100)}%`);
  return `<b>${KIND_LABEL[s.kind]}</b> ${stars(s.severity)}\n${esc(s.title ?? s.slug ?? "")}\n<a href="https://polymarket.com/profile/${s.wallet}">${who(s.wallet_name, s.wallet)}</a> ${verb} <b>${esc(s.outcome ?? "?")}</b> @ ${Number(s.price).toFixed(3)} for <b>${money(Number(s.usd))}</b>${extras.length ? `\n<i>${extras.join(" · ")}</i>` : ""}`;
}
export function signalButtons(s: SignalRow): TgButton[][] {
  return [[{ text: "Market", url: `https://polymarket.com/event/${s.slug ?? ""}` }, { text: "Wallet", url: `https://polymarket.com/profile/${s.wallet}` }, { text: "Mute wallet", callback_data: `mute:${s.wallet}` }]];
}

export function filtersHtml(s: Subscriber): string {
  const kinds = s.kinds.map((k) => KIND_LABEL[k as SignalKind] ?? k).join(", ");
  const muted = s.muted_until && Date.parse(s.muted_until) > Date.now() ? `until ${new Date(s.muted_until).toUTCString().slice(5, 22)} UTC` : "no";
  return `<b>Your filters</b>\nKinds: ${esc(kinds)}\nMin severity: ${stars(s.min_severity)}\nMin fill: ${money(Number(s.min_usd))}\nMin copy score: ${s.min_score}\nOnly wallets: ${s.only_wallets.length ? s.only_wallets.map((w) => esc(w.slice(0, 8))).join(", ") : "whole watchlist"}\nMuted wallets: ${s.muted_wallets.length}\nMuted: ${muted}\n${s.active ? "Alerts on" : "Alerts off — /start to resume"}`;
}

export async function handle(chatId: number, username: string | null, text: string, store: Store): Promise<Reply> {
  const { cmd, args } = parse(text);
  const sub = await store.getSub(chatId);
  switch (cmd) {
    case "start": {
      const s = await store.upsertSub({ chat_id: chatId, username, active: true, muted_until: null });
      return { html: `Subscribed. You'll get alerts when a watchlist wallet opens, adds, or exits.\n\n${filtersHtml(s)}\n\nTry /signals, /consensus, /wallets, or /help.` };
    }
    case "help": return { html: `<b>Commands</b>\n/signals [n] — latest signals\n/consensus — markets where 2+ tracked wallets agree\n/wallets [n] — top of the watchlist\n/wallet &lt;name or 0x…&gt; — profile and open book\n/filters — your alert filters\n/kinds new consensus add early exit — choose kinds\n/severity 1–5 — minimum severity\n/min 5000 — minimum fill in USD\n/score 60 — minimum copy score\n/only 0x… 0x… — only these wallets (/only all to reset)\n/mute 6 — mute 6 hours · /mute 0x… — mute a wallet\n/unmute — clear mutes\n/stop — unsubscribe\n/status — engine health` };
    case "stop": { await store.upsertSub({ chat_id: chatId, active: false }); return { html: "Unsubscribed. /start to resume." }; }
    case "filters": return { html: sub ? filtersHtml(sub) : "Not subscribed yet — /start" };
    case "kinds": {
      if (!args.length) return { html: `Usage: /kinds new consensus add early exit\nCurrent: ${esc((sub?.kinds ?? KINDS).join(", "))}` };
      const kinds = args.map((a) => KIND_ALIAS[a.toLowerCase()] ?? (KINDS.includes(a.toUpperCase() as SignalKind) ? (a.toUpperCase() as SignalKind) : null));
      const bad = args.filter((_, i) => !kinds[i]); if (bad.length) return { html: `Unknown kind: ${esc(bad.join(", "))}. Use: new, consensus, add, early, exit.` };
      const s = await store.upsertSub({ chat_id: chatId, kinds: [...new Set(kinds as SignalKind[])] }); return { html: filtersHtml(s) };
    }
    case "severity": { const n = Number(args[0]); if (!(n >= 1 && n <= 5)) return { html: "Usage: /severity 1–5" }; return { html: filtersHtml(await store.upsertSub({ chat_id: chatId, min_severity: Math.round(n) })) }; }
    case "min": { const n = Number(String(args[0] ?? "").replace(/[$,k]/gi, (m) => (m.toLowerCase() === "k" ? "000" : ""))); if (!(n >= 0)) return { html: "Usage: /min 5000" }; return { html: filtersHtml(await store.upsertSub({ chat_id: chatId, min_usd: n })) }; }
    case "score": { const n = Number(args[0]); if (!(n >= 0 && n <= 100)) return { html: "Usage: /score 60" }; return { html: filtersHtml(await store.upsertSub({ chat_id: chatId, min_score: n })) }; }
    case "only": {
      if (!args.length) return { html: "Usage: /only 0x… 0x… — or /only all" };
      if (args[0].toLowerCase() === "all") return { html: filtersHtml(await store.upsertSub({ chat_id: chatId, only_wallets: [] })) };
      const addrs: string[] = [];
      for (const a of args) { if (isAddr(a)) addrs.push(a.toLowerCase()); else { const w = await store.findWallet(a); if (w) addrs.push(w.address); else return { html: `Can't find wallet "${esc(a)}"` }; } }
      return { html: filtersHtml(await store.upsertSub({ chat_id: chatId, only_wallets: [...new Set([...(sub?.only_wallets ?? []), ...addrs])] })) };
    }
    case "mute": {
      const a = args[0]; if (!a) return { html: "Usage: /mute 6 (hours) or /mute 0x… (wallet)" };
      if (isAddr(a)) { const s = await store.upsertSub({ chat_id: chatId, muted_wallets: [...new Set([...(sub?.muted_wallets ?? []), a.toLowerCase()])] }); return { html: `Muted ${esc(a.slice(0, 10))}… (${s.muted_wallets.length} muted). /unmute clears.` }; }
      const h = Number(a); if (!(h > 0)) { const w = await store.findWallet(a); if (w) { const s = await store.upsertSub({ chat_id: chatId, muted_wallets: [...new Set([...(sub?.muted_wallets ?? []), w.address])] }); return { html: `Muted ${who(w.name, w.address)} (${s.muted_wallets.length} muted).` }; } return { html: "Usage: /mute 6 (hours) or /mute 0x… (wallet)" }; }
      const until = new Date(Date.now() + h * 3600_000).toISOString(); await store.upsertSub({ chat_id: chatId, muted_until: until });
      return { html: `Muted for ${h}h — back at ${new Date(until).toUTCString().slice(17, 22)} UTC.` };
    }
    case "unmute": { await store.upsertSub({ chat_id: chatId, muted_until: null, muted_wallets: [] }); return { html: "Mutes cleared." }; }
    case "signals": {
      const n = Math.min(20, Math.max(1, Number(args[0]) || 8)); const rows = await store.recentSignals(n);
      if (!rows.length) return { html: "No signals yet." };
      return { html: rows.map((s) => `${ago(s.created_at)} ago · ${signalHtml(s)}`).join("\n\n") };
    }
    case "consensus": {
      const rows = await store.consensus(Math.min(15, Number(args[0]) || 10));
      if (!rows.length) return { html: "No market has 2+ tracked wallets on the same side right now." };
      return { html: `<b>Consensus now</b>\n\n` + rows.map((c) => `<b>${c.wallets}×</b> <b>${esc(c.outcome ?? "?")}</b> — <a href="https://polymarket.com/event/${c.slug ?? ""}">${esc(c.title ?? c.slug ?? "")}</a>\n${money(Number(c.cost_usd))} at avg ${Number(c.avg_entry).toFixed(2)} · score ${Math.round(Number(c.weighted_score))}${c.end_date ? ` · ends ${c.end_date}` : ""}\n<i>${esc(c.names.slice(0, 4).join(", "))}${c.names.length > 4 ? ` +${c.names.length - 4}` : ""}</i>`).join("\n\n") };
    }
    case "wallets": {
      const rows = await store.topWallets(Math.min(25, Number(args[0]) || 10));
      if (!rows.length) return { html: "Watchlist is empty — run the refresh or seed it." };
      return { html: `<b>Watchlist — top by copy score</b>\n` + rows.map((w, i) => `${i + 1}. <a href="https://polymarket.com/profile/${w.address}">${who(w.name, w.address)}</a> · ${Math.round(Number(w.copy_score))} · ${money(Number(w.pnl_90d))} 90d · ${esc(w.style)}`).join("\n") };
    }
    case "wallet": {
      if (!args[0]) return { html: "Usage: /wallet crckr or /wallet 0x…" };
      const w = await store.findWallet(args.join(" ")); if (!w) return { html: `No tracked wallet matches "${esc(args.join(" "))}".` };
      const book = await store.openBook(w.address, 6);
      const head = `<b>${who(w.name, w.address)}</b>\n<code>${w.address}</code>\nCopy score <b>${Math.round(Number(w.copy_score))}</b> · 90d ${money(Number(w.pnl_90d))} · ${esc(w.style)}\nNet/DD ${w.net_dd == null ? "—" : Number(w.net_dd).toFixed(1)} · months up ${w.months_up}/${w.months_total} · ${w.fills_per_day == null ? "—" : Math.round(Number(w.fills_per_day))} fills/day · idle ${w.days_idle ?? "—"}d`;
      const b = book.length ? `\n\n<b>Open book</b>\n` + book.map((p) => `${esc(p.outcome ?? "?")} — <a href="https://polymarket.com/event/${p.slug ?? ""}">${esc(p.title ?? p.slug ?? p.token_id.slice(0, 10))}</a>\n${money(Number(p.cost_usd))} at ${Number(p.avg_price).toFixed(2)} · ${ago(p.last_seen)} ago`).join("\n") : "\n\nNo open positions seen by the engine yet.";
      return { html: head + b, buttons: [[{ text: "Profile", url: `https://polymarket.com/profile/${w.address}` }, { text: sub?.muted_wallets.includes(w.address) ? "Muted" : "Mute wallet", callback_data: `mute:${w.address}` }, { text: "Only this wallet", callback_data: `only:${w.address}` }]] };
    }
    case "status": { const s = await store.status(); return { html: `<b>Engine</b>\nTracking ${s.tracked} wallets\n${s.signals24h} signals in 24h\nLast refresh: ${s.lastRefresh ? esc(s.lastRefresh) : "never"}\nLast fill seen: ${s.lastFill ? `${ago(s.lastFill)} ago` : "none"}` }; }
    default: return { html: cmd ? `Unknown command /${esc(cmd)} — /help` : "Send /help for commands." };
  }
}

export async function handleCallback(chatId: number, data: string, store: Store): Promise<string> {
  const [op, arg] = data.split(":");
  const sub = await store.getSub(chatId);
  if (op === "mute" && isAddr(arg)) { const s = await store.upsertSub({ chat_id: chatId, muted_wallets: [...new Set([...(sub?.muted_wallets ?? []), arg.toLowerCase()])] }); return `Muted (${s.muted_wallets.length} wallets muted)`; }
  if (op === "only" && isAddr(arg)) { await store.upsertSub({ chat_id: chatId, only_wallets: [arg.toLowerCase()] }); return "Now only alerting on this wallet. /only all to reset."; }
  return "Unknown action";
}

/** Should this subscriber receive this signal? Pure; unit-tested. */
export function matches(sub: Subscriber, s: SignalRow, now = Date.now()): boolean {
  if (!sub.active) return false;
  if (sub.muted_until && Date.parse(sub.muted_until) > now) return false;
  if (!sub.kinds.includes(s.kind)) return false;
  if (s.severity < sub.min_severity) return false;
  if (Number(s.usd) < Number(sub.min_usd)) return false;
  const score = typeof s.payload?.copyScore === "number" ? (s.payload.copyScore as number) : 100;
  if (score < Number(sub.min_score)) return false;
  if (sub.only_wallets.length && !sub.only_wallets.includes(s.wallet)) return false;
  if (sub.muted_wallets.includes(s.wallet)) return false;
  return true;
}
