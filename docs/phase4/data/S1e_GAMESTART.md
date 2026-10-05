# S1e: are `gameStartTime` values at 00:00:00Z placeholders or real evening starts? (generated; research; D68 untouched)

Sample: 33707 markets → 12000 distinct events with a datetime `gameStartTime` (0 without one, 0 date-only); 1837 events at exactly 00:00:00Z. Eastern conversions use the IANA zone America/New_York per value. 6065 events under EDT and 5935 under EST.
Fetch: 272 requests; stopped: sample cap reached (33707 markets, 12000 events).

## A. The daylight-saving discriminator (events; 00:00Z / 01:00Z counts; rules fixed before the counts)

| sport | EDT events | at 00:00Z | at 01:00Z | EST events | at 00:00Z | at 01:00Z | verdict |
|---|---|---|---|---|---|---|---|
| sports:other_sport | 1262 | 36 | 89 | 4103 | 846 | 425 | FIXED_UTC_PLACEHOLDER |
| sports:basketball | 861 | 172 | 42 | 814 | 154 | 179 | LOCAL_TIME_SHIFT |
| sports:hockey | 763 | 96 | 50 | 565 | 215 | 65 | FIXED_UTC_PLACEHOLDER |
| politics | 960 | 1 | 0 | 49 | 4 | 0 | NO_MIDNIGHT_CLUSTER |
| sports:tennis | 985 | 8 | 8 | 0 | 0 | 0 | INSUFFICIENT_AFTER |
| sports:baseball | 454 | 35 | 0 | 6 | 0 | 0 | INSUFFICIENT_AFTER |
| sports:american_football | 250 | 234 | 0 | 195 | 9 | 13 | UNDETERMINED |
| sports:soccer | 257 | 2 | 2 | 89 | 7 | 0 | NO_MIDNIGHT_CLUSTER |
| sports:combat | 105 | 3 | 3 | 95 | 13 | 0 | NO_MIDNIGHT_CLUSTER |

Recurring clocks, sports and esports (events EDT → EST; a clock that shifts +1 h with daylight saving is local time): 00:00:00 587→1244 (FIXED_UTC) · 12:00:00 22→0 (UNDETERMINED) · 16:00:00 224→14 (SHIFTS_WITH_DST) · 23:00:00 533→301 (SHIFTS_WITH_DST) · 19:30:00 71→45 (SHIFTS_WITH_DST) · 01:00:00 194→682 (FIXED_UTC); Eastern-local shapes: Eastern 00:00:00 2→3 · Eastern 23:59:xx 6→10.

Recurring clocks, other categories (events EDT → EST; a clock that shifts +1 h with daylight saving is local time): 00:00:00 2→4 (TOO_FEW) · 12:00:00 0→0 (TOO_FEW) · 16:00:00 949→0 (SHIFTS_WITH_DST) · 23:00:00 0→0 (TOO_FEW) · 19:30:00 0→0 (TOO_FEW) · 01:00:00 24→0 (UNDETERMINED); Eastern-local shapes: Eastern 00:00:00 1→0 · Eastern 23:59:xx 13→27.
At 00:00Z by sport / market type / period: sports:other_sport/MONEYLINE/EST 845ev 845mk · sports:american_football/FUTURES/EDT 234ev 2823mk · sports:hockey/MONEYLINE/EST 215ev 215mk · sports:basketball/MONEYLINE/EST 154ev 154mk · sports:basketball/MONEYLINE/EDT 56ev 56mk · sports:basketball/SPREADS/EDT 49ev 49mk.

## B. Independent corroboration per event (00:00Z group vs a same-size contrast sample at other clocks)

| | 00:00Z events | contrast events |
|---|---|---|
| LIKELY_REAL / LIKELY_PLACEHOLDER / UNDETERMINED | 0 / 298 / 1539 | 160 / 301 / 1376 |
| schedule: with a time of day / agree ≤ 15 min / differ / absent | 0 / 0 / 0 / 1825 | 161 / 160 / 1 / 1671 |
| resolved with a gap: n · p10 / p50 / p90 (h) · in 1–6 h | 0 · n/m / n/m / n/m · 0 | 0 · n/m / n/m / n/m · 0 |
| start within 1 h of creation (of n) · median days after creation | 37 of 1837 · 2 | 231 of 1837 · 2.5 |

