import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { MACHINE_COMMAND_PURPOSE, MACHINE_COMMANDS_PER_CLAIM, signMachineCommand, type MachineCommand } from "@fulcrumaxe/runner-protocol";
import { describe, expect, it } from "vitest";
import { createClaudeLoginRunner, type ClaudeLoginRunner, type Outcome } from "../../src/daemon/claudeLogin.js";
import type { GhLoginRunner } from "../../src/daemon/ghLogin.js";
import { createMachineCommandReceiver, MACHINE_COMMAND_SEEN_CAPACITY } from "../../src/daemon/machineCommands.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const keyring = { "job-key-1": publicKey };
const RUNNER = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const OTHER_RUNNER = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const ADMIN = "5d3f1c2a-7b8e-4f90-a1b2-c3d4e5f60718";
const REQ = "11111111-1111-4111-8111-111111111111";
const clock = new Date("2026-11-23T15:00:00Z");
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (s: number): string => new Date(clock.getTime() + s * 1000).toISOString();
const base = (n: number) => ({ v: 1 as const, purpose: MACHINE_COMMAND_PURPOSE, command_id: id(n), runner_id: RUNNER, issued_by: ADMIN, issued_at: at(0), expires_at: at(600) });
const start = (n: number, over: Partial<MachineCommand> = {}) => ({ ...base(n), kind: "claude_login_start", args: { request_id: REQ }, ...over }) as MachineCommand;
const code = (n: number) => ({ ...base(n), kind: "claude_login_code", args: { request_id: REQ } }) as MachineCommand;
const logout = (n: number, over: Partial<MachineCommand> = {}) => ({ ...base(n), kind: "claude_logout", args: {}, ...over }) as MachineCommand;
const signed = (c: MachineCommand, key = privateKey) => signMachineCommand(c, "job-key-1", key);
const dropped = (reason: string): string => `fx-runner: a machine command was dropped (${reason})`;

function fake(answer: (call: string) => Outcome = () => ({ ok: true })) {
  const calls: string[] = [];
  const login: ClaudeLoginRunner = {
    start: async (r) => (calls.push(`start ${r}`), answer("start")),
    code: async (r) => (calls.push(`code ${r}`), answer("code")),
    logout: async () => (calls.push("logout"), answer("logout")),
    idle: async () => undefined,
  };
  return { login, calls };
}
const receiver = (login: ClaudeLoginRunner, lines: string[] = [], now = () => clock) => createMachineCommandReceiver({ keyring, runnerId: RUNNER, now, login, log: (l) => lines.push(l) });

describe("the runner's machine command receive path", () => {
  it("runs each kind once, in arrival order, and acks every one", async () => {
    const { login, calls } = fake();
    const r = receiver(login);
    r.receive([signed(start(1)), signed(code(2)), signed(logout(3))]);
    await r.idle();
    expect(calls).toEqual([`start ${REQ}`, `code ${REQ}`, "logout"]);
    expect(r.pendingAcks()).toEqual([1, 2, 3].map((n) => ({ command_id: id(n), outcome: "applied" })));
  });

  it("acks a refusal with its fixed reason, and a handler that throws as failed with none of its text", async () => {
    const lines: string[] = [];
    const { login } = fake((k) => {
      if (k === "code") throw new Error("boom with text");
      return { ok: false, refusal: "busy" };
    });
    const r = receiver(login, lines);
    r.receive([signed(start(1)), signed(code(2))]);
    await r.idle();
    expect(r.pendingAcks()).toEqual([
      { command_id: id(1), outcome: "refused", refusal: "busy" },
      { command_id: id(2), outcome: "refused", refusal: "failed" },
    ]);
    expect(JSON.stringify([lines, r.pendingAcks()])).not.toContain("boom");
  });

  it("drops, without an ack and without acting, a command signed by another key, for another runner, altered, expired, from the future, unsigned or not a command", async () => {
    const { login, calls } = fake();
    const lines: string[] = [];
    const r = receiver(login, lines);
    const good = signed(start(9));
    r.receive([
      signed(start(1), stranger.privateKey),
      signed(start(2, { runner_id: OTHER_RUNNER })),
      { ...good, command: { ...good.command, args: { request_id: "99999999-9999-4999-8999-999999999999" } } },
    ]);
    r.receive([
      signed(start(4, { issued_at: at(-700), expires_at: at(-100) })),
      signed(start(5, { issued_at: at(3600), expires_at: at(4000) })),
      { command: start(6), key_id: "job-key-1" },
      "not a command",
      null,
    ]);
    await r.idle();
    expect(calls).toEqual([]);
    expect(r.pendingAcks()).toEqual([]);
    expect(lines).toEqual([dropped("bad_signature"), dropped("bad_signature"), dropped("bad_signature"), dropped("expired"), dropped("expired"), dropped("missing_signature"), dropped("malformed"), dropped("malformed")]);
  });

  it("a command signed under another purpose string does not verify here", async () => {
    const { login, calls } = fake();
    const r = receiver(login);
    const other = signMachineCommand(start(1), "job-key-1", privateKey);
    r.receive([{ ...other, command: { ...other.command, purpose: "sandbox_command_v1" } }]);
    await r.idle();
    expect(calls).toEqual([]);
  });

  it("a command id seen before is dropped, in the same claim and in a later one", async () => {
    const { login, calls } = fake();
    const lines: string[] = [];
    const r = receiver(login, lines);
    r.receive([signed(logout(1)), signed(logout(1))]);
    await r.idle();
    r.receive([signed(logout(1))]);
    await r.idle();
    expect(calls).toEqual(["logout"]);
    expect(lines).toEqual([dropped("id_reused"), dropped("id_reused")]);
  });

  it("takes at most five per claim", async () => {
    const { login, calls } = fake();
    const r = receiver(login);
    r.receive(Array.from({ length: 8 }, (_, i) => signed(logout(i + 1))));
    await r.idle();
    expect(calls).toHaveLength(MACHINE_COMMANDS_PER_CLAIM);
    expect(MACHINE_COMMAND_SEEN_CAPACITY).toBeGreaterThan(MACHINE_COMMANDS_PER_CLAIM * 10);
  });

  it("holds acks until the claim that carried them was answered 200, then forgets exactly those", async () => {
    const { login } = fake();
    const r = receiver(login);
    r.receive([signed(logout(1)), signed(logout(2))]);
    await r.idle();
    const sent = r.pendingAcks();
    r.receive([signed(logout(3))]);
    await r.idle();
    expect(r.pendingAcks()).toHaveLength(3);
    r.committed(sent);
    expect(r.pendingAcks()).toEqual([{ command_id: id(3), outcome: "applied" }]);
  });

  it("keeps the newest acks when more than twenty wait", async () => {
    const { login } = fake();
    const r = receiver(login);
    for (let i = 0; i < 6; i++) {
      r.receive(Array.from({ length: 5 }, (_, j) => signed(logout(i * 5 + j + 1))));
      await r.idle();
    }
    const acks = r.pendingAcks();
    expect(acks).toHaveLength(MACHINE_COMMANDS_PER_CLAIM * 4);
    expect(acks.at(-1)!.command_id).toBe(id(30));
  });
});

