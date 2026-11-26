import { generateKeyPairSync } from "node:crypto";
import { MACHINE_COMMAND_PURPOSE, MACHINE_LOGIN_CAPABILITY, SURVEY_CAPABILITY, signMachineCommand, type HelloMessage, type MachineCommand } from "@fulcrumaxe/runner-protocol";
import { describe, expect, it } from "vitest";
import type { ClaudeLoginRunner } from "../../src/daemon/claudeLogin.js";
import { createRunnerClient } from "../../src/daemon/client.js";
import { createMachineCommandReceiver } from "../../src/daemon/machineCommands.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../../src/version.js";
// D#845 ON-10e1: `survey_public_v1` is the newest capability of all and is dropped before everything on the ladder (pinned in surveyPublic.test.ts); these tests pin the ladder behind it.
// D#845 ON-8f2c: `project_setup_v1` is newer still and is dropped first of all (pinned in daemon/projectSetupHello.test.ts), so the ladders below start behind both.
const BUILD_BEHIND_PUBLIC = RUNNER_BUILD_CAPABILITIES.filter((c) => c !== "survey_public_v1" && c !== "project_setup_v1" && c !== "engine_session_v1");

const REQ = "11111111-1111-4111-8111-111111111111";
const RUNNER = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const URL_LINE = "https://claude.com/cai/oauth/authorize?code=REDACTED&client_id=REDACTED&scope=a+b%3Ac";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const now = new Date("2026-11-23T15:00:00Z");
const cmd = (n: number, kind: "claude_login_start" | "claude_logout"): MachineCommand =>
  ({ v: 1, purpose: MACHINE_COMMAND_PURPOSE, command_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, runner_id: RUNNER, issued_by: RUNNER, issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 600_000).toISOString(), kind, args: kind === "claude_logout" ? {} : { request_id: REQ } }) as MachineCommand;

interface Seen {
  method: string;
  path: string;
  body: unknown;
}
function cloud(reply: (seen: Seen) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const entry = { method: init.method ?? "GET", path: new URL(url).pathname, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
    seen.push(entry);
    const r = reply(entry);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}
const idleLogin: ClaudeLoginRunner = { start: async () => ({ ok: true }), code: async () => ({ ok: false, refusal: "failed" }), logout: async () => ({ ok: true }), idle: async () => undefined };

describe("hello: machine_login_v1 is dropped first", () => {
  it("is in the build list, right ahead of survey_v1 (the newest), and an old cloud drops survey_v1 (the newer one) and then it", async () => {
    expect(BUILD_BEHIND_PUBLIC.at(-2)).toBe(MACHINE_LOGIN_CAPABILITY);
    const sent: string[][] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => {
      const caps = (JSON.parse(String(init.body)).capabilities ?? []) as string[];
      sent.push(caps);
      const refuse = caps.includes(MACHINE_LOGIN_CAPABILITY);
      return new Response(JSON.stringify(refuse ? { error: { code: "invalid_message", message: "x" } } : {}), { status: refuse ? 400 : 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => now, fetchFn });
    const hello: HelloMessage = { protocol_version: RUNNER_PROTOCOL_VERSION, binary_version: RUNNER_VERSION, model_auth_present: false, isolation: "host_sandbox", capabilities: [...BUILD_BEHIND_PUBLIC] };
    expect(await client.hello(hello)).toEqual({ kind: "ok", dropped: [SURVEY_CAPABILITY, MACHINE_LOGIN_CAPABILITY] });
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual(BUILD_BEHIND_PUBLIC.filter((c) => c !== MACHINE_LOGIN_CAPABILITY && c !== SURVEY_CAPABILITY));
  });
});

describe("the claim carries machine commands in and their acks out", () => {
  it("hands the signed commands to the receiver, and sends the acks on the next claim only", async () => {
    const started: string[] = [];
    const login: ClaudeLoginRunner = { ...idleLogin, start: async (r) => (started.push(r), { ok: true }) };
    const machineCommands = createMachineCommandReceiver({ keyring: { k1: publicKey }, runnerId: RUNNER, now: () => now, login });
    let n = 0;
    const { seen, fetchFn } = cloud(() => (n++ === 0 ? { status: 200, body: { retry_after: 5, machine_commands: [signMachineCommand(cmd(1, "claude_login_start"), "k1", privateKey), signMachineCommand(cmd(2, "claude_logout"), "k1", privateKey)] } } : { status: 200, body: { retry_after: 5 } }));
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => now, fetchFn, machineCommands, protocolVersion: RUNNER_PROTOCOL_VERSION });
    await client.claim(undefined, undefined);
    await machineCommands.idle();
    expect(started).toEqual([REQ]);
    expect(seen[0]!.body).toEqual({});
    await client.claim(undefined, undefined);
    expect(seen[1]!.body).toEqual({ machine_acks: [{ command_id: "00000000-0000-4000-8000-000000000001", outcome: "applied" }, { command_id: "00000000-0000-4000-8000-000000000002", outcome: "applied" }] });
    // answered 200: they are not sent again
    await client.claim(undefined, undefined);
    expect(seen[2]!.body).toEqual({});
  });

  it("keeps the acks when the claim failed, and sends them on the next one that is answered", async () => {
    const machineCommands = createMachineCommandReceiver({ keyring: { k1: publicKey }, runnerId: RUNNER, now: () => now, login: idleLogin });
    machineCommands.receive([signMachineCommand(cmd(1, "claude_logout"), "k1", privateKey)]);
    await machineCommands.idle();
    const statuses = [500, 200];
    const { seen, fetchFn } = cloud(() => ({ status: statuses.shift() ?? 200, body: { retry_after: 5 } }));
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => now, fetchFn, machineCommands, protocolVersion: RUNNER_PROTOCOL_VERSION });
    await client.claim(undefined, undefined);
    await client.claim(undefined, undefined);
    await client.claim(undefined, undefined);
    expect(JSON.stringify(seen.map((s) => s.body))).toContain("machine_acks");
    expect(machineCommands.pendingAcks()).toEqual([]);
  });

  it("an older protocol sends none and delivers none", async () => {
    const machineCommands = createMachineCommandReceiver({ keyring: { k1: publicKey }, runnerId: RUNNER, now: () => now, login: idleLogin });
    machineCommands.receive([signMachineCommand(cmd(1, "claude_logout"), "k1", privateKey)]);
    await machineCommands.idle();
    const { seen, fetchFn } = cloud(() => ({ status: 200, body: { retry_after: 5 } }));
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => now, fetchFn, machineCommands, protocolVersion: 21 });
    await client.claim(undefined, undefined);
    expect(seen[0]!.body).toEqual({});
  });
});

