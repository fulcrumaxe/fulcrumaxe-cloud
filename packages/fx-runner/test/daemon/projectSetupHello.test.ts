import { describe, expect, it } from "vitest";
import { HelloMessage, PROJECT_SETUP_CAPABILITY, SURVEY_PUBLIC_CAPABILITY, type HelloMessage as Hello } from "@fulcrumaxe/runner-protocol";
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

/** The build behind `engine_session_v1` (D#845 ON-13b2), which is listed after this capability and dropped before it. */
const BUILD = RUNNER_BUILD_CAPABILITIES.filter((c) => c !== "engine_session_v1");

describe("project_setup_v1 on the build and on the hello", () => {
  it("is on the build, last of all, and the hello it makes is a valid one at this protocol version", () => {
    expect(RUNNER_BUILD_CAPABILITIES).toContain(PROJECT_SETUP_CAPABILITY);
    expect(BUILD.at(-1)).toBe(PROJECT_SETUP_CAPABILITY); // the build behind engine_session_v1, which is newer and is last (daemon/engineSessionHello.test.ts)
    expect(HelloMessage.safeParse({ ...base, capabilities: [...BUILD] }).success).toBe(true);
  });

  it("a cloud that does not know it costs one retry that drops it alone and keeps every other capability, survey_public_v1 included", async () => {
    const { client, sent } = cloud([PROJECT_SETUP_CAPABILITY]);
    const answer = await client.hello({ ...base, capabilities: [...BUILD] });
    expect(answer).toEqual({ kind: "ok", dropped: [PROJECT_SETUP_CAPABILITY] });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain(PROJECT_SETUP_CAPABILITY);
    expect(sent[1]).toEqual(BUILD.filter((c) => c !== PROJECT_SETUP_CAPABILITY));
    expect(sent[1]).toContain(SURVEY_PUBLIC_CAPABILITY);
  });

  it("a cloud that knows it keeps it: one hello, nothing dropped", async () => {
    const { client, sent } = cloud([]);
    expect(await client.hello({ ...base, capabilities: [...BUILD] })).toEqual({ kind: "ok" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(PROJECT_SETUP_CAPABILITY);
  });

  it("goes before survey_public_v1 on the ladder: a cloud that lacks both drops project_setup_v1 first, then survey_public_v1", async () => {
    const { client, sent } = cloud([PROJECT_SETUP_CAPABILITY, SURVEY_PUBLIC_CAPABILITY]);
    const answer = await client.hello({ ...base, capabilities: [...BUILD] });
    expect(answer).toEqual({ kind: "ok", dropped: [PROJECT_SETUP_CAPABILITY, SURVEY_PUBLIC_CAPABILITY] });
    expect(sent).toHaveLength(3);
    expect(sent[1]).toContain(SURVEY_PUBLIC_CAPABILITY);
    expect(sent[1]).not.toContain(PROJECT_SETUP_CAPABILITY);
    expect(sent[2]).toEqual(BUILD.filter((c) => c !== PROJECT_SETUP_CAPABILITY && c !== SURVEY_PUBLIC_CAPABILITY));
  });

  it("a hello at protocol 22 that lists it parses", () => {
    expect(HelloMessage.safeParse({ ...base, protocol_version: 22, capabilities: [PROJECT_SETUP_CAPABILITY] }).success).toBe(true);
  });
});
