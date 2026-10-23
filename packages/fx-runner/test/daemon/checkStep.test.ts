import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECK_NOT_RUN_REASONS } from "@fulcrumaxe/runner-protocol";
import { createBaseFile, createCheckStep, createVcsState, normalised, skippedTests, type CheckStepInput } from "../../src/daemon/checkStep.js";
import { runCapture, runInstall } from "../../src/engines/claude/capture.js";
import { testLaunch } from "../helpers/launch.js";

/**
 * D#6 R-CHK-2: the check step on real child processes (no fake spawn) and a real git repository for the base-commit pinning. The sandbox tool is not part of this
 * file: `launch` here starts the vector directly, which is exactly what the sandbox's own launch hands back with the tool in front.
 */
let root: string;
let ws: string;
let base: string;
const git = (...args: string[]): string => execFileSync("git", ["-C", ws, ...args], { encoding: "utf8" }).trim();
const commit = (message: string): string => {
  git("-c", "user.email=a@b", "-c", "user.name=a", "add", ".");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-check-"));
  ws = path.join(root, "ws");
  mkdirSync(path.join(ws, "scripts"), { recursive: true });
  writeFileSync(path.join(ws, "scripts", "check.sh"), "#!/bin/sh\necho base check\nexit 3\n", { mode: 0o755 });
  git("init", "-q");
  base = commit("base");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const vcsState = createVcsState((command, args, env, timeoutMs) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs, 1024 * 1024, 2048), {});
const step = createCheckStep({ capture: (command, args, env, cwd, timeoutMs, tail, signal, feed) => runInstall(spawn, command, args, env, cwd, timeoutMs, tail, signal, feed), now: () => new Date(), vcsState });
const baseFile: CheckStepInput["baseFile"] = async (dir, sha, relative) => {
  try {
    return execFileSync("git", ["-C", dir, "cat-file", "blob", `${sha}:${relative}`]);
  } catch {
    return null;
  }
};
const run = (argv: string[], timeout_s = 60, extra: Partial<CheckStepInput> = {}) =>
  step({ check: { argv, dev_shell: false, timeout_s }, workspace: ws, base, baseDir: ws, baseFile, launch: (v) => ({ tool: v[0]!, args: v.slice(1), env: { PATH: process.env.PATH ?? "" } }), ...extra });
