# Phase 4 — live execution, shadow first: plan v2

Status: **DRAFT v2 for owner approval. Nothing here is built, and no code is to be written until the owner approves this plan.**
v1: 30 Sep 2026. v2: 1 Oct 2026, against `main` at `a8400ba`. Not legal, tax or financial advice. Decisions marked *owner* are the owner's alone.

## 0. Summary

Phase 4 builds a **live executor** fed by a **deterministic eligibility pipeline**, a **Grok Strategic Gate** and a **deterministic Safety Gate**,
checked by **reconciliation** and protected by **emergency controls**. Everything is built and proven in **shadow mode** first: the whole
pipeline runs, orders are built and logged, nothing is sent, and no trading key exists.

**Division of labour (final):** the system supplies facts; Grok exercises judgement on those facts; deterministic code enforces safety; only the
executor touches money.
`Grok chooses opportunities. The Safety Gate controls safety. The executor controls money. No layer can bypass the next.`

**Changes since v1:** Grok Strategic Gate added (D41 replaced by D42–D50); policy V1 defined (§3); venue made a precondition for the evidence lock
(D53); contracts for the Grok gate and the Safety Gate specified (§5); shadow, calibration and evidence sequence specified (§7); inconclusive-result
rule (D50); separate cost-reduction workstream (§9); conditions for Grok to enter the live path (G7); new measured facts (§1).

## 1. Where we start (measured 1 Oct 2026; clean regime since 27 Sep 04:28 UTC, 4.6 days)

