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
import { MUTATIONS_4_0D } from "./mutations-4-0d";

interface Edit { file: string; find: string; replace: string }
interface Mutation { id: string; what: string; edits: Edit[]; tests: string[] }
const L = "src/lib/phase4/";
const T = { ev: "tests/phase4-events.test.ts", dg: "tests/phase4-diagnose.test.ts", ts: "tests/phase4-timestamps.test.ts", ph: "tests/phase4-placeholders.test.ts", map: "tests/phase4-mapping.test.ts", fun: "tests/phase4-funnel.test.ts", st: "tests/phase4-stats.test.ts", sc: "tests/phase4-scripts.test.ts", http: "tests/phase4-http.test.ts", cat: "tests/phase4-categorize.test.ts", mem: "tests/phase4-memory.test.ts", kal: "tests/phase4-kalshi.test.ts", vf: "tests/phase4-venue-funnel.test.ts", tsr: "tests/phase4-title-search.test.ts", us: "tests/phase4-us-sports.test.ts", cp: "tests/phase4-compact.test.ts", vr: "tests/phase4-venue-run.test.ts", ki: "tests/phase4-kalshi-inventory.test.ts", sr: "tests/phase4-stop-rule.test.ts", rv: "tests/phase4-review.test.ts", rc: "tests/phase4-review-cli.test.ts", mm: "tests/phase4-matrix-merge.test.ts", ws: "tests/phase4-wallet-share.test.ts", wk: "tests/phase4-weak-spots.test.ts" };
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
  m("D11", "diagnostic mode keeps the 6,000-market cap", "venues.ts", "o.maxUsMarkets ?? (o.diagnose ? DIAGNOSE_DEFAULT_CAP : NORMAL_CAP)", "o.maxUsMarkets ?? NORMAL_CAP", [T.sc]),
  m("D17", "diagnostic mode retains the raw, un-slimmed market objects (the out-of-memory defect)", "venues.ts", "slim: !!o.diagnose }", "slim: false }", [T.mem]),
  m("D20", "the audit flattens every listing market before sampling (the Kalshi out-of-memory defect)", "s1a.ts", "mk(sampleRaws(open, light, per(o.sampleOpen), o.sampleOpen), false)", "mk(open, false)", [T.mem]),
  m("D21", "sampleRaws flattens what it does not pick", "audit.ts", "return stratifiedSample(light, perStratum, total).map((x) => raws[x.i]);", "toAuditMarkets(\"v\", raws, { idOf: o.idOf, isResolved: () => false, titleOf: o.titleOf, slugOf: o.slugOf }); return stratifiedSample(light, perStratum, total).map((x) => raws[x.i]);", [T.mem]),
  m("D22", "the US audit fetches keep each market whole (the one-venue-per-process out-of-memory defect)", "s1a.ts", "const o = await fetchUs(opt.http, opt.us, { closed: false, max: so * ff, slim: true });", "const o = await fetchUs(opt.http, opt.us, { closed: false, max: so * ff });", [T.mem]),
  m("D23", "the international audit fetches keep each market whole", "s1a.ts", "const o = await fetchGamma(opt.http, { closed: false, max: so * ff, slim: true });", "const o = await fetchGamma(opt.http, { closed: false, max: so * ff });", [T.mem]),
  m("D25", "the US targeted-query fetch keeps each market whole", "venues.ts", "query: q.query, enough, slim: true });", "query: q.query, enough });", [T.mem]),
  m("D24", "fetchGamma ignores the slim option", "venues.ts", "out.push(o.slim ? (slimRaw(m) as RawMarket) : m); fresh++; if (out.length >= o.max) break; }\n    if (page === 0 && records.length) notes.filterHonoured", "out.push(m); fresh++; if (out.length >= o.max) break; }\n    if (page === 0 && records.length) notes.filterHonoured", [T.mem]),
  m("D26", "the sports-API stage keeps every market of every page (the 4.0d out-of-memory defect)", "us-sports.ts", "markets: kept, notes: r.notes, reachedQuota: enough(kept)", "markets: r.markets, notes: r.notes, reachedQuota: enough(r.markets)", [T.us]),
  m("D27", "the per-event bound is not applied (one event can use the whole budget)", "us-sports.ts", "if (n >= perEvent) continue; seen.set", "seen.set", [T.us]),
  m("D19", "a finite cap stops at 40 pages again (4,000 markets), however large the cap", "venues.ts", "Math.max(40, Math.ceil(o.max / cfg.pageSize) + 2)", "40", [T.sc]),
  m("D18", "slimming keeps long free text and nested market lists", "venues.ts", 'if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) : v;', "if (typeof v === \"string\") return v;", [T.mem]),
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
  // ── 4.0c: Kalshi adapter, per-candidate verdicts, title search, sports API, in-play, compact file
  m("K1", "Kalshi's expected / latest expiration times are no longer resolution-like (a forecast of the settlement could fill a slot)", "timestamps.ts", "|expectedexpiration|latestexpiration|determinationtime/", "|determinationtime/", [T.kal]),
  m("K2", "open_time is no longer a listing-like time (it could fill slot 1)", "timestamps.ts", "creat|listed|published|deployed|inserted|^open(time|date|ts|at|timestamp)$/", "creat|listed|published|deployed|inserted/", [T.kal]),
  m("K3", "Kalshi's deprecated expiration_time is read as a close time", "timestamps.ts", "if (venue === KALSHI) { const o = KALSHI_ROLE_OVERRIDES[leaf(name)]; if (o) return o; }", "", [T.kal]),
  m("K4", "the inventory ignores the venue of the markets (Kalshi's overrides never apply)", "audit.ts", "role: classifyFieldNameFor(markets[0]?.venue, path),", "role: classifyFieldName(path),", [T.kal]),
  m("K5", "a finite Kalshi cap does not stop mid-page", "venue-kalshi.ts", "out.push(slimRaw(m) as RawMarket); fresh++; if (out.length >= o.max) break; }", "out.push(slimRaw(m) as RawMarket); fresh++; }", [T.kal]),
  m("K6", "a cap reached on the last page is reported as 'listing ended' (a cut-off listing looks complete)", "venue-kalshi.ts", "if (out.length >= o.max && (consumed < records.length || next))", "if (false)", [T.kal, T.vf]),
  m("K7", "Kalshi markets are kept un-slimmed (memory follows the responses, not the cap)", "venue-kalshi.ts", "out.push(slimRaw(m) as RawMarket);", "out.push(m);", [T.kal]),
  m("K8", "a venue that ignores the cursor is paged until the page limit", "venue-kalshi.ts", "if (!fresh && next === cursor)", "if (false)", [T.kal]),
  m("K9", "a refusal does not stop the search for a working base URL", "venue-kalshi.ts", 'if (r.kind === "BLOCKED" || r.kind === "BLOCKED_SKIPPED") return { base: null, tried };', "", [T.kal]),
  m("K10", "a closed Kalshi market counts as open", "venue-kalshi.ts", 'if (s === "closed") return "closed";', 'if (s === "closed") return "open";', [T.kal]),
  m("K11", "an unopened Kalshi market counts as resolved", "venue-kalshi.ts", 'return b === "closed" || b === "settled"; };', 'return b !== "open"; };', [T.kal]),
  m("K12", "a market's own side label (the team in yes_sub_title) is not an outcome", "venue-kalshi.ts", '["Yes", "No", str(m.yes_sub_title), str(m.no_sub_title)]', '["Yes", "No"]', [T.kal, T.tsr]),
  m("K13", "the listing plan gives more than the cap", "venue-kalshi.ts", "settled: Math.max(1, c - open - closed) }", "settled: c }", [T.kal]),
  m("K14", "a Kalshi market exactly at its close time is still tradable", "venue-funnel.ts", "if (c !== null) return evalMs < c;", "if (c !== null) return evalMs <= c;", [T.vf]),
  m("K15", "tradability ignores the market's opening time", "venue-funnel.ts", "if (o !== null && evalMs < o) return false;", "", [T.vf]),
  m("K16", "the date level reads resolution-like fields as close dates", "venue-funnel.ts", 'classifyFieldNameFor(KALSHI, k) === "CLOSE_LIKE"', 'classifyFieldNameFor(KALSHI, k) !== "NOT_TIME"', [T.vf]),
  m("K17", "the Kalshi funnel uses its own window end, not the US run's", "venue-funnel.ts", "const endMs = o.endIso ? Date.parse(o.endIso) : now();", "const endMs = now();", [T.vf]),
  m("K18", "the three-way table divides our flow by 1 instead of its total", "venue-funnel.ts", "const n68 = tot(ours68), kT = tot(kalshi)", "const n68 = 1, kT = tot(kalshi)", [T.vf]),
  m("K19", "the combined command does not give Kalshi the US run's window", "cli.ts", "endIso: res.window.endIso,", "endIso: undefined,", [T.vf]),
  m("K20", "the Kalshi listing's tags come from the market, not the event (no category)", "venue-kalshi.ts", "[str(e?.category), str(m.category), str(e?.series_category)]", "[str(m.category)]", [T.kal]),
  m("K21", "a Kalshi esports title filed under 'Sports' stays a sport", "categorize.ts", "if (sp && has(ESPORTS, hay)) return", "if (false) return", [T.kal]),
  m("K22", "the slug does not split the Kalshi series into sport and rest", "venue-kalshi.ts", "return p ? `${p}-${bare.slice(p.length)}`.replace(/-$/, \"\") : bare;", "return bare;", [T.kal]),
  m("G1", "slot 1 does not judge neutrally named time fields (Kalshi's strike date is never a candidate)", "audit.ts", '(slot === 1 && f.role === "OTHER_TIME")', "false", [T.cp]),
  m("G2", "the best passing candidate is not listed first", "audit.ts", "Number(b.best) - Number(a.best) || (RANK[a.verdict] - RANK[b.verdict])", "(RANK[a.verdict] - RANK[b.verdict])", [T.us, T.wk]),
  m("G3", "bestField is the older single-field pick (a rejected field answers 'which field fills the slot')", "audit.ts", "bestField: ok[0]?.f.path ?? null", "bestField: pick.f.path", [T.us]),
  m("G4", "a candidate without ordering evidence is called unreliable instead of insufficient", "audit.ts", '(passed ? "RECOMMEND" : c.insufficient ? "INSUFFICIENT_DATA" : "UNRELIABLE_REJECT") as Verdict', '(passed ? "RECOMMEND" : "UNRELIABLE_REJECT") as Verdict', [T.us]),
  m("G5", "futures markets are not recognised", "events.ts", "/FUTURE/.test(type)", "/NEVER/.test(type)", [T.us]),
  m("G6", "futures are declared untrusted without checking the single-game class", "events.ts", "out.push(sgOk && fuBad ?", "out.push(fuBad ?", [T.us]),
  m("G7", "the futures verdict is given with fewer than 30 events", "events.ts", "sg.withField < R.minEventsPerClass || fu.withField < R.minEventsPerClass", "false", [T.us]),
  m("Q1", "the search query keeps filler words", "title-search.ts", 'words = normalizeTitle(p.title).split(" ").filter((w) => w && !FILLER.has(w));', 'words = normalizeTitle(p.title).split(" ").filter((w) => w);', [T.tsr]),
  m("Q2", "the search query is not capped at 80 characters", "title-search.ts", "if ((q ? q.length + 1 : 0) + w.length > MAX_QUERY_CHARS) break;", "", [T.tsr]),
  m("Q3", "the outcome is added even when it is Yes / No", "title-search.ts", "if (oc && !GENERIC_OUTCOMES.has(oc))", "if (oc)", [T.tsr]),
  m("Q4", "a head-to-head title is searched with its market-type words", "title-search.ts", "if (parts) words = [...parts[0].slice(0, 3), ...parts[1].slice(0, 3)];", "if (false) words = [];", [T.tsr]),
  m("Q5", "the request budget allows one request too many", "title-search.ts", "if (provider.requests() - start >= budget)", "if (provider.requests() - start > budget)", [T.tsr]),
  m("Q6", "score ≥ 68 pairs are not searched first", "title-search.ts", "Number((b.score ?? -1) >= SCORE_MIN) - Number((a.score ?? -1) >= SCORE_MIN) ||", "", [T.tsr]),
  m("Q7", "a refusal does not stop the search", "title-search.ts", "if (out.blocked) {", "if (false) {", [T.tsr]),
  m("Q8", "near-misses include PROBABLE matches", "title-search.ts", 'r.diag!.confidence !== "PROBABLE" && r.diag!.best!.score >= 0.5).sort(cmp)', "r.diag!.best!.score >= 0.5).sort(cmp)", [T.tsr]),
  m("Q9", "near-misses reach down to similarity 0.3", "title-search.ts", 'r.diag!.confidence !== "PROBABLE" && r.diag!.best!.score >= 0.5).sort(cmp)', 'r.diag!.confidence !== "PROBABLE" && r.diag!.best!.score >= 0.3).sort(cmp)', [T.tsr, T.wk]),
  m("Q10", "the CSV carries only the first candidate", "title-search.ts", "for (let i = 0; i < 3; i++) { const c = top[i];", "for (let i = 0; i < 1; i++) { const c = top[i];", [T.tsr]),
  m("Q11", "the listing lookup returns candidates that share only filler words", "title-search.ts", "|| [...content(c.question)].some((w) => mine.has(w)))", "|| true)", [T.tsr]),
  m("Q12", "our pairs include EXIT signals", "title-search.ts", '.in("kind", ENTRY_KINDS)', '.in("kind", [...ENTRY_KINDS, "EXIT"])', [T.tsr]),
  m("Q13", "the US search is sent with the wrong parameter name", "title-search.ts", "new URLSearchParams({ query, limit: String(o.limit ?? 10) })", "new URLSearchParams({ q: query, limit: String(o.limit ?? 10) })", [T.tsr]),
  m("Q14", "the title-search summary is not capped at 60 lines", "title-search.ts", 'l)).slice(0, 60);\n}\n\n// ───────────────────────────────────────────── our pairs', 'l));\n}\n\n// ───────────────────────────────────────────── our pairs', [T.tsr]),
  m("Q15", "the default request budget is 20,000", "title-search.ts", "export const DEFAULT_SEARCH_BUDGET = 2000;", "export const DEFAULT_SEARCH_BUDGET = 20000;", [T.tsr]),
  m("Q16", "--all-scores is on by default", "cli.ts", 'if (!flags.has("all-scores")) pairs = pairs.filter(', 'if (false) pairs = pairs.filter(', [T.cp]),
  m("U1", "the default US query uses a sport name for `categories` (the 4.0b guess)", "venues.ts", "{ sport: \"sports\", query: `categories=sports&", "{ sport: \"sports\", query: `categories=football&", [T.us]),
  m("U2", "the default US queries never ask for the ended side", "venues.ts", "&closed=true` },", "&active=true` },", [T.us]),
  m("U3", "the market types lose PROP", "venues.ts", 'US_SPORTS_MARKET_TYPES = ["MONEYLINE", "SPREAD", "TOTAL", "PROP"]', 'US_SPORTS_MARKET_TYPES = ["MONEYLINE", "SPREAD", "TOTAL"]', [T.us]),
  m("U4", "the sports API fetch never asks for ended events", "us-sports.ts", 'const query = side === "open" ? "active=true" : "closed=true";', 'const query = "active=true";', [T.us]),
  m("U5", "the league fallback is dropped", "us-sports.ts", "if (!res.markets.length) for (const lg of", "if (false) for (const lg of", [T.us]),
  m("U6", "a sport reaches the quota with markets OR events", "us-sports.ts", "const enough = (ms: RawMarket[]) => ms.length >= minM && new Set(ms.map(usGroupOf)).size >= minE;", "const enough = (ms: RawMarket[]) => ms.length >= minM || new Set(ms.map(usGroupOf)).size >= minE;", [T.us]),
  m("U7", "every discovered sport is fetched whatever --max-sports says", "us-sports.ts", "d.sports.slice(0, o.maxSports ?? 12)", "d.sports", [T.us]),
  m("U8", "the sports request budget is ignored", "us-sports.ts", "const pages = Math.min(o.maxPages ?? 6, left);", "const pages = o.maxPages ?? 6;", [T.us]),
  m("U9", "live a few minutes before the start counts as early at exactly the tolerance", "us-sports.ts", "r.startMs !== null && minToStart(r) > tol)", "r.startMs !== null && minToStart(r) >= tol)", [T.us]),
  m("U10", "started exactly 5 minutes ago counts as 'started and not live'", "us-sports.ts", "age > tol && age <= win", "age >= tol && age <= win", [T.us]),
  m("U11", "started exactly 180 minutes ago no longer counts", "us-sports.ts", "age > tol && age <= win", "age > tol && age < win", [T.us]),
  m("U12", "an `ended` event counts as agreeing with the markets when only one of them is resolved", "us-sports.ts", "allMarketsResolved: ended.filter((r) => r.allMarketsResolved === true).length", "allMarketsResolved: ended.filter((r) => r.anyMarketResolved === true).length", [T.us, T.wk]),
  m("U13", "the in-play report is marked adopted", "us-sports.ts", "adopted: false, nowIso", "adopted: true as never, nowIso", [T.us]),
  m("U14", "an event exactly at a bucket's lower edge falls in the next bucket", "us-sports.ts", "return t >= b.lo && t < b.hi;", "return t > b.lo && t < b.hi;", [T.us]),
  m("U15", "a placeholder source value is not counted as one", "us-sports.ts", "sourcePlaceholders: rs.filter((r) => placeholderKind(r.source) !== null).length", "sourcePlaceholders: rs.filter((r) => placeholderKind(r.source) === null).length", [T.us]),
  m("U16", "'equal within a minute' means within 15", "us-sports.ts", "agreeWithin1Min: d.filter((x) => x <= 1).length", "agreeWithin1Min: d.filter((x) => x <= 15).length", [T.us]),
  m("U17", "the slower per-origin gap is ignored", "http.ts", "Math.max(this.gap, this.originGaps.get(origin) ?? 0)", "this.gap", [T.tsr, T.us]),
  m("U18", "a per-origin gap may undercut the 500 ms floor", "http.ts", "this.originGaps.set(k, Math.max(500, v))", "this.originGaps.set(k, v)", [T.tsr]),
  m("U19", "the CLI does not pace the US origin more slowly", "cli.ts", "originGapMs: origin ? { [origin]: Math.max(US_MIN_INTERVAL_MS, o.usPaceMs ?? 0) } : undefined", "originGapMs: undefined", [T.us]),
  m("U20", "--us-targeted default does not use the sports API", "cli.ts", 'usSports: targetedSpec === "default",', "usSports: false,", [T.us]),
  m("U21", "the US fallback queries are skipped when the sports API returns nothing", "s1a.ts", "if (!sp.results.some((x) => x.markets.length)) {", "if (false) {", [T.us]),
  m("U22", "targeted ENDED markets never reach the resolved side of the audit", "s1a.ts", "extraResolved: tMarkets.filter((m) => usIsResolved(m)),", "extraResolved: [],", [T.us, T.wk]),
  m("X1", "S1_COMPACT.md is not capped at 80 lines (the row budget and the final cut both removed)", "compact.ts", "const budget = COMPACT_MAX_LINES - head.length - tableHead.length - funnelLines.length - 2;", "const budget = 100000;", [T.cp]),
  m("X2", "thin strata are shown before informative ones", "compact.ts", "rows.sort((a, b) => Number(b.informative) - Number(a.informative) ||", "rows.sort((a, b) => ", [T.cp, T.wk]),
  m("X3", "an unreachable venue is silent in the compact file", "compact.ts", "if (!v.reachable) { const st =", "if (!v.reachable) { continue; const st =", [T.cp]),
  m("X4", "the funnel table shows only EXACT counts", "compact.ts", '`${fn.variants.EXACT.counts[i] ?? "n/m"} / ${fn.variants.EXACT_PLUS_PROBABLE.counts[i] ?? "n/m"}`', '`${fn.variants.EXACT.counts[i] ?? "n/m"} / ${fn.variants.EXACT.counts[i] ?? "n/m"}`', [T.cp]),
  m("X5", "an unmeasured stage is shown as 0 in the compact file", "compact.ts", '`${fn.variants.EXACT.counts[i] ?? "n/m"} / ', '`${fn.variants.EXACT.counts[i] ?? 0} / ', [T.cp]),
  m("X6", "the S1a script does not write the compact file", "s1a.ts", "writeCompact((rel) => opt.readFile?.(rel) ?? null, opt.write, { s1a: summary });", "", [T.cp, T.sc]),
  m("X7", "the coverage script does not write the compact file", "cli.ts", "writeCompact(rf, (rel, c) => write(`${outDir}/${rel}`, c));", "", [T.sc, T.vf]),
  // ── read-only (test 6)
  m("R1", "the read-only wrapper also exposes a write", "readonly-db.ts", 'return { select: (table, columns = "*", options) => db.from(table).select(columns, options) };', 'return { select: (table, columns = "*", options) => db.from(table).select(columns, options), upsert: (t: string, r: unknown) => (db as any).from(t).upsert(r) } as never;', [T.sc]),
  m("R2", "every select also performs a write", "readonly-db.ts", 'select: (table, columns = "*", options) => db.from(table).select(columns, options) };', 'select: (table, columns = "*", options) => { (db as any).from(table).upsert({ x: 1 }); return db.from(table).select(columns, options); } };', [T.sc]),
  m("R3", "the wrapper exposes rpc", "readonly-db.ts", 'return { select: (table, columns = "*", options) => db.from(table).select(columns, options) };', 'return { select: (table, columns = "*", options) => db.from(table).select(columns, options), rpc: (n: string) => (db as any).rpc(n) } as never;', [T.sc]),
  // ── scripts: output, files, windows (test 7)
  { id: "C1", what: "the S1a summary is not capped at 60 lines (the row limit, the drop-detail loop and the final cap all removed: any one alone is covered by the others)", edits: [{ file: L + "s1a.ts", find: "const show = rows.slice(0, 5);", replace: "const show = rows.slice(0, 500);" }, { file: L + "s1a.ts", find: "while (L.length > 60) L.splice(L.length - 2, 1);", replace: "" }, { file: L + "s1a.ts", find: ".map((l) => (l.length > 220 ? l.slice(0, 217) + \"...\" : l)).slice(0, 60);\n}", replace: ".map((l) => (l.length > 220 ? l.slice(0, 217) + \"...\" : l));\n}" }], tests: [T.sc] },
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
  const only = new Set(process.argv.slice(2)); const list = [...MUTATIONS, ...MUTATIONS_4_0D].filter((x) => !only.size || only.has(x.id));
  const originals = new Map<string, string>(); const touched = [...new Set(list.flatMap((x) => x.edits.map((e) => e.file)))];
  for (const f of touched) originals.set(f, readFileSync(f, "utf8"));
  const restore = () => { for (const [f, c] of originals) writeFileSync(f, c); };
  process.on("SIGINT", () => { restore(); process.exit(130); }); process.on("SIGTERM", () => { restore(); process.exit(143); }); // a killed run must never leave a mutated source file behind process.on("exit", restore);
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
