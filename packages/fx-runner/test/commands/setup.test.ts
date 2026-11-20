import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_REGISTER_CAPABILITY, DEVICE_USER_CODE_PATTERN, jwkThumbprint, type Ed25519Jwk } from "@fulcrumaxe/runner-protocol";
import { runCli } from "../../src/cli.js";
import type { RunnerKey } from "../../src/keys.js";
import { loadRegistration } from "../../src/config.js";
import type { DeviceTerminal } from "../../src/context.js";
import type { DoctorHost } from "../../src/commands/doctor.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import type { ScopeSupport } from "../../src/sandbox/jobLimits.js";
import type { VmInstallFacts } from "../../src/vm/doctorChecks.js";
import { makeFake, type Fake } from "../engines/claude/harness.js";
import { startFakeDeviceCloud, type FakeDeviceCloud } from "../helpers/fakeDeviceCloud.js";
import { fakeSandboxHost } from "../helpers/fakeSandboxHost.js";
import { testLaunch } from "../helpers/launch.js";

/** D#845 ON-3: `fx-runner setup` and the device flow, against a fake of the cloud's device routes over a real HTTP connection and the real doctor. */
// Every key the CLI makes is kept here, so the secret-surface check can look for each one's private part (a failed flow saves none).
const made: RunnerKey[] = [];
vi.mock("../../src/keys.js", async (original) => {
  const real = await original<typeof import("../../src/keys.js")>();
  return { ...real, generateRunnerKey: () => (made.push(real.generateRunnerKey()), made.at(-1)!) };
});

const SCOPES_OK: ScopeSupport = { ok: true, tools: { systemdRun: "/x/systemd-run", systemctl: "/x/systemctl", env: "/x/env" }, runtimeDir: "/run/user/1000" };
const HOST_PATH = process.env.PATH ?? "";
const START = Date.parse("2026-11-20T12:00:00.000Z");
const sha = "c".repeat(64);
const NOTHING: VmInstallFacts = { unit: "absent", socket: "absent", binary: { state: "absent" }, signed: { state: "absent" }, config: { state: "absent" }, jailRoot: { state: "absent" }, group: { user: "alice", exists: false, member: false, active: false }, kvm: "present" };
const INSTALLED: VmInstallFacts = { unit: "active", socket: "answers", binary: { state: "ok", value: sha }, signed: { state: "ok", value: sha }, config: { state: "ok", value: { kind: "file", uid: 0, gid: 0, mode: 0o600 } }, jailRoot: { state: "ok", value: { kind: "dir", uid: 0, gid: 0, mode: 0o711 } }, group: { user: "alice", exists: true, member: true, active: true }, kvm: "present" };

let root: string;
let stateDir: string;
let fake: Fake;
let cloud: FakeDeviceCloud;
beforeEach(async () => {
  made.length = 0;
  root = mkdtempSync(path.join(tmpdir(), "fxr-setup-"));
  stateDir = path.join(root, "state");
  const toolbin = path.join(root, "toolbin");
  mkdirSync(toolbin);
  fake = makeFake();
  symlinkSync(fake.binary, path.join(toolbin, "claude"));
  for (const name of ["bwrap", "socat"]) {
    writeFileSync(path.join(toolbin, name), "#!/bin/sh\n");
    chmodSync(path.join(toolbin, name), 0o755);
  }
  vi.stubEnv("PATH", `${toolbin}:${HOST_PATH}`);
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) vi.stubEnv(name, "");
  cloud = await startFakeDeviceCloud(START);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(fake.dir, { recursive: true, force: true });
});

interface Rig {
  out: string[];
  err: string[];
  slept: number[];
  ran: string[][];
  asked: string[];
  abort: AbortController;
  /** What each askEnter returns, in order; `undefined` once the list is out. */
  answers: Array<string | undefined>;
  /** Called at each sleep, after the clock moved: where a test approves, expires or cancels. */
  onSleep?: ((n: number) => void) | undefined;
  /** Called at each sleep before the clock moves, with the length asked for: where a test approves in the last interval of a code's life. */
  beforeSleep?: ((n: number, ms: number) => void) | undefined;
  /** How far the clock really moves in a sleep when it is not the whole length (Ctrl-C part-way through the wait); undefined for all of it. */
  advance?: ((n: number, ms: number) => number | undefined) | undefined;
  /** Called when the Enter question is asked, before it is answered. */
  onAsk?: (() => void) | undefined;
  /** Called once each poll reply has been read by the CLI's fetch, before the CLI looks at it. */
  afterPoll?: (() => void) | undefined;
  /** Called each time the CLI reads the clock: where a test makes the save fail after the key is written. */
  onNow?: (() => void) | undefined;
  /** What the terminal and the service start did, in order: "release" when the Ctrl-C listener was removed, "run" for each service command. */
  events: string[];
  runCode: number;
}

