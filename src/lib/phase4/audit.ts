/**
 * Phase 4.0 (S1a) — analysis of the time fields found on venue market objects (docs/PHASE4_PLAN.md §7 S1a, §3.3).
 * Pure: it takes already-fetched market objects and returns plain JSON. It decides nothing about trading; it produces
 * the evidence from which the owner fills §3.3's two slots with concrete field names or marks them unusable.
 *
 * Method, in one paragraph: flatten every market (and nested event) object to dotted paths; a path is "time-like" when
 * its value looks like a date or datetime (or a plausible epoch number under a time-like name); for every such path
 * inventory the format, precision, offset, presence by stratum and placeholder shapes; then, per stratum, measure how
 * each candidate field is ordered against the other fields and against the venue's own resolution/closure timestamps
 * (and ours), and apply the explicit, exported RECOMMEND_RULES to propose a field per slot or "unreliable: reject".
 */
import { categorize, stratum } from "./categorize";
import { classifyFieldName, parseTimestamp, placeholderKind, repeatedInstants, timeOfDayProfile, type FieldRole, type PlaceholderKind, type RepeatedInstant } from "./timestamps";
import { quantile } from "./stats";

export type RawMarket = Record<string, unknown>;
export interface AuditMarket {
  venue: string; id: string;
  /** Stratum label: `sports:basketball`, `esports`, `crypto_short_term`, `politics`, `culture_other`, … */
  stratum: string;
  /** Closed / resolved on the venue (the caller decides from the venue's own status fields). */
  resolved: boolean;
  /** Event or title family: markets of one event legitimately share times. */
  group: string;
  flat: Record<string, unknown>;
  /** Our own observed on-chain resolution time (UTC ms) when known (international venue, via token_resolutions). */
  ourResolutionMs?: number | null;
}

// ───────────────────────────────────────────── flattening ─────────────────────────────────────────────────

/** Dotted paths to scalar leaves. Arrays of objects contribute their FIRST element under `path[]`; scalar arrays are skipped. Depth and size bounded. */
export function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  if (depth > 4 || obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) { const first = obj.find((x) => x && typeof x === "object" && !Array.isArray(x)); if (first) flatten(first, `${prefix}[]`, out, depth + 1); return out; }
  if (typeof obj === "object") { for (const [k, v] of Object.entries(obj as Record<string, unknown>)) { const p = prefix ? `${prefix}.${k}` : k; if (v !== null && typeof v === "object") flatten(v, p, out, depth + 1); else out[p] = v; } return out; }
  out[prefix] = obj; return out;
}

const DATEISH = /^\d{4}-\d{2}-\d{2}/;
/** A path/value pair is time-like if the value starts like a date, or is a plausible epoch number under a name that is not a plain non-time name. */
export function isTimeLike(path: string, value: unknown): boolean {
  if (typeof value === "string") return DATEISH.test(value.trim());
  if (typeof value === "number") { const role = classifyFieldName(path); return role !== "NOT_TIME" && parseTimestamp(value).kind === "epoch"; }
  return false;
}

export type FormatLabel = "date_only" | "datetime_utc" | "datetime_offset" | "datetime_lenient" | "datetime_no_offset" | "epoch_s" | "epoch_ms" | "invalid";
export function formatOf(raw: unknown): FormatLabel {
  const p = parseTimestamp(raw);
  switch (p.kind) {
    case "date_only": return "date_only"; case "no_offset": return "datetime_no_offset"; case "invalid": case "missing": return "invalid";
    case "epoch": return p.unit === "s" ? "epoch_s" : "epoch_ms";
    case "datetime": return p.format === "lenient" ? "datetime_lenient" : p.offsetMinutes === 0 ? "datetime_utc" : "datetime_offset";
  }
}
/** The instant of a value when it carries a time of day and a zone (datetime or epoch); null for date-only, offset-less and invalid values. */
export function instantOf(raw: unknown): number | null { const p = parseTimestamp(raw); return p.kind === "datetime" || p.kind === "epoch" ? p.ms : null; }

