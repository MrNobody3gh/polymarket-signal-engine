/**
 * Phase 4.0e, Part D — returning a run's files from a log-only host (Railway) in one piece.
 *
 * `npm run phase4:bundle` packs `docs/phase4/data` (or listed files) into a USTAR tar, gzips it (level 9, no timestamps: the same files always give the same bytes), and PRINTS
 *     =====BUNDLE_SHA <sha256 of the gzip bytes> <gzip bytes> LINES <n>
 *     PAD ...          about 300 KB of padding lines, so the log window is big enough for the log tool to save it to a file
 *     B64 <index> <3,000 base64 characters>      the gzip bytes, in order, `index` counting from 0
 *     =====BUNDLE_END
 * at most 200 lines per second (a one-second pause after every 200 lines). `phase4:bundle-decode --in <saved log> --out <dir>` rebuilds the files from a saved log (plain text
 * or JSON: an array of strings or of objects with a `message` / `text` / `line` member, or JSON lines), ignores everything else (padding, other log lines, timestamps), verifies
 * the checksum and the byte count, and REFUSES on any mismatch, missing line or unsafe file name. Lines out of order are put back in order by their index (reported); two
 * different lines with one index are refused. No network, no database, no dependency (node:zlib and node:crypto only).
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { hash } from "node:crypto";
import { EXIT, parseArgs, num } from "./cli";

export const B64_LINE_CHARS = 3000; export const PAD_LINE_CHARS = 3000; export const MAX_LOG_LINES_PER_CALL = 500; export const PAD_BYTES_DEFAULT = 300_000; export const MAX_LINES_PER_SECOND = 200; export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024; export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
export interface BundleFile { name: string; data: Uint8Array }

// ───────────────────────────────────────────── tar (USTAR) ───────────────────────────────────────────────────
const enc = new TextEncoder(), dec = new TextDecoder();
const oct = (n: number, w: number) => n.toString(8).padStart(w - 1, "0") + "\0";
function field(buf: Uint8Array, off: number, s: string, w: number) { const b = enc.encode(s); if (b.length > w) throw new Error(`tar field too long: ${s}`); buf.set(b, off); }
/** The tar of `files` (mtime 0, mode 0644, owner 0): deterministic. Names are relative, forward-slash, at most 255 bytes (100 + a 155-byte prefix). */
export function tarPack(files: BundleFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of files) {
    if (!f.name || f.name.startsWith("/") || f.name.split("/").includes("..")) throw new Error(`unsafe file name: ${f.name}`);
    let name = f.name, prefix = ""; if (enc.encode(name).length > 100) { const i = name.lastIndexOf("/", name.length - 1); let cut = -1; for (let j = i; j > 0; j = name.lastIndexOf("/", j - 1)) if (enc.encode(name.slice(j + 1)).length <= 100 && enc.encode(name.slice(0, j)).length <= 155) { cut = j; break; } if (cut < 0) throw new Error(`file name too long for tar: ${f.name}`); prefix = name.slice(0, cut); name = name.slice(cut + 1); }
    const h = new Uint8Array(512); field(h, 0, name, 100); field(h, 100, "0000644\0", 8); field(h, 108, "0000000\0", 8); field(h, 116, "0000000\0", 8); field(h, 124, oct(f.data.length, 12), 12); field(h, 136, oct(0, 12), 12); h.fill(0x20, 148, 156); h[156] = 0x30; field(h, 257, "ustar\0", 6); field(h, 263, "00", 2); field(h, 345, prefix, 155);
    let sum = 0; for (const b of h) sum += b; field(h, 148, oct(sum, 7) + " ", 8); parts.push(h, f.data, new Uint8Array((512 - (f.data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024)); const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
const str0 = (b: Uint8Array, off: number, w: number) => dec.decode(b.subarray(off, off + w)).split("\0")[0];
/** Read the tar back; refuses a bad header checksum, an unsafe name, a non-regular entry and a truncated archive. */
export function tarUnpack(tar: Uint8Array): BundleFile[] {
  const out: BundleFile[] = []; let off = 0, total = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512); if (h.every((b) => b === 0)) return out;
    const stored = parseInt(str0(h, 148, 8).trim(), 8); let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]; if (stored !== sum) throw new Error(`tar header checksum mismatch at byte ${off}`);
    const type = String.fromCharCode(h[156] || 0x30); if (type !== "0") throw new Error(`unsupported tar entry type ${JSON.stringify(type)} (only regular files)`);
    const prefix = str0(h, 345, 155), name = (prefix ? `${prefix}/` : "") + str0(h, 0, 100); if (!name || name.startsWith("/") || name.split("/").includes("..")) throw new Error(`unsafe file name in the archive: ${name}`);
    const size = parseInt(str0(h, 124, 12).trim() || "0", 8); if (!Number.isFinite(size) || size < 0) throw new Error(`bad size for ${name}`); total += size; if (total > MAX_UNPACKED_BYTES) throw new Error(`the archive unpacks to more than ${MAX_UNPACKED_BYTES} bytes: refused`);
    if (off + 512 + size > tar.length) throw new Error(`the archive is truncated inside ${name}`); out.push({ name, data: tar.slice(off + 512, off + 512 + size) }); off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("the archive has no end marker (truncated)");
}

// ───────────────────────────────────────────── the printed form ─────────────────────────────────────────────
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
export interface MadeBundle { lines: string[]; sha: string; bytes: number; b64Lines: number; padLines: number; files: number }
/** The lines of a bundle (the header, the padding, the data, the end marker). Refuses a bundle larger than `maxBytes` (a log cannot carry it): list files instead. */
export function makeBundle(files: BundleFile[], o: { padBytes?: number; maxBytes?: number } = {}): MadeBundle {
  const gz = gzipSync(Buffer.from(tarPack(files)), { level: 9 }); const max = o.maxBytes ?? MAX_BUNDLE_BYTES; if (gz.length > max) throw new Error(`the bundle is ${gz.length} bytes (> ${max}): too large for a log; list the files you need with --files`);
  const sha = hash("sha256", gz, "hex"); const text = b64(gz); const data: string[] = []; for (let i = 0; i < text.length; i += B64_LINE_CHARS) data.push(text.slice(i, i + B64_LINE_CHARS));
  // LONG padding lines (3,000 characters, like the data lines): the Railway log tool returns at most 500 lines per call, so 300 KB of 80-character lines (3,750 lines) would put the data beyond any call that starts at the header. About 100 padding lines.
  const padLineBytes = PAD_LINE_CHARS; const padLines = (o.padBytes ?? PAD_BYTES_DEFAULT) <= 0 ? 0 : Math.max(1, Math.ceil((o.padBytes ?? PAD_BYTES_DEFAULT) / padLineBytes)); const pad = Array.from({ length: padLines }, (_, i) => `PAD ${String(i).padStart(6, "0")} ${"=".repeat(padLineBytes - 11)}`);
  const lines = [`=====BUNDLE_SHA ${sha} ${gz.length} LINES ${data.length}`, ...pad, ...data.map((d, i) => `B64 ${String(i).padStart(5, "0")} ${d}`), "=====BUNDLE_END"];
  return { lines, sha, bytes: gz.length, b64Lines: data.length, padLines, files: files.length };
}
/** Emit lines with at most `MAX_LINES_PER_SECOND` per second: a one-second pause after every 200. */
export async function emitPaced(lines: string[], log: (l: string) => void, sleep: (ms: number) => Promise<void>): Promise<void> { let n = 0; for (const l of lines) { log(l); if (++n % MAX_LINES_PER_SECOND === 0) await sleep(1000); } }

// ───────────────────────────────────────────── decoding ──────────────────────────────────────────────────────
const MEMBERS = ["message", "msg", "text", "line", "log", "content"];
/** The text lines of a saved log: plain text, a JSON array (strings or objects with a message-like member), an object holding such an array, or JSON lines. */
export function logLines(text: string): string[] {
  const asLines = (v: unknown): string[] | null => { if (typeof v === "string") return v.split(/\r?\n/); if (Array.isArray(v)) { const o: string[] = []; for (const x of v) { const l = asLines(x); if (l === null) return null; o.push(...l); } return o; } if (v && typeof v === "object") { for (const k of MEMBERS) { const m = (v as Record<string, unknown>)[k]; if (typeof m === "string") return m.split(/\r?\n/); } for (const k of ["logs", "lines", "entries", "data", "items", "result"]) { const m = (v as Record<string, unknown>)[k]; if (Array.isArray(m)) return asLines(m); } } return null; };
  const t = text.trim(); if (t.startsWith("[") || t.startsWith("{")) { try { const l = asLines(JSON.parse(t)); if (l) return l; } catch { /* JSON lines or plain text below */ } }
  const out: string[] = []; for (const raw of text.split(/\r?\n/)) { const s = raw.trim(); if (s.startsWith("{") && s.endsWith("}")) { try { const l = asLines(JSON.parse(s)); if (l) { out.push(...l); continue; } } catch { /* keep as text */ } } out.push(raw); }
  return out;
}
export type DecodeResult = { ok: true; files: BundleFile[]; sha: string; bytes: number; lines: number; reordered: boolean; ignored: number } | { ok: false; error: string };
/** Rebuild the files of the LAST complete bundle in a saved log; refuse on a checksum or length mismatch, a missing line, conflicting duplicates or an unsafe name. */
export function decodeBundle(text: string): DecodeResult {
  const lines = logLines(text); interface Cur { sha: string; bytes: number; n: number; data: Map<number, string>; order: number[]; ended: boolean; dup: string | null }
  let cur: Cur | null = null; let done: Cur | null = null; let ignored = 0;
  for (const l of lines) {
    const h = /=====BUNDLE_SHA ([0-9a-f]{64}) (\d+) LINES (\d+)/.exec(l); if (h) { cur = { sha: h[1], bytes: Number(h[2]), n: Number(h[3]), data: new Map(), order: [], ended: false, dup: null }; continue; }
    if (cur && /=====BUNDLE_END/.test(l)) { cur.ended = true; done = cur; cur = null; continue; }
    const d = cur ? /(?:^|\s)B64 (\d{5}) ([A-Za-z0-9+/=]+)\s*$/.exec(l) : null; if (d && cur) { const i = Number(d[1]); const prev = cur.data.get(i); if (prev !== undefined && prev !== d[2]) cur.dup = `line ${i} appears twice with different content`; cur.data.set(i, d[2]); cur.order.push(i); continue; }
    ignored++;
  }
  const b = done ?? cur; if (!b) return { ok: false, error: "no bundle found in the log (no =====BUNDLE_SHA line)" }; if (!b.ended) return { ok: false, error: `the bundle has no =====BUNDLE_END line: the log was cut off after ${b.data.size} of ${b.n} data lines` };
  if (b.dup) return { ok: false, error: b.dup }; const missing: number[] = []; for (let i = 0; i < b.n; i++) if (!b.data.has(i)) missing.push(i); if (missing.length) return { ok: false, error: `${missing.length} data line(s) missing (first: ${missing.slice(0, 5).join(", ")}) of ${b.n}` };
  if (b.data.size > b.n) return { ok: false, error: `${b.data.size} data lines but the header says ${b.n}` };
  const reordered = b.order.some((x, k) => k > 0 && x < b.order[k - 1]); const gz = Buffer.from([...Array(b.n).keys()].map((i) => b.data.get(i)!).join(""), "base64");
  if (gz.length !== b.bytes) return { ok: false, error: `length mismatch: ${gz.length} bytes decoded, the header says ${b.bytes}` };
  const sha = hash("sha256", gz, "hex"); if (sha !== b.sha) return { ok: false, error: `checksum mismatch: decoded ${sha}, the header says ${b.sha}; the files were NOT written` };
  try { return { ok: true, files: tarUnpack(new Uint8Array(gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES }))), sha, bytes: gz.length, lines: b.n, reordered, ignored }; } catch (e) { return { ok: false, error: `the verified bytes do not unpack: ${(e as Error).message}` }; }
}