async function runSetup(argv: string[], vm: VmInstallFacts | undefined, over: Partial<Rig> = {}): Promise<{ code: number; rig: Rig }> {
  const rig: Rig = { out: [], err: [], slept: [], ran: [], asked: [], abort: new AbortController(), answers: [], events: [], runCode: 0, ...over };
  const terminal: DeviceTerminal = {
    signal: () => rig.abort.signal,
    release: () => void rig.events.push("release"),
    askEnter: async (question) => {
      rig.asked.push(question);
      rig.onAsk?.();
      return rig.answers.shift();
    },
  };
  const doctor: DoctorHost = { platform: "linux", shellVars: [], engine: createClaudeKit(spawn, { launch: testLaunch() }), home: root, sandbox: fakeSandboxHost(), scopeSupport: SCOPES_OK, ...(vm === undefined ? {} : { vmInstall: async () => vm }) };
  const code = await runCli({
    argv,
    home: root,
    stateDirOverride: stateDir,
    hostname: "studio-pc",
    uid: 1000,
    platform: "linux",
    stdout: (t) => rig.out.push(t),
    stderr: (t) => rig.err.push(t),
    now: () => (rig.onNow?.(), new Date(cloud.clock.now)),
    fetchFn: (async (url: string, init?: RequestInit) => {
      const response = await fetch(url, init);
      if (String(url).endsWith("/poll")) rig.afterPoll?.();
      return response;
    }) as typeof fetch,
    sleep: async (ms) => {
      rig.slept.push(ms);
      rig.beforeSleep?.(rig.slept.length, ms);
      cloud.clock.now += rig.advance?.(rig.slept.length, ms) ?? ms;
      rig.onSleep?.(rig.slept.length);
    },
    doctorHost: doctor,
    serviceHost: { home: root, platform: "linux", command: ["/opt/fxr/node", "/opt/fxr/cli.js", "run"], path: "/opt/fxr/bin" },
    setupHost: { terminal, run: async (a) => (rig.ran.push([...a]), rig.events.push("run"), rig.runCode) },
  });
  return { code, rig };
}

const SETUP = (): string[] => ["setup", "--cloud-url", cloud.origin];
const text = (rig: Rig): string => rig.out.join("");
const codeShown = (rig: Rig): string[] => [...text(rig).matchAll(/Your code: (\S+)/g)].map((m) => m[1]!);
const unitFile = (): string => path.join(root, ".config", "systemd", "user", "fx-runner.service");
const stateFiles = (): string[] => (existsSync(stateDir) ? readdirSync(stateDir).filter((n) => !["versions", "claude-flags.json"].includes(n)) : []);
const RERUN = "fx-runner: The code expired. Run `fx-runner setup` again\n";
const thumbprintOfPem = (pem: string): string => jwkThumbprint(createPublicKey(createPrivateKey(pem)).export({ format: "jwk" }) as Ed25519Jwk);
/** No device code and no part of any key this run made in what the person sees (both streams) or in a started program's arguments. */
const expectNoSecrets = (rig: Rig, label: string): void => {
  const surface = [rig.out.join(""), rig.err.join(""), JSON.stringify(rig.ran)].join("\n");
  for (const row of cloud.codes) expect(surface, `${label}: device code`).not.toContain(row.deviceCode);
  expect(surface, `${label}: key`).not.toMatch(/PRIVATE KEY|BEGIN/);
  for (const key of made) {
    const jwk = key.privateKey.export({ format: "jwk" });
    expect(surface, `${label}: private scalar`).not.toContain(jwk.d!);
    expect(surface, `${label}: key pem`).not.toContain(key.privateKey.export({ format: "pem", type: "pkcs8" }).toString().split("\n")[1]!);
  }
};

describe("setup: the whole way", () => {
  it("criterion 1: checks, device flow, key at 0600 and the registration, the service installed and started, exit 0", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { onSleep: (n) => n === 2 && cloud.approve(cloud.codes[0]!.userCode) });
    expect(code).toBe(0);
    const out = text(rig);
    // The doctor's failed and warned checks come first, each with its fix line; the registration check (setup is making it) is not among them.
    expect(out).toContain("Claude login");
    expect(out).not.toContain("Registration:");
    expect(out.indexOf("Your code:")).toBeGreaterThan(out.indexOf("Claude login"));
    const [shown] = codeShown(rig);
    expect(shown).toMatch(DEVICE_USER_CODE_PATTERN);
    expect(out).toContain(`Open ${cloud.origin}/link`);
    // The key and the registration, private; the cloud's reply is what was stored.
    expect(lstatSync(path.join(stateDir, "runner-key.pem")).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.join(stateDir, "registration.json")).mode & 0o777).toBe(0o600);
    const registration = loadRegistration(stateDir)!;
    expect(registration).toMatchObject({ cloud_origin: cloud.origin, account_id: cloud.accountId, credential_mode: "subscription" });
    expect(stateFiles().sort()).toEqual(["registration.json", "runner-key.pem"]);
    // The saved key is the key the approval was bound to: the same thumbprint as the registration and as the key the cloud holds on the approved code's row.
    const savedKey = thumbprintOfPem(readFileSync(path.join(stateDir, "runner-key.pem"), "utf8"));
    expect(savedKey).toBe(registration.jkt);
    expect(savedKey).toBe(jwkThumbprint(cloud.codes[0]!.jwk));
    expect(cloud.leftBehind()).toHaveLength(1);
    // The success line names the account that was joined (the reply gives its id, not a name), so a wrong link can be noticed.
    expect(out).toContain(`in account ${cloud.accountId}`);
    // The Ctrl-C listener is gone before the service is started.
    expect(rig.events).toEqual(["release", "run", "run"]);
    // The service: its unit is written and the two start commands run as fixed argument lists.
    expect(readFileSync(unitFile(), "utf8")).toContain("fx-runner");
    expect(rig.ran).toEqual([["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "fx-runner.service"]]);
    expect(out).toContain("The runner service is installed and running.");
    expect(out).not.toContain("Next: sudo fx-runner vm install");
  });

  it("criterion 1: a machine with /dev/kvm and no VM helper ends with exactly the one next step, and still exits 0", async () => {
    const { code, rig } = await runSetup(SETUP(), NOTHING, { onSleep: (n) => n === 1 && cloud.approve(cloud.codes[0]!.userCode) });
    expect(code).toBe(0);
    expect(text(rig).split("\n").filter((l) => l.startsWith("Next:"))).toEqual(["Next: sudo fx-runner vm install"]);
    expect(text(rig).trimEnd().endsWith("Next: sudo fx-runner vm install")).toBe(true);
    // The fact sent to the approval page: kvm present.
    expect(JSON.parse(cloud.seen[0]!.body).facts).toMatchObject({ kvm: true, os: "linux", hostname: "studio-pc" });
  });

  it("no hint without /dev/kvm, and a failed VM check never blocks registration: it registers on the standard tier and says so", async () => {
    const noKvm = await runSetup(SETUP(), { ...NOTHING, kvm: "absent" }, { onSleep: (n) => n === 1 && cloud.approve(cloud.codes[0]!.userCode) });
    expect(noKvm.code).toBe(0);
    expect(text(noKvm.rig)).not.toContain("Next:");
    expect(JSON.parse(cloud.seen[0]!.body).facts.kvm).toBe(false);
    rmSync(stateDir, { recursive: true, force: true });
    cloud.seen.length = 0;
    const failed = await runSetup(SETUP(), { ...INSTALLED, unit: "inactive" }, { onSleep: (n) => n === 1 && cloud.approve(cloud.codes[1]!.userCode) });
    expect(failed.code).toBe(0);
    expect(text(failed.rig)).toMatch(/FAIL\s+VM unit:/);
    expect(text(failed.rig)).toContain("registers on the standard tier");
    expect(loadRegistration(stateDir)).toBeDefined();
  });

  it("a service that cannot be started is reported with the commands to run, after the registration is kept", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { runCode: 1, onSleep: (n) => n === 1 && cloud.approve(cloud.codes[0]!.userCode) });
    expect(code).toBe(1);
    expect(rig.err.join("")).toContain("systemctl --user daemon-reload");
    expect(loadRegistration(stateDir)).toBeDefined();
  });
});

