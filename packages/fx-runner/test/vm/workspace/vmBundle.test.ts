import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildWorkspaceArchive } from "../../../src/daemon/vmArchive.js";
import { applyBundle, checkTipTree, MAX_COMMITS } from "../../../src/daemon/vmBundle.js";
import { BundleRefused, MAX_BUNDLE_BYTES, parseBundleHeader } from "../../../src/vm/workspace/bundleHeader.js";
import { BundlePullError, pullBundle, reopenWorkspace } from "../../../src/vm/workspace/bundleOut.js";
import { sendWorkspace } from "../../../src/vm/workspace/guestWorkspace.js";
import { createGit } from "../../../src/daemon/git.js";
import { DEFAULT_PACK_LIMITS } from "../../../src/vm/workspace/packScan.js";
import { bundleOf, craftBundle, entryHeader, packOf, plainEntry } from "./bombs.js";
import { fixtureRepo, git, GIT_ENV, hostDeps, hostWorkspace, localGuest, scratchDir, type LocalGuest } from "./helpers.js";

const refusal = async (work: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    if (error instanceof BundleRefused || error instanceof BundlePullError) return error.code;
    throw error;
  }
  return "none";
};

/** A fixture repo, its host workspace, and a guest that was sent the start commit through the real archive path. */
async function started() {
  const fx = fixtureRepo();
  const deps = hostDeps();
  const g = localGuest();
  await sendWorkspace(g.guest, await buildWorkspaceArchive(deps, fx.mirror, fx.commit), g.paths);
  const ws = hostWorkspace(fx.mirror, fx.commit);
  const canaryDir = scratchDir("fxw-canary-");
  const canary = path.join(canaryDir, "canary.txt");
  writeFileSync(canary, "untouched\n");
  return { fx, deps, g, ws, canary, canaryDir };
}
const commitInGuest = (g: LocalGuest, message = "agent"): void => {
  git(g.paths.workspace, "add", "-A");
  git(g.paths.workspace, "commit", "-qm", message);
};
const hashObject = (cwd: string, type: string, body: Buffer): string => execFileSync("git", ["hash-object", "-w", "-t", type, "--literally", "--stdin"], { cwd, env: GIT_ENV(), input: body, encoding: "utf8" }).trim();
/** A tree object made by hand, so it can hold an entry git itself would never write. */
const rawTree = (cwd: string, entries: Array<{ mode: string; name: string; oid: string }>): string => hashObject(cwd, "tree", Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, "hex")]))));
/** Replaces the guest's tip with a commit over `tree` (child of the start commit). */
function commitTree(g: LocalGuest, base: string, tree: string): void {
  const commit = git(g.paths.workspace, "commit-tree", tree, "-p", base, "-m", "crafted");
  git(g.paths.workspace, "update-ref", "refs/heads/fx-work", commit);
}
const treeWith = (g: LocalGuest, base: string, extra: Array<{ mode: string; name: string; oid: string }>): string => {
  const blob = git(g.paths.workspace, "hash-object", "-w", "--stdin");
  void blob;
  const entries = git(g.paths.workspace, "ls-tree", base).split("\n").map((line) => {
    const m = line.match(/^(\d+) \w+ ([0-9a-f]{40})\t(.+)$/) as RegExpMatchArray;
    return { mode: m[1] as string, oid: m[2] as string, name: m[3] as string };
  });
  return rawTree(g.paths.workspace, [...entries, ...extra].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))));
};
const blobOf = (g: LocalGuest, text: string): string => execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: g.paths.workspace, env: GIT_ENV(), input: text, encoding: "utf8" }).trim();
const snapshot = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).filter((f) => !f.startsWith(".git")).sort();