describe("the two sign-in routes", () => {
  const key = generateRunnerKey();
  const make = (reply: (s: Seen) => { status: number; body: unknown }) => {
    const c = cloud(reply);
    return { ...c, client: createRunnerClient({ origin: "https://cloud.example.test", key, now: () => now, fetchFn: c.fetchFn }) };
  };

  it("report: posts to the request's own path with the protocol's body; 200 is recorded, 404 and 409 are refusals, anything else an error", async () => {
    const answers = [200, 409, 404, 500, 403];
    const { seen, client } = make(() => ({ status: answers.shift()!, body: { state: "done", error: { code: "not_in_state", message: "x" } } }));
    expect(await client.machineLoginReport(REQ, { state: "awaiting_code", auth_url: URL_LINE })).toEqual({ kind: "recorded" });
    expect(seen[0]).toEqual({ method: "POST", path: `/api/runner/machine-login/${REQ}/report`, body: { state: "awaiting_code", auth_url: URL_LINE } });
    expect(await client.machineLoginReport(REQ, { state: "done" })).toMatchObject({ kind: "refused", status: 409 });
    expect(await client.machineLoginReport(REQ, { state: "failed", failure_code: "busy" })).toMatchObject({ kind: "refused", status: 404 });
    expect(await client.machineLoginReport(REQ, { state: "done" })).toMatchObject({ kind: "error", status: 500 });
    expect(await client.machineLoginReport(REQ, { state: "done" })).toMatchObject({ kind: "error", status: 403 });
  });

  it("report: a body the protocol refuses is never sent", async () => {
    const { seen, client } = make(() => ({ status: 200, body: {} }));
    expect(await client.machineLoginReport(REQ, { state: "awaiting_code", auth_url: "https://evil.example/x" })).toMatchObject({ kind: "error", code: "invalid_message" });
    expect(await client.machineLoginReport(REQ, { state: "awaiting_code" })).toMatchObject({ kind: "error", code: "invalid_message" });
    expect(await client.machineLoginReport("../x", { state: "done" })).toMatchObject({ kind: "error", code: "invalid_message" });
    expect(seen).toEqual([]);
  });

  it("code: a GET on the request's own path; the code comes back once, 410 is gone, a malformed answer is an error", async () => {
    const answers = [
      { status: 200, body: { code: "abc.DEF-123~x" } },
      { status: 410, body: { error: { code: "gone", message: "x" } } },
      { status: 200, body: { code: "has a space" } },
      { status: 200, body: {} },
      { status: 500, body: {} },
    ];
    const { seen, client } = make(() => answers.shift()!);
    expect(await client.machineLoginCode(REQ)).toEqual({ kind: "code", code: "abc.DEF-123~x" });
    expect(seen[0]).toMatchObject({ method: "GET", path: `/api/runner/machine-login/${REQ}/code` });
    expect(await client.machineLoginCode(REQ)).toEqual({ kind: "gone" });
    expect(await client.machineLoginCode(REQ)).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(await client.machineLoginCode(REQ)).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(await client.machineLoginCode(REQ)).toMatchObject({ kind: "error", status: 500 });
    expect(await client.machineLoginCode("not-a-uuid")).toMatchObject({ kind: "error", code: "invalid_message" });
  });

  it("code: an error result never carries the code, even from a reply that held one", async () => {
    const { client } = make(() => ({ status: 500, body: { code: "SENTINEL-in-an-error-body" } }));
    expect(JSON.stringify(await client.machineLoginCode(REQ))).not.toContain("SENTINEL");
  });
});
