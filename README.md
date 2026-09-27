# Polymarket copy-signal engine

Scores every wallet that reaches a Polymarket leaderboard over a rolling 90-day
window, keeps the ones whose edge looks real *and* followable, watches their
fills live, and alerts you when they open, add, or exit.

Companion to the published snapshot dashboard (17 Sep 2026): the same scoring
formula, the same 180-wallet watchlist (`config/watchlist.json`).

Read-only research on public data. Nothing here places trades.

## How it works

```
always-on         npm run worker              websocket firehose → tracked wallets only → same engine
  every minute      (worker) REST backstop    new fills per tracked wallet since cursor
  daily 04:15 UTC   (worker) re-score         discover every board (11 cats × 4 windows × 2 sorts)
                                              + recent $10k+ fills → score ~1,400 wallets → mark watchlist
  every 10 / 15 min (worker) paper            mark 1h/6h/24h + settle; execution simulation
                        ↓
                  src/lib/signals/rules.ts    NEW_POSITION · CONSENSUS · CONVICTION_ADD · EARLY_ENTRY · EXIT
                        ↓
                  Supabase (signals, positions, fills)  →  Telegram / Discord / email
```

The websocket path is real-time (~2 s Polygon blocks). REST is CDN-cached
`max-age=300`, so the poller alone is up to 5 minutes behind — it exists so a
dropped socket costs latency, not fills. Every scheduled job runs inside the one
worker process; the Vercel app is the dashboard, the Telegram webhook and manual
entry points (`/api/cron/*`, protected by `CRON_SECRET`).

## Setup (15 minutes)

1. **Supabase** — create a project, then apply **every** migration in
   `supabase/migrations/` in order, `0001` through `0011` (`npm run db:push`,
   or paste each file into the SQL editor and run it). All are additive; the
   code needs all of them.
2. **Env** — `cp .env.example .env.local` and fill in the Supabase URL + service
   role key, a `CRON_SECRET`, and whichever alert channels you want
   (Telegram: create a bot with @BotFather, message it once, get your chat id
   from `https://api.telegram.org/bot<TOKEN>/getUpdates`).
3. **Install + test**
   ```bash
   npm install
   npm test          # the real-Postgres tests run only when PG_TEST_URL is set
   npm run typecheck
   ```
4. **Seed the watchlist** from the snapshot so it works before the first full
   refresh: `npm run refresh -- --seed` (or hit
   `/api/cron/refresh-wallets?seed=1&secret=...` once deployed).
5. **Run**
   ```bash
   npm run dev       # dashboard on :3000 — /, /signals, /wallets, /api/signals
   npm run worker    # live listener (separate terminal)
   ```
6. **Deploy** — push to Vercel for the dashboard and bot webhook. Run the worker
   on Railway / Fly / any box (`npm run worker`) — Vercel functions can't hold a
   socket open, and the ~5-minute daily re-score doesn't fit a serverless time
   limit. `vercel.json` therefore registers no crons.
7. **First full re-score**: the worker runs one on its first start (and daily at
   04:15 UTC after that). To run it by hand: `npm run refresh` (≈4,000 API calls, ~5 min).

## Telegram bot

The engine *is* a Telegram bot. Anyone who messages it gets their own filtered
alert stream; signals are pushed the moment the rules fire.

**Setup**
1. @BotFather → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`; set any
   random string as `TELEGRAM_WEBHOOK_SECRET`.
2. Apply all migrations (Setup step 1).
3. Deployed on Vercel: `npm run tg:setup -- https://your-app.vercel.app`
   registers the webhook (`/api/telegram/webhook`) and the command menu.
   Locally: `npm run tg:setup` (no URL) then `npm run bot` to long-poll.
4. Open the bot, send `/start`.

**Commands**

