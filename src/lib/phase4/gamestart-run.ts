/**
 * Phase 4.0e — the `phase4:gamestart-check` run: STREAMS the US exchange's listings and the sports-API schedule into the bounded `GsCollector` (nothing but a ≤ 200-byte
 * record per distinct event is kept; the market objects are dropped as each page is processed), then analyses (`gamestart.ts`) and renders `S1e_GAMESTART.md` (≤ 80 lines).
 * Public unauthenticated GETs through PoliteHttp (the US origin at 1.1 s per request); a refusal (401/403/451) stops the whole run and is reported, nothing else is tried.
 * One venue, one process; no database at all.
 */
import type { PoliteHttp } from "./http";
import type { RawMarket } from "./audit";
import { discoverUsSports } from "./us-sports";
import { extractRecords, usIdOf, type UsConfig } from "./venues";
import { analyse, DST_TRANSITION_DATE, GsCollector, type GamestartResult } from "./gamestart";
import { EVIDENCE_SCHEMA, type Guard } from "./venue-run";

export const GS_DEFAULTS = { maxMarkets: 40_000, maxEvents: 12_000, maxRequests: 700, pagesPerSource: 8, listingPages: 120 } as const;
export interface StreamNote { name: string; markets: number; pages: number; stoppedBecause: string }

