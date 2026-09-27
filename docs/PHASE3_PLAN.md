# Phase 3 — portfolio / risk layer: audit and plan

Status: **READY** (decisions D1–D4 approved 2026-09-26; D4 revised after review the same day; review 2 added B11 rehydration, the per-field rewind point and the D4 completion instant). Not implemented yet. Audited against `main` at `faecce7`.

## Measured on production (read-only, 2026-09-26)

| Measure | Value |
|---|---|
| Signals, 18–26 Sep | 41,467 (~4,790/day, **bot-inflated**) |
| Entry signals from wallets now classified as high-frequency bots | 30,595 of 39,881 (77%) |
| Signal rate after the bot filter (26 Sep 12:15 UTC) | 619 in 9.1 h ≈ **1,630/day** — the planning rate |
| Entry signals by kind | CONSENSUS 18,133 (45%) · NEW_POSITION 11,149 · CONVICTION_ADD 10,560 (26%) · EARLY_ENTRY 20 |
| CONSENSUS on a token that already had a signal | 9,216 |
| Resolution discovery lag (`settled_at − resolved_at`) | median 42 h, p90 154 h |
| Settled ledger rows carrying on-chain `resolved_at` | 5,074 of 5,074 |
| REALISTIC rows rewritten in one hour (mostly new marks on open lots) | 1,423 (503 open) |
| REALISTIC positions open on tokens nothing checks for resolution | 544 |
| Distinct fills sharing the old `sourceKey` | 25 of 3,739 with a fill id (0.7%) |
| Longest detection delay (`evaluated_at − created_at`) | 171 h |
| `paper_portfolio_runs` rows / production callers of `simulatePortfolio` | 0 / none (tests only) |

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| D1 | CONVICTION_ADD / CONSENSUS on a held position | Separate lot per signal (existing tested rule). Limited by wallet, market and total caps; each lot closes on its own wallet's EXIT. Signals from the same fill share one lot, credited to the first kind in event order (NEW_POSITION before CONSENSUS) — so portfolio-level CONSENSUS attribution is understated; the duplicate is recorded as `REJECTED_DUPLICATE_POSITION` and reported per kind. |
| D2 | When a resolution frees capital | On-chain `resolved_at`. Late discoveries rewind to a checkpoint and replay. |
| D3 | Resolutions for tokens nobody watches | Approved: new `resolve-orphans.ts` + a union in the `token_resolutions` view; `mark.ts` untouched. Report the Phase 2 before/after. |
| D4 | Portfolio start | **The first successful worker re-score on 27 Sep 2026** (scheduled 04:15 UTC; the exact instant is the **completion** of that run, `cursors['refresh:last'].updated_at`. Its `value` is the run's *start*: on 26 Sep that was 04:24:51 against a completion at 04:26:41, and the new watchlist only applies after completion). Earlier signals are excluded: 77% came from wallets now filtered as bots, and the watchlist changes at that re-score. No retroactive bot filter is applied to older history (that would use today's classification in the past). `start_ts` is part of `portfolio_id`. |
| D5 | `PAPER_PORTFOLIO_CONFIG` values | Operator's choice, no defaults. Needed only to switch the feature on. |

## Decisions raised by step 3 (open)

