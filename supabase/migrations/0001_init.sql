-- Polymarket copy-signal engine — schema
-- Run with `supabase db push` or paste into the SQL editor.

create extension if not exists pgcrypto;

-- One row per wallet we have scored. `tracked` marks watchlist membership.
create table if not exists wallets (
  address        text primary key,                  -- proxy wallet, lowercase 0x…
  name           text,
  copy_score     numeric not null default 0,        -- 0..100, see src/lib/scoring/score.ts
  pnl_90d        numeric not null default 0,        -- mark-inclusive, USD, rolling 90 days
  style          text not null default 'Selective directional',
  fills_per_day  numeric,
  program_share  numeric,                           -- share of profit from rebates/rewards
  concentration  numeric,                           -- biggest win / lifetime profit
  net_dd         numeric,                           -- profit per $ of max drawdown
  months_up      int not null default 0,
  months_total   int not null default 0,
  days_idle      int,
  trade_count    int,
  sources        text[] not null default '{}',      -- which boards it came from
  tracked        boolean not null default false,
  scored_at      timestamptz not null default now()
);
create index if not exists wallets_tracked_idx on wallets (tracked) where tracked;
create index if not exists wallets_score_idx on wallets (copy_score desc);

-- Current book per (wallet, outcome token), maintained from fills.
create table if not exists positions (
  wallet        text not null references wallets(address) on delete cascade,
  token_id      text not null,
  condition_id  text not null,
  outcome       text,
  title         text,
  slug          text,
  size          numeric not null default 0,         -- shares currently held
  avg_price     numeric not null default 0,
  cost_usd      numeric not null default 0,         -- basis of what is still held
  peak_size     numeric not null default 0,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  end_date      date,
  primary key (wallet, token_id)
);
create index if not exists positions_token_idx on positions (token_id) where size > 0;

-- Every fill we have seen from a tracked wallet. `id` is a composite that is
-- unique per fill even when several fills share one transaction hash.
create table if not exists fills (
  id            text primary key,                   -- tx:token:wallet:ts:side:size
  wallet        text not null,
  condition_id  text not null,
  token_id      text not null,
  side          text not null check (side in ('BUY','SELL')),
  size          numeric not null,
  price         numeric not null,
  usd           numeric not null,
  ts            timestamptz not null,
  title         text,
  slug          text,
  outcome       text,
  source        text not null default 'rest',       -- rest | ws
  raw           jsonb
);
create index if not exists fills_wallet_ts_idx on fills (wallet, ts desc);
create index if not exists fills_ts_idx on fills (ts desc);

-- Signals the rule engine fired. `dedupe_key` stops a duplicate inside the
-- dedupe window; `closed_at` is set by the exit rule.
create table if not exists signals (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('NEW_POSITION','CONSENSUS','CONVICTION_ADD','EARLY_ENTRY','EXIT')),
  severity      int  not null check (severity between 1 and 5),
  wallet        text not null,
  wallet_name   text,
  condition_id  text not null,
  token_id      text not null,
  outcome       text,
  title         text,
  slug          text,
  price         numeric,
  usd           numeric,
  payload       jsonb not null default '{}',
  dedupe_key    text not null,
  created_at    timestamptz not null default now(),
  closed_at     timestamptz,
  delivered     jsonb not null default '{}'         -- {telegram: true, discord: false, ...}
);
create unique index if not exists signals_dedupe_idx on signals (dedupe_key);
create index if not exists signals_created_idx on signals (created_at desc);
create index if not exists signals_open_idx on signals (wallet, token_id) where closed_at is null;

-- Small key/value store: REST poll cursors per wallet, last refresh, etc.
create table if not exists cursors (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

-- Paper ledger: what a $100 copy of each signal would have done. Filled by the
-- daily refresh from /v2/prices-history and resolutions.
create table if not exists paper_ledger (
  signal_id   uuid primary key references signals(id) on delete cascade,
  entry_price numeric not null,
  mark_price  numeric,
  resolved    boolean not null default false,
  payout      numeric,                                -- 0 or 1 once resolved
  pnl_per_100 numeric,
  updated_at  timestamptz not null default now()
);

-- Row level security: the browser only ever reads through the anon key.
alter table wallets enable row level security;
alter table signals enable row level security;
alter table positions enable row level security;
alter table fills enable row level security;
alter table paper_ledger enable row level security;
create policy "public read wallets"  on wallets  for select using (true);
create policy "public read signals"  on signals  for select using (true);
create policy "public read paper"    on paper_ledger for select using (true);
-- positions/fills/cursors are service-role only (no policy = no anon access).
