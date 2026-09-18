# Polymarket copy-signal engine

Scores every wallet that reaches a Polymarket leaderboard over a rolling 90-day
window, keeps the ones whose edge looks real *and* followable, watches their
fills live, and alerts you when they open, add, or exit.

Companion to the published snapshot dashboard (17 Sep 2026): the same scoring
formula, the same 180-wallet watchlist (`config/watchlist.json`).

Read-only research on public data. Nothing here places trades.

## How it works

```
daily 04:15 UTC   /api/cron/refresh-wallets   discover every board (11 cats × 4 windows × 2 sorts)
                                              + recent $10k+ fills → score ~1,400 wallets → mark watchlist
every minute      /api/cron/poll-trades       REST backstop: new fills per tracked wallet since cursor
always-on         npm run worker              websocket firehose → tracked wallets only → same engine
                        ↓
                  src/lib/signals/rules.ts    NEW_POSITION · CONSENSUS · CONVICTION_ADD · EARLY_ENTRY · EXIT
                        ↓
                  Supabase (signals, positions, fills)  →  Telegram / Discord / email
```

The websocket path is real-time (~2 s Polygon blocks). REST is CDN-cached
`max-age=300`, so the poller alone is up to 5 minutes behind — it exists so a
dropped socket costs latency, not fills.

## Setup (15 minutes)

1. **Supabase** — create a project, open the SQL editor, paste
   `supabase/migrations/0001_init.sql`, run it.
2. **Env** — `cp .env.example .env.local` and fill in the Supabase URL + service
   role key, a `CRON_SECRET`, and whichever alert channels you want
   (Telegram: create a bot with @BotFather, message it once, get your chat id
   from `https://api.telegram.org/bot<TOKEN>/getUpdates`).
3. **Install + test**
   ```bash
   npm install
   npm test          # 54 tests: rules, scoring, client, dispatch, bot
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
6. **Deploy** — push to Vercel; `vercel.json` registers both crons and Vercel
   sends `Authorization: Bearer $CRON_SECRET` automatically. Run the worker on
   Railway / Fly / any box (`npm run worker`) — Vercel functions can't hold a
   socket open.
7. **First full re-score**: `npm run refresh` (≈4,000 API calls, ~5 min).

## Telegram bot

The engine *is* a Telegram bot. Anyone who messages it gets their own filtered
alert stream; signals are pushed the moment the rules fire.

**Setup**
1. @BotFather → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`; set any
   random string as `TELEGRAM_WEBHOOK_SECRET`.
2. Run both migrations (`0001_init.sql`, `0002_telegram.sql`).
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
worker/ws-listener.ts          live websocket listener
tests/                         vitest
```

## Paper ledger

`paper_ledger` is provisioned for tracking what a $100 copy of each signal
Deployed via Vercel.
would have returned (mark via `/v2/prices-history?as_of=`, settle via
`/v2/resolutions`). The engine records every signal's entry price; wiring the
daily mark is the obvious next step and the honest way to find out whether any
of this has forward information.