**Exists:** signal engine, three-mode paper execution, portfolio book with limits and checkpoints, reports, D13 audit, alerts with a 1 h freshness limit,
bot filtering. **Does not exist** (verified by searching the repository): order submission, key handling, a Risk Gate, a Trade Runner, any Grok layer in
this repository (Grok is used in the owner's separate Sentinel project as an X-sentiment analyst, veto-only), a kill switch, order reconciliation.

**Paper results (hypotheses, not conclusions):**
- Independent $100 ledger, settled trades: IDEAL 2,164, **+9.1 %** of stake; REALISTIC 1,958, **−5.4 %**; CONSERVATIVE 1,854, **−8.2 %**.
- Where REALISTIC's gap comes from (same 1,958 signals): IDEAL **+5.8 %** → price movement, spread and impact **−6.7 points** → **−0.9 %** before fees →
  fees **−4.5 points** → **−5.4 %** net. Fees are 99 % observed; 98 % of trades are in fee-charging markets.
- Capital-limited portfolios ($1,000, $25 positions): equity at marks $980 / $677 / $902 (IDEAL / REALISTIC / CONSERVATIVE); 94–98 % of signals are
  rejected because slots, cash or exposure are full; only 41 / 50 / 70 trades settled.
- By copy score (REALISTIC / IDEAL return): 50–59: −7.7 % / +6.1 %; 60–67: −3.1 % / +12.7 %; 68–74: −5.6 % / +9.9 %; 75+: −2.4 % / +7.9 %. **No clear
  gradient.** Score ≥ 68 is **24 % of signals from 20 wallets** (latest count; three wallets produce all of the 75+ band).
- Per-trade return standard deviation is **89 %**; the 1,990 settled REALISTIC trades sit in only 702 markets and 103 wallets.
- **Event time:** the only field stored, `markets.end_date`, is a **date without a time of day**. 45 % of signals have an end date on the same UTC day,
  11 % the next day, 14 % within 7 days, 20 % later, 3 % already passed, 8 % no usable date. The 24-hour rule cannot be computed from it.
- Flow: about 828 entry signals a day; about 200 a day with score ≥ 68; about 110 a day after a date-level 24-hour proxy (estimate, before the in-play rule,
  market mapping and Grok's acceptance rate).

**Caveats:** 4.6 days; settled-only counts favour quick markets; spread, impact and liquidity are approximated (no historical books); historical fee flags are
today's.

## 2. Principles (non-negotiable)

1. **Fail closed.** Any doubt means no new orders; resting orders are cancelled where safe.
2. **One path to money.** Only the executor holds a key and it accepts only an `AuthorizedOrder` from the Safety Gate. Not the worker, Telegram, the
   dashboard, an assistant or Grok can create one.
3. **Append-only journal.** Corrections are new rows (D18 rule).
4. **Never assume.** A timeout is `UNKNOWN`, never "failed" or "filled"; an `UNKNOWN` order is never resubmitted until reconciled.
5. **Nothing live that paper has not measured.** Includes Grok, stop-loss, take-profit and time stops.
6. **Shadow before live; small before large; manual before automatic.**
7. **Hard caps set by the owner and enforced outside the code that decides.**
8. **Humans decide the gates.** No script, assistant or model opens a gate.
9. **No circumvention** of any jurisdictional or venue restriction.
10. **Grok is a selector, not a control.** Its selection value must be demonstrated forward; until then it observes.
11. **The system supplies facts, Grok supplies judgement.** Grok never supplies an authoritative value.
12. **Policies are versioned.** A locked policy is never edited; any change is a new version and a new evidence window.
13. **Every outcome has a reason code.** Nothing is dropped silently, including Grok outages and capacity rejections.

## 3. Policy V1

### 3.1 Named policies
- **V1-shadow:** eligibility pipeline, Grok decisions recorded, hypothetical orders recorded, nothing sent. Runs from the lock (§7).
- **V1-live-rule:** eligibility pipeline + Safety Gate + executor, **no Grok**.
- **V1-live-grok:** as V1-live-rule, but a Grok ACCEPT is required. May exist only after G7 (§6).
Each decision records the policy version, scoring version, model ID, prompt version and context-builder version that produced it.

### 3.2 Eligibility chain (deterministic; all checks evaluated and every failure recorded; Grok is called only if none fails)

| # | Check | Reject code |
|---|---|---|
| E0 | Not a duplicate of a source fill already processed under this policy | `DUPLICATE` |
| E1 | Signal age ≤ `MAX_SIGNAL_AGE` | `SIGNAL_STALE` |
| E2 | Market mapped to an execution-venue market with verified identical question and resolution rules | `UNMAPPED` / `MAPPING_UNVERIFIED` |
| E3 | Execution-venue market tradable (open, not resolved or invalid) | `MARKET_NOT_TRADABLE` |
| E4 | Event timestamp present, valid and unambiguous (§3.3) | `TIMESTAMP_MISSING` / `TIMESTAMP_AMBIGUOUS` / `TIMESTAMP_VENUE_MISMATCH` |
| E5 | Event has not started (§3.4) | `EVENT_STARTED` |
| E6 | Event is within 24 h (§3.4) | `BEYOND_HORIZON` |
| E7 | At least `MIN_LEAD` before the event (§3.4) | `TOO_CLOSE_TO_START` |
| E8 | Copy score ≥ 68/100 at signal time, with the pinned scoring version (§3.5) | `SCORE_BELOW_MIN` / `SCORE_VERSION_MISMATCH` |
Existing upstream filters (bot and market-maker wallets, freshness of the watchlist) are unchanged.

### 3.3 Timestamp hierarchy and venue authority
For the **execution venue's mapped market**, in this order:
1. **`event_start_time`**: the venue-provided scheduled start of the real-world event (a match kick-off, a scheduled event), with time of day and offset. Used whenever present and valid.
2. **`market_close_time`**: the venue-provided trading deadline with time of day, used only when (1) is absent (deadline-type markets).
3. Otherwise **REJECT** (`TIMESTAMP_MISSING`).

Never used: a date-only value, a resolution or settlement time, our stored `markets.end_date`, any value written by Grok, or the signal venue's time when the
execution venue differs. Validation: ISO-8601 with offset, converted to UTC; between the evaluation time and 400 days ahead; fields known (from the audit,
§7 S1) to hold placeholder values for a market type are rejected for that type; if both (1) and (2) exist and (1) is later than (2) by more than the
tolerance, `TIMESTAMP_AMBIGUOUS`. Metadata must have been fetched within `METADATA_FRESHNESS` and is **re-fetched and re-validated at authorization**
(events are postponed). The journal stores the source field name and raw value of every timestamp used.
**Venue authority:** the execution venue is authoritative. If the signal venue differs and provides its own time for the same event, the two must agree
within `TIMESTAMP_TOLERANCE` (D51), else `TIMESTAMP_VENUE_MISMATCH`.
*Provisional until the S1 audit has inspected real responses from every candidate venue; the audit may change which field names fill (1) and (2), not the hierarchy.*

### 3.4 The 24-hour, in-play and lead-time rules (exact)
`time_to_event = event_time_utc − evaluation_time_utc`, where `evaluation_time_utc` is recorded by the system when the eligibility chain runs.
- `time_to_event ≤ 0` → **REJECT** `EVENT_STARTED` (a started event or a passed deadline; in-play signals are rejected in V1: the aim is to copy before the event, not chase one underway).
- `0 < time_to_event ≤ 24 h` → eligible. Exactly 24:00:00 is eligible; 24 h + 1 s is `BEYOND_HORIZON`.
- `time_to_event > 24 h` → **REJECT**.
- `time_to_event < MIN_LEAD` → **REJECT** `TOO_CLOSE_TO_START`: the order could fill after the event begins. `MIN_LEAD` ≥ Grok timeout + expected order latency + margin (calibrated in S2).
- The Safety Gate **re-computes** all four at authorization time with fresh metadata; Grok's own `time_to_event` (if it echoes one) is ignored.
Examples: Oct 1 12:00 → Oct 2 11:00 = 23 h eligible; → Oct 2 13:00 = 25 h reject; Man U v Man City 4 pm, signal at 3:30 pm → eligible (subject to `MIN_LEAD`); signal at 4:30 pm → reject.
A deadline-type market ("by October 15th") is rejected whenever the deadline is more than 24 h away.

### 3.5 Copy-score rule
Eligible only if `copy_score ≥ 68` (out of 100), where `copy_score` is the value the signal engine recorded **at signal time** under a pinned `SCORING_VERSION`
(a version identifier to be added to scoring; today none is stored). Never recomputed. A scoring change that alters what 68 means creates a new policy version
and a new evidence window. **68 is a locked V1 operating threshold, not a claim that it is optimal or predictive**; paper data so far shows no clear gradient (§1).
Signals below 68 are rejected before Grok; Grok is never asked whether a lower score is acceptable.

### 3.6 Policy constants (versioned, in code; never environment variables)

| Constant | Value | Status |
|---|---|---|
| `SCORE_MIN` | 68 | fixed |
| `MAX_HORIZON` | 24 h | fixed |
| `MIN_LEAD` | 300 s | proposed; calibrate (S2) |
| `MAX_SIGNAL_AGE` | 600 s | proposed; calibrate |
| `GROK_TIMEOUT` | measured in S2 (initial guess 10 s) | calibrate; D47 |
| `DECISION_TTL` | 60 s | proposed; calibrate |
| `CONTEXT_FRESHNESS` (book, price) / `METADATA_FRESHNESS` | 30 s / 300 s | proposed |
| `TIMESTAMP_TOLERANCE` | 15 min | proposed; D51 |
| `PRICE_TOLERANCE`, order type | from the cost workstream (§9) | calibrate |
| `MAX_WINDOW`, `MIN_EFFECT`, `MIN_SETTLED_PER_ARM` | 12 weeks, 10 points, computed in S2 (≈ 1,900 at 10 points) | proposed; D48 |
| `MAX_GROK_FAILURE_RATE` | 2 % of eligible signals | proposed; D56 |

## 4. Architecture

```
SIGNAL ENGINE (existing; no keys)
   │ signal
   ▼
ELIGIBILITY PIPELINE (deterministic)  ── Market Mapper (signal venue → execution venue; unmapped = reject)
   │  E0–E8 incl. Timestamp Resolver     └ Venue Adapter, read-only (market metadata, order book, fees)
   ▼ eligible only
VERIFIED CONTEXT BUILDER (system facts, hashed)
   ▼
GROK STRATEGIC GATE (decision service; no trading credentials)      [V1-shadow: observes only]
   │ ACCEPT / REJECT (strict schema), journaled, HMAC-signed
   ▼
══════════════ EXECUTOR SERVICE (separate; the only place with a trading key) ══════════════
 DETERMINISTIC SAFETY GATE ── re-verifies everything from fresh independent data ──► AUTHORIZED / REJECTED
   ▼ AuthorizedOrder (single use)
 LIVE EXECUTOR (idempotent state machine) ──► VENUE ADAPTER ──► VENUE
   ▲                                              │
 RECONCILER (venue + authoritative source vs journal) · EMERGENCY CONTROLS (kill switch, automatic triggers)
══════════════════════════════════════════════════════════════════════════════════════════════
Telegram / dashboard: monitoring and confirmed controls only; cannot create orders.
```
- **Venue-agnostic core.** The Venue Adapter encapsulates authentication, order submission and cancellation, open orders, fills, positions, balances, market
  metadata, order books, venue errors, minimums and reconciliation. The Safety Gate and the Grok gate contain no venue-specific logic.
- **Shadow adapter** records the exact order it would send; it holds no key.
- **Grok runs outside the executor service**, with its own provider key (a leaked provider key is a cost risk, not a money risk). Decision records are
  append-only and HMAC-signed with a secret the executor can verify but the worker cannot read; the Safety Gate does not trust a decision on its own and
  re-derives eligibility and the context hash itself.
- **LIVE book state comes from reconciled real fills**, and the limit arithmetic of `PortfolioBook` is shared by the paper book and the Safety Gate (one function).

## 5. Contracts

### 5.1 Verified decision context (built by the system; Grok may not alter or extend it)
`context_id`, `signal_id`, `source_fill_id`, `policy_version`, `scoring_version`, `context_builder_version`, `built_at`, and `context_hash` (SHA-256 of canonical JSON), with provenance
(`source`, `fetched_at`) on every group:
- **signal:** kind, side, source price, source size, source time, evaluation time, detection lag.
- **wallet:** address, `copy_score`, bot class, activity (fills/day, status), profile summary (90-day profit and consistency, recent performance windows) from the
  system's own tables.
- **market (execution venue):** mapped venue market ID, outcome, question text, `event_time_utc`, `event_time_source`, `time_to_event_s`, status, best bid/ask, spread, depth
  near the touch, tick size, minimum order, fee rate, mapping verification result.
- **Untrusted block:** market question/description/rules and any text retrieved by tools, clearly delimited and labelled untrusted.
- **Not included in V1 (D54):** cash, exposure, positions, capacity or reconciliation state. Keeping selection independent of capacity makes the capacity-rejection
  outcome mean what it says. (If the owner prefers Grok to see them, record that as a policy change.)

### 5.2 Grok Strategic Gate contract
Question: *"Given this signal and the verified evidence, is this a trade we should consider copying?"*
**Request:** the context, a fixed instruction text (versioned), strict output schema. **Tools:** read-only only; each call and returned text hash is journaled; a call budget applies.
**Response** (JSON, schema-validated; anything else is invalid):
```
{ "schema_version": "1", "context_hash": "<echo>", "decision": "ACCEPT" | "REJECT",
  "reason_code": "<enum>", "reason_text": "<≤500 chars, inert, never parsed or forwarded>",
  "confidence": 0.0-1.0, "risk_flags": ["<enum>", ...], "evidence_refs": ["<context field names>", ...] }
```
**System-added record fields (never from Grok):** `decision_id`, `signal_id`, `source_fill_id`, `policy_version`, `model_id` (as returned by the provider), `prompt_version`,
`request_started_at`, `response_received_at`, `latency_ms`, `tool_calls`, `raw_response`, `validation_result`, `decision_timestamp`, `expires_at = decision_timestamp + DECISION_TTL`, `hmac`.
**Validation:** exact schema (no extra fields); `context_hash` equals the sent hash; enums valid; `evidence_refs` ⊆ the context's field names; ACCEPT requires a reason code and ≥ 1 evidence ref; REJECT requires a reason code.
**Outcomes:** `GROK_ACCEPT`, `GROK_REJECT`, `GROK_TIMEOUT`, `GROK_INVALID_OUTPUT`, `GROK_UNAVAILABLE`. **Only a valid, unexpired `GROK_ACCEPT` proceeds; every other outcome is no trade.**
Grok **cannot** supply, alter or be trusted for: event time, copy score, wallet statistics, balance, exposure, size, market status, reconciliation state, price, order-book state, limits.
**Injection resistance** is architectural, not instructional: structured output only; free text inert; read-only tools; untrusted content delimited; the Safety Gate recomputes everything; a red-team set of hostile market descriptions and tweets is part of the audit (§14).

### 5.3 Deterministic Safety Gate contract
Pure function over fetched-and-timestamped inputs (no network calls inside the decision): `(decision, fresh_state, policy) → AUTHORIZED(AuthorizedOrder) | REJECTED(codes[])`. **All** failing checks are recorded.

| Group | Checks (each with a reason code) |
|---|---|
| Authority | `LIVE_TRADING` on; kill switch clear; policy locked and version matches; executor and database healthy; risk configuration valid; geoblock/eligibility check passes |
| Decision integrity | Decision valid, signed, `ACCEPT`, unexpired; bound to this signal; context hash re-derived from fresh data still matches (or the changed facts are within defined tolerances) |
| Eligibility re-check | E1–E8 recomputed from fresh data; `0 < time_to_event ≤ 24 h`; ≥ `MIN_LEAD`; signal age |
| Market | Open, not closed/resolved/invalid; order meets tick and minimum size; required data available |
| Price protection | Limit price ≤ signal-referenced price + `PRICE_TOLERANCE`; visible depth sufficient; spread within limit |
| Duplicates | Client order ID not seen; no live or unknown order for this source fill |
| Reconciliation | Fresh, not drifted, no `UNKNOWN` orders blocking |
| **Capacity (reported separately)** | Cash for order + expected fee + buffer **and** cash after ≥ reserve (D20, a true floor); market, wallet and total exposure caps; open-position cap; daily loss limit |
`AuthorizedOrder`: `order_id` (client ID: hash of policy, source fill, portfolio, attempt), venue and market, side, **limit price (cap; no market orders in V1)**, size, expiry, `decision_id`, gate version, list of checks passed, MAC; single use; the executor re-verifies the MAC.
**Capacity outcome:** when Grok accepted and the only failing checks are capacity checks, the outcome is **`GROK_ACCEPT_CAPACITY_REJECT_{SLOTS|CASH|EXPOSURE|MARKET|WALLET}`**, never counted as a Grok rejection.

### 5.4 Outcome taxonomy (every signal ends in exactly one)
`ELIGIBILITY_REJECT_{code}` · `GROK_{REJECT|TIMEOUT|INVALID_OUTPUT|UNAVAILABLE}` · `SAFETY_REJECT_{code}` · `GROK_ACCEPT_CAPACITY_REJECT_{reason}` · `AUTHORIZED` → execution outcome (`FILLED`, `PARTIAL`, `NOT_FILLED`, `CANCELLED`, `REJECTED_BY_VENUE`, `UNKNOWN`). In shadow, `AUTHORIZED` becomes `SHADOW_AUTHORIZED` and a hypothetical order is journaled.

### 5.5 Journal (append-only; answers "why accepted / why rejected" without reading logs)
`eligibility_results` (all checks per signal), `grok_decisions` (full record above), `safety_results`, `authorized_orders`, `shadow_orders` / `live_orders`, `live_order_events`, `order_book_snapshots`,
`reconciliation_runs`, `policy_versions` (constants, locked-at), `evidence_windows`. Each row links signal ID, source fill ID, wallet, market and token, signal time, evaluation time, event time and its source, time to event, copy score and version, decision and reason, flags, confidence, model, prompt and policy versions, gate result, `AuthorizedOrder` ID, rejection reasons and execution outcome.

## 6. Gates

| Gate | Must be true before | Evidence | Decided by |
|---|---|---|---|
| **G1 Eligibility** | any real order | Owner's country and residence permit access to the chosen venue on the day (for a New York resident the candidate is the US-regulated exchange; the international platform is close-only for the US); the venue's own terms permit automated trading; written advice from a New York-qualified lawyer (state-level treatment of event contracts is disputed) and a US tax adviser; re-checked monthly | owner |
| **G2 Evidence (absolute)** | first real order | §7 absolute criteria, on the policy that would trade | owner, from computed verdicts |
| **G3 Custody and caps** | first real order | Venue credential model decided (D33), key/credential only in the executor service, funds = money the owner can lose, daily loss stop, kill switch tested, named operator plus automatic backstop | owner |
| **G4 Shadow validation** | first real order | ≥ 2 weeks of shadow with clean reconciliation; executor decisions match the policy; simulator costs compared with observed books | computed, owner reviews |
| **G5 Hostile audit** | first real order | §14, by an independent reviewer | independent reviewer |
| **G6 Pilot exit** | anything above pilot size | D34 | owner |
| **G7 Grok live path** | any order that depends on a Grok ACCEPT | All of: (1) G1–G5 passed for the pilot; (2) the evidence window completed per its pre-registration (sample reached or `MAX_WINDOW`), with no unapproved protocol deviation; (3) **relative PASS** (§7); (4) absolute criteria passed **by the Grok-gated arm**; (5) Grok failure rate (timeout, invalid, unavailable) ≤ `MAX_GROK_FAILURE_RATE`; (6) injection red-team passed; (7) pinned model confirmed available for the pilot period; (8) owner's written approval | owner |

## 7. Shadow, calibration and evidence sequence

**S0 Preconditions (decisions, no data):** D53 venue decided (a precondition for S3); G1 started; pre-registration drafted.
**S1 Audits (read-only, public data, both candidate venues):** (a) **Timestamp audit**: inventory every time field per market type, what it means (kick-off, close, resolution), placeholder patterns, agreement with resolution times we have already observed; fixes §3.3's field names. (b) **Coverage probe**: share of our signals whose market exists on the execution venue and is mappable; share surviving each eligibility rule; expected eligible signals per day. (c) Book and fee capture design.
**S2 Calibration (nothing counts as evidence):** shadow executor, mapper and context builder built; Grok **plumbing** (format, schema, latency) developed on synthetic data and old signals **for plumbing only**, never to improve selection (Grok may know old outcomes); measure Grok latency, tool-call time and failure rate → set `GROK_TIMEOUT`, `DECISION_TTL`, `MIN_LEAD`, `MAX_SIGNAL_AGE`; run the injection red-team; compute variance and clustering from forward data → fix `MIN_SETTLED_PER_ARM`; **feasibility rule:** the evidence window is locked only if expected time to reach the sample is ≤ `MAX_WINDOW`; otherwise redesign *before* the lock (widen eligibility or extend the window; both are pre-lock decisions).
**S3 Lock:** a pre-registration document is committed and tagged; it fixes model ID, prompt, context builder, scoring version, 68, the 24-hour and in-play rules, `GROK_TIMEOUT`, mapping rules, timestamp tolerance, metric, sample, effect size, window, analysis date and the verdict rules below. The lock time is written to `evidence_windows`. **Any change after the lock is a new policy version and a new window.**
**S4 Evidence window (forward only):** every eligible signal is evaluated by Grok live; arms: **rule-only** (all eligible), **Grok ACCEPT**, **Grok REJECT**; costs from the real order book captured at decision time and observed fees ("verified costs"); two layers: the **independent $100 simulation** (selection value without capacity noise) and a **Grok-gated paper portfolio** (what capacity does). Interim looks are monitoring only (data quality, outages); no result is viewed for decisions before the analysis date. Outages count as `GROK_UNAVAILABLE`, are reported, and are never dropped.
**S5 Analysis (automatic, on the pre-set date):** verdicts computed exactly as pre-registered:
- **Relative (D44/D48):** primary metric = mean net return per dollar staked, ACCEPT minus REJECT, 95 % cluster-bootstrap interval clustered by market. **PASS** = lower bound > 0 and point estimate ≥ `MIN_EFFECT`; **FAIL** = upper bound < `MIN_EFFECT`; **INCONCLUSIVE** otherwise or if the sample is not reached. Other metrics (net P&L, win rate, median and mean return, profit factor, drawdown, fees, slippage, holding time, by signal type, score band and wallet-quality band) are descriptive only.
- **Absolute (D52), on the arm that would trade:** ≥ 1,000 settled trades; net return per dollar after **verified costs**: point estimate ≥ +3 points, lower 95 % bound > 0; still ≥ 0 after removing the best 5 % of trades; positive in ≥ 2 of 3 equal time thirds; modelled maximum drawdown ≤ 20 % of pilot capital. *(proposals; owner approves)*
**S6 Decision:** §8.

## 8. D50 — inconclusive results (decided)
**INCONCLUSIVE ⇒ remain in shadow; no automatic Grok-gated live trading.** Do not lower the bar, change the model, prompt, threshold or data treatment, or reinterpret results to obtain a pass. A new window can begin only after a deliberate, versioned policy change. The relative and absolute questions stay separate: neither is substituted for the other.
**Pilot after an inconclusive result** needs an explicit owner decision and is limited to the **rule-only** policy (no Grok in the live path), and only if that arm passed the absolute criteria; otherwise there is no pilot. *(owner confirms; D50b)*

## 9. Cost-reduction workstream (separate from selection value)
Baseline on the international platform: about 11 points of stake per trade (6.7 price and delay, 4.5 fees). Selection cannot remove it, and the execution venue's costs will differ.
**Measure in shadow, per signal, from real books and fills-to-be:** price movement from signal to decision to would-be fill (split into detection, Grok and order latency); spread; depth and impact by walking the book; fee behaviour by market type and side (and maker versus taker where supported); the effect of price-protection limits (share blocked and their forward results); limit-order behaviour versus other order types where supported; partial and missed fills; time to fill.
**Rules:** no parameter is changed to improve historical results; every change is versioned and evaluated forward; the absolute gate uses observed costs. Hypotheses to test, not assumptions: faster detection, limit orders at or inside the spread, depth minimums, skipping high-fee markets.

## 10. Build steps (each reviewed, mutation-tested and audited before the next; sizes relative)
**4.0 Gates, decisions and S0–S1 audits.** Decide D51–D57, start G1/G3, run the timestamp audit and coverage probe on both venues. *Decisions + read-only scripts.*
**4.1 Shadow executor, journal and policy plumbing.** Interfaces, order state machine, journal tables, policy-version and scoring-version mechanism, shadow adapter, order-book snapshots, `LIVE_TRADING` default off and unbypassable. *Large.*
**4.2 Eligibility pipeline, market mapper, timestamp resolver, context builder.** Deterministic, fully tested at every boundary (23 h, 24 h, 24 h + 1 s, ≤ 0, `MIN_LEAD`, missing and ambiguous timestamps, mismatch, score 67/68, version mismatch). *Medium–large.*
**4.3 Grok Strategic Gate (shadow).** Contract, schema validation, timeout, HMAC, journaling, red-team harness. *Medium.*
**4.4 Safety Gate and AuthorizedOrder.** Pure function, shared limit arithmetic, every check and reason code, capacity outcomes. *Medium.*
**4.5 Reconciliation, exits and emergency controls.** As in v1 (read-only first, crash recovery by client ID, automatic triggers, kill switch); exits mirror the wallet's EXIT signals only. *Large.*
**4.6 Hostile audit and rehearsal** (§14). **Then S2–S6, running in parallel with 4.3–4.5 where possible.** Phase 5 pilot only after G1–G5 (and G7 for any Grok dependence).

## 11. Failure modes

| Failure | Required behaviour |
|---|---|
| Grok unavailable, timeout, malformed or ambiguous output | No trade; recorded; counts toward the failure rate |
| Stale or expired Grok ACCEPT, or facts changed after it | Safety Gate rejects (`STALE_CONTEXT`) |
| Event postponed or moved | Re-fetched timestamp at authorization; reject if no longer eligible |
| Venue timestamps disagree | `TIMESTAMP_VENUE_MISMATCH`, reject |
| Provider retires or changes the pinned model mid-window | Protocol deviation; owner decides; normally a new window |
| Hostile text in a market description or tweet | Inert by design; red-team measures the ACCEPT rate on injected samples |
| Crash after submit, timeout, partial fill, duplicates, restart | As v1: client ID lookup, `UNKNOWN` until reconciled, never blind resubmission |
| Database unreachable | Fail closed; cancel resting orders if safe |
| Venue moves the owner's region or the market to restricted | Eligibility check pauses trading; no workaround |
| Key or credential leak | Capped funds; rotate; revoke |
| Kill-switch operator unreachable | Automatic triggers act without a human |

## 12. Parties involved in every aspect
Owner (operator, final approver); the execution venue and its regulator; the owner's lawyer (New York-qualified) and tax adviser; bank and funding rails (the US exchange is fiat-based; verify current funding options); the xAI/Grok provider (model availability, pricing, API terms, retirement of model versions); Railway, Vercel, Supabase, GitHub, package registries (infrastructure and supply chain; rotate and delete stale tokens); Telegram (alerts and confirmed controls only); AI assistants that write and review code (independent hostile audit required); an independent reviewer (D58); for the international platform only: Polygon and UMA, not relevant to a US-exchange execution venue.

## 13. Decisions

| # | Decision | Status |
|---|---|---|
| D30 | Phase 4 = live execution, shadow first | **decided** (30 Sep) |
| D31 | Country and eligibility: New York, US, long term; venue eligibility per G1 | owner stated; verification open |
| D32 | Evidence criteria | superseded by D44/D48/D52 |
| D33 | Custody/credential model | open; depends on D53 (US exchange: API credential tied to a verified account; international: a wallet key) |
| D34 | Pilot size and exit | open; proposal: fund $100–$200, positions $5–$10 subject to venue minimums, manual approval first two weeks |
| D35 | Approval mode | open; recommend manual first |
| D36 | Kill switch: human plus automatic triggers | open; recommend both |
| D37 | Executor in a separate service | open; recommend yes |
| D38 | Order style: limit with a price cap, no market orders | open; recommend yes |
| D39 | Stop-loss, take-profit, time stop | out of Phase 4 until measured in paper |
| D40 | Journal exported for tax | open; recommend yes |
| D41 | Role of Grok | **replaced** by D42–D50 |
| D42 | Timestamp hierarchy (§3.3), audit before final | **decided** (1 Oct) |
| D43 | Immediate per-signal decisions, no ranking window; capacity outcomes recorded separately | **decided** |
| D44 | Pre-registered forward evaluation; one primary metric; no retroactive Grok runs; inconclusive is a valid result | **decided** |
| D45 | ACCEPT required; structured output; no credentials; untrusted text; hash and expiry binding | **decided** |
| D46 | Venue-agnostic core with a market mapper; unmapped fails closed | **decided** |
| D47 | Hard Grok timeout, a versioned constant, value measured in S2 | **decided**; value pending |
| D48 | Lock the methodology before the window; minimum effect and sample | decided in principle; numbers proposed (§3.6) |
| D49 | Reject in-play; plus `MIN_LEAD` | **decided**; `MIN_LEAD` value pending |
| D50 | Inconclusive ⇒ remain in shadow (§8) | **decided**; D50b open |
| D51 | Timestamp tolerance between venues | open; proposal 15 min |
| D52 | Absolute-gate thresholds (§7 S5) | open; proposals given |
| D53 | **Execution venue**: a precondition for the lock, not only for live trading | **open, blocking** |
| D54 | Grok sees no cash, exposure or capacity data in V1 | open; recommend yes |
| D55 | Final numeric constants after calibration | open (S2) |
| D56 | Acceptable Grok failure rate for a valid window | open; proposal 2 % |
| D57 | Provider, model, cost cap and handling of model retirement; read-only tool use allowed with a call budget | open |
| D58 | Who is the independent reviewer | open |
| D6–D9 | Older open data decisions | open; decide before S3 |
| — | Carried from Phase 3: D20 true reserve floor, D18 append-only corrections | adopted as gate rules |

**Venue options (D53), for the owner:** (a) the US-regulated exchange (separate API with signed-request authentication, identity verification before API keys, a public market-data API without keys, a subset of markets, fiat funding; availability in New York for all contract types is disputed at state level); (b) the international platform: the US is close-only, so not an option for a US resident; (c) another regulated venue: different markets, would need its own mapping. Run the S1 audits on (a) first.

## 14. Hostile-audit checklist (every answer must be "no")
v1 list (limits, duplicates, restarts, unconfirmed orders, bypass by any component, `LIVE_TRADING`, stale signal or reconciliation, key in logs, worker or Vercel spending, history edits, kill switch disabled by message, unnoticed balance mismatch) **plus:**
Can Grok's output contain anything the system executes or parses as a command? Can a market description or tweet change a policy constant, a limit or the schema? Can a Grok decision be reused for another signal, price, context or after expiry? Can a timeout, invalid output or outage be treated as ACCEPT? Can capacity or cash data reach Grok? Can any signal skip the eligibility chain or Grok in V1-live-grok? Can the policy constants change without a version bump? Can Grok be run on historical signals and the result counted as evidence? Can a decision row be forged by the worker and authorize an order? Can the timestamp come from a date-only field, a resolution time or Grok? Can a postponed event still be traded? Can the same source fill produce two orders under two policy versions?

## 15. Not in Phase 4
Strategy changes, wallet-scoring changes, tuning against results, optimisation of allocation, scaling above the pilot, any automation that opens a gate, any workaround of a jurisdictional or venue restriction, retroactive Grok evaluation counted as evidence.
