/**
 * D#845 MC-8b: the Claude sign-in on a managed server, run for the cloud's `claude_login_start`, `claude_login_code` and `claude_logout` machine commands.
 *
 * One sign-in at a time. The CLI's own sign-in command is started inside util-linux `script` (a pty) with a fixed argument vector: the command line is one constant string, nothing is interpolated into
 * it, and the code the person types never goes anywhere near an argument vector. The CLI prints a link and then waits at a prompt. The runner reports the link, once it passes the protocol's pattern, and
 * the cloud shows it to the person. When the person types the code on the cloud, the cloud sends `claude_login_code`; the runner takes the code from the cloud once (a second fetch is 410), writes it to the
 * CLI's standard input and waits for the CLI to say it signed in. It then reports `done` or `failed`. The credential the CLI saves stays on this machine and is never read here.
 *
 * What is kept: everything the CLI prints up to the moment the code is written goes to a 0600 log (at most 1 MiB) under the state directory, and only a link that passes the pattern leaves the machine.
 * A pty echoes what is typed into it, so once the code is written the CLI's output is only matched in memory against two fixed phrases and is never written to the log, to a report or to the journal. The code is
 * held in one local until it is written and is never put in a message, a log line, a report, an argument or a file. A failure is reported as a short fixed word, never as text the CLI printed.
 *
 * Linux only: it serves the servers the cloud creates. Any other platform refuses the start and says so to the cloud, as does a start that cannot go ahead (busy, no CLI, a log that cannot be opened):
 * the request is reported `failed` at once instead of waiting for it to expire.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { CLAUDE_AUTH_ORIGIN, CLAUDE_AUTH_URL_PATTERN, type MachineCommandAck, type MachineLoginReport } from "@fulcrumaxe/runner-protocol";

/** The name the CLI is resolved by, from the child's search path. Production always uses it; only a test hands the host another name (a stand-in whose name is not the real CLI's). */
export const CLAUDE_CLI_NAME = "claude";
/** The command for a CLI name: one string the caller controls, never the person's input. */
export const loginCommandFor = (cliName: string = CLAUDE_CLI_NAME): string => `${cliName} auth login --claudeai`;
/** The pty arguments for a CLI name: `script -q -e -c <command> /dev/null` (`-e` returns the command's exit status). */
export const loginArgsFor = (cliName: string = CLAUDE_CLI_NAME): readonly string[] => Object.freeze(["-q", "-e", "-c", loginCommandFor(cliName), "/dev/null"]);
/** The one command, as one constant string (the spike's command, Ruling 52.10). */
export const CLAUDE_LOGIN_COMMAND = loginCommandFor();
/** The pty arguments for the production name. */
export const CLAUDE_LOGIN_ARGS: readonly string[] = loginArgsFor();
export const CLAUDE_LOGOUT_ARGS: readonly string[] = Object.freeze(["auth", "logout"]);
/** The whole sign-in, from the start to the end of it. */
export const CLAUDE_LOGIN_LIMIT_MS = 10 * 60 * 1000;
/** How long the CLI has to print its link. */
export const CLAUDE_LINK_LIMIT_MS = 60 * 1000;
export const CLAUDE_LOGOUT_LIMIT_MS = 60 * 1000;
export const CLAUDE_LOGIN_LOG_MAX_BYTES = 1_048_576;
/** The directory under the state directory that holds the logs. */
export const CLAUDE_LOGIN_LOG_DIR = "login";
/** A sign-in log older than this is removed when the runner starts. */
export const CLAUDE_LOGIN_LOG_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The directory under the state directory the CLI is started in: fixed, 0700, and emptied before each start. */
export const CLAUDE_LOGIN_CWD_DIR = "login-cwd";
/** After the first signal the child's tree has this long to go before everything left is killed. */
export const CLAUDE_KILL_GRACE_MS = 1500;
const REPORT_ATTEMPTS = 3;
const REPORT_RETRY_MS = 2000;
const TAIL_MAX = 8192;
const SUCCESS_PHRASE = "Login successful.";
const REFUSED_PHRASE = "Invalid code";
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One process below the one we started, as the entry point's process table reads it. `start` tells a reused pid from the process that was seen. */
export interface LoginProc {
  pid: number;
  pgid: number;
  start: string;
}
/** What the kill needs from the machine; the entry point reads the process table and sends the signals, so this file names neither. */
export interface LoginKillPorts {
  /** Signals a process (positive) or a whole process group (negative). A target that is already gone is not an error. */
  signal(target: number, sig: "SIGTERM" | "SIGKILL"): void;
  /** Every process below `root`, however deep (children, their children), with its process group and start time. */
  below(root: number): LoginProc[];
  /** The process now at `pid`, or undefined when there is none. */
  look(pid: number): LoginProc | undefined;
  after(ms: number, fn: () => void): void;
}

