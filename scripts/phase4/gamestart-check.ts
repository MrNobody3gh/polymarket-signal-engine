/**
 * `npm run phase4:gamestart-check -- --venue polymarket_us` — Phase 4.0e (see src/lib/phase4/cli-gamestart.ts). Read-only public GETs; prints ≤ 60 lines; details go to files.
 * Exit: 0 finished, 1 failed, 2 configuration, 3 stopped by the heap budget.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runGamestartCli } from "../../src/lib/phase4/cli-gamestart";

runGamestartCli(process.argv.slice(2), process.env, {
  writeFile: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
}).then((code) => { process.exitCode = code; }).catch((e) => { console.error(`gamestart-check failed: ${(e as Error).message}`); process.exitCode = 1; });
