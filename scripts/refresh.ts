/** `npm run refresh` — run the daily cohort refresh from your machine. Add `--seed` to load config/watchlist.json first. */
import { db } from "../src/lib/db";
import { refresh, seedFromSnapshot } from "../src/lib/scoring/refresh";
import snapshot from "../config/watchlist.json";
(async () => {
  if (process.argv.includes("--seed")) console.log("seeded", await seedFromSnapshot(db(), snapshot));
  else console.log(await refresh(db()));
})().catch((e) => { console.error(e); process.exit(1); });
