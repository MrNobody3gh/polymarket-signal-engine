# D24 — leave the exit and resolution out of the input hash of a decision that never opened a lot

Status: **implemented (compare side, with D26)**; the analysis below is as written on 29 Sep 2026, before the implementation. See docs/PORTFOLIO.md §11 (D24–D29) for what was built and what remains (D27 checkpoint fix, D28 residual class, D29).
Written 29 Sep 2026 after the first production audit; repository head at the time `e114ef6`.

## 1. What happened, and why (the unexplained difference)

The audit of 29 Sep 2026 (~13:31 UTC) reported exit 1 with exactly one unexplained difference in three portfolios. Read-only
queries against production (only `SELECT`; nothing was written) identify it. It is **not** the signal first suspected
(CONSERVATIVE `8f5b11d2`; its stored hash already carries the exit, `…@1790634035` = 22:20:35). It is:

| | |
|---|---|
| Decision | CONSERVATIVE, `44ff1fc1-1e84-403c-bf78-5cfe238459d6`, NEW_POSITION, event 13:52:50, `REJECTED_MAX_OPEN_POSITIONS`, decided 22:12:22 |
| Stored `input_hash` | `f64e330259a2c01a\|-@-\|-@-` (no exit, no resolution) |
| Linked exit | `1d00d0f9…`, source 22:13:45, evaluated 22:19:20; CONSERVATIVE fill 22:20:35 |
| Its $100 execution row | `UNKNOWN` / `NOT_ENTERED`, `computed_at` 14:17:52 (never rewritten) |
| Its ledger row | `sim_terminal = false` (REALISTIC's record for the signal is `PARTIALLY_EXITED`) |
| Siblings | IDEAL and REALISTIC copies of the same signal carry the exit (`@1790633625`, `@1790633970`); their rows were rewritten 22:32:43 |

Across the whole database it is the only decision whose stored hash says "no exit" although a linked exit exists.

**Cause.** The runner re-reads a decided signal only when its mode's `paper_executions.computed_at` moves (change detection,
plan §B2). The sweep rewrites a row only when the $100 record's hash changes. A `NOT_ENTERED` record has no exit fields, so a
late exit leaves it byte-identical: the row never moves, nothing re-reads the decision, and the fingerprint (which includes
the exit) drifts away from the stored hash. The audit cannot call it D13 (accepted: "never recomputed") because the sweep
*does* still visit the signal — its ledger row is not `sim_terminal`, since another mode is still open — so the audit's
last branch reports it as unexplained. The same happens in IDEAL when a resolution arrives after an exit already closed the
position (record unchanged), and in any mode when the decision never opened a lot.

Other causes were tested and ruled out (`tests/phase3-stale-hash.test.ts`, each mutation-checked):

1. *A row rewritten while a run is in progress falls between two windows*: no. The next run starts at the previous run's
   **start**, so a row stamped after it is read (test: the rewrite is landed mid-run; the next run repairs the hash). Not
   the cause here: the sweep and the portfolio job are serial in one worker, and the row was stamped hours before.
2. *`hashFixes` skipped on some path*: no. A run that dies before it refreshes hashes leaves them for the next run, which
   re-reads the same rows (crash path); a change before the restored checkpoint (a decision the rewind does not replay) is
   refreshed by `fixInputHashes`. Over 16 random live worlds in production order and cadence, **0** decisions were *lost*
   (stale although their row was rewritten inside the window the finishing run had to read); every unexplained difference
   was the invisible kind.
3. *Changes that never touch `computed_at`*: **yes, this is the cause** (above).
4. *The audit's classification too narrow*: partly. It is correct that nothing will re-examine the decision; it is
   over-strict in calling it unexplained without saying that it cannot matter. The audit now says so (`effect=none`).

## 2. Is the D24 claim true in the code?

Claim: for a decision that never opened a lot (REJECTED, UNFILLED, EXPIRED, INVALID, UNKNOWN), the signal's own exit and
resolution cannot affect any decision, lot or equity number.

**Argument, by code path** (`src/lib/paper/portfolio/book.ts`, `run.ts`):

