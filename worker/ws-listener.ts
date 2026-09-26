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
import { WS_LIVE, PolymarketClient, normalizeFill, parseRemotePosition, withOccurrence } from "../src/lib/polymarket/client";
import { isBotLike } from "../src/lib/signals/rules";
import { pollOnce } from "../src/lib/signals/poll";
import { runMarking, gammaSource } from "../src/lib/paper/mark";
import { buildSnapshot, saveSnapshot } from "../src/lib/paper/snapshot";
import { heartbeat } from "../src/lib/health/heartbeat";
import { runSimulation } from "../src/lib/paper/sim/run";
import { memSample, fmtMem, withMemLog, storeMem } from "../src/lib/health/memory";
import { measureActivity, activityRow } from "../src/lib/scoring/activity";
import { GammaMarketMeta } from "../src/lib/polymarket/markets";

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
  // Bootstrap: reconcile every tracked wallet's book from /v2/positions BEFORE any fill is evaluated, so a position
  // that existed before this process started is an existing position (CONVICTION_ADD), not a NEW_POSITION.
  await reconcileAll("boot");
  setInterval(() => reconcileAll("periodic").catch((e) => console.error("reconcile failed", (e as Error).message)), 6 * 3600 * 1000);
  setInterval(() => engine.loadWallets().catch(() => {}), 10 * 60 * 1000); // pick up daily re-scores
  // REST backstop every 60s so the worker alone is enough (Vercel Hobby crons only run daily).
  const poll = () => pollOnce(db(), engine, undefined, { concurrency: 2 }).then((r) => { if (r.fills) console.log(`poll: ${r.fills} fills, ${r.signals} signals`); }).catch((e) => console.error("poll failed", (e as Error).message));
  poll(); setInterval(poll, 60 * 1000);
  // V2: paper price marking + settlement. Idempotent, so an overlap with a manual run is harmless.
  const markEvery = Math.max(2, Number(process.env.MARK_INTERVAL_MIN) || 10) * 60 * 1000;
  const snapshot = () => withMemLog("snapshot", () => buildSnapshot(db())).then((snap) => saveSnapshot(db(), snap)).then(() => console.log(new Date().toISOString(), "[paper] snapshot rebuilt")).catch((e) => console.error("snapshot failed", (e as Error).message));
  // Memory: sample every 5 minutes (log + health:memory) so growth is visible long before an OOM.
  const memTick = () => { const s = memSample(); console.log(`${s.at} [mem] ${fmtMem(s)}`); void storeMem(db()); };
  memTick(); setInterval(memTick, 5 * 60 * 1000);
  // Execution simulation: bounded batches; aggregates computed in Postgres.
  const meta = new GammaMarketMeta(db());
  let simBusy = false;
  const simulate = async () => { if (simBusy) return; simBusy = true; try { await withMemLog("sim", () => runSimulation(db(), { fetchBudget: 3000, metaFetcher: (c) => meta.endDate(c), log: (m) => console.log(new Date().toISOString(), "[sim]", m) })); } catch (e) { console.error("sim failed", (e as Error).message); } finally { simBusy = false; } };
  setTimeout(simulate, 90_000); setInterval(simulate, 15 * 60 * 1000);
  // Bot detection: measure fills/day for tracked wallets daily (and now, if the last measurement is stale).
  const measureAll = async () => {
    const { data } = await db().from("wallets").select("address,program_share,activity_measured_at").eq("tracked", true);
    const stale = (data ?? []).filter((w) => !w.activity_measured_at || Date.now() - Date.parse(w.activity_measured_at) > 20 * 3600 * 1000);
    let ok = 0, lower = 0, insufficient = 0;
    for (const w of stale) {
      const a = await measureActivity(pm, w.address, Math.floor(Date.now() / 1000));
      const { error } = await db().from("wallets").update(activityRow(a, w.program_share == null ? null : Number(w.program_share))).eq("address", w.address);
      if (!error) { if (a.status === "OK") ok++; else if (a.status === "LOWER_BOUND") lower++; else insufficient++; }
    }
    if (stale.length) { console.log(new Date().toISOString(), `[activity] measured ${stale.length} wallets: ${ok} ok, ${lower} lower-bound, ${insufficient} insufficient`); await engine.loadWallets(); }
  };
  setTimeout(() => withMemLog("activity", measureAll).catch((e) => console.error("activity failed", (e as Error).message)), 45_000);
  setInterval(() => withMemLog("activity", measureAll).catch((e) => console.error("activity failed", (e as Error).message)), 6 * 3600 * 1000);
  const mark = () => runMarking(db(), gammaSource(undefined, db()), { log: (m) => console.log(new Date().toISOString(), "[paper]", m) }).catch((e) => console.error("mark failed", (e as Error).message)).then(snapshot);
  setTimeout(snapshot, 5_000);
  // Retention: expire raw fills (7d), closed positions (30d), old data-quality rows (14d). Signals and paper results are permanent.
  const prune = async () => { const { data, error } = await db().rpc("prune_working_data"); if (error) console.error("prune failed", error.message); else console.log(new Date().toISOString(), "[retention] pruned", JSON.stringify(data)); };
  setTimeout(prune, 60_000); setInterval(prune, 24 * 3600 * 1000);
  setTimeout(mark, 20_000); setInterval(mark, markEvery);
  await heartbeat(db(), "worker_boot", new Date().toISOString());
  connect();
}
const pm = new PolymarketClient();
async function reconcileAll(reason: string) {
  const wallets = engine.trackedProfiles().filter((w) => !isBotLike(w)).map((w) => w.address);
  let up = 0, zero = 0, fail = 0;
  for (const w of wallets) {
    try {
      const rows = await pm.userPositions(w, "OPEN");
      const remote = rows.map((r) => parseRemotePosition(r, w)).filter((x): x is NonNullable<typeof x> => !!x);
      const r = await engine.reconcileWallet(w, remote, { freshSec: reason === "boot" ? 0 : 600 }); up += r.upserted; zero += r.zeroed;
    } catch (e) { fail++; console.error(`reconcile ${w}: ${(e as Error).message}`); }
  }
  console.log(new Date().toISOString(), `[reconcile:${reason}] ${wallets.length} wallets, ${up} upserted, ${zero} zeroed, ${fail} failed`);
}
// Identical websocket rows (same tx/token/wallet/second/side/size/price) get the same occurrence suffixes REST assigns.
const wsOccurrence = new Map<string, number>(); setInterval(() => wsOccurrence.clear(), 15 * 60 * 1000);
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
      const raw = normalizeFill(p as Record<string, unknown>, "ws"); if (!raw || !engine.isTracked(raw.wallet)) continue;
      const [f] = withOccurrence([raw], wsOccurrence);
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
