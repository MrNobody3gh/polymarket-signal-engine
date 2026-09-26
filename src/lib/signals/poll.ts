/**
 * REST poller: pull every fill per tracked wallet since its cursor.
 *
 * Correctness contract
 *  - Pages are walked (newest → oldest, keyset) until a row older than the cursor appears or the feed ends, so a
 *    burst larger than one page is never truncated. There is no fixed cap on how much of the window is read.
 *  - `start` is inclusive and the local filter is `ts >= cursor`, so fills sharing the cursor's second are re-read;
 *    the engine's atomic claim makes re-reads harmless. This is what makes identical timestamps safe.
 *  - The cursor only advances to the last timestamp whose fills were ALL processed. A crash or error mid-wallet
 *    leaves the cursor where it was, so a restart re-reads (and the claim skips what already landed).
 *  - A hard row ceiling (maxRowsPerWallet) stops a runaway walk. Hitting it is reported as a data-quality gap, never
 *    silently: the fills read are processed and the cursor advances past them, which is the only way to make progress.
 */
import { PolymarketClient, explainFill, withOccurrence } from "../polymarket/client";
import type { Fill, RawFill } from "../polymarket/types";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PollEngine { trackedAddresses(): string[]; ingest(f: Fill): Promise<unknown[]> }
export interface PollOptions { lookbackSec?: number; maxWallets?: number; concurrency?: number; pageSize?: number; maxRowsPerWallet?: number; now?: number }

/** Read every row with timestamp ≥ since for one wallet. */
export async function readSince(client: Pick<PolymarketClient, "paginate">, wallet: string, since: number, pageSize: number, maxRows: number): Promise<{ rows: RawFill[]; truncated: boolean }> {
  const rows: RawFill[] = []; let truncated = false;
  for await (const r of client.paginate<RawFill>("/v2/trades", { user: wallet, taker_only: false, start: since }, { page: pageSize })) {
    const ts = Number(r.timestamp ?? r.ts);
    if (Number.isFinite(ts) && ts < since) break; // walked past the window (feed is newest-first)
    rows.push(r);
    if (rows.length >= maxRows) { truncated = true; break; }
  }
  return { rows, truncated };
}

export async function pollOnce(db: SupabaseClient, engine: PollEngine, client: Pick<PolymarketClient, "paginate"> = new PolymarketClient(), opts: PollOptions = {}) {
  const wallets = engine.trackedAddresses().slice(0, opts.maxWallets ?? 400);
  const { data: curs } = await db.from("cursors").select("key,value").like("key", "poll:%");
  const cursor = new Map((curs ?? []).map((c: { key: string; value: string }) => [c.key.slice(5), Number(c.value)]));
  const now = opts.now ?? Math.floor(Date.now() / 1000); const lookback = opts.lookbackSec ?? 6 * 3600;
  const pageSize = opts.pageSize ?? 500; const maxRows = opts.maxRowsPerWallet ?? 20_000;
  let fills = 0, signals = 0, rejected = 0, gaps = 0, errors = 0; const conc = opts.concurrency ?? 8;
  let i = 0;
  const workers = Array.from({ length: conc }, async () => {
    while (i < wallets.length) {
      const w = wallets[i++]; const since = cursor.get(w) ?? now - lookback;
      let read;
      try { read = await readSince(client, w, since, pageSize, maxRows); } catch (e) { errors++; console.error(`poll ${w}: ${(e as Error).message}`); continue; }
      const valid: Fill[] = [];
      for (const r of read.rows) { const x = explainFill(r, "rest", now); if ("fill" in x) { if (x.fill.ts >= since) valid.push(x.fill); } else rejected++; }
      // Oldest first (stable within a second, preserving feed order), then disambiguate identical rows.
      const ordered = withOccurrence(valid.map((f, idx) => ({ f, idx })).sort((a, b) => a.f.ts - b.f.ts || b.idx - a.idx).map((x) => x.f));
      let done = since; let failed = false;
      for (let k = 0; k < ordered.length; k++) {
        const f = ordered[k];
        try { signals += (await engine.ingest(f)).length; fills++; }
        catch (e) { failed = true; errors++; console.error(`poll ${w} ingest ${f.id}: ${(e as Error).message}`); break; }
        // Advance only once every fill of this second is done (the next fill is later, or this is the last one).
        if (k === ordered.length - 1 || ordered[k + 1].ts > f.ts) done = Math.max(done, f.ts);
      }
      if (read.truncated && !failed) {
        gaps++;
        await db.from("data_quality_issues").insert({ kind: "poll_gap", ref_type: "wallet", ref_id: w, detail: { since, rows: read.rows.length, maxRows } }).then(() => {}, () => {});
      }
      if (done !== (cursor.get(w) ?? -1)) await db.from("cursors").upsert({ key: `poll:${w}`, value: String(done), updated_at: new Date().toISOString() });
    }
  });
  await Promise.all(workers);
  return { wallets: wallets.length, fills, signals, rejected, gaps, errors };
}
