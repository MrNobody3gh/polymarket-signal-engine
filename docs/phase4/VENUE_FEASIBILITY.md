# Phase 4.0d: one venue at a time, the feasibility matrix, a pre-approved stop rule, a human-verified sample, per-wallet executable share

Read-only, like 4.0 to 4.0c: public unauthenticated GETs only, per-host pacing exactly as the polite client sets it (never faster), no keys, accounts, identity
verification or orders, a refusal stops that part with no workaround, strictly read-only database access (select only), no migration, production change, environment
variable or dependency, no change to signal rules, scoring, portfolio, simulation or thresholds. **No policy is decided and no legal conclusion is given.**

## Status of the measurements: nothing was measured by this step
The authoring environment cannot reach any venue: every request through its outbound proxy ends in `CONNECT tunnel failed, response 403` (the same reason as in 4.0c).
Delivered and tested on synthetic worlds with hand-derived answers: all code, the documents, the mutation checks. **Measurements that remain, one venue per process,
on production infrastructure** (see the run sheet): the three audits, the three coverage runs, the two title searches (US past the 403 with `--resume`, and a slower pace
if the owner chooses), the Kalshi category inventory, the US per-sport verdicts with the corrected queries, the reviews, and the wallet share. No number in this
document is a measurement of a venue; the numbers in the tests are constructed.

## 1. One venue per process (Part A)
Why: the 4.0 to 4.0c runs died or were killed out of memory (exit 134 / 137) because one process held two or three venues' listings. A run with `--venue` touches **only that
venue**: the other venues' hosts are never asked, their stages are never built, and the process refuses (`VenueScopeError`) to enter another venue's stage. Each run
writes one compact evidence file and drops its raw markets before it exits.

| Command | Venue | What runs | File written (`docs/phase4/data/`) |
|---|---|---|---|
| `npm run phase4:ts-audit -- --venue polymarket_intl [--with-db]` | international | Gamma open and resolved samples; with `--with-db` our resolution times | `v_polymarket_intl_audit.json` |
| `npm run phase4:ts-audit -- --venue polymarket_us` | US exchange | open and resolved samples, the **sports API per sport** (`--us-targeted default` is the default here), `live`/`ended`, schedule | `v_polymarket_us_audit.json` |
| `npm run phase4:ts-audit -- --venue kalshi [--kalshi-inventory \| --kalshi-inventory-only]` | Kalshi | the bounded listing (cap 40,000), milestones, optionally the category inventory | `v_kalshi_audit.json` |
| `npm run phase4:coverage -- --venue polymarket_intl` | international | **database only**: the signal window, the category mix of our flow, the settled paper trades (SD, design effect, settlement lag) | `v_polymarket_intl_coverage.json` |
| `npm run phase4:coverage -- --venue polymarket_us [--diagnose]` | US exchange | the US listing (cap 40,000), the funnel | `v_polymarket_us_coverage.json` (+ `v_polymarket_us_s1b_mapping_*.csv`) |
| `npm run phase4:coverage -- --venue kalshi` | Kalshi | the Kalshi listing, the funnel | `v_kalshi_coverage.json` |
| `npm run phase4:title-search -- --venue polymarket_us [--all-scores] [--resume] [--us-search-pace-ms N]` | US exchange | the venue's search endpoint, one query per pair | `v_polymarket_us_titles.json` |
| `npm run phase4:title-search -- --venue kalshi [--all-scores]` | Kalshi | a lookup in the bounded listing (no search endpoint is documented) | `v_kalshi_titles.json` |
| `npm run phase4:merge` | none | reads the files only | `S1a_RESULTS.md`, `S1_COMPACT.md` (≤ 80 lines), `FEASIBILITY_MATRIX.md` (≤ 100), `S1b_FUNNELS.md` |
| `npm run phase4:review-sheet -- --venue <v> --n 60` | none | reads `v_<venue>_titles.json` | `s1d_review_<venue>.csv` |
| `npm run phase4:review-ingest -- --file <filled csv>` | none | the owner's answers | `s1d_review_results_<venue>.json` and `.csv` |
| `npm run phase4:wallet-share -- --venue <v>` | none | our entry signals (select only) + the titles file | `v_<venue>_wallets.json`, `WALLET_SHARE_<venue>.md` |

