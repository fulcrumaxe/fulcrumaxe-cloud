/**
 * D#845 MC-8b: the sign-in runner against a real util-linux `script` (a real pty and a real process group) with a strict fake of the CLI in place of the CLI itself. The fake is a shell script that
 * accepts only the argument vector and environment the real command would be given, prints the spike's fixture, reads one line from the pty, and echoes it as a pty does. The real CLI is never run here:
 * its own test is `claudeLogin.real.test.ts`, which runs only when the owner asks for it. Without `script` on the machine this file is skipped by name.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MachineLoginReport } from "@fulcrumaxe/runner-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_CLI_NAME, CLAUDE_LOGIN_ARGS, createClaudeLoginRunner, killLoginTree, loginArgsFor, readProcessTable, CLAUDE_LOGIN_LIMIT_MS, type ClaudeLoginHost, type LoginChild } from "../../src/daemon/claudeLogin.js";
import { findOnPath } from "../helpers/findOnPath.js";

// The search path the child gets: only where `script` and the shell are, never the host's own PATH, so the real CLI on this machine can never be found by it.
const script = findOnPath("script", ["/run/current-system/sw/bin", "/usr/bin", "/bin"].join(path.delimiter));
const rm = findOnPath("rm", ["/run/current-system/sw/bin", "/usr/bin", "/bin"].join(path.delimiter));
const sleep = findOnPath("sleep", ["/run/current-system/sw/bin", "/usr/bin", "/bin"].join(path.delimiter));
// The child's whole search path: a private tools directory holding links to `script`, `rm` and `sleep` and nothing else. The host's PATH and /bin are not on it, so a real CLI, `gh` or a git credential helper can never be found by the child.
// The stand-in's name is neutral on purpose: the model-call guard refuses a child whose file or arguments name the real CLI, and this file never runs it.
const FAKE_CLI = "fake-model-cli";
const search = (): string => path.join(dir, "tools");
/** Before anything is spawned: the real CLI, `gh` and every git credential helper are unreachable on the private path (the one CLI there is the fake, put first by the runner). */
function assertPrivatePath(): void {
  const entries = [path.join(dir, "bin"), ...search().split(path.delimiter)];
  for (const name of ["gh", "git"]) expect(findOnPath(name, search())).toBeUndefined();
  expect(findOnPath("claude", search())).toBeUndefined();
  expect(findOnPath(FAKE_CLI, search())).toBeUndefined();
  expect(findOnPath("claude", entries.join(path.delimiter))).toBeUndefined();
  expect(findOnPath(FAKE_CLI, entries.join(path.delimiter))).toBe(path.join(dir, "bin", FAKE_CLI));
  for (const entry of entries) expect(existsSync(entry) ? readdirSync(entry).filter((n) => n.startsWith("git-credential-")) : []).toEqual([]);
}
const procRead = {
  pids: (): number[] => readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n)).map(Number),
  stat: (pid: number): string | undefined => {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return undefined;
    }
  },
};
/** Alive means there is a process that is not a zombie (a killed child waits to be reaped as `Z`). */
const alive = (pid: number): boolean => {
  const text = procRead.stat(pid);
  return text !== undefined && text.slice(text.lastIndexOf(")") + 2, text.lastIndexOf(")") + 3) !== "Z";
};
const killPorts = {
  ...readProcessTable(procRead),
  signal: (target: number, sig: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(target, sig);
    } catch {
      // already gone
    }
  },
  after: (ms: number, fn: () => void): void => void setTimeout(fn, ms),
};
const URL_LINE = "https://claude.com/cai/oauth/authorize?code=REDACTED&client_id=REDACTED&response_type=REDACTED&redirect_uri=REDACTED&scope=REDACTED&code_challenge=REDACTED&code_challenge_method=REDACTED&state=REDACTED";
const REQ = "11111111-1111-4111-8111-111111111111";
const GOOD = "good-code-0123456789-ABCDEF";

/** The strict fake. It exits 64 when it is called in a way the real command would not be. */
const FAKE = `#!/bin/sh
if [ "$1 $2 $3" = "auth logout " ]; then
  rm -f "$HOME/signed-in"
  exit 0
fi
[ "$1 $2 $3" = "auth login --claudeai" ] && [ "$#" = 3 ] || { echo "bad argv" >&2; exit 64; }
[ -z "\${BROWSER+x}\${DISPLAY+x}\${ANTHROPIC_API_KEY+x}\${CLAUDE_CODE_OAUTH_TOKEN+x}" ] || { echo "bad env" >&2; exit 64; }
printf 'Opening browser to sign in\\342\\200\\246\\n'
printf "If the browser didn't open, visit: ${URL_LINE}\\n"
printf 'Paste code here if prompted > '
while read -r line; do
  if [ "$line" = "${GOOD}" ]; then
    : > "$HOME/signed-in"
    printf 'Login successful.\\n'
    exit 0
  fi
  printf 'Invalid code. Please make sure the full code was copied.\\n'
  printf 'Paste code here if prompted > '
done
exit 1
`;

