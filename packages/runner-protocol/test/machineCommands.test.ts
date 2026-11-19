import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JobSignatureError, canonicalJson } from "../src/jobSignature.js";
import { CLAUDE_AUTH_URL_PATTERN, ClaudeAuthUrl, MACHINE_COMMAND_KINDS, MACHINE_COMMAND_PURPOSE, MachineCommand, signMachineCommand, verifyMachineCommand, type MachineCommand as Command } from "../src/machineCommands.js";
import { SANDBOX_COMMAND_PURPOSE, signSandboxCommand } from "../src/sandboxCommands.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const keyring = { "job-key-1": publicKey };
const NOW = new Date("2026-11-18T15:00:00Z");
const RUNNER = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const ID = "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f";
const at = (s: number): string => new Date(NOW.getTime() + s * 1000).toISOString();
const cmd = (over: Record<string, unknown> = {}): Command => ({ v: 1, purpose: MACHINE_COMMAND_PURPOSE, command_id: ID, runner_id: RUNNER, issued_by: ID, issued_at: at(0), expires_at: at(300), kind: "claude_login_start", args: { request_id: ID }, ...over }) as Command;
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

describe("machine command schema", () => {
  it("has the two sign-in commands, each with a request id and nothing else, and no repo", () => {
    expect([...MACHINE_COMMAND_KINDS]).toEqual(["claude_login_start", "claude_login_code"]);
    for (const kind of MACHINE_COMMAND_KINDS) expect(MachineCommand.safeParse(cmd({ kind })).success, kind).toBe(true);
    expect(MachineCommand.safeParse(cmd({ repo_gh_id: 7 })).success).toBe(false);
    expect(MachineCommand.safeParse(cmd({ args: { request_id: ID, extra: 1 } })).success).toBe(false);
    expect(MachineCommand.safeParse(cmd({ args: {} })).success).toBe(false);
    expect(MachineCommand.safeParse(cmd({ args: { request_id: "nope" } })).success).toBe(false);
    expect(MachineCommand.safeParse(cmd({ kind: "start_day" })).success).toBe(false);
    expect(MachineCommand.safeParse(cmd({ extra: 1 })).success).toBe(false);
  });
  it("lives at most 600 s", () => {
    expect(MachineCommand.safeParse(cmd({ expires_at: at(600) })).success).toBe(true);
    expect(MachineCommand.safeParse(cmd({ expires_at: at(601) })).success).toBe(false);
    expect(MachineCommand.safeParse(cmd({ expires_at: at(0) })).success).toBe(false);
  });
});

describe("claude auth url", () => {
  const good = (value: unknown): boolean => ClaudeAuthUrl.safeParse(value).success;
  it("takes an https URL on claude.ai or console.anthropic.com", () => {
    expect(good("https://claude.ai/oauth/authorize?code=true&client_id=abc-1&state=x%20y")).toBe(true);
    expect(good("https://console.anthropic.com/login/x")).toBe(true);
    expect(CLAUDE_AUTH_URL_PATTERN.source.startsWith("^https:")).toBe(true);
  });
  it("refuses any other host, scheme, space, control character, quote or length over 2,000", () => {
    for (const url of ["https://evil.example/x", "https://claude.ai.evil.example/x", "https://claude.ai@evil.example/x", "https://claude.aix/x", "http://claude.ai/x", "javascript:alert(1)", "//claude.ai/x", "https://claude.ai", "https://claude.ai/", "https://claude.ai/a b", "https://claude.ai/a\tb", "https://claude.ai/a\nb", "https://claude.ai/a\u0000b", "https://claude.ai/x\n", "https://claude.ai/a\"b", "https://claude.ai/a<b", "https://claude.ai/a#frag", "https://claude.ai/a:b", "https://CLAUDE.AI/x", "https://claude.ai/é", "https://api.claude.ai/x"]) expect(good(url), JSON.stringify(url)).toBe(false);
    const prefix = "https://claude.ai/";
    expect(good(prefix + "a".repeat(2000 - prefix.length))).toBe(true);
    expect(good(prefix + "a".repeat(2001 - prefix.length))).toBe(false);
    expect(good(prefix + "a".repeat(2001))).toBe(false);
    for (const junk of [null, 5, undefined, {}]) expect(good(junk)).toBe(false);
  });
});

describe("verifyMachineCommand", () => {
  const signed = (command: Command = cmd()) => signMachineCommand(command, "job-key-1", privateKey);
  it("returns what it signed", () => {
    for (const kind of MACHINE_COMMAND_KINDS) expect(verifyMachineCommand(signed(cmd({ kind })), keyring, RUNNER, NOW)).toEqual(cmd({ kind }));
  });
  it("rejects a flipped byte, another key, another runner, an expired or future command", () => {
    const s = signed();
    failsWith(() => verifyMachineCommand({ ...s, command: { ...s.command, args: { request_id: "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d" } } }, keyring, RUNNER, NOW), "bad_signature");
    failsWith(() => verifyMachineCommand({ ...s, command: { ...s.command, kind: "claude_login_code" } }, keyring, RUNNER, NOW), "bad_signature");
    failsWith(() => verifyMachineCommand(signMachineCommand(cmd(), "job-key-1", other.privateKey), keyring, RUNNER, NOW), "bad_signature");
    failsWith(() => verifyMachineCommand(s, keyring, "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", NOW), "bad_signature");
    failsWith(() => verifyMachineCommand(s, keyring, RUNNER, new Date(NOW.getTime() + 301_000)), "expired");
    failsWith(() => verifyMachineCommand(signed(cmd({ issued_at: at(120), expires_at: at(400) })), keyring, RUNNER, NOW), "expired");
    failsWith(() => verifyMachineCommand(s, { "other-key": publicKey }, RUNNER, NOW), "unknown_key_id");
    failsWith(() => verifyMachineCommand({ command: s.command, key_id: s.key_id }, keyring, RUNNER, NOW), "missing_signature");
    for (const junk of [null, 5, [], "x"]) failsWith(() => verifyMachineCommand(junk, keyring, RUNNER, NOW), "malformed");
  });
  it("never verifies a signature made over another purpose, and another purpose never verifies as this one", () => {
    const sandbox = signSandboxCommand({ purpose: SANDBOX_COMMAND_PURPOSE, runner_id: RUNNER, kind: "reap_sandboxes", nonce: ID, exp: at(300) }, "job-key-1", privateKey);
    failsWith(() => verifyMachineCommand(sandbox, keyring, RUNNER, NOW), "malformed");
    const body = cmd({ purpose: "engine_command_v1" });
    const signature = sign(null, Buffer.from(canonicalJson(body), "utf8"), privateKey).toString("base64url");
    failsWith(() => verifyMachineCommand({ command: body, key_id: "job-key-1", signature }, keyring, RUNNER, NOW), "malformed");
  });
});
