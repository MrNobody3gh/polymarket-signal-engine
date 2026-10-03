# Kalshi public market-data API: what was recorded for step 4.0c (Part A1)

**Status: NOT VERIFIED.** The authoring environment could not reach `docs.kalshi.com` or any Kalshi host (the network policy answered 403 `Host not in allowlist`; the documentation-fetch tool was blocked the same way). Everything below comes from **search-engine summaries of Kalshi's published documentation pages** (the page URLs are quoted so the owner can check each statement), not from the pages themselves and not from a response. The first production run (`npm run phase4:ts-audit -- --kalshi`) is the check: it records the base URL that answered, the pagination key it saw, and every time field it found, and `S1a_RESULTS.md` prints them next to this page's claims. A statement that the run contradicts must be corrected here.

Nothing in the code uses an order, portfolio, balance, key or account endpoint. Market data is read with unauthenticated GETs only (≤ 2 requests per second, a descriptive User-Agent, no credential header exists in the client; a 401/403/451 ends requests to that host).

## Base URL
| Statement | Source | Note |
|---|---|---|
| Production base: `https://api.elections.kalshi.com/trade-api/v2` (the name says "elections" but it serves all markets); demo base `https://demo-api.kalshi.co/trade-api/v2` | https://docs.kalshi.com/getting_started/api_keys (summary) | The code's first default |
| One summary instead named `https://external-api.kalshi.com/trade-api/v2` as "the base URL for all endpoints" | https://docs.kalshi.com/getting_started/quick_start_market_data (summary) | The code's second default. `resolveKalshiBase` asks `GET /events?limit=1` on each in order and uses the first that answers; a refusal stops the search. Override with `--kalshi-base URL` |

## Authentication
- "Kalshi provides several public endpoints that don't require API keys"; the market-data endpoints need no authentication (https://docs.kalshi.com/getting_started/quick_start_market_data, summary). **If a run finds that public data needs authentication, that part stops and is reported** (the client never sends a credential).
- For orders and the portfolio, every request is signed with an RSA private key: headers `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, `KALSHI-ACCESS-SIGNATURE` (https://docs.kalshi.com/getting_started/api_keys, summary). **Described only; never used.**

## Endpoints the adapter reads (all GET)
| Endpoint | Parameters (as summarised) | Used for |
|---|---|---|
| `/events` | `status` = `unopened` \| `open` \| `closed` \| `settled`; `series_ticker`; `with_nested_markets=true`; `limit` (≤ 200); `cursor` | The listing: events with their `category` and (nested) markets, so every market carries its event's category and strike date. https://docs.kalshi.com/api-reference/events/get-events |
| `/markets` | `status`, `series_ticker`, `limit` (≤ 1000), `cursor`, `event_ticker`; multivariate (parlay) markets can be excluded | Not used by default (a market has no category of its own in the documented schema; the multivariate collections would dominate it). https://docs.kalshi.com/api-reference/market/get-markets |
| `/milestones` | `limit`, `cursor`, `minimum_start_date` | The candidate schedule source (real-world events with a `start_date`, `category`, `type`, `primary_event_tickers`). Existence and fields are **unconfirmed**; absence is reported as a note, not an error |
| series list | `GET /series` (category filter) | Not used |

## Pagination
Cursor style: each page returns `cursor`; pass it back as `cursor`; an empty cursor ends the listing (https://docs.kalshi.com/getting_started/pagination, summary). The adapter stops at the cap, an empty page, an empty cursor, a repeated page (a venue that ignores the cursor), or an error, and says which in `stoppedBecause`.

## Rate limits
Summaries of https://docs.kalshi.com/getting_started/rate_limits state a token budget: the Basic tier 200 tokens/s with most requests costing 10, i.e. 20 reads per second. **This is far above the brief's ceiling; the client keeps to ≤ 2 requests per second regardless.**

## Field names
| Field | Meaning in the summaries | Role in the audit (by name) |
|---|---|---|
| `ticker`, `event_ticker`, `series_ticker` | identifiers; the event groups markets that share times | grouping (`kalshiGroupOf`) |
| `title`, `subtitle`, `yes_sub_title`, `no_sub_title` | the question and the label of each side (e.g. the team) | title and outcome labels |
| `category` (on the **event**) | a high-level grouping (sports, crypto, weather, …) | Kalshi's own category; our stratum comes from it plus title/slug words |
| `status` (market) | `initialized`, `inactive`, `active`, `closed`, `determined`, `disputed`, `amended`, `finalized`; the **filter** values are `unopened`, `open`, `closed`, `settled` | `open` / `unopened` / `closed` / `settled` buckets |
| `created_time`, `updated_time` | bookkeeping | CREATION_LIKE / UPDATE_LIKE: never accepted |
| `open_time` | when trading opens ("active" when `open_time` passes) | **CREATION_LIKE**: a listing-like time, never an event start |
| `close_time` | after it the market is closed to new orders, awaiting determination | **CLOSE_LIKE**: a candidate for slot 2 |
| `expected_expiration_time` | "when the outcome is expected to be known": for a game "typically a few hours after the scheduled start" | **RESOLUTION_LIKE**: a forecast of the settlement; never a start or a close |
| `latest_expiration_time` | the settlement backstop (the legacy meaning of `expiration_time`) | **RESOLUTION_LIKE** |
| `expiration_time` | deprecated legacy field | RESOLUTION_LIKE on Kalshi only (a generic `expirationTime` elsewhere stays close-like) |
| `strike_date` (on the **event**) | the event-specific strike date/time | **neutral (OTHER_TIME)**: judged as a slot-1 candidate by the same rules; nothing is assumed |
| milestone `start_date` | a real-world event's start | compared with `strike_date` (schedule sources) |

`START_LIKE` is **not** assigned to any Kalshi market field by name: no documented market field genuinely denotes the event start. If `event.strike_date` (or a milestone start) turns out to be the kick-off, the audit's per-candidate verdict shows it passing the start rules (varied time of day, start ≤ resolution, not a listing time), and the owner decides.

## Documentation URLs consulted (via search summaries)
https://docs.kalshi.com/getting_started/quick_start_market_data · https://docs.kalshi.com/api-reference/market/get-markets · https://docs.kalshi.com/api-reference/market/get-market · https://docs.kalshi.com/api-reference/events/get-events · https://docs.kalshi.com/api-reference/events/get-event · https://docs.kalshi.com/getting_started/pagination · https://docs.kalshi.com/getting_started/rate_limits · https://docs.kalshi.com/getting_started/market_lifecycle · https://docs.kalshi.com/getting_started/api_keys · https://docs.kalshi.com/openapi.yaml · https://docs.kalshi.com/changelog

## To confirm on the first production run (listed in `S1a_RESULTS.md` under "Not established")
1. which base URL answers; 2. that public data needs no authentication; 3. the cursor key (`notes.cursorKey`); 4. that `with_nested_markets` and `status` are honoured (`filterHonoured`); 5. which of `open_time`, `close_time`, `expected_expiration_time`, `latest_expiration_time`, `expiration_time`, `event.strike_date` exist and in what format (the inventory table); 6. whether `/milestones` exists; 7. the multivariate / parlay share of the listing (the events endpoint is expected to exclude those collections; if it does not, the category table will show it).
