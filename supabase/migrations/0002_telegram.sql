-- Telegram bot: per-chat subscriptions and mutes.
create table if not exists tg_subscribers (
  chat_id       bigint primary key,
  username      text,
  kinds         text[] not null default '{NEW_POSITION,CONSENSUS,CONVICTION_ADD,EARLY_ENTRY,EXIT}',
  min_severity  int  not null default 2 check (min_severity between 1 and 5),
  min_usd       numeric not null default 0,
  min_score     numeric not null default 0,           -- copy-score floor for this chat
  only_wallets  text[] not null default '{}',         -- empty = whole watchlist
  muted_wallets text[] not null default '{}',
  muted_until   timestamptz,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists tg_subscribers_active_idx on tg_subscribers (active) where active;

-- Delivery log per chat, so a redeploy never double-sends.
create table if not exists tg_deliveries (
  signal_id uuid not null references signals(id) on delete cascade,
  chat_id   bigint not null,
  sent_at   timestamptz not null default now(),
  ok        boolean not null,
  primary key (signal_id, chat_id)
);

-- Live consensus view: tokens where ≥2 tracked wallets are long right now.
create or replace view consensus_now as
select p.token_id, p.condition_id, max(p.title) as title, max(p.slug) as slug, max(p.outcome) as outcome,
       count(*) as wallets, sum(p.cost_usd) as cost_usd, sum(w.copy_score) as weighted_score,
       avg(p.avg_price) as avg_entry, max(p.last_seen) as last_seen, max(p.end_date) as end_date,
       array_agg(coalesce(w.name, left(p.wallet, 8)) order by w.copy_score desc) as names
from positions p join wallets w on w.address = p.wallet and w.tracked
where p.size > 0
group by p.token_id, p.condition_id
having count(*) >= 2;
