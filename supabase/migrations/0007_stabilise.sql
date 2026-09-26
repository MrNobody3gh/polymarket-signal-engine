-- Phase 2.5: stabilisation. Additive. Aggregation moves into Postgres so the worker never loads history into memory.

-- ── price backlog with explicit states ─────────────────────────────────────────────────────────────
alter table price_observations add column if not exists state text;
alter table price_observations add column if not exists attempts int not null default 0;
alter table price_observations add column if not exists next_attempt_at timestamptz;
alter table price_observations add column if not exists processing_started_at timestamptz;
alter table price_observations add column if not exists last_error text;
update price_observations set state = case when price is null then 'UNAVAILABLE' else 'COMPLETE' end where state is null;
alter table price_observations alter column state set default 'PENDING';
alter table price_observations alter column state set not null;
alter table price_observations drop constraint if exists price_observations_state_chk;
alter table price_observations add constraint price_observations_state_chk check (state in ('PENDING','PROCESSING','COMPLETE','FAILED','UNAVAILABLE'));
create index if not exists price_obs_queue_idx on price_observations (as_of) where state in ('PENDING','PROCESSING','FAILED');

-- Atomically claim a batch of backlog work. PROCESSING rows abandoned by a crashed worker are reclaimed after 10 minutes;
-- FAILED rows are retried when their backoff has elapsed. SKIP LOCKED makes concurrent claimers safe.
create or replace function claim_price_backlog(p_limit int)
returns table (token_id text, as_of bigint, attempts int) language sql as $$
  update price_observations o set state = 'PROCESSING', processing_started_at = now()
  from (select po.token_id, po.as_of from price_observations po
        where po.state = 'PENDING'
           or (po.state = 'FAILED' and po.next_attempt_at is not null and po.next_attempt_at <= now())
           or (po.state = 'PROCESSING' and po.processing_started_at < now() - interval '10 minutes')
        order by po.as_of, po.token_id limit p_limit for update skip locked) c
  where o.token_id = c.token_id and o.as_of = c.as_of
  returning o.token_id, o.as_of, o.attempts;
$$;

-- ── incremental simulation bookkeeping ─────────────────────────────────────────────────────────────
alter table paper_ledger add column if not exists sim_terminal boolean not null default false;
update paper_ledger set sim_terminal = true where side = 'EXIT_EVENT' and not sim_terminal;
create index if not exists paper_ledger_sim_open_idx on paper_ledger (signal_id) where not sim_terminal;
alter table paper_executions add column if not exists coverage_state text;
alter table paper_executions add column if not exists record_hash text;
alter table paper_executions add column if not exists fee_observed_at timestamptz;
update paper_executions set latency_source = 'ESTIMATED' where latency_source = 'ASSUMED';
update paper_executions set coverage_state = case
    when status in ('FILLED','PARTIALLY_FILLED') then 'SIMULATED' when status = 'UNKNOWN' then 'UNAVAILABLE_DATA'
    when status in ('UNFILLED','EXPIRED') then 'UNFILLED' when status = 'INVALID' then 'INVALID' else 'PENDING_DATA' end
  where coverage_state is null;
create index if not exists paper_executions_cov_idx on paper_executions (mode, coverage_state);

-- One resolution per token (earliest), for bounded per-batch joins.
create or replace view token_resolutions as
  select distinct on (token_id) token_id, final_price as value, coalesce(resolved_at, settled_at) as resolved_ts
  from paper_ledger where status in ('RESOLVED_WIN','RESOLVED_LOSS') and final_price is not null
  order by token_id, coalesce(resolved_at, settled_at);

-- ── wallet activity (bot detection) ────────────────────────────────────────────────────────────────
alter table wallets add column if not exists activity_status text;          -- OK | LOWER_BOUND | INSUFFICIENT_DATA
alter table wallets add column if not exists activity_reason text;
alter table wallets add column if not exists activity_fills int;
alter table wallets add column if not exists activity_window_days numeric;
alter table wallets add column if not exists active_days int;
alter table wallets add column if not exists activity_measured_at timestamptz;
alter table wallets add column if not exists bot_class text;               -- MARKET_MAKER | BOT_HIGH_FREQUENCY | HIGH_FREQUENCY | ACTIVE | INSUFFICIENT_DATA

