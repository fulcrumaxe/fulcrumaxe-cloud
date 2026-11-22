import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { redactShapes, sha256Text } from "@fulcrumaxe/runner-protocol";
import { runCommand, type RunHooks, type RunHost } from "../../src/commands/run.js";
import { CliError } from "../../src/cliError.js";
import type { CommandContext } from "../../src/context.js";
import { saveRegistration } from "../../src/config.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { originHash } from "../../src/keyring.js";
import { setSetting } from "../../src/runnerSettings.js";
import { startEgressProxy } from "../../src/vm/egress/proxy.js";
import { startReverseEndpoint, type ReverseDecision } from "../../src/vm/egress/reverse.js";
import { createMicrovmParts } from "../../src/vm/liveParts.js";
import { TEMPLATES } from "../../src/vm/lock.js";
import { parseMemAvailableBytes, type VmHostFacts } from "../../src/vm/limits.js";
import { GuestBindings } from "../../src/vm/sandboxd/guestBindings.js";
import { guestMakeRuntime } from "../../src/vm/sandboxd/guestRuntime.js";
import { createHelperClient, type Helper } from "../../src/vm/sandboxd/helperClient.js";
import type { LiveMicrovmParts } from "../../src/vm/sandboxd/live.js";
import { fixtureText, makeFake, type Fake } from "../engines/claude/harness.js";
import { fakeSandboxHost } from "../helpers/fakeSandboxHost.js";
import { shellSandboxUsable, testLaunch } from "../helpers/launch.js";
import { until } from "../helpers/manualClock.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";
import { KEYRING, signedJob } from "../helpers/signedJob.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";
import { signRelease, type SignedRelease } from "./helpers/signedRelease.js";
import { connectUnix } from "./sandboxd/helpers.js";

/**
 * D#587 A1 criterion 26, the half `vmJob.real.test.ts` leaves out: the agent CLI that is already in the image (/opt/fx/bin/claude, not a stand-in) runs one tiny Haiku job in a real
 * microVM, and the model call goes guest relay -> host reverse relay -> api.anthropic.com for real. It spends a subscription, so it runs only on purpose: it is skipped unless
 * FX_C26_REAL=1, the five FX_VM_* variables (as in vmJob.real.test.ts) are set, FX_C26_CONFIG_DIR names an existing directory holding a throwaway sign-in's .credentials.json, and
 * FX_FORBID_MODEL_CALLS is not "1" (like its siblings, the repo's model-call guard is never switched off for it: the run is started with that variable unset).
 * It is in no workflow and must never be listed in one. FX_C26_CONFIG_DIR is read here and handed to nothing else (not the runner, the guest or a child process).
 * FX_C26_SCAN_DIRS (optional, colon separated) names helper-owned directories outside the test's own root that the token search also covers; an unreadable file there fails the test.
 * The access token is read straight into a Buffer and handed to the runner's own token path (B-6.4): never logged, never in an argument list, never written. The Buffer is wiped at the end.
 */
const E = process.env;
const configDir = E["FX_C26_CONFIG_DIR"];
const ready = E["FX_C26_REAL"] === "1" && E["FX_VM_HELPER_SOCKET"] !== undefined && E["FX_VM_TEMPLATE"] === TEMPLATES[0] && E["FX_VM_KERNEL"] !== undefined && E["FX_VM_ROOTFS"] !== undefined && E["FX_VM_AGENT"] !== undefined && E["FX_FORBID_MODEL_CALLS"] !== "1" && configDir !== undefined && existsSync(configDir) && process.geteuid?.() !== 0 && freemem() > 2.5 * 2 ** 30;
if (!ready) console.warn("vmJob.claude.real: FX_C26_REAL=1, the FX_VM_* variables and FX_C26_CONFIG_DIR (an existing directory) are not all set, or FX_FORBID_MODEL_CALLS is 1; the real-CLI job is skipped");

/** The wait for the job ends 2 minutes before the `it` timeout, so the "timed out; the runner said" error (with the scrubbed log tail) is what a stuck run reports, never Vitest's bare timeout. */
const IT_TIMEOUT_MS = 20 * 60_000;
const WAIT_MS = IT_TIMEOUT_MS - 2 * 60_000;

/** Progress line on stderr only. It takes fixed text and counts, never token material: callers pass literals, counts and `scrub(...)` output, nothing else. */
const stage = (s: string): void => console.error(`[c26 ${new Date().toISOString()}] ${s}`);

