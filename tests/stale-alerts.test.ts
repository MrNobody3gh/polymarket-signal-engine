/**
 * D22/D23 — no alerts for signals detected more than ALERT_MAX_LAG_HOURS (default 1) after the trade.
 * lag = evaluation time − source trade time (signals.evaluated_at − signals.created_at). Late = strictly greater.
 * The signal is stored and simulated exactly as before; only the push (admin chat, subscribers, Discord/email) is skipped.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fakeDb } from "./helpers/fakeDb";
import { pgDb } from "./helpers/pgDb";
import { SignalEngine } from "@/lib/signals/engine";
import { detectionLagSec, isStaleLag, parseMaxLagHours, DEFAULT_ALERT_MAX_LAG_HOURS, resetStaleWarning, resolveMaxLagHours, STALE_ALERT_KIND } from "@/lib/alerts/staleness";
import { handle, type Store, type Subscriber } from "@/lib/telegram/commands";
import { supabaseStore } from "@/lib/telegram/store";
import { logIssues } from "@/lib/paper/ledger";
import type { Fill, WalletProfile } from "@/lib/polymarket/types";
import type { MarketMetaSource } from "@/lib/polymarket/markets";

const NOW = 1_790_000_000; const H = 3600; const LIMIT = DEFAULT_ALERT_MAX_LAG_HOURS * H; // D23: the default threshold, in seconds
const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40);
const profile = (address: string, o: Partial<WalletProfile> = {}): WalletProfile => ({ address, name: address.slice(0, 6), copyScore: 70, pnl90d: 100_000, style: "Selective directional", fillsPerDay: 10, programShare: 0.01, concentration: 0.1, netDd: 20, monthsUp: 3, monthsTotal: 3, daysIdle: 0, tradeCount: 1000, sources: [], ...o });
let seq = 0;
const fill = (o: Partial<Fill> = {}): Fill => { const f = { wallet: A, conditionId: "0xcond", tokenId: "tok1", side: "BUY" as const, size: 10_000, price: 0.3, usd: 3000, ts: NOW, title: "Will X?", slug: "will-x", outcome: "Yes", tx: "0xtx" + ++seq, source: "rest" as const, ...o }; return { id: `${f.tx}:${f.tokenId}:${f.wallet}:${f.ts}:${f.side}:${f.size}:${f.price}`, ...f } as Fill; };
const noMeta: MarketMetaSource = { endDate: async () => null };
const ADMIN = 99;
const okResp = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

type Call = { chat_id: number | string; text: string };
/** A wired rig: fake database, engine, a stubbed global fetch that records every Telegram call. */
function rig(o: { maxAlertLagHours?: number; markets?: MarketMetaSource; wallets?: WalletProfile[]; subs?: Partial<Subscriber>[]; admin?: boolean; bot?: boolean; fail?: (chat: number | string) => Response | null; log?: (m: string) => void } = {}) {
  const db = fakeDb(); const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => { const b = JSON.parse(String(init?.body)); calls.push({ chat_id: b.chat_id, text: b.text }); return o.fail?.(b.chat_id) ?? okResp(); }));
  if (o.bot ?? true) vi.stubEnv("TELEGRAM_BOT_TOKEN", "tok"); else vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  for (const s of o.subs ?? []) db.T("tg_subscribers").push({ chat_id: 1, username: null, kinds: ["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY", "EXIT"], min_severity: 1, min_usd: 0, min_score: 0, only_wallets: [], muted_wallets: [], muted_until: null, active: true, consecutive_failures: 0, next_attempt_at: null, ...s });
  const channels = (o.admin ?? true) ? { telegram: { token: "tok", chatId: String(ADMIN) } } : {};
  const logs: string[] = []; const log = (m: string) => { logs.push(m); o.log?.(m); };
  const e = new SignalEngine({ db: db as never, channels, markets: o.markets ?? noMeta, now: () => NOW, log, ...(o.maxAlertLagHours !== undefined ? { maxAlertLagHours: o.maxAlertLagHours } : {}) });
  for (const w of o.wallets ?? [profile(A), profile(B)]) (e as unknown as { wallets: Map<string, WalletProfile> }).wallets.set(w.address, w);
  const sigOf = (f: Fill) => db.T("signals").filter((s) => s.source_fill_id === f.id);
  return { db, e, calls, logs, sigOf, admin: () => calls.filter((c) => c.chat_id === String(ADMIN)), subscribers: () => calls.filter((c) => c.chat_id !== String(ADMIN)), staleIssues: () => db.T("data_quality_issues").filter((r) => r.kind === STALE_ALERT_KIND) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); resetStaleWarning(); });