const cursorOf = (json: unknown): string | null => { if (!json || typeof json !== "object" || Array.isArray(json)) return null; for (const [k, v] of Object.entries(json as Record<string, unknown>)) if (/cursor/i.test(k) && typeof v === "string" && v) return v; return null; };
/** Page one query, handing every market to `sink` as its page arrives (the page is not kept). Stops at `maxPages`, the budget, an empty or repeated page, an error, or `stop()`. */
export async function streamPages(http: PoliteHttp, cfg: UsConfig, o: { name: string; path: string; query: string; maxPages: number; budget: { left: number }; sink: (m: RawMarket) => void; stop: () => boolean }): Promise<StreamNote & { refused: boolean }> {
  const note: StreamNote & { refused: boolean } = { name: o.name, markets: 0, pages: 0, stoppedBecause: "", refused: false }; let cursor: string | null = null, offset = 0, lastFirst = "";
  for (let page = 0; page < o.maxPages; page++) {
    if (o.stop()) { note.stoppedBecause = "sample cap reached"; return note; } if (o.budget.left <= 0) { note.stoppedBecause = "request budget reached"; return note; }
    let url = `${cfg.base}${o.path}?${o.query}&${cfg.limitParam}=${cfg.pageSize}`; if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`; else if (cfg.pageParam && page > 0) url += `&${cfg.pageParam}=${offset}`;
    o.budget.left--; const r = await http.getJson(url); note.pages++;
    if (!r.ok) { note.stoppedBecause = `error (${r.kind}${r.status ? ` ${r.status}` : ""})`; note.refused = r.kind === "BLOCKED" || r.kind === "BLOCKED_SKIPPED"; return note; }
    const { records } = extractRecords(r.json); const next = cursorOf(r.json); if (!records.length) { note.stoppedBecause = "empty page"; return note; }
    const first = usIdOf(records[0]); if (first && first === lastFirst) { note.stoppedBecause = "page repeated (paging parameter ignored?)"; return note; } lastFirst = first;
    for (const m of records) { o.sink(m); note.markets++; } if (next) cursor = next; else if (cfg.pageParam) offset += records.length; else { note.stoppedBecause = "no paging mechanism"; return note; }
  }
  note.stoppedBecause = "page limit reached"; return note;
}

export interface GsRunOptions { maxMarkets?: number; maxEvents?: number; maxRequests?: number; pagesPerSource?: number; listingPages?: number; now?: () => number; guard?: Guard | null; heap?: () => { budgetMb: number; peakMb: number } | null; log?: (m: string) => void }
/** Fetch (sports API first, then the open and the closed listing) into the collector, then analyse. */
export async function runGamestart(http: PoliteHttp, cfg: UsConfig, o: GsRunOptions = {}): Promise<{ result: GamestartResult; collector: GsCollector }> {
  const now = o.now ?? (() => Date.now()); const startedAt = new Date(now()).toISOString(); const col = new GsCollector(o.maxEvents ?? GS_DEFAULTS.maxEvents, o.maxMarkets ?? GS_DEFAULTS.maxMarkets); const budget = { left: o.maxRequests ?? GS_DEFAULTS.maxRequests }; const sources: StreamNote[] = []; let refused = false; let stopped: string | null = null;
  const run = async (name: string, path: string, query: string, pages: number) => { if (refused || budget.left <= 0 || col.counts.full) return; o.guard?.setStage(name, "polymarket_us"); o.log?.(`gamestart: ${name}`); const n = await streamPages(http, cfg, { name, path, query, maxPages: pages, budget, sink: (m) => col.add(m), stop: () => col.counts.full }); sources.push({ name: n.name, markets: n.markets, pages: n.pages, stoppedBecause: n.stoppedBecause }); if (n.refused) { refused = true; stopped = `${cfg.base} refused access (${n.stoppedBecause}) during ${name}; the run stops and tries nothing else`; } };
  o.guard?.setStage("sports API discovery", "polymarket_us"); budget.left -= 2; const d = refused ? { sports: [] } : await discoverUsSports(http, cfg);
  for (const sp of d.sports.slice(0, 12)) { await run(`sports API: ${sp.slug} open`, `${cfg.sportsPath}/${encodeURIComponent(sp.slug)}/events`, "active=true", o.pagesPerSource ?? GS_DEFAULTS.pagesPerSource); await run(`sports API: ${sp.slug} ended`, `${cfg.sportsPath}/${encodeURIComponent(sp.slug)}/events`, "closed=true", o.pagesPerSource ?? GS_DEFAULTS.pagesPerSource); }
  await run("listing: open", cfg.marketsPath, cfg.openQuery, o.listingPages ?? GS_DEFAULTS.listingPages); await run("listing: closed", cfg.marketsPath, cfg.closedQuery, o.listingPages ?? GS_DEFAULTS.listingPages);
  const events = [...col.events.values()]; const a = analyse(events);
  const result: GamestartResult = { schema: EVIDENCE_SCHEMA, kind: "gamestart", venue: "polymarket_us", startedAt, finishedAt: new Date(now()).toISOString(), transition: DST_TRANSITION_DATE, counts: col.counts, ...a,
    fetch: { requests: (o.maxRequests ?? GS_DEFAULTS.maxRequests) - budget.left, sources, stoppedBecause: stopped ?? (col.counts.full ? `sample cap reached (${col.counts.markets} markets, ${col.events.size} events)` : budget.left <= 0 ? "request budget reached" : null), refused }, heap: o.heap?.() ?? null, stopped: stopped ? { reason: "refused", stage: sources[sources.length - 1]?.name ?? "start", message: stopped } : null };
  return { result, collector: col };
}

// ───────────────────────────────────────────── rendering ─────────────────────────────────────────────────────

const pc = (x: number | null | undefined) => (x === null || x === undefined ? "n/m" : `${(x * 100).toFixed(1)} %`);
export const GS_MD_MAX_LINES = 80;
const STRATA_SHOWN = ["sports:american_football", "sports:basketball", "sports:hockey", "sports:combat", "sports:other_sport", "esports", "politics"];
/** S1e_GAMESTART.md, at most 80 lines. Every conclusion is a statement of the numbers; no option is recommended. */
export function renderGamestartMd(r: GamestartResult): string {
  const L: string[] = ["# S1e: are `gameStartTime` values at 00:00:00Z placeholders or real evening starts? (generated; research; D68 untouched)", ""];
  L.push(`Sample: ${r.counts.markets} markets → ${r.events} distinct events with a datetime \`gameStartTime\` (${r.counts.noGameStart} without one, ${r.counts.dateOnly} date-only); ${r.midnightEvents} events at exactly 00:00:00Z. Eastern conversions use the IANA zone America/New_York per value. ${r.sampleNote}.`);
  L.push(`Fetch: ${r.fetch.requests} requests; ${r.fetch.stoppedBecause ? `stopped: ${r.fetch.stoppedBecause}` : "finished"}${r.stopped ? ` · REFUSED: ${r.stopped.message}` : ""}.`, "");
  L.push("## A. The daylight-saving discriminator (events; 00:00Z / 01:00Z counts; rules fixed before the counts)", "", "| sport | EDT events | at 00:00Z | at 01:00Z | EST events | at 00:00Z | at 01:00Z | verdict |", "|---|---|---|---|---|---|---|---|");
  for (const s of r.dst.slice(0, 9)) L.push(`| ${s.sport} | ${s.EDT.events} | ${s.EDT.midnightEvents} | ${s.EDT.at0100Events} | ${s.EST.events} | ${s.EST.midnightEvents} | ${s.EST.at0100Events} | ${s.verdict} |`);
  for (const scope of ["sports and esports", "other categories"]) L.push("", `Recurring clocks, ${scope} (events EDT → EST; a clock that shifts +1 h with daylight saving is local time): ${r.clocks.filter((c) => c.scope === scope && c.kind !== "ET_MIDNIGHT" && c.kind !== "ET_END_OF_DAY").map((c) => `${c.clock} ${c.EDTevents}→${c.ESTevents} (${c.verdict})`).join(" · ")}; Eastern-local shapes: ${r.clocks.filter((c) => c.scope === scope && (c.kind === "ET_MIDNIGHT" || c.kind === "ET_END_OF_DAY")).map((c) => `${c.clock} ${c.EDTevents}→${c.ESTevents}`).join(" · ")}.`);
  const g = r.midnightByType.slice(0, 6).map((x) => `${x.sport}/${x.marketType}/${x.period} ${x.events}ev ${x.markets}mk`).join(" · "); L.push(`At 00:00Z by sport / market type / period: ${g || "none"}.`, "");
  const c = r.corroboration, m = c.midnight.all, k = c.control.all;
  L.push("## B. Independent corroboration per event (00:00Z group vs a same-size contrast sample at other clocks)", "", "| | 00:00Z events | contrast events |", "|---|---|---|");
  L.push(`| LIKELY_REAL / LIKELY_PLACEHOLDER / UNDETERMINED | ${m.labels.LIKELY_REAL} / ${m.labels.LIKELY_PLACEHOLDER} / ${m.labels.UNDETERMINED} | ${k.labels.LIKELY_REAL} / ${k.labels.LIKELY_PLACEHOLDER} / ${k.labels.UNDETERMINED} |`);
  L.push(`| schedule: with a time of day / agree ≤ 15 min / differ / absent | ${m.schedule.withTimeOfDay} / ${m.schedule.agree} / ${m.schedule.differs} / ${m.schedule.absent} | ${k.schedule.withTimeOfDay} / ${k.schedule.agree} / ${k.schedule.differs} / ${k.schedule.absent} |`);
  L.push(`| resolved with a gap: n · p10 / p50 / p90 (h) · in 1–6 h | ${m.resolution.n} · ${m.resolution.p10h ?? "n/m"} / ${m.resolution.p50h ?? "n/m"} / ${m.resolution.p90h ?? "n/m"} · ${m.resolution.real} | ${k.resolution.n} · ${k.resolution.p10h ?? "n/m"} / ${k.resolution.p50h ?? "n/m"} / ${k.resolution.p90h ?? "n/m"} · ${k.resolution.real} |`);
  L.push(`| start within 1 h of creation (of n) · median days after creation | ${m.creation.within1h} of ${m.creation.n} · ${m.creation.p50days ?? "n/m"} | ${k.creation.within1h} of ${k.creation.n} · ${k.creation.p50days ?? "n/m"} |`, "");
  L.push(`Share of events at 00:00Z by market type: ${c.byMarketType.slice(0, 6).map((x) => `${x.marketType} ${pc(x.share)} (${x.atMidnight}/${x.events})`).join(" · ")}; by category: ${c.byCategory.slice(0, 6).map((x) => `${x.category} ${pc(x.share)} (${x.atMidnight}/${x.events})`).join(" · ")}.`);
  L.push(`Slates (sports): ${c.slate.slice(0, 5).map((x) => `${x.sport} ${x.instantsAt0000} instants at 00:00Z, max ${x.maxEventsOnOneInstant} events on one instant`).join(" · ")}. Rules: S schedule agrees ≤ 15 min; R resolution 1–6 h; T futures-like or non-game category; creation and slate are reported, not decisive.`, "");
  L.push("## C. The what-if (LABELLED: nothing is applied; the real audit verdicts are unchanged; thresholds RECOMMEND_RULES unchanged)", "", "usable share and verdict for `gameStartTime` as slot 1: baseline | exempt LIKELY_REAL 00:00Z events | exempt schedule-corroborated | (c) the schedule start as the candidate", "", "| stratum | events | at 00:00Z (real / schedule-agree) | baseline | what-if real | what-if schedule | (c) schedule |", "|---|---|---|---|---|---|---|");
  const cell = (e: { usableShare: number | null; verdict: string; failedKeys: string[] }) => `${pc(e.usableShare)} ${e.verdict === "RECOMMEND" ? "PASS" : e.verdict === "INSUFFICIENT_DATA" ? "?DATA" : `REJECT (${e.failedKeys.join(", ")})`}`;
  const rows = r.whatIf.filter((w) => STRATA_SHOWN.includes(w.stratum)).sort((a, b) => STRATA_SHOWN.indexOf(a.stratum) - STRATA_SHOWN.indexOf(b.stratum)); for (const w of rows) L.push(`| ${w.stratum} | ${w.events} | ${w.midnightEvents} (${w.likelyRealEvents} / ${w.scheduleAgreeEvents}) | ${cell(w.baseline)} | ${cell(w.likelyReal)} | ${cell(w.scheduleAgrees)} | ${cell(w.schedule)} |`);
  const pass = (f: (w: GamestartResult["whatIf"][number]) => string) => r.whatIf.filter((w) => f(w) === "RECOMMEND").map((w) => w.stratum).join(", ") || "none";
  L.push("", "A what-if cell shows the usable share and, when it still rejects, the audit rule(s) that decide (a rule other than usableShare is NOT affected by the exemption: for example topClock rejects a stratum whose starts cluster on one time of day, placeholder or not).", "", "Options for the owner (no recommendation):");
  L.push(`(a) keep the placeholder rule: strata passing slot 1 with \`gameStartTime\`: ${pass((w) => w.baseline.verdict)}. Cost: none; sports stay without a slot-1 field from this venue unless (c).`);
  L.push(`(b) exempt 00:00:00Z only where independent evidence corroborates it per event (rule: S agrees ≤ 15 min, or R in 1–6 h, and no placeholder evidence): passing with LIKELY_REAL exempted: ${pass((w) => w.likelyReal.verdict)}; with schedule-corroborated exempted: ${pass((w) => w.scheduleAgrees.verdict)}. Cost: a per-event schedule lookup for each event at 00:00Z (${m.events} in this sample; ${m.schedule.agree} corroborated by the schedule, ${m.resolution.real} by resolution timing, which is not available before the event ends).`);
  L.push(`(c) slot 1 for sports from the schedule endpoint with its own audit: passing: ${pass((w) => w.schedule.verdict)}. Cost: depends on the endpoint's coverage (${m.schedule.absent} of ${m.events} midnight events and ${k.schedule.absent} of ${k.events} contrast events had no schedule start in this sample) and on its own rate limit.`);
  return L.slice(0, GS_MD_MAX_LINES).join("\n") + "\n";
}
/** ≤ 60 console lines. */
export function gamestartLines(r: GamestartResult, outDir: string): string[] {
  const L = [`gamestart-check polymarket_us: ${r.counts.markets} markets → ${r.events} events (${r.eventsBeforeTransition} EDT, ${r.eventsAfterTransition} EST); ${r.midnightEvents} at 00:00:00Z; ${r.fetch.requests} requests${r.fetch.stoppedBecause ? `; ${r.fetch.stoppedBecause}` : ""}`, r.sampleNote];
  if (r.stopped) L.push(`REFUSED: ${r.stopped.message}`);
  for (const s of r.dst.slice(0, 8)) L.push(`  ${s.sport.padEnd(26)} EDT ${s.EDT.events} (00:00Z ${s.EDT.midnightEvents}, 01:00Z ${s.EDT.at0100Events}) · EST ${s.EST.events} (00:00Z ${s.EST.midnightEvents}, 01:00Z ${s.EST.at0100Events}) → ${s.verdict}`);
  const m = r.corroboration.midnight.all; L.push(`00:00Z events: LIKELY_REAL ${m.labels.LIKELY_REAL} · LIKELY_PLACEHOLDER ${m.labels.LIKELY_PLACEHOLDER} · UNDETERMINED ${m.labels.UNDETERMINED}; schedule agrees ${m.schedule.agree}, differs ${m.schedule.differs}, absent ${m.schedule.absent}`);
  for (const w of r.whatIf.filter((x) => STRATA_SHOWN.includes(x.stratum))) L.push(`  what-if ${w.stratum.padEnd(26)} baseline ${w.baseline.verdict} ${pc(w.baseline.usableShare)} → real ${w.likelyReal.verdict} ${pc(w.likelyReal.usableShare)} · schedule ${w.scheduleAgrees.verdict} ${pc(w.scheduleAgrees.usableShare)} · (c) ${w.schedule.verdict} ${pc(w.schedule.usableShare)}`);
  L.push("what-if only: no verdict of the real audit changed; options (a)(b)(c) in S1e_GAMESTART.md; none is recommended", `files in ${outDir}: v_polymarket_us_gamestart.json S1e_GAMESTART.md`);
  return L.map((l) => (l.length > 220 ? l.slice(0, 217) + "..." : l)).slice(0, 60);
}
