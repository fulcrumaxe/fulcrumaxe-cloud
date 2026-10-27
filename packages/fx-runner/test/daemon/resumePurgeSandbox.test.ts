import { pinFixture } from "../helpers/pinFixture.js";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeChildCommand } from "../../src/commands/purgeChild.js";
import { runCli } from "../../src/cli.js";
import type { GitCaptured } from "../../src/daemon/git.js";
import { cleanResumedWorkspace } from "../../src/daemon/resumeClean.js";
import { createSandboxedPurge, parseCounts, purgeChildEnv, purgeProfile, SANDBOX_EXEC } from "../../src/daemon/resumePurgeSandbox.js";

let root: string;
let ws: string;
let outside: string;
let state: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "fxr-purgesb-")));
  ws = path.join(root, "ws");
  outside = path.join(root, "outside");
  state = path.join(root, "state");
  for (const dir of [ws, outside, state]) mkdirSync(dir);
  // The listing is read only from a git folder of the shape the sandbox leaves (`hostRead.ts`): a minimal one.
  for (const dir of ["refs", "objects"]) mkdirSync(path.join(ws, ".git", dir), { recursive: true });
  writeFileSync(path.join(ws, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(ws, ".git", "config"), "[core]\n\tbare = false\n");
  pinFixture(ws);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (base: string, rel: string, text = "x"): void => {
  mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  writeFileSync(path.join(base, rel), text);
};
const exists = (target: string): boolean => {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
};

describe("purgeProfile", () => {
  it("denies every write except /dev/null and the workspace subtree, and denies the network", () => {
    const profile = purgeProfile("/Users/me/.cache/fx/ws/job-1");
    expect(profile).toBe('(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null"))(allow file-write* (subpath "/Users/me/.cache/fx/ws/job-1"))(allow file-read* (subpath "/Users/me/.cache/fx/ws/job-1"))(deny file-write* (subpath "/Users/me/.cache/fx/ws/job-1/.git") (subpath "/Users/me/.cache/fx/ws/job-1/.claude"))');
    // The deny for the always-kept folders comes after the allow (the last matching rule wins).
    expect(profile.indexOf("(deny file-write* (subpath")).toBeGreaterThan(profile.indexOf('(allow file-write* (subpath'));
    // The only allow rule for writes besides /dev/null names the workspace; reads are not restricted.
    expect(profile.match(/\(allow file-write\*/g)).toHaveLength(2);
    expect(profile).not.toContain("deny file-read");
  });

  it("quotes a path with a quote or a backslash so it cannot widen the rule", () => {
    expect(purgeProfile('/w/a"b\\c')).toContain('(subpath "/w/a\\"b\\\\c")');
  });

  it("refuses a root that is relative, not normalised, or the filesystem root", () => {
    for (const bad of ["ws", "/a/../b", "/a/", "/"]) expect(() => purgeProfile(bad)).toThrow(TypeError);
  });
});

describe("createSandboxedPurge (the child protocol)", () => {
  type Call = { command: string; args: readonly string[]; env: Record<string, string>; list: string | undefined; listMode: number | undefined };
  const fake = (answer: (call: Call) => GitCaptured) => {
    const calls: Call[] = [];
    // A strict stand-in for the capture: the program is an absolute path, the sandbox flag comes first, the environment is only strings.
    const capture = async (command: string, args: readonly string[], env: Record<string, string>): Promise<GitCaptured> => {
      expect(path.isAbsolute(command)).toBe(true);
      expect(args[0]).toBe("-p");
      const list = args[args.indexOf("__purge") + 1];
      const call: Call = { command, args, env, list, listMode: list !== undefined && exists(list) ? lstatSync(list).mode & 0o777 : undefined };
      call.list = list !== undefined && exists(list) ? readFileSync(list, "utf8") : undefined;
      calls.push(call);
      return answer(call);
    };
    return { calls, capture };
  };

  it("starts the program itself under sandbox-exec with the profile, the list file and the root, and returns its two counts", async () => {
    const f = fake(() => ({ code: 0, stdout: "3 2\n", timedOut: false }));
    const purge = createSandboxedPurge({ capture: f.capture, selfCommand: ["/opt/fx/node", "/opt/fx/fx-runner.mjs"], stateDir: state, isFile: (target) => target === SANDBOX_EXEC });
    expect(await purge(ws, ["dist/", "a.log"])).toEqual({ files: 3, dirs: 2 });
    const call = f.calls[0]!;
    expect(call.command).toBe(SANDBOX_EXEC);
    expect(call.args.slice(0, 2)).toEqual(["-p", purgeProfile(ws)]);
    expect(call.args.slice(2, 4)).toEqual(["/opt/fx/node", "/opt/fx/fx-runner.mjs"]);
    expect(call.args[4]).toBe("__purge");
    expect(call.args[6]).toBe(ws);
    expect(call.list).toBe("dist/\0a.log"); // the list is read from a file, never put on the command line
    expect(call.listMode).toBe(0o600);
    expect(path.dirname(path.dirname(call.args[5]!))).toBe(path.join(state, "purge"));
    // The list file and its directory are gone afterwards.
    expect(existsSync(call.args[5]!)).toBe(false);
    expect(existsSync(path.dirname(call.args[5]!))).toBe(false);
  });

  it("fails closed without sandbox-exec: nothing is started", async () => {
    const f = fake(() => ({ code: 0, stdout: "1 1\n", timedOut: false }));
    const purge = createSandboxedPurge({ capture: f.capture, selfCommand: ["/opt/fx/fx-runner"], stateDir: state, isFile: () => false });
    expect(await purge(ws, ["dist/"])).toBeUndefined();
    expect(f.calls).toHaveLength(0);
    expect(existsSync(path.join(state, "purge"))).toBe(false);
  });

  it("fails closed with no own command to start", async () => {
    const f = fake(() => ({ code: 0, stdout: "1 1\n", timedOut: false }));
    const purge = createSandboxedPurge({ capture: f.capture, selfCommand: [], stateDir: state, isFile: () => true });
    expect(await purge(ws, ["dist/"])).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    ["a non-zero exit", { code: 65, stdout: "1 1\n", timedOut: false }],
    ["a killed child", { code: null, stdout: "", timedOut: false }],
    ["a timeout", { code: 0, stdout: "1 1\n", timedOut: true }],
    ["an answer that is not two counts", { code: 0, stdout: "removed 1 file", timedOut: false }],
    ["an empty answer", { code: 0, stdout: "", timedOut: false }],
  ] as const)("fails closed on %s, and still removes the list file", async (_name, result) => {
    const f = fake(() => ({ ...result }));
    const purge = createSandboxedPurge({ capture: f.capture, selfCommand: ["/opt/fx/fx-runner"], stateDir: state, isFile: () => true });
    expect(await purge(ws, ["dist/"])).toBeUndefined();
    const args = f.calls[0]!.args;
    expect(existsSync(path.dirname(args[args.indexOf("__purge") + 1]!))).toBe(false);
  });

  it("fails closed when the capture throws", async () => {
    const purge = createSandboxedPurge({ capture: () => Promise.reject(new Error("spawn failed")), selfCommand: ["/opt/fx/fx-runner"], stateDir: state, isFile: () => true });
    expect(await purge(ws, ["dist/"])).toBeUndefined();
  });

  it("parseCounts takes exactly two counts", () => {
    expect(parseCounts("0 0\n")).toEqual({ files: 0, dirs: 0 });
    for (const bad of ["", "1", "1 2 3", "-1 2", "a b", "1 2\nrm -rf /"]) expect(parseCounts(bad)).toBeUndefined();
  });
});

describe("cleanResumedWorkspace on darwin", () => {
  // The first call of a read is the config-key listing (`git config --list`); the second is the ignored-entries listing.
  const listing = (entries: string[]) => ({ run: async (_code: string, args: readonly string[]) => (args[0] === "config" ? "core.bare\nfalse\0" : `${entries.join("\0")}\0`) }) as never;

  it("hands the listed entries to the sandboxed purge and removes nothing itself", async () => {
    put(ws, "dist/a.js");
    const seen: Array<[string, readonly string[]]> = [];
    const lines: string[] = [];
    const counts = await cleanResumedWorkspace(listing(["dist/", "../escape", "/abs"]), ws, (line) => lines.push(line), 64 * 1024, "darwin", async (realRoot, entries) => {
      seen.push([realRoot, entries]);
      return { files: 1, dirs: 1 };
    });
    expect(seen).toEqual([[ws, ["dist/"]]]); // a path that leaves the root is not even handed on
    expect(counts).toEqual({ files: 1, dirs: 1 });
    expect(exists(path.join(ws, "dist/a.js"))).toBe(true);
    expect(lines).toEqual(["fx-runner: resumed workspace: removed 1 ignored files and 1 directories of build output"]);
  });

  it("logs one count-free line and removes nothing when the sandboxed purge did not complete", async () => {
    put(ws, "dist/a.js");
    const lines: string[] = [];
    const counts = await cleanResumedWorkspace(listing(["dist/"]), ws, (line) => lines.push(line), 64 * 1024, "darwin", async () => undefined);
    expect(counts).toEqual({ files: 0, dirs: 0 });
    expect(lines).toEqual(["fx-runner: resume clean-up under the macOS sandbox did not complete"]);
    expect(exists(path.join(ws, "dist/a.js"))).toBe(true);
  });

  it("is still skipped, with its one line, when there is no sandboxed purge", async () => {
    put(ws, "dist/a.js");
    const lines: string[] = [];
    await cleanResumedWorkspace(listing(["dist/"]), ws, (line) => lines.push(line), 64 * 1024, "darwin");
    expect(lines).toEqual(["fx-runner: resume clean-up skipped on macOS"]);
    expect(exists(path.join(ws, "dist/a.js"))).toBe(true);
  });
});

describe("the __purge child", () => {
  const run = (list: string, rootArg: string): { code: number; out: string } => {
    let out = "";
    const code = (() => {
      try {
        return purgeChildCommand(list, rootArg, { stateDir: state, out: (line) => (out += `${line}\n`), err: () => undefined, now: () => new Date(), fetchFn: fetch });
      } catch (error) {
        return (error as { exitCode?: number }).exitCode ?? -1;
      }
    })();
    return { code, out };
  };

  it("purges the listed entries with the same checks and prints the counts", () => {
    put(ws, "dist/a.js");
    put(ws, "dist/node_modules/p/i.js");
    put(ws, "keep.txt");
    put(outside, "victim");
    symlinkSync(outside, path.join(ws, "linked"));
    const list = path.join(state, "list");
    writeFileSync(list, ["dist/", "linked", "../outside/victim"].join("\0"), { mode: 0o600 });
    const { code, out } = run(list, ws);
    expect(code).toBe(0);
    expect(out).toBe("2 0\n"); // dist/a.js and the link itself; dist stays because node_modules is kept inside it
    expect(exists(path.join(ws, "dist/a.js"))).toBe(false);
    expect(exists(path.join(ws, "dist/node_modules/p/i.js"))).toBe(true);
    expect(exists(path.join(ws, "linked"))).toBe(false);
    expect(exists(path.join(outside, "victim"))).toBe(true);
    expect(exists(path.join(ws, "keep.txt"))).toBe(true);
  });

  it("does nothing when the root is a link to a workspace, relative, or missing, or the list is a link or missing", () => {
    put(ws, "dist/a.js");
    const list = path.join(state, "list");
    writeFileSync(list, "dist/", { mode: 0o600 });
    const link = path.join(root, "wslink");
    symlinkSync(ws, link);
    expect(run(list, link).code).toBe(1);
    expect(run(list, "ws").code).toBe(2);
    expect(run(list, path.join(root, "nope")).code).toBe(1);
    const listLink = path.join(state, "listlink");
    symlinkSync(list, listLink);
    expect(run(listLink, ws).code).toBe(1);
    expect(run(path.join(state, "nolist"), ws).code).toBe(1);
    expect(exists(path.join(ws, "dist/a.js"))).toBe(true);
  });

  it("refuses a list file that others can write", () => {
    put(ws, "dist/a.js");
    const list = path.join(state, "list");
    writeFileSync(list, "dist/", { mode: 0o666 });
    chmodSync(list, 0o666);
    expect(run(list, ws).code).toBe(1);
    expect(exists(path.join(ws, "dist/a.js"))).toBe(true);
  });

  it("runs from the parent's exact child environment, mapped onto the CLI's inputs the way bin/fx-runner.mjs does (no HOME)", async () => {
    put(ws, "dist/a.js");
    const list = path.join(state, "list");
    writeFileSync(list, "dist/", { mode: 0o600 });
    const env = purgeChildEnv(state);
    expect(Object.keys(env).sort()).toEqual(["FX_RUNNER_HOME", "LC_ALL"]);
    let out = "";
    let err = "";
    const code = await runCli({ argv: ["__purge", list, ws], home: env.HOME, stateDirOverride: env.FX_RUNNER_HOME, protectionBypassFile: env.FX_RUNNER_PROTECTION_BYPASS_FILE, platform: "darwin", xdgCacheHome: env.XDG_CACHE_HOME, stdout: (t) => (out += t), stderr: (t) => (err += t) });
    expect({ code, out, err }).toEqual({ code: 0, out: "1 1\n", err: "" });
    expect(exists(path.join(ws, "dist"))).toBe(false);
  });

  it("is reachable as the hidden __purge command and not as any other word", async () => {
    put(ws, "dist/a.js");
    const list = path.join(state, "list");
    writeFileSync(list, "dist/", { mode: 0o600 });
    let out = "";
    const code = await runCli({ argv: ["__purge", list, ws], home: root, stateDirOverride: state, stdout: (text) => (out += text), stderr: () => undefined });
    expect(code).toBe(0);
    expect(out).toBe("1 1\n");
    expect(exists(path.join(ws, "dist"))).toBe(false);
  });
});

// Real Seatbelt: macOS only. CI is Linux, so this is skipped there; the Team Lead runs it on a Mac session.
describe.skipIf(process.platform !== "darwin")("real sandbox-exec (macOS)", () => {
  it("does not follow a directory swapped for a link out of the workspace: the target outside survives", () => {
    put(outside, "victim", "keep me");
    symlinkSync(outside, path.join(ws, "dist")); // what a surviving process of the previous run could have swapped in
    // A stand-in child that does exactly what an unchecked purge would do for the entry `dist/victim`: unlink through the swapped directory.
    const script = path.join(state, "unlink.mjs");
    writeFileSync(script, `import { unlinkSync } from "node:fs";\ntry { unlinkSync(process.argv[2]); console.log("unlinked"); } catch (error) { console.log(error.code); }\n`);
    const target = path.join(ws, "dist", "victim");
    const run = (profile: string | undefined): string => execFileSync(profile === undefined ? process.execPath : SANDBOX_EXEC, profile === undefined ? [script, target] : ["-p", profile, process.execPath, script, target], { encoding: "utf8" }).trim();
    // Control: unconfined, the same call deletes the file outside the workspace (so the test can tell the profile is what saves it).
    put(outside, "control", "x");
    expect(execFileSync(process.execPath, [script, path.join(ws, "dist", "control")], { encoding: "utf8" }).trim()).toBe("unlinked");
    expect(existsSync(path.join(outside, "control"))).toBe(false);
    expect(run(purgeProfile(ws))).toBe("EPERM");
    expect(readFileSync(path.join(outside, "victim"), "utf8")).toBe("keep me");
  });

  it("still removes a real file below the workspace under the same profile", () => {
    put(ws, "build/out.js");
    const script = path.join(state, "unlink2.mjs");
    writeFileSync(script, `import { unlinkSync } from "node:fs";\nunlinkSync(process.argv[2]);\n`);
    execFileSync(SANDBOX_EXEC, ["-p", purgeProfile(ws), process.execPath, script, path.join(ws, "build", "out.js")]);
    expect(existsSync(path.join(ws, "build/out.js"))).toBe(false);
  });
});