beforeEach(() => { resetStaleWarning(); });

/** One scenario per signal kind: the fills that lead up to it (fresh) and the target fill at a chosen lag. */
const early: MarketMetaSource = { endDate: async () => new Date((NOW + 5 * 86_400) * 1000).toISOString().slice(0, 10) };
const SCENARIOS: { kind: string; markets?: MarketMetaSource; setup: () => Fill[]; target: (lag: number) => Fill }[] = [
  { kind: "NEW_POSITION", setup: () => [], target: (lag) => fill({ ts: NOW - lag }) },
  { kind: "CONSENSUS", setup: () => [fill({ wallet: B, ts: NOW })], target: (lag) => fill({ ts: NOW - lag }) },
  { kind: "CONVICTION_ADD", setup: () => [fill({ ts: NOW })], target: (lag) => fill({ ts: NOW - lag, size: 6000, usd: 1800 }) },
  { kind: "EARLY_ENTRY", markets: early, setup: () => [], target: (lag) => fill({ ts: NOW - lag, price: 0.2, size: 15_000, usd: 3000 }) },
  { kind: "EXIT", setup: () => [fill({ ts: NOW })], target: (lag) => fill({ ts: NOW - lag, side: "SELL", size: 10_000, price: 0.4, usd: 4000 }) },
];
/** Run a scenario: fresh set-up fills, then the target fill `lag` seconds old. Returns what was sent for the target fill only. */
async function runScenario(sc: (typeof SCENARIOS)[number], lag: number, o: Parameters<typeof rig>[0] = {}) {
  const r = rig({ subs: [{ chat_id: 1 }], markets: sc.markets, ...o });
  for (const f of sc.setup()) await r.e.ingest(f);
  const t = sc.target(lag); const a0 = r.admin().length, s0 = r.subscribers().length, d0 = r.db.T("tg_deliveries").length, i0 = r.staleIssues().length;
  await r.e.ingest(t);
  const mine = r.sigOf(t).filter((s) => s.kind === sc.kind);
  expect(mine, `${sc.kind} scenario must produce exactly one ${sc.kind} signal`).toHaveLength(1);
  const n = r.sigOf(t).length; // every signal the target fill produced (an entry can fire several kinds)
  return { ...r, target: mine[0], n, admin: r.admin().length - a0, subscribers: r.subscribers().length - s0, deliveries: r.db.T("tg_deliveries").length - d0, issues: r.staleIssues().length - i0 };
}

describe("D22 definition: lag = evaluation − trade time, strictly greater than the threshold", () => {
  it("isStaleLag / detectionLagSec: exactly at the threshold is fresh, one second over is late", () => {
    expect(detectionLagSec(NOW, NOW - 100)).toBe(100);
    expect(isStaleLag(LIMIT - 1, 1)).toBe(false); expect(isStaleLag(LIMIT, 1)).toBe(false); expect(isStaleLag(LIMIT + 1, 1)).toBe(true);
    expect(isStaleLag(6 * H, 6)).toBe(false); expect(isStaleLag(6 * H + 1, 6)).toBe(true); // an explicit 6 h is still honoured
    expect(isStaleLag(0, 1)).toBe(false); expect(isStaleLag(-30, 1)).toBe(false); // a trade timestamped slightly in the future is not late
    expect(isStaleLag(90, 0.025)).toBe(false); expect(isStaleLag(91, 0.025)).toBe(true); // fractional hours: 0.025 h = 90 s
  });

  it("through the engine: 1 s under the limit → sent, exactly the limit (1 h) → sent, 1 s over → suppressed (admin chat and subscriber)", async () => {
    const nb = SCENARIOS[0];
    const under = await runScenario(nb, LIMIT - 1), exact = await runScenario(nb, LIMIT), over = await runScenario(nb, LIMIT + 1);
    for (const r of [under, exact]) { expect(r.admin, "admin chat").toBe(r.n); expect(r.subscribers, "subscriber").toBe(r.n); expect(r.deliveries).toBe(r.n); expect(r.issues).toBe(0); }
    expect(over.admin).toBe(0); expect(over.subscribers).toBe(0); expect(over.deliveries).toBe(0); expect(over.issues).toBe(over.n);
  });

  it("the lag is the signal's own evaluated_at − created_at, as stored", async () => {
    const r = await runScenario(SCENARIOS[0], LIMIT + 1);
    expect(Date.parse(r.target.evaluated_at) / 1000 - Date.parse(r.target.created_at) / 1000).toBe(LIMIT + 1);
  });
});

