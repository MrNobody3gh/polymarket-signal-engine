/**
 * `npm run phase4:bundle-decode` — Phase 4.0e Part D (see src/lib/phase4/bundle.ts). No network, no database. Exit: 0 finished, 2 refused or bad input.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runBundleDecodeCli } from "../../src/lib/phase4/bundle";

runBundleDecodeCli(process.argv.slice(2), {
  readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  writeBinary: (p, data) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); },
}).then((code) => { process.exitCode = code; }).catch((e) => { console.error(`bundle-decode failed: ${(e as Error).message}`); process.exitCode = 1; });