-- ── telegram delivery health ───────────────────────────────────────────────────────────────────────
alter table tg_subscribers add column if not exists consecutive_failures int not null default 0;
alter table tg_subscribers add column if not exists next_attempt_at timestamptz;
alter table tg_subscribers add column if not exists last_error text;
alter table tg_subscribers add column if not exists disabled_reason text;
alter table tg_subscribers add column if not exists migrated_to bigint;

-- ── reporting in the database ──────────────────────────────────────────────────────────────────────
-- Execution report for one mode (optionally one kind). Every outcome is counted; pending/unavailable data is never P&L.
create or replace function paper_exec_stats(p_mode text, p_kind text default null) returns jsonb language sql stable as $$
  with e as (select * from paper_executions where mode = p_mode and (p_kind is null or kind = p_kind)),
  entered as (select * from e where coverage_state = 'SIMULATED' and filled_shares > 0),
  settled as (select * from entered where state in ('RESOLVED','EXITED')),
  curve as (select sum(net_pnl) over (order by closed_at, signal_id) as eq, row_number() over (order by closed_at, signal_id) as rn from settled),
  dd as (select coalesce(max(peak - eq), 0) as mdd, coalesce(max(peak), 0) as peak from (select eq, greatest(0, max(eq) over (order by rn rows unbounded preceding)) as peak from curve) x),
  ranked as (select net_pnl, row_number() over (order by net_pnl desc) as rk from settled)
  select jsonb_build_object(
    'total', (select count(*) from e),
    'coverage', jsonb_build_object(
      'SIMULATED', (select count(*) from e where coverage_state = 'SIMULATED'), 'PENDING_DATA', (select count(*) from e where coverage_state = 'PENDING_DATA'),
      'UNAVAILABLE_DATA', (select count(*) from e where coverage_state = 'UNAVAILABLE_DATA'), 'INVALID', (select count(*) from e where coverage_state = 'INVALID'),
      'UNFILLED', (select count(*) from e where coverage_state = 'UNFILLED')),
    'coveragePct', (select case when count(*) = 0 then null else count(*) filter (where coverage_state not in ('PENDING_DATA','UNAVAILABLE_DATA'))::numeric / count(*) end from e),
    'status', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from e group by status) s),
    'fillRateOfDecided', (select case when count(*) filter (where coverage_state not in ('PENDING_DATA','UNAVAILABLE_DATA')) = 0 then null else count(*) filter (where coverage_state = 'SIMULATED')::numeric / count(*) filter (where coverage_state not in ('PENDING_DATA','UNAVAILABLE_DATA')) end from e),
    'fillRateOfAll', (select case when count(*) = 0 then null else count(*) filter (where coverage_state = 'SIMULATED')::numeric / count(*) end from e),
    'latency', (select jsonb_build_object('avgSec', avg(extract(epoch from fill_ts - source_trade_ts)), 'medianSec', percentile_cont(0.5) within group (order by extract(epoch from fill_ts - source_trade_ts)),
        'observed', count(*) filter (where latency_source = 'OBSERVED'), 'estimated', count(*) filter (where latency_source = 'ESTIMATED'), 'none', count(*) filter (where latency_source = 'NONE'))
      from e where coverage_state <> 'PENDING_DATA'),
    'entrySlipTicks', (select jsonb_build_object('avg', avg(slippage_ticks), 'median', percentile_cont(0.5) within group (order by slippage_ticks)) from entered),
    'exitSlipTicks', (select jsonb_build_object('avg', avg(exit_slippage_ticks), 'median', percentile_cont(0.5) within group (order by exit_slippage_ticks)) from entered where exit_sold_shares > 0),
    'feeSources', (select coalesce(jsonb_object_agg(fee_source, n), '{}') from (select fee_source, count(*) n from entered group by fee_source) f),
    'fees', (select coalesce(sum(fees_total), 0) from entered),
    'slippageCost', (select coalesce(sum(coalesce(entry_slippage_cost, 0) + coalesce(exit_slippage_cost, 0)), 0) from entered),
    'latencyCost', (select coalesce(sum(latency_cost), 0) from entered),
    'grossPnl', (select coalesce(sum(gross_pnl), 0) from entered), 'netPnl', (select coalesce(sum(net_pnl), 0) from entered),
    'realizedPnl', (select coalesce(sum(realized_pnl), 0) from entered), 'unrealizedPnl', (select coalesce(sum(unrealized_pnl), 0) from entered),
    'settled', (select count(*) from settled),
    'winRate', (select case when count(*) = 0 then null else count(*) filter (where net_pnl > 0)::numeric / count(*) end from settled),
    'avgReturn', (select avg(net_pnl / nullif(filled_usd, 0)) from entered), 'medianReturn', (select percentile_cont(0.5) within group (order by net_pnl / nullif(filled_usd, 0)) from entered),
    'maxDrawdown', (select mdd from dd), 'peakEquity', (select peak from dd), 'endingEquity', (select coalesce(sum(net_pnl), 0) from settled),
    'robustness', jsonb_build_object(
      'exBest1', (select coalesce(sum(net_pnl), 0) - coalesce(sum(net_pnl) filter (where rk <= 1 and net_pnl > 0), 0) from ranked),
      'exBest3', (select coalesce(sum(net_pnl), 0) - coalesce(sum(net_pnl) filter (where rk <= 3 and net_pnl > 0), 0) from ranked),
      'exBest5', (select coalesce(sum(net_pnl), 0) - coalesce(sum(net_pnl) filter (where rk <= 5 and net_pnl > 0), 0) from ranked),
      'exBest10', (select coalesce(sum(net_pnl), 0) - coalesce(sum(net_pnl) filter (where rk <= 10 and net_pnl > 0), 0) from ranked),
      'profitFactor', (select case when coalesce(sum(net_pnl) filter (where net_pnl < 0), 0) = 0 then null else sum(net_pnl) filter (where net_pnl > 0) / -sum(net_pnl) filter (where net_pnl < 0) end from settled),
      'expectancy', (select avg(net_pnl) from settled), 'largestWin', (select max(net_pnl) filter (where net_pnl > 0) from settled), 'largestLoss', (select min(net_pnl) filter (where net_pnl < 0) from settled)));
