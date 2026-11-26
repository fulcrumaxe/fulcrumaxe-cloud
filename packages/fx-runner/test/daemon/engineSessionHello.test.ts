import { RUNNER_CAPABILITIES } from "@fulcrumaxe/runner-protocol";
import { describe, expect, it } from "vitest";
import { createRunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../../src/version.js";

/**
 * D#845 ON-13b2: the capability ladder. `engine_session_v1` is the newest capability of all: it is the LAST of the build list, and an older cloud (one that refuses a capability name it does not know) loses it before any other.
 * A runner only says it on a host that has the whole session stack; that part is decided in `commands/run.ts` and tested with the composed daemon in `test/commands/run.test.ts` (both the host that has it and the host that has not).
 */
const hello = (capabilities: typeof RUNNER_BUILD_CAPABILITIES) => ({ protocol_version: RUNNER_PROTOCOL_VERSION, binary_version: RUNNER_VERSION, model_auth_present: false, isolation: "host_sandbox" as const, capabilities: [...capabilities] });
const cloudRefusing = (refuses: (caps: string[]) => boolean): { fetchFn: typeof fetch; sent: string[][] } => {
  const sent: string[][] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const caps = (JSON.parse(String(init.body)).capabilities ?? []) as string[];
    sent.push(caps);
    const refuse = refuses(caps);
    return new Response(JSON.stringify(refuse ? { error: { code: "invalid_message", message: "x" } } : {}), { status: refuse ? 400 : 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, sent };
};

describe("the capability ladder", () => {
  it("engine_session_v1 is the last of the build list, and the protocol knows every name in it", () => {
    expect(RUNNER_BUILD_CAPABILITIES.at(-1)).toBe("engine_session_v1");
    expect(RUNNER_BUILD_CAPABILITIES.filter((c) => c === "engine_session_v1")).toHaveLength(1);
    for (const c of RUNNER_BUILD_CAPABILITIES) expect(RUNNER_CAPABILITIES as readonly string[], c).toContain(c);
  });

  it("a cloud that does not know it costs one retry, which drops it alone and keeps project_setup_v1, survey_public_v1 and every other capability", async () => {
    const { fetchFn, sent } = cloudRefusing((caps) => caps.includes("engine_session_v1"));
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn });
    expect(await client.hello(hello(RUNNER_BUILD_CAPABILITIES))).toEqual({ kind: "ok", dropped: ["engine_session_v1"] });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(RUNNER_BUILD_CAPABILITIES.filter((c) => c !== "engine_session_v1"));
    expect(sent[1]).toContain("survey_public_v1");
    expect(sent[1]).toContain("project_setup_v1");
  });

  it("a cloud that knows none of the three newest drops them newest first, one retry each: engine_session_v1, project_setup_v1, survey_public_v1", async () => {
    const { fetchFn, sent } = cloudRefusing((caps) => caps.includes("survey_public_v1"));
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn });
    expect(await client.hello(hello(RUNNER_BUILD_CAPABILITIES))).toEqual({ kind: "ok", dropped: ["engine_session_v1", "project_setup_v1", "survey_public_v1"] });
    expect(sent).toHaveLength(4);
    expect(sent[1]).toEqual(RUNNER_BUILD_CAPABILITIES.filter((c) => c !== "engine_session_v1"));
    expect(sent[3]).toEqual(RUNNER_BUILD_CAPABILITIES.filter((c) => c !== "engine_session_v1" && c !== "project_setup_v1" && c !== "survey_public_v1"));
  });
});
