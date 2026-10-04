# Phase 4.0 — gap report, timestamp audit, coverage probe, capture design

Read-only. **No trading of any kind exists in this step**: no orders, keys, wallet, accounts or authenticated endpoints; nothing
writes to a database table; no migration, worker, Vercel or environment-variable change; no signal rule, scoring, portfolio,
simulation or threshold changed. Plan: `docs/PHASE4_PLAN.md` (v2).

| Part | Document | Code | Command |
|---|---|---|---|
| A gap report | [`GAP_REPORT.md`](GAP_REPORT.md) | — | — |
| B S1a timestamp audit | [`S1a_TIMESTAMP_AUDIT.md`](S1a_TIMESTAMP_AUDIT.md) | `src/lib/phase4/{timestamps,audit,s1a,venues,http,categorize}.ts` | `npm run phase4:ts-audit` |
| C S1b coverage probe and feasibility | [`S1b_COVERAGE.md`](S1b_COVERAGE.md) | `src/lib/phase4/{mapping,funnel,feasibility,stats,probe,readonly-db}.ts` | `npm run phase4:coverage` |
| D S1c book and fee capture design | [`S1c_BOOK_AND_FEE_CAPTURE.md`](S1c_BOOK_AND_FEE_CAPTURE.md) | — (design only) | — |
| 4.0b event-level S1a, diagnostic | sections 8 of the S1a and S1b documents | `src/lib/phase4/{events,diagnose}.ts`, `audit.ts`, `mapping.ts`, `funnel.ts`, `probe.ts`, `cli.ts` | `npm run phase4:ts-audit -- --us-targeted default`, `npm run phase4:coverage -- --diagnose`, `--print-files a,b` |
| 4.0c Kalshi, title search, corrected US queries, per-candidate verdicts, compact results | [`KALSHI_API.md`](KALSHI_API.md), [`VENUE_SURVEY.md`](VENUE_SURVEY.md), section 9 of the S1a and S1b documents | `src/lib/phase4/{venue-kalshi,venue-funnel,title-search,us-sports,compact}.ts`, `audit.ts`, `events.ts`, `venues.ts`, `http.ts`, `cli.ts` | `npm run phase4:ts-audit -- --us-targeted default --kalshi`, `npm run phase4:coverage -- --diagnose --kalshi`, `npm run phase4:title-search` |
| 4.0d one venue per process, feasibility matrix, stop rule, human review, wallet share | [`VENUE_FEASIBILITY.md`](VENUE_FEASIBILITY.md), [`REVIEW_GUIDE.md`](REVIEW_GUIDE.md), `stop_rule.json` | `src/lib/phase4/{venue-run,kalshi-inventory,stop-rule,review,matrix,merge,wallet-share,cli-review}.ts`, `scripts/phase4/{merge,review-sheet,review-ingest,wallet-share,mutations-4-0d}.ts` | `npm run phase4:ts-audit -- --venue kalshi`, `npm run phase4:merge`, `npm run phase4:review-sheet`, `npm run phase4:review-ingest`, `npm run phase4:wallet-share` |
| tests | `tests/phase4-*.test.ts`, `tests/helpers/phase4*.ts`, `tests/fixtures/phase4/` | | `npm test` |
| mutation check | every rule above, broken on purpose | `scripts/phase4/mutation-check.ts` | `npm run phase4:mutations` |

## Run order (where the venues and the database are reachable)

1. `npm run phase4:ts-audit -- --with-db` → `docs/phase4/data/s1a_*.json`, `S1a_RESULTS.md`, `tests/fixtures/phase4/s1a_*` (commit them). First check the US defaults against https://docs.polymarket.us (S1a §3).
2. `npm run phase4:coverage` → `docs/phase4/data/s1b_funnel.json`, `s1b_feasibility.json`, `s1b_mapping_review.csv` (the owner reviews the CSV).
3. Fill the "Results" sections of S1a and S1b from those files and decide D51, D48/D52, D53, D55 with them.

