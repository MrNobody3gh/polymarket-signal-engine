-- V2: paper-trade measurement, price marks, consensus events, data quality, health.
-- Purely additive. Existing columns on paper_ledger are kept.

alter table paper_ledger
  add column if not exists wallet          text,
  add column if not exists wallet_name     text,
  add column if not exists kind            text,
  add column if not exists token_id        text,
  add column if not exists condition_id    text,
  add column if not exists outcome         text,
  add column if not exists title           text,
  add column if not exists slug            text,
  add column if not exists side            text not null default 'LONG',   -- LONG (paper long on the outcome token) | EXIT_EVENT (closes longs, no position)
  add column if not exists signal_ts       timestamptz,
  add column if not exists size_usd        numeric not null default 100,
  add column if not exists shares          numeric,
  add column if not exists copy_score      numeric,
  add column if not exists severity        int,
  add column if not exists consensus_depth int,
  add column if not exists trade_usd       numeric,                         -- the real fill size that triggered the signal
  add column if not exists status          text not null default 'OPEN',   -- OPEN | RESOLVED_WIN | RESOLVED_LOSS | EXITED | UNRESOLVED | INVALID | EXIT_EVENT
  add column if not exists status_reason   text,
  add column if not exists exit_price      numeric,
  add column if not exists exit_ts         timestamptz,
  add column if not exists final_price     numeric,
  add column if not exists final_pnl       numeric,
  add column if not exists final_return    numeric,                        -- fraction, e.g. 0.071 = +7.1%
  add column if not exists settled_at      timestamptz,
  add column if not exists created_at      timestamptz not null default now();
create index if not exists paper_ledger_status_idx on paper_ledger (status);
create index if not exists paper_ledger_wallet_idx on paper_ledger (wallet);
create index if not exists paper_ledger_token_idx  on paper_ledger (token_id) where status = 'OPEN';
create index if not exists paper_ledger_ts_idx     on paper_ledger (signal_ts desc);

-- One observation per (position, horizon). Re-running the marker is a no-op.
create table if not exists paper_marks (
  signal_id   uuid not null references paper_ledger(signal_id) on delete cascade,
  horizon     text not null check (horizon in ('1h','6h','24h','exit','resolution')),
  observed_at timestamptz not null,       -- the time the price refers to
  price       numeric not null,
  pnl         numeric not null,
  return_pct  numeric not null,           -- fraction
  source      text not null,              -- prices-history | fill | gamma | resolutions
  created_at  timestamptz not null default now(),
  primary key (signal_id, horizon)
);

-- Consensus context captured at the moment a CONSENSUS signal fires.
create table if not exists consensus_events (
  signal_id      uuid primary key references signals(id) on delete cascade,
  token_id       text not null,
  condition_id   text,
  outcome        text,
  depth          int not null,            -- wallets on the same side including this one
  participants   text[] not null,
  combined_usd   numeric,                 -- sum of the open paper/real positions' cost we could see
  first_buy_ts   timestamptz,             -- earliest tracked buy among participants
  this_buy_ts    timestamptz not null,
  spread_seconds int,                     -- this_buy_ts - first_buy_ts
  entry_prices   numeric[] not null default '{}',
  created_at     timestamptz not null default now()
);

-- Anything the pipeline could not process cleanly. Never silently dropped.
create table if not exists data_quality_issues (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,              -- missing_market | missing_wallet | invalid_price | price_out_of_bounds | duplicate_signal | duplicate_paper | missing_resolution | stale_market | stale_websocket | mark_failed | invalid_size | resolution_unparseable
  ref_type    text,                       -- signal | paper | fill | token | worker
  ref_id      text,
  detail      jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists dq_kind_idx on data_quality_issues (kind, created_at desc);
create unique index if not exists dq_open_unique on data_quality_issues (kind, ref_type, ref_id) where resolved_at is null;

alter table paper_marks enable row level security;
alter table consensus_events enable row level security;
alter table data_quality_issues enable row level security;
create policy "public read paper_marks" on paper_marks for select using (true);
create policy "public read consensus_events" on consensus_events for select using (true);
-- data_quality_issues: service role only (no policy).
