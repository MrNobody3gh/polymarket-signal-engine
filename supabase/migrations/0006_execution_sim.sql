-- Phase 2: realistic paper execution. Additive; the original paper_ledger (IDEAL methodology) is untouched in meaning.
-- Rollback: drop the new tables and columns listed here; nothing pre-existing is altered.

-- Observed timestamps for latency accounting (null for rows written before this migration).
alter table fills   add column if not exists received_at  timestamptz;
alter table signals add column if not exists received_at  timestamptz;
alter table signals add column if not exists evaluated_at timestamptz;
alter table signals add column if not exists source_fill_id text;

-- Marker: round-robin checking + authoritative resolution time.
alter table paper_ledger add column if not exists mark_checked_at timestamptz;
alter table paper_ledger add column if not exists resolved_at timestamptz;
create index if not exists paper_ledger_open_check_idx on paper_ledger (mark_checked_at nulls first) where status = 'OPEN';

-- Execution-relevant market configuration (from Gamma; null = not provided).
alter table markets add column if not exists fees_enabled      boolean;
alter table markets add column if not exists taker_fee_rate    numeric;
alter table markets add column if not exists tick_size         numeric;
alter table markets add column if not exists min_order_shares  numeric;
alter table markets add column if not exists clob_token_ids    text[];
alter table markets add column if not exists meta_fetched_at   timestamptz;

-- Point-in-time price cache: "last trade at or before as_of". A past as_of answer never changes, so rows are immutable.
create table if not exists price_observations (
  token_id           text not null,
  as_of              bigint not null,           -- epoch s the question was asked for (a simulated decision time)
  obs_ts             bigint,                    -- epoch s of the observation returned (<= as_of), null = none existed
  price              numeric,
  resolution_seconds int,
  fetched_at         timestamptz not null default now(),
  primary key (token_id, as_of)
);

-- One simulated execution per (signal, mode). IDEAL reproduces the original ledger; REALISTIC / CONSERVATIVE add execution.
create table if not exists paper_executions (
  signal_id uuid not null references signals(id) on delete cascade,
  mode text not null check (mode in ('IDEAL','REALISTIC','CONSERVATIVE')),
  kind text not null, config_hash text not null,
  source_trade_ts timestamptz, evaluated_ts timestamptz, latency_source text, submit_ts timestamptz, fill_ts timestamptz,
  signal_price numeric, market_price numeric, market_obs_ts timestamptz, fill_price numeric, tick numeric, slippage_ticks numeric,
  status text not null, reason text, requested_usd numeric, filled_usd numeric, filled_shares numeric, fill_pct numeric,
  entry_fee numeric, fee_rate numeric, fee_source text, latency_cost numeric, entry_slippage_cost numeric,
  exit_trigger_ts timestamptz, exit_decision_ts timestamptz, exit_fill_ts timestamptz, exit_market_price numeric, exit_fill_price numeric,
  exit_slippage_ticks numeric, exit_status text, exit_reason text, exit_sold_shares numeric, exit_fee numeric, exit_slippage_cost numeric,
  resolution_ts timestamptz, resolution_value numeric, resolution_shares numeric, mark_ts timestamptz, mark_price numeric, open_shares numeric,
  state text not null, gross_pnl numeric, fees_total numeric, net_pnl numeric, realized_pnl numeric, unrealized_pnl numeric, closed_at timestamptz,
  computed_at timestamptz not null default now(),
  primary key (signal_id, mode)
);
create index if not exists paper_executions_mode_kind_idx on paper_executions (mode, kind);

-- Latest portfolio simulation per mode (only when PAPER_PORTFOLIO_CONFIG is set).
create table if not exists paper_portfolio_runs (
  mode text primary key, exec_config_hash text not null, portfolio_config jsonb not null, summary jsonb not null, decisions jsonb not null,
  computed_at timestamptz not null default now()
);

alter table price_observations enable row level security;
alter table paper_executions enable row level security;
alter table paper_portfolio_runs enable row level security;
create policy "public read paper_executions" on paper_executions for select using (true);
create policy "public read paper_portfolio_runs" on paper_portfolio_runs for select using (true);