describe("D22 scope: every signal kind, admin chat and subscribers", () => {
  for (const sc of SCENARIOS) {
    it(`${sc.kind}: late (1 h + 1 s) → nothing pushed anywhere; 30 min → pushed to both`, async () => {
      const late = await runScenario(sc, LIMIT + 1);
      expect(late.admin, "admin chat").toBe(0); expect(late.subscribers).toBe(0); expect(late.deliveries).toBe(0);
      expect(late.issues).toBe(late.n); expect(late.staleIssues().map((i) => i.ref_id)).toContain(late.target.id);
      const fresh = await runScenario(sc, H / 2);
      expect(fresh.admin).toBe(fresh.n); expect(fresh.subscribers).toBe(fresh.n); expect(fresh.issues).toBe(0);
    });
  }
  it("the admin chat alone is gated (no bot token, no subscribers)", async () => {
    const late = await runScenario(SCENARIOS[0], LIMIT + 1, { bot: false, subs: [] }); expect(late.calls).toHaveLength(0);
    const fresh = await runScenario(SCENARIOS[0], H / 2, { bot: false, subs: [] }); expect(fresh.admin).toBe(fresh.n); expect(fresh.calls.every((c) => c.chat_id === String(ADMIN))).toBe(true);
  });
  it("the subscriber broadcast alone is gated (no admin chat)", async () => {
    const late = await runScenario(SCENARIOS[0], LIMIT + 1, { admin: false }); expect(late.calls).toHaveLength(0);
    const fresh = await runScenario(SCENARIOS[0], H, { admin: false }); expect(fresh.subscribers).toBe(fresh.n);
  });
  it("Discord and email share dispatch and are gated the same way", async () => {
    const db = fakeDb(); const urls: string[] = []; vi.stubGlobal("fetch", vi.fn(async (u: string) => { urls.push(String(u)); return okResp(); })); vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const e = new SignalEngine({ db: db as never, channels: { discord: { webhookUrl: "https://discord.example/hook" }, email: { resendKey: "k", to: "a@b.c", from: "s@b.c" } }, markets: noMeta, now: () => NOW });
    (e as unknown as { wallets: Map<string, WalletProfile> }).wallets.set(A, profile(A));
    await e.ingest(fill({ ts: NOW - LIMIT - 1 })); expect(urls).toEqual([]);
    await e.ingest(fill({ ts: NOW - 60, tokenId: "tok2" })); expect(urls.some((u) => u.includes("discord"))).toBe(true); expect(urls.some((u) => u.includes("resend"))).toBe(true);
  });
});

