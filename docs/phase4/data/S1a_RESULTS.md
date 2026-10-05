# S1a timestamp audit — generated results

Run: 2026-10-04T22:05:15.250Z → 2026-10-04T22:10:20.758Z. Requests: 586 (ok 573; failures {"RATE_LIMITED":1}).

Endpoints used: `https://api.elections.kalshi.com/trade-api/v2/events`

Documentation to confirm field meanings against: https://docs.polymarket.com, https://docs.kalshi.com/getting_started/quick_start_market_data, https://docs.kalshi.com/api-reference/events/get-events, https://docs.kalshi.com/api-reference/market/get-markets, https://docs.kalshi.com/getting_started/pagination, https://docs.kalshi.com/getting_started/rate_limits, https://docs.kalshi.com/getting_started/market_lifecycle

All reliability rules are evaluated per **distinct event** (one representative market per event); the thresholds are `RECOMMEND_RULES` (owner decision D68) and are unchanged.

## Not established in this run

- polymarket_intl: NOT RUN (no v_polymarket_intl_audit.json in docs/phase4/data); not a zero
- polymarket_us: NOT RUN (no v_polymarket_us_audit.json in docs/phase4/data); not a zero

## kalshi

Open sample 300, resolved sample 300. Fetch: open 20000 markets in 12 pages (sample size reached); resolved 16000 in 14 pages (sample size reached).

### Strata: markets and distinct events

| stratum | markets | distinct events | open | resolved |
|---|---|---|---|---|
| crypto_other | 33 | 7 | 1 | 32 |
| crypto_short_term | 42 | 17 | 10 | 32 |
| culture_other | 58 | 58 | 26 | 32 |
| politics | 58 | 58 | 26 | 32 |
| sports:american_football | 58 | 51 | 26 | 32 |
| sports:baseball | 58 | 46 | 26 | 32 |
| sports:basketball | 58 | 58 | 26 | 32 |
| sports:combat | 25 | 10 | 25 | 0 |
| sports:golf | 32 | 10 | 26 | 6 |
| sports:hockey | 26 | 12 | 26 | 0 |
| sports:motorsport | 4 | 1 | 4 | 0 |
| sports:other_sport | 58 | 57 | 26 | 32 |
| sports:soccer | 32 | 20 | 26 | 6 |
| sports:tennis | 58 | 17 | 26 | 32 |

### Time-field inventory

| field | name suggests | present | formats | placeholder share | top times of day |
|---|---|---|---|---|---|
| `close_time` | CLOSE_LIKE | 100 % | datetime_utc:600 | 27 % | 04:59:00 14%, 03:59:00 14%, 14:00:00 14% |
| `created_time` | CREATION_LIKE | 100 % | datetime_utc:600 | 0 % | 09:02:18 5%, 20:04:20 3%, 09:02:08 3% |
| `custom_strike.Date` | OTHER_TIME | 1 % | datetime_utc:2 date_only:1 | 33 % | 14:00:00 100% |
| `custom_strike.deadline` | CLOSE_LIKE | 0 % | date_only:1 | 100 % |  |
| `custom_strike.strike_date` | OTHER_TIME | 0 % | datetime_offset:2 | 0 % | 18:30:00 100% |
| `event.last_updated_ts` | UPDATE_LIKE | 100 % | datetime_utc:600 | 0 % | 09:05:03 7%, 21:31:26 5%, 21:01:38 4% |
| `event.strike_date` | OTHER_TIME | 10 % | datetime_utc:62 | 2 % | 22:00:00 82%, 15:00:00 6%, 21:00:00 5% |
| `expected_expiration_time` | RESOLUTION_LIKE | 100 % | datetime_utc:600 | 5 % | 15:00:00 44%, 14:00:00 28%, 22:05:00 9% |
| `expiration_time` | RESOLUTION_LIKE | 100 % | datetime_utc:600 | 7 % | 15:00:00 41%, 14:00:00 28%, 22:00:00 9% |
| `latest_expiration_time` | RESOLUTION_LIKE | 100 % | datetime_utc:600 | 7 % | 15:00:00 41%, 14:00:00 28%, 22:00:00 9% |
| `occurrence_datetime` | OTHER_TIME | 91 % | datetime_utc:544 | 7 % | 15:00:00 32%, 14:00:00 26%, 22:05:00 9% |
| `open_time` | CREATION_LIKE | 100 % | datetime_utc:600 | 5 % | 21:00:00 11%, 14:00:00 11%, 20:00:00 7% |
| `settlement_ts` | RESOLUTION_LIKE | 36 % | datetime_utc:214 | 0 % | 23:19:48 7%, 20:22:21 3%, 22:09:47 3% |
| `updated_time` | UPDATE_LIKE | 100 % | datetime_utc:600 | 0 % | 00:00:02 3%, 21:31:32 3%, 22:01:19 3% |

