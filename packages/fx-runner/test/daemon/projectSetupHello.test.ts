import { describe, expect, it } from "vitest";
import { GH_LOGIN_CAPABILITY, HelloMessage, PROJECT_SETUP_CAPABILITY, SURVEY_PUBLIC_CAPABILITY, TWIN_CAPABILITY, type HelloMessage as Hello } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../../src/version.js";

// D#845 ON-8f2c: `project_setup_v1` is the newest capability of all. It is on the build, a hello that lists it is a valid one at this protocol version, and it is the first step of the hello's drop ladder.
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

describe("project_setup_v1 on the build and on the hello", () => {
  it("is on the build, behind `twin_v1` (D#845 ON-27d4c) and `gh_login_v1` (D#845 ON-19c), and the hello it makes is a valid one at this protocol version", () => {
    expect(RUNNER_BUILD_CAPABILITIES).toContain(PROJECT_SETUP_CAPABILITY);
    expect(RUNNER_BUILD_CAPABILITIES.indexOf(PROJECT_SETUP_CAPABILITY)).toBeLessThan(RUNNER_BUILD_CAPABILITIES.indexOf(TWIN_CAPABILITY));
    expect(RUNNER_BUILD_CAPABILITIES.indexOf(TWIN_CAPABILITY)).toBeLessThan(RUNNER_BUILD_CAPABILITIES.indexOf(GH_LOGIN_CAPABILITY));
    expect(HelloMessage.safeParse({ ...base, capabilities: [...RUNNER_BUILD_CAPABILITIES] }).success).toBe(true);
  });

  it("a cloud that does not know it costs one retry that drops it alone and keeps every other capability, survey_public_v1 included", async () => {
    // a cloud that lacks project_setup_v1 lacks the newer twin_v1 and gh_login_v1 too, which go first
    const { client, sent } = cloud([PROJECT_SETUP_CAPABILITY, TWIN_CAPABILITY, GH_LOGIN_CAPABILITY]);
    const answer = await client.hello({ ...base, capabilities: [...RUNNER_BUILD_CAPABILITIES] });
    expect(answer).toEqual({ kind: "ok", dropped: [GH_LOGIN_CAPABILITY, TWIN_CAPABILITY, PROJECT_SETUP_CAPABILITY] });
    expect(sent).toHaveLength(4);
    expect(sent[0]).toContain(PROJECT_SETUP_CAPABILITY);
    expect(sent[3]).toEqual(RUNNER_BUILD_CAPABILITIES.filter((c) => c !== PROJECT_SETUP_CAPABILITY && c !== TWIN_CAPABILITY && c !== GH_LOGIN_CAPABILITY));
    expect(sent[3]).toContain(SURVEY_PUBLIC_CAPABILITY);
  });

  it("a cloud that knows it keeps it: one hello, nothing dropped", async () => {
    const { client, sent } = cloud([]);
    expect(await client.hello({ ...base, capabilities: [...RUNNER_BUILD_CAPABILITIES] })).toEqual({ kind: "ok" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(PROJECT_SETUP_CAPABILITY);
  });

  it("goes before survey_public_v1 on the ladder: a cloud that lacks both drops project_setup_v1 first, then survey_public_v1", async () => {
    const { client, sent } = cloud([PROJECT_SETUP_CAPABILITY, SURVEY_PUBLIC_CAPABILITY, TWIN_CAPABILITY, GH_LOGIN_CAPABILITY]);
    const answer = await client.hello({ ...base, capabilities: [...RUNNER_BUILD_CAPABILITIES] });
    expect(answer).toEqual({ kind: "ok", dropped: [GH_LOGIN_CAPABILITY, TWIN_CAPABILITY, PROJECT_SETUP_CAPABILITY, SURVEY_PUBLIC_CAPABILITY] });
    expect(sent).toHaveLength(5);
    expect(sent[3]).toContain(SURVEY_PUBLIC_CAPABILITY);
    expect(sent[3]).not.toContain(PROJECT_SETUP_CAPABILITY);
    expect(sent[4]).toEqual(RUNNER_BUILD_CAPABILITIES.filter((c) => c !== PROJECT_SETUP_CAPABILITY && c !== SURVEY_PUBLIC_CAPABILITY && c !== TWIN_CAPABILITY && c !== GH_LOGIN_CAPABILITY));
  });

  it("a hello at protocol 22 that lists it parses", () => {
    expect(HelloMessage.safeParse({ ...base, protocol_version: 22, capabilities: [PROJECT_SETUP_CAPABILITY] }).success).toBe(true);
  });
});
