/**
 * Phase 4.0d, Part D — per-wallet and per-category executable share (research only): the arithmetic on a hand-derived fixture world, the unknown-is-not-zero rule for
 * signals on pairs that were not searched, the distribution, the concentration, the score ≥ 68 group comparison, the by-category shares, the labels, and the read-only
 * database path (a spy that throws on any write).
 */
import { describe, expect, it } from "vitest";
import { diagnoseCandidates } from "../src/lib/phase4/mapping";
import type { TitleSearchRow } from "../src/lib/phase4/title-search";
import { loadWalletSignals, renderWalletShare, walletShare, walletShareLines, type WalletSignal } from "../src/lib/phase4/wallet-share";
import { runWalletShareCli } from "../src/lib/phase4/cli-review";
import { EXIT } from "../src/lib/phase4/cli";
import { readOnly } from "../src/lib/phase4/readonly-db";
import { memDb } from "./helpers/phase4Db";
import { ENV, OUT, buildVenueFiles, pipe, worldDb } from "./helpers/phase4Pipeline";

const row = (cond: string, proposed: boolean): TitleSearchRow => { const pair = { conditionId: cond, tokenId: "t", title: "alpha bravo charlie", slug: null, outcome: "Yes", stratum: "x", score: 70, signals: 1, wallet: "0xw", eventDate: null };
  return { pair, query: "q", error: null, diag: diagnoseCandidates({ conditionId: cond, tokenId: "t", title: pair.title, outcome: "Yes", slug: null, stratum: "x" }, [{ venue: "kalshi", marketId: `m-${cond}`, question: proposed ? "alpha bravo charlie" : "zulu yankee xray", outcomes: ["Yes", "No"], categories: [], stratum: "x", slug: null, url: null }]) }; };
// P1..P3 proposed, P4 and P5 searched but not proposed, P6 not searched at all
const ROWS = [row("0xP1", true), row("0xP2", true), row("0xP3", true), row("0xP4", false), row("0xP5", false)];
const S = (wallet: string, cond: string, score: number | null, category: string): WalletSignal => ({ wallet, conditionId: cond, outcome: "Yes", score, category });
const SIGNALS: WalletSignal[] = [
  S("W1", "0xP1", 80, "sports"), S("W1", "0xp1", 80, "sports"), S("W1", "0xP2", 70, "sports"),                                   // W1: 3 signals, all proposed (the condition id is compared case-insensitively)
  S("W2", "0xP1", 60, "sports"), S("W2", "0xP4", 60, "politics"), S("W2", "0xP4", 65, "politics"), S("W2", "0xP5", 50, "crypto"), // W2: 4 signals, 1 proposed, no score ≥ 68
  S("W3", "0xP3", 90, "sports"), S("W3", "0xP4", 90, "politics"),                                                                 // W3: 2 signals, 1 proposed
  S("W4", "0xP6", 70, "esports"), S("W4", "0xP6", 70, "esports"),                                                                 // W4: 2 signals on a pair that was NOT searched
  ...Array.from({ length: 5 }, () => S("W5", "0xP4", 60, "politics")),                                                            // W5: 5 signals, none proposed
  S("W6", "0xP2", 68, "sports"),                                                                                                  // W6: 1 signal, proposed (score exactly 68)
];
const R = walletShare({ venue: "kalshi", signals: SIGNALS, rows: ROWS, elapsedDays: 2, minSignals: 3 });