### Verdict per stratum and slot (per distinct event; the rule that decided is shown)

| stratum | slot | field | verdict | decided by | events / markets | usable | Eastern-date placeholders | failed rules / evidence |
|---|---|---|---|---|---|---|---|---|
| crypto_other | 1 | `occurrence_datetime` | INSUFFICIENT_DATA | minEvents | 7 / 33 | 71 % | 0 % | present on 5 < 30 distinct events |
| crypto_other | 2 | `close_time` | INSUFFICIENT_DATA | minEvents | 7 / 33 | 100 % | 0 % | present on 7 < 30 distinct events |
| crypto_short_term | 1 | `occurrence_datetime` | INSUFFICIENT_DATA | minEvents | 17 / 42 | 29 % | 71 % | present on 17 < 30 distinct events |
| crypto_short_term | 2 | `close_time` | INSUFFICIENT_DATA | minEvents | 17 / 42 | 88 % | 12 % | present on 17 < 30 distinct events |
| culture_other | 1 | `occurrence_datetime` | UNRELIABLE_REJECT | usableShare | 58 / 58 | 76 % | 8 % | usable share 75.9 % < 90 % of events; placeholder share 10.2 % > 10 % of events; start ≤ resolution in 84.4 % < 99 % of 32 resolved events |
| culture_other | 2 | `close_time` | UNRELIABLE_REJECT | usableShare | 58 / 58 | 50 % | 50 % | usable share 50.0 % < 90 % of events; placeholder share 50.0 % > 10 % of events |
| politics | 1 | `occurrence_datetime` | UNRELIABLE_REJECT | usableShare | 58 / 58 | 72 % | 11 % | usable share 72.4 % < 90 % of events; placeholder share 10.6 % > 10 % of events; start ≤ resolution in 50.0 % < 99 % of 30 resolved events; start ≤ close_time (+15 min) in 55.9 % < 95 % of events |
| politics | 2 | `close_time` | UNRELIABLE_REJECT | usableShare | 58 / 58 | 76 % | 24 % | usable share 75.9 % < 90 % of events; placeholder share 24.1 % > 10 % of events |
| sports:american_football | 1 | `occurrence_datetime` | UNRELIABLE_REJECT | topClock | 51 / 58 | 96 % | 0 % | one time of day (15:00:00) holds 52 % of events > 50 %; start ≤ close_time (+15 min) in 40.5 % < 95 % of events |
| sports:american_football | 2 | `close_time` | UNRELIABLE_REJECT | usableShare | 51 / 58 | 75 % | 26 % | usable share 74.5 % < 90 % of events; placeholder share 25.5 % > 10 % of events |
| sports:baseball | 1 | `occurrence_datetime` | UNRELIABLE_REJECT | usableShare | 46 / 58 | 78 % | 0 % | usable share 78.3 % < 90 % of events |
| sports:baseball | 2 | `close_time` | UNRELIABLE_REJECT | usableShare | 46 / 58 | 76 % | 24 % | usable share 76.1 % < 90 % of events; placeholder share 23.9 % > 10 % of events |
| sports:basketball | 1 | `occurrence_datetime` | UNRELIABLE_REJECT | usableShare | 58 / 58 | 90 % | 2 % | usable share 89.7 % < 90 % of events; one time of day (15:00:00) holds 64 % of events > 50 %; start ≤ resolution in 12.9 % < 99 % of 31 resolved events; start ≤ close_time (+15 min) in 11.8 % < 95 % of events |
| sports:basketball | 2 | `close_time` | UNRELIABLE_REJECT | usableShare | 58 / 58 | 64 % | 36 % | usable share 63.8 % < 90 % of events; placeholder share 36.2 % > 10 % of events |
| sports:combat | 1 | `occurrence_datetime` | INSUFFICIENT_DATA | minEvents | 10 / 25 | 100 % | 0 % | present on 10 < 30 distinct events |
| sports:combat | 2 | `close_time` | INSUFFICIENT_DATA | minEvents | 10 / 25 | 100 % | 0 % | present on 10 < 30 distinct events |
| sports:golf | 1 | `occurrence_datetime` | INSUFFICIENT_DATA | minEvents | 10 / 32 | 50 % | 17 % | present on 6 < 30 distinct events |
| sports:golf | 2 | `close_time` | INSUFFICIENT_DATA | minEvents | 10 / 32 | 80 % | 20 % | present on 10 < 30 distinct events |
| sports:hockey | 1 | `occurrence_datetime` | INSUFFICIENT_DATA | minEvents | 12 / 26 | 92 % | 0 % | present on 11 < 30 distinct events |
| sports:hockey | 2 | `close_time` | INSUFFICIENT_DATA | minEvents | 12 / 26 | 92 % | 8 % | present on 12 < 30 distinct events |
| sports:motorsport | 1 | `custom_strike.Date` | INSUFFICIENT_DATA | minEvents | 1 / 4 | 0 % | — | present on 0 < 30 distinct events |
| sports:motorsport | 2 | `close_time` | INSUFFICIENT_DATA | minEvents | 1 / 4 | 0 % | 100 % | present on 1 < 30 distinct events |
| sports:other_sport | 1 | `occurrence_datetime` | UNRELIABLE_REJECT | usableShare | 57 / 58 | 83 % | 0 % | usable share 82.5 % < 90 % of events; start ≤ close_time (+15 min) in 65.9 % < 95 % of events |
| sports:other_sport | 2 | `close_time` | UNRELIABLE_REJECT | usableShare | 57 / 58 | 83 % | 18 % | usable share 82.5 % < 90 % of events; placeholder share 17.5 % > 10 % of events |
| sports:soccer | 1 | `occurrence_datetime` | INSUFFICIENT_DATA | minEvents | 20 / 32 | 80 % | 15 % | present on 20 < 30 distinct events |
| sports:soccer | 2 | `close_time` | INSUFFICIENT_DATA | minEvents | 20 / 32 | 65 % | 35 % | present on 20 < 30 distinct events |
| sports:tennis | 1 | `occurrence_datetime` | INSUFFICIENT_DATA | minEvents | 17 / 58 | 100 % | 0 % | present on 17 < 30 distinct events |
| sports:tennis | 2 | `close_time` | INSUFFICIENT_DATA | minEvents | 17 / 58 | 82 % | 18 % | present on 17 < 30 distinct events |