describe("the header of a bundle is read as text before git sees it", () => {
  async function realBundle() {
    const s = await started();
    writeFileSync(path.join(s.g.paths.workspace, "n.txt"), "n\n");
    commitInGuest(s.g);
    return { ...s, bundle: (await pullBundle(s.g.guest, s.fx.commit, { paths: s.g.paths })) as Buffer };
  }

  it("a real bundle of the agent's commit has the one prerequisite and the one HEAD, and a pack", async () => {
    const s = await realBundle();
    const header = parseBundleHeader(s.bundle, s.fx.commit);
    expect(header.tip).toBe(git(s.g.paths.workspace, "rev-parse", "HEAD"));
    expect(s.bundle.subarray(header.packAt, header.packAt + 4).toString()).toBe("PACK");
  });

  it("a wrong prerequisite, two of them, none, another ref name, an extra ref, another object format and a missing pack are each refused with their own closed code", async () => {
    const { bundle, fx } = await realBundle();
    const text = bundle.toString("latin1");
    const edit = (from: string | RegExp, to: string): Buffer => Buffer.from(text.replace(from, to), "latin1");
    const other = "b".repeat(40);
    const cases: Array<[string, Buffer, string]> = [
      ["wrong prerequisite", edit(`-${fx.commit}`, `-${other}`), "bundle_prerequisite"],
      ["two prerequisites", edit(/(-[0-9a-f]{40}[^\n]*\n)/, `$1-${other} x\n`), "bundle_prerequisite"],
      ["no prerequisite", edit(/-[0-9a-f]{40}[^\n]*\n/, ""), "bundle_prerequisite"],
      ["another ref", edit(/ HEAD\n/, " refs/heads/main\n"), "bundle_ref"],
      ["an extra ref", edit(/( HEAD\n)/, `$1${other} refs/heads/extra\n`), "bundle_ref"],
      ["sha256", edit("# v2 git bundle", "# v3 git bundle\n@object-format=sha256"), "bundle_malformed"],
      ["a capability that is not the object format", edit("# v2 git bundle", "# v3 git bundle\n@filter=blob:none"), "bundle_malformed"],
      ["not a bundle", Buffer.from("hello"), "bundle_malformed"],
      ["no pack", Buffer.from(text.slice(0, text.indexOf("PACK")), "latin1"), "bundle_malformed"],
    ];
    for (const [why, tampered, code] of cases) expect(await refusal(() => parseBundleHeader(tampered, fx.commit)), why).toBe(code);
    expect(await refusal(() => parseBundleHeader(bundle, fx.commit, bundle.length - 1))).toBe("bundle_too_large");
    expect(await refusal(() => parseBundleHeader(bundle, "not-a-commit"))).toBe("bundle_prerequisite");
    expect(MAX_BUNDLE_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});

describe("what the guest is asked for, and how much", () => {
  it("nothing new is null; a commit is a bundle; the staging file is removed after", async () => {
    const s = await started();
    expect(await pullBundle(s.g.guest, s.fx.commit, { paths: s.g.paths })).toBeNull();
    writeFileSync(path.join(s.g.paths.workspace, "n.txt"), "n\n");
    commitInGuest(s.g);
    expect((await pullBundle(s.g.guest, s.fx.commit, { paths: s.g.paths }))?.length).toBeGreaterThan(100);
    expect(existsSync(path.join(s.g.paths.stage, "out.bundle"))).toBe(false);
  });

  it("a bundle over the cap is refused from the size the guest names, before any of it is transferred", async () => {
    const s = await started();
    writeFileSync(path.join(s.g.paths.workspace, "big.bin"), randomBytes(200_000));
    commitInGuest(s.g);
    const before = s.g.sent.commands.length;
    expect(await refusal(pullBundle(s.g.guest, s.fx.commit, { paths: s.g.paths, maxBytes: 1000 }))).toBe("bundle_too_large");
    expect(s.g.sent.commands.slice(before).some((c) => c.cmd === "base64")).toBe(false);
  });

  it("a guest that sends more than it said is cut off, and a length that does not match is refused", async () => {
    const s = await started();
    writeFileSync(path.join(s.g.paths.workspace, "n.txt"), "n\n");
    commitInGuest(s.g);
    const real = s.g.guest;
    const lying = (extra: string, killed: { n: number }, replace = false) => ({ ...real, runCommand: async (p: Parameters<typeof real.runCommand>[0]) => {
      const command = await real.runCommand(p);
      if (p.cmd !== "base64") return command;
      return { ...command, async *logs() { if (!replace) for await (const c of command.logs()) yield c; yield { stream: "stdout", data: extra }; }, kill: async (sig?: "SIGTERM" | "SIGKILL") => (killed.n++, command.kill(sig)) };
    } }) as typeof real;
    const killed = { n: 0 };
    expect(await refusal(pullBundle(lying("A".repeat(100_000), killed), s.fx.commit, { paths: s.g.paths }))).toBe("bundle_size_mismatch");
    expect(killed.n).toBe(1);
    // four more valid characters: a length that does not match (or, when the real text ended in padding, text that is no longer base64): refused either way
    expect(["bundle_size_mismatch", "bundle_pull_failed"]).toContain(await refusal(pullBundle(lying("QUJD", { n: 0 }), s.fx.commit, { paths: s.g.paths })));
    // valid base64 of the wrong length (the real data replaced by three bytes): the decoded length is not the size the guest named
    expect(await refusal(pullBundle(lying("QUJD", { n: 0 }, true), s.fx.commit, { paths: s.g.paths }))).toBe("bundle_size_mismatch");
  });

  it("the guest's working copy is found again for the run that sent it, and for no other commit", async () => {
    const s = await started();
    expect(await reopenWorkspace(s.g.guest, s.fx.commit, s.g.paths)).toBe(true);
    expect(await reopenWorkspace(s.g.guest, "c".repeat(40), s.g.paths)).toBe(false);
    const fresh = localGuest();
    expect(await reopenWorkspace(fresh.guest, s.fx.commit, fresh.paths)).toBe(false);
  });
});

describe("the bundle comes into the host workspace, and nothing else changes", () => {
  it("the agent's commits arrive: the same tree as the guest's, the same history, files and modes in the workspace, no leftovers", async () => {
    const s = await started();
    writeFileSync(path.join(s.g.paths.workspace, "n.txt"), "new\n");
    writeFileSync(path.join(s.g.paths.workspace, "README.md"), "changed\n");
    execFileSync("chmod", ["755", path.join(s.g.paths.workspace, "README.md")]);
    symlinkSync("src/a.ts", path.join(s.g.paths.workspace, "second-link"));
    commitInGuest(s.g, "one");
    writeFileSync(path.join(s.g.paths.workspace, "n.txt"), "newer\n");
    commitInGuest(s.g, "two");
    const bundle = (await pullBundle(s.g.guest, s.fx.commit, { paths: s.g.paths })) as Buffer;
    const applied = await applyBundle(s.deps, { bundle, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws });
    expect(applied).toEqual({ tip: git(s.g.paths.workspace, "rev-parse", "HEAD"), commits: 2 });
    expect(git(s.ws, "rev-parse", "HEAD")).toBe(applied.tip);
    expect(git(s.ws, "rev-parse", "HEAD^{tree}")).toBe(git(s.g.paths.workspace, "rev-parse", "HEAD^{tree}"));
    expect(git(s.ws, "log", "--format=%s", `${s.fx.commit}..HEAD`)).toBe("two\none");
    expect(git(s.ws, "status", "--porcelain")).toBe("");
    expect(readFileSync(path.join(s.ws, "n.txt"), "utf8")).toBe("newer\n");
    expect(statSync(path.join(s.ws, "README.md")).mode & 0o111).not.toBe(0);
    expect(lstatSync(path.join(s.ws, "second-link")).isSymbolicLink()).toBe(true);
    expect(git(s.ws, "for-each-ref", "refs/fx")).toBe("");
    expect(readdirSync(s.deps.scratchDir)).toEqual([]);
  });

  it.each([
    ["a link with an absolute target", (g: LocalGuest, canaryDir: string) => symlinkSync(canaryDir, path.join(g.paths.workspace, "escape"))],
    ["a link that climbs out with ..", (_g: LocalGuest, _c: string) => undefined],
  ])("%s is refused (bundle_tree), the workspace and the canary outside it are as they were", async (why, plant) => {
    const s = await started();
    if (why.startsWith("a link that climbs")) symlinkSync(`../../../../../../..${s.canaryDir}`, path.join(s.g.paths.workspace, "escape"));
    else plant(s.g, s.canaryDir);
    commitInGuest(s.g);
    const bundle = (await pullBundle(s.g.guest, s.fx.commit, { paths: s.g.paths })) as Buffer;
    const before = snapshot(s.ws);
    expect(await refusal(applyBundle(s.deps, { bundle, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe("bundle_tree");
    expect(git(s.ws, "rev-parse", "HEAD")).toBe(s.fx.commit);
    expect(snapshot(s.ws)).toEqual(before);
    expect(readFileSync(s.canary, "utf8")).toBe("untouched\n");
    expect(readdirSync(s.canaryDir)).toEqual(["canary.txt"]);
  });

  it("a regular file replaced by a link that points out (a type change on an existing path) is refused and the file stays", async () => {
    const s = await started();
    execFileSync("rm", [path.join(s.g.paths.workspace, "README.md")]);
    symlinkSync(s.canary, path.join(s.g.paths.workspace, "README.md"));
    commitInGuest(s.g);
    const bundle = (await pullBundle(s.g.guest, s.fx.commit, { paths: s.g.paths })) as Buffer;
    expect(await refusal(applyBundle(s.deps, { bundle, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe("bundle_tree");
    expect(readFileSync(path.join(s.ws, "README.md"), "utf8")).toBe("hello\n");
    expect(readFileSync(s.canary, "utf8")).toBe("untouched\n");
  });

  it.each([
    ["an entry named .. ", "..", "100644"],
    ["an entry with an absolute name", "/abs-canary", "100644"],
    ["an entry named .git", ".git", "100644"],
    ["an entry named .GIT with a mode of its own", ".GIT", "100755"],
    ["a mode git does not write (100664)", "odd.txt", "100664"],
    ["a submodule entry", "vendor", "160000"],
  ])("a tree with %s is refused and no file is written", async (_why, name, mode) => {
    const s = await started();
    const blob = blobOf(s.g, "payload\n");
    const base = s.fx.commit;
    const tree = treeWith(s.g, base, [{ mode, name, oid: mode === "160000" ? "d".repeat(40) : blob }]);
    commitTree(s.g, base, tree);
    const bundle = await pullBundle(s.g.guest, base, { paths: s.g.paths }).catch(() => null);
    if (bundle === null) return;
    const before = snapshot(s.ws);
    const code = await refusal(applyBundle(s.deps, { bundle, base, mirrorDir: s.fx.mirror, workspace: s.ws }));
    expect(["bundle_fetch_failed", "bundle_tree"]).toContain(code);
    expect(git(s.ws, "rev-parse", "HEAD")).toBe(base);
    expect(snapshot(s.ws)).toEqual(before);
    expect(existsSync("/abs-canary")).toBe(false);
    expect(readFileSync(s.canary, "utf8")).toBe("untouched\n");
  });

  it("a bundle built on another commit, a merge, a workspace that moved and a garbled bundle are each refused with their own code", async () => {
    const s = await started();
    writeFileSync(path.join(s.g.paths.workspace, "n.txt"), "n\n");
    commitInGuest(s.g);
    const good = (await pullBundle(s.g.guest, s.fx.commit, { paths: s.g.paths })) as Buffer;
    expect(await refusal(applyBundle(s.deps, { bundle: good, base: "e".repeat(40), mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe("bundle_prerequisite");
    // a byte flipped inside the data is seen by the host's own walk of the pack; one flipped in the checksum passes the walk and is git's to refuse
    const garbled = Buffer.from(good);
    garbled[garbled.length - 30] = (garbled[garbled.length - 30] as number) ^ 0xff;
    expect(await refusal(applyBundle(s.deps, { bundle: garbled, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe("bundle_malformed");
    const badSum = Buffer.from(good);
    badSum[badSum.length - 1] = (badSum[badSum.length - 1] as number) ^ 0xff;
    expect(await refusal(applyBundle(s.deps, { bundle: badSum, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe("bundle_fetch_failed");
    // the workspace has moved on from the start commit: nothing is checked out over it
    writeFileSync(path.join(s.ws, "mine.txt"), "m\n");
    git(s.ws, "add", "mine.txt");
    git(s.ws, "commit", "-qm", "moved");
    expect(await refusal(applyBundle(s.deps, { bundle: good, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe("bundle_base_moved");
    expect(existsSync(path.join(s.ws, "n.txt"))).toBe(false);
    // a merge commit: a second branch merged in the guest
    const s2 = await started();
    git(s2.g.paths.workspace, "checkout", "-q", "-b", "side");
    writeFileSync(path.join(s2.g.paths.workspace, "side.txt"), "s\n");
    commitInGuest(s2.g, "side");
    git(s2.g.paths.workspace, "checkout", "-q", "fx-work");
    writeFileSync(path.join(s2.g.paths.workspace, "main.txt"), "m\n");
    commitInGuest(s2.g, "main");
    git(s2.g.paths.workspace, "merge", "-q", "--no-ff", "-m", "merge", "side");
    const merged = (await pullBundle(s2.g.guest, s2.fx.commit, { paths: s2.g.paths })) as Buffer;
    expect(await refusal(applyBundle(s2.deps, { bundle: merged, base: s2.fx.commit, mirrorDir: s2.fx.mirror, workspace: s2.ws }))).toBe("bundle_commits");
    expect(MAX_COMMITS).toBe(500);
  });

  it("a .gitattributes in the guest's tree cannot run a filter the host has configured, and the bytes are checked out as committed", async () => {
    const config = path.join(scratchDir("fxw-cfg-"), "gitconfig");
    const probe = path.join(scratchDir("fxw-probe-"), "filter-ran");
    writeFileSync(config, `[filter "pwn"]\n\tsmudge = sh -c 'touch ${probe}; cat'\n\tclean = cat\n\trequired = true\n`);
    const fx = fixtureRepo();
    const deps = hostDeps({ GIT_CONFIG_GLOBAL: config });
    const g = localGuest();
    await sendWorkspace(g.guest, await buildWorkspaceArchive(deps, fx.mirror, fx.commit), g.paths);
    const ws = hostWorkspace(fx.mirror, fx.commit);
    writeFileSync(path.join(g.paths.workspace, ".gitattributes"), "*.txt filter=pwn\n");
    writeFileSync(path.join(g.paths.workspace, "a.txt"), "line\r\nline\r\n");
    git(g.paths.workspace, "add", "-A");
    git(g.paths.workspace, "-c", "core.autocrlf=false", "commit", "-qm", "attrs");
    const bundle = (await pullBundle(g.guest, fx.commit, { paths: g.paths })) as Buffer;
    mkdirSync(path.dirname(probe), { recursive: true });
    await applyBundle(deps, { bundle, base: fx.commit, mirrorDir: fx.mirror, workspace: ws });
    expect(existsSync(probe)).toBe(false);
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("line\r\nline\r\n");
    expect(git(ws, "rev-parse", "HEAD^{tree}")).toBe(git(g.paths.workspace, "rev-parse", "HEAD^{tree}"));
  });
});

describe("the host's own check of the tip's tree, independent of git's", () => {
  /** A bare repository made by hand, with one commit over a tree that holds `extra` on top of a plain file. */
  function repoWith(extra: Array<{ mode: string; name: string; target?: string; oid?: string }>): { repo: string; tip: string } {
    const repo = path.join(scratchDir("fxw-tree-"), "r");
    execFileSync("git", ["init", "-q", "--bare", repo], { env: GIT_ENV() });
    const blob = (text: string): string => execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, env: GIT_ENV(), input: text, encoding: "utf8" }).trim();
    const entries = [{ mode: "100644", name: "ok.txt", oid: blob("ok\n") }, ...extra.map((e) => ({ mode: e.mode, name: e.name, oid: e.oid ?? blob(e.target ?? "x\n") }))].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const tree = rawTree(repo, entries);
    return { repo, tip: execFileSync("git", ["commit-tree", tree, "-m", "t"], { cwd: repo, env: GIT_ENV(), encoding: "utf8" }).trim() };
  }
  const code = async (extra: Parameters<typeof repoWith>[0]): Promise<string> => {
    const { repo, tip } = repoWith(extra);
    return refusal(checkTipTree(hostDeps(), repo, tip));
  };

  it("a plain tree, and links that stay inside, pass", async () => {
    expect(await code([])).toBe("none");
    expect(await code([{ mode: "120000", name: "l", target: "ok.txt" }, { mode: "100755", name: "x.sh" }])).toBe("none");
  });

  it.each([
    ["an absolute link target", { mode: "120000", name: "l", target: "/outside/file" }],
    ["a link target that climbs out", { mode: "120000", name: "l", target: "../../x" }],
    ["an empty link target", { mode: "120000", name: "l", target: "" }],
    ["a name that is ..", { mode: "100644", name: ".." }],
    ["a name that is .", { mode: "100644", name: "." }],
    ["an absolute name", { mode: "100644", name: "/abs" }],
    ["a .git name", { mode: "100644", name: ".git" }],
    ["a name with a backslash", { mode: "100644", name: "a\\b" }],
    ["a submodule", { mode: "160000", name: "vendor", oid: "d".repeat(40) }],
  ])("%s is refused as bundle_tree", async (_why, entry) => {
    expect(await code([entry])).toBe("bundle_tree");
  });
});

const MiB = 1024 * 1024;

describe("a small bundle cannot grow without limit on the host (the compressed cap is not a cap on what it inflates to)", () => {
  /** What a refusal must leave alone: HEAD, the files, and the daemon's scratch directory. */
  async function refusedUntouched(s: Awaited<ReturnType<typeof started>>, bundle: Buffer, expected: string, deps = s.deps) {
    const before = snapshot(s.ws);
    const head = git(s.ws, "rev-parse", "HEAD");
    expect(await refusal(applyBundle(deps, { bundle, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe(expected);
    expect(git(s.ws, "rev-parse", "HEAD")).toBe(head);
    expect(snapshot(s.ws)).toEqual(before);
    expect(existsSync(path.join(s.ws, "big.bin"))).toBe(false);
    expect(execFileSync("ls", ["-A", deps.scratchDir], { encoding: "utf8" })).toBe("");
  }

  it("a zlib bomb (an object over the per-object cap that is a few hundred KB compressed) is refused with nothing changed", async () => {
    const s = await started();
    const { bundle } = craftBundle(s.fx.mirror, s.fx.commit, [{ name: "big.bin", source: { kind: "zeros", size: 128 * MiB } }]);
    expect(bundle.length).toBeLessThan(2 * MiB);
    await refusedUntouched(s, bundle, "bundle_too_large");
  });

  it("a delta bomb (a 64 KiB base and a few KB of copy instructions that declare a result over the cap) is refused with nothing changed", async () => {
    const s = await started();
    const { bundle } = craftBundle(s.fx.mirror, s.fx.commit, [{ name: "big.bin", source: { kind: "copies", size: 128 * MiB } }]);
    expect(bundle.length).toBeLessThan(200 * 1024);
    await refusedUntouched(s, bundle, "bundle_too_large");
  });

  it("bundles just under the caps still apply: a 99 MiB object, and a 96 MiB delta result", async () => {
    for (const source of [{ kind: "zeros" as const, size: 99 * MiB }, { kind: "copies" as const, size: 96 * MiB }]) {
      const s = await started();
      const { bundle, tip } = craftBundle(s.fx.mirror, s.fx.commit, [{ name: "big.bin", source }]);
      const applied = await applyBundle(s.deps, { bundle, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws });
      expect(applied.tip, source.kind).toBe(tip);
      expect(statSync(path.join(s.ws, "big.bin")).size, source.kind).toBe(source.size);
    }
  }, 120_000);

  it("the caps are on one object, on the total, and on the object count: each is refused at its edge and accepted just inside it", async () => {
    const small = (over: Partial<typeof DEFAULT_PACK_LIMITS>) => (deps: ReturnType<typeof hostDeps>) => ({ ...deps, limits: over });
    const blob = (n: number, size: number) => ({ name: `f${String(n)}.bin`, source: { kind: "raw" as const, body: Buffer.concat([Buffer.from([n]), randomBytes(size - 1)]) } });
    // one object: exactly at the cap is fine, one byte over is not
    const atCap = await started();
    const exact = craftBundle(atCap.fx.mirror, atCap.fx.commit, [blob(1, MiB)]);
    expect((await applyBundle(small({ perObject: MiB, total: 100 * MiB })(atCap.deps), { bundle: exact.bundle, base: atCap.fx.commit, mirrorDir: atCap.fx.mirror, workspace: atCap.ws })).tip).toBe(exact.tip);
    const over = await started();
    await refusedUntouched(over, craftBundle(over.fx.mirror, over.fx.commit, [blob(1, MiB + 1)]).bundle, "bundle_too_large", small({ perObject: MiB, total: 100 * MiB })(over.deps));
    // the total: two 1 MiB objects are inside 2.5 MiB, three are not
    const two = await started();
    const pair = craftBundle(two.fx.mirror, two.fx.commit, [blob(1, MiB), blob(2, MiB)]);
    expect((await applyBundle(small({ perObject: MiB, total: 2.5 * MiB })(two.deps), { bundle: pair.bundle, base: two.fx.commit, mirrorDir: two.fx.mirror, workspace: two.ws })).tip).toBe(pair.tip);
    const three = await started();
    await refusedUntouched(three, craftBundle(three.fx.mirror, three.fx.commit, [blob(1, MiB), blob(2, MiB), blob(3, MiB)]).bundle, "bundle_too_large", small({ perObject: MiB, total: 2.5 * MiB })(three.deps));
    // a delta result counts toward both caps
    const delta = await started();
    await refusedUntouched(delta, craftBundle(delta.fx.mirror, delta.fx.commit, [{ name: "d.bin", source: { kind: "copies", size: 2 * MiB } }]).bundle, "bundle_too_large", small({ perObject: MiB, total: 100 * MiB })(delta.deps));
    const deltaTotal = await started();
    await refusedUntouched(deltaTotal, craftBundle(deltaTotal.fx.mirror, deltaTotal.fx.commit, [{ name: "d.bin", source: { kind: "copies", size: 1.5 * MiB } }, blob(1, MiB)]).bundle, "bundle_too_large", small({ perObject: 2 * MiB, total: 2 * MiB })(deltaTotal.deps));
    // a delta's result counts toward the total even when the tree does not name it (so the tree's own sum cannot be what refuses this)
    const unnamed = await started();
    await refusedUntouched(unnamed, craftBundle(unnamed.fx.mirror, unnamed.fx.commit, [], { extraCopies: [1.5 * MiB, 1.5 * MiB] }).bundle, "bundle_too_large", small({ perObject: 2 * MiB, total: 2.5 * MiB })(unnamed.deps));
    // the object count
    const many = await started();
    await refusedUntouched(many, craftBundle(many.fx.mirror, many.fx.commit, [blob(1, 100), blob(2, 100), blob(3, 100)]).bundle, "bundle_too_large", small({ objects: 4 })(many.deps));
    expect(DEFAULT_PACK_LIMITS).toEqual({ perObject: 100 * MiB, total: 1024 * MiB, objects: 500_000 });
  }, 60_000);

  it("a tree that names one stored blob under many names is held to the total as well: the sizes of the tip's listing are summed before the checkout", async () => {
    const s = await started();
    const body = randomBytes(MiB);
    for (const n of [1, 2, 3, 4]) writeFileSync(path.join(s.g.paths.workspace, `copy${String(n)}.bin`), body);
    commitInGuest(s.g);
    const bundle = (await pullBundle(s.g.guest, s.fx.commit, { paths: s.g.paths })) as Buffer;
    // the pack holds the blob once (about 1 MiB), and the tree names it four times
    const tight = { ...s.deps, limits: { perObject: 2 * MiB, total: 2.5 * MiB } };
    const before = snapshot(s.ws);
    expect(await refusal(applyBundle(tight, { bundle, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe("bundle_too_large");
    expect(snapshot(s.ws)).toEqual(before);
    expect(git(s.ws, "rev-parse", "HEAD")).toBe(s.fx.commit);
    expect(await refusal(applyBundle({ ...s.deps, limits: { perObject: 2 * MiB, total: 5 * MiB } }, { bundle, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe("none");
  });

  it("the pack is judged before git runs at all, and git runs with one thread when it does", async () => {
    const calls: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
    const capture = async (command: string, args: readonly string[], env: Record<string, string>) => {
      calls.push({ args, env });
      try {
        return { code: 0, stdout: execFileSync(command, [...args], { env: { ...GIT_ENV(), ...env }, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] }), timedOut: false };
      } catch (error) {
        return { code: (error as { status?: number }).status ?? 1, stdout: "", timedOut: false };
      }
    };
    const recording = createGit({ capture });
    const s = await started();
    const deps = { git: recording, gitLarge: recording, scratchDir: s.deps.scratchDir };
    const bomb = craftBundle(s.fx.mirror, s.fx.commit, [{ name: "big.bin", source: { kind: "zeros", size: 128 * MiB } }]).bundle;
    expect(await refusal(applyBundle(deps, { bundle: bomb, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe("bundle_too_large");
    expect(calls).toEqual([]);
    writeFileSync(path.join(s.g.paths.workspace, "n.txt"), "n\n");
    commitInGuest(s.g);
    const good = (await pullBundle(s.g.guest, s.fx.commit, { paths: s.g.paths })) as Buffer;
    await applyBundle(deps, { bundle: good, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws });
    const settings = (env: Record<string, string>): Record<string, string> => Object.fromEntries(Array.from({ length: Number(env["GIT_CONFIG_COUNT"] ?? 0) }, (_x, i) => [env[`GIT_CONFIG_KEY_${String(i)}`] as string, env[`GIT_CONFIG_VALUE_${String(i)}`] as string]));
    const fetches = calls.filter((c) => c.args.includes("fetch"));
    expect(fetches).toHaveLength(2);
    for (const c of fetches) expect(settings(c.env)["pack.threads"], c.args.join(" ")).toBe("1");
    expect(settings((fetches[0] as { env: Record<string, string> }).env)["fetch.fsckObjects"]).toBe("true");
  });

  it("a pack of plain blobs each under the per-object cap that add up past the total, and a pack of deltas with big instructions and tiny results, are refused with no git call at all", async () => {
    const calls: string[][] = [];
    const real = hostDeps().git;
    const counting = { run: (...a: Parameters<typeof real.run>) => (calls.push([...a[1]]), real.run(...a)) };
    const s = await started();
    const deps = { ...s.deps, git: counting, gitLarge: counting };
    const before = snapshot(s.ws);
    const plain = ["a", "b", "c"].map((name, n) => ({ name: `${name}.bin`, source: { kind: "raw" as const, body: Buffer.concat([Buffer.from([n]), randomBytes(MiB - 1)]) } }));
    expect(await refusal(applyBundle({ ...deps, limits: { perObject: 2 * MiB, total: 2.5 * MiB } }, { bundle: craftBundle(s.fx.mirror, s.fx.commit, plain).bundle, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe("bundle_too_large");
    // 3 deltas of 1 MiB instructions (two size bytes, then zeros) that build 2 bytes each
    const instructions = Buffer.concat([Buffer.from([2, 2]), Buffer.alloc(MiB - 2)]);
    const delta = Buffer.concat([entryHeader(7, instructions.length), Buffer.alloc(20, 1), deflateSync(instructions, { level: 9 })]);
    const heavy = craftBundle(s.fx.mirror, s.fx.commit, [], { extraObjects: [delta, delta, delta] }).bundle;
    expect(await refusal(applyBundle({ ...deps, limits: { perObject: 2 * MiB, total: 2.5 * MiB } }, { bundle: heavy, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe("bundle_too_large");
    expect(calls).toEqual([]);
    expect(snapshot(s.ws)).toEqual(before);
    expect(git(s.ws, "rev-parse", "HEAD")).toBe(s.fx.commit);
    expect(readdirSync(s.deps.scratchDir)).toEqual([]);
  });

  it("a pack whose framing does not parse is refused before git sees it: a header that lies small, a short pack, a wrong count, trailing bytes, an unknown type, no checksum", async () => {
    const s = await started();
    const blobBody = Buffer.from("twenty bytes of text\n");
    const tipOid = "c".repeat(40);
    const make = (objects: Parameters<typeof packOf>[0]): Buffer => bundleOf(s.fx.commit, tipOid, packOf(objects));
    const cases: Array<[string, Buffer]> = [
      ["a size that lies small (declares 10, holds 21)", make({ entries: [Buffer.concat([entryHeader(3, 10), plainEntry(3, blobBody).subarray(entryHeader(3, blobBody.length).length)])] })],
      ["a count above the objects", make({ entries: [plainEntry(3, blobBody)], count: 2 })],
      ["a count below the objects", make({ entries: [plainEntry(3, blobBody), plainEntry(3, Buffer.from("x"))], count: 1 })],
      ["bytes between the last object and the checksum", make({ entries: [plainEntry(3, blobBody)], after: Buffer.from("junk") })],
      ["an object type that is not one", make({ entries: [Buffer.concat([entryHeader(5, blobBody.length), plainEntry(3, blobBody).subarray(entryHeader(3, blobBody.length).length)])] })],
      ["no checksum", make({ entries: [plainEntry(3, blobBody)], noTrailer: true })],
      ["a stream cut short", make({ entries: [plainEntry(3, blobBody).subarray(0, 8)] })],
    ];
    for (const [why, bundle] of cases) expect(await refusal(applyBundle(s.deps, { bundle, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws })), why).toBe("bundle_malformed");
    expect(execFileSync("ls", ["-A", s.deps.scratchDir], { encoding: "utf8" })).toBe("");
  });
});

describe("the commit-shape checks each stand on their own", () => {
  /** A repository whose start commit C has a parent P (the mirror holds both), and a host workspace at C. */
  async function twoDeep() {
    const fx = fixtureRepo((dir) => {
      writeFileSync(path.join(dir, "first.txt"), "1\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "first");
      writeFileSync(path.join(dir, "second.txt"), "2\n");
    });
    const parent = git(fx.repo, "rev-parse", "HEAD^");
    const ws = hostWorkspace(fx.mirror, fx.commit);
    const clone = path.join(scratchDir("fxw-clone-"), "c");
    git(path.dirname(clone), "clone", "-q", fx.repo, clone);
    return { fx, parent, ws, clone, deps: hostDeps() };
  }

  it("a one-commit chain off the start commit's PARENT, with the header's prerequisite rewritten to the start commit, is refused (the walk must end at the start commit)", async () => {
    const t = await twoDeep();
    git(t.clone, "checkout", "-q", "--detach", t.parent);
    git(t.clone, "commit", "-q", "--allow-empty", "-m", "off the parent");
    const out = path.join(path.dirname(t.clone), "off.bundle");
    git(t.clone, "bundle", "create", out, "HEAD", `^${t.parent}`, "--quiet");
    const text = readFileSync(out).toString("latin1").replace(`-${t.parent}`, `-${t.fx.commit}`);
    const bundle = Buffer.from(text, "latin1");
    expect(bundle.includes(Buffer.from(`-${t.fx.commit}`))).toBe(true);
    expect(await refusal(applyBundle(t.deps, { bundle, base: t.fx.commit, mirrorDir: t.fx.mirror, workspace: t.ws }))).toBe("bundle_commits");
    expect(git(t.ws, "rev-parse", "HEAD")).toBe(t.fx.commit);
  });

  it("a merge whose second parent is the start commit itself is refused (a commit in the chain has two parents)", async () => {
    const t = await twoDeep();
    const tree = git(t.clone, "rev-parse", "HEAD^{tree}");
    const z = git(t.clone, "commit-tree", tree, "-p", t.fx.commit, "-m", "z");
    const m = git(t.clone, "commit-tree", tree, "-p", z, "-p", t.fx.commit, "-m", "m");
    git(t.clone, "checkout", "-q", "--detach", m);
    const out = path.join(path.dirname(t.clone), "merge.bundle");
    git(t.clone, "bundle", "create", out, "HEAD", `^${t.fx.commit}`, "--quiet");
    expect(await refusal(applyBundle(t.deps, { bundle: readFileSync(out), base: t.fx.commit, mirrorDir: t.fx.mirror, workspace: t.ws }))).toBe("bundle_commits");
    expect(git(t.ws, "rev-parse", "HEAD")).toBe(t.fx.commit);
  });

  it("the PACK magic is read: twelve bytes that are not a pack, after a valid header, are refused as malformed by the header parser itself", async () => {
    const s = await started();
    writeFileSync(path.join(s.g.paths.workspace, "n.txt"), "n\n");
    commitInGuest(s.g);
    const bundle = (await pullBundle(s.g.guest, s.fx.commit, { paths: s.g.paths })) as Buffer;
    const { packAt } = parseBundleHeader(bundle, s.fx.commit);
    const wrong = Buffer.from(bundle);
    wrong.write("PUCK", packAt, "latin1");
    expect(await refusal(() => parseBundleHeader(wrong, s.fx.commit))).toBe("bundle_malformed");
    const version = Buffer.from(bundle);
    version.writeUInt32BE(3, packAt + 4);
    expect(await refusal(() => parseBundleHeader(version, s.fx.commit))).toBe("bundle_malformed");
  });
});

describe("a link into the repository's own folder is refused", () => {
  it("a link whose target is inside the tree but names .git is refused as bundle_tree, and nothing is checked out", async () => {
    const s = await started();
    symlinkSync(".git/config", path.join(s.g.paths.workspace, "to-config"));
    commitInGuest(s.g);
    const bundle = (await pullBundle(s.g.guest, s.fx.commit, { paths: s.g.paths })) as Buffer;
    const before = snapshot(s.ws);
    expect(await refusal(applyBundle(s.deps, { bundle, base: s.fx.commit, mirrorDir: s.fx.mirror, workspace: s.ws }))).toBe("bundle_tree");
    expect(snapshot(s.ws)).toEqual(before);
    expect(existsSync(path.join(s.ws, "to-config"))).toBe(false);
  });
});
