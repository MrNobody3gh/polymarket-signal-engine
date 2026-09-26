/** Fan a persisted signal out to every subscriber whose filters match.
 *  Idempotent per (signal, chat) via tg_deliveries; paced under Telegram's ~30 msg/s global limit.
 *
 *  Failure handling (never retried forever):
 *   - group upgraded to supergroup (parameters.migrate_to_chat_id) → subscription moves to the new id, old one disabled
 *   - permanent errors (chat not found, kicked, blocked, deactivated, not a member, 403) → disabled with the reason
 *   - transient errors (429, 5xx, network) → exponential back-off; disabled after MAX_CONSECUTIVE_FAILURES
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { TelegramApi, type TgResult } from "./api";
import { matches, signalButtons, signalHtml, type SignalRow, type Subscriber } from "./commands";
import { heartbeat } from "../health/heartbeat";

export const MAX_CONSECUTIVE_FAILURES = 8;
const PERMANENT = /chat not found|bot was kicked|bot was blocked|blocked by the user|user is deactivated|not a member|group chat was deleted|have no rights to send|CHAT_WRITE_FORBIDDEN|PEER_ID_INVALID/i;

export type FailureKind = { kind: "MIGRATED"; to: number } | { kind: "PERMANENT"; reason: string } | { kind: "TRANSIENT"; reason: string; retryAfterSec: number | null };
export function classifyFailure(r: TgResult): FailureKind {
  const to = r.parameters?.migrate_to_chat_id; if (to) return { kind: "MIGRATED", to };
  const d = r.description ?? "";
  if (r.error_code === 403 || PERMANENT.test(d)) return { kind: "PERMANENT", reason: d || `HTTP ${r.error_code}` };
  if (r.error_code === 400 && /chat/i.test(d)) return { kind: "PERMANENT", reason: d };
  return { kind: "TRANSIENT", reason: d || `HTTP ${r.error_code ?? "?"}`, retryAfterSec: r.parameters?.retry_after ?? null };
}
export function backoffSec(failures: number, retryAfter: number | null): number { return Math.max(retryAfter ?? 0, Math.min(3600, 30 * 2 ** Math.max(0, failures - 1))); }

/** Move a subscription to a new chat id (supergroup upgrade), keeping its filters. Idempotent. */
export async function migrateSubscriber(db: SupabaseClient, sub: Subscriber, to: number, nowIso: string) {
  const { data: existing } = await db.from("tg_subscribers").select("chat_id").eq("chat_id", to).maybeSingle();
  if (!existing) await db.from("tg_subscribers").upsert({ chat_id: to, username: sub.username, kinds: sub.kinds, min_severity: sub.min_severity, min_usd: sub.min_usd, min_score: sub.min_score, only_wallets: sub.only_wallets, muted_wallets: sub.muted_wallets, muted_until: sub.muted_until, active: true, consecutive_failures: 0, next_attempt_at: null, disabled_reason: null, last_error: null, updated_at: nowIso }, { onConflict: "chat_id" });
  await db.from("tg_subscribers").update({ active: false, disabled_reason: "MIGRATED", migrated_to: to, updated_at: nowIso }).eq("chat_id", sub.chat_id);
}

export async function broadcast(db: SupabaseClient, api: TelegramApi, signal: SignalRow, opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<{ sent: number; failed: number; skipped: number; migrated: number; disabled: number }> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))); const now = opts.now ?? (() => Date.now());
  const { data: subs } = await db.from("tg_subscribers").select("*").eq("active", true);
  const { data: done } = await db.from("tg_deliveries").select("chat_id").eq("signal_id", signal.id);
  const already = new Set((done ?? []).map((d) => Number(d.chat_id)));
  let sent = 0, failed = 0, skipped = 0, migrated = 0, disabled = 0;
  const html = signalHtml(signal); const buttons = signalButtons(signal);
  for (const sub of (subs ?? []) as Subscriber[]) {
    if (already.has(Number(sub.chat_id)) || !matches(sub, signal)) { skipped++; continue; }
    if (sub.next_attempt_at && Date.parse(sub.next_attempt_at) > now()) { skipped++; continue; } // backing off
    let target = sub; let r = await api.send(target.chat_id, html, buttons);
    const nowIso = new Date(now()).toISOString();
    if (!r.ok) {
      const f = classifyFailure(r);
      if (f.kind === "MIGRATED") {
        await migrateSubscriber(db, sub, f.to, nowIso); migrated++;
        target = { ...sub, chat_id: f.to }; r = await api.send(f.to, html, buttons);
      } else if (f.kind === "PERMANENT") {
        await db.from("tg_subscribers").update({ active: false, disabled_reason: "PERMANENT_ERROR", last_error: f.reason.slice(0, 300), updated_at: nowIso }).eq("chat_id", sub.chat_id); disabled++;
      } else {
        const n = (sub.consecutive_failures ?? 0) + 1; const off = n >= MAX_CONSECUTIVE_FAILURES;
        await db.from("tg_subscribers").update({ consecutive_failures: n, last_error: f.reason.slice(0, 300), next_attempt_at: new Date(now() + backoffSec(n, f.retryAfterSec) * 1000).toISOString(), ...(off ? { active: false, disabled_reason: "REPEATED_FAILURE" } : {}), updated_at: nowIso }).eq("chat_id", sub.chat_id);
        if (off) disabled++;
      }
    }
    const ok = !!r.ok; ok ? sent++ : failed++;
    await db.from("tg_deliveries").upsert({ signal_id: signal.id, chat_id: target.chat_id, ok });
    if (ok && (target.consecutive_failures ?? 0) > 0) await db.from("tg_subscribers").update({ consecutive_failures: 0, next_attempt_at: null, last_error: null }).eq("chat_id", target.chat_id);
    if (sent % 25 === 0 && sent > 0) await sleep(1000);
  }
  if (sent > 0) await heartbeat(db, "last_tg_delivery", new Date(now()).toISOString());
  return { sent, failed, skipped, migrated, disabled };
}
