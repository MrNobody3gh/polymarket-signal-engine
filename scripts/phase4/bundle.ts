/**
 * `npm run phase4:bundle` — Phase 4.0e Part D (see src/lib/phase4/bundle.ts). No network, no database. Exit: 0 finished, 2 refused or bad input.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runBundleCli } from "../../src/lib/phase4/bundle";

runBundleCli(process.argv.slice(2), {
  listFiles: (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).sort() : []),
  readBinary: (p) => (existsSync(p) ? new Uint8Array(readFileSync(p)) : null),
}).then((code) => { process.exitCode = code; }).catch((e) => { console.error(`bundle failed: ${(e as Error).message}`); process.exitCode = 1; });