describe("criterion 2 and 15: expiry, Enter and Ctrl-C", () => {
  it("Enter after an expired code starts a new device flow with no re-run, and the second code is the one that is approved", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { answers: [""], onSleep: (n) => (n === 1 ? cloud.expire(cloud.codes[0]!.userCode) : n === 3 && cloud.approve(cloud.codes[1]!.userCode)) });
    expect(code).toBe(0);
    expect(text(rig)).toContain("The code expired. Press Enter for a new code");
    expect(rig.asked).toHaveLength(1);
    const shown = codeShown(rig);
    expect(shown).toHaveLength(2);
    expect(shown[1]).not.toBe(shown[0]);
    expect(cloud.codes).toHaveLength(2);
    // A new key for the new code: nothing of the first one was kept.
    expect(cloud.codes[1]!.jwk.x).not.toBe(cloud.codes[0]!.jwk.x);
    // The saved key, the registration and the approved row all carry the second code's key, never the first one's.
    const savedKey = thumbprintOfPem(readFileSync(path.join(stateDir, "runner-key.pem"), "utf8"));
    expect(savedKey).toBe(loadRegistration(stateDir)!.jkt);
    expect(savedKey).toBe(jwkThumbprint(cloud.codes[1]!.jwk));
    expect(savedKey).not.toBe(jwkThumbprint(cloud.codes[0]!.jwk));
  });

  it("an expired code with no Enter (an end of input, or any other answer) exits non-zero with the re-run words and stores nothing", async () => {
    for (const answers of [[undefined], ["no"]]) {
      rmSync(stateDir, { recursive: true, force: true });
      const { code, rig } = await runSetup(SETUP(), INSTALLED, { answers, onSleep: (n) => n === 1 && cloud.expire(cloud.codes.at(-1)!.userCode) });
      expect(code).not.toBe(0);
      expect(rig.err.join("")).toBe(RERUN);
      expect(stateFiles()).toEqual([]);
    }
  });

  it("a code that outlives its time is ended by this machine's own clock, with no answer from the cloud", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { answers: [undefined] });
    expect(code).not.toBe(0);
    expect(rig.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(600_000 + 5_000);
    expect(rig.err.join("")).toContain("The code expired");
    expect(stateFiles()).toEqual([]);
  });

  it("Ctrl-C while waiting for approval exits non-zero, stores nothing and asks no question", async () => {
    const abort = new AbortController();
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { abort, onSleep: (n) => n === 3 && abort.abort() });
    expect(code).toBe(130);
    // The row's own sentence, the one the expiry exit ends with, and nothing else.
    expect(rig.err.join("")).toBe(RERUN);
    expect(rig.asked).toEqual([]);
    expect(cloud.revokes).toEqual([]);
    expect(stateFiles()).toEqual([]);
    expect(rig.ran).toEqual([]);
  });

  it("Ctrl-C while the person approves during the wait between polls: one last poll learns it and the runner is revoked, with its own signed request", async () => {
    const abort = new AbortController();
    const { code, rig } = await runSetup(SETUP(), INSTALLED, {
      abort,
      onSleep: (n) => {
        if (n !== 2) return;
        cloud.approve(cloud.codes[0]!.userCode);
        abort.abort();
      },
    });
    expect(code).toBe(130);
    const row = cloud.codes[0]!;
    expect(row.runnerId).toBeDefined();
    expect(rig.err.join("")).toBe(`fx-runner: The code expired. Run \`fx-runner setup\` again. Runner ${row.runnerId} was approved and has been revoked; nothing was kept.\n`);
    expect(cloud.revokes).toEqual([jwkThumbprint(row.jwk)]);
    expect(cloud.leftBehind()).toEqual([]);
    expect(stateFiles()).toEqual([]);
    expect(rig.ran).toEqual([]);
    expect(rig.events).toEqual(["release"]);
    expectNoSecrets(rig, "cancel after approval");
  });

  it("Ctrl-C while the approving poll reply is in flight revokes the runner the reply made and exits 130", async () => {
    const inFlight = new AbortController();
    let polled = 0;
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { abort: inFlight, afterPoll: () => void (++polled === 2 && inFlight.abort()), onSleep: (n) => n === 2 && cloud.approve(cloud.codes.at(-1)!.userCode) });
    expect(code).toBe(130);
    const row = cloud.codes.at(-1)!;
    expect(rig.err.join("")).toContain(`Runner ${row.runnerId} was approved and has been revoked`);
    expect(cloud.seen.filter((r) => r.path === "/api/runner/revoke")).toHaveLength(1);
    expect(cloud.revokes).toEqual([jwkThumbprint(row.jwk)]);
    expect(cloud.leftBehind()).toEqual([]);
    expect(stateFiles()).toEqual([]);
    expect(rig.ran).toEqual([]);
    expectNoSecrets(rig, "cancel in flight");
  });

  it("Ctrl-C at the Enter question ends it with the same sentence, and an Enter that arrives with the abort is still a cancel", async () => {
    const abort = new AbortController();
    const asked = await runSetup(SETUP(), INSTALLED, { abort, answers: [""], onAsk: () => abort.abort(), onSleep: (n) => n === 1 && cloud.expire(cloud.codes.at(-1)!.userCode) });
    expect(asked.code).toBe(130);
    expect(asked.rig.asked).toHaveLength(1);
    expect(asked.rig.err.join("")).toBe(RERUN);
    expect(stateFiles()).toEqual([]);
    expect(cloud.revokes).toEqual([]);
  });

  it("at most five codes in one run, then the re-run words", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { answers: ["", "", "", "", ""], onSleep: () => { for (const c of cloud.codes) if (c.status === "pending") cloud.expire(c.userCode); } });
    expect(code).not.toBe(0);
    expect(cloud.codes).toHaveLength(5);
    expect(rig.err.join("")).toContain("Run `fx-runner setup` again");
  });
});

