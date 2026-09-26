-- Phase 3.1: portfolio / risk layer — schema only (docs/PHASE3_PLAN.md §E). Additive; safe to run more than once.
-- Nothing here changes an existing table's columns. The one replaced object is the token_resolutions view (D3), whose
-- columns and meaning for existing rows are unchanged: it gains rows for tokens the marker no longer watches.
-- portfolio_report() lands in 0009 with the JS report it must match (plan §J step 7).

-- ── portfolios: one per (mode, execution config, portfolio config, start) ──────────────────────────
create table if not exists portfolios (
  id               text primary key check (length(id) between 8 and 64),  -- hash(mode, exec_config_hash, config_hash, start_ts)
  mode             text not null check (mode in ('IDEAL','REALISTIC','CONSERVATIVE')),
  exec_config_hash text not null,
  config           jsonb not null,                                          -- PortfolioConfig exactly as supplied (no defaults)
  config_hash      text not null,
  start_ts         timestamptz not null,                                    -- D4: completion of the 27 Sep re-score
  status           text not null default 'ACTIVE' check (status in ('ACTIVE','RETIRED')),
  created_at       timestamptz not null default now()
);

-- ── run bookkeeping + lease (one writer per portfolio) ───────────────────────────────────────────────
create table if not exists portfolio_runs (
  portfolio_id         text primary key references portfolios(id) on delete cascade,
  lease_owner          text,
  lease_until          timestamptz,
  last_run_started_at  timestamptz,                                         -- change detection reads computed_at after this
  last_run_finished_at timestamptz,
  last_watermark_ts    timestamptz,                                         -- last decided event (the frontier)
  last_watermark_key   text,
  stats                jsonb not null default '{}',
  updated_at           timestamptz not null default now()
);

-- ── checkpoints: serialised PortfolioState at an event boundary ─────────────────────────────────────
create table if not exists portfolio_checkpoints (
  portfolio_id text not null references portfolios(id) on delete cascade,
  event_ts     timestamptz not null,                                        -- state is AFTER every event ordered <= (event_ts, event_key)
  event_key    text not null,                                               -- kindOrder|signalId|seq: the total order of §B9
  state        jsonb not null,
  built_at     timestamptz not null default now(),
  primary key (portfolio_id, event_ts, event_key)
);

-- ── one decision per (portfolio, entry signal) ─────────────────────────────────────────────────────
create table if not exists portfolio_decisions (
  portfolio_id  text not null references portfolios(id) on delete cascade,
  signal_id     uuid not null references signals(id) on delete cascade,
  kind          text not null check (kind in ('NEW_POSITION','CONSENSUS','CONVICTION_ADD','EARLY_ENTRY')),
  source_key    text not null,                                              -- source_fill_id when present, else legacy sourceKey
  event_ts      timestamptz not null,                                       -- simulated fill time
  outcome       text not null check (outcome in ('FILLED','PARTIALLY_FILLED','UNFILLED','EXPIRED','INVALID','UNKNOWN','REJECTED')),
  reason        text,
  requested_usd numeric not null check (requested_usd >= 0),
  filled_usd    numeric not null default 0 check (filled_usd >= 0),
  filled_shares numeric not null default 0 check (filled_shares >= 0),
  fill_price    numeric check (fill_price is null or (fill_price > 0 and fill_price < 1)),
  fee           numeric not null default 0 check (fee >= 0),
  resized       boolean not null default false,
  input_hash    text not null,                                              -- decision inputs only (§B2): never marks
  record_hash   text not null,
  computed_at   timestamptz not null default now(),
  primary key (portfolio_id, signal_id),
  constraint portfolio_decisions_rejected_reason check (outcome <> 'REJECTED' or reason like 'REJECTED\_%'),
  constraint portfolio_decisions_filled_le_requested check (filled_usd <= requested_usd + 1e-6),
  constraint portfolio_decisions_fill_needs_shares check ((outcome in ('FILLED','PARTIALLY_FILLED')) = (filled_shares > 0))
);
create index if not exists portfolio_decisions_event_idx on portfolio_decisions (portfolio_id, event_ts);

-- ── lots: one per filled decision ───────────────────────────────────────────────────────────────────
create table if not exists portfolio_lots (
  portfolio_id        text not null,
  signal_id           uuid not null,
  wallet              text not null,
  token_id            text not null,
  condition_id        text not null,
  opened_ts           timestamptz not null,
  shares_filled       numeric not null check (shares_filled > 0),
  cost_usd            numeric not null check (cost_usd > 0),              -- filled notional (cost basis)
  entry_fee           numeric not null default 0 check (entry_fee >= 0),
  shares_open         numeric not null check (shares_open >= 0),
  cost_open           numeric not null check (cost_open >= 0),
  exit_signal_id      uuid,                                                 -- linked EXIT (§B11 rehydration compares this)
  exit_ts             timestamptz,
  exit_shares         numeric check (exit_shares is null or exit_shares >= 0),
  exit_proceeds       numeric check (exit_proceeds is null or exit_proceeds >= 0),
  exit_fee            numeric check (exit_fee is null or exit_fee >= 0),
  resolution_ts       timestamptz,
  resolution_value    numeric check (resolution_value is null or resolution_value between 0 and 1),
  resolution_proceeds numeric check (resolution_proceeds is null or resolution_proceeds >= 0),
  state               text not null check (state in ('OPEN','PARTIALLY_EXITED','EXITED','RESOLVED')),
  locked_unresolved   boolean not null default false,                       -- open > 30 d with no resolution: label only
  realized_pnl        numeric not null default 0,
  closed_ts           timestamptz,
  record_hash         text not null,
  computed_at         timestamptz not null default now(),
  primary key (portfolio_id, signal_id),
  foreign key (portfolio_id, signal_id) references portfolio_decisions(portfolio_id, signal_id) on delete cascade,
  constraint portfolio_lots_closed_consistent check ((state in ('EXITED','RESOLVED')) = (closed_ts is not null)),
  constraint portfolio_lots_closed_empty check (state not in ('EXITED','RESOLVED') or shares_open <= 1e-9),
  constraint portfolio_lots_open_le_filled check (shares_open <= shares_filled + 1e-9)
);
create index if not exists portfolio_lots_open_idx on portfolio_lots (portfolio_id) where state in ('OPEN','PARTIALLY_EXITED');