describe("D22 what must NOT change", () => {
  /** Every table the engine writes, with row ids replaced by the signal's dedupe key so two runs are comparable. */
  const canon = (db: ReturnType<typeof fakeDb>) => {
    const ids = new Map(db.T("signals").map((s) => [s.id as string, `<${s.dedupe_key}>`]));
    let out = JSON.stringify(Object.fromEntries(Object.entries(db.tables).filter(([t]) => t !== "data_quality_issues" && t !== "cursors").sort(([a], [b]) => a.localeCompare(b)).map(([t, rows]) => [t, rows.map((r) => JSON.stringify(r)).sort()])));
    for (const [id, k] of ids) out = out.split(id).join(k);
    return out;
  };
  const SCRIPT = (): Fill[] => (seq = 1000, [
    fill({ wallet: B, ts: NOW }), fill({ ts: NOW - 30 }),                                                    // fresh NEW_POSITION + CONSENSUS
    fill({ ts: NOW - 20, size: 6000, usd: 1800 }),                                                            // fresh CONVICTION_ADD
    fill({ tokenId: "tok2", ts: NOW - LIMIT - 5 }), fill({ tokenId: "tok2", wallet: B, ts: NOW - LIMIT - 9 }),  // LATE NEW_POSITION ×2 (+ CONSENSUS)
    fill({ tokenId: "tok2", ts: NOW - LIMIT - 3, size: 6000, usd: 1800 }),                                     // LATE CONVICTION_ADD
    fill({ tokenId: "tok3", ts: NOW - 40 * H, price: 0.2, size: 15_000 }),                                    // LATE EARLY_ENTRY (+ NEW_POSITION)
    fill({ tokenId: "tok3", side: "SELL", ts: NOW - 30 * H, size: 15_000, price: 0.4, usd: 6000 }),          // LATE EXIT
    fill({ ts: NOW - 5, side: "SELL", size: 16_000, price: 0.4, usd: 6400 }),                                 // fresh EXIT
  ]);
  async function playScript(maxAlertLagHours?: number) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(NOW * 1000);
    const r = rig({ maxAlertLagHours, admin: false, bot: false, markets: early, wallets: [profile(A), profile(B)] });
    for (const f of SCRIPT()) await r.e.ingest(f);
    vi.useRealTimers(); return r;
  }

  it("a run with the rule on writes byte-identical rows to a run with it off, in every table (only data_quality_issues gains rows)", async () => {
    const on = await playScript(); const off = await playScript(1e9);
    const late = on.db.T("signals").filter((s) => Date.parse(s.evaluated_at) - Date.parse(s.created_at) > LIMIT * 1000);
    expect(late.length).toBeGreaterThanOrEqual(6); // the script really contains late signals
    expect(new Set(late.map((s) => s.kind))).toEqual(new Set(["NEW_POSITION", "CONSENSUS", "CONVICTION_ADD", "EARLY_ENTRY", "EXIT"]));
    expect(on.db.T("signals").length).toBe(off.db.T("signals").length);
    expect(on.db.T("paper_ledger").length).toBe(on.db.T("signals").length); expect(on.db.T("consensus_events").length).toBeGreaterThanOrEqual(1);
    for (const s of late) { expect(on.db.T("paper_ledger").some((p) => p.signal_id === s.id), `ledger row for late ${s.kind}`).toBe(true); }
    expect(canon(on.db)).toBe(canon(off.db));
    expect(on.staleIssues()).toHaveLength(late.length); expect(off.staleIssues()).toHaveLength(0);
    expect(new Set(on.staleIssues().map((i) => i.ref_id))).toEqual(new Set(late.map((s) => s.id)));
  });

  it("the consensus event of a late CONSENSUS signal and the positions are as without the rule", async () => {
    const on = await playScript(); const off = await playScript(1e9);
    const lateCons = on.db.T("signals").find((s) => s.kind === "CONSENSUS" && s.token_id === "tok2")!; expect(lateCons).toBeTruthy();
    expect(on.db.T("consensus_events").some((c) => c.signal_id === lateCons.id)).toBe(true);
    expect(JSON.stringify(on.db.T("positions"))).toBe(JSON.stringify(off.db.T("positions")));
  });

  it("with channels configured the late row is stored as today, with nothing recorded as delivered", async () => {
    const late = await runScenario(SCENARIOS[0], LIMIT + 1);
    expect(late.target.delivered).toEqual({}); expect(late.target.payload).toBeTruthy(); expect(late.target.closed_at ?? null).toBeNull();
    const fresh = await runScenario(SCENARIOS[0], H); expect(fresh.target.delivered).toMatchObject({ telegram: true, bot: { sent: 1 } });
    // same columns, same payload shape: the only difference is what was delivered
    expect(Object.keys(late.target).sort()).toEqual(Object.keys(fresh.target).sort());
  });

  it("a late EXIT still closes the wallet's open signals", async () => {
    const r = await runScenario(SCENARIOS[4], LIMIT + 1);
    expect(r.db.T("signals").filter((s) => s.kind !== "EXIT" && s.token_id === "tok1").every((s) => s.closed_at != null)).toBe(true);
  });

  it("a late signal is still listed by /signals and /signal <ref> (the store reads the signals table, untouched)", async () => {
    const r = await runScenario(SCENARIOS[0], LIMIT + 1);
    const { data } = await (r.db.from("signals").select("*").order("created_at") as unknown as Promise<{ data: { id: string }[] }>);
    expect(data.map((s) => s.id)).toContain(r.target.id);
  });
});

