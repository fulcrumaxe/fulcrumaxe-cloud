import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchCommand } from "../../src/commands/watchPane.js";
import { runCli } from "../../src/cli.js";
import { stateDirFor } from "../../src/config.js";
import type { GitCapture } from "../../src/daemon/git.js";
import { createJobWatch, TAKEOVER_POLL_MS } from "../../src/daemon/watch.js";
import { createRunLog } from "../../src/engines/claude/stream.js";
import { cleanEnv, SUBSCRIPTION_TOKEN_VAR } from "../../src/job/cleanEnv.js";
import { SandboxGrantRefused, sandboxSettings } from "../../src/sandbox/sandboxSettings.js";
import { MAX_LOG_LINE_BYTES, readLogFrom, removeEntry, clearTakeover, ensurePrivateDir, markTakeoverReady, readEntries, requestTakeover, sessionName, shortId, socketIsPrivate, socketPath, takeoverState, tmuxDir, writeEntry } from "../../src/watch/layout.js";
import { attachArgs, findTmux, startWatch, statusLine, tmuxEnv, type TmuxConfig } from "../../src/watch/tmux.js";
import { manualClock } from "../helpers/manualClock.js";
import { itNeedsHostSockets } from "../helpers/needsHostSockets.js";

const RUN = "3f6c1a52-8d0e-4b7a-9c14-0a5e6d2b7f38";
let root: string;
let stateDir: string;
const servers: net.Server[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-w-"));
  stateDir = path.join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
});
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** Records every tmux call. `fail` makes the calls whose arguments contain the word exit 1. */
function fakeTmux(fail?: string) {
  const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const capture: GitCapture = async (command, args, env) => {
    calls.push({ command, args: [...args], env: { ...env } });
    return { code: fail !== undefined && args.includes(fail) ? 1 : 0, stdout: "", timedOut: false };
  };
  const cfg: TmuxConfig = { binary: "/bin/tmux", stateDir, capture, env: tmuxEnv({ home: "/home/jane", path: "/usr/bin", stateDir, term: "xterm" }), selfCommand: ["node", "fx-runner.mjs"] };
  return { calls, cfg };
}

const listen = (file: string): Promise<void> =>
  new Promise((resolve) => {
    const server = net.createServer();
    servers.push(server);
    server.listen(file, resolve);
  });

describe("the tmux socket directory and socket", () => {
  it("the directory is made 0700 whatever the umask, and a loose one is tightened", () => {
    const old = process.umask(0);
    try {
      ensurePrivateDir(tmuxDir(stateDir));
    } finally {
      process.umask(old);
    }
    expect((lstatSync(tmuxDir(stateDir)).mode & 0o777).toString(8)).toBe("700");
    chmodSync(tmuxDir(stateDir), 0o755);
    ensurePrivateDir(tmuxDir(stateDir));
    expect((lstatSync(tmuxDir(stateDir)).mode & 0o777).toString(8)).toBe("700");
  });

  it("a link or a file where the directory belongs is refused, never followed", () => {
    const target = path.join(root, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, tmuxDir(stateDir));
    expect(() => ensurePrivateDir(tmuxDir(stateDir))).toThrow();
    writeFileSync(path.join(stateDir, "watch"), "");
    expect(() => ensurePrivateDir(path.join(stateDir, "watch"))).toThrow();
  });

  it("starting a watch makes the directory 0700 and puts the socket inside it", async () => {
    const t = fakeTmux();
    expect(await startWatch(t.cfg, { runId: RUN, role: "executor", repo: "acme/app" })).toBe(true);
    expect((lstatSync(tmuxDir(stateDir)).mode & 0o777).toString(8)).toBe("700");
    expect(t.calls[0]!.args.slice(0, 2)).toEqual(["-S", socketPath(stateDir)]);
    expect(path.dirname(socketPath(stateDir))).toBe(tmuxDir(stateDir));
  });

  itNeedsHostSockets("only a real socket with mode 0600 in a 0700 directory counts as private", async () => {
    expect(socketIsPrivate(stateDir)).toBe(false);
    ensurePrivateDir(tmuxDir(stateDir));
    await listen(socketPath(stateDir));
    chmodSync(socketPath(stateDir), 0o600);
    expect(lstatSync(socketPath(stateDir)).isSocket()).toBe(true);
    expect((lstatSync(socketPath(stateDir)).mode & 0o777).toString(8)).toBe("600");
    expect(socketIsPrivate(stateDir)).toBe(true);
    chmodSync(socketPath(stateDir), 0o660);
    expect(socketIsPrivate(stateDir)).toBe(false);
    chmodSync(socketPath(stateDir), 0o600);
    chmodSync(tmuxDir(stateDir), 0o750);
    expect(socketIsPrivate(stateDir)).toBe(false);
  });

  it("a plain file named like the socket is not a socket", () => {
    ensurePrivateDir(tmuxDir(stateDir));
    writeFileSync(socketPath(stateDir), "", { mode: 0o600 });
    expect(socketIsPrivate(stateDir)).toBe(false);
  });
});

