/**
 * The whole Phase 4.0d pipeline over synthetic worlds, through the real command-line entry points and an in-memory file system:
 * per-venue audits, coverage and title searches, the review sheet, the owner's answers, the ingest, and the merge. SYNTHETIC: not evidence about any venue.
 */
import { readFileSync } from "node:fs";
import { runCoverageCli, runTimestampAuditCli, runTitleSearchCli, type CliDeps } from "../../src/lib/phase4/cli";
import { runMergeCli, runReviewIngestCli, runReviewSheetCli, runWalletShareCli } from "../../src/lib/phase4/cli-review";
import { readOnly } from "../../src/lib/phase4/readonly-db";
import { fakeFetch, json, memDb, virtualClock } from "./phase4Db";
import { buildWorld } from "./phase4World";
import { funnelEvents, kalshiServer, nbaEvents } from "./phase4Kalshi";

export const OUT = "docs/phase4/data"; export const RULE = "docs/phase4/stop_rule.json";
export const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-never-logged" };
export const NOW = Date.parse("2026-10-03T00:00:00Z"); const z = (s: string) => new Date(Date.parse(s)).toISOString();
// the UNAPPROVED variant of the committed rule (the committed file itself is approved since 4 Oct 2026): the pipeline tests that need an unapproved rule must not depend on that state
export const SHIPPED_RULE = JSON.stringify({ ...JSON.parse(readFileSync(RULE, "utf8")), approved: false, approvedBy: null, approvedOn: null }, null, 2);
export const APPROVED_RULE = JSON.stringify({ ...JSON.parse(SHIPPED_RULE), approved: true, approvedBy: "owner", approvedOn: "2026-10-05" }, null, 2);

const world = buildWorld(4);
const sig = (id: string, o: Record<string, unknown>) => ({ id, kind: "NEW_POSITION", wallet: "0xw1", condition_id: "0xc1", token_id: "tok1", outcome: "Lakers", title: "Lakers vs. Celtics", slug: "nba-lal-bos", price: 0.5, created_at: z("2026-10-02T10:00:00Z"), evaluated_at: z("2026-10-02T10:02:00Z"), payload: { copyScore: 80 }, ...o });
export const SIGNALS = [
  sig("s1", {}), sig("s2", { wallet: "0xw2", evaluated_at: z("2026-10-02T13:57:00Z") }), sig("s3", { wallet: "0xw3", evaluated_at: z("2026-10-02T14:30:00Z") }),
  sig("s4", { wallet: "0xw4", condition_id: "0xc2", token_id: "tok3", outcome: "Warriors", title: "Warriors vs. Knicks", slug: "nba-gsw-nyk", evaluated_at: z("2026-10-02T09:00:00Z") }),
  sig("s5", { wallet: "0xw5", payload: { copyScore: 60 } }), sig("s6", { wallet: "0xw6", condition_id: "0xc9", token_id: "tok9", outcome: "Yes", title: "Unknown game xyz", slug: "xyz" }),
  sig("s7", { wallet: "0xw7", condition_id: "0xc3", token_id: "tok5", outcome: "Bulls", title: "Bulls vs. Heat", slug: "nba-chi-mia" }), sig("s8", { wallet: "0xw8", condition_id: "0xc4", token_id: "tok7", outcome: "Nets", title: "Nets vs. Suns", slug: "nba-bkn-phx", evaluated_at: z("2026-10-02T18:00:00Z") }),
  sig("x1", { kind: "EXIT", wallet: "0xw1" }),
];
const US_MARKETS = [
  { id: "u1", slug: "nba-lal-bos", question: "Lakers vs Celtics", outcomes: '["Lakers","Celtics"]', conditionId: "0xc1", clobTokenIds: ["tok1", "tok2"], status: "open", eventStartTime: "2026-10-02T14:00:00+00:00", closeTime: "2026-10-02T17:00:00+00:00" },
  { id: "u2", slug: "nba-gsw-nyk", question: "Warriors vs Knicks", outcomes: '["Warriors","Knicks"]', clobTokenIds: ["tok3", "tok4"], status: "open", eventStartTime: "2026-10-04T20:00:00+00:00" },
  { id: "u3", slug: "nba-chi-mia", question: "Bulls vs Heat", outcomes: '["Bulls","Heat"]', clobTokenIds: ["tok5", "tok6"], status: "open" },
];
const PAPER = [[10, 1], [-100, 3], [30, 2], [-60, 1], [90, 4], [-100, 2], [20, 1], [-40, 2]].map(([ret, days], i) => ({ signal_id: `s${(i % 8) + 1}`, mode: "REALISTIC", coverage_state: "SIMULATED", state: "RESOLVED", source_trade_ts: z("2026-09-30T10:00:00Z"), fill_ts: z("2026-09-30T10:05:00Z"), closed_at: new Date(Date.parse("2026-09-30T10:05:00Z") + days * 86_400_000).toISOString(), net_pnl: ret * 0.05, filled_usd: 5 }));
export const worldDb = () => memDb({ signals: SIGNALS.map((s) => ({ ...s })), markets: [{ condition_id: "0xc1", end_date: "2026-10-02" }, { condition_id: "0xc2", end_date: "2026-10-04" }], paper_executions: PAPER.map((p) => ({ ...p })) });

