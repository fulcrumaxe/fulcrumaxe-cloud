import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MachineLoginReport } from "@fulcrumaxe/runner-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_LOGIN_ARGS,
  CLAUDE_LOGIN_LOG_KEEP_MS,
  CLAUDE_LOGIN_COMMAND,
  CLAUDE_LOGIN_LIMIT_MS,
  CLAUDE_LOGIN_LOG_MAX_BYTES,
  CLAUDE_LINK_LIMIT_MS,
  CLAUDE_LOGOUT_ARGS,
  createClaudeLoginRunner,
  findLink,
  type ClaudeLoginHost,
  type CodeResult,
  type LoginChild,
  type LoginSpawnSpec,
  type ReportResult,
} from "../../src/daemon/claudeLogin.js";

/** The spike's golden fixture (Ruling 52.10): what the real CLI printed, with the query values redacted. */
const URL_LINE = "https://claude.com/cai/oauth/authorize?code=REDACTED&client_id=REDACTED&response_type=REDACTED&redirect_uri=REDACTED&scope=REDACTED&code_challenge=REDACTED&code_challenge_method=REDACTED&state=REDACTED";
const BANNER = "Opening browser to sign in…\r\nIf the browser didn't open, visit: " + URL_LINE + "\r\nPaste code here if prompted > ";
const REQ = "11111111-1111-4111-8111-111111111111";
const REQ2 = "22222222-2222-4222-8222-222222222222";
/** A sentinel no real code could be mistaken for. It must be found nowhere but the CLI's standard input. */
const SENTINEL = "SENTINEL-code-9f3a7c1e-do-not-leak";

/**
 * A strict fake of the CLI as the runner sees it (a process behind `script`): it accepts only the fixed argument vector and an environment with no browser, display or credential, prints what the real CLI
 * printed, waits for a line that ends in a carriage return, and (like a pty) echoes whatever it is given. It refuses (throws) anything the real one would not take.
 */
class FakeCli implements LoginChild {
  written: string[] = [];
  killed = 0;
  private out: Array<(t: string) => void> = [];
  private exit: Array<(c: number | null) => void> = [];
  exited = false;
  constructor(readonly spec: LoginSpawnSpec) {}
  write(text: string): void {
    if (this.exited) throw new Error("write after exit");
    if (!text.endsWith("\r")) throw new Error("the CLI reads a line: the code must end in a carriage return");
    this.written.push(text);
  }
  onOutput(cb: (t: string) => void): void {
    this.out.push(cb);
  }
  onExit(cb: (c: number | null) => void): void {
    this.exit.push(cb);
  }
  kill(): void {
    this.killed++;
    this.exited = true;
  }
  // test controls
  print(text: string): void {
    for (const cb of this.out) cb(text);
  }
  end(code: number | null): void {
    this.exited = true;
    for (const cb of this.exit) cb(code);
  }
}

let dir: string;
let children: FakeCli[];
let reports: Array<{ id: string; report: MachineLoginReport }>;
let logLines: string[];
let timers: Array<{ ms: number; fn: () => void; live: boolean }>;
let reportAnswers: ReportResult[];
let codeAnswer: CodeResult;
let takeCalls: string[];
let claudePath: string | undefined;
let managed: boolean;
let nowMs: number;

function strictHost(): ClaudeLoginHost {
  return {
    locateClaude: () => claudePath,
    env: () => ({ HOME: "/home/fx", PATH: "/usr/bin", TERM: "xterm" }),
    launch: (spec) => {
      if (spec.file === "script") {
        expect(spec.args).toEqual(["-q", "-e", "-c", "claude auth login --claudeai", "/dev/null"]);
        expect(spec.args).toEqual([...CLAUDE_LOGIN_ARGS]);
      } else {
        expect(spec.file).toBe("/opt/claude/bin/claude");
        expect(spec.args).toEqual([...CLAUDE_LOGOUT_ARGS]);
      }
      for (const name of Object.keys(spec.env)) expect(name).not.toMatch(/BROWSER|DISPLAY|ANTHROPIC|TOKEN|KEY|SECRET|CLAUDE_CODE/i);
      expect(spec.env["PATH"]!.startsWith("/opt/claude/bin:")).toBe(true);
      expect(spec.cwd).toBe(path.join(dir, "login-cwd"));
      const child = new FakeCli(spec);
      children.push(child);
      return child;
    },
  };
}

