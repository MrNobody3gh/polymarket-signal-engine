-- Phase 3 step 8, decision D15: the portfolio report is for the worker only. Additive; safe to run more than once.
-- The dashboard reads the precomputed snapshot (cursors['paper:portfolio']), never these functions. Through the anon
-- key RLS hides portfolio_runs, so a browser call would get a report with no watermark; closing the functions to anon
-- and authenticated removes that half-answer. Same pattern as the lease functions in 0008. 0007's functions unchanged.

revoke all on function portfolio_report(text) from public, anon, authenticated;
revoke all on function portfolio_pending_ahead(text, timestamptz) from public, anon, authenticated;
grant execute on function portfolio_report(text) to service_role;
grant execute on function portfolio_pending_ahead(text, timestamptz) to service_role;