const gamma = (u: URL): Response => { const closed = u.searchParams.get("closed") === "true"; const all = (world.gamma as any[]).filter((m) => m.closed === closed); const off = Number(u.searchParams.get("after_cursor") ?? 0); return json({ markets: all.slice(off, off + 100), next_cursor: off + 100 < all.length ? String(off + 100) : null }); };
const usAudit = (u: URL): Response => { const closed = u.searchParams.get("closed") === "true"; const all = (world.us as any[]).filter((m) => (m.status === "settled") === closed); const off = Number(u.searchParams.get("offset") ?? 0); return json({ markets: all.slice(off, off + 100) }); };
const usCover = (u: URL): Response => (u.pathname === "/v1/markets" ? json({ markets: US_MARKETS.filter((m) => (m.status === "settled") === (u.searchParams.get("closed") === "true")) }) : u.pathname === "/v1/search" ? json({ events: u.searchParams.get("query")!.includes("lakers") ? [{ title: "Lakers vs Celtics", slug: "nba-lal-bos", markets: [{ id: "u1", question: "Lakers vs Celtics", outcomes: '["Lakers","Celtics"]' }] }] : [] }) : new Response("no", { status: 404 }));
export const handler = (mode: "audit" | "cover"): ((u: URL) => Response) => { const kAudit = kalshiServer({ open: nbaEvents("o", 40, false), settled: nbaEvents("s", 40, true) }).handler; const kCover = kalshiServer(funnelEvents()).handler;
  return (u) => (u.host === "gamma-api.polymarket.com" ? gamma(u) : u.host === "gateway.polymarket.us" ? (mode === "audit" ? (u.pathname === "/v1/markets" ? usAudit(u) : new Response("no", { status: 404 })) : usCover(u)) : mode === "audit" ? kAudit(u) : kCover(u)); };

export interface Pipe { fs: Record<string, string>; lines: Record<string, string[]>; codes: Record<string, number>; calls: string[] }
export function pipe(): Pipe & { run: (name: string, cli: typeof runMergeCli, argv: string[], o?: { mode?: "audit" | "cover"; db?: ReturnType<typeof worldDb> | null; env?: Record<string, string | undefined>; extra?: Partial<CliDeps> }) => Promise<number> } {
  const fs: Record<string, string> = { [RULE]: SHIPPED_RULE }; const lines: Record<string, string[]> = {}; const codes: Record<string, number> = {}; const calls: string[] = [];
  const run = async (name: string, cli: typeof runMergeCli, argv: string[], o: { mode?: "audit" | "cover"; db?: ReturnType<typeof worldDb> | null; env?: Record<string, string | undefined>; extra?: Partial<CliDeps> } = {}) => {
    const c = virtualClock(NOW); const f = fakeFetch(handler(o.mode ?? "cover"), c.now); const l: string[] = []; const db = o.db === undefined ? worldDb() : o.db;
    const code = await cli(argv, o.env ?? ENV, { fetch: f.fetch, now: c.now, sleep: c.sleep, writeFile: (p, x) => { fs[p] = x; }, mkdir() {}, readFile: (p) => (fs[p] !== undefined ? fs[p] : null), log: (x) => l.push(x), db: db ? () => readOnly(db.db as never) : undefined, ...(o.extra ?? {}) });
    lines[name] = l; codes[name] = code; calls.push(...f.calls.map((x) => x.url)); return code;
  };
  return { fs, lines, codes, calls, run };
}
/** Everything up to (and not including) the review: audits, coverage and title searches of both execution venues, plus the signal source's coverage. */
export async function buildVenueFiles(p: ReturnType<typeof pipe>, o: { allScores?: boolean } = {}): Promise<void> {
  await p.run("audit-us", runTimestampAuditCli, ["--venue", "polymarket_us", "--no-fixtures"], { mode: "audit", db: null, env: {} }); await p.run("audit-kalshi", runTimestampAuditCli, ["--venue", "kalshi", "--no-fixtures"], { mode: "audit", db: null, env: {} });
  await p.run("cov-intl", runCoverageCli, ["--venue", "polymarket_intl"]); await p.run("cov-us", runCoverageCli, ["--venue", "polymarket_us", "--diagnose"]); await p.run("cov-kalshi", runCoverageCli, ["--venue", "kalshi"]);
  await p.run("titles-us", runTitleSearchCli, ["--venue", "polymarket_us", ...(o.allScores ? ["--all-scores"] : [])]); await p.run("titles-kalshi", runTitleSearchCli, ["--venue", "kalshi", ...(o.allScores ? ["--all-scores"] : [])]);
}
export { runMergeCli, runReviewIngestCli, runReviewSheetCli, runWalletShareCli };