function make(over: { platform?: NodeJS.Platform; host?: ClaudeLoginHost | undefined } = {}) {
  return createClaudeLoginRunner({
    host: "host" in over ? over.host : strictHost(),
    platform: over.platform ?? "linux",
    stateDir: dir,
    uid: process.getuid?.(),
    managed: () => managed,
    now: () => nowMs,
    log: (line) => logLines.push(line),
    after: (ms, fn) => {
      const t = { ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    cloud: {
      report: async (id, report) => {
        reports.push({ id, report });
        return reportAnswers.shift() ?? { kind: "recorded" };
      },
      takeCode: async (id) => {
        takeCalls.push(id);
        return codeAnswer;
      },
    },
  });
}
const fire = (ms: number): void => {
  for (const t of timers) if (t.live && t.ms === ms) {
      t.live = false;
      t.fn();
    }
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const logFile = (id = REQ): string => path.join(dir, "login", `${id}.log`);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-claude-login-"));
  children = [];
  reports = [];
  logLines = [];
  timers = [];
  reportAnswers = [];
  codeAnswer = { kind: "code", code: SENTINEL };
  takeCalls = [];
  claudePath = "/opt/claude/bin/claude";
  managed = true;
  nowMs = Date.now();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Starts a sign-in up to the point where the link is reported. */
async function startToLink(runner = make()) {
  const started = runner.start(REQ);
  await settle();
  children[0]!.print(BANNER.slice(0, 40));
  children[0]!.print(BANNER.slice(40));
  expect(await started).toEqual({ ok: true });
  return runner;
}

describe("the command is fixed", () => {
  it("is one constant string behind script, with no interpolation", () => {
    expect(CLAUDE_LOGIN_COMMAND).toBe("claude auth login --claudeai");
    expect([...CLAUDE_LOGIN_ARGS]).toEqual(["-q", "-e", "-c", CLAUDE_LOGIN_COMMAND, "/dev/null"]);
  });
});

describe("a sign-in that works", () => {
  it("reports the link once, takes the code once, writes it to the CLI, and reports done", async () => {
    const runner = await startToLink();
    // The link, whole, and only after its line ended (it arrived in two pieces).
    expect(reports).toEqual([{ id: REQ, report: { state: "awaiting_code", auth_url: URL_LINE } }]);
    const cli = children[0]!;
    expect(await runner.code(REQ)).toEqual({ ok: true });
    expect(takeCalls).toEqual([REQ]);
    expect(cli.written).toEqual([`${SENTINEL}\r`]);
    // A pty echoes what was typed, then the CLI says it is signed in.
    cli.print(`${SENTINEL}\r\nLogin successful.\r\n`);
    cli.end(0);
    await settle();
    expect(reports.map((r) => r.report)).toEqual([{ state: "awaiting_code", auth_url: URL_LINE }, { state: "done" }]);
    expect(cli.killed).toBe(1);
    await runner.idle();
  });

  it("matches the link through terminal control sequences and carriage returns", async () => {
    const runner = make();
    const started = runner.start(REQ);
    await settle();
    children[0]!.print(`\u001b[2K\u001b[1G\u001b[32mIf the browser didn't open, visit: ${URL_LINE}\u001b[0m\r\n`);
    expect(await started).toEqual({ ok: true });
    expect(reports[0]!.report).toEqual({ state: "awaiting_code", auth_url: URL_LINE });
  });

  it("does not report a link before its line has ended", async () => {
    const runner = make();
    const started = runner.start(REQ);
    await settle();
    children[0]!.print(`visit: ${URL_LINE}`);
    await settle();
    expect(reports).toEqual([]);
    children[0]!.print("\r\n");
    expect(await started).toEqual({ ok: true });
    expect(reports).toHaveLength(1);
  });
});

describe("the code never goes anywhere but the CLI's input", () => {
  it("is absent from every report, journal line, log file, launch spec and the acks, whatever the pty echoes", async () => {
    const runner = await startToLink();
    await runner.code(REQ);
    const cli = children[0]!;
    // The echo, a refusal that quotes it, and a success: the CLI's text after the code is never kept.
    cli.print(`${SENTINEL}\r\nInvalid code ${SENTINEL}`);
    await settle();
    cli.print(`\r\nLogin successful.`);
    await settle();
    const everything = JSON.stringify({ reports, logLines, specs: children.map((c) => c.spec), logs: readdirSync(path.join(dir, "login")).map((f) => readFileSync(path.join(dir, "login", f), "utf8")) });
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain("9f3a7c1e");
    // The one place it went.
    expect(cli.written).toEqual([`${SENTINEL}\r`]);
    for (const spec of children.map((c) => c.spec)) expect([spec.file, ...spec.args, ...Object.values(spec.env)].join(" ")).not.toContain("SENTINEL");
  });

  it("keeps what the CLI printed before the code in a 0600 log, and nothing after it", async () => {
    const runner = await startToLink();
    await runner.code(REQ);
    children[0]!.print("after-the-code-text");
    const text = readFileSync(logFile(), "utf8");
    expect(text).toContain("Paste code here if prompted >");
    expect(text).toContain(URL_LINE);
    expect(text).not.toContain("after-the-code-text");
    expect(statSync(logFile()).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, "login")).mode & 0o777).toBe(0o700);
  });

  it("stops the log at 1 MiB", async () => {
    const runner = make();
    const started = runner.start(REQ);
    await settle();
    for (let i = 0; i < 20; i++) children[0]!.print("x".repeat(100_000));
    children[0]!.print(`${URL_LINE}\n`);
    await started;
    expect(statSync(logFile()).size).toBeLessThanOrEqual(CLAUDE_LOGIN_LOG_MAX_BYTES);
  });
});

describe("links that are not the sign-in link", () => {
  for (const [name, line] of [
    ["a lookalike host", "visit: https://claude.com.evil.example/cai/oauth/authorize?x=1"],
    ["userinfo", "visit: https://claude.com@evil.example/cai/oauth/authorize?x=1"],
    ["plain http", "visit: http://claude.com/cai/oauth/authorize?x=1"],
    ["another path", "visit: https://claude.com/other?x=1"],
    ["the right pattern on another origin", "visit: https://claude.ai/cai/oauth/authorize?x=1"],
  ] as const) {
    it(`${name} is never reported: the request fails as bad_link`, async () => {
      const runner = make();
      const started = runner.start(REQ);
      await settle();
      children[0]!.print(`${line}\r\n`);
      expect(await started).toEqual({ ok: false, refusal: "failed" });
      expect(reports).toEqual([{ id: REQ, report: { state: "failed", failure_code: "bad_link" } }]);
      expect(children[0]!.killed).toBe(1);
    });
  }
  it("findLink says what it saw", () => {
    expect(findLink(`visit: ${URL_LINE}`)).toEqual({ kind: "valid", url: URL_LINE });
    expect(findLink("no link here")).toBeUndefined();
  });
});

describe("a start that cannot go ahead reports failed itself", () => {
  it("not on Linux: unsupported, reported, nothing started", async () => {
    const runner = make({ platform: "darwin" });
    expect(await runner.start(REQ)).toEqual({ ok: false, refusal: "unsupported" });
    expect(reports).toEqual([{ id: REQ, report: { state: "failed", failure_code: "unsupported_platform" } }]);
    expect(children).toEqual([]);
  });
  it("no host wiring (a test or an old entry point): unsupported", async () => {
    const runner = make({ host: undefined });
    expect(await runner.start(REQ)).toEqual({ ok: false, refusal: "unsupported" });
    expect(reports[0]!.report).toEqual({ state: "failed", failure_code: "unsupported_platform" });
  });
  it("no CLI on the machine: claude_missing", async () => {
    claudePath = undefined;
    const runner = make();
    expect(await runner.start(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(reports).toEqual([{ id: REQ, report: { state: "failed", failure_code: "claude_missing" } }]);
  });
  it("a second start while one is running: busy, and the first goes on", async () => {
    const runner = await startToLink();
    expect(await runner.start(REQ2)).toEqual({ ok: false, refusal: "busy" });
    expect(reports.at(-1)).toEqual({ id: REQ2, report: { state: "failed", failure_code: "busy" } });
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(0);
    expect(await runner.code(REQ)).toEqual({ ok: true });
  });
  it("a start that throws: start_failed", async () => {
    const host = { ...strictHost(), launch: () => { throw new Error("spawn script ENOENT"); } };
    const runner = make({ host });
    expect(await runner.start(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(reports[0]!.report).toEqual({ state: "failed", failure_code: "start_failed" });
    expect(logLines.join("\n")).not.toContain("ENOENT");
  });
  it("a repeated start of the same request is refused without a second process and without a report", async () => {
    const runner = await startToLink();
    children[0]!.end(1);
    await settle();
    reports.length = 0;
    expect(await runner.start(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(children).toHaveLength(1);
    expect(reports).toEqual([]);
  });
  it("a log directory that is not safe: log_unwritable", async () => {
    writeFileSync(path.join(dir, "login"), "a file where the directory should be");
    const runner = make();
    expect(await runner.start(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(reports[0]!.report).toEqual({ state: "failed", failure_code: "log_unwritable" });
  });
  it("a CLI that exits before it prints a link: no_link", async () => {
    const runner = make();
    const started = runner.start(REQ);
    await settle();
    children[0]!.end(1);
    expect(await started).toEqual({ ok: false, refusal: "failed" });
    expect(reports).toEqual([{ id: REQ, report: { state: "failed", failure_code: "no_link" } }]);
  });
  it("a CLI that prints no link within a minute: no_link, and it is killed", async () => {
    const runner = make();
    const started = runner.start(REQ);
    await settle();
    fire(CLAUDE_LINK_LIMIT_MS);
    expect(await started).toEqual({ ok: false, refusal: "failed" });
    expect(reports).toEqual([{ id: REQ, report: { state: "failed", failure_code: "no_link" } }]);
    expect(children[0]!.killed).toBe(1);
  });
  it("a cloud that will not take the link (409): the sign-in ends and the start is refused", async () => {
    reportAnswers = [{ kind: "refused", status: 409 }, { kind: "refused", status: 409 }];
    const runner = make();
    const started = runner.start(REQ);
    await settle();
    children[0]!.print(`visit: ${URL_LINE}\r\n`);
    expect(await started).toEqual({ ok: false, refusal: "failed" });
    expect(children[0]!.killed).toBe(1);
    await runner.idle();
  });
});

describe("the ends", () => {
  it("a late code fetch (410): the sign-in ends failed code_gone and nothing is written", async () => {
    const runner = await startToLink();
    codeAnswer = { kind: "gone" };
    expect(await runner.code(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(children[0]!.written).toEqual([]);
    expect(children[0]!.killed).toBe(1);
    expect(reports.at(-1)).toEqual({ id: REQ, report: { state: "failed", failure_code: "code_gone" } });
  });
  it("a code fetch that fails on the network fails closed", async () => {
    const runner = await startToLink();
    codeAnswer = { kind: "error" };
    expect(await runner.code(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(reports.at(-1)!.report).toEqual({ state: "failed", failure_code: "code_fetch_failed" });
    expect(children[0]!.written).toEqual([]);
  });
  it("a second code command for the same request takes no second code", async () => {
    const runner = await startToLink();
    expect(await runner.code(REQ)).toEqual({ ok: true });
    expect(await runner.code(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(takeCalls).toEqual([REQ]);
  });
  it("a code command for a request nobody started takes nothing", async () => {
    const runner = make();
    expect(await runner.code(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(takeCalls).toEqual([]);
  });
  it("a late done (409) is logged in fixed words and changes nothing here", async () => {
    const runner = await startToLink();
    await runner.code(REQ);
    reportAnswers = [{ kind: "refused", status: 409 }];
    children[0]!.print("Login successful.\r\n");
    children[0]!.end(0);
    await settle();
    await runner.idle();
    expect(reports.at(-1)!.report).toEqual({ state: "done" });
    expect(logLines).toEqual(["fx-runner: the cloud no longer takes a report for this sign-in (409)"]);
  });
  it("the CLI refusing the code: invalid_code, and it is killed", async () => {
    const runner = await startToLink();
    await runner.code(REQ);
    children[0]!.print("Invalid code. Please make sure the full code was copied.\r\n");
    await settle();
    expect(reports.at(-1)!.report).toEqual({ state: "failed", failure_code: "invalid_code" });
    expect(children[0]!.killed).toBe(1);
  });
  it("an exit with a failure status after the code: login_failed; an exit 0 without the phrase is not success", async () => {
    let runner = await startToLink();
    await runner.code(REQ);
    children[0]!.end(1);
    await settle();
    expect(reports.at(-1)!.report).toEqual({ state: "failed", failure_code: "login_failed" });
    children = [];
    reports = [];
    runner = make();
    const started = runner.start(REQ2);
    await settle();
    children[0]!.print(`visit: ${URL_LINE}\n`);
    await started;
    await runner.code(REQ2);
    children[0]!.end(0);
    await settle();
    expect(reports.at(-1)!.report).toEqual({ state: "failed", failure_code: "login_failed" });
  });
  it("the success phrase with a failing exit is not success", async () => {
    const runner = await startToLink();
    await runner.code(REQ);
    children[0]!.print("Login successful.\r\n");
    children[0]!.end(1);
    await settle();
    expect(reports.at(-1)!.report).toEqual({ state: "failed", failure_code: "login_failed" });
  });
  it("the ten-minute limit kills the process group and reports timeout", async () => {
    await startToLink();
    fire(CLAUDE_LOGIN_LIMIT_MS);
    await settle();
    expect(children[0]!.killed).toBe(1);
    expect(reports.at(-1)!.report).toEqual({ state: "failed", failure_code: "timeout" });
  });
  it("a report that cannot be sent is tried three times and then given up on", async () => {
    await startToLink();
    reports.length = 0;
    reportAnswers = [{ kind: "error" }, { kind: "error" }, { kind: "error" }];
    children[0]!.end(1);
    // the retry pauses go through `after`
    for (let i = 0; i < 6; i++) {
      await settle();
      for (const t of timers) if (t.live && t.ms === 2000) {
          t.live = false;
          t.fn();
        }
    }
    expect(reports).toHaveLength(3);
    expect(logLines.join("\n")).toContain("could not be sent");
  });
});

describe("sign out", () => {
  it("runs the CLI's own sign-out with a fixed argument vector and reports applied on exit 0", async () => {
    const runner = make();
    const out = runner.logout();
    await settle();
    expect(children[0]!.spec.file).toBe("/opt/claude/bin/claude");
    children[0]!.end(0);
    expect(await out).toEqual({ ok: true });
  });
  it("a failing exit is refused failed; a CLI that never ends is killed after a minute", async () => {
    let runner = make();
    let out = runner.logout();
    await settle();
    children[0]!.end(1);
    expect(await out).toEqual({ ok: false, refusal: "failed" });
    runner = make();
    out = runner.logout();
    await settle();
    fire(60_000);
    expect(await out).toEqual({ ok: false, refusal: "failed" });
    expect(children[1]!.killed).toBe(1);
  });
  it("is refused as busy during a sign-in, unsupported off Linux, and failed with no CLI", async () => {
    const runner = await startToLink();
    expect(await runner.logout()).toEqual({ ok: false, refusal: "busy" });
    expect(await make({ platform: "win32" }).logout()).toEqual({ ok: false, refusal: "unsupported" });
    claudePath = undefined;
    expect(await make().logout()).toEqual({ ok: false, refusal: "failed" });
  });
});

describe("only a server the cloud manages runs a sign-in", () => {
  it("a start on a machine that is not managed is refused as unsupported, reported not_managed, and nothing starts", async () => {
    managed = false;
    const runner = make();
    expect(await runner.start(REQ)).toEqual({ ok: false, refusal: "unsupported" });
    expect(reports).toEqual([{ id: REQ, report: { state: "failed", failure_code: "not_managed" } }]);
    expect(children).toEqual([]);
    expect(existsSync(path.join(dir, "login"))).toBe(false);
    expect(existsSync(path.join(dir, "login-cwd"))).toBe(false);
  });
  it("a code command and a sign-out on a machine that is not managed are refused as unsupported, and nothing starts or is fetched", async () => {
    const runner = await startToLink();
    managed = false;
    expect(await runner.code(REQ)).toEqual({ ok: false, refusal: "unsupported" });
    expect(takeCalls).toEqual([]);
    expect(await runner.logout()).toEqual({ ok: false, refusal: "unsupported" });
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(0);
  });
  it("the answer is read on every command: once the machine is managed the same runner starts", async () => {
    managed = false;
    const runner = make();
    expect(await runner.start(REQ)).toEqual({ ok: false, refusal: "unsupported" });
    managed = true;
    const started = runner.start(REQ2);
    await settle();
    expect(children).toHaveLength(1);
    children[0]!.print(BANNER);
    expect(await started).toEqual({ ok: true });
  });
});

describe("the CLI starts in its own fixed empty directory", () => {
  const work = (): string => path.join(dir, "login-cwd");
  it("makes it 0700 when missing", async () => {
    await startToLink();
    const st = lstatSync(work());
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
  });
  it("empties it before each start, without following a link out of it", async () => {
    mkdirSync(work(), { mode: 0o700 });
    const outside = path.join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep"), "x");
    symlinkSync(outside, path.join(work(), "link"));
    writeFileSync(path.join(work(), "left-over"), "x");
    mkdirSync(path.join(work(), "sub"));
    writeFileSync(path.join(work(), "sub", "deep"), "x");
    await startToLink();
    expect(readdirSync(work())).toEqual([]);
    expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("x");
  });
  it("a directory that is wider than 0700, or a link, makes the start fail in fixed words and starts nothing", async () => {
    mkdirSync(work(), { mode: 0o700 });
    chmodSync(work(), 0o755);
    expect(await make().start(REQ)).toEqual({ ok: false, refusal: "failed" });
    expect(reports.at(-1)).toEqual({ id: REQ, report: { state: "failed", failure_code: "start_failed" } });
    expect(children).toEqual([]);
    rmSync(work(), { recursive: true });
    mkdirSync(path.join(dir, "elsewhere"), { mode: 0o700 });
    symlinkSync(path.join(dir, "elsewhere"), work());
    expect(await make().start(REQ2)).toEqual({ ok: false, refusal: "failed" });
    expect(children).toEqual([]);
  });
  it("sign-out starts there too", async () => {
    const out = make().logout();
    await settle();
    expect(children[0]!.spec.cwd).toBe(work());
    children[0]!.end(0);
    expect(await out).toEqual({ ok: true });
  });
});

describe("old sign-in logs are removed when the runner starts", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const old = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const young = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const aged = (file: string, ageMs: number): void => {
    const t = new Date(nowMs - ageMs);
    utimesSync(file, t, t);
  };
  it("takes the logs older than seven days and nothing else", () => {
    const logs = path.join(dir, "login");
    mkdirSync(logs, { mode: 0o700 });
    const upper = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.log";
    for (const name of [`${old}.log`, `${young}.log`, "notes.txt", upper]) writeFileSync(path.join(logs, name), "x", { mode: 0o600 });
    aged(path.join(logs, `${old}.log`), CLAUDE_LOGIN_LOG_KEEP_MS + 60_000);
    aged(path.join(logs, `${young}.log`), CLAUDE_LOGIN_LOG_KEEP_MS - DAY);
    aged(path.join(logs, "notes.txt"), 30 * DAY);
    aged(path.join(logs, upper), 30 * DAY);
    make();
    expect(readdirSync(logs).sort()).toEqual([upper, `${young}.log`, "notes.txt"].sort());
  });
  it("does not follow a link named like a log", () => {
    const logs = path.join(dir, "login");
    mkdirSync(logs, { mode: 0o700 });
    const target = path.join(dir, "target");
    writeFileSync(target, "x");
    aged(target, 30 * DAY);
    symlinkSync(target, path.join(logs, `${old}.log`));
    make();
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(path.join(logs, `${old}.log`)).isSymbolicLink()).toBe(true);
  });
  it("a log directory that is itself a link is left alone", () => {
    const real = path.join(dir, "real-logs");
    mkdirSync(real);
    writeFileSync(path.join(real, `${old}.log`), "x");
    aged(path.join(real, `${old}.log`), 30 * DAY);
    symlinkSync(real, path.join(dir, "login"));
    make();
    expect(existsSync(path.join(real, `${old}.log`))).toBe(true);
  });
  it("a start still works with no log directory yet", async () => {
    make();
    await startToLink();
    expect(readdirSync(path.join(dir, "login"))).toEqual([`${REQ}.log`]);
  });
});
