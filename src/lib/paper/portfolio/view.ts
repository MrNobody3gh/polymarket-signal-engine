/**
 * The /execution portfolio section as data: `portfolioView(snapshot)` turns the `cursors['paper:portfolio']` snapshot
 * (savePortfolioSnapshot) into labelled rows with one text cell per mode, so the page only renders and the wording is
 * testable without React. Measured results only: no ranking of modes or signal kinds, no verdict wording, no colours.
 */
import { PORTFOLIO_MODES } from "./config";
import type { PortfolioReport } from "./report";

export interface ViewRow { label: string; values: string[] }
export interface ViewSection { title: string; note?: string; rows: ViewRow[] }
export interface PortfolioView {
  state: "off" | "no-run" | "ready";
  message: string | null;
  generatedAt: string | null;
  staleNote: string | null;
  modes: string[];
  /** Per column: the IDEAL non-causal label, else null. */
  columnNotes: (string | null)[];
  sections: ViewSection[];
}

export const OFF_MESSAGE = "Portfolio simulation is off: PAPER_PORTFOLIO_CONFIG is not set on the worker.";
export const NO_RUN_MESSAGE = "Portfolio simulation is configured; no run has finished yet.";
export const IDEAL_COLUMN_NOTE = "non-causal baseline — not a strategy that could have been run";
export const INSUFFICIENT = "insufficient data";
const STALE_AFTER_SEC = 45 * 60;

type Snap = { generatedAt?: string; portfolios?: { portfolioId: string; mode: string; report: PortfolioReport | null }[];
  lastJob?: { at: string; modes: { mode: string; failed: string | null; skipped: string | null }[] } | null };
