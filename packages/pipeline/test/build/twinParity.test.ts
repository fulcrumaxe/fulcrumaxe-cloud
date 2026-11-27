import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GitHubHttpRequest } from "../../src/build/githubMergePort.js";
import { MAX_PARITY_CALLS } from "../../src/build/planeParity.js";
import { TWIN_PARITY_PATHS_CAP, computeTwinParity, type TwinParityInput } from "../../src/build/twinParity.js";

/**
 * D#845 ON-27d1: the twin's parity rule, against a fake that serves GitHub's real shapes for the three reads it may make (the repository's `default_branch`, a branch ref's `object.sha`, a recursive tree with its `truncated`
 * boolean) and enforces what the platform's read-only client does: GET only, 40-hex ids, `recursive=1` on a tree, and nothing else (a commit list, a compare, a file's content, a write: refused). The tree of a commit the
 * fake does not know is a 404, as on GitHub. It counts every call. Not faked faithfully: GitHub's 7 MB / 100,000-entry tree cap (a flag), and how long a call takes.
 * Paths are fictional. The twin's private set here is the fixed roots, the person's `internal/**` and the install's `app/[id]/page.tsx` (a path a glob cannot spell).
 */
const blob = (s: string) => createHash("sha1").update(s).digest("hex");
const commitId = (c: string): string => createHash("sha1").update(`commit:${c}`).digest("hex");
type Files = Record<string, string>;

const OVERLAY = ["internal/**"];
const INSTALL = ["app/[id]/page.tsx"];
const BASE: Files = { "README.md": "r1", "src/a.ts": "a1", "src/b.ts": "b1", "docs/guide.md": "g1" };
/** Files that are private on the twin and so never compared (a fixed root, the person's glob, the install's bracket path). */
const PRIVATE: Files = { ".autonomous-team/plan.md": "p1", "internal/notes.md": "n1", "app/[id]/page.tsx": "x1", ".env": "e1" };

interface Side {
  /** The commits of the repository by name, each with its files. */
  commits: Record<string, Files>;
  tip: string;
}
interface World {
  priv: Side;
  pub: Side;
  truncate?: { priv?: boolean | "missing"; pub?: boolean | "missing" };
  fail?: (kind: string, side: "priv" | "pub") => { status: number; body?: unknown } | "hang" | undefined;
  defaultBranch?: { priv?: string; pub?: string };
}

function makeFake(w: World) {
  const log: Array<{ side: "priv" | "pub"; kind: string; path: string }> = [];
  const entries = (files: Files) => [{ path: "src", mode: "040000", type: "tree", sha: "d".repeat(40) }, ...Object.entries(files).map(([path, tag]) => ({ path, mode: "100644", type: "blob", sha: blob(tag), size: 1 }))];
  const handle = (side: "priv" | "pub") => async (req: GitHubHttpRequest) => {
    const m = /^\/repos\/o\/(priv|pub)(\/.*)?$/.exec(req.path);
    if (req.method !== "GET" || !m || m[1] !== side) throw new Error("refused by the read-only client");
    const rest = m[2] ?? "";
    const kind = rest === "" ? "repo" : rest === "/git/ref/heads/main" ? "ref" : rest.startsWith("/git/trees/") ? "tree" : "other";
    log.push({ side, kind, path: rest });
    if (kind === "other") throw new Error("refused by the read-only client");
    const forced = w.fail?.(kind, side);
    if (forced === "hang") return new Promise<never>(() => undefined);
    if (forced) return { status: forced.status, body: forced.body ?? { message: "boom: secret-path/x.env" } };
    const json = (status: number, body: unknown) => ({ status, body });
    const s = side === "pub" ? w.pub : w.priv;
    if (kind === "repo") return json(200, { full_name: `o/${side}`, default_branch: w.defaultBranch?.[side] ?? "main" });
    if (kind === "ref") return json(200, { ref: "refs/heads/main", object: { type: "commit", sha: commitId(`${side}:${s.tip}`) } });
    if (kind === "tree") {
      expect(req.query).toEqual({ recursive: "1" });
      const id = rest.slice("/git/trees/".length);
      expect(id).toMatch(/^[0-9a-f]{40}$/);
      const name = Object.keys(s.commits).find((c) => commitId(`${side}:${c}`) === id);
      if (name === undefined) return json(404, { message: "Not Found" });
      const flag = side === "pub" ? w.truncate?.pub : w.truncate?.priv;
      return json(200, { sha: id, tree: entries(s.commits[name]!), ...(flag === "missing" ? {} : { truncated: flag === true }) });
    }
    throw new Error("unreachable");
  };
  const anchors = { published: commitId("priv:base"), synced: commitId("pub:base") };
  const run = (over: Partial<TwinParityInput> = {}, twin: Partial<TwinParityInput["twin"]> = {}) =>
    computeTwinParity({
      privateHttp: { request: handle("priv") },
      publicHttp: { request: handle("pub") },
      twin: { privateRepo: { owner: "o", name: "priv" }, publicRepo: { owner: "o", name: "pub" }, publishedPrivateSha: anchors.published, syncedPublicSha: anchors.synced, overlayGlobs: OVERLAY, installPaths: INSTALL, ...twin },
      ...over,
    });
  return { run, log, anchors, trees: () => log.filter((l) => l.kind === "tree").length };
}

