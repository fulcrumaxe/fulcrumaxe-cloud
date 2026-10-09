import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../../src/cliError.js";
import { runCli } from "../../src/cli.js";
import { attachCommand } from "../../src/commands/attach.js";
import type { CommandContext } from "../../src/context.js";
import type { RunHost } from "../../src/commands/run.js";
import { renderLogRecord } from "../../src/commands/logs.js";
import { takeoverPaneCommand } from "../../src/commands/watchPane.js";
import type { GitCapture } from "../../src/daemon/git.js";
import { itNeedsHostSockets } from "../helpers/needsHostSockets.js";
import { takeoverCommand } from "../../src/engines/claude/takeover.js";
import { recordSession } from "../../src/engines/claude/session.js";
import { ensurePrivateDir, markTakeoverReady, readEntries, socketPath, takeoverState, tmuxDir, writeEntry } from "../../src/watch/layout.js";

const RUN_A = "3f6c1a52-8d0e-4b7a-9c14-0a5e6d2b7f38";
const RUN_B = "9b2e0c11-1111-4222-8333-444455556666";
const SESSION = "7d1c4e90-2b3a-4c5d-8e6f-0a1b2c3d4e5f";
let root: string;
let stateDir: string;
const servers: net.Server[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-a-"));
  stateDir = path.join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
});
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  rmSync(root, { recursive: true, force: true });
});

const listen = (file: string): Promise<void> =>
  new Promise((resolve) => {
    const server = net.createServer();
    servers.push(server);
    server.listen(file, resolve);
  });

/** A private tmux socket directory with a real socket, as a running daemon's tmux leaves it. */
async function privateSocket(): Promise<void> {
  ensurePrivateDir(tmuxDir(stateDir));
  await listen(socketPath(stateDir));
  chmodSync(socketPath(stateDir), 0o600);
}

const entry = (runId: string, started: string, role = "executor", repo = "acme/app") => writeEntry(stateDir, { run_id: runId, role, repo, started });

function rig(over: { sessions?: string[]; ask?: string; foreground?: number | null } = {}) {
  const foreground: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const captured: string[][] = [];
  const capture: GitCapture = async (_command, args) => {
    captured.push([...args]);
    const named = args.find((a) => a.startsWith("=fx-"));
    const live = over.sessions === undefined || named === undefined || over.sessions.includes(named.slice(1));
    return { code: live ? 0 : 1, stdout: "", timedOut: false };
  };
  const out: string[] = [];
  const asked: string[] = [];
  const host = {
    home: "/home/jane",
    platform: "linux" as const,
    signals: {} as RunHost["signals"],
    pid: 1,
    kill: () => true,
    term: "xterm",
    interactive: true,
    ask: async (question: string) => {
      asked.push(question);
      return over.ask ?? "";
    },
    engine: {
      capture,
      foreground: async (command: string, args: readonly string[], env: Record<string, string>) => {
        foreground.push({ command, args: [...args], env });
        return over.foreground === undefined ? 0 : over.foreground;
      },
    },
  } as unknown as RunHost;
  const ctx: CommandContext = { stateDir, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date(), fetchFn: fetch };
  const hooks = { binary: "/bin/tmux", sleep: async () => undefined, waitMs: 40 };
  return { host, ctx, out, foreground, captured, asked, hooks };
}

const flags = (entries: Array<[string, string | true]>): Map<string, string | true> => new Map(entries);