export const MODE_FAILED = "FAILED this cycle";
export const RUN_UNFINISHED = "the last run for this mode did not finish";
/** This cycle's outcome for one mode, independent of whether the mode has ever finished a run. */
const jobCell = (snap: Snap, mode: string) => {
  const j = snap.lastJob?.modes?.find((m) => m.mode === mode);
  if (!j) return "—";
  if (j.failed) return `${MODE_FAILED} — ${j.failed} (figures shown are from the last completed run)`;
  if (j.skipped) return "skipped this cycle — another runner holds the lease";
  return "completed";
};
const utc = (t: number | null | undefined) => (t == null ? "—" : `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
const money = (v: number | null | undefined) => (v == null || !Number.isFinite(Number(v)) ? "—" : `${Number(v) < 0 ? "−" : ""}$${Math.abs(Number(v)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(Number(v)) ? "—" : `${(Number(v) * 100).toFixed(d)}%`);
const int = (v: number | null | undefined) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
const num = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(d));
const dur = (s: number | null | undefined) => (s == null ? "—" : s >= 86_400 ? `${(s / 86_400).toFixed(1)} d` : s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);

/** Pure. `snapshot` is the parsed cursor value (or null when the row does not exist); `now` in epoch seconds. */
export function portfolioView(snapshot: unknown, now: number): PortfolioView {
  const empty = (state: PortfolioView["state"], message: string, generatedAt: string | null = null): PortfolioView => ({ state, message, generatedAt, staleNote: null, modes: [...PORTFOLIO_MODES], columnNotes: PORTFOLIO_MODES.map((m) => (m === "IDEAL" ? IDEAL_COLUMN_NOTE : null)), sections: [] });
  const snap = snapshot as Snap | null;
  if (!snap || !Array.isArray(snap.portfolios)) return empty("off", OFF_MESSAGE);
  const gen = snap.generatedAt ?? null; const genTs = gen ? Date.parse(gen) / 1000 : null;
  const reports = PORTFOLIO_MODES.map((m) => snap.portfolios!.find((p) => p.mode === m)?.report ?? null);
  const decided = reports.map((r) => (r && r.asOf?.ts != null ? r : null));
  if (!decided.some(Boolean)) {
    const failed = (snap.lastJob?.modes ?? []).filter((m) => m.failed);
    return empty("no-run", failed.length ? `${NO_RUN_MESSAGE} The last job failed: ${failed.map((m) => `${m.mode} — ${m.failed}`).join("; ")}.` : NO_RUN_MESSAGE, gen);
  }

  const cell = (f: (r: PortfolioReport) => string, none = "—") => decided.map((r) => (r ? f(r) : none));
  const row = (label: string, f: (r: PortfolioReport) => string, none = "—"): ViewRow => ({ label, values: cell(f, none) });
  const union = (pick: (r: PortfolioReport) => Record<string, number> | undefined) => [...new Set(decided.flatMap((r) => (r ? Object.keys(pick(r) ?? {}) : [])))].sort();
  const kinds = ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"] as const;
  const kindOf = (r: PortfolioReport, k: string) => (r.byKind as Record<string, any>)[k] ?? {};
  const topRows = (key: "topMarkets" | "topWallets", id: "conditionId" | "wallet"): ViewRow[] => Array.from({ length: 10 }, (_, i) => ({ label: `#${i + 1} (by cost at risk)`,
    values: cell((r) => { const x = (r.exposure[key] as Record<string, any>[])[i]; return x ? `${String(x[id]).slice(0, 14)}${String(x[id]).length > 14 ? "…" : ""} · ${money(x.cost)} · ${pct(x.share)} · ${int(x.lots)} lot(s)` : "—"; }) }));

  const sections: ViewSection[] = [
    { title: "Portfolio", rows: [
      row("As of", (r) => `as of ${utc(r.asOf.ts)}`, "no run has finished yet"),
      row("Start", (r) => utc(r.portfolio.startTs)), row("Last run finished", (r) => utc(r.asOf.lastRunFinishedAt)),
      row("Frontier (first event still waiting for data)", (r) => (r.asOf.frontier ? utc((r.asOf.frontier as { ts: number }).ts) : "none")),
      row("Baseline note", (r) => (r.portfolio.nonCausalBaseline ? r.portfolio.label ?? IDEAL_COLUMN_NOTE : "—")),
    ] },
    { title: "Capital (cost basis)", rows: [
      row("Starting capital", (r) => money(r.capital.startingCapital)), row("Cash", (r) => money(r.capital.cash)), row("Invested at cost", (r) => money(r.capital.investedAtCost)),
      row("Equity at cost", (r) => money(r.capital.equityAtCost)), row("Utilisation", (r) => pct(r.capital.utilisation)), row("Cash above the reserve", (r) => money(r.capital.availableCash)),
    ] },
    { title: "P&L (cost basis)", rows: [
      row("Realised P&L (net of fees)", (r) => money(r.pnl.realized)), row("Entry / exit fees", (r) => `${money(r.pnl.entryFees)} / ${money(r.pnl.exitFees)}`),
      row("Realised before fees", (r) => money(r.pnl.gross)), row("Realised return on starting capital", (r) => pct(r.pnl.returnPct, 2)),
    ] },
    { title: "Market value (separate basis)", note: "Open lots at their latest 1h/6h/24h mark up to the as-of time. Lots without a mark are valued at cost and counted below.", rows: [
      row("Unrealised at marks", (r) => money(r.pnl.marketValue.unrealisedAtMarks)), row("Equity at marks", (r) => money(r.pnl.marketValue.equityAtMarks)),
      row("Open lots without a mark (at cost)", (r) => `${int(r.pnl.marketValue.lotsWithoutMark.count)} · ${money(r.pnl.marketValue.lotsWithoutMark.cost)}`),
    ] },
    { title: "Risk (cost basis, equity curve)", note: decided.find(Boolean)!.risk.note, rows: [
      row("Equity points", (r) => int(r.risk.points)), row("Peak equity", (r) => money(r.risk.peakEquity)),
      row("Max drawdown ($ / % of running peak)", (r) => `${money(r.risk.maxDrawdown)} / ${pct(r.risk.maxDrawdownPct, 2)}`), row("Ending equity", (r) => money(r.risk.endingEquity)),
      row("Hourly points before", (r) => (r.risk.thinnedBefore == null ? "none thinned yet" : utc(r.risk.thinnedBefore))),
    ] },
    { title: "Decisions", note: `Fill rate: ${decided.find(Boolean)!.decisions.fillRateBasis}.`, rows: [
      row("Decisions", (r) => int(r.decisions.total)),
      ...(["FILLED", "PARTIALLY_FILLED", "UNFILLED", "EXPIRED", "INVALID", "UNKNOWN", "REJECTED"] as const).map((o) => row(`  ${o}`, (r) => int((r.decisions.byOutcome as Record<string, number>)[o]))),
      row("Fill rate", (r) => pct(r.decisions.fillRate)), row("Requested / filled", (r) => `${money(r.decisions.requestedUsd)} / ${money(r.decisions.filledUsd)}`),
      row("Resized to fit a limit", (r) => int(r.decisions.resized)),
    ] },
    { title: "Rejections by reason", note: decided.find(Boolean)!.decisions.duplicatesNote, rows: [
      ...union((r) => r.decisions.rejectionsByReason as Record<string, number>).map((k) => row(k, (r) => int((r.decisions.rejectionsByReason as Record<string, number>)[k] ?? 0))),
      row("REJECTED_DUPLICATE_POSITION (same source fill, shown separately)", (r) => int(r.decisions.duplicates)),
    ] },
    { title: "By signal kind", note: decided.find(Boolean)!.byKindNote, rows: kinds.flatMap((k) => [
      row(`${k}: requests / fills / lots opened`, (r) => `${int(kindOf(r, k).requests)} / ${int(kindOf(r, k).fills)} / ${int(kindOf(r, k).lotsOpened)}`),
      row(`${k}: open / settled lots`, (r) => `${int(kindOf(r, k).openLots)} / ${int(kindOf(r, k).settledLots)}`),
      row(`${k}: realised P&L · fees`, (r) => `${money(kindOf(r, k).realizedPnl)} · ${money(kindOf(r, k).fees)}`),
      row(`${k}: win rate (settled lots)`, (r) => (kindOf(r, k).insufficient ? `${INSUFFICIENT} (${int(kindOf(r, k).settledLots)} settled)` : pct(kindOf(r, k).winRate))),
      row(`${k}: rejections`, (r) => Object.entries(kindOf(r, k).rejections ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([a, b]) => `${a}: ${b}`).join(" · ") || "none"),
    ]) },
    { title: "Exposure", rows: [row("Open lots", (r) => int(r.exposure.openLots)), row("Invested at cost", (r) => money(r.exposure.investedAtCost))] },
    { title: "Top markets by cost at risk (market · cost · share of invested · lots)", rows: topRows("topMarkets", "conditionId") },
    { title: "Top wallets by cost at risk (wallet · cost · share of invested · lots)", rows: topRows("topWallets", "wallet") },
    { title: "Lots", note: decided.find(Boolean)!.lots.lockedUnresolved.rule, rows: [
      ...(["OPEN", "PARTIALLY_EXITED", "EXITED", "RESOLVED"] as const).map((s) => row(s, (r) => int((r.lots.byState as Record<string, number>)[s]))),
      row("Closed by exit / by resolution", (r) => `${int(r.lots.closedByExit)} / ${int(r.lots.closedByResolution)}`), row("Median holding time (settled)", (r) => dur(r.lots.medianHoldingSec)),
      row("Locked unresolved (open 30+ days, no resolution)", (r) => `${int(r.lots.lockedUnresolved.count)} · ${money(r.lots.lockedUnresolved.cost)}${r.lots.lockedUnresolved.oldestOpenedTs == null ? "" : ` · oldest ${utc(r.lots.lockedUnresolved.oldestOpenedTs)}`}`),
    ] },
    { title: "Robustness (settled lots, net of fees)", rows: [
      row("Sample", (r) => (r.robustness.insufficient ? `${INSUFFICIENT} (${int(r.robustness.settled)} settled lots, fewer than 10)` : `${int(r.robustness.settled)} settled lots`)),
      row("Total", (r) => money(r.robustness.total)),
      row("Total excluding the top 1 / 3 lots by P&L", (r) => `${money(r.robustness.exBest1)} / ${money(r.robustness.exBest3)}`),
      row("Total excluding the top 5 / 10 lots by P&L", (r) => `${money(r.robustness.exBest5)} / ${money(r.robustness.exBest10)}`),
      row("Profit factor (gains ÷ losses)", (r) => num(r.robustness.profitFactor)), row("Average per lot", (r) => money(r.robustness.expectancy)),
      row("Largest gain / loss", (r) => `${money(r.robustness.largestWin)} / ${money(r.robustness.largestLoss)}`), row("Median lot return", (r) => pct(r.robustness.medianReturn, 2)),
    ] },
    { title: "Health", rows: [
      { label: "This cycle", values: PORTFOLIO_MODES.map((m) => jobCell(snap, m)) },
      row("Warnings", (r) => { const w = [...r.health.warnings];
        const st = r.health.lastRunStartedAt, fin = r.asOf.lastRunFinishedAt; if (st != null && (fin == null || st > fin)) w.push(RUN_UNFINISHED);
        return w.length ? w.join(" · ") : "none"; }),
      row("Execution rows after the as-of time (waiting)", (r) => int(r.health.pendingAhead)), row("Rows skipped as stale in the last run", (r) => int(r.health.staleRows)),
      row("Lease", (r) => (r.health.lease.held ? `held by ${r.health.lease.owner ?? "?"} until ${utc(r.health.lease.until)}` : "free")),
      row("Last rewind", (r) => { const w = r.health.lastRewind as { to: number | null; reasons?: string[] } | null; return w && w.to != null ? `to ${utc(w.to)}${w.reasons?.[0] ? ` — ${w.reasons[0]}` : ""}` : "none in the last run"; }),
      row("Rows read in the last run", (r) => int(r.health.rowsRead)), row("Last run started", (r) => utc(r.health.lastRunStartedAt)),
    ] },
  ];
  const staleNote = genTs != null && now - genTs > STALE_AFTER_SEC ? `The snapshot was generated ${utc(genTs)} and has not been refreshed for ${dur(now - genTs)} (the worker refreshes it every 15 minutes when the feature is on).` : null;
  return { state: "ready", message: null, generatedAt: gen, staleNote, modes: [...PORTFOLIO_MODES], columnNotes: PORTFOLIO_MODES.map((m) => (m === "IDEAL" ? IDEAL_COLUMN_NOTE : null)), sections };
}
