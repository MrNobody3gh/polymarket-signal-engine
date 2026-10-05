/**
 * Phase 4.0e, Part D — `phase4:bundle` and `phase4:bundle-decode`: round trip, determinism, padding, the line format, a corrupted line, missing lines, out-of-order lines,
 * duplicate lines, a cut-off log, log formats (text, JSON, JSON lines, timestamps), unsafe names, size and pacing limits.
 */
import { describe, expect, it } from "vitest";
import { B64_LINE_CHARS, MAX_LINES_PER_SECOND, MAX_LOG_LINES_PER_CALL, PAD_BYTES_DEFAULT, decodeBundle, emitPaced, logLines, makeBundle, runBundleCli, runBundleDecodeCli, tarPack, tarUnpack, type BundleFile } from "../src/lib/phase4/bundle";
import { EXIT } from "../src/lib/phase4/cli";
import { virtualClock } from "./helpers/phase4Db";

const txt = (s: string) => new TextEncoder().encode(s);
const FILES: BundleFile[] = [{ name: "S1_COMPACT.md", data: txt("# compact\n".repeat(50)) }, { name: "v_kalshi_audit.json", data: txt(JSON.stringify({ a: [1, 2, 3], b: "é–✓" })) }, { name: "empty.csv", data: new Uint8Array(0) }, { name: "sub/dir/exact512.bin", data: new Uint8Array(512).fill(7) }];
const same = (a: BundleFile[], b: BundleFile[]) => { expect(a.map((f) => f.name)).toEqual(b.map((f) => f.name)); a.forEach((f, i) => expect(Buffer.from(f.data).equals(Buffer.from(b[i].data)), f.name).toBe(true)); };
const rnd = (n: number) => { const b = new Uint8Array(n); let s = 12345; for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; b[i] = s >>> 24; } return b; };

describe("tar", () => {
  it("round trips names, empty files and sizes that are exact multiples of 512, and is deterministic", () => {
    const t = tarPack(FILES); expect(t.length % 512).toBe(0); same(tarUnpack(t), FILES); expect(Buffer.from(tarPack(FILES)).equals(Buffer.from(t))).toBe(true);
  });
  it("a name longer than 100 bytes is split into a prefix; one that cannot be split is refused", () => {
    const long = `${"d".repeat(60)}/${"e".repeat(60)}/file.json`; same(tarUnpack(tarPack([{ name: long, data: txt("x") }])), [{ name: long, data: txt("x") }]); expect(() => tarPack([{ name: "x".repeat(130), data: txt("x") }])).toThrow(/too long/);
  });
  it("unsafe names are refused when packing and when unpacking", () => {
    for (const n of ["../evil", "/abs", "a/../../b", ""]) expect(() => tarPack([{ name: n, data: txt("x") }]), n).toThrow(/unsafe/);
    const t = tarPack([{ name: "okay/file", data: txt("x") }]); const bad = new Uint8Array(t); bad.set(txt("../x\0"), 0); // the name is changed, so the header checksum no longer matches
    expect(() => tarUnpack(bad)).toThrow(/checksum/);
    const forged = new Uint8Array(t); const name = "../x"; forged.fill(0, 0, 100); forged.set(txt(name), 0); forged.fill(0x20, 148, 156); let sum = 0; for (let i = 0; i < 512; i++) sum += forged[i]; forged.set(txt(sum.toString(8).padStart(7, "0") + " "), 148); expect(() => tarUnpack(forged)).toThrow(/unsafe file name/);
  });
  it("a truncated archive and a non-regular entry are refused", () => { const t = tarPack(FILES); expect(() => tarUnpack(t.subarray(0, 700))).toThrow(/truncated/); const link = new Uint8Array(t); link[156] = 0x32; link.fill(0x20, 148, 156); let s = 0; for (let i = 0; i < 512; i++) s += link[i]; link.set(txt(s.toString(8).padStart(7, "0") + " "), 148); expect(() => tarUnpack(link)).toThrow(/unsupported tar entry type/); });
});

