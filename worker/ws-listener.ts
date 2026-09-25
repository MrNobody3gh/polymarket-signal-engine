/**
 * Live listener — the real-time path. Vercel functions cannot hold a socket
 * open, so run this anywhere that can (Railway, Fly, a $5 VPS, your laptop):
 *   npm run worker
 * It subscribes to Polymarket's global fill stream (~30–40 fills/s, median
 * $2.40), keeps only tracked wallets, and pushes them through the same engine
 * the REST poller uses. The poller keeps running as the backstop, so a dropped
 * socket costs latency, not fills.
 */
import WebSocket from "ws";
import { db } from "../src/lib/db";
import { SignalEngine } from "../src/lib/signals/engine";
import { WS_LIVE, normalizeFill } from "../src/lib/polymarket/client";
import { pollOnce } from "../src/lib/signals/poll";
import { runMarking, gammaSource } from "../src/lib/paper/mark";
import { buildSnapshot, saveSnapshot } from "../src/lib/paper/snapshot";
import { heartbeat } from "../src/lib/health/heartbeat";

const engine = new SignalEngine({ db: db(), log: (m) => console.log(new Date().toISOString(), "[signal]", m) });
let backoff = 1000; let seen = 0, kept = 0;
// Ingest fills one at a time. Unbounded parallelism starves every other client of the database gateway.
const queue: Parameters<typeof engine.ingest>[0][] = []; let draining = false;
async function drain() { if (draining) return; draining = true; try { while (queue.length) { const f = queue.shift()!; try { await engine.ingest(f); } catch (e) { console.error("ingest failed", (e as Error).message); } } } finally { draining = false; } }

async function main() {
  // Boot must survive a database that is restarting: retry with backoff instead of exiting.
  for (let attempt = 1; ; attempt++) {
    try { await engine.loadWallets(); break; }
    catch (e) { const wait = Math.min(60_000, 2_000 * 2 ** attempt); console.error(`boot: database not ready (${(e as Error).message}); retry in ${wait / 1000}s`); await new Promise((r) => setTimeout(r, wait)); }
  }
  console.log(`tracking ${engine.trackedAddresses().length} wallets`);
  setInterval(() => engine.loadWallets().catch(() => {}), 10 * 60 * 1000); // pick up daily re-scores
  // REST backstop every 60s so the worker alone is enough (Vercel Hobby crons only run daily).
  const poll = () => pollOnce(db(), engine, undefined, { concurrency: 2 }).then((r) => { if (r.fills) console.log(`poll: ${r.fills} fills, ${r.signals} signals`); }).catch((e) => console.error("poll failed", (e as Error).message));
  poll(); setInterval(poll, 60 * 1000);
  // V2: paper price marking + settlement. Idempotent, so an overlap with a manual run is harmless.
  const markEvery = Math.max(2, Number(process.env.MARK_INTERVAL_MIN) || 10) * 60 * 1000;
  const snapshot = () => buildSnapshot(db()).then((snap) => saveSnapshot(db(), snap)).then(() => console.log(new Date().toISOString(), "[paper] snapshot rebuilt")).catch((e) => console.error("snapshot failed", (e as Error).message));
  const mark = () => runMarking(db(), gammaSource(), { log: (m) => console.log(new Date().toISOString(), "[paper]", m) }).catch((e) => console.error("mark failed", (e as Error).message)).then(snapshot);
  setTimeout(snapshot, 5_000);
  // Retention: expire raw fills (7d), closed positions (30d), old data-quality rows (14d). Signals and paper results are permanent.
  const prune = async () => { const { data, error } = await db().rpc("prune_working_data"); if (error) console.error("prune failed", error.message); else console.log(new Date().toISOString(), "[retention] pruned", JSON.stringify(data)); };
  setTimeout(prune, 60_000); setInterval(prune, 24 * 3600 * 1000);
  setTimeout(mark, 20_000); setInterval(mark, markEvery);
  await heartbeat(db(), "worker_boot", new Date().toISOString());
  connect();
}
const SILENCE_LIMIT_MS = 2 * 60 * 1000; // no message for this long = dead socket, even if still "open"
function connect() {
  const ws = new WebSocket(WS_LIVE);
  let pinger: NodeJS.Timeout | undefined; let watchdog: NodeJS.Timeout | undefined; let lastMsg = Date.now();
  const armWatchdog = () => { clearInterval(watchdog); watchdog = setInterval(() => { if (Date.now() - lastMsg > SILENCE_LIMIT_MS) { console.log(`socket silent for ${Math.round((Date.now() - lastMsg) / 1000)}s; forcing reconnect`); heartbeat(db(), "ws_connected", "false").catch(() => {}); ws.terminate(); } }, 15_000); };
  ws.on("open", () => {
    backoff = 1000;
    ws.send(JSON.stringify({ action: "subscribe", subscriptions: [{ topic: "activity", type: "trades" }] }));
    pinger = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send("PING"); }, 5000);
    lastMsg = Date.now(); armWatchdog();
    console.log("connected to", WS_LIVE);
    heartbeat(db(), "ws_connected", "true").catch(() => {});
  });
  ws.on("message", async (buf) => {
    lastMsg = Date.now();
    let msg: unknown; try { msg = JSON.parse(buf.toString()); } catch { return; }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const p = (m as { payload?: Record<string, unknown> })?.payload ?? (m as Record<string, unknown>);
      if (!p || typeof p !== "object" || !("proxyWallet" in p)) continue;
      seen++;
      heartbeat(db(), "last_trade").catch(() => {});
      const f = normalizeFill(p as Record<string, unknown>, "ws"); if (!f || !engine.isTracked(f.wallet)) continue;
      kept++;
      queue.push(f); if (queue.length > 5000) queue.splice(0, queue.length - 5000); // never grow without bound; the poller backstops
      void drain();
    }
  });
  ws.on("pong", () => { lastMsg = Date.now(); });
  ws.on("close", () => { clearInterval(pinger); clearInterval(watchdog); heartbeat(db(), "ws_connected", "false").catch(() => {}); console.log(`socket closed; reconnect in ${backoff}ms (seen ${seen}, kept ${kept})`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60_000); });
  ws.on("error", (e) => { console.error("socket error", e.message); });
}
main().catch((e) => { console.error(e); process.exit(1); });