Share of events at 00:00Z by market type: MONEYLINE 17.0 % (1347/7934) · FUTURES 18.3 % (292/1599) · TOTALS 10.6 % (88/831) · SPREADS 10.9 % (88/811) · DRAWABLE_OUTCOME 0.9 % (4/427) · FOOTBALL_TEAM_FULL_GAME_WINNER 1.0 % (1/100); by category: sports 16.9 % (1831/10825) · politics 0.5 % (5/1009) · esports 0.0 % (0/106) · culture_other 1.9 % (1/54) · crypto_other 0.0 % (0/4) · crypto_short_term 0.0 % (0/2).
Slates (sports): esports 0 instants at 00:00Z, max 8 events on one instant · sports:american_football 10 instants at 00:00Z, max 234 events on one instant · sports:baseball 3 instants at 00:00Z, max 33 events on one instant · sports:basketball 125 instants at 00:00Z, max 12 events on one instant · sports:combat 4 instants at 00:00Z, max 15 events on one instant. Rules: S schedule agrees ≤ 15 min; R resolution 1–6 h; T futures-like or non-game category; creation and slate are reported, not decisive.

## C. The what-if (LABELLED: nothing is applied; the real audit verdicts are unchanged; thresholds RECOMMEND_RULES unchanged)

usable share and verdict for `gameStartTime` as slot 1: baseline | exempt LIKELY_REAL 00:00Z events | exempt schedule-corroborated | (c) the schedule start as the candidate

| stratum | events | at 00:00Z (real / schedule-agree) | baseline | what-if real | what-if schedule | (c) schedule |
|---|---|---|---|---|---|---|
| sports:american_football | 445 | 243 (0 / 0) | 45.4 % REJECT (usableShare, placeholderShare, topClock) | 45.4 % REJECT (usableShare, placeholderShare, topClock) | 45.4 % REJECT (usableShare, placeholderShare, topClock) | n/m ?DATA |
| sports:basketball | 1675 | 326 (0 / 0) | 80.5 % REJECT (usableShare, placeholderShare, startBeforeClose) | 80.5 % REJECT (usableShare, placeholderShare, startBeforeClose) | 80.5 % REJECT (usableShare, placeholderShare, startBeforeClose) | 5.6 % REJECT (usableShare, startBeforeClose) |
| sports:hockey | 1328 | 311 (0 / 0) | 76.6 % REJECT (usableShare, placeholderShare) | 76.6 % REJECT (usableShare, placeholderShare) | 76.6 % REJECT (usableShare, placeholderShare) | n/m ?DATA |
| sports:combat | 200 | 16 (0 / 0) | 92.0 % REJECT (startBeforeClose) | 92.0 % REJECT (startBeforeClose) | 92.0 % REJECT (startBeforeClose) | n/m ?DATA |
| sports:other_sport | 5365 | 882 (0 / 0) | 83.0 % REJECT (usableShare, placeholderShare) | 83.0 % REJECT (usableShare, placeholderShare) | 83.0 % REJECT (usableShare, placeholderShare) | 2.1 % REJECT (usableShare) |
| esports | 106 | 0 (0 / 0) | 95.3 % ?DATA | 95.3 % ?DATA | 95.3 % ?DATA | 89.6 % REJECT (usableShare) |
| politics | 1009 | 5 (0 / 0) | 97.2 % REJECT (topClock, startBeforeClose) | 97.2 % REJECT (topClock, startBeforeClose) | 97.2 % REJECT (topClock, startBeforeClose) | n/m ?DATA |

A what-if cell shows the usable share and, when it still rejects, the audit rule(s) that decide (a rule other than usableShare is NOT affected by the exemption: for example topClock rejects a stratum whose starts cluster on one time of day, placeholder or not).

Options for the owner (no recommendation):
(a) keep the placeholder rule: strata passing slot 1 with `gameStartTime`: none. Cost: none; sports stay without a slot-1 field from this venue unless (c).
(b) exempt 00:00:00Z only where independent evidence corroborates it per event (rule: S agrees ≤ 15 min, or R in 1–6 h, and no placeholder evidence): passing with LIKELY_REAL exempted: none; with schedule-corroborated exempted: none. Cost: a per-event schedule lookup for each event at 00:00Z (1837 in this sample; 0 corroborated by the schedule, 0 by resolution timing, which is not available before the event ends).
(c) slot 1 for sports from the schedule endpoint with its own audit: passing: none. Cost: depends on the endpoint's coverage (1825 of 1837 midnight events and 1671 of 1837 contrast events had no schedule start in this sample) and on its own rate limit.
