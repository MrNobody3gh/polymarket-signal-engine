/**
 * `npm run phase4:coverage` — Phase 4.0 S1b coverage probe and feasibility (docs/PHASE4_PLAN.md §7 S1b, §3.2, §3.6, D48/D52/D53).
 * READ-ONLY: the database through select only (needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, as
 * scripts/portfolio-audit.ts), the execution venue through public GETs (≤ 2 requests/s). Writes nothing to any table.
 * Prints ≤ 60 lines; details go to docs/phase4/data (or --out-dir).
 * Exit: 0 finished (possibly partial), 1 failed, 2 database variables missing (the database is not touched).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runCoverageCli } from "../../src/lib/phase4/cli";

runCoverageCli(process.argv.slice(2), process.env, {
  writeFile: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
}).then((code) => { process.exitCode = code; }).catch((e) => { console.error(`coverage probe failed: ${(e as Error).message}`); process.exitCode = 1; });
