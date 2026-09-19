import { describe, it, expect, vi } from "vitest";
import { pollOnce } from "@/lib/signals/poll";
import type { SignalEngine } from "@/lib/signals/engine";
import type { PolymarketClient } from "@/lib/polymarket/client";

describe("pollOnce", () => {
  it("only ingests fills newer than the cursor even when the API returns old history", async () => {
    const ingested: number[] = [];
    const engine = { trackedAddresses: () => ["0xabc"], ingest: async (f: { ts: number }) => { ingested.push(f.ts); return []; } } as unknown as SignalEngine;
    const upserts: Record<string, unknown>[] = [];
    const db = { from: (t: string) => ({ select: () => ({ like: async () => ({ data: t === "cursors" ? [{ key: "poll:0xabc", value: "1000" }] : [] }) }), upsert: async (r: Record<string, unknown>) => { upserts.push(r); return {}; } }) } as never;
    const rows = [900, 1000, 1001, 1500].map((ts) => ({ proxyWallet: "0xabc", side: "BUY", size: 10, price: 0.5, timestamp: ts, asset: "t", conditionId: "c", transactionHash: "0x" + ts }));
    const client = { userTrades: vi.fn(async () => rows) } as unknown as PolymarketClient;
    const r = await pollOnce(db, engine, client);
    expect(ingested).toEqual([1001, 1500]); expect(r.fills).toBe(2); expect(upserts[0]).toMatchObject({ key: "poll:0xabc", value: "1500" });
    const again = await pollOnce({ from: (t: string) => ({ select: () => ({ like: async () => ({ data: t === "cursors" ? [{ key: "poll:0xabc", value: "1500" }] : [] }) }), upsert: async () => ({}) }) } as never, engine, client);
    expect(again.fills).toBe(0);
  });
});
