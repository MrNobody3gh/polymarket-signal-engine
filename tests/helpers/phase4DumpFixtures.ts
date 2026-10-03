/** Regenerates tests/fixtures/phase4/synthetic_*.json from tests/helpers/phase4World.ts:  npx tsx tests/helpers/phase4DumpFixtures.ts */
import { writeFileSync } from "node:fs";
import { buildWorld } from "./phase4World";
const w = buildWorld(4);
const dir = "tests/fixtures/phase4";
writeFileSync(`${dir}/synthetic_gamma_markets.json`, JSON.stringify(w.gamma, null, 1) + "\n");
writeFileSync(`${dir}/synthetic_us_markets.json`, JSON.stringify(w.us, null, 1) + "\n");
writeFileSync(`${dir}/synthetic_expected.json`, JSON.stringify(w.expected, null, 1) + "\n");
console.log(`gamma ${w.gamma.length} us ${w.us.length} pairs ${w.expected.matchedPairs.length}`);