### Every candidate field judged per stratum and slot (same rules and thresholds; the best passing field, if any, is marked)

| stratum | slot | candidate field | name suggests | verdict | decided by | events with the field | usable | failed rules |
|---|---|---|---|---|---|---|---|---|
| crypto_other | 1 | `occurrence_datetime` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 5 / 7 | 71 % | present on 5 < 30 distinct events |
| crypto_other | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 4 / 7 | 57 % | present on 4 < 30 distinct events |
| crypto_other | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 7 | 0 % | present on 0 < 30 distinct events |
| crypto_other | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 7 | 0 % | present on 0 < 30 distinct events |
| crypto_other | 2 | `close_time` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 7 / 7 | 100 % | present on 7 < 30 distinct events |
| crypto_other | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 7 | 0 % | present on 0 < 30 distinct events |
| crypto_short_term | 1 | `occurrence_datetime` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 17 / 17 | 29 % | present on 17 < 30 distinct events |
| crypto_short_term | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 2 / 17 | 12 % | present on 2 < 30 distinct events |
| crypto_short_term | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 17 | 0 % | present on 0 < 30 distinct events |
| crypto_short_term | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 17 | 0 % | present on 0 < 30 distinct events |
| crypto_short_term | 2 | `close_time` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 17 / 17 | 88 % | present on 17 < 30 distinct events |
| crypto_short_term | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 17 | 0 % | present on 0 < 30 distinct events |
| culture_other | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 11 / 58 | 17 % | present on 11 < 30 distinct events |
| culture_other | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 4 / 58 | 0 % | present on 4 < 30 distinct events |
| culture_other | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 2 / 58 | 3 % | present on 2 < 30 distinct events |
| culture_other | 1 | `occurrence_datetime` | OTHER_TIME | UNRELIABLE_REJECT | usableShare | 49 / 58 | 76 % | usable share 75.9 % < 90 % of events; placeholder share 10.2 % > 10 % of events; start ≤ resolution in 84.4 % < 99 % of 32 resolved events |
| culture_other | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 58 | 0 % | present on 0 < 30 distinct events |
| culture_other | 2 | `close_time` | CLOSE_LIKE | UNRELIABLE_REJECT | usableShare | 58 / 58 | 50 % | usable share 50.0 % < 90 % of events; placeholder share 50.0 % > 10 % of events |
| politics | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 10 / 58 | 3 % | present on 10 < 30 distinct events |
| politics | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 4 / 58 | 7 % | present on 4 < 30 distinct events |
| politics | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 58 | 0 % | present on 0 < 30 distinct events |
| politics | 1 | `occurrence_datetime` | OTHER_TIME | UNRELIABLE_REJECT | usableShare | 47 / 58 | 72 % | usable share 72.4 % < 90 % of events; placeholder share 10.6 % > 10 % of events; start ≤ resolution in 50.0 % < 99 % of 30 resolved events; start ≤ close_time (+15 min) in 55.9 % < 95 % of events |
| politics | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 58 | 0 % | present on 0 < 30 distinct events |
| politics | 2 | `close_time` | CLOSE_LIKE | UNRELIABLE_REJECT | usableShare | 58 / 58 | 76 % | usable share 75.9 % < 90 % of events; placeholder share 24.1 % > 10 % of events |
| sports:american_football | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 51 | 0 % | present on 0 < 30 distinct events |
| sports:american_football | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 51 | 0 % | present on 0 < 30 distinct events |
| sports:american_football | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 51 | 0 % | present on 0 < 30 distinct events |
| sports:american_football | 1 | `occurrence_datetime` | OTHER_TIME | UNRELIABLE_REJECT | topClock | 50 / 51 | 96 % | one time of day (15:00:00) holds 52 % of events > 50 %; start ≤ close_time (+15 min) in 40.5 % < 95 % of events |
| sports:american_football | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 51 | 0 % | present on 0 < 30 distinct events |
| sports:american_football | 2 | `close_time` | CLOSE_LIKE | UNRELIABLE_REJECT | usableShare | 51 / 51 | 75 % | usable share 74.5 % < 90 % of events; placeholder share 25.5 % > 10 % of events |
| sports:baseball | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 21 / 46 | 0 % | present on 21 < 30 distinct events |
| sports:baseball | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 46 | 0 % | present on 0 < 30 distinct events |
| sports:baseball | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 46 | 0 % | present on 0 < 30 distinct events |
| sports:baseball | 1 | `occurrence_datetime` | OTHER_TIME | UNRELIABLE_REJECT | usableShare | 36 / 46 | 78 % | usable share 78.3 % < 90 % of events |
| sports:baseball | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 46 | 0 % | present on 0 < 30 distinct events |
| sports:baseball | 2 | `close_time` | CLOSE_LIKE | UNRELIABLE_REJECT | usableShare | 46 / 46 | 76 % | usable share 76.1 % < 90 % of events; placeholder share 23.9 % > 10 % of events |
| sports:basketball | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 58 | 0 % | present on 0 < 30 distinct events |
| sports:basketball | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 58 | 0 % | present on 0 < 30 distinct events |
| sports:basketball | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 58 | 0 % | present on 0 < 30 distinct events |
| sports:basketball | 1 | `occurrence_datetime` | OTHER_TIME | UNRELIABLE_REJECT | usableShare | 53 / 58 | 90 % | usable share 89.7 % < 90 % of events; one time of day (15:00:00) holds 64 % of events > 50 %; start ≤ resolution in 12.9 % < 99 % of 31 resolved events; start ≤ close_time (+15 min) in 11.8 % < 95 % of events |
| sports:basketball | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 1 / 58 | 0 % | present on 1 < 30 distinct events |
| sports:basketball | 2 | `close_time` | CLOSE_LIKE | UNRELIABLE_REJECT | usableShare | 58 / 58 | 64 % | usable share 63.8 % < 90 % of events; placeholder share 36.2 % > 10 % of events |
| sports:combat | 1 | `occurrence_datetime` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 10 / 10 | 100 % | present on 10 < 30 distinct events |
| sports:combat | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 10 | 0 % | present on 0 < 30 distinct events |
| sports:combat | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 10 | 0 % | present on 0 < 30 distinct events |
| sports:combat | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 10 | 0 % | present on 0 < 30 distinct events |
| sports:combat | 2 | `close_time` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 10 / 10 | 100 % | present on 10 < 30 distinct events |
| sports:combat | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 10 | 0 % | present on 0 < 30 distinct events |
| sports:golf | 1 | `occurrence_datetime` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 6 / 10 | 50 % | present on 6 < 30 distinct events |
| sports:golf | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 10 | 0 % | present on 0 < 30 distinct events |
| sports:golf | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 10 | 0 % | present on 0 < 30 distinct events |
| sports:golf | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 10 | 0 % | present on 0 < 30 distinct events |
| sports:golf | 2 | `close_time` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 10 / 10 | 80 % | present on 10 < 30 distinct events |
| sports:golf | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 10 | 0 % | present on 0 < 30 distinct events |
| sports:hockey | 1 | `occurrence_datetime` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 11 / 12 | 92 % | present on 11 < 30 distinct events |
| sports:hockey | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 12 | 0 % | present on 0 < 30 distinct events |
| sports:hockey | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 12 | 0 % | present on 0 < 30 distinct events |
| sports:hockey | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 12 | 0 % | present on 0 < 30 distinct events |
| sports:hockey | 2 | `close_time` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 12 / 12 | 92 % | present on 12 < 30 distinct events |
| sports:hockey | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 12 | 0 % | present on 0 < 30 distinct events |
| sports:motorsport | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 1 | 0 % | present on 0 < 30 distinct events |
| sports:motorsport | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 1 | 0 % | present on 0 < 30 distinct events |
| sports:motorsport | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 1 | 0 % | present on 0 < 30 distinct events |
| sports:motorsport | 1 | `occurrence_datetime` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 1 | 0 % | present on 0 < 30 distinct events |
| sports:motorsport | 2 | `close_time` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 1 / 1 | 0 % | present on 1 < 30 distinct events |
| sports:motorsport | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 1 | 0 % | present on 0 < 30 distinct events |
| sports:other_sport | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 5 / 57 | 0 % | present on 5 < 30 distinct events |
| sports:other_sport | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 57 | 0 % | present on 0 < 30 distinct events |
| sports:other_sport | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 57 | 0 % | present on 0 < 30 distinct events |
| sports:other_sport | 1 | `occurrence_datetime` | OTHER_TIME | UNRELIABLE_REJECT | usableShare | 48 / 57 | 83 % | usable share 82.5 % < 90 % of events; start ≤ close_time (+15 min) in 65.9 % < 95 % of events |
| sports:other_sport | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 57 | 0 % | present on 0 < 30 distinct events |
| sports:other_sport | 2 | `close_time` | CLOSE_LIKE | UNRELIABLE_REJECT | usableShare | 57 / 57 | 83 % | usable share 82.5 % < 90 % of events; placeholder share 17.5 % > 10 % of events |
| sports:soccer | 1 | `occurrence_datetime` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 20 / 20 | 80 % | present on 20 < 30 distinct events |
| sports:soccer | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 20 | 0 % | present on 0 < 30 distinct events |
| sports:soccer | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 20 | 0 % | present on 0 < 30 distinct events |
| sports:soccer | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 20 | 0 % | present on 0 < 30 distinct events |
| sports:soccer | 2 | `close_time` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 20 / 20 | 65 % | present on 20 < 30 distinct events |
| sports:soccer | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 20 | 0 % | present on 0 < 30 distinct events |
| sports:tennis | 1 | `occurrence_datetime` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 17 / 17 | 100 % | present on 17 < 30 distinct events |
| sports:tennis | 1 | `custom_strike.Date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 1 / 17 | 0 % | present on 1 < 30 distinct events |
| sports:tennis | 1 | `custom_strike.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 17 | 0 % | present on 0 < 30 distinct events |
| sports:tennis | 1 | `event.strike_date` | OTHER_TIME | INSUFFICIENT_DATA | minEvents | 0 / 17 | 0 % | present on 0 < 30 distinct events |
| sports:tennis | 2 | `close_time` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 17 / 17 | 82 % | present on 17 < 30 distinct events |
| sports:tennis | 2 | `custom_strike.deadline` | CLOSE_LIKE | INSUFFICIENT_DATA | minEvents | 0 / 17 | 0 % | present on 0 < 30 distinct events |