let dir: string;
let reports: MachineLoginReport[];
let taken: string[];
let nextCode = GOOD;
const live: LoginChild[] = [];

function host(): ClaudeLoginHost {
  return {
    locateClaude: () => path.join(dir, "bin", FAKE_CLI),
    cliName: FAKE_CLI,
    env: () => ({ HOME: dir, PATH: search(), TERM: "xterm" }),
    launch: (spec) => {
      const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdin.on("error", () => undefined);
      const exits: Array<(c: number | null) => void> = [];
      let done = false;
      const end = (c: number | null): void => {
        if (done) return;
        done = true;
        for (const cb of exits) cb(c);
      };
      child.on("error", () => end(null));
      child.on("close", (c) => end(c));
      const handle: LoginChild = {
        write: (t) => void child.stdin.write(t),
        onOutput: (cb) => {
          child.stdout.on("data", cb);
          child.stderr.on("data", cb);
        },
        onExit: (cb) => void exits.push(cb),
        kill: () => {
          if (child.pid !== undefined) killLoginTree(killPorts, child.pid);
        },
      };
      live.push(handle);
      return handle;
    },
  };
}

let timers: Array<{ ms: number; fn: () => void; live: boolean }>;
/** A runner whose timers are held: `fire(ms)` runs one, so a ten-minute limit does not take ten minutes. */
function manualRunner() {
  return createClaudeLoginRunner({
    host: host(),
    platform: "linux",
    stateDir: dir,
    uid: process.getuid?.(),
    managed: () => true,
    log: () => undefined,
    after: (ms, fn) => {
      const t = { ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    cloud: {
      report: async (_id, report) => (reports.push(report), { kind: "recorded" }),
      takeCode: async () => (taken.push("take"), { kind: "code", code: nextCode }),
    },
  });
}
const fire = (ms: number): void => {
  for (const t of timers) if (t.live && t.ms === ms) {
    t.live = false;
    t.fn();
  }
};

function runner() {
  return createClaudeLoginRunner({
    host: host(),
    platform: "linux",
    stateDir: dir,
    uid: process.getuid?.(),
    managed: () => true,
    log: () => undefined,
    after: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    cloud: {
      report: async (_id, report) => (reports.push(report), { kind: "recorded" }),
      takeCode: async () => (taken.push("take"), { kind: "code", code: nextCode }),
    },
  });
}
const until = async (cond: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-fake-cli-pty-"));
  mkdirSync(path.join(dir, "bin"));
  mkdirSync(path.join(dir, "tools"));
  if (script !== undefined) symlinkSync(script, path.join(dir, "tools", "script"));
  if (rm !== undefined) symlinkSync(rm, path.join(dir, "tools", "rm"));
  if (sleep !== undefined) symlinkSync(sleep, path.join(dir, "tools", "sleep"));
  timers = [];
  writeFileSync(path.join(dir, "bin", FAKE_CLI), FAKE);
  chmodSync(path.join(dir, "bin", FAKE_CLI), 0o755);
  reports = [];
  taken = [];
  nextCode = GOOD;
});
afterEach(() => {
  for (const c of live.splice(0)) c.kill();
  // Whatever a stubborn stand-in left behind goes now, by the pids it wrote down, so no test leaves a process running.
  for (const name of ["cli.pid", "child.pid"]) {
    try {
      const pid = Number(readFileSync(path.join(dir, name), "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGKILL");
    } catch {
      // no such file, or the process is already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(script === undefined || rm === undefined || sleep === undefined || process.platform !== "linux")("the sign-in through a real pty and a real process group", () => {
  it("the child's search path is private: no real CLI, gh or git credential helper can be reached", () => {
    assertPrivatePath();
  });

  it("production wiring still runs the CLI by its own name; only a test-given name changes the command string (nothing is spawned)", () => {
    expect(CLAUDE_CLI_NAME).toBe("claude");
    expect(loginArgsFor()).toEqual(CLAUDE_LOGIN_ARGS);
    expect(CLAUDE_LOGIN_ARGS[3]).toBe("claude auth login --claudeai");
    expect(loginArgsFor(FAKE_CLI)[3]).toBe(`${FAKE_CLI} auth login --claudeai`);
  });

  it("reports the link from the real pty output, writes the code, sees the success and reports done", async () => {
    const r = runner();
    expect(await r.start(REQ)).toEqual({ ok: true });
    expect(reports).toEqual([{ state: "awaiting_code", auth_url: URL_LINE }]);
    expect(await r.code(REQ)).toEqual({ ok: true });
    await until(() => reports.length === 2);
    expect(reports[1]).toEqual({ state: "done" });
    expect(existsSync(path.join(dir, "signed-in"))).toBe(true);
    // the pty echoed the code; the log holds what came before it and not the code
    const logs = readdirSync(path.join(dir, "login")).map((f) => readFileSync(path.join(dir, "login", f), "utf8")).join("\n");
    expect(logs).toContain(URL_LINE);
    expect(logs).not.toContain(GOOD);
    expect(JSON.stringify(reports)).not.toContain(GOOD);
  });

  it("a wrong code is reported as invalid_code", async () => {
    nextCode = "junk-code-0000";
    const r = runner();
    await r.start(REQ);
    await r.code(REQ);
    await until(() => reports.length === 2);
    expect(reports[1]).toEqual({ state: "failed", failure_code: "invalid_code" });
    expect(existsSync(path.join(dir, "signed-in"))).toBe(false);
  });

  it("sign-out runs the fake's own sign-out and reports applied", async () => {
    writeFileSync(path.join(dir, "signed-in"), "");
    const r = runner();
    expect(await r.logout()).toEqual({ ok: true });
    expect(existsSync(path.join(dir, "signed-in"))).toBe(false);
  });

  it("a CLI that is not there fails the start as start_failed or no_link, reported, never hung", async () => {
    rmSync(path.join(dir, "bin", FAKE_CLI));
    // No CLI of any name is on the child's private path (the stand-in's directory is not on it, and the real one is nowhere), or this could start one.
    expect(findOnPath(FAKE_CLI, `${path.join(dir, "bin")}:${search()}`)).toBeUndefined();
    expect(findOnPath("claude", `${path.join(dir, "bin")}:${search()}`)).toBeUndefined();
    const r = runner();
    expect(await r.start(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(reports.at(-1)).toMatchObject({ state: "failed" });
  });
});

/** A stand-in that ignores the hang-up (and, if `ignore` says so, the terminate signal too), writes its own pid and its helper's, prints the link, and then answers every line with a refusal for ever. */
const stubborn = (ignore: string): string => `#!/bin/sh
trap '' ${ignore}
echo $$ > "$HOME/cli.pid"
sleep 300 &
echo $! > "$HOME/child.pid"
printf "If the browser didn't open, visit: ${URL_LINE}\\n"
printf 'Paste code here if prompted > '
while :; do
  if read -r line; then
    printf 'Invalid code. Please make sure the full code was copied.\\n'
  else
    sleep 1
  fi
done
`;
const pidOf = (name: string): number => Number(readFileSync(path.join(dir, name), "utf8").trim());
const written = (name: string): boolean => existsSync(path.join(dir, name)) && readFileSync(path.join(dir, name), "utf8").trim() !== "";

describe.skipIf(script === undefined || rm === undefined || sleep === undefined || process.platform !== "linux")("a CLI that will not hang up is ended, with everything it started", () => {
  const cases: Array<[string, string]> = [
    ["ignores the hang-up", "HUP"],
    ["ignores the hang-up and the terminate signal", "HUP TERM"],
  ];
  for (const [what, ignore] of cases) {
    it(`a stand-in that ${what} is dead, with its helper, after the ten-minute limit`, async () => {
      writeFileSync(path.join(dir, "bin", FAKE_CLI), stubborn(ignore));
      assertPrivatePath();
      const r = manualRunner();
      expect(await r.start(REQ)).toEqual({ ok: true });
      await until(() => written("cli.pid") && written("child.pid"));
      const [cli, helper] = [pidOf("cli.pid"), pidOf("child.pid")];
      expect(alive(cli) && alive(helper)).toBe(true);
      fire(CLAUDE_LOGIN_LIMIT_MS);
      await until(() => reports.some((x) => x.state === "failed" && x.failure_code === "timeout"));
      await until(() => !alive(cli) && !alive(helper), 10_000);
      expect([alive(cli), alive(helper)]).toEqual([false, false]);
    });

    it(`a stand-in that ${what} is dead, with its helper, once the sign-in has finished`, async () => {
      writeFileSync(path.join(dir, "bin", FAKE_CLI), stubborn(ignore));
      assertPrivatePath();
      const r = manualRunner();
      expect(await r.start(REQ)).toEqual({ ok: true });
      await until(() => written("cli.pid") && written("child.pid"));
      const [cli, helper] = [pidOf("cli.pid"), pidOf("child.pid")];
      nextCode = "junk-code-0000";
      expect(await r.code(REQ)).toEqual({ ok: true });
      await until(() => reports.some((x) => x.state === "failed" && x.failure_code === "invalid_code"));
      await until(() => !alive(cli) && !alive(helper), 10_000);
      expect([alive(cli), alive(helper)]).toEqual([false, false]);
    });
  }

  it("a sign-out that never ends is dead after its minute, with what it started", async () => {
    writeFileSync(path.join(dir, "bin", FAKE_CLI), `#!/bin/sh\ntrap '' HUP\necho $$ > "$HOME/cli.pid"\nsleep 300 &\necho $! > "$HOME/child.pid"\nwhile :; do sleep 1; done\n`);
    assertPrivatePath();
    const r = manualRunner();
    const out = r.logout();
    await until(() => written("cli.pid") && written("child.pid"));
    const [cli, helper] = [pidOf("cli.pid"), pidOf("child.pid")];
    fire(60_000);
    expect(await out).toEqual({ ok: false, refusal: "failed" });
    await until(() => !alive(cli) && !alive(helper), 10_000);
  });
});
