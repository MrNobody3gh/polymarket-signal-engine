/**
 * SYNTHETIC event-level markets for the Phase 4.0b tests (not real samples, not evidence about any venue; see tests/fixtures/phase4/README.md).
 * Built so every answer is known by construction: events with many markets (moneyline, spread, total, prop) that share a game start, Eastern-time
 * date placeholders on both sides of the daylight-saving change, and `gameStartTime` fields by sport and market type.
 */
import { toAuditMarkets, type AuditMarket, type RawMarket } from "../../src/lib/phase4/audit";
import { gammaGroupOf, gammaIdOf, gammaIsResolved, gammaTitleOf, tagsOf } from "../../src/lib/phase4/venues";

const Z = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const lenient = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "+00");
const TYPES = ["MONEYLINE", "SPREAD", "SPREAD", "TOTAL", "TOTAL", "PROP"];
export interface EventSpec { id: string; title: string; slug: string; kickMs: number; markets: number; resolved: boolean; endDate?: string; sport?: string }

/** One Gamma-shaped market per (event, market index): the event's own id, a shared gameStartTime/startTime, listing times well before, a closedTime after the game for resolved ones. */
export function marketsOfEvents(specs: EventSpec[], opt: { gameStartField?: boolean } = {}): RawMarket[] {
  const out: RawMarket[] = [];
  for (const e of specs) for (let k = 0; k < e.markets; k++) {
    const created = e.kickMs - 5 * 86_400_000 + k * 1000; const type = TYPES[k % TYPES.length];
    const m: RawMarket = { conditionId: `0x${e.id}${String(k).padStart(3, "0")}`, question: k === 0 ? e.title : `${e.title}: ${type} ${k}`, slug: `${e.slug}-${k}`, closed: e.resolved, sportsMarketType: type.toLowerCase(),
      createdAt: new Date(created).toISOString(), startDate: new Date(created + 60_000).toISOString(),
      events: [{ id: e.id, slug: e.slug, startDate: new Date(created).toISOString(), startTime: Z(e.kickMs), endDate: e.endDate ?? Z(e.kickMs + 3 * 3_600_000) }] };
    if (opt.gameStartField !== false) m.gameStartTime = lenient(e.kickMs);
    if (e.endDate) m.endDate = e.endDate;
    if (e.resolved) m.closedTime = lenient(e.kickMs + 2.5 * 3_600_000 + k * 60_000);
    out.push(m);
  }
  return out;
}
export const toMarkets = (raws: RawMarket[], venue = "v"): AuditMarket[] => toAuditMarkets(venue, raws, { idOf: gammaIdOf, isResolved: gammaIsResolved, titleOf: gammaTitleOf, slugOf: (m) => String(m.slug), tagsOf, groupOf: gammaGroupOf });

const BASE = Date.UTC(2026, 8, 1, 0, 0, 0);
/** `n` events with kick-offs on a 15-minute grid that never hits a UTC or Eastern placeholder, one every `stepH` hours. */
export function varied(prefix: string, n: number, o: { markets: number; resolved?: (i: number) => boolean; sport?: string; stepH?: number } = { markets: 1 }): EventSpec[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, title: `Team ${prefix}${i}a vs Team ${prefix}${i}b`, slug: `nba-${prefix}-${i}`, kickMs: BASE + i * (o.stepH ?? 7) * 3_600_000 + 17 * 60_000 + (i % 4) * 15 * 60_000, markets: o.markets, resolved: o.resolved ? o.resolved(i) : i % 2 === 1 }));
}
