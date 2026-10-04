# Review guide: checking whether two markets are the same (for the owner; no programming needed)

**What this is.** The code can only *propose* that a market on a US venue is "the same" as the market one of our wallets traded on the international platform. It can
never mark anything verified. Only your answers can. This guide explains the spreadsheet you fill in, what each question means, how to decide, and what to do when
you cannot decide. Nothing you do here places an order, changes the trading system, or touches a database.

**Why it matters.** Whether the evidence window can reach its sample (decision D53 and the plan's feasibility rule, §7 S2) depends on how many of our signals have a
*truly identical* market on a venue you may use. Your answers on about 60 rows per venue are the measurement; the numbers the matrix shows are computed from them.

## The two commands
1. Someone runs the title search for a venue, then `npm run phase4:review-sheet -- --venue polymarket_us --n 60` (or `kalshi`). That writes
   `docs/phase4/data/s1d_review_<venue>.csv`. **Open it in a spreadsheet** (Excel, Numbers, Google Sheets). Keep the header row. Do not add, delete, reorder or rename
   columns, and do not sort the rows into a different file.
2. You fill the columns described below and save as **CSV** (comma-separated; UTF-8 if asked). Then `npm run phase4:review-ingest -- --file <your file>` checks the
   sheet (it refuses a sheet with a missing or unknown answer and tells you the row) and writes the result file the merge reads.

## What the sample is (so you know what you are looking at)
About 60 rows, mixed in random order. **Stratum A** (30 rows): pairs where the code found a similar title (similarity at least 0.50). **Stratum B** (15): similarity 0.30 to 0.50.
**Stratum C** (15, picked at random): pairs where the code found *nothing similar*. C exists to find out what the code misses, so for these rows **you** search the venue
(see "When nothing is listed" below). A fixed seed made the draw, so re-running the command gives the same rows.

## The columns
| Column | What it is |
|---|---|
| `row_id`, `stratum`, `band`, `pair_key` | bookkeeping; leave alone. `band` is the similarity band of the best candidate. |
| `src_title`, `src_outcome` | **Our** market (on the international platform) and the side the wallet bought (for example "Lakers", "Yes", "Over"). |
| `src_category`, `src_copy_score`, `src_signals` | our category guess, the highest copy score, and how many signals sit behind this market and outcome. |
| `src_event_time (date only: markets.end_date)` | the end date we stored for the market: **a day, not a time**. It is shown for orientation only; it is never treated as a verified time. |
| `src_url` | the international platform's page for the market (`https://polymarket.com/event/<slug>`), where the full rules are. |
| `c1_…`, `c2_…`, `c3_…` | the venue's three best candidates, best first: `title`, `similarity` (0 to 1), `proposed` (Y when the code proposes it: an identifier match, or similarity at least 0.70 with equal numbers and negations and a matching outcome label), `outcomes` (the sides the venue offers), `category`, `event_time_fields` (every time-like field the venue shows, as `field=value`, **unjudged**), `rules_start` (the first 240 characters of the venue's rule text, when the listing has it), `venue_id`, `url`. |
| `proposed_candidate` | which candidate (1, 2 or 3) the code proposes, or empty. |
| `time_auto` | computed: **unknown** unless both venues have a verified-valid timestamp (plan §3.3). It is always `unknown` for now. Leave it. |
| `candidate_used` | **Optional.** Which candidate your answers are about: `1`, `2`, `3`, or `F` (see below). Empty means the proposed candidate, or candidate 1 when none is proposed. |
| `found_url` | **Optional.** The address of the same market on the venue when it is not among the three listed (needed when `candidate_used` is `F`). |
| `QUESTION`, `OUTCOME`, `TIME`, `RESOLUTION` | **Your four answers: `Y`, `N` or `U`.** Every row needs all four. |
| `NOTES` | anything you want to remember; ignored by the computation. |
| `VERIFIED`, `REJECTION_REASON` | computed on ingest; leave empty. |
| `venue`, `seed`, `population (do not edit)`, `unsearched_pairs`, `unsearched_signals` | the sheet's bookkeeping. If you change them the sheet is refused. |

