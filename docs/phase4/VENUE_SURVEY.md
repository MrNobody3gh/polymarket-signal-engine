# Venue survey for the eligibility gate (step 4.0c, Part E)

**Documentation only. No call beyond reading public pages (through a search engine, because the pages themselves were not reachable from the authoring environment).** Every statement carries its source and is marked **not verified**: the sources are search-engine summaries and third-party articles, not the venues' pages, and several are marketing or news sites. **This page does not conclude whether the owner may trade on any venue.** Gate G1 of `docs/PHASE4_PLAN.md` requires a New York-qualified lawyer, who reads the venues' own terms and the current state of the litigation. Dates matter: statements about state-level availability were changing during 2026.

Venues listed are those with a **public market-data API** found in published sources; venues without one were skipped (see the end).

## 1. US-regulated Polymarket exchange ("US exchange")
| Question | What the sources say (all **not verified**) | Source |
|---|---|---|
| API documentation | Public docs with an events, markets, series, sports and search API | https://docs.polymarket.us · https://docs.polymarket.us/api-reference/introduction |
| Does public market data need authentication? | No: the public gateway `https://gateway.polymarket.us` needs no API key | https://context7.com/websites/polymarket_us · https://agentbets.ai/guides/polymarket-us-api-guide/ (summaries) |
| Public rate limit | 60 requests per minute (the code paces this origin at ≥ 1.1 s per request, slower than the brief's 2/s) | https://agentbets.ai/guides/polymarket-us-api-guide/ (summary) |
| Order API and its authentication model (described, never used) | A trading API with signed requests and API keys tied to a verified account; one summary says "Ed25519 API key authentication", 23 REST endpoints and 2 WebSocket endpoints. The international platform's model (a wallet key, EIP-712 order signatures, HMAC for API requests) is different and not the US exchange's | https://www.quantvps.com/blog/polymarket-us-api-available (summary); international model: https://docs.polymarket.com/developers/CLOB/authentication |
| Published terms on automated trading | The same summary says the API enables "automated trading bots". **No terms-of-use text on automated trading was found**; the venue's own terms must be read | https://www.quantvps.com/blog/polymarket-us-api-available |
| Availability by US state, **including New York** | Open to US residents with full identity verification, the waitlist dropped in May 2026. Litigation: Nevada obtained a temporary restraining order in early 2026; Polymarket sued Massachusetts; the CFTC sued Connecticut, Arizona and Illinois in April 2026 over federal preemption. "Availability can differ by state while the courts decide." **No statement specific to New York was found in the sources read** | https://polymarket.review/us-access.html · https://metamask.io/news/prediction-market-overview-trends-2026 · https://startpolymarket.com/countries/united-states/ |
| Categories listed | Sports (market types MONEYLINE, SPREAD, TOTAL, PROP; documented sports API by sport and league), crypto, and others. Our own measurement on 3 Oct 2026 (4.0/4.0b run, a lower bound): 0 % esports, 3 % culture/other in the 40,053-market sample | docs above; `docs/phase4/RESULTS_2026-10-03.md` |
| Fee schedule | **Not found for the US exchange.** The fee pages the search returned belong to the international platform (`docs.polymarket.com/trading/fees`: most markets fee-free, taker fees on crypto, NCAAB and Serie A markets); they must not be applied to the US exchange | https://docs.polymarket.com/trading/fees (international) |
| Settlement currency | **Not found for the US exchange.** The plan (§12) records it as fiat-based, to be verified; the international platform settles in USDC on Polygon | `docs/PHASE4_PLAN.md` §12; https://docs.polymarket.com/trading/overview (international) |

## 2. Kalshi
| Question | What the sources say (all **not verified**) | Source |
|---|---|---|
| API documentation | Public developer docs: markets, events, series, milestones, orders, portfolio; REST and WebSocket; official SDKs | https://docs.kalshi.com · details and URLs in [`KALSHI_API.md`](KALSHI_API.md) |
| Does public market data need authentication? | No: the market-data endpoints are public | https://docs.kalshi.com/getting_started/quick_start_market_data (summary) |
| Public rate limit | Basic tier 20 read requests per second (a token budget) | https://docs.kalshi.com/getting_started/rate_limits (summary) |
| Order API and its authentication model (described, never used) | Every request signed with an RSA private key: `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, `KALSHI-ACCESS-SIGNATURE`; a demo environment exists at `demo-api.kalshi.co`; order and portfolio endpoints are under `/portfolio/`. API access is described as free, with every key belonging to an identity-verified account | https://docs.kalshi.com/getting_started/api_keys · https://allium.so/blog/kalshi-api-what-kyc-and-fees-mean-for-access/ (secondary) |
| Published terms on automated trading | **None found in the sources read.** Sources describe API trading as supported; the Member Agreement and API terms must be read | (none) |
| Availability by US state, **including New York** | Statements are about litigation, not an eligibility list. The New York State Gaming Commission sent a cease-and-desist letter on 24 Oct 2025 (sports event contracts need a gaming licence); Kalshi sued; the New York Attorney General also filed a complaint; one outlet says Kalshi "continues to run its sports markets in New York while contesting"; in September 2026 the CFTC was reported to be suing states. The sources are news and review sites with dates from late 2025 to October 2026 and disagree in emphasis. **No conclusion is drawn here** | https://www.si.com/prediction-markets/reviews/kalshi-new-york · https://news.bloomberglaw.com/securities-law/kalshi-sues-new-york-over-sports-event-contract-gaming-crackdown · https://communitynews.org/gambling-news/new-york-attorney-general-kalshi-lawsuit-36-billion/ · https://readsludge.com/2026/09/28/trumps-cftc-is-suing-states-for-kalshi-and-polymarket-backed-by-trump-jr |
| Categories listed | Events carry a `category` (sports, crypto, weather and others: politics, economics, entertainment, science and technology and so on; the exact list is recorded by the audit) | https://docs.kalshi.com/api-reference/events/get-events (summary) |
| Fee schedule | Taker fee = round up(0.07 × contracts × price × (1 − price)); maker fee on resting orders round up(0.0175 × contracts × price × (1 − price)); settlement itself carries no fee on the general schedule (the schedule has exceptions by series) | https://kalshi.com/docs/kalshi-fee-schedule.pdf · https://sailgp.com/prediction-markets/kalshi/fees (secondary) |
| Settlement currency | US dollars; contracts settle at $1.00 or $0.00 | https://sailgp.com/prediction-markets/kalshi/fees (secondary) |
| Regulatory status as published | A CFTC-designated contract market; regulation page https://kalshi.com/market-integrity/regulation | (as listed) |

## 3. PredictIt
| Question | What the sources say (all **not verified**) | Source |
|---|---|---|
| API documentation | A read-only market-data endpoint, `https://www.predictit.org/api/marketdata/all`, listing every market and its contracts | https://apidog.com/blog/top-10-prediction-market-apis-2026/ · https://search.r-project.org/CRAN/packages/rpredictit/index.html (a client library) |
| Does public market data need authentication? | No authorisation is required | https://rdrr.io/cran/rpredictit (summary) |
| Terms on the data | "License to use data made available via the API is for non-commercial use and PredictIt is the sole source of such data": a restriction that must be read against any use of the data in a trading system | https://danielkovtun.r-universe.dev/rpredictit/doc/manual.html (summary) |
| Order API and its authentication model | **None found.** No public order API was found in the sources read | (none) |
| Published terms on automated trading | **Not found** | (none) |
| Availability by US state, including New York | **Not found** | (none) |
| Categories, fee schedule, settlement currency | **Not established from the sources read** (the product is described as political markets; fees are not stated in the summaries and are not guessed here) | (none) |

## Considered and skipped (no public market-data API found in the sources read)
Crypto.com's CFTC-regulated exchange (named as a designated contract market in https://sailgp.com/prediction-markets/guide/cftc; no public prediction-market API documentation was found), Robinhood, Coinbase and Webull (consumer front-ends that offer contracts of an underlying exchange; the brief names Robinhood as offering Kalshi's), and Interactive Brokers' ForecastEx (not found in the sources read). Absence from this list is not a statement that no API exists; it records only what the searches returned.

## What this page does not do
It does not say that the owner may, or may not, trade on any venue; it does not rank the venues; it does not interpret any state's law or any court's order; it does not replace reading each venue's own terms. The next step is G1 (a New York-qualified lawyer) with this page, the venues' own terms of service and API terms, and the measurements of steps 4.0–4.0c in hand.
