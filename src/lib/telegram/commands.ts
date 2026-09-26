/**
 * Bot command layer. Pure with respect to Telegram: every handler takes a
 * `Store` (a thin data interface, mocked in tests) and returns HTML + buttons.
 */
import { esc, money, type TgButton } from "./api";
import type { SignalKind } from "../polymarket/types";
import { pct, usd, type PaperRowLite, type MarkLite, MIN_SAMPLE } from "../paper/analytics";
import type { PaperSnapshot } from "../paper/snapshot";
import { assessHealth, healthHtml } from "../health/assess";

export interface Subscriber { chat_id: number; username: string | null; kinds: string[]; min_severity: number; min_usd: number; min_score: number; only_wallets: string[]; muted_wallets: string[]; muted_until: string | null; active: boolean;
  consecutive_failures?: number; next_attempt_at?: string | null; last_error?: string | null; disabled_reason?: string | null; migrated_to?: number | null }
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
  // V2
  paper(o: { sinceIso?: string; wallet?: string }): Promise<{ rows: PaperRowLite[]; marks: MarkLite[] }>;
  snapshot(): Promise<PaperSnapshot | null>;
  signalDetail(idOrPrefix: string): Promise<{ row: Record<string, unknown> | null; marks: Record<string, unknown>[]; consensus: Record<string, unknown> | null; ambiguous: boolean }>;
  health(): Promise<{ hb: Record<string, string>; dbOk: boolean }>;
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
const KIND_EMOJI: Record<SignalKind, string> = { NEW_POSITION: "🚨", CONSENSUS: "👥", CONVICTION_ADD: "📈", EARLY_ENTRY: "🎯", EXIT: "🚪" };
const cents = (p: number) => `${(p * 100).toFixed(1)}¢`;
const hhmm = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(11, 16) + " UTC"; };
/** Alert layout. Every line is backed by a real field on the signal; missing fields are omitted, never faked. */
export function signalHtml(s: SignalRow): string {
  const p = s.payload ?? {}; const sell = s.kind === "EXIT";
  const L: string[] = [];
  L.push(`${KIND_EMOJI[s.kind]} <b>${KIND_LABEL[s.kind].toUpperCase()}</b> ${stars(s.severity)}`);
  if (s.title || s.slug) L.push(`\n${esc(s.title ?? s.slug)}`);
  L.push(`\n👤 <a href="https://polymarket.com/profile/${s.wallet}">${who(s.wallet_name, s.wallet)}</a>`);
  L.push(`${sell ? "🔴 Sold" : "🟢 Bought"} <b>${esc(s.outcome ?? "?")}</b>`);
  L.push(`\n💰 Trade: <b>${money(Number(s.usd))}</b>`);
  L.push(`📍 ${sell ? "Exit" : "Entry"}: ${cents(Number(s.price))}`);
  if (typeof p.avgEntry === "number" && sell) L.push(`📍 Their avg entry: ${cents(Number(p.avgEntry))}`);
  const ctx: string[] = [];
  if (typeof p.copyScore === "number") ctx.push(`⭐ Copy score: ${Math.round(Number(p.copyScore))}/100`);
  if (typeof p.wallets === "number") ctx.push(`👥 Consensus: ${p.wallets} wallets same side`);
  if (typeof p.beforeSize === "number" && typeof p.addSize === "number" && Number(p.beforeSize) > 0) ctx.push(`➕ Added ${Math.round((Number(p.addSize) / Number(p.beforeSize)) * 100)}% to position`);
  if (typeof p.daysToEnd === "number") ctx.push(`📅 ${p.daysToEnd}d to resolution`);
  if (typeof p.soldFraction === "number") ctx.push(`📉 Sold ${Math.round(Number(p.soldFraction) * 100)}% of position`);
  if (ctx.length) L.push("\n" + ctx.join("\n"));
  const t = hhmm(s.created_at); if (t) L.push(`\n⏱ Detected: ${t}`);
  L.push(`\n<i>Paper ref: ${s.id.slice(0, 8)} · /signal ${s.id.slice(0, 8)}</i>`);
  return L.join("\n");
}
export function signalButtons(s: SignalRow): TgButton[][] {
  return [[{ text: "Market ↗", url: `https://polymarket.com/event/${s.slug ?? ""}` }, { text: "Wallet ↗", url: `https://polymarket.com/profile/${s.wallet}` }], [{ text: "🔕 Mute wallet", callback_data: `mute:${s.wallet}` }]];
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
      // (Re)subscribing always clears any delivery back-off or disable left over from earlier failures.
      const s = await store.upsertSub({ chat_id: chatId, username, active: true, muted_until: null, consecutive_failures: 0, next_attempt_at: null, disabled_reason: null, last_error: null });
      return { html: `Subscribed. You'll get alerts when a watchlist wallet opens, adds, or exits.\n\n${filtersHtml(s)}\n\nTry /signals, /consensus, /wallets, or /help.` };
    }
    case "help": return { html: `<b>Commands</b>\n/signals [n] — latest signals\n/consensus — markets where 2+ tracked wallets agree\n/wallets [n] — top of the watchlist\n/wallet &lt;name or 0x…&gt; — profile and open book\n/filters — your alert filters\n/kinds new consensus add early exit — choose kinds\n/severity 1–5 — minimum severity\n/min 5000 — minimum fill in USD\n/score 60 — minimum copy score\n/only 0x… 0x… — only these wallets (/only all to reset)\n/mute 6 — mute 6 hours · /mute 0x… — mute a wallet\n/unmute — clear mutes\n/stop — unsubscribe\n/status — engine health\n\n<b>Paper performance (V2)</b>\n/performance [7d|30d|all] — measured paper results\n/stats — compact overview\n/signal &lt;id&gt; — one signal, what happened after` };
    case "stop": { await store.upsertSub({ chat_id: chatId, active: false, disabled_reason: "USER_STOP" }); return { html: "Unsubscribed. /start to resume." }; }
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
      const snap = await store.snapshot(); const ws = snap?.wallets[w.address]; const ps = ws?.stats;
      const perf = ps && ps.signals ? `\n\n<b>Paper performance</b> (n=${ps.signals}, ${ps.open} open, ${ps.resolved + ps.exited} settled)\nP&amp;L ${usd(ps.pnl)} · avg ${pct(ps.avgReturn)} · median ${pct(ps.medianReturn)}\nWin rate ${ps.winRate == null ? "—" : (ps.winRate * 100).toFixed(0) + "%"} · avg win ${pct(ps.avgWin)} · avg loss ${pct(ps.avgLoss)}${ps.insufficient ? "\n<i>Insufficient data.</i>" : ""}` + ws!.byKind.map((k) => `\n${KIND_LABEL[k.key as SignalKind] ?? k.key}: n=${k.stats.signals}, ${usd(k.stats.pnl)}${k.stats.insufficient ? " (insufficient)" : ""}`).join("") : "\n\n<i>No paper signals for this wallet yet.</i>";
      return { html: head + b + perf, buttons: [[{ text: "Profile", url: `https://polymarket.com/profile/${w.address}` }, { text: sub?.muted_wallets.includes(w.address) ? "Muted" : "Mute wallet", callback_data: `mute:${w.address}` }, { text: "Only this wallet", callback_data: `only:${w.address}` }]] };
    }
    case "status": {
      const s = await store.status(); const h = await store.health();
      return { html: `${healthHtml(assessHealth(h), esc)}\n\nTracking ${s.tracked} wallets · ${s.signals24h} signals in 24h\nLast re-score: ${s.lastRefresh ? esc(s.lastRefresh) : "never"}` };
    }
    case "performance": case "stats": {
      const win = (args[0] ?? (cmd === "stats" ? "30d" : "all")).toLowerCase();
      const key = win === "all" ? "all" : win === "7d" ? "d7" : win === "30d" ? "d30" : null;
      if (!key) return { html: "Usage: /performance, /performance 7d, /performance 30d" };
      const snap = await store.snapshot();
      if (!snap) return { html: "Performance snapshot not built yet — the worker rebuilds it every few minutes after marking." };
      const w = snap.windows[key]; const st = w.stats; const label = key === "all" ? "all time" : key === "d7" ? "last 7 days" : "last 30 days";
      const head = `📊 <b>PAPER PERFORMANCE</b> — ${label}\n$${w.sizeUsd} hypothetical per signal, long the outcome token at the signal price. Built ${ago(snap.builtAt)} ago.`;
      if (!st.signals) return { html: `${head}\n\nNo paper signals in this window yet.` };
      const core = `\nSignals: ${st.signals}\nOpen: ${st.open} · Resolved: ${st.resolved} · Exited: ${st.exited}${st.unresolved ? ` · Unresolved: ${st.unresolved}` : ""}${st.invalid ? ` · Invalid: ${st.invalid}` : ""}\nObserved (have a price after entry): ${st.observed}\n\nHypothetical P&amp;L: <b>${usd(st.pnl)}</b>\nAverage return: ${pct(st.avgReturn)}\nMedian return: ${pct(st.medianReturn)}\nWin rate (settled only): ${st.winRate == null ? "— (nothing settled yet)" : `${(st.winRate * 100).toFixed(1)}% of ${st.resolved + st.exited}`}\nAvg win / avg loss: ${pct(st.avgWin)} / ${pct(st.avgLoss)}`;
      if (cmd === "stats") return { html: `${head}${core}\n\n<i>Paper only. ${st.insufficient ? "Insufficient data for conclusions." : ""}</i>` };
      const kinds = w.byKind.map((k) => `${KIND_LABEL[k.key as SignalKind] ?? k.key}: n=${k.stats.signals}, P&amp;L ${usd(k.stats.pnl)}, avg ${pct(k.stats.avgReturn)}${k.stats.insufficient ? " (insufficient)" : ""}`).join("\n");
      const bw = st.best ? `\n\nBest: ${pct(st.best.ret)} — ${esc(st.best.title ?? st.best.id.slice(0, 8))}\nWorst: ${pct(st.worst!.ret)} — ${esc(st.worst!.title ?? st.worst!.id.slice(0, 8))}` : "";
      return { html: `${head}${core}\n\n<b>By signal type</b>\n${kinds}${bw}\n\n<i>Paper only. Samples under ${MIN_SAMPLE} are flagged insufficient; nothing here is a recommendation.</i>` };
    }
    case "signal": {
      if (!args[0]) return { html: "Usage: /signal &lt;id or first 8 chars&gt; — the ref is printed on every alert" };
      const d = await store.signalDetail(args[0]);
      if (d.ambiguous) return { html: "That prefix matches more than one signal — give a few more characters." };
      if (!d.row) return { html: `No paper record for "${esc(args[0])}".` };
      const r = d.row as Record<string, unknown>; const marks = d.marks as { horizon: string; observed_at: string; price: number; pnl: number; return_pct: number; source: string }[];
      const entry = Number(r.entry_price); const ts = String(r.signal_ts);
      const lines = [`🔍 <b>Signal ${String(r.signal_id).slice(0, 8)}</b> — ${esc(KIND_LABEL[r.kind as SignalKind] ?? r.kind)}`, esc(String(r.title ?? r.slug ?? "")), `👤 ${esc(String(r.wallet_name ?? String(r.wallet ?? "").slice(0, 10)))} · <b>${esc(String(r.outcome ?? ""))}</b>`,
        r.side === "EXIT_EVENT" ? `🚪 Exit event at ${cents(entry)} — closes paper longs, no position of its own` : `📍 Entry ${cents(entry)} · $${r.size_usd} → ${Number(r.shares).toFixed(2)} shares`,
        `⭐ Score ${r.copy_score ?? "—"} · sev ${r.severity ?? "—"}${r.consensus_depth ? ` · 👥 ${r.consensus_depth} wallets` : ""} · real trade ${r.trade_usd != null ? money(Number(r.trade_usd)) : "—"}`, `⏱ ${hhmm(ts)} ${ts.slice(0, 10)}`];
      if (d.consensus) { const c = d.consensus as Record<string, unknown>; lines.push(`👥 Participants: ${(c.participants as string[]).map((w) => esc(w.slice(0, 8))).join(", ")}${c.spread_seconds != null ? ` · spread ${Math.round(Number(c.spread_seconds) / 60)} min` : ""}${c.combined_usd != null ? ` · combined ${money(Number(c.combined_usd))}` : ""}`); }
      lines.push(`\n<b>Timeline</b>\n${hhmm(ts)} — signal at ${cents(entry)}`);
      if (!marks.length) lines.push("<i>No observations yet — the marker records 1h / 6h / 24h and resolution as they become available.</i>");
      for (const m of marks) lines.push(`${m.horizon === "resolution" ? "Resolution" : m.horizon === "exit" ? "Exit" : "+" + m.horizon} — ${cents(Number(m.price))} · ${usd(Number(m.pnl))} (${pct(Number(m.return_pct))})`);
      lines.push(`\nStatus: <b>${esc(String(r.status))}</b>${r.status_reason ? ` — ${esc(String(r.status_reason))}` : ""}${r.final_pnl != null ? ` · settled ${usd(Number(r.final_pnl))}` : ""}`);
      return { html: lines.join("\n"), buttons: [[{ text: "Market ↗", url: `https://polymarket.com/event/${r.slug ?? ""}` }, { text: "Wallet ↗", url: `https://polymarket.com/profile/${r.wallet ?? ""}` }]] };
    }
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
