/**
 * Phase 4.1 — the job's database access. The ONLY table this module writes is `shadow_books` (insert-if-absent and bounded deletes); it reads
 * `signals` and `shadow_books`. Everything is bounded: a window of at most LOOKBACK_S, pages of PAGE_SIZE, deletes of PRUNE_BATCH.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectIn } from "../../chunk";
import { LOOKBACK_S, MAX_PAGES, PAGE_SIZE } from "./config";
import { rowKey, type SignalLite } from "./schedule";
import type { ShadowRow } from "./snapshot";

const fail = (what: string, e: unknown): never => { throw new Error(`shadow books: ${what}: ${(e as { message?: string })?.message ?? String(e)}`); };
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const toSignal = (r: Record<string, any>): SignalLite => ({ id: r.id, tokenId: r.token_id, kind: r.kind, price: r.price === null || r.price === undefined ? null : Number(r.price), createdAtSec: Math.floor(Date.parse(r.created_at) / 1000), copyScore: typeof r.payload?.copyScore === "number" ? r.payload.copyScore : null });

/**
 * Entry signals created in the last LOOKBACK_S seconds, oldest first, in pages; `enough` is asked after each page so that paging stops as soon as the
 * cycle has all the work it can do (later pages are newer, so they could only be less urgent). At most MAX_PAGES × PAGE_SIZE signals are ever held.
 */
export async function loadWindow(db: SupabaseClient, nowSec: number, enough: (signals: SignalLite[]) => boolean, lookbackS = LOOKBACK_S): Promise<SignalLite[]> {
  const out: SignalLite[] = []; const seen = new Set<string>(); let from = iso(nowSec - lookbackS);
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await db.from("signals").select("id,kind,token_id,price,created_at,payload").gte("created_at", from).lte("created_at", iso(nowSec)).neq("kind", "EXIT").order("created_at", { ascending: true }).order("id", { ascending: true }).limit(PAGE_SIZE);
    if (error) fail("reading signals", error);
    const rows = (data ?? []) as Record<string, any>[]; let fresh = 0;
    for (const r of rows) { if (seen.has(r.id)) continue; seen.add(r.id); out.push(toSignal(r)); fresh++; }
    if (rows.length < PAGE_SIZE || fresh === 0 || enough(out)) break;
    from = rows[rows.length - 1].created_at;
  }
  return out;
}

/** Keys (`signal:offset`) of the rows that already exist for these signals. */
export async function existingKeys(db: SupabaseClient, signalIds: string[]): Promise<Set<string>> {
  if (!signalIds.length) return new Set();
  const rows = await selectIn<{ signal_id: string; offset_s: number }>(signalIds, (chunk) => db.from("shadow_books").select("signal_id,offset_s").in("signal_id", chunk as string[]));
  return new Set(rows.map((r) => rowKey(r.signal_id, r.offset_s)));
}

/** Insert rows that do not exist yet; a row that already exists is left untouched (idempotent). */
export async function insertRows(db: SupabaseClient, rows: ShadowRow[]): Promise<void> {
  if (!rows.length) return;
  const { error } = await db.from("shadow_books").upsert(rows, { onConflict: "signal_id,offset_s", ignoreDuplicates: true });
  if (error) fail("writing shadow_books", error);
}

/** Requests spent since `sinceIso` (the start of the UTC day), from the rows themselves: restart-safe. Read in pages of 1,000; only a running sum is kept. */
export async function requestsSince(db: SupabaseClient, sinceIso: string): Promise<number> {
  let sum = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("shadow_books").select("request_count").gte("taken_at", sinceIso).order("taken_at", { ascending: true }).order("signal_id", { ascending: true }).order("offset_s", { ascending: true }).range(from, from + 999);
    if (error) fail("reading the daily request count", error);
    const rows = (data ?? []) as { request_count: number }[]; for (const r of rows) sum += Number(r.request_count) || 0;
    if (rows.length < 1000) return sum;
    if (from > 1_000_000) fail("reading the daily request count", "more than a million rows in one day");
  }
}

/** One bounded delete of rows due before `cutoffIso`: at most `batch` rows are selected and removed. Returns the number of rows selected (0 = nothing left). */
export async function pruneBatch(db: SupabaseClient, cutoffIso: string, batch: number): Promise<number> {
  const { data, error } = await db.from("shadow_books").select("signal_id,offset_s").lt("due_at", cutoffIso).order("due_at", { ascending: true }).limit(batch);
  if (error) fail("selecting rows to prune", error);
  const rows = (data ?? []) as { signal_id: string; offset_s: number }[]; if (!rows.length) return 0;
  const ids = [...new Set(rows.map((r) => r.signal_id))];
  const { error: e2 } = await db.from("shadow_books").delete().in("signal_id", ids).lt("due_at", cutoffIso);
  if (e2) fail("pruning shadow_books", e2);
  return rows.length;
}
