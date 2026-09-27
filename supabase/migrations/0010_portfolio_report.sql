-- Phase 3 step 7: the portfolio report (docs/PHASE3_PLAN.md §J step 7). Additive; safe to run more than once.
-- One read-only function. Aggregation happens here so the worker never loads a portfolio's history into memory.
-- src/lib/paper/portfolio/report.ts holds a pure JS reference with the identical output shape (parity-tested).
--
-- Rules the numbers follow:
--  - Everything is "as of the watermark" (portfolio_runs.last_watermark_ts, the last second the runner fully decided):
--    rows timestamped after it are ignored (decisions by event_ts, lots by opened_ts, equity by ts, marks by observed_at).
--  - Two bases, never mixed (plan B8 / R8): cost basis (cash + open lots at cost) and, separately, market value (open
--    lots at their latest 1h/6h/24h mark observed between the lot's fill and the watermark; unmarked lots at cost, and
--    counted).
--  - Cash is derived from the lots: start − Σ(cost + entry fee) + Σ(exit proceeds − exit fee) + Σ resolution proceeds.
--  - Measured results only; samples under 10 settled lots are flagged `insufficient`.
--  - All times are epoch seconds; asOf also carries an ISO string for display. Text ties sort by code unit (C collation).

-- Execution rows of a mode still ahead of a portfolio's watermark. Planned with the actual values on every call (EXECUTE
-- ... USING), so the (mode, fill_ts) range is estimated from statistics and read through paper_executions_mode_fill_idx.
-- (Inside a SQL function the values are unknown at planning time and the planner assumes a third of the table.)
create or replace function portfolio_pending_ahead(p_mode text, p_after timestamptz) returns bigint language plpgsql stable as $$
declare n bigint;
begin
  execute 'select count(*) from paper_executions where mode = $1 and fill_ts > $2' into n using p_mode, p_after;
  return n;
end $$;