Both scripts need only `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (the coverage probe; S1a only with `--with-db`), print ≤ 60 lines, exit 0 on a finished-but-partial run, and report any blocked or failing endpoint exactly. No retries beyond 3 attempts for transient errors; a refusal (401/403/451) is never retried and ends requests to that host.

## Status of the measurements

**Not run by the authoring environment** (and the owner ran the scripts once on 3 Oct 2026: both venues reachable, results reported in the 4.0b brief; the result files are not in this repository, so these pages do not reproduce them). The authoring environment's network policy returned `403 Host not in allowlist` for every venue host (Gamma, `docs.polymarket.us`, `gateway.polymarket.us`, `api.polymarket.us`) and no database was configured. See S1a §1 for the exact attempts. Everything else (libraries, scripts, tests, Part A and Part D) is complete.

## Decisions D59–D72 (**accepted as recommended by the owner, 3 Oct 2026**)

| # | Decision | Recommendation |
|---|---|---|
| D59 | How E2 mapping is verified at scale: a human review per market (the CSV process) versus an allow-list of verified markets, and who reviews | Allow-list of reviewed `(venue market, outcome)` pairs, reviewed before they can ever pass E2; PROBABLE never trades |
| D60 | A start time that is present but unusable: fall back to the close time, or reject (GAP_REPORT U1) | Reject (implemented; `fallbackToCloseWhenStartInvalid` off) |
| D61 | A time in the past: valid for E4 and rejected by E5, with E5 and E7 both recorded when `time_to_event ≤ 0` (U2, U3) | As implemented |
| D62 | E0: when one fill yields several signals, which is evaluated | The Phase 3 order (`KIND_ORDER`: NEW_POSITION, EARLY_ENTRY, CONVICTION_ADD, CONSENSUS), first wins, deterministic |
| D63 | One limit-arithmetic function with a `feeAware` parameter: paper calls it unaware (parity, D20 kept), the Safety Gate aware (A2, A3) | Yes |
| D64 | Journal tamper-evidence: insert-only database roles, hash-chained rows, or both (U6) | Both; decide before 4.1 |
| D65 | The owner-only control channel for the kill switch (U7): allow-listed chat id plus a second factor, or a separate admin page | Design before 4.5 |
| D66 | `MAX_SIGNAL_AGE`: keep 600 s given the observed detection-lag distribution, and include E1 in the plan's flow estimate (U8) | Decide after S1b's `freshAtFinal` |
| D67 | Capture the international venue's raw time fields in production (GAP_REPORT §4 change) or rely on S1a's live fetches | Rely on S1a unless forward analysis of stored signals is wanted |
| D68 | Ownership of `RECOMMEND_RULES` thresholds (S1a §2) | Owner reviews the printed table with the first real results |
| D69 | Reading each venue's published terms for public data, and where the scripts run (region) | Before the first run |
| D70 | A watchlist-freshness gate (GAP_REPORT A4): reject when `wallets.scored_at` is older than N hours | Yes, small, in 4.2 |
| D71 | A "recent performance window" in the wallet context (A5): add a stored 7/30-day value or drop the words | Drop from V1 unless S1b shows a gradient |
| D72 | Book-capture cadence, N levels, raw retention, REJECT-arm `FILL_PROBE` (S1c §8) | As proposed in S1c |

Status: every recommendation in the third column stands as decided. D59–D62 are already implemented as described; D63–D65 and D70–D71 are carried into the build steps named in the table; D66 is revisited with S1b's `freshAtFinal`; D67–D69 and D72 are acted on in the order of the run sheet above.

## Step 4.0b: decisions D73–D78 (**accepted as recommended by the owner, 3 Oct 2026**)

Nothing was measured by this step (no venue or database access); these are the choices the new measurements will present, with the options. The owner decides.

| # | Decision | Options |
|---|---|---|
| D73 | Event level as the unit of every S1a reliability rule, with a minimum of 30 distinct events (implemented as the brief asks; the thresholds are unchanged) | Confirm; or also choose how an event whose markets disagree on a field is treated (today: the first market represents it, no flag) |
| D74 | Eastern-time date placeholders (`ET_MIDNIGHT` / `ET_END_OF_DAY`) are date-only values for every purpose | Confirm; and whether a **date-level** time rule may exist at all. Options after the run: (a) V1 stays timestamp-only, with the flow `s1b_funnel.json` shows; (b) a date-level rule with the in-play check obtained elsewhere (the date alone cannot give it); (c) other venues or sources of start times |
| D75 | The date-level funnel row (not the V1 policy) and the diagnostic's timestamp-free PROBABLE are reporting only | Confirm: neither is an input to eligibility or to the feasibility table |
| D76 | Per-sport quota for the `gameStartTime` evidence: ≥ 100 markets from ≥ 30 distinct events | Keep; or lower for sports that cannot reach it, with the shortfall stated |
| D77 | The US query syntax for `categories` and `sportsMarketTypes` and the archived query | Set from `docs.polymarket.us` before the targeted run (`--us-targeted`, `--us-archived-query`); the defaults are guesses |
| D78 | Cross-venue participant matching without an alias list ("Man City" / "Manchester City" scores 0.33 and is not matched) | Accept the loss and read the matched/head-to-head counts; or add a small alias table per sport after the first run |

Status: D73, D75, D76 and D78 stand as recommended. D74 is confirmed for Eastern placeholders; **whether a date-level time rule may exist at all stays open** until the 4.0b run's numbers are read. D77: the audit and the diagnostic are run with the default US queries and the queries are corrected from any errors (`--us-targeted`, `--us-archived-query`).

## Step 4.0c: the second candidate venue, correct US queries, title search for every pair, per-candidate verdicts

Same rules as 4.0 and 4.0b: public unauthenticated GETs only, ≤ 2 requests per second per host (the US origin slower, see below), no keys, accounts, identity verification or orders, a refusal is reported and never worked around, read-only database, no migration, production change, environment variable or dependency, no change to signal rules, scoring, portfolio, simulation or thresholds. Console output of every script is ≤ 60 lines; details go to files. **No policy is decided and no legal conclusion is given here.**

### Run sheet (production infrastructure; each command prints ≤ 60 lines)
```
# 1. time fields: US sports API (open + ended events), Kalshi, in-play, schedule sources; writes S1_COMPACT.md
npm run phase4:ts-audit -- --with-db --us-targeted default --kalshi --print-files S1_COMPACT.md
# 2. coverage: US exchange and Kalshi from one signal window, one category table; refreshes S1_COMPACT.md
npm run phase4:coverage -- --diagnose --kalshi --print-files S1_COMPACT.md
# 3. title search for every pair on both venues (~15 minutes for the US search at 60 requests/minute)
npm run phase4:title-search -- --print-files s1b_title_search_summary.json
```
Flags added: `--kalshi`, `--kalshi-max 40000` (listing cap, markets), `--kalshi-base URL`, `--us-sports-max-requests 400`, `--search-max-requests 2000`, `--all-scores`, `--venue us|kalshi|both` (title search), `--us-search-path`. `--print-files a,b` keeps working (paced, ≤ 200 lines per second): useful names are `S1_COMPACT.md`, `S1a_RESULTS.md`, `s1a_summary.json`, `s1b_funnel_kalshi.json`, `s1b_title_search_summary.json`, `s1b_title_search_polymarket_us.csv`, `s1b_title_search_kalshi.csv`, `s1a_inplay_us.json`. Run 1 before run 2: the coverage script reads `s1a_summary.json` (S1a recommendations per venue). Memory: everything is slimmed on arrival and capped (US 40,000 markets in diagnostic mode, Kalshi 40,000 by default; the production heap limit is about 500 MB).

| Output | Where | Read it for |
|---|---|---|
| `S1_COMPACT.md` | the output directory | one row per venue x stratum x slot (best passing field, verdict, events, the deciding rule and what the other candidates failed on) and one funnel table; at most 80 lines |
| `S1a_RESULTS.md`, `s1a_<venue>.json` | same | every candidate field per slot, the Kalshi listing by category, FUTURES versus single-game, the `live` / `ended` report, the schedule sources, the sports API requests |
| `s1b_funnel_kalshi.json`, `s1b_mapping_review_kalshi.csv` | same | the Kalshi funnel and its PROBABLE candidates for the owner's eye |
| `s1b_title_search_<venue>.csv`, `s1b_title_search_summary.json` | same | the per-pair title search: bands, any candidate, the best three candidates per pair |

### What changed in the code
- **Per-candidate slot verdicts (Part D1).** Every candidate field is judged for every slot with the unchanged thresholds; the best passing one is `bestField`; a candidate with no ordering evidence is `INSUFFICIENT_DATA`, not "unusable". Cause of the 4.0b misreading: S1a section 9.1.
- **Corrected US queries and the sports API (Part C1).** Category slugs (`sports`, `crypto`), the documented `sportsMarketTypes`, sports, leagues and events by sport and league slug, open and ended; the broken default is gone; `--us-targeted` still overrides.
- **Kalshi (Part A).** Adapter, audit, funnel and category table; the API as recorded is **not verified**: [`KALSHI_API.md`](KALSHI_API.md).
- **Title search (Part B).** `npm run phase4:title-search`.
- **`live` / `ended`, schedule sources, FUTURES (Parts C2, C3, D2); `S1_COMPACT.md` (D3); venue survey (Part E).**
- **Pacing.** `PoliteHttp` takes a slower gap per origin; the US exchange's origin runs at 1.1 s per request because a summary of its documentation states 60 requests per minute (**not verified**).
- **Categoriser.** A title or slug with esports words is esports even when the venue's own tag is a plain "Sports" (Kalshi files esports there).

### Status of the measurements: nothing was measured by the step that wrote this
The authoring environment's network policy answered 403 for every venue host (`gateway.polymarket.us`, `api.elections.kalshi.com`, `docs.polymarket.us`, `docs.kalshi.com`, Gamma) and the documentation-fetch tool was blocked the same way; the documentation facts come from search-engine summaries and are marked **not verified**. Delivered and tested on fixtures with hand-derived answers: all code, the documents, the mutation checks. **Remaining measurements, to be run on production infrastructure:** the three commands above. The tests do not prove any statement about Kalshi's or the US exchange's real responses.

### Decisions D79–D87 (the owner decides; **D80 and D86 settled 3 Oct 2026**: D80 keep 1.1 s per request on the US origin; D86 run with the 40,000-market caps first and raise them only if the run reports being cut off; D79 and D81–D85 and D87 are decided from the run's output)
| # | Decision | Options, with what the run will show |
|---|---|---|
| D79 | Which Kalshi base URL and facts stand: the two documented hosts, public data without authentication, the cursor key, `with_nested_markets`, milestones | Read `S1a_RESULTS.md` "Not established" and `fetch.*` for kalshi; correct `KALSHI_API.md`; if public data needs authentication that part stops (rule) |
| D80 | The pace for the US exchange's origin: 1.1 s per request (its documented 60 per minute, not verified) versus the brief's 2 per second | Keep 1.1 s (default, about 15 minutes for 740 searches); or confirm the real limit on the first run (any 429 shows in `http.byKind`) and set it |
| D81 | May `gameStartTime` fill slot 1 for **single-game market types only** (FUTURES excluded)? | After the run: `bestField` per sport and `futuresVerdicts`; options (a) yes for the sports whose verdict is `SINGLE_GAME_ONLY` or `NO_DIFFERENCE_OBSERVED` with ≥ 30 events per class, (b) also require the schedule source to agree within 15 minutes, (c) no, keep `INSUFFICIENT_DATA` strata rejected |
| D82 | May Kalshi's `event.strike_date`, or a milestone's `start_date`, fill slot 1? | Only if its per-candidate verdict passes and the schedule comparison shows a time of day and agreement; otherwise Kalshi stays on `close_time` (slot 2, deadline-type markets) |
| D83 | Kalshi has no identifier shared with Polymarket: only PROBABLE exists. How is a Kalshi mapping verified (extends D59)? | Human review of each pair (the review CSV and the title-search CSV list them: the count is the cost); an allow-list of reviewed pairs before any can pass E2; or no Kalshi execution |
| D84 | Title wording across venues ("Winner?" suffixes, team aliases) lowers similarity (extends D78) | Keep the strict function and read the near-miss list; or add a small normalisation / alias table per sport after reading the 10 near-misses per venue |
| D85 | Use the US exchange's `live` / `ended` flags as a **second** in-play check beside plan §3.4's `time_to_event <= 0`? | After the run: false positives (live before the start), false negatives (started, neither live nor ended) and the `ended` agreement with resolved status; options (a) not used, (b) used only to reject (a flagged live event is rejected even if the clock says not started), (c) adopted as the primary check |
| D86 | Listing caps: US 40,000 and Kalshi 40,000 markets give lower bounds when cut off | Raise `--us-max` / `--kalshi-max` (memory permitting) or accept lower bounds with the shortfall stated |
| D87 | D53 (venue) with the new numbers: the US exchange, Kalshi, both, or neither | Decided by the owner from the funnels, the category table and the title-search bands, and by G1 (a New York-qualified lawyer, with [`VENUE_SURVEY.md`](VENUE_SURVEY.md) as input). **No recommendation is made here** |

## Step 4.0d: one venue at a time, a feasibility matrix with a pre-approved stop rule, a human-verified sample, per-wallet executable share
Everything is in [`VENUE_FEASIBILITY.md`](VENUE_FEASIBILITY.md) (run sheet, evidence files, heap budget and exit code 3, the Kalshi category inventory, the US pace/refusal/resume rules, the matrix formulas, the stop rule, decisions **D88–D98**) and [`REVIEW_GUIDE.md`](REVIEW_GUIDE.md) (for the owner). Nothing was measured by the authoring step (no venue is reachable from it); the remaining measurements are listed there. The stop rule `docs/phase4/stop_rule.json` ships **unapproved**. **Decisions D88–D98 accepted as recommended by the owner on 4 Oct 2026, including approval of the stop rule exactly as proposed (`"approved": true`, committed before any review result existed); D96 approved (all-scores title search); D95: the US title search is re-run with `--resume` at a slower pace.**
