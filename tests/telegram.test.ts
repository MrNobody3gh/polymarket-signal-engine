import { describe, it, expect, vi } from "vitest";
import { handle, handleCallback, matches, parse, signalHtml, type Store, type Subscriber, type SignalRow } from "@/lib/telegram/commands";
import { broadcast } from "@/lib/telegram/broadcast";
import { TelegramApi } from "@/lib/telegram/api";

const sub = (o: Partial<Subscriber> = {}): Subscriber => ({ chat_id: 1, username: "joseph", kinds: ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY", "EXIT"], min_severity: 2, min_usd: 0, min_score: 0, only_wallets: [], muted_wallets: [], muted_until: null, active: true, ...o });
const sig = (o: Partial<SignalRow> = {}): SignalRow => ({ id: "s1", kind: "CONSENSUS", severity: 4, wallet: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca", wallet_name: "paddaa", outcome: "No", title: "Hormuz by Sept 30?", slug: "hormuz", price: 0.658, usd: 12_400, payload: { copyScore: 72, wallets: 3 }, created_at: new Date().toISOString(), closed_at: null, ...o });

function memStore(): Store & { subs: Map<number, Subscriber> } {
  const subs = new Map<number, Subscriber>();
  return {
    subs,
    async getSub(id) { return subs.get(id) ?? null; },
    async upsertSub(s) { const cur = subs.get(s.chat_id) ?? sub({ chat_id: s.chat_id }); const n = { ...cur, ...s } as Subscriber; subs.set(s.chat_id, n); return n; },
    async recentSignals(n) { return [sig(), sig({ id: "s2", kind: "EXIT", severity: 2, payload: { soldFraction: 0.8 } })].slice(0, n); },
    async consensus() { return [{ token_id: "t", title: "Hormuz", slug: "hormuz", outcome: "No", wallets: 6, cost_usd: 192_472, weighted_score: 380, avg_entry: 0.5356, names: ["a", "b", "c", "d", "e", "f"], end_date: "2026-12-31" }]; },
    async topWallets(n) { return [{ address: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca", name: "crckr", copy_score: 77, pnl_90d: 289_530, style: "Selective directional", net_dd: 44.8, months_up: 3, months_total: 3, fills_per_day: 12, days_idle: 0 }].slice(0, n); },
    async findWallet(q) { return /crckr|0xabcabc/i.test(q) ? { address: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca", name: "crckr", copy_score: 77, pnl_90d: 289_530, style: "Selective directional", net_dd: 44.8, months_up: 3, months_total: 3, fills_per_day: 12, days_idle: 0 } : null; },
    async openBook() { return [{ token_id: "t", title: "Hormuz", slug: "hormuz", outcome: "No", size: 1000, avg_price: 0.54, cost_usd: 540, last_seen: new Date().toISOString() }]; },
    async status() { return { tracked: 180, signals24h: 7, lastRefresh: "17 Sep 2026 04:15 UTC", lastFill: new Date().toISOString() }; },
  };
}

describe("parse", () => {
  it("strips the bot suffix and lowercases", () => { expect(parse("/Kinds@MyBot new exit")).toEqual({ cmd: "kinds", args: ["new", "exit"] }); expect(parse("hello")).toEqual({ cmd: "", args: [] }); });
});

describe("commands", () => {
  it("/start subscribes and shows filters", async () => { const st = memStore(); const r = await handle(1, "joseph", "/start", st); expect(r.html).toContain("Subscribed"); expect(st.subs.get(1)?.active).toBe(true); });
  it("/kinds accepts aliases and rejects junk", async () => {
    const st = memStore(); await handle(1, null, "/start", st);
    await handle(1, null, "/kinds new exit", st); expect(st.subs.get(1)?.kinds).toEqual(["NEW_POSITION", "EXIT"]);
    expect((await handle(1, null, "/kinds banana", st)).html).toContain("Unknown kind");
  });
  it("/severity /min /score validate", async () => {
    const st = memStore(); await handle(1, null, "/start", st);
    await handle(1, null, "/severity 4", st); await handle(1, null, "/min $5k", st); await handle(1, null, "/score 60", st);
    const s = st.subs.get(1)!; expect(s.min_severity).toBe(4); expect(s.min_usd).toBe(5000); expect(s.min_score).toBe(60);
    expect((await handle(1, null, "/severity 9", st)).html).toContain("Usage");
  });
  it("/only and /mute resolve names to addresses", async () => {
    const st = memStore(); await handle(1, null, "/start", st);
    await handle(1, null, "/only crckr", st); expect(st.subs.get(1)?.only_wallets).toEqual(["0xabcabcabcabcabcabcabcabcabcabcabcabcabca"]);
    await handle(1, null, "/only all", st); expect(st.subs.get(1)?.only_wallets).toEqual([]);
    await handle(1, null, "/mute crckr", st); expect(st.subs.get(1)?.muted_wallets).toEqual(["0xabcabcabcabcabcabcabcabcabcabcabcabcabca"]);
    await handle(1, null, "/mute 6", st); expect(Date.parse(st.subs.get(1)!.muted_until!)).toBeGreaterThan(Date.now() + 5 * 3600_000);
    await handle(1, null, "/unmute", st); expect(st.subs.get(1)?.muted_wallets).toEqual([]); expect(st.subs.get(1)?.muted_until).toBeNull();
  });
  it("/signals /consensus /wallets /wallet /status render", async () => {
    const st = memStore();
    expect((await handle(1, null, "/signals 1", st)).html).toContain("<b>Consensus</b> ★★★★☆");
    expect((await handle(1, null, "/consensus", st)).html).toContain("6×");
    expect((await handle(1, null, "/wallets", st)).html).toContain("crckr");
    const w = await handle(1, null, "/wallet crckr", st); expect(w.html).toContain("Copy score <b>77</b>"); expect(w.buttons?.[0]?.[1]?.callback_data).toBe("mute:"+"0xabcabcabcabcabcabcabcabcabcabcabcabcabca");
    expect((await handle(1, null, "/wallet nobody", st)).html).toContain("No tracked wallet");
    expect((await handle(1, null, "/status", st)).html).toContain("Tracking 180");
  });
  it("callback mute adds the wallet", async () => { const st = memStore(); await handle(1, null, "/start", st); expect(await handleCallback(1, "mute:"+"0xabcabcabcabcabcabcabcabcabcabcabcabcabca", st)).toContain("Muted"); expect(st.subs.get(1)?.muted_wallets).toEqual(["0xabcabcabcabcabcabcabcabcabcabcabcabcabca"]); });
  it("signalHtml escapes HTML in titles", () => { expect(signalHtml(sig({ title: "<b>x</b> & y" }))).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y"); });
});

describe("matches", () => {
  it("applies every filter", () => {
    expect(matches(sub(), sig())).toBe(true);
    expect(matches(sub({ active: false }), sig())).toBe(false);
    expect(matches(sub({ kinds: ["EXIT"] }), sig())).toBe(false);
    expect(matches(sub({ min_severity: 5 }), sig())).toBe(false);
    expect(matches(sub({ min_usd: 20_000 }), sig())).toBe(false);
    expect(matches(sub({ min_score: 80 }), sig())).toBe(false);
    expect(matches(sub({ only_wallets: ["0xdefdefdefdefdefdefdefdefdefdefdefdefdefd"] }), sig())).toBe(false);
    expect(matches(sub({ muted_wallets: ["0xabcabcabcabcabcabcabcabcabcabcabcabcabca"] }), sig())).toBe(false);
    expect(matches(sub({ muted_until: new Date(Date.now() + 1000).toISOString() }), sig())).toBe(false);
    expect(matches(sub({ muted_until: new Date(Date.now() - 1000).toISOString() }), sig())).toBe(true);
  });
});

describe("broadcast", () => {
  it("sends to matching subscribers once and deactivates blocked chats", async () => {
    const rows = { tg_subscribers: [sub({ chat_id: 1 }), sub({ chat_id: 2, min_severity: 5 }), sub({ chat_id: 3 }), sub({ chat_id: 4 })], tg_deliveries: [{ chat_id: 4 }] };
    const writes: unknown[] = [];
    const db = { from: (t: string) => ({
      select: () => ({ eq: async () => ({ data: (rows as Record<string, unknown[]>)[t] }) }),
      upsert: async (r: unknown) => { writes.push(["upsert", t, r]); return {}; },
      update: (r: unknown) => ({ eq: async () => { writes.push(["update", t, r]); return {}; } }),
    }) } as never;
    const f = vi.fn(async (url: string, init?: RequestInit) => { const b = JSON.parse(String(init?.body)); return new Response(JSON.stringify(b.chat_id === 3 ? { ok: false, description: "Forbidden: bot was blocked by the user" } : { ok: true }), { status: 200 }); });
    const r = await broadcast(db, new TelegramApi("t", f as unknown as typeof fetch), sig(), { sleep: async () => {} });
    expect(r).toEqual({ sent: 1, failed: 1, skipped: 2 }); expect(f).toHaveBeenCalledTimes(2);
    expect(writes.some((w) => (w as unknown[])[0] === "update" && (w as unknown[])[1] === "tg_subscribers")).toBe(true);
  });
});
