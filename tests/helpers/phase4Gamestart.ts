/**
 * SYNTHETIC US-exchange market objects for the Phase 4.0e tests (not real samples; not evidence about the venue). Every answer is known by construction:
 * a "local" world whose evening games start at 8 pm Eastern (00:00Z under EDT, 01:00Z under EST) and a "placeholder" world whose value stays at 00:00:00Z on every date.
 */
import type { RawMarket } from "../../src/lib/phase4/audit";

export const Z = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
export const lenient = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "+00");
const DAY = 86_400_000;
/** The instant of a US Eastern wall-clock time on a given date, for the dates used here (EDT before 2026-11-01 06:00Z, EST after). */
export const easternInstant = (y: number, mo: number, d: number, hh: number, mm = 0): number => { const edt = Date.UTC(y, mo - 1, d, hh + 4, mm); return edt < Date.UTC(2026, 10, 1, 6) ? edt : Date.UTC(y, mo - 1, d, hh + 5, mm); };

export interface UsSpec {
  id: string; sport?: "nba" | "nhl" | "nfl" | "politics" | "culture"; gs: number | "date" | null; createdMs?: number | null; resolvedMs?: number | null; resolved?: boolean; type?: string; markets?: number;
  /** the schedule endpoint's event start: an instant, "date" (date-only), "none" */ schedule?: number | "date" | "none"; endDate?: number; withClose?: boolean;
}
const SLUG: Record<string, string> = { nba: "nba", nhl: "nhl", nfl: "nfl", politics: "politics", culture: "culture" };
const TITLE = (s: string, id: string) => (s === "politics" ? `Will the senate pass bill ${id}` : s === "culture" ? `Will the album ${id} go platinum` : `Team ${id}a vs Team ${id}b`);
/** One event's markets (one or more), US-shaped and exploded as the sports API / listing delivers them (each market keeps its event under `event`). */
export function usEvent(s: UsSpec): RawMarket[] {
  const sport = s.sport ?? "nba"; const n = s.markets ?? 1; const types = s.type ? [s.type] : ["MONEYLINE", "SPREAD", "TOTAL", "PROP"]; const out: RawMarket[] = [];
  const sched = s.schedule === undefined ? (typeof s.gs === "number" ? s.gs : "none") : s.schedule;
  for (let k = 0; k < n; k++) {
    const m: RawMarket = { id: `${s.id}-m${k}`, slug: `${SLUG[sport]}-${s.id}-m${k}`, question: k === 0 ? TITLE(sport, s.id) : `${TITLE(sport, s.id)}: ${types[k % types.length]} ${k}`, outcomes: '["Yes","No"]', sportsMarketType: types[k % types.length], closed: !!s.resolved, status: s.resolved ? "settled" : "open", active: !s.resolved,
      event: { id: s.id, slug: `${SLUG[sport]}-${s.id}`, title: TITLE(sport, s.id), ...(sched === "none" ? {} : { startTime: sched === "date" ? Z(s.gs === null || s.gs === "date" ? 0 : s.gs).slice(0, 10) : Z(sched as number) }) } };
    if (s.gs === "date") m.gameStartTime = Z(s.createdMs ?? Date.UTC(2026, 9, 5)).slice(0, 10); else if (s.gs !== null) m.gameStartTime = lenient(s.gs);
    if (s.createdMs !== undefined && s.createdMs !== null) m.createdAt = Z(s.createdMs);
    if (s.resolved && s.resolvedMs !== undefined && s.resolvedMs !== null) m.closedTime = lenient(s.resolvedMs + k * 60_000);
    if (s.endDate !== undefined) m.endDate = Z(s.endDate); out.push(m);
  }
  return out;
}
/** `n` evening games, one per day from `startDate` (UTC midnight of the first day), each at `hour:minute` EASTERN LOCAL time converted with the right offset for that date. */
export function localSlate(prefix: string, n: number, startDate: number, o: { sport?: UsSpec["sport"]; hour?: number; minute?: number; resolved?: boolean; markets?: number; createdDaysBefore?: number; sched?: boolean; schedOffsetMin?: number } = {}): UsSpec[] {
  return Array.from({ length: n }, (_, i) => { const d = new Date(startDate + i * DAY); const gs = easternInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), o.hour ?? 20, o.minute ?? 0);
    return { id: `${prefix}${i}`, sport: o.sport ?? "nba", gs, createdMs: gs - (o.createdDaysBefore ?? 5) * DAY, resolved: o.resolved, resolvedMs: o.resolved ? gs + 2.5 * 3_600_000 + (i % 5) * 600_000 : null, markets: o.markets ?? 2, schedule: o.sched === false ? "none" : gs + (o.schedOffsetMin ?? 2) * 60_000 }; });
}
/** `n` events whose value is 00:00:00Z on every date (a date-only value expanded to UTC midnight), on unrelated categories, with no schedule. */
export function midnightPlaceholders(prefix: string, n: number, startDate: number, o: { sport?: UsSpec["sport"]; resolved?: boolean; type?: string; markets?: number } = {}): UsSpec[] {
  return Array.from({ length: n }, (_, i) => { const day = startDate + i * DAY; return { id: `${prefix}${i}`, sport: o.sport ?? "politics", gs: day, createdMs: day - 20 * DAY, resolved: o.resolved, resolvedMs: o.resolved ? day + (3 + (i % 9)) * DAY : null, type: o.type, markets: o.markets ?? 1, schedule: "none" as const }; });
}
export const explode = (specs: UsSpec[]): RawMarket[] => specs.flatMap(usEvent);
