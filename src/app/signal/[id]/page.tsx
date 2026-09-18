import { db } from "@/lib/db";
import { loadSignalDetail } from "@/lib/paper/queries";
import { pct, usd } from "@/lib/paper/analytics";
export const dynamic = "force-dynamic";
const KIND: Record<string, string> = { NEW_POSITION: "New position", CONSENSUS: "Consensus", CONVICTION_ADD: "Conviction add", EARLY_ENTRY: "Early entry", EXIT: "Exit" };
const cents = (p: number) => `${(p * 100).toFixed(1)}¢`;
const t = (iso: string) => new Date(iso).toUTCString().slice(5, 22) + " UTC";
export default async function SignalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const d = await loadSignalDetail(db(), id);
  if (!d.row) return <><h1>Signal</h1><div className="empty">{d.ambiguous ? "Ambiguous id prefix." : "No paper record for this id."}</div></>;
  const r = d.row as Record<string, unknown>; const marks = d.marks as { horizon: string; observed_at: string; price: number; pnl: number; return_pct: number; source: string }[]; const c = d.consensus as Record<string, unknown> | null;
  const entry = Number(r.entry_price);
  return (
    <>
      <h1>{KIND[String(r.kind)] ?? String(r.kind)} — {String(r.title ?? r.slug ?? "")}</h1>
      <p className="lede"><a href={`https://polymarket.com/profile/${r.wallet}`} target="_blank">{String(r.wallet_name ?? String(r.wallet).slice(0, 10))}</a> {r.side === "EXIT_EVENT" ? "sold" : "bought"} <b>{String(r.outcome ?? "")}</b> at {cents(entry)} · real trade {r.trade_usd != null ? `$${Number(r.trade_usd).toFixed(0)}` : "—"} · <a href={`https://polymarket.com/event/${r.slug}`} target="_blank">market ↗</a></p>
      <div className="stats">
        <div className="stat"><b>{r.side === "EXIT_EVENT" ? "exit event" : `$${r.size_usd} → ${Number(r.shares).toFixed(2)} sh`}</b><span>paper position</span></div>
        <div className="stat"><b>{r.copy_score == null ? "—" : Math.round(Number(r.copy_score))}</b><span>wallet copy score</span></div>
        <div className="stat"><b>{r.severity == null ? "—" : String(r.severity)}</b><span>severity</span></div>
        <div className="stat"><b>{r.consensus_depth == null ? "—" : String(r.consensus_depth)}</b><span>consensus depth</span></div>
        <div className="stat"><b>{String(r.status)}</b><span>{String(r.status_reason ?? "status")}</span></div>
      </div>
      {c && <p className="mute">Consensus participants: {(c.participants as string[]).map((w) => w.slice(0, 8)).join(", ")}{c.spread_seconds != null ? ` · first-to-this spread ${Math.round(Number(c.spread_seconds) / 60)} min` : ""}{c.combined_usd != null ? ` · combined tracked cost $${Number(c.combined_usd).toFixed(0)}` : ""} · entries {(c.entry_prices as number[]).map((p) => cents(Number(p))).join(", ")}</p>}
      <h2>Timeline</h2>
      <div className="wrap"><table><thead><tr><th>When</th><th>Event</th><th className="r">Price</th><th className="r">Paper P&L</th><th className="r">Return</th><th>Source</th></tr></thead><tbody>
        <tr><td className="mute">{t(String(r.signal_ts))}</td><td>Signal detected</td><td className="r">{cents(entry)}</td><td className="r">—</td><td className="r">—</td><td className="mute">fill</td></tr>
        {marks.map((m) => <tr key={m.horizon}><td className="mute">{t(m.observed_at)}</td><td>{m.horizon === "resolution" ? "Resolution" : m.horizon === "exit" ? "Wallet exited" : `Market +${m.horizon}`}</td><td className="r">{cents(Number(m.price))}</td><td className={`r ${Number(m.pnl) >= 0 ? "pos" : "neg"}`}>{usd(Number(m.pnl))}</td><td className="r">{pct(Number(m.return_pct))}</td><td className="mute">{m.source}</td></tr>)}
      </tbody></table></div>
      {!marks.length && <div className="empty">No observations recorded yet. The marker adds 1h / 6h / 24h points as they become available and a resolution point when the market settles. Nothing is interpolated.</div>}
    </>
  );
}
