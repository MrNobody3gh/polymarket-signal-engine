/**
 * Phase 4.0d, Part D — per-wallet and per-category EXECUTABLE SHARE. RESEARCH ONLY: not a strategy change, not a recommendation, and nothing here is verified.
 * Question: of the entry signals each wallet produced in the window (all copy scores), how many have a PROPOSED candidate on the execution venue
 * (an identifier match, or title similarity ≥ 0.70 with equal numbers and negations and a matching outcome label), and is that flow concentrated in a few
 * wallets or in a few categories? The inputs are our entry signals (read-only) and the saved per-venue title results; a signal whose market+outcome pair was not
 * searched is UNKNOWN (counted separately), never "no candidate".
 */
import { categorize, stratum } from "./categorize";
import { ENTRY_KINDS } from "../paper/ledger";
import { selectAll, type ReadOnlyDb } from "./readonly-db";
import { pairKey, proposedOf, type TitleSearchRow } from "./title-search";
import { SCORE_MIN } from "./funnel";

export interface WalletSignal { wallet: string; conditionId: string; outcome: string | null; score: number | null; category: string }
export const MIN_SIGNALS_FOR_SHARE = 5;

export interface CategoryShare { category: string; signals: number; searched: number; proposed: number; share: number | null }
export interface WalletRow { wallet: string; signals: number; searched: number; unsearched: number; proposed: number; share: number | null; perDay: number; hasScore68: boolean; byCategory: CategoryShare[] }
export interface GroupShare { label: string; wallets: number; signals: number; searched: number; proposed: number; share: number | null; medianWalletShare: number | null }
export interface WalletShareResult {
  venue: string; research: string; elapsedDays: number; minSignalsForShare: number;
  totals: { signals: number; searched: number; unsearched: number; proposed: number; share: number | null; proposedPerDay: number };
  wallets: number; walletsWithEnoughSignals: number;
  distribution: { atLeast25: number; atLeast50: number; of: number; allWallets: { atLeast25: number; atLeast50: number; of: number } };
  concentration: { top3: { proposed: number; share: number | null }; top10: { proposed: number; share: number | null } };
  groups: { score68Wallets: GroupShare; otherWallets: GroupShare; note: string };
  byCategory: CategoryShare[]; perWallet: WalletRow[]; notes: string[];
}