The all-in-one commands without `--venue` still work for small runs (and the old files `s1a_summary.json`, `s1b_funnel.json`, ... are still written by them); they are not
recommended for the production listings. Every command prints at most 60 lines; `--print-files a,b` (bare `--print-files` for the review, ingest and wallet commands)
returns result files from a log-only host, paced. **The container is deleted after a run**: chain the commands of one venue in the same container, or return the
files with `--print-files` (a single-line JSON is split in 3,000-character pieces) and commit them.

### Run sheet (production, region as before; one process per line, in this order; every line is a separate `npm run`)
```
# 0. database side (also feeds the required-signals-per-day table)
npm run phase4:coverage -- --venue polymarket_intl
# 1. the US exchange
npm run phase4:ts-audit  -- --venue polymarket_us
npm run phase4:coverage  -- --venue polymarket_us --diagnose
npm run phase4:title-search -- --venue polymarket_us --all-scores          # a 403 stops it; record the pairs reached; later: --resume --us-search-pace-ms 2500
# 2. Kalshi
npm run phase4:ts-audit  -- --venue kalshi --kalshi-inventory
npm run phase4:coverage  -- --venue kalshi
npm run phase4:title-search -- --venue kalshi --all-scores
# 3. the signal source's own time fields (optional, uses the database and Gamma)
npm run phase4:ts-audit  -- --venue polymarket_intl --with-db
# 4. combine, then review (owner), then ingest AFTER approving docs/phase4/stop_rule.json, then merge again
npm run phase4:merge -- --print-files FEASIBILITY_MATRIX.md,S1_COMPACT.md
npm run phase4:review-sheet -- --venue polymarket_us --n 60 --print-files
npm run phase4:review-ingest -- --file <filled csv>
npm run phase4:wallet-share -- --venue polymarket_us --print-files
```

### The heap budget (default 350 MB; `--heap-budget-mb`)
The temporary Railway service has a heap limit of about 500 MB. Every request, and every stage, first checks the heap in use against the budget; **over budget the run
stops with a message naming the venue and the stage, writes a partial evidence file (`"stopped": {...}`, which the merge shows as STOPPED, never as zero), and exits 3**:
```
STOPPED (heap budget): venue kalshi, stage "listing, request 41": 361 MB of heap in use exceeds the budget of 350 MB (--heap-budget-mb). Nothing further was fetched ...
```
`heapUsed` also counts garbage that has not been collected, and the host kills a process for what it holds. So the guard **collects garbage on demand before it decides**
(it switches `--expose-gc` on at run time, no command-line flag is needed) and stops only if the live heap is still over budget; a run therefore stops on live data, and the
collection costs nothing while under budget. Exit codes: 0 finished (possibly partial, as before), 1 failed, 2 configuration or input error (nothing touched), **3 stopped by the
heap budget**. Measured on the synthetic 40,000-market listings (tests): peak heap about 68 MB (Kalshi audit), well inside 350 MB; this says nothing about the real listings' sizes.

### The evidence files
Each is JSON with `schema`, `kind` (`audit`, `coverage`, `titles`), `venue`, the run's start and finish, `heap: {budgetMb, peakMb}`, `stopped` (null when finished) and the
payload: the venue's audit (inventory, evidence, per-candidate verdicts per stratum and slot, the sports API, `live`/`ended`, the schedule, the Kalshi inventory); the coverage
result (the funnel, mapping buckets, the diagnostic, the category mix, the feasibility from settled paper trades); the title search (every pair with its three best candidates,
the summary with the pace used, the pairs reached, a refusal if any, the pairs and signals **not** searched). A missing, unreadable, foreign or old-schema file is "not run".

