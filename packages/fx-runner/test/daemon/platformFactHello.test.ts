import { describe, expect, it } from "vitest";
import { ENGINE_CARRY_CAPABILITY, HelloMessage, KVM_FACT_HELLO_CAPABILITY, PLATFORM_FACT_HELLO_CAPABILITY, TWIN_CAPABILITY, type HelloMessage as Hello } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../../src/version.js";

// D#587 B-7c: `platform_fact_v1` is the newest capability of all, so it is the first rung of the hello's drop ladder (index 0, not "the last one": the list grows). An old cloud costs one retry that drops it alone.
const FACTS = { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" } as const;
const base: Hello = { protocol_version: RUNNER_PROTOCOL_VERSION, binary_version: RUNNER_VERSION, model_auth_present: false, isolation: "host_sandbox" };

interface Sent {
  capabilities: string[];
  facts: Record<string, unknown> | undefined;
}

/** A cloud that refuses `platform_fact_v1` (and any `facts.platform`) with 400 invalid_message when `refuses`, and lists `platform_fact` in the replies it accepts when `lists`. */
function cloud(refuses: boolean, lists: boolean) {
  const sent: Sent[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { capabilities?: string[]; facts?: Record<string, unknown> };
    sent.push({ capabilities: body.capabilities ?? [], facts: body.facts });
    const refuse = refuses && ((body.capabilities ?? []).includes(PLATFORM_FACT_HELLO_CAPABILITY) || (body.facts !== undefined && "platform" in body.facts));
    const reply = refuse ? { error: { code: "invalid_message", message: "x" } } : lists ? { protocol_version: 1, capabilities: ["platform_fact"] } : {};
    return new Response(JSON.stringify(reply), { status: refuse ? 400 : 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn }), sent };
}

describe("hello: platform_fact_v1 is dropped first", () => {
  it("is a protocol capability, and a hello that lists it parses", () => {
    expect(HelloMessage.safeParse({ ...base, capabilities: [PLATFORM_FACT_HELLO_CAPABILITY] }).success).toBe(true);
  });

  it("an old cloud costs one retry that drops platform_fact_v1 alone, and every other capability stays", async () => {
    const { client, sent } = cloud(true, false);
    const others = [...RUNNER_BUILD_CAPABILITIES, KVM_FACT_HELLO_CAPABILITY];
    const answer = await client.hello({ ...base, capabilities: [...others, PLATFORM_FACT_HELLO_CAPABILITY] });
    expect(answer).toEqual({ kind: "ok", dropped: [PLATFORM_FACT_HELLO_CAPABILITY] });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.capabilities.indexOf(PLATFORM_FACT_HELLO_CAPABILITY)).toBeGreaterThanOrEqual(0);
    expect(sent[1]!.capabilities).toEqual(others);
    expect(sent[1]!.capabilities).toContain(TWIN_CAPABILITY);
  });

  it("sits ahead of engine_carry_v1 on the ladder: a cloud that refuses only platform_fact_v1 drops it alone and engine_carry_v1 stays (Ruling 128.1)", async () => {
    const { client, sent } = cloud(true, false);
    const answer = await client.hello({ ...base, capabilities: [ENGINE_CARRY_CAPABILITY, PLATFORM_FACT_HELLO_CAPABILITY] });
    expect((answer as { dropped?: string[] }).dropped?.[0]).toBe(PLATFORM_FACT_HELLO_CAPABILITY);
    expect((answer as { dropped?: string[] }).dropped).toHaveLength(1);
    expect(sent[1]!.capabilities.indexOf(ENGINE_CARRY_CAPABILITY)).toBe(0);
  });

  it("the retry carries no facts.platform either (a cloud rolled back after it listed platform_fact), and the other facts stay", async () => {
    const { client, sent } = cloud(true, false);
    const answer = await client.hello({ ...base, facts: { ...FACTS, platform: "wsl2" }, capabilities: [PLATFORM_FACT_HELLO_CAPABILITY] });
    expect(answer).toEqual({ kind: "ok", dropped: [PLATFORM_FACT_HELLO_CAPABILITY] });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.facts).toMatchObject({ platform: "wsl2" });
    expect(sent[1]!.facts).toEqual({ ...FACTS });
  });

  it("a cloud that takes it costs no retry, and the facts are sent as they are", async () => {
    const { client, sent } = cloud(false, true);
    await client.hello({ ...base, facts: { ...FACTS, platform: "linux" }, capabilities: [PLATFORM_FACT_HELLO_CAPABILITY] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.facts).toMatchObject({ platform: "linux" });
  });

  it("platformFact is set when the cloud lists platform_fact and platform_fact_v1 stood", async () => {
    const { client } = cloud(false, true);
    expect(await client.hello({ ...base, capabilities: [PLATFORM_FACT_HELLO_CAPABILITY] })).toEqual({ kind: "ok", platformFact: true });
  });

  it("platformFact is not set when the cloud does not list it, or when the capability was dropped even if the retried reply lists it", async () => {
    expect(await cloud(false, false).client.hello({ ...base, capabilities: [PLATFORM_FACT_HELLO_CAPABILITY] })).toEqual({ kind: "ok" });
    expect(await cloud(true, true).client.hello({ ...base, capabilities: [PLATFORM_FACT_HELLO_CAPABILITY] })).toEqual({ kind: "ok", dropped: [PLATFORM_FACT_HELLO_CAPABILITY] });
  });
});
