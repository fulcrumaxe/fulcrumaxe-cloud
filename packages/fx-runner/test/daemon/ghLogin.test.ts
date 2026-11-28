import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GH_DEVICE_URL, type GhLoginReport } from "@fulcrumaxe/runner-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeLoginHost, LoginChild, LoginSpawnSpec } from "../../src/daemon/claudeLogin.js";
import { GH_LINK_LIMIT_MS, GH_LOGIN_ARGS, GH_TOKEN_ARGS, GH_STATUS_LIMIT_MS, GH_LOGIN_CWD_DIR, GH_LOGIN_LIMIT_MS, GH_LOGOUT_ARGS, createGhLoginRunner, ghRelayOf } from "../../src/daemon/ghLogin.js";

/**
 * D#845 ON-19c: the GitHub sign-in relay, against a stand-in host (no process is started). SPIKE is what the real `gh` 2.101.0 printed in a throwaway container on a pty, byte for byte, with a fresh unusable device code
 * swapped for CODE (the spike never signed in: it was stopped at this prompt). The same text is replayed in pieces and with every part of it changed, to hold the fence: only the exact address and an 8-character code leave.
 */
const CODE = "AB12-CD34";
const SPIKE =
  "\r\n\x1b[0;31m!\x1b[0m Failed to copy one-time code to clipboard\r\n  No clipboard utilities available. Please install xsel, xclip, wl-clipboard or Termux:API add-on for termux-clipboard-get/set.\r\n" +
  `\x1b[0;33m!\x1b[0m First copy your one-time code: \x1b[0;1;39m${CODE}\x1b[0m\r\n\x1b[0;1;39mOpen this URL\x1b[0m to continue in your web browser: ${GH_DEVICE_URL}\r\n`;
const REQ = "11111111-1111-4111-8111-111111111111";
const TOKEN = ["gho", "16C7e42F292c6912E7710c838347Ae178B4a"].join("_");

let dir: string;
let reports: GhLoginReport[];
let logs: string[];
let spawned: LoginSpawnSpec[];
/** The `gh auth token` presence checks (they are not sign-ins, so they are not in `spawned`) and what each exits with: 1 (no account) unless a test says otherwise; `hang` never exits, `null` is a process that did not run. */
let tokenCalls: LoginSpawnSpec[];
let statusExit: number | null | "hang";
let child: { out: (t: string) => void; exit: (c: number | null) => void; killed: number; wrote: string[] };
let timers: Array<{ ms: number; fn: () => void; live: boolean }>;
let cloudAnswer: "recorded" | "refused" | "error";
/** The cloud's answer to the `done` report alone (a sign-in it has already cancelled refuses it). */
let doneAnswer: "recorded" | "refused" | "error";

