# Going live — step by step

Total time: about 45 minutes. You need a laptop with Node 22+ and Git, and the
unzipped project open in Cursor (or a terminal in the project folder).

Cost: Supabase free, Vercel free (Hobby), Railway ~$5/month, Telegram free.

---

## Step 1 — Create the Telegram bot (3 min)

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Give it a display name (e.g. `Polymarket Signals`) and a username ending in `bot` (e.g. `pm_signals_bot`).
3. BotFather replies with a token like `7412345678:AAH…`. **Copy it** — this is `TELEGRAM_BOT_TOKEN`.
4. Open your new bot's chat and press Start (don't send anything else yet).

## Step 2 — Create the database on Supabase (5 min)

1. Go to supabase.com → **New project**. Name it `polymarket-signals`, choose a strong DB password (save it), region **London**. Wait ~2 minutes for it to provision.
2. Left sidebar → **SQL Editor** → **New query**.
3. Open `supabase/migrations/0001_init.sql` in Cursor, copy **all** of it, paste into the editor, click **Run**. You should see "Success".
4. Repeat for **every other file** in `supabase/migrations/`, in order: `0002_telegram.sql`, `0003_v2_paper.sql`, `0004_retention.sql`, `0005_signal_correctness.sql`, `0006_execution_sim.sql`, `0007_stabilise.sql`, `0008_portfolio.sql`, `0009_orphan_resolutions.sql`, `0010_portfolio_report.sql`, `0011_portfolio_report_access.sql`. Each should say "Success". Skipping any of them breaks the worker (missing tables, columns and database functions).
5. Left sidebar → **Project Settings** → **API**. Copy two things:
   - **Project URL** (`https://xxxx.supabase.co`) → `NEXT_PUBLIC_SUPABASE_URL`
   - **service_role** key (click Reveal; it's the long secret one, *not* anon) → `SUPABASE_SERVICE_ROLE_KEY`

## Step 3 — Local config (3 min)

1. In the project folder, copy `.env.example` to `.env.local`.
2. Fill in:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ…
   CRON_SECRET=<any long random string>
   TELEGRAM_BOT_TOKEN=7412345678:AAH…
   TELEGRAM_WEBHOOK_SECRET=<another long random string>
   ```
   To make a random string, run `openssl rand -hex 24` in the terminal, or just mash the keyboard for 40 characters.
3. Leave `TELEGRAM_CHAT_ID`, Discord and Resend blank.

## Step 4 — Run it on your laptop first (10 min)

In the terminal, in the project folder:

```bash
npm install
npm test                      # expect: all passed (the real-Postgres tests are skipped without PG_TEST_URL)
npm run refresh -- --seed     # loads the 180-wallet watchlist → "seeded 180"
npm run dev                   # open http://localhost:3000/wallets — 180 wallets listed
```

Open a **second terminal** in the same folder:

```bash
npm run worker
```
You should see `tracking 180 wallets` then `connected to wss://ws-live-data.polymarket.com`. Within a couple of minutes http://localhost:3000/board shows live fills.

Open a **third terminal**:

```bash
npm run tg:setup              # sets the bot's command menu, polling mode
npm run bot
```
Now go to your bot in Telegram and send `/start`, then `/status` and `/wallets`. If those answer, the bot works. Leave everything running for a while and you'll get your first alerts.

Once this works locally, the rest is just moving the same thing to servers that stay on.

## Step 5 — Put the code on GitHub (3 min)

```bash
git init
git add .
git commit -m "polymarket signal engine"
```
On github.com → **New repository** → name `polymarket-signal-engine`, **Private**, no README → Create. Then run the two `git remote add…` / `git push…` lines GitHub shows you.

`.env.local` is git-ignored, so your keys do not go up.

## Step 6 — Deploy the app to Vercel (7 min)

1. vercel.com → **Add New → Project** → Import `polymarket-signal-engine`.
2. Before clicking Deploy, open **Environment Variables** and add every line from your `.env.local` (name and value, one at a time).
3. Click **Deploy**. Wait ~2 minutes. You get a URL like `https://polymarket-signal-engine.vercel.app`.
4. Check it: open `https://<your-url>/wallets` — the same 180 wallets.
5. Check the poller works from Vercel: open `https://<your-url>/api/cron/poll-trades?secret=<your CRON_SECRET>` — you should see `{"ok":true,"wallets":180,…}`.

**About Vercel crons:** there are none. The Hobby plan caps functions at 60 seconds, and the daily re-score takes about 5 minutes and saves only at the end — as a Vercel cron it would be killed every day without saving anything. Every scheduled job (the minute poll, the 04:15 UTC re-score, paper marking, the simulation) runs in the Railway worker (Step 7), so you don't need Vercel Pro. The `/api/cron/*` routes stay as manual entry points.

## Step 7 — Run the worker on Railway (7 min)

The worker holds the live websocket open and polls REST every minute. Vercel can't do that, so it lives on Railway.

1. railway.app → **New Project** → **Deploy from GitHub repo** → pick `polymarket-signal-engine`.
2. Click the service → **Variables** → **Raw Editor** → paste the contents of your `.env.local` → Update.
3. **Settings** → **Deploy** → **Custom Start Command**: `npm run worker`
4. **Settings** → **Networking**: no public domain needed.
5. Redeploy. Open **Deployments → View logs**. You want to see:
   ```
   tracking 180 wallets
   connected to wss://ws-live-data.polymarket.com
   ```
   If you see `poll: N fills` lines every minute, the REST backstop is working too.

Railway restarts the worker automatically if it ever crashes.

## Step 8 — Switch the bot to always-on (2 min)

Back on your laptop (stop `npm run bot` first if it's running — Ctrl+C):

```bash
npm run tg:setup -- https://<your-vercel-url>
```
Expect `webhook: { ok: true, … }`. From now on Telegram talks to Vercel directly, so the bot answers even when your laptop is off.

Test: send `/status` to the bot. It should reply with "Tracking 180 wallets".

## Step 9 — First full re-score (5 min, optional today)

The seed is the 17 Sep snapshot. To re-score every wallet from the live API with your own engine:

```bash
npm run refresh
```
Runs ~4,000 API calls, takes about 5 minutes, prints `scored 1400, tracking 180`. You usually don't need to: the Railway worker runs this automatically on its first start and then every day at 04:15 UTC (look for `[rescore]` lines in its logs). Don't trigger the refresh through the Vercel URL on the Hobby plan — it will hit the 60-second limit.

## Step 10 — Optional: the portfolio simulation (Phase 3)

A paper-only portfolio with finite capital, one per execution mode, shown on `/execution`. It is **off** unless you set
it on the Railway worker. Two variables, both read once when the worker starts:

| Variable | Value |
|---|---|
| `PAPER_PORTFOLIO_CONFIG` | One JSON object with every limit and the start time; no defaults. Unset = off. Every field and rule: `docs/PORTFOLIO.md` §7. |
| `PAPER_PORTFOLIO_DRY_RUN` | `1` = compute and log only, write nothing. Unset, empty or `0` = real runs. Anything else turns the feature off. |

Switch it on **only by following the runbook**, `docs/PORTFOLIO.md` §8 (migrations `0010`–`0011`, a dry run first,
the read-only check `railway run npm run portfolio:audit`, then real runs). Switching off: delete the variables and
redeploy; nothing is deleted (§9).

### Late alerts (D22)

A signal whose source trade is **more than 1 hour old when it is evaluated** is still stored, simulated and listed
everywhere, but no Telegram alert is sent for it (subscribers and the admin chat; also Discord and email, which share the
same path). It is a safety net for outages and catch-ups, not a daily event. Nothing needs to be set: the default is 1
hour (D23). To change it, set the variable on the Railway worker **and** on Vercel (the poller evaluates too):

| Variable | Value |
|---|---|
| `ALERT_MAX_LAG_HOURS` | Optional. Hours, a positive number (default `1`). Late means strictly more than this between the trade and its evaluation. Anything else (empty, `0`, negative, text) uses `1` and logs one line at start; it never switches the rule off. |

Each suppressed alert is a `data_quality_issues` row (`kind = 'stale_alert_suppressed'`) and `/status` shows how many
were held back in the last 24 h. See `docs/PORTFOLIO.md` §11 (D22, D23).

## Step 11 — Optional extras

- **Fill the position book faster:** the engine only knows positions it has seen fills for. It fills in naturally over the first day.
- **Discord / email:** add `DISCORD_WEBHOOK_URL` or `RESEND_API_KEY` + `ALERT_EMAIL_TO` to Vercel *and* Railway env, redeploy.
- **Invite others:** anyone who messages the bot and sends `/start` gets their own alert stream with their own filters.
- **Tune it:** `/severity 3`, `/min 5000`, `/kinds new consensus` in Telegram — per person, no redeploy.

---

## Checklist — you're live when

- [ ] `https://<vercel-url>/board` shows fills from the last few minutes
- [ ] Railway logs show `connected to wss://…`
- [ ] Bot answers `/status` with your laptop closed
- [ ] Railway logs show `[rescore] scored …, tracking …` (first start, then daily after 04:15 UTC)

## If something's wrong

| Symptom | Fix |
|---|---|
| `npm test` fails | Node version — run `node -v`, needs 22+. |
| `/wallets` empty | Step 4 seed didn't run, or env vars missing on Vercel. Re-run `npm run refresh -- --seed`. |
| Bot doesn't reply | Run `npm run tg:setup -- <url>` again and check `ok: true`. Make sure `TELEGRAM_WEBHOOK_SECRET` on Vercel matches `.env.local`. |
| No alerts for hours | Normal-ish: rules only fire on $2k+ new positions by score ≥ 40 wallets. Send `/severity 1` and `/min 500` to loosen. Check Railway logs are still scrolling. |
| Railway shows `socket closed; reconnect` repeatedly | Polymarket hiccup; it backs off and reconnects. Fills are still caught by the minute poll. |
| Supabase "permission denied" | You pasted the anon key instead of service_role. |
| Portfolio section says "off", or a `portfolio:` line in the Railway logs | See `docs/PORTFOLIO.md` §10 (troubleshooting). |