describe("wallet share: the arithmetic on the fixture world", () => {
  it("totals: 17 signals, 15 searched, 2 unknown, 6 proposed = 40 % of the searched, 3 per day", () => { expect(R.totals).toMatchObject({ signals: 17, searched: 15, unsearched: 2, proposed: 6, proposedPerDay: 3 }); expect(R.totals.share).toBeCloseTo(0.4, 12); expect(R.wallets).toBe(6); });
  it("per wallet: signals, searched, unknown, proposed, share (null when nothing was searched — unknown, not zero), per day, score ≥ 68", () => {
    const w = (n: string) => R.perWallet.find((x) => x.wallet === n)!;
    expect(w("W1")).toMatchObject({ signals: 3, searched: 3, unsearched: 0, proposed: 3, share: 1, perDay: 1.5, hasScore68: true }); expect(w("W2")).toMatchObject({ signals: 4, searched: 4, proposed: 1, share: 0.25, perDay: 0.5, hasScore68: false }); expect(w("W3")).toMatchObject({ proposed: 1, share: 0.5, hasScore68: true });
    expect(w("W4")).toMatchObject({ signals: 2, searched: 0, unsearched: 2, proposed: 0, share: null, hasScore68: true }); expect(w("W5")).toMatchObject({ signals: 5, proposed: 0, share: 0, hasScore68: false }); expect(w("W6")).toMatchObject({ proposed: 1, share: 1, hasScore68: true });
    expect(R.perWallet.map((x) => x.wallet)).toEqual(["W1", "W2", "W3", "W6", "W5", "W4"]); // by proposed signals, then signals, then name
  });
  it("by category within a wallet: W2's flow is 1 proposed of 1 in sports, 0 of 2 in politics, 0 of 1 in crypto", () => {
    expect(R.perWallet.find((x) => x.wallet === "W2")!.byCategory).toEqual([{ category: "sports", signals: 1, searched: 1, proposed: 1, share: 1 }, { category: "politics", signals: 2, searched: 2, proposed: 0, share: 0 }, { category: "crypto", signals: 1, searched: 1, proposed: 0, share: 0 }]);
  });
  it("the distribution: wallets with enough searched signals (≥ 3) are W1, W2, W5 — ≥ 25 % proposed: 2, ≥ 50 %: 1; counting every wallet with a share: 4 and 3 of 5", () => {
    expect(R.walletsWithEnoughSignals).toBe(3); expect(R.distribution).toEqual({ atLeast25: 2, atLeast50: 1, of: 3, allWallets: { atLeast25: 4, atLeast50: 3, of: 5 } });
    const d = walletShare({ venue: "kalshi", signals: SIGNALS, rows: ROWS, elapsedDays: 2 }); expect(d.minSignalsForShare).toBe(5); expect(d.walletsWithEnoughSignals).toBe(1); expect(d.distribution).toMatchObject({ atLeast25: 0, atLeast50: 0, of: 1 }); // W5 alone has 5
  });
  it("the share is inclusive at the thresholds (exactly 25 % and 50 % count)", () => { expect(R.perWallet.find((x) => x.wallet === "W2")!.share).toBe(0.25); expect(R.distribution.atLeast25).toBe(2); expect(R.distribution.allWallets.atLeast50).toBe(3); });
  it("concentration of the proposed flow: top 3 wallets 5 of 6, top 10 all", () => { expect(R.concentration.top3).toEqual({ proposed: 5, share: 5 / 6 }); expect(R.concentration.top10).toEqual({ proposed: 6, share: 1 }); });
  it("the wallets with a score ≥ 68 signal against the rest: 8 signals / 6 searched / 5 proposed against 9 / 9 / 1, with the medians of the wallets that have enough signals", () => {
    const g = R.groups; expect(g.score68Wallets).toMatchObject({ wallets: 4, signals: 8, searched: 6, proposed: 5, medianWalletShare: 1 }); expect(g.score68Wallets.share).toBeCloseTo(5 / 6, 12); expect(g.otherWallets).toMatchObject({ wallets: 2, signals: 9, searched: 9, proposed: 1, medianWalletShare: 0.125 }); expect(g.otherWallets.share).toBeCloseTo(1 / 9, 12); expect(g.note).toMatch(/83 % against 11 % for the others \(higher\)/);
  });
  it("by category: sports 6 of 6 proposed, politics 0 of 8, crypto 0 of 1, esports unknown (nothing searched) — never 0 %", () => {
    const c = (n: string) => R.byCategory.find((x) => x.category === n)!; expect(c("sports")).toEqual({ category: "sports", signals: 6, searched: 6, proposed: 6, share: 1 }); expect(c("politics")).toEqual({ category: "politics", signals: 8, searched: 8, proposed: 0, share: 0 }); expect(c("crypto").share).toBe(0); expect(c("esports")).toMatchObject({ signals: 2, searched: 0, share: null });
  });
  it("labels everything proposed-not-verified and research, and says how many signals are unknown", () => {
    expect(R.research).toContain("proposed, not verified"); expect(R.research).toContain("not a strategy change and not a recommendation"); expect(R.notes.join(" ")).toContain("2 of 17 signals sit on pairs that were not searched"); const md = renderWalletShare(R); expect(md).toContain("not a strategy change and not a recommendation"); expect(md).toContain("PROPOSED"); expect(md.trim().split("\n").length).toBeLessThanOrEqual(80);
    const L = walletShareLines(R, "out"); expect(L.length).toBeLessThanOrEqual(60); expect(L.join("\n")).toContain("not a strategy change"); expect(L.join("\n")).toContain("unknown 2");
  });
  it("an empty world and a zero-length window do not divide by zero", () => { const e = walletShare({ venue: "kalshi", signals: [], rows: [], elapsedDays: 0 }); expect(e.totals).toMatchObject({ signals: 0, share: null, proposedPerDay: 0 }); expect(e.concentration.top3.share).toBeNull(); expect(e.groups.note).toContain("no comparison"); expect(() => renderWalletShare(e)).not.toThrow(); });
  it("an errored or result-less title row is unknown, not 'no candidate'", () => { const bad: TitleSearchRow = { ...row("0xP1", true), diag: null, error: "BLOCKED 403" }; const r = walletShare({ venue: "kalshi", signals: [S("W", "0xP1", 80, "sports")], rows: [bad], elapsedDays: 1 }); expect(r.totals).toMatchObject({ searched: 0, unsearched: 1, proposed: 0 }); expect(r.perWallet[0].share).toBeNull(); });
});