describe("D22 delivery bookkeeping", () => {
  const failing = (chat: number | string) => (chat === "1" || chat === 1 ? new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 5 } }), { status: 429 }) : null);
  it("a suppressed alert writes no tg_deliveries row and leaves every subscriber's failure counters and back-off alone", async () => {
    const subs = [{ chat_id: 1, consecutive_failures: 3, last_error: "old", next_attempt_at: null }, { chat_id: 2, consecutive_failures: 0 }];
    const late = await runScenario(SCENARIOS[0], LIMIT + 1, { subs, fail: failing });
    expect(late.calls).toHaveLength(0); expect(late.db.T("tg_deliveries")).toHaveLength(0);
    expect(late.db.T("tg_subscribers")).toEqual([expect.objectContaining({ chat_id: 1, consecutive_failures: 3, last_error: "old", next_attempt_at: null, active: true }), expect.objectContaining({ chat_id: 2, consecutive_failures: 0, active: true })]);
  });
  it("control: the same failing subscriber does move its counters on a FRESH signal (so the test above can fail)", async () => {
    const fresh = await runScenario(SCENARIOS[0], H, { subs: [{ chat_id: 1, consecutive_failures: 3 }], fail: failing });
    const s = fresh.db.T("tg_subscribers")[0]; expect(s.consecutive_failures).toBeGreaterThan(3); expect(s.next_attempt_at).toBeTruthy();
  });
  it("subscriber filters and dedupe are unaffected: a later fresh signal reaches exactly the matching subscribers, once", async () => {
    const r = rig({ subs: [{ chat_id: 1 }, { chat_id: 2, kinds: ["EXIT"] }, { chat_id: 3, min_usd: 1e9 }] });
    await r.e.ingest(fill({ ts: NOW - LIMIT - 1 }));                    // late: nothing
    expect(r.calls).toHaveLength(0);
    const f = fill({ tokenId: "tok9", ts: NOW - 10 }); await r.e.ingest(f); await r.e.ingest(f);
    const sig = r.sigOf(f)[0]; expect(r.subscribers().filter((c) => c.chat_id === 1 || c.chat_id === "1")).toHaveLength(r.sigOf(f).length);
    expect(r.subscribers().every((c) => String(c.chat_id) === "1")).toBe(true);
    expect(r.db.T("tg_deliveries").filter((d) => d.signal_id === sig.id)).toHaveLength(1);
    expect(r.admin()).toHaveLength(r.sigOf(f).length);                  // the duplicate ingest added nothing
  });
});

