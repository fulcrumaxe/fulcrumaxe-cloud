import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { SANDBOX_COMMAND_PURPOSE, signSandboxCommand, type SandboxCommand } from "@fulcrumaxe/runner-protocol";
import { afterAll, describe, expect, it } from "vitest";
import { createRunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey } from "../../src/keys.js";
import { createSandboxCommandReceiver, refusingSandboxLifecycle, SANDBOX_NONCE_CAPACITY, type SandboxLifecycle } from "../../src/daemon/sandboxCommands.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const keyring = { "job-key-1": publicKey };
const RUNNER = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const OTHER_RUNNER = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
let clock = new Date("2026-11-18T15:00:00Z");
const nonce = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const expIn = (s: number): string => new Date(clock.getTime() + s * 1000).toISOString();
const command = (n: number, over: Partial<SandboxCommand> = {}): SandboxCommand => ({ purpose: SANDBOX_COMMAND_PURPOSE, runner_id: RUNNER, kind: "delete_sandbox", name: "vm-one", nonce: nonce(n), exp: expIn(600), ...over }) as SandboxCommand;
const signed = (c: SandboxCommand, key = privateKey) => signSandboxCommand(c, "job-key-1", key);

function recorder(): { lifecycle: SandboxLifecycle; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    lifecycle: {
      stop: async (name) => (calls.push(`stop ${name}`), { ok: true }),
      delete: async (name) => (calls.push(`delete ${name}`), name === "busy" ? { ok: false, refusal: "in_use" } : { ok: true }),
      reapStopped: async () => (calls.push("reap"), { ok: true }),
    },
  };
}
const receiver = (lifecycle?: SandboxLifecycle, log?: (l: string) => void) => createSandboxCommandReceiver({ keyring, runnerId: RUNNER, now: () => clock, ...(lifecycle ? { lifecycle } : {}), ...(log ? { log } : {}) });

