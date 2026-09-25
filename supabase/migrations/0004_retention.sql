-- Retention: keep the database small and fast. Signals, paper ledger, marks and consensus events are permanent;
-- raw fills and closed positions are working data and expire.
create index if not exists fills_ts_brin on fills using brin (ts);

create or replace function prune_working_data(fill_days int default 7, closed_position_days int default 30, dq_days int default 14)
returns jsonb language plpgsql security definer set search_path = public as $$
declare f int; p int; d int;
begin
  delete from fills where ts < now() - make_interval(days => fill_days);
  get diagnostics f = row_count;
  delete from positions where size <= 0 and last_seen < now() - make_interval(days => closed_position_days);
  get diagnostics p = row_count;
  delete from data_quality_issues where created_at < now() - make_interval(days => dq_days);
  get diagnostics d = row_count;
  return jsonb_build_object('fills', f, 'positions', p, 'dq', d);
end $$;
revoke all on function prune_working_data(int, int, int) from public, anon, authenticated;
