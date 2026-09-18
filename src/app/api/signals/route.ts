import { NextResponse } from "next/server";
import { db } from "@/lib/db";
export const dynamic = "force-dynamic";
/** JSON feed of recent signals — for the dashboard, a bot, or a spreadsheet. */
export async function GET(req: Request) {
  const url = new URL(req.url); const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100)); const kind = url.searchParams.get("kind");
  let q = db().from("signals").select("*").order("created_at", { ascending: false }).limit(limit);
  if (kind) q = q.eq("kind", kind);
  const { data, error } = await q; if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ signals: data });
}