describe("fx-runner attach", () => {
  itNeedsHostSockets("with no argument lists this machine's running jobs: short id, repo, role, started", async () => {
    await privateSocket();
    entry(RUN_A, "2026-10-08T10:00:00.000Z", "executor", "acme/app");
    entry(RUN_B, "2026-10-08T11:00:00.000Z", "code-reviewer", "acme/web");
    const r = rig();
    expect(await attachCommand(flags([]), r.ctx, r.host, r.hooks)).toBe(0);
    expect(r.out[0]).toMatch(/ID .*REPO .*ROLE .*STARTED/);
    expect(r.out[1]).toMatch(/^3f6c1a52 +acme\/app +executor +2026-10-08T10:00:00.000Z$/);
    expect(r.out[2]).toMatch(/^9b2e0c11 +acme\/web +code-reviewer +2026-10-08T11:00:00.000Z$/);
    expect(r.foreground).toEqual([]);
  });

  itNeedsHostSockets("lists nothing for a record whose session is gone (a daemon that died), or when the socket is not private", async () => {
    await privateSocket();
    entry(RUN_A, "2026-10-08T10:00:00.000Z");
    let r = rig({ sessions: [] });
    await attachCommand(flags([]), r.ctx, r.host, r.hooks);
    expect(r.out).toEqual(["No running jobs on this machine."]);
    chmodSync(socketPath(stateDir), 0o666);
    r = rig();
    await attachCommand(flags([]), r.ctx, r.host, r.hooks);
    expect(r.out).toEqual(["No running jobs on this machine."]);
  });

  itNeedsHostSockets("attaches read-only: the tmux client is started with -r, on the private socket, for the right session", async () => {
    await privateSocket();
    entry(RUN_A, "2026-10-08T10:00:00.000Z");
    for (const target of [[["run", "3f6c1a52"]], [["run", RUN_A]], [["run", "3F6C"]], [["latest", true as const]]] as Array<Array<[string, string | true]>>) {
      const r = rig();
      expect(await attachCommand(flags(target), r.ctx, r.host, r.hooks)).toBe(0);
      expect(r.foreground).toHaveLength(1);
      expect(r.foreground[0]!.command).toBe("/bin/tmux");
      expect(r.foreground[0]!.args).toEqual(["-S", socketPath(stateDir), "attach-session", "-r", "-t", "=fx-3f6c1a52"]);
      expect(r.asked).toEqual([]);
      expect(takeoverState(stateDir, RUN_A)).toBe("none");
    }
  });

  itNeedsHostSockets("--latest is the newest job", async () => {
    await privateSocket();
    entry(RUN_A, "2026-10-08T10:00:00.000Z");
    entry(RUN_B, "2026-10-08T11:00:00.000Z");
    const r = rig();
    await attachCommand(flags([["latest", true]]), r.ctx, r.host, r.hooks);
    expect(r.foreground[0]!.args.at(-1)).toBe("=fx-9b2e0c11");
  });

  itNeedsHostSockets("an unknown or finished run exits 2 with the fixed message and attaches to nothing", async () => {
    await privateSocket();
    entry(RUN_A, "2026-10-08T10:00:00.000Z");
    const r = rig({ sessions: [] });
    const err = await attachCommand(flags([["run", "3f6c1a52"]]), r.ctx, r.host, r.hooks).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(2);
    expect((err as CliError).message).toBe("No running job 3f6c1a52 on this machine. See: fx-runner logs 3f6c1a52");
    expect(r.foreground).toEqual([]);
    const odd = await attachCommand(flags([["run", "../x;y"]]), r.ctx, r.host, r.hooks).catch((e: unknown) => e);
    expect((odd as CliError).message).toBe("No running job ???x?y on this machine. See: fx-runner logs ???x?y");
  });

  it("through the command line: exit code 2 and the message on standard error", async () => {
    const r = rig();
    let err = "";
    const code = await runCli({ argv: ["attach", "deadbeef"], home: "/home/jane", stateDirOverride: stateDir, stdout: () => undefined, stderr: (t) => (err += t), host: r.host });
    expect(code).toBe(2);
    expect(err).toBe("fx-runner: No running job deadbeef on this machine. See: fx-runner logs deadbeef\n");
    const bare = await runCli({ argv: ["attach"], home: "/home/jane", stateDirOverride: stateDir, stdout: () => undefined, stderr: () => undefined });
    expect(bare).toBe(1);
  });

  itNeedsHostSockets("a take-over asks the person to type the run's short id, and says what will happen; a wrong answer changes nothing", async () => {
    await privateSocket();
    entry(RUN_A, "2026-10-08T10:00:00.000Z");
    const r = rig({ ask: "nope" });
    const err = await attachCommand(flags([["run", "3f6c1a52"], ["take-over", true]]), r.ctx, r.host, r.hooks).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toContain("stops the agent");
    expect(r.asked[0]).toContain("recorded as taken over");
    expect(r.asked[0]).toContain("no result will be sent");
    expect(r.asked[0]).toContain("Type 3f6c1a52 to confirm");
    expect(takeoverState(stateDir, RUN_A)).toBe("none");
    expect(r.foreground).toEqual([]);
  });

  itNeedsHostSockets("a take-over needs a terminal: with standard input piped, nothing is asked or requested", async () => {
    await privateSocket();
    entry(RUN_A, "2026-10-08T10:00:00.000Z");
    const r = rig({ ask: "3f6c1a52" });
    (r.host as { interactive?: boolean }).interactive = false;
    await expect(attachCommand(flags([["run", "3f6c1a52"], ["take-over", true]]), r.ctx, r.host, r.hooks)).rejects.toThrow(/needs a terminal/);
    expect(r.asked).toEqual([]);
    expect(takeoverState(stateDir, RUN_A)).toBe("none");
  });

  itNeedsHostSockets("a socket owned by another user is never attached to", async () => {
    await privateSocket();
    entry(RUN_A, "2026-10-08T10:00:00.000Z");
    const r = rig();
    (r.host as { uid?: number }).uid = process.getuid!() + 1;
    await attachCommand(flags([]), r.ctx, r.host, r.hooks);
    expect(r.out).toEqual(["No running jobs on this machine."]);
  });

  itNeedsHostSockets("a confirmed take-over files the request, waits for the daemon's go-ahead, then attaches read-write (no -r)", async () => {
    await privateSocket();
    entry(RUN_A, "2026-10-08T10:00:00.000Z");
    const r = rig({ ask: "3F6C1A52" });
    let polls = 0;
    const hooks = {
      ...r.hooks,
      sleep: async () => {
        // The daemon, a few polls later: the agent is stopped, the take-over recorded, the pane swapped.
        if (++polls === 3) {
          expect(takeoverState(stateDir, RUN_A)).toBe("requested");
          markTakeoverReady(stateDir, RUN_A);
        }
      },
      waitMs: 60_000,
    };
    expect(await attachCommand(flags([["run", "3f6c1a52"], ["take-over", true]]), r.ctx, r.host, hooks)).toBe(0);
    expect(r.foreground).toHaveLength(1);
    expect(r.foreground[0]!.args).toEqual(["-S", socketPath(stateDir), "attach-session", "-t", "=fx-3f6c1a52"]);
    expect(takeoverState(stateDir, RUN_A)).toBe("none");
  });

  itNeedsHostSockets("a daemon that never answers ends the wait with a plain message, and nothing is attached", async () => {
    await privateSocket();
    entry(RUN_A, "2026-10-08T10:00:00.000Z");
    const r = rig({ ask: "3f6c1a52" });
    const err = await attachCommand(flags([["run", "3f6c1a52"], ["take-over", true]]), r.ctx, r.host, r.hooks).catch((e: unknown) => e);
    expect((err as CliError).message).toContain("did not hand the session over in time");
    expect(r.foreground).toEqual([]);
  });

  itNeedsHostSockets("--take-over needs a target; a second request for the same job is refused", async () => {
    await privateSocket();
    entry(RUN_A, "2026-10-08T10:00:00.000Z");
    const r = rig({ ask: "3f6c1a52" });
    await expect(attachCommand(flags([["take-over", true]]), r.ctx, r.host, r.hooks)).rejects.toMatchObject({ exitCode: 2 });
    writeFileSync(path.join(stateDir, "watch", `${RUN_A}.takeover`), "requested\n");
    await expect(attachCommand(flags([["run", "3f6c1a52"], ["take-over", true]]), r.ctx, r.host, r.hooks)).rejects.toThrow(/already under way/);
  });

  itNeedsHostSockets("a job already handed over is not listed or attached as a running job", async () => {
    await privateSocket();
    writeEntry(stateDir, { run_id: RUN_A, role: "executor", repo: "acme/app", started: "2026-10-08T10:00:00.000Z", taken_over: true });
    const r = rig();
    await attachCommand(flags([]), r.ctx, r.host, r.hooks);
    expect(r.out).toEqual(["No running jobs on this machine."]);
  });
});