$$;
create or replace function paper_exec_report(p_mode text) returns jsonb language sql stable as $$
  select jsonb_build_object('overall', paper_exec_stats(p_mode), 'byKind', coalesce((select jsonb_object_agg(kind, paper_exec_stats(p_mode, kind)) from (select distinct kind from paper_executions where mode = p_mode) k), '{}'));
$$;

-- Ledger performance (the IDEAL methodology), same shape as the JS computeStats, computed in the database.
create or replace function paper_group_stats(p_since timestamptz, p_group text) returns jsonb language sql stable as $$
  with base as (
    select l.*, coalesce(case when l.status in ('RESOLVED_WIN','RESOLVED_LOSS','EXITED') and l.final_pnl is not null then l.final_pnl end, m.pnl) as cur_pnl,
           coalesce(case when l.status in ('RESOLVED_WIN','RESOLVED_LOSS','EXITED') and l.final_return is not null then l.final_return end, m.return_pct) as cur_ret,
           (l.status in ('RESOLVED_WIN','RESOLVED_LOSS','EXITED') and l.final_pnl is not null) as is_settled
    from paper_ledger l
    left join lateral (select pnl, return_pct from paper_marks pm where pm.signal_id = l.signal_id order by observed_at desc limit 1) m on true
    where l.status <> 'EXIT_EVENT' and (p_since is null or l.signal_ts >= p_since)),
  keyed as (select *, case p_group when 'all' then 'all' when 'kind' then kind when 'wallet' then coalesce(wallet, 'unknown') when 'wallet_kind' then coalesce(wallet, 'unknown') || '|' || kind
      when 'band' then case when copy_score is null then 'unscored' when copy_score < 40 then '0–39' when copy_score < 60 then '40–59' when copy_score < 80 then '60–79' else '80–100' end
      when 'depth' then case when kind <> 'CONSENSUS' then null when coalesce(consensus_depth, 0) >= 5 then '5+ wallets' when consensus_depth between 2 and 4 then consensus_depth || ' wallets' else 'unknown' end end as k from base),
  g as (select k, count(*) as signals, count(*) filter (where status = 'OPEN') as open, count(*) filter (where status in ('RESOLVED_WIN','RESOLVED_LOSS')) as resolved,
      count(*) filter (where status = 'EXITED') as exited, count(*) filter (where status = 'UNRESOLVED') as unresolved, count(*) filter (where status = 'INVALID') as invalid,
      count(cur_ret) as observed, coalesce(sum(cur_pnl), 0) as pnl, avg(cur_ret) as avg_ret, percentile_cont(0.5) within group (order by cur_ret) as med_ret,
      count(*) filter (where is_settled) as n_settled, count(*) filter (where is_settled and cur_pnl > 0) as wins, count(*) filter (where is_settled and cur_pnl < 0) as losses,
      avg(cur_ret) filter (where is_settled and cur_pnl > 0) as avg_win, avg(cur_ret) filter (where is_settled and cur_pnl < 0) as avg_loss,
      max(wallet_name) as name, max(size_usd) as size_usd
    from keyed where k is not null group by k),
  bw as (select distinct on (k) k, signal_id, cur_ret, title from keyed where k is not null and cur_ret is not null order by k, cur_ret desc, signal_id),
  ww as (select distinct on (k) k, signal_id, cur_ret, title from keyed where k is not null and cur_ret is not null order by k, cur_ret asc, signal_id)
  select coalesce(jsonb_agg(jsonb_build_object('key', g.k, 'name', g.name, 'sizeUsd', g.size_usd, 'stats', jsonb_build_object(
      'signals', g.signals, 'open', g.open, 'resolved', g.resolved, 'exited', g.exited, 'unresolved', g.unresolved, 'invalid', g.invalid, 'observed', g.observed,
      'pnl', g.pnl, 'avgReturn', g.avg_ret, 'medianReturn', g.med_ret,
      'winRate', case when g.n_settled = 0 then null else g.wins::numeric / g.n_settled end, 'lossRate', case when g.n_settled = 0 then null else g.losses::numeric / g.n_settled end,
      'avgWin', g.avg_win, 'avgLoss', g.avg_loss,
      'best', case when bw.signal_id is null then null else jsonb_build_object('id', bw.signal_id, 'ret', bw.cur_ret, 'title', bw.title) end,
      'worst', case when ww.signal_id is null then null else jsonb_build_object('id', ww.signal_id, 'ret', ww.cur_ret, 'title', ww.title) end,
      'insufficient', g.observed < 10)) order by g.signals desc, g.k), '[]')
  from g left join bw on bw.k = g.k left join ww on ww.k = g.k;