/**
 * Ends a sign-in's process tree. `script` is the leader of the process group we started, but it starts the command it runs in a NEW session on the pty, so a signal to `script`'s group never
 * reaches the CLI. So: the tree below `script` is read first (the CLI's own session and group are among it), SIGTERM goes to `script`'s group (it passes the signal on) and to each of those groups,
 * and after a short grace SIGKILL goes to every group and every process of the tree that is still the same process (checked by its start time, so a reused pid is never signalled).
 */
export function killLoginTree(ports: LoginKillPorts, rootPid: number, graceMs: number = CLAUDE_KILL_GRACE_MS): void {
  const known = new Map<number, LoginProc>();
  const remember = (): void => {
    for (const p of ports.below(rootPid)) if (!known.has(p.pid)) known.set(p.pid, p);
  };
  const groups = (): Set<number> => new Set([...known.values()].map((p) => p.pgid).filter((g) => g > 1 && g !== rootPid));
  const rootStart = ports.look(rootPid)?.start;
  remember();
  ports.signal(-rootPid, "SIGTERM");
  for (const g of groups()) ports.signal(-g, "SIGTERM");
  ports.after(graceMs, () => {
    remember();
    // `script`'s own group, unless its pid has since gone to another process (a group that still has members keeps its number, so a pid that is gone is still this group's).
    const rootNow = ports.look(rootPid);
    if (rootNow === undefined || rootNow.start === rootStart) ports.signal(-rootPid, "SIGKILL");
    for (const p of known.values()) {
      const now = ports.look(p.pid);
      if (now === undefined || now.start !== p.start) continue;
      if (now.pgid > 1 && now.pgid !== rootPid) ports.signal(-now.pgid, "SIGKILL");
      ports.signal(p.pid, "SIGKILL");
    }
  });
}

/** The process table, read through two ports the entry point fills (the stat file of a pid, and the pids there are), so this file names no path. */
export function readProcessTable(read: { pids(): number[]; stat(pid: number): string | undefined }): Pick<LoginKillPorts, "below" | "look"> {
  // The name (field 2) may hold spaces and brackets, so the fields are counted after its closing bracket: state, ppid, pgrp, session, ... start time is the 20th of them (field 22 of the line).
  const one = (pid: number): (LoginProc & { ppid: number }) | undefined => {
    const text = read.stat(pid);
    if (text === undefined) return undefined;
    const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(rest[1]);
    const pgid = Number(rest[2]);
    const start = rest[19];
    return Number.isSafeInteger(ppid) && Number.isSafeInteger(pgid) && start !== undefined && start !== "" ? { pid, ppid, pgid, start } : undefined;
  };
  return {
    look: (pid) => {
      const p = one(pid);
      return p === undefined ? undefined : { pid: p.pid, pgid: p.pgid, start: p.start };
    },
    below: (root) => {
      const kids = new Map<number, Array<LoginProc & { ppid: number }>>();
      for (const pid of read.pids()) {
        const p = one(pid);
        if (p !== undefined) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
      }
      const out: LoginProc[] = [];
      const queue = [root];
      for (let next = queue.shift(); next !== undefined && out.length < 256; next = queue.shift()) {
        for (const p of kids.get(next) ?? []) {
          out.push({ pid: p.pid, pgid: p.pgid, start: p.start });
          queue.push(p.pid);
        }
      }
      return out;
    },
  };
}