describe("the printed bundle", () => {
  const b = makeBundle(FILES);
  it("has the documented shape: a header with the checksum, the byte count and the line count; about 300 KB of PAD lines; B64 lines of 3,000 characters; an end marker", () => {
    expect(b.lines[0]).toMatch(/^=====BUNDLE_SHA [0-9a-f]{64} \d+ LINES \d+$/); expect(b.lines[b.lines.length - 1]).toBe("=====BUNDLE_END"); const pad = b.lines.filter((l) => l.startsWith("PAD ")), data = b.lines.filter((l) => l.startsWith("B64 "));
    expect(pad.length).toBe(b.padLines); const padBytes = pad.reduce((a, l) => a + l.length, 0); expect(PAD_BYTES_DEFAULT).toBe(300_000); expect(padBytes).toBeGreaterThan(285_000); expect(padBytes).toBeLessThan(330_000); expect(data.length).toBe(b.b64Lines);
    expect(B64_LINE_CHARS).toBe(3000); for (const l of data.slice(0, -1)) expect(l.length).toBe("B64 00000 ".length + 3000); expect(data[data.length - 1].length).toBeLessThanOrEqual("B64 00000 ".length + 3000);
    expect(b.lines.indexOf(pad[0])).toBeLessThan(b.lines.indexOf(data[0])); expect(b.lines.length).toBe(2 + pad.length + data.length); expect(b.lines[0]).toContain(`${b.bytes} LINES ${b.b64Lines}`);
  });
  it("is deterministic: the same files give the same checksum and the same lines", () => { expect(makeBundle(FILES).sha).toBe(b.sha); expect(makeBundle(FILES).lines).toEqual(b.lines); expect(makeBundle([...FILES].reverse()).sha).not.toBe(b.sha); });
  // Found on review: 300 KB of 80-character padding lines was 3,750 lines, but the Railway log tool returns at most 500 lines per call, so a call starting at the header could never reach the data.
  it("the whole bundle (header, padding, data, end) fits one log call of 500 lines, and the padding is still large enough to make the log window save to a file", () => {
    const big = makeBundle([{ name: "big.bin", data: rnd(120_000) }]);                       // the default padding
    expect(big.lines.length).toBeLessThanOrEqual(MAX_LOG_LINES_PER_CALL); expect(big.padLines).toBeLessThanOrEqual(110); expect(big.padLines).toBeGreaterThanOrEqual(95);
    const total = big.lines.reduce((a2, l) => a2 + l.length, 0); expect(total).toBeGreaterThan(290_000);
    expect(big.lines.filter((l) => l.startsWith("PAD ")).every((l) => l.length <= 3010 && l.length >= 2990)).toBe(true);
    expect(makeBundle(FILES, { padBytes: 0 }).padLines).toBe(0);
  });
  it("--pad-bytes changes only the padding", () => { const c = makeBundle(FILES, { padBytes: 1000 }); expect(c.sha).toBe(b.sha); expect(c.padLines).toBeLessThan(b.padLines); expect(c.lines.filter((l) => l.startsWith("B64 "))).toEqual(b.lines.filter((l) => l.startsWith("B64 "))); });
  it("a bundle larger than the limit is refused with the way out", () => { expect(() => makeBundle([{ name: "big.bin", data: rnd(5000) }], { maxBytes: 1000 })).toThrow(/too large for a log; list the files/); });
});

