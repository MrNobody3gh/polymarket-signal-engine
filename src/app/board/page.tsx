import { db } from "@/lib/db";
export const dynamic = "force-dynamic";
const money = (v: number) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}k` : `$${v.toFixed(0)}`);
const ago = (iso: string) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const cutoff48 = () => new Date(Date.now() - 48 * 3600_000).toISOString();

/** Live version of the published snapshot: same sections, fed from Supabase. */
export default async function Board() {
  const d = db();
  const [{ data: wallets }, { data: cons }, { data: fresh }, { data: fills }, { data: refreshed }] = await Promise.all([
    d.from("wallets").select("*").order("pnl_90d", { ascending: false }).limit(1500),
    d.from("consensus_now").select("*").order("wallets", { ascending: false }).order("weighted_score", { ascending: false }).limit(30),
    d.from("positions").select("wallet,title,slug,outcome,avg_price,cost_usd,last_seen,end_date").gt("size", 0).gte("cost_usd", 2000).gte("last_seen", cutoff48()).order("last_seen", { ascending: false }).limit(60),
    d.from("fills").select("wallet,side,title,slug,outcome,price,usd,ts").gte("usd", 50).order("ts", { ascending: false }).limit(60),
    d.from("cursors").select("value").eq("key", "refresh:last").maybeSingle(),
  ]);
  const W = wallets ?? []; const byAddr = new Map(W.map((w) => [w.address, w]));
  const name = (a: string) => byAddr.get(a)?.name ?? `${a.slice(0, 6)}…${a.slice(-4)}`;
  const pos = W.filter((w) => Number(w.pnl_90d) > 0); const grossPos = pos.reduce((s, w) => s + Number(w.pnl_90d), 0);
  const styles = new Map<string, { n: number; pnl: number }>();
  for (const w of W) { const e = styles.get(w.style) ?? { n: 0, pnl: 0 }; e.n++; e.pnl += Number(w.pnl_90d); styles.set(w.style, e); }
  const top10 = W.slice(0, 10).reduce((s, w) => s + Number(w.pnl_90d), 0);
  const byScore = [...W].sort((a, b) => Number(b.copy_score) - Number(a.copy_score) || Number(b.pnl_90d) - Number(a.pnl_90d)).slice(0, 100);
  const ref = refreshed?.value ? new Date(Number(refreshed.value) * 1000).toUTCString().slice(5, 22) + " UTC" : null;

  return (
    <>
      <h1>Live board</h1>
      <p className="lede">The same read as the published snapshot, but from the engine's own data. Wallets re-score daily{ref ? ` (last ${ref})` : " — not yet run"}; positions and fills update with every poll and every websocket fill.</p>
      {!W.length ? <div className="empty">No wallets scored yet. Run <code>npm run refresh -- --seed</code> for the snapshot watchlist, or <code>npm run refresh</code> for a full re-score.</div> : (<>
        <div className="stats">
          <div className="stat"><b>{money(W.reduce((s, w) => s + Number(w.pnl_90d), 0))}</b><span>net 90-day profit, cohort</span></div>
          <div className="stat"><b>{pos.length} / {W.length}</b><span>wallets up over the window</span></div>
          <div className="stat"><b>{Math.round((top10 / Math.max(1, grossPos)) * 100)}%</b><span>of gross profit in 10 wallets</span></div>
          <div className="stat"><b>{W.filter((w) => Number(w.copy_score) >= 50).length}</b><span>copy score ≥ 50</span></div>
          <div className="stat"><b>{W.filter((w) => w.tracked).length}</b><span>on the watchlist</span></div>
        </div>
        <h2>Where the profit came from</h2>
        <div className="wrap"><table><thead><tr><th>Style</th><th className="r">Wallets</th><th className="r">90d PnL</th></tr></thead><tbody>
          {[...styles.entries()].sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => <tr key={k}><td>{k}</td><td className="r">{v.n}</td><td className={`r ${v.pnl >= 0 ? "pos" : "neg"}`}>{money(v.pnl)}</td></tr>)}
        </tbody></table></div>
        <h2>Consensus now</h2>
        {!cons?.length ? <div className="empty">No market has 2+ tracked wallets on the same side yet — needs a few polls to build the book.</div> : (
          <div className="wrap"><table><thead><tr><th className="r">Wallets</th><th>Side</th><th>Market</th><th className="r">Cost</th><th className="r">Avg entry</th><th className="r">Score</th><th>Who</th><th>Ends</th></tr></thead><tbody>
            {cons.map((c) => <tr key={c.token_id}><td className="r"><b>{c.wallets}</b></td><td>{c.outcome}</td><td style={{ whiteSpace: "normal", minWidth: 260 }}><a href={`https://polymarket.com/event/${c.slug}`} target="_blank">{c.title ?? c.slug}</a></td><td className="r">{money(Number(c.cost_usd))}</td><td className="r">{Number(c.avg_entry).toFixed(2)}</td><td className="r">{Math.round(Number(c.weighted_score))}</td><td className="mute">{(c.names as string[]).slice(0, 4).join(", ")}</td><td className="mute">{c.end_date ?? "—"}</td></tr>)}
          </tbody></table></div>
        )}
        <h2>Fresh entries — last 48 hours</h2>
        {!fresh?.length ? <div className="empty">Nothing $2k+ in the last 48h yet.</div> : (
          <div className="wrap"><table><thead><tr><th>When</th><th>Wallet</th><th className="r">Score</th><th>Market</th><th>Side</th><th className="r">Entry</th><th className="r">Cost</th></tr></thead><tbody>
            {fresh.map((p, i) => <tr key={i}><td className="mute">{ago(p.last_seen)} ago</td><td><a href={`https://polymarket.com/profile/${p.wallet}`} target="_blank">{name(p.wallet)}</a></td><td className="r">{Math.round(Number(byAddr.get(p.wallet)?.copy_score ?? 0))}</td><td style={{ whiteSpace: "normal", minWidth: 260 }}><a href={`https://polymarket.com/event/${p.slug}`} target="_blank">{p.title ?? p.slug}</a></td><td>{p.outcome}</td><td className="r">{Number(p.avg_price).toFixed(3)}</td><td className="r">{money(Number(p.cost_usd))}</td></tr>)}
          </tbody></table></div>
        )}
        <h2>Latest fills</h2>
        {!fills?.length ? <div className="empty">No fills yet — start the poller or the websocket worker.</div> : (
          <div className="wrap"><table><thead><tr><th>When</th><th>Wallet</th><th>Side</th><th>Market</th><th>Outcome</th><th className="r">Price</th><th className="r">USD</th></tr></thead><tbody>
            {fills.map((f, i) => <tr key={i}><td className="mute">{ago(f.ts)} ago</td><td><a href={`https://polymarket.com/profile/${f.wallet}`} target="_blank">{name(f.wallet)}</a></td><td className={f.side === "BUY" ? "pos" : "neg"}>{f.side}</td><td style={{ whiteSpace: "normal", minWidth: 260 }}><a href={`https://polymarket.com/event/${f.slug}`} target="_blank">{f.title ?? f.slug}</a></td><td>{f.outcome}</td><td className="r">{Number(f.price).toFixed(3)}</td><td className="r">{money(Number(f.usd))}</td></tr>)}
          </tbody></table></div>
        )}
        <h2>The board — top 100 by copy score</h2>
        <div className="wrap"><table><thead><tr><th>#</th><th>Wallet</th><th className="r">90d PnL</th><th className="r">Score</th><th>Style</th><th className="r">Net/DD</th><th className="r">Months up</th><th className="r">Fills/day</th><th className="r">Idle</th></tr></thead><tbody>
          {byScore.map((w, i) => <tr key={w.address}><td>{i + 1}</td><td><a href={`https://polymarket.com/profile/${w.address}`} target="_blank">{w.name ?? w.address.slice(0, 10)}</a>{w.tracked ? "" : <span className="mute"> · untracked</span>}</td><td className={`r ${Number(w.pnl_90d) >= 0 ? "pos" : "neg"}`}>{money(Number(w.pnl_90d))}</td><td className="r">{Math.round(Number(w.copy_score))}</td><td>{w.style}</td><td className="r">{w.net_dd == null ? "—" : Number(w.net_dd).toFixed(1)}</td><td className="r">{w.months_up}/{w.months_total}</td><td className="r">{w.fills_per_day == null ? "—" : Math.round(Number(w.fills_per_day))}</td><td className="r">{w.days_idle ?? "—"}</td></tr>)}
        </tbody></table></div>
      </>)}
      <p className="mute" style={{ marginTop: 24 }}>Read-only research on public data, straight from data-api.polymarket.com v2. Nothing here places trades or gives advice.</p>
    </>
  );
}
