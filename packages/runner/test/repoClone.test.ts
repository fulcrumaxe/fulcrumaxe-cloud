import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLONE_EXIT_TOO_LARGE, CLONE_PINNED_SCRIPT, CLONE_SCRIPT, MAX_CLONE_KB, PREVIEW_WORKDIR, buildCloneCommand } from "../src/repoClone.js";
import { overlapsAgentConfigDir } from "../src/agentConfig.js";

/** D#2 PREVIEW-RUNNER-EVENTS: the clone command is built safely, and the script it runs does what it says on a real shell. */
describe("buildCloneCommand", () => {
  it("is a fixed script plus an argument array: the values are separate arguments, never part of the shell text", () => {
    const { cmd, args } = buildCloneCommand({ owner: "acme", name: "widgets.js" }, PREVIEW_WORKDIR);
    expect(cmd).toBe("sh");
    expect(args).toEqual(["-c", CLONE_SCRIPT, "fx-clone", "https://github.com/acme/widgets.js.git", PREVIEW_WORKDIR, String(MAX_CLONE_KB)]);
    // The script is the same text for every repository: nothing from the values is inside it.
    expect(buildCloneCommand({ owner: "other", name: "thing" }, "/srv/w").args[1]).toBe(args[1]);
    expect(CLONE_SCRIPT).not.toMatch(/acme|widgets|github\.com|\/vercel/);
  });

  it("carries no credential: no token, user, header or auth option", () => {
    const wire = JSON.stringify(buildCloneCommand({ owner: "acme", name: "w" }, PREVIEW_WORKDIR));
    expect(wire).not.toMatch(/token|@github|Authorization|extraheader|credential|password/i);
  });

  it("is shallow, single-branch (the default branch), and writes links as plain files", () => {
    expect(CLONE_SCRIPT).toContain("clone --depth 1 --single-branch --no-tags");
    expect(CLONE_SCRIPT).toContain("core.symlinks=false");
    expect(CLONE_SCRIPT).not.toMatch(/--branch|-b /);
  });

  it("refuses a repository name or directory that is not plain, so nothing reaches a shell", () => {
    for (const bad of ["a; rm -rf /", "$(id)", "`id`", "a b", "a\nb", "a/b", "a'b", 'a"b', "", "..", ".", "a".repeat(101), "a|b", "a&b", "a>b", "ünï"]) {
      expect(() => buildCloneCommand({ owner: bad, name: "ok" }, PREVIEW_WORKDIR), `owner ${bad}`).toThrow();
      expect(() => buildCloneCommand({ owner: "ok", name: bad }, PREVIEW_WORKDIR), `name ${bad}`).toThrow();
    }
    for (const bad of ["", "relative/dir", "/", "/a/../b", "/a/./b", "/a b", "/a;b", "/a$(id)", "/a\nb", "//a", "/a//b", "/a/"]) {
      expect(() => buildCloneCommand({ owner: "ok", name: "ok" }, bad), `dir ${bad}`).toThrow();
    }
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => buildCloneCommand({ owner: "ok", name: "ok" }, PREVIEW_WORKDIR, bad)).toThrow();
  });

  it("a pinned commit uses the pinned script with the sha as its own argument; no sha keeps the default-branch command byte for byte", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const { cmd, args } = buildCloneCommand({ owner: "acme", name: "widgets", sha }, PREVIEW_WORKDIR);
    expect(cmd).toBe("sh");
    expect(args).toEqual(["-c", CLONE_PINNED_SCRIPT, "fx-clone", "https://github.com/acme/widgets.git", PREVIEW_WORKDIR, String(MAX_CLONE_KB), sha]);
    expect(CLONE_PINNED_SCRIPT).not.toMatch(/acme|widgets|github\.com|\/vercel|[0-9a-f]{40}/);
    expect(CLONE_PINNED_SCRIPT).toContain("fetch --depth 1 --no-tags");
    expect(CLONE_PINNED_SCRIPT).toContain("core.symlinks=false");
    expect(CLONE_PINNED_SCRIPT).toContain("config core.symlinks false");
    expect(buildCloneCommand({ owner: "acme", name: "widgets" }, PREVIEW_WORKDIR).args).toEqual(["-c", CLONE_SCRIPT, "fx-clone", "https://github.com/acme/widgets.git", PREVIEW_WORKDIR, String(MAX_CLONE_KB)]);
    for (const bad of ["", "HEAD", "main", "0123456", sha.toUpperCase(), `${sha}0`, `${sha.slice(1)};`, "$(id)"]) {
      expect(() => buildCloneCommand({ owner: "acme", name: "widgets", sha: bad }, PREVIEW_WORKDIR), `sha ${bad}`).toThrow();
    }
  });

  it("the fixed directory is allowed as a run workdir", () => {
    expect(overlapsAgentConfigDir(PREVIEW_WORKDIR)).toBe(false);
  });
});

