/**
 * Phase 4.0 — market category used to stratify the S1a/S1b samples (brief: sports by sport, esports, short-term
 * crypto, politics, culture/other). HEURISTIC: neither `signals` nor `markets` stores a category today (GAP_REPORT §4),
 * so this reads venue tags when a sample provides them and falls back to keywords in the title and slug. It is a
 * stratification aid for the audit, never an input to a trading decision, and its error rate is not measured.
 */
export type Category = "sports" | "esports" | "crypto_short_term" | "crypto_other" | "politics" | "culture_other";
export interface Categorized { category: Category; /** sports only */ sport: string | null; basis: "tags" | "slug" | "title" | "default" }

const SPORT_PREFIX: [RegExp, string][] = [
  [/^(nba|wnba|ncaab|cbb)\b/, "basketball"], [/^(nfl|ncaaf|cfb)\b/, "american_football"], [/^(mlb)\b/, "baseball"], [/^(nhl)\b/, "hockey"],
  [/^(epl|ucl|uel|laliga|la-liga|bundesliga|seriea|serie-a|ligue1|mls|fifa|uefa|soccer|efl|premier)\b/, "soccer"], [/^(atp|wta|tennis)\b/, "tennis"],
  [/^(ufc|mma|boxing)\b/, "combat"], [/^(f1|formula)\b/, "motorsport"], [/^(cricket|ipl|bbl)\b/, "cricket"], [/^(golf|pga|lpga|masters)\b/, "golf"],
];
const SPORT_WORDS: [RegExp, string][] = [
  [/\b(nba|wnba|lakers|celtics|warriors|knicks|basketball)\b/, "basketball"], [/\b(nfl|super bowl|touchdown|quarterback)\b/, "american_football"], [/\b(mlb|world series|yankees|dodgers|red sox)\b/, "baseball"],
  [/\b(nhl|stanley cup)\b/, "hockey"], [/\b(premier league|la liga|bundesliga|serie a|champions league|europa league|world cup|man(chester)? (united|city|utd)|arsenal|chelsea|liverpool|barcelona|real madrid|fc |soccer|mls)\b/, "soccer"],
  [/\b(atp|wta|wimbledon|us open|roland garros|australian open|tennis)\b/, "tennis"], [/\b(ufc|mma|boxing|fight night)\b/, "combat"], [/\b(formula 1|f1|grand prix)\b/, "motorsport"],
  [/\b(cricket|ipl|test match|t20)\b/, "cricket"], [/\b(golf|pga|masters|ryder cup)\b/, "golf"], [/\b(vs\.?|versus)\b.*\b(game|match|spread|o\/u|over|under)\b|\bspread\b|\bo\/u\b/, "other_sport"],
];
const ESPORTS = /\b(esports?|league of legends|lol\b|dota ?2?|cs ?2|cs:?go|counter-strike|valorant|overwatch|rocket league|starcraft|call of duty|cdl|lck|lpl|lec|blast|iem|bo[1-5])\b/;
const CRYPTO = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|dogecoin|doge|bnb|crypto|cardano|ada|hyperliquid|hype|sui|avalanche|avax|chainlink)\b/;
const SHORT_TERM = /\b(up or down|up\/down|above|below|price of|hit \$?[\d,.]+|reach \$?[\d,.]+|\d{1,2}(:\d{2})? ?(am|pm) ?(et|utc|est|edt)|5 ?(m|min)|15 ?(m|min)|hourly|today|tonight)\b|-updown-|-(5|15)m-/;
const POLITICS = /\b(election|elect|president(ial)?|senate|senator|house of representatives|congress|governor|primary|nominee|nomination|trump|biden|harris|vance|democrat(ic)?|republican|gop|parliament|prime minister|mayor|ballot|vote|referendum|tariff|supreme court|cabinet|impeach|ukraine|russia|israel|gaza|iran|china|taiwan|nato|zelensky|putin|netanyahu|fed (rate|cut|hike)|fomc)\b/;

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** Classify a market. `tags` are the venue's own labels when available (Gamma `tags[].label` / `tags[].slug`, or the US venue's equivalent). */
export function categorize(m: { title?: string | null; slug?: string | null; tags?: string[] | null }): Categorized {
  const tags = (m.tags ?? []).map(norm).filter(Boolean); const slug = norm(m.slug); const title = norm(m.title); const hay = `${title} ${slug.replace(/-/g, " ")}`;
  const fromTags = tags.join(" | ");
  const has = (re: RegExp, s: string) => re.test(s);
  const sportOf = (s: string, words = true): string | null => { for (const [re, v] of SPORT_PREFIX) if (re.test(s)) return v; if (words) for (const [re, v] of SPORT_WORDS) if (re.test(s)) return v; return null; };

  if (tags.length) {
    if (has(ESPORTS, fromTags) || /e-?sports?|gaming/.test(fromTags)) return { category: "esports", sport: null, basis: "tags" };
    if (has(CRYPTO, fromTags) || /crypto/.test(fromTags)) return { category: has(SHORT_TERM, hay) ? "crypto_short_term" : "crypto_other", sport: null, basis: "tags" };
    if (/politic|election|geopolit|world affairs|government/.test(fromTags)) return { category: "politics", sport: null, basis: "tags" };
    const sp = /sports?|nba|nfl|mlb|nhl|soccer|football|tennis|ufc|mma|cricket|golf|f1|basketball|baseball|hockey/.test(fromTags);
    // a venue whose category is a plain "Sports" (Kalshi) also files esports there: the title and slug decide between the two
    if (sp && has(ESPORTS, hay)) return { category: "esports", sport: null, basis: slug ? "slug" : "title" };
    if (sp) return { category: "sports", sport: sportOf(fromTags) ?? sportOf(slug) ?? sportOf(hay) ?? "other_sport", basis: "tags" };
  }
  if (has(ESPORTS, hay)) return { category: "esports", sport: null, basis: slug ? "slug" : "title" };
  const slugSport = sportOf(slug, false); if (slugSport) return { category: "sports", sport: slugSport, basis: "slug" };
  if (has(CRYPTO, hay)) return { category: has(SHORT_TERM, hay) ? "crypto_short_term" : "crypto_other", sport: null, basis: "title" };
  if (has(POLITICS, hay)) return { category: "politics", sport: null, basis: "title" };
  const w = sportOf(hay); if (w) return { category: "sports", sport: w, basis: "title" };
  return { category: "culture_other", sport: null, basis: "default" };
}

/** `sports:basketball`, `esports`, … — the stratum label used in reports. */
export const stratum = (c: Categorized): string => (c.category === "sports" ? `sports:${c.sport ?? "other_sport"}` : c.category);
