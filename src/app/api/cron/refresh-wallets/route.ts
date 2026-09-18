import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { refresh, seedFromSnapshot } from "@/lib/scoring/refresh";
import { cronAuthorized } from "@/lib/auth";
import snapshot from "../../../../../config/watchlist.json";
export const maxDuration = 300; export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  if (url.searchParams.get("seed") === "1") { const n = await seedFromSnapshot(db(), snapshot); return NextResponse.json({ ok: true, seeded: n }); }
  const r = await refresh(db(), undefined, { limit: Number(url.searchParams.get("limit") ?? 5000) });
  return NextResponse.json({ ok: true, ...r, at: new Date().toISOString() });
}
