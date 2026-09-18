import { db } from "@/lib/db";
export const dynamic = "force-dynamic";
export default async function Signals({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind } = await searchParams;
  let q = db().from("signals").select("*").order("created_at", { ascending: false }).limit(300); if (kind) q = q.eq("kind", kind);
  const { data } = await q;
  const kinds = ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY", "EXIT"];
  return (
    <>
      <h1>Signals</h1>
      <p className="lede">{kinds.map((k) => <a key={k} href={`/signals?kind=${k}`} style={{ marginRight: 14, fontWeight: k === kind ? 600 : 400 }}>{k.replace("_", " ")}</a>)}<a href="/signals">all</a></p>
      {!data?.length ? <div className="empty">Nothing here yet.</div> : (
        <div className="wrap"><table><thead><tr><th>When</th><th>Kind</th><th>Wallet</th><th>Market</th><th>Side</th><th className="r">Price</th><th className="r">USD</th><th>Detail</th><th>Closed</th></tr></thead><tbody>
          {data.map((s) => <tr key={s.id}><td className="mute">{new Date(s.created_at).toUTCString().slice(5, 22)}</td><td><span className="kind">{s.kind.replace("_", " ")}</span></td><td><a href={`https://polymarket.com/profile/${s.wallet}`} target="_blank">{s.wallet_name ?? s.wallet.slice(0, 10)}</a></td><td style={{ whiteSpace: "normal", minWidth: 260 }}><a href={`https://polymarket.com/event/${s.slug}`} target="_blank">{s.title || s.slug}</a></td><td>{s.outcome}</td><td className="r">{Number(s.price).toFixed(3)}</td><td className="r">${Number(s.usd).toFixed(0)}</td><td className="mute" style={{ whiteSpace: "normal", maxWidth: 320 }}>{Object.entries(s.payload ?? {}).filter(([k]) => k !== "peers").map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</td><td className="mute">{s.closed_at ? new Date(s.closed_at).toUTCString().slice(5, 22) : "open"}</td></tr>)}
        </tbody></table></div>
      )}
    </>
  );
}
