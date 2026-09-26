# Paper execution methodology (Phase 2)

Three modes run over the same signals. **IDEAL** is the original ledger and is kept as the baseline. **REALISTIC** and
**CONSERVATIVE** add execution. All three are recomputed every 15 minutes by the worker; per-signal records land in
`paper_executions (signal_id, mode)`, aggregates in `cursors['paper:execution']`, and the dashboard at `/execution`.

## What is known vs. assumed

| Input | Provenance | Source |
|---|---|---|
| Source trade time | OBSERVED | block timestamp of the wallet's fill |
| Evaluation time | OBSERVED | `signals.evaluated_at` (new), else `paper_ledger.created_at` for live signals; missing only for the 470 V1 signals back-filled on 2026-09-18 15:16 UTC |
| Detection latency when evaluation time is missing | DERIVED | median 134 s (REALISTIC) / p90 3,173 s (CONSERVATIVE) of the observed source→evaluation latency across 36,197 live signals (p99 was 9.3 h, driven by outage backlogs) |
| Decision + execution latency | CONFIGURED | 5 + 5 s (REALISTIC), 60 + 15 s (CONSERVATIVE). No orders were ever placed, so this cannot be observed |
| Market price at the fill time | OBSERVED | last trade at or before the fill time from `/v2/prices-history?as_of=`; only buckets that END at or before the fill time are used |
| Order book / spread | **not available historically** | — |
| Spread cost | APPROXIMATED | pay 1 tick (REALISTIC) / 2 ticks (CONSERVATIVE) beyond the last trade, rounded to the tick grid against the trader |
| Impact | APPROXIMATED | + 1 / 3 ticks × (order notional ÷ source-trade notional), capped at 1× |
| Liquidity | APPROXIMATED | the source wallet's own fill proves that notional traded; we may take 1× / 0.5× of it. Excess → PARTIALLY_FILLED |
| Tick size / min order | OBSERVED when Gamma provides `orderPriceMinTickSize` / `orderMinSize`, else 0.01 / 5 shares; 0.001 below 0.04 and above 0.96 (DERIVED from Polymarket tick rules) |
| Fees | OBSERVED formula `shares × rate × p × (1−p)` (taker only). `feesEnabled=false` → 0. Rate from market metadata when present, else 0.05 / 0.07 (published "Other/General" and highest category rates) — APPROXIMATED |
| Resolution | OBSERVED `/v2/resolutions` payouts and `resolved_at`. Settlement is not an execution: no slippage, no fee |
| Marks at 1h / 6h / 24h | OBSERVED. **Observations only**; never used as execution prices |
| Portfolio limits | CONFIGURED by the operator — **no defaults** (`PAPER_PORTFOLIO_CONFIG`) |

## Fill states
- **FILLED** — full requested notional within the liquidity cap and above the minimum order.
- **PARTIALLY_FILLED** — the cap binds; P&L uses only the filled shares.
- **UNFILLED** — below the minimum order after the cap (INSUFFICIENT_LIQUIDITY), a buy that would have to pay ≥ $1 (NO_ASK_BELOW_ONE), or no bid after exit slippage.
- **EXPIRED** — fill time later than `maxSignalAgeSec` after the source trade (CONSERVATIVE: 1 h).
- **INVALID** — signal price outside (0,1), market settled before the fill (settlement tick at/before fill time), or an observation that would be look-ahead.
- **UNKNOWN** — no observation at/before the fill time, or the latest one is older than `maxQuoteAgeSec`. Not guessed.
- Portfolio only: **REJECTED** with a reason — duplicate source trade, max open positions, per-wallet allocation, per-market exposure, insufficient cash (after reserve), total exposure, or below minimum order after a resize.

## Look-ahead rules
1. The only price used to decide or price an execution at time *t* is "last trade at or before *t*", from a complete bucket.
2. Exits and resolutions are applied only to a position that exists (after its fill), and only in time order.
3. Marks and resolution values never feed back into entry fill decisions.
4. The pure simulator takes no clock, no randomness; events are ordered by (time, event type, signal id).

## Do not overfit
These parameters were set before looking at any simulated result and are frozen (`configHash` is shown on the
dashboard). Change them only with a written reason unrelated to P&L, and keep the old hash's results for comparison.

## Coverage states (Phase 2.5)
Every signal has one record per mode. `coverage_state`: **SIMULATED** (filled or partially filled), **PENDING_DATA**
(price not fetched yet — not a result), **UNAVAILABLE_DATA** (no usable trade existed at the fill time, or the fetch
failed permanently — not a trading failure), **INVALID**, **UNFILLED** (includes EXPIRED). REJECTED exists only in the
Phase 3 portfolio. Coverage % = records whose outcome is determined ÷ all records. Latency is labelled OBSERVED or
ESTIMATED per record. Reports are computed by Postgres (`paper_exec_report`, `data_quality_report`).

## Coverage states (Phase 2.5)
Every signal has one record per mode. Only **SIMULATED** rows carry P&L.

| Coverage | Meaning | In P&L? |
|---|---|---|
| SIMULATED | filled or partially filled | yes |
| PENDING_DATA | the price it needs has not been fetched yet | no — and not a loss |
| UNAVAILABLE_DATA | no trade existed at/before the fill time, the latest was too old, or the fetch failed 6 times | no — not a trading failure |
| INVALID | bad signal data, settled market, look-ahead observation | no |
| UNFILLED | liquidity cap, ≥ $1 ask, no bid, expired | no — a trading outcome |
| REJECTED | portfolio limits (Phase 3) | — |

Coverage % = (all − pending − unavailable) ÷ all. Fill rate is shown both over decided rows and over all rows.

## Memory model (Phase 2.5)
The worker never loads history. The simulation sweeps non-final signals in keyset batches of **500**: large enough to
amortise the ~8 queries per batch, small enough that a batch's inputs stay around 10 MB. Only changed records are
written (hash compare); signals whose outcome can no longer change are flagged `sim_terminal` and skipped thereafter.
All aggregates (percentiles, drawdown, robustness, per-kind, per-wallet) are computed by Postgres functions
(`paper_exec_report`, `paper_group_stats`, `data_quality_report`). Memory is sampled every 5 minutes (`health:memory`).