/** What the entry point starts: no shell, an environment from a fixed allowlist, the leader of its own process group. */
export interface LoginSpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface LoginChild {
  write(text: string): void;
  onOutput(cb: (text: string) => void): void;
  /** Called once, with the exit status, or `null` for a start that failed or a signal. */
  onExit(cb: (code: number | null) => void): void;
  /** Ends the child and everything it started (see `killLoginTree`). */
  kill(): void;
}
export interface ClaudeLoginHost {
  launch(spec: LoginSpawnSpec): LoginChild;
  /** The absolute path of the installed CLI, or undefined when there is none. */
  locateClaude(): string | undefined;
  /** The name the sign-in command runs the CLI by (looked up on the child's search path). Absent in production, where it is the CLI's own name; a test names a stand-in. */
  cliName?: string;
  /** The fixed-allowlist environment (no credential, no `BROWSER`, no `DISPLAY`); `PATH` is extended here with the CLI's own directory. */
  env(): Record<string, string>;
}

export type CodeResult = { kind: "code"; code: string } | { kind: "gone" } | { kind: "error" };
export type ReportResult = { kind: "recorded" } | { kind: "refused"; status: number } | { kind: "error" };
/** The runner's two calls on one request; the cloud's own answers are described in `MachineLoginReport`. */
export interface LoginCloud {
  report(requestId: string, report: MachineLoginReport): Promise<ReportResult>;
  takeCode(requestId: string): Promise<CodeResult>;
}

export type Refusal = NonNullable<MachineCommandAck["refusal"]>;
export type Outcome = { ok: true } | { ok: false; refusal: Refusal };

export interface ClaudeLoginRunner {
  start(requestId: string): Promise<Outcome>;
  code(requestId: string): Promise<Outcome>;
  logout(): Promise<Outcome>;
  /** Resolves when no sign-in is running (tests, and a stopping daemon). */
  idle(): Promise<void>;
}

interface Session {
  requestId: string;
  child: LoginChild;
  logFd: number | undefined;
  logBytes: number;
  /** Complete lines are matched; the unfinished last one waits for its newline. */
  pending: string;
  tail: string;
  linkReported: boolean;
  codeWritten: boolean;
  sawSuccess: boolean;
  finished: boolean;
  cancel: Array<() => void>;
  settleStart: (outcome: Outcome) => void;
}

/** The text with terminal control sequences and carriage returns taken out, so a line can be matched. */
const CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g;
const clean = (text: string): string => text.replace(CONTROL, "");

/** A link on a complete line: `valid` when it passes the pattern and the one sign-in origin, `bad` when a link-shaped word is there and does not. */
export function findLink(line: string): { kind: "valid"; url: string } | { kind: "bad" } | undefined {
  const found = line.match(/https?:\/\/\S+/);
  if (found === null) return undefined;
  const url = found[0];
  if (!CLAUDE_AUTH_URL_PATTERN.test(url)) return { kind: "bad" };
  try {
    return new URL(url).origin === CLAUDE_AUTH_ORIGIN ? { kind: "valid", url } : { kind: "bad" };
  } catch {
    // fx-swallow-ok: a link that does not parse is a bad link, in fixed words
    return { kind: "bad" };
  }
}

