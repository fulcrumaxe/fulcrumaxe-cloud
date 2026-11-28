/**
 * D#845 ON-19c: the GitHub sign-in runner against a real util-linux `script` (a real pty and process group) with a strict fake of `gh` in place of the CLI. The fake accepts only the argument vector and environment
 * the real command is given, then prints the spike's transcript. The child's whole search path is a private directory holding `script`, `sleep` and the fake: the real `gh`, the real model CLI and every git credential
 * helper are asserted unreachable before anything is spawned. The real `gh` is never run here. Without `script` on the machine this file is skipped by name.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GH_DEVICE_URL, type GhLoginReport } from "@fulcrumaxe/runner-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killLoginTree, readProcessTable, type ClaudeLoginHost, type LoginChild } from "../../src/daemon/claudeLogin.js";
import { createGhLoginRunner } from "../../src/daemon/ghLogin.js";
import { findOnPath } from "../helpers/findOnPath.js";

const SYSTEM = ["/run/current-system/sw/bin", "/usr/bin", "/bin"].join(path.delimiter);
const script = findOnPath("script", SYSTEM);
const sleepBin = findOnPath("sleep", SYSTEM);
const REQ = "33333333-3333-4333-8333-333333333333";
const CODE = "AB12-CD34";
const TOKEN = ["gho", "16C7e42F292c6912E7710c838347Ae178B4a"].join("_");

/** Strict: exits 64 when called in a way the real command would not be. The printed text is the spike's, with the code swapped; a token-shaped line follows, as it would after a real sign-in. */
const FAKE = `#!/bin/sh
if [ "$1 $2 $3 $4" = "auth logout --hostname github.com" ] && [ "$#" = 4 ]; then
  [ "$GH_PROMPT_DISABLED" = 1 ] || exit 64
  exit 0
fi
if [ "$*" = "auth token --hostname github.com" ]; then
  [ "$GH_PROMPT_DISABLED" = 1 ] || exit 64
  [ -f "$HOME/signed-in" ] && exit 0
  exit 1
fi
[ "$1 $2" = "auth status" ] && exit 1
[ "$*" = "auth login --hostname github.com --web --skip-ssh-key" ] || { echo "bad argv" >&2; exit 64; }
[ -z "\${BROWSER+x}\${DISPLAY+x}\${GH_TOKEN+x}\${GITHUB_TOKEN+x}" ] && [ "$GH_PROMPT_DISABLED" = 1 ] || { echo "bad env" >&2; exit 64; }
printf '\\r\\n\\033[0;31m!\\033[0m Failed to copy one-time code to clipboard\\r\\n'
printf '\\033[0;33m!\\033[0m First copy your one-time code: \\033[0;1;39m${CODE}\\033[0m\\r\\n'
printf '\\033[0;1;39mOpen this URL\\033[0m to continue in your web browser: ${GH_DEVICE_URL}\\r\\n'
sleep 1
printf '${TOKEN}\\r\\n'
[ -f "$HOME/fail" ] && exit 1
exit 0
`;

let dir: string;
let reports: GhLoginReport[];
let specs: Array<{ args: string[]; ignoreStdio?: boolean | undefined }> = [];
const live: LoginChild[] = [];
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
const search = (): string => path.join(dir, "tools");
function host(): ClaudeLoginHost {
  return {
    locateClaude: () => undefined,
    locateGh: () => path.join(dir, "bin", "gh"),
    env: () => ({ HOME: dir, PATH: search(), TERM: "xterm" }),
    launch: (spec) => {
      specs.push(spec);
      const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: spec.ignoreStdio === true ? ["ignore", "ignore", "ignore"] : ["pipe", "pipe", "pipe"] });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdin?.on("error", () => undefined);
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
        write: (t) => void child.stdin?.write(t),
        onOutput: (cb) => {
          child.stdout?.on("data", cb);
          child.stderr?.on("data", cb);
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
const runner = () =>
  createGhLoginRunner({
    host: host(),
    platform: "linux",
    stateDir: dir,
    uid: process.getuid?.(),
    managed: () => true,
    log: (l) => void logs.push(l),
    after: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    cloud: { report: async (_id, r) => (reports.push(r), { kind: "recorded" }) },
  });
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-fake-gh-pty-"));
  mkdirSync(path.join(dir, "bin"));
  mkdirSync(path.join(dir, "tools"));
  if (script !== undefined) symlinkSync(script, path.join(dir, "tools", "script"));
  if (sleepBin !== undefined) symlinkSync(sleepBin, path.join(dir, "tools", "sleep"));
  writeFileSync(path.join(dir, "bin", "gh"), FAKE);
  chmodSync(path.join(dir, "bin", "gh"), 0o755);
  reports = [];
  logs = [];
  specs = [];
});
afterEach(() => {
  for (const c of live.splice(0)) c.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(script === undefined || sleepBin === undefined)("gh_login_start against a real pty [pty]", () => {
  it("the real gh, the real model CLI and every git credential helper are unreachable on the child's private path; only the fake gh is first on it", () => {
    for (const name of ["gh", "git", "claude"]) expect(findOnPath(name, search())).toBeUndefined();
    expect(findOnPath("gh", [path.join(dir, "bin"), search()].join(path.delimiter))).toBe(path.join(dir, "bin", "gh"));
    expect(readdirSync(search()).filter((n) => n.startsWith("git-credential-") || n === "claude" || n === "gh")).toEqual([]);
    expect(existsSync(path.join(dir, "bin", "gh"))).toBe(true);
  });

  it("relays the code and the address from a real pty, then reports done when the process exits 0; the token line after it is never sent", async () => {
    const r = runner();
    expect(await r.start(REQ)).toEqual({ ok: true });
    expect(reports).toEqual([{ state: "awaiting_code", device_url: GH_DEVICE_URL, user_code: CODE }]);
    await r.idle();
    const end = Date.now() + 10_000;
    while (reports.length < 2 && Date.now() < end) await new Promise((res) => setTimeout(res, 25));
    expect(reports).toEqual([{ state: "awaiting_code", device_url: GH_DEVICE_URL, user_code: CODE }, { state: "done" }]);
    expect(JSON.stringify({ reports, logs })).not.toContain(TOKEN);
  });

  it("a machine that already has an account is refused before any sign-in starts: the real pty is never opened", async () => {
    writeFileSync(path.join(dir, "signed-in"), "");
    const r = runner();
    expect(await r.start(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(reports).toEqual([{ state: "failed", failure_code: "already_signed_in" }]);
    // the check was gh auth token with every stream ignored (the fake's gh auth status says 1 for this account: unverifiable, still present)
    expect(specs.map((c) => `${c.args.join(" ")}:${String(c.ignoreStdio)}`)).toEqual(["auth token --hostname github.com:true"]);
  });

  it("a process that exits 1 after the relay is reported failed (login_failed)", async () => {
    writeFileSync(path.join(dir, "fail"), "");
    const r = runner();
    expect(await r.start(REQ)).toEqual({ ok: true });
    const end = Date.now() + 10_000;
    while (reports.length < 2 && Date.now() < end) await new Promise((res) => setTimeout(res, 25));
    expect(reports.at(-1)).toEqual({ state: "failed", failure_code: "login_failed" });
  });

  it("gh_logout runs the fake with the exact vector", async () => {
    expect(await runner().logout()).toEqual({ ok: true });
  });
});
