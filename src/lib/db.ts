import { createClient, type SupabaseClient } from "@supabase/supabase-js";
let cached: SupabaseClient | null = null;
/** Server-side client (service role). Never import from client components. */
export function db(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  // Every database request gets a deadline: a stalled request must fail (and be retried next cycle), never hang a job.
  const timeoutMs = Number(process.env.DB_REQUEST_TIMEOUT_MS) || 60_000;
  const fetchWithTimeout: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  cached = createClient(url, key, { auth: { persistSession: false }, global: { fetch: fetchWithTimeout } });
  return cached;
}