-- ── equity curve (downsampled to hourly after 7 days by the runner) ─────────────────────────────────
create table if not exists portfolio_equity (
  portfolio_id text not null references portfolios(id) on delete cascade,
  ts           timestamptz not null,
  seq          int not null,
  cash         numeric not null,
  exposure     numeric not null check (exposure >= 0),
  equity       numeric not null,
  primary key (portfolio_id, ts, seq)
);

-- ── streaming + change detection on the existing execution table (plan §B1, §B2) ────────────────────
create index if not exists paper_executions_mode_fill_idx on paper_executions (mode, fill_ts, signal_id);
create index if not exists paper_executions_mode_computed_idx on paper_executions (mode, computed_at);

-- ── D3: resolutions for tokens the marker no longer watches ─────────────────────────────────────────
-- Written by src/lib/paper/resolve-orphans.ts (step 3). One authoritative observation per token.
create table if not exists token_resolution_obs (
  token_id     text primary key,
  condition_id text not null,
  value        numeric not null check (value between 0 and 1),          -- payout per share
  resolved_ts  timestamptz not null,                                     -- on-chain resolved_at (D2)
  source       text not null,
  observed_at  timestamptz not null default now()
);

-- Same columns, same meaning for every token it already covered; earliest resolution wins, ties broken by value so the
-- choice is deterministic. Disagreements are surfaced below, never silently merged.
create or replace view token_resolutions as
  select distinct on (token_id) token_id, value, resolved_ts from (
    select token_id, final_price as value, coalesce(resolved_at, settled_at) as resolved_ts
      from paper_ledger where status in ('RESOLVED_WIN','RESOLVED_LOSS') and final_price is not null
    union all
    select token_id, value, resolved_ts from token_resolution_obs
  ) r
  order by token_id, resolved_ts, value;

create or replace view token_resolution_conflicts as
  select token_id, array_agg(distinct value order by value) as values, min(resolved_ts) as first_resolved_ts
  from (
    select token_id, final_price as value, coalesce(resolved_at, settled_at) as resolved_ts
      from paper_ledger where status in ('RESOLVED_WIN','RESOLVED_LOSS') and final_price is not null
    union all
    select token_id, value, resolved_ts from token_resolution_obs
  ) r
  group by token_id having count(distinct value) > 1;

-- ── lease functions ──────────────────────────────────────────────────────────────────────────────────
-- Claim or renew. True for exactly one owner at a time; a lease expires on its own if the holder dies.
create or replace function claim_portfolio_lease(p_portfolio_id text, p_owner text, p_seconds int)
returns boolean language plpgsql as $$
declare ok boolean;
begin
  if p_owner is null or length(p_owner) = 0 then raise exception 'lease owner required'; end if;
  if p_seconds is null or p_seconds < 1 or p_seconds > 3600 then raise exception 'lease seconds must be 1..3600, got %', p_seconds; end if;
  insert into portfolio_runs (portfolio_id) values (p_portfolio_id) on conflict (portfolio_id) do nothing;
  update portfolio_runs
     set lease_owner = p_owner, lease_until = clock_timestamp() + make_interval(secs => p_seconds), updated_at = now()
   where portfolio_id = p_portfolio_id
     and (lease_until is null or lease_until <= clock_timestamp() or lease_owner = p_owner)
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function release_portfolio_lease(p_portfolio_id text, p_owner text)
returns boolean language plpgsql as $$
declare ok boolean;
begin
  update portfolio_runs set lease_owner = null, lease_until = null, updated_at = now()
   where portfolio_id = p_portfolio_id and lease_owner = p_owner
  returning true into ok;
  return coalesce(ok, false);
end $$;

revoke all on function claim_portfolio_lease(text, text, int) from public, anon, authenticated;
revoke all on function release_portfolio_lease(text, text) from public, anon, authenticated;
grant execute on function claim_portfolio_lease(text, text, int) to service_role;
grant execute on function release_portfolio_lease(text, text) to service_role;

-- ── row level security: results are public-read like the rest of the paper data; runs/checkpoints are not ──
alter table portfolios            enable row level security;
alter table portfolio_runs        enable row level security;
alter table portfolio_checkpoints enable row level security;
alter table portfolio_decisions   enable row level security;
alter table portfolio_lots        enable row level security;
alter table portfolio_equity      enable row level security;
alter table token_resolution_obs  enable row level security;
drop policy if exists "public read portfolios" on portfolios;
create policy "public read portfolios" on portfolios for select using (true);
drop policy if exists "public read portfolio_decisions" on portfolio_decisions;
create policy "public read portfolio_decisions" on portfolio_decisions for select using (true);
drop policy if exists "public read portfolio_lots" on portfolio_lots;
create policy "public read portfolio_lots" on portfolio_lots for select using (true);
drop policy if exists "public read portfolio_equity" on portfolio_equity;
create policy "public read portfolio_equity" on portfolio_equity for select using (true);
drop policy if exists "public read token_resolution_obs" on token_resolution_obs;
create policy "public read token_resolution_obs" on token_resolution_obs for select using (true);
-- portfolio_runs, portfolio_checkpoints: service role only (no policy).