describe("criterion 3 and 29: nothing is sent", () => {
  it("a machine that already holds a registration refuses with the existing message and sends nothing", async () => {
    await runSetup(SETUP(), INSTALLED, { onSleep: (n) => n === 1 && cloud.approve(cloud.codes[0]!.userCode) });
    cloud.seen.length = 0;
    const again = await runSetup(SETUP(), { ...INSTALLED, unit: "inactive" });
    expect(again.code).toBe(1);
    expect(again.rig.err.join("")).toContain("this machine already holds a runner registration, and a subscription login is never shared between accounts; run: fx-runner revoke, then register again");
    expect(cloud.seen).toEqual([]);
    expect(again.rig.ran).toEqual([]);
    // Not even the checks are run for a machine that is already registered.
    expect(text(again.rig)).toBe("");
  });

  it("the same refusal from `register` with no code", async () => {
    await runSetup(SETUP(), INSTALLED, { onSleep: (n) => n === 1 && cloud.approve(cloud.codes[0]!.userCode) });
    cloud.seen.length = 0;
    const again = await runSetup(["register", "--cloud-url", cloud.origin], undefined);
    expect(again.code).toBe(1);
    expect(again.rig.err.join("")).toContain("already holds a runner registration");
    expect(cloud.seen).toEqual([]);
  });

  it("a hello without the device-flow capability is never offered the flow: nothing is sent, nothing is stored", async () => {
    const { deviceRegister } = await import("../../src/deviceRegister.js");
    const lines: string[] = [];
    const ctx = { stateDir, out: (l: string) => void lines.push(l), err: () => undefined, now: () => new Date(cloud.clock.now), fetchFn: fetch, terminal: { signal: () => new AbortController().signal, askEnter: async () => undefined } };
    await expect(deviceRegister(ctx, { origin: cloud.origin, kvm: false, capabilities: ["wake_v1", "engine_bridge_v1"] })).rejects.toThrow(/cannot register through the device flow/);
    expect(cloud.seen).toEqual([]);
    expect(existsSync(stateDir)).toBe(false);
    // The same call with the capability reaches the cloud.
    cloud.seen.length = 0;
    await expect(deviceRegister({ ...ctx, sleep: async (ms: number) => void (cloud.clock.now += ms) }, { origin: cloud.origin, kvm: false, capabilities: [DEVICE_REGISTER_CAPABILITY] })).rejects.toThrow();
    expect(cloud.seen.length).toBeGreaterThan(0);
  });

  it("`register` with --credential-mode or --name but no code is still refused for its missing code, and without --cloud-url says so", async () => {
    const mode = await runSetup(["register", "--cloud-url", cloud.origin, "--credential-mode", "api_key"], undefined);
    expect(mode.code).toBe(2);
    expect(mode.rig.err.join("")).toContain("--code-stdin");
    const none = await runSetup(["register"], undefined);
    expect(none.code).toBe(2);
    expect(cloud.seen).toEqual([]);
  });
});

describe("criterion 4: the secrets", () => {
  it("the private key is in no request body, and neither the device code nor the key reaches the output, the error text or an argument list", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { onSleep: (n) => n === 2 && cloud.approve(cloud.codes[0]!.userCode) });
    expect(code).toBe(0);
    const pem = readFileSync(path.join(stateDir, "runner-key.pem"), "utf8");
    const d = createPrivateKey(pem).export({ format: "jwk" }).d!;
    expect(cloud.seen.length).toBeGreaterThan(2);
    for (const request of cloud.seen) {
      expect(request.body).not.toContain(d);
      expect(request.body).not.toContain("PRIVATE KEY");
      expect(Buffer.from(request.body).toString("base64")).not.toContain(Buffer.from(d, "base64url").toString("base64"));
    }
    // The start has no signature headers (the proof is in the body); every poll has them.
    expect(cloud.seen[0]!.headers.signature).toBeUndefined();
    expect(cloud.seen[1]!.headers.signature).toBeDefined();
    const deviceCode = cloud.codes[0]!.deviceCode;
    for (const surface of [text(rig), rig.err.join(""), JSON.stringify(rig.ran), readFileSync(path.join(stateDir, "registration.json"), "utf8"), readFileSync(unitFile(), "utf8")]) {
      expect(surface).not.toContain(deviceCode);
      expect(surface).not.toContain(d);
    }
  });
});