| Place | Depends on the signal's own exit / resolution? |
|---|---|
| `enter()` duplicate check (`taken`) | No. `taken` is written only after a lot opens (`book.ts` `this.taken.set` after the fill); a rejected signal adds nothing. |
| `enter()` open-position, wallet, market, cash, total-exposure checks | No. They read the *other* open lots (their cost), cash and equity. Those depend on the other lots' exits and resolutions, which are in **their** fingerprints (they opened lots, so they keep them). |
| `enter()` resize / `simulateEntry` (`UNFILLED`, `EXPIRED`, `INVALID`, `UNKNOWN`) | No. `simulateEntry` takes the entry input only. |
| `scheduleFor` (where `sig.exit` and `sig.resolution` are read) | Only after a fill. A no-lot decision returns before it. |
| Ordering (`entryKey`, `submit`) | Entry fill time and kind only. |
| Frontier (`frontierOf`, `exitWait`) | A pending exit price holds *later* events back (a scheduling effect), computed from the current request, not from the stored hash; entries before the exit are decided, and when the price arrives nothing about the decision changes. |
| Rehydration (B11) | Open lots only. |
| Reports (`report.ts`, `0010`) | Read outcome and reason, and lots; `input_hash` is used by nothing but change detection and the audit. |

**Evidence** (`tests/phase3-d24.test.ts`, 17 tests; mutation-checked: making a no-lot outcome depend on its exit, or on its
resolution, fails 16 and 14 of them). For 3 modes × 5 limit profiles (roomy, tight, exposure-bound, cash-bound, resize) × 6
random histories (bursts in one second, duplicate source trades, late evaluations, out-of-range prices, missing prices), the
test replaces the exit and the resolution of **every** signal that did not open a lot with other random ones, replays from
scratch, and requires decisions, lots, equity curve and totals to be identical:

- 16,308 no-lot decisions checked, 15,920 with a real perturbation, alongside 3,492 decisions that did open a lot;
- all five outcomes without a lot (REJECTED, UNFILLED, EXPIRED, INVALID, UNKNOWN) and twelve distinct reasons, including all six
  `REJECTED_*` limit reasons;
- a control: the same perturbation applied to signals that *did* open a lot changes the equity curve in every round, so the
  harness can see a dependence when there is one.

Through the real sweep and runner: in every one of the 16 random live worlds a fresh replay of the final inputs equals the
incrementally-run database (decisions, lots, equity), `input_hash` aside — including the worlds in which stale hashes were
present.

So the claim holds. It is an invariant of the book, not of the data: a future rule that lets a rejected signal depend on its
own exit would break it, and `tests/phase3-d24.test.ts` is the guard that must stay in CI if D24 is adopted.

## 3. What D24 would change — and a design constraint

The fingerprint is computed from the *request*, before the book decides, so it cannot know whether the signal will open a
lot. D24 therefore cannot be a change to `fingerprint()`; it has to be applied where the outcome is known:

- **Compare side (recommended).** `detectChanges`, the rehydration check and the audit read `outcome` along with `input_hash`
  (one more column). If the stored decision's outcome is not `FILLED` / `PARTIALLY_FILLED` (exactly the decisions with a lot:
  `enter()` opens a lot iff `filledShares > 0`), compare the **entry part only**; otherwise compare the whole hash. Stored
  values and the fingerprint format stay as they are.
- **Store side (alternative).** Store `entry|-@-|-@-` for such decisions and compare like with like. This changes stored values
  and needs the transition below.

**Transition.**

- *Compare-side rule*: no re-hash is needed. A stored old-format hash and the new comparison agree on the entry part, so a
  mixed state is fine, and nothing rewinds. An optional one-time canonicalisation (a pure string transform of the stored
  hash of every no-lot decision to `<its own stored entry part>|-@-|-@-`, done in JS because `record_hash` is a JS hash) only
  makes stored values uniform. It must keep the **stored** entry part and must not recompute from current inputs: recomputing
  would silently accept a genuine entry change made since the decision (a real change would be hidden). It never rewinds
  and touches only `input_hash` / `record_hash`.
