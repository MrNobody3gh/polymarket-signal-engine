/**
 * Phase 4.0d, Part C — the human-verified sample: the stratified sheet (quotas, three strata, fixed seed, empty owner columns), the automatic TIME check, the ingest
 * validation (missing or unknown answers rejected), Wilson intervals against known values, the extrapolation arithmetic, and the operational meaning of "verified".
 */
import { describe, expect, it } from "vitest";
import { diagnoseCandidates, isProposed, PROPOSED_MIN_SIMILARITY, type VenueMarketRef } from "../src/lib/phase4/mapping";
import { OWNER_COLUMNS, REVIEW_COLUMNS, REVIEW_SEED, allocateA, autoTime, buildReviewSample, ingestLines, ingestReview, quotas, reviewSheetCsv, stratumOfBand, type ReviewResults } from "../src/lib/phase4/review";
import { pairKey, type SearchPair, type TitleSearchRow } from "../src/lib/phase4/title-search";
import { parseCsv, toCsv, wilson } from "../src/lib/phase4/stats";
import { stampOf } from "../src/lib/phase4/stop-rule";

// ───────── a world of title-search rows whose best-candidate band is known by construction (no digits, no head-to-head titles)
const W = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa"];
const sharing = (i: number, shared: number, ours: number, theirs: number) => { const base = (k: number) => `${W[(i * 3 + k) % W.length]}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}`; const common = Array.from({ length: shared }, (_, k) => base(k)); return { ours: [...common, ...Array.from({ length: ours - shared }, (_, k) => `o${base(100 + k)}`)].join(" "), theirs: [...common, ...Array.from({ length: theirs - shared }, (_, k) => `t${base(200 + k)}`)].join(" ") }; };
// band → (shared, ours, theirs): Jaccard 1.0, 8/10 = 0.8, 4/6 = 0.667, 2/6 = 0.333, 0
const SHAPE: Record<string, [number, number, number]> = { "≥ 0.90": [5, 5, 5], "0.70–0.90": [8, 9, 9], "0.50–0.70": [4, 5, 5], "0.30–0.50": [2, 4, 4], "< 0.30": [0, 4, 4] };
const ref = (id: string, q: string): VenueMarketRef => ({ venue: "kalshi", marketId: id, question: q, outcomes: ["Yes", "No"], categories: ["Sports"], stratum: "sports:basketball", slug: null, url: `https://kalshi.test/${id}`, times: [{ field: "event.strike_date", value: "2026-10-05T20:00:00Z" }], rules: "Resolves Yes if the home team wins." });
function row(i: number, band: string, o: { score?: number | null; signals?: number; error?: string | null; noDiag?: boolean } = {}): TitleSearchRow {
  const [sh, ou, th] = SHAPE[band]; const t = sharing(i, sh, ou, th); const pair: SearchPair = { conditionId: `0xc${i}`, tokenId: `t${i}`, title: t.ours, slug: `s-${i}`, outcome: "Yes", stratum: "sports:basketball", score: o.score === undefined ? 80 : o.score, signals: o.signals ?? 1 + (i % 4), wallet: `0xw${i % 7}`, eventDate: "2026-10-05" };
  return { pair, query: "q", diag: o.noDiag ? null : diagnoseCandidates({ conditionId: pair.conditionId, tokenId: pair.tokenId, title: pair.title, outcome: pair.outcome, slug: pair.slug, stratum: pair.stratum }, [ref(`m${i}`, t.theirs), ref(`n${i}`, "unrelated zulu yankee xray")]), error: o.error ?? null };
}
const BANDS = Object.keys(SHAPE);
const world = (perBand: Record<string, number>): TitleSearchRow[] => { let i = 0; return BANDS.flatMap((b) => Array.from({ length: perBand[b] ?? 0 }, () => row(i++, b))); };
const BIG = world({ "≥ 0.90": 8, "0.70–0.90": 25, "0.50–0.70": 40, "0.30–0.50": 60, "< 0.30": 120 });

describe("the construction: every row lands in the band it was built for", () => {
  it("band of the best candidate", () => { for (const b of BANDS) { const r = row(3, b); expect(r.diag!.band, b).toBe(b); } });
});

