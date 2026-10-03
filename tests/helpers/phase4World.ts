/**
 * SYNTHETIC venue market objects for the Phase 4.0 tests. NOT real samples and NOT evidence about any venue.
 *
 * Why synthetic: the authoring environment could not reach any venue (network policy 403), so no real response could be
 * captured. The shapes below follow what this repository already reads from Gamma (`conditionId`, `question`, `slug`,
 * `endDate`, `endDateIso`, `clobTokenIds` as a JSON string, `closed`) plus time fields whose names and formats are RECALLED
 * for Gamma (`startDate`, `gameStartTime` as "YYYY-MM-DD HH:MM:SS+00", `closedTime`, `umaEndDate`, `events[]`). The
 * "US exchange" objects use invented field names: the real schema is NOT known here. The real, sanitized samples are written
 * by `npm run phase4:ts-audit` to tests/fixtures/phase4/s1a_*.json when it is run where the venues are reachable.
 *
 * The world is built so its answers are known by construction (see `expected`): which fields are placeholders, which stratum
 * has a usable start field, and which pairs exist on both venues with which start-time difference.
 */
export type Raw = Record<string, unknown>;

function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const BASE = Date.UTC(2026, 9, 5); // 5 Oct 2026 00:00 UTC; open markets lie after it, resolved before it
const z = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const lenient = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "+00");
const hex = (r: () => number, n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");

const TEAMS = [["Lakers", "Celtics"], ["Warriors", "Knicks"], ["Bulls", "Heat"], ["Nets", "Suns"], ["Mavericks", "Clippers"], ["Spurs", "Jazz"], ["Hawks", "Magic"], ["Pistons", "Raptors"]];
const SOCCER = [["Arsenal", "Chelsea"], ["Liverpool", "Man City"], ["Barcelona", "Real Madrid"], ["Bayern", "Dortmund"], ["Inter", "Milan"], ["PSG", "Lyon"]];
const ESPORT = [["T1", "Gen.G"], ["Fnatic", "G2"], ["NAVI", "FaZe"], ["Team Liquid", "Cloud9"], ["LOUD", "Sentinels"]];

export interface World { gamma: Raw[]; us: Raw[]; expected: { matchedPairs: { gammaId: string; usId: string; diffMin: number; stratum: string }[]; stratumCounts: Record<string, number> } }

export function buildWorld(seed = 4): World {
  const r = rng(seed); const gamma: Raw[] = []; const us: Raw[] = []; const pairs: World["expected"]["matchedPairs"] = []; const stratumCounts: Record<string, number> = {};
  let n = 0;
  const mk = (stratum: string, question: string, slug: string, outcomes: string[], kind: "sports" | "esports" | "crypto" | "deadline", resolved: boolean, i: number) => {
    n++; stratumCounts[stratum] = (stratumCounts[stratum] ?? 0) + 1;
    const dayOffset = 1 + Math.floor(r() * 20); const startOfEvent = resolved ? BASE - dayOffset * 86_400_000 : BASE + dayOffset * 86_400_000;
    // kick-off at a varied time of day (never a placeholder), a multiple of 15 min
    let kick = startOfEvent + (Math.floor(r() * 96) * 15 * 60_000);
    { const tod = (kick - Date.UTC(new Date(kick).getUTCFullYear(), new Date(kick).getUTCMonth(), new Date(kick).getUTCDate())) / 3_600_000; if (tod === 0 || tod === 12) kick += 15 * 60_000; } // never a placeholder shape by accident
    const conditionId = "0x" + hex(r, 64); const tokens = [String(1000000 + n * 2), String(1000001 + n * 2)];
    const created = kick - (3 + Math.floor(r() * 10)) * 86_400_000 + Math.floor(r() * 86_400_000); // listing time: days before the event, with milliseconds
    const dur = kind === "sports" ? (2 + r()) * 3_600_000 : kind === "esports" ? (1 + r() * 2) * 3_600_000 : 5 * 60_000;
    const m: Raw = { id: String(500000 + n), conditionId, question, slug, outcomes: JSON.stringify(outcomes), clobTokenIds: JSON.stringify(tokens), closed: resolved, active: !resolved,
      createdAt: new Date(created).toISOString(), updatedAt: new Date(BASE - 3_600_000).toISOString(), startDate: new Date(created + 60_000).toISOString(), volume: "12345.6", liquidity: 2500.5 };
    const midnight = Date.UTC(new Date(kick).getUTCFullYear(), new Date(kick).getUTCMonth(), new Date(kick).getUTCDate());
    if (kind === "sports" || kind === "esports") {
      m.gameStartTime = lenient(kick);
      m.endDate = z(midnight);                                 // placeholder: midnight UTC of the event date
      m.endDateIso = new Date(midnight).toISOString().slice(0, 10);
      if (resolved) { m.closedTime = lenient(kick + dur + Math.floor(r() * 3_600_000)); m.umaEndDate = z(kick + dur + 2 * 3_600_000); }
      m.events = [{ id: String(9000 + n), slug, startDate: new Date(created).toISOString(), endDate: z(midnight), startTime: z(kick), title: question }];
    } else if (kind === "crypto") {
      m.endDate = z(kick); m.endDateIso = new Date(kick).toISOString().slice(0, 10);   // real deadline with a time of day
      if (resolved) { m.closedTime = lenient(kick + 90_000); m.umaEndDate = z(kick + 3_600_000); }
      m.events = [{ id: String(9000 + n), slug, startDate: new Date(created).toISOString(), endDate: z(kick), title: question }];
    } else {
      m.endDate = z(midnight); m.endDateIso = new Date(midnight).toISOString().slice(0, 10); // "by <date>": date-level placeholder
      if (resolved) { m.closedTime = lenient(kick + 7 * 86_400_000); m.umaEndDate = z(kick + 7 * 86_400_000 + 7_200_000); }
      m.events = [{ id: String(9000 + n), slug, startDate: new Date(created).toISOString(), endDate: z(midnight), title: question }];
    }
    gamma.push(m); return { m, kick, dur };
  };
  let i = 0;
  // sports: basketball (62) and soccer (40); half resolved
  for (let k = 0; k < 62; k++, i++) {
    const [a, b] = TEAMS[k % TEAMS.length]; const resolved = k % 2 === 1;
    const { m, kick, dur } = mk("sports:basketball", `${a} vs. ${b} (${k})`, `nba-${a.toLowerCase()}-${b.toLowerCase()}-${k}`, [a, b], "sports", resolved, i);
    if (k < 60) { // 60 basketball markets (30 open, 30 resolved) also exist on the US venue with a known start-time difference
      const diff = [0, 0, 5, -5, 10, -10, 20, -30, 0, 15][k % 10]; const usId = `us-${m.id}`;
      us.push({ id: usId, slug: `nba-${k}`, question: `${a} vs ${b} (${k})`, outcomes: JSON.stringify([a, b]), status: resolved ? "settled" : "open", eventStartTime: new Date(kick + diff * 60_000).toISOString().replace("Z", "+00:00").replace(/\.\d{3}/, ""), closeTime: z(kick + 3 * 3_600_000), ...(resolved ? { settledAt: z(kick + dur + 3_600_000) } : {}), event: { id: `ev-${k}`, title: `${a} vs ${b}` } });
      pairs.push({ gammaId: String(m.conditionId), usId, diffMin: diff, stratum: "sports:basketball" });
    }
  }
  for (let k = 0; k < 64; k++, i++) { const [a, b] = SOCCER[k % SOCCER.length]; mk("sports:soccer", `${a} vs ${b} - Premier League match ${k}`, `epl-${a.toLowerCase()}-${b.toLowerCase()}-${k}`, [a, b, "Draw"], "sports", k % 2 === 1, i); }
  for (let k = 0; k < 64; k++, i++) { const [a, b] = ESPORT[k % ESPORT.length]; mk("esports", `${a} vs ${b} - League of Legends BO3 ${k}`, `lol-${a.toLowerCase()}-${b.toLowerCase()}-${k}`, [a, b], "esports", k % 2 === 1, i); }
  for (let k = 0; k < 64; k++, i++) mk("crypto_short_term", `Bitcoin up or down - ${k} ET`, `btc-updown-15m-${k}`, ["Up", "Down"], "crypto", k % 2 === 1, i);
  for (let k = 0; k < 64; k++, i++) mk("politics", `Will the Senate pass the bill number ${k} by October?`, `senate-bill-${k}`, ["Yes", "No"], "deadline", k % 2 === 1, i);
  for (let k = 0; k < 64; k++, i++) mk("culture_other", `Will the movie number ${k} gross over $100M opening weekend?`, `movie-${k}`, ["Yes", "No"], "deadline", k % 2 === 1, i);
  return { gamma, us, expected: { matchedPairs: pairs, stratumCounts } };
}
