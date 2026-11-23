import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createSetupRepos } from "../../src/setup/setupRepos.js";
import { fixtureRepo, git, hostDeps, scratchDir } from "../vm/workspace/helpers.js";

/** D#845 ON-8d: the host's copy of a repo for a setup, against real repositories (adapted from the security review's repros). */
describe("createSetupRepos", () => {
  const make = (fx: ReturnType<typeof fixtureRepo>) => {
    const deps = hostDeps();
    const root = path.join(scratchDir("fx-setup-ws-"), "ws");
    let synced: unknown;
    const repos = createSetupRepos({ git: deps.git, gitLarge: deps.gitLarge, mirrors: { sync: async (r) => ((synced = r), { dir: fx.mirror, base: fx.commit }) }, workspaceRoot: root, scratchDir: () => deps.scratchDir });
    return { repos, root, synced: () => synced };
  };
  const sig = new AbortController().signal;

  it("opens a pinned work tree at base_sha below the root, an archive of that commit, and release removes it", async () => {
    const fx = fixtureRepo();
    const m = make(fx);
    const copy = await m.repos.open({ repoId: 7, owner: "acme", name: "w", baseSha: fx.commit, signal: sig });
    expect(path.dirname(copy.workspace)).toBe(m.root);
    expect(git(copy.workspace, "rev-parse", "HEAD")).toBe(fx.commit);
    expect(copy.archive.commit).toBe(fx.commit);
    expect(m.synced()).toEqual({ id: "7", owner: "acme", name: "w" });
    await copy.release();
    expect(existsSync(copy.workspace)).toBe(false);
  });

  it("the archive holds no host path", async () => {
    const fx = fixtureRepo();
    const m = make(fx);
    const copy = await m.repos.open({ repoId: 7, owner: "acme", name: "w", baseSha: fx.commit, signal: sig });
    const text = JSON.stringify(Object.fromEntries(Object.entries(copy.archive).map(([k, v]) => [k, Buffer.isBuffer(v) ? (k === "gz" ? gunzipSync(v) : v).toString("latin1") : v])));
    for (const p of [fx.mirror, fx.repo, copy.workspace, m.root]) expect(text.includes(p), p).toBe(false);
    await copy.release();
  });

  it.each(["", "abc", "A".repeat(40), `${"a".repeat(40)}\n`, "--upload-pack=x"])("refuses a base %j that is not a full lower-hex id, before any sync", async (bad) => {
    const fx = fixtureRepo();
    const m = make(fx);
    await expect(m.repos.open({ repoId: 7, owner: "acme", name: "w", baseSha: bad, signal: sig })).rejects.toThrow();
    expect(m.synced()).toBeUndefined();
  });

  it("a base that is not a commit in the mirror refuses and leaves no work tree behind", async () => {
    const fx = fixtureRepo();
    const m = make(fx);
    await expect(m.repos.open({ repoId: 7, owner: "acme", name: "w", baseSha: "b".repeat(40), signal: sig })).rejects.toThrow();
    await expect(m.repos.open({ repoId: 7, owner: "acme", name: "w", baseSha: fx.tree, signal: sig })).rejects.toThrow();
    expect(existsSync(m.root) ? readdirSync(m.root) : []).toEqual([]);
  });
});