describe("quotas and allocation", () => {
  it("60 → 30 / 15 / 15; other sizes keep the 2 : 1 : 1 split and never exceed n", () => {
    expect(quotas(60)).toEqual({ A: 30, B: 15, C: 15 }); expect(quotas(10)).toEqual({ A: 5, B: 3, C: 2 }); expect(quotas(1)).toEqual({ A: 1, B: 1, C: 0 }); for (const n of [1, 2, 7, 33, 60, 100]) { const q = quotas(n); expect(q.A + q.B + q.C).toBeGreaterThanOrEqual(Math.min(n, 2)); expect(q.C).toBeGreaterThanOrEqual(0); }
  });
  it("strata of the bands: ≥ 0.50 is A, 0.30–0.50 is B, below is C", () => { expect(["≥ 0.90", "0.70–0.90", "0.50–0.70"].map(stratumOfBand)).toEqual(["A", "A", "A"]); expect(stratumOfBand("0.30–0.50")).toBe("B"); expect(stratumOfBand("< 0.30")).toBe("C"); });
  it("allocateA: equal thirds, a thin band hands its unused share to the others (higher band first), the total is min(quota, available)", () => {
    expect(allocateA(30, { "≥ 0.90": 100, "0.70–0.90": 100, "0.50–0.70": 100 })).toEqual({ "≥ 0.90": 10, "0.70–0.90": 10, "0.50–0.70": 10 });
    expect(allocateA(30, { "≥ 0.90": 8, "0.70–0.90": 20, "0.50–0.70": 40 })).toEqual({ "≥ 0.90": 8, "0.70–0.90": 11, "0.50–0.70": 11 });
    expect(allocateA(31, { "≥ 0.90": 100, "0.70–0.90": 100, "0.50–0.70": 100 })).toEqual({ "≥ 0.90": 11, "0.70–0.90": 10, "0.50–0.70": 10 });
    expect(allocateA(30, { "≥ 0.90": 5, "0.70–0.90": 5, "0.50–0.70": 5 })).toEqual({ "≥ 0.90": 5, "0.70–0.90": 5, "0.50–0.70": 5 }); expect(allocateA(30, { "≥ 0.90": 0, "0.70–0.90": 0, "0.50–0.70": 50 })).toEqual({ "≥ 0.90": 0, "0.70–0.90": 0, "0.50–0.70": 30 }); expect(allocateA(0, {})).toEqual({ "≥ 0.90": 0, "0.70–0.90": 0, "0.50–0.70": 0 });
  });
});

