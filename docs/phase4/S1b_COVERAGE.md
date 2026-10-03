# Phase 4.0 — Part C: S1b coverage probe and feasibility

**Status: method, libraries and script delivered and tested; the production measurements were NOT run.** This container had
no database access (no `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`) and no route to any venue (network policy,
see `S1a_TIMESTAMP_AUDIT.md` §1). The funnel counts, the mapping rate, the eligible flow per day and the feasibility table are
therefore **not measured** here. What is below the horizontal rule in §6 is **arithmetic on the plan's own numbers**, clearly
labelled, and is not a result of this step.

Plan reference: `docs/PHASE4_PLAN.md` §7 S1b, §3.2, §3.6, §13 D48/D52/D53. Code: `src/lib/phase4/{mapping,funnel,feasibility,stats,probe}.ts`,
`scripts/phase4/coverage-probe.ts`; tests `tests/phase4-{mapping,funnel,stats,scripts}.test.ts`.

## 1. What the script does

`npm run phase4:coverage` is **read-only** by construction: the database is reached only through `readOnly()` (`src/lib/phase4/readonly-db.ts`: `select` and nothing else, no `rpc`, no write method exists on the type);
the network only through `PoliteHttp` (public GET, ≤ 2 requests/second, a descriptive User-Agent, at most 3 attempts for transient errors, a refusal (401/403/451) is never retried and ends requests to that origin, no credentials possible).
`tests/phase4-scripts.test.ts` runs the whole script against a database that throws on every write method and every RPC.

Inputs, all selects:

| Table | Columns | Why |
|---|---|---|
| `signals` | `id, kind, wallet, condition_id, token_id, outcome, title, slug, price, created_at, evaluated_at, payload` where `kind` in the four entry kinds and `created_at` ∈ [27 Sep 2026 04:28:38 UTC, now) | the funnel; `payload.copyScore` is the score at signal time (GAP_REPORT §3) |
| `markets` | `condition_id, end_date` for the signals with score ≥ 68 | the date-level proxy and the signal-side date for PROBABLE matching |
| `paper_executions` | `signal_id, coverage_state, state, fill_ts, closed_at, net_pnl, filled_usd` for one mode (default REALISTIC) | settled paper trades for the feasibility table |

Network: the execution venue's open and closed market listings (up to 6,000 markets in total, `--us-max`; if either listing is cut off by the cap the run says so and every mapped count is a **lower bound**: the closed listing in particular may not contain the markets of older signals). If the venue is not configured, blocked, failing or returns nothing, every stage after the score stage is reported **not measured** (null), the feasibility table falls back to the labelled date-level proxy, and the run still ends with exit 0.

## 2. The funnel (brief's order; every stage is cumulative)

| # | Stage | Definition (as implemented) |
|---|---|---|
| 0 | all entry signals | `signals` of kind NEW_POSITION, CONSENSUS, CONVICTION_ADD, EARLY_ENTRY (`ENTRY_KINDS`) in the half-open window |
| 1 | copy score ≥ 68 | `payload.copyScore ≥ 68`; missing = below |
| 2 | market mapped | `EXACT` (a shared token id, or a shared condition id plus a matching outcome label). `PROBABLE` is counted in a **separate** funnel (`EXACT_PLUS_PROBABLE`) |
| 3 | venue market tradable | the venue market is open now, or resolved at/after the signal's evaluation time (a resolution-like field from the audit); unknown counts as not tradable. **Approximation**: current status applied to a past time |
| 4 | usable event timestamp | `resolveEventTime` under the S1a **recommended** fields for the candidate's stratum (§3.3: start if present and valid, else close; ambiguity and invalid values reject); no recommendation or an unusable value = **reject** |
| 5 | event not started | event time − evaluation time > 0 |
| 6 | within 24 h | ≤ 24:00:00 (exactly 24 h is eligible) |
| 7 | ≥ `MIN_LEAD` (300 s) of lead | = expected Grok-eligible, before Grok's acceptance |

Reported for each variant: counts; the average **per elapsed day** and, over **whole UTC days only**, the mean, minimum and maximum per day and by weekday (the two partial edge days are excluded from those, so a short window does not understate the minimum);
the cumulative count by signal kind and by category; wallets remaining per stage; the three wallets with the most final-stage signals and their share; where signals leave (first failing stage).

