import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHandle, LocalOnlyEvent, StartOptions } from "@fulcrumaxe/runner-protocol";
import { SURVEY_ROLE, structuredSchemaFor } from "@fulcrumaxe/runner-protocol";
import { guestJobFiles } from "../../src/vm/sandboxd/guestJobFiles.js";
import { roleToolsFor } from "../../src/job/roleTools.js";
import { confineFileTools } from "../../src/engines/claude/filePermissions.js";
import { claudeArgv } from "../../src/engines/claude/argv.js";
import { outcomeOf, type RunOutcome } from "../../src/engines/claude/engine.js";
import { EngineRefusal } from "../../src/engines/claude/refusal.js";
import { SUBSCRIPTION_TOKEN_VAR } from "../../src/job/cleanEnv.js";
import { AgentError } from "../../src/vm/sandboxd/agentError.js";
import { FALLBACK_LIMIT_MS, GUEST_AGENT_PATH, GUEST_JOBS_DIR, GUEST_USAGE_LIMITS, MAX_TIMEOUT_S, SIGNAL_CLI, createGuestRuntime, guestMakeRuntime, type GuestRuntimeConfig } from "../../src/vm/sandboxd/guestRuntime.js";
import { guestEnvOf, microvmEnvAllowed } from "../../src/vm/sandboxd/guestEnv.js";
import { JobTokenError } from "../../src/vm/sandboxd/jobToken.js";
import { VM_BACKSTOP_MS, createMicrovmSandbox, MicrovmSandboxRefused } from "../../src/vm/sandboxd/microvmSandbox.js";
import type { StreamSpec } from "../../src/vm/sandboxd/sandboxd.js";
import type { SdkSandbox } from "../../src/vm/sandboxd/sdkSlice.js";
import type { GuestStream, StreamDone, StreamFrame, StreamSignal } from "../../src/vm/sandboxd/streamCommand.js";
import { runAgentStream } from "../../src/engines/claude/streamRun.js";
import { FULL_HELP, RUN_ID, fixtureText, helpWithout } from "../engines/claude/harness.js";
import { GOLDEN_FILE, SCENARIOS, canonical, chunked } from "../engines/claude/streamScenarios.js";

/**
 * D#587 B-5a-RT-3 over FAKES at the guest-agent frame seam: `launch` is a fake that answers the runtime's plain commands (`--version`, `--help`, the memory read,
 * the SIGINT sender) and hands back a scripted stream for the CLI's token launch. What a real guest does with a signal, a stop or a lost VM is in
 * `guestRuntime.real.test.ts`; the real `claude` and a model are A1 criterion 26 (3c), not here.
 */
const WORKDIR = "/vercel/sandbox/work";
const SENTINEL = ["sk-ant", "oat01-SENTINELSENTINELSENTINEL1234"].join("-");
const roots: string[] = [];
afterEach(() => void roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const logDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "fx-grt-"));
  roots.push(dir);
  return dir;
};

/** A stream the test drives: frames are pushed, and the end (or the loss) is chosen. */
class FakeStream implements GuestStream {
  readonly id = "fake";
  killed: StreamSignal[] = [];
  aborted = false;
  onKill: ((signal: StreamSignal, s: FakeStream) => void) | undefined;
  private q: Array<{ f: StreamFrame } | { exit: StreamDone } | { lost: true }> = [];
  private wake: (() => void) | undefined;
  private over = false;
  private resolveDone!: (d: StreamDone) => void;
  private rejectDone!: (e: AgentError) => void;
  readonly done = new Promise<StreamDone>((res, rej) => {
    this.resolveDone = res;
    this.rejectDone = rej;
  });
  constructor() {
    this.done.catch(() => undefined);
  }
  push(stream: "stdout" | "stderr", text: string | Buffer): void {
    this.q.push({ f: { stream, data: Buffer.from(text) } });
    this.wake?.();
  }
  end(exit: Partial<StreamDone> = {}): void {
    this.q.push({ exit: { exit: 0, signal: null, timedOut: false, ...exit } });
    this.wake?.();
  }
  lose(): void {
    if (this.over) return;
    this.q.push({ lost: true });
    this.wake?.();
  }
  readonly frames: AsyncIterable<StreamFrame> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<StreamFrame>> => {
        for (;;) {
          const item = this.q.shift();
          if (item !== undefined && "f" in item) return { done: false, value: item.f };
          if (item !== undefined && "exit" in item) {
            this.over = true;
            this.resolveDone(item.exit);
            return { done: true, value: undefined };
          }
          if (item !== undefined) {
            this.over = true;
            this.rejectDone(new AgentError("lost"));
            throw new AgentError("lost");
          }
          await new Promise<void>((r) => (this.wake = r));
        }
      },
      return: async () => {
        this.abort();
        return { done: true, value: undefined };
      },
    }),
  };
  async kill(signal: StreamSignal): Promise<void> {
    this.killed.push(signal);
    this.onKill?.(signal, this);
  }
  abort(): void {
    this.aborted = true;
    this.lose();
  }
}

interface Guest {
  specs: StreamSpec[];
  runs: FakeStream[];
  written: Array<Array<{ path: string; content: string; mode?: number }>>;
  interrupts: string[][];
  oom: string;
  version: string;
  help: string;
  failRun?: unknown;
  failProbe?: unknown;
  /** What the CLI's launch does with its stream. */
  onRun: (s: FakeStream, spec: StreamSpec) => void;
  config(over?: Partial<GuestRuntimeConfig>): GuestRuntimeConfig;
}

const tool = fixtureText("stream.tooluse.synthetic.jsonl");
const finish = (text: string, exit: Partial<StreamDone> = {}) => (s: FakeStream): void => {
  for (let i = 0; i < text.length; i += 13) s.push("stdout", text.slice(i, i + 13));
  s.end(exit);
};

