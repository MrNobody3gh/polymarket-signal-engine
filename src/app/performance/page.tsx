import { db } from "@/lib/db";
import { loadPaper } from "@/lib/paper/queries";
import { computeStats, byKind, byScoreBand, byConsensusDepth, byWallet, currentReturn, pct, usd, MIN_SAMPLE, type Stats } from "@/lib/paper/analytics";
export const dynamic = "force-dynamic";
const KIND: Record<string, string> = { NEW_POSITION: "New position", CONSENSUS: "Consensus", CONVICTION_ADD: "Conviction add", EARLY_ENTRY: "Early entry", EXIT: "Exit" };
const cents = (p: number) => `${(p * 100).toFixed(1)}¢`;
function StatsRow({ label, s, link }: { label: string; s: Stats; link?: string }) {
  return (<tr><td>{link ? <a href={link}>{label}</a> : label}</td><td className="r">{s.signals}</td><td className="r">{s.open}</td><td className="r">{s.resolved + s.exited}</td><td className={`r ${s.pnl >= 0 ? "pos" : "neg"}`}>{usd(s.pnl)}</td><td className="r">{pct(s.avgReturn)}</td><td className="r">{pct(s.medianReturn)}</td><td className="r">{s.winRate == null ? "—" : `${(s.winRate * 100).toFixed(0)}%`}</td><td className="mute">{s.insufficient ? "Insufficient data" : ""}</td></tr>);
}
const HEAD = <thead><tr><th></th><th className="r">Signals</th><th className="r">Open</th><th className="r">Settled</th><th className="r">Paper P&L</th><th className="r">Avg return</th><th className="r">Median</th><th className="r">Win rate</th><th></th></tr></thead>;

export default async function Performance({ searchParams }: { searchParams: Promise<{ window?: string }> }) {
  const { window: win } = await searchParams; const days = win && win !== "all" ? Number(win) : null;
  const { rows, marks } = await loadPaper(db(), { sinceIso: days ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined });
  const st = computeStats(rows, marks);
  return (
    <>
      <h1>Paper performance</h1>
      <p className="lede">Every signal is recorded as a ${rows[0]?.size_usd ?? 100} hypothetical long on the outcome token at the signal price, then marked at 1h / 6h / 24h and settled at resolution or when the wallet exits. Measured results only — nothing here is a forecast. Samples under {MIN_SAMPLE} are flagged.</p>
      <p className="lede">{[["7", "7 days"], ["30", "30 days"], ["all", "All time"]].map(([v, l]) => <a key={v} href={`/performance?window=${v}`} style={{ marginRight: 14, fontWeight: (win ?? "all") === v ? 600 : 400 }}>{l}</a>)}</p>
      <h2>Overview</h2>
      <div className="stats">
        <div className="stat"><b>{st.signals}</b><span>signals</span></div>
        <div className="stat"><b>{st.open}</b><span>open</span></div>
        <div className="stat"><b>{st.resolved + st.exited}</b><span>settled ({st.resolved} resolved, {st.exited} exited)</span></div>
        <div className="stat"><b className={st.pnl >= 0 ? "pos" : "neg"}>{usd(st.pnl)}</b><span>hypothetical P&L</span></div>
        <div className="stat"><b>{pct(st.avgReturn)}</b><span>average return</span></div>
        <div className="stat"><b>{pct(st.medianReturn)}</b><span>median return</span></div>
        <div className="stat"><b>{st.winRate == null ? "—" : `${(st.winRate * 100).toFixed(1)}%`}</b><span>win rate (settled only)</span></div>
      </div>
      {st.best && <p className="mute">Best: {pct(st.best.ret)} <a href={`/signal/${st.best.id}`}>{st.best.title ?? st.best.id.slice(0, 8)}</a> · Worst: {pct(st.worst!.ret)} <a href={`/signal/${st.worst!.id}`}>{st.worst!.title ?? st.worst!.id.slice(0, 8)}</a>{st.insufficient ? " · Insufficient data for conclusions." : ""}</p>}
      <h2>By signal type</h2>
      <div className="wrap"><table>{HEAD}<tbody>{byKind(rows, marks).map((k) => <StatsRow key={k.key} label={KIND[k.key] ?? k.key} s={k.stats} />)}</tbody></table></div>
      <h2>By wallet copy score at signal time</h2>
      <div className="wrap"><table>{HEAD}<tbody>{byScoreBand(rows, marks).map((k) => <StatsRow key={k.key} label={k.key} s={k.stats} />)}</tbody></table></div>
      <h2>By consensus depth (consensus signals only)</h2>
      <div className="wrap"><table>{HEAD}<tbody>{byConsensusDepth(rows, marks).map((k) => <StatsRow key={k.key} label={k.key} s={k.stats} />)}</tbody></table></div>
      {!byConsensusDepth(rows, marks).length && <div className="empty">No consensus signals in this window.</div>}
      <h2>By wallet</h2>
      <div className="wrap"><table>{HEAD}<tbody>{byWallet(rows, marks).slice(0, 100).map((w) => <StatsRow key={w.key} label={w.name ?? w.key.slice(0, 10)} s={w.stats} link={`https://polymarket.com/profile/${w.key}`} />)}</tbody></table></div>
      <h2>Signal history</h2>
      <div className="wrap"><table><thead><tr><th>When</th><th>Type</th><th>Wallet</th><th>Market</th><th>Side</th><th className="r">Entry</th><th className="r">Score</th><th className="r">Cons.</th><th className="r">Now / settled</th><th className="r">Paper P&L</th><th>Status</th></tr></thead><tbody>
        {rows.slice(0, 300).map((r) => { const c = currentReturn(r, marks); const latest = marks.filter((m) => m.signal_id === r.signal_id).sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0];
          return <tr key={r.signal_id}><td className="mute"><a href={`/signal/${r.signal_id}`}>{r.signal_ts.slice(5, 16).replace("T", " ")}</a></td><td>{KIND[r.kind] ?? r.kind}</td><td>{r.wallet_name ?? r.wallet?.slice(0, 8)}</td><td style={{ whiteSpace: "normal", minWidth: 220 }}>{r.title}</td><td>{r.outcome}</td><td className="r">{cents(r.entry_price)}</td><td className="r">{r.copy_score == null ? "—" : Math.round(r.copy_score)}</td><td className="r">{r.consensus_depth ?? "—"}</td><td className="r">{latest ? cents(latest.price) : "—"}</td><td className={`r ${c ? (c.pnl >= 0 ? "pos" : "neg") : "mute"}`}>{c ? usd(c.pnl) : "—"}</td><td className="mute">{r.status}</td></tr>; })}
      </tbody></table></div>
    </>
  );
}