describe("the socket directory is on the sandbox deny list", () => {
  const base = { workspace: "/home/jane/work/run-1", tempDir: "/tmp/fx-run-1", home: "/home/jane", stateDir: "/home/jane/.fx-runner", binaryDir: "/home/jane/.local/bin", workspaceRoot: "/home/jane/work", tempRoot: "/tmp" };

  it("denies both read and write of the directory, so the agent cannot send keys into its own session", () => {
    const block = sandboxSettings(base) as { filesystem: { denyRead: string[]; denyWrite: string[] } };
    const dir = tmuxDir(base.stateDir);
    const covers = (list: string[]): boolean => list.some((entry) => dir === entry || dir.startsWith(`${entry}${path.sep}`));
    expect(covers(block.filesystem.denyRead)).toBe(true);
    expect(covers(block.filesystem.denyWrite)).toBe(true);
    expect(covers((sandboxSettings(base) as { filesystem: { allowRead: string[] } }).filesystem.allowRead)).toBe(false);
  });

  it("no grant can reopen the socket directory or the watch records", () => {
    for (const grant of [tmuxDir(base.stateDir), path.join(base.stateDir, "watch")]) {
      expect(() => sandboxSettings({ ...base, extraReadPaths: [grant] }), grant).toThrow(SandboxGrantRefused);
      expect(() => sandboxSettings({ ...base, extraWritePaths: [grant] }), grant).toThrow(SandboxGrantRefused);
    }
  });
});