### Kalshi category inventory (no market is loaded): what the documentation does and does not allow
`fetchKalshiInventory` reads, through the polite client (≤ 2 requests per second, a request budget of 600 by default, `--kalshi-inventory-max-requests`):
`GET /search/tags_by_categories` (category names and tags), `GET /series` (every series with its category, title and tags: **series per category is exact**),
`GET /events?status=<s>&limit=200` for `open`, `unopened`, `closed`, `settled` **without nested markets**, counted page by page and dropped (**events per category and status
are exact when every status pages to its end; lower bounds, flagged, when the budget cuts them**), and one `limit=1` probe each of `/events` and `/markets` to see whether the
answer carries a total (`total`, `count`, ...). **Markets are never loaded** (`with_nested_markets` is never requested; a test makes every answer carry nested markets and
fails if the code reads a `markets` member), so the number of **markets** per category and status is reported as **not available** unless the venue documents a total; it is
never estimated. Esports: a category name, a series title or tag, or an event title matching the esports list (`ESPORTS_RE`) is counted separately: `categoryExists` is about
category names, the match counts are about titles. All endpoint names are those of Kalshi's documentation as summarised in [`KALSHI_API.md`](KALSHI_API.md) and are **not
verified** until a run answers; each miss is recorded under "What they did not allow" in `S1a_RESULTS.md`.

### US per-sport verdicts, the title search past the 403
`--venue polymarket_us` runs the sports API (sports, leagues, events by sport and league slug, open and ended, the corrected `categories=sports` queries as fallback) in a US-only
process, reaching at least 100 markets from at least 30 events per sport where the listing allows (decision D76), with the corrected `live`/`ended` and schedule comparisons from 4.0c.
The US title search stopped with HTTP 403 after 97 of 791 pairs in the production run. Now: a refusal (401/403/451) ends **that run** at once, the pairs answered are recorded
(`reachedPairs`, `refusal.afterPairs`, the pairs and signals not searched), and the run **tries nothing else**: no retry, no other header or origin, no automatic slowing within the
same run. `--us-search-pace-ms` sets the gap between requests (never below 1,100 ms; a lower value is raised with a note; the pace used is recorded as `paceMs` and requests per minute);
`--resume` (or `--resume-from FILE`) carries over every pair already answered and searches only the rest, so a *later* run may legitimately go slower. Whether to run it again, and
at what pace, is the owner's decision (D95).

## 2. What "verified" means (Part B1; written into the code in `review.ts`)
- A candidate is **proposed** by code: an identifier match, or title similarity at least **0.70** with equal numbers and negations and a matching outcome label (`isProposed`). The
  similarity is the existing band score, `max(title Jaccard, participant similarity)`, so the bands and the proposals agree.
