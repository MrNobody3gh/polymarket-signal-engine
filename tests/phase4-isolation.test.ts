/**
 * Phase 4.0 guarantees that are about the repository rather than a function: nothing here is wired into production, the
 * Phase 4.0 code cannot write or trade, and no dependency was added.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === "node_modules" || n === ".next" ? [] : walk(p)) : [p]; });
const src = (p: string) => readFileSync(p, "utf8");

// Phase 4.1 adds exactly one production path: the flag-gated shadow order-book job, imported by the worker entry point and nothing else.
const SHADOW_HOOK = "worker/ws-listener.ts"; const SHADOW_DIR = join("src", "lib", "phase4", "shadow");
/** Every mention of "phase4" in `text` with the allowed shadow-job import paths and the heartbeat key removed. */
const strayPhase4 = (text: string) => text.replace(/\.\.\/src\/lib\/phase4\/shadow\/(config|job)/g, "").replace(/\bPhase 4\.1\b/g, "");

describe("Phase 4.0 is not part of any production path", () => {
  it("nothing outside src/lib/phase4, scripts/phase4 and tests imports it (the Vercel routes, pages, the other libraries); the worker only imports the 4.1 shadow job", () => {
    const files = [...walk("src"), ...walk("worker"), ...walk("scripts"), "next.config.ts", "vercel.json"].filter((p) => !p.startsWith(join("src", "lib", "phase4")) && !p.startsWith(join("scripts", "phase4")));
    const offenders = files.filter((p) => (p === SHADOW_HOOK ? /phase4/i.test(strayPhase4(src(p))) : /phase4/i.test(src(p))) && !/\.(md)$/.test(p));
    expect(offenders).toEqual([]);
  });
  it("vercel.json does not mention the new scripts, and the worker entry point mentions nothing of Phase 4 but the two shadow-job imports", () => { expect(src("vercel.json")).not.toMatch(/phase4/i); expect(strayPhase4(src("worker/ws-listener.ts"))).not.toMatch(/phase4/i); });
});

describe("the Phase 4.0 library cannot write to a database or reach a trading, account or credential endpoint", () => {
  const libs = walk(join("src", "lib", "phase4")).filter((p) => p.endsWith(".ts"));
  it("has files to check", () => { expect(libs.length).toBeGreaterThanOrEqual(12); });
  // Phase 4.1: the ONE file that writes is shadow/store.ts, and only to shadow_books (tests/phase4-shadow-readonly.test.ts checks that precisely).
  it("never calls a write method or rpc (except shadow/store.ts, the 4.1 recorder's only database writer)", () => { for (const p of libs.filter((x) => x !== join(SHADOW_DIR, "store.ts"))) expect(src(p), p).not.toMatch(/\.(insert|upsert|update|delete|rpc)\s*\(/); });
  it("never builds an authorization or key header, and never names an order, balance, wallet-key or account endpoint", () => {
    for (const p of libs) { const t = src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); expect(t, p).not.toMatch(/["']?authorization["']?\s*:|setRequestHeader|\.headers\.set\(|bearer|private[-_ ]?key|passphrase|signature|\/orders?\b|\/balance|\/account|\/positions\b|\/portfolio|createOrder|postOrder|placeOrder|x-api-key|api[-_]key\s*:/i); }
  });
  it("the HTTP client only issues GET", () => { const t = src(join("src", "lib", "phase4", "http.ts")); expect(t).toContain('method: "GET"'); expect(t).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/); });
  it("receives the database only as the select-only wrapper (the probe and the CLIs never import the Supabase client type)", () => {
    for (const p of ["probe.ts", "s1a.ts", "audit.ts", "mapping.ts", "funnel.ts", "feasibility.ts"]) expect(src(join("src", "lib", "phase4", p)), p).not.toMatch(/SupabaseClient/);
  });
});

describe("no dependency was added", () => {
  it("package.json lists exactly the pre-Phase-4.0 dependencies", () => {
    const pkg = JSON.parse(src("package.json"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@supabase/supabase-js", "next", "react", "react-dom", "ws"]);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@types/node", "@types/pg", "@types/react", "@types/react-dom", "@types/ws", "pg", "tsx", "typescript", "vitest"]);
  });
  it("the three new npm scripts exist and point at scripts/phase4", () => { const s = JSON.parse(src("package.json")).scripts; expect(s["phase4:ts-audit"]).toBe("tsx scripts/phase4/timestamp-audit.ts"); expect(s["phase4:coverage"]).toBe("tsx scripts/phase4/coverage-probe.ts"); expect(s["phase4:mutations"]).toBe("tsx scripts/phase4/mutation-check.ts"); });
});

describe("the documents describe what exists", () => {
  it("every file and npm script the Phase 4.0 README names exists", () => {
    const readme = src("docs/phase4/README.md"); const files = [...readme.matchAll(/`((?:src|scripts|tests|docs)\/[A-Za-z0-9_./{},*-]+)`/g)].map((m) => m[1]).filter((p) => !/[{}*]/.test(p) && /\.[a-z]+$/.test(p) && (!p.startsWith("docs/phase4/data/") || p.endsWith("README.md"))); // outputs of the scripts do not exist until they are run
    for (const f of files) expect(() => statSync(f), f).not.toThrow();
    for (const s of readme.matchAll(/npm run (phase4:[a-z-]+)/g)) expect(JSON.parse(src("package.json")).scripts[s[1]], s[1]).toBeTruthy();
  });
  it("the S1b document's stated start of the clean regime equals the code's", () => { expect(src("docs/phase4/S1b_COVERAGE.md")).toContain("27 Sep 2026 04:28:38 UTC"); expect(src("src/lib/phase4/probe.ts")).toContain("2026-09-27T04:28:38Z"); });
});
