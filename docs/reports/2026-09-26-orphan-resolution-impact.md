# Orphan resolution: impact on Phase 2 results

Generated 2026-09-26T22:11:04.527Z from production, read-only (nothing was written). 82,066 open simulated positions read; 1,337 sit on 329 tokens that no process checks for resolution. Every one of them reproduces its stored P&L exactly with the report's arithmetic (largest difference 0.0e+0); that arithmetic is tested against the Phase 2 simulator itself.

## What Polymarket says about the 329 tokens

| Answer | Tokens |
|---|---|
| RESOLVED | 141 |
| UNKNOWN | 116 |
| OPEN | 51 |
| NO_CONDITION_ID | 21 |

| Unanswered because | Tokens |
|---|---|
| UNKNOWN: resolved_but_token_value_unknown | 116 |

`resolved_but_token_value_unknown` is one market type: neg-risk markets settled by UMA. `/v2/resolutions` reports them resolved but gives no payouts and no `resolved_at`. Gamma's closed-market record has the final prices and `umaEndDate` for 114 of the 116; that time is within 30 s (median) / 76 s (p90) of the v2 row's `last_update_timestamp`.

## A. Resolver as built (D2: settle only at an on-chain `resolved_at`)

*Revisited* positions have a ledger row, so the sweep recomputes them once their token resolves; only these change the Phase 2 results. *Frozen* positions (no ledger row, signals from 18–20 Sep) are never recomputed: their rows show what a resolution would mean, but their stored results stay as they are.

| Mode | Group | Positions | Token resolved | Settled | Wins / losses | Net P&L before | Net P&L after | Change | Resolved before our fill (stays open) | Exit voided |
|---|---|---|---|---|---|---|---|---|---|---|
| IDEAL | **Revisited** | 10 | 0 | 0 | 0 / 0 | $0.00 | $0.00 | $0.00 | 0 | 0 |
| IDEAL | Frozen | 363 | 231 | 231 | 141 / 90 | $0.00 | −$289.12 | −$289.12 | 0 | 0 |
| REALISTIC | **Revisited** | 187 | 64 | 58 | 30 / 28 | −$97.72 | −$1,091.47 | −$993.75 | 6 | 0 |
| REALISTIC | Frozen | 357 | 239 | 239 | 142 / 97 | −$460.79 | $355.19 | $815.98 | 0 | 3 |
| CONSERVATIVE | **Revisited** | 149 | 54 | 53 | 32 / 21 | −$170.24 | −$250.75 | −$80.52 | 1 | 0 |
| CONSERVATIVE | Frozen | 271 | 161 | 161 | 51 / 110 | −$696.38 | −$7,927.88 | −$7,231.50 | 0 | 0 |

Mode totals (`paper_exec_report`), before → after:

| Mode | Net P&L | Realised | Unrealised | Settled trades | Win rate |
|---|---|---|---|---|---|
| IDEAL | $132,717.64 → $132,717.64 ($0.00) | $58,241.76 → $58,241.76 | $74,475.88 → $74,475.88 | 7790 → 7790 | 66.1% → 66.1% |
| REALISTIC | $147,449.56 → $146,455.81 (−$993.75) | −$60,411.41 → −$61,405.16 | $207,860.97 → $207,860.97 | 5935 → 5993 | 56.0% → 56.0% |
| CONSERVATIVE | −$37,967.94 → −$38,048.46 (−$80.52) | −$85,067.78 → −$85,148.30 | $47,099.84 → $47,099.84 | 5174 → 5227 | 55.3% → 55.3% |

## B. Sensitivity: also accept Gamma's UMA settlement time for neg-risk markets (needs a decision)