- It becomes **owner-confirmed** only when the owner marks QUESTION, OUTCOME, TIME and RESOLUTION all `Y` in the review sheet.
- It becomes **verified** only when, in addition, the TIME check **computed automatically** from verified-valid timestamps on **both** venues (plan §3.3, within `TIMESTAMP_TOLERANCE`)
  says `yes`. Where either venue has no verified-valid timestamp it is **unknown**, and unknown **blocks verification** (so today nothing is verified, by construction, while no
  time field passes the S1a rules; the owner's confirmations are still counted).
- **Anything unverified counts as not tradable**; `U` (unsure) counts as not confirmed.

## 3. The venue feasibility matrix (Part B2, B3)
`FEASIBILITY_MATRIX.md` (generated, at most 100 lines): the required-per-day table, then one row per venue (the international platform shown as the signal source only):
signal pairs (score ≥ 68, all scores in the same cell when the title search used `--all-scores`) · proposed matches by similarity band · human precision of the proposals by band with
Wilson intervals (or "not reviewed") · timestamp coverage (or "no field passes") · resolution rules (Y/N/U counts) · **expected verified-executable eligible signals per day**
(lower · point · upper) · the number the window requires (the infeasible test · the feasible test) · the verdict. A venue with no file is **not run**, never zero.

**Required per day.** From the settled paper trades: `perArm = ceil(2 z² SD² DEFF / effect²)` (z for α 0.05 two-sided and power 80 %), and
`required = perArm / ((MAX_WINDOW − settlement lag p90) × settled share × min(accept, 1 − accept))`, for effects 10 and 15 points, `MAX_WINDOW` 84 days, acceptance 10, 25, 50 %.
Known answer: SD 89, DEFF 1, no lag, 84 days: 1,244 per arm at 10 points, 29.62 / 59.24 / 148.10 per day at 50 / 25 / 10 %; 553 per arm at 15 points. The statistics come from
the eligible-like subset when it has at least 100 settled trades, else from all settled trades (the choice is printed).

**Expected per day** `= (score ≥ 68 signals per day) × WINDOW × TIMESTAMP × SHARE`, each factor with a lower, a point and an upper value, **multiplied bound by bound** (wider than a
joint 95 % interval, on purpose):

| Factor | Lower | Point | Upper |
|---|---|---|---|
| SHARE of signals with an owner-confirmed proposed candidate (review) | Wilson lower of confirmed∧proposed, per band, weighted by the band's signals; unreviewed band or unsearched pairs 0 | the same at the point, only when every band was reviewed and nothing was unsearched, else **n/m** | Wilson upper of **any** confirmed pair (matcher misses included), an unreviewed band or the unsearched pairs counted fully |
| WINDOW (24 h, not started, MIN_LEAD) | measured funnel survival among signals with a usable timestamp, needs ≥ 30 such signals, else 0 | the measurement, else the date-level proxy, else n/m | the date-level proxy (score ≥ 68 with a stored end date today or tomorrow: **it includes events that had already started, so it over-states**), else 1 |
| TIMESTAMP (stratum-level) | share of proposed signals whose candidate's stratum has a recommended time field (slot 1 or 2) | the same | the same plus strata with too little data to judge |
| listing cut off | with no reviewed below-0.30 stratum of at least 15 rows the **upper bound is open (n/m)**: a venue cannot then be INFEASIBLE |  |  |

Approximations, stated once: the shares are over signals, assuming verification does not depend on how many signals a pair has within a band; the timestamp factor is by stratum,
not by market (the production gate is per market); the window factor uses the proxy until timestamps can be measured; the settled-trade statistics favour quick markets (plan §1).

## 4. The pre-approved stop rule (Part B4): `docs/phase4/stop_rule.json`
Committed with `"approved": false`. Every number is in the file. **Proposed**: a venue is **INFEASIBLE** when the **upper** bound of expected verified-executable eligible signals per day
is *strictly below* the number required at **25 % acceptance and a 15-point effect** (26.3/day at SD 89); **FEASIBLE** when the **lower** bound is *strictly above* the number
required at **50 % acceptance and a 10-point effect** (29.6/day at SD 89); **UNDETERMINED** otherwise, and whenever a bound is unknown. Reasoning: INFEASIBLE is judged on the
optimistic reading (more review could not change it), FEASIBLE on the pessimistic one; a venue is never declared infeasible on missing evidence.

`merge` prints a verdict **only if the file is valid and `"approved": true`**; otherwise it prints "UNDETERMINED: stop rule not approved" and the numbers. This code never sets `approved`.
**To approve:** edit the numbers if you want different ones, set `"approved": true` with your name and date, **commit**, and only then run `review-ingest`: the review results remember
the file's hash and its approval state at that moment, and `merge` withholds the verdict if the rule was unapproved then, or differs now (the goalposts cannot move afterwards;
re-ingesting is free and deterministic).

## 5. The human-verified sample (Part C) and the wallet share (Part D)
The procedure for the owner is [`REVIEW_GUIDE.md`](REVIEW_GUIDE.md). `review-sheet` draws 60 rows per venue (30 from similarity ≥ 0.50 spread over its three bands, 15 from 0.30 to 0.50,
15 random from < 0.30; seed `phase4-0d-review-v1`, the pool is the score ≥ 68 pairs searched without error; the sheet carries the populations so the ingest needs nothing else).
`review-ingest` validates (every row all four answers Y/N/U, `candidate_used` 1/2/3/F, F needs `found_url`, nothing edited), computes per band the confirmed∧proposed and any-confirmed
shares with Wilson intervals, the precision of the proposals, the false-negative rate of the < 0.30 stratum, and the extrapolation, and records the stop rule's stamp. **Nothing marks
anything verified except the owner's answers.**
`wallet-share` is **research: not a strategy change and not a recommendation**; everything it prints is **proposed, not verified**. For every wallet with signals in the window (all scores):
the share of its entry signals with a proposed candidate, overall and by category; the proposed signals per day; how many wallets have at least 25 % and 50 % (of those with enough
searched signals); the concentration of the proposed flow in the top 3 and top 10 wallets; whether the score ≥ 68 wallets differ from the rest; the share by category. Signals on pairs that
were not searched are **unknown, not zero**.

