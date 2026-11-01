import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubHttp, GitHubHttpRequest } from "../../src/build/githubMergePort.js";
import { computePlaneParity, MAX_PARITY_CALLS, type PlaneParityInput } from "../../src/build/planeParity.js";

/**
 * D#598 P1d-2 (as amended by C21): the parity rule, against a fake that serves GitHub's real shapes for the four reads it may make: the repository
 * (`default_branch`), a branch ref (`object.sha`), a recursive tree (`tree[]` of `path/mode/type/sha`, plus `truncated`, a boolean GitHub always sends) and a
 * commit list. The commit list is GitHub's: a bare array, newest first, `per_page` (default 30, at most 100) and `page` (default 1, 1-based) slicing it, each
 * element a commit with `sha`, `parents` and `commit` metadata and NO `files` key. The fake enforces what the platform's read-only client enforces (40-hex ids,
 * `recursive=1`, the public list at `per_page<=30`, the private list at `per_page=100` and `page` 1 or 2) and refuses anything else, `compare` included. It
 * counts every call.
 *
 * Not faked faithfully: GitHub's real ancestry (here a given history list), its 7 MB / 100,000-entry tree cap (a flag), and how long it takes.
 */
const OVERLAY = [".autonomous-team/", "internal/*.md"];
const blob = (s: string) => createHash("sha1").update(s).digest("hex");
type Files = Record<string, string>;

interface World {
  /** Public main's commits, newest first, and each commit's files (path to content tag). */
  chain: string[];
  trees: Record<string, Files>;
  /** The private repository: its tip, its files, and the public commits in its history (placed after `depth - 1` private-only commits, in chain order). */
  privTip: string;
  privFiles: Files;
  ancestors: Set<string>;
  /** 1-based position in private main's history of the newest public commit it holds (default 1). */
  depth?: number;
  /** The full private history, newest first, when a test needs it spelled out. */
  privHistory?: string[];
  /** Public commits with a second parent (a merge commit). */
  merges?: Set<string>;
  truncate?: { priv?: boolean | "missing"; pub?: boolean | "missing" };
  fail?: (kind: string, side: "priv" | "pub") => { status: number; body?: unknown } | "hang" | undefined;
  defaultBranch?: string;
}

function chainWorld(n: number, files: Files, over: Partial<World> = {}): World {
  const unique = Array.from({ length: n }, (_, i) => `${i.toString(16).padStart(2, "0")}${"a".repeat(38)}`);
  const trees: Record<string, Files> = {};
  for (const c of unique) trees[c] = { ...files };
  return { chain: unique, trees, privTip: "f".repeat(40), privFiles: { ...files }, ancestors: new Set(unique), ...over };
}

