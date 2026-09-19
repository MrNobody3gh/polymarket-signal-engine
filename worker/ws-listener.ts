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

async function main() {
  await engine.loadWallets();
  console.log(`tracking ${engine.trackedAddresses().length} wallets`);
  setInterval(() => engine.loadWallets().catch(() => {}), 10 * 60 * 1000); // pick up daily re-scores
  // REST backstop every 60s so the worker alone is enough (Vercel Hobby crons only run daily).
  const poll = () => pollOnce(db(), engine).then((r) => { if (r.fills) console.log(`poll: ${r.fills} fills, ${r.signals} signals`); }).catch((e) => console.error("poll failed", (e as Error).message));
  poll(); setInterval(poll, 60 * 1000);
  // V2: paper price marking + settlement. Idempotent, so an overlap with a manual run is harmless.
  const markEvery = Math.max(2, Number(process.env.MARK_INTERVAL_MIN) || 10) * 60 * 1000;
  const snapshot = () => buildSnapshot(db()).then((snap) => saveSnapshot(db(), snap)).then(() => console.log(new Date().toISOString(), "[paper] snapshot rebuilt")).catch((e) => console.error("snapshot failed", (e as Error).message));
  const mark = () => runMarking(db(), gammaSource(), { log: (m) => console.log(new Date().toISOString(), "[paper]", m) }).catch((e) => console.error("mark failed", (e as Error).message)).then(snapshot);
  setTimeout(snapshot, 5_000);
  setTimeout(mark, 20_000); setInterval(mark, markEvery);
  await heartbeat(db(), "worker_boot", new Date().toISOString());
  connect();
}
function connect() {
  const ws = new WebSocket(WS_LIVE);
  let pinger: NodeJS.Timeout | undefined;
  ws.on("open", () => {
    backoff = 1000;
    ws.send(JSON.stringify({ action: "subscribe", subscriptions: [{ topic: "activity", type: "trades" }] }));
    pinger = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send("PING"); }, 5000);
    console.log("connected to", WS_LIVE);
    heartbeat(db(), "ws_connected", "true").catch(() => {});
  });
  ws.on("message", async (buf) => {
    let msg: unknown; try { msg = JSON.parse(buf.toString()); } catch { return; }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const p = (m as { payload?: Record<string, unknown> })?.payload ?? (m as Record<string, unknown>);
      if (!p || typeof p !== "object" || !("proxyWallet" in p)) continue;
      seen++;
      heartbeat(db(), "last_trade").catch(() => {});
      const f = normalizeFill(p as Record<string, unknown>, "ws"); if (!f || !engine.isTracked(f.wallet)) continue;
      kept++;
      try { await engine.ingest(f); } catch (e) { console.error("ingest failed", (e as Error).message); }
    }
  });
  ws.on("close", () => { clearInterval(pinger); heartbeat(db(), "ws_connected", "false").catch(() => {}); console.log(`socket closed; reconnect in ${backoff}ms (seen ${seen}, kept ${kept})`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60_000); });
  ws.on("error", (e) => { console.error("socket error", e.message); });
}
main().catch((e) => { console.error(e); process.exit(1); });