### Listing (bounded): 40000 markets, 5130 events; by status {"open":26019,"settled":9380,"unopened":201,"closed":3127,"unknown":1273}

| Kalshi category | open | unopened | closed | settled | total |
|---|---|---|---|---|---|
| Elections | 9801 | 20 | 0 | 2030 | 12580 |
| Sports | 6833 | 120 | 55 | 3036 | 10116 |
| Entertainment | 3471 | 27 | 219 | 1046 | 4923 |
| Financials | 1691 | 1 | 1431 | 560 | 3703 |
| Politics | 1402 | 8 | 18 | 543 | 2154 |
| Economics | 1694 | 0 | 4 | 78 | 1795 |
| Mentions | 134 | 0 | 33 | 1456 | 1655 |
| Commodities | 0 | 22 | 1266 | 0 | 1288 |
| Science and Technology | 318 | 1 | 25 | 142 | 498 |
| Crypto | 112 | 0 | 7 | 323 | 460 |
| Companies | 394 | 2 | 0 | 14 | 423 |
| Climate and Weather | 125 | 0 | 69 | 149 | 346 |
| Social | 19 | 0 | 0 | 0 | 26 |
| World | 7 | 0 | 0 | 0 | 10 |
| Health | 10 | 0 | 0 | 0 | 10 |
| AI | 6 | 0 | 0 | 3 | 9 |
| Transportation | 1 | 0 | 0 | 0 | 1 |
| Business | 1 | 0 | 0 | 0 | 1 |
| (none) | 0 | 0 | 0 | 0 | 1 |
| Education | 0 | 0 | 0 | 0 | 1 |

