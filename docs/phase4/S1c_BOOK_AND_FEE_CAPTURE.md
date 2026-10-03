# Phase 4.0 — Part D: S1c order-book and fee capture design

**Design only.** No migration, no code, nothing captured: the schemas below are text in this document, not files under
`supabase/migrations/`. Nothing here was measured; every size is arithmetic on stated assumptions (§4). Plan reference:
`docs/PHASE4_PLAN.md` §5.5 (`order_book_snapshots`), §7 S4 ("verified costs"), §9 (cost workstream), §2.13 (every outcome has a reason code).

What is **not known** and must be read from the execution venue's documentation (https://docs.polymarket.us was unreachable from the
authoring environment): the shape of its order-book response, whether it stamps the book, its tick/minimum rules, and above all its **fee schedule**. The design records
what the venue says and where it said it; it does not assume a formula for the US exchange. The one formula in this repository (taker fee = shares × rate × p × (1 − p), international platform, `sim/config.ts` ASSUMPTIONS) is kept as a *named model*, not as a default.

## 1. What to snapshot, and when

A snapshot is one read of one venue market's book and rules, **bound to a signal and a purpose**, stored as a row. Moments (all in the eligibility → decision → would-be-fill chain of §4):

| Purpose | Taken | Used for | For which signals |
|---|---|---|---|
| `CONTEXT` | when the verified context is built (after E0–E8 pass, before Grok is called) | "depth near the touch" in the context (§5.1); price at decision; spread at decision | every eligible signal |
| `AUTHORIZATION` | by the Safety Gate's re-fetch (§5.3) | price protection, depth sufficient, `STALE_CONTEXT` | Grok ACCEPT only (live and shadow) |
| `FILL_PROBE` | at `decision time + the order-latency assumption` (the would-be fill moment); optionally further probes at +30 s and +120 s for the price-movement study | the book that a real order would have met → verified costs | **every eligible signal**, so the REJECT arm and the rule-only arm have costs too |
| failures | when any of the above cannot be read | nothing is dropped silently (§2.13): an `ERROR` row with the reason | all |

Per snapshot, what to store:

| Group | Fields | Why |
|---|---|---|
| identity | `signal_id`, `source_fill_id`, `policy_version`, `purpose`, `attempt`, venue, venue market id, outcome/token id | joins to the journal; idempotent key `hash(policy_version, signal_id, purpose, attempt)` |
| book | top **N = 10** levels per side as `[price, size]` pairs, in venue units; `levels_n_bid/ask`; `book_hash` (SHA-256 of the canonical level list) | N = 10 covers the order sizes in scope (pilot positions $5–$10, plan D34) many times over; the hash proves the book was not edited |
| derived (stored for convenience, recomputable) | best bid/ask, mid, spread, depth within 1 / 2 / 5 ticks (shares and USD) | cheap filters; the walk in §6 uses `levels` only |
| rules | tick size, minimum order size (shares and/or notional), maximum if any, price bounds, neg-risk/other-outcome flags as given | order validation and rounding |
| fee | `fee_observation_id` → §3 | cost model |
| status | venue market status **raw** and normalised (`OPEN`, `CLOSED`, `RESOLVED`, `PAUSED`, `UNKNOWN`), accepting-orders flag if given | E3, `MARKET_NOT_TRADABLE` |
| latency | `request_started_at`, `response_received_at` (local UTC clock), `venue_timestamp` if the venue stamps the book, `latency_ms`, derived `clock_skew_ms` = venue stamp − local midpoint | splits price movement into detection, Grok and order latency (§9); detects clock trouble |
| diagnostics | HTTP status, endpoint, API version header if any, `raw_hash`, error text (≤ 300 chars) | reproducibility; never the raw credentials (none exist in a read-only adapter) |
| flags | `crossed` (best bid ≥ best ask), `empty_side`, `stale` (age > `CONTEXT_FRESHNESS`, 30 s, at use time) | verified-cost status (§6) |

Clock discipline: every stamp is the process's UTC clock; record the venue's own stamp and the skew rather than trusting either. Any skew > 2 s marks the snapshot `CLOCK_SUSPECT` and excludes it from latency analyses, not from cost.

