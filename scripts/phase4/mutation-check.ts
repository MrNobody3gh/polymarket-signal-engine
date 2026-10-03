/**
 * `npm run phase4:mutations` — Phase 4.0 mutation check. For each entry below it applies ONE deliberate defect to a
 * source file, runs the tests that are supposed to catch it, expects them to FAIL (some test actually failing, not a
 * crash), and restores the file. A mutation that survives (the tests still pass) is a hole in the tests: exit 1.
 *
 * It edits files in src/lib/phase4 only and always restores them (also on Ctrl-C). It never touches a database or the network. Takes about two minutes.
 *   npm run phase4:mutations            all
 *   npm run phase4:mutations -- T1 M3   only those ids
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

interface Edit { file: string; find: string; replace: string }
interface Mutation { id: string; what: string; edits: Edit[]; tests: string[] }
const L = "src/lib/phase4/";
const T = { ev: "tests/phase4-events.test.ts", dg: "tests/phase4-diagnose.test.ts", ts: "tests/phase4-timestamps.test.ts", ph: "tests/phase4-placeholders.test.ts", map: "tests/phase4-mapping.test.ts", fun: "tests/phase4-funnel.test.ts", st: "tests/phase4-stats.test.ts", sc: "tests/phase4-scripts.test.ts", http: "tests/phase4-http.test.ts", cat: "tests/phase4-categorize.test.ts" };
const m = (id: string, what: string, file: string, find: string, replace: string, tests: string[]): Mutation => ({ id, what, edits: [{ file: L + file, find, replace }], tests });

export const MUTATIONS: Mutation[] = [
  // ── timestamp validation (test 1)
  m("T1", "400-day window: the upper limit becomes exclusive", "timestamps.ts", "if (p.ms > evalMs + MAX_AHEAD_MS)", "if (p.ms >= evalMs + MAX_AHEAD_MS)", [T.ts]),
  m("T2", "window: the evaluation time itself is rejected as past", "timestamps.ts", "if (p.ms < evalMs && !o.allowPast)", "if (p.ms <= evalMs && !o.allowPast)", [T.ts]),
  m("T3", "a date-only value is accepted", "timestamps.ts", 'case "date_only": return { ok: false, reason: "FORMAT_DATE_ONLY" };', 'case "date_only": break;', [T.ts]),
  m("T4", "a resolution-time field is accepted", "timestamps.ts", 'if (FORBIDDEN_ROLES.has(role)) return { ok: false, reason: "FIELD_ROLE_FORBIDDEN" };', "", [T.ts]),
  m("T5", "start-after-close: exactly the tolerance becomes ambiguous", "timestamps.ts", "s.ms - c.ms > tol", "s.ms - c.ms >= tol", [T.ts]),
  m("T6", "venue agreement: exactly the tolerance becomes a mismatch", "timestamps.ts", "Math.abs(sv.ms - chosen.v.ms) > tol", "Math.abs(sv.ms - chosen.v.ms) >= tol", [T.ts]),
  m("T7", "24 h horizon: exactly 24:00:00 becomes beyond", "timestamps.ts", "if (t > MAX_HORIZON_MS)", "if (t >= MAX_HORIZON_MS)", [T.ts]),
  m("T8", "MIN_LEAD: exactly 300 s becomes too close", "timestamps.ts", "if (t < minLeadMs)", "if (t <= minLeadMs)", [T.ts]),
  m("T9", "time_to_event of exactly 0 is no longer 'started'", "timestamps.ts", "if (t <= 0) failures", "if (t < 0) failures", [T.ts]),
  m("T10", "an unusable start silently falls back to the close time", "timestamps.ts", 'if (!cfg.fallbackToCloseWhenStartInvalid) return { ok: false, code: "TIMESTAMP_MISSING", reasons, used };', "", [T.ts]),
  m("T11", "offset applied with the wrong sign", "timestamps.ts", "ms: wall - offsetMinutes * 60_000", "ms: wall + offsetMinutes * 60_000", [T.ts, T.ph]),
  m("T12", "closedTime is no longer recognised as a resolution-like field", "timestamps.ts", "closed(time|at|date|ts|timestamp)?$|closedtime|", "", [T.ts]),
  m("T13", "a start-like field may fill slot 2 and a close-like field slot 1", "timestamps.ts", 'return slot === 1 ? role === "START_LIKE" : role === "CLOSE_LIKE";', "return true;", [T.ts]),
  m("T14", "the venue's time may be used when it is the only one", "timestamps.ts", "const s = absent(input.start) ? null :", "const s = absent(input.start) && !input.signalVenue ? null :", [T.ts]),
  // ── placeholder detection (test 2)
  m("P1", "midnight UTC is not flagged", "timestamps.ts", 'if (c === "00:00:00") return "MIDNIGHT_UTC";', "", [T.ph]),
  m("P2", "end of day is looked for at 23:59:58", "timestamps.ts", 'c === "23:59:59"', 'c === "23:59:58"', [T.ph]),
  m("P3", "noon UTC is not flagged", "timestamps.ts", 'if (c === "12:00:00") return "NOON_UTC";', "", [T.ph]),
  m("P4", "date-only values are not flagged", "timestamps.ts", 'if (p.kind === "date_only") return "DATE_ONLY";', "", [T.ph]),
  m("P5", "a repeated instant counts even when all items belong to one event", "timestamps.ts", "e.groups.size >= minGroups", "true", [T.ph]),
  m("P6", "recommendation ignores the placeholder share", "audit.ts", "> R.maxPlaceholderShare)", "> 2)", [T.ph, T.sc]),
  m("P7", "recommendation ignores the usable share", "audit.ts", "share(usable, sm.length) < R.minUsableShare", "share(usable, sm.length) < 0", [T.ph]),
  m("P8", "a start-like field that equals the creation time is accepted", "audit.ts", "if (coincide > R.maxCreationCoincidenceShare)", "if (false)", [T.ph]),
  m("P9", "the event-type gap rule is dropped", "audit.ts", "if (med > R.eventTypeMaxMedianGapHours)", "if (false)", [T.ph]),
  m("P10", "a placeholder close is used to judge the start", "audit.ts", "&& !placeholderKind(m.flat[c2.path]) ? [{ a, b }]", "? [{ a, b }]", [T.ph, T.sc]),
  m("P11", "venue agreement: exactly 15 minutes is no longer 'within 15 minutes'", "audit.ts", "abs.filter((x) => x <= 15)", "abs.filter((x) => x < 15)", [T.sc]),
  m("P12", "relation: before and after swapped", "audit.ts", "before: d.filter((x) => x > 0).length", "before: d.filter((x) => x < 0).length", [T.ph]),
  m("P14", "a single repeated time of day is not noticed", "audit.ts", "if (topClock > R.maxTopClockShare && vals.length >= R.minPresent)", "if (false)", [T.ph]),
  m("P15", "a start after the resolution time is not noticed", "audit.ts", "if (okShare < R.minOrderedShare)", "if (false)", [T.ph]),
  m("P16", "a start after a real close time is not noticed", "audit.ts", "if (okc < R.minStartBeforeCloseShare)", "if (false)", [T.ph]),
  m("P17", "too few markets with the field still yields a verdict", "audit.ts", "if (vals.length < R.minPresent) return", "if (false) return", [T.ph]),
  m("P18", "a start field with no reference times is recommended anyway", "audit.ts", "if (!failed.length && gap) return", "if (false) return", [T.ph]),
  m("P13", "stratified sample takes one market too many from each stratum", "audit.ts", "round < perStratum && out.length < total", "round <= perStratum && out.length < total", [T.ph]),
  m("P19", "stratified sample can exceed the requested total", "audit.ts", "for (const g of groups.values()) { if (out.length >= total) break;", "for (const g of groups.values()) {", [T.ph]),
  // ── mapping (test 3)
  m("M1", "a mapping is reported as verified", "mapping.ts", "= { verified: false, resolutionRulesVerified: false };", "= { verified: true, resolutionRulesVerified: false } as never;", [T.map]),
  m("M2", "numbers in the titles are not compared (Over 2.5 = Over 3.5)", "mapping.ts", 'if (!t.numbersAgree) return', "if (false) return", [T.map]),
  m("M3", "negations are not compared", "mapping.ts", 'if (!t.negationsAgree) return', "if (false) return", [T.map]),
  m("M4", "events one day apart no longer match", "mapping.ts", "Math.abs(d1 - d2) > PROBABLE_MAX_DATE_DIFF_DAYS", "Math.abs(d1 - d2) >= PROBABLE_MAX_DATE_DIFF_DAYS", [T.map]),
  m("M5", "an unknown event date is accepted", "mapping.ts", 'if (d1 === null || d2 === null) return { cand, level: "NONE"', 'if (false) return { cand, level: "NONE"', [T.map]),
  m("M6", "a tie between two candidates is broken arbitrarily", "mapping.ts", "if (distinct.size > 1) return none(", "if (false) return none(", [T.map]),
  m("M7", "a token-id match no longer outranks a title match", "mapping.ts", 'if (idTok) return { cand, level: "EXACT", evidence: ev, venueOutcome: outcome, rank: 3 };', 'if (idTok) return { cand, level: "EXACT", evidence: ev, venueOutcome: outcome, rank: 0 };', [T.map]),
  m("M8", "candidates are no longer ordered (non-deterministic evidence)", "mapping.ts", ".sort((a, b) => (a.marketId < b.marketId ? -1 : a.marketId > b.marketId ? 1 : 0))", ".sort(() => 0)", [T.map]),
  m("M9", "condition ids are compared case-sensitively", "mapping.ts", 'const ev: string[] = []; const cid = (sig.conditionId ?? "").toLowerCase();', 'const ev: string[] = []; const cid = (sig.conditionId ?? "");', [T.map]),
  m("M10", "an identifier match with an unmatched outcome is called EXACT", "mapping.ts", "    if (outcome) { ev.push(", "    if (true) { ev.push(", [T.map]),
  m("M11", "the candidate index misses candidates the brute-force search finds", "mapping.ts", "const need = Math.max(1, Math.ceil(toks.length / 2));", "const need = toks.length + 1;", [T.map]),
  // ── funnel (test 4)
  m("F1", "score 68 is rejected (> instead of ≥)", "funnel.ts", "!(r.copyScore >= c.scoreMin)", "!(r.copyScore > c.scoreMin)", [T.fun]),
  m("F2", "exactly 24 h is beyond the horizon", "funnel.ts", "if (!(t <= c.horizonMs)) return 5;", "if (!(t < c.horizonMs)) return 5;", [T.fun]),
  m("F3", "exactly MIN_LEAD is too close", "funnel.ts", "if (!(t >= c.minLeadMs)) return 6;", "if (!(t > c.minLeadMs)) return 6;", [T.fun]),
  m("F4", "time_to_event 0 counts as not started", "funnel.ts", "if (!(t > 0)) return 4;", "if (!(t >= 0)) return 4;", [T.fun]),
  m("F5", "an unknown tradability counts as tradable", "funnel.ts", "if (r.tradable !== true) return 2;", "if (r.tradable === false) return 2;", [T.fun]),
  m("F6", "an unknown event time is not a reject", "funnel.ts", "if (r.eventMs === null) return 3;", "", [T.fun]),
  m("F7", "the window end is inclusive", "funnel.ts", "r.createdAtMs >= cfg.startMs && r.createdAtMs < cfg.endMs", "r.createdAtMs >= cfg.startMs && r.createdAtMs <= cfg.endMs", [T.fun]),
  m("F8", "partial edge days are counted as complete days", "funnel.ts", "const firstDay = Math.ceil(startMs / DAY_MS)", "const firstDay = Math.floor(startMs / DAY_MS)", [T.fun]),
  m("F9", "an unmeasured stage is reported as zero", "funnel.ts", "? null : depth.reduce", "? 0 : depth.reduce", [T.fun]),
  m("F10", "a PROBABLE mapping is counted in the EXACT funnel", "funnel.ts", '(variant === "EXACT_PLUS_PROBABLE" && r.mapping === "PROBABLE")', '(r.mapping === "PROBABLE")', [T.fun]),
  m("F11", "the top-3 share counts two wallets", "funnel.ts", "top.slice(0, 3).reduce", "top.slice(0, 2).reduce", [T.fun]),
  m("F12", "the minimum copy score is 67", "funnel.ts", "export const SCORE_MIN = 68;", "export const SCORE_MIN = 67;", [T.fun, T.sc]),
  m("F13", "a detection lag of exactly MAX_SIGNAL_AGE counts as stale", "funnel.ts", "r.evalMs - r.createdAtMs <= maxAge", "r.evalMs - r.createdAtMs < maxAge", [T.fun]),
  m("F14", "an unobserved lag counts as fresh", "funnel.ts", "r.lagObserved === true", "r.lagObserved !== false", [T.fun]),
  // ── 4.0b: event-level S1a, Eastern placeholders, diagnostic, date-level row, --print-files
  m("E1", "markets of one event are counted as separate events", "audit.ts", "if (!seen.has(m.group)) seen.set(m.group, m);", "seen.set(m.id + m.group, m);", [T.ev]),
  m("E2", "the verdict does not name the rule that decided it", "audit.ts", 'decidedBy: pick.failedRules[0] ?? "allPassed"', 'decidedBy: "allPassed"', [T.ev]),
  m("E3", "Eastern midnight is not recognised", "timestamps.ts", 'if (e.time === "00:00:00") return { kind: "ET_MIDNIGHT", date: e.date };', "", [T.ev]),
  m("E4", "Eastern end of day is only recognised at 23:59:00", "timestamps.ts", 'e.time === "23:59:00" || e.time === "23:59:59"', 'e.time === "23:59:00"', [T.ev]),
  m("E5", "Eastern time ignores daylight saving (always UTC−4)", "timestamps.ts", 'timeZone: "America/New_York"', 'timeZone: "Etc/GMT+4"', [T.ev]),
  m("E6", "the implied date of an Eastern end-of-day value is the UTC date", "timestamps.ts", 'return { kind: "ET_END_OF_DAY", date: e.date };', 'return { kind: "ET_END_OF_DAY", date: new Date(p.ms).toISOString().slice(0, 10) };', [T.ev]),
  m("E7", "the date-level alternative is marked recommended", "audit.ts", 'inPlayCheck: "cannot be evaluated at date level", recommended: false };', 'inPlayCheck: "cannot be evaluated at date level", recommended: true as never };', [T.ev]),
  m("E8", "a stratum quota is spent on many markets of the same event", "audit.ts", "if (!seen.has(x.group ?? \"\")) {", "if (true) {", [T.ev]),
  m("E9", "a sport reaches the quota with markets OR events", "events.ts", "sm.length >= 100 && evs >= 30", "sm.length >= 100 || evs >= 30", [T.ev]),
  m("E10", "a qualifier after a colon is read as part of a participant", "mapping.ts", "title.split(/[:(\\[|–—]/)[0]", "title.split(/[(\\[|–—]/)[0]", [T.ev]),
  m("E11", "the crossed (home/away swapped) pairing is ignored", "mapping.ts", "return Math.max(Math.min(j(pa[0], pb[0]), j(pa[1], pb[1])), Math.min(j(pa[0], pb[1]), j(pa[1], pb[0])));", "return Math.min(j(pa[0], pb[0]), j(pa[1], pb[1]));", [T.ev]),
  m("E12", "a tie between two events is broken arbitrarily", "events.ts", "ambiguous++; continue;", "ambiguous++;", [T.ev]),
  m("E13", "the same event is matched across any date", "events.ts", "dayDiff(ea.etDate, c.eb.etDate) <= maxDays", "true", [T.ev]),
  m("D1", "the diagnostic labels an identifier match EXACT", "mapping.ts", 'confidence: probable ? "PROBABLE" : "NONE", verified: false, dateChecked: false', 'confidence: probable ? (winners[0].identifierMatch ? ("EXACT" as never) : "PROBABLE") : "NONE", verified: false, dateChecked: false', [T.dg]),
  m("D2", "the diagnostic reports a match as verified", "mapping.ts", "verified: false, dateChecked: false, identifierMatch:", "verified: true as never, dateChecked: false, identifierMatch:", [T.dg]),
  m("D3", "the diagnostic ignores numbers", "mapping.ts", "c.titleSimilarity >= PROBABLE_MIN_SIMILARITY && c.numbersAgree && c.negationsAgree", "c.titleSimilarity >= PROBABLE_MIN_SIMILARITY && c.negationsAgree", [T.dg]),
  m("D4", "the diagnostic ignores negations", "mapping.ts", "c.titleSimilarity >= PROBABLE_MIN_SIMILARITY && c.numbersAgree && c.negationsAgree", "c.titleSimilarity >= PROBABLE_MIN_SIMILARITY && c.numbersAgree", [T.dg]),
  m("D5", "a similarity of exactly 0.9 falls in the lower band", "mapping.ts", "SIMILARITY_BANDS.find((b) => score >= b.min)!.name", "SIMILARITY_BANDS.find((b) => score > b.min)!.name", [T.dg]),
  m("D6", "the sample ignores its seed", "diagnose.ts", "const rng = seededRng(seed);", 'const rng = seededRng("fixed");', [T.dg]),
  m("D7", "the diagnostic is no longer deterministic about ties", "mapping.ts", "(a.c.marketId < b.c.marketId ? -1 : 1)).slice(0, limit)", "0).slice(0, limit)", [T.dg]),
  m("D8", "the date-level row counts the UTC date, not the Eastern date", "funnel.ts", "const today = easternParts(r.evalMs).date;", "const today = new Date(r.evalMs).toISOString().slice(0, 10);", [T.fun]),
  m("D9", "the date-level row accepts only today, not tomorrow", "funnel.ts", "r.impliedDateEt === today || r.impliedDateEt === nextDay(today)", "r.impliedDateEt === today", [T.fun]),
  m("D10", "the feasibility table takes its flow from the date-level row", "probe.ts", "const fin = funnel.variants.EXACT.perDay.minLead;", "const fin = funnel.dateLevel.variants.EXACT.perDay;", [T.sc]),
  m("D11", "diagnostic mode keeps the 6,000-market cap", "probe.ts", "o.maxUsMarkets ?? (o.diagnose ? Infinity : 6000)", "o.maxUsMarkets ?? 6000", [T.sc]),
  m("D12", "a targeted fetch stops at 100 markets OR 30 events", "venues.ts", "ms.length >= minM && new Set(ms.map(usGroupOf)).size >= minE", "ms.length >= minM || new Set(ms.map(usGroupOf)).size >= minE", [T.sc]),
  m("D13", "the PROBABLE rule no longer needs a date on both sides", "mapping.ts", 'if (d1 === null || d2 === null) return { cand, level: "NONE"', 'if (false) return { cand, level: "NONE"', [T.map, T.sc]),
  m("D14", "--print-files prints by default", "cli.ts", '(opts["print-files"] ?? "")', '(opts["print-files"] ?? "s1b_funnel.json")', [T.sc]),
  m("D15", "--print-files pauses every 400 lines instead of 200", "cli.ts", "export const PRINT_PACE_LINES = 200;", "export const PRINT_PACE_LINES = 400;", [T.sc]),
  m("D16", "--print-files does not split long lines", "cli.ts", "export const PRINT_MAX_LINE = 3000;", "export const PRINT_MAX_LINE = 30000;", [T.sc]),
  // ── sample-size maths (test 5)
  m("S1", "the sample size is rounded down", "stats.ts", "return Math.ceil((2 * z * z", "return Math.floor((2 * z * z", [T.st]),
  m("S2", "power uses the wrong quantile", "stats.ts", "normInv(1 - alpha / 2) + normInv(power)", "normInv(1 - alpha / 2) + normInv(1 - power)", [T.st]),
  m("S3", "negative intra-class correlation is not clamped", "stats.ts", "Math.max(0, (msb - msw) / denom)", "(msb - msw) / denom", [T.st]),
  m("S4", "design effect formula uses m instead of m − 1", "stats.ts", "deff: 1 + (m - 1) * icc", "deff: 1 + m * icc", [T.st]),
  m("S5", "the scarcer arm no longer decides the duration", "stats.ts", "Math.min(i.acceptRate, 1 - i.acceptRate)", "i.acceptRate", [T.st]),
  m("S6", "quantiles are not interpolated", "stats.ts", "s[lo] + (s[hi] - s[lo]) * (i - lo)", "s[lo]", [T.st]),
  m("S7", "standard deviation divides by n", "stats.ts", "return Math.sqrt(s / (xs.length - 1));", "return Math.sqrt(s / xs.length);", [T.st]),
  m("S8", "the days model ignores the settlement lag", "stats.ts", "return i.settlementLagDays + i.perArm", "return i.perArm", [T.st]),
  m("S9", "'what must change' uses the median lag instead of the 90th percentile", "feasibility.ts", "const lag90 = stats.holdP90Days ?? 0;", "const lag90 = stats.holdP50Days ?? 0;", [T.st]),
  // ── read-only (test 6)
  m("R1", "the read-only wrapper also exposes a write", "readonly-db.ts", 'return { select: (table, columns = "*", options) => db.from(table).select(columns, options) };', 'return { select: (table, columns = "*", options) => db.from(table).select(columns, options), upsert: (t: string, r: unknown) => (db as any).from(t).upsert(r) } as never;', [T.sc]),
  m("R2", "every select also performs a write", "readonly-db.ts", 'select: (table, columns = "*", options) => db.from(table).select(columns, options) };', 'select: (table, columns = "*", options) => { (db as any).from(table).upsert({ x: 1 }); return db.from(table).select(columns, options); } };', [T.sc]),
  m("R3", "the wrapper exposes rpc", "readonly-db.ts", 'return { select: (table, columns = "*", options) => db.from(table).select(columns, options) };', 'return { select: (table, columns = "*", options) => db.from(table).select(columns, options), rpc: (n: string) => (db as any).rpc(n) } as never;', [T.sc]),
  // ── scripts: output, files, windows (test 7)
  { id: "C1", what: "the S1a summary is not capped at 60 lines (both the row limit and the final cap removed: either alone is covered by the other)", edits: [{ file: L + "s1a.ts", find: "const show = rows.slice(0, 10);", replace: "const show = rows.slice(0, 500);" }, { file: L + "s1a.ts", find: ".map((l) => (l.length > 220 ? l.slice(0, 217) + \"...\" : l)).slice(0, 60);\n}", replace: ".map((l) => (l.length > 220 ? l.slice(0, 217) + \"...\" : l));\n}" }], tests: [T.sc] },
  m("C2", "long lines are not truncated", "s1a.ts", "l.length > 220 ? l.slice(0, 217) + \"...\" : l)).slice(0, 60);", "l)).slice(0, 60);", [T.sc]),
  m("C3", "the probe's lower window bound is dropped", "probe.ts", '.gte("created_at", startIso)', '.gte("created_at", "2000-01-01T00:00:00Z")', [T.sc]),
  m("C4", "EXIT signals are counted as entries", "probe.ts", '.in("kind", ENTRY_KINDS)', '.in("kind", [...ENTRY_KINDS, "EXIT"])', [T.sc]),
  m("C5", "tradability: a market resolved exactly at the evaluation time is not tradable", "probe.ts", "return Math.min(...times) >= evalMs;", "return Math.min(...times) > evalMs;", [T.cat]),
  m("C6", "the review CSV drops its reviewer columns", "mapping.ts", 'm.evidence.join(" | "), "", ""];', 'm.evidence.join(" | ")];', [T.map]),
  // ── scripts: network (test 8)
  m("N1", "requests are allowed faster than 2 per second", "http.ts", "Math.max(500, o.minIntervalMs ?? 500)", "o.minIntervalMs ?? 500", [T.http]),
  m("N2", "retries are not bounded at 3", "http.ts", "Math.min(3, o.maxAttempts ?? 3)", "(o.maxAttempts ?? 3)", [T.http]),
  m("N3", "a 403 is retried like a transient error", "http.ts", "if (res.status === 401 || res.status === 403 || res.status === 451) {", "if (res.status === 401 || res.status === 451) {", [T.http, T.sc]),
  m("N4", "the client keeps asking an origin that refused it", "http.ts", "if (n >= this.blockedStop) this.stopped.add(origin);", "", [T.http, T.sc]),
  m("N5", "an Authorization header is sent", "http.ts", 'headers: { Accept: "application/json", "User-Agent": this.ua }', 'headers: { Accept: "application/json", "User-Agent": this.ua, Authorization: "Bearer x" }', [T.http, T.sc]),
  m("N6", "Retry-After is not capped", "http.ts", "Math.min(ra * 1000, this.maxRetryAfterMs)", "ra * 1000", [T.http]),
  m("N7", "malformed JSON is mislabelled as a server error (and would be retried)", "http.ts", 'kind: "MALFORMED", status: res.status', 'kind: "SERVER_ERROR", status: 500', [T.http]),
  m("N8", "the User-Agent is not sent", "http.ts", '"User-Agent": this.ua }', '"X-Agent": this.ua }', [T.http, T.sc]),
];

function run(files: string[]): { failedTests: boolean; out: string } {
  const r = spawnSync("npx", ["vitest", "run", ...files], { encoding: "utf8", timeout: 300_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { failedTests: r.status !== 0 && /Tests\s+(\d+ failed|.*\d+ failed)/.test(out), out };
}

async function main() {
  const only = new Set(process.argv.slice(2)); const list = MUTATIONS.filter((x) => !only.size || only.has(x.id));
  const originals = new Map<string, string>(); const touched = [...new Set(list.flatMap((x) => x.edits.map((e) => e.file)))];
  for (const f of touched) originals.set(f, readFileSync(f, "utf8"));
  const restore = () => { for (const [f, c] of originals) writeFileSync(f, c); };
  process.on("SIGINT", () => { restore(); process.exit(130); }); process.on("exit", restore);
  const dirty = spawnSync("git", ["status", "--porcelain", "--", ...touched], { encoding: "utf8" }).stdout?.trim();
  if (dirty) console.log(`note: some of the ${touched.length} source files have uncommitted changes (they are restored byte for byte afterwards)`);
  const base = run([...new Set(list.flatMap((x) => x.tests))]); if (base.out.match(/Tests\s+.*failed/)) { console.log("baseline tests fail; fix them before mutation checking"); process.exit(2); }
  let survived = 0, stale = 0; const lines: string[] = [];
  for (const mu of list) {
    let ok = true;
    try {
      for (const e of mu.edits) { const cur = readFileSync(e.file, "utf8"); const n = cur.split(e.find).length - 1; if (n !== 1) { ok = false; lines.push(`${mu.id.padEnd(4)} STALE   ${mu.what} (find string matched ${n} times in ${e.file})`); stale++; break; } writeFileSync(e.file, cur.replace(e.find, () => e.replace)); }
      if (!ok) continue;
      const r = run(mu.tests); if (r.failedTests) lines.push(`${mu.id.padEnd(4)} killed  ${mu.what}`); else { survived++; lines.push(`${mu.id.padEnd(4)} SURVIVED ${mu.what}  ← tests ${mu.tests.join(", ")} still pass`); }
    } finally { restore(); }
  }
  for (const l of lines) console.log(l);
  console.log(`\n${list.length} mutations: ${list.length - survived - stale} killed, ${survived} survived, ${stale} stale`);
  process.exitCode = survived || stale ? 1 : 0;
}
if (process.argv[1]?.endsWith("mutation-check.ts")) main();
