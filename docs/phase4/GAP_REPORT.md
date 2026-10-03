# Phase 4.0 — Part A: gap report

Against `docs/PHASE4_PLAN.md` v2 (commit `aa7e860`), checked against the repository at the same commit. Method: every claim
below was read in the code or the migrations (file and function given). Nothing was measured on production data: this step
had **no database access and no network access** (see `S1a_TIMESTAMP_AUDIT.md` §1), so every number that needs production
data is listed as *not measured* and assigned to a script. "Recalled" means: from my memory of a venue's API, not verified
here, and to be confirmed by the S1a run.

Contents: [1 Wrong or unverified assumptions](#1-wrong-or-unverified-assumptions) ·
[2 What can be reused](#2-what-already-exists-and-can-be-reused) · [3 Copy score and wallet profile data](#3-copy-score-and-wallet-profile-data) ·
[4 Market metadata today](#4-market-metadata-today) · [5 Size and risk of steps 4.1–4.6](#5-size-and-risk-of-steps-41-46) ·
[6 Unsafe, ambiguous or unimplementable as written](#6-unsafe-ambiguous-or-unimplementable-as-written)

---

## 1. Wrong or unverified assumptions

### 1.0 Confirmed: no order, key or Grok code exists

Searched `src/`, `worker/`, `scripts/`, `supabase/`, `tests/`, `config/`, `package.json` and `docs/` (excluding the Phase 4.0 files) for
`grok`, `xai`, `ethers`, `viem`, `web3`, `privateKey`/`private_key`, `mnemonic`, `signTypedData`, `signMessage`, `clob-client`,
`postOrder`, `placeOrder`, `submitOrder`, `createOrder`, `/order`, `api_secret`, `passphrase`, `POLY_API`, `hmac`, `wallet connect`:
**no match.** Dependencies are `@supabase/supabase-js`, `next`, `react`, `react-dom`, `ws` (runtime) and `@types/*`, `pg`, `tsx`,
`typescript`, `vitest` (dev): no signing, wallet or exchange-client library. The only credentials the code reads are
`SUPABASE_SERVICE_ROLE_KEY` (and `SUPABASE_READ_KEY`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`
(`grep process.env`). The plan's §1 statement ("verified by searching the repository") is **correct**.

### 1.1 Corrections to the plan

| # | Plan says | The code says | Effect |
|---|---|---|---|
| A1 | §2.3 and §13: "append-only journal; corrections are new rows (**D18 rule**)"; "carried from Phase 3: … **D18 append-only corrections**" | `docs/PHASE3_PLAN.md` **D18 is a different finding**: an entry whose fill time moves after it was decided is not replayed correctly (latent). Phase 3 has no append-only rule. Worse, its tables are *not* append-only: the runner deletes and rewrites rows past a watermark (`src/lib/paper/portfolio/run.ts`, "delete everything after the restored checkpoint", and diff writes by `record_hash`) | The reference is wrong; the journal's append-only property is **new work** (§6 U6). Re-label as a Phase 4 rule, not a carried one |
| A2 | §4: "the limit arithmetic of `PortfolioBook` is shared by the paper book and the Safety Gate (one function)" | There is **no such function.** The arithmetic is inline inside `PortfolioBook.enter` (`src/lib/paper/portfolio/book.ts`, the `checks` array, line 84) and **duplicated** in `simulatePortfolio.enter` (`src/lib/paper/sim/portfolio.ts`, line 47). Both are closures over mutable state | Extraction is a prerequisite refactor of Phase 3 code (4.4). Parity tests exist (`tests/phase3.test.ts`: book equals reference), which makes it feasible and risky at once |
| A3 | §5.3 Capacity: "cash for order **+ expected fee** + buffer and cash after ≥ reserve (D20, a true floor)" and §4 "shared" | Phase 3 **keeps D20 as a known property**: the cash check compares the order size, not size + fee, so the reserve can be undercut by one entry fee (`docs/PHASE3_PLAN.md` D20, decided to keep for parity with the reference). A shared function cannot be both parity-preserving and a true floor | The live gate needs a **stricter variant** of the arithmetic. "One function" must be one function with an explicit `feeAware` parameter, the paper path calling it with `false` (§6 U4) |
| A4 | §3.2 "Existing upstream filters (bot and market-maker wallets, **freshness of the watchlist**) are unchanged" | Bot filtering exists: `isBotLike` (`src/lib/signals/rules.ts`: style = "Market maker / bot", fills/day > 500, program share > 0.25), applied in `SignalEngine.ingest` and `evaluate`. **No watchlist-freshness filter exists:** `wallets.scored_at` is written (`src/lib/scoring/refresh.ts`) and never read anywhere (`grep scored_at`). `engine.loadWallets` loads `tracked = true` whatever its age | Either implement a freshness gate (new, small) or drop the words; today a failed re-score silently keeps old scores in force |
| A5 | §5.1 wallet context: "**bot class**, activity, profile summary (90-day profit and consistency, **recent performance windows**) from the system's own tables" | `wallets.bot_class` / `activity_*` exist (migration 0007) but `engine.loadWallets` does **not load** them into `WalletProfile` (`src/lib/polymarket/types.ts`); `isBotLike` uses `style`, `fills_per_day`, `program_share` only. **No "recent performance window"** (7/30-day) is stored: `wallets` holds `pnl_90d`, `months_up/total`, `net_dd`, `concentration`, `days_idle`, `trade_count`; the daily PnL curve is fetched during scoring (`userPnl`) and discarded | The context builder (4.2) must read the `wallets` row itself and a "recent performance" field needs a new column or a derived value. Decide whether it is in V1 |
| A6 | §3.5 "`copy_score` is the value the signal engine recorded **at signal time**" | True with a bounded caveat: the value is the in-memory profile at the last `loadWallets` (boot, then every 10 minutes: `worker/ws-listener.ts:45`). After the 04:15 UTC re-score the engine can keep scoring with the previous day's value for up to 10 minutes (§3) | Define "at signal time" as "the score the engine used"; it is what the paper results use, so it is the consistent choice |
| A7 | §1 "the only field stored, `markets.end_date`, is a **date without a time of day**" | **Correct**, and wider: `markets.end_date date` (migration 0005), `positions.end_date date` (0001) and `Position.endDate` are all dates, and the parser slices to ten characters (`parseGammaEndDate`, `markets.ts:29`; `GammaMarketMeta.endDate`, `markets.ts:43`). Rows exist only for markets where a tracked wallet **bought** (`SignalEngine.ingestClaimed` → `markets.endDate` for BUY) or whose token order was looked up (`mark.ts` partial upserts, which leave `end_date` null) | "8 % no usable date" is consistent with this; it is not a defect of the date field |
| A8 | §3.2 E0 "not a duplicate of a source fill already processed" | One fill can yield **several signals** (NEW_POSITION + EARLY_ENTRY + CONSENSUS are all emitted by `evaluate` for one fill) with distinct `dedupe_key`s; `signals.source_fill_id` (migration 0006) links them, and is null for the V1 signals back-filled on 18 Sep (`sim/config.ts` ASSUMPTIONS). Phase 3 resolves this with `sourceKey` + `KIND_ORDER` (`book.ts`: RESOLUTION 0, EXIT 1, NEW_POSITION 2, EARLY_ENTRY 3, CONVICTION_ADD 4, CONSENSUS 5; "taken" window 7 days) | E0 must say **which signal wins** (suggest: the same `KIND_ORDER`, deterministic) |
| A9 | §7 S1/§10 "timestamp audit … public data, both venues" | `scripts/` and the container cannot reach any venue from the authoring environment (network policy `403`); so S1a/S1b measurements are **pending** and the plan's §3.3 field names remain provisional | Run the two scripts where the venues are reachable (S1a §5, S1b §5) |
| A10 | §6 "G1 … the venue's own terms permit automated trading" and brief "respect each venue's published terms for public data" | The terms could not be read from here (host blocked). Nothing in the repository records any venue's terms | Open: read both venues' API terms before the first run of the scripts against the US venue |

### 1.2 Figures in the plan that this step cannot verify (no database)

§1 "about 828 entry signals a day; about 200 with score ≥ 68; about 110 after a date-level 24-hour proxy"; "24 % of signals from
20 wallets"; "1,990 settled REALISTIC trades in 702 markets and 103 wallets"; "per-trade SD 89 %"; "45 % end on the same UTC day …".
`scripts/phase4/coverage-probe.ts` reproduces the first four from the database (`s1b_funnel.json`: counts, the date-level proxy,
wallets) and the feasibility table recomputes SD, markets and wallets (`s1b_feasibility.json`). They are **not** repeated here.

One figure can be cross-checked from the repository alone: plan §3.6 puts `MIN_SETTLED_PER_ARM` at "≈ 1,900 at 10 points".
At SD 89 points, effect 10, α 0.05 two-sided, power 80 %, **no clustering** the arithmetic gives **1,244 per arm**
(`sampleSizePerArm`, `tests/phase4-stats.test.ts`, independently checked with Python's `statistics.NormalDist`); the plan's
"about 1,241" in the brief is that number to rounding. 1,900 therefore implies a design effect near 1.5 (1,866 at DEFF 1.5). The plan does not
say where 1.5 comes from; S1b measures it (market-clustering ICC) instead of assuming it.

---

## 2. What already exists and can be reused

| Need (plan §) | Existing piece | Where | Fit |
|---|---|---|---|
| Limit arithmetic (§4, 4.4) | the check list in `PortfolioBook.enter` (cash, reserve, per-wallet, per-market, total exposure, max positions, resize rule) | `book.ts:72-92`; reference copy `sim/portfolio.ts:45-55` | Semantics reusable; **needs extraction** and a fee-aware variant (A2, A3) |
| Append-only / idempotent writes (§2, 5.5) | claim-by-insert: `fills` upsert `ignoreDuplicates` then continue only if a row came back (`SignalEngine.ingestClaimed`); unique `dedupe_key`; `23505` handling | `engine.ts:83-110` | Good pattern for `eligibility_results` (unique per signal+policy) |
| Hash-diff writes | `record_hash` on `paper_executions` (`recordHash`, `sim/run.ts:148`), `input_hash`/`stableHash` on portfolio decisions (`requests.ts:84`) | `sim/run.ts`, `portfolio/requests.ts` | Reusable for the **context hash** (§5.1) and for "write only on change" fee observations (S1c) |
| Checkpointing | `portfolio_checkpoints`, restore + replay, leases (`claim_portfolio_lease`) | `portfolio/run.ts`, migration 0008 | Reusable for the **Grok-gated paper portfolio** (§7 S4). Not suited to the journal itself (it rewrites) |
| Audit pattern | strictly read-only audit with a spy database that throws on any write/RPC; exit codes 0/1/2/3; paced output (Railway 500 lines/s) | `portfolio/audit.ts`, `scripts/portfolio-audit.ts`, `tests/phase3-audit.test.ts` | Reused here: `src/lib/phase4/readonly-db.ts` + `tests/phase4-scripts.test.ts`; the §14 hostile audit can follow the same shape |
| Memory logging | `withMemLog`, `memSample`, `storeMem` (`cursors['health:memory']`) | `health/memory.ts` | Reusable as is for a decision service |
| Heartbeats | throttled `cursors['health:*']` keys, `assessHealth` thresholds | `health/heartbeat.ts`, `health/assess.ts` | Extend `HeartbeatKey` with executor/gate keys; the Safety Gate's "executor and database healthy" check can read them |
| Telegram | bot with per-chat filters, delivery table, failure classification, backoff (`broadcast.ts`) | `src/lib/telegram/` | Alerts reusable. **Controls are not**: there is no owner-only command, no confirmation flow, no chat allow-list (`TELEGRAM_CHAT_ID` is only a push target in `alerts/dispatch.ts`). The kill switch's "confirmed controls" is new code (§6 U7) |
| Polite public reads | `PolymarketClient` (param whitelist, retries, UA) | `polymarket/client.ts` | Not used by 4.0: its retry policy (4 attempts, 45 s timeout) is looser than the brief's; `PoliteHttp` is stricter (`src/lib/phase4/http.ts`) |
| Resolution times of ours | `token_resolutions` view (earliest `resolved_ts` per token, from the marker and `token_resolution_obs`) | migrations 0008, 0009 | Used by `loadOurs` in S1a (select only) |
| Fee model facts | per-trade provenance OBSERVED_FEE_FREE / OBSERVED_RATE / ASSUMED_RATE / ASSUMED_UNKNOWN; taker fee = shares × rate × p × (1 − p) (international docs, as recorded) | `sim/config.ts` ASSUMPTIONS, `sim/execute.ts` | The *international* venue only; the US venue's fee schedule is unknown here (S1c §6) |
| Retention | `prune_working_data` (fills 7 d, closed positions 30 d, dq 14 d) | migration 0004, `worker/ws-listener.ts:98` | Pattern for snapshot retention (S1c §5) |
| Stale-signal handling | `detectionLagSec`, `isStaleLag`, D22/D23 (1 h alert limit) | `alerts/staleness.ts` | Lag definition reused for E1 (`MAX_SIGNAL_AGE`); note 1 h ≫ 600 s |

---

## 3. Copy score and wallet profile data

**Where the score lives.**

| Place | What | Written by | Rewritten? |
|---|---|---|---|
| `signals.payload.copyScore` | the score the engine used for this signal | `evaluate` (`signals/rules.ts:96-127`: `payload: { copyScore: w.copyScore, … }` on **every** kind incl. EXIT), inserted once at `engine.ts:110` | **No.** The only later updates to `signals` are `delivered` (`engine.ts:128`) and `closed_at` on EXIT (`engine.ts:129`); `grep 'from("signals")'` finds no other write |
| `paper_ledger.copy_score` | copy of the payload value | `buildPaperRow` (`paper/ledger.ts:27-31`) at insert | No |
| `wallets.copy_score` | the **current** score | `refresh()` upsert (`scoring/refresh.ts:68`), `seedFromSnapshot`; daily at the 04:15 UTC slot (`REFRESH_SLOT_UTC`), run inside the worker (`ws-listener.ts:91`) | **Yes, daily.** There is no history table |

**Is `payload.copyScore` the score at signal time, taken from the wallet profile at ingestion?** Yes: `SignalEngine.ingestClaimed`
calls `evaluate({ wallet: w, … })` with `w = this.wallets.get(f.wallet)`, the `WalletProfile` loaded by `loadWallets` (`engine.ts:50`)
from `wallets.copy_score`. Bounded staleness: the map is refreshed at boot and **every 10 minutes** (`ws-listener.ts:45`), so a signal
evaluated in the ≤ 10 minutes after the re-score completes can carry the previous day's score. For the REST poller on Vercel the engine is built
per invocation and loads fresh.

**How the daily re-score changes things.** `refresh()` re-scores every discovered wallet plus every tracked one, upserts all profile fields,
and **recomputes the `tracked` set** (top 150 by score ≥ 40, plus top 50 by 90-day PnL): wallets enter and leave the watchlist daily and every
score moves as the 90-day window rolls. Consequences: (1) `wallets.copy_score` today is not the score of any old signal; analysis of past signals by score **must** use
the payload (the plan and the probe do); (2) the score is a function of data that changes under the same code, so the
"pinned scoring version" must pin the **formula**, not the value; (3) "score ≥ 68 is 24 % of signals from 20 wallets" is a statement about one
re-score epoch; the probe reports wallets and the top-3 share over the whole window.

**Everything a pinned `SCORING_VERSION` would touch (additive only).**

1. `src/lib/scoring/score.ts`: export `SCORING_VERSION` next to `copyScore` (the formula and its constants: log10 scale to 40, drawdown ×1.5 to 20, months-up ×15, fills/day penalties, program-share −30×, concentration −20×, edge-per-dollar bonus 10, idle penalties 15/15, unrankable −10) and `buildProfile` (the 90-day window, `rankable` = ≥100 trades, ≥60 curve days, ≥10 moves, activity known, the fills/day fallback), `classifyStyle` (bot/lottery thresholds). Any change to those changes what 68 means.
2. `WalletProfile` (`polymarket/types.ts`): new optional `scoringVersion`.
3. `wallets` table: new nullable column `scoring_version text`; `refresh.ts` row mapping writes it; `engine.loadWallets` reads it.
4. `rules.ts` `evaluate`: add `scoringVersion` next to `copyScore` in each payload (additive JSON key; consumers read named keys only: `buildPaperRow`, `telegram/commands.ts`).
5. `paper_ledger`: optional `scoring_version text` copied by `buildPaperRow`.
6. `activity` measurement (`scoring/activity.ts`, `ACTIVITY_WINDOW_DAYS = 7`) feeds `fillsPerDay`, hence the score; include it in the version's definition. `config/watchlist.json` (seed snapshot) carries no version.
7. **Existing signals have no version** (everything before the change). Treat them as `UNVERSIONED`; E8's `SCORE_VERSION_MISMATCH` then rejects them, which is right for live use and irrelevant for the probe (it reads `payload.copyScore` regardless).
8. Check before changing `payload`: whether any fingerprint hashes the whole payload (`requests.ts` `stableHash` inputs); `grep` shows the paper path reads `copyScore` and `wallets` only, but the check belongs in 4.1's tests.

Not touched: the engine's own `minCopyScore` (env `MIN_COPY_SCORE`, default **40**, `rules.ts`) is a separate, lower filter; 68 is a Phase 4 policy constant and must live in policy code, not in `RuleConfig`.

---

## 4. Market metadata today

**What is captured.** `parseGammaExecMeta` (`markets.ts:15`) returns `MarketExecMeta { conditionId, feesEnabled, takerFeeRate, tickSize, minOrderShares, clobTokenIds, endDate }`
from the Gamma row; `execMetaRow` (`markets.ts:58`) writes `markets(condition_id, end_date, fees_enabled, taker_fee_rate, tick_size, min_order_shares, clob_token_ids, meta_fetched_at, fetched_at)`.
`GammaMarketMeta.endDate` returns a `YYYY-MM-DD` string, caches in memory (20,000 entries; negative results re-asked after an hour) and in `markets`.

**What is discarded.** `parseGammaEndDate` (`markets.ts:25`) reads, in order, `endDateIso`, `end_date_iso`, `endDate`, `end_date`; takes the first that is a string,
**cuts it to its first ten characters** and validates `YYYY-MM-DD`. Hence: the time of day and the offset of `endDate`, when Gamma supplies them, are thrown away; and because the
date-only `endDateIso` is tried first, the datetime `endDate` is only used when `endDateIso` is absent. The raw Gamma row is stored nowhere (`markets` has no JSON column).
`mark.ts` additionally reads `closed`, `umaResolutionStatus`/`resolutionStatus`, `outcomePrices`, `clobTokenIds` (`parseGammaResolution`) and discards them after use.
The repository proves that **only** these time-related names are read: `endDateIso`, `end_date_iso`, `endDate`, `end_date`.

**Available but discarded: unverified.** Gamma market and event objects very probably carry more time fields; from my recollection (not verified here, and not found anywhere in the repository):
`startDate`, `startDateIso`, `gameStartTime` (a "YYYY-MM-DD HH:MM:SS+00" string), `closedTime`, `umaEndDate`, `createdAt`, `updatedAt`, `acceptingOrdersTimestamp`, and nested `events[]` with `startDate`, `endDate`, `startTime`.
Their presence, format, meaning and reliability are exactly what `npm run phase4:ts-audit` establishes (it enumerates every time-like field generically, so it does not depend on this list being right).

**Smallest additive change that would capture real timestamps with time of day (described, not implemented).**

1. Migration (additive, nullable): `alter table markets add column time_fields jsonb, add column time_fields_fetched_at timestamptz;`.
2. `parseGammaExecMeta`: add `timeFields: Record<string, string> | null`, the raw string of every time-like leaf of the market row and of its first event (`flatten` + `isTimeLike` from `src/lib/phase4/audit.ts`, bounded to ~40 keys). **Store raw strings; assume no meaning** (S1a decides which field is a start, a close or a placeholder).
3. `execMetaRow`: add `time_fields`, `time_fields_fetched_at`.
4. `GammaMarketMeta.endDate` is unchanged (still the date), so the EARLY_ENTRY rule and `positions.end_date` behave exactly as today. Existing tests assert with `toMatchObject` (`tests/phase2.test.ts:195`), which tolerates new keys.
5. A backfill rule is needed: `GammaMarketMeta.endDate` returns the stored date without refetching when a `markets` row exists (`markets.ts:41-44`), so existing rows would never receive `time_fields`. Either refetch when `time_fields is null` (bounded per cycle) or run a one-off read-and-fill job. New rows are covered automatically.
6. Scope honesty: for the *execution* decision the plan uses the **execution venue's** times only (§3.3). This change would capture the **international** venue's times, useful for (a) the venue-agreement check (§3.3 "venue authority"), (b) analysing the 24 h rule on stored signals going forward. If the owner prefers, the S1a script (which fetches live) is enough and this change can be skipped.

---

## 5. Size and risk of steps 4.1–4.6

| Step | Size | Main risks |
|---|---|---|
| **4.1** Shadow executor, journal, policy plumbing | **Large** | New tables (≥ 9) and an order state machine; **append-only must be enforced by the database**, not by convention: every process holds the same `SUPABASE_SERVICE_ROLE_KEY`, which bypasses row-level security, so a "worker cannot forge a decision" guarantee needs separate roles/grants (insert-only on journal tables) or a service-side write path (§6 U6). `LIVE_TRADING` "unbypassable" needs a design (config in code + signed policy row). Scoring-version change touches the rule engine payload (§3). Dependent on D53 for the adapter shape |
| **4.2** Eligibility pipeline, mapper, timestamp resolver, context builder | **Medium–large** | The mapper depends on D53 and on how much of our flow exists on the venue (S1b); equivalence of resolution rules is a **human** check and a scaling problem (every new market). The timestamp resolver is the small part (done as a tested library here). Context builder needs data the system does not hold today (A5, depth near the touch) |
| **4.3** Grok Strategic Gate | **Medium** | Provider/model/cost/retirement are open (D57); latency unknown (D47); strict-schema validation is easy, **operationally** the risk is availability (`MAX_GROK_FAILURE_RATE` 2 %) and the injection red-team. `reason_code` and `risk_flags` enums and the context field-name registry (for `evidence_refs`) are unspecified |
| **4.4** Safety Gate and `AuthorizedOrder` | **Medium** | Extracting the limit arithmetic from two Phase 3 copies without changing paper results (A2, A3); MAC key management; "re-derive the context hash from fresh data" needs a canonical JSON spec; the pure-function rule (no network inside) forces all fetching into the caller |
| **4.5** Reconciliation, exits, emergency controls | **Large** | Needs a real venue to test against; crash recovery by client ID is only as good as the venue's idempotency semantics (unknown for the US exchange); automatic triggers (daily loss, drift) must be calibrated without live data; the kill switch channel does not exist (§2). "Exits mirror the wallet's EXIT signals only" interacts with the 24 h entry rule (an exit on a market we never entered) |
| **4.6** Hostile audit and rehearsal | **Large** | Needs the independent reviewer (D58) and a venue sandbox or paper environment; §14's 20+ "must be no" questions each need a test; scope grows with every earlier step |

---

## 6. Unsafe, ambiguous or unimplementable as written

**Ambiguous (decide before 4.2; U1–U3 are implemented fail-closed in `src/lib/phase4/timestamps.ts` with tests; the decisions they need are D60–D62 in `docs/phase4/README.md`):**

- **U1 — "(1) absent" versus "(1) invalid" (§3.3).** The plan uses slot 2 "only when (1) is absent". A start that is present but unusable (date-only, wrong format, placeholder) is not absent; falling back to the close time would usually place the event *later* than it is (a deadline follows kick-off) and let an in-play market through. Implemented: **no fallback** (`TIMESTAMP_MISSING`); `fallbackToCloseWhenStartInvalid` exists as an explicit option.
- **U2 — the 400-day window versus E5 (§3.3, §3.4).** §3.3 validates "between the evaluation time and 400 days ahead", which makes a time in the past *invalid*, so the code `EVENT_STARTED` (E5, "a started event or a passed deadline") could never fire, and none of the three E4 codes means "in the past". Implemented: a past time is **valid for E4** (`allowPast`) and rejected by E5; only "too far ahead" is an E4 failure.
- **U3 — overlap of E5 and E7.** For `time_to_event ≤ 0` both `EVENT_STARTED` (≤ 0) and `TOO_CLOSE_TO_START` (< `MIN_LEAD`) are literally true, and §3.2 says "every failure recorded". Implemented: all failing checks are returned in E5, E6, E7 order with `primary` = the first.
- **U4 — "one function" and D20** (A2, A3).
- **U5 — which signal wins E0** (A8).

**Unsafe or missing safeguards:**

- **U6 — the append-only journal and the HMAC rest on one shared database credential.** Worker, Vercel routes and scripts all use `SUPABASE_SERVICE_ROLE_KEY` (`src/lib/db.ts`). Anyone holding it can rewrite or delete any row, including `grok_decisions`. HMAC prevents *forging* a decision only if the signing secret is outside the worker; the plan says so (§4) but the rest of the design (`policy_versions`, `evidence_windows`, "lock time written to a table") assumes tamper-evidence the database does not provide today. Needed: database roles with insert-only grants on journal tables, or hash-chained rows (each row carries the previous row's hash) so rewriting is detectable.
- **U7 — "Telegram … confirmed controls".** No owner-only command path exists (§2). Until one is designed, "kill switch by message" (§14 asks it must be impossible to *disable* by message) has no secure channel: a chat-id allow-list plus a second factor is new work.
- **U8 — E1 `MAX_SIGNAL_AGE` 600 s is not in the plan's flow estimate.** Earlier phases recorded a **median detection lag of 134 s and a 90th percentile of 3,173 s** over 36,197 live signals (`sim/config.ts` ASSUMPTIONS, an observation of those phases, not measured here). A 600 s limit therefore removes a non-trivial share of signals before any other rule, and the plan's "about 110 a day" excludes it. The S1b probe reports it as a supplementary stage (`freshAtFinal`), measured from `signals.evaluated_at − created_at`.
- **U9 — an evidence window that may not be reachable.** With SD 89 points, a 10-point minimum effect needs ≥ 1,244 settled trades in the scarcer arm even without clustering. At a few dozen eligible signals a day and an acceptance rate of 25 %, that is many months. S1b computes it (`s1b_feasibility.json`); §7 S2's feasibility rule is the right gate and must not be skipped.
- **U10 — constants "in code, never environment variables" versus the repository's practice** (`ALERT_MAX_LAG_HOURS`, `MIN_COPY_SCORE`, `PAPER_*`). Not a defect; a new convention to state in 4.1 (a versioned policy object, hashed, written to `policy_versions`).

**Unimplementable as written (until something else exists):**

- §5.1 "depth near the touch", §9 price-movement and fill measurements: need **order-book capture**, which does not exist and which no venue has been read for. Design: `S1c_BOOK_AND_FEE_CAPTURE.md`.
- §7 S5 "verified costs" on the US exchange: its fee schedule and book format are unknown here.
- §3.3 field names: provisional until S1a runs (the plan says so).
- D53 (the venue) blocks S3; D33 depends on it.
