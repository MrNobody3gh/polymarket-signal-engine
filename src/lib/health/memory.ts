/** Process memory instrumentation. Logged periodically and around each job; latest sample stored as health:memory. */
import type { SupabaseClient } from "@supabase/supabase-js";
export interface MemSample { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number; at: string }
export function memSample(): MemSample {
  const m = process.memoryUsage(); const mb = (x: number) => Math.round((x / 1048576) * 10) / 10;
  return { rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), externalMb: mb(m.external), at: new Date().toISOString() };
}
export const fmtMem = (s: MemSample) => `rss ${s.rssMb} MB · heap ${s.heapUsedMb}/${s.heapTotalMb} MB · ext ${s.externalMb} MB`;
/** Run a job and log its duration plus memory before/after. */
export async function withMemLog<T>(name: string, fn: () => Promise<T>, log: (m: string) => void = console.log): Promise<T> {
  const a = memSample(); const t = Date.now();
  try { return await fn(); } finally { const b = memSample(); log(`${new Date().toISOString()} [mem:${name}] ${((Date.now() - t) / 1000).toFixed(1)} s · heap ${a.heapUsedMb}→${b.heapUsedMb} MB · rss ${a.rssMb}→${b.rssMb} MB`); }
}
export async function storeMem(db: SupabaseClient) { try { await db.from("cursors").upsert({ key: "health:memory", value: JSON.stringify(memSample()), updated_at: new Date().toISOString() }); } catch { /* never break the worker */ } }