describe("decoding", () => {
  const b = makeBundle(FILES, { padBytes: 2000 }); const text = b.lines.join("\n");
  it("round trips: files, checksum, byte and line counts; padding and other log lines are ignored", () => {
    const noisy = ["2026-10-05T10:00:00Z npm run phase4:bundle", ...b.lines.slice(0, 5), "some other log line", ...b.lines.slice(5), "done"].join("\n"); const r = decodeBundle(noisy); expect(r.ok).toBe(true); if (r.ok) { same(r.files, FILES); expect(r.sha).toBe(b.sha); expect(r.bytes).toBe(b.bytes); expect(r.lines).toBe(b.b64Lines); expect(r.reordered).toBe(false); expect(r.ignored).toBeGreaterThan(b.padLines); }
  });
  it("a large, incompressible bundle round trips (about 350 data lines)", () => { const big: BundleFile[] = [{ name: "big.bin", data: rnd(1_000_000) }]; const m = makeBundle(big, { padBytes: 100 }); expect(m.b64Lines).toBeGreaterThan(300); const r = decodeBundle(m.lines.join("\n")); expect(r.ok && r.files[0].data.length).toBe(1_000_000); if (r.ok) same(r.files, big); });
  it("a corrupted line (one character changed) is refused by the checksum, naming both values", () => {
    const lines = [...b.lines]; const i = lines.findIndex((l) => l.startsWith("B64 00000")); const c = lines[i][20] === "A" ? "B" : "A"; lines[i] = lines[i].slice(0, 20) + c + lines[i].slice(21); const r = decodeBundle(lines.join("\n")); expect(r.ok).toBe(false); expect(!r.ok && r.error).toMatch(/checksum mismatch|do not unpack|length mismatch/);
  });
  it("a wrong byte count in the header is refused as a length mismatch", () => { const r = decodeBundle(text.replace(` ${b.bytes} LINES`, ` ${b.bytes + 1} LINES`)); expect(r.ok).toBe(false); expect(!r.ok && r.error).toMatch(/length mismatch: \d+ bytes decoded, the header says \d+/); });
  it("a deliberately wrong checksum in the header is refused", () => { const r = decodeBundle(text.replace(b.sha, "0".repeat(64))); expect(r.ok).toBe(false); expect(!r.ok && r.error).toContain("checksum mismatch"); expect(!r.ok && r.error).toContain("NOT written"); });
  it("missing lines are refused and named", () => { const lines = b.lines.filter((l) => !l.startsWith("B64 00001 ")); const bigger = makeBundle([{ name: "x.bin", data: rnd(30_000) }], { padBytes: 100 }); const gone = bigger.lines.filter((l) => !l.startsWith("B64 00002 ")); const r = decodeBundle(gone.join("\n")); expect(r.ok).toBe(false); expect(!r.ok && r.error).toMatch(/1 data line\(s\) missing \(first: 2\) of \d+/); void lines; });
  it("a bundle cut off before its end marker is refused, saying how far it got", () => { const r = decodeBundle(b.lines.slice(0, -2).join("\n")); expect(r.ok).toBe(false); expect(!r.ok && r.error).toMatch(/no =====BUNDLE_END line: the log was cut off after \d+ of \d+/); });
  it("no bundle at all is refused", () => { expect(decodeBundle("hello\nworld")).toEqual({ ok: false, error: "no bundle found in the log (no =====BUNDLE_SHA line)" }); expect(decodeBundle("")).toMatchObject({ ok: false }); });
  it("out-of-order lines are put back by their index and reported", () => {
    const m = makeBundle([{ name: "x.bin", data: rnd(30_000) }], { padBytes: 100 }); const d = m.lines.filter((l) => l.startsWith("B64 ")); const swapped = [...m.lines]; const i = swapped.indexOf(d[1]), j = swapped.indexOf(d[3]); [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
    const r = decodeBundle(swapped.join("\n")); expect(r.ok).toBe(true); expect(r.ok && r.reordered).toBe(true); expect(r.ok && Buffer.from(r.files[0].data).equals(Buffer.from(rnd(30_000)))).toBe(true);
  });
  it("a duplicated identical line is harmless, two different lines with one index are refused", () => {
    const d = b.lines.findIndex((l) => l.startsWith("B64 00000")); const dup = [...b.lines]; dup.splice(d, 0, b.lines[d]); expect(decodeBundle(dup.join("\n")).ok).toBe(true);
    const conflict = [...b.lines]; conflict.splice(d, 0, b.lines[d].slice(0, 20) + (b.lines[d][20] === "A" ? "B" : "A") + b.lines[d].slice(21)); const r = decodeBundle(conflict.join("\n")); expect(r.ok).toBe(false); expect(!r.ok && r.error).toContain("appears twice with different content");
  });
  it("two bundles in one log: the last complete one wins; a later cut-off one does not hide an earlier complete one", () => {
    const other = makeBundle([{ name: "second.txt", data: txt("two") }], { padBytes: 100 }); const r = decodeBundle([...b.lines, "x", ...other.lines].join("\n")); expect(r.ok && r.files.map((f) => f.name)).toEqual(["second.txt"]); const cut = decodeBundle([...b.lines, ...other.lines.slice(0, 3)].join("\n")); expect(cut.ok && cut.files.length).toBe(FILES.length);
  });
  it("a bundle that decodes but contains an unsafe name is refused (the bytes are verified, the names are not trusted)", () => {
    const evil = new Uint8Array(tarPack([{ name: "a", data: txt("x") }])); evil.fill(0, 0, 100); evil.set(txt("../escape"), 0); evil.fill(0x20, 148, 156); let s = 0; for (let i = 0; i < 512; i++) s += evil[i]; evil.set(txt(s.toString(8).padStart(7, "0") + " "), 148);
    const { gzipSync } = require("node:zlib") as typeof import("node:zlib"); const { hash } = require("node:crypto") as typeof import("node:crypto"); const gz = gzipSync(Buffer.from(evil)); const b64 = gz.toString("base64"); const log = [`=====BUNDLE_SHA ${hash("sha256", gz, "hex")} ${gz.length} LINES 1`, `B64 00000 ${b64}`, "=====BUNDLE_END"].join("\n"); const r = decodeBundle(log); expect(r.ok).toBe(false); expect(!r.ok && r.error).toContain("unsafe file name");
  });
});

describe("log formats", () => {
  const b = makeBundle(FILES, { padBytes: 500 });
  it("plain text with a timestamp prefix on every line", () => { expect(decodeBundle(b.lines.map((l) => `2026-10-05T10:11:12.345Z [info] ${l}`).join("\n")).ok).toBe(true); });
  it("a JSON array of strings, of objects with a message, text or line member", () => { for (const m of ["message", "text", "line"]) expect(decodeBundle(JSON.stringify(b.lines.map((l) => ({ [m]: l, ts: 1 })))).ok, m).toBe(true); expect(decodeBundle(JSON.stringify(b.lines)).ok).toBe(true); });
  it("JSON lines and an object holding the array under logs, entries or data", () => { expect(decodeBundle(b.lines.map((l) => JSON.stringify({ message: l })).join("\n")).ok).toBe(true); for (const k of ["logs", "entries", "data"]) expect(decodeBundle(JSON.stringify({ [k]: b.lines.map((l) => ({ message: l })) })).ok, k).toBe(true); });
  it("a message holding several lines is split; CRLF is accepted", () => { expect(decodeBundle(JSON.stringify([{ message: b.lines.join("\n") }])).ok).toBe(true); expect(decodeBundle(b.lines.join("\r\n")).ok).toBe(true); expect(logLines("a\r\nb")).toEqual(["a", "b"]); });
});

describe("pacing", () => {
  it("at most 200 lines per second: a one-second pause after every 200 lines, measured on a virtual clock", async () => {
    const c = virtualClock(0); const stamps: number[] = []; const lines = Array.from({ length: 1000 }, (_, i) => `L${i}`); await emitPaced(lines, () => stamps.push(c.now()), c.sleep);
    expect(stamps).toHaveLength(1000); expect(c.sleeps).toEqual([1000, 1000, 1000, 1000, 1000]); const perSecond = new Map<number, number>(); for (const t of stamps) perSecond.set(Math.floor(t / 1000), (perSecond.get(Math.floor(t / 1000)) ?? 0) + 1); expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(MAX_LINES_PER_SECOND); expect(MAX_LINES_PER_SECOND).toBe(200);
  });
  it("the bundle command paces the padding and the data alike", async () => {
    const c = virtualClock(0); const out: string[] = []; const fs = new Map<string, Uint8Array>([["docs/phase4/data/a.json", txt("{}")]]); const code = await runBundleCli([], { log: (l) => out.push(l), sleep: c.sleep, listFiles: () => ["a.json"], readBinary: (p) => fs.get(p) ?? null });
    expect(code).toBe(EXIT.OK); expect(out.length).toBeGreaterThan(100); expect(out.length).toBeLessThan(MAX_LOG_LINES_PER_CALL); expect(c.sleeps.length).toBe(Math.floor(out.length / 200)); expect(out[0]).toContain("=====BUNDLE_SHA");
  });
});

describe("the commands", () => {
  const fs = new Map<string, Uint8Array>(FILES.map((f) => [`docs/phase4/data/${f.name}`, f.data])); const deps = (out: string[], c = virtualClock(0)) => ({ log: (l: string) => out.push(l), sleep: c.sleep, listFiles: () => FILES.map((f) => f.name), readBinary: (p: string) => fs.get(p) ?? null });
  it("bundle then decode round trips through a saved log and writes every file byte for byte", async () => {
    const out: string[] = []; expect(await runBundleCli(["--pad-bytes", "1000"], deps(out))).toBe(EXIT.OK); const written = new Map<string, Uint8Array>(); const lines: string[] = [];
    const code = await runBundleDecodeCli(["--in", "saved.log", "--out", "restored"], { log: (l) => lines.push(l), readFile: () => out.join("\n"), mkdir: () => {}, writeBinary: (p, d) => written.set(p, d) }); expect(code).toBe(EXIT.OK); same([...written.entries()].map(([name, data]) => ({ name: name.replace("restored/", ""), data })), FILES);
    expect(lines[0]).toMatch(/^bundle verified: sha256 [0-9a-f]{64}/); expect(lines.length).toBeLessThanOrEqual(60);
  });
  it("--files bundles only the listed files; an unreadable file is refused before anything is printed", async () => {
    const out: string[] = []; await runBundleCli(["--files", "S1_COMPACT.md", "--pad-bytes", "100"], deps(out)); const r = decodeBundle(out.join("\n")); expect(r.ok && r.files.map((f) => f.name)).toEqual(["S1_COMPACT.md"]);
    const bad: string[] = []; expect(await runBundleCli(["--files", "nope.json"], deps(bad))).toBe(EXIT.CONFIG); expect(bad).toEqual(["cannot read docs/phase4/data/nope.json"]); expect(await runBundleCli(["--dir", "empty"], { ...deps([]), listFiles: () => [] })).toBe(EXIT.CONFIG);
  });
  it("decode refuses a corrupted log with exit 2 and writes NOTHING", async () => {
    const out: string[] = []; await runBundleCli(["--pad-bytes", "100"], deps(out)); const i = out.findIndex((l) => l.startsWith("B64 00000")); out[i] = out[i].slice(0, 30) + (out[i][30] === "A" ? "B" : "A") + out[i].slice(31);
    const written: string[] = []; const lines: string[] = []; const code = await runBundleDecodeCli(["--in", "x", "--out", "o"], { log: (l) => lines.push(l), readFile: () => out.join("\n"), mkdir: () => written.push("mkdir"), writeBinary: (p) => written.push(p) }); expect(code).toBe(EXIT.CONFIG); expect(lines[0]).toMatch(/^REFUSED: /); expect(written).toEqual([]);
  });
  it("decode needs --in and --out and a readable file", async () => { const l: string[] = []; expect(await runBundleDecodeCli([], { log: (x) => l.push(x) })).toBe(EXIT.CONFIG); expect(await runBundleDecodeCli(["--in", "x", "--out", "o"], { log: (x) => l.push(x), readFile: () => null })).toBe(EXIT.CONFIG); expect(l[1]).toBe("cannot read x"); });
  it("the bundle command refuses a bundle over --max-bytes", async () => { const out: string[] = []; fs.set("docs/phase4/data/big.bin", rnd(20_000)); const code = await runBundleCli(["--files", "big.bin", "--max-bytes", "500"], deps(out)); expect(code).toBe(EXIT.CONFIG); expect(out[0]).toContain("too large for a log"); fs.delete("docs/phase4/data/big.bin"); });
});
