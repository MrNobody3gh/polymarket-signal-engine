import { db } from "@/lib/db";
export const dynamic = "force-dynamic";
const money = (v: number) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`);
export default async function Home() {
  const d = db();
  const [{ count: tracked }, { count: signals24 }, { data: last }, { data: refreshed }] = await Promise.all([
    d.from("wallets").select("address", { count: "exact", head: true }).eq("tracked", true),
    d.from("signals").select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 86_400_000).toISOString()),
    d.from("signals").select("*").order("created_at", { ascending: false }).limit(12),
    d.from("cursors").select("value").eq("key", "refresh:last").maybeSingle(),
  ]);
  const ref = refreshed?.value ? new Date(Number(refreshed.value) * 1000).toUTCString() : "never — run /api/cron/refresh-wallets?seed=1";
  return (
    <>
      <h1>Copy-signal engine</h1>
      <p className="lede">Watches the wallets that earned their way onto the watchlist and alerts when they open, add, or exit. Everything below is what the rules fired; the alerts went to your channels.</p>
      <div className="stats">
        <div className="stat"><b>{tracked ?? 0}</b><span>wallets tracked</span></div>
        <div className="stat"><b>{signals24 ?? 0}</b><span>signals in the last 24h</span></div>
        <div className="stat"><b style={{ fontSize: "1rem" }}>{ref}</b><span>last cohort refresh</span></div>
      </div>
      <h2>Latest signals</h2>
      {!last?.length ? <div className="empty">No signals yet. Seed the watchlist with <code>/api/cron/refresh-wallets?seed=1</code>, then let the poller or the websocket worker run for a few minutes.</div> : (
        <div className="wrap"><table><thead><tr><th>When</th><th>Kind</th><th>Wallet</th><th>Market</th><th>Side</th><th className="r">Price</th><th className="r">USD</th><th className="r">Sev.</th></tr></thead><tbody>
          {last.map((s) => <tr key={s.id}><td className="mute">{new Date(s.created_at).toUTCString().slice(5, 22)}</td><td><span className="kind">{s.kind.replace("_", " ")}</span></td><td><a href={`https://polymarket.com/profile/${s.wallet}`} target="_blank">{s.wallet_name ?? s.wallet.slice(0, 10)}</a></td><td style={{ whiteSpace: "normal", minWidth: 260 }}><a href={`https://polymarket.com/event/${s.slug}`} target="_blank">{s.title || s.slug}</a></td><td>{s.outcome}</td><td className="r">{Number(s.price).toFixed(3)}</td><td className="r">{money(Number(s.usd))}</td><td className="r">{"★".repeat(s.severity)}</td></tr>)}
        </tbody></table></div>
      )}
    </>
  );
}