function makeGuest(): Guest {
  const guest: Guest = {
    specs: [],
    runs: [],
    written: [],
    interrupts: [],
    oom: "",
    version: "2.1.295 (Claude Code)\n",
    help: FULL_HELP,
    onRun: (s) => finish(tool)(s),
    config(over = {}) {
      return {
        launch: async (spec) => {
          guest.specs.push(spec);
          const s = new FakeStream();
          if (spec.withToken === true) {
            if (guest.failRun !== undefined) throw guest.failRun;
            guest.runs.push(s);
            guest.onRun(s, spec);
            return s;
          }
          if (guest.failProbe !== undefined) throw guest.failProbe;
          const args = spec.args ?? [];
          if (args[0] === "--version") s.push("stdout", guest.version);
          else if (args[0] === "--help") s.push("stdout", guest.help);
          else if (args[1]?.startsWith("cat /sys/fs/cgroup")) s.push("stdout", guest.oom);
          else if (args[1] === SIGNAL_CLI) guest.interrupts.push(args);
          s.end();
          return s;
        },
        writeFiles: async (files) => void guest.written.push(files),
        credentials: { mode: "subscription" },
        logDir: logDir(),
        killGraceMs: 30,
        killWaitMs: 60,
        ...over,
      };
    },
  };
  return guest;
}

function startOpts(over: Partial<StartOptions> & Record<string, unknown> = {}): StartOptions & { events: unknown[] } {
  const events: unknown[] = [];
  return { runId: RUN_ID, role: "executor", roleCard: "card", prompt: "PROMPT-TEXT-FROM-JOB", model: "sonnet", workdir: WORKDIR, capUsd: 1, onEvent: (e) => void events.push(e), events, ...over } as StartOptions & { events: unknown[] };
}

const outcome = async (handle: AgentHandle): Promise<RunOutcome> => outcomeOf(handle);
const refusalOf = async (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: unknown) => (e instanceof EngineRefusal ? e.code : `other:${String(e)}`));
const cliSpec = (g: Guest): StreamSpec => g.specs.find((s) => s.withToken === true)!;

describe("RT-3 criterion 15: config and the credential mode (fake launch)", () => {
  it("returns a runtime with start, stop, resume and interrupt", () => {
    const rt = createGuestRuntime(makeGuest().config());
    expect([typeof rt.start, typeof rt.stop, typeof rt.resume, typeof rt.interrupt]).toEqual(["function", "function", "function", "function"]);
  });
  it("a runner-side mode other than subscription ends the start with credential_mismatch before any guest call", async () => {
    const g = makeGuest();
    const rt = createGuestRuntime(g.config({ credentials: { mode: "api_key", apiKey: "k" } as never }));
    expect(await refusalOf(rt.start(startOpts()))).toBe("credential_mismatch");
    expect(g.specs).toEqual([]);
    expect(g.written).toEqual([]);
  });
});

describe("RT-3 criterion 16: inputs, env and the binary (fake launch)", () => {
  it("every stream carries the full microVM env, built from guestEnvOf, and no variable outside the allow-list", async () => {
    const g = makeGuest();
    const { handle } = await createGuestRuntime(g.config({ env: { LANG: "C" } })).start(startOpts());
    await outcome(handle);
    expect(g.specs.length).toBe(3); // --version, --help, the CLI
    for (const spec of g.specs) {
      expect(spec.env, JSON.stringify(spec.args)).toEqual(guestEnvOf({ LANG: "C" }));
      expect(microvmEnvAllowed(spec.env)).toBe(true);
      expect(spec.user).toBe("ubuntu");
    }
    expect(cliSpec(g).env?.ANTHROPIC_BASE_URL).toBe("http://api.anthropic.com");
  });
  it("an environment outside the table refuses the start before any guest call", async () => {
    const g = makeGuest();
    expect(await refusalOf(createGuestRuntime(g.config({ env: { SECRET_THING: "x" } })).start(startOpts()))).toBe("bad_start_options");
    expect(g.specs).toEqual([]);
  });
  it("the token's variable name and a sentinel token are in no request, file, log line or event the runtime makes", async () => {
    const g = makeGuest();
    g.onRun = (s) => finish(tool.replace("Done.", `Done. ${SENTINEL}`))(s);
    const config = g.config();
    const opts = startOpts();
    const { handle } = await createGuestRuntime(config).start(opts);
    await outcome(handle);
    const everything = JSON.stringify([g.specs, g.written, opts.events]) + readFileSync(path.join(config.logDir, `${RUN_ID}.jsonl`), "utf8");
    expect(everything).not.toContain(SUBSCRIPTION_TOKEN_VAR);
    expect(readFileSync(path.join(config.logDir, `${RUN_ID}.jsonl`), "utf8")).not.toContain(SENTINEL);
    expect(JSON.stringify(g.specs)).not.toContain(SENTINEL);
  });
  it("asks the guest for --version then --help, as the ordinary user with no token, through the engine's own checks, once per sandbox", async () => {
    const g = makeGuest();
    const memo = {};
    for (const n of [1, 2]) {
      const { handle } = await createGuestRuntime(g.config({ binary: memo })).start(startOpts());
      await outcome(handle);
      expect(n).toBeGreaterThan(0);
    }
    const probes = g.specs.filter((s) => s.withToken !== true);
    expect(probes.map((s) => s.args)).toEqual([["--version"], ["--help"]]);
    expect(probes.every((s) => s.cmd === "/opt/fx/bin/claude" && s.withToken === undefined && s.user === "ubuntu")).toBe(true);
    expect(g.runs.length).toBe(2);
  });
  it("a version below the minimum is claude_version_unsupported, a missing flag is claude_flags_unsupported, and neither starts the CLI", async () => {
    const old = makeGuest();
    old.version = "2.1.10 (Claude Code)\n";
    expect(await refusalOf(createGuestRuntime(old.config()).start(startOpts()))).toBe("claude_version_unsupported");
    expect(old.runs).toEqual([]);
    const unreadable = makeGuest();
    unreadable.version = "garbage\n";
    expect(await refusalOf(createGuestRuntime(unreadable.config()).start(startOpts()))).toBe("claude_version_unsupported");
    const noFlag = makeGuest();
    noFlag.help = helpWithout(FULL_HELP, "--json-schema");
    expect(await refusalOf(createGuestRuntime(noFlag.config()).start(startOpts()))).toBe("claude_flags_unsupported");
    expect(noFlag.runs).toEqual([]);
  });
  it("a failed check is not remembered: the next start asks again", async () => {
    const g = makeGuest();
    g.version = "2.1.10 (Claude Code)\n";
    const memo = {};
    expect(await refusalOf(createGuestRuntime(g.config({ binary: memo })).start(startOpts()))).toBe("claude_version_unsupported");
    g.version = "2.1.295 (Claude Code)\n";
    const { handle } = await createGuestRuntime(g.config({ binary: memo })).start(startOpts());
    expect((await outcome(handle)).status).toBe("ok");
  });
  it("an older image without the streaming exec is the closed guest_agent_unsupported, and nothing falls back to a one-shot exec", async () => {
    const g = makeGuest();
    g.failProbe = new AgentError("unsupported");
    expect(await refusalOf(createGuestRuntime(g.config()).start(startOpts()))).toBe("guest_agent_unsupported");
    expect(g.runs).toEqual([]);
  });
});

