import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGit } from "../../../src/daemon/git.js";
import { ArchiveRefused } from "../../../src/vm/workspace/tar.js";
import { assertTreeSize, parseTreeListing } from "../../../src/vm/workspace/tree.js";
import { buildWorkspaceArchive, MAX_ARCHIVE_GZ_BYTES } from "../../../src/daemon/vmArchive.js";
import { GuestWorkspaceError, sendWorkspace } from "../../../src/vm/workspace/guestWorkspace.js";
import { fixtureRepo, git, GIT_ENV, localGuest, scratchDir } from "./helpers.js";

/** The daemon's guarded git, bound to real processes with the test environment. */
function hostGit(extraEnv: Record<string, string> = {}) {
  const capture = async (command: string, args: readonly string[], env: Record<string, string>, _timeoutMs: number) => {
    try {
      const stdout = execFileSync(command, [...args], { env: { ...GIT_ENV(), ...env, ...extraEnv }, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, stdout, timedOut: false };
    } catch (error) {
      return { code: (error as { status?: number }).status ?? 1, stdout: "", timedOut: false };
    }
  };
  const g = createGit({ capture });
  return { git: g, gitLarge: g, scratchDir: scratchDir("fxw-scratch-") };
}

describe("building the archive on the host", () => {
  it("is the tree of the commit, with the commit's own text, and no host path inside it", async () => {
    const fx = fixtureRepo();
    const deps = hostGit();
    const archive = await buildWorkspaceArchive(deps, fx.mirror, fx.commit);
    expect(archive.tree).toBe(fx.tree);
    expect(archive.commit).toBe(fx.commit);
    expect(archive.commitText.toString("utf8")).toBe(`${git(fx.repo, "cat-file", "commit", fx.commit)}\n`.replace(/\n\n$/, "\n"));
    expect(archive.items.map((i) => i.path).sort()).toEqual(["README.md", "link-to-a", "run.sh", "src/a.ts"]);
    const raw = execFileSync("gunzip", ["-c"], { input: archive.gz, maxBuffer: 1 << 24 });
    for (const hostPath of [fx.mirror, fx.repo, deps.scratchDir, path.dirname(fx.repo)]) expect(raw.includes(Buffer.from(hostPath)), hostPath).toBe(false);
    expect(archive.commitText.includes(Buffer.from(fx.repo))).toBe(false);
  });

  it("removes its scratch file whether the archive is good or refused", async () => {
    const fx = fixtureRepo((dir) => {
      mkdirSync(path.join(dir, "vendor", "lib"), { recursive: true });
      git(path.join(dir, "vendor", "lib"), "init", "-q");
      git(path.join(dir, "vendor", "lib"), "commit", "-q", "--allow-empty", "-m", "inner");
    });
    const deps = hostGit();
    await expect(buildWorkspaceArchive(deps, fx.mirror, fx.commit)).rejects.toBeInstanceOf(ArchiveRefused);
    expect(execFileSync("ls", ["-A", deps.scratchDir], { encoding: "utf8" })).toBe("");
    const ok = hostGit();
    const fy = fixtureRepo();
    await buildWorkspaceArchive(ok, fy.mirror, fy.commit);
    expect(execFileSync("ls", ["-A", ok.scratchDir], { encoding: "utf8" })).toBe("");
  });

  /** Attribute lines real repositories carry; each changes what a plain `git archive` writes, and none may change what the guest starts from. */
  const ATTRIBUTE_CASES: Array<[string, (dir: string) => void]> = [
    ["export-ignore on a file", (dir) => writeFileSync(path.join(dir, ".gitattributes"), "src/a.ts export-ignore\n")],
    ["export-ignore on a directory and a pattern (the common /tests line)", (dir) => writeFileSync(path.join(dir, ".gitattributes"), "/src export-ignore\n*.md export-ignore\n")],
    ["export-subst", (dir) => (writeFileSync(path.join(dir, ".gitattributes"), "README.md export-subst\n"), writeFileSync(path.join(dir, "README.md"), "id: $Format:%H$\n"))],
    ["eol=crlf", (dir) => (writeFileSync(path.join(dir, ".gitattributes"), "*.bat text eol=crlf\n"), writeFileSync(path.join(dir, "run.bat"), "a\nb\n"))],
    ["text eol=crlf on every text file", (dir) => writeFileSync(path.join(dir, ".gitattributes"), "* text=auto eol=crlf\n")],
    ["ident", (dir) => (writeFileSync(path.join(dir, ".gitattributes"), "README.md ident\n"), writeFileSync(path.join(dir, "README.md"), "$Id$\n"))],
    ["a filter nothing defines", (dir) => writeFileSync(path.join(dir, ".gitattributes"), "README.md filter=nothere\n")],
    ["working-tree-encoding", (dir) => (writeFileSync(path.join(dir, ".gitattributes"), "README.md working-tree-encoding=UTF-16LE-BOM\n"), writeFileSync(path.join(dir, "README.md"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello\n", "utf16le")])))],
  ];

  for (const [name, setup] of ATTRIBUTE_CASES) {
    it(`a repository with ${name} is archived whole, accepted, and the guest's tree is the host's tree byte for byte`, async () => {
      const fx = fixtureRepo(setup);
      const built = await buildWorkspaceArchive(hostGit(), fx.mirror, fx.commit);
      expect(built.tree).toBe(fx.tree);
      const g = localGuest();
      await sendWorkspace(g.guest, built, g.paths);
      expect(git(g.paths.workspace, "rev-parse", "HEAD^{tree}")).toBe(fx.tree);
      // (a working-tree-encoding attribute makes the guest's own git see the UTF-8 file as changed against its own re-encoding; the tree and the bytes are what must match)
      if (name !== "working-tree-encoding") expect(git(g.paths.workspace, "status", "--porcelain")).toBe("");
      // every blob of the tree is on disk as git holds it, with no conversion
      for (const item of built.items.filter((i) => i.mode !== "120000")) {
        expect(readFileSync(path.join(g.paths.workspace, item.path)).equals(execFileSync("git", ["cat-file", "blob", item.oid], { cwd: fx.mirror, env: GIT_ENV() })), item.path).toBe(true);
      }
    });
  }

  it("a work tree is archived the same way as a mirror (the check's fresh VM is given the host workspace's tip)", async () => {
    const fx = fixtureRepo((dir) => writeFileSync(path.join(dir, ".gitattributes"), "src/a.ts export-ignore\n*.md text eol=crlf\n"));
    const fromMirror = await buildWorkspaceArchive(hostGit(), fx.mirror, fx.commit);
    const fromTree = await buildWorkspaceArchive(hostGit(), fx.repo, fx.commit);
    expect(fromTree.tree).toBe(fromMirror.tree);
    expect(fromTree.items).toEqual(fromMirror.items);
    expect(fromTree.commitText.equals(fromMirror.commitText)).toBe(true);
  });

  it("no filter program the host's own git configuration defines is started by an archive, whatever the tree's attributes ask for", async () => {
    const scratch = scratchDir("fxw-filter-");
    const marker = path.join(scratch, "STARTED");
    const config = path.join(scratch, "gitconfig");
    writeFileSync(config, `[filter "x"]\n\tsmudge = "touch ${marker} && cat"\n\tclean = cat\n\trequired = true\n`);
    const fx = fixtureRepo((dir) => (writeFileSync(path.join(dir, ".gitattributes"), "*.md filter=x\n*.ts filter=x\n"), undefined));
    // a self-check that the configuration works: the plain `git archive` the daemon used to run does start it
    execFileSync("git", ["-C", fx.mirror, "archive", "--format=tar", "-o", path.join(scratch, "plain.tar"), fx.tree], { env: { ...GIT_ENV(), GIT_CONFIG_GLOBAL: config } });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const built = await buildWorkspaceArchive(hostGit({ GIT_CONFIG_GLOBAL: config }), fx.mirror, fx.commit);
    expect(built.tree).toBe(fx.tree);
    expect(existsSync(marker)).toBe(false);
  });

  it("a tree whose blobs add up to more than the cap is refused from git's listing, before anything is written", () => {
    const item = (size: number | undefined) => ({ mode: "100644" as const, oid: "a".repeat(40), path: "x", ...(size === undefined ? {} : { size }) });
    expect(() => assertTreeSize([item(10), item(20)], 30)).not.toThrow();
    expect(() => assertTreeSize([item(10), item(21)], 30)).toThrowError(expect.objectContaining({ code: "archive_too_large" }) as Error);
    expect(() => assertTreeSize([item(undefined)], 30)).toThrowError(expect.objectContaining({ code: "archive_too_large" }) as Error);
    expect(parseTreeListing(`100644 blob ${"a".repeat(40)}     12\tx\0`, 10)).toEqual([item(12)]);
  });

  it("a tree whose listed blobs are over the body cap is refused before git archive runs and before anything is written", async () => {
    const fx = fixtureRepo();
    const deps = hostGit();
    const calls: string[][] = [];
    const spy = { run: async (...args: Parameters<typeof deps.git.run>) => (calls.push([...args[1]]), deps.git.run(...args)) };
    await expect(buildWorkspaceArchive({ git: spy, gitLarge: spy, scratchDir: deps.scratchDir, maxBodyBytes: 10 }, fx.mirror, fx.commit)).rejects.toMatchObject({ code: "archive_too_large" });
    expect(calls.some((args) => args.includes("ls-tree") && args.includes("-l"))).toBe(true);
    expect(calls.some((args) => args.includes("archive"))).toBe(false);
    expect(execFileSync("ls", ["-A", deps.scratchDir], { encoding: "utf8" })).toBe("");
    // and at the cap it is built
    const ok = await buildWorkspaceArchive({ ...deps, maxBodyBytes: 1 << 20 }, fx.mirror, fx.commit);
    expect(ok.tree).toBe(fx.tree);
  });

  it("a tree with a submodule entry, a commit that is not a full id and a commit that is not in the mirror are refused", async () => {
    const withModule = fixtureRepo((dir) => {
      mkdirSync(path.join(dir, "vendor", "lib"), { recursive: true });
      git(path.join(dir, "vendor", "lib"), "init", "-q");
      git(path.join(dir, "vendor", "lib"), "commit", "-q", "--allow-empty", "-m", "inner");
    });
    await expect(buildWorkspaceArchive(hostGit(), withModule.mirror, withModule.commit)).rejects.toMatchObject({ code: "archive_type" });
    const fx = fixtureRepo();
    await expect(buildWorkspaceArchive(hostGit(), fx.mirror, "main")).rejects.toMatchObject({ code: "archive_mismatch" });
    await expect(buildWorkspaceArchive(hostGit(), fx.mirror, "e".repeat(40))).rejects.toBeInstanceOf(Error);
  });

  it("an archive over the compressed cap is refused", async () => {
    expect(MAX_ARCHIVE_GZ_BYTES).toBeLessThan(128 * 1024 * 1024);
  });
});

describe("the repository in the guest", () => {
  it("the guest's tree, files, modes, links and start commit are the host's, and the stage is cleaned", async () => {
    const fx = fixtureRepo();
    const archive = await buildWorkspaceArchive(hostGit(), fx.mirror, fx.commit);
    const g = localGuest();
    await sendWorkspace(g.guest, archive, g.paths);
    const ws = g.paths.workspace;
    expect(git(ws, "rev-parse", "HEAD")).toBe(fx.commit);
    expect(git(ws, "rev-parse", "HEAD^{tree}")).toBe(fx.tree);
    expect(git(ws, "status", "--porcelain")).toBe("");
    expect(readFileSync(path.join(ws, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(statSync(path.join(ws, "run.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(path.join(ws, "README.md")).mode & 0o111).toBe(0);
    expect(lstatSync(path.join(ws, "link-to-a")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(ws, "link-to-a"))).toBe("src/a.ts");
    expect(readFileSync(path.join(g.paths.stage, "base"), "utf8").trim()).toBe(fx.commit);
    expect(execFileSync("ls", ["-A", g.paths.stage], { encoding: "utf8" }).trim()).toBe("base");
    // the agent's own commit has the start commit as its parent, and a bundle of it names exactly that one prerequisite
    writeFileSync(path.join(ws, "new.txt"), "n\n");
    git(ws, "add", "new.txt");
    git(ws, "commit", "-qm", "agent");
    expect(git(ws, "rev-parse", "HEAD^")).toBe(fx.commit);
    expect(git(ws, "bundle", "create", path.join(g.root, "out.bundle"), "HEAD", `^${fx.commit}`)).toBe("");
    expect(readFileSync(path.join(g.root, "out.bundle"), "latin1")).toContain(`-${fx.commit}`);
  });

  it("a .gitattributes in the tree cannot change a byte of it in the guest (CRLF kept, tree equal)", async () => {
    // the CRLF file is committed first, with no attribute; the attribute that would rewrite it on a `git add` arrives in the fixture commit
    const fx = fixtureRepo((dir) => {
      writeFileSync(path.join(dir, "crlf.txt"), "a\r\nb\r\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "crlf");
      writeFileSync(path.join(dir, ".gitattributes"), "*.txt text eol=lf\n");
      // the attribute goes in WITHOUT re-adding the CRLF file (a plain `add` would rewrite it to LF)
      git(dir, "update-index", "--add", "--cacheinfo", `100644,${git(dir, "hash-object", "-w", ".gitattributes")},.gitattributes`);
      git(dir, "commit", "-qm", "attributes");
      return "committed";
    });
    expect(git(fx.repo, "cat-file", "-p", `${fx.commit}:crlf.txt`)).toBe("a\r\nb"); // trim strips the last newline only
    expect(execFileSync("git", ["-C", fx.repo, "cat-file", "-p", `${fx.commit}:crlf.txt`], { env: GIT_ENV() }).toString()).toBe("a\r\nb\r\n");
    const archive = await buildWorkspaceArchive(hostGit(), fx.mirror, fx.commit);
    const g = localGuest();
    await sendWorkspace(g.guest, archive, g.paths);
    expect(git(g.paths.workspace, "rev-parse", "HEAD^{tree}")).toBe(fx.tree);
    expect(readFileSync(path.join(g.paths.workspace, "crlf.txt"), "utf8")).toBe("a\r\nb\r\n");
  });

  it("nothing sent names a host path: not the files, not the command lines, not the environment", async () => {
    const fx = fixtureRepo();
    const deps = hostGit();
    const archive = await buildWorkspaceArchive(deps, fx.mirror, fx.commit);
    const g = localGuest();
    await sendWorkspace(g.guest, archive, g.paths);
    const hostPaths = [fx.mirror, fx.repo, deps.scratchDir, path.dirname(fx.repo), process.cwd()];
    const wire = JSON.stringify({ commands: g.sent.commands, files: g.sent.files.filter((f) => !f.path.endsWith("archive.b64")) });
    for (const hostPath of hostPaths) expect(wire.includes(hostPath), hostPath).toBe(false);
    const archived = g.sent.files.find((f) => f.path.endsWith("archive.b64"));
    expect(archived).toBeDefined();
    for (const hostPath of hostPaths) expect(Buffer.from(archived?.content ?? "", "base64").includes(Buffer.from(hostPath)), hostPath).toBe(false);
  });

  it("a guest whose tree comes out different, or whose start commit does not hash to the id, stops with unpack_failed", async () => {
    const fx = fixtureRepo();
    const archive = await buildWorkspaceArchive(hostGit(), fx.mirror, fx.commit);
    const tampered = { ...archive, items: archive.items.map((i) => (i.path === "README.md" ? { ...i, oid: "d".repeat(40) } : i)) };
    const a = localGuest();
    await expect(sendWorkspace(a.guest, tampered, a.paths)).rejects.toMatchObject({ code: "unpack_failed" });
    const other = fixtureRepo((dir) => writeFileSync(path.join(dir, "other.txt"), "o\n"));
    const b = localGuest();
    await expect(sendWorkspace(b.guest, { ...archive, commitText: Buffer.from(git(other.repo, "cat-file", "commit", other.commit) + "\n") }, b.paths)).rejects.toBeInstanceOf(GuestWorkspaceError);
    expect(existsSync(path.join(b.paths.stage, "base"))).toBe(false);
  });

  it("a stale workspace of an earlier run is replaced, not merged into", async () => {
    const fx = fixtureRepo();
    const archive = await buildWorkspaceArchive(hostGit(), fx.mirror, fx.commit);
    const g = localGuest();
    mkdirSync(g.paths.workspace, { recursive: true });
    writeFileSync(path.join(g.paths.workspace, "leftover.txt"), "old\n");
    await sendWorkspace(g.guest, archive, g.paths);
    expect(existsSync(path.join(g.paths.workspace, "leftover.txt"))).toBe(false);
  });
});
