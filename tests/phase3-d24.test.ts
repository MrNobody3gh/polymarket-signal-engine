/**
 * Decision D24 (analysis only, docs/PHASE3_D24_ANALYSIS.md): "for a decision that never opened a lot, the exit and resolution
 * parts of its fingerprint cannot affect it, so they could be left out of its input_hash".
 *
 * Nothing here implements D24. These tests check the CLAIM against the code as it is: the book's outcome for a signal that
 * never opens a lot (REJECTED, UNFILLED, EXPIRED, INVALID, UNKNOWN) is independent of that signal's own exit and
 * resolution, through duplicate detection, the per-wallet / per-market / total limits, the open-position cap, cash,
 * ordering and every outcome. The check is exhaustive in the way that matters: replace the exit and the resolution of
 * every such signal with other values, replay from scratch, and require decisions, lots, equity and totals to be identical.
 */
import { describe, it, expect } from "vitest";
import { MODES, type ModeName, type PortfolioConfig } from "@/lib/paper/sim/config";
import { PortfolioBook, cmpKey, entryKey } from "@/lib/paper/portfolio/book";
import type { BookSignal } from "@/lib/paper/portfolio/types";

const T0 = 1_790_000_000;
const PCS: Record<string, PortfolioConfig> = {
  roomy: { startingCapitalUsd: 100_000, positionUsd: 100, maxMarketExposureUsd: 10_000, maxTotalExposurePct: 100, maxOpenPositions: 1000, maxWalletAllocationUsd: 10_000, minCashReserveUsd: 0, allowResize: false },
  tight: { startingCapitalUsd: 1_000, positionUsd: 100, maxMarketExposureUsd: 150, maxTotalExposurePct: 60, maxOpenPositions: 8, maxWalletAllocationUsd: 250, minCashReserveUsd: 50, allowResize: false },
  exposureBound: { startingCapitalUsd: 2_000, positionUsd: 100, maxMarketExposureUsd: 10_000, maxTotalExposurePct: 30, maxOpenPositions: 100, maxWalletAllocationUsd: 10_000, minCashReserveUsd: 0, allowResize: false },
  cashBound: { startingCapitalUsd: 500, positionUsd: 100, maxMarketExposureUsd: 10_000, maxTotalExposurePct: 100, maxOpenPositions: 50, maxWalletAllocationUsd: 10_000, minCashReserveUsd: 120, allowResize: true },
  resize: { startingCapitalUsd: 1_000, positionUsd: 100, maxMarketExposureUsd: 150, maxTotalExposurePct: 60, maxOpenPositions: 8, maxWalletAllocationUsd: 250, minCashReserveUsd: 50, allowResize: true },
};
let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

/** Random history: bursts in one second, duplicate source trades (shared source key), exits, resolutions, marks, missing prices. */
function history(n: number): BookSignal[] {
  const out: BookSignal[] = [];
  for (let i = 0; i < n; i++) {
    const id = `s${String(i).padStart(5, "0")}`; const src = T0 + Math.floor(i / 3) * 40; const ev = src + (rnd() < 0.05 ? 4000 + Math.floor(rnd() * 3000) : 3 + Math.floor(rnd() * 60));   // a late evaluation: EXPIRED in CONSERVATIVE
    const price = 0.05 + rnd() * 0.9; const obs = rnd() < 0.08 ? null : { ts: ev - Math.floor(rnd() * 30), price: Math.min(0.99, Math.max(0.01, price + (rnd() - 0.5) * 0.05)), resolutionSeconds: 0 };
    const market = rnd() < 0.5 ? null : { feesEnabled: rnd() < 0.5, takerFeeRate: rnd() < 0.5 ? 0.02 : null, tickSize: 0.01, minOrderShares: rnd() < 0.2 ? 300 : 5 };
    const dup = i > 0 && rnd() < 0.12 ? out[i - 1] : null;
    const exit = randomExit(src, market);
    out.push({ signalId: id, kind: dup ? "CONSENSUS" : pick(["NEW_POSITION", "NEW_POSITION", "CONVICTION_ADD", "EARLY_ENTRY", "CONSENSUS"]), wallet: `w${Math.floor(rnd() * 6)}`, conditionId: `c${Math.floor(rnd() * 5)}`, tokenId: `t${i}`,
      sourceKey: dup ? dup.sourceKey : `k${i}`, exitId: exit ? `x${i}` : null,
      entry: dup ? { ...dup.entry } : { sourceTs: src, evalTs: ev, signalPrice: rnd() < 0.03 ? pick([0, 1, 1.3]) : price, sourceUsd: 50 + rnd() * 3000, obs, market },
      exit, resolution: randomResolution(src), mark: rnd() < 0.5 ? { ts: src + 3600, price: rnd() } : null });
  }
  return out;
}
function randomExit(src: number, market: BookSignal["entry"]["market"]): BookSignal["exit"] {
  if (rnd() < 0.4) return null;
  const xs = src + pick([-100, 0, 5, 30, 500, 4000, 40_000]);
  return { triggerTs: xs, triggerEvalTs: xs + pick([0, 5, 300]), triggerPrice: 0.05 + rnd() * 0.9, triggerUsd: rnd() < 0.3 ? 10 + rnd() * 40 : 500 + rnd() * 2000, obs: rnd() < 0.15 ? null : { ts: xs, price: 0.05 + rnd() * 0.9, resolutionSeconds: 0 }, market };
}
function randomResolution(src: number): BookSignal["resolution"] { return rnd() < 0.4 ? null : { ts: src + pick([-500, -50, 0, 300, 2000, 9000, 60_000]), value: pick([0, 1, 1, 0.5]) }; }

