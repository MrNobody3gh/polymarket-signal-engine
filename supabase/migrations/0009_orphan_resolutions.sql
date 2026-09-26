-- Phase 3 step 3 (D3): find and resolve tokens the marker no longer watches. Additive; safe to run more than once.
-- The marker settles paper_ledger rows that are OPEN. When every ledger row on a token is EXITED / INVALID (or, for
-- signals from 18–20 Sep, missing), no process ever asks whether that market resolved, yet simulated positions (and,
-- from Phase 3, portfolio lots) can still hold shares on it. src/lib/paper/resolve-orphans.ts asks, and writes the
-- answer to token_resolution_obs (0008), which the token_resolutions view already unions in.

-- One row per token the resolver has asked about: round-robin order and re-check spacing.
create table if not exists token_resolution_checks (
  token_id        text primary key,
  condition_id    text not null,
  last_checked_at timestamptz not null,
  last_state      text not null check (last_state in ('OPEN','UNKNOWN','NO_RESOLVED_TIME','RESOLVED')),
  last_reason     text,
  checks          int not null default 1 check (checks >= 1)
);
alter table token_resolution_checks enable row level security; -- service role only (no policy)

-- Keeps the candidate scan proportional to open simulated positions, not to all executions.
create index if not exists paper_executions_open_sim_idx on paper_executions (signal_id)
  where coverage_state = 'SIMULATED' and state in ('OPEN','PARTIALLY_EXITED');

-- Tokens held by an open simulated position (any mode) or an open portfolio lot that have no known resolution, no OPEN
-- ledger row (those the marker covers), and were not checked in the last p_recheck_sec. Least recently checked first.
-- frozen_lots counts positions with no ledger row at all: the sweep never recomputes those, so resolving their token
-- records the fact but does not change their stored result.
create or replace function orphan_resolution_candidates(p_limit int, p_recheck_sec int default 21600)
returns table (token_id text, condition_id text, outcome text, open_lots bigint, frozen_lots bigint, oldest_fill_ts timestamptz, last_checked_at timestamptz)
language sql stable as $$
  with held as (
    select s.token_id, lower(s.condition_id) as condition_id, s.outcome, e.fill_ts, (l.signal_id is null) as frozen
      from paper_executions e
      join signals s on s.id = e.signal_id
      left join paper_ledger l on l.signal_id = e.signal_id
     where e.coverage_state = 'SIMULATED' and e.state in ('OPEN','PARTIALLY_EXITED')
    union all
    select pl.token_id, lower(pl.condition_id), null, pl.opened_ts, false
      from portfolio_lots pl where pl.state in ('OPEN','PARTIALLY_EXITED')
  ), agg as (
    select h.token_id, min(h.condition_id) as condition_id, max(h.outcome) as outcome, count(*) as open_lots,
           count(*) filter (where h.frozen) as frozen_lots, min(h.fill_ts) as oldest_fill_ts
      from held h group by h.token_id
  )
  select a.token_id, a.condition_id, a.outcome, a.open_lots, a.frozen_lots, a.oldest_fill_ts, c.last_checked_at
    from agg a
    left join token_resolution_checks c on c.token_id = a.token_id
   where not exists (select 1 from token_resolutions r where r.token_id = a.token_id)
     and not exists (select 1 from paper_ledger p where p.token_id = a.token_id and p.status = 'OPEN')
     and (c.last_checked_at is null or c.last_checked_at <= now() - make_interval(secs => greatest(p_recheck_sec, 0)))
   order by c.last_checked_at nulls first, a.oldest_fill_ts, a.token_id
   limit greatest(0, least(coalesce(p_limit, 0), 1000));
$$;

revoke all on function orphan_resolution_candidates(int, int) from public, anon, authenticated;
grant execute on function orphan_resolution_candidates(int, int) to service_role;
