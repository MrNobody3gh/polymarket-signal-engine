/**
 * Stateful engine: takes normalised fills, keeps the position book in Supabase,
 * runs the rules, persists signals, dispatches alerts. Shared by the REST
 * poller (Vercel cron) and the websocket worker.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Fill, Position, Signal, WalletProfile } from "../polymarket/types";
import { applyFill, configFromEnv, evaluate, isBotLike, type RuleConfig } from "./rules";
import { channelsFromEnv, dispatch, type Channels } from "../alerts/dispatch";
import { TelegramApi } from "../telegram/api";
import { broadcast } from "../telegram/broadcast";
import { recordConsensusEvent, recordPaperSignal } from "../paper/ledger";
import { heartbeat } from "../health/heartbeat";
import { GammaMarketMeta, type MarketMetaSource } from "../polymarket/markets";
import type { RemotePosition } from "../polymarket/client";

export interface EngineDeps { db: SupabaseClient; cfg?: RuleConfig; channels?: Channels; now?: () => number; log?: (m: string) => void; markets?: MarketMetaSource }

const toSec = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);
const toIso = (sec: number | null | undefined) => (sec == null ? null : new Date(sec * 1000).toISOString());
/** DB row → Position. */
export function rowToPosition(pb: Record<string, any>): Position {
  return { wallet: pb.wallet, tokenId: pb.token_id, conditionId: pb.condition_id, outcome: pb.outcome ?? "", title: pb.title ?? "", slug: pb.slug ?? "", size: Number(pb.size), avgPrice: Number(pb.avg_price), costUsd: Number(pb.cost_usd), peakSize: Number(pb.peak_size), firstSeen: toSec(pb.first_seen) ?? 0, lastSeen: toSec(pb.last_seen) ?? 0, lastBuyTs: toSec(pb.last_buy_ts), lastSellTs: toSec(pb.last_sell_ts), endDate: pb.end_date ?? null };
}
export function positionToRow(p: Position) {
  return { wallet: p.wallet, token_id: p.tokenId, condition_id: p.conditionId, outcome: p.outcome, title: p.title, slug: p.slug, size: p.size, avg_price: p.avgPrice, cost_usd: p.costUsd, peak_size: p.peakSize, first_seen: toIso(p.firstSeen), last_seen: toIso(p.lastSeen), last_buy_ts: toIso(p.lastBuyTs), last_sell_ts: toIso(p.lastSellTs), end_date: p.endDate };
}

