-- Phase 4.1: shadow order-book measurement (docs/phase4/SHADOW_BOOKS.md). Additive; safe to run more than once.
-- One new table, nothing else: no existing table, column, function or policy is changed. The worker writes it only when
-- SHADOW_BOOKS=1 (default off). It holds PUBLIC order-book snapshots of the token behind each entry signal; no key,
-- account or order is involved. Service role only: no policy, and no grant to anon or authenticated.
-- Rollback: `drop table if exists shadow_books;` (nothing depends on it).

create table if not exists shadow_books (
  signal_id      uuid        not null references signals(id) on delete cascade,
  offset_s       int         not null check (offset_s between 0 and 3600),   -- seconds after signals.created_at (D106: 0 / 60 / 300)
  due_at         timestamptz not null,                                        -- signals.created_at + offset_s
  taken_at       timestamptz not null,                                        -- when the snapshot was taken (or, for MISSED, decided)
  token_id       text        not null,
  side           text        not null default 'BUY' check (side = 'BUY'),     -- the hypothetical order is always a taker BUY of the signal's token
  source_price   numeric     check (source_price is null or (source_price > 0 and source_price < 1)),  -- the wallet's fill price
  best_bid       numeric     check (best_bid is null or (best_bid >= 0 and best_bid <= 1)),
  best_ask       numeric     check (best_ask is null or (best_ask >= 0 and best_ask <= 1)),
  spread         numeric,                                                      -- best_ask - best_bid, in price units (0.01 = 1 point)
  mid            numeric,
  bids           jsonb,                                                        -- top 10 levels [[price, size], ...], best first
  asks           jsonb,
  fills          jsonb,                                                        -- hypothetical taker buys at $10 / $25 / $100 (see shadow/fill.ts)
  fee_rate_bps   numeric     check (fee_rate_bps is null or fee_rate_bps >= 0),
  fee_source     text        check (fee_source is null or fee_source in ('NONE','OBSERVED_FEE_FREE','OBSERVED_RATE','ASSUMED_RATE','ASSUMED_UNKNOWN')),
  status         text        not null check (status in ('OK','EMPTY_BOOK','ONE_SIDED','CROSSED','NOT_FOUND','ERROR','REFUSED','MISSED')),
  http_status    int,
  latency_ms     int         check (latency_ms is null or latency_ms >= 0),
  request_count  int         not null default 0 check (request_count >= 0),
  schema_version int         not null default 1,                               -- version of the offsets / sizes / depth constants (D106)
  primary key (signal_id, offset_s),
  constraint shadow_books_ok_has_two_sides check (status <> 'OK' or (best_bid is not null and best_ask is not null and best_bid <= best_ask)),
  constraint shadow_books_missed_has_no_data check (status <> 'MISSED' or (bids is null and asks is null and fills is null and best_bid is null and best_ask is null and request_count = 0))
);

create index if not exists shadow_books_due_idx   on shadow_books (due_at);    -- retention pruning, report windows
create index if not exists shadow_books_taken_idx on shadow_books (taken_at);  -- the daily request budget

alter table shadow_books enable row level security;                            -- service role only: no policy
revoke all on table shadow_books from public, anon, authenticated;
grant select, insert, delete on table shadow_books to service_role;            -- the job inserts and prunes; it never updates
