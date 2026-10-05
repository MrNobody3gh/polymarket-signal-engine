/**
 * `npm run phase4:shadow-report` — Phase 4.1 Part B (see src/lib/phase4/shadow/report-cli.ts). Read-only: the database through a select-only wrapper, no network.
 * Prints at most 60 lines; details go to files (`--print-files` returns them on a log-only host). Exit: 0 finished, 1 failed, 2 configuration.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runShadowReportCli } from "../../src/lib/phase4/shadow/report-cli";

runShadowReportCli(process.argv.slice(2), process.env, {
  writeFile: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
}).then((code) => { process.exitCode = code; }).catch((e) => { console.error(`shadow-report failed: ${(e as Error).message}`); process.exitCode = 1; });