/** Masks what a CLI line can carry about the account besides the token: email addresses and UUIDs (an account or organisation id), replaced by fixed markers. Pure; applied after the token scrub, before any text goes into a failure message. */
export function maskIdentifiers(text: string): string {
  return text.replace(/[^\s"'<>@]+@[^\s"'<>]+\.[A-Za-z]{2,}/g, "[email]").replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]");
}

/** The one scrub every progress and failure text goes through: the token, then token shapes, then account identifiers. Pure, so the offline test below drives the same function the real test's `scrub` calls. */
export function scrubText(tokenText: string, text: string): string {
  return maskIdentifiers(redactShapes(text.split(tokenText).join("[TOKEN]")));
}

describe("scrubText and maskIdentifiers (offline: runs whether or not the real job is enabled)", () => {
  it("leaves no address, uuid or token in what a failure message would carry", () => {
    const tokenText = ["sk-ant-", "oat01-", "MASKTESTTOKEN0123456789abcdefghij"].join("");
    const orgId = "0A1b2c3d-4e5f-6789-abcd-ef0123456789";
    const lines = [
      JSON.stringify({ type: "result", subtype: "error", is_error: true, result: `Invalid account person.name+x@example.test in org ${orgId}` }),
      JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none", account: { email: "someone@example.test", organization_id: orgId } }),
      `Authorization failed for ${tokenText}`,
    ].join("\n");
    const out = scrubText(tokenText, lines);
    expect(out).not.toMatch(/@/);
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    expect(out).not.toContain("MASKTESTTOKEN");
    expect(out).toContain("[email]");
    expect(out).toContain("[uuid]");
  });
});

/** Thrown from the wait when the run command has ended without ever claiming, so the wait is not run out. */
class EndedBeforeClaim extends Error {}

const LINE = "fx-c26-ok";
const PROMPT = `Create a file named c26.txt in the current directory whose only content is the line ${LINE}. Then run: git add c26.txt && git commit -m c26. Then stop. Use no other tools.\n`;

/** The access token of the throwaway sign-in, as a Buffer and nothing else; the parsed text is dropped at once. */
function readAccessToken(dir: string): Buffer {
  const parsed = JSON.parse(readFileSync(path.join(dir, ".credentials.json"), "utf8")) as { claudeAiOauth?: { accessToken?: unknown } };
  const token = parsed.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || token === "") throw new Error("the throwaway sign-in holds no access token");
  return Buffer.from(token);
}

const CHUNK = 8 * 2 ** 20;

/** True when the file holds `needle`: read in chunks that overlap by the needle's length less one, so a file of any size (a VM snapshot) is searched whole. A file that cannot be read throws. */
function fileHolds(file: string, needle: Buffer): boolean {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK + needle.length);
    let tail = 0;
    for (let pos = 0; pos < size; ) {
      const n = readSync(fd, buf, tail, CHUNK, pos);
      if (n === 0) break;
      pos += n;
      const total = tail + n;
      if (buf.subarray(0, total).includes(needle)) return true;
      tail = Math.min(needle.length - 1, total);
      buf.copy(buf, 0, total - tail, total);
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Every regular file under each of `dirs` that holds `needle` (links are not followed). A directory or file that cannot be read fails the search, it never passes it. */
function filesHolding(dirs: string[], needle: Buffer): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && lstatSync(file).size > 0 && fileHolds(file, needle)) found.push(file);
    }
  };
  for (const d of dirs) walk(d);
  return found;
}