describe("RT-3 criterion 17: job files in the guest (fake writeFiles)", () => {
  it("one writeFiles puts settings and MCP files under jobsDir/<run>/, mode 0600, from the builders, with the guest's own sandbox block", async () => {
    const g = makeGuest();
    const { handle } = await createGuestRuntime(g.config()).start(startOpts());
    await outcome(handle);
    expect(g.written.length).toBe(1);
    const files = g.written[0]!;
    expect(files.map((f) => [f.path, f.mode])).toEqual([[`/vercel/fx-job/${RUN_ID}/settings.json`, 0o600], [`/vercel/fx-job/${RUN_ID}/mcp.json`, 0o600]]);
    const settings = JSON.parse(files[0]!.content) as { sandbox: Record<string, unknown>; permissions: { allow: string[] } };
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, enableWeakerNestedSandbox: false });
    expect((settings.sandbox["filesystem"] as { allowWrite: string[] }).allowWrite).toEqual([WORKDIR, `/tmp/fx-${RUN_ID}`]);
    expect(JSON.parse(files[1]!.content)).toEqual({ mcpServers: {} });
  });
  it("nothing of the host's home, temp or state paths is in a guest file", async () => {
    const g = makeGuest();
    const { handle } = await createGuestRuntime(g.config()).start(startOpts());
    await outcome(handle);
    const text = JSON.stringify(g.written);
    for (const host of [process.env["HOME"] ?? "/home", ...(tmpdir() === "/tmp" ? [] : [tmpdir()]), "/.fx-runner"]) expect(host === "/home" ? text.includes("/home/") : text.includes(host), host).toBe(false);
  });
  it("a block that does not switch the sandbox on, or leaves a way out, is bad_start_options before the guest is touched", async () => {
    for (const bad of [{}, { enabled: false, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false }, { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: true, autoAllowBashIfSandboxed: false }]) {
      const g = makeGuest();
      expect(await refusalOf(createGuestRuntime(g.config({ sandbox: () => bad })).start(startOpts()))).toBe("bad_start_options");
      expect(g.specs).toEqual([]);
      expect(g.written).toEqual([]);
    }
  });
  it("a layout outside the image's (a working directory in /tmp, in the settings directory, or not plain) is refused before the guest is touched", async () => {
    for (const workdir of ["/tmp/work", "/vercel/fx-job/x", "/vercel/../etc", "/opt/fx/bin"]) {
      const g = makeGuest();
      expect(await refusalOf(createGuestRuntime(g.config()).start(startOpts({ workdir }))), workdir).toBe("bad_start_options");
      expect(g.specs).toEqual([]);
    }
  });
  it("a playwright or Chrome browser job is refused in v1, before the guest is touched", async () => {
    for (const over of [{ browserMethod: "playwright_runner" }, { browserMethod: "chrome_extension" }, { role: "deploy-verifier" }]) {
      const g = makeGuest();
      expect(await refusalOf(createGuestRuntime(g.config()).start(startOpts(over as never))), JSON.stringify(over)).toBe("bad_start_options");
      expect(g.specs).toEqual([]);
    }
  });
});

