import { db } from "@/lib/db";
export const dynamic = "force-dynamic";
const money = (v: number) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`);
export default async function Wallets() {
  const { data } = await db().from("wallets").select("*").eq("tracked", true).order("copy_score", { ascending: false }).limit(300);
  return (
    <>
      <h1>Watchlist</h1>
      <p className="lede">Wallets with copy score ≥ 40 (top 150) plus the top 50 by 90-day profit. Re-scored daily; the websocket worker reloads this list every 10 minutes.</p>
      {!data?.length ? <div className="empty">Empty. Seed it: <code>/api/cron/refresh-wallets?seed=1</code></div> : (
        <div className="wrap"><table><thead><tr><th>#</th><th>Wallet</th><th className="r">90d PnL</th><th className="r">Copy score</th><th>Style</th><th className="r">Net/DD</th><th className="r">Months up</th><th className="r">Fills/day</th><th className="r">Program</th><th className="r">Conc.</th><th className="r">Idle</th></tr></thead><tbody>
          {data.map((w, i) => <tr key={w.address}><td>{i + 1}</td><td><a href={`https://polymarket.com/profile/${w.address}`} target="_blank">{w.name ?? w.address.slice(0, 10)}</a></td><td className={`r ${Number(w.pnl_90d) >= 0 ? "pos" : "neg"}`}>{money(Number(w.pnl_90d))}</td><td className="r">{Number(w.copy_score).toFixed(0)}</td><td>{w.style}</td><td className="r">{w.net_dd == null ? "—" : Number(w.net_dd).toFixed(1)}</td><td className="r">{w.months_up}/{w.months_total}</td><td className="r">{w.fills_per_day == null ? "—" : Number(w.fills_per_day).toFixed(0)}</td><td className="r">{w.program_share == null ? "—" : `${(Number(w.program_share) * 100).toFixed(0)}%`}</td><td className="r">{w.concentration == null ? "—" : `${(Number(w.concentration) * 100).toFixed(0)}%`}</td><td className="r">{w.days_idle ?? "—"}</td></tr>)}
        </tbody></table></div>
      )}
    </>
  );
}