describe("the stratified sample", () => {
  const s = buildReviewSample(BIG, { venue: "kalshi" });
  it("60 rows: 30 from ≥ 0.50 (10 per band; the ≥ 0.90 band has only 8, so 8 + 11 + 11), 15 from 0.30–0.50, 15 random from < 0.30", () => {
    expect(s.picked).toHaveLength(60); const by = (st: string) => s.picked.filter((p) => p.stratum === st).length; expect([by("A"), by("B"), by("C")]).toEqual([30, 15, 15]);
    expect(s.picked.filter((p) => p.band === "≥ 0.90")).toHaveLength(8); expect(s.picked.filter((p) => p.band === "0.70–0.90")).toHaveLength(11); expect(s.picked.filter((p) => p.band === "0.50–0.70")).toHaveLength(11); expect(s.picked.filter((p) => p.band === "0.30–0.50")).toHaveLength(15); expect(s.picked.filter((p) => p.band === "< 0.30")).toHaveLength(15); expect(s.short).toEqual([]);
  });
  it("each pair once; the band of every pick is the band of its best candidate; populations are the pool's", () => {
    expect(new Set(s.picked.map((p) => pairKey(p.row.pair))).size).toBe(60); for (const p of s.picked) expect(p.row.diag!.band).toBe(p.band); expect(s.bands.map((b) => b.pairs)).toEqual([8, 25, 40, 60, 120]); expect(s.pool).toBe(253); expect(s.bands.map((b) => b.sampled)).toEqual([8, 11, 11, 15, 15]);
    expect(s.bands[0].signals).toBe(BIG.filter((r) => r.diag!.band === "≥ 0.90").reduce((a, r) => a + r.pair.signals, 0));
  });
  it("a fixed seed gives the same sheet every time, a different seed another one, and the default seed is the documented one", () => {
    const again = buildReviewSample(BIG, { venue: "kalshi" }); expect(again.picked.map((p) => pairKey(p.row.pair))).toEqual(s.picked.map((p) => pairKey(p.row.pair))); const other = buildReviewSample(BIG, { venue: "kalshi", seed: "another" }); expect(other.picked.map((p) => pairKey(p.row.pair))).not.toEqual(s.picked.map((p) => pairKey(p.row.pair))); const keys = (x: typeof s) => x.picked.map((p) => pairKey(p.row.pair)).sort(); expect(keys(other)).not.toEqual(keys(s)); // the SELECTION changes with the seed, not only the order expect(REVIEW_SEED).toBe("phase4-0d-review-v1");
    expect(buildReviewSample(BIG, { venue: "polymarket_us" }).picked.map((p) => pairKey(p.row.pair))).not.toEqual(s.picked.map((p) => pairKey(p.row.pair)));
    const shuffled = [...BIG].reverse(); expect(buildReviewSample(shuffled, { venue: "kalshi" }).picked.map((p) => pairKey(p.row.pair))).toEqual(s.picked.map((p) => pairKey(p.row.pair))); // independent of input order
  });
  it("the order of the sheet mixes the bands (the reviewer does not meet all the high-similarity rows first)", () => { const firstTen = s.picked.slice(0, 10).map((p) => p.stratum); expect(new Set(firstTen).size).toBeGreaterThan(1); });
  it("the pool excludes errored rows, rows without a result and score < 68 pairs (unless asked); a thin stratum is reported SHORT", () => {
    const rows = [...world({ "≥ 0.90": 3, "0.30–0.50": 2 }), row(90, "≥ 0.90", { score: 50 }), row(91, "≥ 0.90", { score: null }), row(92, "≥ 0.90", { error: "BLOCKED 403", noDiag: true }), row(93, "< 0.30", { noDiag: true })];
    const a = buildReviewSample(rows, { venue: "kalshi", n: 60 }); expect(a.pool).toBe(5); expect(a.short.map((x) => x.stratum)).toEqual(["A", "B", "C"]); expect(a.picked).toHaveLength(5);
    const b = buildReviewSample(rows, { venue: "kalshi", n: 60, includeBelow68: true }); expect(b.pool).toBe(7);
  });
});