describe("the transcript a watch pane renders (the renderer of `fx-runner logs`)", () => {
  const line = (message: unknown, kind = "stdout") => JSON.stringify({ kind, line: typeof message === "string" ? message : JSON.stringify(message) });

  it("shows the assistant's text, its tool uses and the end; nothing for a damaged line or a kind that is not shown", () => {
    const shown = renderLogRecord(RUN_A, line({ type: "assistant", message: { content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }] } }));
    expect(shown[0]).toBe("assistant: hello");
    expect(shown).toContain("  tool: command echo hi");
    expect(renderLogRecord(RUN_A, line("stderr text", "stderr"))).toEqual(["stderr: stderr text"]);
    expect(renderLogRecord(RUN_A, line("x", "other"))).toEqual([]);
    expect(renderLogRecord(RUN_A, "not json")).toEqual([]);
  });

  it("drops control characters, so a transcript cannot move the cursor or set the terminal's title", () => {
    const esc = String.fromCharCode(27);
    const shown = renderLogRecord(RUN_A, line({ type: "assistant", message: { content: [{ type: "text", text: `a${esc}]0;owned${String.fromCharCode(7)}b${esc}[2Jc` }] } }));
    expect(shown).toEqual(["assistant: a]0;ownedb[2Jc"]);
    expect(shown.join("")).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });
});