describe("RT-3 criterion 18: launch (fake launch)", () => {
  it("the prompt is on stdin, the argv is claudeArgv with guest paths under the pid-recording wrapper, the user is ubuntu with the token, and the limit is the port's plus the backstop", async () => {
    const g = makeGuest();
    const { handle } = await createGuestRuntime(g.config({ timeoutMs: () => 600_000 })).start(startOpts());
    await outcome(handle);
    const spec = cliSpec(g);
    expect(spec.stdin?.toString()).toBe("PROMPT-TEXT-FROM-JOB");
    expect(JSON.stringify(spec)).not.toContain("PROMPT-TEXT");
    expect(spec).toMatchObject({ cmd: "/bin/sh", cwd: WORKDIR, withToken: true, user: "ubuntu", timeoutS: (600_000 + VM_BACKSTOP_MS) / 1000 });
    const args = spec.args!;
    const at = args.indexOf("/opt/fx/bin/claude");
    expect(args.slice(0, 3)).toEqual(["-c", expect.stringContaining("exec"), "fx-run"]);
    expect(args[4]).toBe(`/tmp/fx-${RUN_ID}`);
    expect(args.slice(at + 1)).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--settings", `/vercel/fx-job/${RUN_ID}/settings.json`, "--model", "sonnet"]));
    const tools = roleToolsFor("executor");
    expect(args.slice(at + 1)).toEqual(claudeArgv({ cliModel: "sonnet", roleTools: tools, allowRules: confineFileTools(tools, WORKDIR), settingsPath: `/vercel/fx-job/${RUN_ID}/settings.json`, mcpPath: `/vercel/fx-job/${RUN_ID}/mcp.json`, chrome: false, ...(structuredSchemaFor("executor") === undefined ? {} : { jsonSchema: structuredSchemaFor("executor")! }) }));
    expect(args).not.toContain("--resume");
  });
  it("a resume re-validates the session id and starts a new stream with --resume (and a new stream id)", async () => {
    const g = makeGuest();
    const rt = createGuestRuntime(g.config());
    const first = await rt.start(startOpts());
    await outcome(first.handle);
    for (const bad of ["-x", "bad id/with spaces"]) expect(await refusalOf(Promise.resolve().then(() => rt.resume(first.handle, bad, "again"))), bad).toBe("bad_start_options");
    const again = await rt.resume(first.handle, "sess-0001", "again");
    await outcome(again.handle);
    const [a, b] = g.specs.filter((s) => s.withToken === true);
    expect(b!.args).toEqual(expect.arrayContaining(["--resume", "sess-0001"]));
    expect(b!.stdin?.toString()).toBe("again");
    expect(a!.id).not.toBe(b!.id);
    expect(g.runs.length).toBe(2);
  });
});

describe("RT-3 criterion 19: stream and events (fake stream)", () => {
  const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Record<string, string>;
  it("the guest run's events, local events and outcome are byte-equal to the host engine's recorded ones for the same transcript", async () => {
    for (const name of ["tool use with structured output", "error result", "truncated: no result line", "credential mismatch", "complete subscription run"]) {
      const scenario = SCENARIOS.find((s) => s.name === name)!;
      const g = makeGuest();
      g.onRun = (s) => finish(scenario.stream, { exit: scenario.exitCode ?? 0 })(s);
      const locals: LocalOnlyEvent[] = [];
      const opts = startOpts();
      const { handle } = await createGuestRuntime(g.config({ onLocalEvent: (e) => void locals.push(e) })).start(opts);
      const done = await outcome(handle);
      expect(canonical({ events: opts.events, locals, outcome: done }, "<none>"), name).toBe(golden[name]);
    }
  });
  it("the usage meter is held to bounded ceilings, not the host's lifted ones", async () => {
    expect(GUEST_USAGE_LIMITS.maxIds).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(GUEST_USAGE_LIMITS.maxLineOutputTokens).toBeLessThan(Number.MAX_SAFE_INTEGER);
    const huge = tool.replaceAll('"output_tokens":5', '"output_tokens":900000000').replaceAll('"output_tokens":7', '"output_tokens":900000000');
    const locals: Array<{ type?: string; usage?: unknown }> = [];
    const g = makeGuest();
    g.onRun = finish(huge);
    const { handle } = await createGuestRuntime(g.config({ onLocalEvent: (e) => void locals.push(e as never) })).start(startOpts());
    await outcome(handle);
    const direct: Array<{ type?: string; usage?: unknown }> = [];
    await runAgentStream({ options: startOpts(), workdir: WORKDIR, credentials: { mode: "subscription" }, engineVersion: "2.1.295", usageLimits: { maxLineInputSideTokens: Number.MAX_SAFE_INTEGER, maxLineOutputTokens: Number.MAX_SAFE_INTEGER, maxIds: Number.MAX_SAFE_INTEGER }, stdout: chunked(huge), stderr: chunked(""), ended: Promise.resolve({ code: 0, signal: null }), terminate: () => undefined, log: { write: () => undefined }, onLocalEvent: (e) => void direct.push(e as never) });
    expect(JSON.stringify(locals.filter((e) => e.type === "usage"))).not.toBe(JSON.stringify(direct.filter((e) => e.type === "usage")));
  });
  it("the raw transcript is on the host log directory at 0600 and redacts a token-shaped value by shape", async () => {
    const g = makeGuest();
    g.onRun = (s) => (s.push("stderr", `warn ${SENTINEL}\n`), finish(tool.replace("Done.", `Done. ${SENTINEL}`))(s));
    const config = g.config();
    const { handle } = await createGuestRuntime(config).start(startOpts());
    await outcome(handle);
    expect(readdirSync(config.logDir)).toEqual([`${RUN_ID}.jsonl`]);
    const text = readFileSync(path.join(config.logDir, `${RUN_ID}.jsonl`), "utf8");
    expect(text).not.toContain(SENTINEL);
    expect(text).toContain("engine_version");
  });
});

