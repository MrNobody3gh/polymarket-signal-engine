import { db } from "@/lib/db";
import { ASSUMPTIONS, MODES } from "@/lib/paper/sim/config";
import type { ExecReport } from "@/lib/paper/sim/report";
export const dynamic = "force-dynamic";
type Snap = { builtAt: string; observationsPending: number; portfolioConfigured: boolean; portfolio: Record<string, any> | null; modes: Record<string, { pending: number; configHash: string; overall: ExecReport; byKind: Record<string, ExecReport> }> };
const $ = (v: number | null | undefined) => (v == null ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
const pc = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
const n = (v: number | null | undefined, d = 1) => (v == null ? "—" : v.toFixed(d));
const MODE_ORDER = ["IDEAL", "REALISTIC", "CONSERVATIVE"];

export default async function Execution() {
  const { data } = await db().from("cursors").select("value").eq("key", "paper:execution").maybeSingle();
  const snap: Snap | null = data?.value ? JSON.parse(data.value) : null;
  if (!snap) return <><h1>Execution realism</h1><div className="empty">The simulation has not run yet. The worker runs it every 15 minutes.</div></>;
  const m = (k: string) => snap.modes[k]?.overall;
  const rows: [string, (r: ExecReport) => string][] = [
    ["Signals simulated", (r) => String(r.signals)], ["Filled", (r) => String(r.filled)], ["Partially filled", (r) => String(r.partial)], ["Unfilled", (r) => String(r.unfilled)],
    ["Expired", (r) => String(r.expired)], ["Invalid", (r) => String(r.invalid)], ["Unknown (no usable price)", (r) => String(r.unknown)], ["Fill rate", (r) => pc(r.fillRate)],
    ["Median latency (s)", (r) => n(r.medLatencySec, 0)], ["Latency observed (not assumed)", (r) => pc(r.latencyObservedShare, 0)],
    ["Avg / median entry slippage (ticks)", (r) => `${n(r.avgEntrySlipTicks, 2)} / ${n(r.medEntrySlipTicks, 2)}`], ["Avg / median exit slippage (ticks)", (r) => `${n(r.avgExitSlipTicks, 2)} / ${n(r.medExitSlipTicks, 2)}`],
    ["Gross P&L", (r) => $(r.grossPnl)], ["Latency cost", (r) => $(r.latencyCost)], ["Slippage cost", (r) => $(r.slippageCost)], ["Fees", (r) => $(r.fees)], ["Net P&L", (r) => $(r.netPnl)],
    ["Realized / unrealized", (r) => `${$(r.realizedPnl)} / ${$(r.unrealizedPnl)}`], ["Settled trades", (r) => String(r.settled)], ["Win rate (settled)", (r) => pc(r.winRate)],
    ["Avg / median return", (r) => `${pc(r.avgReturn)} / ${pc(r.medReturn)}`], ["Max drawdown (realised)", (r) => $(r.maxDrawdown)], ["Ending realised equity", (r) => $(r.endingEquity)],
    ["P&L ex best 1 / 3", (r) => `${$(r.robustness.exBest1)} / ${$(r.robustness.exBest3)}`], ["P&L ex best 5 / 10", (r) => `${$(r.robustness.exBest5)} / ${$(r.robustness.exBest10)}`],
    ["Profit factor", (r) => n(r.robustness.profitFactor, 2)], ["Expectancy / trade", (r) => $(r.robustness.expectancy)], ["Largest win / loss", (r) => `${$(r.robustness.largestWin)} / ${$(r.robustness.largestLoss)}`],
  ];
  const kinds = [...new Set(MODE_ORDER.flatMap((k) => Object.keys(snap.modes[k]?.byKind ?? {})))].sort();
  return (
    <>
      <h1>Execution realism</h1>
      <p className="lede">The same signals under three execution assumptions. IDEAL is the original ledger (entry at the source wallet&apos;s price, no costs). REALISTIC and CONSERVATIVE add observed detection latency, the observed market price at the simulated fill time, spread/impact, liquidity caps and fees. Built {new Date(snap.builtAt).toUTCString().slice(5, 22)} UTC · {snap.observationsPending.toLocaleString()} price observations still to fetch (those signals are pending, not guessed).</p>
      <div className="wrap"><table><thead><tr><th></th>{MODE_ORDER.map((k) => <th key={k} className="r">{k}<div className="mute" style={{ fontSize: ".75rem" }}>pending {snap.modes[k]?.pending ?? 0} · cfg {snap.modes[k]?.configHash}</div></th>)}</tr></thead>
        <tbody>{rows.map(([label, f]) => <tr key={label}><td>{label}</td>{MODE_ORDER.map((k) => <td key={k} className="r">{m(k) ? f(m(k)!) : "—"}</td>)}</tr>)}</tbody></table></div>
      <h2>Net P&amp;L by signal type</h2>
      <div className="wrap"><table><thead><tr><th>Type</th>{MODE_ORDER.map((k) => <th key={k} className="r">{k} (n · fill rate · net)</th>)}</tr></thead><tbody>
        {kinds.map((kind) => <tr key={kind}><td>{kind}</td>{MODE_ORDER.map((k) => { const r = snap.modes[k]?.byKind[kind]; return <td key={k} className="r">{r ? `${r.signals} · ${pc(r.fillRate, 0)} · ${$(r.netPnl)}` : "—"}</td>; })}</tr>)}
      </tbody></table></div>
      <h2>Portfolio (finite capital)</h2>
      {!snap.portfolioConfigured ? <div className="empty">Not configured. Portfolio limits have no defaults — set <code>PAPER_PORTFOLIO_CONFIG</code> on the worker (starting capital, position size, max market / total exposure, max open positions, max per wallet, cash reserve, resize on/off).</div> : (
        <div className="wrap"><table><thead><tr><th></th>{MODE_ORDER.map((k) => <th key={k} className="r">{k}</th>)}</tr></thead><tbody>
          {["endingEquity", "peakEquity", "maxDrawdown", "realizedPnl", "unrealizedPnl", "fees", "slippageCost", "endingCash", "invested"].map((f) => <tr key={f}><td>{f}</td>{MODE_ORDER.map((k) => <td key={k} className="r">{$(snap.portfolio?.[k]?.[f])}</td>)}</tr>)}
          <tr><td>Decisions</td>{MODE_ORDER.map((k) => <td key={k} className="r" style={{ whiteSpace: "normal" }}>{Object.entries(snap.portfolio?.[k]?.decisions ?? {}).map(([a, b]) => `${a}: ${b}`).join(" · ")}</td>)}</tr>
        </tbody></table></div>)}
      <h2>Assumptions</h2>
      <div className="wrap"><table><thead><tr><th>Assumption</th><th>Provenance</th><th>Detail</th></tr></thead><tbody>{ASSUMPTIONS.map((a) => <tr key={a.key}><td>{a.key}</td><td>{a.provenance}</td><td style={{ whiteSpace: "normal" }}>{a.note}</td></tr>)}</tbody></table></div>
      <h2>Mode parameters</h2>
      <div className="wrap"><table><thead><tr><th>Parameter</th>{MODE_ORDER.map((k) => <th key={k} className="r">{k}</th>)}</tr></thead><tbody>
        {(["assumedDetectionLatencySec", "decisionLatencySec", "executionLatencySec", "maxQuoteAgeSec", "maxSignalAgeSec", "spreadTicks", "impactTicksAtFullParticipation", "participation", "feeModel", "fallbackFeeRate", "defaultTickSize", "defaultMinOrderShares"] as const).map((p) => <tr key={p}><td>{p}</td>{MODE_ORDER.map((k) => <td key={k} className="r">{String((MODES as any)[k][p])}</td>)}</tr>)}
      </tbody></table></div>
    </>
  );
}
