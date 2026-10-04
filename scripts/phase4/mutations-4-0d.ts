/**
 * The Phase 4.0d mutations (one venue per process, the heap budget, the Kalshi inventory, the stop rule, the review, the matrix and merge, the wallet share),
 * checked by `npm run phase4:mutations` together with the older ones. Every id starts with `d` so it cannot collide with an earlier id.
 */
export interface Edit { file: string; find: string; replace: string }
export interface Mutation { id: string; what: string; edits: Edit[]; tests: string[] }
const L = "src/lib/phase4/";
const T = { vr: "tests/phase4-venue-run.test.ts", ki: "tests/phase4-kalshi-inventory.test.ts", sr: "tests/phase4-stop-rule.test.ts", rv: "tests/phase4-review.test.ts", rc: "tests/phase4-review-cli.test.ts", mm: "tests/phase4-matrix-merge.test.ts", ws: "tests/phase4-wallet-share.test.ts", st: "tests/phase4-stats.test.ts", tsr: "tests/phase4-title-search.test.ts" };
const m = (id: string, what: string, file: string, find: string, replace: string, tests: string[]): Mutation => ({ id, what, edits: [{ file: L + file, find, replace }], tests });

export const MUTATIONS_4_0D: Mutation[] = [
  // ── one venue per process, the heap budget
  m("dH1", "the heap budget is exclusive: exactly the budget stops the run", "venue-run.ts", "if (mb > this.budgetMb) throw new HeapBudgetExceeded(", "if (mb >= this.budgetMb) throw new HeapBudgetExceeded(", [T.vr]),
  m("dH2", "the guard stops on garbage: it never collects before it judges", "venue-run.ts", "if (mb > this.budgetMb && this.collect) {", "if (false && this.collect) {", [T.vr]),
  m("dH3", "the stop message does not say which request or stage", "venue-run.ts", "detail ? `${this.stage}, ${detail}` : this.stage,", "this.stage,", [T.vr]),
  m("dH4", "the default heap budget is 700 MB", "venue-run.ts", "export const DEFAULT_HEAP_BUDGET_MB = 350;", "export const DEFAULT_HEAP_BUDGET_MB = 700;", [T.vr]),
  m("dH5", "the HTTP client does not consult the guard before a request", "http.ts", "this.guard?.check(`request ${this.requests + 1}`);", "", [T.vr]),
  m("dH6", "a heap stop exits 0", "venue-run.ts", "export const EXIT_BUDGET = 3;", "export const EXIT_BUDGET = 0;", [T.vr]),
  m("dV1", "a venue-scoped process may enter another venue's stage", "venue-run.ts", "if (venue !== this.venue) throw new VenueScopeError", "if (false) throw new VenueScopeError", [T.vr]),
  m("dV2", "the short alias intl is not accepted", "venue-run.ts", "INTERNATIONAL, intl: INTERNATIONAL,", "INTERNATIONAL,", [T.vr]),
  m("dV3", "a single-venue audit still fetches the international venue", "s1a.ts", "if (want(INTERNATIONAL)) {", "if (true) {", [T.vr]),
  m("dV4", "a single-venue audit writes the combined files too", "s1a.ts", "    if (opt.fixtureDir) writeFixtures(venues, raws, opt, opt.fixtureDir);\n    return result;\n  }", "    if (opt.fixtureDir) writeFixtures(venues, raws, opt, opt.fixtureDir);\n  }", [T.vr]),
  m("dV5", "--with-db is honoured for any venue", "cli.ts", "if (flags.has(\"with-db\") && only && only !== INTERNATIONAL)", "if (false)", [T.vr]),
  m("dV6", "a venue-scoped audit treats every venue as wanted", "s1a.ts", "const want = (v: VenueId) => !only || only === v;", "const want = (v: VenueId) => true;", [T.vr]),
  m("dP1", "the US search pace may go below the polite floor", "cli.ts", "const usPace = Math.max(US_MIN_INTERVAL_MS, paceAsked ?? 0);", "const usPace = paceAsked ?? US_MIN_INTERVAL_MS;", [T.rc]),
  m("dP2", "a refusal does not end the US title search", "title-search.ts", "    if (out.blocked) { done++;", "    if (false) { done++;", [T.rc, T.tsr]),
  m("dP3", "--resume asks again for pairs already answered", "title-search.ts", "if (kept.has(pairKey(pair))) continue;", "", [T.rc]),
  m("dP4", "an errored row counts as answered in the unsearched count", "title-search.ts", "const answered = new Set(rows.filter((r) => r.diag && !r.error).map((r) => pairKey(r.pair)));", "const answered = new Set(rows.map((r) => pairKey(r.pair)));", [T.rc]),
  m("dP5", "pair keys are case-sensitive", "title-search.ts", "`${String(p.conditionId).toLowerCase()}|${p.outcome ?? \"\"}`", "`${String(p.conditionId)}|${p.outcome ?? \"\"}`", [T.ws, T.rc]),
  // ── the Kalshi inventory (no market is loaded)
  m("dK1", "the inventory asks for nested markets", "kalshi-inventory.ts", "const qs = new URLSearchParams({ status, limit: String(size) });", "const qs = new URLSearchParams({ status, limit: String(size), with_nested_markets: \"true\" });", [T.ki]),
  m("dK2", "the inventory reads an event's markets", "kalshi-inventory.ts", "for (const e of list) { const cat = str(e.category) ?? \"(none)\"; const c = (byCategory[cat] ??= cell());", "for (const e of list) { void e.markets; const cat = str(e.category) ?? \"(none)\"; const c = (byCategory[cat] ??= cell());", [T.ki]),
  m("dK3", "an esports category is always reported to exist", "kalshi-inventory.ts", ".some((c) => ESPORTS_RE.test(c));", ".some(() => true);", [T.ki]),
  m("dK4", "every event is counted as open", "kalshi-inventory.ts", "c[status]++; c.total++; total[status]++;", "c.open++; c.total++; total.open++;", [T.ki]),
  m("dK5", "an inventory that answered nothing says esports do not exist instead of unknown", "kalshi-inventory.ts", "!series.read && !total.total && !categories.names.length ? null :", "false ? null :", [T.ki]),
  m("dK6", "a cut-off count is reported complete", "kalshi-inventory.ts", "ps.stoppedBecause = \"request budget reached\"; complete = false;", "ps.stoppedBecause = \"request budget reached\";", [T.ki]),
  // ── the stop rule
  m("dS1", "an upper bound exactly equal to the requirement is infeasible", "stop-rule.ts", "b.upper !== null && b.upper < reqInf;", "b.upper !== null && b.upper <= reqInf;", [T.sr]),
  m("dS2", "a lower bound exactly equal to the requirement is feasible", "stop-rule.ts", "b.lower !== null && b.lower > reqFeas;", "b.lower !== null && b.lower >= reqFeas;", [T.sr]),
  m("dS3", "an unknown upper bound is treated as zero", "stop-rule.ts", "b.upper !== null && b.upper < reqInf;", "(b.upper ?? 0) < reqInf;", [T.sr]),
  m("dS4", "an unapproved rule issues a verdict", "stop-rule.ts", "if (!r.approved) return {", "if (false) return {", [T.sr, T.mm]),
  m("dS5", "a rule edited after the ingest still gives a verdict", "stop-rule.ts", "if (!o.current || u.sha256 !== o.current.sha256)", "if (false)", [T.sr, T.mm]),
  m("dS6", "review results ingested before approval still give a verdict", "stop-rule.ts", "if (!u || u.approved !== true) return {", "if (false) return {", [T.sr, T.mm]),
  m("dS7", "an unknown lower bound can be feasible", "stop-rule.ts", "b.lower !== null && b.lower > reqFeas;", "(b.lower ?? 1e9) > reqFeas;", [T.sr]),
  // ── Wilson, required per day
  m("dW1", "Wilson uses z = 1.64", "stats.ts", "export function wilson(k: number, n: number, z = 1.96)", "export function wilson(k: number, n: number, z = 1.64)", [T.rv, T.st]),
  m("dW2", "Wilson leaves a rounding residue at k = 0", "stats.ts", "lo: k === 0 ? 0 : Math.max(0, c - h)", "lo: Math.max(0, c - h)", [T.rv]),
  m("dW3", "the required signals per day ignore the settlement lag", "feasibility.ts", "const usable = W - i.lagDays;", "const usable = W;", [T.mm]),
  m("dW4", "the required signals per day ignore the settled share", "feasibility.ts", "const scarce = Math.min(a, 1 - a) * share; out.push", "const scarce = Math.min(a, 1 - a) * 1; out.push", [T.mm]),
  // ── the review sheet and the ingest
  m("dR1", "the sample split is a third each", "review.ts", "const A = Math.ceil(n / 2), B = Math.ceil(n / 4);", "const A = Math.ceil(n / 3), B = Math.ceil(n / 3);", [T.rv]),
  m("dR2", "a thin band does not hand its share to the others", "review.ts", "for (let guard = 0; left > 0 && guard < 10_000; guard++)", "for (let guard = 0; false; guard++)", [T.rv]),
  m("dR3", "the sample ignores the seed", "review.ts", "const rng = seededRng(`${seed}|${o.venue}|${b}`);", "const rng = seededRng(`fixed|${o.venue}|${b}`);", [T.rv]),
  m("dR4", "unsure counts as confirmed", "review.ts", "const confirmed = r.q === \"Y\" && r.o === \"Y\" && r.t === \"Y\" && r.r === \"Y\";", "const confirmed = r.q !== \"N\" && r.o !== \"N\" && r.t !== \"N\" && r.r !== \"N\";", [T.rv]),
  m("dR5", "an unknown automatic TIME no longer blocks verification", "review.ts", "const verified = confirmed && r.timeAuto === \"yes\";", "const verified = confirmed;", [T.rv]),
  m("dR6", "exactly the timestamp tolerance disagrees", "review.ts", "return Math.abs(sourceMs - venueMs) <= toleranceMs ? \"yes\" : \"no\";", "return Math.abs(sourceMs - venueMs) < toleranceMs ? \"yes\" : \"no\";", [T.rv]),
  m("dR7", "the automatic TIME is computed when only one venue has a timestamp", "review.ts", "if (sourceMs === null || venueMs === null || !Number.isFinite(sourceMs) || !Number.isFinite(venueMs)) return \"unknown\";", "if (sourceMs === null && venueMs === null) return \"unknown\";", [T.rv]),
  m("dR8", "an unknown answer value is accepted", "review.ts", "else if (!ANSWER.test(v)) err(", "else if (false) err(", [T.rv, T.rc]),
  m("dR9", "the extrapolated lower bound uses the point estimate", "review.ts", "lo += w * b.jointProposed.lo;", "lo += w * b.jointProposed.point;", [T.rv]),
  m("dR10", "the unsearched pairs are left out of the upper bound", "review.ts", "const w = un.signals / totalSignals; hi += w; missHi += w;", "const w = un.signals / totalSignals; missHi += w;", [T.rv]),
  m("dR11", "every confirmed pair counts as proposed", "review.ts", "const proposedByCode = used === \"F\" ? false : r.props[Number(used) - 1] === true;", "const proposedByCode = true;", [T.rv]),
  m("dR12", "an edited population column is accepted", "review.ts", "let popOk = rows.every((r) => r.pop === rows[0].pop);", "let popOk = true;", [T.rv]),
  m("dR13", "the review pool includes score < 68 pairs", "review.ts", "(o.includeBelow68 || (r.pair.score ?? -1) >= SCORE_MIN)", "true", [T.rv]),
  m("dR14", "a proposal needs only 0.60 similarity", "mapping.ts", "export const PROPOSED_MIN_SIMILARITY = 0.7;", "export const PROPOSED_MIN_SIMILARITY = 0.6;", [T.rv]),
  m("dR15", "a proposal ignores the outcome label", "mapping.ts", "c.identifierMatch || (c.score >= PROPOSED_MIN_SIMILARITY && c.numbersAgree && c.negationsAgree && c.outcomeMatch === true)", "c.identifierMatch || (c.score >= PROPOSED_MIN_SIMILARITY && c.numbersAgree && c.negationsAgree)", [T.rv]),
  // ── the matrix and the merge
  m("dX1", "an unjudged stratum counts as passing in the lower bound", "matrix.ts", "tri: { lower: share(pass), point: share(pass), upper: share(pass + unk) }", "tri: { lower: share(pass + unk), point: share(pass), upper: share(pass + unk) }", [T.mm]),
  m("dX2", "a cut-off listing never leaves the upper bound open", "matrix.ts", "const upperOpen = f.cutOff && fn < f.minFalseNegativeRows;", "const upperOpen = false;", [T.mm]),
  m("dX3", "a point estimate is made even when the window share is n/m", "matrix.ts", "share.point !== null && f.window.point !== null && f.ts.point !== null ?", "share.point !== null && f.ts.point !== null ?", [T.mm]),
  m("dX4", "the eligible-like subset is used whatever its size", "matrix.ts", "eligible && eligible.stats.n >= rule.minTrades &&", "eligible &&", [T.mm]),
  m("dX5", "29 dated signals are enough to measure the window share", "matrix.ts", "ts >= 30 &&", "ts >= 1 &&", [T.mm]),
  m("dX6", "a venue with no title search shows a range from zero instead of not run", "matrix.ts", "    if (!t) return row;\n", "", [T.mm]),
  m("dX7", "a missing coverage file is left out of the compact funnel instead of shown as not run", "merge.ts", "notRun: !v.coverage,", "notRun: false,", [T.mm]),
  m("dX8", "the proxy of another venue's coverage is not used", "matrix.ts", "proxySource && proxySource.funnel.proxy.scoreAndProxy !== null ?", "false ?", [T.mm]),
  // ── wallet share
  m("dL1", "signals on pairs that were not searched count as 'no candidate'", "wallet-share.ts", "share: ratio(a.proposed, a.searched), perDay", "share: ratio(a.proposed, a.signals), perDay", [T.ws]),
  m("dL2", "exactly 25 % does not count as at least 25 %", "wallet-share.ts", "w.share !== null && w.share >= t", "w.share !== null && w.share > t", [T.ws]),
  m("dL3", "score 68 exactly is not a score ≥ 68 wallet", "wallet-share.ts", "if (s.score !== null && s.score >= SCORE_MIN) w.has68 = true;", "if (s.score !== null && s.score > SCORE_MIN) w.has68 = true;", [T.ws]),
  m("dL4", "the concentration counts the top 2 instead of the top 3 wallets", "wallet-share.ts", "concentration: { top3: topN(3), top10: topN(10) }", "concentration: { top3: topN(2), top10: topN(10) }", [T.ws]),
];