describe("RT-3 criterion 20: outcomes and exit codes (fake stream)", () => {
  it.each([
    ["exit code 3 with no result line", "noresult", { exit: 3 }, "agent_exit"],
    ["killed by a signal with no result line", "noresult", { exit: null, signal: 9 }, "agent_exit"],
    ["the guest's own timeout", "noresult", { exit: null, signal: 9, timedOut: true }, "agent_exit"],
    ["a clean end with a result line", "full", {}, undefined],
  ] as const)("%s", async (_name, kind, exit, reason) => {
    const g = makeGuest();
    g.onRun = finish(kind === "full" ? tool : tool.split("\n").filter((l) => !l.includes('"type":"result"')).join("\n"), exit);
    const { handle } = await createGuestRuntime(g.config()).start(startOpts());
    expect((await outcome(handle)).failureReason).toBe(reason);
  });
  it("a lost stream is agent_exit, never ok, even after a result line", async () => {
    const g = makeGuest();
    g.onRun = (s) => {
      s.push("stdout", tool);
      s.lose();
    };
    const { handle } = await createGuestRuntime(g.config()).start(startOpts());
    expect(await outcome(handle)).toMatchObject({ status: "failed", failureReason: "agent_exit" });
  });
  it("a refused launch (AgentError) and a launch that throws end agent_exit with no cause in the code", async () => {
    for (const failure of [new AgentError("refused"), new AgentError("unreachable"), new Error("secret path /home/x")]) {
      const g = makeGuest();
      g.failRun = failure;
      const { handle } = await createGuestRuntime(g.config()).start(startOpts());
      const done = await outcome(handle);
      expect(done).toMatchObject({ status: "failed", failureReason: "agent_exit" });
      expect(JSON.stringify(done)).not.toContain("secret");
    }
  });
  it("a JobTokenError from the launcher is not swallowed: it propagates with its own code", async () => {
    const g = makeGuest();
    g.failRun = new JobTokenError("vm_token_delivery_failed");
    await expect(createGuestRuntime(g.config()).start(startOpts())).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
  });
  it("the port raises AgentRunFailed with the engine's code exactly as for the host (failureOf over this outcome)", async () => {
    const g = makeGuest();
    g.onRun = finish(tool.split("\n").filter((l) => l !== "").slice(2).join("\n") + "\n", { exit: 1 });
    const { handle } = await createGuestRuntime(g.config()).start(startOpts());
    const { failureOf } = await import("../../src/sandbox/agentOutcome.js");
    expect(failureOf(await outcome(handle))).toBe("no_init_line");
  });
});

describe("RT-3 criterion 21: resource_limit comes from the guest (fake memory read)", () => {
  const noResult = tool.split("\n").filter((l) => !l.includes('"type":"result"')).join("\n");
  it("oom_kill above 0 after a non-clean end with no result line is resource_limit", async () => {
    const g = makeGuest();
    g.oom = "low 0\noom 1\noom_kill 2\n";
    g.onRun = finish(noResult, { exit: null, signal: 9 });
    const { handle } = await createGuestRuntime(g.config()).start(startOpts());
    expect((await outcome(handle)).failureReason).toBe("resource_limit");
    expect(g.specs.at(-1)!.args![1]).toContain("memory.events");
  });
  it.each([["oom_kill 0\n"], [""]])("%j (no kill, or nothing readable) is agent_exit", async (text) => {
    const g = makeGuest();
    g.oom = text;
    g.onRun = finish(noResult, { exit: null, signal: 9 });
    const { handle } = await createGuestRuntime(g.config()).start(startOpts());
    expect((await outcome(handle)).failureReason).toBe("agent_exit");
  });
  it("a read that fails is agent_exit, and a result line that was seen is never turned into resource_limit", async () => {
    const g = makeGuest();
    g.oom = "oom_kill 3\n";
    g.onRun = finish(tool, { exit: null, signal: 9 });
    const { handle } = await createGuestRuntime(g.config()).start(startOpts());
    expect((await outcome(handle)).status).toBe("ok");
    const f = makeGuest();
    f.onRun = finish(noResult, { exit: 1 });
    const base = f.config();
    const { handle: h2 } = await createGuestRuntime({ ...base, launch: async (spec) => (spec.args?.[1]?.startsWith("cat /sys") === true ? Promise.reject(new AgentError("lost")) : base.launch(spec)) }).start(startOpts());
    expect((await outcome(h2)).failureReason).toBe("agent_exit");
  });
  it("signal 9 alone does not imply it (the runtime's own stop sends 9 too)", async () => {
    const g = makeGuest();
    g.oom = "oom_kill 0\n";
    g.onRun = finish(noResult, { exit: null, signal: 9 });
    const { handle } = await createGuestRuntime(g.config()).start(startOpts());
    expect((await outcome(handle)).failureReason).not.toBe("resource_limit");
  });
});

