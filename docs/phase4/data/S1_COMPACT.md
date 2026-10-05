# S1 compact results (generated; the rules are RECOMMEND_RULES, owner decision D68; nothing here is a decision)

S1a (time fields): run 2026-10-04T22:05:15.250Z → 2026-10-04T22:10:20.758Z. Slot 1 = event start, slot 2 = close. OK = best passing field; NONE = no candidate passes; ?DATA = fewer than 30 events or no resolved ordering evidence.

| venue | stratum | slot | best field | verdict | events | deciding rule (other candidates: field:rule) |
|---|---|---|---|---|---|---|
| US | (venue) | — | — | NOT RUN | n/m | no evidence file for this venue |
| Kalshi | culture_other | 1 | NONE | REJECT | 58 | event.strike_date:minEvents, custom_strike.Date:minEvents, custom_strike.strike_date:minEvents,… |
| Kalshi | culture_other | 2 | NONE | REJECT | 58 | custom_strike.deadline:minEvents, close_time:usableShare |
| Kalshi | politics | 1 | NONE | REJECT | 58 | custom_strike.Date:minEvents, event.strike_date:minEvents, custom_strike.strike_date:minEvents,… |
| Kalshi | politics | 2 | NONE | REJECT | 58 | custom_strike.deadline:minEvents, close_time:usableShare |
| Kalshi | sports:basketball | 1 | NONE | REJECT | 58 | custom_strike.Date:minEvents, custom_strike.strike_date:minEvents, event.strike_date:minEvents,… |
| Kalshi | sports:basketball | 2 | NONE | REJECT | 58 | custom_strike.deadline:minEvents, close_time:usableShare |
| Kalshi | sports:other_sport | 1 | NONE | REJECT | 57 | custom_strike.Date:minEvents, custom_strike.strike_date:minEvents, event.strike_date:minEvents,… |
| Kalshi | sports:other_sport | 2 | NONE | REJECT | 57 | custom_strike.deadline:minEvents, close_time:usableShare |
| Kalshi | sports:american_football | 1 | NONE | REJECT | 51 | custom_strike.Date:minEvents, custom_strike.strike_date:minEvents, event.strike_date:minEvents,… |
| Kalshi | sports:american_football | 2 | NONE | REJECT | 51 | custom_strike.deadline:minEvents, close_time:usableShare |
| Kalshi | sports:baseball | 1 | NONE | REJECT | 46 | custom_strike.Date:minEvents, custom_strike.strike_date:minEvents, event.strike_date:minEvents,… |
| Kalshi | sports:baseball | 2 | NONE | REJECT | 46 | custom_strike.deadline:minEvents, close_time:usableShare |
| Intl | (venue) | — | — | NOT RUN | n/m | no evidence file for this venue |
| Kalshi | sports:soccer | 1 | NONE | ?DATA | 20 | occurrence_datetime:minEvents, custom_strike.Date:minEvents, custom_strike.strike_date:minEvent… |
| Kalshi | sports:soccer | 2 | NONE | ?DATA | 20 | close_time:minEvents, custom_strike.deadline:minEvents |
| Kalshi | crypto_short_term | 1 | NONE | ?DATA | 17 | occurrence_datetime:minEvents, event.strike_date:minEvents, custom_strike.Date:minEvents, custo… |
| Kalshi | crypto_short_term | 2 | NONE | ?DATA | 17 | close_time:minEvents, custom_strike.deadline:minEvents |
| Kalshi | sports:tennis | 1 | NONE | ?DATA | 17 | occurrence_datetime:minEvents, custom_strike.Date:minEvents, custom_strike.strike_date:minEvent… |
| Kalshi | sports:tennis | 2 | NONE | ?DATA | 17 | close_time:minEvents, custom_strike.deadline:minEvents |
| Kalshi | sports:hockey | 1 | NONE | ?DATA | 12 | occurrence_datetime:minEvents, custom_strike.Date:minEvents, custom_strike.strike_date:minEvent… |
| Kalshi | sports:hockey | 2 | NONE | ?DATA | 12 | close_time:minEvents, custom_strike.deadline:minEvents |
| Kalshi | sports:combat | 1 | NONE | ?DATA | 10 | occurrence_datetime:minEvents, custom_strike.Date:minEvents, custom_strike.strike_date:minEvent… |
| Kalshi | sports:combat | 2 | NONE | ?DATA | 10 | close_time:minEvents, custom_strike.deadline:minEvents |
| Kalshi | sports:golf | 1 | NONE | ?DATA | 10 | occurrence_datetime:minEvents, custom_strike.Date:minEvents, custom_strike.strike_date:minEvent… |
| Kalshi | sports:golf | 2 | NONE | ?DATA | 10 | close_time:minEvents, custom_strike.deadline:minEvents |
| Kalshi | crypto_other | 1 | NONE | ?DATA | 7 | occurrence_datetime:minEvents, event.strike_date:minEvents, custom_strike.Date:minEvents, custo… |
| Kalshi | crypto_other | 2 | NONE | ?DATA | 7 | close_time:minEvents, custom_strike.deadline:minEvents |
| Kalshi | sports:motorsport | 1 | NONE | ?DATA | 1 | custom_strike.Date:minEvents, custom_strike.strike_date:minEvents, event.strike_date:minEvents,… |
| Kalshi | sports:motorsport | 2 | NONE | ?DATA | 1 | close_time:minEvents, custom_strike.deadline:minEvents |

Funnel (cumulative signals, same window 2026-09-27T04:28:38.000Z → 2026-10-04T22:10:35.511Z; EXACT / EXACT+PROBABLE; n/m = stage not measured; not run = no coverage file for the venue; mapped counts are lower bounds if a listing was cut off):

| stage | US | Kalshi |
|---|---|---|
| all entry signals | not run | 7431 / 7431 |
| copy score ≥ 68 | not run | 1567 / 1567 |
| market mapped on the execution venue | not run | 0 / 0 |
| venue market tradable | not run | 0 / 0 |
| usable event timestamp | not run | 0 / 0 |
| event not started | not run | 0 / 0 |
| within 24 h | not run | 0 / 0 |
| at least MIN_LEAD of lead = Grok-eligible | not run | 0 / 0 |

Final stage per elapsed day (EXACT): US not run · Kalshi 0.0.