describe("the seen command ids are kept across a restart", () => {
  const withState = (run: (stateDir: string, file: string) => Promise<void>) => async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "fx-machine-cmds-"));
    try {
      await run(stateDir, path.join(stateDir, "machine-commands-state.json"));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  };
  const persistent = (login: ClaudeLoginRunner, file: string, lines: string[] = [], now = () => clock) =>
    createMachineCommandReceiver({ keyring, runnerId: RUNNER, now, login, log: (l) => lines.push(l), statePath: file, uid: process.getuid?.() });

  it(
    "a sign-out the cloud delivers again after a restart is dropped, not run a second time",
    withState(async (_dir, file) => {
      const first = fake();
      const r1 = persistent(first.login, file);
      r1.receive([signed(logout(1))]);
      await r1.idle();
      expect(first.calls).toEqual(["logout"]);
      // the restart: a new receiver over the same file, and the same command again, 100 s later but well inside its 600 s life
      const second = fake();
      const lines: string[] = [];
      const r2 = persistent(second.login, file, lines, () => new Date(clock.getTime() + 100_000));
      r2.receive([signed(logout(1))]);
      await r2.idle();
      expect(second.calls).toEqual([]);
      expect(r2.pendingAcks()).toEqual([]);
      expect(lines).toEqual([dropped("id_reused")]);
      // a different id still runs
      r2.receive([signed(logout(2))]);
      await r2.idle();
      expect(second.calls).toEqual(["logout"]);
    }),
  );

  it(
    "writes the id before the command runs, as a 0600 plain file with the command's own expiry",
    withState(async (_dir, file) => {
      let seenOnDisk: unknown;
      const login: ClaudeLoginRunner = {
        start: async () => ({ ok: true }),
        code: async () => ({ ok: true }),
        logout: async () => {
          seenOnDisk = JSON.parse(readFileSync(file, "utf8"));
          return { ok: true };
        },
        idle: async () => undefined,
      };
      const r = persistent(login, file);
      r.receive([signed(logout(1))]);
      await r.idle();
      expect(seenOnDisk).toEqual({ v: 1, seen: { [id(1)]: clock.getTime() + 600_000 } });
      const st = lstatSync(file);
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o777).toBe(0o600);
      expect(readdirSync(path.dirname(file))).toEqual(["machine-commands-state.json"]);
    }),
  );

  it(
    "forgets an id once its command can no longer verify, and drops it from the file at the next write",
    withState(async (_dir, file) => {
      const a = fake();
      const r1 = persistent(a.login, file);
      r1.receive([signed(logout(1))]);
      await r1.idle();
      const later = () => new Date(clock.getTime() + 601_000);
      const b = fake();
      const r2 = persistent(b.login, file, [], later);
      // the expired id is not loaded, and writing a new one leaves it out of the file
      r2.receive([signed(logout(2, { issued_at: later().toISOString(), expires_at: new Date(later().getTime() + 600_000).toISOString() }))]);
      await r2.idle();
      expect(b.calls).toEqual(["logout"]);
      expect(Object.keys((JSON.parse(readFileSync(file, "utf8")) as { seen: object }).seen)).toEqual([id(2)]);
    }),
  );

  it(
    "a state file that cannot be trusted (a link, too wide, not what this module wrote) makes it take no command at all",
    withState(async (dir, file) => {
      const target = path.join(dir, "elsewhere");
      writeFileSync(target, JSON.stringify({ v: 1, seen: {} }), { mode: 0o600 });
      for (const make of [
        () => symlinkSync(target, file),
        () => writeFileSync(file, JSON.stringify({ v: 1, seen: {} }), { mode: 0o644 }),
        () => writeFileSync(file, "not json", { mode: 0o600 }),
        () => writeFileSync(file, JSON.stringify({ v: 1, seen: { "not-an-id": 1 } }), { mode: 0o600 }),
        () => writeFileSync(file, JSON.stringify({ v: 1, seen: [] }), { mode: 0o600 }),
      ]) {
        rmSync(file, { force: true });
        make();
        const { login, calls } = fake();
        const lines: string[] = [];
        const r = persistent(login, file, lines);
        r.receive([signed(logout(1))]);
        await r.idle();
        expect(calls).toEqual([]);
        expect(r.pendingAcks()).toEqual([]);
        expect(lines[0]).toBe("fx-runner: the machine command state file cannot be trusted; machine commands are refused");
      }
    }),
  );

  it(
    "an id that cannot be written down is a command that does not run",
    withState(async (dir, file) => {
      // the state directory is gone, so the exclusive create of the temp file fails
      const { login, calls } = fake();
      const lines: string[] = [];
      const r = persistent(login, path.join(dir, "missing-dir", "state.json"), lines);
      r.receive([signed(logout(1))]);
      await r.idle();
      expect(calls).toEqual([]);
      expect(lines).toEqual([dropped("state_unwritable")]);
      expect(existsSync(file)).toBe(false);
    }),
  );
});