## The four questions (answer for the candidate you chose)
Use **Y** only when you are sure it is the same. Use **N** when you are sure it is not. Use **U** when you cannot tell. **U counts as "not confirmed"**: anything that is
not a clear Y is treated as not tradable.

1. **QUESTION: is it the same question about the same real-world event?** "Lakers vs Celtics, 5 Oct" on both is yes. "Lakers win" against "Lakers win by more than 5" is no.
   Same teams on a different date is no. A series winner against a single game is no. A different threshold (over 220.5 against over 221.5) is no.
2. **OUTCOME: is *our side* the same side on the venue?** If the wallet bought "Lakers", is the venue's "Yes" (or its "Lakers" button) the Lakers winning? Watch inverted
   markets ("Will the Celtics lose?"), "Draw" outcomes, and venues that put the team name in the title and offer only Yes/No. The `outcomes` column shows what the venue offers.
3. **TIME: is it the same event time?** Look at the `event_time_fields` (the venue's own start and close fields) and at `src_event_time` and our page. The same kick-off
   (a few minutes apart is fine) is yes; a different day is no. If the venue shows only a deadline, not a start, and you cannot tell, answer U. *This is your reading by
   eye. The system separately needs a machine-verified timestamp before it will call anything verified (`time_auto`).*
4. **RESOLUTION: do the two venues settle it the same way?** Open both pages and read the rule text. Same means: the same source of truth (for example the official league result),
   the same treatment of overtime, postponement and cancellation, the same cut-off time, and the same meaning of "Yes". Typical differences that make it **N**: one venue voids
   on postponement and the other waits; one counts overtime and the other does not; different official sources; a different "as of" time for a price or number. The venue's
   `rules_start` shows only the beginning: **open the `url` and read the whole rule** before answering Y. If either page's rules are missing or you cannot find them, answer **U**.

## When you are unsure
Answer **U**, write why in `NOTES`, and move on. **Do not guess Y.** A U costs a little precision on paper; a wrong Y would put a mismatched market into a result.
Do not ask Grok or any tool to decide for you in this step: the point is an independent human check.

## When nothing is listed that looks right (and for every stratum C row)
Search the venue yourself (its search box, or the `venue_id`/`url` as a starting point) for the same game or question. If you find the same market, paste its address into
`found_url`, put `F` in `candidate_used`, and answer the four questions about *that* market. If the venue does not list it, answer **N** to QUESTION and the other three
(they must still be filled in) and write "not on the venue" in NOTES. This is how the false-negative rate (what the title search misses) is measured; if you skip the
search on stratum C rows the estimate of the misses is wrong.

## How long it takes
My estimate, **not measured**: about 2 to 4 minutes for a row with a clear candidate, 5 to 8 for a stratum C row you must search, so roughly 3 to 4 hours for 60 rows. Do
it in two or three sittings; the order of the rows is shuffled, so stopping and resuming does not bias anything. If time is short, a smaller `--n 30` sheet works but
widens every interval the matrix prints.

## What happens next
`review-ingest` computes, per similarity band, the share of rows you confirmed (with a Wilson 95 % interval), the share the code proposed *and* you confirmed, the share
of stratum C rows you found a match for (what the code misses), and an extrapolation to all the signals the title search covered. `phase4:merge` puts those numbers into
`FEASIBILITY_MATRIX.md`. It prints a verdict (feasible / infeasible) **only if** the stop rule `docs/phase4/stop_rule.json` was approved and committed **before** you ingested
the sheet; the review result remembers the rule it was ingested under. **Approve the rule first, then ingest** (re-ingesting is free if you did it in the other order).

Answering Y on all four does **not** make a pair "verified" by itself: verified (the word the plan uses for a mapping that may be traded) also needs the machine-verified
timestamp check, which is "unknown" until a venue time field passes the S1a audit. Your confirmation is what is measured now.