describe("the clone script on a real shell (local repository standing in for the proxy)", () => {
  let base: string;
  let origin: string;
  let first: string;
  let tip: string;
  const run = (url: string, dir: string, limitKb: number) => spawnSync("sh", ["-c", CLONE_SCRIPT, "fx-clone", url, dir, String(limitKb)], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60_000 });
  const pinned = (url: string, dir: string, limitKb: number, sha: string) =>
    spawnSync("sh", ["-c", CLONE_PINNED_SCRIPT, "fx-clone", url, dir, String(limitKb), sha], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60_000 });
  const head = (dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), "fx-clone-"));
    origin = path.join(base, "origin");
    mkdirSync(origin);
    const git = (...a: string[]) => execFileSync("git", ["-C", origin, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "pipe" });
    git("init", "-q", "-b", "trunk");
    writeFileSync(path.join(origin, "README.md"), "hello\n");
    // A committed link out of the tree: the clone must write it as a plain file holding the link text.
    symlinkSync("../../etc/passwd", path.join(origin, "up"));
    git("add", "README.md", "up");
    git("commit", "-q", "-m", "one");
    first = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    git("checkout", "-q", "-b", "side");
    writeFileSync(path.join(origin, "side.txt"), "side\n");
    git("add", "side.txt");
    git("commit", "-q", "-m", "two");
    git("checkout", "-q", "trunk"); // the default branch is where HEAD points
    writeFileSync(path.join(origin, "big.bin"), Buffer.alloc(600 * 1024, 7));
    git("add", "big.bin");
    git("commit", "-q", "-m", "three");
    tip = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("clones the default branch only, shallow, into the directory, and exits 0", () => {
    const dir = path.join(base, "ok");
    const r = run(`file://${origin}`, dir, MAX_CLONE_KB);
    expect(r.status).toBe(0);
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(path.join(dir, "side.txt"))).toBe(false); // the other branch is not there
    const count = execFileSync("git", ["-C", dir, "rev-list", "--count", "--all"], { encoding: "utf8" }).trim();
    expect(count).toBe("1"); // depth 1
  });

  it("a committed symlink arrives as a regular file, in the default-branch clone and in the pinned one", () => {
    for (const [dir, r] of [
      [path.join(base, "links"), (d: string) => run(`file://${origin}`, d, MAX_CLONE_KB)],
      [path.join(base, "links-pinned"), (d: string) => pinned(`file://${origin}`, d, MAX_CLONE_KB, first)],
    ] as const) {
      expect(r(dir).status).toBe(0);
      const st = lstatSync(path.join(dir, "up"));
      expect(st.isSymbolicLink()).toBe(false);
      expect(st.isFile()).toBe(true);
      expect(readFileSync(path.join(dir, "up"), "utf8")).toBe("../../etc/passwd");
    }
  });

  it("pinned: checks out exactly the pinned commit (not the branch tip), shallow, and HEAD is that commit", () => {
    const dir = path.join(base, "pinned");
    const r = pinned(`file://${origin}`, dir, MAX_CLONE_KB, first);
    expect(r.status).toBe(0);
    expect(head(dir)).toBe(first);
    expect(first).not.toBe(tip);
    expect(existsSync(path.join(dir, "big.bin"))).toBe(false); // the tip's file is not in the pinned tree
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("hello\n");
    expect(execFileSync("git", ["-C", dir, "rev-list", "--count", "--all"], { encoding: "utf8" }).trim()).toBe("1");
    // A second pinned clone into the same checkout (Build again) replaces it.
    expect(pinned(`file://${origin}`, dir, MAX_CLONE_KB, tip).status).toBe(0);
    expect(head(dir)).toBe(tip);
  });

  it("pinned: a commit the remote does not have fails the clone (non-zero, not the size exit), and no checkout is left to read", () => {
    const dir = path.join(base, "pinned-missing");
    const r = pinned(`file://${origin}`, dir, MAX_CLONE_KB, "f".repeat(40));
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(CLONE_EXIT_TOO_LARGE);
    expect(existsSync(path.join(dir, "README.md"))).toBe(false);
  });

  it("pinned: over the size limit exits with the size code and leaves no directory behind", () => {
    const dir = path.join(base, "pinned-big");
    expect(pinned(`file://${origin}`, dir, 100, tip).status).toBe(CLONE_EXIT_TOO_LARGE);
    expect(existsSync(dir)).toBe(false);
  });

  it("a leftover CHECKOUT from an earlier attempt (Build again, in the executor's persistent sandbox) is replaced by a fresh clone", () => {
    const dir = path.join(base, "again");
    expect(run(`file://${origin}`, dir, MAX_CLONE_KB).status).toBe(0);
    writeFileSync(path.join(dir, "stale.txt"), "left by the failed attempt\n");
    const r = run(`file://${origin}`, dir, MAX_CLONE_KB);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(dir, "stale.txt"))).toBe(false);
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("hello\n");
  });

  it("a directory that is NOT a checkout is never removed: the clone fails as it always did and the files stay", () => {
    const dir = path.join(base, "precious");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "mine.txt"), "keep\n");
    const r = run(`file://${origin}`, dir, MAX_CLONE_KB);
    expect(r.status).not.toBe(0);
    expect(readFileSync(path.join(dir, "mine.txt"), "utf8")).toBe("keep\n");
  });

  it("a clone that fails exits non-zero and is not the size exit", () => {
    const r = run(`file://${path.join(base, "does-not-exist")}`, path.join(base, "gone"), MAX_CLONE_KB);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(CLONE_EXIT_TOO_LARGE);
  });

  it("a repository over the size limit exits with the size code and leaves no directory behind", () => {
    const dir = path.join(base, "big");
    const r = run(`file://${origin}`, dir, 100); // 100 KiB limit; the checkout alone is over 600 KiB
    expect(r.status).toBe(CLONE_EXIT_TOO_LARGE);
    expect(existsSync(dir)).toBe(false);
  });

  it("values are only ever data: shell syntax in the url or the directory is never run", () => {
    const marker = path.join(base, "PWNED");
    run(`file://${origin}; touch ${marker}`, path.join(base, "x"), MAX_CLONE_KB);
    run(`file://${origin}`, path.join(base, `y$(touch ${marker})`), MAX_CLONE_KB);
    run("$(touch " + marker + ")", path.join(base, "z"), MAX_CLONE_KB);
    expect(existsSync(marker)).toBe(false);
  });
});
