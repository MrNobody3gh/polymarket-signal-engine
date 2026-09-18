/**
 * Stateful engine: takes normalised fills, keeps the position book in Supabase,
 * runs the rules, persists signals, dispatches alerts. Shared by the REST
 * poller (Vercel cron) and the websocket worker.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Fill, Position, Signal, WalletProfile } from "../polymarket/types";
import { applyFill, configFromEnv, evaluate, type RuleConfig } from "./rules";
import { channelsFromEnv, dispatch, type Channels } from "../alerts/dispatch";
import { TelegramApi } from "../telegram/api";
import { broadcast } from "../telegram/broadcast";
import { recordConsensusEvent, recordPaperSignal } from "../paper/ledger";
import { heartbeat } from "../health/heartbeat";

export interface EngineDeps { db: SupabaseClient; cfg?: RuleConfig; channels?: Channels; now?: () => number; log?: (m: string) => void }

export class SignalEngine {
  private db: SupabaseClient; private cfg: RuleConfig; private ch: Channels; private now: () => number; private log: (m: string) => void;
  private wallets = new Map<string, WalletProfile>(); private median = new Map<string, number>(); private paperSize: number;
  constructor(d: EngineDeps) { this.db = d.db; this.cfg = d.cfg ?? configFromEnv(); this.ch = d.channels ?? channelsFromEnv(); this.now = d.now ?? (() => Math.floor(Date.now() / 1000)); this.log = d.log ?? (() => {}); const ps = Number(process.env.PAPER_SIZE_USD); this.paperSize = Number.isFinite(ps) && ps > 0 ? ps : 100; }

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

  private async medianFill(wallet: string): Promise<number | null> {
    if (this.median.has(wallet)) return this.median.get(wallet)!;
    const { data } = await this.db.from("fills").select("usd").eq("wallet", wallet).order("ts", { ascending: false }).limit(200);
    const xs = (data ?? []).map((r) => Number(r.usd)).filter((x) => x > 0).sort((a, b) => a - b);
    const m = xs.length ? xs[Math.floor(xs.length / 2)] : null; if (m != null) this.median.set(wallet, m); return m;
  }

  /** Process one fill end-to-end. Returns the signals that were persisted (new, not deduped). */
  async ingest(f: Fill): Promise<Signal[]> {
    const w = this.wallets.get(f.wallet); if (!w) return [];
    // 1) store fill (idempotent)
    const { error: fe } = await this.db.from("fills").upsert({ id: f.id, wallet: f.wallet, condition_id: f.conditionId, token_id: f.tokenId, side: f.side, size: f.size, price: f.price, usd: f.usd, ts: new Date(f.ts * 1000).toISOString(), title: f.title, slug: f.slug, outcome: f.outcome, source: f.source, raw: null }, { onConflict: "id", ignoreDuplicates: true });
    if (fe) throw fe;
    await heartbeat(this.db, "last_db_write");
    // 2) position before
    const { data: pb } = await this.db.from("positions").select("*").eq("wallet", f.wallet).eq("token_id", f.tokenId).maybeSingle();
    const before: Position | null = pb ? { wallet: pb.wallet, tokenId: pb.token_id, conditionId: pb.condition_id, outcome: pb.outcome, title: pb.title, slug: pb.slug, size: Number(pb.size), avgPrice: Number(pb.avg_price), costUsd: Number(pb.cost_usd), peakSize: Number(pb.peak_size), firstSeen: Math.floor(Date.parse(pb.first_seen) / 1000), lastSeen: Math.floor(Date.parse(pb.last_seen) / 1000), endDate: pb.end_date } : null;
    // 3) consensus peers: other tracked wallets long the same token
    const { data: peersRows } = await this.db.from("positions").select("wallet,last_seen").eq("token_id", f.tokenId).gt("size", 0).neq("wallet", f.wallet);
    const peers = (peersRows ?? []).filter((p) => this.wallets.has(p.wallet)).map((p) => ({ wallet: p.wallet, lastBuyTs: Math.floor(Date.parse(p.last_seen) / 1000), copyScore: this.wallets.get(p.wallet)!.copyScore }));
    // 4) open signal?
    const { count } = await this.db.from("signals").select("id", { count: "exact", head: true }).eq("wallet", f.wallet).eq("token_id", f.tokenId).is("closed_at", null).neq("kind", "EXIT");
    const signals = evaluate({ fill: f, wallet: w, before, consensus: { peers }, medianFillUsd: await this.medianFill(f.wallet), hasOpenSignal: (count ?? 0) > 0, endDate: before?.endDate ?? null, now: this.now() }, this.cfg);
    await heartbeat(this.db, "last_eval");
    // 5) update book
    const after = applyFill(before, f, before?.endDate ?? null);
    const { error: pe } = await this.db.from("positions").upsert({ wallet: after.wallet, token_id: after.tokenId, condition_id: after.conditionId, outcome: after.outcome, title: after.title, slug: after.slug, size: after.size, avg_price: after.avgPrice, cost_usd: after.costUsd, peak_size: after.peakSize, first_seen: new Date(after.firstSeen * 1000).toISOString(), last_seen: new Date(after.lastSeen * 1000).toISOString(), end_date: after.endDate }, { onConflict: "wallet,token_id" });
    if (pe) throw pe;
    // 6) persist + dispatch (dedupe via unique index)
    const fired: Signal[] = [];
    for (const s of signals) {
      const { data: ins, error } = await this.db.from("signals").insert({ kind: s.kind, severity: s.severity, wallet: s.wallet, wallet_name: s.walletName, condition_id: s.conditionId, token_id: s.tokenId, outcome: s.outcome, title: s.title, slug: s.slug, price: s.price, usd: s.usd, payload: s.payload, dedupe_key: s.dedupeKey, created_at: new Date(s.ts * 1000).toISOString() }).select("id").maybeSingle();
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
}
