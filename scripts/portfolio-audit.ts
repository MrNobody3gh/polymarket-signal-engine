/**
 * `npm run portfolio:audit` — the read-only D13 fingerprint audit (docs/PORTFOLIO.md, "Switch-on runbook").
 *
 * Needs the worker's exact variables: PAPER_PORTFOLIO_CONFIG (and PAPER_SIZE_USD if the worker sets it, since it is part
 * of every portfolio id), NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. The simplest way is
 *   railway run npm run portfolio:audit
 * Writes nothing. Exit code: 0 clean · 1 unexplained differences or missing rows · 2 configuration unset or invalid
 * (the database is not touched) · 3 inconclusive (a run was in progress; run it again between cycles).
 */
import { db } from "../src/lib/db";
import { runAuditCli } from "../src/lib/paper/portfolio/audit";

runAuditCli(process.env, { db }).then((code) => { process.exitCode = code; }).catch((e) => { console.error(`portfolio audit failed: ${(e as Error).message}`); process.exitCode = 1; });
