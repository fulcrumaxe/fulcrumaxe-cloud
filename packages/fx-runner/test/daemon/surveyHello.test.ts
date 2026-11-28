import { describe, expect, it } from "vitest";
import { HelloMessage, MACHINE_LOGIN_CAPABILITY, SURVEY_CAPABILITY, WATCH_MODE_HELLO_CAPABILITY, KVM_FACT_HELLO_CAPABILITY, type HelloMessage as Hello } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../../src/version.js";
// D#845 ON-10e1: `survey_public_v1` is the newest capability of all and is dropped before everything on the ladder (pinned in surveyPublic.test.ts); these tests pin the ladder behind it.
// D#845 ON-8f2c: `project_setup_v1` is newer still and is dropped first of all (pinned in daemon/projectSetupHello.test.ts), so the ladders below start behind both.
const BUILD_BEHIND_PUBLIC = RUNNER_BUILD_CAPABILITIES.filter((c) => c !== "survey_public_v1" && c !== "project_setup_v1" && c !== "twin_v1" && c !== "gh_login_v1");

/** D#845 ON-10c: `survey_v1` is the last capability the build turns on, and its step on the hello's drop ladder is the first of the newer ones, ahead of `machine_login_v1` and `watch_mode_v1`, so a cloud that lacks only it costs those two nothing. */
const base: Hello = { protocol_version: RUNNER_PROTOCOL_VERSION, binary_version: RUNNER_VERSION, model_auth_present: false, isolation: "host_sandbox" };

function cloud(unknown: string[]) {
  const sent: string[][] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const caps = (JSON.parse(String(init.body)).capabilities ?? []) as string[];
    sent.push(caps);
    const refuse = caps.some((c) => unknown.includes(c));
    return new Response(JSON.stringify(refuse ? { error: { code: "invalid_message", message: "x" } } : {}), { status: refuse ? 400 : 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn }), sent };
}

describe("survey_v1 on the build and on the hello", () => {
  it("is the build's newest capability, and the hello it makes is a valid one at this protocol version", () => {
    expect(BUILD_BEHIND_PUBLIC.at(-1)).toBe(SURVEY_CAPABILITY);
    expect(HelloMessage.safeParse({ ...base, capabilities: [...BUILD_BEHIND_PUBLIC] }).success).toBe(true);
  });

  it("a cloud that does not know it drops survey_v1 alone and keeps every other capability, machine_login_v1 and watch_mode_v1 included", async () => {
    const { client, sent } = cloud([SURVEY_CAPABILITY]);
    const answer = await client.hello({ ...base, capabilities: [...BUILD_BEHIND_PUBLIC] });
    expect(answer).toEqual({ kind: "ok", dropped: [SURVEY_CAPABILITY] });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(BUILD_BEHIND_PUBLIC.filter((c) => c !== SURVEY_CAPABILITY));
    expect(sent[1]).toContain(MACHINE_LOGIN_CAPABILITY);
    expect(sent[1]).toContain(WATCH_MODE_HELLO_CAPABILITY);
  });

  it("a cloud that knows it keeps it: one hello, nothing dropped", async () => {
    const { client, sent } = cloud([]);
    expect(await client.hello({ ...base, capabilities: [...BUILD_BEHIND_PUBLIC] })).toEqual({ kind: "ok" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(SURVEY_CAPABILITY);
  });

  it("a cloud that knows it but not the newer kvm_fact_v1 pays no retry for it (survey_v1 is behind kvm_fact_v1 on the ladder)", async () => {
    const { client, sent } = cloud([KVM_FACT_HELLO_CAPABILITY]);
    const answer = await client.hello({ ...base, capabilities: [...BUILD_BEHIND_PUBLIC, KVM_FACT_HELLO_CAPABILITY] });
    expect(answer).toEqual({ kind: "ok", dropped: [KVM_FACT_HELLO_CAPABILITY] });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain(SURVEY_CAPABILITY);
  });

  it("a cloud that lacks watch_mode_v1 and survey_v1 drops survey_v1, then machine_login_v1 (ahead of watch_mode_v1), then watch_mode_v1, and keeps the rest", async () => {
    const { client, sent } = cloud([WATCH_MODE_HELLO_CAPABILITY, SURVEY_CAPABILITY]);
    const answer = await client.hello({ ...base, capabilities: [...BUILD_BEHIND_PUBLIC] });
    expect(answer).toEqual({ kind: "ok", dropped: [SURVEY_CAPABILITY, MACHINE_LOGIN_CAPABILITY, WATCH_MODE_HELLO_CAPABILITY] });
    expect(sent).toHaveLength(4);
    expect(sent[3]).toContain("engine_bridge_v1");
  });

  it("the protocol refuses survey_v1 on a version below machine onboarding (an older hello never gets a survey)", () => {
    expect(HelloMessage.safeParse({ ...base, protocol_version: 21, capabilities: [SURVEY_CAPABILITY] }).success).toBe(false);
  });
});
