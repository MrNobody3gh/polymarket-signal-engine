import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { TelegramApi, type TgUpdate } from "@/lib/telegram/api";
import { processUpdate } from "@/lib/telegram/bot";
export const dynamic = "force-dynamic"; export const maxDuration = 30;
/** Telegram → here. Verified by the secret token set in scripts/telegram-setup.ts. */
export async function POST(req: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token) return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not set" }, { status: 500 });
  const update = (await req.json()) as TgUpdate;
  // Acknowledge immediately; a slow reply must never make Telegram re-send the update.
  after(async () => { try { await processUpdate(update, db(), new TelegramApi(token)); } catch (e) { console.error("webhook processing failed", (e as Error).message); } });
  return NextResponse.json({ ok: true });
}
