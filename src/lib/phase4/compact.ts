/**
 * Phase 4.0c, Part D3 — `S1_COMPACT.md`: ≤ 80 lines, one row per venue × stratum × slot (best field, verdict, events, the deciding rule) and one funnel
 * table for the execution venues. The international section of the last production log was lost because the full results are too long to retrieve from a
 * log-only host; this file is what a Railway run prints (`--print-files S1_COMPACT.md`). Generated from the JSON files the two scripts write, so either
 * script can refresh it and a missing input is stated, never guessed. Pure apart from the injected `readFile`.
 */
import type { SlotVerdict } from "./audit";
import { STAGES, type FunnelResult } from "./funnel";

export const COMPACT_MAX_LINES = 80;
export const COMPACT_FILE = "S1_COMPACT.md";
const VENUE_ORDER = ["polymarket_us", "kalshi", "polymarket_intl"];
const SHORT: Record<string, string> = { polymarket_us: "US", kalshi: "Kalshi", polymarket_intl: "Intl" };

/** `status` (4.0d, per-venue runs merged later): "not_run" = no evidence file for the venue, "stopped" = its run stopped on a budget; both read as such, never as "not reached" or zero. */
export interface S1aSummaryLike { startedAt?: string; finishedAt?: string; venues?: { venue: string; reachable: boolean; recommendations?: SlotVerdict[]; status?: "run" | "not_run" | "stopped" }[] }
interface FunnelFileLike { window?: { startIso: string; endIso: string }; funnel?: FunnelResult; venue?: { measured?: { mapping: boolean; tradable: boolean; timestamp: boolean } }; measured?: { mapping: boolean; tradable: boolean; timestamp: boolean } }
/** `notRun` (4.0d): the venue was not run in a per-venue process, so its funnel column reads "not run" instead of being left out. */
export interface CompactInput { s1a: S1aSummaryLike | null; funnels: { venue: string; file: FunnelFileLike | null; notRun?: boolean }[] }

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const verdictText = (v: SlotVerdict): { best: string; verdict: string } => {
  const best = v.bestField !== undefined ? v.bestField : v.verdict === "RECOMMEND" ? v.field : null;
  return { best: best ?? "NONE", verdict: best ? (v.slot === 2 || v.needsHumanReview ? "OK (human review)" : "OK") : v.verdict === "INSUFFICIENT_DATA" ? "?DATA" : "REJECT" };
};
/** The rule that decided the row, and what each other candidate failed on (`field:rule`), so a field that was judged and lost is visible. */
export function ruleText(v: SlotVerdict): string {
  const cands = v.candidates ?? []; const best = v.bestField ?? (v.verdict === "RECOMMEND" ? v.field : null);
  if (best) { const others = cands.filter((c) => c.field !== best).slice(0, 3).map((c) => `${leaf(c.field)}:${c.decidedBy}`); return `allPassed${others.length ? `; also ${others.join(", ")}` : ""}`; }
  if (cands.length) return cands.slice(0, 4).map((c) => `${leaf(c.field)}:${c.decidedBy}`).join(", ");
  return v.decidedBy;
}
export const leaf = (p: string) => p.replace(/\[\]/g, "").split(".").slice(-2).join(".");

