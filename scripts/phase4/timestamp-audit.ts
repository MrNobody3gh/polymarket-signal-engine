/**
 * `npm run phase4:ts-audit` — Phase 4.0 S1a timestamp audit (docs/PHASE4_PLAN.md §7 S1a, §3.3). READ-ONLY.
 * Public, unauthenticated GETs only (≤ 2 requests/s); no orders, keys or accounts. Needs no secret unless `--with-db`
 * (then NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, select only). Prints ≤ 60 lines; details go to files.
 * Exit: 0 finished (possibly partial), 1 failed, 2 database variables missing for --with-db.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runTimestampAuditCli } from "../../src/lib/phase4/cli";

runTimestampAuditCli(process.argv.slice(2), process.env, {
  writeFile: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
  mkdir: (d) => mkdirSync(d, { recursive: true }),
}).then((code) => { process.exitCode = code; }).catch((e) => { console.error(`timestamp audit failed: ${(e as Error).message}`); process.exitCode = 1; });