function openLog(dir: string, requestId: string, uid: number | undefined): number {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const st = lstatSync(dir);
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) throw new Error("the sign-in log directory is not safe");
  const fd = openSync(path.join(dir, `${requestId}.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error("the sign-in log is not a file");
  }
  return fd;
}

/** The fixed directory the CLI starts in: made 0700 when it is missing, checked (a directory, ours, 0700) and emptied; anything in it is removed without following a link. */
function prepareWorkDir(dir: string, uid: number | undefined): string {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const st = lstatSync(dir);
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) throw new Error("the sign-in working directory is not safe");
  for (const name of readdirSync(dir)) rmSync(path.join(dir, name), { recursive: true, force: true });
  return dir;
}

const LOG_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/;

/** Removes the sign-in logs older than the keep time. Only plain files named like a request's log are touched; the directory itself must be a real directory. Returns how many went. */
export function pruneLoginLogs(dir: string, nowMs: number): number {
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined || !st.isDirectory()) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!LOG_NAME.test(name)) continue;
    const file = path.join(dir, name);
    const f = lstatSync(file, { throwIfNoEntry: false });
    if (f === undefined || !f.isFile() || f.mtimeMs > nowMs - CLAUDE_LOGIN_LOG_KEEP_MS) continue;
    unlinkSync(file);
    removed++;
  }
  return removed;
}

export function createClaudeLoginRunner(config: {
  host: ClaudeLoginHost | undefined;
  platform: NodeJS.Platform;
  cloud: LoginCloud;
  stateDir: string;
  uid?: number | undefined;
  /** Whether this machine is a server the cloud manages (the install path's own marker). Sign-in commands run only then; anywhere else each is refused as unsupported. */
  managed: () => boolean;
  /** The clock, in ms (the log prune). */
  now?: () => number;
  /** Calls `fn` after `ms`; returns a function that cancels it. */
  after: (ms: number, fn: () => void) => () => void;
  log: (line: string) => void;
}): ClaudeLoginRunner {
  let active: Session | undefined;
  let ending: Promise<void> = Promise.resolve();
  let loggingOut = false;
  const logDir = path.join(config.stateDir, CLAUDE_LOGIN_LOG_DIR);
  const workDir = path.join(config.stateDir, CLAUDE_LOGIN_CWD_DIR);
  try {
    pruneLoginLogs(logDir, (config.now ?? Date.now)());
  } catch {
    // fx-swallow-ok: a log that cannot be removed stays; the next start tries again
    config.log("fx-runner: old sign-in logs could not be removed");
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => void config.after(ms, resolve));

  /** Writes to the 0600 log until the cap; nothing else ever receives the CLI's text. */
  const logLine = (s: Session, text: string): void => {
    if (s.logFd === undefined || s.logBytes >= CLAUDE_LOGIN_LOG_MAX_BYTES) return;
    const room = CLAUDE_LOGIN_LOG_MAX_BYTES - s.logBytes;
    const chunk = Buffer.from(text, "utf8").subarray(0, room);
    try {
      writeSync(s.logFd, chunk);
      s.logBytes += chunk.length;
    } catch {
      // fx-swallow-ok: a log that cannot be written is dropped; the sign-in itself goes on
      s.logFd = undefined;
    }
  };

  /** One report, with a short retry for a network failure only. A refusal (the request is over, 409 or 404) is final and never changes the outcome on this machine. */
  const reportOnce = async (requestId: string, report: MachineLoginReport): Promise<ReportResult> => {
    let last: ReportResult = { kind: "error" };
    for (let attempt = 0; attempt < REPORT_ATTEMPTS; attempt++) {
      last = await config.cloud.report(requestId, report);
      if (last.kind !== "error") return last;
      if (attempt < REPORT_ATTEMPTS - 1) await sleep(REPORT_RETRY_MS);
    }
    return last;
  };

  /** Ends a session once: stops the child and the timers, closes the log, says how it ended (unless that is already known to the cloud) and lets the start command settle. */
  const finish = (s: Session, how: { state: "done" } | { state: "failed"; code: string }): Promise<void> => {
    if (s.finished) return Promise.resolve();
    s.finished = true;
    for (const cancel of s.cancel) cancel();
    s.child.kill();
    logLine(s, `\n[fx-runner] sign-in ended: ${how.state}${how.state === "failed" ? ` (${how.code})` : ""}\n`);
    if (s.logFd !== undefined) {
      try {
        closeSync(s.logFd);
      } catch {
        // fx-swallow-ok: a log that is already closed needs nothing more
      }
      s.logFd = undefined;
    }
    if (active === s) active = undefined;
    // A start still waiting for its link is answered here: the sign-in never got that far.
    s.settleStart({ ok: false, refusal: "failed" });
    const done = reportOnce(s.requestId, how.state === "done" ? { state: "done" } : { state: "failed", failure_code: how.code }).then((r) => {
      // A late `done` (409: the request expired or was cancelled while the code was being typed) is not an error here: the machine is signed in, and the cloud derives the card's state from the machine itself.
      if (r.kind === "refused") config.log(`fx-runner: the cloud no longer takes a report for this sign-in (${r.status})`);
      else if (r.kind === "error") config.log("fx-runner: the sign-in report could not be sent");
    });
    ending = ending.then(() => done);
    return done;
  };

  const onText = (s: Session, text: string): void => {
    if (s.finished) return;
    if (!s.codeWritten) {
      // Everything the CLI prints before the code exists is the log's.
      logLine(s, text);
      s.pending += clean(text);
      let nl = s.pending.indexOf("\n");
      while (nl >= 0 && !s.linkReported) {
        const line = s.pending.slice(0, nl);
        s.pending = s.pending.slice(nl + 1);
        const link = findLink(line);
        if (link?.kind === "bad") {
          void finish(s, { state: "failed", code: "bad_link" });
          return;
        }
        if (link?.kind === "valid") {
          s.linkReported = true;
          void reportLink(s, link.url);
          return;
        }
        nl = s.pending.indexOf("\n");
      }
      if (s.pending.length > TAIL_MAX) s.pending = s.pending.slice(-TAIL_MAX);
      return;
    }
    // After the code: only two fixed phrases are looked for, in memory, and nothing the CLI prints is kept.
    s.tail = (s.tail + clean(text)).slice(-TAIL_MAX);
    if (s.tail.includes(SUCCESS_PHRASE)) s.sawSuccess = true;
    else if (s.tail.includes(REFUSED_PHRASE)) void finish(s, { state: "failed", code: "invalid_code" });
  };

  const reportLink = async (s: Session, url: string): Promise<void> => {
    const r = await reportOnce(s.requestId, { state: "awaiting_code", auth_url: url });
    if (r.kind === "recorded") {
      s.settleStart({ ok: true });
      return;
    }
    // The cloud would not take the link (it is over, or unreachable): nobody can type a code for it, so the sign-in ends here. Reporting again would only be refused too.
    await finish(s, { state: "failed", code: r.kind === "refused" ? "link_refused" : "link_unsent" });
  };

  const onExit = (s: Session, code: number | null): void => {
    if (s.finished) return;
    if (!s.linkReported) void finish(s, { state: "failed", code: "no_link" });
    else if (!s.codeWritten) void finish(s, { state: "failed", code: "exited_early" });
    else if (code === 0 && s.sawSuccess) void finish(s, { state: "done" });
    else void finish(s, { state: "failed", code: s.tail.includes(REFUSED_PHRASE) ? "invalid_code" : "login_failed" });
  };

  /** A start that cannot go ahead: the request is reported failed now, so the person sees why instead of waiting for it to expire. */
  const refuseStart = async (requestId: string, failureCode: string, refusal: Refusal): Promise<Outcome> => {
    await reportOnce(requestId, { state: "failed", failure_code: failureCode });
    return { ok: false, refusal };
  };

  return {
    async start(requestId) {
      if (!UUID_LOWER.test(requestId)) return { ok: false, refusal: "failed" };
      if (config.platform !== "linux" || config.host === undefined) return await refuseStart(requestId, "unsupported_platform", "unsupported");
      if (!config.managed()) return await refuseStart(requestId, "not_managed", "unsupported");
      if (active !== undefined || loggingOut) return await refuseStart(requestId, "busy", "busy");
      const claude = config.host.locateClaude();
      if (claude === undefined) return await refuseStart(requestId, "claude_missing", "failed");
      let logFd: number;
      try {
        logFd = openLog(logDir, requestId, config.uid);
      } catch (error) {
        // fx-swallow-ok: a log that cannot be opened is a start that does not go ahead; an existing one means this request was already started here (no report: it is already known)
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, refusal: "failed" };
        return await refuseStart(requestId, "log_unwritable", "failed");
      }
      const env = { ...config.host.env(), PATH: `${path.dirname(claude)}:${config.host.env()["PATH"] ?? ""}` };
      let child: LoginChild;
      try {
        child = config.host.launch({ file: "script", args: [...loginArgsFor(config.host.cliName)], cwd: prepareWorkDir(workDir, config.uid), env });
      } catch {
        // fx-swallow-ok: a start that throws (or a working directory that is not safe) is reported in fixed words
        closeSync(logFd);
        return await refuseStart(requestId, "start_failed", "failed");
      }
      return await new Promise<Outcome>((settleStart) => {
        const s: Session = { requestId, child, logFd, logBytes: 0, pending: "", tail: "", linkReported: false, codeWritten: false, sawSuccess: false, finished: false, cancel: [], settleStart };
        active = s;
        s.cancel.push(
          config.after(CLAUDE_LINK_LIMIT_MS, () => {
            if (!s.linkReported) void finish(s, { state: "failed", code: "no_link" });
          }),
        );
        s.cancel.push(config.after(CLAUDE_LOGIN_LIMIT_MS, () => void finish(s, { state: "failed", code: "timeout" })));
        child.onOutput((text) => onText(s, text));
        child.onExit((code) => onExit(s, code));
      });
    },

    async code(requestId) {
      if (!config.managed()) return { ok: false, refusal: "unsupported" };
      const s = active;
      if (s === undefined || s.requestId !== requestId || !s.linkReported || s.codeWritten || s.finished) return { ok: false, refusal: "failed" };
      // Marked before the fetch so a second command for the same request cannot take a second code.
      s.codeWritten = true;
      const taken = await config.cloud.takeCode(requestId);
      if (taken.kind !== "code") {
        // 410 is a code that is not there any more (late, taken, or the request is over); an error leaves it unknown whether the cloud gave it up. Both end the sign-in: fail closed.
        await finish(s, { state: "failed", code: taken.kind === "gone" ? "code_gone" : "code_fetch_failed" });
        return { ok: false, refusal: "failed" };
      }
      if (s.finished) return { ok: false, refusal: "failed" };
      logLine(s, "\n[fx-runner] the code was written; the CLI's output is no longer kept\n");
      s.child.write(`${taken.code}\r`);
      return { ok: true };
    },

    async logout() {
      if (config.platform !== "linux" || config.host === undefined || !config.managed()) return { ok: false, refusal: "unsupported" };
      if (active !== undefined || loggingOut) return { ok: false, refusal: "busy" };
      const claude = config.host.locateClaude();
      if (claude === undefined) return { ok: false, refusal: "failed" };
      loggingOut = true;
      try {
        const env = { ...config.host.env(), PATH: `${path.dirname(claude)}:${config.host.env()["PATH"] ?? ""}` };
        let child: LoginChild;
        try {
          child = config.host.launch({ file: claude, args: [...CLAUDE_LOGOUT_ARGS], cwd: prepareWorkDir(workDir, config.uid), env });
        } catch {
          // fx-swallow-ok: a start that throws (or a working directory that is not safe) is a failed sign-out, in fixed words
          return { ok: false, refusal: "failed" };
        }
        child.onOutput(() => undefined);
        return await new Promise<Outcome>((resolve) => {
          const cancel = config.after(CLAUDE_LOGOUT_LIMIT_MS, () => {
            child.kill();
            resolve({ ok: false, refusal: "failed" });
          });
          child.onExit((code) => {
            cancel();
            resolve(code === 0 ? { ok: true } : { ok: false, refusal: "failed" });
          });
        });
      } finally {
        loggingOut = false;
      }
    },

    async idle() {
      await ending;
    },
  };
}
