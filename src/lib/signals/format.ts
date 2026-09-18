import type { Signal } from "../polymarket/types";
const money = (v: number) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : `$${v.toFixed(0)}`);
const KIND: Record<Signal["kind"], string> = { NEW_POSITION: "New position", CONSENSUS: "Consensus", CONVICTION_ADD: "Conviction add", EARLY_ENTRY: "Early entry", EXIT: "Exit" };
export function marketUrl(s: Signal): string { return s.slug ? `https://polymarket.com/event/${s.slug}` : "https://polymarket.com"; }
export function profileUrl(s: Signal): string { return `https://polymarket.com/profile/${s.wallet}`; }
/** Plain-text body shared by every channel (Telegram uses it as HTML-safe text). */
export function formatSignal(s: Signal): string {
  const who = s.walletName ?? `${s.wallet.slice(0, 6)}…${s.wallet.slice(-4)}`;
  const stars = "★".repeat(s.severity) + "☆".repeat(5 - s.severity);
  const head = `${KIND[s.kind]} ${stars}`;
  const line = `${who} ${s.kind === "EXIT" ? "sold" : "bought"} ${s.outcome || "?"} @ ${s.price.toFixed(3)} for ${money(s.usd)}`;
  const extra: string[] = [];
  const p = s.payload as Record<string, unknown>;
  if (typeof p.copyScore === "number") extra.push(`copy score ${p.copyScore}`);
  if (typeof p.wallets === "number") extra.push(`${p.wallets} wallets same side`);
  if (typeof p.daysToEnd === "number") extra.push(`${p.daysToEnd}d to resolution`);
  if (typeof p.soldFraction === "number") extra.push(`sold ${(Number(p.soldFraction) * 100).toFixed(0)}%`);
  return [head, s.title || s.slug, line, extra.join(" · "), marketUrl(s), profileUrl(s)].filter(Boolean).join("\n");
}