| Mode | Group | Positions | Token resolved | Settled | Wins / losses | Net P&L before | Net P&L after | Change | Resolved before our fill (stays open) | Exit voided |
|---|---|---|---|---|---|---|---|---|---|---|
| IDEAL | **Revisited** | 10 | 0 | 0 | 0 / 0 | $0.00 | $0.00 | $0.00 | 0 | 0 |
| IDEAL | Frozen | 363 | 284 | 284 | 181 / 103 | $0.00 | −$138.33 | −$138.33 | 0 | 0 |
| REALISTIC | **Revisited** | 187 | 165 | 157 | 123 / 34 | $17.71 | −$80.49 | −$98.20 | 8 | 0 |
| REALISTIC | Frozen | 357 | 295 | 295 | 185 / 110 | −$538.56 | $780.24 | $1,318.79 | 0 | 3 |
| CONSERVATIVE | **Revisited** | 149 | 124 | 123 | 95 / 28 | −$185.51 | −$341.03 | −$155.52 | 1 | 4 |
| CONSERVATIVE | Frozen | 271 | 209 | 208 | 86 / 122 | −$771.59 | −$8,348.34 | −$7,576.76 | 1 | 0 |

| Mode | Net P&L | Realised | Unrealised | Settled trades | Win rate |
|---|---|---|---|---|---|
| IDEAL | $132,717.64 → $132,717.64 ($0.00) | $58,241.76 → $58,241.76 | $74,475.88 → $74,475.88 | 7790 → 7790 | 66.1% → 66.1% |
| REALISTIC | $147,449.56 → $147,351.35 (−$98.20) | −$60,411.41 → −$60,509.62 | $207,860.97 → $207,860.97 | 5935 → 6092 | 56.0% → 56.6% |
| CONSERVATIVE | −$37,967.94 → −$38,123.46 (−$155.52) | −$85,067.78 → −$85,223.30 | $47,099.84 → $47,099.84 | 5174 → 5297 | 55.3% → 55.8% |

Max drawdown and the robustness figures depend on closing order and are not projected; the next sweep recomputes them.

## Tokens with no usable condition id (21)

Their signals carry an empty or malformed `condition_id` (the malformed ones end in long runs of zeros, which looks like a lost-precision conversion upstream), so they cannot be looked up:

- `63114442211264831251…` — condition id missing on the signal
- `13902810601352963126…` — malformed condition id 0x0312df069829555d571a47d6dc5898b70c0000000000000000000000000000
- `15690420382014566943…` — malformed condition id 0x03780bdbc9afdd03e3721707df3a2475f80000000000000000000000000000
- `99599228415218267665…` — condition id missing on the signal
- `16920762746432319274…` — malformed condition id 0x03bdae6540de1fbf00fdf1df91e192a8e00000000000000000000000000000
- `15423439334996737940…` — malformed condition id 0x0368ef8c0bcecbe0d80444149b4d6612aa0000000000000000000000000000
- `17330110636342056043…` — malformed condition id 0x03d4d978f6e3ccdf45d2ad2e64a29818690000000000000000000000000000
- `11340458991702242352…` — condition id missing on the signal
- `15295190792650305463…` — malformed condition id 0x0361ad57c397df2b579892ccdf64a2eba40000000000000000000000000000
- `15219588716293485748…` — malformed condition id 0x035d65f013d10e084a5358e7f88afeb57b0000000000000000000000000000
- `83897649206122342808…` — condition id missing on the signal
- `10778891441698840814…` — condition id missing on the signal
- `14056785186931258450…` — malformed condition id 0x031b95fa1302860f90d99ceda20675bc330000000000000000000000000000
- `67353723863817622506…` — condition id missing on the signal
- `33282351682892805766…` — condition id missing on the signal
- `10827385010864417376…` — condition id missing on the signal
- `15273031813655654530…` — malformed condition id 0x03606c478af8a000225109e45f9c23eef30000000000000000000000000000
- `47915821095334304655…` — condition id missing on the signal
- `48624154286623161133…` — condition id missing on the signal
- `94629194311111416815…` — condition id missing on the signal
- `13972262971184810655…` — malformed condition id 0x0316cd53c07215dbdd9b5e1fae1b03cb450000000000000000000000000000

_Run time 109 s._