describe("polling is bounded and polite", () => {
  it("slow_down widens the wait by five seconds each time, up to a ceiling", async () => {
    const polls = 12;
    for (let i = 0; i < polls; i++) cloud.force.push({ path: "/api/runner/device/poll", status: 429, body: { error: { code: "slow_down", message: "slow_down" }, interval_s: 5 } });
    // A forced reply is made only for its own path, so the start is answered for real and the polls get the 429s.
    const { rig } = await runSetup(SETUP(), INSTALLED, { answers: [undefined] });
    expect(rig.slept.slice(0, 5)).toEqual([5000, 10000, 15000, 20000, 25000]);
    expect(Math.max(...rig.slept)).toBeLessThanOrEqual(60_000);
  });

  it("a server that says the code lives for a year still gets no more than ten minutes of polling", async () => {
    cloud.ttlMs = 365 * 86_400_000;
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { answers: [undefined] });
    expect(code).not.toBe(0);
    expect(rig.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(605_000);
    expect(cloud.seen.filter((r) => r.path.endsWith("/poll")).length).toBeLessThanOrEqual(130);
  });

  it("four failed polls in a row end it; a declined or used code ends it with its own words and stores nothing", async () => {
    for (let i = 0; i < 4; i++) cloud.force.push({ path: "/api/runner/device/poll", status: 503 });
    const down = await runSetup(SETUP(), INSTALLED);
    expect(down.code).toBe(1);
    expect(down.rig.err.join("")).toContain("the cloud refused the request (503");
    const declined = await runSetup(SETUP(), INSTALLED, { onSleep: (n) => n === 1 && cloud.deny(cloud.codes.at(-1)!.userCode) });
    expect(declined.rig.err.join("")).toContain("declined in the workspace");
    expect(stateFiles()).toEqual([]);
  });
});

describe("a hostile cloud", () => {
  const hostileStart: Array<[string, (r: Record<string, unknown>) => Record<string, unknown>]> = [
    ["a link to another origin", (r) => ({ ...r, verification_uri: "https://evil.example.com/link" })],
    ["a link with another path", (r) => ({ ...r, verification_uri: `${String(r.verification_uri).replace("/link", "/x")}` })],
    ["a code with control characters", (r) => ({ ...r, user_code: "BCDF\u001b[2J" })],
    ["a code in lower case", (r) => ({ ...r, user_code: "bcdf-ghjk" })],
    ["an extra key", (r) => ({ ...r, extra: "x" })],
    ["a device code of the wrong form", (r) => ({ ...r, device_code: "fxrd_../../../etc" })],
    ["an expiry in the past", (r) => ({ ...r, expires_at: new Date(START - 1000).toISOString() })],
  ];
  it.each(hostileStart)("start reply with %s is refused: nothing is shown as a code, nothing is stored, no poll is made", async (_name, tweak) => {
    cloud.tweakStart = tweak;
    const { code, rig } = await runSetup(SETUP(), INSTALLED);
    expect(code).not.toBe(0);
    expect(rig.err.join("")).toContain("not understood");
    expect(text(rig)).not.toContain("Your code:");
    expect(stateFiles()).toEqual([]);
    expect(cloud.seen.filter((r) => r.path.endsWith("/poll"))).toEqual([]);
  });

  const hostileApproved: Array<[string, (r: Record<string, unknown>) => Record<string, unknown>]> = [
    ["a runner id that is a path", (r) => ({ ...r, registration: { ...(r.registration as object), runner_id: "../../../../etc/cron.d/x" } })],
    ["an extra key in the registration", (r) => ({ ...r, registration: { ...(r.registration as object), state_dir: "/etc" } })],
    ["an unknown mode", (r) => ({ ...r, registration: { ...(r.registration as object), credential_mode: "root" } })],
    ["an extra key beside it", (r) => ({ ...r, write: "/etc/passwd" })],
  ];
  it.each(hostileApproved)("an approved reply with %s writes nothing, and the service is not installed", async (_name, tweak) => {
    cloud.tweakApproved = tweak;
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { onSleep: (n) => n === 1 && cloud.approve(cloud.codes[0]!.userCode) });
    expect(code).not.toBe(0);
    expect(stateFiles()).toEqual([]);
    expect(existsSync(unitFile())).toBe(false);
    expect(rig.ran).toEqual([]);
  });

  it("a state directory that is a link is refused before anything is written through it", async () => {
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, stateDir);
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { onSleep: (n) => n === 1 && cloud.approve(cloud.codes[0]!.userCode) });
    expect(code).not.toBe(0);
    // Not even the doctor's own file: the directory is judged before the checks run.
    expect(readdirSync(elsewhere)).toEqual([]);
    // Refused before the cloud is asked for a code: no request at all, so no runner exists to undo.
    expect(cloud.seen).toEqual([]);
    expect(cloud.codes).toEqual([]);
    expect(rig.err.join("")).toContain("not a plain directory");
  });

  it("a register lock held by another run is refused before the cloud is asked for a code", async () => {
    mkdirSync(stateDir, { mode: 0o700 });
    writeFileSync(path.join(stateDir, "register.lock"), "", { mode: 0o600 });
    const { code, rig } = await runSetup(SETUP(), INSTALLED);
    expect(code).not.toBe(0);
    expect(rig.err.join("")).toContain("another fx-runner register is running");
    expect(cloud.seen).toEqual([]);
  });
});

