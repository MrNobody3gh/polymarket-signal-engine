import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runMarking, gammaSource } from "@/lib/paper/mark";
import { cronAuthorized } from "@/lib/auth";
export const maxDuration = 60; export const dynamic = "force-dynamic";
/** Manual / Pro-plan entry point for paper marking. The Railway worker runs the same job every 10 minutes; both are idempotent. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await runMarking(db(), gammaSource(), { limit: 120 });
  return NextResponse.json({ ok: true, ...r, at: new Date().toISOString() });
}
