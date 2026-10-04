/**
 * `npm run phase4:review-ingest` — Phase 4.0d (see src/lib/phase4/cli-review.ts for what it reads and writes and its usage line, `--help`).
 * Prints ≤ 60 lines; details go to files. Exit: 0 finished, 1 failed, 2 configuration or input error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runReviewIngestCli } from "../../src/lib/phase4/cli-review";

runReviewIngestCli(process.argv.slice(2), process.env, {
  writeFile: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
}).then((code) => { process.exitCode = code; }).catch((e) => { console.error(`review-ingest failed: ${(e as Error).message}`); process.exitCode = 1; });
