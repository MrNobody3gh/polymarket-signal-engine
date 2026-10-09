# Manual pilot runbook (use ONLY if every item in GO_NO_GO_2026-10-11.md is met)

Written 8 Oct 2026. Manual orders only. No bot, no key outside Polymarket's own app, no Grok authority.

## Limits (set by the owner in writing before the first order; these are the suggested values)
- Total pilot money: **$250**. Per order: **$10**. One open order at a time. **At most 40 orders.**
- **Stop** at cumulative **−$75**, at order 40, or on any fill more than **5 points** worse than the alert price. After a stop nothing is added.
- Only alerts that satisfy policy V1 (copy score ≥ 68, ≤ 24 h, event not started). No other markets, no discretionary trades.

## Before the first order (once)
1. Written budget and acceptance (items 3 and 4 of the memo) saved with the tax letters.
2. Funding: one transfer of the whole pilot amount into the account; record the transaction hash and the rand rate and its source (the funding leg is a disposal in rand).
3. Confirm your own status from your South African connection (geoblock endpoint) and re-read Polymarket's restricted page and fee page; save screenshots with the date.

## Per alert
1. Open the alert; check the event has not started and the price is within 5 points of the alert price. If not, **skip** and note why.
2. Place a $10 order. Prefer a limit order at the best ask (a market order may move the price). Do not chase: if it is not filled within 5 minutes, cancel and record "unfilled".
3. Within the hour, add a row to `PILOT_LOG_TEMPLATE.csv` (copy it): order id, market, outcome, UTC and SAST time, alert price, fill price, stake, fees, rand rate and its source for the acquisition.
4. At settlement, complete the row: payout, rand rate and source at disposal, proceeds, base cost, gain or loss in rand, transaction hashes.

## After each 10 orders, and at the end
- Totals: orders, unfilled, average price versus alert, fees paid, gain or loss in USDC and rand.
- Compare average price versus alert with the shadow report (about 2 points at $25; at $10 expect slightly less). A large gap means the model is wrong; stop and report.
- Keep the CSV, the rate screenshots or API source, and the wallet history for **five years**.

## What the pilot can and cannot show
It shows whether you can execute at the alert price and what the real fees and fills are. It cannot show profit: forty $10 orders carry a per-trade standard deviation of about 88 points, so a profit or a loss over 40 orders is noise. Do not scale up on a good run.
