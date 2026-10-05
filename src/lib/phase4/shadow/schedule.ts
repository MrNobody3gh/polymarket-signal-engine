/**
 * Phase 4.1 — which snapshots are due (pure). The schedule lives in the database, not in memory: a restart re-derives it from the signals and the
 * rows already written, so nothing is lost or repeated.
 *
 *   due_at = signal created_at + offset
 *   not yet due                    → wait
 *   a row exists                   → done (idempotent: running twice records once)
 *   due, at most MAX_LATE_S late   → take a snapshot
 *   due, more than MAX_LATE_S late → record MISSED with no data (a late book would bias the measurement)
 * Oldest due first. The two lists are capped separately: snapshots (network) and MISSED rows (no network).
 */
import { MAX_LATE_S, OFFSETS_S } from "./config";

export interface SignalLite { id: string; tokenId: string; kind: string; price: number | null; createdAtSec: number; copyScore: number | null }
export interface Due { signalId: string; tokenId: string; sourcePrice: number | null; offsetS: number; dueAtSec: number }
export const rowKey = (signalId: string, offsetS: number) => `${signalId}:${offsetS}`;

/** Entry signals only (everything but EXIT); with a minimum score, a signal without a score is excluded (min 0 keeps all). */
export const isMeasured = (s: SignalLite, minScore: number): boolean => s.kind !== "EXIT" && (minScore <= 0 || (s.copyScore !== null && s.copyScore >= minScore));

export function planWork(signals: readonly SignalLite[], have: ReadonlySet<string>, nowSec: number, o: { minScore: number; maxSnapshots: number; maxMissed: number; offsets?: readonly number[]; maxLateS?: number }): { snapshots: Due[]; missed: Due[] } {
  const offsets = o.offsets ?? OFFSETS_S; const maxLate = o.maxLateS ?? MAX_LATE_S;
  const all: (Due & { late: boolean })[] = [];
  for (const s of signals) {
    if (!isMeasured(s, o.minScore)) continue;
    for (const off of offsets) {
      const dueAtSec = s.createdAtSec + off;
      if (dueAtSec > nowSec || have.has(rowKey(s.id, off))) continue;
      all.push({ signalId: s.id, tokenId: s.tokenId, sourcePrice: s.price, offsetS: off, dueAtSec, late: nowSec - dueAtSec > maxLate });
    }
  }
  all.sort((a, b) => a.dueAtSec - b.dueAtSec || (a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : a.offsetS - b.offsetS));
  const strip = ({ late: _l, ...d }: Due & { late: boolean }): Due => d;
  return { snapshots: all.filter((d) => !d.late).slice(0, o.maxSnapshots).map(strip), missed: all.filter((d) => d.late).slice(0, o.maxMissed).map(strip) };
}
export const isTooLate = (dueAtSec: number, nowSec: number, maxLateS = MAX_LATE_S): boolean => nowSec - dueAtSec > maxLateS;
