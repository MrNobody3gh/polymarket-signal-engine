# Phase 4 — live execution, shadow first: plan v3 (international Polymarket)

Status: **DRAFT v3 for owner approval. Nothing live is built; no wallet, key or order exists.** v1: 30 Sep 2026. v2: 1 Oct. **v3: 6 Oct 2026**, against `main` after Phase 4.0e.
Not legal, tax or financial advice. Decisions marked *owner* are the owner's alone. **v3 supersedes v2 where it says so; the sections listed in §11 stay in force unchanged** (`docs/PHASE4_PLAN.md` is v2).

## 0. What changed since v2
1. **Venue decided (D53, owner, 5 Oct 2026): the international Polymarket**, conditional on gate G1. The signal source and the execution venue become the same market set, so coverage is complete and the cross-venue market mapper disappears.
2. **Why not the US-accessible venues.** Measured on 880 market+outcome pairs behind score ≥ 68 signals: the US exchange had 19 pairs (2.2 %) at title similarity ≥ 0.70 and Kalshi 14 (1.6 %); neither lists esports (about a third of the flow); a complete title search of the US exchange is impossible (its search endpoint refuses after about 100 requests); nothing is verified. (`docs/phase4/RESULTS_2026-10-03/04/05.md`.)
3. **Eligibility (G1) is reopened.** The owner reported moving to South Africa (a move, not a visit). Germany, Italy, the United States and the United Kingdom are restricted by Polymarket; South Africa is not on the lists seen (secondary sources), and its law on prediction markets is an unsettled grey area (§3).
4. **The evidence gate is now the larger blocker.** Paper REALISTIC is about −5.4 % of stake after costs; a follower gives up about 11 points to price movement (6.7) and fees (4.5). Measuring those costs on the real order book is the first build step (§6).
5. **The timestamp rule needs a decision (D105).** On the international data only tennis `events[].startTime` (slot 1) and a few `endDate` strata (slot 2) passed the audit; most close fields are Eastern-time date markers. The mandatory "within 24 hours and not started" entry rule can be evaluated for only a small share of the flow (§4).

## 1. Where we start (measured, 6 Oct 2026; clean regime since 27 Sep 04:28 UTC)
- **Paper, independent $100 ledger (settled):** IDEAL +9.1 % (2,164 trades), REALISTIC −5.4 % (1,958), CONSERVATIVE −8.2 % (1,854). Same 1,958 signals: IDEAL +5.8 % → price movement, spread and impact −6.7 points → −0.9 % before fees → fees −4.5 points → −5.4 %. Fees are 99 % observed; 98 % of trades pay them.
- **Portfolios ($1,000, $25):** equity $980 / $677 / $902; 94–98 % of signals rejected for capacity.
- **Copy score:** no clear gradient (REALISTIC by band 50–59 −7.7 %, 60–67 −3.1 %, 68–74 −5.6 %, 75+ −2.4 %); score ≥ 68 is about 24 % of signals from about 20 wallets.
- **Variance:** per-trade return SD about 88 points; design effect 1.2–2.8 (trades cluster in few markets). About 1,100–1,400 settled trades per arm are needed to detect a 10-point difference (3,400 unclustered-adjusted worst case).
- **Flow:** about 830–960 entry signals a day; about 200 a day with score ≥ 68.
- **Not measured yet:** real spreads, depth, price drift between detection and action, and fee rates from the actual order book on this venue; per-category paper results (esports, sports, politics, culture); resolved-market evidence for any timestamp field.

## 2. Principles
As v2 §2 (fail closed; one path to money; append-only journal; never assume; nothing live that paper has not measured; shadow before live; hard caps; humans decide gates; no circumvention; Grok is a selector not a control; the system supplies facts; versioned policies; every outcome has a reason code). **Added in v3:**
14. **Eligibility precedes custody.** No wallet, key, funded address or authenticated call exists until G1 is passed and recorded.
15. **Measurement code is additive, off by default and failure-isolated.** It never changes a signal, a score, a paper result or an alert, and when switched off it makes no request and no database call.