const host = (over: Partial<ClaudeLoginHost> = {}): ClaudeLoginHost => ({
  locateClaude: () => "/opt/fake/bin/claude",
  locateGh: () => "/opt/fake/bin/gh",
  env: () => ({ HOME: "/home/fake", PATH: "/opt/fake/tools", TERM: "xterm" }),
  launch: (spec) => {
    if (spec.args.join(" ") === GH_TOKEN_ARGS.join(" ")) {
      tokenCalls.push(spec);
      return { write: () => undefined, onOutput: () => undefined, onExit: (cb) => (statusExit === "hang" ? undefined : cb(statusExit)), kill: () => undefined };
    }
    spawned.push(spec);
    const outs: Array<(t: string) => void> = [];
    const exits: Array<(c: number | null) => void> = [];
    child = { out: (t) => outs.forEach((cb) => cb(t)), exit: (c) => exits.forEach((cb) => cb(c)), killed: 0, wrote: [] };
    const handle: LoginChild = { write: (t) => void child.wrote.push(t), onOutput: (cb) => void outs.push(cb), onExit: (cb) => void exits.push(cb), kill: () => void (child.killed += 1) };
    return handle;
  },
  ...over,
});
const make = (o: { host?: ClaudeLoginHost | undefined; managed?: boolean; platform?: NodeJS.Platform } = {}) =>
  createGhLoginRunner({
    host: "host" in o ? o.host : host(),
    platform: o.platform ?? "linux",
    stateDir: dir,
    uid: process.getuid?.(),
    managed: () => o.managed ?? true,
    log: (l) => void logs.push(l),
    after: (ms, fn) => {
      const t = { ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    cloud: {
      report: async (_id, r) => {
        reports.push(r);
        const answer = r.state === "done" ? doneAnswer : cloudAnswer;
        return answer === "recorded" ? { kind: "recorded" } : answer === "refused" ? { kind: "refused", status: 409 } : { kind: "error" };
      },
    },
  });
const fire = (ms: number): void => {
  for (const t of timers) {
    if (!t.live || t.ms !== ms) continue;
    t.live = false;
    t.fn();
  }
};
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
/** Everything that left the runner: each report, each log line. */
const everything = (): string => JSON.stringify({ reports, logs });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-gh-login-"));
  reports = [];
  logs = [];
  spawned = [];
  tokenCalls = [];
  statusExit = 1;
  timers = [];
  cloudAnswer = "recorded";
  doneAnswer = "recorded";
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ghRelayOf: the real CLI's lines", () => {
  it("takes the code and the address from the spike's output and nothing else", () => {
    const found = SPIKE.split("\n").map((l) => ghRelayOf(l)).filter((r) => r !== undefined);
    expect(found).toEqual([{ kind: "code", code: CODE }, { kind: "url" }]);
  });
  it.each([
    "Open this URL to continue in your web browser: https://github.com/login/device/",
    "Open this URL to continue in your web browser: https://github.com/login/device?user_code=AB12-CD34",
    "Open this URL to continue in your web browser: http://github.com/login/device",
    "Open this URL to continue in your web browser: https://github.com.evil.test/login/device",
    "Open this URL to continue in your web browser: https://evil.test/login/device",
    "Open this URL to continue in your web browser: https://user@github.com/login/device",
    "Open this URL to continue in your web browser: https://github.com/login/oauth/authorize",
    "Open this URL to continue in your web browser: https://github.com/login/device https://evil.test",
  ])("refuses a link that is not the one address: %s", (line) => expect(ghRelayOf(line)).toEqual({ kind: "bad" }));
  it.each(["ab12-cd34", "AB12CD34", "AB12-CD345", "AB1-CD34", "AB12-CD3!", "AB12-CD34 extra", "AB12-CD34\u0000", "gho_" + "x".repeat(36), "AB12-"])("refuses a code that is not 8 letters or digits in two groups of four: %s", (c) => {
    expect(ghRelayOf(`First copy your one-time code: ${c}`)?.kind).not.toBe("code");
  });
});