describe("the runner's sandbox command receive path", () => {
  it("applies a good command once and acks it", async () => {
    const { lifecycle, calls } = recorder();
    const r = receiver(lifecycle);
    r.receive([signed(command(1))]);
    await r.idle();
    expect(calls).toEqual(["delete vm-one"]);
    expect(r.pendingAcks()).toEqual([{ nonce: nonce(1), outcome: "applied" }]);
  });
  it("maps stop, delete and reap to the lifecycle, and a refusal to its reason", async () => {
    const { lifecycle, calls } = recorder();
    const r = receiver(lifecycle);
    r.receive([signed(command(1, { kind: "stop_sandbox" })), signed(command(2, { name: "busy" })), signed({ ...command(3, { kind: "reap_sandboxes" }), name: undefined } as SandboxCommand)]);
    await r.idle();
    expect(calls.sort()).toEqual(["delete busy", "reap", "stop vm-one"]);
    expect(r.pendingAcks().find((a) => a.nonce === nonce(2))).toEqual({ nonce: nonce(2), outcome: "refused", refusal: "in_use" });
  });
  it("runs a command once: the same nonce again does nothing, whether it comes in the same batch or later", async () => {
    const { lifecycle, calls } = recorder();
    const logs: string[] = [];
    const r = receiver(lifecycle, (l) => logs.push(l));
    const one = signed(command(1));
    r.receive([one, one]);
    await r.idle();
    r.receive([one]);
    await r.idle();
    expect(calls).toEqual(["delete vm-one"]);
    expect(logs.filter((l) => l.includes("nonce_reused"))).toHaveLength(2);
  });
  it("a command whose own run failed is not run again either", async () => {
    let n = 0;
    const r = receiver({ ...refusingSandboxLifecycle, delete: async () => (n++, Promise.reject(new Error("disk is on fire"))) });
    r.receive([signed(command(1))]);
    await r.idle();
    r.receive([signed(command(1))]);
    await r.idle();
    expect(n).toBe(1);
    expect(r.pendingAcks()).toEqual([{ nonce: nonce(1), outcome: "refused", refusal: "failed" }]);
  });
  it("drops, without any ack, a bad signature, a command for another runner, an expired command and an unpinned key", async () => {
    const { lifecycle, calls } = recorder();
    const r = receiver(lifecycle);
    r.receive([
      signed(command(1), stranger.privateKey),
      signed(command(2, { runner_id: OTHER_RUNNER })),
      signed(command(3, { exp: expIn(-1) })),
      { ...signed(command(4)), key_id: "other-key" },
      { ...signed(command(5)), command: { ...command(5), name: "vm-two" } },
    ]);
    await r.idle();
    expect(calls).toEqual([]);
    expect(r.pendingAcks()).toEqual([]);
  });
  it("accepts the same command again only if it was never accepted: an expired one dropped earlier is not remembered as used", async () => {
    const { lifecycle, calls } = recorder();
    const r = receiver(lifecycle);
    r.receive([signed(command(1, { exp: expIn(-1) }))]);
    r.receive([signed(command(1))]);
    await r.idle();
    expect(calls).toEqual(["delete vm-one"]);
  });
  it("forgets a nonce once its command can no longer verify, and holds a bounded number", async () => {
    const { lifecycle, calls } = recorder();
    const r = receiver(lifecycle);
    r.receive([signed(command(1, { exp: expIn(610) }))]);
    await r.idle();
    clock = new Date(clock.getTime() + 620_000);
    r.receive([signed(command(1, { exp: expIn(610) }))]);
    await r.idle();
    expect(calls).toHaveLength(2);
    const small = receiver(lifecycle);
    for (let n = 0; n < Math.ceil(SANDBOX_NONCE_CAPACITY / 5) + 4; n++) small.receive(Array.from({ length: 5 }, (_, k) => signed(command(1000 + n * 5 + k))));
    await small.idle();
    expect(calls).toHaveLength(2 + SANDBOX_NONCE_CAPACITY);
  });
  it("takes at most five commands from one reply", async () => {
    const { lifecycle, calls } = recorder();
    const r = receiver(lifecycle);
    r.receive(Array.from({ length: 9 }, (_, n) => signed(command(100 + n, { name: `vm-${n}` }))));
    await r.idle();
    expect(calls).toHaveLength(5);
  });
  it("by default refuses everything and touches nothing", async () => {
    const r = receiver();
    r.receive([signed(command(1))]);
    await r.idle();
    expect(r.pendingAcks()).toEqual([{ nonce: nonce(1), outcome: "refused", refusal: "unsupported" }]);
  });
  it("keeps an ack until the cloud answered 200 to the claim that carried it", async () => {
    const r = receiver();
    r.receive([signed(command(1)), signed(command(2))]);
    await r.idle();
    const first = r.pendingAcks();
    expect(first).toHaveLength(2);
    expect(r.pendingAcks()).toHaveLength(2);
    r.committed([first[0]!]);
    expect(r.pendingAcks().map((a) => a.nonce)).toEqual([nonce(2)]);
  });
});