describe("no credential reaches tmux (S6)", () => {
  // Built at run time from parts, so no token-shaped literal sits in this file.
  const oauth = ["sk", "ant", "oat01", "fakefakefake"].join("-");
  const apiKey = ["sk", "ant", "api03", "fakefakefake"].join("-");

  it("the tmux environment is five names (the state directory among them), and the host's token variables are not among them", () => {
    vi.stubEnv(SUBSCRIPTION_TOKEN_VAR, oauth);
    vi.stubEnv("ANTHROPIC_API_KEY", apiKey);
    vi.stubEnv("TMUX", "/tmp/tmux-1000/default,1,0");
    const env = tmuxEnv({ home: "/home/jane", path: cleanEnv({ mode: "subscription" }).PATH ?? "", stateDir });
    expect(Object.keys(env).sort()).toEqual(["FX_RUNNER_HOME", "HOME", "LANG", "PATH", "TERM"]);
    expect(JSON.stringify(env)).not.toContain(oauth);
    expect(JSON.stringify(env)).not.toContain(apiKey);
  });

  it("a TERM that is not a plain terminal name is replaced", () => {
    expect(tmuxEnv({ home: "/h", path: "/p", stateDir: "/s", term: "xterm-256color" }).TERM).toBe("xterm-256color");
    expect(tmuxEnv({ home: "/h", path: "/p", stateDir: "/s", term: "x;rm -rf" }).TERM).toBe("xterm-256color");
  });

  it("no tmux call, argument or environment holds a credential, while the host has them set", async () => {
    vi.stubEnv(SUBSCRIPTION_TOKEN_VAR, oauth);
    vi.stubEnv("ANTHROPIC_API_KEY", apiKey);
    const t = fakeTmux();
    const clock = manualClock();
    const watch = createJobWatch({ tmux: t.cfg, clock });
    const watched = (await watch.begin({ runId: RUN, role: "executor", repo: "acme/app", started: clock.now() }))!;
    await watched.handOver();
    await watched.finish();
    expect(t.calls.length).toBeGreaterThan(2);
    const everything = JSON.stringify(t.calls) + JSON.stringify(readEntries(stateDir));
    expect(everything).not.toContain(oauth);
    expect(everything).not.toContain(apiKey);
  });

  it("what the pane shows (the transcript, scrubbed when it was written) holds no credential", async () => {
    const log = createRunLog(path.join(stateDir, "logs"), RUN, [oauth]);
    log.write("stdout", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `my token is ${oauth}` }] } }));
    const shown: string[] = [];
    await watchCommand(new Map([["run", RUN]]), { stateDir, out: (l) => shown.push(l), err: () => undefined, now: () => new Date(), fetchFn: fetch }, async () => undefined);
    expect(shown.join("\n")).toContain("my token is");
    expect(shown.join("\n")).not.toContain(oauth);
  });
});

describe("the tmux calls", () => {
  it("one session named for the short run id, whose single pane runs the watch; no credential-bearing option", async () => {
    const t = fakeTmux();
    await startWatch(t.cfg, { runId: RUN, role: "code-reviewer", repo: "acme/app" });
    const [create, length, left] = t.calls.map((c) => c.args);
    expect(create).toEqual(["-S", socketPath(stateDir), "new-session", "-d", "-s", `fx-${shortId(RUN)}`, "-x", "200", "-y", "50", "node", "fx-runner.mjs", "__watch", RUN]);
    expect(sessionName(RUN)).toBe("fx-3f6c1a52");
    expect(length).toContain("status-left-length");
    expect(left![left!.length - 1]).toBe(`Watching code-reviewer on acme/app. Detach: Ctrl-b d. To take over: fx-runner attach 3f6c1a52 --take-over`);
    expect(statusLine("r", "o/n", RUN)).toBe("Watching r on o/n. Detach: Ctrl-b d. To take over: fx-runner attach 3f6c1a52 --take-over");
  });

  it("read-only attach is `attach-session -r`; the take-over attach is not", () => {
    const readOnly = attachArgs(stateDir, RUN, true);
    expect(readOnly).toEqual(["-S", socketPath(stateDir), "attach-session", "-r", "-t", `=fx-${shortId(RUN)}`]);
    expect(attachArgs(stateDir, RUN, false)).not.toContain("-r");
  });

  it("tmux is looked for only in absolute search path directories", () => {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "tmux"), "#!/bin/sh\n");
    expect(findTmux(`relative:${bin}`)).toBeUndefined();
    chmodSync(path.join(bin, "tmux"), 0o755);
    expect(findTmux(`relative:${bin}`)).toBe(path.join(bin, "tmux"));
  });
});

