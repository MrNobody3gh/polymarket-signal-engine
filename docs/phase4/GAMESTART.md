# Phase 4.0e — are the US exchange's `00:00:00Z` `gameStartTime` values placeholders or real 8 pm Eastern starts?

Read-only. Public unauthenticated GETs, 1.1 s per request on the US origin, no keys, accounts or orders, no database, no migration, no new dependency or environment variable.
**The audit thresholds and placeholder rules (D68) are unchanged**: `placeholderKind` still classifies exactly 00:00:00Z as `MIDNIGHT_UTC`, `RECOMMEND_RULES` is untouched, and
the what-if below is a separate, labelled re-computation that never changes a verdict. Nothing here is a policy decision or a legal conclusion.

## Status of the measurements — read this first

**Nothing was measured by the step that wrote this.** The authoring environment has no route to the venue (`403 Host not in allowlist`). Everything below describes code, rules and
fixture tests. Every number about the real venue (counts, verdicts, what-if cells) is **still to be produced** by running the command on the infrastructure that can reach the venue:

```
npm run phase4:gamestart-check -- --venue polymarket_us     # ≤ 60 console lines; writes v_polymarket_us_gamestart.json and S1e_GAMESTART.md (≤ 80 lines)
npm run phase4:bundle -- --dir docs/phase4/data --files v_polymarket_us_gamestart.json,S1e_GAMESTART.md   # prints a paced, checksummed text bundle to paste back
npm run phase4:bundle-decode -- --in <pasted log> --out <dir>                                           # rebuilds the files, verifying checksum and length
```

Flags of the check: `--max-markets` (40,000), `--max-events` (12,000), `--max-requests` (700), `--pages-per-source` (8), `--listing-pages` (120), `--heap-budget-mb` (350), `--us-base`, `--out-dir`, `--print-files`.
A refusal (401/403/451/429-blocked) stops the origin and is reported, never worked around. A heap stop writes a partial file and exits 3.

## Part A — the daylight-saving discriminator

US leagues schedule in local time. 8 pm Eastern is 00:00Z while daylight saving time is in force (EDT, offset −240 min, until **2026-11-01 06:00:00Z**) and 01:00Z after (EST, −300 min).
A date-only value expanded to midnight UTC stays 00:00Z on every date. Every Eastern conversion uses the IANA zone `America/New_York` per value (`easternParts`), never a fixed offset;
the tests cover both sides of the transition (00:00Z on 1 Nov is still EDT).

Per sport and market type (`dstBySport`, `midnightByType`), B = events with a datetime start under EDT, A = under EST; b00/b01 and a00/a01 = those at exactly 00:00:00Z / 01:00:00Z. Verdict, in this order (fixed before any count was looked at):

