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

## Step 4.0b: new open decisions (continue from D72)

Nothing was measured by this step (no venue or database access); these are the choices the new measurements will present, with the options. The owner decides.

| # | Decision | Options |
|---|---|---|
| D73 | Event level as the unit of every S1a reliability rule, with a minimum of 30 distinct events (implemented as the brief asks; the thresholds are unchanged) | Confirm; or also choose how an event whose markets disagree on a field is treated (today: the first market represents it, no flag) |
| D74 | Eastern-time date placeholders (`ET_MIDNIGHT` / `ET_END_OF_DAY`) are date-only values for every purpose | Confirm; and whether a **date-level** time rule may exist at all. Options after the run: (a) V1 stays timestamp-only, with the flow `s1b_funnel.json` shows; (b) a date-level rule with the in-play check obtained elsewhere (the date alone cannot give it); (c) other venues or sources of start times |
| D75 | The date-level funnel row (not the V1 policy) and the diagnostic's timestamp-free PROBABLE are reporting only | Confirm: neither is an input to eligibility or to the feasibility table |
| D76 | Per-sport quota for the `gameStartTime` evidence: ≥ 100 markets from ≥ 30 distinct events | Keep; or lower for sports that cannot reach it, with the shortfall stated |
| D77 | The US query syntax for `categories` and `sportsMarketTypes` and the archived query | Set from `docs.polymarket.us` before the targeted run (`--us-targeted`, `--us-archived-query`); the defaults are guesses |
| D78 | Cross-venue participant matching without an alias list ("Man City" / "Manchester City" scores 0.33 and is not matched) | Accept the loss and read the matched/head-to-head counts; or add a small alias table per sport after the first run |
