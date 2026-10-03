/**
 * `npm run phase4:title-search` — Phase 4.0c title search for every market+outcome pair behind our entry signals, on the US exchange (its documented
 * `GET /v1/search`) and on Kalshi (a lookup in its bounded listing). READ-ONLY: public unauthenticated GETs (≤ 2 requests/s; the US origin slower), a
 * select-only database wrapper, no orders, keys or accounts. Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (select only). Prints ≤ 60 lines;
 * the per-pair results are in docs/phase4/data/s1b_title_search_<venue>.csv. Exit: 0 finished (possibly partial), 1 failed, 2 configuration missing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runTitleSearchCli } from "../../src/lib/phase4/cli";

runTitleSearchCli(process.argv.slice(2), process.env, {
  writeFile: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
}).then((code) => { process.exitCode = code; }).catch((e) => { console.error(`title search failed: ${(e as Error).message}`); process.exitCode = 1; });