describe("phase4:wallet-share", () => {
  it("reads our signals with select only (a spy that throws on any write is never tripped), reads the saved titles file, writes JSON and Markdown, prints ≤ 60 lines", async () => {
    const p = pipe(); await buildVenueFiles(p, { allScores: true }); const spy = worldDb(); expect(await p.run("w", runWalletShareCli, ["--venue", "kalshi"], { db: spy })).toBe(EXIT.OK);
    expect(spy.touched).toEqual([]); expect([...new Set(spy.reads.map((r) => r.table))]).toEqual(["signals"]); expect(p.lines.w.length).toBeLessThanOrEqual(60); expect(p.lines.w.join("\n")).toContain("not a strategy change"); const j = JSON.parse(p.fs[`${OUT}/v_kalshi_wallets.json`]); expect(j).toMatchObject({ kind: "wallets", venue: "kalshi" }); expect(j.totals.signals).toBe(8); expect(j.totals.unsearched).toBe(0); expect(p.fs[`${OUT}/WALLET_SHARE_kalshi.md`]).toContain("# Per-wallet executable share on kalshi");
  });
  it("without --all-scores in the title run the file says so (the wallets' other signals are unknown)", async () => {
    const p = pipe(); await buildVenueFiles(p); await p.run("w", runWalletShareCli, ["--venue", "polymarket_us"], {}); const j = JSON.parse(p.fs[`${OUT}/v_polymarket_us_wallets.json`]); expect(j.notes.join(" ")).toContain("without --all-scores"); expect(j.totals.signals).toBe(8);
  });
  it("refuses a missing titles file, a bad venue, missing database variables and a start without a time zone — before the database is touched", async () => {
    const p = pipe(); const spy = worldDb(); expect(await p.run("a", runWalletShareCli, ["--venue", "kalshi"], { db: spy })).toBe(EXIT.CONFIG); expect(p.lines.a.join(" ")).toContain("run the title search"); expect(await p.run("b", runWalletShareCli, ["--venue", "polymarket_intl"], { db: spy })).toBe(EXIT.CONFIG); expect(await p.run("c", runWalletShareCli, ["--venue", "kalshi"], { db: null, env: {} })).toBe(EXIT.CONFIG); expect(spy.reads).toHaveLength(0);
    await buildVenueFiles(p, { allScores: true }); const spy2 = worldDb(); expect(await p.run("d", runWalletShareCli, ["--venue", "kalshi", "--start", "2026-10-01T00:00:00"], { db: spy2 })).toBe(EXIT.CONFIG); expect(spy2.reads).toHaveLength(0);
  });
  it("loadWalletSignals de-duplicates by id, keeps entry kinds only and reads the copy score (select only)", async () => {
    const s = (id: string, o: Record<string, unknown> = {}) => ({ id, kind: "NEW_POSITION", wallet: "0xw", condition_id: "0xc", outcome: "Yes", title: "Lakers vs Celtics", slug: "nba-a", created_at: "2026-10-02T10:00:00Z", payload: { copyScore: 77 }, ...o });
    const spy = memDb({ signals: [s("1"), s("1"), s("2", { kind: "EXIT" }), s("3", { payload: {} }), s("4", { created_at: "2026-09-01T00:00:00Z" })] }); const r = await loadWalletSignals(readOnly(spy.db as never), "2026-09-27T04:28:38Z", "2026-10-03T00:00:00Z");
    expect(r).toHaveLength(2); expect(r[0]).toMatchObject({ wallet: "0xw", score: 77, category: "sports:basketball" }); expect(r[1].score).toBeNull(); expect(spy.touched).toEqual([]);
  });
});