describe("the interactive resume of a taken-over run", () => {
  async function jobFiles(logLines: string[]): Promise<string> {
    const workspace = path.join(root, "work", RUN_A);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(path.join(stateDir, "jobs", RUN_A), { recursive: true });
    mkdirSync(path.join(stateDir, "logs"), { recursive: true });
    writeFileSync(path.join(stateDir, "jobs", RUN_A, "settings.json"), "{}");
    writeFileSync(path.join(stateDir, "jobs", RUN_A, "mcp.json"), "{}");
    writeFileSync(path.join(stateDir, "logs", `${RUN_A}.jsonl`), logLines.join("\n") + "\n");
    await recordSession(path.join(stateDir, "sessions.json"), SESSION, workspace);
    return workspace;
  }
  const init = JSON.stringify({ kind: "stdout", line: JSON.stringify({ type: "system", subtype: "init", session_id: SESSION }) });

  it("resumes the session in its workspace, with the job's own settings, MCP file and tools, interactive and asking for approval", async () => {
    const workspace = await jobFiles([JSON.stringify({ kind: "meta", line: "{}" }), init]);
    const { argv, cwd } = takeoverCommand({ stateDir, runId: RUN_A, role: "executor" });
    expect(cwd).toBe(workspace);
    expect(argv).toEqual([
      "--resume", SESSION,
      "--setting-sources", "",
      "--settings", path.join(stateDir, "jobs", RUN_A, "settings.json"),
      "--strict-mcp-config",
      "--mcp-config", path.join(stateDir, "jobs", RUN_A, "mcp.json"),
      "--tools", expect.stringMatching(/^[A-Za-z,]+$/),
      "--disallowedTools", "WebFetch", "WebSearch",
      "--disable-slash-commands",
      "--permission-mode", "default",
    ]);
    expect(argv).not.toContain("-p");
    expect(argv).not.toContain("--permission-prompts");
    expect(argv).not.toContain("--dangerously-skip-permissions");
  });

  it("refuses a run with no session, no job files or no workspace left", async () => {
    await jobFiles([init]);
    expect(() => takeoverCommand({ stateDir, runId: RUN_B, role: "executor" })).toThrow();
    rmSync(path.join(root, "work"), { recursive: true });
    expect(() => takeoverCommand({ stateDir, runId: RUN_A, role: "executor" })).toThrow(/workspace is gone/);
    writeFileSync(path.join(stateDir, "logs", `${RUN_A}.jsonl`), "");
    expect(() => takeoverCommand({ stateDir, runId: RUN_A, role: "executor" })).toThrow(/no session/);
  });

  it("a session id that could pass as a flag is never used", async () => {
    await jobFiles([JSON.stringify({ kind: "stdout", line: JSON.stringify({ session_id: "--dangerously-skip-permissions" }) })]);
    expect(() => takeoverCommand({ stateDir, runId: RUN_A, role: "executor" })).toThrow(/no session/);
  });
});

describe("the take-over pane command", () => {
  it("refuses a run that was not handed over, and one that is not a run id", async () => {
    const r = rig();
    entry(RUN_A, "2026-10-08T10:00:00.000Z");
    await expect(takeoverPaneCommand(flags([["run", RUN_A]]), r.ctx, r.host)).rejects.toThrow(/not handed over/);
    await expect(takeoverPaneCommand(flags([["run", "nope"]]), r.ctx, r.host)).rejects.toMatchObject({ exitCode: 2 });
    expect(existsSync(path.join(stateDir, "watch", `${RUN_A}.json`))).toBe(true);
  });

  it("is not reachable without the program's host facts", async () => {
    let err = "";
    expect(await runCli({ argv: ["__takeover", RUN_A], home: "/h", stateDirOverride: stateDir, stdout: () => undefined, stderr: (t) => (err += t) })).toBe(1);
    expect(err).toContain("only available");
    expect(readEntries(stateDir)).toEqual([]);
  });
});