$$;

-- Data-quality report (not performance).
create or replace function data_quality_report() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'signals', (select count(*) from signals),
    'latencyObserved', (select count(*) from paper_executions where mode = 'REALISTIC' and latency_source = 'OBSERVED'),
    'latencyEstimated', (select count(*) from paper_executions where mode = 'REALISTIC' and latency_source = 'ESTIMATED'),
    'prices', (select coalesce(jsonb_object_agg(state, n), '{}') from (select state, count(*) n from price_observations group by state) s),
    'marks', (select coalesce(jsonb_object_agg(horizon, n), '{}') from (select horizon, count(*) n from paper_marks group by horizon) s),
    'positions', jsonb_build_object('open', (select count(*) from paper_ledger where status = 'OPEN'), 'resolved', (select count(*) from paper_ledger where status in ('RESOLVED_WIN','RESOLVED_LOSS')),
      'exited', (select count(*) from paper_ledger where status = 'EXITED'), 'unresolved', (select count(*) from paper_ledger where status = 'UNRESOLVED'), 'invalid', (select count(*) from paper_ledger where status = 'INVALID'),
      'checkedByMarker', (select count(*) from paper_ledger where status = 'OPEN' and mark_checked_at is not null)),
    'fees', jsonb_build_object('marketsWithFlag', (select count(*) from markets where fees_enabled is not null), 'marketsWithoutFlag', (select count(*) from markets where fees_enabled is null),
      'signalMarketsWithoutMetadata', (select count(distinct s.condition_id) from signals s left join markets m on m.condition_id = lower(s.condition_id) where m.condition_id is null)),
    'bots', (select coalesce(jsonb_object_agg(coalesce(bot_class, 'NOT_MEASURED'), n), '{}') from (select bot_class, count(*) n from wallets where tracked group by bot_class) b),
    'simulation', (select coalesce(jsonb_object_agg(mode, cov), '{}') from (select mode, jsonb_object_agg(coverage_state, n) cov from (select mode, coalesce(coverage_state, 'UNKNOWN') coverage_state, count(*) n from paper_executions group by 1, 2) x group by mode) y));
$$;

revoke all on function claim_price_backlog(int) from public, anon, authenticated;
grant execute on function claim_price_backlog(int) to service_role;