### Date-level alternative (SHOWN, NOT RECOMMENDED; the in-play check cannot be evaluated at date level)

| stratum | field | events | with an implied Eastern date | ET midnight | ET end of day | date-only | implied date ≤ resolution date (checked) | median days before resolution |
|---|---|---|---|---|---|---|---|---|

### `gameStartTime` deep dive (field: not present on this venue; event start field: none; market type field: `market_type`)

## Schedule sources (event-level start with a time of day versus the other start field)

### Kalshi: milestone start_date versus event strike_date

| group | events | source has a time of day | other has a time of day | both | equal within 1 min | within 15 min | |diff| p50 / p90 / max (min) | source placeholders |
|---|---|---|---|---|---|---|---|---|
| Elections | 1 | 0 | 0 | 0 | 0 (—) | 0 | — / — / — | 1 |


## The same event on both venues (participant names + Eastern date; D51 input)

Not available (a venue was not audited).

## Venue agreement by recommended fields (D51 input)

Not available: the venues were audited in separate processes (4.0d, one venue per process): the cross-venue start-time comparison needs two listings in one process and is not made

## Kalshi category inventory (no market loaded)

Base https://api.elections.kalshi.com/trade-api/v2; 535 of 600 requests; **CUT**: GET /events?status=settled: RATE_LIMITED 429 (counts are lower bounds). Category source: /search/tags_by_categories.