/** Render the compact file; never more than 80 lines (rows are dropped, least informative first, with a final line saying how many). */
export function renderCompact(inp: CompactInput): string {
  const head: string[] = ["# S1 compact results (generated; the rules are RECOMMEND_RULES, owner decision D68; nothing here is a decision)", ""];
  head.push(inp.s1a ? `S1a (time fields): run ${inp.s1a.startedAt ?? "?"} → ${inp.s1a.finishedAt ?? "?"}. Slot 1 = event start, slot 2 = close. OK = best passing field; NONE = no candidate passes; ?DATA = fewer than 30 events or no resolved ordering evidence.` : "S1a (time fields): s1a_summary.json not found: run `npm run phase4:ts-audit` (slot rows omitted).");
  const rows: { venue: string; stratum: string; slot: number; events: number; line: string; informative: boolean }[] = [];
  for (const v of inp.s1a?.venues ?? []) { if (!v.reachable) { const st = v.status === "not_run" ? "NOT RUN" : v.status === "stopped" ? "STOPPED" : "NOT REACHED"; rows.push({ venue: v.venue, stratum: "(all)", slot: 0, events: 0, line: v.status === "not_run" || v.status === "stopped" ? `| ${SHORT[v.venue] ?? v.venue} | (venue) | — | — | ${st} | n/m | ${v.status === "not_run" ? "no evidence file for this venue" : "the run stopped before it finished"} |` : `| ${SHORT[v.venue] ?? v.venue} | (venue) | — | NONE | NOT REACHED | 0 | no markets fetched |`, informative: true }); continue; }
    for (const r of v.recommendations ?? []) { const t = verdictText(r); rows.push({ venue: v.venue, stratum: r.stratum, slot: r.slot, events: r.events, line: `| ${SHORT[v.venue] ?? v.venue} | ${r.stratum} | ${r.slot} | ${t.best === "NONE" ? "NONE" : "`" + cut(leaf(t.best), 28) + "`"} | ${t.verdict} | ${r.events} | ${cut(ruleText(r), 96)} |`, informative: r.events >= 30 || t.best !== "NONE" }); } }
  rows.sort((a, b) => Number(b.informative) - Number(a.informative) || VENUE_ORDER.indexOf(a.venue) - VENUE_ORDER.indexOf(b.venue) || b.events - a.events || (a.stratum < b.stratum ? -1 : a.stratum > b.stratum ? 1 : a.slot - b.slot));
  const funnelLines: string[] = [];
  const have = inp.funnels.filter((f) => f.file?.funnel);
  // a venue whose coverage file is missing is shown as "not run" when another venue has one (all-in-one files never name a venue that was not asked for)
  const cols = have.length ? inp.funnels.filter((f) => f.file?.funnel || f.notRun) : [];
  if (!have.length) funnelLines.push("", "Funnel: s1b_funnel*.json not found: run `npm run phase4:coverage` (funnel table omitted).");
  else {
    const w = have[0].file!.window; funnelLines.push("", `Funnel (cumulative signals, same window${w ? ` ${w.startIso} → ${w.endIso}` : ""}; EXACT / EXACT+PROBABLE; n/m = stage not measured; not run = no coverage file for the venue; mapped counts are lower bounds if a listing was cut off):`, "", `| stage | ${cols.map((f) => SHORT[f.venue] ?? f.venue).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
    STAGES.forEach((s, i) => funnelLines.push(`| ${s.label.replace(/ \(.*\)$/, "")} | ${cols.map((f) => { const fn = f.file?.funnel; return fn ? `${fn.variants.EXACT.counts[i] ?? "n/m"} / ${fn.variants.EXACT_PLUS_PROBABLE.counts[i] ?? "n/m"}` : "not run"; }).join(" | ")} |`));
    const eligible = cols.map((f) => { const d = f.file?.funnel?.variants.EXACT.perDay.minLead; return `${SHORT[f.venue] ?? f.venue} ${!f.file?.funnel ? "not run" : d?.perElapsedDay == null ? "n/m" : d.perElapsedDay.toFixed(1)}`; }).join(" · "); funnelLines.push("", `Final stage per elapsed day (EXACT): ${eligible}.`);
  }
  const tableHead = ["", "| venue | stratum | slot | best field | verdict | events | deciding rule (other candidates: field:rule) |", "|---|---|---|---|---|---|---|"];
  const budget = COMPACT_MAX_LINES - head.length - tableHead.length - funnelLines.length - 2;
  const shown = rows.length <= budget ? rows : rows.slice(0, Math.max(0, budget - 1));
  const out = [...head, ...(inp.s1a ? [...tableHead, ...shown.map((r) => r.line), ...(rows.length > shown.length ? [`… ${rows.length - shown.length} more rows (strata with fewer than 30 events, and later slot rows) in s1a_summary.json`] : [])] : []), ...funnelLines];
  return out.slice(0, COMPACT_MAX_LINES).join("\n") + "\n";
}

/** Read the three JSON files from `outDir` and write `S1_COMPACT.md` (either script calls this after it finishes). Unreadable input is treated as missing. */
export function writeCompact(readFile: (rel: string) => string | null, write: (rel: string, content: string) => void, o: { s1a?: S1aSummaryLike | null } = {}): void {
  const load = <T>(rel: string): T | null => { try { const t = readFile(rel); return t ? (JSON.parse(t) as T) : null; } catch { return null; } };
  write(COMPACT_FILE, renderCompact({ s1a: o.s1a !== undefined ? o.s1a : load<S1aSummaryLike>("s1a_summary.json"), funnels: [{ venue: "polymarket_us", file: load<FunnelFileLike>("s1b_funnel.json") }, { venue: "kalshi", file: load<FunnelFileLike>("s1b_funnel_kalshi.json") }] }));
}