// ───────────────────────────────────────────── inventory ──────────────────────────────────────────────────

export interface StratumPresence { present: number; total: number; rate: number }
export interface FieldInventory {
  path: string; role: FieldRole;
  presence: { overall: StratumPresence; byStratum: Record<string, StratumPresence> };
  formats: Partial<Record<FormatLabel, number>>;
  precision: { minute: number; second: number; fraction: number };
  offsets: Record<string, number>;
  placeholders: Partial<Record<PlaceholderKind, number>>;
  /** Share of present values (any format) that are a placeholder shape (date-only, midnight, noon or end-of-day) */
  placeholderShare: number;
  timeOfDay: { datetime: number; dateOnly: number; topClocks: { clock: string; count: number; share: number }[] };
  repeated: RepeatedInstant[];
  examples: string[];
}

const share = (a: number, b: number) => (b ? a / b : 0);
export function buildInventory(markets: AuditMarket[]): FieldInventory[] {
  const totals = new Map<string, number>(); for (const m of markets) totals.set(m.stratum, (totals.get(m.stratum) ?? 0) + 1);
  const paths = new Map<string, { m: AuditMarket; v: unknown }[]>();
  for (const m of markets) for (const [p, v] of Object.entries(m.flat)) if (isTimeLike(p, v)) { const a = paths.get(p); if (a) a.push({ m, v }); else paths.set(p, [{ m, v }]); }
  const out: FieldInventory[] = [];
  for (const [path, rows] of [...paths.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const bySt: Record<string, number> = {}; for (const r of rows) bySt[r.m.stratum] = (bySt[r.m.stratum] ?? 0) + 1;
    const byStratum: Record<string, StratumPresence> = {}; for (const [st, tot] of [...totals.entries()].sort()) byStratum[st] = { present: bySt[st] ?? 0, total: tot, rate: share(bySt[st] ?? 0, tot) };
    const formats: FieldInventory["formats"] = {}; const precision = { minute: 0, second: 0, fraction: 0 }; const offsets: Record<string, number> = {}; const placeholders: FieldInventory["placeholders"] = {};
    let ph = 0;
    for (const { v } of rows) {
      const f = formatOf(v); formats[f] = (formats[f] ?? 0) + 1;
      const p = parseTimestamp(v);
      if (p.kind === "datetime") { precision[p.precision]++; const o = p.offsetMinutes; const key = o === 0 ? "+00:00" : `${o < 0 ? "-" : "+"}${String(Math.floor(Math.abs(o) / 60)).padStart(2, "0")}:${String(Math.abs(o) % 60).padStart(2, "0")}`; offsets[key] = (offsets[key] ?? 0) + 1; }
      const k = placeholderKind(v); if (k) { placeholders[k] = (placeholders[k] ?? 0) + 1; ph++; }
    }
    const prof = timeOfDayProfile(rows.map((r) => r.v));
    out.push({
      path, role: classifyFieldName(path), presence: { overall: { present: rows.length, total: markets.length, rate: share(rows.length, markets.length) }, byStratum },
      formats, precision, offsets, placeholders, placeholderShare: share(ph, rows.length),
      timeOfDay: { datetime: prof.datetime, dateOnly: prof.dateOnly, topClocks: prof.byClock.slice(0, 5) },
      repeated: repeatedInstants(rows.map((r) => ({ group: r.m.group, raw: r.v }))).slice(0, 10),
      examples: [...new Set(rows.slice(0, 40).map((r) => String(r.v)))].slice(0, 3),
    });
  }
  return out;
}

// ───────────────────────────────────────────── relations between fields ───────────────────────────────────

export interface Relation { n: number; before: number; equal: number; after: number; p10Min: number | null; p50Min: number | null; p90Min: number | null; within1hShare: number | null }
/** Signed difference B − A in minutes over the markets where BOTH are instants. `before` = A is earlier than B. */
export function relation(pairs: { a: number; b: number }[]): Relation {
  const d = pairs.map((p) => (p.b - p.a) / 60_000);
  const q = (p: number) => { const x = quantile(d, p); return x === null ? null : Math.round(x * 10) / 10; };
  return { n: d.length, before: d.filter((x) => x > 0).length, equal: d.filter((x) => x === 0).length, after: d.filter((x) => x < 0).length, p10Min: q(0.1), p50Min: q(0.5), p90Min: q(0.9), within1hShare: d.length ? d.filter((x) => Math.abs(x) <= 60).length / d.length : null };
}
const pairsOf = (ms: AuditMarket[], a: string, b: string) => ms.flatMap((m) => { const x = instantOf(m.flat[a]), y = instantOf(m.flat[b]); return x !== null && y !== null ? [{ a: x, b: y }] : []; });

export interface ResolutionReference { name: string; get: (m: AuditMarket) => number | null }
/** The references a candidate is compared with for RESOLVED markets: every RESOLUTION_LIKE field the venue provides, and our observed resolution time when known. */
export function resolutionReferences(inv: FieldInventory[]): ResolutionReference[] {
  const refs: ResolutionReference[] = inv.filter((f) => f.role === "RESOLUTION_LIKE").map((f) => ({ name: f.path, get: (m: AuditMarket) => instantOf(m.flat[f.path]) }));
  refs.push({ name: "ours:token_resolutions.resolved_ts", get: (m) => m.ourResolutionMs ?? null });
  return refs;
}

export interface CandidateEvidence {
  path: string; role: FieldRole;
  /** Candidate versus each reference: candidate earlier than the reference ⇒ `before`. Resolved markets only. */
  vsReference: Record<string, Relation>;
  /** Candidate versus every other candidate field (ordering, disagreement), all markets of the stratum. */
  vsField: Record<string, Relation>;
}
export function candidateEvidence(ms: AuditMarket[], inv: FieldInventory[]): CandidateEvidence[] {
  const resolved = ms.filter((m) => m.resolved); const refs = resolutionReferences(inv);
  const cands = inv.filter((f) => f.role === "START_LIKE" || f.role === "CLOSE_LIKE" || f.role === "OTHER_TIME");
  return cands.map((c) => {
    const vsReference: Record<string, Relation> = {}; for (const r of refs) { const pairs = resolved.flatMap((m) => { const x = instantOf(m.flat[c.path]), y = r.get(m); return x !== null && y !== null ? [{ a: x, b: y }] : []; }); if (pairs.length) vsReference[r.name] = relation(pairs); }
    const vsField: Record<string, Relation> = {}; for (const o of cands) { if (o.path === c.path) continue; const pairs = pairsOf(ms, c.path, o.path); if (pairs.length) vsField[o.path] = relation(pairs); }
    return { path: c.path, role: c.role, vsReference, vsField };
  });
}

// ───────────────────────────────────────────── recommendation rules ───────────────────────────────────────

/**
 * PROPOSED thresholds (not decisions): the owner may change them, the output prints them next to every verdict.
 * A field is recommended for a slot only when ALL of its rules hold in a stratum; otherwise "unreliable: reject"
 * (enough data, a rule failed) or "insufficient data" (fewer than `minPresent` markets carry it).
 */
export const RECOMMEND_RULES = {
  minPresent: 30,
  minUsableShare: 0.9,          // share of the stratum's markets with a datetime (time of day and zone) that is not a placeholder shape
  maxPlaceholderShare: 0.1,     // share of present values that are date-only / 00:00:00 / 12:00:00 / 23:59:59 UTC
  maxTopClockShare: 0.5,        // no single UTC time of day may hold more than this share of the values (a hidden placeholder)
  minOrderedShare: 0.99,        // slot 1: start ≤ the earliest reference (resolution/closure) in at least this share of resolved markets
  minOrderedSamples: 30,
  startToleranceVsCloseMin: 15, // slot 1: start ≤ close + tolerance in at least minStartBeforeCloseShare of markets with both
  minStartBeforeCloseShare: 0.95,
  maxCreationCoincidenceShare: 0.5, // slot 1: the field must not coincide (within `creationCoincidenceMin` minutes) with a creation-like field in more than this share of markets: that is a listing time, not an event start
  creationCoincidenceMin: 60,
  eventTypeMaxMedianGapHours: 24, // slot 1, event-type strata (sports, esports, short-term crypto): the median distance from start to resolution is at most this (events last hours)
} as const;
const EVENT_TYPE = (st: string) => st.startsWith("sports") || st === "esports" || st === "crypto_short_term";

export type Verdict = "RECOMMEND" | "UNRELIABLE_REJECT" | "INSUFFICIENT_DATA";
export interface SlotVerdict { slot: 1 | 2; stratum: string; venue: string; field: string | null; verdict: Verdict; usableShare: number | null; presentShare: number | null; placeholderShare: number | null; failed: string[]; evidence: Record<string, number | string | null>; needsHumanReview: boolean }

const earliestRefMs = (m: AuditMarket, refs: ResolutionReference[]): number | null => { const v = refs.map((r) => r.get(m)).filter((x): x is number => x !== null); return v.length ? Math.min(...v) : null; };

/** The best candidate per slot per stratum, with every rule's outcome. */
export function recommendSlots(venue: string, ms: AuditMarket[], inv: FieldInventory[], rules: Partial<Record<keyof typeof RECOMMEND_RULES, number>> = {}): SlotVerdict[] {
  const R = { ...RECOMMEND_RULES, ...rules } as Record<keyof typeof RECOMMEND_RULES, number>; const refs = resolutionReferences(inv); const out: SlotVerdict[] = [];
  for (const st of [...new Set(ms.map((m) => m.stratum))].sort()) {
    const sm = ms.filter((m) => m.stratum === st);
    for (const slot of [1, 2] as const) {
      const role: FieldRole = slot === 1 ? "START_LIKE" : "CLOSE_LIKE";
      const cands = inv.filter((f) => f.role === role);
      if (!cands.length) { out.push({ venue, stratum: st, slot, field: null, verdict: "UNRELIABLE_REJECT", usableShare: null, presentShare: null, placeholderShare: null, failed: [`no ${role} field exists on the venue's objects`], evidence: {}, needsHumanReview: false }); continue; }
      const scored = cands.map((f) => {
        const vals = sm.map((m) => m.flat[f.path]).filter((v) => v !== undefined && v !== null && v !== "");
        const usable = vals.filter((v) => { const p = parseTimestamp(v); return (p.kind === "datetime") && !placeholderKind(v); }).length;
        const phs = vals.filter((v) => placeholderKind(v) !== null).length; const prof = timeOfDayProfile(vals);
        const topClock = prof.byClock[0]?.share ?? 0;
        const failed: string[] = []; let gap: string | null = null; const evidence: SlotVerdict["evidence"] = { present: vals.length, stratumMarkets: sm.length, topClock: prof.byClock[0]?.clock ?? null, topClockShare: Math.round(topClock * 1000) / 1000, lenientFormatShare: Math.round(share(vals.filter((v) => formatOf(v) === "datetime_lenient").length, vals.length) * 1000) / 1000 };
        if (vals.length < R.minPresent) return { f, failed: [`present on ${vals.length} < ${R.minPresent} markets`], insufficient: true, usable, vals, phs, evidence };
        if (share(usable, sm.length) < R.minUsableShare) failed.push(`usable share ${(share(usable, sm.length) * 100).toFixed(1)} % < ${R.minUsableShare * 100} %`);
        if (share(phs, vals.length) > R.maxPlaceholderShare) failed.push(`placeholder share ${(share(phs, vals.length) * 100).toFixed(1)} % > ${R.maxPlaceholderShare * 100} %`);
        if (topClock > R.maxTopClockShare && vals.length >= R.minPresent) failed.push(`one time of day (${prof.byClock[0]?.clock}) holds ${(topClock * 100).toFixed(0)} % of values > ${R.maxTopClockShare * 100} %`);
        if (slot === 1) {
          const resolved = sm.filter((m) => m.resolved);
          const ord = resolved.flatMap((m) => { const a = instantOf(m.flat[f.path]), r = earliestRefMs(m, refs); return a !== null && r !== null ? [{ a, r }] : []; });
          if (ord.length >= R.minOrderedSamples) { const okShare = share(ord.filter((x) => x.a <= x.r).length, ord.length); evidence.startNotAfterResolutionShare = Math.round(okShare * 1000) / 1000; evidence.orderedSamples = ord.length; if (okShare < R.minOrderedShare) failed.push(`start ≤ resolution in ${(okShare * 100).toFixed(1)} % < ${R.minOrderedShare * 100} % of ${ord.length} resolved markets`); if (EVENT_TYPE(st)) { const gaps = ord.map((x) => (x.r - x.a) / 3_600_000); const med = quantile(gaps, 0.5)!; evidence.medianStartToResolutionHours = Math.round(med * 10) / 10; if (med > R.eventTypeMaxMedianGapHours) failed.push(`median start→resolution ${med.toFixed(1)} h > ${R.eventTypeMaxMedianGapHours} h: looks like a listing time, not an event start`); } }
          else { evidence.orderedSamples = ord.length; gap = `only ${ord.length} resolved markets with a reference time (< ${R.minOrderedSamples}): meaning not established`; }
          // a start-like field that coincides with a creation-like field is a listing time
          let coincide = 0; for (const cf of inv.filter((x) => x.role === "CREATION_LIKE")) { const prs = pairsOf(sm, f.path, cf.path); if (prs.length >= R.minPresent) coincide = Math.max(coincide, share(prs.filter((x) => Math.abs(x.b - x.a) <= R.creationCoincidenceMin * 60_000).length, prs.length)); }
          evidence.coincidesWithCreationShare = Math.round(coincide * 1000) / 1000;
          if (coincide > R.maxCreationCoincidenceShare) failed.push(`${(coincide * 100).toFixed(0)} % of values are within ${R.creationCoincidenceMin} min of a creation-like field: a listing time, not an event start`);
          // compare with close-like fields only where THAT field carries a real time of day: a placeholder close (midnight of the event date) would precede almost every kick-off
          for (const c2 of inv.filter((x) => x.role === "CLOSE_LIKE")) { const prs = sm.flatMap((m) => { const a = instantOf(m.flat[f.path]), b = instantOf(m.flat[c2.path]); return a !== null && b !== null && !placeholderKind(m.flat[c2.path]) ? [{ a, b }] : []; }); if (prs.length >= R.minPresent) { const okc = share(prs.filter((x) => x.a <= x.b + R.startToleranceVsCloseMin * 60_000).length, prs.length); evidence[`startNotAfter(${c2.path})`] = Math.round(okc * 1000) / 1000; if (okc < R.minStartBeforeCloseShare) failed.push(`start ≤ ${c2.path} (+${R.startToleranceVsCloseMin} min) in ${(okc * 100).toFixed(1)} % < ${R.minStartBeforeCloseShare * 100} %`); } }
        }
        if (!failed.length && gap) return { f, failed: [gap], insufficient: true, usable, vals, phs, evidence };
        return { f, failed, insufficient: false, usable, vals, phs, evidence };
      });
      const ok = scored.filter((s) => !s.insufficient && !s.failed.length).sort((a, b) => b.usable - a.usable || (a.f.path < b.f.path ? -1 : 1));
      const pick = ok[0] ?? [...scored].sort((a, b) => Number(a.insufficient) - Number(b.insufficient) || a.failed.length - b.failed.length || b.usable - a.usable || (a.f.path < b.f.path ? -1 : 1))[0];
      const verdict: Verdict = ok[0] ? "RECOMMEND" : pick.insufficient ? "INSUFFICIENT_DATA" : "UNRELIABLE_REJECT";
      out.push({ venue, stratum: st, slot, field: pick.f.path, verdict, usableShare: Math.round(share(pick.usable, sm.length) * 1000) / 1000, presentShare: Math.round(share(pick.vals.length, sm.length) * 1000) / 1000, placeholderShare: pick.vals.length ? Math.round(share(pick.phs, pick.vals.length) * 1000) / 1000 : null, failed: pick.failed, evidence: pick.evidence,
        // slot 2 has no ordering rule that can be asserted without evidence of what the venue's deadline means: a human reads the relations
        needsHumanReview: slot === 2 && verdict === "RECOMMEND" });
    }
  }
  return out;
}

// ───────────────────────────────────────────── venue agreement (D51 input) ────────────────────────────────

export interface VenueDiffSummary { stratum: string; n: number; absP50Min: number | null; absP90Min: number | null; absP95Min: number | null; absP99Min: number | null; maxAbsMin: number | null; within15MinShare: number | null; within60MinShare: number | null; signedP50Min: number | null }
/** Start-time disagreement between the two venues for matched events (UTC ms each), by stratum. Input to D51 (TIMESTAMP_TOLERANCE, proposed 15 min). */
export function compareVenues(pairs: { stratum: string; aMs: number; bMs: number }[]): VenueDiffSummary[] {
  const by = new Map<string, number[]>(); for (const p of pairs) { const a = by.get(p.stratum) ?? []; a.push((p.bMs - p.aMs) / 60_000); by.set(p.stratum, a); }
  const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([st, d]) => { const abs = d.map(Math.abs); return { stratum: st, n: d.length, absP50Min: r1(quantile(abs, 0.5)), absP90Min: r1(quantile(abs, 0.9)), absP95Min: r1(quantile(abs, 0.95)), absP99Min: r1(quantile(abs, 0.99)), maxAbsMin: r1(Math.max(...abs)), within15MinShare: abs.filter((x) => x <= 15).length / abs.length, within60MinShare: abs.filter((x) => x <= 60).length / abs.length, signedP50Min: r1(quantile(d, 0.5)) }; });
}