describe("the claim carries the acks and hands the commands to the receiver", () => {
  function clientWith(replies: Array<{ status: number; body: unknown }>, opts: { protocolVersion?: number } = {}) {
    const seen: unknown[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      const next = replies.shift() ?? { status: 200, body: { retry_after: 60 } };
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const { lifecycle, calls } = recorder();
    const sandboxCommands = receiver(lifecycle);
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => clock, fetchFn, sandboxCommands, ...(opts.protocolVersion === undefined ? {} : { protocolVersion: opts.protocolVersion }) });
    return { client, seen, calls, sandboxCommands };
  }

  it("applies what the reply carries, and sends the ack on the next claim only", async () => {
    const { client, seen, calls, sandboxCommands } = clientWith([{ status: 200, body: { retry_after: 60, sandbox_commands: [signed(command(1))] } }]);
    await client.claim();
    await sandboxCommands.idle();
    await client.claim();
    await client.claim();
    expect(calls).toEqual(["delete vm-one"]);
    expect(seen).toEqual([{}, { sandbox_acks: [{ nonce: nonce(1), outcome: "applied" }] }, {}]);
  });

  it("repeats an ack the cloud did not accept (429)", async () => {
    const { client, seen, sandboxCommands } = clientWith([{ status: 200, body: { retry_after: 60, sandbox_commands: [signed(command(1))] } }, { status: 429, body: { retry_after: 4 } }]);
    await client.claim();
    await sandboxCommands.idle();
    await client.claim();
    await client.claim();
    expect(seen[1]).toEqual(seen[2]);
    expect(seen[1]).toHaveProperty("sandbox_acks");
  });

  it("a status poll, and a runner that declared an older protocol, send no acks and hand over no commands", async () => {
    const poll = clientWith([{ status: 200, body: { retry_after: 60 } }]);
    poll.sandboxCommands.receive([signed(command(1))]);
    await poll.sandboxCommands.idle();
    await poll.client.claim("bwrap_missing");
    expect(poll.seen).toEqual([{ sandbox_unavailable: "bwrap_missing" }]);
    const old = clientWith([{ status: 200, body: { retry_after: 60, sandbox_commands: [signed(command(2))] } }], { protocolVersion: 20 });
    await old.client.claim();
    await old.sandboxCommands.idle();
    expect(old.calls).toEqual([]);
  });

  it("a status poll leaves the acks alone: they are not marked sent, and the next ordinary claim still carries them; a poll reply's commands are not taken", async () => {
    const c = clientWith([
      { status: 200, body: { retry_after: 60, sandbox_commands: [signed(command(1))] } },
      { status: 200, body: { retry_after: 60, sandbox_commands: [signed(command(2))] } },
      { status: 200, body: { retry_after: 60 } },
    ]);
    await c.client.claim();
    await c.sandboxCommands.idle();
    await c.client.claim("bwrap_missing");
    await c.sandboxCommands.idle();
    await c.client.claim();
    expect(c.seen).toEqual([{}, { sandbox_unavailable: "bwrap_missing" }, { sandbox_acks: [{ nonce: nonce(1), outcome: "applied" }] }]);
    expect(c.calls).toEqual(["delete vm-one"]);
    expect(c.sandboxCommands.pendingAcks()).toEqual([]);
  });
});