describe("gh_login_start", () => {
  it("starts gh in a pty with the fixed vector and a clean environment, relays the code and the address once, and is done when gh exits 0", async () => {
    const r = make();
    const started = r.start(REQ);
    await tick();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ file: "script", args: [...GH_LOGIN_ARGS], cwd: path.join(dir, GH_LOGIN_CWD_DIR) });
    expect(spawned[0]!.args).toEqual(["-q", "-e", "-c", "gh auth login --hostname github.com --web --skip-ssh-key", "/dev/null"]);
    const env = spawned[0]!.env;
    expect(env).toMatchObject({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" });
    expect(env["PATH"]!.startsWith("/opt/fake/bin:")).toBe(true);
    for (const name of ["BROWSER", "DISPLAY", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]) expect(env).not.toHaveProperty(name);
    // in pieces, as a pty delivers it
    for (const piece of SPIKE.match(/[\s\S]{1,37}/g)!) child.out(piece);
    expect(await started).toEqual({ ok: true });
    expect(reports).toEqual([{ state: "awaiting_code", device_url: GH_DEVICE_URL, user_code: CODE }]);
    child.out(`Press Enter ${TOKEN}\r\n✓ Authentication complete.\r\n✓ Logged in as someone\r\n`);
    child.exit(0);
    await r.idle();
    expect(reports).toEqual([{ state: "awaiting_code", device_url: GH_DEVICE_URL, user_code: CODE }, { state: "done" }]);
    expect(child.killed).toBe(1);
    // nothing is ever written to the CLI: the person types the code on GitHub's page
    expect(child.wrote).toEqual([]);
  });

  it("forwards nothing else the CLI prints: not the clipboard line, not a token, not the account name, in a report or a log line", async () => {
    const r = make();
    const started = r.start(REQ);
    await tick();
    child.out(SPIKE);
    await started;
    child.out(`${TOKEN}\r\n✓ Logged in as someone-private\r\n`);
    child.exit(0);
    await r.idle();
    const all = everything();
    for (const secret of [TOKEN, "someone-private", "clipboard", "Termux", "Open this URL", "xsel"]) expect(all).not.toContain(secret);
    expect(Object.keys(reports[0]!).sort()).toEqual(["device_url", "state", "user_code"]);
  });

  it.each([
    ["a lookalike address", `\x1b[0;33m!\x1b[0m First copy your one-time code: ${CODE}\r\nOpen this URL: https://github.com/login/device/x\r\n`],
    ["another host", `First copy your one-time code: ${CODE}\r\nOpen this URL: https://evil.test/login/device\r\n`],
    ["a code of the wrong shape", `First copy your one-time code: ab12-cd34\r\nOpen this URL: ${GH_DEVICE_URL}\r\n`],
    ["a token where the code goes", `First copy your one-time code: ${TOKEN}\r\nOpen this URL: ${GH_DEVICE_URL}\r\n`],
    ["a bad link before the code", `Open this URL: https://evil.test/\r\nFirst copy your one-time code: ${CODE}\r\nOpen this URL: ${GH_DEVICE_URL}\r\n`],
  ])("%s ends the sign-in as failed (bad_link) and relays nothing", async (_name, out) => {
    const r = make();
    const started = r.start(REQ);
    await tick();
    child.out(out);
    expect(await started).toEqual({ ok: false, refusal: "failed" });
    await r.idle();
    expect(reports).toEqual([{ state: "failed", failure_code: "bad_link" }]);
    expect(everything()).not.toContain(TOKEN);
    expect(everything()).not.toContain("evil.test");
    expect(child.killed).toBe(1);
  });

  it("an address with no code (or a code with no address) is never relayed; the link limit ends it as no_link", async () => {
    const r = make();
    const started = r.start(REQ);
    await tick();
    child.out(`Open this URL: ${GH_DEVICE_URL}\r\nFirst copy your one-time code: ${CODE}`); // no newline after the code yet
    await tick();
    expect(reports).toEqual([]);
    fire(GH_LINK_LIMIT_MS);
    expect(await started).toEqual({ ok: false, refusal: "failed" });
    await r.idle();
    expect(reports).toEqual([{ state: "failed", failure_code: "no_link" }]);
  });

  it("gh exiting non-zero after the relay is failed (login_failed); exiting before it is no_link; the ten-minute limit kills it (timeout)", async () => {
    let r = make();
    let started = r.start(REQ);
    await tick();
    child.out(SPIKE);
    await started;
    child.exit(1);
    await r.idle();
    expect(reports.at(-1)).toEqual({ state: "failed", failure_code: "login_failed" });

    reports = [];
    r = make();
    started = r.start(REQ);
    await tick();
    child.exit(1);
    expect(await started).toEqual({ ok: false, refusal: "failed" });
    await r.idle();
    expect(reports).toEqual([{ state: "failed", failure_code: "no_link" }]);

    reports = [];
    r = make();
    started = r.start(REQ);
    await tick();
    child.out(SPIKE);
    await started;
    fire(GH_LOGIN_LIMIT_MS);
    await r.idle();
    expect(reports.at(-1)).toEqual({ state: "failed", failure_code: "timeout" });
    expect(child.killed).toBeGreaterThan(0);
  });

  it("a cloud that refuses or cannot be reached for the relay ends the sign-in: nobody could use the code", async () => {
    for (const answer of ["refused", "error"] as const) {
      cloudAnswer = answer;
      const r = make();
      const started = r.start(REQ);
      await tick();
      child.out(SPIKE);
      // the report's retry waits on a timer: let it run
      const pump = setInterval(() => fire(2000), 5);
      expect(await started).toEqual({ ok: false, refusal: "failed" });
      await r.idle();
      clearInterval(pump);
      expect(child.killed).toBeGreaterThan(0);
      reports = [];
    }
  });

  it("is refused, and said so in fixed words, off Linux, unmanaged, without a host, without gh, with a bad id and while another sign-in runs; nothing is started", async () => {
    const cases: Array<[ReturnType<typeof make>, string, string]> = [
      [make({ platform: "darwin" }), "unsupported_platform", "unsupported"],
      [make({ host: undefined }), "unsupported_platform", "unsupported"],
      [make({ managed: false }), "not_managed", "unsupported"],
      [make({ host: host({ locateGh: () => undefined }) }), "gh_missing", "failed"],
      [make({ host: host({ locateGh: undefined }) }), "gh_missing", "failed"],
    ];
    for (const [r, failure, refusal] of cases) {
      reports = [];
      expect(await r.start(REQ)).toEqual({ ok: false, refusal });
      expect(reports).toEqual([{ state: "failed", failure_code: failure }]);
    }
    expect(spawned).toEqual([]);
    expect(await make().start("not-a-uuid")).toEqual({ ok: false, refusal: "failed" });
    expect(await make().start("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toEqual({ ok: false, refusal: "failed" });
    reports = [];
    const r = make();
    void r.start(REQ);
    await tick();
    expect(await r.start("22222222-2222-4222-8222-222222222222")).toEqual({ ok: false, refusal: "busy" });
    expect(reports).toEqual([{ state: "failed", failure_code: "busy" }]);
    expect(spawned).toHaveLength(1);
  });
});

describe("gh_logout", () => {
  it("runs gh auth logout for github.com with prompts off and answers by its exit status", async () => {
    const r = make();
    const out = r.logout();
    await tick();
    expect(spawned[0]).toMatchObject({ file: "/opt/fake/bin/gh", args: [...GH_LOGOUT_ARGS] });
    expect(spawned[0]!.args).toEqual(["auth", "logout", "--hostname", "github.com"]);
    expect(spawned[0]!.env).toMatchObject({ GH_PROMPT_DISABLED: "1" });
    child.out(`${TOKEN} signed out of someone-private`);
    child.exit(0);
    expect(await out).toEqual({ ok: true });
    const bad = r.logout();
    await tick();
    child.exit(1);
    expect(await bad).toEqual({ ok: false, refusal: "failed" });
    const slow = r.logout();
    await tick();
    fire(60_000);
    expect(await slow).toEqual({ ok: false, refusal: "failed" });
    expect(child.killed).toBe(1);
    expect(everything()).not.toContain(TOKEN);
  });
  it("is refused off Linux, unmanaged and without gh (a sign-in that runs is ended by it: see below)", async () => {
    expect(await make({ platform: "win32" }).logout()).toEqual({ ok: false, refusal: "unsupported" });
    expect(await make({ managed: false }).logout()).toEqual({ ok: false, refusal: "unsupported" });
    expect(await make({ host: host({ locateGh: () => undefined }) }).logout()).toEqual({ ok: false, refusal: "failed" });
  });
});

describe("cancel, sign-out during a sign-in, and the fail-safe", () => {
  const LOGOUT = ["auth", "logout", "--hostname", "github.com"];
  const relayed = async (r: ReturnType<typeof make>) => {
    const started = r.start(REQ);
    await tick();
    child.out(SPIKE);
    expect(await started).toEqual({ ok: true });
  };

  it("a sign-out while the sign-in waits for the person kills the sign-in's process tree first, reports it failed (cancelled), then signs out; it is not refused busy", async () => {
    const r = make();
    await relayed(r);
    const login = child;
    const out = r.logout();
    login.exit(null); // the killed process is gone
    await tick();
    await tick();
    expect(login.killed).toBe(1);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]).toMatchObject({ file: "/opt/fake/bin/gh", args: LOGOUT });
    child.exit(0);
    expect(await out).toEqual({ ok: true });
    await r.idle();
    expect(reports.at(-1)).toEqual({ state: "failed", failure_code: "cancelled" });
    expect(reports.some((x) => x.state === "done")).toBe(false);
    // nothing is left running: a new sign-in may start
    const again = r.start("22222222-2222-4222-8222-222222222222");
    await tick();
    expect(spawned).toHaveLength(3);
    void again;
  });

  it("a sign-out before the code is relayed also ends the sign-in", async () => {
    const r = make();
    const started = r.start(REQ);
    await tick();
    const login = child;
    const out = r.logout();
    login.exit(null);
    expect(await started).toEqual({ ok: false, refusal: "failed" });
    await tick();
    await tick();
    expect(login.killed).toBe(1);
    expect(spawned[1]).toMatchObject({ args: LOGOUT });
    child.exit(0);
    expect(await out).toEqual({ ok: true });
  });

  it("a process that exits 0 after the person entered the code, when the cloud refuses the done report (cancelled or over), is signed out again with fixed arguments", async () => {
    doneAnswer = "refused";
    const r = make();
    await relayed(r);
    child.exit(0);
    await tick();
    await tick();
    expect(reports.at(-1)).toEqual({ state: "done" });
    expect(spawned).toHaveLength(2);
    expect(spawned[1]).toMatchObject({ file: "/opt/fake/bin/gh", args: LOGOUT });
    expect(spawned[1]!.env).toMatchObject({ GH_PROMPT_DISABLED: "1" });
    child.exit(0);
    await r.idle();
    expect(logs.join("\n")).toContain("report was not taken");
    expect(everything()).not.toContain(TOKEN);
  });

  it("a done the cloud took, or one it could not be asked about, is not followed by a sign-out", async () => {
    for (const answer of ["recorded", "error"] as const) {
      doneAnswer = answer;
      spawned = [];
      const r = make();
      await relayed(r);
      const pump = setInterval(() => fire(2000), 5);
      child.exit(0);
      await r.idle();
      clearInterval(pump);
      expect(spawned, answer).toHaveLength(1);
    }
  });
});

