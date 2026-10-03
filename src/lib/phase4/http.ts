/**
 * Phase 4.0 — a deliberately small, polite HTTP reader for PUBLIC, UNAUTHENTICATED venue endpoints.
 *
 * Rules enforced here (brief, "Hard rules"):
 *  - at most 2 requests per second per client (a minimum gap of `minIntervalMs` between request starts, retries included);
 *  - a descriptive User-Agent; no cookies, no credentials, no Authorization header, ever (there is no option to add one);
 *  - bounded retries: at most `maxAttempts` (default 3) for transient failures only (429, 5xx, timeout, network), with
 *    exponential backoff and Retry-After honoured (capped);
 *  - NEVER retried and never worked around: 401 / 403 / 451 (reported as BLOCKED), 404, other 4xx, malformed JSON. After
 *    `blockedStop` consecutive BLOCKED answers (default 2) the client stops sending requests to that origin for the rest of
 *    the run ("stop that part, report exactly what happened, continue with the rest");
 *  - it never throws: every outcome is a value with a precise `kind`, so a script can report and carry on.
 */
export const DEFAULT_USER_AGENT = "polymarket-signal-engine-research/4.0 (read-only public-data audit; contact: repository owner)";

export type HttpFailureKind = "BLOCKED" | "BLOCKED_SKIPPED" | "NOT_FOUND" | "BAD_REQUEST" | "RATE_LIMITED" | "SERVER_ERROR" | "TIMEOUT" | "NETWORK" | "MALFORMED";
export type HttpResult<T = unknown> =
  | { ok: true; status: number; json: T; ms: number; attempts: number }
  | { ok: false; kind: HttpFailureKind; status: number | null; message: string; attempts: number };

export interface HttpEvent { url: string; ok: boolean; kind: string; status: number | null; attempts: number }
export interface PoliteHttpOptions {
  fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number;
  userAgent?: string; minIntervalMs?: number; maxAttempts?: number; timeoutMs?: number; blockedStop?: number; maxRetryAfterMs?: number;
}

export class PoliteHttp {
  private f: typeof fetch; private sleep: (ms: number) => Promise<void>; private now: () => number;
  private ua: string; private gap: number; private maxAttempts: number; private timeoutMs: number; private blockedStop: number; private maxRetryAfterMs: number;
  private lastStart = -Infinity; private blockedRun = new Map<string, number>(); private stopped = new Set<string>();
  /** Every request outcome, in order (urls without credentials by construction). Scripts summarise it. */
  readonly events: HttpEvent[] = []; requests = 0;
  constructor(o: PoliteHttpOptions = {}) {
    this.f = o.fetch ?? globalThis.fetch.bind(globalThis); this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))); this.now = o.now ?? (() => Date.now());
    this.ua = o.userAgent ?? DEFAULT_USER_AGENT;
    // The 2 requests/second ceiling is a hard floor on the gap: a caller may be slower, never faster.
    this.gap = Math.max(500, o.minIntervalMs ?? 500); this.maxAttempts = Math.max(1, Math.min(3, o.maxAttempts ?? 3));
    this.timeoutMs = o.timeoutMs ?? 20_000; this.blockedStop = Math.max(1, o.blockedStop ?? 2); this.maxRetryAfterMs = o.maxRetryAfterMs ?? 30_000;
  }
  isStopped(origin: string): boolean { return this.stopped.has(origin); }
  private originOf(url: string): string { try { return new URL(url).origin; } catch { return url; } }

  private async pace() {
    const wait = this.lastStart + this.gap - this.now(); if (wait > 0) await this.sleep(wait);
    this.lastStart = this.now();
  }

  async getJson<T = unknown>(url: string): Promise<HttpResult<T>> {
    const origin = this.originOf(url);
    const done = (r: HttpResult<T>, attempts: number): HttpResult<T> => { this.events.push({ url, ok: r.ok, kind: r.ok ? "OK" : r.kind, status: r.status, attempts }); return r; };
    if (this.stopped.has(origin)) return done({ ok: false, kind: "BLOCKED_SKIPPED", status: null, message: `skipped: ${origin} refused access earlier in this run and is not asked again`, attempts: 0 }, 0);
    let last: HttpResult<T> = { ok: false, kind: "NETWORK", status: null, message: "no attempt made", attempts: 0 };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.pace(); this.requests++;
      const t0 = this.now(); let retryAfterMs = 0;
      try {
        const res = await this.f(url, { method: "GET", headers: { Accept: "application/json", "User-Agent": this.ua }, signal: AbortSignal.timeout(this.timeoutMs), redirect: "follow" });
        if (res.status === 401 || res.status === 403 || res.status === 451) {
          let body = ""; try { body = (await res.text()).slice(0, 160); } catch { /* ignore */ }
          const n = (this.blockedRun.get(origin) ?? 0) + 1; this.blockedRun.set(origin, n); if (n >= this.blockedStop) this.stopped.add(origin);
          return done({ ok: false, kind: "BLOCKED", status: res.status, message: `HTTP ${res.status} from ${origin}${body ? `: ${body.replace(/\s+/g, " ")}` : ""}`, attempts: attempt }, attempt);
        }
        this.blockedRun.set(origin, 0);
        if (res.status === 404) return done({ ok: false, kind: "NOT_FOUND", status: 404, message: `HTTP 404 on ${url}`, attempts: attempt }, attempt);
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers.get("retry-after")); retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, this.maxRetryAfterMs) : 0;
          last = { ok: false, kind: res.status === 429 ? "RATE_LIMITED" : "SERVER_ERROR", status: res.status, message: `HTTP ${res.status} on ${url}`, attempts: attempt };
        } else if (!res.ok) {
          return done({ ok: false, kind: "BAD_REQUEST", status: res.status, message: `HTTP ${res.status} on ${url}`, attempts: attempt }, attempt);
        } else {
          let text = ""; try { text = await res.text(); } catch (e) { return done({ ok: false, kind: "NETWORK", status: res.status, message: `body read failed: ${(e as Error).message}`, attempts: attempt }, attempt); }
          try { return done({ ok: true, status: res.status, json: JSON.parse(text) as T, ms: this.now() - t0, attempts: attempt }, attempt); }
          catch { return done({ ok: false, kind: "MALFORMED", status: res.status, message: `response is not JSON (${text.length} bytes, starts: ${JSON.stringify(text.slice(0, 60))})`, attempts: attempt }, attempt); }
        }
      } catch (e) {
        const name = (e as Error).name; last = { ok: false, kind: name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "NETWORK", status: null, message: `${name}: ${(e as Error).message}`.slice(0, 200), attempts: attempt };
      }
      if (attempt < this.maxAttempts) await this.sleep(Math.max(retryAfterMs, 1000 * 2 ** (attempt - 1)));
    }
    return done(last, this.maxAttempts);
  }

  /** A compact summary of outcomes by kind, for the script's printed summary. */
  summary(): { requests: number; ok: number; byKind: Record<string, number>; firstErrors: string[] } {
    const byKind: Record<string, number> = {}; const firstErrors: string[] = []; let ok = 0;
    for (const e of this.events) { if (e.ok) { ok++; continue; } byKind[e.kind] = (byKind[e.kind] ?? 0) + 1; if (firstErrors.length < 5) firstErrors.push(`${e.kind}${e.status ? ` ${e.status}` : ""} ${e.url.replace(/\?.*/, "")}`); }
    return { requests: this.requests, ok, byKind, firstErrors };
  }
}