describe("a runner that is not a cloud-managed server", () => {
  it("refuses every sign-in command with a closed code, acks each as refused, and starts nothing", async () => {
    let launched = 0;
    const reported: unknown[] = [];
    const login = createClaudeLoginRunner({
      host: {
        locateClaude: () => "claude-stand-in",
        env: () => ({}),
        launch: () => {
          launched++;
          throw new Error("must not start");
        },
      },
      platform: "linux",
      managed: () => false,
      stateDir: tmpdir(),
      log: () => undefined,
      after: () => () => undefined,
      cloud: { report: async (_id, report) => (reported.push(report), { kind: "recorded" }), takeCode: async () => ({ kind: "error" }) },
    });
    const r = receiver(login);
    r.receive([signed(start(1)), signed(code(2)), signed(logout(3))]);
    await r.idle();
    expect(r.pendingAcks()).toEqual([1, 2, 3].map((n) => ({ command_id: id(n), outcome: "refused", refusal: "unsupported" })));
    expect(launched).toBe(0);
    expect(reported).toEqual([{ state: "failed", failure_code: "not_managed" }]);
  });
});

describe("the GitHub sign-in's two commands", () => {
  const ghStart = (n: number) => ({ ...base(n), kind: "gh_login_start", args: { request_id: REQ } }) as MachineCommand;
  const ghOut = (n: number) => ({ ...base(n), kind: "gh_logout", args: {} }) as MachineCommand;
  it("go to the GitHub runner, never to the Claude one, and are acked by its answer", async () => {
    const { login, calls } = fake();
    const seen: string[] = [];
    const gh: GhLoginRunner = { start: async (r) => (seen.push(`start ${r}`), { ok: true }), logout: async () => (seen.push("logout"), { ok: false, refusal: "busy" }), idle: async () => undefined };
    const r = createMachineCommandReceiver({ keyring, runnerId: RUNNER, now: () => clock, login, gh });
    r.receive([signed(ghStart(1)), signed(ghOut(2))]);
    await r.idle();
    expect(seen).toEqual([`start ${REQ}`, "logout"]);
    expect(calls).toEqual([]);
    expect(r.pendingAcks()).toEqual([{ command_id: id(1), outcome: "applied" }, { command_id: id(2), outcome: "refused", refusal: "busy" }]);
  });
  it("are refused as unsupported by a build with no GitHub runner, and still never reach the Claude one", async () => {
    const { login, calls } = fake();
    const r = receiver(login);
    r.receive([signed(ghStart(1)), signed(ghOut(2))]);
    await r.idle();
    expect(calls).toEqual([]);
    expect(r.pendingAcks()).toEqual([1, 2].map((n) => ({ command_id: id(n), outcome: "refused", refusal: "unsupported" })));
  });
});