describe("D22 visibility", () => {
  it("records each suppression in data_quality_issues with the specified shape, once per signal", async () => {
    const r = rig({ subs: [{ chat_id: 1 }] }); const f = fill({ ts: NOW - (LIMIT + 3) }); await r.e.ingest(f);
    const [s] = r.sigOf(f); const issues = r.staleIssues(); expect(issues).toHaveLength(r.sigOf(f).length);
    const mine = issues.find((i) => i.ref_id === s.id)!;
    expect(mine).toMatchObject({ kind: "stale_alert_suppressed", ref_type: "signal", ref_id: s.id, detail: { lagHours: Math.round(((LIMIT + 3) / 3600) * 1000) / 1000, thresholdHours: DEFAULT_ALERT_MAX_LAG_HOURS, kind: s.kind } });
    expect(Object.keys(mine.detail).sort()).toEqual(["kind", "lagHours", "thresholdHours"]);
    // re-ingesting the same fill (same engine, a fresh engine, another worker) records nothing new
    await r.e.ingest(f); const e2 = new SignalEngine({ db: r.db as never, channels: {}, markets: noMeta, now: () => NOW }); (e2 as unknown as { wallets: Map<string, WalletProfile> }).wallets.set(A, profile(A)); await e2.ingest(f);
    expect(r.staleIssues()).toHaveLength(issues.length);
  });
  it("a repeated open issue for the same signal (the unique index, code 23505) is tolerated", async () => {
    const db = { from: () => ({ insert: async () => ({ error: { code: "23505", message: "duplicate key" } }) }) } as never; const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await logIssues(db, [{ kind: STALE_ALERT_KIND, ref_type: "signal", ref_id: "x", detail: {} }]); expect(err).not.toHaveBeenCalled(); err.mockRestore();
  });
  it("a failure to record the issue never breaks ingestion or the suppression", async () => {
    const r = rig({ subs: [{ chat_id: 1 }] }); const real = r.db.from.bind(r.db); (r.db as { from: unknown }).from = (t: string) => { if (t === "data_quality_issues") throw new Error("dq down"); return real(t); };
    const f = fill({ ts: NOW - LIMIT - 1 }); const out = await r.e.ingest(f);
    expect(out.length).toBeGreaterThan(0); expect(r.sigOf(f).length).toBe(out.length); expect(r.calls).toHaveLength(0); expect(r.logs.some((l) => l.includes("could not record"))).toBe(true);
  });
  it("a burst is one leading line plus one summary line, never one line per signal", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(NOW * 1000);
    const r = rig({ subs: [{ chat_id: 1 }] });
    for (let i = 0; i < 40; i++) await r.e.ingest(fill({ tokenId: `t${i}`, ts: NOW - LIMIT - 100 - i * 60 }));
    expect(r.staleIssues().length).toBeGreaterThanOrEqual(40); // every signal is recorded…
    const lines = () => r.logs.filter((l) => l.startsWith("alerts:"));
    expect(lines()).toHaveLength(1); expect(lines()[0]).toMatch(/suppressed 1 stale alert .*limit 1 h/); // …but only one line so far
    vi.advanceTimersByTime(61_000);
    expect(lines()).toHaveLength(2); expect(lines()[1]).toMatch(/suppressed \d+ more stale alert\(s\) in the last minute \(max lag 1\.\d h, limit 1 h\)/);
    expect(Number(lines()[1].match(/suppressed (\d+)/)![1])).toBe(r.staleIssues().length - 1);
    vi.advanceTimersByTime(120_000); expect(lines()).toHaveLength(2); // nothing more when nothing more happens
  });
  it("flushStaleSummary reports a pending summary at once", async () => {
    const r = rig({ subs: [] }); await r.e.ingest(fill({ tokenId: "a", ts: NOW - LIMIT - 1 })); await r.e.ingest(fill({ tokenId: "b", ts: NOW - LIMIT - 1 }));
    r.e.flushStaleSummary(); expect(r.logs.filter((l) => l.startsWith("alerts:")).length).toBe(2);
  });
});