describe("RT-3 criteria 22 and 23: interrupt and the stop ladder (fake stream)", () => {
  it("interrupt sends SIGINT to the CLI's own pid (the pid file the wrapper records), not to the group, and does nothing once the run ended", async () => {
    const g = makeGuest();
    g.onRun = (s) => s.push("stdout", tool.split("\n")[0] + "\n");
    const rt = createGuestRuntime(g.config());
    const { handle } = await rt.start(startOpts());
    await rt.interrupt(handle);
    expect(g.interrupts.length).toBe(1);
    const pidFile = cliSpec(g).args![3]!;
    expect(g.interrupts[0]).toEqual(["-c", SIGNAL_CLI, "fx-int", pidFile]);
    expect(g.runs[0]!.killed).toEqual([]);
    g.runs[0]!.end();
    await outcome(handle);
    await rt.interrupt(handle);
    expect(g.interrupts.length).toBe(1);
  });
  it("stop sends SIGTERM, waits the grace, sends SIGKILL, waits for the exit frame, and resolves with the outcome", async () => {
    const g = makeGuest();
    g.onRun = (s) => {
      s.push("stdout", tool.split("\n")[0] + "\n");
      s.onKill = (sig, st) => sig === "SIGKILL" && st.end({ exit: null, signal: 9 });
    };
    const rt = createGuestRuntime(g.config());
    const { handle } = await rt.start(startOpts());
    const t0 = Date.now();
    await rt.stop(handle);
    expect(g.runs[0]!.killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(g.runs[0]!.aborted).toBe(false);
    expect((await outcome(handle)).failureReason).toBe("agent_exit");
  });
  it("a command that ends on SIGTERM is not killed again", async () => {
    const g = makeGuest();
    g.onRun = (s) => void (s.onKill = (sig, st) => sig === "SIGTERM" && st.end({ exit: null, signal: 15 }));
    const rt = createGuestRuntime(g.config());
    const { handle } = await rt.start(startOpts());
    await rt.stop(handle);
    expect(g.runs[0]!.killed).toEqual(["SIGTERM"]);
  });
  it("a command that survives both signals is given up on: the stream is aborted, and the stop still resolves (abort alone is not the kill)", async () => {
    const hang = makeGuest();
    hang.onRun = () => undefined;
    const rt2 = createGuestRuntime(hang.config());
    const second = await rt2.start(startOpts());
    await rt2.stop(second.handle);
    expect(hang.runs[0]!.killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(hang.runs[0]!.aborted).toBe(true);
    expect((await outcome(second.handle)).failureReason).toBe("agent_exit");
  });
  it("stop is safe twice, and for a handle whose launch failed or whose stream is over", async () => {
    const g = makeGuest();
    const rt = createGuestRuntime(g.config());
    const { handle } = await rt.start(startOpts());
    await outcome(handle);
    await rt.stop(handle);
    await rt.stop(handle);
    expect(g.runs[0]!.killed).toEqual([]);
    const failed = makeGuest();
    failed.failRun = new AgentError("unreachable");
    const rt2 = createGuestRuntime(failed.config());
    const lost = await rt2.start(startOpts());
    await rt2.stop(lost.handle);
    await rt2.stop(lost.handle);
    await rt2.stop({ runId: "never-started" });
  });
  it("a stream the run's own checks stop (a credential mismatch) is ended through the same ladder", async () => {
    const g = makeGuest();
    g.onRun = (s) => {
      s.onKill = (sig, st) => sig === "SIGTERM" && st.end({ exit: null, signal: 15 });
      s.push("stdout", SCENARIOS.find((x) => x.name === "credential mismatch")!.stream);
    };
    const { handle } = await createGuestRuntime(g.config()).start(startOpts());
    await vi_waitFor(() => g.runs[0]!.killed.length > 0);
    expect(g.runs[0]!.killed[0]).toBe("SIGTERM");
    expect((await outcome(handle)).failureReason).toBe("credential_mismatch");
  });
});

async function vi_waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe("RT-3 criterion 24: the port's timer wins over the guest's timedOut (fake sandbox)", () => {
  function fakeGuest(): SdkSandbox {
    const guest = {
      name: "g1", status: "running", timeout: 120_000,
      runCommand: async () => { throw new Error("unused"); },
      writeFiles: async () => undefined,
      updateNetworkPolicy: async () => undefined,
      extendTimeout: async () => undefined,
      stop: async () => undefined,
      delete: async () => undefined,
      currentSession: () => ({ sessionId: "s1" }),
      listSessions: async () => ({ sessions: [], pagination: { next: null } }),
    };
    return guest as unknown as SdkSandbox;
  }
  it("a run the wall clock stopped reports sandbox_timeout, not agent_exit", async () => {
    const g = makeGuest();
    g.onRun = (s) => {
      s.push("stdout", tool.split("\n")[0] + "\n");
      s.onKill = (sig, st) => sig === "SIGKILL" && st.end({ exit: null, signal: 9, timedOut: true });
    };
    const guest = fakeGuest();
    const sdk = { create: async () => guest, get: async () => guest, setTimeoutMs: async () => undefined, armTimeoutAt: async () => undefined };
    const port = createMicrovmSandbox({ sdk: sdk as never, makeRuntime: guestMakeRuntime({ credentials: { mode: "subscription" }, logDir: logDir(), killGraceMs: 20, killWaitMs: 50 }, () => ({ launch: g.config().launch })) });
    const handle = await port.createSandbox({ sandboxName: "g1", retention: { persistent: false }, timeoutMs: 150 });
    const { hookFired } = port.startDetached(handle, { runId: RUN_ID, role: "executor", roleCard: "c", prompt: "p", model: "sonnet", workdir: WORKDIR, capUsd: 1, networkPolicy: [], env: {}, onEvent: () => undefined });
    await expect(hookFired).rejects.toBeInstanceOf(MicrovmSandboxRefused);
    await expect(hookFired).rejects.toMatchObject({ code: "sandbox_timeout" });
    expect(g.runs[0]!.killed).toContain("SIGTERM");
  });
});

describe("RT-3 criterion 26: refusals before any guest call", () => {
  it.each([
    ["an unknown role", { role: "no-such-role" }, "unknown_role"],
    ["a run id that is not a uuid", { runId: "../../etc" }, "bad_start_options"],
    ["a model with a space", { model: "so net" }, "bad_start_options"],
    ["a relative working directory", { workdir: "work" }, "bad_start_options"],
    ["no working directory", { workdir: undefined }, "bad_start_options"],
  ])("%s", async (_name, over, code) => {
    const g = makeGuest();
    expect(await refusalOf(createGuestRuntime(g.config()).start(startOpts(over as never)))).toBe(code);
    expect(g.specs).toEqual([]);
    expect(g.written).toEqual([]);
  });
  it("a resume without start options on the handle is bad_start_options", () => {
    const rt = createGuestRuntime(makeGuest().config());
    expect(() => rt.resume({ runId: RUN_ID }, "sess-1", "p")).toThrow(EngineRefusal);
  });
});

describe("RT-3 section 1.7: the guest path defaults are held to the image (file-level)", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const dockerfile = readFileSync(path.join(ROOT, "infra", "microvm-image", "Dockerfile"), "utf8");
  const lock = JSON.parse(readFileSync(path.join(ROOT, "infra", "microvm-image", "lock.json"), "utf8")) as { artifacts: Record<string, { version: string }> };
  it("the image installs claude at the default agent path, and its pinned version is one the runtime accepts", async () => {
    expect(dockerfile).toContain(`fetch claude ${GUEST_AGENT_PATH}`);
    const { versionSupported } = await import("../../src/engines/claude/pin.js");
    expect(versionSupported(lock.artifacts["claude"]!.version)).toBe(true);
  });
  it("the home is /vercel, the working directory the wiring passes is inside the image's own tree, and the jobs directory is under the home", () => {
    expect(dockerfile).toContain("install -d -o ubuntu -g ubuntu /vercel /vercel/sandbox");
    expect(dockerfile).toContain("usermod --home /vercel ubuntu");
    expect(GUEST_JOBS_DIR.startsWith("/vercel/")).toBe(true);
    expect(WORKDIR.startsWith("/vercel/sandbox/")).toBe(true);
  });
});

describe("RT-3 review fixes: the guest limit, the pid file and the pid sender", () => {
  it("the guest command's limit is the port's plus the backstop; with no port limit it is the 24 h fallback plus the backstop; and no limit is above 7 days", async () => {
    const limitOf = async (timeoutMs?: () => number | undefined): Promise<number | undefined> => {
      const g = makeGuest();
      const { handle } = await createGuestRuntime(g.config(timeoutMs === undefined ? {} : { timeoutMs })).start(startOpts());
      await outcome(handle);
      return cliSpec(g).timeoutS;
    };
    expect(FALLBACK_LIMIT_MS).toBe(24 * 3600_000);
    expect(await limitOf()).toBe((FALLBACK_LIMIT_MS + VM_BACKSTOP_MS) / 1000);
    expect(await limitOf(() => undefined)).toBe((FALLBACK_LIMIT_MS + VM_BACKSTOP_MS) / 1000);
    expect(await limitOf(() => 90_000)).toBe((90_000 + VM_BACKSTOP_MS) / 1000);
    expect(MAX_TIMEOUT_S).toBe(7 * 24 * 3600);
    expect(await limitOf(() => 30 * 24 * 3600_000)).toBe(MAX_TIMEOUT_S);
    expect(await limitOf(() => Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMEOUT_S);
  });

  it("the pid file is outside every path the guest sandbox block allows to read or write, and inside a directory it denies", async () => {
    const g = makeGuest();
    const { handle } = await createGuestRuntime(g.config()).start(startOpts());
    await outcome(handle);
    const args = cliSpec(g).args!;
    const pidFile = args[3]!;
    expect(pidFile.startsWith(`/tmp/fx-pid-${RUN_ID}-`)).toBe(true);
    const settings = JSON.parse(g.written[0]!.find((f) => f.path.endsWith("settings.json"))!.content) as { sandbox: { filesystem: { allowRead: string[]; allowWrite: string[]; denyRead: string[] } } };
    const { allowRead, allowWrite, denyRead } = settings.sandbox.filesystem;
    const under = (dir: string, file: string): boolean => file === dir || file.startsWith(`${dir}/`);
    expect(allowRead.length).toBeGreaterThan(0);
    for (const dir of [...allowRead, ...allowWrite]) expect(under(dir, pidFile), `${pidFile} under ${dir}`).toBe(false);
    expect(denyRead.some((dir) => under(dir, pidFile))).toBe(true);
    expect(under(args[4]!, pidFile)).toBe(false); // not in the run's own temp directory either
  });

  describe("the pid sender, run for real with `kill` replaced by a recorder", () => {
    const sendWith = (content: string | undefined): { status: number | null; signalled: string } => {
      const dir = mkdtempSync(path.join(tmpdir(), "fx-sig-"));
      roots.push(dir);
      const pidFile = path.join(dir, "pid");
      if (content !== undefined) writeFileSync(pidFile, content);
      const marker = path.join(dir, "marker");
      // A shell function shadows the builtin, so a refused value is seen as "no call", and an accepted one as the exact argument.
      const run = spawnSync("sh", ["-c", `kill() { echo "$@" >> "$FX_MARKER"; }; ${SIGNAL_CLI}`, "fx-int", pidFile], { env: { PATH: process.env.PATH ?? "", FX_MARKER: marker }, encoding: "utf8" });
      let signalled = "";
      try {
        signalled = readFileSync(marker, "utf8");
      } catch {
        // fx-swallow-ok: no marker file means no signal was sent, which is the answer being tested
      }
      return { status: run.status, signalled };
    };

    it("signals a plain pid, with a trailing newline as the wrapper writes it", () => {
      expect(sendWith("4242\n")).toEqual({ status: 0, signalled: "-INT 4242\n" });
      expect(sendWith("2")).toEqual({ status: 0, signalled: "-INT 2\n" });
    });

    it("sends nothing for 0, 1, a negative or leading-zero number, an option, a list, a substitution, an empty or a missing file", () => {
      for (const bad of ["0\n", "00", "1\n", "01", "-1\n", "-0", "+5", "12 34", "12\n34", "12\n-1", "1e3", "0x10", "$(id)", "`id`", "12;id", "", "\n", " 7", "-INT", "--", "abc"]) {
        const sent = sendWith(bad);
        expect(sent.signalled, JSON.stringify(bad)).toBe("");
        expect(sent.status, JSON.stringify(bad)).not.toBe(0);
      }
      const missing = sendWith(undefined);
      expect(missing.signalled).toBe("");
      expect(missing.status).not.toBe(0);
    });

    it("really signals SIGINT to a live process", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "fx-sig-"));
      roots.push(dir);
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      const exited = new Promise<string | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
      try {
        const pidFile = path.join(dir, "pid");
        writeFileSync(pidFile, `${child.pid}\n`);
        const run = spawnSync("sh", ["-c", SIGNAL_CLI, "fx-int", pidFile], { env: { PATH: process.env.PATH ?? "" } });
        expect(run.status).toBe(0);
        expect(await exited).toBe("SIGINT");
      } finally {
        child.kill("SIGKILL");
      }
    });
  });
});