// ───────────────────────────────────────────── the two commands ──────────────────────────────────────────────
export interface BundleDeps { log?: (l: string) => void; sleep?: (ms: number) => Promise<void>; listFiles?: (dir: string) => string[]; readBinary?: (path: string) => Uint8Array | null; readFile?: (path: string) => string | null; writeBinary?: (path: string, data: Uint8Array) => void; mkdir?: (dir: string) => void }
export const BUNDLE_USAGE = "usage: npm run phase4:bundle -- [--dir docs/phase4/data] [--files a.json,b.md] [--pad-bytes 300000] [--max-bytes 20971520]";
export const BUNDLE_DECODE_USAGE = "usage: npm run phase4:bundle-decode -- --in <saved log file> --out <dir>";
export async function runBundleCli(argv: string[], d: BundleDeps): Promise<number> {
  const log = d.log ?? ((l: string) => console.log(l)); const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))); const { flags, opts } = parseArgs(argv); if (flags.has("help")) { log(BUNDLE_USAGE); return EXIT.OK; }
  const dir = (opts.dir ?? "docs/phase4/data").replace(/\/$/, ""); const names = opts.files ? opts.files.split(",").map((x) => x.trim()).filter(Boolean) : (d.listFiles ? d.listFiles(dir) : []);
  if (!names.length) { log(`no files to bundle in ${dir}`); return EXIT.CONFIG; } const files: BundleFile[] = [];
  for (const n of names) { const p = n.includes("/") && opts.files ? n : `${dir}/${n}`; const data = d.readBinary ? d.readBinary(p) : null; if (!data) { log(`cannot read ${p}`); return EXIT.CONFIG; } files.push({ name: n.replace(/^\.\//, ""), data }); }
  try { const b = makeBundle(files, { padBytes: num(opts["pad-bytes"], PAD_BYTES_DEFAULT), maxBytes: num(opts["max-bytes"], MAX_BUNDLE_BYTES) }); await emitPaced(b.lines, log, sleep); return EXIT.OK; } catch (e) { log(`bundle failed: ${(e as Error).message}`); return EXIT.CONFIG; }
}
export async function runBundleDecodeCli(argv: string[], d: BundleDeps): Promise<number> {
  const log = d.log ?? ((l: string) => console.log(l)); const { flags, opts } = parseArgs(argv); if (flags.has("help")) { log(BUNDLE_DECODE_USAGE); return EXIT.OK; }
  if (!opts.in || !opts.out) { log("--in <saved log> and --out <dir> are required."); return EXIT.CONFIG; } const text = d.readFile ? d.readFile(opts.in) : null; if (text === null) { log(`cannot read ${opts.in}`); return EXIT.CONFIG; }
  const r = decodeBundle(text); if (!r.ok) { log(`REFUSED: ${r.error}`); return EXIT.CONFIG; }
  d.mkdir?.(opts.out); for (const f of r.files) d.writeBinary?.(`${opts.out}/${f.name}`, f.data);
  log(`bundle verified: sha256 ${r.sha} (${r.bytes} bytes), ${r.lines} data lines${r.reordered ? " (lines were out of order and were put back by their index)" : ""}, ${r.ignored} other log lines ignored`); for (const f of r.files.slice(0, 40)) log(`  ${f.name}  ${f.data.length} bytes`); if (r.files.length > 40) log(`  … ${r.files.length - 40} more files`); log(`wrote ${r.files.length} files to ${opts.out}`);
  return EXIT.OK;
}
