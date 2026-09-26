/**
 * The rule engine. Pure: (fill, wallet profile, position before the fill,
 * consensus context, config) -> signals[]. No I/O, fully unit-tested.
 */
import { createHash } from "node:crypto";
import type { Fill, Position, Signal, WalletProfile } from "../polymarket/types";

export interface RuleConfig {
  minFillUsd: number; newPositionMinUsd: number; convictionAddRatio: number; earlyEntryMaxPrice: number;
  earlyEntryMaxDays: number; exitSellRatio: number; consensusWindowHours: number; dedupeMinutes: number; minCopyScore: number;
}
export const DEFAULT_CONFIG: RuleConfig = {
  minFillUsd: 50, newPositionMinUsd: 2000, convictionAddRatio: 0.5, earlyEntryMaxPrice: 0.35, earlyEntryMaxDays: 30,
  exitSellRatio: 0.6, consensusWindowHours: 72, dedupeMinutes: 10, minCopyScore: 40,
};
export function configFromEnv(env: Record<string, string | undefined> = process.env): RuleConfig {
  const n = (k: string, d: number) => { const v = Number(env[k]); return Number.isFinite(v) && env[k] !== undefined && env[k] !== "" ? v : d; };
  return {
    minFillUsd: n("MIN_FILL_USD", DEFAULT_CONFIG.minFillUsd), newPositionMinUsd: n("NEW_POSITION_MIN_USD", DEFAULT_CONFIG.newPositionMinUsd),
    convictionAddRatio: n("CONVICTION_ADD_RATIO", DEFAULT_CONFIG.convictionAddRatio), earlyEntryMaxPrice: n("EARLY_ENTRY_MAX_PRICE", DEFAULT_CONFIG.earlyEntryMaxPrice),
    earlyEntryMaxDays: n("EARLY_ENTRY_MAX_DAYS", DEFAULT_CONFIG.earlyEntryMaxDays), exitSellRatio: n("EXIT_SELL_RATIO", DEFAULT_CONFIG.exitSellRatio),
    consensusWindowHours: n("CONSENSUS_WINDOW_HOURS", DEFAULT_CONFIG.consensusWindowHours), dedupeMinutes: n("DEDUPE_MINUTES", DEFAULT_CONFIG.dedupeMinutes),
    minCopyScore: n("MIN_COPY_SCORE", DEFAULT_CONFIG.minCopyScore),
  };
}

export interface ConsensusContext {
  /** Other tracked wallets currently holding the same token, with the time of their last BUY fill
   *  (null if no buy was observed — e.g. a position known only from reconciliation). */
  peers: { wallet: string; lastBuyTs: number | null; copyScore: number }[];
}

/** Deterministic identity of a consensus group: token + the sorted, de-duplicated participant set. */
export function consensusKey(tokenId: string, wallets: string[]): string {
  const set = [...new Set(wallets.map((w) => w.toLowerCase()))].sort();
  return `CONS:${tokenId}:${createHash("sha256").update(set.join(",")).digest("hex").slice(0, 24)}`;
}
export interface RuleContext {
  fill: Fill; wallet: WalletProfile; before: Position | null; consensus: ConsensusContext; medianFillUsd: number | null;
  /** Whether an open (un-closed) signal already exists for this wallet+token. */
  hasOpenSignal: boolean; endDate: string | null; now: number;
}

/** Apply a fill to a position book entry. Returns the position after the fill. */
export function applyFill(before: Position | null, f: Fill, endDate: string | null): Position {
  const base: Position = before ?? { wallet: f.wallet, tokenId: f.tokenId, conditionId: f.conditionId, outcome: f.outcome, title: f.title, slug: f.slug, size: 0, avgPrice: 0, costUsd: 0, peakSize: 0, firstSeen: f.ts, lastSeen: f.ts, lastBuyTs: null, lastSellTs: null, endDate };
  const p: Position = { ...base, lastSeen: Math.max(base.lastSeen, f.ts), endDate: endDate ?? base.endDate };
  if (f.title && !p.title) p.title = f.title; if (f.slug && !p.slug) p.slug = f.slug; if (f.outcome && !p.outcome) p.outcome = f.outcome;
  if (f.side === "BUY") {
    const newSize = p.size + f.size;
    p.avgPrice = newSize > 0 ? (p.avgPrice * p.size + f.price * f.size) / newSize : 0;
    p.size = newSize; p.costUsd = p.avgPrice * p.size; p.peakSize = Math.max(p.peakSize, newSize);
    if (before === null || before.size <= 0) p.firstSeen = f.ts;
    p.lastBuyTs = Math.max(p.lastBuyTs ?? 0, f.ts);
  } else {
    p.size = Math.max(0, p.size - f.size); p.costUsd = p.avgPrice * p.size;
    if (p.size === 0) p.avgPrice = 0;
    p.lastSellTs = Math.max(p.lastSellTs ?? 0, f.ts); // a SELL never counts as buying
  }
  return p;
}

export function isBotLike(w: WalletProfile): boolean {
  return w.style === "Market maker / bot" || (w.fillsPerDay ?? 0) > 500 || (w.programShare ?? 0) > 0.25;
}

/** Neg-risk conversion residue often shows up as a ~0.50 position that was never chosen. */
export function looksLikeHedgeResidue(f: Fill, before: Position | null): boolean {
  return f.side === "BUY" && Math.abs(f.price - 0.5) < 0.02 && (before?.size ?? 0) === 0 && f.usd < 200;
}

