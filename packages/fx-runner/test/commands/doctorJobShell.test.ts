import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCommand, type DoctorHost } from "../../src/commands/doctor.js";
import type { CommandContext } from "../../src/context.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { createSandboxHost } from "../../src/sandbox/probeHost.js";
import type { SandboxHost } from "../../src/sandbox/probe.js";
import { bwrapCanCreateNamespaces } from "../helpers/bwrapProbe.js";
import { findOnPath } from "../helpers/findOnPath.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#6 C44-2: doctor's "Job shell" lines. Every shell here is the real bash -l, started with the clean environment in a throwaway HOME made with mkdtemp.
 * Nothing reads or writes the real home directory (the real rc file carries a hotfix that would hide the very bug these tests need).
 */
const HOST_PATH = process.env.PATH ?? "";
const bash = findOnPath("bash", HOST_PATH);
const realBwrap = findOnPath("bwrap", HOST_PATH);
const realSocat = findOnPath("socat", HOST_PATH);

// Each case starts several real processes (the CLI kit's version probe, the sandbox probe, two shells); a loaded machine needs more than the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

let root: string;
let home: string;
let tools: string;
let toolbin: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpRoot(), "c442-"));
  home = path.join(root, "home");
  mkdirSync(path.join(home, "default-bin"), { recursive: true });
  // node and pnpm exist only here, which only the runner's PATH reaches.
  tools = path.join(root, "tools");
  mkdirSync(tools);
  for (const name of ["node", "pnpm"]) writeScript(path.join(tools, name), `#!/bin/sh\necho ${name}-fake\n`);
  toolbin = path.join(root, "toolbin");
  mkdirSync(toolbin);
  vi.stubEnv("PATH", `${tools}:${toolbin}:${HOST_PATH}`);
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
  // The runner copies this marker into a job's environment only when its own environment has it (cleanEnv, LOGIN_SHELL_MARKERS), and without it the NixOS system profile replaces PATH wholesale.
  // A desktop session has the marker and a systemd service unit does not, so set it here: the cases below are about the rc files in the throwaway HOME, not about the host's system profile.
  // The resetting rc files unset it themselves, which is the case they exist to show.
  vi.stubEnv("__NIXOS_SET_ENVIRONMENT_DONE", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function writeScript(file: string, text: string): void {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

/** The rc files of a machine whose start-up resets PATH the NixOS way (as in the C44-1 test): unset the marker, source /etc/profile if there is one, then reset PATH. */
function resettingRc(extra = ""): void {
  const rc = ["unset __NIXOS_SET_ENVIRONMENT_DONE", "[ -r /etc/profile ] && . /etc/profile", 'PATH="$HOME/default-bin"', "export PATH", extra, ""].join("\n");
  writeFileSync(path.join(home, ".bashrc"), rc);
  writeFileSync(path.join(home, ".profile"), '. "$HOME/.bashrc"\n');
}
function cleanRc(): void {
  writeFileSync(path.join(home, ".bashrc"), "# nothing that touches PATH\n");
  writeFileSync(path.join(home, ".profile"), '. "$HOME/.bashrc"\n');
}
/** A start-up file that replaces the shell: it runs only the last line of the command (the check) in a new shell with a PATH of its own, so no line put in front of the command can apply. */
const EXEC_RC = 'PATH="$HOME/default-bin" exec "$BASH" --noprofile --norc -c "${BASH_EXECUTION_STRING##*$\'\\n\'}"';

/** A host whose process start is the real shell-less capture. With `unwrap`, the sandbox tool is skipped and the command after `--` runs directly (the rc files are then read from HOME as they are). */
function realHost(unwrap: boolean): SandboxHost & { calls: string[][] } {
  const inner = createSandboxHost(createClaudeKit(spawn).captureWithStderr);
  const calls: string[][] = [];
  return {
    ...inner,
    calls,
    run: (command, args, env, timeoutMs) => {
      calls.push([command, ...args]);
      if (!unwrap) return inner.run(command, args, env, timeoutMs);
      const cut = args.indexOf("--");
      return inner.run(args[cut + 1]!, args.slice(cut + 2), env, timeoutMs);
    },
  };
}

async function doctorLines(sandbox: SandboxHost, over: Partial<DoctorHost> = {}): Promise<string[]> {
  const lines: string[] = [];
  const ctx: CommandContext = { stateDir: path.join(root, "state"), uid: process.getuid?.(), out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => new Date(), fetchFn: (async () => new Response("", { status: 200 })) as typeof fetch };
  await doctorCommand(ctx, { platform: "linux", shellVars: [], engine: createClaudeKit(spawn), home, shell: bash, sandbox, ...over });
  return lines;
}
const shellLines = (lines: string[]): string[] => lines.filter((line) => line.includes("Job shell"));
const levelOf = (lines: string[], label: string): string | undefined => lines.find((line) => line.includes(`${label}:`))?.slice(0, 4).trim();

describe.skipIf(bash === undefined)("C44-2: the Job shell lines, with the real bash -l in a throwaway HOME", () => {
  beforeEach(() => {
    // The tool search of the sandbox probe wants the two tools on the path; the unwrapped host never runs them.
    for (const name of ["bwrap", "socat"]) writeScript(path.join(toolbin, name), "#!/bin/sh\n");
  });

  it("criterion 1: a start-up file that resets PATH is a WARN for the plain run and a PASS for the run with the env file; the runner PATH line keeps its own label", async () => {
    resettingRc();
    const lines = await doctorLines(realHost(true));
    expect(levelOf(lines, "Job shell")).toBe("WARN");
    expect(lines.join("\n")).toContain("your shell start-up files reset PATH inside jobs; fx-runner restores it");
    expect(levelOf(lines, "Job shell env")).toBe("PASS");
    expect(lines.join("\n")).toMatch(/Job shell env:\s+with the job's env file: node found at \/.*\/node, pnpm found/);
    expect(levelOf(lines, "Runner PATH")).toBe("INFO");
    expect(lines.join("\n")).toMatch(/Runner PATH:\s+found node/);
    expect(lines.join("\n")).not.toContain("Toolchain:");
  });

  it("criterion 2: a start-up file that replaces the shell after the env file could apply is a FAIL naming the PATH the job shell saw", async () => {
    resettingRc(EXEC_RC);
    const lines = await doctorLines(realHost(true));
    expect(levelOf(lines, "Job shell")).toBe("WARN");
    const fail = lines.find((line) => line.startsWith("FAIL") && line.includes("Job shell env:"));
    expect(fail).toContain("node was not found even with the job's env file");
    expect(fail).toContain(`the job shell's PATH was ${path.join(home, "default-bin")}`);
  });

  it("criterion 3: a clean start-up file passes both runs and prints no WARN", async () => {
    cleanRc();
    const lines = await doctorLines(realHost(true));
    expect(levelOf(lines, "Job shell")).toBe("PASS");
    expect(levelOf(lines, "Job shell env")).toBe("PASS");
    expect(lines.filter((line) => line.startsWith("WARN") && line.includes("Job shell"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("FAIL") && line.includes("Job shell"))).toEqual([]);
  });

  it("the shell is started with the clean environment: the job marker and the home are set, and the subscription token is not passed on", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", ["sk-ant-", "oat01-", "fake-0123456789"].join(""));
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-fake-key-0123456789");
    cleanRc();
    const seen: Array<Record<string, string>> = [];
    const inner = realHost(true);
    const lines = await doctorLines({ ...inner, run: (command, args, env, timeoutMs) => (seen.push(env), inner.run(command, args, env, timeoutMs)) });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const env of seen.slice(1)) {
      expect(env.FX_RUNNER_JOB).toBe("1");
      expect(env.HOME).toBe(home);
      expect(Object.keys(env)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
    }
    expect(lines.join("\n")).not.toContain("fake-0123456789");
  });

  it("the plain run does not carry the env file's lines, and the second run does (the order is plain, then with the file)", async () => {
    cleanRc();
    const host = realHost(true);
    await doctorLines(host);
    const commands = host.calls.map((call) => call[call.length - 1]!).filter((text) => text.includes("fx-node"));
    expect(commands).toHaveLength(2);
    expect(commands[0]).not.toContain("export PATH=");
    expect(commands[1]).toMatch(/^export PATH='.*'\nexport TMPDIR='.*'\nprintf /);
  });

  it("no node on the runner PATH: the check says it was not run, and nothing is started for it", async () => {
    cleanRc();
    vi.stubEnv("PATH", `${toolbin}:/nonexistent`);
    const host = realHost(true);
    const lines = await doctorLines(host);
    expect(lines.find((line) => line.includes("Job shell:"))).toMatch(/^INFO\s+Job shell:\s+not checked: node is not on the runner PATH/);
    expect(host.calls.filter((call) => call[call.length - 1]!.includes("fx-node"))).toEqual([]);
  });

  it("no known login shell: not checked, INFO, nothing started", async () => {
    const host = realHost(true);
    const lines = await doctorLines(host, { shell: undefined });
    expect(shellLines(lines)).toHaveLength(1);
    expect(lines.find((line) => line.includes("Job shell:"))).toMatch(/^INFO\s+Job shell:\s+not checked: the login shell is not known/);
    expect(host.calls.filter((call) => call[call.length - 1]!.includes("fx-node"))).toEqual([]);
  });

  it("a PATH entry the env file cannot quote is a FAIL with the closed reason, and no shell is started", async () => {
    cleanRc();
    vi.stubEnv("PATH", `${tools}:${toolbin}:/opt/it's/bin:${HOST_PATH}`);
    const host = realHost(true);
    const lines = await doctorLines(host);
    expect(lines.find((line) => line.includes("Job shell env:"))).toMatch(/^FAIL\s+Job shell env:\s+job_env_unsafe/);
    expect(host.calls.filter((call) => call[call.length - 1]!.includes("fx-node"))).toEqual([]);
  });

  it("a shell that cannot be started is a WARN that says so, not a node finding", async () => {
    cleanRc();
    const lines = await doctorLines(realHost(true), { shell: path.join(root, "no-such-shell") });
    expect(lines.find((line) => line.includes("Job shell:"))).toMatch(/^WARN\s+Job shell:\s+not checked: /);
    expect(lines.filter((line) => line.startsWith("FAIL") && line.includes("Job shell"))).toEqual([]);
  });

  it("a failed sandbox probe leaves the Job shell lines out (the Sandbox FAIL is the finding)", async () => {
    cleanRc();
    const failingHost: SandboxHost = { ...realHost(true), run: async () => ({ code: 1, stdout: "", stderr: "bwrap: odd failure", timedOut: false }) };
    const lines = await doctorLines(failingHost);
    expect(levelOf(lines, "Sandbox")).toBe("FAIL");
    expect(shellLines(lines)).toEqual([]);
  });
});

const bwrapUsable = realBwrap !== undefined && realSocat !== undefined && bwrapCanCreateNamespaces(realBwrap);
describe.skipIf(bash === undefined || !bwrapUsable)("C44-2: the same lines through the real bubblewrap, whose home view hides every file but the shell start-up files", () => {
  it("a resetting start-up file is a WARN then a PASS, a clean one passes both, a replacing one FAILs", async () => {
    resettingRc();
    const reset = await doctorLines(realHost(false));
    expect(levelOf(reset, "Job shell")).toBe("WARN");
    expect(levelOf(reset, "Job shell env")).toBe("PASS");
    cleanRc();
    const clean = await doctorLines(realHost(false));
    expect(levelOf(clean, "Job shell")).toBe("PASS");
    expect(levelOf(clean, "Job shell env")).toBe("PASS");
    resettingRc(EXEC_RC);
    const replaced = await doctorLines(realHost(false));
    expect(levelOf(replaced, "Job shell env")).toBe("FAIL");
  });
});
