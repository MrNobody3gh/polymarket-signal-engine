import { describe, it, expect, vi } from "vitest";
import { dispatch, channelsFromEnv } from "@/lib/alerts/dispatch";
import { formatSignal } from "@/lib/signals/format";
import type { Signal } from "@/lib/polymarket/types";
const sig: Signal = { kind: "CONSENSUS", severity: 4, wallet: "0xabcdef1234567890", walletName: "paddaa", conditionId: "c", tokenId: "t", outcome: "No", title: "Iran-Oman Hormuz Agreement by September 30?", slug: "hormuz", price: 0.658, usd: 12_400, payload: { copyScore: 72, wallets: 3 }, dedupeKey: "CONS:t:3", ts: 1 };
describe("formatSignal", () => {
  it("is compact and carries the links", () => { const t = formatSignal(sig); expect(t).toContain("Consensus ★★★★☆"); expect(t).toContain("paddaa bought No @ 0.658 for $12.4k"); expect(t).toContain("3 wallets same side"); expect(t).toContain("polymarket.com/event/hormuz"); });
});
describe("dispatch", () => {
  it("posts to every configured channel and reports per-channel success", async () => {
    const f = vi.fn(async (url: string, _init?: RequestInit) => new Response("{}", { status: url.includes("discord") ? 500 : 200 }));
    const r = await dispatch(sig, channelsFromEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1", DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/x", RESEND_API_KEY: "r", ALERT_EMAIL_TO: "a@b.c" }), f as unknown as typeof fetch);
    expect(r).toEqual({ telegram: true, discord: false, email: true }); expect(f).toHaveBeenCalledTimes(3);
    const tg = JSON.parse(String(f.mock.calls[0][1]?.body)); expect(tg.chat_id).toBe("1");
  });
  it("does nothing with no channels", async () => { const f = vi.fn(); expect(await dispatch(sig, {}, f as unknown as typeof fetch)).toEqual({}); expect(f).not.toHaveBeenCalled(); });
});