- *Store-side, if the re-hash were skipped*: every no-lot decision would compare unequal. Whenever the sweep rewrites the
  row (marks alone rewrite about 1,400 REALISTIC rows an hour, plan §Measured), `rewindPoint` would find the old
  exit/resolution part different and rewind to that time — up to days back — for decisions that cannot change; and the audit
  would report about 96% of all decisions as differing. That is the failure to avoid, and why the compare-side rule is
  preferred.

The runner and the audit must use the same rule (the audit imports the runner's request builder for the same reason).

## 4. Measured

Production, 29 Sep 2026 ~14:00 UTC, read-only:

| | CONSERVATIVE | IDEAL | REALISTIC |
|---|---|---|---|
| Decisions | 1,973 | 1,986 | 1,973 |
| … that never opened a lot | 1,878 (95.2%) | 1,919 (96.6%) | 1,904 (96.5%) |
| Stored resolution part predates a resolution | 54 | 20 | 44 |
| … of which never opened a lot / open lot / closed lot | **54** / 0 / 0 | **20** / 0 / 0 | **44** / 0 / 0 |
| Audit differences (owner's run, 13:31) | 56 | 20 | 45 |
| D24 would remove (at least) | 55 (54 + the exit case) = 98% | 20 = 100% | 44 = 98% |

The one or two differences per mode that D24 does not necessarily remove are the "row rewritten after the last run started"
kind, which the next run re-reads anyway and which the queries above cannot classify.

Synthetic (`tests/phase3-stale-hash.test.ts`, 16 random live worlds, audited at the end): 1,240 decisions, 132 differ, **127
(96.2%) of them never opened a lot and differ only in exit / resolution**; the other 5 involve a lot or an entry change.

**Would it hide a real change?** Not for a decision's own exit or resolution (section 2). Kept unchanged by D24 and still
detected: any change to the entry part (kind, wallet, market, token, source key including `source_fill_id`, entry timing,
price, size, observation, market metadata), for every decision; the whole hash for every decision that has a lot; the D18
moved-entry case; a decision that stops being rejected because *another* lot's exit or resolution changed (that lot's own
hash changes and the runner rewinds through it). D24 also removes the audit's D13 class for never-opened lots, which was
100% of the D13 differences in production, so a non-empty audit would mean something.

## 5. Recommendation: adopt, with conditions

Adopt the **compare-side** rule (option b in the plan) once the owner has decided, with these conditions:

1. Compare-side, outcome-aware; no change to `fingerprint()`, its format, the stored values, or any decision, lot, equity or
   signal rule; no rewind and no re-hash needed. The canonicalisation is optional.
2. `tests/phase3-d24.test.ts` stays in CI as the guard of the invariant D24 relies on.
3. The audit keeps its `effect=none` / `effect=possible` field and one-line output, so a future difference is still visible.
4. Documented in `PORTFOLIO.md` §8/§11 and the D13 wording updated ("closed lots" only).

Until then (D25) the single difference of 29 Sep is `effect=none` and changes no number; the owner may accept it for the
switch-on, or wait for D24.

## 6. Proposed tests for the implementation

1. The 29 Sep shape (`tests/phase3-stale-hash.test.ts`, "reproduces it") flips: no unexplained difference; the existing
   `it.fails` "DESIRED" test starts passing (remove `.fails`).
2. Entry part still compared for a no-lot decision: change `source_fill_id`, the entry time or the market metadata → rewind
   and replay as today (test 4a of the audit suite must keep failing the audit).
3. A no-lot decision whose entry change makes it open a lot is replayed to `FILLED` with the whole hash stored.
4. A decision with a lot keeps whole-hash comparison: a late exit / resolution on it is still detected and replayed.
5. Mixed state: old-format hashes for no-lot decisions cause no rewind and no audit difference; the optional canonicalisation
   changes only `input_hash` / `record_hash`, never a decision, lot or equity row, and is idempotent.
6. A rewind caused by another lot's exit still re-decides a no-lot signal whose outcome depends on that lot.
7. Fresh-replay equality over random live worlds with D24 on (the existing property test, with zero unexplained).
8. The runner and the audit agree on every decision in the random worlds (same rule in both).
9. `tests/phase3-d24.test.ts` unchanged and passing; mutation checks: comparing the whole hash again fails 1–2; ignoring the
   entry part fails 2.