## 6. Part E: the 4.0c mutation survivors
G2 (display order of candidates), Q9 (near-miss range), U12 (an `ended` event counted as agreeing when only one of event and markets is resolved), U22 (targeted ENDED markets reach the
resolved side of the audit) and X2 (thin strata before informative ones) now each have a test that fails when the mutation is applied (`tests/phase4-weak-spots.test.ts`). U18 is an
equivalent mutation (the global gap enforces the floor) and is left as is.

## 7. Decisions D88 to D98 (the owner decides; none is taken here)
| # | Decision | Options and what is proposed |
|---|---|---|
| D88 | The stop-rule numbers in `stop_rule.json` | Proposed: INFEASIBLE when the upper bound is strictly below the requirement at 25 % acceptance and 15 points; FEASIBLE when the lower bound is strictly above it at 50 % and 10 points; Wilson z 1.96; eligible-like statistics from 100 settled trades; below-0.30 review of at least 15 rows to close a cut-off listing. Reasoning in §4. Approve or edit, **commit, then ingest** |
| D89 | The operational "proposed" rule: similarity ≥ 0.70 (the existing band score, `max(title, participants)`) with equal numbers and negations and a matching outcome, or an identifier match | Keep; or raise to 0.85 (the strict PROBABLE rule: fewer proposals, higher precision); or lower. The review measures the precision of whatever is chosen |
| D90 | TIME blocks verification until a machine-verified timestamp exists on both venues (the brief's rule, implemented) | Keep (nothing is "verified" until the S1a time fields pass; the owner's confirmations are still measured); or let the owner's TIME = Y suffice for the *precision* estimate only (already so) while the timestamp share carries the rest |
| D91 | Review design: 60 rows per venue, 30 / 15 / 15, seed fixed; who reviews; stratum C needs a manual venue search | Keep, or 30 rows per venue to save time (wider intervals); the owner estimates 3 to 4 hours per venue (an estimate, not measured) |
| D92 | The matrix multiplies per-factor bounds (wider than a joint interval) | Keep (conservative both ways); or a bootstrap over signals once there is data |
| D93 | The WINDOW upper bound is the date-level proxy and the TIMESTAMP factor is stratum-level | Keep until timestamps can be measured at market level; then replace both with the measured funnel |
| D94 | Heap budget 350 MB with garbage collected on demand (a run-time `--expose-gc`) | Keep; or set the budget per venue; or start the service with a higher `--max-old-space-size` (a production-environment change: not made here) |
| D95 | The US title search after the 403: run again with `--resume` at a slower pace (for example 2,500 ms), or ask the venue about its rate limit and terms first | The owner decides; this code never retries a refusal inside a run and never varies headers or origin |
| D96 | Run the title searches with `--all-scores` (needed by the wallet share and the all-scores block of the matrix): about 3,000 pairs; at 1.1 s per US request that is about 55 minutes | Approve; or keep the default (score ≥ 68 only) and skip the wallet share |
| D97 | Kalshi inventory: a request budget of 600 (about 5 minutes) gives exact events per category and status; markets per category are not available without paging through them | Accept; or authorise a bounded paging scan of `/markets` that counts and discards (about 350 requests per 350,000 markets at 1,000 per page): a larger load on the venue |
| D98 | Retention of the evidence files (the container is deleted) | Commit `v_*` files and the review results to `docs/phase4/data/` after each run; keep the titles files out of version control if their size (about 1 to 4 MB each) is a problem, and rerun instead |