**Supplementary (not in the brief's order): E1.** Plan §3.2 E1 (`MAX_SIGNAL_AGE`, proposed 600 s) is not in the brief's funnel or in the plan's flow estimate (GAP_REPORT U8). `freshAtFinal` reports how many final-stage signals have an *observed* detection lag (`evaluated_at − created_at`) of at most 600 s, how many have an observed lag at all, and the per-day rate.

**Date-level proxy** (DB only, always computed): score ≥ 68 and the stored `markets.end_date` is the signal's UTC day or the next. It includes events that have already started and signals whose market is not on the venue; it is an upper bound and the number the plan's "about 110 a day" refers to.

## 3. Mapping (`src/lib/phase4/mapping.ts`)

| Level | Rule |
|---|---|
| `EXACT` | a shared **token id**; or a shared **condition id** *and* the signal's outcome label matches exactly one venue outcome |
| `PROBABLE` | no shared identifier (or an identifier whose outcome cannot be matched), but: normalised titles identical or Jaccard ≥ 0.85 on content tokens, **numbers equal** (Over 2.5 ≠ Over 3.5), **negations equal**, event dates known on both sides and within 1 UTC day, and the outcome matches exactly one venue outcome |
| `NONE` | anything else, including two different candidates qualifying equally (`ambiguous`, never an arbitrary pick) |

`verified` and `resolutionRulesVerified` are the literal `false` on every result, EXACT included: equivalence of resolution rules is a **human** check. `s1b_mapping_review.csv` exports up to 60 matched pairs (≥ 50 when that many exist), stratified by category, with titles, outcomes, times and URLs and two empty columns for the reviewer's verdict (`SAME_RULES / DIFFERENT / UNSURE`) and notes. Whether Polymarket's two venues share condition or token ids is **unknown here**: if they do not, everything is PROBABLE at best, and E2 (`MAPPING_UNVERIFIED`) rejects all of it until a human has reviewed each market.

## 4. Feasibility (`feasibility.ts`, `stats.ts`)

From settled paper trades (REALISTIC by default; `paper_executions` with `coverage_state = SIMULATED` and `state` RESOLVED or EXITED), return per trade = `net_pnl / filled_usd` in percentage points, holding time = `closed_at − fill_ts`.
Two subsets: **all settled**, and the **eligible-like proxy** (score ≥ 68 and a date-level end date on the signal's day or the next).

- per-trade mean and SD (n − 1); **market-clustering design effect** by one-way ANOVA: ρ = (MSB − MSW) / (MSB + (n₀ − 1) MSW), DEFF = 1 + (m − 1) ρ with m the size-weighted mean cluster size; ρ < 0 clamped to 0 (DEFF never < 1); not estimable with one cluster or all singletons (DEFF 1, noted);
- `MIN_SETTLED_PER_ARM = ⌈ 2 (z₍₁₋α/₂₎ + z₍power₎)² σ² DEFF / δ² ⌉` for δ = 10 and 15 points, α = 0.05 two-sided, power 80 % (`tests/phase4-stats.test.ts`: σ 89, δ 10, no clustering → **1,244** (the plan's "about 1,241"), checked independently with Python's `statistics.NormalDist`);
- expected days = settlement lag + per-arm / (eligible per day × settled share × min(accept, 1 − accept)) for acceptance 10 / 25 / 50 % and lag = median and 90th-percentile holding time, against `MAX_WINDOW` = 84 days: `feasibleWithinWindow`;
- **what would have to change**: the eligible rate per day needed to reach the sample inside the window (p90 lag), and the smallest effect detectable inside the window at the measured rate.

Approximations (printed in `s1b_feasibility.json`): settled-only trades favour quick markets; the eligible-like subset is a proxy; DEFF is applied to both arms; constant daily rate; acceptance independent of holding time. The eligible rate used is the venue funnel's final-stage mean over whole UTC days when the venue was measured, otherwise the proxy, and the basis is printed beside it.

## 5. How to run

```
npm run phase4:ts-audit -- --with-db   # first (S1a): produces docs/phase4/data/s1a_summary.json with the recommended time fields
npm run phase4:coverage                # then: needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (select only)
# options: --out-dir docs/phase4/data  --recommendations <path to s1a_summary.json>  --no-venue  --mode REALISTIC|IDEAL|CONSERVATIVE
#          --us-base URL --us-markets-path /v1/markets --us-open-query 'a=b' --us-closed-query 'a=b' --us-max 6000
#          --start 2026-09-27T04:28:38Z   (the clean regime of plan §1; must carry a time zone)
```
Prints ≤ 60 lines; files: `s1b_funnel.json`, `s1b_feasibility.json`, `s1b_mapping_review.csv` (and nothing else). Exit 0 finished (possibly partial), 1 failed, 2 database variables missing (the database is not touched).
Without `s1a_summary.json` the timestamp stage is reported not measured and only identifier matches can be found (PROBABLE needs a venue date).

## 6. Results

*Update (4.0b): the owner ran the scripts on production infrastructure on 3 Oct 2026 and reported findings; those result files are not committed here, so this page still shows no measured value. Section 8 below describes the method added in response.*

**Not measured in this step.** The fields below are what the run will fill.

| Item | Value |
|---|---|
| Entry signals / score ≥ 68 / mapped (EXACT) / mapped (PROBABLE) / tradable / usable timestamp / not started / ≤ 24 h / ≥ MIN_LEAD | *not measured* |
| Expected Grok-eligible signals per day (average, min–max over whole days, by weekday) | *not measured* |
| Wallets remaining; top-3 wallet share | *not measured* |
| SD of per-trade return; DEFF; settled trades; markets; wallets | *not measured* (plan §1 states SD 89, 1,990 trades, 702 markets, 103 wallets: not re-verified) |
| `MIN_SETTLED_PER_ARM` at 10 / 15 points (measured SD and DEFF) | *not measured* |
| Days to the sample; feasible within 84 days? | *not measured* |

---

### Arithmetic on the plan's own inputs (NOT measurements by this step)

Inputs: SD 89 points (plan §1); eligible flow per day: the plan's "about 110 a day" is a **date-level proxy and an upper bound** (before the in-play rule, mapping, tradability, lead time and Grok), so 25 and 50 are shown too; DEFF is unknown and shown at 1, 1.5, 2. Days **exclude the settlement lag**, which must be added (median and p90 holding time are measured by the script).
Formula as above (`daysToSample`); sample sizes recomputed with the same code and checked independently.

| Effect | DEFF | Per arm | Days at 25 / day: accept 10 % · 25 % · 50 % | at 50 / day | at 110 / day |
|---|---|---|---|---|---|
| 10 pts | 1.0 | 1,244 | 498 · 199 · 100 | 249 · 100 · 50 | 113 · 45 · 23 |
| 10 pts | 1.5 | 1,866 | 746 · 299 · 149 | 373 · 149 · 75 | 170 · 68 · 34 |
| 10 pts | 2.0 | 2,487 | 995 · 398 · 199 | 497 · 199 · 99 | 226 · 90 · 45 |
| 15 pts | 1.0 | 553 | 221 · 88 · 44 | 111 · 44 · 22 | 50 · 20 · 10 |
| 15 pts | 1.5 | 829 | 332 · 133 · 66 | 166 · 66 · 33 | 75 · 30 · 15 |
| 15 pts | 2.0 | 1,106 | 442 · 177 · 88 | 221 · 88 · 44 | 101 · 40 · 20 |

Eligible signals per day needed to reach the sample **inside 84 days with zero lag**: at 10 points and DEFF 1 / 1.5 / 2: 148 / 222 / 296 (accept 10 %), **59 / 89 / 118 (accept 25 %)**, 30 / 44 / 59 (accept 50 %); at 15 points: 66 / 99 / 132 · 26 / 40 / 53 · 13 / 20 / 26.

Reading it (conditional on those inputs, not a finding): at 110 a day, 10 points, DEFF 1.5 and acceptance 25 % the sample takes 68 days **plus the settlement lag**, so the 84-day window leaves a lag budget of 16 days; if the later funnel stages (mapping, tradability, lead time, `MAX_SIGNAL_AGE`) leave less than about 81 % of the 110 (89 needed at those settings), the window is not reached; at acceptance 10 % it is not reached even at 110. If the measured numbers look like that, then before a lock one of these would have to change: widen eligibility (more markets, more venues, drop the 24 h limit), extend `MAX_WINDOW`, accept a larger minimum effect (15 points roughly halves the need), or evaluate on something with lower variance than per-trade return. §7 S2's feasibility rule exists for exactly this; the probe replaces the plan's inputs by measured ones.

## 7. Ambiguities and the cheapest test

| Ambiguity | Cheapest test |
|---|---|
| Do the two venues share condition or token ids (so EXACT is possible)? | `mappingBuckets.EXACT` in `s1b_funnel.json` after one run; or print one US market object |
| Is "venue market tradable" for past signals meaningful? | Compare the funnel at stage 3 over a window of the last day only (`--start <yesterday>`) with the full window |
| How wrong is the category heuristic? | Hand-label 50 signals from `s1b_mapping_review.csv`'s category column |
| Does the settlement lag of settled trades understate the real lag (selection)? | Compare the median hold of settled trades with the age of still-open trades in the same window (a one-line query on `paper_executions`) |
| Is the eligible-like proxy close to the venue-measured eligible flow? | Both are printed side by side by the same run |

## 8. Step 4.0b: why did nothing map? (`--diagnose`)

The first production run (3 Oct 2026, reported by the owner) found 1,181 entry signals with score ≥ 68 and **0 mapped** (EXACT 0, PROBABLE 0; 727 distinct market+outcome pairs NONE), the venue's open and closed listings each cut off at 3,000 markets, and no review pairs. A zero can be a true absence of overlap or a constraint of the matcher (the strict PROBABLE needs a date on both sides and there was almost no usable venue timestamp). This step adds a diagnostic that **does not need a timestamp**. It makes no policy: it shows what overlaps.

```
npm run phase4:coverage -- --diagnose --print-files s1b_diagnostic.json,s1b_funnel.json,s1b_mapping_diagnostic.csv
# --diagnose            full venue listing (pages until it ends, ≤ 2 requests/second), the timestamp-free matcher, s1b_diagnostic.json, s1b_mapping_diagnostic.csv
# --us-max N            an explicit cap, also in diagnostic mode (the cut-off is then reported as a lower bound)
# --us-archived-query   query string for archived markets (UNVERIFIED default "archived=true"; "none" skips it)
# --diagnostic-sample N sample size for the CSV (default 100)
```

### 8.1 Full listing and totals
Without a cap the open, closed and (if the query works) archived listings are fetched until the venue's listing ends. `s1b_diagnostic.json` records, per list and overall: markets, distinct events, counts **by the venue's own status**, by our category heuristic, and by the venue's own category/tag labels (`categories`, `tags`, event tags). Without `--diagnose` the cap is unchanged (6,000 in total).

### 8.2 The diagnostic matcher (probe only; `diagnoseSignal` in `mapping.ts`)
Candidates are generated **without any timestamp**: shared identifiers (condition id, token id, slug, event slug) and the venue markets sharing the most content tokens with the title (at most 60, ties broken by market id). For each candidate: title similarity, participant similarity (home/away order ignored), whether numbers and negations agree, outcome match, category match and identifier match. The label is **`PROBABLE` or `NONE` only**: PROBABLE here means an identifier match, or title similarity ≥ 0.85 with equal numbers and negations and a matching outcome, **with no date checked** (`dateChecked` is the literal `false`); never `EXACT`, never verified. The funnel's own PROBABLE definition (dates within a day on both sides) is **unchanged**; nothing was loosened to produce a number. A pair is also flagged `sameParticipants` when the teams match but the title does not (same game, different market type).
For the 727-style set (every market+outcome behind a score ≥ 68 signal) the file reports the **number of pairs by best-candidate similarity band** (≥ 0.90, 0.70–0.90, 0.50–0.70, 0.30–0.50, < 0.30), the number of candidates generated in each band, how many pairs are PROBABLE / identifier matches / same participants (and of those how many differ in title), how often the best candidate has the same category, and the same table by our category.

### 8.3 To judge by eye: `s1b_mapping_diagnostic.csv` and the category mix
A **stratified random sample of 100 of our signal markets** (strata: our category × score ≥ 68 or not; reproducible: seeded by the window start), each with our title, outcome and slug, and its **nearest 3 venue titles** with title and participant similarity, the venue's category and market id/url, and empty reviewer columns. `s1b_diagnostic.json` also holds the **category mix of our flow versus the venue's listing** (share of all signals, of score ≥ 68 signals and of distinct markets, against the venue's share, open/closed): for example short-term crypto "up or down" markets against what the venue lists.

### 8.4 A second funnel line, not the V1 policy (`funnel.dateLevel`)
In `s1b_funnel.json` and the summary: all → score → mapped → tradable → **an Eastern calendar date is implied by a placeholder or date-only close-like field of the mapped venue market** → **that date is the evaluation's Eastern date or the next**. Labelled `NOT THE V1 POLICY`; the in-play check and the lead time are marked **cannot be evaluated at date level**; reported per day like the V1 funnel, in both variants (EXACT; EXACT + PROBABLE). It is **never** an input to the feasibility table (the eligible rate there still comes from the V1 funnel or the labelled proxy; `tests/phase4-scripts.test.ts` pins this).
To let the strict matcher compare dates when no timestamp field is recommended, the candidate's date is taken from the recommended field if there is one, else from a close-like field (the Eastern date it implies, or the Eastern date of a real close time). The rule itself, a date within one day on both sides, is unchanged, and the matched candidates are counted by how their date was obtained (`dateBasis`: `implied`, `close_date`, `none`).

### 8.5 If a mapping cannot be established
Then the result is stated as it is: the best-band table, the category mix and the CSV are the evidence (for example most pairs in the lowest band and a category mix with little overlap). Nothing in the code produces a number by relaxing a rule; PROBABLE is never reported as a mapping. Whether anything can be done about it is the owner's decision.

### 8.6 Not measured by the step that wrote this
No venue or database was reachable: every number above is to be produced by the run. The tests (`tests/phase4-diagnose.test.ts`, `tests/phase4-scripts.test.ts`) run the whole path on fixtures with hand-derived answers, including a zero listing, a 7,000-market listing, an explicit cap and a database that throws on any write.

## 9. Step 4.0c: Kalshi funnel, title search for every pair, one category table

Nothing here was measured by the step that wrote it; the tests run every path on fixtures with hand-derived answers.

### 9.1 The Kalshi funnel (`--kalshi`)
`src/lib/phase4/venue-funnel.ts`. The same stages, in the same order, from the **same signal window** as the US run (the combined command passes the US run's end to the Kalshi run), with the same caveats printed. Differences that are facts of the venue, not choices:
- **Kalshi shares no identifier with Polymarket**, so `EXACT` is structurally 0 and only `PROBABLE` (title ≥ 0.85, equal numbers and negations, dates within one day, the outcome label among the market's labels: `Yes`, `No`, `yes_sub_title`, `no_sub_title`) can map. Read the `EXACT+PROBABLE` column; PROBABLE is never verified.
- **Tradable at the signal's evaluation time** = opened (`open_time` ≤ evaluation) and not closed (evaluation < `close_time`); an open market with no close time counts as tradable; otherwise unknown (a reject once measured). Resolution-like fields (`expected_expiration_time`, `latest_expiration_time`) are never consulted.
- **Event time** from the S1a recommendations for Kalshi (`s1a_summary.json`, venue `kalshi`) through the same §3.3 pipeline; without them the timestamp and later stages are `n/m`, and PROBABLE falls back to a close-like date.
- A listing cut off at the cap (`--kalshi-max`, default 40,000) is reported: mapped counts are a lower bound.
Outputs: `s1b_funnel_kalshi.json`, `s1b_mapping_review_kalshi.csv`. The combined run prints one summary of ≤ 60 lines: both funnels side by side, the mapping and timestamp-free diagnostic lines, the Kalshi listing counts, and the table of 9.3.

### 9.2 Title search for every pair (`npm run phase4:title-search`)
`src/lib/phase4/title-search.ts`. The 4.0b diagnostic compared titles with a **sample** of each listing; this asks the venue. For each distinct market+outcome pair behind our entry signals with score ≥ 68 (all scores with `--all-scores`, after the high-score ones, while the budget lasts) a **short normalised query** is built (head-to-head titles become the two sides only; other titles keep their first distinct content words, numbers included; a name outcome is added; ≤ 80 characters) and sent to:
- the **US exchange**'s documented `GET /v1/search?query=…&limit=10` (the response shape is unverified, so events and markets are both read), paced at its documented 60 requests per minute (~740 queries ≈ 14 minutes);
- **Kalshi**: no free-text market search appears in the published documentation as far as the summaries show (not verified), so the lookup is in the **complete bounded listing** fetched in Part A (`mode: "listing"`, stated in the output); where that listing was cut off, its result is a lower bound.
Candidates are scored with the existing similarity function (`diagnoseCandidates`); bands ≥ 0.90, 0.70–0.90, 0.50–0.70, 0.30–0.50, < 0.30; how many pairs return any candidate; `PROBABLE` keeps its definition (no date is checked: `dateChecked` is the literal false; nothing is verified). A **hard total-request budget** (`--search-max-requests`, default 2,000) stops the run with a message naming how many pairs were searched and how many were not; a refusal (401/403/451) ends that venue's search at once, no workaround. Outputs: `s1b_title_search_<venue>.csv` (our title, outcome, stratum, score, signals, wallet, the query, band, label, candidates returned, the best three candidates with similarity, category and id), `s1b_title_search_summary.json`; the console shows the 15 best matches and the 10 near-misses per venue (≤ 60 lines in all) so the owner can judge by eye.

### 9.3 One category table
Our score ≥ 68 flow, the Kalshi listing and the US-exchange listing by stratum in one table (counts and shares, each side over its own total; `n/m` where a listing was not fetched). The US column needs `--diagnose` (it uses that run's listing totals). Strata are our keyword heuristic over Kalshi's event category, title and ticker words (an esports title filed under "Sports" is recognised); its error rate is unmeasured.

### 9.4 Running it
```
npm run phase4:coverage -- --diagnose --kalshi --print-files S1_COMPACT.md
npm run phase4:title-search -- --print-files s1b_title_search_summary.json
```