| verdict | rule |
|---|---|
| `INSUFFICIENT_AFTER` | A < 10 events: too few events after the transition to conclude (stated explicitly; with today's date, 5 Oct 2026, the venue can hold only scheduled future events after 1 Nov) |
| `NO_MIDNIGHT_CLUSTER` | b00 < 5 |
| `LOCAL_TIME_SHIFT` | a01/A > a00/A and a01/A ≥ 0.5 × b00/B |
| `FIXED_UTC_PLACEHOLDER` | a00/A ≥ 0.5 × b00/B and a00 ≥ a01 |
| `UNDETERMINED` | otherwise |

The same shift test runs for `NOON_UTC`, `ET_END_OF_DAY`, `ET_MIDNIGHT` and the recurring clocks 16:00, 23:00, 19:30, 01:00 (`clockShifts`), in two scopes (sports and esports; other categories). Weak point: an exchange that rolls a slate by event
date rather than start time can mimic either answer; hence Part B.

## Part B — per-event corroboration

Three independent pieces of evidence for an event whose value is 00:00:00Z (the same rules label a contrast sample of non-midnight events):

* **S schedule** (the sports API's own event start): with a time of day and |Δ| ≤ 15 min → agree (exactly 15 agrees, 16 differs); beyond 15 min → differs; absent or itself a placeholder → none.
* **R resolution timing** (resolved events only; gap = earliest resolution-like time − start): 1 h ≤ gap ≤ 6 h → real; gap < 0 or > 24 h → placeholder; between (0–1 h, 6–24 h) → none.
* **T market type**: a futures-like market type or a non-sport/esport category → placeholder; otherwise none (game type is necessary, not sufficient).

`LIKELY_REAL` = (S agree or R real) and no placeholder evidence; `LIKELY_PLACEHOLDER` = (S differs or R placeholder or T placeholder) and no real evidence; everything else `UNDETERMINED`.
Creation time (start − created ≤ 60 min) and slate sharing are reported, not decisive. The deciding rule is written beside each label in the output.

## Part C — the what-if (labelled; nothing applied)

Per stratum (american_football, basketball, hockey, combat, other_sport, esports, politics): the usable share and verdict of `gameStartTime` as slot 1 for (baseline) the real rules, (what-if) exempting
LIKELY_REAL 00:00Z events, exempting schedule-corroborated events, and (c) the schedule start as the candidate with its own audit. The what-if applies **all** the other audit rules (ordering, creation coincidence,
start-before-close, one-time-of-day cluster) and prints the rule keys that still reject; exempting 00:00Z alone may not rescue a stratum whose remaining times cluster (`topClock`). The tests prove the baseline equals the real
`recommendSlots` and that the what-if leaves real verdicts unchanged.

Owner options (**no recommendation is made**):

* (a) keep the placeholder rule exactly as is; sports stay without a slot-1 field from this venue unless (c);
* (b) exempt 00:00:00Z only where independent evidence corroborates it per event; cost: a per-event schedule lookup, resolution timing is not available before the event ends;
* (c) take slot 1 for sports from the schedule endpoint with its own audit; cost: that endpoint's coverage and rate limit.

## Part D — the bundle

`phase4:bundle` packs the named evidence files (USTAR + gzip), prints one header `=====BUNDLE_SHA <sha256> <bytes> LINES <n>`, `PAD ` filler lines (≈ 300 KB, so a truncating log viewer keeps the data), then `B64 <idx> <3000 chars>` lines at ≤ 200 lines/s,
then `=====BUNDLE_END`. `phase4:bundle-decode` finds the last complete bundle in a pasted log and rebuilds the files; it rejects a bad checksum, wrong byte count, missing, duplicated-with-different-content or out-of-order lines, an unsafe archive name
and a corrupt tar header. Limit 20 MiB.

## Memory

One venue per process; market objects are slimmed on arrival and never retained; the collector keeps only a compact record per event, capped (`maxEvents` 12,000, `maxMarkets` 40,000, a repeated market id is counted once);
the heap guard (350 MB of the ≈ 500 MB) stops with a partial file and exit 3. Tests prove the caps and the guard.

## Decisions D99 to D104 (the owner decides; none is taken here)

| # | Question | Options |
|---|---|---|
| D99 | After the run: is 00:00:00Z a placeholder or local time per sport? | Read the Part A table per sport. If a sport is `INSUFFICIENT_AFTER` (too few events after 1 Nov 2026), either wait for more post-transition events and re-run, or decide from Part B alone |
| D100 | The Part B corroboration rule (S ≤ 15 min, R 1–6 h, the T and resolution-gap rules) | Keep; or change a threshold (a change is a new labelled what-if, not a change to the audit) |
| D101 | The audit's placeholder rule for exactly 00:00:00Z | (a) keep, (b) exempt per event with corroboration, (c) use the schedule start for sports; **no recommendation**; any change to `placeholderKind` or `RECOMMEND_RULES` is a separate decision that amends D68 |
| D102 | If (b): the one-time-of-day cluster rule (`topClock`) still rejects a clustered stratum after the exemption | Keep it as is (evening games cluster by nature, so some strata may stay rejected); or consider a per-sport allowance; the what-if prints which rule rejects |
| D103 | Use of the schedule endpoint beyond measurement (request budget 700 on the US origin at 1.1 s) | Keep the budget; raise it; or measure only a sample |
| D104 | Bundle settings (padding 300 KB, 3,000-character lines, 200 lines/s, 20 MiB) and retention of the evidence files (extends D98) | Keep; adjust if the log viewer truncates or throttles; commit the decoded files to `docs/phase4/data/` |

## Tests

`tests/phase4-gamestart.test.ts` (conversion on both sides of the transition, discriminator fixtures, classification boundaries at gap 0/1/6/24 h and schedule 14/15/16 min, what-if leaves verdicts unchanged, bounded collector),
`tests/phase4-gamestart-run.test.ts` (paging, refusal, budget, output limits, read-only, heap guard), `tests/phase4-bundle.test.ts` (round trip, corruption, pacing, size). Mutation checks: `scripts/phase4/mutations-4-0e.ts` (38 mutations, all killed).
