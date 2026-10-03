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
