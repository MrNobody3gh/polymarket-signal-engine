/** Supabase reads for analytics/dashboard/bot. Server-side only. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarkLite, PaperRowLite } from "./analytics";
import { selectIn } from "../chunk";
export async function loadPaper(db: SupabaseClient, o: { sinceIso?: string; wallet?: string; limit?: number } = {}): Promise<{ rows: PaperRowLite[]; marks: MarkLite[] }> {
  let q = db.from("paper_ledger").select("signal_id,wallet,wallet_name,kind,token_id,title,outcome,signal_ts,entry_price,shares,size_usd,copy_score,consensus_depth,status,final_pnl,final_return").order("signal_ts", { ascending: false }).limit(o.limit ?? 5000);
  if (o.sinceIso) q = q.gte("signal_ts", o.sinceIso); if (o.wallet) q = q.eq("wallet", o.wallet);
  const { data: rows, error } = await q; if (error) throw new Error(`paper_ledger query failed: ${error.message}`);
  const ids = (rows ?? []).map((r) => r.signal_id);
  const marks = await selectIn<MarkLite>(ids, (c) => db.from("paper_marks").select("signal_id,horizon,observed_at,price,pnl,return_pct").in("signal_id", c as string[]));
  return { rows: ((rows ?? []) as unknown as PaperRowLite[]).map((r) => ({ ...r, entry_price: Number(r.entry_price), shares: r.shares == null ? null : Number(r.shares), size_usd: Number(r.size_usd) })), marks: marks.map((m) => ({ ...m, price: Number(m.price), pnl: Number(m.pnl), return_pct: Number(m.return_pct) })) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmtUuid = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
/** Pure: the inclusive uuid range covering every id that starts with `prefix` (dashes optional), or null when the input
 *  cannot be a uuid prefix. Postgres has no LIKE/ILIKE on uuid, but uuid ordering is byte order = hex order, so a prefix
 *  match is exactly `id BETWEEN <prefix>000… AND <prefix>fff…` (and can use the primary-key index). */
export function uuidPrefixRange(prefix: string): { lo: string; hi: string } | null {
  const t = prefix.trim().toLowerCase(); if (!/^[0-9a-f-]+$/.test(t)) return null;
  const hex = t.replace(/-/g, ""); if (!hex.length || hex.length > 32) return null;
  return { lo: fmtUuid(hex.padEnd(32, "0")), hi: fmtUuid(hex.padEnd(32, "f")) };
}

export async function loadSignalDetail(db: SupabaseClient, idOrPrefix: string) {
  const none = (ambiguous = false) => ({ row: null, marks: [], consensus: null, ambiguous });
  const input = idOrPrefix.trim(); const isFull = UUID_RE.test(input);
  const range = isFull ? null : uuidPrefixRange(input); if (!isFull && !range) return none();
  const q = db.from("paper_ledger").select("*");
  const { data, error } = isFull ? await q.eq("signal_id", input.toLowerCase()).limit(1) : await q.gte("signal_id", range!.lo).lte("signal_id", range!.hi).order("signal_id").limit(2);
  if (error) throw new Error(`paper_ledger lookup failed: ${error.message}`); // a failed query is an error, never "no record"
  if (!data?.length) return none(); if (data.length > 1) return none(true);
  const row = data[0];
  const [{ data: marks }, { data: cons }] = await Promise.all([db.from("paper_marks").select("*").eq("signal_id", row.signal_id).order("observed_at"), db.from("consensus_events").select("*").eq("signal_id", row.signal_id).maybeSingle()]);
  return { row, marks: marks ?? [], consensus: cons, ambiguous: false };
}