describe("the sheet (CSV)", () => {
  const s = buildReviewSample(BIG, { venue: "kalshi" }); const csv = reviewSheetCsv(s, { venue: "kalshi", unsearched: { pairs: 12, signals: 30 } }); const t = parseCsv(csv); const h = t[0];
  it("the header is the documented one; there is one row per sample row and the file round-trips through the CSV reader", () => { expect(h).toEqual([...REVIEW_COLUMNS]); expect(t).toHaveLength(61); expect(new Set(t.slice(1).map((r) => r.length))).toEqual(new Set([h.length])); });
  it("the OWNER columns are empty, the COMPUTED columns are empty, time_auto is 'unknown' (no verified timestamp exists in the sheet)", () => {
    const ix = (c: string) => h.indexOf(c); for (const r of t.slice(1)) { for (const c of [OWNER_COLUMNS.question, OWNER_COLUMNS.outcome, OWNER_COLUMNS.time, OWNER_COLUMNS.resolution, OWNER_COLUMNS.notes, OWNER_COLUMNS.used, OWNER_COLUMNS.found, "VERIFIED (computed on ingest; leave empty)", "REJECTION_REASON (computed on ingest; leave empty)"]) expect(r[ix(c)], c).toBe(""); expect(r[ix("time_auto (computed: unknown unless both venues have a verified-valid timestamp)")]).toBe("unknown"); }
  });
  it("each row carries our market and outcome, the stored date-level end date (labelled as such), the venue's candidates with titles, similarity, outcomes, category, time fields, rule text and id, and the populations", () => {
    const r = t[1]; const g = (c: string) => r[h.indexOf(c)]; expect(g("src_title")).not.toBe(""); expect(g("src_outcome")).toBe("Yes"); expect(g("src_event_time (date only: markets.end_date)")).toBe("2026-10-05"); expect(g("src_url")).toMatch(/^https:\/\/polymarket\.com\/event\/s-/);
    expect(g("c1_title")).not.toBe(""); expect(Number(g("c1_similarity"))).toBeGreaterThanOrEqual(Number(g("c2_similarity"))); expect(g("c1_outcomes")).toBe("Yes / No"); expect(g("c1_category")).toContain("sports:basketball"); expect(g("c1_event_time_fields")).toBe("event.strike_date=2026-10-05T20:00:00Z"); expect(g("c1_rules_start")).toContain("Resolves Yes"); expect(g("c1_venue_id")).toMatch(/^m\d+$/); expect(g("c1_url")).toMatch(/^https:\/\/kalshi\.test\//);
    expect(g("venue")).toBe("kalshi"); expect(g("seed")).toBe(REVIEW_SEED); expect(g("unsearched_pairs")).toBe("12"); expect(g("unsearched_signals")).toBe("30"); expect(JSON.parse(g("population (do not edit)"))).toHaveLength(5);
  });
  it("the proposed flags are the code's: Y exactly when isProposed holds (identifier, or ≥ 0.70 with equal numbers and negations and a matching outcome)", () => {
    for (const r of t.slice(1)) { const key = r[h.indexOf("pair_key")]; const p = s.picked.find((x) => pairKey(x.row.pair) === key)!; p.row.diag!.top.forEach((c, i) => expect(r[h.indexOf(`c${i + 1}_proposed`)], key).toBe(isProposed(c) ? "Y" : "N")); }
    expect(PROPOSED_MIN_SIMILARITY).toBe(0.7); const hi = row(1, "≥ 0.90").diag!.top[0]; expect(isProposed(hi)).toBe(true); expect(isProposed(row(1, "0.30–0.50").diag!.top[0])).toBe(false); expect(isProposed(row(1, "0.50–0.70").diag!.top[0])).toBe(false); expect(isProposed(row(1, "0.70–0.90").diag!.top[0])).toBe(true);
  });
});

describe("isProposed", () => {
  const base = { identifierMatch: false, score: 0.7, numbersAgree: true, negationsAgree: true, outcomeMatch: true as boolean | null };
  it("exactly 0.70 is proposed; just below is not; each guard blocks; an identifier match always proposes", () => {
    expect(isProposed(base)).toBe(true); expect(isProposed({ ...base, score: 0.699 })).toBe(false); expect(isProposed({ ...base, numbersAgree: false })).toBe(false); expect(isProposed({ ...base, negationsAgree: false })).toBe(false); expect(isProposed({ ...base, outcomeMatch: false })).toBe(false); expect(isProposed({ ...base, outcomeMatch: null })).toBe(false);
    expect(isProposed({ ...base, score: 0.1, numbersAgree: false, negationsAgree: false, outcomeMatch: false, identifierMatch: true })).toBe(true);
  });
});

describe("the automatic TIME check", () => {
  it("unknown unless BOTH venues have a verified-valid timestamp; yes within the 15-minute tolerance (exactly 15 minutes agrees), no beyond it", () => {
    const t = Date.parse("2026-10-05T20:00:00Z"); expect(autoTime(null, t)).toBe("unknown"); expect(autoTime(t, null)).toBe("unknown"); expect(autoTime(null, null)).toBe("unknown"); expect(autoTime(NaN, t)).toBe("unknown");
    expect(autoTime(t, t)).toBe("yes"); expect(autoTime(t, t + 15 * 60_000)).toBe("yes"); expect(autoTime(t + 15 * 60_000, t)).toBe("yes"); expect(autoTime(t, t + 15 * 60_000 + 1)).toBe("no"); expect(autoTime(t, t, 0)).toBe("yes"); expect(autoTime(t, t + 1, 0)).toBe("no");
  });
});

// ───────── ingest
const STAMP = stampOf("docs/phase4/stop_rule.json", JSON.stringify({ approved: true })); const NOW = "2026-10-06T10:00:00.000Z";
type Fill = { q?: string; o?: string; t?: string; r?: string; used?: string; found?: string; timeAuto?: string };
/** Fill a sheet: `decide(rowIndex, band, proposedCandidate)` returns the owner's answers for that row. */
function fill(csv: string, decide: (i: number, band: string, h: Record<string, string>) => Fill): string {
  const t = parseCsv(csv); const h = t[0]; const ix = (c: string) => h.indexOf(c); const TA = "time_auto (computed: unknown unless both venues have a verified-valid timestamp)";
  return toCsv(h, t.slice(1).map((r, i) => { const f = decide(i, r[ix("band")], Object.fromEntries(h.map((c, k) => [c, r[k]]))); const out = [...r]; out[ix(OWNER_COLUMNS.question)] = f.q ?? "Y"; out[ix(OWNER_COLUMNS.outcome)] = f.o ?? "Y"; out[ix(OWNER_COLUMNS.time)] = f.t ?? "Y"; out[ix(OWNER_COLUMNS.resolution)] = f.r ?? "Y"; out[ix(OWNER_COLUMNS.used)] = f.used ?? ""; out[ix(OWNER_COLUMNS.found)] = f.found ?? ""; if (f.timeAuto) out[ix(TA)] = f.timeAuto; return out; }));
}
const sheet = (rows: TitleSearchRow[], n = 60, un = { pairs: 0, signals: 0 }) => reviewSheetCsv(buildReviewSample(rows, { venue: "kalshi", n }), { venue: "kalshi", unsearched: un });
const ok = (csv: string) => { const r = ingestReview(csv, { file: "f.csv", now: NOW, stopRule: STAMP }); if (!r.ok) throw new Error(r.errors.join("; ")); return r; };

describe("ingest: validation (nothing is computed from a bad sheet)", () => {
  const good = sheet(BIG);
  it("an unfilled sheet is rejected row by row, naming the row and the column", () => {
    const r = ingestReview(good, { file: "f", now: NOW, stopRule: STAMP }); expect(r.ok).toBe(false); if (!r.ok) { expect(r.errors[0]).toMatch(/^r\d{3}: QUESTION is empty/); expect(r.errors.length).toBeLessThanOrEqual(21); expect(r.errors.join("\n")).toContain("more errors not listed"); }
  });
  it("a missing answer in ONE row, an unknown value (yes, 1, X), and a column left out are each rejected", () => {
    const miss = fill(good, (i) => (i === 7 ? { t: "" } : {})); const a = ingestReview(miss, { file: "f", now: NOW, stopRule: STAMP }); expect(a).toMatchObject({ ok: false }); expect((a as any).errors).toEqual(["r008: TIME is empty (every row needs all four answers: Y, N or U)"]);
    for (const bad of ["yes", "1", "X", "Y/N", "maybe"]) { const r = ingestReview(fill(good, (i) => (i === 0 ? { r: bad } : {})), { file: "f", now: NOW, stopRule: STAMP }); expect(r.ok, bad).toBe(false); expect((r as any).errors[0]).toBe(`r001: RESOLUTION is "${bad}" (allowed: Y, N, U)`); }
    const noCol = toCsv(parseCsv(good)[0].filter((c) => c !== "RESOLUTION (Y/N/U)"), parseCsv(fill(good, () => ({}))).slice(1).map((r) => r.filter((_, k) => k !== parseCsv(good)[0].indexOf("RESOLUTION (Y/N/U)")))); const c = ingestReview(noCol, { file: "f", now: NOW, stopRule: STAMP }); expect(c).toMatchObject({ ok: false }); expect((c as any).errors[0]).toContain("columns missing: RESOLUTION (Y/N/U)");
  });
  it("lower-case y/n/u are accepted (spreadsheets); candidate_used must be 1, 2, 3, F or empty, and F needs a found_url", () => {
    expect(ingestReview(fill(good, () => ({ q: "y", o: "n", t: "u", r: "y" })), { file: "f", now: NOW, stopRule: STAMP }).ok).toBe(true);
    const bad = ingestReview(fill(good, (i) => (i === 2 ? { used: "4" } : i === 3 ? { used: "F" } : {})), { file: "f", now: NOW, stopRule: STAMP }); expect((bad as any).errors).toEqual(['r003: candidate_used is "4" (allowed: 1, 2, 3, or empty)'.replace("or empty", "F, or empty"), "r004: candidate_used is F but found_url is empty"]);
    expect(ingestReview(fill(good, (i) => (i === 3 ? { used: "f", found: "https://kalshi.test/x" } : {})), { file: "f", now: NOW, stopRule: STAMP }).ok).toBe(true);
  });
  it("a sheet whose population, venue or seed was edited is rejected; an empty or header-only file too", () => {
    const t = parseCsv(fill(good, () => ({}))); const h = t[0]; const edit = (col: string, v: string, row = 1) => toCsv(h, t.slice(1).map((r, i) => (i === row ? r.map((x, k) => (k === h.indexOf(col) ? v : x)) : r)));
    expect((ingestReview(edit("population (do not edit)", "[]"), { file: "f", now: NOW, stopRule: STAMP }) as any).errors.join()).toMatch(/population column differs/); expect((ingestReview(edit("seed", "other"), { file: "f", now: NOW, stopRule: STAMP }) as any).errors.join()).toMatch(/different seeds/); expect((ingestReview(edit("venue", "polymarket_us"), { file: "f", now: NOW, stopRule: STAMP }) as any).errors.join()).toMatch(/2 different venues/); expect((ingestReview(edit("band", "0.99"), { file: "f", now: NOW, stopRule: STAMP }) as any).errors.join()).toMatch(/not a similarity band/);
    expect((ingestReview("", { file: "f", now: NOW, stopRule: STAMP }) as any).errors[0]).toContain("no data rows"); expect((ingestReview(toCsv([...REVIEW_COLUMNS], []), { file: "f", now: NOW, stopRule: STAMP }) as any).errors[0]).toContain("no data rows");
  });
});

describe("ingest: what 'verified' means and what is computed", () => {
  const rows = BIG; const csv = sheet(rows);
  it("owner-confirmed needs all four Y; one N or U makes it not confirmed (unsure counts as not tradable); the reason names which", () => {
    const r = ok(fill(csv, (i) => ({ q: i === 0 ? "N" : "Y", o: i === 1 ? "U" : "Y", t: i === 2 ? "N" : "Y", r: i === 3 ? "U" : "Y" }))).results; expect(r.rows).toBe(60); expect(r.ownerConfirmed).toBe(56); expect(r.unsure).toBe(2);
    expect(r.perRow[0]).toMatchObject({ confirmed: false, reason: "QUESTION: no" }); expect(r.perRow[1].reason).toBe("OUTCOME: unsure (counts as not confirmed)"); expect(r.perRow[2].reason).toBe("TIME: no"); expect(r.perRow[3].reason).toBe("RESOLUTION: unsure (counts as not confirmed)");
    const multi = ok(fill(csv, (i) => (i === 0 ? { q: "N", r: "U" } : {}))).results.perRow[0]; expect(multi.reason).toBe("QUESTION: no; RESOLUTION: unsure (counts as not confirmed)");
  });
  it("VERIFIED (operational) additionally needs the AUTOMATIC time check to say yes: with 'unknown' (every sheet today) nothing is verified, however the owner answered, and the reason says so", () => {
    const r = ok(fill(csv, () => ({}))).results; expect(r.ownerConfirmed).toBe(60); expect(r.verifiedOperational).toBe(0); expect(r.timeAutoUnknown).toBe(60); expect(r.perRow.every((p) => p.confirmed && !p.verified)).toBe(true); expect(r.perRow[0].reason).toContain("TIME_AUTO unknown"); expect(r.perRow[0].reason).toContain("blocks verification");
    const v = ok(fill(csv, (i) => ({ timeAuto: i < 10 ? "yes" : i < 20 ? "no" : "unknown" }))).results; expect(v.verifiedOperational).toBe(10); expect(v.perRow[10].reason).toContain("TIME_AUTO no"); expect(v.perRow[0]).toMatchObject({ verified: true, reason: "" });
  });
  it("per band: Wilson intervals of the confirmed∧proposed share, of any confirmed pair, and the precision of the proposals — against hand-computed values", () => {
    // owner rule: in the ≥ 0.90 band 8 of 8 confirmed; 0.70–0.90: 8 of 11; 0.50–0.70: 3 of 11; 0.30–0.50: 0 of 15; < 0.30: 0 of 15
    const per: Record<string, number> = {}; const r = ok(fill(csv, (_, band) => { per[band] = (per[band] ?? 0) + 1; const yes = band === "≥ 0.90" ? per[band] <= 8 : band === "0.70–0.90" ? per[band] <= 8 : band === "0.50–0.70" ? per[band] <= 3 : false; return yes ? {} : { q: "N" }; })).results;
    const b = (n: string) => r.bands.find((x) => x.band === n)!; expect(b("≥ 0.90")).toMatchObject({ sampled: 8, confirmedAny: 8, confirmedProposed: 8, proposedRows: 8 }); expect(b("0.70–0.90")).toMatchObject({ sampled: 11, confirmedAny: 8, confirmedProposed: 8, proposedRows: 11 }); expect(b("0.50–0.70")).toMatchObject({ sampled: 11, confirmedAny: 3, confirmedProposed: 0, proposedRows: 0 });
    expect(b("0.70–0.90").jointProposed).toEqual(wilson(8, 11)); expect(b("0.70–0.90").precisionOfProposed).toEqual(wilson(8, 11)); expect(b("≥ 0.90").jointProposed!.lo).toBeCloseTo(0.6756, 3); expect(b("0.50–0.70").precisionOfProposed).toBeNull(); expect(b("0.50–0.70").anyConfirmed).toEqual(wilson(3, 11)); expect(b("< 0.30").anyConfirmed).toEqual(wilson(0, 15)); expect(b("< 0.30").anyConfirmed!.hi).toBeCloseTo(0.2039, 3);
    expect(r.falseNegatives).toMatchObject({ band: "< 0.30", sampled: 15, confirmed: 0 }); expect(wilson(8, 10)!.lo).toBeCloseTo(0.4902, 4); expect(wilson(8, 10)!.hi).toBeCloseTo(0.9433, 4);
  });
  it("the extrapolation is the band-weighted sum of the Wilson bounds, with the unsearched pairs as 0–100 % (point n/m), against a hand computation", () => {
    const r = ok(fill(sheet(BIG, 60, { pairs: 30, signals: 90 }), (_, band, row) => (band === "≥ 0.90" || (band === "0.70–0.90" && Number(row.src_signals ?? 1) >= 0) ? {} : { q: "N" }))).results; const e = r.extrapolation; const pop = r.bands; const tot = pop.reduce((a, b) => a + b.popSignals, 0) + 90; expect(e.totalSignals).toBe(tot); expect(e.totalPairs).toBe(253 + 30);
    let lo = 0, hi = 0; for (const b of pop) { const w = b.popSignals / tot; lo += w * b.jointProposed!.lo; hi += w * b.anyConfirmed!.hi; } hi += 90 / tot; expect(e.share.lo).toBeCloseTo(lo, 10); expect(e.share.hi).toBeCloseTo(hi, 10); expect(e.share.point).toBeNull(); expect(e.signals.lo).toBeCloseTo(lo * tot, 8); expect(e.signals.hi).toBeCloseTo(hi * tot, 8); expect(e.signals.point).toBeNull(); expect(e.pairs.point).toBeNull();
    expect(e.share.lo).toBeGreaterThan(0); expect(e.share.lo).toBeLessThan(e.share.hi); expect(e.basis).toContain("unsearched");
  });
  it("with nothing unsearched and every band reviewed there is a point estimate, between the bounds; all-yes: only the bands that HAVE a proposal count as proposed, but every confirmed pair counts in the upper bound; all-no: lower 0 and a small upper", () => {
    const r = ok(fill(csv, () => ({}))).results; const tot = r.bands.reduce((a, b) => a + b.popSignals, 0); const proposedBands = r.bands.filter((b) => b.band === "≥ 0.90" || b.band === "0.70–0.90"); const w = proposedBands.reduce((a, b) => a + b.popSignals, 0) / tot;
    expect(r.extrapolation.share.point).toBeCloseTo(w, 10); expect(r.extrapolation.share.hi).toBeCloseTo(r.bands.reduce((a, b) => a + (b.popSignals / tot) * b.anyConfirmed!.hi, 0), 10); expect(r.extrapolation.share.hi).toBeGreaterThan(0.9); expect(r.extrapolation.share.lo).toBeLessThan(w); expect(r.extrapolation.share.lo).toBeGreaterThan(0); expect(r.extrapolation.matcherMisses.point).toBeCloseTo(1 - w, 10);
    const n = ok(fill(csv, () => ({ q: "N" }))).results; expect(n.extrapolation.share).toMatchObject({ lo: 0, point: 0 }); expect(n.extrapolation.share.hi).toBeLessThan(0.3); expect(n.extrapolation.share.hi).toBeGreaterThan(0.05);
  });
  it("a confirmed pair the code did NOT propose (found by the owner, F) is a matcher miss: in the upper bound and the miss count, not in the lower bound", () => {
    const base = ok(fill(csv, (_, band) => (band === "< 0.30" ? { q: "N" } : { q: "N" }))).results; const miss = ok(fill(csv, (_, band) => (band === "< 0.30" ? { used: "F", found: "https://kalshi.test/found" } : { q: "N" }))).results;
    expect(miss.falseNegatives).toMatchObject({ confirmed: 15, sampled: 15 }); expect(miss.extrapolation.share.lo).toBe(base.extrapolation.share.lo); expect(miss.extrapolation.share.hi).toBeGreaterThan(base.extrapolation.share.hi); expect(miss.extrapolation.matcherMisses.hi).toBeGreaterThan(0); expect(miss.bands.find((b) => b.band === "< 0.30")!.confirmedProposed).toBe(0);
  });
  it("candidate_used decides which candidate the answers are about: an answer on a candidate the code did not propose is not 'proposed'", () => {
    const r = ok(fill(csv, (_, band) => (band === "≥ 0.90" ? { used: "2" } : {}))).results; expect(r.bands.find((b) => b.band === "≥ 0.90")).toMatchObject({ confirmedAny: 8, confirmedProposed: 0, proposedRows: 0 });
  });
  it("an unreviewed band (no rows sampled in it) has no interval: lower 0, upper full weight, point n/m", () => {
    const only = world({ "≥ 0.90": 6, "0.70–0.90": 6 }); const s = buildReviewSample(only, { venue: "kalshi", n: 60 }); const r = ok(fill(reviewSheetCsv(s, { venue: "kalshi" }).replace(/^/, ""), () => ({}))).results; expect(r.bands.map((b) => b.band)).toEqual(["≥ 0.90", "0.70–0.90"]); expect(r.extrapolation.share.point).toBeCloseTo(1, 10); // both bands have proposals, so all-yes is all proposed
    // population has bands with pairs but no sampled row only when the quota is 0: simulate with n = 1
    const one = ok(fill(reviewSheetCsv(buildReviewSample(BIG, { venue: "kalshi", n: 1 }), { venue: "kalshi" }), () => ({}))).results; expect(one.rows).toBe(2); const unrev = one.bands.filter((b) => b.sampled === 0); expect(unrev.length).toBeGreaterThan(0); for (const b of unrev) { expect(b.jointProposed).toBeNull(); expect(b.anyConfirmed).toBeNull(); } expect(one.extrapolation.share.point).toBeNull(); expect(one.extrapolation.share.hi).toBeGreaterThan(0.9);
  });
  it("records the stop rule's hash and approval at ingest time, the file name, the seed and the time; the result CSV has VERIFIED and REJECTION_REASON per row", () => {
    const out = ok(fill(csv, () => ({}))); expect(out.results).toMatchObject({ kind: "review", venue: "kalshi", file: "f.csv", ingestedAt: NOW, seed: REVIEW_SEED, stopRule: STAMP }); const t = parseCsv(out.csv); expect(t[0]).toEqual(["row_id", "pair_key", "band", "stratum", "owner_confirmed", "proposed_by_code", "VERIFIED", "REJECTION_REASON"]); expect(t).toHaveLength(61); expect(t[1][6]).toBe("N"); expect(t[1][7]).toContain("TIME_AUTO unknown");
  });
  it("the printed summary is at most 40 lines and carries the research caveat", () => { const L = ingestLines(ok(fill(csv, () => ({}))).results as ReviewResults); expect(L.length).toBeLessThanOrEqual(40); expect(L.join("\n")).toContain("not a decision"); expect(L.join("\n")).toContain("VERIFIED (operational"); expect(Math.max(...L.map((l) => l.length))).toBeLessThanOrEqual(220); });
});
