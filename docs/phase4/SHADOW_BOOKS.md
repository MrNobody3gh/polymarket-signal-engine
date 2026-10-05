# Phase 4.1 — shadow order-book measurement (operator guide)

> **Owner decisions, 6 Oct 2026: D106 accepted as proposed** (offsets 0/60/300 s, sizes $10/$25/$100, 10 stored levels, retention 45 days). **D107 (switching the flag on) is not yet decided**: migration 0012 is applied with the flag OFF. **D111 (the fee formula and unit conversion) is unverified: do not read the report's fee verdict until it is settled.**


**Status: built and tested against fixtures; NOT run against the live venue.** The authoring environment's network policy refuses `clob.polymarket.com`,
`gamma-api.polymarket.com` and `docs.polymarket.com` (HTTP 403 from the egress proxy, a host refusal; nothing was tried to get round it). Every
endpoint, field name and unit below comes from search snippets of the official documentation, not from a request, and is **unverified** until the
first run on a host that can reach the venue (§3, §9). Plan: `docs/PHASE4_PLAN_V3.md` §6. Brief: `PHASE4_1_BRIEF.md`.

## 1. What it is, and what it is not

A **read-only recorder of public order books** plus a **report**. For every entry signal (`kind <> 'EXIT'`) it reads the public CLOB book of the signal's
token at 0, 60 and 300 seconds after the signal's `created_at`, records the best bid and ask, the top 10 levels of each side, the hypothetical **taker buy**
fill at $10, $25 and $100 (average price, slippage against the wallet's price and against the mid, share filled, fee) and the observed fee rate, and later
compares all that with what the paper REALISTIC simulation assumed for the same signals.

It **places no order, creates no wallet, uses no key, no account and no authenticated endpoint**, and changes no signal, score, alert, paper result or portfolio.
It makes **public, unauthenticated GET requests** only: `GET /book` and `GET /fee-rate` on `https://clob.polymarket.com`. It is **off by default**.
Its result is a **cost** measurement; it is not an edge estimate and says nothing about whether following a wallet pays.

## 2. Turn it on, turn it off, roll it back

Environment variables on the Railway **worker** (read once at start; documented in `.env.example` and `DEPLOY.md`):

| Variable | Meaning |
|---|---|
| `SHADOW_BOOKS` | `1` = on. Unset, empty or `0` = **off: no request, no database access from this job**. Any other value (`true`, `yes`, ` 1`, …) = off, with one log line saying so (never on). |
| `SHADOW_BOOKS_MIN_SCORE` | Optional, 0–100, default `0` (all entry signals; D108). Inclusive. A malformed value turns the feature off with one line. |
| `SHADOW_BOOKS_DAILY_REQUESTS` | Optional whole number 1–172800, default `20000`. A hard daily request budget (§5). A malformed value turns the feature off with one line. |

**Before switching on:** (1) apply `supabase/migrations/0012_shadow_books.sql` in the Supabase SQL editor (additive; safe to run twice); (2) check that the worker's
host can reach `https://clob.polymarket.com/book` (a refusal is recorded as `REFUSED`, the job pauses and logs it; **do not work round a refusal**: no VPN, proxy,
header trick or alternate host; see D113); (3) set `SHADOW_BOOKS=1` and redeploy. The worker logs one line at start: `shadow books: on · offsets 0/60/300 s · …` or `shadow books: off (…)`.

**Switch off:** delete `SHADOW_BOOKS` (or set `0`) and redeploy. Nothing is deleted; the rows stay and the report still reads them.
**Roll back completely:** switch off, then `drop table if exists shadow_books;` (nothing depends on it; no other table changed). Pruning keeps the table at 45 days anyway (§6).
**Status:** `cursors` key `health:last_shadow_books` (the existing health mechanism, written only when the job is on) holds the last cycle's outcome as JSON, success or failure.

## 3. Endpoints and fields (documentation, UNVERIFIED live)

| Use | Request | Fields read | Documentation |
|---|---|---|---|
| Order book | `GET https://clob.polymarket.com/book?token_id=<token>` | `bids[]`, `asks[]` of `{ price, size }` (decimal **strings**; numbers and `[price, size]` pairs also accepted), `tick_size`, `min_order_size` (the answer also carries `market`, `asset_id`, `timestamp`, `hash`, `neg_risk`, `last_trade_price`, not used) | <https://docs.polymarket.com/api-reference/market-data/get-order-book> · <https://docs.polymarket.com/market-data/prices-order-books> |
| Fee rate | `GET https://clob.polymarket.com/fee-rate?token_id=<token>` (the path form `/fee-rate/{token_id}` is also documented) | `fee_rate_bps` (also `base_fee`, an older name, accepted) | <https://docs.polymarket.com/api-reference/market-data/get-fee-rate> · <https://docs.polymarket.com/trading/fees> |

What the code does **not** rely on: the order of the levels (both sides are sorted), the type of numbers, a minimum number of levels. A token with no book is expected to answer
HTTP 404 (recorded `NOT_FOUND`). Gamma is not called at all (market metadata comes from nothing: the report uses the database).

**Could not be verified from the authoring environment** (all of §3): that the paths and query parameter name are exactly these; the field names and types; that `/book` and `/fee-rate` need no
authentication (the documentation says they are public market data); the venue's rate limits for these paths; the 404 body for a token without a book; whether the answer lists levels best-first. The
parsing is tolerant where the documentation is ambiguous and `tests/phase4-shadow-fill.test.ts` pins the documented shape; the first live run decides the rest (§9).

**Fees (D111, important).** The paper simulator's fee is `shares × rate × p × (1 − p)` with `rate` a fraction (`src/lib/paper/sim/execute.ts`, `takerFee`). The recorder reuses **that function** on each
level taken, and converts the venue's `fee_rate_bps` with one constant, `BPS_PER_UNIT = 10 000` (`src/lib/phase4/shadow/fee.ts`). The unit conversion and the formula are **not verified**: search snippets
of the fee page show a formula with an exponent for some categories and a different rate scale. The raw `fee_rate_bps` is stored on every row, so every fee can be recomputed later without
re-measuring. **Do not read the fee verdict of the report until D111 is settled.** Provenance uses the paper vocabulary: `OBSERVED_FEE_FREE` (0 bps), `OBSERVED_RATE` (> 0), `ASSUMED_UNKNOWN` (the rate could
not be read: the paper REALISTIC fallback rate 0.05 is used and the row says so). Fees are not rounded (the paper model does not round; the venue is documented to round to 4 decimals, an effect below $0.0001 per fill).

## 4. What is recorded (`shadow_books`, migration `0012`)

One row per `(signal_id, offset_s)` (primary key; offsets 0, 60, 300; `schema_version` 1 versions the constants of D106). Columns: `due_at` (created_at + offset), `taken_at`, `token_id`, `side` (always `BUY`),
`source_price` (the wallet's fill price), `best_bid`, `best_ask`, `spread` (price units: 0.01 = 1 point), `mid`, `bids` / `asks` (top 10 levels `[[price, size], …]`, best first), `fills`, `fee_rate_bps`, `fee_source`,
`status`, `http_status`, `latency_ms` (the book request only, without pacing), `request_count` (all requests of the snapshot, retries included).

`fills` = `{ tick_size, min_order_size, by_usd: { "10": …, "25": …, "100": … } }`, each with `usd_requested`, `filled_usd`, `shares`, `avg_price`, `limit_price` (the worst ask level touched),
`slippage_vs_source` and `slippage_vs_mid` (average price minus the reference, price units), `filled_share` (0–1), `fee_usd`, `below_min_order`.

**Status:** `OK` (two-sided book) · `EMPTY_BOOK` · `ONE_SIDED` (asks only still prices a buy; bids only reads as unfillable) · `CROSSED` (best bid above best ask; no fills are invented from it, and its fee rate is not
asked) · `NOT_FOUND` (404) · `ERROR` (timeout, network, 5xx, 400, not JSON, JSON that is not a book) · `REFUSED` (401, 403, 451, 429) · `MISSED` (§5; no data at all).

**Fill walk** (`fill.ts`): buys the signal's token from the best ask upwards, spending up to $X of stake, partial fills allowed, **never fabricating liquidity** (what the book does not offer is unfilled). The walk
uses the **whole** book; only the stored copy is cut to 10 levels (so depth figures near the 10th level are lower bounds; the report counts how often). **Rounding rule:** observed prices and sizes are read exactly as the venue
prints them and never rounded to a tick (resting levels are already on the tick; a 0.001-tick price is preserved); derived numbers (spread, mid, averages, shares) are rounded to 6 decimals only to remove float
noise; the `limit_price` of a fill is a level price, hence on the venue's tick.

## 5. Scheduling, budgets, failure isolation

* **Database-driven and restart-safe.** About every 15 s the job reads the entry signals created in the last 2 hours (bounded pages), the rows already written for them, and plans: not yet due → wait; row exists → done
  (**idempotent**: the insert is insert-if-absent); due and at most **120 s** late → snapshot; **more than 120 s late → a `MISSED` row with no data and no request** (a late book would bias the measurement). Oldest due first. A
  restart re-derives everything from the signals and the rows. After an outage shorter than 2 h the gap is filled with `MISSED` rows; an outage longer than 2 h leaves signals with no row at all (the report counts them:
  "entry signals in the period … with no row"). A first enable does **not** back-fill history.
* **Polite.** One client for the whole job: **at most 2 requests per second in total across every signal and offset** (a 500 ms floor between request starts that cannot be configured lower), a descriptive `User-Agent`
  (`polymarket-signal-engine-shadow-books/4.1 (read-only public order-book measurement; no orders, no account; …)`), no cookie, no credential header (there is no option to add one), one retry at most for a timeout or 5xx
  with `Retry-After` honoured (the sleep is capped at 30 s), the per-request event list not kept (a long-lived worker must not grow it).
* **A refusal stops the job.** HTTP 401/403/451 or **429** is recorded as `REFUSED` (the 429 is **not** retried or slept on), the rest of the cycle is not asked, and the job **pauses** 60 s (doubling at each consecutive refusal up to
  1 h; a longer `Retry-After` wins), logging one line. It asks again after the pause; it never works round a refusal.
* **Budgets.** Per cycle: at most 20 snapshots and 14 s of wall time (no new snapshot starts after that); at most 200 `MISSED` rows. **Per UTC day: `SHADOW_BOOKS_DAILY_REQUESTS`** (default 20 000), counted from the rows
  themselves (so it survives a restart); when it is reached the job logs `daily request budget reached …` **once**, takes no more snapshots that day, and the snapshots that fall due become `MISSED`. Expected use: about 900 entry signals
  a day × 3 offsets ≈ 2 700 snapshots ≈ 3 500 requests (the fee rate of a token is asked once an hour).
* **Failure-isolated.** The job has its **own timer** (not part of the 15-minute simulation cycle), its **own busy guard** and its own time budget. `runShadowCycleSafely` catches everything: one log line per failed cycle,
  a status heartbeat, no rethrow. The signal sweep, the paper simulation, the portfolio runner and the alerts never see its errors (tests inject failures). **The one worker hook** (`worker/ws-listener.ts`, 3 lines):
  ```ts
  const shadow = shadowSetup(process.env, (m) => console.log(new Date().toISOString(), m));
  if (shadow.on) { const log = (m: string) => console.log(new Date().toISOString(), m); const job = new ShadowJob({ db: db(), config: shadow.config, log }); const tick = () => void runShadowCycleSafely(job, { db: db(), log }); setTimeout(tick, 120_000); setInterval(tick, SHADOW_CYCLE_MS); }
  ```
  With the flag off there is no timer, no client, no `db()` call.
* **Memory.** No list grows with the signal history: signals are read in pages of 200 (at most 5 pages), at most 20 snapshots a cycle, the fee cache is bounded (500 tokens, 1 h), the HTTP event list is not kept, the daily
  count is a running sum over pages of 1 000. Tests assert each.

## 6. Retention and volume

Raw snapshots are kept **45 days** (D106) and pruned by the job itself: at most once an hour, in deletes of at most 100 rows, at most 20 per run; the statement removes only rows whose `due_at` is older than the cutoff. A
documented aggregate may be kept: the report writes `shadow_groups.csv` / `shadow_report.json`, which can be committed as the permanent record of a period.

**Volume estimate** (to be replaced by the report's measured figure): ≈ 900 entry signals/day × 3 offsets ≈ **2 700 rows/day**; a synthetic row with 10 levels per side and three fills measures **928 bytes** of JSON (fixture, computed with the module's own functions) plus about 0.2 KB of columns and
indexes, so about **3 MB/day and ≈ 140 MB at 45 days** (real books with longer size strings or the 0.001 tick may be 30 % larger). `npm run phase4:shadow-report` prints the measured rows/day and bytes/row. If that is too much for the plan, D112 lists the levers (fewer levels, a score floor, a shorter retention).

## 7. The report (read-only)

`npm run phase4:shadow-report -- [--days 14] [--since ISO] [--out-dir docs/phase4/data] [--max-rows 400000] [--print-files shadow_report.md,shadow_groups.csv]`

Reads the database **only through a select-only wrapper** (no insert, update, delete or rpc can be typed; a test runs the whole path against a spy). It streams `shadow_books` in pages of 500 and keeps only numbers.
The console is at most 60 lines; the details go to `shadow_report.json`, `shadow_report.md`, `shadow_groups.csv` and `shadow_paired.csv` in the output directory. On Railway: `railway run npm run phase4:shadow-report -- --print-files shadow_report.md`
or `npm run phase4:bundle` (it packs `docs/phase4/data`).

1. **Coverage:** signals measured, rows by status and offset, the `MISSED` and `REFUSED` shares, entry signals in the period with no row.
2. **Per category and signal kind** (the existing `categorize`): spread p50/p90 in price points, ask-side depth within 1 and 2 points ($, p50; with the share of truncated depth), fee rate (bps) distribution, share **not fully fillable** at $25
   and $100, **slippage versus the wallet's price** at every offset and size (median, p90, mean; in points of price and as % of stake; with counts).
3. **Paired comparison with paper REALISTIC on the same signals.** The paper fill is at the paper size ($100); the observed fill is the $100 taker fill at the offset **nearest to the paper decision + execution latency (10 s): offset 0**
   (the pairing treats the signal's `created_at` as the paper evaluation time; the report prints the observed median gap). For each pair: price cost as % of stake `(fill − wallet's price) ÷ fill`, split into **price moved before the
   order** (mid vs the wallet's price) and **spread and impact** (fill vs mid), and the fee as % of stake (compared only where **both** sides observed a rate). The difference `observed − paper` gets a **cluster-robust** 95 % interval
   (clusters = markets, because signals on one market are not independent). Verdict: `UNDERSTATED` (the whole interval above 0: the real book is dearer than the paper model said), `OVERSTATED` (below 0), `CONFIRMED` (the interval
   contains 0: the data cannot tell them apart, which is **not** proof they are equal; read the interval), `INSUFFICIENT_DATA` (fewer than 30 pairs or 10 markets). The plan's 6.7 points of price and 4.5 of fees are printed beside,
   as a reference for a different population, never used in a calculation.
4. **"What this is not":** no result is an edge estimate; it measures the cost of following, not whether following pays.

## 8. Tests (all in `tests/phase4-shadow-*.test.ts`; mutation-checked)

`phase4-shadow-fill` (book normalisation, fill walk with known answers: exact fill, partial, empty, one-sided, crossed, size beyond depth, a price exactly at a level, tick precision; fee parity with the paper function on shared fixtures) ·
`phase4-shadow-schedule` (due, late, missed, idempotent, restart, oldest first, caps, EXIT and score filters) · `phase4-shadow-job` (flag off makes no request and no database call; malformed flags are off; refusals and 429; budgets per cycle,
per day, time; pacing never below the floor; error isolation with injected failures; memory bounds; retention pruning) · `phase4-shadow-report` (arithmetic, the paired comparison on a fixture, every database path read-only, the CLI) ·
`phase4-shadow-boundaries` (what may be written, what may be asked, no credential vocabulary, the migration touches one table) · `phase4-shadow-sql` (real Postgres: migrations 0001–0012 from scratch, 0012 twice, RLS and grants as the roles,
constraints, no existing table or function changed, the job and the report over the real schema; skipped without `PG_TEST_URL`) · `phase4-isolation` (updated: the worker may import the shadow job and nothing else of Phase 4).
`npm run phase4:mutations` includes the 4.1 mutations (`scripts/phase4/mutations-4-1.ts`, ids `s4…`); run it with `PG_TEST_URL` set so the migration mutations are judged by the real-Postgres file as well.

## 9. What remains to be measured (not done here)

1. **First live contact:** from the worker's host, one `GET /book?token_id=<a real token>` and one `GET /fee-rate?token_id=<same>`; compare the field names, types, level order, the 404 body and the fee unit with §3. Fix the parser
   if they differ (the tests pin the documented shape, so a difference shows up as a failing fixture).
2. **D111:** the fee formula and the bps→rate conversion, against a real fill or the fee page's table for the categories in the signal flow.
3. **Two weeks of data** (plan §7 S2), then the report. Until then every number in §6's volume estimate and every verdict is a design figure, not a measurement.

## 10. Open decisions (continue from D111; none is decided here)

| # | Decision | Recommendation |
|---|---|---|
| D111 | The fee unit and formula: is `rate = fee_rate_bps ÷ 10 000` and `fee = shares × rate × p × (1 − p)` right for every category in the flow (the fee page shows category-specific rates and, for some, an exponent)? | Verify on the first live run before reading any fee verdict; if the formula differs, change `fee.ts` / `takerFee` once, for the paper model and the recorder together, and recompute from the stored `fee_rate_bps` |
| D112 | Storage: ≈ 140 MB at 45 days for all entry signals (estimate). Keep as is, or cut (5 levels instead of 10; `SHADOW_BOOKS_MIN_SCORE=68` ≈ one quarter of the rows; 30 days) | Keep as is for the first two weeks, read the measured bytes per row, then decide |
| D113 | If the venue refuses the worker's host (HTTP 403/451), which is plausible for a region the venue restricts: where may the worker run? The plan forbids any circumvention. | Owner decision; until then the job records `REFUSED` and pauses; do not use a proxy or VPN |
| D114 | Which offset answers "what does a follower pay": 0 s (the paper simulator's own latency of 10 s) or 60 / 300 s (a human reading an alert)? The report pairs at 0 s and prints all three | Judge G4 on the offset that matches the intended follower (an automated one: 0 s; a human: 60–300 s) and say so in the pre-registration |
| D115 | The report's `INSUFFICIENT_DATA` thresholds (30 pairs, 10 markets) are display rules, not decision thresholds. What sample and what interval width justify moving G4? | Pre-register with the S3 constants lock |
| D116 | An outage longer than the 2-hour look-back leaves signals with no row. Back-fill them as `MISSED` (a longer look-back) or leave the gap visible in the report only | Leave visible (current behaviour) |
