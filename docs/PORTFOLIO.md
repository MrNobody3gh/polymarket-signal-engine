# Portfolio simulation (Phase 3)

Paper only. Nothing in this project places a trade, and nothing here can. This page is for the operator: plain English
first, precise details after. File and function names in `code` are where each rule lives, so every sentence can be
checked against the code. All results are *measured* on past signals under stated assumptions; nothing here predicts
future returns.

Contents: [1 What it is](#1-what-it-is) · [2 The three modes](#2-the-three-modes) ·
[3 How a signal becomes a position](#3-how-a-signal-becomes-a-position) · [4 Every outcome and reason](#4-every-outcome-and-reason) ·
[5 Reading the numbers](#5-reading-the-numbers) · [6 How it runs](#6-how-it-runs) · [7 Configuration](#7-configuration) ·
[8 Switch-on runbook](#8-switch-on-runbook) · [9 Switch-off and rollback](#9-switch-off-and-rollback) ·
[10 Troubleshooting](#10-troubleshooting) · [11 Known limitations and open decisions](#11-known-limitations-and-open-decisions)

---

## 1. What it is

Phase 2 treats every signal as its own independent $100 paper trade with unlimited money. Phase 3 asks a different
question: *what if one account with a fixed amount of capital had followed these signals, subject to limits?* It
replays the same signals in time order through one simulated portfolio per execution mode. Each signal asks for a
position; the portfolio checks it against the limits you set (cash, number of positions, per-wallet and per-market
caps, total exposure), buys at its own size with the same fill, fee and liquidity rules as Phase 2, and holds the
position until the wallet that triggered it exits or the market resolves. Money is locked while a position is open and
comes back when it closes. It is a simulation on top of the Phase 2 paper records: it reads them, never trades, and
never changes them (the one thing it adds to a Phase 2 table is a request for a missing price, see §6).

It is **off** until `PAPER_PORTFOLIO_CONFIG` is set on the worker (§7). Code: `src/lib/paper/portfolio/`
(`config.ts`, `requests.ts`, `book.ts`, `run.ts`, `report.ts`, `view.ts`, `job.ts`, `audit.ts`); design:
`docs/PHASE3_PLAN.md`.

## 2. The three modes

One portfolio runs per execution mode, with identical limits. The modes are the Phase 2 modes
(`src/lib/paper/sim/config.ts` `MODES`, described in `docs/PAPER_EXECUTION.md`):

| Mode | When it buys | At what price | Fees | Liquidity cap |
|---|---|---|---|---|
| **IDEAL** | at the source wallet's own trade time | the signal price | none | none |
| **REALISTIC** | evaluation time + 5 s + 5 s | last trade at or before then + 1 tick spread + impact | market fee | 1× the source trade |
| **CONSERVATIVE** | evaluation time + 60 s + 15 s (expires after 1 h) | last trade + 2 ticks + 3× impact | market fee (7% fallback) | 0.5× the source trade |

"Evaluation time" is when our system evaluated the signal (`signals.evaluated_at`); where it was not recorded,
REALISTIC assumes 134 s and CONSERVATIVE 3,173 s after the source trade (`timeline`, `sim/execute.ts`). "Market fee"
is the market's own taker rate, or 5% (REALISTIC) / 7% (CONSERVATIVE) when the rate is unknown.

> **IDEAL is a non-causal baseline — not a strategy that could have been run.** It fills at the moment the source
> wallet traded, which is *before* our system could have known about the trade (detection has taken up to 171 hours).
> So the IDEAL portfolio spends capital on signals before they could have been seen, and a signal detected late makes
> IDEAL re-decide the past. Use it only as an upper reference to compare REALISTIC and CONSERVATIVE against (plan
> B10). The code labels it everywhere: `IDEAL_LABEL` in `config.ts` (stored in `portfolios.config.note` and the run
> stats), and the `/execution` column note "non-causal baseline — not a strategy that could have been run"
> (`IDEAL_COLUMN_NOTE`, `view.ts`).

REALISTIC and CONSERVATIVE are causal: every fill time is after the signal was evaluated, and every price used is the
last trade at or before that time (Phase 2 look-ahead rules). Their assumptions (spread, impact, liquidity, latency)
are approximations, labelled as such in `docs/PAPER_EXECUTION.md`.

## 3. How a signal becomes a position

In plain English: each entry signal (NEW_POSITION, CONSENSUS, CONVICTION_ADD, EARLY_ENTRY) becomes an order request for
`positionUsd`. The portfolio checks its limits one by one; if one is too tight it either shrinks the order to fit (when
`allowResize` is true) or rejects it. The order is then filled the Phase 2 way at the portfolio's own size. A filled
order becomes a **lot**. The lot is sold when *its own* wallet sends an EXIT on that token, or pays out when the market
resolves, whichever comes first.

Step by step (`PortfolioBook.enter` in `book.ts`, same rules as the Phase 2 reference `simulatePortfolio` in
`sim/portfolio.ts`, parity-tested):

1. **Request.** `buildRequests` (`requests.ts`) turns the signal into a request for `positionUsd`, with the price
   observations its mode needs. A signal whose fill time is before `startTs` is never requested (D4).
2. **Limits, in this order.** The first that fails decides:
   1. *Duplicate:* the same source fill was already taken (duplicate key `fill:<source_fill_id>`, else the legacy
      wallet|token|second|price key) → `REJECTED_DUPLICATE_POSITION`. Never resized.
   2. *Open positions:* already `maxOpenPositions` lots open → `REJECTED_MAX_OPEN_POSITIONS`. Never resized.
   3. *Wallet:* room = `maxWalletAllocationUsd` − cost already open for this wallet → `REJECTED_MAX_WALLET_ALLOCATION`.
   4. *Market:* room = `maxMarketExposureUsd` − cost already open on this market (condition) → `REJECTED_MAX_MARKET_EXPOSURE`.
   5. *Cash above the reserve:* room = cash − `minCashReserveUsd` → `REJECTED_INSUFFICIENT_CASH`.
   6. *Total exposure:* room = `maxTotalExposurePct`% × (cash + open cost) − open cost → `REJECTED_MAX_PORTFOLIO_EXPOSURE`.
3. **Resize or reject.** For checks 3–6: if the room is at least the order size, the check passes. If not, then with
   `allowResize: false`, or when the room is zero or negative, the order is rejected with that check's reason. With
   `allowResize: true` the order shrinks to the room and the next check sees the smaller size.
4. **Fill** (`simulateEntry` in `sim/execute.ts`, at the portfolio's size): the mode's latency, price, spread and
   impact (impact grows with order size ÷ source-trade size), the liquidity cap (larger orders are more often
   `PARTIALLY_FILLED`), the market's minimum order and the fee formula — all exactly as Phase 2, only the size differs.
   Cash falls by filled amount + fee. A resized order that ends up below the minimum order is `REJECTED` with
   `REJECTED_BELOW_MIN_ORDER` (D10, below); any other unfilled order keeps its execution outcome (`UNFILLED`, `UNKNOWN`…).
5. **Lot.** A fill (full or partial) opens one lot at cost. Only the filled part is booked.
6. **Exit or resolution.** Each lot is linked to the first later EXIT signal by the *same wallet* on the *same token*
   (`buildSignals`, `sim/run.ts`). At that exit's fill time the lot sells its open shares (`simulateExit`: price,
   spread, cap and fee as for entries; unsold shares stay open, `PARTIALLY_EXITED`). A resolution pays shares × payout
   at the on-chain resolution time (D2), with no fee and no slippage. If the market resolves at or before the exit's
   fill time, the exit is not used. A lot that never exits and never resolves keeps its capital locked (§5).

**D1 — one lot per signal.** Several signals on a position the portfolio already holds (a CONVICTION_ADD, a CONSENSUS)
each open their own lot, limited by the wallet, market and total caps, and each closes on its own wallet's EXIT. But
two signals produced by the *same* source fill (typically a NEW_POSITION and a CONSENSUS from one trade) are one trading
opportunity: they share one lot, credited to the one that comes first in event order (NEW_POSITION before CONSENSUS),
and the other is recorded as `REJECTED_DUPLICATE_POSITION`. So at portfolio level **CONSENSUS is under-attributed**:
some of its opportunities are counted under NEW_POSITION. The report says so next to the by-kind table
(`BY_KIND_NOTE`, `report.ts`).

Same-second order (plan B9): events at the same second are applied RESOLUTION → EXIT → NEW_POSITION → EARLY_ENTRY →
CONVICTION_ADD → CONSENSUS, then by signal id; so capital freed at a second is available to entries at that second.

## 4. Every outcome and reason

Every decided entry signal gets exactly one outcome (`portfolio_decisions.outcome`) and at most one reason.

**Outcomes**

| Outcome | Meaning |
|---|---|
| `FILLED` | The whole (possibly resized) order was bought. A lot was opened. |
| `PARTIALLY_FILLED` | The liquidity cap allowed only part of it. A lot was opened with the filled part. |
| `UNFILLED` | A trading outcome: too little liquidity for the minimum order, or no ask below $1. Nothing booked. |
| `EXPIRED` | CONSERVATIVE only: the fill would be more than 1 h after the source trade. Nothing booked. |
| `INVALID` | Bad data: signal price outside (0, 1), the market had settled before the fill, or the only price would be look-ahead. |
| `UNKNOWN` | No usable price at the fill time (never guessed). Excluded from the fill rate. |
| `REJECTED` | A portfolio limit refused it (reason below). **Only exists at portfolio level**; Phase 2 has no REJECTED. |

**Rejection reasons** (outcome `REJECTED`; `book.ts`)

| Reason | Meaning |
|---|---|
| `REJECTED_DUPLICATE_POSITION` | The same source fill was already taken by another signal (D1). Not a risk limit; reported apart. |
| `REJECTED_MAX_OPEN_POSITIONS` | `maxOpenPositions` lots were already open. |
| `REJECTED_MAX_WALLET_ALLOCATION` | This wallet's open lots already use its `maxWalletAllocationUsd`. |
| `REJECTED_MAX_MARKET_EXPOSURE` | This market's open lots already use `maxMarketExposureUsd`. |
| `REJECTED_INSUFFICIENT_CASH` | Cash above `minCashReserveUsd` is not enough (and resizing is off or there is none left). |
| `REJECTED_MAX_PORTFOLIO_EXPOSURE` | Open cost is already at `maxTotalExposurePct`% of equity (at cost). |
| `REJECTED_BELOW_MIN_ORDER` | The order was shrunk to fit a limit and the smaller order is below the market's minimum order. |

**D10's rule** (decided and implemented in step 8): `REJECTED_BELOW_MIN_ORDER` appears **only** with outcome `REJECTED`,
and only for a *resized* order that the minimum order then blocks (`UNFILLED` / `INSUFFICIENT_LIQUIDITY` after a resize).
A resized order that fails for any other reason keeps its own outcome and reason (e.g. `UNFILLED` / `NO_ASK_BELOW_ONE`).
Decisions written before step 8 may still carry the old label until a replay touches them.

**Execution reasons** a decision can carry (from `sim/execute.ts`; the same as Phase 2):

| Reason | With outcome | Meaning |
|---|---|---|
| `LIQUIDITY_CAP` | `PARTIALLY_FILLED` | The cap (1× / 0.5× the source trade) bound. |
| `INSUFFICIENT_LIQUIDITY` | `UNFILLED` | After the cap the order is below the market's minimum order (not resized). |
| `NO_ASK_BELOW_ONE` | `UNFILLED` | Spread and impact would push the price to $1 or more. |
| `EXECUTION_TIMEOUT` | `EXPIRED` | CONSERVATIVE's 1-hour limit. |
| `NO_PRICE_OBSERVATION` | `UNKNOWN` | No trade at or before the fill time. |
| `STALE_QUOTE` | `UNKNOWN` | The last trade is older than the mode allows (1 h / 15 min). |
| `LOOKAHEAD_OBSERVATION_REJECTED` | `INVALID` | The only price would come from after the fill time. |
| `MARKET_SETTLED_BEFORE_FILL` | `INVALID` | The market had already settled. |
| `PRICE_OUT_OF_RANGE` | `INVALID` | The observed price is not in (0, 1). |
| `INVALID_SIGNAL_PRICE` | `INVALID` | The signal's own price is not in (0, 1). |
| `FILL_PRICE_OUT_OF_RANGE` | `INVALID` | The computed fill price is not above 0. |
| `ZERO_SIZE` | `INVALID` | An order of $0 (cannot happen with a valid configuration). |
| `NOTHING_TO_SELL` | — | Exit side only: the lot had no shares left to sell. |
| `NO_BID_AFTER_SLIPPAGE` | — | Exit side only: after spread and impact no bid is left above 0, so the exit sells nothing (the lot stays open). |

A filled order that was resized carries `RESIZED:<reason>`: `RESIZED:LIMIT` (shrunk and fully filled) or
`RESIZED:LIQUIDITY_CAP` (shrunk, then partially filled). A full, unresized fill has no reason.

## 5. Reading the numbers

The `/execution` page shows one column per mode (`view.ts` renders the `cursors['paper:portfolio']` snapshot; the
report itself is the SQL function `portfolio_report`, migration `0010`, with a parity-tested JS twin in `report.ts`).

- **"As of" the watermark, not now.** Every figure is as of the last second the runner has *fully decided* (the
  watermark, `portfolio_runs.last_watermark_ts`). Rows after it are ignored; a lot that exits after the watermark is
  shown open, at cost. **Figures lag until the next signal (D12):** the watermark only moves when an entry signal is
  decided, so an exit or a resolution that happens after the latest entry is shown only once a later entry arrives.
  The lag is at most the gap between signals (minutes at current rates). "Frontier" is the first event still waiting
  for a price; nothing at or after it is decided yet.
- **Cost basis vs market value.** Two separate bases, never mixed. *Capital* and *P&L* are at **cost**: cash (derived
  from the lots: start − cost − entry fees + exit proceeds − exit fees + resolution payouts), money invested at cost,
  realised P&L net of fees. *Market value* is separate: each open lot at its latest 1h/6h/24h mark observed between its
  fill and the watermark. **`lotsWithoutMark`** ("Open lots without a mark (at cost)") counts open lots that have no
  mark yet; they are valued at cost in "Equity at marks", so a large count means that figure is mostly cost. Marks are
  observations only; they never drive a decision.
- **Drawdown.** Measured on the cost-basis equity curve (one point per fill, exit and resolution). Points older than 7
  days are thinned to the last point of each hour (`EQUITY_DENSE_DAYS`, `run.ts`), so drawdown **before "Hourly points
  before" is measured on hourly points** and a dip that recovered within the hour does not show.
- **Locked unresolved (D11).** Open lots opened 30 or more days before the watermark with no resolution: their capital
  is still committed. It is computed in the report (count, cost, oldest); the `portfolio_lots.locked_unresolved`
  column is not maintained (D11, decided).
- **Insufficient data.** Any win rate or robustness figure over fewer than 10 settled lots is shown as "insufficient
  data" — too few to read anything into.
- **Fill rate** = fills ÷ decisions, excluding `UNKNOWN` (no price data) and `REJECTED_DUPLICATE_POSITION` (not a real
  opportunity). **Rejections by reason** list the limits that bound; duplicates are shown on their own line.
- **Robustness** (settled lots, net of fees): *total excluding the best 1 / 3 / 5 / 10 lots* shows how much of the
  result depends on a handful of outliers (if removing the best three lots turns the total negative, the result rests
  on three trades); *profit factor* = gains ÷ losses (above 1 means gains exceeded losses); *average per lot*
  (expectancy) is total ÷ settled lots; plus the largest gain and loss and the median lot return. They matter because
  prediction-market P&L is dominated by a few large resolutions: a positive total alone says little.
- **By signal kind**, **exposure** (top 10 markets and wallets by cost at risk), **lots** (by state, closed by exit /
  by resolution, median holding time) and **health** (this cycle's outcome, warnings, rows waiting after the watermark,
  lease, last rewind) complete the page. There is no ranking and no verdict wording: measured figures only.

## 6. How it runs

In plain English: every 15 minutes the worker brings Phase 2 up to date, then asks each portfolio "what changed since
last time?", goes back only as far as it must, and replays forward. It saves its state every hour so it never has to
start from scratch, and it never decides anything it lacks a price for.

**The 15-minute cycle** (`makeSimCycle`, `job.ts`; first run 90 s after boot): (1) orphan resolutions
(`resolve-orphans.ts`), (2) the Phase 2 simulation: fetch queued prices, then sweep, (3) the portfolio job: IDEAL,
REALISTIC, CONSERVATIVE one after another, then the snapshot `cursors['paper:portfolio']` and the heartbeat
`health:last_portfolio`. One cycle at a time: a cycle that is still running when the next is due makes the next one a
no-op. Each step is isolated: a failure is logged and the next step still runs. With the config unset there is no step
3, and the cycle is exactly the pre-Phase-3 one.

**One mode's run** (`runPortfolios`, `run.ts`):

- **Lease.** A database lease (`claim_portfolio_lease`, 15 minutes, renewed after every batch, released at the end)
  guarantees one writer per portfolio. If another process holds it, this mode is skipped for the cycle.
- **Change detection.** It reads only the execution rows the sweep rewrote since the last run started, and compares
  each one's *decision inputs* (entry, linked exit and its time, resolution and its time — never marks) with the
  fingerprint stored in `portfolio_decisions.input_hash`. A mark-only change never causes work.
- **Checkpoints and rewinds.** If an input of something already decided changed, the run goes back to the checkpoint
  just before the earliest changed event (checkpoints are kept hourly for 10 days, daily before that, and always at the
  watermark), deletes the outputs after it, and replays forward. Every restore also re-links open lots to their current
  exit and resolution (plan B11). Rewinds are normal, not errors.
- **Why REALISTIC rewinds often (D16).** Inputs arrive late by nature: a resolution is dated at its on-chain time but
  discovered hours later (median 42 h in production), and an exit is detected after it happened. Each such arrival
  changes the past, so the run rewinds to it. On a simulated 12-hour day of 15-minute cycles REALISTIC rewound on
  54–59% of runs (median 88 minutes back), CONSERVATIVE similarly, and IDEAL on nearly every run (late-detected signals
  fill at their source time, in IDEAL's past). A rewinding run reads about twice the rows. `rewinds in last 20 runs` in
  the log is the live count (D16 is open: revisit with production counts).
- **The frontier and waiting for prices (D17).** Rows are read in fill-time order in batches of 500 (never splitting a
  second). The run stops at the first event whose price has not been fetched yet (an entry price, or the price of an
  exit that matters) and decides nothing at or after it; the watermark is the last second before it. Prices the
  portfolio needs that the Phase 2 sweep will not ask for (the sweep stops at a signal once its $100 record is final)
  are queued by the runner as `PENDING` rows in `price_observations` — existing rows untouched — and fetched by the
  next cycle's backlog (up to 3,000 per cycle). A price that cannot be fetched after 6 attempts becomes unavailable and
  the event is decided as `UNKNOWN`, so the frontier cannot wait for ever. **In a dry run these prices are counted
  (`queued N price(s)`) but not queued**, so the dry-run frontier can wait on them cycle after cycle; a real run
  queues them.
- **Writes.** Only rows whose content changed are written (hash compare), in the order outputs → checkpoints → run
  record, so an unchanged run writes nothing. A dry run writes nothing at all (no lease, no row, no snapshot).
- **"This cycle: FAILED".** On `/execution`, "FAILED this cycle — <message> (figures shown are from the last completed
  run)" means that mode's run threw (a lost lease, a database error). The other modes still ran; the next cycle tries
  again and, if the failed run had written anything past its recorded watermark, rewinds over it ("previous run did
  not finish"). If *every* mode fails, the snapshot and heartbeat are not updated that cycle.

## 7. Configuration

Two variables on the **worker** (Railway). Both are read **once at boot** (`portfolioJobSetup`, `job.ts`), so a change
takes effect only when the worker restarts: on Railway, change the variable and then deploy the service.

### `PAPER_PORTFOLIO_CONFIG`

One JSON object. Every field is required; there are **no defaults** (D5); an unknown key is refused (so a typo cannot
be silently ignored). Validation: `validatePortfolioConfig` (`config.ts`). Unset or empty → feature off. Invalid → the
worker logs one line naming the problem and the feature stays off (the rest of the worker is unaffected).

| Field | Meaning | Units | Rule |
|---|---|---|---|
| `startingCapitalUsd` | Cash the portfolio starts with | USD | number > 0 |
| `positionUsd` | Size of every order before limits | USD | number > 0 and ≤ `startingCapitalUsd` |
| `maxMarketExposureUsd` | Cap on open cost in one market (condition) | USD | number > 0 |
| `maxTotalExposurePct` | Cap on open cost as a share of equity at cost | percent (80 = 80%) | number in (0, 100] |
| `maxOpenPositions` | Cap on the number of open lots | count | integer ≥ 1 |
| `maxWalletAllocationUsd` | Cap on open cost from one source wallet | USD | number > 0 |
| `minCashReserveUsd` | Cash that entries may not spend | USD | number ≥ 0 and < `startingCapitalUsd` |
| `allowResize` | Shrink an order to fit a limit instead of rejecting it | — | `true` or `false` |
| `startTs` | First fill time the portfolio considers | ISO time with a timezone | for this deployment `"2026-09-27T04:28:38.593Z"` (below); not in the future |

The validator does **not** check that the caps are at least `positionUsd`: with `allowResize: false` and, say,
`maxMarketExposureUsd` below `positionUsd`, every order is rejected. Choose caps ≥ `positionUsd`.

Worked example — **example values, not a recommendation**. The `startTs` placeholder is deliberately invalid, so a
copy that is not edited is refused rather than silently wrong:

```json
{"startingCapitalUsd": 10000, "positionUsd": 100, "maxMarketExposureUsd": 500, "maxTotalExposurePct": 80, "maxOpenPositions": 60, "maxWalletAllocationUsd": 1000, "minCashReserveUsd": 500, "allowResize": true, "startTs": "REPLACE-WITH-THE-27-SEP-COMPLETION-TIME"}
```

On Railway paste it as one line (the value is the JSON itself, no surrounding quotes).

**`startTs` = the completion of the 27 Sep 2026 re-score (D4).** The watchlist changes when the daily re-score
*finishes*, and the bot filter took effect the day before, so the portfolio starts at the first re-score after both.
The exact instant is `cursors['refresh:last'].updated_at` right after that run (its `value` is the run's *start*; on
26 Sep the start was 04:24:51 and the completion 04:26:41). **That row is overwritten by every later re-score (next:
28 Sep 04:15 UTC), so read it on 27 Sep**, in the Supabase SQL editor:

```sql
select value, updated_at from cursors where key = 'refresh:last';
```

and use `updated_at`, in UTC with a `Z`, as `startTs` (seconds are enough). If the row has already moved on, the
Railway log line `[rescore] scored …, tracking …` of 27 Sep is printed immediately after that write; use its timestamp.
The value is never derived at runtime.

**Recorded value (read from production on 27 Sep 2026 at 22:33 UTC):** the 27 Sep re-score started at 04:26:18 and
finished at **`2026-09-27T04:28:38.593Z`**; it scored 3,958 wallets and left 179 tracked. Use exactly that as
`startTs`. The worker keeps whole seconds, so its boot line shows `start 2026-09-27T04:28:38.000Z`; that is expected.
The database row has since been overwritten by later re-scores, so this document is now the record.

**Changing any field creates a new portfolio.** The portfolio id is a hash of the mode, the execution configuration,
the portfolio configuration and `startTs` (`portfolioIdFor`, `config.ts`). Change anything — a limit, `allowResize`, the
start, or `PAPER_SIZE_USD` (the Phase 2 paper size, which is part of the execution configuration) — and the worker
starts three new portfolios from the start, fully replayed. The old ones are left untouched in the database, no longer
run and no longer shown (§9).

### `PAPER_PORTFOLIO_DRY_RUN`

| Value | Effect |
|---|---|
| unset, empty, or `0` | real runs: results are written and shown |
| `1` | dry run: everything is computed and logged, **nothing** is written (no lease, no rows, no snapshot, no heartbeat) |
| anything else (`true`, `yes`, ` 1`…) | **the feature is off** (one log line); a misspelt switch never means "write for real" |

The variable has no effect while `PAPER_PORTFOLIO_CONFIG` is unset.

### Other variables involved

- `PAPER_SIZE_USD` (Phase 2, default 100): part of every portfolio id (above). The audit must run with the worker's value.
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DB_REQUEST_TIMEOUT_MS`: the database connection
  (`src/lib/db.ts`), needed by the worker and by `npm run portfolio:audit`.

## 8. Switch-on runbook

This is the step 10 checklist. Do the steps in order; each one says what you should see and what means *stop*. The
feature stays paper-only throughout.

**Step 0 — the start time.** Done: `2026-09-27T04:28:38.593Z`, recorded in §7. (For a future re-launch from a
different date, run the `refresh:last` query in §7 after that day's re-score has finished and use `updated_at`.)

**Step 1 — apply migrations `0010` and `0011`.** Supabase → SQL Editor → paste
`supabase/migrations/0010_portfolio_report.sql` → Run; then the same for `0011_portfolio_report_access.sql`. Both
are additive and safe to run twice. (`0008` and `0009` are already live; for a fresh project apply `0001`–`0011` in
order.) Check:

```sql
select to_regclass('portfolios') as t0008, to_regclass('token_resolution_checks') as t0009,
       has_function_privilege('service_role', 'portfolio_report(text)', 'execute') as service_ok,
       has_function_privilege('anon', 'portfolio_report(text)', 'execute') as anon_denied_if_false;
```

Expect `portfolios`, `token_resolution_checks`, `true`, `false`. Anything else: stop.

**Step 2 — set the configuration with dry run on.** Railway → the worker service → Variables → Raw Editor, add both
lines *in the same edit* (so there is never a moment with the config and no dry-run switch):

```
PAPER_PORTFOLIO_DRY_RUN=1
PAPER_PORTFOLIO_CONFIG={"startingCapitalUsd": …, …, "startTs": "2026-09-27T04:…Z"}
```

**Configuration chosen by the owner for the first launch (27 Sep 2026).** $1,000 in positions of $25, so 30 can be open
at once: all 30 fit under both the 80% exposure cap and the $150 reserve including entry fees, so every mode gets the
same number of slots. At most 2 positions per market and 4 per wallet; no resizing.

```
PAPER_PORTFOLIO_CONFIG={"startingCapitalUsd": 1000, "positionUsd": 25, "maxMarketExposureUsd": 50, "maxWalletAllocationUsd": 100, "maxTotalExposurePct": 80, "maxOpenPositions": 30, "minCashReserveUsd": 150, "allowResize": false, "startTs": "2026-09-27T04:28:38.593Z"}
```

With it, the boot line reads `… · capital $1000 · $25/position`.

Deploy. At boot the log shows (timestamp prefix omitted here and below):

```
portfolio: on (dry run: nothing written) · start 2026-09-27T04:…:….000Z · capital $10000 · $100/position
```

Stop if you see `portfolio: off (invalid configuration) — …`: the rest of the line names the field (for example
`PAPER_PORTFOLIO_CONFIG: startTs must be an ISO timestamp with a timezone, e.g. "2026-09-27T04:26:41Z" (got
"2026-09-27 04:26:41")`). Fix the value and deploy again.

**Step 3 — watch at least four dry-run cycles (one hour).** About 90 seconds after boot, and every 15 minutes after,
each mode logs one line, then the dry-run note and the job's duration:

```
[portfolio] IDEAL: watermark 2026-09-28T09:58:12Z · 2410 rows · no rewind · rewinds in last 20 runs: 0 · wrote {"portfolio_decisions":2410,"portfolio_lots":…,"portfolio_equity":…,"portfolio_checkpoints":…} · deleted {} · heap 80.1→96.4 MB
[portfolio] REALISTIC: watermark … · … rows · no rewind · rewinds in last 20 runs: 0 · queued 3 price(s) · wrote {…} · deleted {} · heap …
[portfolio] CONSERVATIVE: …
[portfolio] dry run: nothing written; snapshot and heartbeat not saved
[mem:portfolio] 41.3 s · heap 80.1→97.0 MB · rss 310→322 MB
```

(Figures illustrative; the shape is exact.) What is normal in a dry run:

- `wrote {…}` is what a real run *would* write; nothing is written. `no rewind` every time (a dry run keeps no state).
- `rows` is every execution row since `startTs`: **each dry run replays everything from the start**, so rows and the
  duration grow with the days since `startTs`. The `[mem:portfolio] N s` figure is therefore a direct measure of how
  long the first real run's computation takes (the real run adds its writes on top).
- IDEAL's watermark is close to the latest signal's source time; REALISTIC and CONSERVATIVE lag by the price-fetch
  delay. `queued N price(s)` may stay above zero (counted, not queued, in a dry run; see §6).
- `/execution` still shows "Portfolio simulation is off: PAPER_PORTFOLIO_CONFIG is not set on the worker." during a dry
  run, because a dry run saves no snapshot. That message is expected here.

Stop signals: any `FAILED — …` line; `portfolio failed portfolio: every mode failed (…)`; a watermark of `—` for a mode
after several cycles while signals exist; the job duration approaching 15 minutes; heap or rss climbing cycle after
cycle (compare the `[mem:portfolio]` lines, and the 5-minute `[mem]` lines); any error mentioning `out of order` or
`rehydration did not converge` (a bug: report it).

**Step 4 — run the D13 audit.** From the project folder on your laptop, with the Railway CLI linked to the project:

```bash
railway run npm run portfolio:audit
```

(`railway link` once to select the project, environment and the worker service; `railway run` then passes that
service's variables to the command. Alternatively put the same variables in a local env file
and run `npx tsx --env-file=.env.local scripts/portfolio-audit.ts`.) It is read-only: it never writes, takes no
lease and calls no database function. During the dry run it prints the dry-run note and, per mode, `nothing to audit:
this portfolio has never run for real (no portfolios row)…`, and exits 0. That confirms the configuration parses, the
database is reachable and the portfolio ids are computed the same way as the worker's. The meaningful audit comes after
real runs (step 7): a dry run writes no decisions to check.

Exit codes: **0** clean (every difference explained) · **1** stop: unexplained differences or missing rows ·
**2** the configuration is unset or invalid (nothing was read) · **3** inconclusive: a run held the lease during the
audit; run it again between two cycles.

What it does (`auditDecisionInputs`, `src/lib/paper/portfolio/audit.ts`): for each mode it reads the stored decisions
500 at a time, rebuilds each signal's request *now* with the runner's own functions, and compares the current
fingerprint with the stored `input_hash`. Each difference is classed, first match wins:

| Class | Meaning | Exit |
|---|---|---|
| unexplained (moved entry) | the entry's fill time moved (unless it is the D13 case below); the runner does not replay that correctly (§11, D18) | 1 |
| next run | the next run re-examines it anyway: its row was rewritten since the last run, its lot is open, it sits after a crashed run's watermark, or the sweep will rewrite its row next cycle | 0 |
| (a) D13 | its Phase 2 record is final (`sim_terminal`) or it has no ledger row, and its lot is closed or was never opened: never re-examined, accepted by D13 | 0 |
| unexplained | nothing will ever re-examine it | 1 |

For each class it prints the count, the **earliest affected event** (how far back a replay would have to go) and up
to 20 examples naming the part that differs (entry / exit / resolution). Decisions whose signal or execution row no
longer exists are counted separately (exit 1). A plain-English summary is followed by the full JSON under `--- JSON ---`.

**Step 5 — switch to real runs.** Railway → Variables: set `PAPER_PORTFOLIO_DRY_RUN=0` (or delete it). Deploy. Boot
line: `portfolio: on · start … · capital $… · $…/position`.

**Step 6 — the first real run.** It is a full replay from `startTs` (there is no state yet): the same rows as a dry run,
plus the writes. Expect one line per mode with large `wrote` counts, e.g.
`[portfolio] REALISTIC: watermark … · 2410 rows · no rewind · rewinds in last 20 runs: 0 · wrote {"portfolio_decisions":2410,…,"portfolio_checkpoints":…} · deleted {"portfolio_checkpoints":…} · heap …`
(a few checkpoints are pruned at once by the hourly/daily rule). Duration: the dry-run `[mem:portfolio]` time plus
writing in batches of 500. The row count is every execution row since `startTs`: at the planning rate (about 1,630
signals a day after the bot filter, plan R5) that is on the order of 1,600 rows per mode per day since the start. The
next runs read only what changed, typically `0 rows · no rewind · wrote {} · deleted {}`, or a few hundred rows after
a rewind.

**Step 7 — check the page and audit for real.** `/execution` → "Portfolio (finite capital)": three columns, IDEAL
labelled "non-causal baseline — not a strategy that could have been run", "As of" a time within minutes of the latest
signal, "This cycle: completed" in Health, no staleness note, "insufficient data" wherever fewer than 10 lots have
settled (normal for the first days). After 24 hours of real runs, run the audit again (`railway run npm run
portfolio:audit`, between two cycles); expect exit 0 and note the D13 count and earliest time. Repeat after a week.
Exit 1: switch the feature off (§9) and report the output. Also note `rewinds in last 20 runs` for D16.

## 9. Switch-off and rollback

- **Switch off:** Railway → Variables → delete `PAPER_PORTFOLIO_CONFIG` (and `PAPER_PORTFOLIO_DRY_RUN`) → Deploy. Boot
  line `portfolio: off (PAPER_PORTFOLIO_CONFIG unset)`; the cycle is exactly the Phase 2 one again. **Nothing is
  deleted.** The `/execution` section keeps showing the last snapshot, with "The snapshot was generated … and has not
  been refreshed for …". To make it say "off", delete the snapshot row (safe; it is rebuilt when the feature is on):
  `delete from cursors where key = 'paper:portfolio';`
- **Switch back on with the same configuration:** it continues where it stopped (same ids). The first run reads every
  row rewritten while it was off and rewinds as needed.
- **Retire a portfolio:** change the configuration (any field). The old portfolios stay in the database, no longer run
  or shown. `portfolios.status` exists (`ACTIVE` / `RETIRED`) but no code reads it; marking one retired is a label only:
  `update portfolios set status = 'RETIRED' where id = '…';`
- **Safe to delete:** a portfolio that is *not* in the current configuration, entirely:
  `delete from portfolios where id = '…';` (cascades to its runs, checkpoints, decisions, lots and equity). To rebuild
  the *current* portfolio from scratch, do the same for its id with the feature off (or between cycles); the next run
  recreates it with a full replay. Also safe: the snapshot row above.
- **Not safe:** deleting only some of the current portfolio's rows (some decisions, lots, equity points or
  checkpoints, or its `portfolio_runs` row): the runner's change detection assumes they are consistent. Never delete
  Phase 2 data (`signals`, `paper_ledger`, `paper_executions`, `price_observations`, `token_resolution_obs`) to fix a
  portfolio.
- **Migrations:** `0010` and `0011` only add two report functions and restrict who may call them; there is nothing to
  roll back. With the feature off they are unused.

## 10. Troubleshooting

| Log line / dashboard message | Meaning | What to do |
|---|---|---|
| `portfolio: off (PAPER_PORTFOLIO_CONFIG unset)` | Feature off. | Nothing, unless you meant it on (§7). |
| `portfolio: off (invalid configuration) — PAPER_PORTFOLIO_CONFIG: …` | The JSON is invalid; the message names the field. Feature off. | Fix the value on Railway; deploy. |
| `portfolio: off (invalid configuration) — PAPER_PORTFOLIO_DRY_RUN must be 0 or 1, got "…"` | Misspelt dry-run switch. Feature off (never "write for real"). | Set `0` or `1`. |
| `[portfolio] MODE: skipped (lease held by another runner)` · page: "skipped this cycle — another runner holds the lease" | Another process holds the lease: an overlapping deploy, or a run killed mid-way (its lease lapses within 15 min). | Wait a cycle. Every cycle → check that only one worker instance runs. |
| `[portfolio] MODE: FAILED — lease lost during run (…)` | Renewing the lease after a batch failed: another runner took it, or the lease call itself failed. | As above; the next run rewinds over anything half-written. |
| `[portfolio] MODE: FAILED — <error>` · page: "FAILED this cycle — … (figures shown are from the last completed run)" | That mode's run threw (often a database or network error). Other modes ran. | Transient: the next cycle retries. Same error for an hour → investigate the message. |
| `portfolio failed portfolio: every mode failed (…)` | No mode completed; snapshot and heartbeat not saved this cycle. | As above; the page will show the staleness note. |
| page: "The snapshot was generated … and has not been refreshed for …" | No successful portfolio job for 45+ minutes. | Check the worker is running and its logs (off? every mode failing?). After a switch-off this is expected (§9). |
| page Warnings: "N execution row(s) were skipped in the last run because their stored fill time no longer matched their inputs; …" | Stale rows: the sweep has not recomputed them yet. | Normally clears within a cycle or two. Persisting for days → a moved entry on a final record (§11, D18): report it. |
| page Warnings: "the last run for this mode did not finish" | The previous run died mid-way (restart, crash, out of memory). | The next run rewinds over it ("previous run did not finish"). Repeating → check `[mem]` lines. |
| page "Frontier (first event still waiting for data)" stuck for hours; "Execution rows after the as-of time (waiting)" growing | A price the frontier needs is still pending or failing. | Find it: `select stats->'frontier' from portfolio_runs where portfolio_id = '…';` then `select * from price_observations where token_id = (select token_id from signals where id = '<frontier id>') and as_of = <frontier ts>;`. `PENDING`/`FAILED` → the backlog retries (6 attempts, then it is decided `UNKNOWN`). In a dry run this is expected when `queued N price(s)` stays above zero. |
| page: "Portfolio simulation is configured; no run has finished yet." | Config set, no real run finished yet (first run pending, or failing). | Wait one cycle; if it persists, check the logs. |
| page: "Portfolio simulation is off: PAPER_PORTFOLIO_CONFIG is not set on the worker." while in dry run | A dry run saves no snapshot. | Expected in dry run. |
| an error containing `out of order` or `rehydration did not converge` | A bug in the runner. | Switch off (§9) and report the log. |
| "insufficient data" | Fewer than 10 settled lots. | Not an error. |
| audit exit 1 / 2 / 3 | Unexplained differences or missing rows / config unset or invalid / a run was in progress. | 1: stop, report the JSON. 2: run with the worker's variables. 3: run again between cycles. |

## 11. Known limitations and open decisions

Decided and in force: D1 (one lot per signal; CONSENSUS under-attributed), D2 (resolutions free capital at their
on-chain time), D3 (orphan resolver), D4 (start at the 27 Sep re-score), D5 (no default limits), D10, D11 (locked
unresolved derived in the report), D12 (watermark lag, §5), D13 (accepted, plus the audit in §8), D14, D15 (the report
functions are service-role only).

Open (from `docs/PHASE3_PLAN.md`):

- **D6 — UMA-settled neg-risk markets.** Polymarket reports them resolved but gives no payout or resolution time, so
  under D2 they never settle: their lots keep capital locked (about 35% of orphan tokens when measured).
- **D7 — 648 frozen Phase 2 records from 18–20 Sep.** They cannot be recomputed. Phase 3 is unaffected (it starts 27 Sep).
- **D8 — missing token order for most markets with open ledger rows.** Those markets can fail to settle in the marker;
  a portfolio lot on such a token stays open until something resolves it.
- **D9 — about 2% of signals carry an unusable condition id.** Their market metadata cannot be found (fees and tick
  fall back to defaults) and their resolution may never be found.
- **D16 — rewinds without a safety lag.** REALISTIC rewinds on about half the runs; acceptable today, to be revisited
  with the production `rewinds in last 20 runs` count.
- **D17 — the runner queues missing prices** (§6). Recommended "accept"; not yet formally decided.

Found while writing this page (step 9); open decisions D18–D21 are listed in the plan:

- **D18 — an entry whose fill time moves after it was decided is not replayed correctly.** If a signal's evaluation
  time were corrected after the portfolio decided it, the runner rewinds to the *new* (later) fill time, so a lot
  opened at the old time survives from the checkpoint and the re-read signal is recorded as a duplicate; on a final
  Phase 2 record the row is instead skipped as stale for ever. No code changes an evaluation time today, so this is
  latent; the audit reports any such case as unexplained (exit 1).
- **D19 — the D13 audit checks nothing during a dry run** (a dry run writes no decisions). It is run then as a smoke
  test and again after the first real day and week (§8 steps 4 and 7).
- **D20 — the cash reserve can be undercut by one entry fee.** The cash check compares the order size (not size + fee)
  with cash above the reserve, exactly as the Phase 2 reference does; the overshoot is at most one entry fee (order ×
  fee rate × (1 − price): up to $5 or $7 on a $100 order at the 5% / 7% fallback rates, otherwise the market's own rate).
- **D21 — limits smaller than `positionUsd` are accepted** by validation; with `allowResize: false` every order is then
  rejected.

Other limitations: IDEAL is not causal (§2); marks are the only market-value evidence (§5); spread, impact and
liquidity are approximations (`docs/PAPER_EXECUTION.md`); `/execution` cannot tell "off" from "dry run" and keeps the
last snapshot after a switch-off (§9); `portfolios.status` is a label only (§9); the audit must run with the worker's
exact `PAPER_PORTFOLIO_CONFIG` and `PAPER_SIZE_USD`, otherwise it computes other portfolio ids and reports nothing to
audit. Scoring or filter changes after the start are regime changes for these results: record each one here with its
date.

| Date | Change affecting portfolio results |
|---|---|
| 26 Sep 2026 | Bot filter (before the start) |
| 27 Sep 2026 | Re-score = `startTs` (D4) |