// ───────────────────────────────────────────── building the sample ────────────────────────────────────────

/** Turn raw venue market objects into AuditMarkets. `isResolved` and `idOf` are venue-specific and supplied by the caller (the audit records which fields it used). */
export function toAuditMarkets(venue: string, raws: RawMarket[], o: { idOf: (m: RawMarket) => string; isResolved: (m: RawMarket) => boolean; titleOf: (m: RawMarket) => string | null; slugOf: (m: RawMarket) => string | null; tagsOf?: (m: RawMarket) => string[]; groupOf?: (m: RawMarket) => string; ourResolutionMs?: (m: RawMarket) => number | null }): AuditMarket[] {
  return raws.map((raw) => {
    const title = o.titleOf(raw), slug = o.slugOf(raw);
    return { venue, id: o.idOf(raw), stratum: stratum(categorize({ title, slug, tags: o.tagsOf?.(raw) })), resolved: o.isResolved(raw), group: o.groupOf?.(raw) ?? (slug ?? title ?? o.idOf(raw)), flat: flatten(raw), ourResolutionMs: o.ourResolutionMs?.(raw) ?? null };
  });
}

/**
 * Round-robin over the strata (in order of first appearance, items in input order): one market from each stratum in turn, at
 * most `perStratum` per stratum, until `total` markets are chosen; then, if the per-stratum cap kept it below `total`, fill
 * from what is left in input order. Never returns more than `total`; deterministic.
 */
export function stratifiedSample<T extends { stratum: string }>(items: T[], perStratum: number, total: number): T[] {
  const groups = new Map<string, T[]>(); for (const it of items) { const g = groups.get(it.stratum); if (g) g.push(it); else groups.set(it.stratum, [it]); }
  const out: T[] = []; const used = new Set<T>();
  for (let round = 0; round < perStratum && out.length < total; round++) for (const g of groups.values()) { if (out.length >= total) break; if (round < g.length) { out.push(g[round]); used.add(g[round]); } }
  for (const it of items) { if (out.length >= total) break; if (!used.has(it)) { used.add(it); out.push(it); } }
  return out;
}