describe("the daemon's watch of one job", () => {
  const job = (clock: ReturnType<typeof manualClock>) => ({ runId: RUN, role: "executor", repo: "acme/app", started: clock.now() });

  it("records the job, lists it, and removes it and the session when the job ends", async () => {
    const t = fakeTmux();
    const clock = manualClock();
    const watched = (await createJobWatch({ tmux: t.cfg, clock }).begin(job(clock)))!;
    expect(readEntries(stateDir)).toEqual([{ run_id: RUN, role: "executor", repo: "acme/app", started: clock.now().toISOString() }]);
    await watched.finish();
    expect(readEntries(stateDir)).toEqual([]);
    expect(t.calls.at(-1)!.args).toEqual(["-S", socketPath(stateDir), "kill-session", "-t", `=fx-${shortId(RUN)}`]);
  });

  it("a tmux that will not start means no watch and no record, and the job is unaffected", async () => {
    const t = fakeTmux("new-session");
    const clock = manualClock();
    expect(await createJobWatch({ tmux: t.cfg, clock }).begin(job(clock))).toBeUndefined();
    expect(readEntries(stateDir)).toEqual([]);
  });

  it("a take-over request is seen once, within a poll, and only the request file raises it", async () => {
    const t = fakeTmux();
    const clock = manualClock();
    const watched = (await createJobWatch({ tmux: t.cfg, clock }).begin(job(clock)))!;
    const asked = vi.fn();
    watched.onTakeOver(asked);
    await clock.advance(5 * TAKEOVER_POLL_MS, TAKEOVER_POLL_MS);
    expect(asked).not.toHaveBeenCalled();
    expect(requestTakeover(stateDir, RUN)).toBe(true);
    expect(requestTakeover(stateDir, RUN)).toBe(false);
    await clock.advance(3 * TAKEOVER_POLL_MS, TAKEOVER_POLL_MS);
    expect(asked).toHaveBeenCalledTimes(1);
    await watched.finish();
  });

  it("handing over swaps the pane to the take-over command, tells attach it may go ahead, and leaves the session to the person", async () => {
    const t = fakeTmux();
    const clock = manualClock();
    const watched = (await createJobWatch({ tmux: t.cfg, clock }).begin(job(clock)))!;
    requestTakeover(stateDir, RUN);
    expect(takeoverState(stateDir, RUN)).toBe("requested");
    expect(await watched.handOver()).toBe(true);
    expect(t.calls.at(-1)!.args).toEqual(["-S", socketPath(stateDir), "respawn-pane", "-k", "-t", `fx-${shortId(RUN)}`, "node", "fx-runner.mjs", "__takeover", RUN]);
    expect(takeoverState(stateDir, RUN)).toBe("ready");
    await watched.finish();
    expect(t.calls.some((c) => c.args.includes("kill-session"))).toBe(false);
    expect(readEntries(stateDir)).toEqual([expect.objectContaining({ run_id: RUN, taken_over: true })]);
  });

  it("a pane that cannot be swapped is not announced as ready, and the session is then ended with the job", async () => {
    const t = fakeTmux("respawn-pane");
    const clock = manualClock();
    const watched = (await createJobWatch({ tmux: t.cfg, clock }).begin(job(clock)))!;
    requestTakeover(stateDir, RUN);
    expect(await watched.handOver()).toBe(false);
    expect(takeoverState(stateDir, RUN)).toBe("requested");
    await watched.finish();
    expect(t.calls.at(-1)!.args).toContain("kill-session");
    expect(takeoverState(stateDir, RUN)).toBe("none");
  });

  it("the request file helpers: none, requested, ready, cleared", () => {
    expect(takeoverState(stateDir, RUN)).toBe("none");
    requestTakeover(stateDir, RUN);
    expect(takeoverState(stateDir, RUN)).toBe("requested");
    markTakeoverReady(stateDir, RUN);
    expect(takeoverState(stateDir, RUN)).toBe("ready");
    expect((lstatSync(path.join(stateDir, "watch", `${RUN}.takeover`)).mode & 0o777).toString(8)).toBe("600");
    clearTakeover(stateDir, RUN);
    expect(takeoverState(stateDir, RUN)).toBe("none");
  });

  it("a run id that is not a uuid never becomes a path", () => {
    expect(() => requestTakeover(stateDir, "../../etc/passwd")).toThrow();
    expect(() => writeEntry(stateDir, { run_id: "x/../y", role: "r", repo: "o/n", started: "t" })).toThrow();
    expect(existsSync(path.join(stateDir, "watch", "..", "..", "etc"))).toBe(false);
  });
});

