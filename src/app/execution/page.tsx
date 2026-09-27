import { db } from "@/lib/db";
import { ASSUMPTIONS, MODES } from "@/lib/paper/sim/config";
import { portfolioView, type PortfolioView } from "@/lib/paper/portfolio/view";
export const dynamic = "force-dynamic";
type R = Record<string, any>;
const $ = (v: any) => (v == null ? "—" : `${Number(v) < 0 ? "−" : ""}$${Math.abs(Number(v)).toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
const pc = (v: any, d = 1) => (v == null ? "—" : `${(Number(v) * 100).toFixed(d)}%`);
const n = (v: any, d = 1) => (v == null ? "—" : Number(v).toFixed(d));
const int = (v: any) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
const MODE_ORDER = ["IDEAL", "REALISTIC", "CONSERVATIVE"];

export default async function Execution() {
  // One read for the three precomputed rows (the portfolio section reads only its snapshot, never the report function).
  const { data: cur } = await db().from("cursors").select("key,value").in("key", ["paper:execution", "health:memory", "paper:portfolio"]);
  const val = (k: string) => (cur ?? []).find((r) => r.key === k)?.value as string | undefined;
  const data = { value: val("paper:execution") }; const mem = { value: val("health:memory") };
  const snap: R | null = data?.value ? JSON.parse(data.value) : null;
  const pview = portfolioView(parseOrNull(val("paper:portfolio")), Math.floor(Date.now() / 1000));
  if (!snap) return <><h1>Execution realism</h1><div className="empty">The simulation has not run yet. The worker runs it every 15 minutes.</div><PortfolioSection v={pview} /></>;
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
      <PortfolioSection v={pview} />
      <h2>Assumptions</h2>
      <div className="wrap"><table><thead><tr><th>Assumption</th><th>Provenance</th><th>Detail</th></tr></thead><tbody>{ASSUMPTIONS.map((a) => <tr key={a.key}><td>{a.key}</td><td>{a.provenance}</td><td style={{ whiteSpace: "normal" }}>{a.note}</td></tr>)}</tbody></table></div>
      <h2>Mode parameters</h2>
      <div className="wrap"><table><thead><tr><th>Parameter</th>{MODE_ORDER.map((k) => <th key={k} className="r">{k}</th>)}</tr></thead><tbody>
        {(["assumedDetectionLatencySec", "decisionLatencySec", "executionLatencySec", "maxQuoteAgeSec", "maxSignalAgeSec", "spreadTicks", "impactTicksAtFullParticipation", "participation", "feeModel", "fallbackFeeRate", "defaultTickSize", "defaultMinOrderShares"] as const).map((p) => <tr key={p}><td>{p}</td>{MODE_ORDER.map((k) => <td key={k} className="r">{String((MODES as any)[k][p])}</td>)}</tr>)}
      </tbody></table></div>
    </>
  );
}

function parseOrNull(v: string | undefined): unknown { if (!v) return null; try { return JSON.parse(v); } catch { return null; } }

/** Phase 3 portfolio: finite capital, one portfolio per execution mode. Rendered from portfolioView (measured results only). */
function PortfolioSection({ v }: { v: PortfolioView }) {
  return (
    <>
      <h2>Portfolio (finite capital)</h2>
      {v.message ? <div className="empty">{v.message}</div> : <>
        <p className="lede">One portfolio per execution mode, replayed signal by signal with finite capital and the configured limits. Every figure is as of the last second the runner fully decided (the watermark), not now. Snapshot generated {v.generatedAt ? `${new Date(v.generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "—"}.</p>
        {v.staleNote && <div className="empty">{v.staleNote}</div>}
        {v.sections.map((s) => (
          <div key={s.title}>
            <h3>{s.title}</h3>
            {s.note && <p className="lede">{s.note}</p>}
            <div className="wrap"><table><thead><tr><th></th>{v.modes.map((m, i) => <th key={m} className="r">{m}{v.columnNotes[i] && <div className="mute" style={{ fontSize: ".75rem", whiteSpace: "normal" }}>{v.columnNotes[i]}</div>}</th>)}</tr></thead>
              <tbody>{s.rows.map((r) => <tr key={r.label}><td style={{ whiteSpace: "pre" }}>{r.label}</td>{r.values.map((x, i) => <td key={i} className="r" style={{ whiteSpace: "normal" }}>{x}</td>)}</tr>)}</tbody></table></div>
          </div>
        ))}
      </>}
    </>
  );
}