const ordered = (sigs: BookSignal[], exec: typeof MODES.IDEAL) => [...sigs].sort((a, b) => cmpKey(entryKey(a, exec), entryKey(b, exec)));
function replay(sigs: BookSignal[], exec: typeof MODES.IDEAL, pc: PortfolioConfig) {
  const book = new PortfolioBook(exec, pc); for (const s of ordered(sigs, exec)) book.submit(s); book.advance(null);
  return { out: book.take(), summary: book.summary(), state: book.snapshot() };
}
/** A lot is opened by any decision that filled shares (FILLED, PARTIALLY_FILLED, also a resized fill). */
const noLot = (out: ReturnType<typeof replay>["out"]) => new Set(out.decisions.filter((d) => d.filledShares <= 0).map((d) => d.signalId));

describe("D24 claim: a decision that never opened a lot does not depend on its own exit or resolution", () => {
  let checked = 0, perturbed = 0, lotDecisions = 0; const outcomes = new Set<string>(); const reasons = new Set<string>();
  for (const mode of ["IDEAL", "REALISTIC", "CONSERVATIVE"] as ModeName[]) for (const pcName of Object.keys(PCS)) {
    it(`${mode}, ${pcName} limits: replacing the exit and resolution of every no-lot signal changes nothing`, () => {
      seed = [...`d24/${mode}/${pcName}`].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 2 ** 31, 7);
      const exec = MODES[mode]; const pc = PCS[pcName];
      for (let round = 0; round < 6; round++) {
        const sigs = history(220); const base = replay(sigs, exec, pc); const none = noLot(base.out);
        expect(none.size, "the history must contain both kinds of decision").toBeGreaterThan(20); expect(base.out.decisions.length - none.size).toBeGreaterThan(0);
        lotDecisions += base.out.decisions.length - none.size;
        const changed = sigs.map((s) => {
          if (!none.has(s.signalId)) return s;
          const dupOfLot = false; void dupOfLot;
          const before = JSON.stringify([s.exit, s.resolution]);
          const next = { ...s, exit: randomExit(s.entry.sourceTs, s.entry.market), exitId: null as string | null, resolution: randomResolution(s.entry.sourceTs) };
          next.exitId = next.exit ? `x-other-${s.signalId}` : null;
          if (JSON.stringify([next.exit, next.resolution]) !== before) perturbed++;
          return next;
        });
        const after = replay(changed, exec, pc);
        expect(after.out.decisions).toEqual(base.out.decisions); expect(after.out.lots).toEqual(base.out.lots); expect(after.out.equity).toEqual(base.out.equity);
        expect(after.summary).toEqual(base.summary);
        checked += none.size; for (const d of base.out.decisions) if (d.filledShares <= 0) { outcomes.add(d.outcome); reasons.add(d.reason?.replace(/:.*/, "") ?? d.outcome); }
      }
    });
  }
  it("…and the check is not vacuous: it saw thousands of no-lot decisions, real perturbations, several outcomes and every kind of rejection", () => {
    if (process.env.DBG) console.log("D24-CLAIM", JSON.stringify({ noLotDecisionsChecked: checked, perturbed, lotDecisions, outcomes: [...outcomes], reasons: [...reasons] }));
    expect(checked).toBeGreaterThan(10_000); expect(perturbed).toBeGreaterThan(5_000); expect(lotDecisions).toBeGreaterThan(500);
    expect([...outcomes].sort()).toEqual(["EXPIRED", "INVALID", "REJECTED", "UNFILLED", "UNKNOWN"]);          // every outcome a decision without a lot can have
    for (const r of ["REJECTED_DUPLICATE_POSITION", "REJECTED_MAX_OPEN_POSITIONS", "REJECTED_MAX_WALLET_ALLOCATION", "REJECTED_MAX_MARKET_EXPOSURE", "REJECTED_INSUFFICIENT_CASH", "REJECTED_MAX_PORTFOLIO_EXPOSURE"]) expect([...reasons], r).toContain(r);
  });

  it("control: the same perturbation on a signal that DID open a lot changes the numbers, so the harness can see a dependence", () => {
    seed = 99; const exec = MODES.REALISTIC; const pc = PCS.roomy; let differing = 0, tried = 0;
    for (let round = 0; round < 4; round++) {
      const sigs = history(200); const base = replay(sigs, exec, pc); const none = noLot(base.out);
      const changed = sigs.map((s) => (none.has(s.signalId) ? s : { ...s, exit: randomExit(s.entry.sourceTs, s.entry.market), exitId: `x-other-${s.signalId}`, resolution: randomResolution(s.entry.sourceTs) }));
      tried++; if (JSON.stringify(replay(changed, exec, pc).out.equity) !== JSON.stringify(base.out.equity)) differing++;
    }
    expect(differing).toBe(tried);
  });
});
