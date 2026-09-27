/**
 * /execution renders the portfolio section from the snapshot alone: one cursor read for the page, the report function
 * is never called. Rendered to HTML with the database mocked (the page is a server component).
 */
import { it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { stressDb } from "./helpers/stressDb";
import { runPortfolios } from "@/lib/paper/portfolio/run";
import { buildPortfolioReport, savePortfolioSnapshot } from "@/lib/paper/portfolio/report";
import { validatePortfolioConfig, IDEAL_LABEL } from "@/lib/paper/portfolio/config";
(globalThis as any).React = React; // the page is compiled with the classic JSX runtime here

const cursors: Record<string, string> = {}; const calls: string[] = [];
vi.mock("@/lib/db", () => ({ db: () => ({
  from: (t: string) => ({ select: (c: string) => ({ in: (k: string, v: string[]) => { calls.push(`${t}(${c}) ${k} in ${v.join(",")}`); return Promise.resolve({ data: v.filter((x) => x in cursors).map((key) => ({ key, value: cursors[key] })), error: null }); } }) }),
  rpc: (f: string) => { calls.push(`rpc ${f}`); return Promise.resolve({ data: null, error: null }); },
}) }));
beforeEach(() => { for (const k of Object.keys(cursors)) delete cursors[k]; calls.length = 0; });
const render = async () => { const mod = await import("@/app/execution/page"); return renderToStaticMarkup(await mod.default()); };

it("feature off: one sentence, and a single cursor read for the whole page", async () => {
  const html = await render();
  expect(html).toContain("Portfolio (finite capital)"); expect(html).toContain("Portfolio simulation is off: PAPER_PORTFOLIO_CONFIG is not set on the worker.");
  expect(html).not.toContain("Deferred to Phase 3");
  expect(calls).toEqual(["cursors(key,value) key in paper:execution,health:memory,paper:portfolio"]);
});

it("a real snapshot: three columns, the IDEAL label, 'as of', both bases — and never the report function", async () => {
  const START = 1_790_000_000; const iso = (s: number) => new Date(s * 1000).toISOString();
  const rpc: Record<string, (a: any) => any> = {}; const db = stressDb({ rpc }); rpc.release_portfolio_lease = () => true;
  rpc.claim_portfolio_lease = ({ p_portfolio_id: id }: any) => { if (!db.T("portfolio_runs").some((r) => r.portfolio_id === id)) db.insertRow("portfolio_runs", { portfolio_id: id, stats: {} }); return true; }; // as the SQL function does
  rpc.portfolio_report = ({ p_portfolio_id: id }: any) => { const p = db.T("portfolios").find((x) => x.id === id) ?? null; const m = (t: string) => db.T(t).filter((x) => x.portfolio_id === id);
    return buildPortfolioReport({ portfolio: p, run: m("portfolio_runs")[0] ?? null, decisions: m("portfolio_decisions"), lots: m("portfolio_lots"), equity: m("portfolio_equity"), marks: [], executionFillTs: [], now: START + 86_400 }); };
  let t = START;
  for (let i = 0; i < 300; i++) { t += 60; const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    db.insertRow("signals", { id, kind: ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY"][i % 4], wallet: `w${i % 9}`, condition_id: `c${i % 20}`, token_id: `t${i}`, price: 0.3 + (i % 5) / 10, usd: 1000, created_at: iso(t), evaluated_at: iso(t + 5), source_fill_id: `f${i}` });
    db.insertRow("paper_ledger", { signal_id: id, created_at: iso(t + 5), sim_terminal: true, side: "LONG" });
    db.insertRow("paper_executions", { signal_id: id, mode: "IDEAL", fill_ts: iso(t), computed_at: iso(START), state: "OPEN", coverage_state: "SIMULATED", record_hash: "x" });
    if (i % 2) db.insertRow("token_resolutions", { token_id: `t${i}`, value: i % 4 === 1 ? 1 : 0, resolved_ts: iso(t + 1800) }); }
  const cfg = validatePortfolioConfig({ startingCapitalUsd: 5000, positionUsd: 100, maxMarketExposureUsd: 600, maxTotalExposurePct: 90, maxOpenPositions: 30, maxWalletAllocationUsd: 800, minCashReserveUsd: 100, allowResize: true, startTs: iso(START) }, t + 86_400);
  await runPortfolios(db as never, { config: cfg, modes: ["IDEAL"], owner: "t", now: () => t + 60 });
  const snap = await savePortfolioSnapshot(db as never, { config: cfg, now: () => t + 120 });
  cursors["paper:portfolio"] = JSON.stringify(snap); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime((t + 300) * 1000);
  const html = await render(); vi.useRealTimers();
  for (const s of ["IDEAL", "REALISTIC", "CONSERVATIVE", "non-causal baseline — not a strategy that could have been run", IDEAL_LABEL, "as of ", "Capital (cost basis)", "Market value (separate basis)",
    "Open lots without a mark (at cost)", "Rejections by reason", "CONSENSUS is under-attributed", "Locked unresolved", "Robustness (settled lots, net of fees)", "Health", "no run has finished yet"]) expect(html, s).toContain(s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;"));
  expect(html).not.toMatch(/\b(best|worst|winner)\b/i);
  expect(calls).toEqual(["cursors(key,value) key in paper:execution,health:memory,paper:portfolio"]); // no report RPC from the page
});
