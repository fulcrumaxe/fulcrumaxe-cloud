import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HelloMessage, MACHINE_JOB_CAPABILITY, PROJECT_SETUP_CAPABILITY, TWIN_CAPABILITY, type HelloMessage as Hello } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../../src/version.js";

// D#845 ON-27d4c: `twin_v1` is the newest capability of all, last on the build, and listed only because run.ts registers a handler for every job kind the capability gates.
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

describe("twin_v1 on the build and on the hello", () => {
  it("is last on the build and the hello it makes is a valid one", () => {
    expect(RUNNER_BUILD_CAPABILITIES.at(-1)).toBe(TWIN_CAPABILITY);
    expect(HelloMessage.safeParse({ ...base, capabilities: [...RUNNER_BUILD_CAPABILITIES] }).success).toBe(true);
  });

  it("is listed only while run.ts registers a handler for every job kind it gates (seed, publish and sync)", () => {
    const kinds = Object.entries(MACHINE_JOB_CAPABILITY).filter(([, cap]) => cap === TWIN_CAPABILITY).map(([kind]) => kind).sort();
    expect(kinds).toEqual(["twin_publish", "twin_seed", "twin_sync"]);
    const run = readFileSync(new URL("../../src/commands/run.ts", import.meta.url), "utf8");
    const registered = /handlers: \{([^\n]*)\}/.exec(run.slice(run.indexOf("createMachineJobDispatcher({")))?.[1] ?? "";
    for (const kind of kinds) expect(registered, `run.ts registers no handler for ${kind}`).toContain(`${kind}: `);
  });

  it("a cloud that does not know it costs one retry that drops it alone and keeps project_setup_v1 and every other capability", async () => {
    const { client, sent } = cloud([TWIN_CAPABILITY]);
    const answer = await client.hello({ ...base, capabilities: [...RUNNER_BUILD_CAPABILITIES] });
    expect(answer).toEqual({ kind: "ok", dropped: [TWIN_CAPABILITY] });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(RUNNER_BUILD_CAPABILITIES.filter((c) => c !== TWIN_CAPABILITY));
    expect(sent[1]).toContain(PROJECT_SETUP_CAPABILITY);
  });

  it("a cloud that knows it keeps it: one hello, nothing dropped", async () => {
    const { client, sent } = cloud([]);
    expect(await client.hello({ ...base, capabilities: [...RUNNER_BUILD_CAPABILITIES] })).toEqual({ kind: "ok" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(TWIN_CAPABILITY);
  });
});