describe("one account per machine, and a sign-out that fails is said", () => {
  it("refuses a start when github.com already has an account (gh auth token exits 0): the closed word already_signed_in, nothing started, and the check ran with the fixed vector and a scrubbed environment", async () => {
    statusExit = 0;
    const r = make();
    expect(await r.start(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(reports).toEqual([{ state: "failed", failure_code: "already_signed_in" }]);
    expect(spawned).toEqual([]);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]).toMatchObject({ file: "/opt/fake/bin/gh", args: ["auth", "token", "--hostname", "github.com"], ignoreStdio: true });
    expect(tokenCalls[0]!.env).toMatchObject({ GH_PROMPT_DISABLED: "1" });
    for (const name of ["BROWSER", "DISPLAY", "GH_TOKEN", "GITHUB_TOKEN"]) expect(tokenCalls[0]!.env).not.toHaveProperty(name);
    // the check does not leave the machine busy
    statusExit = 1;
    const again = make();
    void again.start(REQ);
    await tick();
    expect(spawned).toHaveLength(1);
  });

  it("asks by the stored config, not the network: gh auth token (never gh auth status, which exits 1 for a present account it cannot verify), with every stream ignored so no token reaches a pipe of ours; present but unverifiable is refused", async () => {
    statusExit = 0; // what gh auth token answers for an account whose token cannot be verified right now (gh auth status would say 1)
    const r = make();
    expect(await r.start(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(reports).toEqual([{ state: "failed", failure_code: "already_signed_in" }]);
    expect(tokenCalls.map((c) => c.args.join(" "))).toEqual(["auth token --hostname github.com"]);
    expect(tokenCalls[0]!.ignoreStdio).toBe(true);
    expect(spawned.every((c) => c.ignoreStdio !== true)).toBe(true);
    // only the presence check is started with no pipe; the sign-in and the sign-out keep theirs
    statusExit = 1;
    const ok = make();
    void ok.start(REQ);
    await tick();
    expect(spawned[0]!.ignoreStdio).toBeUndefined();
  });

  it("any answer but 0 and 1 is start_failed: a status of 2 or 127, a signal, a start that fails", async () => {
    for (const exit of [2, 127, 255, null]) {
      statusExit = exit;
      reports = [];
      expect(await make().start(REQ), String(exit)).toEqual({ ok: false, refusal: "failed" });
      expect(reports, String(exit)).toEqual([{ state: "failed", failure_code: "start_failed" }]);
    }
    expect(spawned).toEqual([]);
  });

  it("a check that cannot be answered refuses too (start_failed): it never starts a sign-in it could not check", async () => {
    statusExit = null;
    expect(await make().start(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(reports.at(-1)).toEqual({ state: "failed", failure_code: "start_failed" });
    statusExit = "hang";
    reports = [];
    const r = make();
    const out = r.start(REQ);
    await tick();
    fire(GH_STATUS_LIMIT_MS);
    expect(await out).toEqual({ ok: false, refusal: "failed" });
    expect(reports).toEqual([{ state: "failed", failure_code: "start_failed" }]);
    expect(spawned).toEqual([]);
  });

  it("a fail-safe sign-out that does not succeed is reported signout_failed, in fixed words, and logged without any gh text", async () => {
    doneAnswer = "refused";
    const r = make();
    const started = r.start(REQ);
    await tick();
    child.out(SPIKE);
    await started;
    child.exit(0);
    await tick();
    await tick();
    child.out(`${TOKEN} unable to determine which account`);
    child.exit(1);
    await r.idle();
    expect(reports.at(-1)).toEqual({ state: "failed", failure_code: "signout_failed" });
    expect(logs.join("\n")).toContain("sign-out did not succeed");
    expect(everything()).not.toContain(TOKEN);
  });

  it("a sign-out that ends a running sign-in and then fails is reported signout_failed for that request; its own answer is refused", async () => {
    const r = make();
    const started = r.start(REQ);
    await tick();
    child.out(SPIKE);
    await started;
    const login = child;
    const out = r.logout();
    login.exit(null);
    await tick();
    await tick();
    child.exit(1);
    expect(await out).toEqual({ ok: false, refusal: "failed" });
    await r.idle();
    expect(reports.map((x) => x.failure_code)).toEqual([undefined, "cancelled", "signout_failed"]);
  });
});