describe.skipIf(!ready)("criterion 26 with the image's own agent CLI: one Haiku job in a real microVM, the model reached through the host's reverse relay", () => {
  let signed: SignedRelease;
  let helper: Helper;
  let token: Buffer;
  let root: string;
  let home: string;
  let stateDir: string;
  let remote: string;
  let cloud: StrictRunnerCloud;
  let fake: Fake;
  let started: { signals: EventEmitter; done: Promise<number> } | undefined;
  const logLines: string[] = [];
  const reversed: ReverseDecision[] = [];
  const sandboxIds = new Set<string>();

  const git = (...args: string[]): string =>
    execFileSync("git", args, { env: { PATH: process.env["PATH"] ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  beforeAll(async () => {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    signed = await signRelease({ template: TEMPLATES[0], files: [{ kind: "kernel", arch, file: E["FX_VM_KERNEL"] as string }, { kind: "rootfs", arch, file: E["FX_VM_ROOTFS"] as string }, { kind: "agent", arch, file: E["FX_VM_AGENT"] as string }] });
    stage("beforeAll: release signed");
    helper = createHelperClient(connectUnix(E["FX_VM_HELPER_SOCKET"] as string));
    stage("beforeAll: helper client created");
    token = readAccessToken(configDir as string);
  }, 120_000);
  afterAll(async () => {
    token?.fill(0);
    await signed?.close();
  });

  beforeEach(async () => {
    root = mkdtempSync(path.join(socketTmpRoot(), "fxr-c26-"));
    home = path.join(root, "home");
    stateDir = path.join(home, ".fx-runner");
    mkdirSync(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.stubEnv("GH_TOKEN", "invalid");
    vi.stubEnv("GITHUB_TOKEN", "invalid");
    vi.stubEnv("GH_HOST", "invalid.localhost");
    cloud = await startStrictRunnerCloud();
    fake = makeFake({ stream: fixtureText("stream.subscription.jsonl").split("\n")[0]! + "\n" });
    const key = generateRunnerKey();
    saveRunnerKey(stateDir, key);
    saveRegistration(stateDir, { version: 1, cloud_origin: cloud.origin, runner_id: randomUUID(), account_id: randomUUID(), credential_mode: "subscription", jkt: key.jkt, registered_at: new Date().toISOString() });
    cloud.trust(key.publicJwk);
    remote = path.join(root, "remote.git");
    git("init", "--bare", "-b", "main", remote);
    const seed = path.join(root, "seed");
    git("init", "-b", "main", seed);
    writeFileSync(path.join(seed, "README.md"), "hello\n");
    git("-C", seed, "add", "README.md");
    git("-C", seed, "commit", "-m", "first");
    git("-C", seed, "push", remote, "main");
    setSetting(stateDir, "sandbox_engine", "microvm");
    for (const [k, v] of [["microvm.max_vms", "2"], ["microvm.max_vcpus", "4"], ["microvm.max_memory_mb", "4096"], ["microvm.snapshot_dir", path.join(home, "snaps")], ["microvm.snapshot_quota_bytes", "1073741824"]] as const) setSetting(stateDir, k, v);
    stage("beforeEach: cloud, runner key, registration and git remote are set up");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    let doneError: unknown;
    let doneFailed = false;
    if (started !== undefined) {
      started.signals.emit("SIGTERM");
      // a non-CliError rejection of `done` is kept, the cleanup below always runs, and the error is rethrown after it
      await Promise.race([started.done, new Promise((resolve) => setTimeout(resolve, 90_000))]).catch((error: unknown) => {
        doneFailed = true;
        doneError = error;
      });
    }
    for (const id of sandboxIds) await helper.destroy(id).catch(() => undefined); // fx-swallow-ok: an id the helper no longer holds is the wanted state
    await cloud.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
    if (doneFailed) throw doneError;
  });

  const vmFacts = async (): Promise<VmHostFacts> => ({ kvm: "present", helperSocket: "present", helperSocketPath: E["FX_VM_HELPER_SOCKET"] as string, helperState: "ready", totalMemMb: 16384, cpus: 4, readMemAvailableBytes: () => parseMemAvailableBytes(readFileSync("/proc/meminfo", "utf8")) });

  /** The production parts: the real egress pair (no test hooks, so the model host is reached for real), the image's own CLI, and a token read that hands out a fresh copy each time (the token step wipes the copy). */
  const parts = (): LiveMicrovmParts => {
    const d = signed.digests(process.arch === "arm64" ? "arm64" : "amd64");
    const logDir = path.join(stateDir, "logs");
    mkdirSync(logDir, { recursive: true });
    const made = createMicrovmParts({ euid: process.geteuid?.(), uid: process.getuid?.(), platform: process.platform, helperSocket: E["FX_VM_HELPER_SOCKET"] as string, tuf: signed.client, readManifest: () => JSON.stringify({ [TEMPLATES[0]]: { kernel: d.kernel, rootfs: d.rootfs } }), nodeArch: process.arch, now: Date.now, egress: { startProxy: startEgressProxy, startReverse: (o) => startReverseEndpoint({ ...o, onDecision: (x) => void reversed.push(x) }) }, logDir: () => logDir, readToken: () => Buffer.from(token) });
    const bindings = new GuestBindings();
    return { ...made, deps: { ...made.deps, helper: { ...made.deps.helper, prepare: async (p) => (sandboxIds.add(p.sandboxId), stage(`helper.prepare called (${sandboxIds.size} sandbox id(s) so far)`), made.deps.helper.prepare(p)), list: async () => (await made.deps.helper.list()).filter((e) => sandboxIds.has(e.sandboxId)) } }, bindings, makeRuntime: guestMakeRuntime({ credentials: { mode: "subscription" }, logDir, agentPath: "/opt/fx/bin/claude" }, bindings.binding) };
  };

  /** Text for an error message: every occurrence of the token is replaced. */
  const scrub = (text: string): string => scrubText(token.toString(), text);

  /** The host's raw transcripts of the CLI's output (each log line is `{kind, line}` JSON). */
  const transcripts = (): string => {
    const lines: string[] = [];
    for (const entry of readdirSync(path.join(stateDir, "logs"), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      for (const raw of readFileSync(path.join(entry.parentPath, entry.name), "utf8").split("\n")) {
        const parsed = raw === "" ? {} : (JSON.parse(raw) as { line?: unknown });
        if (typeof parsed.line === "string") lines.push(parsed.line);
      }
    }
    return lines.join("\n");
  };

  /** The scrubbed start of the host transcripts, read while `root` still exists (afterEach removes it), for a failure message. A transcript that cannot be read says so. */
  const transcriptNote = (): string => {
    try {
      return `\nhost transcripts (scrubbed, first 4000 chars):\n${scrub(transcripts()).slice(0, 4000)}`;
    } catch {
      return "\n(host transcripts could not be read)";
    }
  };

  it("26 (real CLI): the job completes, the check passes in a fresh VM, c26.txt is pushed, the model host was allowed by the reverse relay, the result is no error and names Haiku, and the token is on no host disk", async () => {
    const check = { argv: ["sh", "-c", `grep -qx ${LINE} c26.txt`], dev_shell: false, timeout_s: 120 };
    cloud.enqueue(signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(), model_hint: "haiku-4.5", task: { kind: "implement", prompt: PROMPT, prompt_sha256: sha256Text(PROMPT) }, check }));
    const signals = new EventEmitter();
    const ctx: CommandContext = { stateDir, out: (l) => logLines.push(l), err: (l) => logLines.push(l), now: () => new Date(), fetchFn: fetch };
    const toolbin = path.join(root, "toolbin");
    mkdirSync(toolbin);
    for (const name of ["bwrap", "socat"]) writeFileSync(path.join(toolbin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // a microVM job never uses the host's own agent CLI, but the runner looks for a runnable one on its search path at start and refuses without it (vmJob.real.test.ts links its stand-in the same way)
    symlinkSync(fake.binary, path.join(toolbin, "claude"));
    const host: RunHost = { home, platform: "linux", signals: signals as unknown as RunHost["signals"], pid: process.pid, kill: (pid, signal) => process.kill(pid, signal), chdir: () => undefined, engine: createClaudeKit(spawn, { launch: testLaunch(), bashSandboxUnusable: shellSandboxUsable }), sandbox: fakeSandboxHost(), vmFacts, microvm: parts() };
    const hooks: RunHooks = { keyrings: { [originHash(cloud.origin)!]: KEYRING }, searchPath: toolbin, probe: { read: () => ({ totalMemBytes: 64 * 1024 ** 3, availMemBytes: 60 * 1024 ** 3, load1: 0, cores: 32, freeDiskBytes: 500 * 1024 ** 3 }) }, jobLimits: { enforced: true }, remoteUrl: () => pathToFileURL(remote).href };
    stage("runCommand: starting");
    // a CliError's message is fixed text, never a token; it is kept in the log lines so that a refusal says why
    const done = runCommand(ctx, host, hooks).then((code) => { stage(`runCommand: returned exit code ${code}`); return code; }, (error: unknown) => { if (!(error instanceof CliError)) throw error; logLines.push(`refused: ${error.message}`); stage(`runCommand: ended with exit code ${error.exitCode}: ${scrub(error.message)}`); return error.exitCode; });
    let ended: number | undefined;
    void done.then((code) => { ended = code; }, () => undefined); // fx-swallow-ok: the rejection is reported where `done` is awaited
    started = { signals, done };
    let claimSeen = false;
    let lastBeat = Date.now();
    try {
      await until(() => {
        if (!claimSeen && cloud.seen.some((s) => s.path.endsWith("/claim"))) {
          claimSeen = true;
          stage("the fake cloud saw a claim");
        }
        // the command ended before it claimed anything: nothing can arrive now, so fail at once with what it printed
        if (ended !== undefined && !claimSeen) throw new EndedBeforeClaim(`runCommand ended with exit code ${ended} before any claim (cloud.seen=${cloud.seen.length}); the runner said:\n${scrub(logLines.slice(-40).join("\n"))}`);
        if (Date.now() - lastBeat >= 60_000) {
          lastBeat = Date.now();
          stage(`waiting: cloud.seen=${cloud.seen.length} sandboxIds=${sandboxIds.size}; last log lines:\n${scrub(logLines.slice(-5).join("\n"))}`);
        }
        return [...cloud.runs.values()].some((r) => r.doneReply !== undefined || r.endedBy !== undefined);
      }, WAIT_MS);
    } catch (error) {
      if (error instanceof EndedBeforeClaim) throw error;
      throw new Error(`timed out; the runner said:\n${scrub(logLines.slice(-40).join("\n"))}${transcriptNote()}`);
    }
    const runId = [...cloud.runs.keys()][0]!;
    const body = cloud.seen.filter((s) => s.path.endsWith(`/${runId}/done`)).map((s) => s.body as { check?: { exit_code: number | null; timed_out: boolean } })[0];
    // taken before any expect, while the test's root still exists, so a failure here carries what the CLI printed
    const note = transcriptNote();
    expect(body, `the job did not complete; the runner said:\n${scrub(logLines.slice(-40).join("\n"))}${note}`).toBeDefined();
    expect(body!.check, `the check did not pass; the done body is ${scrub(JSON.stringify(body))}${note}`).toMatchObject({ exit_code: 0, timed_out: false });
    expect(cloud.runs.get(runId)!.endedBy).toBeUndefined();
    // two VMs: the agent's, then the check's (a fresh one)
    expect(sandboxIds.size).toBe(2);
    // the pushed branch holds the agent's file
    const refs = git("--git-dir", remote, "for-each-ref", "--format=%(refname)", "refs/heads/fx/").split("\n").filter((r) => r !== "");
    expect(refs).toHaveLength(1);
    expect(git("--git-dir", remote, "show", `${refs[0]!}:c26.txt`)).toBe(LINE);
    // the host's own decision log: the model host was allowed through the reverse relay
    const allowed = reversed.filter((d) => d.outcome === "allow");
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.filter((d) => d.host !== "api.anthropic.com"), "the reverse relay allowed a host other than the model host").toEqual([]);
    // the CLI's result line: not an error, and the model is a Haiku
    const said = transcripts();
    const results = said.split("\n").filter((l) => l.includes('"type":"result"')).map((l) => JSON.parse(l) as { is_error?: boolean });
    expect(results.length).toBeGreaterThan(0);
    expect(results[results.length - 1]!.is_error).toBe(false);
    expect(/"model":"claude-haiku/.test(said), "the transcript names no Haiku model").toBe(true);
    // no VM is left, and the token is on no host disk (a planted control proves the search can find it)
    signals.emit("SIGTERM");
    expect(await done).toBe(0);
    const held = new Set((await helper.list()).map((e) => e.sandboxId));
    for (const id of sandboxIds) expect(held.has(id), `the helper still holds ${id}`).toBe(false);
    const planted = path.join(root, "planted.txt");
    writeFileSync(planted, Buffer.concat([Buffer.from("x"), token, Buffer.from("x")]));
    // the test's own root (home, state, logs, workspaces, the VM snapshots under home/snaps, whatever their size) and the helper-owned directories named in FX_C26_SCAN_DIRS
    const dirs = [root, ...(E["FX_C26_SCAN_DIRS"] ?? "").split(":").filter((d) => d !== "")];
    expect(filesHolding(dirs, token)).toEqual([planted]);
    rmSync(planted);
    expect(filesHolding(dirs, token), "a file under the runner's root or a helper-owned directory holds the token").toEqual([]);
    // booleans only: a failure must never print the token or the text it was looked for in
    const leaked = (haystack: string): boolean => haystack.includes(token.toString());
    expect(leaked(logLines.join("\n")), "token leaked into the runner's output").toBe(false);
    expect(leaked(JSON.stringify(cloud.seen)), "token leaked into what the cloud saw").toBe(false);
    expect(leaked(said), "token leaked into the CLI transcript").toBe(false);
  }, IT_TIMEOUT_MS);
});
