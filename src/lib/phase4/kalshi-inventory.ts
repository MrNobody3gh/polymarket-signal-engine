/**
 * Phase 4.0d, Part A4 — the Kalshi category inventory WITHOUT scanning its roughly 350,000 markets. Question: how many markets and events exist per category
 * and status, and does an esports category exist at all? The 4.0c run could only say what its 40,000-market listing held (5 esports markets), which is a
 * statement about the sample, not about Kalshi.
 *
 * What it reads (public, unauthenticated GETs through PoliteHttp, ≤ 2 requests/second; endpoint names are those of Kalshi's published documentation as
 * summarised in docs/phase4/KALSHI_API.md, UNVERIFIED until a run answers):
 *  1. `GET /search/tags_by_categories`: the category names and their tags (one request);
 *  2. `GET /series[?category=…]`: every series with its category, title and tags, so series per category and the esports series are counted exactly;
 *  3. `GET /events?status=<s>&limit=200` WITHOUT nested markets, for each status, paged and counted on arrival: events per category and status. The page
 *     is dropped as soon as it is counted, so memory is the size of the count table, not of the listing (this is the streaming that replaces the scan);
 *  4. one `limit=1` probe each on `/events` and `/markets`, recording whether the response carries a documented total (`total`, `count`, …).
 * What it never does: load a market. `with_nested_markets` is never requested, `/markets` is asked for one record only, and the code never reads an event's
 * `markets` member (tests/phase4-kalshi-inventory.test.ts proves it with a proxy that throws on access). The number of MARKETS per category is therefore
 * reported as NOT AVAILABLE unless the venue returns a total; it is never estimated or guessed.
 */
import type { PoliteHttp } from "./http";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const KINDS = ["open", "unopened", "closed", "settled"] as const;
export type InventoryStatus = (typeof KINDS)[number];
export interface InventoryCell { open: number; unopened: number; closed: number; settled: number; total: number }

/** Words that name an esports title or league; matched on category names, tags, series and event titles (whole words, case-insensitive). */
export const ESPORTS_RE = /\be-?sports?\b|\bleague of legends\b|\bcounter-?strike\b|\bcs2\b|\bcs:?\s?go\b|\bdota ?2?\b|\bvalorant\b|\boverwatch\b|\brocket league\b|\bstarcraft\b|\bcall of duty\b|\bcdl\b|\blck\b|\blcs\b|\blpl\b|\blec\b/i;

export interface KalshiInventory {
  base: string; requests: number; budget: number; complete: boolean; stoppedBecause: string | null;
  /** Total-like members seen in the answers of the limit=1 probes (empty = the endpoint documents no total, so none can be read). */
  totals: { endpoint: string; ok: boolean; totalKeys: string[]; note: string }[];
  categories: { source: string; names: string[]; tagsByCategory: Record<string, number> };
  series: { read: boolean; total: number | null; byCategory: Record<string, number>; note: string };
  events: { byCategory: Record<string, InventoryCell>; total: InventoryCell; perStatus: Record<InventoryStatus, { pages: number; events: number; stoppedBecause: string }>; note: string };
  /** Markets are never loaded; the count is available only where the venue documents a total. */
  markets: { counted: false; note: string };
  esports: { categoryExists: boolean | null; matchedCategories: string[]; seriesMatched: number; eventsMatched: number; examples: string[]; basis: string };
  allows: string[]; doesNotAllow: string[];
}