function makeFake(w: World) {
  const log: Array<{ side: "priv" | "pub"; kind: string; path: string; query?: Record<string, string | number | undefined> }> = [];
  const entries = (files: Files) => [{ path: "src", mode: "040000", type: "tree", sha: "d".repeat(40) }, ...Object.entries(files).map(([path, tag]) => ({ path, mode: "100644", type: "blob", sha: blob(tag), size: 1 }))];
  const history = (): string[] => {
    if (w.privHistory) return w.privHistory;
    const held = w.chain.filter((c) => w.ancestors.has(c));
    const filler = Array.from({ length: Math.max(0, (w.depth ?? 1) - 1) }, (_, i) => `e${i.toString(16).padStart(39, "0")}`);
    return [...filler, ...held];
  };
  const handle = (side: "priv" | "pub") => async (req: GitHubHttpRequest) => {
    const m = /^\/repos\/o\/(priv|pub)(\/.*)?$/.exec(req.path);
    if (req.method !== "GET" || !m || m[1] !== side) throw new Error("refused by the read-only client");
    const rest = m[2] ?? "";
    const q = req.query ?? {};
    const kind = rest === "" ? "repo" : rest.startsWith("/git/ref/") ? "ref" : rest.startsWith("/git/trees/") ? "tree" : rest === "/commits" ? "commits" : "other";
    log.push({ side, kind, path: rest, ...(req.query ? { query: { ...req.query } } : {}) });
    if (kind === "other") throw new Error("refused by the read-only client");
    const forced = w.fail?.(kind, side);
    if (forced === "hang") return new Promise<never>(() => undefined);
    if (forced) return { status: forced.status, body: forced.body ?? { message: "boom: secret-path/x.env", documentation_url: "https://docs.github.com/rest" } };
    const json = (status: number, body: unknown) => ({ status, body });
    const nf = json(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest" });
    if (kind === "repo") return json(200, { full_name: `o/${side}`, default_branch: w.defaultBranch ?? "main" });
    if (kind === "ref") return json(200, { ref: "refs/heads/main", object: { type: "commit", sha: side === "pub" ? w.chain[0]! : w.privTip } });
    if (kind === "tree") {
      expect(q).toEqual({ recursive: "1" });
      const id = rest.slice("/git/trees/".length);
      const files = side === "pub" ? w.trees[id] : id === w.privTip ? w.privFiles : undefined;
      if (!files) return nf;
      const flag = side === "pub" ? w.truncate?.pub : w.truncate?.priv;
      return json(200, { sha: id, tree: entries(files), ...(flag === "missing" ? {} : { truncated: flag === true }) });
    }
    if (kind === "commits") {
      expect(String(q.sha)).toMatch(/^[0-9a-f]{40}$/);
      const perPage = q.per_page === undefined ? 30 : Number(q.per_page);
      const page = q.page === undefined ? 1 : Number(q.page);
      const keys = Object.keys(q).sort().join();
      if (side === "pub") {
        if (keys !== "per_page,sha" || perPage < 1 || perPage > 30) throw new Error("refused by the read-only client");
        const at = w.chain.indexOf(String(q.sha));
        return json(200, w.chain.slice(at, at + perPage).map((c, i) => ({ sha: c, commit: { message: "m" }, parents: [...(w.chain[at + i + 1] ? [{ sha: w.chain[at + i + 1] }] : []), ...(w.merges?.has(c) ? [{ sha: "9".repeat(40) }] : [])] })));
      }
      if (keys !== "page,per_page,sha" || perPage !== 100 || (page !== 1 && page !== 2) || q.sha !== w.privTip) throw new Error("refused by the read-only client");
      return json(200, history().slice((page - 1) * perPage, page * perPage).map((c) => ({ sha: c, commit: { message: "m" }, parents: [] })));
    }
    throw new Error("unreachable");
  };
  const run = (over: Partial<PlaneParityInput> = {}, globs: readonly string[] = OVERLAY) =>
    computePlaneParity({ privateHttp: { request: handle("priv") }, publicHttp: { request: handle("pub") }, pairing: { privateRepo: { owner: "o", name: "priv" }, publicRepo: { owner: "o", name: "pub" }, overlayGlobs: globs }, ...over });
  return { run, log, handlers: { priv: handle("priv"), pub: handle("pub") }, histories: () => log.filter((l) => l.side === "priv" && l.kind === "commits").length, trees: () => log.filter((l) => l.kind === "tree").length };
}

const BASE: Files = { "README.md": "r1", "src/a.ts": "a1", "src/b.ts": "b1" };
const PRIV_ONLY: Files = { ".autonomous-team/plan.md": "p1", "internal/notes.md": "n1" };

afterEach(() => vi.restoreAllMocks());

describe("computePlaneParity", () => {
  it("1: private main is public U plus overlay files: in_parity, and the sync point is U", async () => {
    const w = chainWorld(5, BASE, { privFiles: { ...BASE, ...PRIV_ONLY } });
    const f = makeFake(w);
    const r = await f.run();
    expect(r).toMatchObject({ result: "in_parity", syncSha: w.chain[0], publicSha: w.chain[0], privateSha: w.privTip, paths: [], pathCount: 0 });
  });

  it("2: public is 3 commits ahead of what private holds: lag at U~3 with no paths", async () => {
    const w = chainWorld(8, BASE, { privFiles: { ...BASE, ...PRIV_ONLY } });
    w.ancestors = new Set(w.chain.slice(3));
    const r = await makeFake(w).run();
    expect(r).toMatchObject({ result: "lag", syncSha: w.chain[3], paths: [], pathCount: 0 });
  });

  it("3: lag plus one changed non-overlay file on private main is drift naming exactly that file", async () => {
    const w = chainWorld(8, BASE, { privFiles: { ...BASE, ...PRIV_ONLY, "src/a.ts": "a2" } });
    w.ancestors = new Set(w.chain.slice(3));
    expect(await makeFake(w).run()).toMatchObject({ result: "drift", syncSha: w.chain[3], paths: ["src/a.ts"], pathCount: 1 });
    // An added file and a removed file count too.
    const w2 = chainWorld(2, BASE, { privFiles: { ...BASE, "extra.txt": "x1" } });
    delete w2.privFiles["src/b.ts"];
    expect(await makeFake(w2).run()).toMatchObject({ result: "drift", paths: ["extra.txt", "src/b.ts"], pathCount: 2 });
  });

  it("4: an overlay file on public main only, or different on both sides, is no drift and is counted", async () => {
    const w = chainWorld(3, { ...BASE, "internal/readme.md": "i1", ".autonomous-team/x.md": "t1" }, { privFiles: { ...BASE, "internal/readme.md": "i2", ".autonomous-team/x.md": "t2", ".autonomous-team/y.md": "y1" } });
    const r = await makeFake(w).run();
    expect(r).toMatchObject({ result: "in_parity", paths: [], overlayOnPublicCount: 2 });
  });

  it("5: none of the 30 listed commits in private main: in_parity when equal to U outside the overlay, else no_shared_history naming the paths", async () => {
    const same = chainWorld(30, BASE, { privFiles: { ...BASE, ...PRIV_ONLY } });
    same.ancestors = new Set();
    const f = makeFake(same);
    expect(await f.run()).toMatchObject({ result: "in_parity", syncSha: null });
    const differ = chainWorld(40, BASE, { privFiles: { ...BASE, "src/a.ts": "zz" } });
    differ.ancestors = new Set();
    expect(await makeFake(differ).run()).toMatchObject({ result: "no_shared_history", syncSha: null, paths: ["src/a.ts"] });
  });

  it("6: a tree that is truncated, or does not say, on either side is too_large; an overlay that does not compile is invalid_overlay with no call", async () => {
    for (const truncate of [{ priv: true }, { pub: true }, { priv: "missing" as const }, { pub: "missing" as const }]) {
      expect((await makeFake(chainWorld(3, BASE, { truncate })).run()).result, JSON.stringify(truncate)).toBe("too_large");
    }
    for (const globs of [[], ["src/[ab].ts"], ["../x"], ["/abs"]]) {
      const f = makeFake(chainWorld(3, BASE));
      expect((await f.run({}, globs)).result, globs.join()).toBe("invalid_overlay");
      expect(f.log).toEqual([]);
    }
  });

  it("7: a 500, a 429, a 403, an unreadable body or a timeout on any call is unavailable", async () => {
    for (const kind of ["repo", "ref", "tree", "commits"]) {
      for (const status of [500, 429, 403]) {
        const r = await makeFake(chainWorld(5, BASE, { fail: (k) => (k === kind ? { status } : undefined) })).run();
        expect(r, `${status} on ${kind}`).toMatchObject({ result: "unavailable", paths: [], pathCount: 0 });
      }
      const hang = chainWorld(5, BASE, { fail: (k) => (k === kind ? "hang" : undefined) });
      expect((await makeFake(hang).run({ limits: { callTimeoutMs: 20 } })).result, `hang on ${kind}`).toBe("unavailable");
      const bad = chainWorld(5, BASE, { fail: (k) => (k === kind ? { status: 200, body: { unexpected: true } } : undefined) });
      expect((await makeFake(bad).run()).result, `shape on ${kind}`).toBe("unavailable");
    }
    // The private commit list failing, on its own, ends the check as unavailable (the public list answering fine).
    for (const status of [500, 429, 404]) {
      const w = chainWorld(5, BASE, { fail: (k, side) => (k === "commits" && side === "priv" ? { status } : undefined) });
      expect((await makeFake(w).run()).result, `${status} on the private list`).toBe("unavailable");
    }
    // A history page that is not a bare array, or holds a malformed id, is unavailable too.
    for (const body of [{ commits: [] }, [{ sha: "zz" }], [{ nosha: 1 }], "x"]) {
      const w = chainWorld(5, BASE, { fail: (k, side) => (k === "commits" && side === "priv" ? { status: 200, body } : undefined) });
      expect((await makeFake(w).run()).result, JSON.stringify(body)).toBe("unavailable");
    }
    // A default branch that is not `main` is a lasting condition, not an outage: its own result, naming the side (public here).
    const odd = await makeFake(chainWorld(3, BASE, { defaultBranch: "master" })).run();
    expect([odd.result, odd.limitSide, odd.privateSha, odd.paths]).toEqual(["unsupported_branch", "public", null, []]);
    expect((await makeFake(chainWorld(3, BASE)).run({ deadline: Date.now() - 1 })).result).toBe("unavailable");
  });

  it("8: containment reads private main's commit list: found at depth 1, 100, 101, 199 and 200, and no sync point beyond 200", async () => {
    for (const depth of [1, 2, 100, 101, 199, 200]) {
      const w = chainWorld(30, BASE, { depth });
      w.ancestors = new Set(w.chain.slice(4));
      const f = makeFake(w);
      const r = await f.run();
      expect(r.syncSha, `depth=${depth}`).toBe(w.chain[4]);
      expect(f.log.length, `depth=${depth}`).toBeLessThanOrEqual(MAX_PARITY_CALLS);
      // Page 2 is read only when page 1 (100 commits) did not settle it.
      expect(f.histories(), `depth=${depth}`).toBe(depth - 1 + 26 > 100 ? 2 : 1);
    }
    // Depth 1 with U itself held: one page, and the whole check is 4 + 1 + 1 + 2 trees (S = U) = 8 calls.
    const top = makeFake(chainWorld(30, BASE, { depth: 1 }));
    expect((await top.run()).syncSha).toBeTruthy();
    expect(top.log.length).toBe(8);
    // Beyond the 200 commits read: no sync point, the check compares with U (equal outside the overlay, so in_parity; changed, so no_shared_history).
    for (const depth of [201, 250, 5000]) {
      const w = chainWorld(30, BASE, { depth, privFiles: { ...BASE, ...PRIV_ONLY } });
      const f = makeFake(w);
      expect(await f.run(), `depth=${depth}`).toMatchObject({ result: "in_parity", syncSha: null });
      expect(f.histories()).toBe(2);
      const d = chainWorld(30, BASE, { depth, privFiles: { ...BASE, "src/a.ts": "zz" } });
      expect(await makeFake(d).run(), `depth=${depth}`).toMatchObject({ result: "no_shared_history", syncSha: null, paths: ["src/a.ts"] });
    }
    // The sync point is the NEWEST window commit held, wherever it sits in the list.
    const newest = chainWorld(30, BASE, { privHistory: [...Array.from({ length: 99 }, (_, i) => `e${i.toString(16).padStart(39, "0")}`), "07" + "a".repeat(38), "12" + "a".repeat(38)] });
    expect((await makeFake(newest).run()).syncSha).toBe("07" + "a".repeat(38));
  });

  it("8b: the call cap is 10: the worst case uses exactly 10, and one call fewer ends the same check as unavailable", async () => {
    expect(MAX_PARITY_CALLS).toBe(10);
    // Four default-branch calls, one public list, two private pages, three trees: the sync point is on page 2 and is not U.
    const w = chainWorld(30, BASE, { depth: 150 });
    w.ancestors = new Set(w.chain.slice(3));
    const f = makeFake(w);
    expect((await f.run()).result).toBe("lag");
    expect(f.log.length).toBe(10);
    const capped = makeFake(w);
    expect((await capped.run({ limits: { maxCalls: 9 } })).result).toBe("unavailable");
    expect(capped.log.length).toBe(9);
    // No input makes the check exceed 10 calls.
    for (const depth of [1, 100, 101, 200, 201, 1000]) {
      const x = chainWorld(30, BASE, { depth });
      x.ancestors = new Set(x.chain.slice(6));
      const g = makeFake(x);
      await g.run();
      expect(g.log.length, `depth=${depth}`).toBeLessThanOrEqual(10);
    }
  });

  it("9: the fake's commit list is GitHub's: a bare array, page and per_page slice it, and no element carries a files key", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(40, "0"));
    const w = chainWorld(3, BASE, { privHistory: ids });
    const priv = makeFake(w).handlers.priv;
    const list = async (query: Record<string, string | number>) => priv({ method: "GET", path: "/repos/o/priv/commits", query: { sha: w.privTip, ...query } });
    const p1 = await list({ per_page: 100, page: 1 });
    const p2 = await list({ per_page: 100, page: 2 });
    expect(Array.isArray(p1.body) && Array.isArray(p2.body)).toBe(true);
    expect((p1.body as Array<{ sha: string }>).map((c) => c.sha)).toEqual(ids.slice(0, 100));
    expect((p2.body as Array<{ sha: string }>).map((c) => c.sha)).toEqual(ids.slice(100, 150));
    for (const c of [...(p1.body as object[]), ...(p2.body as object[])]) {
      expect(c).not.toHaveProperty("files");
      expect(c).toHaveProperty("sha");
      expect(c).toHaveProperty("parents");
    }
    // Anything the read-only client would refuse, the fake refuses: a third page, a smaller page, an extra key.
    await expect(list({ per_page: 100, page: 3 })).rejects.toThrow();
    await expect(list({ per_page: 30, page: 1 })).rejects.toThrow();
    await expect(list({ per_page: 100 })).rejects.toThrow();
    await expect(priv({ method: "GET", path: "/repos/o/priv/compare/" + "a".repeat(40) + "..." + w.privTip, query: { per_page: 1 } })).rejects.toThrow();
  });

  it("10: a failure leaks no path, login or GitHub message, and nothing is logged", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const secret = "octocat-secret-path/x.env";
    const w = chainWorld(4, BASE, { fail: (k, side) => (k === "commits" && side === "priv" ? { status: 500, body: { message: secret, documentation_url: "u" } } : undefined) });
    const throwing: GitHubHttp = { request: async () => Promise.reject(new Error(`connect failed for ${secret} as octocat`)) };
    const a = await makeFake(w).run();
    const b = await computePlaneParity({ privateHttp: throwing, publicHttp: throwing, pairing: { privateRepo: { owner: "o", name: "priv" }, publicRepo: { owner: "o", name: "pub" }, overlayGlobs: OVERLAY } });
    for (const r of [a, b]) {
      expect(r.result).toBe("unavailable");
      expect(JSON.stringify(r)).not.toMatch(/secret|octocat|x\.env/);
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