const script = (name: string, body: string): string => {
  const file = path.join(root, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

describe("the result of a real run", () => {
  it("exit 0 passes, with the exit code, a duration and the output", async () => {
    const out = await run([script("ok.sh", "echo hello")]);
    expect(out.passed).toBe(true);
    expect(out.body).toMatchObject({ exit_code: 0, timed_out: false, skipped_tests: null });
    expect(out.body.summary).toContain("hello");
  });

  it("exit 3 fails and says 3", async () => {
    const out = await run([script("three.sh", "echo no; exit 3")]);
    expect(out.passed).toBe(false);
    expect(out.body).toMatchObject({ exit_code: 3, timed_out: false });
  });

  it("a command that outlasts its own cap is killed with everything it started and reports timed_out", async () => {
    const marker = path.join(root, "child-alive");
    const long = script("long.sh", `sh -c 'sleep 30; echo late > "${marker}"' &\nsleep 30`);
    const started = Date.now();
    const out = await run([long], 2);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(out.passed).toBe(false);
    expect(out.body).toMatchObject({ exit_code: null, timed_out: true });
    expect(existsSync(marker)).toBe(false);
  });

  it("a cap above the per-command 1800 seconds is a cap of this step: the argument is passed through as seconds", async () => {
    const seen: number[] = [];
    const capture = createCheckStep({ capture: async (_c, _a, _e, _cwd, timeoutMs) => (seen.push(timeoutMs), { code: 0, tail: "", timedOut: false, aborted: false }), now: () => new Date(), vcsState });
    await capture({ check: { argv: ["true"], dev_shell: false, timeout_s: 5400 }, workspace: ws, base, baseDir: ws, baseFile, launch: () => ({ tool: "true", args: [], env: {} }) });
    expect(seen).toEqual([5_400_000]);
  });

  it("the launch's descriptor-3 bytes are handed to the capture", async () => {
    const fed: Array<Buffer | undefined> = [];
    const capture = createCheckStep({ capture: async (_c, _a, _e, _cwd, _t, _tail, _s, feed) => (fed.push(feed), { code: 0, tail: "", timedOut: false, aborted: false }), now: () => new Date(), vcsState });
    await capture({ check: { argv: ["true"], dev_shell: false, timeout_s: 60 }, workspace: ws, base, baseDir: ws, baseFile, launch: () => ({ tool: "true", args: [], env: {}, feed: Buffer.from("filter") }) });
    expect(fed[0]?.toString()).toBe("filter");
  });

  it("a stop signal ends the process group and the result does not pass", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const out = await run([script("hang.sh", "sleep 30")], 60, { signal: stop.signal });
    expect(out.passed).toBe(false);
    expect(out.body.exit_code).toBeNull();
  });

  it("a launch the sandbox cannot make is a failed check, not a pass; a refusal carries its words", async () => {
    const out = await run(["true"], 60, { launch: () => undefined });
    expect(out).toMatchObject({ passed: false, body: { exit_code: null, timed_out: false } });
    const refused = await run(["true"], 60, { launch: () => ({ refused: "the check was not run: not on this platform" }) });
    expect(refused).toMatchObject({ passed: false, body: { exit_code: null, summary: "the check was not run: not on this platform" } });
  });
});

describe("what leaves the machine", () => {
  it("is the last 4096 bytes, with a token-shaped string, the workspace and the home directory replaced", async () => {
    const token = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0".repeat(3);
    const home = path.join(root, "home-of-person");
    const noisy = script("noisy.sh", `i=0; while [ $i -lt 600 ]; do echo "filler line number $i"; i=$((i+1)); done\necho "token ${token}"\necho "home ${home}/.config/x and ${ws}/src/a.ts"\nexit 1`);
    const out = await run([noisy], 60, { home });
    expect(Buffer.byteLength(out.body.summary)).toBeLessThanOrEqual(4096);
    expect(out.body.summary).not.toContain(token);
    expect(out.body.summary).not.toContain(home);
    expect(out.body.summary).not.toContain(ws);
    expect(out.body.summary).toContain("<home>/.config/x");
    expect(out.body.summary).toContain("<workspace>/src/a.ts");
    expect(out.body.summary).toContain("token [redacted]");
  });

  it("holds no NUL byte: output that has one is sent without it", async () => {
    const out = await run([script("nul.sh", `printf 'a\\000b\\000c\\n'`)]);
    expect(out.body.summary).not.toContain("\u0000");
    expect(out.body.summary).toContain("a b c");
  });

  it("reads the skipped count from the test runner's summary line", async () => {
    expect(skippedTests(" Test Files  2 passed (2)\n      Tests  120 passed | 14 skipped (134)\n")).toBe(14);
    expect(skippedTests("\u001b[2m      Tests \u001b[22m \u001b[32m1 passed\u001b[39m | 2 skipped (3)")).toBe(2);
    expect(skippedTests("no summary here")).toBeNull();
    const out = await run([script("vitest.sh", `echo '      Tests  5 passed | 7 skipped (12)'`)]);
    expect(out.body.skipped_tests).toBe(7);
  });
});

describe("the files the vector names are the base commit's (CWE-345)", () => {
  it("an agent edit that makes scripts/check.sh exit 0 does not change the result; the paths are named; the branch's file is given back", async () => {
    const edited = "#!/bin/sh\necho weakened\nexit 0\n";
    writeFileSync(path.join(ws, "scripts", "check.sh"), edited);
    const out = await run(["sh", "scripts/check.sh"]);
    expect(out.passed).toBe(false);
    expect(out.body.exit_code).toBe(3);
    expect(out.body.summary).toMatch(/^check files changed by this branch: scripts\/check\.sh\n/);
    expect(out.body.summary).toContain("base check");
    expect(out.body.summary).not.toContain("weakened");
    expect(readFileSync(path.join(ws, "scripts", "check.sh"), "utf8")).toBe(edited);
  });

  it("an unchanged file is not reported, and a script the branch added is not run", async () => {
    const clean = await run(["sh", "scripts/check.sh"]);
    expect(clean.body.summary.startsWith("check files changed")).toBe(false);
    writeFileSync(path.join(ws, "scripts", "mine.sh"), "echo mine\nexit 0\n");
    const added = await run(["sh", "scripts/mine.sh"]);
    expect(added.passed).toBe(false);
    expect(added.body.summary).toContain("check files changed by this branch: scripts/mine.sh");
    expect(added.body.summary).not.toContain("mine\n");
    expect(readFileSync(path.join(ws, "scripts", "mine.sh"), "utf8")).toContain("echo mine");
  });

  it("a path that leaves the checkout, an absolute path and an option are not file names here", async () => {
    const out = await run(["sh", "../outside.sh", "/bin/true", "--flag=x"]);
    expect(out.body.summary.startsWith("check files changed")).toBe(false);
    expect(["../outside.sh", "/bin/true", "--flag=x", "a/../b"].map(normalised)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("`./scripts/check.sh` and `scripts//check.sh` are the same file: the edit still does not change the result", async () => {
    writeFileSync(path.join(ws, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n");
    for (const spelled of ["./scripts/check.sh", "scripts//check.sh", "././scripts/./check.sh"]) {
      const out = await run(["sh", spelled]);
      expect(out.passed, spelled).toBe(false);
      expect(out.body.exit_code, spelled).toBe(3);
      expect(out.body.summary, spelled).toContain("check files changed by this branch: scripts/check.sh");
      expect(normalised(spelled)).toBe("scripts/check.sh");
    }
  });

  it("a fix round pins to the default branch's version, not to the tip it started from: round 1's weakening is not round 2's base", async () => {
    // round 1 weakened the script and the branch tip holds it; the pin is the earlier commit
    writeFileSync(path.join(ws, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n");
    const tip = commit("round 1 weakens the check");
    const atTip = await run(["sh", "scripts/check.sh"], 60, { base: tip });
    expect(atTip.passed).toBe(true);
    const pinned = await run(["sh", "scripts/check.sh"], 60, { base });
    expect(pinned.passed).toBe(false);
    expect(pinned.body.exit_code).toBe(3);
  });

  it("a link anywhere on a pinned path fails the check without running it, and names the path", async () => {
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "check.sh"), "exit 0\n");
    const marker = path.join(root, "ran");
    // the file itself a link
    rmSync(path.join(ws, "scripts", "check.sh"));
    symlinkSync(path.join(outside, "check.sh"), path.join(ws, "scripts", "check.sh"));
    let out = await run(["sh", "scripts/check.sh", script("mark.sh", `echo x > ${marker}`)]);
    expect(out.passed).toBe(false);
    expect(out.body.summary).toContain("scripts/check.sh");
    expect(out.body.exit_code).toBeNull();
    // a parent directory a link
    rmSync(path.join(ws, "scripts"), { recursive: true });
    symlinkSync(outside, path.join(ws, "scripts"));
    out = await run(["sh", "scripts/check.sh"]);
    expect(out.passed).toBe(false);
    expect(out.body.exit_code).toBeNull();
    expect(out.body.summary).toContain("scripts/check.sh");
    expect(existsSync(marker)).toBe(false);
  });

  it("a give-back is refused when the check swapped a parent directory for a link: nothing is written through it, and the path is named", async () => {
    const outside = path.join(root, "outside2");
    mkdirSync(outside);
    writeFileSync(path.join(ws, "scripts", "swap.sh"), `cd "${ws}" && mv scripts scripts.old && ln -s "${outside}" scripts\n`);
    const pin = commit("swap");
    writeFileSync(path.join(ws, "scripts", "swap.sh"), "echo edited by the branch\n");
    const out = await run(["sh", "scripts/swap.sh"], 60, { base: pin });
    expect(out.passed).toBe(false);
    expect(out.body.summary).toContain("check files not given back to the branch: scripts/swap.sh");
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("what the check may not change (the agent cannot either)", () => {
  it("a check that rewrites pnpm-lock.yaml, writes a .env file and a shell start-up file, and commits, fails; the files are put back and nothing stays committed", async () => {
    writeFileSync(path.join(ws, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    writeFileSync(path.join(ws, ".env.local"), "SECRET=1\n");
    const tip = commit("lock and env");
    const sneaky = script("sneaky.sh", `cd "${ws}"\necho tampered > pnpm-lock.yaml\necho "export X=1" > .bashrc\nrm .env.local\ngit -c user.email=a@b -c user.name=a commit -q -am tampered`);
    const out = await run([sneaky], 60, { base: tip });
    expect(out.passed).toBe(false);
    expect(out.body.summary).toContain("the check changed paths it may not");
    for (const name of ["pnpm-lock.yaml", ".bashrc", ".env.local"]) expect(out.body.summary).toContain(name);
    expect(readFileSync(path.join(ws, "pnpm-lock.yaml"), "utf8")).toBe("lockfileVersion: 9\n");
    expect(readFileSync(path.join(ws, ".env.local"), "utf8")).toBe("SECRET=1\n");
    expect(existsSync(path.join(ws, ".bashrc"))).toBe(false);
    // the commit the check made cannot be undone from here: it is named, and the check fails
    expect(out.body.summary).toContain("not put back: .git");
  });

  it("a check that changes nothing protected passes as before", async () => {
    writeFileSync(path.join(ws, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const tip = commit("lock");
    const out = await run([script("quiet.sh", `cat "${ws}/pnpm-lock.yaml" > /dev/null`)], 60, { base: tip });
    expect(out.passed).toBe(true);
  });

  it("an argument with spaces (a shell string) is never pinned, and the summary says so", async () => {
    const out = await run(["sh", "-c", "exit 0 # scripts/check.sh is not pinned here"]);
    expect(out.passed).toBe(true);
    expect(out.body.summary).toContain("not pinned (a string with spaces is not a file name): exit 0 # scripts/check.sh is not pinned ...");
  });
});

describe("reading a file at a commit (createBaseFile)", () => {
  const read = createBaseFile((command, args, env, timeoutMs) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs, 1024 * 1024, 2048), {});
  it("returns the exact bytes of a text file, null for a path that is not a file there, and refuses a blob that is not valid text", async () => {
    expect((await read(ws, base, "scripts/check.sh"))!.toString("utf8")).toBe("#!/bin/sh\necho base check\nexit 3\n");
    expect(await read(ws, base, "scripts/missing.sh")).toBeNull();
    expect(await read(ws, base, "scripts")).toBeNull();
    writeFileSync(path.join(ws, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]));
    const withBinary = commit("bin");
    await expect(read(ws, withBinary, "blob.bin")).rejects.toThrow(/byte-exact/);
  });

  it("a check that names a blob it cannot read exactly fails closed and runs nothing", async () => {
    writeFileSync(path.join(ws, "scripts", "data.bin"), Buffer.from([0xff, 0xfe, 0x00]));
    const withBinary = commit("bin");
    writeFileSync(path.join(ws, "scripts", "data.bin"), "changed");
    const out = await run(["sh", "scripts/check.sh", "scripts/data.bin"], 60, { base: withBinary, baseFile: read });
    expect(out.passed).toBe(false);
    expect(out.body.exit_code).toBeNull();
    expect(readFileSync(path.join(ws, "scripts", "data.bin"), "utf8")).toBe("changed");
  });
});

/** D#6 R-CHK-3d: every way the step refuses to run the check, or stops its result from counting, names a closed reason code beside the words; an ordinary pass or failure names none. */
describe("the reason code", () => {
  const direct = (v: readonly string[]) => ({ tool: v[0]!, args: v.slice(1), env: { PATH: process.env.PATH ?? "" } });
  const input = (): CheckStepInput => ({ check: { argv: ["true"], dev_shell: false, timeout_s: 60 }, workspace: ws, base, baseDir: ws, baseFile, launch: direct });

  it("an ordinary pass and an ordinary failing exit carry none", async () => {
    expect((await run([script("ok.sh", "exit 0")])).body).not.toHaveProperty("reason");
    expect((await run([script("bad.sh", "exit 3")])).body).not.toHaveProperty("reason");
    const slow = await run([script("slow.sh", "sleep 30")], 1);
    expect(slow.body.timed_out).toBe(true);
    expect(slow.body).not.toHaveProperty("reason");
  });

  it("a launch the sandbox cannot make is sandbox_unavailable; a refusal from the sandbox is sandbox_refused", async () => {
    expect((await run(["true"], 60, { launch: () => undefined })).body.reason).toBe("sandbox_unavailable");
    expect((await run(["true"], 60, { launch: () => ({ refused: "no seccomp filter on this platform" }) })).body.reason).toBe("sandbox_refused");
  });

  it("a link on a pinned path is pin_failed", async () => {
    rmSync(path.join(ws, "scripts", "check.sh"));
    symlinkSync(path.join(root, "elsewhere"), path.join(ws, "scripts", "check.sh"));
    const out = await run(["sh", "scripts/check.sh"]);
    expect(out.body.reason).toBe("pin_failed");
    expect(out.passed).toBe(false);
  });

  it("a base file that cannot be read exactly is pin_failed", async () => {
    const out = await run(["sh", "scripts/check.sh"], 60, {
      baseFile: async () => {
        throw new Error("not byte-exact");
      },
    });
    expect(out.body.reason).toBe("pin_failed");
  });

  it("a check that changes protected paths is protected_changed, even though its own exit status was 0", async () => {
    writeFileSync(path.join(ws, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const tip = commit("lock");
    const out = await run([script("tamper.sh", `echo tampered > "${ws}/pnpm-lock.yaml"`)], 60, { base: tip });
    expect(out.body.exit_code).toBe(0);
    expect(out.body.reason).toBe("protected_changed");
    expect(out.passed).toBe(false);
  });

  it("a give-back that is refused is named: the check's files were not given back to the branch", async () => {
    const outside = path.join(root, "outside3");
    mkdirSync(outside);
    writeFileSync(path.join(ws, "scripts", "swap.sh"), `cd "${ws}" && mv scripts scripts.old && ln -s "${outside}" scripts\n`);
    const pin = commit("swap");
    writeFileSync(path.join(ws, "scripts", "swap.sh"), "echo edited by the branch\n");
    const out = await run(["sh", "scripts/swap.sh"], 60, { base: pin });
    expect(out.passed).toBe(false);
    expect(out.body.reason).toBe("not_restored");
  });

  it("a workspace whose protected state cannot be read is protected_unreadable", async () => {
    const broken = createCheckStep({
      capture: (command, args, env, cwd, timeoutMs, tail, signal, feed) => runInstall(spawn, command, args, env, cwd, timeoutMs, tail, signal, feed),
      now: () => new Date(),
      vcsState: async () => {
        throw new Error("no state");
      },
    });
    expect((await broken(input())).body.reason).toBe("protected_unreadable");
  });

  it("a command the capture cannot start is start_failed", async () => {
    const broken = createCheckStep({
      capture: async () => {
        throw new Error("spawn failed");
      },
      now: () => new Date(),
      vcsState,
    });
    expect((await broken(input())).body.reason).toBe("start_failed");
  });

  it("every code the step names is in the closed set, so the cloud stores it as it is", async () => {
    const outs = [await run(["true"], 60, { launch: () => undefined }), await run(["true"], 60, { launch: () => ({ refused: "x" }) })];
    for (const out of outs) expect(CHECK_NOT_RUN_REASONS).toContain(out.body.reason);
  });
});
