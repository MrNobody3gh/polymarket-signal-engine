import { db } from "@/lib/db";
import { ASSUMPTIONS, MODES } from "@/lib/paper/sim/config";
export const dynamic = "force-dynamic";
type R = Record<string, any>;
const $ = (v: any) => (v == null ? "—" : `${Number(v) < 0 ? "−" : ""}$${Math.abs(Number(v)).toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
const pc = (v: any, d = 1) => (v == null ? "—" : `${(Number(v) * 100).toFixed(d)}%`);
const n = (v: any, d = 1) => (v == null ? "—" : Number(v).toFixed(d));
const int = (v: any) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
const MODE_ORDER = ["IDEAL", "REALISTIC", "CONSERVATIVE"];

export default async function Execution() {
  const [{ data }, { data: mem }] = await Promise.all([db().from("cursors").select("value").eq("key", "paper:execution").maybeSingle(), db().from("cursors").select("value").eq("key", "health:memory").maybeSingle()]);
  const snap: R | null = data?.value ? JSON.parse(data.value) : null;
  if (!snap) return <><h1>Execution realism</h1><div className="empty">The simulation has not run yet. The worker runs it every 15 minutes.</div></>;
  const o = (k: string) => snap.modes?.[k]?.overall as R | undefined; const dq: R = snap.dataQuality ?? {}; const m = mem?.value ? JSON.parse(mem.value) : null;
  const rows: [string, (r: R) => string][] = [
    ["Signals", (r) => int(r.total)], ["Simulated", (r) => int(r.coverage?.SIMULATED)], ["Pending data (not a result)", (r) => int(r.coverage?.PENDING_DATA)], ["Unavailable data (not a trading failure)", (r) => int(r.coverage?.UNAVAILABLE_DATA)],
    ["Invalid", (r) => int(r.coverage?.INVALID)], ["Unfilled / expired", (r) => int(r.coverage?.UNFILLED)], ["Data coverage", (r) => pc(r.coveragePct)],
    ["Fill rate (of decided)", (r) => pc(r.fillRateOfDecided)], ["Fill rate (of all)", (r) => pc(r.fillRateOfAll)],
    ["Latency observed / estimated", (r) => `${int(r.latency?.observed)} / ${int(r.latency?.estimated)}`], ["Median latency (s)", (r) => n(r.latency?.medianSec, 0)],
    ["Entry slippage avg / median (ticks)", (r) => `${n(r.entrySlipTicks?.avg, 2)} / ${n(r.entrySlipTicks?.median, 2)}`], ["Exit slippage avg / median (ticks)", (r) => `${n(r.exitSlipTicks?.avg, 2)} / ${n(r.exitSlipTicks?.median, 2)}`],
    ["Gross P&L", (r) => $(r.grossPnl)], ["Latency cost", (r) => $(r.latencyCost)], ["Slippage cost", (r) => $(r.slippageCost)], ["Fees", (r) => $(r.fees)], ["Net P&L", (r) => $(r.netPnl)],
    ["Realized / unrealized", (r) => `${$(r.realizedPnl)} / ${$(r.unrealizedPnl)}`], ["Settled trades", (r) => int(r.settled)], ["Win rate (settled)", (r) => pc(r.winRate)],
    ["Avg / median return", (r) => `${pc(r.avgReturn)} / ${pc(r.medianReturn)}`], ["Max drawdown (realised)", (r) => $(r.maxDrawdown)], ["Ending realised equity", (r) => $(r.endingEquity)],
    ["P&L ex best 1 / 3", (r) => `${$(r.robustness?.exBest1)} / ${$(r.robustness?.exBest3)}`], ["P&L ex best 5 / 10", (r) => `${$(r.robustness?.exBest5)} / ${$(r.robustness?.exBest10)}`],
    ["Profit factor", (r) => n(r.robustness?.profitFactor, 2)], ["Expectancy / trade", (r) => $(r.robustness?.expectancy)], ["Largest win / loss", (r) => `${$(r.robustness?.largestWin)} / ${$(r.robustness?.largestLoss)}`],
    ["Fee provenance", (r) => Object.entries(r.feeSources ?? {}).map(([a, b]) => `${a}: ${b}`).join(" · ") || "—"],
  ];
  const kinds = [...new Set(MODE_ORDER.flatMap((k) => Object.keys(snap.modes?.[k]?.byKind ?? {})))].sort();
  const sim = dq.simulation ?? {}; const pos = dq.positions ?? {}; const prices = dq.prices ?? {}; const marks = dq.marks ?? {}; const bots = dq.bots ?? {};
  const dqRows: [string, string][] = [
    ["Signals", int(dq.signals)], ["Signals with observed latency", int(dq.latencyObserved)], ["Signals with estimated latency", int(dq.latencyEstimated)],
    ["Price data complete / pending / processing", `${int(prices.COMPLETE ?? 0)} / ${int(prices.PENDING ?? 0)} / ${int(prices.PROCESSING ?? 0)}`], ["Price data unavailable / failed", `${int(prices.UNAVAILABLE ?? 0)} / ${int(prices.FAILED ?? 0)}`],
    ["Positions marked 1h / 6h / 24h", `${int(marks["1h"] ?? 0)} / ${int(marks["6h"] ?? 0)} / ${int(marks["24h"] ?? 0)}`], ["Positions resolved / exited / still open", `${int(pos.resolved)} / ${int(pos.exited)} / ${int(pos.open)}`],
    ["Open positions checked by the marker", int(pos.checkedByMarker)], ["Markets with fee flag / without", `${int(dq.fees?.marketsWithFlag)} / ${int(dq.fees?.marketsWithoutFlag)}`], ["Signal markets with no metadata yet", int(dq.fees?.signalMarketsWithoutMetadata)],
    ["Tracked wallets by bot class", Object.entries(bots).map(([a, b]) => `${a}: ${b}`).join(" · ") || "—"],
    ...MODE_ORDER.map((k): [string, string] => [`${k} coverage`, Object.entries(sim[k] ?? {}).map(([a, b]) => `${a}: ${b}`).join(" · ") || "—"]),
    ["Worker memory", m ? `rss ${m.rssMb} MB · heap ${m.heapUsedMb}/${m.heapTotalMb} MB (${new Date(m.at).toUTCString().slice(17, 22)} UTC)` : "—"],
  ];
  return (
    <>
      <h1>Execution realism</h1>
      <p className="lede">The same signals under three execution assumptions. IDEAL is the original ledger. REALISTIC and CONSERVATIVE add observed detection latency, the observed market price at the simulated fill time, spread/impact, liquidity caps and fees. Pending and unavailable data are counted, never treated as losses. Built {new Date(snap.builtAt).toUTCString().slice(5, 22)} UTC in {n(snap.durationSec, 0)} s · backlog this run: {int(snap.backlog?.done)} fetched ({int(snap.backlog?.unavailable)} unavailable, {int(snap.backlog?.failed)} failed).</p>
      <div className="wrap"><table><thead><tr><th></th>{MODE_ORDER.map((k) => <th key={k} className="r">{k}<div className="mute" style={{ fontSize: ".75rem" }}>cfg {snap.modes?.[k]?.configHash}</div></th>)}</tr></thead>
        <tbody>{rows.map(([label, f]) => <tr key={label}><td>{label}</td>{MODE_ORDER.map((k) => <td key={k} className="r" style={{ whiteSpace: "normal" }}>{o(k) ? f(o(k)!) : "—"}</td>)}</tr>)}</tbody></table></div>
      <h2>Net P&amp;L by signal type</h2>
      <div className="wrap"><table><thead><tr><th>Type</th>{MODE_ORDER.map((k) => <th key={k} className="r">{k} (simulated · pending · net)</th>)}</tr></thead><tbody>
        {kinds.map((kind) => <tr key={kind}><td>{kind}</td>{MODE_ORDER.map((k) => { const r: R | undefined = snap.modes?.[k]?.byKind?.[kind]; return <td key={k} className="r">{r ? `${int(r.coverage?.SIMULATED)} · ${int(r.coverage?.PENDING_DATA)} · ${$(r.netPnl)}` : "—"}</td>; })}</tr>)}
      </tbody></table></div>
      <h2>Data quality</h2>
      <p className="lede">Not performance: how complete and how measured the underlying data is.</p>
      <div className="wrap"><table><tbody>{dqRows.map(([a, b]) => <tr key={a}><td>{a}</td><td style={{ whiteSpace: "normal" }}>{b}</td></tr>)}</tbody></table></div>
      <h2>Portfolio (finite capital)</h2>
      <div className="empty">Deferred to Phase 3. The simulator exists and is tested; it will run once limits are chosen.</div>
      <h2>Assumptions</h2>
      <div className="wrap"><table><thead><tr><th>Assumption</th><th>Provenance</th><th>Detail</th></tr></thead><tbody>{ASSUMPTIONS.map((a) => <tr key={a.key}><td>{a.key}</td><td>{a.provenance}</td><td style={{ whiteSpace: "normal" }}>{a.note}</td></tr>)}</tbody></table></div>
      <h2>Mode parameters</h2>
      <div className="wrap"><table><thead><tr><th>Parameter</th>{MODE_ORDER.map((k) => <th key={k} className="r">{k}</th>)}</tr></thead><tbody>
        {(["assumedDetectionLatencySec", "decisionLatencySec", "executionLatencySec", "maxQuoteAgeSec", "maxSignalAgeSec", "spreadTicks", "impactTicksAtFullParticipation", "participation", "feeModel", "fallbackFeeRate", "defaultTickSize", "defaultMinOrderShares"] as const).map((p) => <tr key={p}><td>{p}</td>{MODE_ORDER.map((k) => <td key={k} className="r">{String((MODES as any)[k][p])}</td>)}</tr>)}
      </tbody></table></div>
    </>
  );
}
