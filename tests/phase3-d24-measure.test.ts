/**
 * Synthetic measurement for the D24 / D26 report (not part of the normal suite: skipped unless D24_MEASURE_OUT is set).
 *
 *   D24_MEASURE_OUT=/tmp/after.json npx vitest run tests/phase3-d24-measure.test.ts
 *
 * Runs the 16 random live worlds of tests/phase3-stale-hash.test.ts (8 seeds × the tight and roomy limits; production order and
 * cadence: price backlog → sweep → the three portfolio runs every 15 minutes) and writes, per world: what the audit finds at the end,
 * how many runs rewound and how far, rows read and written, and every decision / lot / equity row without the two columns that D24 is
 * allowed to change (`input_hash` and the `record_hash` that covers it). Run the same file on the commit before D24 and on the commit
 * with it, then diff the two JSON files: `outputs` must be identical, `differences` and `rewinds` fewer or equal.
 * (Before D24 this file needs the import of `changeDetectionReadsFrom` in tests/helpers/liveWorld.ts replaced by `(x) => x`.)
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { ROOMY, TIGHT, audit, installClock, world, type Db } from "./helpers/liveWorld";

installClock();
const OUT = process.env.D24_MEASURE_OUT; const d = OUT ? describe : describe.skip;
const rows = (db: Db, t: string) => db.T(t).map(({ computed_at: _c, record_hash: _r, input_hash: _i, ...r }: Record<string, any>) => r).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

d("D24 measurement (synthetic worlds only)", () => {
  it("writes the measurement", async () => {
    const out: Record<string, unknown>[] = [];
    for (const [name, pc] of [["tight", TIGHT], ["roomy", ROOMY]] as const) for (let seed = 1; seed <= 8; seed++) {
      const w = await world(seed, pc, 30);
      let checked = 0, differences = 0; const byClass = { d13: 0, nextRun: 0, unexplained: 0 }; let neverOpened = 0;
      for (const r of await audit(w.db, pc)) { checked += r.checked; differences += r.mismatches; for (const k of ["d13", "nextRun", "unexplained"] as const) byClass[k] += r.classes[k].count; }
      // decisions that never opened a lot and differ (by the whole hash, what the audit reported before D24): the stored hash against the fresh one is not available here; count the ones whose exit / resolution part is not the plain "-@-"
      for (const x of w.db.T("portfolio_decisions")) if (Number(x.filled_shares) <= 0) neverOpened++;
      out.push({ world: `${name}#${seed}`, checked, differences, byClass, neverOpened, runStats: w.runStats, outputs: { decisions: rows(w.db, "portfolio_decisions"), lots: rows(w.db, "portfolio_lots"), equity: rows(w.db, "portfolio_equity") } });
    }
    writeFileSync(OUT!, JSON.stringify(out));
    expect(out.length).toBe(16);
  }, 600_000);
});
