/** Supabase reads for analytics/dashboard/bot. Server-side only. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarkLite, PaperRowLite } from "./analytics";
export async function loadPaper(db: SupabaseClient, o: { sinceIso?: string; wallet?: string; limit?: number } = {}): Promise<{ rows: PaperRowLite[]; marks: MarkLite[] }> {
  let q = db.from("paper_ledger").select("signal_id,wallet,wallet_name,kind,token_id,title,outcome,signal_ts,entry_price,shares,size_usd,copy_score,consensus_depth,status,final_pnl,final_return").order("signal_ts", { ascending: false }).limit(o.limit ?? 5000);
  if (o.sinceIso) q = q.gte("signal_ts", o.sinceIso); if (o.wallet) q = q.eq("wallet", o.wallet);
  const { data: rows } = await q; const ids = (rows ?? []).map((r) => r.signal_id);
  const marks: MarkLite[] = [];
  for (let i = 0; i < ids.length; i += 500) { const { data } = await db.from("paper_marks").select("signal_id,horizon,observed_at,price,pnl,return_pct").in("signal_id", ids.slice(i, i + 500)); marks.push(...((data ?? []) as MarkLite[])); }
  return { rows: ((rows ?? []) as unknown as PaperRowLite[]).map((r) => ({ ...r, entry_price: Number(r.entry_price), shares: r.shares == null ? null : Number(r.shares), size_usd: Number(r.size_usd) })), marks: marks.map((m) => ({ ...m, price: Number(m.price), pnl: Number(m.pnl), return_pct: Number(m.return_pct) })) };
}
export async function loadSignalDetail(db: SupabaseClient, idOrPrefix: string) {
  const q = db.from("paper_ledger").select("*"); const isFull = /^[0-9a-f-]{36}$/i.test(idOrPrefix);
  const { data } = isFull ? await q.eq("signal_id", idOrPrefix).limit(1) : await q.ilike("signal_id", `${idOrPrefix.toLowerCase()}%`).limit(2);
  const row = data?.[0]; if (!row || (data && data.length > 1 && !isFull)) return { row: null, marks: [], consensus: null, ambiguous: (data?.length ?? 0) > 1 };
  const [{ data: marks }, { data: cons }] = await Promise.all([db.from("paper_marks").select("*").eq("signal_id", row.signal_id).order("observed_at"), db.from("consensus_events").select("*").eq("signal_id", row.signal_id).maybeSingle()]);
  return { row, marks: marks ?? [], consensus: cons, ambiguous: false };
}