/** Both repositories at their anchors (`base`), then each side's tip as the given change to its files. */
function world(change: { priv?: Files; pub?: Files; privDelete?: string[]; pubDelete?: string[] } = {}, over: Partial<World> = {}): World {
  const drop = (files: Files, paths: string[] = []): Files => Object.fromEntries(Object.entries(files).filter(([p]) => !paths.includes(p)));
  const priv = { ...BASE, ...PRIVATE };
  const pub = { ...BASE };
  const privTip = change.priv !== undefined || change.privDelete !== undefined ? { ...drop(priv, change.privDelete), ...change.priv } : priv;
  const pubTip = change.pub !== undefined || change.pubDelete !== undefined ? { ...drop(pub, change.pubDelete), ...change.pub } : pub;
  return {
    priv: { commits: { base: priv, tip: privTip }, tip: change.priv !== undefined || change.privDelete !== undefined ? "tip" : "base" },
    pub: { commits: { base: pub, tip: pubTip }, tip: change.pub !== undefined || change.pubDelete !== undefined ? "tip" : "base" },
    ...over,
  };
}

describe("computeTwinParity: the outcomes", () => {
  it("in_parity: both sides hold the same files outside the private set, with the private files only on the private side; metadata reads only, and the anchors are not read twice", async () => {
    const f = makeFake(world());
    const r = await f.run();
    expect(r).toMatchObject({ result: "in_parity", paths: [], pathCount: 0, publishCount: 0, syncCount: 0, conflictCount: 0, advanceSyncedTo: null, limitSide: null, privateSha: f.anchors.published, publicSha: f.anchors.synced });
    // two tips (a repository and a ref each) and the two trees; each tip is its own anchor, so nothing is read twice
    expect(f.log.map((l) => `${l.side}:${l.kind}`)).toEqual(["pub:repo", "pub:ref", "priv:repo", "priv:ref", "priv:tree", "pub:tree"]);
    expect(new Set(f.log.map((l) => l.kind))).toEqual(new Set(["repo", "ref", "tree"]));
  });

  it("publish_pending: only the private side changed (a new file, an edit and a delete); the private set never counts", async () => {
    const f = makeFake(world({ priv: { "src/new.ts": "n1", "src/a.ts": "a2", ".autonomous-team/plan.md": "p2", "app/[id]/page.tsx": "x2", ".env": "e2" }, privDelete: ["docs/guide.md"] }));
    const r = await f.run();
    expect(r).toMatchObject({ result: "publish_pending", paths: ["docs/guide.md", "src/a.ts", "src/new.ts"], pathCount: 3, publishCount: 3, syncCount: 0, conflictCount: 0, advanceSyncedTo: null });
  });

  it("sync_pending: the public side changed (an edit, a new file and a delete) and the private side did not; the anchor is not moved", async () => {
    const f = makeFake(world({ pub: { "src/b.ts": "b2", "src/new.ts": "n1" }, pubDelete: ["README.md"] }));
    const r = await f.run();
    expect(r).toMatchObject({ result: "sync_pending", paths: ["README.md", "src/b.ts", "src/new.ts"], pathCount: 3, syncCount: 3, publishCount: 0, conflictCount: 0, advanceSyncedTo: null });
  });

  it("conflict: a path changed on both sides to different content is the result, with its own paths only; the publish and sync counts are still exact", async () => {
    const f = makeFake(world({ priv: { "src/a.ts": "a-private", "src/p.ts": "p1" }, pub: { "src/a.ts": "a-public", "src/q.ts": "q1" } }));
    const r = await f.run();
    expect(r).toMatchObject({ result: "conflict", paths: ["src/a.ts"], pathCount: 1, conflictCount: 1, publishCount: 1, syncCount: 1, advanceSyncedTo: null });
  });

  it("a conflict alone (nothing else to sync) does not move the anchor either", async () => {
    const f = makeFake(world({ priv: { "src/a.ts": "a-private" }, pub: { "src/a.ts": "a-public" } }));
    expect(await f.run()).toMatchObject({ result: "conflict", paths: ["src/a.ts"], conflictCount: 1, syncCount: 0, publishCount: 0, advanceSyncedTo: null });
  });

  it("a delete on one side against an edit on the other is a conflict too", async () => {
    const f = makeFake(world({ priv: { "src/a.ts": "a2" }, pubDelete: ["src/a.ts"] }));
    expect(await f.run()).toMatchObject({ result: "conflict", paths: ["src/a.ts"] });
  });

  it("a path that differs but is in neither delta (an anchor that does not match what was published) is a conflict, never a sync: a wrong anchor must not overwrite a private file", async () => {
    // Both sides sit exactly at their anchors, yet src/a.ts differs between them.
    const w = world();
    w.pub.commits.base = { ...BASE, "src/a.ts": "a-other" };
    const r = await makeFake(w).run();
    expect(r).toMatchObject({ result: "conflict", paths: ["src/a.ts"], conflictCount: 1, syncCount: 0, advanceSyncedTo: null });
  });

  it("the no-op: our own publish merged on the public side (the public delta equals the private files), so the anchor moves to the public tip and nothing is pending", async () => {
    // The private side published src/a.ts and src/new.ts earlier (its anchor is the old base); the public repository now holds exactly them.
    const f = makeFake(world({ priv: { "src/a.ts": "a2", "src/new.ts": "n1" }, pub: { "src/a.ts": "a2", "src/new.ts": "n1" } }));
    const r = await f.run();
    expect(r).toMatchObject({ result: "in_parity", paths: [], pathCount: 0, advanceSyncedTo: commitId("pub:tip") });
  });

  it("the no-op with a private change still to publish is publish_pending, and the anchor still moves", async () => {
    const f = makeFake(world({ priv: { "src/a.ts": "a2", "src/later.ts": "l1" }, pub: { "src/a.ts": "a2" } }));
    expect(await f.run()).toMatchObject({ result: "publish_pending", paths: ["src/later.ts"], publishCount: 1, advanceSyncedTo: commitId("pub:tip") });
  });

  it("the anchor does not move while a real sync is pending, even when some public paths were our own publish", async () => {
    const f = makeFake(world({ priv: { "src/a.ts": "a2" }, pub: { "src/a.ts": "a2", "src/b.ts": "b-public" } }));
    expect(await f.run()).toMatchObject({ result: "sync_pending", paths: ["src/b.ts"], advanceSyncedTo: null });
  });

  it("both sides making the same change is no difference at all", async () => {
    const f = makeFake(world({ priv: { "src/a.ts": "same" }, pub: { "src/a.ts": "same" } }));
    expect(await f.run()).toMatchObject({ result: "in_parity", pathCount: 0, advanceSyncedTo: commitId("pub:tip") });
  });

  it("a public tip that moved only inside the private set moves the anchor and changes nothing else", async () => {
    const f = makeFake(world({ pub: { "internal/public-copy.md": "i1", ".env": "leaked" } }));
    expect(await f.run()).toMatchObject({ result: "in_parity", pathCount: 0, advanceSyncedTo: commitId("pub:tip") });
  });

  it("the private set is dropped from BOTH sides: a private file that differs, appears or vanishes on either side never shows, an install path with brackets included", async () => {
    const f = makeFake(world({ priv: { "internal/notes.md": "n2", "app/[id]/page.tsx": "x2", ".autonomous-team/new.md": "z" }, pub: { "app/[id]/page.tsx": "x-public", "internal/notes.md": "n-public" } }));
    expect(await f.run()).toMatchObject({ result: "in_parity", pathCount: 0, conflictCount: 0, syncCount: 0, publishCount: 0 });
  });
});