export class SignalEngine {
  private db: SupabaseClient; private cfg: RuleConfig; private ch: Channels; private now: () => number; private log: (m: string) => void;
  private wallets = new Map<string, WalletProfile>(); private median = new Map<string, number>(); private paperSize: number;
  private minStoreUsd: number; private markets: MarketMetaSource;
  /** Per-wallet serialisation: a wallet's fills and reconciliation never interleave (position book is read-modify-write). */
  private locks = new Map<string, Promise<unknown>>();
  private withWalletLock<T>(wallet: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(wallet) ?? Promise.resolve(); const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {}); this.locks.set(wallet, tail); tail.then(() => { if (this.locks.get(wallet) === tail) this.locks.delete(wallet); });
    return run;
  }
  private seen = new Set<string>(); private remember(id: string) { this.seen.add(id); if (this.seen.size > 20_000) { const first = this.seen.values().next().value; if (first) this.seen.delete(first); } }
  constructor(d: EngineDeps) { this.db = d.db; this.cfg = d.cfg ?? configFromEnv(); this.ch = d.channels ?? channelsFromEnv(); this.now = d.now ?? (() => Math.floor(Date.now() / 1000)); this.log = d.log ?? (() => {}); const ps = Number(process.env.PAPER_SIZE_USD); this.paperSize = Number.isFinite(ps) && ps > 0 ? ps : 100; this.minStoreUsd = this.cfg.minFillUsd; this.markets = d.markets ?? new GammaMarketMeta(this.db); }

  /** Load tracked wallets into memory. Call at start and after each refresh. */
  async loadWallets(): Promise<Map<string, WalletProfile>> {
    const { data, error } = await this.db.from("wallets").select("*").eq("tracked", true);
    if (error) throw error;
    this.wallets.clear();
    for (const r of data ?? []) this.wallets.set(r.address, { address: r.address, name: r.name, copyScore: Number(r.copy_score), pnl90d: Number(r.pnl_90d), style: r.style, fillsPerDay: r.fills_per_day, programShare: r.program_share, concentration: r.concentration, netDd: r.net_dd, monthsUp: r.months_up, monthsTotal: r.months_total, daysIdle: r.days_idle, tradeCount: r.trade_count, sources: r.sources ?? [] });
    return this.wallets;
  }
  isTracked(wallet: string): boolean { return this.wallets.has(wallet.toLowerCase()); }
  trackedAddresses(): string[] { return [...this.wallets.keys()]; }
  trackedProfiles(): WalletProfile[] { return [...this.wallets.values()]; }

  private async medianFill(wallet: string): Promise<number | null> {
    if (this.median.has(wallet)) return this.median.get(wallet)!;
    const { data } = await this.db.from("fills").select("usd").eq("wallet", wallet).order("ts", { ascending: false }).limit(200);
    const xs = (data ?? []).map((r) => Number(r.usd)).filter((x) => x > 0).sort((a, b) => a - b);
    const m = xs.length ? xs[Math.floor(xs.length / 2)] : null; if (m != null) this.median.set(wallet, m); return m;
  }

  /** Process one fill end-to-end. Returns the signals that were persisted (new, not deduped).
   *  Order: filter → atomically CLAIM the fill in the database → (only the claimant) read book → evaluate → write book → signals.
   *  A fill arriving twice (websocket + REST, two workers, a restart) is processed downstream exactly once. */
  async ingest(f: Fill): Promise<Signal[]> {
    const w = this.wallets.get(f.wallet); if (!w) return [];
    // Volume control: sub-threshold fills and bot/maker wallets can never fire a rule, so they never touch the database.
    // Periodic reconciliation (reconcileWallet) corrects any drift this causes in the position book.
    if (f.usd < this.minStoreUsd || isBotLike(w)) return [];
    if (this.seen.has(f.id)) return [];
    return this.withWalletLock(f.wallet, () => this.ingestClaimed(f, w));
  }

  private async ingestClaimed(f: Fill, w: WalletProfile): Promise<Signal[]> {
    // 1) CLAIM: INSERT … ON CONFLICT DO NOTHING RETURNING id. Only the process that actually inserted continues.
    const { data: claimed, error: fe } = await this.db.from("fills").upsert({ id: f.id, wallet: f.wallet, condition_id: f.conditionId, token_id: f.tokenId, side: f.side, size: f.size, price: f.price, usd: f.usd, ts: new Date(f.ts * 1000).toISOString(), title: f.title, slug: f.slug, outcome: f.outcome, source: f.source, raw: null, received_at: toIso(f.receivedAt ?? this.now()) }, { onConflict: "id", ignoreDuplicates: true }).select("id");
    if (fe) throw fe;
    this.remember(f.id);
    if (!claimed || claimed.length === 0) return []; // someone else owns this fill
    await heartbeat(this.db, "last_db_write");
    // 2) position before
    const { data: pb } = await this.db.from("positions").select("*").eq("wallet", f.wallet).eq("token_id", f.tokenId).maybeSingle();
    const before: Position | null = pb ? rowToPosition(pb) : null;
    // 2b) authoritative market end date (for EARLY_ENTRY). Unknown stays null — never guessed.
    let endDate: string | null = before?.endDate ?? null;
    if (f.side === "BUY") { try { endDate = (await this.markets.endDate(f.conditionId)) ?? endDate; } catch { /* stays as known */ } }
    // 3) consensus peers: other tracked wallets long the same token, keyed by their last BUY (never last fill)
    const { data: peersRows } = await this.db.from("positions").select("wallet,last_buy_ts").eq("token_id", f.tokenId).gt("size", 0).neq("wallet", f.wallet);
    const peers = (peersRows ?? []).filter((p) => this.wallets.has(p.wallet)).map((p) => ({ wallet: p.wallet as string, lastBuyTs: toSec(p.last_buy_ts), copyScore: this.wallets.get(p.wallet)!.copyScore }));
    // 4) open signal?
    const { count } = await this.db.from("signals").select("id", { count: "exact", head: true }).eq("wallet", f.wallet).eq("token_id", f.tokenId).is("closed_at", null).neq("kind", "EXIT");
    const evaluatedAt = this.now(); // OBSERVED evaluation time (paper execution latency starts here)
    const signals = evaluate({ fill: f, wallet: w, before, consensus: { peers }, medianFillUsd: await this.medianFill(f.wallet), hasOpenSignal: (count ?? 0) > 0, endDate, now: this.now() }, this.cfg);
    await heartbeat(this.db, "last_eval");
    // 5) update book
    const after = applyFill(before, f, endDate);
    const { error: pe } = await this.db.from("positions").upsert(positionToRow(after), { onConflict: "wallet,token_id" });
    if (pe) throw pe;
    // 6) persist + dispatch (dedupe via unique index)
    const fired: Signal[] = [];
    for (const s of signals) {
      const { data: ins, error } = await this.db.from("signals").insert({ kind: s.kind, severity: s.severity, wallet: s.wallet, wallet_name: s.walletName, condition_id: s.conditionId, token_id: s.tokenId, outcome: s.outcome, title: s.title, slug: s.slug, price: s.price, usd: s.usd, payload: s.payload, dedupe_key: s.dedupeKey, created_at: new Date(s.ts * 1000).toISOString(), received_at: toIso(f.receivedAt ?? this.now()), evaluated_at: toIso(evaluatedAt), source_fill_id: f.id }).select("id").maybeSingle();
      if (error) { if (error.code === "23505") { await this.db.from("data_quality_issues").insert({ kind: "duplicate_signal", ref_type: "signal", ref_id: s.dedupeKey, detail: { wallet: s.wallet, token: s.tokenId } }).then(() => {}, () => {}); continue; } throw error; } // 23505 = duplicate dedupe key
      fired.push(s);
      // V2: paper experiment + consensus context. Failures are logged, never fatal to alerting.
      if (ins?.id) {
        const sig = { id: ins.id as string, kind: s.kind, severity: s.severity, wallet: s.wallet, wallet_name: s.walletName, condition_id: s.conditionId, token_id: s.tokenId, outcome: s.outcome, title: s.title, slug: s.slug, price: s.price, usd: s.usd, payload: s.payload, created_at: new Date(s.ts * 1000).toISOString() };
        try { await recordPaperSignal(this.db, sig, this.paperSize); if (s.kind === "CONSENSUS") await recordConsensusEvent(this.db, sig); } catch (e) { console.error("paper ledger failed", (e as Error).message); }
      }
      const delivered: Record<string, unknown> = await dispatch(s, this.ch);
      // Telegram bot subscribers (per-chat filters). Env TELEGRAM_CHAT_ID above stays as the admin fallback.
      if (process.env.TELEGRAM_BOT_TOKEN && ins?.id) {
        try { delivered.bot = await broadcast(this.db, new TelegramApi(process.env.TELEGRAM_BOT_TOKEN), { id: ins.id, kind: s.kind, severity: s.severity, wallet: s.wallet, wallet_name: s.walletName, outcome: s.outcome, title: s.title, slug: s.slug, price: s.price, usd: s.usd, payload: s.payload, created_at: new Date(s.ts * 1000).toISOString(), closed_at: null }); }
        catch (e) { delivered.bot = { error: (e as Error).message }; }
      }
      if (ins?.id) await this.db.from("signals").update({ delivered }).eq("id", ins.id);
      if (s.kind === "EXIT") await this.db.from("signals").update({ closed_at: new Date(s.ts * 1000).toISOString() }).eq("wallet", s.wallet).eq("token_id", s.tokenId).is("closed_at", null).neq("kind", "EXIT");
      this.log(`${s.kind} ${s.walletName ?? s.wallet} ${s.outcome} @${s.price} $${s.usd}`);
    }
    return fired;
  }

  /**
   * Reconcile one wallet's book with the authoritative /v2/positions snapshot. Establishes state only — never
   * evaluates rules or creates signals. Idempotent: running it twice leaves the same rows.
   *  - remote open position → upsert size / avg price / cost (keeps first_seen, last_buy_ts, last_sell_ts)
   *  - local open position absent remotely → size 0
   *  - rows touched by a live fill in the last `freshSec` seconds are left alone (the REST snapshot is CDN-cached
   *    and could be older than a fill we just applied)
   */
  async reconcileWallet(wallet: string, remote: RemotePosition[], opts: { freshSec?: number } = {}): Promise<{ upserted: number; zeroed: number; skippedFresh: number }> {
    const addr = wallet.toLowerCase(); const freshSec = opts.freshSec ?? 600;
    return this.withWalletLock(addr, async () => {
      const now = this.now();
      const { data: local } = await this.db.from("positions").select("*").eq("wallet", addr);
      const byToken = new Map((local ?? []).map((r) => [r.token_id as string, rowToPosition(r)]));
      const remoteTokens = new Set<string>(); let upserted = 0, zeroed = 0, skippedFresh = 0;
      const rows = [];
      // /v2/positions pages are an offset walk and can repeat a row across pages: one row per token.
      for (const r of remote) {
        if (remoteTokens.has(r.tokenId)) continue;
        remoteTokens.add(r.tokenId); const cur = byToken.get(r.tokenId);
        if (cur && now - cur.lastSeen < freshSec) { skippedFresh++; continue; }
        const same = cur && Math.abs(cur.size - r.size) < 1e-9 && Math.abs(cur.avgPrice - r.avgPrice) < 1e-9;
        if (same) continue;
        const p: Position = { wallet: addr, tokenId: r.tokenId, conditionId: r.conditionId || cur?.conditionId || "", outcome: r.outcome || cur?.outcome || "", title: r.title || cur?.title || "", slug: r.slug || cur?.slug || "",
          size: r.size, avgPrice: r.avgPrice, costUsd: r.costUsd, peakSize: Math.max(cur?.peakSize ?? 0, r.size), firstSeen: cur && cur.size > 0 ? cur.firstSeen : (r.lastEventAt ?? now),
          lastSeen: now, lastBuyTs: cur?.lastBuyTs ?? null, lastSellTs: cur?.lastSellTs ?? null, endDate: r.endDate ?? cur?.endDate ?? null };
        rows.push(positionToRow(p)); upserted++;
      }
      for (const [token, cur] of byToken) {
        if (remoteTokens.has(token) || cur.size <= 0) continue;
        if (now - cur.lastSeen < freshSec) { skippedFresh++; continue; }
        rows.push(positionToRow({ ...cur, size: 0, costUsd: 0, avgPrice: 0, lastSeen: now })); zeroed++;
      }
      for (let i = 0; i < rows.length; i += 200) { const { error } = await this.db.from("positions").upsert(rows.slice(i, i + 200), { onConflict: "wallet,token_id" }); if (error) throw error; }
      return { upserted, zeroed, skippedFresh };
    });
  }
}