| | |
|---|---|
| `/start` `/stop` | subscribe / unsubscribe |
| `/signals [n]` | latest signals |
| `/consensus` | markets where 2+ tracked wallets hold the same side right now (live `consensus_now` view) |
| `/wallets [n]` | top of the watchlist by copy score |
| `/wallet crckr` or `/wallet 0x…` | profile, 90-day stats, open book — with Mute / Only-this-wallet buttons |
| `/filters` | your current filters |
| `/kinds new consensus add early exit` | which signal kinds to receive |
| `/severity 3` | minimum severity (1–5) |
| `/min 5000` | minimum fill size in USD (`$5k` works) |
| `/score 60` | minimum copy score of the wallet |
| `/only crckr 0x…` / `/only all` | restrict to specific wallets |
| `/mute 6` / `/mute crckr` / `/unmute` | mute for N hours, or mute one wallet |
| `/status` | engine health |

Every pushed alert carries **Market**, **Wallet** and **Mute wallet** buttons.
Delivery is logged per (signal, chat) so redeploys never double-send; chats
that block the bot are deactivated automatically. `TELEGRAM_CHAT_ID` in env is
optional — an admin chat that receives every signal unfiltered.

## The rules

| Signal | Fires when | Suppressed |
|---|---|---|
| **New position** | Tracked wallet buys a token it did not hold, ≥ `$2,000` or ≥ 2× its median fill | |
| **Consensus** | Its buy makes N ≥ 2 tracked wallets on the same side inside 72 h — fires once per new participant | |
| **Conviction add** | Existing position grows ≥ 50% at a price no worse than average entry | averaging down |
| **Early entry** | Buy at ≤ 0.35 in a market resolving inside 30 days, by a wallet up every month of the window | |
| **Exit** | Sells ≥ 60% of a position that was alerted, or closes it — closes the open alerts | trims |
| *(all)* | | fills < $50, bot/maker wallets (>500 fills/day or >25% program income), copy score < 40, neg-risk residue near 0.50, duplicates inside 10 min |

Thresholds are env vars (`MIN_FILL_USD`, `NEW_POSITION_MIN_USD`, …), see `.env.example`.
Severity 1–5 scales with notional (+1 at $5k, +1 at $25k), copy score ≥ 60, and consensus depth.

## The copy score (0–100)

```
+ min(40, 13·log10(pnl_90d / $1k))         recent profit, log-scaled
+ min(20, 1.5 · net_profit / max_drawdown)  profit per dollar of pain
+ 15 · (months up / months in window)       consistency
+ 10 if edge per dollar traded in 3–25%     the copyable band
− 25 if > 500 fills/day (−8 if > 150)       software, unreachable
− 30 · max(0, program income share − 10%)   rebates/rewards you can't inherit
− 20 · max(0, concentration − 40%)          one-bet records
− 15 idle > 14 d, −30 idle > 30 d
− 10 if unrankable (<100 fills, <60 curve days, flat curve)
```

Why this and not the leaderboard: over the 90-day snapshot, 78% of profit came
from 341 wallets whose record is essentially one bet, and the 598 selective
repeatable traders finished the window down as a group. A profit sort puts
jackpots and market makers on top; neither is copyable.

Style buckets: *Market maker / bot* (>500 fills/day or >25% program income),
*Lottery ticket* (>40% of lifetime profit from one position), *Concentrated
directional* (>20% edge per dollar), *High-frequency directional* (>150
fills/day), *Selective directional* (everything else).

## API facts baked into the client

Verified live against production, not from the docs — see `src/lib/polymarket/client.ts`.

- Unknown query params are **silently ignored** with a 200 and default-window data. Every param is whitelisted; a typo throws locally.
- `/v2/trades` defaults to `taker_only=true` and silently drops maker fills.
- v2 pages by opaque cursor; `offset` is a 400.
- Leaderboard `volume` is **shares**, not USD. Use `user-stats.volume_usdc`.
- `day|week|month` boards are mark-inclusive; `all` is realized-only. Never sum them.
- `/v2/user-pnl` defaults to 1-hour fidelity (~10 MB/wallet). Always `fidelity=1d`.
- Every REST response is CDN-cached 300 s. Live = `wss://ws-live-data.polymarket.com`, subscribe with `{action:"subscribe",subscriptions:[{topic:"activity",type:"trades"}]}`, send `PING` every 5 s.
- Rate limits (IP-based): 1,000 req/10 s general, 200 for `/trades`, 150 for `/positions`.

