-- Phase 1 signal correctness. Additive only.
-- 1) BUY and SELL times tracked separately; consensus reads last_buy_ts, never last_seen.
alter table positions add column if not exists last_buy_ts  timestamptz;
alter table positions add column if not exists last_sell_ts timestamptz;
create index if not exists positions_token_open_buy_idx on positions (token_id, last_buy_ts) where size > 0;
-- Backfill from the fills we still hold (7-day retention). Positions with no observed BUY stay null = "not a recent buyer".
update positions p set last_buy_ts = f.ts from (select wallet, token_id, max(ts) ts from fills where side = 'BUY' group by 1,2) f
  where f.wallet = p.wallet and f.token_id = p.token_id and p.last_buy_ts is null;
update positions p set last_sell_ts = f.ts from (select wallet, token_id, max(ts) ts from fills where side = 'SELL' group by 1,2) f
  where f.wallet = p.wallet and f.token_id = p.token_id and p.last_sell_ts is null;

-- 2) Authoritative market metadata cache (end dates for EARLY_ENTRY), survives restarts.
create table if not exists markets (
  condition_id text primary key,
  end_date     date,
  fetched_at   timestamptz not null default now()
);
alter table markets enable row level security;
create policy "public read markets" on markets for select using (true);