describe("an approved runner is never left behind", () => {
  const approveAt = (n: number): ((k: number) => void) => (k) => k === n && cloud.approve(cloud.codes[0]!.userCode);
  const runnerFiles = (): string[] => stateFiles().filter((f) => f === "runner-key.pem" || f === "registration.json");

  it("the register lock taken by another run while the code is being approved: the runner is revoked with the approved key, and the message names it", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { onSleep: (n) => (n === 1 ? (cloud.approve(cloud.codes[0]!.userCode), writeFileSync(path.join(stateDir, "register.lock"), "", { mode: 0o600 })) : undefined) });
    const row = cloud.codes[0]!;
    expect(code).toBe(1);
    expect(rig.err.join("")).toContain("another fx-runner register is running");
    expect(rig.err.join("")).toContain(`Runner ${row.runnerId} was approved and has been revoked`);
    expect(cloud.revokes).toEqual([jwkThumbprint(row.jwk)]);
    expect(cloud.leftBehind()).toEqual([]);
    expect(runnerFiles()).toEqual([]);
    expect(rig.ran).toEqual([]);
    expectNoSecrets(rig, "lock held");
  });

  it("the state directory turned into a link while the code is being approved: the runner is revoked, and nothing is written through the link", async () => {
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    const { code, rig } = await runSetup(SETUP(), INSTALLED, {
      onSleep: (n) => {
        if (n !== 1) return;
        cloud.approve(cloud.codes[0]!.userCode);
        rmSync(stateDir, { recursive: true, force: true });
        symlinkSync(elsewhere, stateDir);
      },
    });
    expect(code).toBe(1);
    expect(rig.err.join("")).toContain("not a plain directory");
    expect(cloud.revokes).toHaveLength(1);
    expect(cloud.leftBehind()).toEqual([]);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("a key that cannot be saved: the runner is revoked and no key file remains", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, {
      onSleep: (n) => {
        if (n !== 1) return;
        cloud.approve(cloud.codes[0]!.userCode);
        // A non-empty directory where the key file goes: the rename of the new key onto it fails.
        mkdirSync(path.join(stateDir, "runner-key.pem"));
        writeFileSync(path.join(stateDir, "runner-key.pem", "x"), "");
      },
    });
    expect(code).toBe(1);
    expect(rig.err.join("")).toContain(`Runner ${cloud.codes[0]!.runnerId} was approved and has been revoked`);
    expect(cloud.leftBehind()).toEqual([]);
    expect(lstatSync(path.join(stateDir, "runner-key.pem")).isDirectory()).toBe(true);
    expect(existsSync(path.join(stateDir, "registration.json"))).toBe(false);
    expect(rig.ran).toEqual([]);
  });

  it("a registration that cannot be saved after the key was: the runner is revoked and the key file this run wrote is removed", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, {
      onSleep: approveAt(1),
      // The registration's own timestamp is read right after the key is written: the file name is taken by a directory there.
      onNow: () => {
        if (existsSync(path.join(stateDir, "runner-key.pem")) && !existsSync(path.join(stateDir, "registration.json"))) mkdirSync(path.join(stateDir, "registration.json"));
      },
    });
    expect(code).toBe(1);
    const row = cloud.codes[0]!;
    expect(rig.err.join("")).toContain(`Runner ${row.runnerId} was approved and has been revoked`);
    expect(cloud.revokes).toEqual([jwkThumbprint(row.jwk)]);
    expect(cloud.leftBehind()).toEqual([]);
    expect(existsSync(path.join(stateDir, "runner-key.pem"))).toBe(false);
    expect(rig.ran).toEqual([]);
    expectNoSecrets(rig, "save failed");
  });

  it("when the revoke itself is refused, the message names the runner that is left, and the key file is still removed", async () => {
    cloud.force.push({ path: "/api/runner/revoke", status: 403, body: { error: { code: "forbidden", message: "forbidden" } } });
    const { code, rig } = await runSetup(SETUP(), INSTALLED, {
      onSleep: approveAt(1),
      onNow: () => {
        if (existsSync(path.join(stateDir, "runner-key.pem")) && !existsSync(path.join(stateDir, "registration.json"))) mkdirSync(path.join(stateDir, "registration.json"));
      },
    });
    expect(code).toBe(1);
    const row = cloud.codes[0]!;
    expect(rig.err.join("")).toContain(`Runner ${row.runnerId} was approved but could not be revoked from here: revoke it on the runner screen in the workspace.`);
    expect(cloud.leftBehind().map((c) => c.runnerId)).toEqual([row.runnerId]);
    expect(existsSync(path.join(stateDir, "runner-key.pem"))).toBe(false);
  });
});

