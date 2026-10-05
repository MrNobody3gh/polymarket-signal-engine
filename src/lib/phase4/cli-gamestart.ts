/**
 * `npm run phase4:gamestart-check -- --venue polymarket_us` (Phase 4.0e): its own process; streams the open and resolved listings and the sports-API schedule into a bounded collector,
 * writes `v_polymarket_us_gamestart.json` and `S1e_GAMESTART.md` (≤ 80 lines). No database. Exit: 0 finished (possibly partial), 1 failed, 2 configuration, 3 stopped by the heap budget.
 */
import { EXIT, parseArgs, num, printFiles, type CliDeps } from "./cli";
import { PoliteHttp } from "./http";
import { US_DEFAULTS, US_MIN_INTERVAL_MS, US_EXCHANGE, type UsConfig } from "./venues";
import { GS_DEFAULTS, gamestartLines, renderGamestartMd, runGamestart } from "./gamestart-run";
import { DEFAULT_HEAP_BUDGET_MB, EVIDENCE_SCHEMA, HeapBudgetExceeded, MemoryGuard, heapInfo, parseVenueId } from "./venue-run";

export const GAMESTART_USAGE = "usage: npm run phase4:gamestart-check -- --venue polymarket_us [--out-dir docs/phase4/data] [--max-markets 40000] [--max-events 12000] [--max-requests 700] [--pages-per-source 8] [--listing-pages 120] [--heap-budget-mb 350] [--us-base URL] [--print-files a,b]";
export async function runGamestartCli(argv: string[], _env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const log = d.log ?? ((l: string) => console.log(l)); const { flags, opts } = parseArgs(argv); if (flags.has("help")) { log(GAMESTART_USAGE); return EXIT.OK; }
  const venue = parseVenueId(opts.venue); if (venue !== US_EXCHANGE) { log("--venue polymarket_us is required (this check is about the US exchange's gameStartTime); nothing was fetched."); return EXIT.CONFIG; }
  const outDir = opts["out-dir"] ?? "docs/phase4/data"; const write = d.writeFile ?? (() => { throw new Error("no writer"); }); const cfg: UsConfig = { ...US_DEFAULTS, base: opts["us-base"] ?? US_DEFAULTS.base };
  const guard = new MemoryGuard({ venue, budgetMb: opts["heap-budget-mb"] !== undefined ? num(opts["heap-budget-mb"], DEFAULT_HEAP_BUDGET_MB) : undefined, heapUsed: d.heapUsed });
  let origin = cfg.base; try { origin = new URL(cfg.base).origin; } catch { /* keep */ } const http = new PoliteHttp({ fetch: d.fetch, sleep: d.sleep, now: d.now, guard, originGapMs: { [origin]: US_MIN_INTERVAL_MS } });
  try {
    d.mkdir?.(outDir); const { result } = await runGamestart(http, cfg, { maxMarkets: num(opts["max-markets"], GS_DEFAULTS.maxMarkets), maxEvents: num(opts["max-events"], GS_DEFAULTS.maxEvents), maxRequests: num(opts["max-requests"], GS_DEFAULTS.maxRequests), pagesPerSource: num(opts["pages-per-source"], GS_DEFAULTS.pagesPerSource), listingPages: num(opts["listing-pages"], GS_DEFAULTS.listingPages), now: d.now, guard, heap: () => heapInfo(guard), log: () => {} });
    write(`${outDir}/v_polymarket_us_gamestart.json`, JSON.stringify(result)); write(`${outDir}/S1e_GAMESTART.md`, renderGamestartMd(result)); for (const l of gamestartLines(result, outDir)) log(l);
    const list = (opts["print-files"] ?? "").split(",").map((x) => x.trim()).filter(Boolean); await printFiles(list, { outDir, readFile: d.readFile, log, sleep: d.sleep }); return EXIT.OK;
  } catch (e) {
    if (e instanceof HeapBudgetExceeded) { log(e.message); const now = new Date((d.now ?? Date.now)()).toISOString(); try { d.mkdir?.(outDir); write(`${outDir}/v_polymarket_us_gamestart.json`, JSON.stringify({ schema: EVIDENCE_SCHEMA, kind: "gamestart", venue, startedAt: now, finishedAt: now, heap: heapInfo(guard), stopped: { reason: "heap_budget", stage: e.stage, message: e.message } })); } catch { /* the message is the record */ } return EXIT.BUDGET; }
    log(`gamestart check failed: ${(e as Error).message}`); return EXIT.FAILED;
  }
}