const med = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Pure: the shares from signals and the venue's title-search rows. */
export function walletShare(o: { venue: string; signals: WalletSignal[]; rows: TitleSearchRow[]; elapsedDays: number; minSignals?: number }): WalletShareResult {
  const minSignals = o.minSignals ?? MIN_SIGNALS_FOR_SHARE; const days = o.elapsedDays > 0 ? o.elapsedDays : 0;
  const lookup = new Map<string, boolean>(); for (const r of o.rows) if (r.diag && !r.error) lookup.set(pairKey(r.pair), !!proposedOf(r));
  type Acc = { signals: number; searched: number; proposed: number; has68: boolean; cat: Map<string, { signals: number; searched: number; proposed: number }> };
  const by = new Map<string, Acc>(); const cats = new Map<string, { signals: number; searched: number; proposed: number }>();
  for (const s of o.signals) {
    const k = pairKey({ conditionId: s.conditionId, outcome: s.outcome }); const hit = lookup.get(k); const searched = hit !== undefined; const proposed = hit === true;
    const w = by.get(s.wallet) ?? { signals: 0, searched: 0, proposed: 0, has68: false, cat: new Map() }; by.set(s.wallet, w);
    w.signals++; if (searched) w.searched++; if (proposed) w.proposed++; if (s.score !== null && s.score >= SCORE_MIN) w.has68 = true;
    for (const m of [w.cat, cats]) { const c = m.get(s.category) ?? { signals: 0, searched: 0, proposed: 0 }; m.set(s.category, c); c.signals++; if (searched) c.searched++; if (proposed) c.proposed++; }
  }
  const catRows = (m: Map<string, { signals: number; searched: number; proposed: number }>): CategoryShare[] => [...m.entries()].map(([category, c]) => ({ category, ...c, share: ratio(c.proposed, c.searched) })).sort((a, b) => b.proposed - a.proposed || b.signals - a.signals || (a.category < b.category ? -1 : 1));
  const wallets: WalletRow[] = [...by.entries()].map(([wallet, a]) => ({ wallet, signals: a.signals, searched: a.searched, unsearched: a.signals - a.searched, proposed: a.proposed, share: ratio(a.proposed, a.searched), perDay: days ? a.proposed / days : 0, hasScore68: a.has68, byCategory: catRows(a.cat) })).sort((a, b) => b.proposed - a.proposed || b.signals - a.signals || (a.wallet < b.wallet ? -1 : 1));
  const tot = wallets.reduce((a, w) => ({ signals: a.signals + w.signals, searched: a.searched + w.searched, proposed: a.proposed + w.proposed }), { signals: 0, searched: 0, proposed: 0 });
  const enough = wallets.filter((w) => w.searched >= minSignals); const ge = (xs: WalletRow[], t: number) => xs.filter((w) => w.share !== null && w.share >= t).length;
  const topN = (n: number) => { const p = wallets.slice(0, n).reduce((a, w) => a + w.proposed, 0); return { proposed: p, share: ratio(p, tot.proposed) }; };
  const group = (label: string, ws: WalletRow[]): GroupShare => { const s = ws.reduce((a, w) => ({ signals: a.signals + w.signals, searched: a.searched + w.searched, proposed: a.proposed + w.proposed }), { signals: 0, searched: 0, proposed: 0 }); return { label, wallets: ws.length, ...s, share: ratio(s.proposed, s.searched), medianWalletShare: med(ws.filter((w) => w.searched >= minSignals && w.share !== null).map((w) => w.share!)) }; };
  const a = group("wallets with at least one score ≥ 68 signal", wallets.filter((w) => w.hasScore68)), b = group("all other wallets", wallets.filter((w) => !w.hasScore68));
  const diff = a.share !== null && b.share !== null ? `the score ≥ 68 wallets' proposed share is ${(a.share * 100).toFixed(0)} % against ${(b.share * 100).toFixed(0)} % for the others (${a.share > b.share ? "higher" : a.share < b.share ? "lower" : "equal"})` : "one group has no searched signal: no comparison";
  const notes = ["PROPOSED, not verified: a candidate for the owner's review; nothing here says a signal could be executed.", "research: not a strategy change and not a recommendation."];
  if (tot.searched < tot.signals) notes.push(`${tot.signals - tot.searched} of ${tot.signals} signals sit on pairs that were not searched (run the title search with --all-scores, and --resume after a refusal): their shares are unknown, not zero.`);
  return { venue: o.venue, research: "proposed, not verified; research: not a strategy change and not a recommendation", elapsedDays: days, minSignalsForShare: minSignals,
    totals: { signals: tot.signals, searched: tot.searched, unsearched: tot.signals - tot.searched, proposed: tot.proposed, share: ratio(tot.proposed, tot.searched), proposedPerDay: days ? tot.proposed / days : 0 }, wallets: wallets.length, walletsWithEnoughSignals: enough.length,
    distribution: { atLeast25: ge(enough, 0.25), atLeast50: ge(enough, 0.5), of: enough.length, allWallets: { atLeast25: ge(wallets, 0.25), atLeast50: ge(wallets, 0.5), of: wallets.filter((w) => w.share !== null).length } },
    concentration: { top3: topN(3), top10: topN(10) }, groups: { score68Wallets: a, otherWallets: b, note: diff }, byCategory: catRows(cats), perWallet: wallets, notes };
}

interface Row { id: string; wallet: string; condition_id: string; outcome: string | null; title: string | null; slug: string | null; created_at: string; payload: Record<string, unknown> | null }
/** Our entry signals of the window, select only, de-duplicated by id. */
export async function loadWalletSignals(db: ReadOnlyDb, startIso: string, endIso: string): Promise<WalletSignal[]> {
  const rows = await selectAll<Row>((from, to) => db.select("signals", "id,wallet,condition_id,outcome,title,slug,created_at,payload").in("kind", ENTRY_KINDS).gte("created_at", startIso).lt("created_at", endIso).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to));
  const seen = new Set<string>(); const out: WalletSignal[] = [];
  for (const r of rows) { if (seen.has(r.id)) continue; seen.add(r.id); const raw = (r.payload ?? {}).copyScore; const sc = raw === null || raw === undefined ? null : Number(raw); out.push({ wallet: r.wallet, conditionId: r.condition_id, outcome: r.outcome, score: sc !== null && Number.isFinite(sc) ? sc : null, category: stratum(categorize({ title: r.title, slug: r.slug })) }); }
  return out;
}