describe("every round that ends without a kept registration revokes what its code may have made", () => {
  const thumb = (i: number): string => jwkThumbprint(cloud.codes[i]!.jwk);
  const revokeRequests = (): number => cloud.seen.filter((r) => r.path === "/api/runner/revoke").length;
  const LEFT = "A runner this code created was revoked.";
  const POLL = "/api/runner/device/poll";
  /** Approves the first code in the last interval of its life, before the sleep that carries this machine's clock past its own deadline: the CLI never polls again. */
  const approveInLastInterval = (_n: number, ms: number): void => {
    const row = cloud.codes[0]!;
    if (row.status === "pending" && cloud.clock.now + ms >= row.expiresAt) cloud.approve(row.userCode);
  };

  it("(a) approval in the last interval, no Enter: the runner is revoked with the round's key and the person is told", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { answers: [undefined], beforeSleep: approveInLastInterval });
    expect(code).toBe(1);
    const row = cloud.codes[0]!;
    // The approval really happened and this machine never saw it: the approved reply was never handed out.
    expect(row.runnerId).toBeDefined();
    expect(row.status).toBe("approved");
    expect(rig.err.join("")).toBe(RERUN);
    expect(text(rig)).toContain(`The code was approved as it ended. ${LEFT}`);
    expect(revokeRequests()).toBe(1);
    expect(cloud.revokes).toEqual([thumb(0)]);
    expect(cloud.leftBehind()).toEqual([]);
    expect(stateFiles()).toEqual([]);
    expectNoSecrets(rig, "approved in the last interval");
  });

  it("(a) approval in the last interval, Enter for a new code: the first round's runner is revoked before the second code is asked for, and each round sends at most one revoke", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { answers: [""], beforeSleep: approveInLastInterval });
    expect(code).toBe(1);
    expect(cloud.codes).toHaveLength(2);
    expect(cloud.revokes).toEqual([thumb(0)]);
    expect(cloud.leftBehind()).toEqual([]);
    // One revoke request per round; the second round's code was never approved, so its revoke gets 401 and says nothing.
    expect(revokeRequests()).toBe(2);
    const order = cloud.seen.map((r) => r.path);
    expect(order.indexOf("/api/runner/revoke")).toBeLessThan(order.lastIndexOf("/api/runner/device/start"));
    expect(rig.err.join("")).toBe(RERUN);
    expect(text(rig).split(LEFT)).toHaveLength(2);
    expect(stateFiles()).toEqual([]);
  });

  it("(b) an approval followed by four failed polls: the runner is revoked", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, {
      beforeSleep: (n) => {
        if (n !== 1) return;
        cloud.approve(cloud.codes[0]!.userCode);
        for (let i = 0; i < 4; i++) cloud.force.push({ path: POLL, status: 503 });
      },
    });
    expect(code).toBe(1);
    expect(rig.err.join("")).toContain("the cloud refused the request (503");
    expect(rig.err.join("")).toContain(LEFT);
    expect(cloud.force).toEqual([]);
    expect(revokeRequests()).toBe(1);
    expect(cloud.revokes).toEqual([thumb(0)]);
    expect(cloud.leftBehind()).toEqual([]);
    expect(stateFiles()).toEqual([]);
    expectNoSecrets(rig, "approval then four failed polls");
  });

  it("(b) an approving reply lost in transit, then 410 consumed: the runner is revoked", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, {
      beforeSleep: (n) => {
        if (n !== 1) return;
        cloud.approve(cloud.codes[0]!.userCode);
        cloud.dropPollReplies = 1;
      },
    });
    expect(code).toBe(1);
    // The cloud consumed the code and made the runner; this machine never got the reply.
    expect(cloud.codes[0]!.status).toBe("consumed");
    expect(rig.err.join("")).toContain("That code was already used");
    expect(rig.err.join("")).toContain(LEFT);
    expect(revokeRequests()).toBe(1);
    expect(cloud.revokes).toEqual([thumb(0)]);
    expect(cloud.leftBehind()).toEqual([]);
    expect(stateFiles()).toEqual([]);
  });

  it("(c) an approved reply that fails the strict schema: the runner is revoked with the round's key", async () => {
    cloud.tweakApproved = (r) => ({ ...r, extra: "x" });
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { onSleep: (n) => n === 1 && cloud.approve(cloud.codes[0]!.userCode) });
    expect(code).toBe(1);
    expect(rig.err.join("")).toBe(`fx-runner: the cloud's reply was not understood; update fx-runner and try again. ${LEFT}\n`);
    expect(revokeRequests()).toBe(1);
    expect(cloud.revokes).toEqual([thumb(0)]);
    expect(cloud.leftBehind()).toEqual([]);
    expect(stateFiles()).toEqual([]);
    expectNoSecrets(rig, "approved reply not understood");
  });

  it("(d) Ctrl-C part-way through a wait, with an approval: the final poll waits out the rest of the interval, so it is not refused as too soon, and the runner it learns of is revoked", async () => {
    const abort = new AbortController();
    const { code, rig } = await runSetup(SETUP(), INSTALLED, {
      abort,
      // The second wait is cut at 2 s of its 5: Ctrl-C lands with 3 s of the interval still to run since the last poll.
      advance: (n) => (n === 2 ? 2_000 : undefined),
      onSleep: (n) => {
        if (n !== 2) return;
        cloud.approve(cloud.codes[0]!.userCode);
        abort.abort();
      },
    });
    expect(code).toBe(130);
    const row = cloud.codes[0]!;
    expect(rig.slept).toEqual([5_000, 5_000, 3_000]);
    // The final poll was answered with the approval (it is consumed), not with slow_down: the message names the runner it got.
    expect(row.status).toBe("consumed");
    expect(rig.err.join("")).toBe(`fx-runner: The code expired. Run \`fx-runner setup\` again. Runner ${row.runnerId} was approved and has been revoked; nothing was kept.\n`);
    expect(revokeRequests()).toBe(1);
    expect(cloud.revokes).toEqual([thumb(0)]);
    expect(cloud.leftBehind()).toEqual([]);
    expect(stateFiles()).toEqual([]);
  });

  it("(d) the final poll after Ctrl-C refused as too soon: the runner the approval made is still revoked, by the round's key", async () => {
    const abort = new AbortController();
    const { code, rig } = await runSetup(SETUP(), INSTALLED, {
      abort,
      onSleep: (n) => {
        if (n !== 2) return;
        cloud.approve(cloud.codes[0]!.userCode);
        cloud.force.push({ path: POLL, status: 429, body: { error: { code: "slow_down", message: "slow_down" }, interval_s: 5 } });
        abort.abort();
      },
    });
    expect(code).toBe(130);
    expect(rig.err.join("")).toBe(`fx-runner: The code expired. Run \`fx-runner setup\` again. ${LEFT}\n`);
    // The approved code was never consumed: this machine never saw the approval.
    expect(cloud.codes[0]!.status).toBe("approved");
    expect(revokeRequests()).toBe(1);
    expect(cloud.revokes).toEqual([thumb(0)]);
    expect(cloud.leftBehind()).toEqual([]);
    expect(stateFiles()).toEqual([]);
  });

  it("a code that was never approved sends one revoke at the end of its round, answered 401, and says nothing about it", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { answers: [undefined], onSleep: (n) => n === 1 && cloud.deny(cloud.codes[0]!.userCode) });
    expect(code).toBe(1);
    expect(revokeRequests()).toBe(1);
    expect(cloud.revokes).toEqual([]);
    expect(rig.err.join("")).not.toContain("revoked");
    expect(text(rig)).not.toContain("revoked");
  });

  it("a key file that cannot be removed after a failed save keeps the message that names the runner, and says where the file is", async () => {
    const keyPath = path.join(stateDir, "runner-key.pem");
    const { code, rig } = await runSetup(SETUP(), INSTALLED, {
      onSleep: (n) => n === 1 && cloud.approve(cloud.codes[0]!.userCode),
      // After the key is written and before the registration is: the key file becomes a directory (so removing it as a file fails) and the registration's name is taken too.
      onNow: () => {
        if (existsSync(keyPath) && lstatSync(keyPath).isFile()) {
          rmSync(keyPath);
          mkdirSync(keyPath);
          mkdirSync(path.join(stateDir, "registration.json"));
        }
      },
    });
    expect(code).toBe(1);
    const err = rig.err.join("");
    expect(err).toContain(`Runner ${cloud.codes[0]!.runnerId} was approved and has been revoked; nothing was kept.`);
    expect(err).toContain(`The key file ${keyPath} could not be removed; remove it yourself.`);
    expect(err).not.toContain("EISDIR");
    expect(cloud.leftBehind()).toEqual([]);
  });
});