function daysUntil(endDate: string | null, now: number): number | null {
  if (!endDate) return null; const t = Date.parse(endDate + "T00:00:00Z"); if (!Number.isFinite(t)) return null; return (t / 1000 - now) / 86_400;
}
function severity(usd: number, score: number, extra = 0): 1 | 2 | 3 | 4 | 5 {
  let s = 1; if (usd >= 5_000) s++; if (usd >= 25_000) s++; if (score >= 60) s++; s += extra;
  return Math.max(1, Math.min(5, s)) as 1 | 2 | 3 | 4 | 5;
}
function bucket(ts: number, minutes: number): number { return Math.floor(ts / (minutes * 60)); }

export function evaluate(ctx: RuleContext, cfg: RuleConfig = DEFAULT_CONFIG): Signal[] {
  const { fill: f, wallet: w, before } = ctx;
  const out: Signal[] = [];
  if (f.usd < cfg.minFillUsd) return out;
  if (isBotLike(w)) return out;
  if (w.copyScore < cfg.minCopyScore) return out;
  const base = { wallet: f.wallet, walletName: w.name, conditionId: f.conditionId, tokenId: f.tokenId, outcome: f.outcome, title: f.title, slug: f.slug, price: f.price, usd: f.usd, ts: f.ts };
  const db = bucket(f.ts, cfg.dedupeMinutes);
  const beforeSize = before?.size ?? 0;

  if (f.side === "BUY") {
    if (looksLikeHedgeResidue(f, before)) return out;
    const isNew = beforeSize <= 0;
    const bigEnough = f.usd >= cfg.newPositionMinUsd || (ctx.medianFillUsd != null && ctx.medianFillUsd > 0 && f.usd >= 2 * ctx.medianFillUsd && f.usd >= cfg.minFillUsd * 4);
    if (isNew && bigEnough) {
      out.push({ ...base, kind: "NEW_POSITION", severity: severity(f.usd, w.copyScore), payload: { copyScore: w.copyScore, pnl90d: w.pnl90d, style: w.style, medianFillUsd: ctx.medianFillUsd }, dedupeKey: `NEW:${f.wallet}:${f.tokenId}:${db}` });
    }
    // conviction add: existing position grows ≥ ratio at a price no worse than avg entry
    if (!isNew && before && f.size >= cfg.convictionAddRatio * before.size && f.price <= before.avgPrice + 1e-9 && f.usd >= cfg.minFillUsd * 4) {
      out.push({ ...base, kind: "CONVICTION_ADD", severity: severity(f.usd, w.copyScore), payload: { beforeSize: before.size, addSize: f.size, avgEntry: before.avgPrice, copyScore: w.copyScore }, dedupeKey: `ADD:${f.wallet}:${f.tokenId}:${db}` });
    }
    // early entry: long shot by a wallet that was up every month of the window
    const dte = daysUntil(ctx.endDate, ctx.now);
    if (isNew && f.price <= cfg.earlyEntryMaxPrice && dte != null && dte >= 0 && dte <= cfg.earlyEntryMaxDays && w.monthsTotal >= 2 && w.monthsUp === w.monthsTotal && f.usd >= cfg.minFillUsd * 4) {
      out.push({ ...base, kind: "EARLY_ENTRY", severity: severity(f.usd, w.copyScore, 1), payload: { daysToEnd: Math.round(dte), monthsUp: w.monthsUp, copyScore: w.copyScore }, dedupeKey: `EARLY:${f.wallet}:${f.tokenId}:${db}` });
    }
    // consensus: this buy makes N≥2 tracked wallets on the same side within the window
    // Only a BUY inside the window qualifies a peer; a peer is counted once however many rows/fills it has.
    const cutoff = f.ts - cfg.consensusWindowHours * 3600;
    const byWallet = new Map<string, { wallet: string; lastBuyTs: number; copyScore: number }>();
    for (const p of ctx.consensus.peers) {
      const addr = p.wallet.toLowerCase();
      if (addr === f.wallet || p.lastBuyTs == null || p.lastBuyTs < cutoff) continue;
      const prev = byWallet.get(addr); if (!prev || p.lastBuyTs > prev.lastBuyTs) byWallet.set(addr, { wallet: addr, lastBuyTs: p.lastBuyTs, copyScore: p.copyScore });
    }
    const peers = [...byWallet.values()].sort((a, b) => a.wallet.localeCompare(b.wallet));
    if (peers.length >= 1 && (isNew || f.usd >= cfg.newPositionMinUsd)) {
      const n = peers.length + 1; const weighted = peers.reduce((a, p) => a + p.copyScore, w.copyScore);
      // Dedupe on WHO is in the group (sorted set), not how many: a different group of the same size is a different event.
      out.push({ ...base, kind: "CONSENSUS", severity: severity(f.usd, w.copyScore, Math.min(2, n - 1)), payload: { wallets: n, peers: peers.map((p) => p.wallet), peerLastBuyTs: peers.map((p) => p.lastBuyTs), weightedScore: Math.round(weighted), copyScore: w.copyScore }, dedupeKey: consensusKey(f.tokenId, [f.wallet, ...peers.map((p) => p.wallet)]) });
    }
  } else {
    // exit: sold ≥ ratio of the position (or all of it) and we had alerted on it
    if (before && before.size > 0 && ctx.hasOpenSignal) {
      const soldFrac = Math.min(1, f.size / before.size);
      if (soldFrac >= cfg.exitSellRatio) {
        out.push({ ...base, kind: "EXIT", severity: severity(f.usd, w.copyScore), payload: { soldFraction: Math.round(soldFrac * 100) / 100, avgEntry: before.avgPrice, pnlPerShare: f.price - before.avgPrice, copyScore: w.copyScore }, dedupeKey: `EXIT:${f.wallet}:${f.tokenId}:${db}` });
      }
    }
  }
  return out;
}