| category | series | events open | unopened | closed | settled | events total |
|---|---|---|---|---|---|---|
| Sports | 3821 | 4939 | 12 | 83 | 47304 | 52338 |
| Crypto | 275 | 106 | 1582 | 7 | 24079 | 25774 |
| Commodities | 86 | 44 | 944 | 34 | 9807 | 10829 |
| Elections | 1872 | 3473 | 0 | 3 | 1126 | 4602 |
| Financials | 989 | 686 | 77 | 124 | 2896 | 3783 |
| Climate and Weather | 415 | 251 | 8 | 13 | 2789 | 3061 |
| Entertainment | 2547 | 688 | 0 | 72 | 869 | 1629 |
| Economics | 835 | 593 | 4 | 7 | 779 | 1383 |
| Politics | 2404 | 680 | 1 | 8 | 525 | 1214 |
| Mentions | 453 | 74 | 0 | 4 | 411 | 489 |
| Science and Technology | 358 | 177 | 3 | 4 | 176 | 360 |
| Companies | 179 | 81 | 0 | 2 | 24 | 107 |
| Social | 52 | 9 | 0 | 0 | 7 | 16 |
| AI | 6 | 5 | 0 | 0 | 2 | 7 |
| Health | 96 | 6 | 0 | 0 | 1 | 7 |
| World | 143 | 4 | 0 | 0 | 3 | 7 |
| (none) | n/m | 1 | 0 | 0 | 1 | 2 |
| Business | 1 | 1 | 0 | 0 | 0 | 1 |
| Education | 1 | 0 | 0 | 0 | 1 | 1 |
| Transportation | 38 | 1 | 0 | 0 | 0 | 1 |
| Exotics | 14 | n/m | n/m | n/m | n/m | n/m |

