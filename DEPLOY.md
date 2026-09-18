# Going live — step by step

Total time: about 45 minutes. You need a laptop with Node 20+ and Git, and the
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
4. New query again → paste **all** of `supabase/migrations/0002_telegram.sql` → **Run**.
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
npm test                      # expect: 54 passed
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

**About Vercel crons:** the free Hobby plan only allows crons to run once a day, and caps functions at 60 seconds. That's fine — the daily re-score cron will run, and the every-minute poll is also done by the Railway worker (Step 7), so you don't need Vercel Pro. If you later upgrade to Pro, the minute cron in `vercel.json` starts working automatically as a second backstop.

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
Runs ~4,000 API calls, takes about 5 minutes, prints `scored 1400, tracking 180`. After this, the 04:15 UTC Vercel cron repeats it every day. (Don't trigger the refresh through the Vercel URL on the Hobby plan — 60-second limit; run it locally or add a second Railway service with start command `npm run refresh` and a daily cron schedule.)

## Step 10 — Optional extras

- **Fill the position book faster:** the engine only knows positions it has seen fills for. It fills in naturally over the first day.
- **Discord / email:** add `DISCORD_WEBHOOK_URL` or `RESEND_API_KEY` + `ALERT_EMAIL_TO` to Vercel *and* Railway env, redeploy.
- **Invite others:** anyone who messages the bot and sends `/start` gets their own alert stream with their own filters.
- **Tune it:** `/severity 3`, `/min 5000`, `/kinds new consensus` in Telegram — per person, no redeploy.

---

## Checklist — you're live when

- [ ] `https://<vercel-url>/board` shows fills from the last few minutes
- [ ] Railway logs show `connected to wss://…`
- [ ] Bot answers `/status` with your laptop closed
- [ ] Vercel → Project → **Cron Jobs** shows `refresh-wallets` scheduled

## If something's wrong

| Symptom | Fix |
|---|---|
| `npm test` fails | Node version — run `node -v`, needs 20+. |
| `/wallets` empty | Step 4 seed didn't run, or env vars missing on Vercel. Re-run `npm run refresh -- --seed`. |
| Bot doesn't reply | Run `npm run tg:setup -- <url>` again and check `ok: true`. Make sure `TELEGRAM_WEBHOOK_SECRET` on Vercel matches `.env.local`. |
| No alerts for hours | Normal-ish: rules only fire on $2k+ new positions by score ≥ 40 wallets. Send `/severity 1` and `/min 500` to loosen. Check Railway logs are still scrolling. |
| Railway shows `socket closed; reconnect` repeatedly | Polymarket hiccup; it backs off and reconnects. Fills are still caught by the minute poll. |
| Supabase "permission denied" | You pasted the anon key instead of service_role. |
