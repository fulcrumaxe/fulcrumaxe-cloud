import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENGINE_COMMAND_PURPOSE, signEngineCommand } from "../src/engineCommands.js";
import { JobSignatureError, canonicalJson } from "../src/jobSignature.js";
import { ClaimMessage, HelloMessage, SANDBOX_NAME_PATTERN } from "../src/messages.js";
import { ClaimIdleReply } from "../src/replies.js";
import {
  SANDBOX_COMMAND_KINDS,
  SANDBOX_COMMAND_MAX_LIFE_S,
  SANDBOX_COMMAND_NAME_PATTERN,
  SANDBOX_COMMAND_PURPOSE,
  SandboxCommand,
  SandboxCommandAck,
  signSandboxCommand,
  verifySandboxCommand,
  type SandboxCommand as Command,
} from "../src/sandboxCommands.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const keyring = { "job-key-1": publicKey };
const NOW = new Date("2026-11-18T15:00:00Z");
const RUNNER = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const NONCE = "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f";
const OTHER_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const exp = (s: number): string => new Date(NOW.getTime() + s * 1000).toISOString();
const stop = (over: Partial<Command> = {}): Command => ({ purpose: SANDBOX_COMMAND_PURPOSE, runner_id: RUNNER, kind: "stop_sandbox", name: "vm-one", nonce: NONCE, exp: exp(300), ...over }) as Command;
const failsWith = (run: () => unknown, code: string): void => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(JobSignatureError);
    expect((error as JobSignatureError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe("sandbox command schema", () => {
  it("has the same name pattern as an inventory row", () => {
    expect(SANDBOX_COMMAND_NAME_PATTERN.source).toBe(SANDBOX_NAME_PATTERN.source);
  });
  it("needs a name for stop and delete and refuses one on reap", () => {
    for (const kind of ["stop_sandbox", "delete_sandbox"] as const) {
      expect(SandboxCommand.safeParse(stop({ kind })).success).toBe(true);
      expect(SandboxCommand.safeParse({ ...stop({ kind }), name: undefined }).success).toBe(false);
    }
    expect(SandboxCommand.safeParse({ ...stop({ kind: "reap_sandboxes" }), name: undefined }).success).toBe(true);
    expect(SandboxCommand.safeParse(stop({ kind: "reap_sandboxes" })).success).toBe(false);
  });
  it.each(["", "UPPER", "../escape", "a/b", "-lead", "a b", "a".repeat(41), "name\n"])("refuses the name %j", (name) => {
    expect(SandboxCommand.safeParse(stop({ name })).success).toBe(false);
  });
  it("holds the purpose string to the one value", () => {
    expect(SandboxCommand.safeParse(stop({ purpose: "engine_command_v1" as never })).success).toBe(false);
    expect(SandboxCommand.safeParse({ ...stop(), purpose: undefined }).success).toBe(false);
  });
  it("is closed: an extra key and an unknown kind are refused", () => {
    expect(SandboxCommand.safeParse({ ...stop(), extra: 1 }).success).toBe(false);
    expect(SandboxCommand.safeParse(stop({ kind: "run_sandbox" as never })).success).toBe(false);
    expect(SANDBOX_COMMAND_KINDS).toEqual(["stop_sandbox", "delete_sandbox", "reap_sandboxes"]);
  });
  it("acks name a reason exactly when refused", () => {
    expect(SandboxCommandAck.safeParse({ nonce: NONCE, outcome: "applied" }).success).toBe(true);
    expect(SandboxCommandAck.safeParse({ nonce: NONCE, outcome: "applied", refusal: "failed" }).success).toBe(false);
    expect(SandboxCommandAck.safeParse({ nonce: NONCE, outcome: "refused" }).success).toBe(false);
    expect(SandboxCommandAck.safeParse({ nonce: NONCE, outcome: "refused", refusal: "unsupported" }).success).toBe(true);
    expect(SandboxCommandAck.safeParse({ nonce: NONCE, outcome: "refused", refusal: "because" }).success).toBe(false);
  });
});

describe("signing and verifying a sandbox command", () => {
  const signed = signSandboxCommand(stop(), "job-key-1", privateKey);
  it("round trips", () => {
    expect(verifySandboxCommand(signed, keyring, RUNNER, NOW)).toEqual(stop());
    expect(verifySandboxCommand(signed, keyring, RUNNER.toUpperCase(), NOW).nonce).toBe(NONCE);
  });
  it("refuses a command signed with another key", () => {
    failsWith(() => verifySandboxCommand(signSandboxCommand(stop(), "job-key-1", other.privateKey), keyring, RUNNER, NOW), "bad_signature");
  });
  it("refuses every change to the signed bytes", () => {
    for (const change of [{ name: "vm-two" }, { kind: "delete_sandbox" }, { nonce: OTHER_ID }, { exp: exp(301) }, { runner_id: OTHER_ID }]) {
      failsWith(() => verifySandboxCommand({ ...signed, command: { ...signed.command, ...change } }, keyring, RUNNER, NOW), "bad_signature");
    }
  });
  it("refuses a command signed for another runner, even though the signature is good", () => {
    const forOther = signSandboxCommand(stop({ runner_id: OTHER_ID }), "job-key-1", privateKey);
    failsWith(() => verifySandboxCommand(forOther, keyring, RUNNER, NOW), "bad_signature");
  });
  it("refuses an expired command, and one that lives longer than a command may", () => {
    failsWith(() => verifySandboxCommand(signSandboxCommand(stop({ exp: exp(0) }), "job-key-1", privateKey), keyring, RUNNER, NOW), "expired");
    failsWith(() => verifySandboxCommand(signSandboxCommand(stop({ exp: exp(-5) }), "job-key-1", privateKey), keyring, RUNNER, NOW), "expired");
    expect(verifySandboxCommand(signSandboxCommand(stop({ exp: exp(SANDBOX_COMMAND_MAX_LIFE_S) }), "job-key-1", privateKey), keyring, RUNNER, NOW).kind).toBe("stop_sandbox");
    failsWith(() => verifySandboxCommand(signSandboxCommand(stop({ exp: exp(SANDBOX_COMMAND_MAX_LIFE_S + 3600) }), "job-key-1", privateKey), keyring, RUNNER, NOW), "expired");
  });
  it("refuses an unknown key id, a missing signature and a malformed command", () => {
    failsWith(() => verifySandboxCommand({ ...signed, key_id: "nope" }, keyring, RUNNER, NOW), "unknown_key_id");
    failsWith(() => verifySandboxCommand({ command: signed.command, key_id: "job-key-1" }, keyring, RUNNER, NOW), "missing_signature");
    failsWith(() => verifySandboxCommand("x", keyring, RUNNER, NOW), "malformed");
    failsWith(() => verifySandboxCommand({ ...signed, command: { ...signed.command, name: "../x" } }, keyring, RUNNER, NOW), "malformed");
  });
  it("a signature made over an engine command, or over the same bytes without the purpose, never verifies as a sandbox command", () => {
    const engine = signEngineCommand({ v: 1, purpose: ENGINE_COMMAND_PURPOSE, command_id: NONCE, command_seq: 1, runner_id: RUNNER, repo_gh_id: 1, issued_by: NONCE, issued_at: NOW.toISOString(), expires_at: exp(60), halt_epoch: 0, kind: "pause_loop", args: {} }, "job-key-1", privateKey);
    failsWith(() => verifySandboxCommand({ command: stop(), key_id: "job-key-1", signature: engine.signature }, keyring, RUNNER, NOW), "bad_signature");
    const { purpose: _purpose, ...bare } = stop();
    const sig = sign(null, Buffer.from(canonicalJson(bare), "utf8"), privateKey).toString("base64url");
    failsWith(() => verifySandboxCommand({ command: stop(), key_id: "job-key-1", signature: sig }, keyring, RUNNER, NOW), "bad_signature");
  });
});

describe("where sandbox commands may ride", () => {
  const signed = signSandboxCommand(stop(), "job-key-1", privateKey);
  it("an idle reply carries at most five, and nothing else", () => {
    expect(ClaimIdleReply.safeParse({ retry_after: 60, sandbox_commands: [signed] }).success).toBe(true);
    expect(ClaimIdleReply.safeParse({ retry_after: 60, sandbox_commands: Array(6).fill(signed) }).success).toBe(false);
    expect(ClaimIdleReply.safeParse({ retry_after: 60, sandbox_commands: [{ ...signed, extra: 1 }] }).success).toBe(false);
  });
  it("a claim carries acks, at most twenty", () => {
    expect(ClaimMessage.safeParse({ sandbox_acks: [{ nonce: NONCE, outcome: "applied" }] }).success).toBe(true);
    expect(ClaimMessage.safeParse({ sandbox_acks: Array(21).fill({ nonce: NONCE, outcome: "applied" }) }).success).toBe(false);
  });
  it("a hello lists the capability only at protocol 21 or later", () => {
    const hello = (protocol_version: number) => HelloMessage.safeParse({ protocol_version, binary_version: "1.0.0", model_auth_present: false, isolation: "host_sandbox", capabilities: ["sandbox_commands_v1"] });
    expect(hello(21).success).toBe(true);
    expect(hello(20).success).toBe(false);
  });
});
