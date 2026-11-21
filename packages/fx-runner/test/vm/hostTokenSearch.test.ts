import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * D#587 3c-v: the root-on-host token search that a dispatched real-VM run calls through `sudo -n`. The script runs here as an ordinary user over directories of this test's own, so
 * what is pinned is its logic: the control, the verdicts, the exit codes, and that the token reaches grep on a pipe and appears in nothing it prints. (What it finds under the real
 * helper directories is the job of vmJob.real.test.ts.)
 */
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "helpers/hostTokenSearch.sh");
const hasGrep = spawnSync("grep", ["-V"]).status === 0;

describe.skipIf(!hasGrep)("the host token search script", () => {
  let root: string;
  let token: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "fxr-hts-"));
    token = `sk-ant-oat01-${randomBytes(24).toString("hex")}`;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 2 });
  });

  const run = (input: string, dirs: string[]) => spawnSync("bash", [SCRIPT, ...dirs], { input, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
  const dirWith = (name: string, files: Record<string, string | Buffer>): string => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    }
    return dir;
  };

  it("says clean, with the control found and each directory's file count, when no file holds the token", () => {
    const a = dirWith("a", { "one.txt": "nothing here", "deep/two.bin": Buffer.from([0, 1, 2, 3]) });
    const b = dirWith("b", { "three.txt": "also nothing" });
    const out = run(`${token}\n`, [a, b]);
    expect(out.status).toBe(0);
    expect(out.stdout.split("\n")).toEqual(["control=found", `dir=${a} files=2`, `dir=${b} files=1`, "result=clean", ""]);
  });

  it("finds the token inside a binary file (a disk image is binary) and names the file, exit 1", () => {
    const a = dirWith("a", { "disk.img": Buffer.concat([randomBytes(4096), Buffer.from(token), randomBytes(4096)]), "clean.txt": "x" });
    const out = run(`${token}\n`, [a]);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain(`hit=${path.join(a, "disk.img")}\n`);
    expect(out.stdout.match(/^hit=/gm)).toHaveLength(1);
    expect(out.stdout.trimEnd().endsWith("result=found")).toBe(true);
  });

  it("does not follow a link out of the directory, and does not read a file that only holds half the token", () => {
    const outside = dirWith("outside", { "has.txt": token });
    const a = dirWith("a", { "half.txt": token.slice(0, token.length - 4) });
    symlinkSync(outside, path.join(a, "link"));
    const out = run(`${token}\n`, [a]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("result=clean");
  });

  it("is not fooled by the token being a pattern: a token with regex characters matches only itself", () => {
    const odd = "a.b*c[d]e+f?g(h)i|j^k$l-0123456789";
    const a = dirWith("a", { "decoy.txt": "aXbbbcdeeffgghhiijjkkl-0123456789" });
    expect(run(`${odd}\n`, [a]).stdout).toContain("result=clean");
    const b = dirWith("b", { "real.txt": odd });
    expect(run(`${odd}\n`, [b]).status).toBe(1);
  });

  it("fails closed: no token, a short token, a missing directory and an unreadable one are errors, never clean", () => {
    const a = dirWith("a", { "one.txt": "x" });
    expect(run("", [a])).toMatchObject({ status: 2 });
    expect(run("short\n", [a])).toMatchObject({ status: 2 });
    const missing = run(`${token}\n`, [path.join(root, "nope")]);
    expect(missing.status).toBe(3);
    expect(missing.stdout).not.toContain("result=clean");
    const locked = dirWith("locked", { "f.txt": "x" });
    chmodSync(locked, 0o000);
    try {
      // a user who can read it anyway (root) cannot show this case
      if (process.geteuid?.() !== 0) {
        const out = run(`${token}\n`, [locked]);
        expect(out.status).toBe(3);
        expect(out.stdout).not.toContain("result=clean");
      }
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("never prints the token, in a verdict of any kind", () => {
    const hit = dirWith("hit", { "f.txt": `x${token}x` });
    const clean = dirWith("clean", { "f.txt": "x" });
    for (const dirs of [[hit], [clean], [path.join(root, "nope")]]) {
      const out = run(`${token}\n`, dirs);
      expect(out.stdout.includes(token) || out.stderr.includes(token)).toBe(false);
    }
  });
});