describe("the secret surface on every exit", () => {
  type Setup = (rig: Partial<Rig>) => Promise<{ code: number; rig: Rig }>;
  const echo = (): unknown => ({ error: { code: "invalid_message", get message() { return cloud.codes.map((c) => c.deviceCode).join(" "); } } });
  const exits: Array<[string, (run: Setup) => Promise<{ code: number; rig: Rig }>, number | "nonzero"]> = [
    ["expired, no Enter", (run) => run({ answers: [undefined], onSleep: (n) => n === 1 && cloud.expire(cloud.codes.at(-1)!.userCode) }), "nonzero"],
    ["expired by this machine's own clock", (run) => run({ answers: [undefined] }), "nonzero"],
    ["declined", (run) => run({ onSleep: (n) => n === 1 && cloud.deny(cloud.codes.at(-1)!.userCode) }), "nonzero"],
    ["consumed", (run) => run({ onSleep: (n) => n === 1 && (cloud.codes.at(-1)!.status = "consumed") }), "nonzero"],
    ["cancelled while waiting", (run) => { const abort = new AbortController(); return run({ abort, onSleep: (n) => n === 2 && abort.abort() }); }, 130],
    ["cancelled at the question", (run) => { const abort = new AbortController(); return run({ abort, answers: [""], onAsk: () => abort.abort(), onSleep: (n) => n === 1 && cloud.expire(cloud.codes.at(-1)!.userCode) }); }, 130],
    ["five codes used", (run) => run({ answers: ["", "", "", "", ""], onSleep: () => { for (const c of cloud.codes) if (c.status === "pending") cloud.expire(c.userCode); } }), "nonzero"],
    ["5xx on the poll", (run) => { for (let i = 0; i < 4; i++) cloud.force.push({ path: "/api/runner/device/poll", status: 503 }); return run({}); }, 1],
    ["429 on the start", (run) => { cloud.force.push({ path: "/api/runner/device/start", status: 429, body: { error: { code: "rate_limited", message: "x" } } }); return run({}); }, 1],
    ["429 on every poll", (run) => { for (let i = 0; i < 12; i++) cloud.force.push({ path: "/api/runner/device/poll", status: 429, body: { error: { code: "slow_down", message: "slow_down" }, interval_s: 5 } }); return run({ answers: [undefined] }); }, "nonzero"],
    ["a refusal that echoes the device code", (run) => { cloud.force.push({ path: "/api/runner/device/poll", status: 400, body: echo() }); return run({}); }, 1],
    ["an approved reply that is not understood", (run) => { cloud.tweakApproved = (r) => ({ ...r, extra: "x" }); return run({ onSleep: (n) => n === 1 && cloud.approve(cloud.codes[0]!.userCode) }); }, "nonzero"],
    ["a start reply that is not understood", (run) => { cloud.tweakStart = (r) => ({ ...r, verification_uri: "https://evil.example.com/link" }); return run({}); }, "nonzero"],
    ["a device code of the wrong form", (run) => { cloud.tweakStart = (r) => ({ ...r, device_code: "fxrd_../../../etc" }); return run({}); }, "nonzero"],
  ];
  it.each(exits)("%s: no device code and no key in the output or the errors", async (label, go, exit) => {
    const { code, rig } = await go((over) => runSetup(SETUP(), INSTALLED, over));
    if (exit === "nonzero") expect(code).not.toBe(0);
    else expect(code).toBe(exit);
    expect(rig.err.join("") + rig.out.join("")).not.toBe("");
    expectNoSecrets(rig, label);
    expect(stateFiles()).toEqual([]);
    // Whatever the exit, a runner the cloud made is not left behind, a reply this machine could not read included.
    expect(cloud.leftBehind()).toEqual([]);
  });

  it("the success path too, and what the services were started with", async () => {
    const { code, rig } = await runSetup(SETUP(), INSTALLED, { onSleep: approveAt(2) });
    expect(code).toBe(0);
    expectNoSecrets(rig, "success");
  });
  function approveAt(n: number): (k: number) => void {
    return (k) => k === n && cloud.approve(cloud.codes[0]!.userCode);
  }
});

describe("criterion 5: built output moved to another directory", () => {
  it("the new files read nothing from where they sit: no module-relative path, no file read of their own", () => {
    for (const file of ["src/deviceRegister.ts", "src/commands/setup.ts", "src/registration.ts"]) {
      const source = readFileSync(path.join(__dirname, "..", "..", file), "utf8");
      expect(source, file).not.toMatch(/import\.meta|__dirname|__filename|readFileSync|createRequire|require\(/);
    }
  });
});