Markets per category and status: markets are never loaded; the number of markets per category and status is NOT AVAILABLE without paging through them (no total is returned).

Esports: a category with an esports-like NAME was not found; series matched by title or tag: 132; events matched by title: 1085 (in Entertainment, Sports). Basis: an esports/gaming word (esports, League of Legends, Counter-Strike, CS2, Dota, Valorant, Overwatch, Rocket League, StarCraft, Call of Duty, CDL/LCK/LCS/LPL/LEC) in a category name, a series title or tag, or an event title; `categoryExists` is about category NAMES only, the match counts are about titles.

- KXGAMEAWARDSBET: Best Esports Team
- KXEWCEASPORTSFC: EA SPORTS FC 25 at 2025 Esports World Cup WINNER
- KXOWGAME: Overwatch Game
- KXCODGAME: Call of Duty Games
- KXLOLAWARD: League of Legends Award

What the endpoints allowed:
- GET /search/tags_by_categories answered: 17 categories
- GET /series lists every series with its category, title and tags (series per category is exact)
- GET /events (status filter, cursor, no nested markets) counts events per category and status exactly, by streaming

What they did not allow:
- GET /markets: a limit=1 page returns a cursor but no total, so the number of markets per category and status cannot be read without paging through them
- GET /events: no total either; the event counts above come from counting pages as they arrive

Total-like members of the `limit=1` probes:
- /events: no total in the answer (members: cursor, events, milestones)
- /markets: no total in the answer (members: cursor, markets)

## Venue runs merged

| venue | audit file | status |
|---|---|---|
| polymarket_intl | v_polymarket_intl_audit.json | not run |
| polymarket_us | v_polymarket_us_audit.json | not run |
| kalshi | v_kalshi_audit.json | run |
