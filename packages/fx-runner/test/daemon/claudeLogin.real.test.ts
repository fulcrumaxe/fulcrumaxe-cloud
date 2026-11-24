/**
 * D#845 MC-8b, the real contract: the sign-in runner against the installed CLI itself. It is gated and never runs by default, in CI or on a builder's machine: it starts the real CLI's sign-in, which
 * contacts the sign-in service, and the second test signs in for real with a code the owner pastes. Nothing here is a fake.
 *
 *  - `FX_REAL_CLAUDE_LOGIN=1`: starts the sign-in in a scratch home and checks the link the CLI prints is one the protocol accepts. It writes no code, so nothing is signed in, and it kills the process group.
 *  - `FX_REAL_CLAUDE_LOGIN_CODE=<code>` as well (the owner opens the link from the first test's printout in a browser, then runs this with the code that page shows): the same runner takes the code, reports `done`, and
 *    the test then signs out again. It is the success fixture's source: what the CLI printed and where the credential went, for the owner's one real sign-in (Ruling 52.10).
 *
 * The scratch home is a fresh temp directory, never the machine's own, so a real credential on this machine is neither read nor changed.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLAUDE_AUTH_URL_PATTERN, type MachineLoginReport } from "@fulcrumaxe/runner-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeLoginRunner, type ClaudeLoginHost, type LoginChild } from "../../src/daemon/claudeLogin.js";
import { resolveClaudePath } from "../../src/engines/claude/pin.js";

const enabled = process.env["FX_REAL_CLAUDE_LOGIN"] === "1" && process.platform === "linux";
const ownerCode = process.env["FX_REAL_CLAUDE_LOGIN_CODE"];
const REQ = "11111111-1111-4111-8111-111111111111";

let home: string;
let reports: MachineLoginReport[];
const live: LoginChild[] = [];

function host(): ClaudeLoginHost {
  const searchPath = process.env["PATH"] ?? "";
  return {
    locateClaude: () => resolveClaudePath(searchPath),
    env: () => ({ HOME: home, PATH: searchPath, TERM: "xterm", LANG: "C.UTF-8" }),
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
          try {
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          } catch {
            // the group is already gone
          }
        },
      };
      live.push(handle);
      return handle;
    },
  };
}

function runner(code: string | undefined) {
  return createClaudeLoginRunner({
    host: host(),
    platform: "linux",
    stateDir: home,
    uid: process.getuid?.(),
    managed: () => true,
    log: (line) => process.stderr.write(`${line}\n`),
    after: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    cloud: {
      report: async (_id, report) => (reports.push(report), { kind: "recorded" }),
      takeCode: async () => (code === undefined ? { kind: "gone" } : { kind: "code", code }),
    },
  });
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "fx-real-login-"));
  reports = [];
});
afterEach(() => {
  for (const c of live.splice(0)) c.kill();
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!enabled)("the installed CLI's sign-in (gated: FX_REAL_CLAUDE_LOGIN=1)", () => {
  it("prints a link the protocol accepts, and the runner reports it", async () => {
    const r = runner(undefined);
    expect(await r.start(REQ)).toEqual({ ok: true });
    const link = reports[0];
    expect(link).toMatchObject({ state: "awaiting_code" });
    expect(link!.auth_url).toMatch(CLAUDE_AUTH_URL_PATTERN);
    process.stderr.write(`link: ${link!.auth_url}\n`);
  }, 90_000);

  it.skipIf(ownerCode === undefined)("signs in with the owner's code, reports done, and signs out again", async () => {
    const r = runner(ownerCode);
    expect(await r.start(REQ)).toEqual({ ok: true });
    expect(await r.code(REQ)).toEqual({ ok: true });
    const end = Date.now() + 60_000;
    while (reports.length < 2 && Date.now() < end) await new Promise((res) => setTimeout(res, 100));
    expect(reports[1]).toEqual({ state: "done" });
    expect(await r.logout()).toEqual({ ok: true });
  }, 180_000);
});
