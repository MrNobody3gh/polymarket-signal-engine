/** Memory benchmark: peak heap ABOVE the in-memory test database, old "load everything" vs new batched sweep.
 *  node --expose-gc --import tsx scripts/mem-bench.ts */
import { stressDb } from "../tests/helpers/stressDb";
import { sweepSimulation, buildSignals, simulateMode, type SimInputs } from "../src/lib/paper/sim/run";
import { MODES } from "../src/lib/paper/sim/config";
const gc = (globalThis as any).gc as () => void; const T0 = 1_790_000_000; const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const heap = () => process.memoryUsage().heapUsed / 1048576;
function populate(db: ReturnType<typeof stressDb>, n: number) { for (let i = 1; i <= n; i++) { const id = uid(i); const tok = `tok${i % Math.max(1, Math.floor(n / 20))}`; const at = new Date((T0 + i * 7) * 1000).toISOString();
  db.insertRow("signals", { id, kind: "NEW_POSITION", wallet: `w${i % 150}`, condition_id: `c${tok}`, token_id: tok, price: 0.4, usd: 900, created_at: at, evaluated_at: new Date((T0 + i * 7 + 90) * 1000).toISOString() });
  db.insertRow("paper_ledger", { signal_id: id, created_at: at, sim_terminal: false, side: "LONG" }); } }
(async () => {
  for (const n of [10_000, 50_000, 100_000]) {
    // OLD: everything in memory at once (what the pre-2.5 runner did)
    let db = stressDb({ slimExecutions: true }); populate(db, n); gc(); let base = heap(); let peak = base;
    const inp: SimInputs = { signals: db.T("signals"), ledger: new Map(db.T("paper_ledger").map((r) => [r.signal_id, r])), marks: new Map(), resolutions: new Map(), markets: new Map(), obs: new Map() };
    const outs = [MODES.IDEAL, MODES.REALISTIC, MODES.CONSERVATIVE].map((m) => simulateMode(buildSignals(inp), inp, m)); peak = Math.max(peak, heap()); const oldDelta = peak - base; void outs;
    // NEW: batched sweep
    db = stressDb({ slimExecutions: true }); populate(db, n); gc(); base = heap(); peak = base;
    let live = 0; const liveBase = heap(); await sweepSimulation(db as never, { onBatch: () => { peak = Math.max(peak, heap()); gc(); live = Math.max(live, heap() - liveBase); } });
    gc(); const after = heap(); // what the sweep WROTE lives in the (in-memory) database; the working set is the transient part
    const newDelta = peak - after; const liveGrowth = live; console.log(`          (database grew by ${(after - base).toFixed(0)} MB of written records — in production that is Postgres, not the worker)`);
    console.log(`${String(n).padStart(7)} signals | old working set: ${oldDelta.toFixed(0).padStart(4)} MB | new: live heap growth across the sweep incl. rows written ${liveGrowth.toFixed(0)} MB, per-batch garbage ≤ ${newDelta.toFixed(0)} MB`);
  }
})();