## 3. Venue and eligibility (G1 reopened)
- **Venue:** international Polymarket (CLOB order book on Polygon, markets and metadata from Gamma). The signal's `token_id` is the tradable token, so identity is exact by construction (still checked: market open, not resolved or closed, token present in the book).
- **G1 — must be true before any wallet, funds or order:**
  1. The owner's **country of residence** (South Africa, once the move is complete) and the place the account is used are **not** on Polymarket's restricted list (blocked or close-only), checked on Polymarket's own geographic-restrictions page **on the day**, and the account is opened and used from that real location, in the owner's own name. No VPN, proxy or other tool to bypass a restriction (Polymarket prohibits it; so does this plan).
  2. **Written advice from a South African lawyer** on whether an individual using an offshore prediction market is exposed (the National Gambling Act has general prohibitions on unlicensed gambling and interactive games; no framework covers prediction markets; the bookmakers' association is lobbying to have offshore prediction markets treated as illegal until one exists).
  3. **Written advice from an accountant** on tax on winnings and losses and on moving funds offshore (exchange-control rules apply to individuals).
  4. A **regulated on-ramp** for the funding route, chosen with that advice.
  5. **Re-checked monthly and on every Polymarket or regulator announcement** (the list and the law can change quickly). A restriction appearing later pauses trading (§11, failure modes).
- Nothing in this plan is conditional on the CFTC's pending decision about US users; a US route is no longer the plan.

## 4. Policy V1 on this venue (changes to v2 §3)
- **Eligibility chain.** v2 §3.2 stays, with E2 (market mapping) replaced by **E2′ `TOKEN_NOT_TRADABLE`**: the signal's token exists on the venue's order book and the market is open (this replaces `UNMAPPED` / `MAPPING_UNVERIFIED`).
- **Timestamps.** The hierarchy of v2 §3.3 (slot 1 event start, slot 2 market close, otherwise reject; never date-only values, never resolution time, never Grok's value; re-checked at authorization) stays. The venue is the same as the signal venue, so the cross-venue tolerance (D51) is not needed.
- **Data reality (international, 2–5 Oct audits).** Slot 1 passed only for tennis `events[].startTime`; slot 2 only for a few strata (short-term crypto, one other-sport stratum). Most `endDate` values are date markers expressed in Eastern time (04:00/05:00 UTC = midnight Eastern, 03:59/04:59 UTC = 23:59), and `startDate` is a listing time. **International `gameStartTime` for sports has not been judged as its own candidate at event level with adequate samples and must be re-audited (§9, step 4.2).**
- **D105 (owner): what to do about the 24-hour and not-started entry rule**, given that it can be evaluated for few signals:
  (a) keep it as written (very small eligible flow; the evidence window is then infeasible);
  (b) restrict V1 to the categories where a verified timestamp exists (small, category-specific);
  (c) add an authoritative schedule source for sports and keep the rule;
  (d) **replace the entry filter by a maximum-holding exit** (a time stop: sell at most N hours after entry), which needs no event timestamp, and measure it in paper first; the earlier H1 hypothesis.
  Recommendation: measure (d) in paper, and (b)/(c) only where the audit supports them. Not decided.

## 5. Architecture (v3)
```
SIGNAL ENGINE (existing; no keys)                   WORKER job (additive, flag SHADOW_BOOKS, default OFF)
   │ signal                                           reads PUBLIC order books (GET only) at fixed offsets after each entry signal,
   ▼                                                  records spread, depth, hypothetical taker fills, fee rate  → table shadow_books
ELIGIBILITY PIPELINE (deterministic; E0–E8 with E2′)
   ▼ eligible only
VERIFIED CONTEXT → GROK STRATEGIC GATE (shadow only until G7) → decision journal
══════════════ EXECUTOR SERVICE (separate; the only place that may ever hold a wallet key; built only after G1) ══════════════
 SAFETY GATE (pure, deterministic) → AuthorizedOrder → EXECUTOR → CLOB (Polygon) ; RECONCILER (CLOB + chain vs journal) · EMERGENCY CONTROLS
═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
```
- v2 §4's venue-agnostic adapter stays, with one concrete adapter (international CLOB). Contracts v2 §5.1–5.5 stand; the market-mapping fields in §5.1 become `token_id` / `condition_id` of the signal.
- **Custody (D109, later):** a dedicated, capped wallet whose key lives only in the executor service; L2 API credentials only there; funds limited to what the owner can lose. No wallet is created before G1.

## 6. Step 4.1 is now the shadow order-book measurement (the cost evidence)
Purpose: replace the paper simulator's **approximated** spread, impact and liquidity with **observed** values from the real order book, on the venue that contains the signal universe, **before anything else is built**.
- For every entry signal, at fixed offsets after the signal (proposed 0 s, 60 s, 300 s; D106), read the public book for the signal's token and record: best bid and ask, spread, depth to 10 levels each side, and for sizes $10 / $25 / $100 the **hypothetical taker fill** (average price, slippage against the wallet's price and against the mid, share filled) with the **observed fee rate**.
- Report per category and signal kind: spread and depth distributions, slippage by offset and size, fee rates, share unfillable at $25, and a **paired comparison with the paper REALISTIC simulation on the same signals** (does the simulator under- or over-state cost, and by how much).
- Output feeds G2/G4 and D105. Brief: `PHASE4_1_BRIEF.md`. It adds a migration, a flag-gated worker job and a read-only report; **no orders, no keys, no wallet, no authenticated endpoint.**

## 7. Sequence (replaces v2 §7)
**S0 Decisions and G1 preparation** (owner: lawyer and accountant, after the move). **S1 audits** (done for the US exchange and Kalshi; for the international venue: re-audit timestamps at event level with adequate samples, including `gameStartTime`, and measure resolved events). **S2 Shadow measurement (this step 4.1)**, run for at least two weeks, plus the **category breakdown of paper results** (sports, esports, politics, culture) and a paper test of the time-stop variant (D105 d). **S3 calibration and lock** (constants, thresholds, the evidence protocol of v2 §7 unchanged: pre-registered, forward-only, one primary metric, inconclusive is valid). **S4 evidence window**, **S5 analysis**, **S6 decision** as v2 §7–8.
The feasibility rule of v2 still applies: the window is locked only if the expected time to reach the sample fits `MAX_WINDOW`; on this venue the eligible flow is the whole signal flow after the chosen entry rule, so the arithmetic is better than on any other venue, but it still depends on D105.

## 8. Gates (as v2 §6, with G1 as in §3 above)
G1 eligibility (reopened, §3) · G2 evidence (absolute and relative, pre-registered) · G3 custody and caps · G4 shadow validation (now measured on the real book) · G5 hostile audit · G6 pilot exit · G7 Grok live path. **Paper results currently fail G2.**

## 9. Build steps
**4.0 done** (gap report, venue research, audits, feasibility tooling; closed for the US exchange and Kalshi).
**4.1 Shadow order-book measurement** (this plan §6; brief `PHASE4_1_BRIEF.md`). **4.2 International audit refresh:** timestamp audit at event level (`gameStartTime`, `events[].startTime`, `endDate`), resolved events, schedule agreement (reuse `phase4:gamestart-check` logic for the international venue). **4.3 Shadow executor and journal** (v2 4.1). **4.4 Eligibility pipeline and context builder** (v2 4.2, without the mapper). **4.5 Grok Strategic Gate in shadow** (v2 4.3). **4.6 Safety Gate and AuthorizedOrder** (v2 4.4). **4.7 Reconciliation, exits, emergency controls** (v2 4.5, with chain reconciliation on Polygon). **4.8 Hostile audit and rehearsal** (v2 4.6). Nothing from 4.3 onward holds a key until G1.

## 10. Decisions
| # | Decision | Status |
|---|---|---|
| D53 | Execution venue | **decided (owner, 5 Oct 2026): international Polymarket, conditional on G1** |
| D31 | Country | owner reports a move to South Africa (week of 5 Oct); G1 steps in §3 |
| D105 | The 24-hour and not-started entry rule on this venue | open; options (a)–(d) in §4 |
| D106 | Shadow offsets (0/60/300 s), sizes ($10/$25/$100), recorded depth (10 levels), retention | proposed in the brief |
| D107 | Feature flag for the measurement job: `SHADOW_BOOKS`, default off; who switches it on | owner |
| D108 | Which signals are measured: all entry signals (proposed) or score ≥ N | proposed: all |
| D109 | Custody model (wallet type, key storage) | open; after G1 |
| D110 | Lawyer and accountant engagement in South Africa | owner action |
| D111–D116 | Shadow-measurement decisions: fee unit and formula, storage, a refusing host, which offset judges G4, report thresholds, outage back-fill | open; listed with recommendations in `docs/phase4/SHADOW_BOOKS.md` §10 |
| D30–D52, D54–D58 | as v2 §13 | unchanged except D51 (tolerance) and the mapper, which no longer apply |
| D59–D104 | Phase 4.0 tooling decisions | closed for the US exchange and Kalshi; the audit tooling is reused for the international venue |

## 11. Carried over unchanged from v2
§2 principles (plus 14–15 above) · §3.4 the 24-hour, in-play and lead-time arithmetic (subject to D105) · §3.5 copy-score rule and its caveat · §3.6 constants · §5.1–5.5 contracts (Grok gate, Safety Gate, outcome taxonomy, journal) with `token_id` replacing the venue-market ID · §7 evidence protocol (S3–S6) · §8 D50 inconclusive handling · §9 cost workstream (now begins with 4.1) · §11 failure modes (**add:** Polymarket restricts the owner's country or the owner's residence changes → pause; a wallet or chain failure; USDC or collateral-token change; Polygon congestion; API or SDK change) · §12 parties (**add:** a South African lawyer and accountant, the regulated on-ramp, Polygon and its RPC providers, UMA for resolution) · §14 hostile-audit checklist (**add:** can any request carry credentials before G1; can the measurement job affect a signal, score, alert or paper result; can the flag-off state make a request).

## 12. Not in Phase 4
Strategy changes, scoring changes, tuning against results, scaling beyond the pilot, any automation that opens a gate, any VPN, proxy or other workaround of a restriction, and any wallet, key or order before G1.