describe("computeTwinParity: the cap, the bounds and the failures", () => {
  it("caps the paths at 200, sorted, and counts all of them", async () => {
    const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`gen/f${String(i).padStart(3, "0")}.ts`, `v${i}`]));
    const r = await makeFake(world({ pub: many })).run();
    expect(r.result).toBe("sync_pending");
    expect(r.pathCount).toBe(250);
    expect(r.syncCount).toBe(250);
    expect(TWIN_PARITY_PATHS_CAP).toBe(200);
    expect(r.paths).toHaveLength(200);
    expect(r.paths).toEqual(Object.keys(many).sort().slice(0, 200));
  });

  it("makes at most 8 reads when every tip and anchor differs, inside the shared call budget", async () => {
    const f = makeFake(world({ priv: { "src/a.ts": "a2" }, pub: { "src/b.ts": "b2" } }));
    await f.run();
    expect(f.log).toHaveLength(8);
    expect(f.trees()).toBe(4);
    expect(f.log.length).toBeLessThanOrEqual(MAX_PARITY_CALLS);
  });

  it("an overlay that does not compile (a backslash in an install path) is invalid_overlay, and nothing is read", async () => {
    const f = makeFake(world());
    expect(await f.run({}, { installPaths: ["bad\\path"] })).toMatchObject({ result: "invalid_overlay", paths: [], pathCount: 0, advanceSyncedTo: null });
    expect(f.log).toEqual([]);
  });

  it("a twin with no anchors yet (not seeded) is unavailable, and nothing is read", async () => {
    for (const twin of [{ publishedPrivateSha: null }, { syncedPublicSha: null }, { publishedPrivateSha: "main" }]) {
      const f = makeFake(world());
      expect(await f.run({}, twin)).toMatchObject({ result: "unavailable", advanceSyncedTo: null });
      expect(f.log).toEqual([]);
    }
  });

  it("a recursive tree that is not plainly untruncated is too_large, for the side it is on", async () => {
    for (const side of ["priv", "pub"] as const) {
      for (const flag of [true, "missing"] as const) {
        const r = await makeFake(world({ priv: { "src/a.ts": "a2" } }, { truncate: { [side]: flag } })).run();
        expect(r).toMatchObject({ result: "too_large", limitSide: side === "priv" ? "private" : "public", paths: [], pathCount: 0, advanceSyncedTo: null });
      }
    }
  });

  it("a default branch other than main is unsupported_branch, for the side it is on", async () => {
    for (const side of ["priv", "pub"] as const) {
      const r = await makeFake(world({}, { defaultBranch: { [side]: "trunk" } })).run();
      expect(r).toMatchObject({ result: "unsupported_branch", limitSide: side === "priv" ? "private" : "public" });
    }
  });

  it("an anchor GitHub no longer has, an error, a timeout and a call over the budget are unavailable, and what GitHub said is never in the result", async () => {
    const gone = world();
    gone.priv.commits = { tip: gone.priv.commits.base! };
    gone.priv.tip = "tip";
    const failures = [
      await makeFake(gone).run({}, { publishedPrivateSha: commitId("priv:base") }),
      await makeFake(world({}, { fail: (kind, side) => (kind === "tree" && side === "pub" ? { status: 500 } : undefined) })).run(),
      await makeFake(world({}, { fail: (kind) => (kind === "ref" ? { status: 403 } : undefined) })).run(),
      await makeFake(world({}, { fail: (kind) => (kind === "tree" ? "hang" : undefined) })).run({ limits: { callTimeoutMs: 20 } }),
      await makeFake(world({ priv: { "src/a.ts": "a2" }, pub: { "src/b.ts": "b2" } })).run({ limits: { maxCalls: 6 } }),
    ];
    for (const r of failures) {
      expect(r).toMatchObject({ result: "unavailable", paths: [], pathCount: 0, publishCount: 0, syncCount: 0, conflictCount: 0, advanceSyncedTo: null });
      expect(JSON.stringify(r)).not.toMatch(/secret-path|boom/);
    }
  });

  it("never reads a commit list, a compare, a file's content or anything it was not given: the fake refuses them and the check still answers", async () => {
    const f = makeFake(world({ priv: { "src/a.ts": "a2" } }));
    expect((await f.run()).result).toBe("publish_pending");
    expect(f.log.filter((l) => l.kind === "other")).toEqual([]);
  });
});