## 2. Draft schema: `order_book_snapshots` (text, not a migration)

```sql
-- DRAFT. Append-only: insert only; no update or delete grants for the application role (see GAP_REPORT U6).
create table order_book_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  snapshot_key          text not null unique,          -- hash(policy_version, signal_id, purpose, attempt): a retry cannot duplicate
  signal_id             uuid not null,
  source_fill_id        text,
  policy_version        text not null,
  purpose               text not null check (purpose in ('CONTEXT','AUTHORIZATION','FILL_PROBE')),
  attempt               int  not null default 1,
  venue                 text not null,
  venue_market_id       text not null,
  venue_outcome         text not null,                 -- token / outcome id as the venue names it
  result                text not null check (result in ('OK','ERROR','EMPTY')),
  error                 text,
  request_started_at    timestamptz not null,
  response_received_at  timestamptz,
  venue_timestamp       timestamptz,                   -- null when the venue gives none
  latency_ms            int,
  clock_skew_ms         int,
  market_status_raw     text,
  market_status         text check (market_status in ('OPEN','CLOSED','RESOLVED','PAUSED','UNKNOWN')),
  accepting_orders      boolean,
  best_bid numeric, best_ask numeric, mid numeric, spread numeric,
  tick_size             numeric,
  min_order_shares      numeric, min_order_notional numeric,
  levels                jsonb,                         -- {"bids":[[price,size],...],"asks":[[price,size],...]}, ≤ 10 per side, best first
  book_hash             text,
  crossed boolean, empty_side boolean,
  fee_observation_id    uuid,                          -- -> venue_fee_observations(id)
  raw_hash              text,
  endpoint              text,
  http_status           int,
  created_at            timestamptz not null default now()
);
create index on order_book_snapshots (signal_id, purpose);
create index on order_book_snapshots (venue, venue_market_id, request_started_at);
```

Alternatives considered: one row per level (≈ 21 rows per snapshot, ≈ 2× the bytes and 20× the rows, more joins, no benefit at N = 10): rejected. Storing the full raw response: kept only for evidence-window rows if the venue's responses are small (§5).

## 3. Draft schema: `venue_fee_observations` (text, not a migration)

A fee is a property of a market, a side and a time, and its source decides whether a cost is "verified". Rows are written **only when the observation changes** (hash-diff, the pattern of `paper_executions.record_hash`), plus at most one `CONFIRMATION` row per market per 24 h, so "the fee was X at time t" is provable for any t.

```sql
-- DRAFT. Append-only.
create table venue_fee_observations (
  id                uuid primary key default gen_random_uuid(),
  venue             text not null,
  venue_market_id   text not null,
  kind              text not null check (kind in ('CHANGE','CONFIRMATION')),
  observed_at       timestamptz not null,
  fee_model         text not null,        -- named formula: e.g. 'TAKER_P_Q' (shares*rate*p*(1-p)), 'FLAT_PCT_NOTIONAL', 'NONE', 'UNKNOWN'
  taker_rate        numeric,              -- fraction; null when not provided
  maker_rate        numeric,              -- null when not provided or not applicable
  fees_apply        boolean,              -- null when the venue does not say
  source            text not null check (source in ('MARKET_ENDPOINT','FEE_SCHEDULE_ENDPOINT','ORDER_RESPONSE','DOCUMENT','DERIVED','ASSUMED')),
  source_ref        text,                 -- URL and field path, or document section
  observation_hash  text not null,        -- hash(fee_model, taker_rate, maker_rate, fees_apply, source, source_ref)
  raw               jsonb,                -- the fee-bearing fragment of the response, bounded
  created_at        timestamptz not null default now(),
  unique (venue, venue_market_id, observation_hash, kind, observed_at)
);
create index on venue_fee_observations (venue, venue_market_id, observed_at desc);
```

