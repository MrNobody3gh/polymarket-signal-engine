/** REST poller: pull new fills per tracked wallet since its cursor. Runs from
 *  the Vercel cron every minute; ~180 wallets × 1 request stays well inside the
 *  documented 1000 req/10s general limit. */
import { PolymarketClient, normalizeFill } from "../polymarket/client";
import type { SignalEngine } from "./engine";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function pollOnce(db: SupabaseClient, engine: SignalEngine, client = new PolymarketClient(), opts: { lookbackSec?: number; maxWallets?: number; concurrency?: number } = {}) {
  const wallets = engine.trackedAddresses().slice(0, opts.maxWallets ?? 400);
  const { data: curs } = await db.from("cursors").select("key,value").like("key", "poll:%");
  const cursor = new Map((curs ?? []).map((c) => [c.key.slice(5), Number(c.value)]));
  const now = Math.floor(Date.now() / 1000); const lookback = opts.lookbackSec ?? 6 * 3600;
  let fills = 0, signals = 0; const conc = opts.concurrency ?? 8;
  let i = 0;
  const workers = Array.from({ length: conc }, async () => {
    while (i < wallets.length) {
      const w = wallets[i++]; const since = (cursor.get(w) ?? now - lookback) - 60; // 60s overlap for indexing lag
      let rows;
      try { rows = await client.userTrades(w, { since, cap: 500 }); } catch (e) { console.error(`poll ${w}: ${(e as Error).message}`); continue; }
      let maxTs = cursor.get(w) ?? since;
      // oldest first so the book evolves in order
      const fs = rows.map((r) => normalizeFill(r, "rest")).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => a.ts - b.ts);
      for (const f of fs) { fills++; signals += (await engine.ingest(f)).length; maxTs = Math.max(maxTs, f.ts); }
      await db.from("cursors").upsert({ key: `poll:${w}`, value: String(maxTs), updated_at: new Date().toISOString() });
    }
  });
  await Promise.all(workers);
  return { wallets: wallets.length, fills, signals };
}