| # | Finding | Measured | Options | Recommendation |
|---|---|---|---|---|
| D6 | Neg-risk markets settled by UMA: `/v2/resolutions` says resolved but gives no payouts and no `resolved_at`. Under D2 they never settle. | 116 of 329 orphan tokens; Gamma's `umaEndDate` is within 30 s (median) / 76 s (p90) of the v2 row's `last_update_timestamp` | (a) keep D2 strict; (b) accept Gamma's final prices with `umaEndDate` as the resolution time when `umaResolutionStatus = resolved` | (b): the time is independently confirmed by v2 to within a minute, and without it 35% of orphan tokens (and those markets in Phase 3) never release capital |
| D7 | 648 entry signals from 18–20 Sep have execution records but no ledger row, so the sweep never recomputes them: their stored Phase 2 results are frozen. | 648 signals; 991 open positions across modes | (a) backfill ledger rows (their `evaluated_at` is null, so REALISTIC latency would come from the backfill time: wrong); (b) exclude them from Phase 2 reports; (c) leave as is, documented | (b): they cannot be recomputed honestly. Phase 3 is unaffected (it starts 27 Sep) |
| D8 | The marker has the same token-order gap as the orphans: Gamma omits closed markets unless asked, and 81% of conditions with OPEN ledger rows have no cached token order. | 8,378 of 10,333 conditions; 1,457 `resolution_unparseable` issues logged | (a) leave `mark.ts` alone; (b) a worker warm-up that runs `ensureTokenOrder` for OPEN ledger conditions (no change to `mark.ts`) | (b): same helper, no marker code change; settles ledger positions the marker currently cannot |
| D9 | About 2% of signals carry an empty condition id, or one ending in 30+ zeros (the token id converted to a float and printed as hex). They can never be looked up. | 196 empty + 912 zero-tailed signals, 31 in the last 24 h; 4,690 fills from both websocket and REST | (a) reject at ingestion (`explainFill`); (b) accept and repair the condition id from Gamma by token id | Investigate the payload first; then (b) if Gamma maps the token, else (a) |
| D10 | The reference records a resized order that then goes unfilled for a reason other than liquidity (e.g. no ask below $1) as outcome `UNFILLED` with reason `REJECTED_BELOW_MIN_ORDER`, a mislabel. The book copies it so the two agree exactly. | Only with `allowResize: true` | (a) keep; (b) fix in both, so the reason is `REJECTED_BELOW_MIN_ORDER` only when the outcome is `REJECTED` | (b), in one small change to both files with the parity test unchanged **Decided 2026-09-27: (b) fix the label in both the book and the reference, in one change — **to be done in step 8**.** |
| D11 | `LOCKED_UNRESOLVED` (plan §F): open lots 30+ days old with no resolution. Step 7 derives it in the report (count, cost locked, oldest); `portfolio_lots.locked_unresolved` stays `false`. | Report-side only | (a) keep it derived in the report; (b) the runner maintains the column (a write per lot as it ages, outside the replay's diff writes, so it would break "an unchanged run writes nothing") | (a): the report computes it exactly as of the watermark at no write cost; drop or repurpose the column later **Decided 2026-09-27: (a) keep it derived in the report; `portfolio_lots.locked_unresolved` stays unmaintained.** |
| D12 | The runner's watermark is the last fully decided entry second, so exits and resolutions after the latest entry wait for the next entry (raised in step 6). | Lag ≤ the gap between signals | (a) keep; (b) advance to "now" (every late sweep row then forces a rewind) | (a) **Decided 2026-09-27: (a) keep the watermark at the last fully decided entry second.** |
| D13 | Inputs of a decided signal whose Phase 2 record is `sim_terminal` and whose lot is closed or never filled are not re-examined (as in Phase 2) (raised in step 6). | — | (a) accept; (b) a read-only fingerprint audit in the step 10 dry run | (a) + (b) **Decided 2026-09-27: (a) accept, plus (b) a read-only fingerprint audit in the step 10 dry run.** |
| D14 | Accept the two `book.ts` fixes made in step 6 (`relink` with an applied-but-empty exit; a lot emitted after its exit is linked). Decision rules and parity unchanged. | — | accept / revert | accept **Decided 2026-09-27: accept the two `book.ts` fixes from step 6.** |
| D15 | `portfolio_report` follows the `0007` report functions: security invoker, executable by any role. Through the anon key RLS hides `portfolio_runs`, so the report comes back with no watermark (nothing decided); the worker (service role) sees everything. | — | (a) keep (dashboard reads the `paper:portfolio` snapshot, not the function); (b) revoke from anon/authenticated like the lease functions | (b) if the function is never meant for the browser; (a) otherwise **Decided 2026-09-27: (b) revoke `portfolio_report` and `portfolio_pending_ahead` from anon/authenticated (service role only), in a new additive migration — **to be done in step 8**.** |

## A. Current architecture

- **Execution (Phase 2/2.5):** the worker runs `runSimulation` every 15 min: `processBacklog` (prices), then the batched `sweepSimulation`. One `paper_executions` row per signal per mode (`fill_ts`, `exit_fill_ts`, `resolution_ts`, `coverage_state`), rewritten only when inputs change. Every position is $100 and independent; no capital limit.
- **`sim/portfolio.ts`:** pure, tested (G–L, O, S in `phase2.test.ts`). Takes the whole signal list in memory, orders events with a heap by `(ts, KIND_ORDER, id)`, one lot per accepted signal, de-duplicates on `sourceKey = wallet|token|sourceTs|price`. Writes nothing.
- **Exit and resolution linkage:** `buildSignals` links each entry to the first later EXIT by the same wallet on the same token. Resolutions come from `token_resolutions`, which only holds ledger rows the marker settled; the marker only checks `OPEN` rows.
- **Placeholders:** `PortfolioConfig` / `portfolioConfigFromEnv` (no defaults); `paper_portfolio_runs` (one unbounded JSON per mode, never written); `/execution` shows "Deferred to Phase 3"; `run.ts` hard-codes `portfolioConfigured: false`.

## B. Proposed architecture

A deterministic, streaming replay per `(mode, portfolio config)`, with checkpoints.

1. **Source.** Stream `paper_executions` for one mode with `fill_ts >= start_ts`, in keyset order `(fill_ts, signal_id)`. No reorder buffer is needed: in REALISTIC and CONSERVATIVE a late signal's fill time is set after its detection, so it arrives at the frontier. (IDEAL is the exception — see B10.) Per 500-row batch, reuse `loadBatchInputs` + `buildSignals`, then **re-run `simulateEntry` / `simulateExit` at the portfolio's size** (stored P&L is at $100 and cap, impact, minimum order and fees depend on size). Fill times don't depend on size, so every needed price is already queued by the sweep. The portfolio decides entries and exits from these inputs itself, not from the stored record's status.
2. **Restarts and change detection.** State is derived. The sweep rewrites a record whenever its latest mark or unrealised P&L changes, which does not affect any portfolio decision. So each run reads only rows with `computed_at` after the last run (bounded by recent activity), computes an **input hash over decision fields only** — entry status/fill inputs, linked exit, `exit_fill_ts`, resolution value and `resolution_ts`, coverage state; never `mark_*` or `unrealized_pnl` — and compares it with the `input_hash` stored on `portfolio_decisions`. The rewind point is the earliest *changed event* among rows whose input hash changed: entry inputs → `fill_ts`; exit → the earlier of the old and new `exit_fill_ts`; resolution → the earlier of the old and new `resolution_ts` (not the entry's `fill_ts`, which would rewind every lot to its opening). The run loads the checkpoint at or before that point, rehydrates it (B11) and replays. `sim/run.ts` is not modified.
3. **Frontier (per event).** The frontier is the earliest event whose own inputs are missing: an entry whose entry price is not yet fetched, or an exit whose exit price is not yet fetched. A pending *exit* blocks only events after `exit_fill_ts`; it does not hold back entries in between. (The sweep marks a whole signal `PENDING_DATA` when either price is missing, so the stored coverage state alone is not used for this.) Nothing at or after the frontier is decided.
4. **Memory.** Batch ≤ 500; open lots ≤ `maxOpenPositions`; heap holds only scheduled exits/resolutions.
5. **Requests.** Each entry signal → `PortfolioRequest`. Duplicate key = `source_fill_id` when present, else the old `sourceKey`.
6. **Cash/exposure.** As `simulatePortfolio`: fill → cash −(`filledUsd` + fee), exposure +`filledUsd` at cost; partial fills book only the filled part; non-fills book nothing; resized below minimum → `REJECTED_BELOW_MIN_ORDER`.
7. **Capital release.** EXIT at `exit_fill_ts` via `simulateExit` (cash +proceeds − fee; unsold shares stay open). Resolution at `resolved_at` (cash +shares × payout, no fee). Never-resolving markets keep capital locked, reported separately.
8. **Idempotency.** `portfolio_id = hash(mode, execConfigHash, portfolioConfigHash, startTs)`; rows keyed `(portfolio_id, signal_id)`; record-hash diff writes; deterministic replay; DB lease against concurrent workers.
9. **Ordering.** `(event_ts, KIND_ORDER, signal_id)`: RESOLUTION → EXIT → NEW_POSITION → EARLY_ENTRY → CONVICTION_ADD → CONSENSUS; insertion counter for events scheduled mid-replay.
10. **IDEAL is not causal.** IDEAL fills at the source trade time, so its portfolio spends capital on signals before they could have been known (up to 171 h early), and a late-detected signal forces a rewind to its source time. The IDEAL portfolio is a baseline for comparison only, labelled as such; it is not a strategy that could have been run.
11. **Checkpoint rehydration (review 2).** Two paths can otherwise hide an exit or resolution from a lot restored from a checkpoint: (a) a checkpoint only holds the exit/resolution events known when it was written, and B2 rewinds to the changed event, which is usually *after* the checkpoint; (b) the sweep marks a signal `sim_terminal` once its **$100** record is EXITED or RESOLVED and never recomputes it, but a portfolio lot of a different size can still hold shares (a larger order hits the exit liquidity cap where $100 did not), so its later resolution never shows as a changed row. Measured today at $100: 0 such rows; at larger portfolio sizes it is expected to be non-zero. Rule: after loading any checkpoint, every open lot in it (≤ `maxOpenPositions`) is re-linked to its current exit and resolution from source data, ignoring `sim_terminal`, and those events are scheduled. If any re-linked event is earlier than the checkpoint, the run falls back to the latest checkpoint before that event.

## C. Files to add

- `src/lib/paper/portfolio/types.ts`: `PortfolioDefinition`, `PortfolioRequest`, `PortfolioDecision`, `PortfolioLot`, `PortfolioState`, `Checkpoint`, `PortfolioEvent`
- `src/lib/paper/portfolio/book.ts`: pure step-wise `PortfolioBook` (request / exit / resolve / snapshot / restore), same rules as `simulatePortfolio`
- `src/lib/paper/portfolio/requests.ts`: `BuiltSignal` → request, `source_fill_id` duplicate key
- `src/lib/paper/portfolio/config.ts`: wraps `portfolioConfigFromEnv`, range checks, start time, `portfolioId`
- `src/lib/paper/portfolio/run.ts`: lease, change detection, checkpoint load, streaming replay, frontier, diff writes, checkpoints, snapshot
- `src/lib/paper/resolve-orphans.ts` (D3)
- `supabase/migrations/0008_portfolio.sql`
- `tests/phase3.test.ts`; additions to `tests/sql.test.ts`
- `docs/PORTFOLIO.md`

## D. Files to modify (additive only)

- `worker/ws-listener.ts`: call `runPortfolios` after `runSimulation` when `PAPER_PORTFOLIO_CONFIG` is set.
- `src/app/execution/page.tsx`: replace the "Deferred to Phase 3" block.
- `docs/PAPER_EXECUTION.md`, `README.md`: links, REJECTED states.

**Do not modify:** `signals/*`, `polymarket/*`, `scoring/*`, `sim/execute.ts`, `sim/config.ts` (frozen `MODES`), `sim/run.ts`, `sim/report.ts`, `sim/portfolio.ts` (kept as the test reference), `paper/mark.ts`, `paper/ledger.ts`, migrations `0001`–`0007`.

## E. Migration 0008 (additive)

- `portfolios(id pk, mode, exec_config_hash, config jsonb, config_hash, start_ts, status)`
- `portfolio_runs(portfolio_id pk, lease_until, last_run_started_at, last_watermark, stats)` + `claim_portfolio_lease()` (service role only)
- `portfolio_checkpoints(pk portfolio_id, watermark_ts, watermark_key; state jsonb, built_at)`: hourly for 10 days, daily after
- `portfolio_decisions(pk portfolio_id, signal_id; outcome, reason, requested/filled usd, fill price, fee, resized, source_key, event_ts, input_hash, record_hash)` — `input_hash` covers decision inputs only (B2)
- `portfolio_lots(pk portfolio_id, signal_id; wallet, token, condition, open shares/cost, `exit_signal_id` and exit details, resolution details, state, realised P&L, closed_ts, record_hash)` — `exit_signal_id` lets rehydration (B11) see when a lot's linked exit changes
- `portfolio_equity(pk portfolio_id, ts, seq; cash, exposure, equity)`
- Indexes on `paper_executions`: `(mode, fill_ts, signal_id)`, `(mode, computed_at)`
- `portfolio_report(portfolio_id)` SQL function (JS parity test) — **moved to migration `0010` in step 7**, where the JS report it must match exists (`0009` is the orphan resolver, step 3)
- D3: `token_resolution_obs` table + `create or replace view token_resolutions` with a union
- `paper_portfolio_runs` left as is. RLS: public read on report tables; leases/checkpoints service role only.

## F. State machine

- **Request:** `RECEIVED` → `PENDING_DATA` → `REJECTED(reason)` | `NOT_FILLED(UNFILLED/EXPIRED/INVALID/UNKNOWN)` | `FILLED` / `PARTIALLY_FILLED` → lot
- **Lot:** `OPEN` → `PARTIALLY_EXITED` → `EXITED` | `RESOLVED`; `OPEN` → `RESOLVED`; after 30 days flagged `LOCKED_UNRESOLVED` (label only, capital stays committed)
- **Run:** `IDLE` → `LEASED` → `REPLAYING` → `WRITING` → `CHECKPOINTED` → `IDLE`; on error release the lease, write no checkpoint

## G. Event flow

Every 15 min: `runSimulation` → `resolveOrphans` → per mode: lease → earliest changed event → checkpoint → stream `(fill_ts, signal_id)` in 500s up to the frontier → per batch `loadBatchInputs` + `buildSignals` → requests → apply due exits/resolutions, then entries → diff writes → checkpoints → report into `cursors['paper:portfolio']` → `/execution`.

## H. Tests

Existing 211 tests untouched (especially G–L, O, S; `phase25`; `sql`; `fixes`). New:

1. `PortfolioBook` equals `simulatePortfolio` on random inputs, all 3 modes. The reference de-duplicates on `sourceKey`, so parity inputs carry no `source_fill_id` (or both use the same key); the fill-id rule is covered by test 7
2. Stop, save, restore at any event = uninterrupted run
3. Late resolution → correct rollback = fresh full replay
4. Late signals and late prices → same rollback
5. Nothing past the frontier is decided; a pending exit does not block entries between the entry and the exit
5a. A mark-only change (new 1h/6h/24h mark, unrealised P&L) causes no rewind and no writes; a change to an exit or resolution rewinds to exactly that event
6. Second run writes zero rows; lease blocks concurrent writers
7. Same fill across NEW_POSITION + CONSENSUS → one lot; distinct fills sharing old key → two lots
8. D1 stacking; each lot exits on its own wallet's EXIT
9. Capital release on full/partial exit and resolution; locked when unresolved
10. Deterministic ties in the same second
11. Bounded memory at 100,000 events (stress DB)
12. Real Postgres: `portfolio_report` parity, lease exclusivity, orphan view union
13. Config validation; config change → new id; unset → feature off
14. Start boundary: signals with `fill_ts < start_ts` are never requested; `start_ts` taken from the 27 Sep re-score; a different start → a different `portfolio_id`
15. IDEAL is reported as a non-causal baseline (label present in the report)
16. Rehydration: a lot restored from a checkpoint receives an exit and a resolution that arrived after the checkpoint, including one whose $100 record is `sim_terminal`; a re-linked event earlier than the checkpoint forces an earlier checkpoint; every case equals a fresh full replay

## I. Risks

| Risk | Handling |
|---|---|
| R1 resolution gap (544 lots) | D3 |
| R2 late resolutions (42 h median) → 2–7 day rewinds; IDEAL late signals up to 171 h | checkpoints; full replay if older than oldest checkpoint. Mark-only rewrites never rewind (B2) |
| R3 stacking dominates results (71% of entries, measured on bot-inflated history; re-measure after 27 Sep) | D1 |
| R4 wrong duplicates (0.7%) | `source_fill_id` |
| R5 replay cost (~1,630 signals/day × 3 modes after the bot filter) | streaming + checkpoints; re-check at 30 days |
| R6 DB size (~5k decision rows/day, ~450k in 90 days, plus lots and equity) | downsample equity to hourly after 7 days; Supabase Pro already in place |
| R9 regime changes (bot filter 26 Sep; rescore 27 Sep) | D4 starts after both; later scoring changes are recorded with their date in `docs/PORTFOLIO.md` |
| R7 no default config | off until D5 |
| R8 equity basis | keep cost basis for limits; report market value separately |

## J. Implementation order

1. Decisions — done (D4 revised: start at the 27 Sep re-score).
2. Migration `0008` + SQL tests (**3.1**; `portfolio_report` deferred to `0010`, step 7). **Done** — `supabase/migrations/0008_portfolio.sql`; 6 real-Postgres tests in `tests/sql.test.ts` (schema, RLS and grants, ordered index walk, lease exclusivity under 8 concurrent claimants, `token_resolutions` union and conflicts, constraints, cascade).
3. Orphan resolver + view union + tests; re-run the sweep and report the Phase 2 before/after. **Done** — `supabase/migrations/0009_orphan_resolutions.sql` (candidate function + check log), `src/lib/paper/resolve-orphans.ts` (runs before every sweep in the worker), `src/lib/polymarket/token-order.ts` (finds closed markets), read-only `scripts/orphan-impact.ts`; report in `docs/reports/2026-09-26-orphan-resolution-impact.md`. Findings D6–D9 below.
4. Pure `PortfolioBook` + parity, restore and tie tests. **Done** — `src/lib/paper/portfolio/{types,book}.ts`. Equals `simulatePortfolio` exactly (decisions, equity curve, totals) in all 3 modes × 5 limit profiles; resumes exactly from a JSON checkpoint taken at any event; `relink()` implements B11 and returns the time to rewind to when an event is already in the past. Two notes for step 6: the book orders ties by code unit (the reference uses `localeCompare`; identical for lower-case uuids), and the database stream orders by `(fill_ts, signal_id)` without the kind, so the runner must sort rows that share a `fill_ts` by `(kind order, signal id)` before submitting them.
5. `requests.ts` + tests. **Done** — `src/lib/paper/portfolio/requests.ts`: `buildRequests` (same price observations as `simulateMode`, checked per signal in all 3 modes; duplicate key `fill:<source_fill_id>` else the legacy key; start boundary), `orderRequests` (re-sorts same-second rows into book order), `frontierOf` (per-event frontier), `fingerprint`/`rewindPoint` (decision inputs only, never marks; rewind to the entry if it changed, else to the earlier of the old and new times of the changed exit/resolution). The runner passes `source_fill_id` in, since `loadBatchInputs` (unchanged) does not select it.
6. `portfolio/run.ts` + restart, rollback, idempotency, memory tests. **Done** — `src/lib/paper/portfolio/config.ts` (strict `PAPER_PORTFOLIO_CONFIG` on top of the Phase 2 parser: every field required and range-checked, unknown keys refused, explicit `startTs` with a timezone and not in the future; one portfolio per mode, id = hash(mode, execution config, portfolio config, start); IDEAL labelled a non-causal baseline in `portfolios.config` and the run stats) and `src/lib/paper/portfolio/run.ts` (`runPortfolios(db, opts)`, not wired into the worker): lease claimed before any work, renewed after every batch, released in `finally`, a held lease skips the portfolio; `paper_executions` streamed by `(fill_ts, signal_id)` in 500-row batches extended to the end of their last fill second; `source_fill_id` loaded per batch; the frontier carried across batches (nothing at or after it decided, written or advanced past); change detection from the last finished run's start (fingerprint vs `input_hash`, marks and metadata fetch times never rewind); every restore rehydrates the open lots (including `sim_terminal` records and entry-input changes) and goes back to an earlier checkpoint when needed; a rewind deletes decisions, lots, equity and checkpoints after the restored second and rewrites the restored open lots; diff writes (outputs → checkpoints → `portfolio_runs`), so an unchanged run writes no output row; whole-second checkpoints (hourly for 10 days, daily before, always one at the watermark); equity thinned to the last point per hour after 7 days; `dryRun` writes nothing at all. Two `book.ts` fixes found by these tests, decision rules unchanged (parity tests untouched): `relink` no longer re-schedules an exit that was applied but sold nothing, and a lot is emitted after its exit is linked. Tests: `tests/phase3-run.test.ts` (26, one real-Postgres) + 1 in `tests/phase3.test.ts`; every requirement mutation-checked. Open decisions: D12 (the watermark is the last fully decided entry second, so exits and resolutions after the latest entry wait for the next one), D13 (inputs of a decided signal whose Phase 2 record is `sim_terminal` and whose lot is closed or never filled are not re-examined, as in Phase 2), D14 (accept the two `book.ts` fixes). (Raised as D11–D13 in the step 6 report; renumbered when step 7 took D11.)
   **Review requirements for step 6 (from the steps 4–5 review, 2026-09-26):**
   - **Never split a fill second across batches.** The database streams `(fill_ts, signal_id)`, but the book orders by `(fill_ts, kind, id)` and refuses anything out of order. 19% of REALISTIC rows (7,433 of 39,947) share their fill second, in groups of up to 9, so a 500-row batch boundary would split a group roughly once in every five boundaries and the replay would throw. Each batch must extend to the end of its last fill second (or hold that second back for the next batch) before `orderRequests`. Test: a same-second group straddling a batch boundary replays identically to one batch.
   - **Carry the frontier across batches:** `frontierOf` is per batch; the runner keeps the minimum across batches.
   - **Pass `sourceFillIds`:** `loadBatchInputs` does not select `signals.source_fill_id`; without it `buildRequests` silently falls back to the legacy duplicate key (R4).
   - **Minor:** the entry fingerprint hashes `entry.market`, which includes the metadata fetch time (`observedAt`). A metadata re-fetch with unchanged values would change the fingerprint and cause an unnecessary rewind. Exclude `observedAt` from the fingerprint (it is provenance, not a decision input).
7. JS + SQL report with parity test. **Done** — `supabase/migrations/0010_portfolio_report.sql`: `portfolio_report(id) returns jsonb` (SQL, stable, same permissions as the `0007` report functions) plus `portfolio_pending_ahead(mode, after)`, and `src/lib/paper/portfolio/report.ts`: the pure JS reference `buildPortfolioReport` (identical shape), `portfolioReport(db, id)` and `savePortfolioSnapshot(db, opts)` (writes every configured portfolio's report to `cursors['paper:portfolio']`; not wired into the worker). Every figure is as of the watermark (rows after it ignored, marks included only if observed between the lot's fill and the watermark; each lot rebuilt as it stood then: an exit or resolution counts only if it happened by the watermark, so a lot exited after it is reported open, at cost, with only its entry fee realised); cost basis (cash derived from the lots, invested at cost, realised P&L, fees) and market value (latest 1h/6h/24h mark, unmarked lots at cost and counted) are reported separately; risk from the equity curve with the hourly-thinning cutoff stated; decisions by outcome and reason (duplicates apart; fill rate excludes UNKNOWN and duplicates); by kind with `insufficient` under 10 settled lots and the CONSENSUS attribution note; top-10 exposure (ties by code unit); lot states, median holding time and `LOCKED_UNRESOLVED` derived in the report (D11); robustness as in `paper_exec_stats`; health (lease, last rewind, stale-row warning, rows still ahead of the watermark). `run.ts`: delete counts are head counts (a read is capped at 1,000 rows). Parity (SQL = JS field by field, 1e-6) on random portfolios in all three modes in real Postgres; on 100,000 decisions the report reads `paper_marks` by primary key and `paper_executions` through `paper_executions_mode_fill_idx` (≈0.4 s). Tests: `tests/phase3-report.test.ts` (19, four real-Postgres, in a database built from `0001`–`0010`). Open: D15.
8. Worker wiring behind the env setting; `/execution` section.
9. Docs.
10. Full test suite (incl. real Postgres), typecheck, `next build`; read-only dry run on live data before switching on.
