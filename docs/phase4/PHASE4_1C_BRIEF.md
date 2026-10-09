# Phase 4.1c brief (for Claude Code): stop the shadow recorder after an access refusal

**Goal.** In `src/lib/phase4/shadow/job.ts` (and `schedule.ts` as needed), when a book request returns 401, 403 or 451, record one `REFUSED` row, log one line, and **stop all further requests until the process restarts**. Today the job pauses, doubles the pause and retries up to hourly. 429 and 5xx keep the current backoff.

**Rules.**
- Scope: shadow module only. Do not touch the migration, the worker hook, alerts, scoring, paper results or `http.ts` defaults.
- The stop is per process: a restart clears it. No persistent flag, no new table or column.
- The stop must hold across timer ticks, across offsets, and for the signals already queued.
- A clear single log line and a heartbeat marker (`last_shadow_books` shows the stopped state) so the operator can see it. Telegram alert only through the existing alert path, once.
- `docs/phase4/SHADOW_BOOKS.md`: replace the refusal section; record as D112 follow-up.

**Tests and checks.** Unit tests for 401, 403, 451 (stop), 429 and 500 (unchanged backoff), several ticks after the stop (zero requests), a restart (resumes). Real-Postgres test unchanged. Add mutations (ids `s4X…`) for: the stop ignored, 429 treated as a stop, the stop not covering queued signals, and the stop cleared by a later tick. Full suite, `tsc`, build, secret scan, `npm run phase4:mutations -- <new ids>`. Patch only; the reviewer pushes.