create or replace function portfolio_report(p_portfolio_id text) returns jsonb language sql stable as $$
  with p as (select * from portfolios where id = p_portfolio_id),
  r as (select * from portfolio_runs where portfolio_id = p_portfolio_id),
  a as (select (select last_watermark_ts from r) as as_of, (p.config->>'startingCapitalUsd')::numeric as cap0,
               coalesce((p.config->>'minCashReserveUsd')::numeric, 0) as reserve from p),
  d as (select * from portfolio_decisions where portfolio_id = p_portfolio_id and event_ts <= (select as_of from a)),
  l as (select lt.*, d.kind, lt.state in ('OPEN','PARTIALLY_EXITED') as is_open, lt.state in ('EXITED','RESOLVED') as is_settled
          from portfolio_lots lt left join d on d.signal_id = lt.signal_id
         where lt.portfolio_id = p_portfolio_id and lt.opened_ts <= (select as_of from a)),
  lo as (select * from l where is_open),
  ls as (select * from l where is_settled),
  om as (select lo.signal_id, lo.shares_open, lo.cost_open, m.price
           from lo left join lateral (
             select pm.price from paper_marks pm
              where pm.signal_id = lo.signal_id and pm.horizon in ('1h','6h','24h')
                and pm.observed_at >= lo.opened_ts and pm.observed_at <= (select as_of from a)
              order by pm.observed_at desc, pm.horizon collate "C" desc limit 1) m on true),
  cash as (select (select cap0 from a) - coalesce(sum(cost_usd + entry_fee), 0) + coalesce(sum(coalesce(exit_proceeds, 0) - coalesce(exit_fee, 0)), 0)
                  + coalesce(sum(coalesce(resolution_proceeds, 0)), 0) as v from l),
  inv as (select coalesce(sum(cost_open), 0) as v from lo),
  e as (select ts, seq, equity from portfolio_equity where portfolio_id = p_portfolio_id and ts <= (select as_of from a)),
  ep as (select ts, seq, equity, greatest((select cap0 from a), max(equity) over (order by ts, seq rows unbounded preceding)) as peak from e),
  rk as (select realized_pnl as net, row_number() over (order by realized_pnl desc) as rk from ls),
  kinds as (select k from (values ('NEW_POSITION'), ('CONSENSUS'), ('CONVICTION_ADD'), ('EARLY_ENTRY')) v(k)),
  ex as (select portfolio_pending_ahead(p.mode, coalesce(a.as_of, p.start_ts - interval '1 second')) as n from p, a)
  select jsonb_build_object(
    'portfolio', jsonb_build_object('id', p.id, 'mode', p.mode, 'startTs', extract(epoch from p.start_ts), 'config', p.config,
      'nonCausalBaseline', p.mode = 'IDEAL', 'label', case when p.mode = 'IDEAL' then p.config->>'note' end),
    'asOf', jsonb_build_object('basis', 'watermark', 'ts', extract(epoch from a.as_of),
      'iso', to_char(a.as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'lastRunFinishedAt', extract(epoch from (select last_run_finished_at from r)), 'frontier', (select stats->'frontier' from r),
      'generatedAt', extract(epoch from now())),
    'capital', jsonb_build_object('startingCapital', a.cap0, 'cash', (select v from cash), 'investedAtCost', (select v from inv),
      'equityAtCost', (select v from cash) + (select v from inv),
      'utilisation', (select v from inv) / nullif((select v from cash) + (select v from inv), 0),
      'minCashReserve', a.reserve, 'availableCash', greatest(0, (select v from cash) - a.reserve)),
    'pnl', (select jsonb_build_object('basis', 'cost', 'realized', coalesce(sum(realized_pnl), 0),
        'entryFees', coalesce(sum(entry_fee), 0), 'exitFees', coalesce(sum(coalesce(exit_fee, 0)), 0),
        'gross', coalesce(sum(realized_pnl), 0) + coalesce(sum(entry_fee), 0) + coalesce(sum(coalesce(exit_fee, 0)), 0),
        'returnPct', coalesce(sum(realized_pnl), 0) / nullif(a.cap0, 0),
        'marketValue', (select jsonb_build_object('basis', 'marks',
            'unrealisedAtMarks', coalesce(sum(price * shares_open - cost_open) filter (where price is not null), 0),
            'equityAtMarks', (select v from cash) + coalesce(sum(price * shares_open) filter (where price is not null), 0) + coalesce(sum(cost_open) filter (where price is null), 0),
            'lotsWithoutMark', jsonb_build_object('count', count(*) filter (where price is null), 'cost', coalesce(sum(cost_open) filter (where price is null), 0)))
          from om)) from l),
    'risk', (select jsonb_build_object('basis', 'cost', 'points', count(*), 'peakEquity', coalesce(max(peak), a.cap0),
        'maxDrawdown', coalesce(max(peak - equity), 0), 'maxDrawdownPct', coalesce(max((peak - equity) / nullif(peak, 0)), 0),
        'endingEquity', coalesce((select equity from ep order by ts desc, seq desc limit 1), a.cap0),
        'thinnedBefore', ((select stats->>'equityDownsampledTo' from r))::numeric,
        'note', 'points older than 7 days are thinned to the last point per hour, so drawdown before thinnedBefore is measured on hourly points')
      from ep),
    'decisions', (select jsonb_build_object('total', count(*),
        'byOutcome', jsonb_build_object('FILLED', count(*) filter (where outcome = 'FILLED'), 'PARTIALLY_FILLED', count(*) filter (where outcome = 'PARTIALLY_FILLED'),
          'UNFILLED', count(*) filter (where outcome = 'UNFILLED'), 'EXPIRED', count(*) filter (where outcome = 'EXPIRED'), 'INVALID', count(*) filter (where outcome = 'INVALID'),
          'UNKNOWN', count(*) filter (where outcome = 'UNKNOWN'), 'REJECTED', count(*) filter (where outcome = 'REJECTED')),
        'rejectionsByReason', coalesce((select jsonb_object_agg(reason, n) from (select reason, count(*) n from d where outcome = 'REJECTED' and reason <> 'REJECTED_DUPLICATE_POSITION' group by reason) x), '{}'),
        'duplicates', count(*) filter (where outcome = 'REJECTED' and reason = 'REJECTED_DUPLICATE_POSITION'),
        'requestedUsd', coalesce(sum(requested_usd), 0), 'filledUsd', coalesce(sum(filled_usd), 0),
        'fillRate', (count(*) filter (where outcome in ('FILLED','PARTIALLY_FILLED')))::numeric
                    / nullif(count(*) filter (where outcome <> 'UNKNOWN' and not (outcome = 'REJECTED' and reason = 'REJECTED_DUPLICATE_POSITION')), 0),
        'fillRateBasis', 'fills / decisions, excluding UNKNOWN (no price data) and REJECTED_DUPLICATE_POSITION (same source fill, plan D1)',
        'resized', count(*) filter (where resized),
        'duplicatesNote', 'REJECTED_DUPLICATE_POSITION is the same source fill seen by two signals (plan D1), not a risk limit')
      from d),
    'byKind', (select jsonb_object_agg(k, (select jsonb_build_object(
          'requests', (select count(*) from d where d.kind = kinds.k),
          'fills', (select count(*) from d where d.kind = kinds.k and outcome in ('FILLED','PARTIALLY_FILLED')),
          'rejections', coalesce((select jsonb_object_agg(reason, n) from (select reason, count(*) n from d where d.kind = kinds.k and outcome = 'REJECTED' group by reason) x), '{}'),
          'lotsOpened', count(*), 'openLots', count(*) filter (where is_open), 'settledLots', count(*) filter (where is_settled),
          'realizedPnl', coalesce(sum(realized_pnl), 0), 'fees', coalesce(sum(entry_fee + coalesce(exit_fee, 0)), 0),
          'winRate', (count(*) filter (where is_settled and realized_pnl > 0))::numeric / nullif(count(*) filter (where is_settled), 0),
          'insufficient', count(*) filter (where is_settled) < 10) from l where l.kind = kinds.k)) from kinds),
    'byKindNote', 'CONSENSUS is under-attributed: when it shares a source fill with NEW_POSITION the lot is credited to NEW_POSITION (plan D1)',
    'exposure', jsonb_build_object('openLots', (select count(*) from lo), 'investedAtCost', (select v from inv),
      'topMarkets', (select coalesce(jsonb_agg(jsonb_build_object('conditionId', g, 'lots', n, 'cost', c, 'share', c / nullif((select v from inv), 0)) order by c desc, g collate "C"), '[]')
          from (select condition_id as g, count(*) n, sum(cost_open) c from lo group by condition_id order by sum(cost_open) desc, condition_id collate "C" limit 10) x),
      'topWallets', (select coalesce(jsonb_agg(jsonb_build_object('wallet', g, 'lots', n, 'cost', c, 'share', c / nullif((select v from inv), 0)) order by c desc, g collate "C"), '[]')
          from (select wallet as g, count(*) n, sum(cost_open) c from lo group by wallet order by sum(cost_open) desc, wallet collate "C" limit 10) x)),
    'lots', (select jsonb_build_object('total', count(*),
        'byState', jsonb_build_object('OPEN', count(*) filter (where state = 'OPEN'), 'PARTIALLY_EXITED', count(*) filter (where state = 'PARTIALLY_EXITED'),
          'EXITED', count(*) filter (where state = 'EXITED'), 'RESOLVED', count(*) filter (where state = 'RESOLVED')),
        'closedByExit', count(*) filter (where state = 'EXITED'), 'closedByResolution', count(*) filter (where state = 'RESOLVED'),
        'medianHoldingSec', percentile_cont(0.5) within group (order by extract(epoch from closed_ts - opened_ts)) filter (where is_settled),
        'lockedUnresolved', (select jsonb_build_object('count', count(*), 'cost', coalesce(sum(cost_open), 0), 'oldestOpenedTs', extract(epoch from min(opened_ts)),
            'rule', 'open lots opened 30 days or more before asOf with no resolution; derived here, portfolio_lots.locked_unresolved is not maintained (D11)')
          from lo where lo.resolution_ts is null and lo.opened_ts <= a.as_of - interval '30 days'))
      from l),
    'robustness', (select jsonb_build_object('basis', 'settled lots, net of fees', 'settled', (select count(*) from ls),
        'total', coalesce(sum(net), 0),
        'exBest1', coalesce(sum(net), 0) - coalesce(sum(net) filter (where rk <= 1 and net > 0), 0),
        'exBest3', coalesce(sum(net), 0) - coalesce(sum(net) filter (where rk <= 3 and net > 0), 0),
        'exBest5', coalesce(sum(net), 0) - coalesce(sum(net) filter (where rk <= 5 and net > 0), 0),
        'exBest10', coalesce(sum(net), 0) - coalesce(sum(net) filter (where rk <= 10 and net > 0), 0),
        'profitFactor', case when coalesce(sum(net) filter (where net < 0), 0) = 0 then null else coalesce(sum(net) filter (where net > 0), 0) / -sum(net) filter (where net < 0) end,
        'expectancy', avg(net), 'largestWin', max(net) filter (where net > 0), 'largestLoss', min(net) filter (where net < 0),
        'medianReturn', (select percentile_cont(0.5) within group (order by realized_pnl / cost_usd) from ls),
        'insufficient', count(*) < 10)
      from rk),
    'health', jsonb_build_object('lastRunStartedAt', extract(epoch from (select last_run_started_at from r)),
      'lastRunFinishedAt', extract(epoch from (select last_run_finished_at from r)),
      'lease', jsonb_build_object('owner', (select lease_owner from r), 'until', extract(epoch from (select lease_until from r)), 'held', coalesce((select lease_until > now() from r), false)),
      'lastRewind', (select stats->'rewind' from r), 'rowsRead', (select (stats->>'rowsRead')::numeric from r),
      'staleRows', coalesce((select (stats->>'staleRows')::numeric from r), 0),
      'pendingAhead', (select n from ex),
      'warnings', to_jsonb(array_remove(array[
        case when a.as_of is null then 'no run has finished yet: nothing is decided' end,
        case when coalesce((select (stats->>'staleRows')::numeric from r), 0) > 0 then
          (select (stats->>'staleRows') from r) || ' execution row(s) were skipped in the last run because their stored fill time no longer matched their inputs; they are decided once the sweep recomputes them' end
      ], null)))
  )
  from p, a;
$$;