describe("the pane under a state directory override", () => {
  it("is told the daemon's state directory, so it reads the same job record and log as the daemon", async () => {
    const env = tmuxEnv({ home: path.join(root, "home"), path: "/usr/bin", stateDir });
    expect(stateDirFor(env.HOME, env.FX_RUNNER_HOME)).toBe(stateDir);
    expect(stateDir).not.toBe(path.join(env.HOME!, ".fx-runner"));
    writeEntry(stateDir, { run_id: RUN, role: "executor", repo: "acme/app", started: "2026-10-08T10:00:00.000Z" });
    const log = createRunLog(path.join(stateDir, "logs"), RUN, []);
    log.write("stderr", "from the daemon's directory");
    // What the pane does: the command line with the environment tmux gave it. The record is there, so it keeps watching; the log is the daemon's.
    let out = "";
    const pane = runCli({ argv: ["__watch", RUN], home: env.HOME, stateDirOverride: env.FX_RUNNER_HOME, stdout: (t) => (out += t), stderr: () => undefined, host: {} as never });
    for (let i = 0; i < 100 && !out.includes("from the daemon's directory"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(out).toContain("stderr: from the daemon's directory");
    expect(out).not.toContain("The job has ended");
    removeEntry(stateDir, RUN);
    expect(await pane).toBe(0);
  });

  it("without it, the same pane would look in the home directory and find no job (what the override broke)", () => {
    const env = tmuxEnv({ home: path.join(root, "home"), path: "/usr/bin", stateDir });
    expect(stateDirFor(env.HOME, undefined)).toBe(path.join(root, "home", ".fx-runner"));
  });
});

describe("readLogFrom", () => {
  const write = (text: string): string => {
    const file = path.join(root, "log.jsonl");
    writeFileSync(file, text);
    return file;
  };

  it("a line longer than the read chunk is read whole, and the one after it follows", () => {
    const file = write(`a\n${"x".repeat(300 * 1024)}\nafter\n`);
    const seen: string[] = [];
    let offset = 0;
    for (let i = 0; i < 5; i++) {
      const { text, next } = readLogFrom(file, offset);
      if (next === offset) break;
      seen.push(...text.split("\n").filter(Boolean).map((l) => l.slice(0, 5)));
      offset = next;
    }
    expect(seen).toEqual(["a", "xxxxx", "after"]);
  });

  it("a line past the cap is skipped with a visible marker and the offset always advances", () => {
    const file = write(`a\n${"x".repeat(600 * 1024)}\nafter\n`);
    let offset = 0;
    const out: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { text, next } = readLogFrom(file, offset, 300 * 1024);
      if (next === offset) break;
      expect(next).toBeGreaterThan(offset);
      out.push(text);
      offset = next;
    }
    expect(out.join("")).toContain("over 4 MiB was skipped");
    expect(out.join("")).toContain("after");
    expect(MAX_LOG_LINE_BYTES).toBeGreaterThan(4 * 1024 * 1024);
  });

  it("a partial last line waits for its newline", () => {
    const file = write("a\npart");
    expect(readLogFrom(file, 0)).toEqual({ text: "a\n", next: 2 });
    expect(readLogFrom(file, 2)).toEqual({ text: "", next: 2 });
  });
});

describe("socketIsPrivate and the user id", () => {
  itNeedsHostSockets("a socket whose owner is not the given user is not private", async () => {
    ensurePrivateDir(tmuxDir(stateDir));
    await listen(socketPath(stateDir));
    chmodSync(socketPath(stateDir), 0o600);
    expect(socketIsPrivate(stateDir, process.getuid!())).toBe(true);
    expect(socketIsPrivate(stateDir, process.getuid!() + 1)).toBe(false);
  });
});
