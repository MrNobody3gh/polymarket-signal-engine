# Bot detection (Phase 2.5)

**Root cause of the failure.** The scorer derived fills/day from `user-stats.trade_count`. The v2 endpoint does not return
that field at the top level (its `trades` counts *distinct markets*), so fills/day was `null` for every wallet. `null`
matched none of the bot rules, so market makers such as RN1 (≈10,800 fills/day in the original snapshot) passed as
"Selective directional" and generated signals.

**Method now.** Measured from the trade feed the API actually serves (`src/lib/scoring/activity.ts`):

| Quantity | Definition |
|---|---|
| window | last 7 calendar days |
| fills | rows in `/v2/trades?user=…&taker_only=false&start=now−7d` (maker and taker fills) |
| fills/day | fills ÷ 7 — calendar days, the same definition as the original `trade_count ÷ curve days` |
| active days | distinct UTC days with ≥1 fill (reported only) |

| Status | Meaning |
|---|---|
| OK | full window read |
| LOWER_BOUND | stopped at 4,000 rows (= 571/day, already above the bot threshold); fills/day is the rate over the span read — a floor |
| INSUFFICIENT_DATA | fetch failed or zero fills in the window. fills/day stays **null**, never 0 |

**Classes** (thresholds unchanged): MARKET_MAKER (> 25 % programme income) · BOT_HIGH_FREQUENCY (> 500/day) ·
HIGH_FREQUENCY (> 150/day) · ACTIVE · INSUFFICIENT_DATA. The engine's existing filter (bot style, > 500/day, or > 25 %
programme income) now has real inputs. Insufficient data is never favourable: such a wallet cannot be "rankable"
(the existing −10 penalty) and never scores above the same wallet measured as an ordinary trader.

Measured daily by the worker for tracked wallets; the daily re-score reads it and never overwrites it.