const pc = (x: number | null) => (x === null ? "n/m" : `${(x * 100).toFixed(0)} %`); const short = (w: string) => (w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w);
/** WALLET_SHARE_<venue>.md, ≤ 80 lines. */
export function renderWalletShare(r: WalletShareResult): string {
  const L = [`# Per-wallet executable share on ${r.venue} (generated; ${r.research})`, "", `Window ${r.elapsedDays.toFixed(1)} days · ${r.totals.signals} entry signals (all scores) · searched ${r.totals.searched} · not searched (unknown) ${r.totals.unsearched} · with a PROPOSED candidate ${r.totals.proposed} (${pc(r.totals.share)} of the searched; ${r.totals.proposedPerDay.toFixed(1)} per day).`, "",
    `Wallets: ${r.wallets}; ${r.walletsWithEnoughSignals} with at least ${r.minSignalsForShare} searched signals. Of those, ≥ 25 % proposed: **${r.distribution.atLeast25}**, ≥ 50 % proposed: **${r.distribution.atLeast50}** (of ${r.distribution.of}); counting every wallet with a searched signal: ${r.distribution.allWallets.atLeast25} / ${r.distribution.allWallets.atLeast50} of ${r.distribution.allWallets.of}.`,
    `Concentration of the proposed flow: top 3 wallets ${pc(r.concentration.top3.share)} (${r.concentration.top3.proposed} signals), top 10 wallets ${pc(r.concentration.top10.share)} (${r.concentration.top10.proposed} signals).`, "",
    "| group | wallets | signals | searched | proposed | share | median wallet share |", "|---|---|---|---|---|---|---|"];
  for (const g of [r.groups.score68Wallets, r.groups.otherWallets]) L.push(`| ${g.label} | ${g.wallets} | ${g.signals} | ${g.searched} | ${g.proposed} | ${pc(g.share)} | ${pc(g.medianWalletShare)} |`);
  L.push("", `${r.groups.note}.`, "", "## By category", "", "| category | signals | searched | proposed | share |", "|---|---|---|---|---|");
  for (const c of r.byCategory.slice(0, 14)) L.push(`| ${c.category} | ${c.signals} | ${c.searched} | ${c.proposed} | ${pc(c.share)} |`);
  L.push("", "## Top 10 wallets by proposed signals", "", "| wallet | signals | searched | proposed | share | proposed per day | top category |", "|---|---|---|---|---|---|---|");
  for (const w of r.perWallet.slice(0, 10)) L.push(`| ${short(w.wallet)} | ${w.signals} | ${w.searched} | ${w.proposed} | ${pc(w.share)} | ${w.perDay.toFixed(2)} | ${w.byCategory[0]?.category ?? "—"} |`);
  L.push("", ...r.notes.map((n) => `- ${n}`));
  return L.slice(0, 80).join("\n") + "\n";
}
export function walletShareLines(r: WalletShareResult, outDir: string): string[] {
  const L = [`wallet share on ${r.venue}  (${r.research})`, `signals ${r.totals.signals} (all scores) · searched ${r.totals.searched} · unknown ${r.totals.unsearched} · proposed ${r.totals.proposed} = ${pc(r.totals.share)} of searched, ${r.totals.proposedPerDay.toFixed(1)}/day`,
    `wallets ${r.wallets} (${r.walletsWithEnoughSignals} with ≥ ${r.minSignalsForShare} searched signals): ≥ 25 % proposed ${r.distribution.atLeast25}, ≥ 50 % ${r.distribution.atLeast50}`, `proposed flow: top 3 wallets ${pc(r.concentration.top3.share)}, top 10 ${pc(r.concentration.top10.share)}`, r.groups.note,
    `by category (share of searched signals proposed): ${r.byCategory.slice(0, 6).map((c) => `${c.category} ${pc(c.share)} (${c.proposed}/${c.searched})`).join(" · ")}`, ...r.notes.slice(2), `files in ${outDir}: v_${r.venue}_wallets.json WALLET_SHARE_${r.venue}.md`];
  return L.map((l) => (l.length > 220 ? l.slice(0, 217) + "..." : l)).slice(0, 60);
}