const cell = (): InventoryCell => ({ open: 0, unopened: 0, closed: 0, settled: 0, total: 0 });
const TOTAL_KEY = /^(total|count|total_count|totalcount|total_results|num_results|n)$/i;
const totalKeysOf = (json: unknown): string[] => (json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json as Record<string, unknown>).filter((k) => TOTAL_KEY.test(k) && typeof (json as Record<string, unknown>)[k] === "number") : []);
const rootArray = (json: unknown, keys: string[]): Record<string, unknown>[] => { const r = json && typeof json === "object" ? (json as Record<string, unknown>) : {}; for (const k of keys) if (Array.isArray(r[k])) return (r[k] as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object"); return Array.isArray(json) ? (json as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []; };
const cursorOf = (json: unknown): string | null => { const c = json && typeof json === "object" ? (json as Record<string, unknown>).cursor : null; return typeof c === "string" && c ? c : null; };

export const DEFAULT_INVENTORY_BUDGET = 600;
export async function fetchKalshiInventory(http: PoliteHttp, base: string, o: { maxRequests?: number; pageSize?: number } = {}): Promise<KalshiInventory> {
  const budget = Math.max(1, o.maxRequests ?? DEFAULT_INVENTORY_BUDGET); const size = Math.min(200, Math.max(1, o.pageSize ?? 200)); let requests = 0; let stoppedBecause: string | null = null; let complete = true;
  const left = () => budget - requests;
  const get = async (path: string) => { requests++; return http.getJson(`${base}${path}`); };
  const allows: string[] = [], doesNotAllow: string[] = [];

  // 1 — categories and tags
  const categories: KalshiInventory["categories"] = { source: "none", names: [], tagsByCategory: {} };
  { const r = await get("/search/tags_by_categories");
    if (r.ok) { const m = (r.json as Record<string, unknown>)?.tags_by_categories ?? r.json; if (m && typeof m === "object" && !Array.isArray(m)) { categories.source = "/search/tags_by_categories"; for (const [k, v] of Object.entries(m as Record<string, unknown>)) { categories.names.push(k); categories.tagsByCategory[k] = Array.isArray(v) ? v.length : 0; } } allows.push(`GET /search/tags_by_categories answered: ${categories.names.length} categories`); }
    else doesNotAllow.push(`GET /search/tags_by_categories: ${r.kind}${r.status ? ` ${r.status}` : ""}`); }

  // 2 — series per category (and esports series), counted on arrival
  const series: KalshiInventory["series"] = { read: false, total: null, byCategory: {}, note: "" }; const esportsSeries: string[] = []; let seriesMatched = 0; const esportsCats = new Set<string>();
  { let cursor: string | null = null; let n = 0; let pages = 0; let more = false;
    while (pages < 20 && left() > 0) {
      const r = await get(`/series${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`); pages++; more = false;
      if (!r.ok) { series.note = `GET /series: ${r.kind}${r.status ? ` ${r.status}` : ""}`; if (pages === 1) doesNotAllow.push(series.note); break; }
      const list = rootArray(r.json, ["series", "data", "results", "items"]); series.read = true;
      for (const x of list) { n++; const cat = str(x.category) ?? "(none)"; series.byCategory[cat] = (series.byCategory[cat] ?? 0) + 1; const tags = Array.isArray(x.tags) ? (x.tags as unknown[]).filter((t): t is string => typeof t === "string") : []; const text = [cat, str(x.title), str(x.ticker), ...tags].filter(Boolean).join(" ");
        if (ESPORTS_RE.test(text)) { seriesMatched++; esportsCats.add(cat); if (esportsSeries.length < 5) esportsSeries.push(`${str(x.ticker) ?? "?"}: ${str(x.title) ?? ""}`.slice(0, 100)); } }
      const next = cursorOf(r.json); if (!next || next === cursor) break; cursor = next; more = true;
    }
    if (series.read) { series.total = n; series.note = series.note || `${n} series read in ${pages} request(s)`; allows.push("GET /series lists every series with its category, title and tags (series per category is exact)"); if (more) { complete = false; stoppedBecause ??= `series listing cut after ${pages} request(s)`; } }
    if (!categories.names.length && series.read) { categories.source = "/series"; categories.names = Object.keys(series.byCategory).sort(); } }

  // 3 — events per category and status, streamed WITHOUT nested markets
  const byCategory: Record<string, InventoryCell> = {}; const total = cell(); const perStatus = Object.fromEntries(KINDS.map((k) => [k, { pages: 0, events: 0, stoppedBecause: "not run" }])) as KalshiInventory["events"]["perStatus"]; let eventsMatched = 0;
  for (const status of KINDS) {
    let cursor: string | null = null; const ps = perStatus[status]; ps.stoppedBecause = "";
    for (let page = 0; ; page++) {
      if (left() <= 0) { ps.stoppedBecause = "request budget reached"; complete = false; stoppedBecause ??= `request budget of ${budget} reached while counting ${status} events`; break; }
      const qs = new URLSearchParams({ status, limit: String(size) }); if (cursor) qs.set("cursor", cursor);
      const r = await get(`/events?${qs}`); ps.pages++;
      if (!r.ok) { ps.stoppedBecause = `error (${r.kind}${r.status ? ` ${r.status}` : ""})`; complete = false; stoppedBecause ??= `GET /events?status=${status}: ${r.kind}${r.status ? ` ${r.status}` : ""}`; if (!page && status === "open") doesNotAllow.push(`GET /events?status=open: ${r.kind}${r.status ? ` ${r.status}` : ""}`); break; }
      const list = rootArray(r.json, ["events", "data", "results", "items"]);
      for (const e of list) { const cat = str(e.category) ?? "(none)"; const c = (byCategory[cat] ??= cell()); c[status]++; c.total++; total[status]++; total.total++; ps.events++;
        if (ESPORTS_RE.test([cat, str(e.title), str(e.series_ticker)].filter(Boolean).join(" "))) { eventsMatched++; esportsCats.add(cat); } }
      const next = cursorOf(r.json); if (!list.length) { ps.stoppedBecause = "empty page"; break; } if (!next) { ps.stoppedBecause = "listing ended"; break; } if (next === cursor) { ps.stoppedBecause = "page repeated (cursor ignored?)"; complete = false; break; } cursor = next;
    }
  }
  if (total.total) allows.push("GET /events (status filter, cursor, no nested markets) counts events per category and status exactly, by streaming");

  // 4 — documented totals: one record per endpoint
  const totals: KalshiInventory["totals"] = [];
  for (const [endpoint, path] of [["/events", "/events?status=open&limit=1"], ["/markets", "/markets?status=open&limit=1"]] as const) {
    if (left() <= 0) { totals.push({ endpoint, ok: false, totalKeys: [], note: "request budget reached" }); continue; }
    const r = await get(path);
    if (!r.ok) totals.push({ endpoint, ok: false, totalKeys: [], note: `${r.kind}${r.status ? ` ${r.status}` : ""}` });
    else { const keys = totalKeysOf(r.json); totals.push({ endpoint, ok: true, totalKeys: keys, note: keys.length ? `total-like members: ${keys.join(", ")}` : `no total in the answer (members: ${Object.keys((r.json ?? {}) as Record<string, unknown>).join(", ") || "none"})` }); }
  }
  const marketsTotal = totals.find((t) => t.endpoint === "/markets");
  if (marketsTotal?.ok && !marketsTotal.totalKeys.length) doesNotAllow.push("GET /markets: a limit=1 page returns a cursor but no total, so the number of markets per category and status cannot be read without paging through them");
  if (totals.find((t) => t.endpoint === "/events")?.ok && !totals.find((t) => t.endpoint === "/events")!.totalKeys.length) doesNotAllow.push("GET /events: no total either; the event counts above come from counting pages as they arrive");

  const categoryExists: boolean | null = !series.read && !total.total && !categories.names.length ? null : [...categories.names, ...Object.keys(series.byCategory), ...Object.keys(byCategory)].some((c) => ESPORTS_RE.test(c));
  const esports: KalshiInventory["esports"] = { categoryExists, matchedCategories: [...esportsCats].sort(), seriesMatched, eventsMatched, examples: esportsSeries,
    basis: "an esports/gaming word (esports, League of Legends, Counter-Strike, CS2, Dota, Valorant, Overwatch, Rocket League, StarCraft, Call of Duty, CDL/LCK/LCS/LPL/LEC) in a category name, a series title or tag, or an event title; `categoryExists` is about category NAMES only, the match counts are about titles" };
  return { base, requests, budget, complete, stoppedBecause, totals, categories, series, events: { byCategory, total, perStatus, note: complete ? "every status was paged to its end" : `LOWER BOUNDS: ${stoppedBecause ?? "a listing was cut"}` }, markets: { counted: false, note: marketsTotal?.totalKeys.length ? `the venue documents a total (${marketsTotal.totalKeys.join(", ")}); per-category market counts still need one query per category and are not made here` : "markets are never loaded; the number of markets per category and status is NOT AVAILABLE without paging through them (no total is returned)" }, esports, allows, doesNotAllow };
}

/** ≤ `max` printable lines of an inventory. */
export function inventoryLines(inv: KalshiInventory, max = 24): string[] {
  const L: string[] = [`Kalshi category inventory (${inv.base}; ${inv.requests}/${inv.budget} requests; ${inv.complete ? "complete" : `CUT: ${inv.stoppedBecause}`})`];
  L.push(`events (no markets loaded): open ${inv.events.total.open} · unopened ${inv.events.total.unopened} · closed ${inv.events.total.closed} · settled ${inv.events.total.settled} · total ${inv.events.total.total}${inv.complete ? "" : " (lower bounds)"}`);
  const cats = Object.entries(inv.events.byCategory).sort((a, b) => b[1].total - a[1].total).slice(0, 10);
  for (const [k, c] of cats) L.push(`  ${k.padEnd(24)} events ${String(c.total).padStart(7)}  (open ${c.open}, closed ${c.closed}, settled ${c.settled})  series ${inv.series.byCategory[k] ?? "n/m"}`);
  L.push(`series: ${inv.series.read ? `${inv.series.total} in ${Object.keys(inv.series.byCategory).length} categories` : `not read (${inv.series.note})`}; markets per category: ${inv.markets.note}`);
  L.push(`esports: category name ${inv.esports.categoryExists === null ? "UNKNOWN (no endpoint answered)" : inv.esports.categoryExists ? "EXISTS" : "none found"}; series matched ${inv.esports.seriesMatched}, events matched ${inv.esports.eventsMatched}${inv.esports.matchedCategories.length ? ` in ${inv.esports.matchedCategories.join(", ")}` : ""}`);
  for (const x of inv.esports.examples.slice(0, 3)) L.push(`    e.g. ${x}`);
  for (const x of inv.doesNotAllow.slice(0, 3)) L.push(`  does not allow: ${x}`);
  return L.map((l) => (l.length > 200 ? l.slice(0, 197) + "..." : l)).slice(0, max);
}

/** The inventory as a Markdown section for S1a_RESULTS.md. */
export function inventoryMarkdown(inv: KalshiInventory): string {
  const L = ["## Kalshi category inventory (no market loaded)", "", `Base ${inv.base}; ${inv.requests} of ${inv.budget} requests; ${inv.complete ? "every status paged to its end" : `**CUT**: ${inv.stoppedBecause} (counts are lower bounds)`}. Category source: ${inv.categories.source}.`, "",
    "| category | series | events open | unopened | closed | settled | events total |", "|---|---|---|---|---|---|---|"];
  const keys = [...new Set([...Object.keys(inv.events.byCategory), ...Object.keys(inv.series.byCategory)])].sort((a, b) => (inv.events.byCategory[b]?.total ?? 0) - (inv.events.byCategory[a]?.total ?? 0) || (a < b ? -1 : 1));
  for (const k of keys) { const c = inv.events.byCategory[k]; L.push(`| ${k} | ${inv.series.byCategory[k] ?? "n/m"} | ${c?.open ?? "n/m"} | ${c?.unopened ?? "n/m"} | ${c?.closed ?? "n/m"} | ${c?.settled ?? "n/m"} | ${c?.total ?? "n/m"} |`); }
  L.push("", `Markets per category and status: ${inv.markets.note}.`, "", `Esports: a category with an esports-like NAME ${inv.esports.categoryExists === null ? "could not be judged (no endpoint answered)" : inv.esports.categoryExists ? "EXISTS" : "was not found"}; series matched by title or tag: ${inv.esports.seriesMatched}; events matched by title: ${inv.esports.eventsMatched}${inv.esports.matchedCategories.length ? ` (in ${inv.esports.matchedCategories.join(", ")})` : ""}. Basis: ${inv.esports.basis}.`);
  if (inv.esports.examples.length) L.push("", ...inv.esports.examples.map((x) => `- ${x}`));
  L.push("", "What the endpoints allowed:", ...inv.allows.map((x) => `- ${x}`), "", "What they did not allow:", ...(inv.doesNotAllow.length ? inv.doesNotAllow.map((x) => `- ${x}`) : ["- (nothing recorded)"]), "", "Total-like members of the `limit=1` probes:", ...inv.totals.map((t) => `- ${t.endpoint}: ${t.note}`));
  return L.join("\n") + "\n";
}