describe("D22 configuration: ALERT_MAX_LAG_HOURS", () => {
  it("parses strictly: a positive decimal number of hours; anything else is the default (1) with a warning", () => {
    for (const [raw, hours] of [["6", 6], ["12", 12], ["0.5", 0.5], [" 3 ", 3], [24, 24], ["1.25", 1.25]] as const) expect(parseMaxLagHours(raw), String(raw)).toEqual({ hours, warning: null });
    expect(parseMaxLagHours(undefined)).toEqual({ hours: DEFAULT_ALERT_MAX_LAG_HOURS, warning: null }); // unset is the default, not a mistake
    for (const bad of ["", " ", "0", "0.0", "-1", "-6", "abc", "6h", "six", "NaN", "Infinity", "-Infinity", "1e3", "0x10", "1,5", ".5", "5.", 0, -3, NaN, Infinity]) { const r = parseMaxLagHours(bad as never); expect(r.hours, String(bad)).toBe(DEFAULT_ALERT_MAX_LAG_HOURS); expect(r.warning, String(bad)).toMatch(/ALERT_MAX_LAG_HOURS/); }
  });
  it("an invalid environment value falls back to 1 h and logs exactly one line per process, however many engines are built", () => {
    const lines: string[] = []; vi.stubEnv("ALERT_MAX_LAG_HOURS", "banana");
    for (let i = 0; i < 4; i++) { const e = new SignalEngine({ db: fakeDb() as never, channels: {}, markets: noMeta, now: () => NOW, log: (m) => lines.push(m) }); expect((e as unknown as { maxAlertLagHours: number }).maxAlertLagHours).toBe(DEFAULT_ALERT_MAX_LAG_HOURS); }
    expect(lines).toHaveLength(1); expect(lines[0]).toContain('"banana"'); expect(lines[0]).toContain(`using ${DEFAULT_ALERT_MAX_LAG_HOURS}`);
  });
  it.each(["", "0", "-2", "soon"])("engine with ALERT_MAX_LAG_HOURS=%j still suppresses at 1 h + 1 s and sends at exactly 1 h", async (v) => {
    vi.stubEnv("ALERT_MAX_LAG_HOURS", v); const lines: string[] = [];
    const late = await runScenario(SCENARIOS[0], LIMIT + 1, { log: (m) => lines.push(m) }); expect(late.calls).toHaveLength(0);
    const exact = await runScenario(SCENARIOS[0], LIMIT); expect(exact.admin).toBe(exact.n);
    expect(lines.filter((l) => l.includes("ALERT_MAX_LAG_HOURS"))).toHaveLength(1);
  });
  it("a valid value moves the threshold (2 h and 12 h), and unset means 1 h", async () => {
    vi.stubEnv("ALERT_MAX_LAG_HOURS", "2");
    expect((await runScenario(SCENARIOS[0], 2 * H + 1)).calls).toHaveLength(0); expect((await runScenario(SCENARIOS[0], 2 * H)).admin).toBeGreaterThan(0);
    vi.stubEnv("ALERT_MAX_LAG_HOURS", "12");
    expect((await runScenario(SCENARIOS[0], 7 * H)).admin).toBeGreaterThan(0); // 7 h is late at the default and at 6 h, fresh at 12 h expect((await runScenario(SCENARIOS[0], 12 * H + 1)).calls).toHaveLength(0);
    vi.unstubAllEnvs(); const lines: string[] = [];
    expect((await runScenario(SCENARIOS[0], LIMIT + 1, { log: (m) => lines.push(m) })).calls).toHaveLength(0); expect(lines.filter((l) => l.includes("ALERT_MAX_LAG_HOURS"))).toHaveLength(0);
    const e = rig({}).e as unknown as { maxAlertLagHours: number }; expect(e.maxAlertLagHours).toBe(1);
  });
  it("the recorded threshold is the effective one", async () => {
    vi.stubEnv("ALERT_MAX_LAG_HOURS", "2"); const r = await runScenario(SCENARIOS[0], 3 * H);
    expect(r.staleIssues()[0].detail).toMatchObject({ thresholdHours: 2, lagHours: 3 });
  });
  it("resolveMaxLagHours logs at most once until reset", () => {
    const lines: string[] = []; resolveMaxLagHours("x", (m) => lines.push(m)); resolveMaxLagHours("y", (m) => lines.push(m)); expect(lines).toHaveLength(1);
    resetStaleWarning(); resolveMaxLagHours("y", (m) => lines.push(m)); expect(lines).toHaveLength(2);
  });
});