/**
 * D#845 ON-10c: the project survey in the guest. Its one writable path is /tmp/fx-survey/<run_id>/ (0700, TMPDIR, made by the launch wrapper), its working copy is read-only, it holds the read guard and the
 * read tools, its answer is held to the survey schema, and its network is the model host alone. Every other role keeps its own layout (the control).
 */
describe("the project survey in the guest (fake launch)", () => {
  const TEMP = `/tmp/fx-survey/${RUN_ID}`;
  const filesOf = (g: Guest): { settings: Record<string, unknown> & { sandbox: { filesystem: { allowWrite: string[]; denyWrite: string[]; allowRead: string[] }; network: Record<string, unknown> }; permissions: { allow: string[]; deny: string[] }; hooks?: { PreToolUse: Array<{ matcher: string }> } } } => ({
    settings: JSON.parse(g.written.flat().find((f) => f.path.endsWith("settings.json"))!.content),
  });

  it("the block writes only in its own temp directory, denies writes to the working copy, and reaches the model host and nothing else", async () => {
    const g = makeGuest();
    const { handle } = await createGuestRuntime(g.config()).start(startOpts({ role: SURVEY_ROLE }));
    await outcome(handle);
    const { sandbox } = filesOf(g).settings;
    expect(sandbox.filesystem.allowWrite).toEqual([TEMP]);
    expect(sandbox.filesystem.denyWrite).toEqual([WORKDIR, GUEST_JOBS_DIR, "/opt/fx/bin"]);
    expect(sandbox.filesystem.allowRead).toEqual([WORKDIR, TEMP]);
    expect(sandbox.network).toEqual({ allowedDomains: ["api.anthropic.com"], strictAllowlist: true, allowLocalBinding: false });
  });

  it("holds the shared read guard and the read tools, with LS denied, and no write tool anywhere", async () => {
    const g = makeGuest();
    const { handle } = await createGuestRuntime(g.config()).start(startOpts({ role: SURVEY_ROLE }));
    await outcome(handle);
    const { settings } = filesOf(g);
    expect(settings.hooks?.PreToolUse.map((h) => h.matcher)).toEqual(["Read|Glob|Grep"]);
    expect(settings.permissions.allow).toEqual([`Read(/${WORKDIR})`, `Read(/${WORKDIR}/**)`]);
    expect(settings.permissions.deny).toContain("LS");
    for (const p of [".git", ".git/**", ".env*"]) expect(settings.permissions.deny).toContain(`Read(/${WORKDIR}/${p})`);
    expect(JSON.stringify(settings.permissions.allow)).not.toMatch(/Bash|Edit|Write|WebFetch|mcp__/);
  });

  it("the launch carries its temp directory and sets it as TMPDIR; the CLI asks for the survey schema and the four read tools", async () => {
    const g = makeGuest();
    const { handle } = await createGuestRuntime(g.config()).start(startOpts({ role: SURVEY_ROLE }));
    await outcome(handle);
    const spec = cliSpec(g);
    expect(spec.args?.[4]).toBe(TEMP);
    expect(spec.env?.TMPDIR).toBe(TEMP);
    expect(spec.env).toEqual({ ...guestEnvOf({}), TMPDIR: TEMP });
    const args = spec.args ?? [];
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,LS");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toEqual(structuredSchemaFor(SURVEY_ROLE));
  });

  it("the wrapper makes that directory 0700, parents included, as the ordinary user's umask does", async () => {
    const g = makeGuest();
    const { handle } = await createGuestRuntime(g.config()).start(startOpts({ role: SURVEY_ROLE }));
    await outcome(handle);
    const args = [...(cliSpec(g).args ?? [])];
    const base = mkdtempSync(path.join(tmpdir(), "fx-survey-wrap-"));
    roots.push(base);
    // the same wrapper, with the machine's /tmp swapped for a scratch directory and the agent for `true`
    const local = path.join(base, "fx-survey", RUN_ID);
    args.splice(3, 3, path.join(base, "pid"), local, "/usr/bin/env");
    args.splice(6, args.length - 6, "true");
    const ran = spawnSync("/bin/sh", args, { encoding: "utf8" });
    expect(ran.status).toBe(0);
    expect(statSync(local).mode & 0o777).toBe(0o700);
    expect(statSync(path.dirname(local)).mode & 0o777).toBe(0o700);
  });

  it("an executor keeps its own layout: the working copy is writable, its temp directory is /tmp/fx-<run>, TMPDIR is the guest's /tmp", async () => {
    const g = makeGuest();
    const { handle } = await createGuestRuntime(g.config()).start(startOpts());
    await outcome(handle);
    const { sandbox } = filesOf(g).settings;
    expect(sandbox.filesystem.allowWrite).toEqual([WORKDIR, `/tmp/fx-${RUN_ID}`]);
    expect(cliSpec(g).env?.TMPDIR).toBe("/tmp");
  });

  it("a survey whose working copy sits in a shared temp directory is refused like any other role; its own temp directory is under /tmp/fx-survey", () => {
    expect(() => guestJobFiles({ jobsDir: GUEST_JOBS_DIR, runId: RUN_ID, role: SURVEY_ROLE, workdir: "/tmp/work" })).toThrow(EngineRefusal);
    const files = guestJobFiles({ jobsDir: GUEST_JOBS_DIR, runId: RUN_ID, role: SURVEY_ROLE, workdir: WORKDIR });
    expect(files.tempDir).toBe(TEMP);
  });
});
