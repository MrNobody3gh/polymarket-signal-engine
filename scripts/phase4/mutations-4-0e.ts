/**
 * The Phase 4.0e mutations (the gameStartTime check and the bundle commands), checked by `npm run phase4:mutations` with the older ones. Every id starts with `e`.
 */
import type { Mutation } from "./mutations-4-0d";
const L = "src/lib/phase4/";
const T = { gs: "tests/phase4-gamestart.test.ts", gr: "tests/phase4-gamestart-run.test.ts", bd: "tests/phase4-bundle.test.ts" };
const m = (id: string, what: string, file: string, find: string, replace: string, tests: string[]): Mutation => ({ id, what, edits: [{ file: L + file, find, replace }], tests });

export const MUTATIONS_4_0E: Mutation[] = [
  m("eC1", "exactly 15 minutes no longer agrees with the schedule", "gamestart.ts", "schedule = delta <= SCHEDULE_TOLERANCE_MIN ?", "schedule = delta < SCHEDULE_TOLERANCE_MIN ?", [T.gs]),
  m("eC2", "a resolution gap of exactly 1 h is not real", "gamestart.ts", "if (gapH >= RES_REAL_MIN_H && gapH <= RES_REAL_MAX_H)", "if (gapH > RES_REAL_MIN_H && gapH <= RES_REAL_MAX_H)", [T.gs]),
  m("eC3", "a resolution gap of exactly 6 h is not real", "gamestart.ts", "if (gapH >= RES_REAL_MIN_H && gapH <= RES_REAL_MAX_H)", "if (gapH >= RES_REAL_MIN_H && gapH < RES_REAL_MAX_H)", [T.gs]),
  m("eC4", "a resolution gap of exactly 0 is placeholder evidence", "gamestart.ts", "else if (gapH < 0 || gapH > RES_PLACEHOLDER_MAX_H)", "else if (gapH <= 0 || gapH > RES_PLACEHOLDER_MAX_H)", [T.gs]),
  m("eC5", "a resolution gap of exactly 24 h is placeholder evidence", "gamestart.ts", "else if (gapH < 0 || gapH > RES_PLACEHOLDER_MAX_H)", "else if (gapH < 0 || gapH >= RES_PLACEHOLDER_MAX_H)", [T.gs]),
  m("eC6", "a futures-like market type is no longer placeholder evidence", "gamestart.ts", "marketClassOf(e.marketType) === \"futures\" || !GAME_CATEGORIES.has(e.category)", "false || !GAME_CATEGORIES.has(e.category)", [T.gs]),
  m("eC7", "conflicting evidence is resolved in favour of real", "gamestart.ts", "const label: Label = real && !ph ? \"LIKELY_REAL\" : ph && !real ? \"LIKELY_PLACEHOLDER\" : \"UNDETERMINED\";", "const label: Label = real ? \"LIKELY_REAL\" : ph ? \"LIKELY_PLACEHOLDER\" : \"UNDETERMINED\";", [T.gs]),
  m("eC8", "a schedule value that is itself a placeholder counts as evidence", "gamestart.ts", "if (e.scheduleMs !== null && !e.schedulePlaceholder) {", "if (e.scheduleMs !== null) {", [T.gs]),
  m("eD1", "the period is judged with the offsets swapped", "gamestart.ts", "easternParts(ms).offsetMinutes === -240 ? \"EDT\" : \"EST\"", "easternParts(ms).offsetMinutes === -300 ? \"EDT\" : \"EST\"", [T.gs]),
  m("eD2", "5 events after the transition are enough to conclude", "gamestart.ts", "export const MIN_AFTER_EVENTS = 10;", "export const MIN_AFTER_EVENTS = 5;", [T.gs]),
  m("eD3", "3 midnight events before the transition make a cluster", "gamestart.ts", "export const MIN_BEFORE_MIDNIGHT = 5;", "export const MIN_BEFORE_MIDNIGHT = 3;", [T.gs]),
  m("eD4", "the cluster need only persist at 30 % of its share", "gamestart.ts", "export const PERSIST_RATIO = 0.5;", "export const PERSIST_RATIO = 0.3;", [T.gs]),
  m("eD5", "a tie between the 01:00Z and 00:00Z shares is a shift", "gamestart.ts", "if (sa01 > sa00 && sa01 >= PERSIST_RATIO * sb)", "if (sa01 >= sa00 && sa01 >= PERSIST_RATIO * sb)", [T.gs]),
  m("eD6", "the shifted clock is two hours later", "gamestart.ts", "return `${String((+h + 1) % 24).padStart(2, \"0\")}:${m}:${s}`;", "return `${String((+h + 2) % 24).padStart(2, \"0\")}:${m}:${s}`;", [T.gs]),
  m("eP1", "the what-if exempts every midnight value whatever the exemption says", "gamestart.ts", "pk === \"MIDNIGHT_UTC\" && exempt(x.e) ? null : pk", "pk === \"MIDNIGHT_UTC\" && true ? null : pk", [T.gs]),
  m("eP2", "the ordering rule is skipped in the what-if re-implementation", "gamestart.ts", "if (okShare < R.minOrderedShare) failed.push(", "if (false) failed.push(", [T.gs]),
  m("eP3", "the creation-coincidence rule is skipped", "gamestart.ts", "if (coincide > R.maxCreationCoincidenceShare) failed.push(", "if (false) failed.push(", [T.gs]),
  m("eP4", "the start-before-close rule is skipped", "gamestart.ts", "if (okc < R.minStartBeforeCloseShare) failed.push(", "if (false) failed.push(", [T.gs]),
  m("eP5", "the one-time-of-day rule is skipped", "gamestart.ts", "if (topClock > R.maxTopClockShare && vals.length >= R.minPresent) failed.push(", "if (false) failed.push(", [T.gs, T.gr]),
  m("eP6", "a repeated market id is counted as a second market", "gamestart.ts", "if (this.seen.has(id)) { this.counts.duplicates++; return; }", "if (false) { this.counts.duplicates++; return; }", [T.gs]),
  m("eP7", "the market cap is not enforced", "gamestart.ts", "if (this.seen.size >= this.maxMarkets) { this.counts.full = true; return; }", "if (false) { this.counts.full = true; return; }", [T.gs, T.gr]),
  m("eP8", "the event cap is not enforced", "gamestart.ts", "if (this.events.size >= this.maxEvents) {", "if (false) {", [T.gs, T.gr]),
  m("eP9", "the contrast sample is one event", "gamestart.ts", "ctl.length < Math.min(mid.length, others.length);", "ctl.length < 1;", [T.gs]),
  m("eR1", "a refusal does not stop the gamestart run", "gamestart-run.ts", "if (n.refused) { refused = true;", "if (false) { refused = true;", [T.gr]),
  m("eR2", "the request budget is ignored while paging", "gamestart-run.ts", "if (o.budget.left <= 0) { note.stoppedBecause = \"request budget reached\"; return note; }", "if (false) { note.stoppedBecause = \"request budget reached\"; return note; }", [T.gr]),
  m("eR3", "a repeated page is not noticed", "gamestart-run.ts", "if (first && first === lastFirst)", "if (false)", [T.gr]),
  m("eB1", "the bundle checksum is not verified", "bundle.ts", "if (sha !== b.sha) return", "if (false) return", [T.bd]),
  m("eB2", "the byte count is not verified", "bundle.ts", "if (gz.length !== b.bytes) return", "if (false) return", [T.bd]),
  m("eB3", "missing lines are accepted", "bundle.ts", "if (missing.length) return", "if (false) return", [T.bd]),
  m("eB4", "out-of-order lines are not reported", "bundle.ts", "const reordered = b.order.some((x, k) => k > 0 && x < b.order[k - 1]);", "const reordered = false;", [T.bd]),
  m("eB5", "two different lines with one index are accepted", "bundle.ts", "if (prev !== undefined && prev !== d[2]) cur.dup =", "if (false) cur.dup =", [T.bd]),
  m("eB6", "the bundle is not paced", "bundle.ts", "if (++n % MAX_LINES_PER_SECOND === 0) await sleep(1000);", "n++;", [T.bd]),
  m("eB7", "an unsafe name in the archive is accepted", "bundle.ts", "if (!name || name.startsWith(\"/\") || name.split(\"/\").includes(\"..\")) throw new Error(`unsafe file name in the archive", "if (false) throw new Error(`unsafe file name in the archive", [T.bd]),
  m("eB8", "the tar header checksum is not verified", "bundle.ts", "if (stored !== sum) throw", "if (false) throw", [T.bd]),
  m("eB9", "a bundle over the size limit is printed anyway", "bundle.ts", "if (gz.length > max) throw", "if (false) throw", [T.bd]),
  m("eB10", "the first complete bundle wins instead of the last", "bundle.ts", "cur.ended = true; done = cur; cur = null; continue;", "cur.ended = true; done = done ?? cur; cur = null; continue;", [T.bd]),
  m("eB11", "the padding is 3 KB instead of 300 KB", "bundle.ts", "export const PAD_BYTES_DEFAULT = 300_000;", "export const PAD_BYTES_DEFAULT = 3_000;", [T.bd]),
  m("eB12", "the data lines are 2,000 characters", "bundle.ts", "export const B64_LINE_CHARS = 3000;", "export const B64_LINE_CHARS = 2000;", [T.bd]),
];
