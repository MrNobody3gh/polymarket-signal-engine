import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { SignalEngine } from "@/lib/signals/engine";
import { pollOnce } from "@/lib/signals/poll";
import { cronAuthorized } from "@/lib/auth";
export const maxDuration = 60; export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const engine = new SignalEngine({ db: db(), log: (m) => console.log("[signal]", m) });
  await engine.loadWallets();
  const r = await pollOnce(db(), engine);
  return NextResponse.json({ ok: true, ...r, at: new Date().toISOString() });
}
