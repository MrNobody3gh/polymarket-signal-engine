import { describe, it, expect, vi } from "vitest";
import { handle, handleCallback, matches, parse, signalHtml, type Store, type Subscriber, type SignalRow } from "@/lib/telegram/commands";
import { broadcast } from "@/lib/telegram/broadcast";
import { computeStats, byKind, byWallet } from "@/lib/paper/analytics";
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
    async paper() { return { rows: [], marks: [] }; },
    async snapshot() { return null; },
    async signalDetail() { return { row: null, marks: [], consensus: null, ambiguous: false }; },
    async health() { return { hb: { ws_connected: "true", last_trade: new Date().toISOString(), last_eval: new Date().toISOString(), last_db_write: new Date().toISOString(), last_mark: new Date().toISOString() }, dbOk: true }; },
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
    expect((await handle(1, null, "/signals 1", st)).html).toContain("<b>CONSENSUS</b> ★★★★☆");
    expect((await handle(1, null, "/consensus", st)).html).toContain("6×");
    expect((await handle(1, null, "/wallets", st)).html).toContain("crckr");
    const w = await handle(1, null, "/wallet crckr", st); expect(w.html).toContain("Copy score <b>77</b>"); expect(w.buttons?.[0]?.[1]?.callback_data).toBe("mute:"+"0xabcabcabcabcabcabcabcabcabcabcabcabcabca"); expect(w.html).toContain("No paper signals");
    expect((await handle(1, null, "/wallet nobody", st)).html).toContain("No tracked wallet");
    expect((await handle(1, null, "/status", st)).html).toContain("Tracking 180"); expect((await handle(1, null, "/status", st)).html).toContain("🟢 Bot: Online");
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

describe("V2 commands", () => {
  const NOW_ISO = new Date().toISOString();
  const rows = [
    { signal_id: "aaaaaaaa-1111-4111-8111-111111111111", wallet: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca", wallet_name: "crckr", kind: "NEW_POSITION", token_id: "t", title: "CS: BBL vs 3DMAX", outcome: "3DMAX", signal_ts: NOW_ISO, entry_price: 0.56, shares: 178.57, size_usd: 100, copy_score: 57, consensus_depth: 4, status: "RESOLVED_WIN", final_pnl: 78.57, final_return: 0.7857 },
    { signal_id: "bbbbbbbb-1111-4111-8111-111111111111", wallet: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca", wallet_name: "crckr", kind: "CONSENSUS", token_id: "t", title: "Hormuz", outcome: "No", signal_ts: NOW_ISO, entry_price: 0.5, shares: 200, size_usd: 100, copy_score: 57, consensus_depth: 3, status: "OPEN", final_pnl: null, final_return: null },
  ] as never[];
  const withPaper = () => { const st = memStore(); const marks = [{ signal_id: "bbbbbbbb-1111-4111-8111-111111111111", horizon: "1h", observed_at: NOW_ISO, price: 0.55, pnl: 10, return_pct: 0.1 }];
    st.paper = async (o) => ({ rows: (o.wallet ? rows.filter((r: { wallet: string }) => r.wallet === o.wallet) : rows) as never, marks });
    const win = { stats: computeStats(rows as never, marks), byKind: byKind(rows as never, marks), byScoreBand: [], byConsensusDepth: [], sizeUsd: 100 };
    st.snapshot = async () => ({ builtAt: NOW_ISO, windows: { all: win, d7: win, d30: win }, wallets: Object.fromEntries(byWallet(rows as never, marks).map((w) => [w.key, { stats: w.stats, byKind: w.kinds, name: w.name }])) });
    st.signalDetail = async (id) => (id.startsWith("aaaa") ? { row: { ...(rows[0] as object), side: "LONG", trade_usd: 5000, severity: 3, slug: "bbl" } as never, marks: [{ horizon: "1h", observed_at: NOW_ISO, price: 0.57, pnl: 1.79, return_pct: 0.018, source: "prices-history" }, { horizon: "resolution", observed_at: NOW_ISO, price: 1, pnl: 78.57, return_pct: 0.7857, source: "gamma" }], consensus: { participants: ["0xabcabcabcabcabcabcabcabcabcabcabcabcabca", "0xdef"], spread_seconds: 900, combined_usd: 12000, entry_prices: [0.56, 0.5] }, ambiguous: false } : id === "amb" ? { row: null, marks: [], consensus: null, ambiguous: true } : { row: null, marks: [], consensus: null, ambiguous: false }); return st; };
  it("/performance and /stats report measured numbers with paper-only framing", async () => {
    const st = withPaper(); const r = await handle(1, null, "/performance", st);
    expect(r.html).toContain("PAPER PERFORMANCE"); expect(r.html).toContain("Signals: 2"); expect(r.html).toContain("+$88.57"); expect(r.html).toContain("Win rate (settled only): 100.0% of 1"); expect(r.html).toContain("By signal type"); expect(r.html).toContain("insufficient");
    expect((await handle(1, null, "/performance 7d", st)).html).toContain("last 7 days"); expect((await handle(1, null, "/performance banana", st)).html).toContain("Usage");
    expect((await handle(1, null, "/stats", st)).html).toContain("last 30 days");
    expect((await handle(1, null, "/performance", memStore())).html).toContain("not built yet");
  });
  it("/signal shows the timeline from real observations", async () => {
    const st = withPaper(); const r = await handle(1, null, "/signal aaaaaaaa", st);
    expect(r.html).toContain("Signal aaaaaaaa"); expect(r.html).toContain("Entry 56.0¢"); expect(r.html).toContain("+1h — 57.0¢"); expect(r.html).toContain("Resolution — 100.0¢"); expect(r.html).toContain("spread 15 min"); expect(r.html).toContain("RESOLVED_WIN");
    expect((await handle(1, null, "/signal amb", st)).html).toContain("more than one"); expect((await handle(1, null, "/signal zzz", st)).html).toContain("No paper record"); expect((await handle(1, null, "/signal", st)).html).toContain("Usage");
  });
  it("/wallet includes paper performance for that wallet", async () => { const r = await handle(1, null, "/wallet crckr", withPaper()); expect(r.html).toContain("Paper performance"); expect(r.html).toContain("n=2"); });
  it("alert layout carries only real fields", () => {
    const h = signalHtml(sig({ kind: "CONVICTION_ADD", payload: { copyScore: 57, wallets: 4, beforeSize: 1000, addSize: 600 } }));
    expect(h).toContain("📈 <b>CONVICTION ADD</b>"); expect(h).toContain("🟢 Bought <b>No</b>"); expect(h).toContain("💰 Trade: <b>$12.4k</b>"); expect(h).toContain("📍 Entry: 65.8¢"); expect(h).toContain("⭐ Copy score: 57/100"); expect(h).toContain("👥 Consensus: 4 wallets"); expect(h).toContain("➕ Added 60%"); expect(h).toContain("/signal s1");
    const plain = signalHtml(sig({ payload: {} })); expect(plain).not.toContain("Copy score"); expect(plain).not.toContain("Consensus");
  });
});