Provenance rule (mirrors Phase 2's OBSERVED / ASSUMED labels): `MARKET_ENDPOINT`, `FEE_SCHEDULE_ENDPOINT`, `ORDER_RESPONSE` are **observed**; `DOCUMENT` is *published*; `DERIVED` and `ASSUMED` are never "verified". The Phase 2 lesson applies: a flag read today and applied to the past is `DERIVED`, so each snapshot links the observation **current at the snapshot time**, never a later one.

## 4. Volume and storage

**Assumptions (stated, not measured):** eligible signals per day *E* — the plan's date-level proxy is about 110 (an upper bound, S1b measures the real figure), so 25, 50, 110 and 200 are shown; snapshots per eligible signal: **2.5** (CONTEXT + FILL_PROBE for all, AUTHORIZATION for the accepted ≈ 25 %) or **4** (with two extra price-movement probes); about **1.1 kB per snapshot** including the primary key and two indexes (a 20-level `jsonb` ≈ 0.5 kB, columns ≈ 0.4 kB, index entries ≈ 0.2 kB); fee rows: 0.7 × *E* distinct markets a day, ~0.4 kB, two rows a day at most.

| *E* / day | Snapshot rows / day (2.5 · 4 per signal) | MB / day | MB over 84 days (12 weeks) | Fee rows / day | Fee MB over 84 days |
|---|---|---|---|---|---|
| 25 | 63 · 100 | 0.07 · 0.11 | 5.6 · 9.0 | ≈ 18 | 0.6 |
| 50 | 125 · 200 | 0.13 · 0.21 | 11 · 18 | ≈ 35 | 1.1 |
| 110 | 275 · 440 | 0.30 · 0.47 | 25 · 40 | ≈ 77 | 2.5 |
| 200 | 500 · 800 | 0.54 · 0.86 | 45 · 72 | ≈ 140 | 4.6 |

Read: at any plausible *E* the capture is tens of megabytes for the whole evidence window, a few hundred rows a day, a few hundred venue reads a day (≈ 2 kB each). Compare with the project's actual database size limit, which this step could not read. One-row-per-level instead of `jsonb` at *E* = 110 would be ≈ 5,800 rows/day and ≈ 0.7 MB/day (per-level ≈ 0.1 kB assumed).

## 5. Retention proposal

| Data | Keep | Why |
|---|---|---|
| Snapshots and fee observations linked to an **evidence window** (a locked `policy_version`), plus the rows of any signal that produced a shadow or live order | **forever** (and never edited) | they are the evidence the verdict is computed from (D44); small |
| Snapshots from S2 calibration (not evidence) | **30 days**, then pruned by a `prune_working_data`-style function (migration 0004 is the pattern; worker daily job) | calibration data has no later use once constants are set |
| `ERROR` snapshots | same as their window | outage statistics (`MAX_GROK_FAILURE_RATE`-style rates for the venue) |
| Raw venue responses | `raw_hash` only, except for evidence rows if responses are small (< 5 kB): full text in a `raw` column | reproducibility without bloat |
| Fee observations | forever | tiny, and each is a fact about a fee at a time |

## 6. "Verified costs": walking the recorded book

Verified costs replace the simulator's approximations (spread ticks, linear impact, participation caps; `sim/config.ts`) by what a real order **would have met**, using the `FILL_PROBE` snapshot (the book at decision + order latency); the `CONTEXT` snapshot gives the price the decision saw.

Inputs: signal side (BUY a token), notional *N* in USD (the pilot position), limit-price cap *L* (price protection, `PRICE_TOLERANCE`), the snapshot, the fee observation.

1. **Validate.** Result OK, status OPEN, not crossed, not stale at use (age ≤ `CONTEXT_FRESHNESS`), levels present on the needed side; otherwise cost status `NO_BOOK` / `STALE_BOOK` / `MARKET_NOT_TRADABLE` and the trade is **excluded from verified-cost statistics** (and counted, per §2.13).
2. **Round the order.** Round *L* down to a tick multiple; drop it if below the minimum order (shares or notional): `BELOW_MIN_ORDER`.
3. **Walk the asks** from the best ask upward: at each level with price *p ≤ L*, take `s = min(level size, remaining notional / p)`, accumulate shares and cost; stop when the notional is spent, the cap is reached, or the 10 stored levels are exhausted. Unspent notional = `unfilled_usd`; if the stored levels end before *N* and *L* has not been reached the fill is `PARTIAL_BOOK` (unknown beyond N levels, never extrapolated).
4. **Outputs:** `filled_shares`, `filled_usd`, `avg_price`, `levels_consumed`, `unfilled_usd`, **slippage vs the signal price** (`avg_price − signals.price`), **vs the decision-time mid** (`CONTEXT` mid), **vs the touch** (`avg_price − best_ask`), spread at fill, depth within 1/2/5 ticks.
5. **Fee.** From the observation current at the snapshot time: if `fee_model` is a known named formula and `source` is observed, `fee_usd` by that formula on the walked fills (for `TAKER_P_Q`: Σ shares × rate × p × (1 − p)); if `fees_apply = false`, 0; if the rate is `DERIVED`/`ASSUMED` or the model `UNKNOWN`, cost status `FEE_NOT_VERIFIED` (the trade is kept in descriptive tables but not in the absolute gate).
6. **Status:** `VERIFIED` only when steps 1–5 all hold; otherwise one of `NO_BOOK`, `STALE_BOOK`, `MARKET_NOT_TRADABLE`, `BELOW_MIN_ORDER`, `PARTIAL_BOOK`, `FEE_NOT_VERIFIED`. The absolute gate (§7 S5) uses `VERIFIED` rows and reports the share that is not.
7. Net return per dollar for a settled trade = (payout − `filled_usd` − `fee_usd`) / `filled_usd`; exits use the same walk on the bid side.

Variants reported side by side (so no parameter is tuned to a result): optimistic = `CONTEXT` book; **base = `FILL_PROBE` book**; pessimistic = the worse of `FILL_PROBE` and the +120 s probe. Deterministic: same snapshot → same numbers (a pure function, tested like `sim/execute.ts`).

## 7. The plan's §9 cost measurements, and what each needs

Baseline (plan §1, international platform, paper): about **11 points of stake** per trade = 6.7 (price movement, spread, impact) + 4.5 (fees). None of the following has been measured on the execution venue.

| §9 measurement | Inputs | Computation | Status |
|---|---|---|---|
| Price movement signal → decision → would-be fill, split into **detection**, **Grok** and **order** latency | `signals.price`, `created_at`, `evaluated_at`; `CONTEXT` and `FILL_PROBE` mids and stamps; Grok `latency_ms` | mid change per segment, in ticks and points of stake, by stratum | Detection lag exists today (`evaluated_at − created_at`; S1b reports its share within 600 s); Grok and order segments need shadow data |
| Spread | `best_bid`, `best_ask` per snapshot | distribution by market type, time to event, price band | needs snapshots |
| Depth and impact by walking the book | `levels` | §6 steps 3–4 for the pilot notional and for 2× and 5× it | needs snapshots |
| Fee behaviour by market type and side, maker versus taker where supported | `venue_fee_observations` | rate by stratum; cost by side | needs the venue's fee schedule (unknown here) |
| Effect of price-protection limits (share blocked and their forward results) | `FILL_PROBE` levels, *L* swept over a **pre-registered** grid | share where the walk is capped; forward returns of blocked vs filled | needs snapshots and settled outcomes; the grid is fixed before the window |
| Limit-order behaviour versus other order types where supported | the venue's order types (unknown); shadow orders | would-be fills for limit-at-ask, limit-inside-spread | needs the venue's rules; V1 is limit-only (D38) |
| Partial and missed fills | `unfilled_usd`, `PARTIAL_BOOK` | rates by size and stratum | needs snapshots |
| Time to fill | shadow orders have none; only live pilot orders do | — | **not measurable in shadow**; first measurable in the pilot |

Rules carried from §9: no parameter is changed to improve historical results; every change is versioned and evaluated forward; the absolute gate uses observed costs only.

## 8. Open decisions this design raises

Snapshot cadence beyond the three moments (the +30 s and +120 s probes); N = 10 levels; whether evidence rows keep raw responses; the retention of calibration snapshots; whether `FILL_PROBE` for REJECT-arm signals is worth the venue reads (it is what makes the arms comparable on cost); the venue's rate limits for book reads (unknown).
