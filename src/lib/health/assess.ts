/** Pure health assessment. "Running" is not "healthy": every component has a staleness threshold. */
export interface HealthLine { name: string; ok: boolean; level: "ok" | "warn" | "down"; detail: string }
export interface HealthInput { hb: Record<string, string>; dbOk: boolean; now?: number }
const THRESH = { last_trade: 5 * 60, last_eval: 15 * 60, last_db_write: 15 * 60, last_mark: 45 * 60, last_tg_delivery: 24 * 3600 };
const ago = (iso: string | undefined, now: number) => { if (!iso) return null; const t = Date.parse(iso); return Number.isFinite(t) ? Math.max(0, Math.round(now - t / 1000)) : null; };
export const fmtAgo = (s: number | null) => s == null ? "never" : s < 60 ? `${s} sec ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;

export function assessHealth({ hb, dbOk, now = Math.floor(Date.now() / 1000) }: HealthInput): { lines: HealthLine[]; healthy: boolean } {
  const lines: HealthLine[] = [];
  lines.push({ name: "Database", ok: dbOk, level: dbOk ? "ok" : "down", detail: dbOk ? "Connected" : "Query failed" });
  const ws = hb.ws_connected === "true"; const trade = ago(hb.last_trade, now);
  const wsStale = trade == null || trade > THRESH.last_trade;
  lines.push({ name: "WebSocket", ok: ws && !wsStale, level: !ws ? "down" : wsStale ? "warn" : "ok", detail: !ws ? "Disconnected" : wsStale ? `Connected but no trade received for ${fmtAgo(trade).replace(" ago", "")}` : "Connected" });
  lines.push({ name: "Last trade", ok: !wsStale, level: wsStale ? "warn" : "ok", detail: fmtAgo(trade) });
  const ev = ago(hb.last_eval, now); lines.push({ name: "Last signal evaluation", ok: ev != null && ev <= THRESH.last_eval, level: ev == null ? "down" : ev > THRESH.last_eval ? "warn" : "ok", detail: fmtAgo(ev) });
  const dbw = ago(hb.last_db_write, now); lines.push({ name: "Last database write", ok: dbw != null && dbw <= THRESH.last_db_write, level: dbw == null ? "down" : dbw > THRESH.last_db_write ? "warn" : "ok", detail: fmtAgo(dbw) });
  const tg = ago(hb.last_tg_delivery, now); lines.push({ name: "Last Telegram delivery", ok: true, level: tg == null || tg > THRESH.last_tg_delivery ? "warn" : "ok", detail: fmtAgo(tg) });
  const mk = ago(hb.last_mark, now); lines.push({ name: "Last paper mark", ok: mk != null && mk <= THRESH.last_mark, level: mk == null ? "down" : mk > THRESH.last_mark ? "warn" : "ok", detail: fmtAgo(mk) });
  const healthy = lines.filter((l) => l.name !== "Last Telegram delivery").every((l) => l.ok);
  return { lines, healthy };
}
export function healthHtml(h: ReturnType<typeof assessHealth>, esc: (s: unknown) => string): string {
  const icon = (l: HealthLine) => (l.level === "ok" ? "🟢" : l.level === "warn" ? "⚠️" : "🔴");
  return `<b>${h.healthy ? "🟢 Bot: Online" : "⚠️ Bot: Degraded"}</b>\n` + h.lines.map((l) => `${icon(l)} ${esc(l.name)}: ${esc(l.detail)}`).join("\n");
}