describe("D22 /status", () => {
  const base = { tracked: 180, signals24h: 7, lastRefresh: "17 Sep 2026 04:15 UTC", lastFill: new Date().toISOString() };
  const store = (extra: Record<string, unknown>): Store => ({ getSub: async () => null, status: async () => ({ ...base, ...extra }), health: async () => ({ hb: { ws_connected: "true", last_trade: new Date().toISOString(), last_eval: new Date().toISOString(), last_db_write: new Date().toISOString(), last_mark: new Date().toISOString() }, dbOk: true }) } as unknown as Store);
  it("shows the line only when more than 0 alerts were suppressed in the last 24 h", async () => {
    for (const extra of [{}, { staleSuppressed24h: 0 }, { staleSuppressed24h: undefined }]) expect((await handle(1, null, "/status", store(extra))).html, JSON.stringify(extra)).not.toMatch(/late alert/);
    const one = (await handle(1, null, "/status", store({ staleSuppressed24h: 1 }))).html; expect(one).toContain("1 late alert not sent in 24h"); expect(one).toContain("Tracking 180");
    expect((await handle(1, null, "/status", store({ staleSuppressed24h: 838 }))).html).toContain("838 late alerts not sent in 24h");
  });
  it("the store counts only stale_alert_suppressed rows from the last 24 h", async () => {
    const db = fakeDb(); const ago = (h: number) => new Date(Date.now() - h * H * 1000).toISOString();
    db.T("data_quality_issues").push({ kind: STALE_ALERT_KIND, created_at: ago(1) }, { kind: STALE_ALERT_KIND, created_at: ago(23) }, { kind: STALE_ALERT_KIND, created_at: ago(25) }, { kind: "poll_gap", created_at: ago(1) });
    expect((await supabaseStore(db as never).status()).staleSuppressed24h).toBe(2);
    expect((await supabaseStore(fakeDb() as never).status()).staleSuppressed24h).toBe(0);
  });
  it("end to end: suppress through the engine, then /status through the real store shows it", async () => {
    const r = await runScenario(SCENARIOS[0], LIMIT + 1);
    const patched = { ...r.db, from: (t: string) => r.db.from(t) };
    // the engine stamps created_at with the database default in production; the fake has none, so stamp it here
    for (const i of r.db.T("data_quality_issues")) i.created_at = new Date().toISOString();
    const html = (await handle(1, null, "/status", supabaseStore(patched as never))).html; expect(html).toMatch(/\d+ late alerts? not sent in 24h/);
  });
});

// ───────────────────────────── real Postgres ─────────────────────────────
const PGURL = process.env.PG_TEST_URL; const dpg = PGURL ? describe : describe.skip;
dpg("D22 in real Postgres (all migrations, own database)", () => {
  it("the suppression row satisfies the table and its open-issue unique index, and the /status count reads it", async () => {
    const name = `d22_${process.pid}_${Date.now()}`; const admin = new pg.Client({ connectionString: PGURL }); await admin.connect(); await admin.query(`create database ${name}`); await admin.end();
    const u = new URL(PGURL!); u.pathname = `/${name}`; const c = new pg.Client({ connectionString: u.toString() }); await c.connect();
    try {
      const MIG = path.resolve(__dirname, "../supabase/migrations"); for (const f of readdirSync(MIG).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) await c.query(readFileSync(path.join(MIG, f), "utf8"));
      const db = pgDb(c); const detail = { lagHours: 7.5, thresholdHours: 6, kind: "NEW_POSITION" }; const id = "11111111-1111-4111-8111-111111111111";
      await logIssues(db as never, [{ kind: STALE_ALERT_KIND, ref_type: "signal", ref_id: id, detail }]);
      await logIssues(db as never, [{ kind: STALE_ALERT_KIND, ref_type: "signal", ref_id: "22222222-2222-4222-8222-222222222222", detail }]);
      const dup = await c.query("insert into data_quality_issues (kind, ref_type, ref_id, detail) values ($1,'signal',$2,'{}') on conflict do nothing", [STALE_ALERT_KIND, id]); expect(dup.rowCount).toBe(0); // one open issue per signal
      const rows = (await c.query("select kind, ref_type, ref_id, detail from data_quality_issues order by ref_id")).rows; expect(rows).toHaveLength(2); expect(rows[0]).toEqual({ kind: "stale_alert_suppressed", ref_type: "signal", ref_id: id, detail });
      await c.query("insert into data_quality_issues (kind, ref_type, ref_id, created_at) values ($1,'signal','old', now() - interval '30 hours'), ('poll_gap','wallet','w', now())", [STALE_ALERT_KIND]);
      expect((await supabaseStore(db as never).status()).staleSuppressed24h).toBe(2);
    } finally { await c.end(); const a2 = new pg.Client({ connectionString: PGURL }); await a2.connect(); await a2.query(`drop database if exists ${name} with (force)`); await a2.end(); }
  }, 120_000);
});