describe("single use across a restart", () => {
  const dirs: string[] = [];
  const stateDir = (): string => {
    const d = mkdtempSync(path.join(tmpdir(), "fx-sbxcmd-"));
    dirs.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const boot = (statePath: string, lifecycle: SandboxLifecycle, log?: (l: string) => void) =>
    createSandboxCommandReceiver({ keyring, runnerId: RUNNER, now: () => clock, lifecycle, statePath, ...(log ? { log } : {}) });

  it("a command that already ran does not run again after the runner restarts", async () => {
    const file = path.join(stateDir(), "sandbox-commands-state.json");
    const { lifecycle, calls } = recorder();
    const logs: string[] = [];
    const captured = signed(command(1));
    const before = boot(file, lifecycle);
    before.receive([captured]);
    await before.idle();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const after = boot(file, lifecycle, (l) => logs.push(l));
    after.receive([captured]);
    await after.idle();
    expect(calls).toEqual(["delete vm-one"]);
    expect(logs.some((l) => l.includes("nonce_reused"))).toBe(true);
  });

  it("keeps only nonces that can still verify", async () => {
    const file = path.join(stateDir(), "sandbox-commands-state.json");
    const { lifecycle } = recorder();
    const first = boot(file, lifecycle);
    first.receive([signed(command(1))]);
    await first.idle();
    clock = new Date(clock.getTime() + 700_000);
    const later = boot(file, lifecycle);
    later.receive([signed(command(2))]);
    await later.idle();
    const kept = (JSON.parse(readFileSync(file, "utf8")) as { seen: Record<string, number> }).seen;
    expect(Object.keys(kept)).toEqual([nonce(2)]);
  });

  it("refuses a command that could have been captured before the process started, even when the state file is gone", async () => {
    const { lifecycle, calls } = recorder();
    const logs: string[] = [];
    const captured = signed(command(1));
    const older = boot(path.join(stateDir(), "sandbox-commands-state.json"), lifecycle);
    older.receive([captured]);
    await older.idle();
    clock = new Date(clock.getTime() + 300_000);
    const restarted = boot(path.join(stateDir(), "sandbox-commands-state.json"), lifecycle, (l) => logs.push(l));
    restarted.receive([captured]);
    await restarted.idle();
    expect(calls).toEqual(["delete vm-one"]);
    expect(logs.some((l) => l.includes("before_start"))).toBe(true);
    const early = receiver(lifecycle);
    early.receive([signed(command(2, { exp: expIn(599) }))]);
    await early.idle();
    expect(calls).toEqual(["delete vm-one"]);
  });

  it("after a restart with a clean state file, a fresh command is taken at once and a replay is still refused", async () => {
    const file = path.join(stateDir(), "sandbox-commands-state.json");
    const { lifecycle, calls } = recorder();
    const first = boot(file, lifecycle);
    const old = signed(command(1));
    first.receive([old]);
    await first.idle();
    clock = new Date(clock.getTime() + 60_000);
    const restarted = boot(file, lifecycle);
    restarted.receive([signed(command(2, { exp: expIn(300) })), old]);
    await restarted.idle();
    expect(calls).toEqual(["delete vm-one", "delete vm-one"]);
    expect(restarted.pendingAcks().map((a) => a.nonce)).toEqual([nonce(2)]);
  });

  it("with no clean state file (missing, or refused) the start guard still drops a command that expires before start plus the longest life", async () => {
    const { lifecycle, calls } = recorder();
    const logs: string[] = [];
    const dir = stateDir();
    const missing = boot(path.join(dir, "missing.json"), lifecycle, (l) => logs.push(l));
    missing.receive([signed(command(3, { exp: expIn(300) }))]);
    await missing.idle();
    const open = path.join(dir, "open.json");
    writeFileSync(open, JSON.stringify({ v: 1, seen: {} }), { mode: 0o600 });
    chmodSync(open, 0o644);
    const refused = boot(open, lifecycle);
    refused.receive([signed(command(4, { exp: expIn(300) }))]);
    await refused.idle();
    expect(calls).toEqual([]);
    expect(logs.some((l) => l.includes("before_start"))).toBe(true);
  });

  it("takes no command when the state file is a link, is open to others or is not what this module wrote, and when it cannot be written", async () => {
    const { lifecycle, calls } = recorder();
    const dir = stateDir();
    const real = path.join(dir, "real.json");
    writeFileSync(real, JSON.stringify({ v: 1, seen: {} }), { mode: 0o600 });
    const link = path.join(dir, "link.json");
    symlinkSync(real, link);
    const open = path.join(dir, "open.json");
    writeFileSync(open, JSON.stringify({ v: 1, seen: {} }), { mode: 0o600 });
    chmodSync(open, 0o644);
    const junk = path.join(dir, "junk.json");
    writeFileSync(junk, "not json", { mode: 0o600 });
    const wrongShape = path.join(dir, "shape.json");
    writeFileSync(wrongShape, JSON.stringify({ v: 1, seen: { "not-a-nonce": 5 } }), { mode: 0o600 });
    for (const file of [link, open, junk, wrongShape]) {
      const r = boot(file, lifecycle);
      r.receive([signed(command(7))]);
      await r.idle();
    }
    const gone = boot(path.join(dir, "no-such-dir", "state.json"), lifecycle);
    gone.receive([signed(command(8))]);
    await gone.idle();
    expect(calls).toEqual([]);
    expect(gone.pendingAcks()).toEqual([]);
  });
});