## Layout

```
config/watchlist.json          180 wallets from the 17 Sep snapshot (seed)
supabase/migrations/0001_init.sql
src/lib/polymarket/client.ts   v2 client, whitelist, cursors, retry, normalizeFill
src/lib/scoring/score.ts       pure scoring (windowPnl, drawdown, monthsUp, copyScore, style)
src/lib/scoring/refresh.ts     discovery + daily re-score + watchlist marking
src/lib/signals/rules.ts       pure rule engine
src/lib/signals/engine.ts      stateful: position book, dedupe, persist, dispatch
src/lib/signals/poll.ts        REST poller
src/lib/alerts/dispatch.ts     admin Telegram chat / Discord / Resend
src/lib/telegram/              bot: api, commands (pure), store, broadcast, webhook glue
scripts/telegram-setup.ts      register webhook + command menu
scripts/bot-poll.ts            local long-polling mode
src/app/                       dashboard + API routes
src/lib/paper/                 paper ledger, marking/settlement, execution simulator (sim/), portfolio (portfolio/)
src/lib/chunk.ts               IN-list chunking for PostgREST (URL length)
worker/ws-listener.ts          the worker: websocket, poller, re-score, marking, simulation, retention
tests/                         vitest
```

## V2 — paper measurement

Every signal is also recorded as a **paper experiment**: a $100 hypothetical long on the outcome token at the signal price (`PAPER_SIZE_USD` to change). EXIT signals never open a position; they close that wallet's open paper longs on the token at the exit price. The worker marks open positions at **1h / 6h / 24h** from `/v2/prices-history?as_of=` and settles them from `/v2/resolutions` payouts (Gamma and the price-history settlement tick are fallbacks) (`MARK_INTERVAL_MIN`, default 10). Missing prices and unparseable resolutions are logged to `data_quality_issues`, never zeroed.

- Telegram: `/performance [7d|30d|all]`, `/stats`, `/signal <ref>` (the ref is printed on every alert), `/wallet` now includes paper results, `/status` shows component health with staleness warnings.
- Dashboard: `/performance` (overview, by type / score band / consensus depth / wallet, signal history) and `/signal/<id>` (timeline of real observations).
- Migrations `0003`–`0007` (additive): `paper_marks`, `consensus_events`, `data_quality_issues`, `markets`, `price_observations`, `paper_executions`; `paper_ledger` extended. Execution realism is documented in `docs/PAPER_EXECUTION.md`, bot detection in `docs/BOT_DETECTION.md`.
- Health heartbeats live in `cursors` under `health:*`.

Paper only. Win rates are computed on settled positions; samples under 10 are flagged "Insufficient data".

## Portfolio (Phase 3)

A simulated portfolio with finite capital on top of the Phase 2 paper records: one per execution mode, replayed signal
by signal under operator-set limits (cash, open positions, per-wallet and per-market caps, total exposure), each
position held until its own wallet exits or the market resolves. Paper only; IDEAL is shown as a non-causal baseline.
It is **off** until `PAPER_PORTFOLIO_CONFIG` is set on the worker (no defaults); results appear on `/execution`.

- How it works, how to read the numbers, configuration, the switch-on runbook and troubleshooting:
  **[`docs/PORTFOLIO.md`](docs/PORTFOLIO.md)**. Design and decisions: `docs/PHASE3_PLAN.md`.
- `npm run portfolio:audit` — read-only check of stored decisions against their current inputs (decision D13), part
  of the switch-on runbook.
- Code: `src/lib/paper/portfolio/`; migrations `0008`–`0011`.
