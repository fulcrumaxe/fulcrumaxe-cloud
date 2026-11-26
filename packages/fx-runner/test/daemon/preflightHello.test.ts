import { describe, expect, it } from "vitest";
import { BROWSER_CHROME_CAPABILITY, BROWSER_PLAYWRIGHT_CAPABILITY, DEPLOY_ORDER_CAPABILITY, KVM_FACT_HELLO_CAPABILITY, PREFLIGHT_HELLO_CAPABILITY, SANDBOX_COMMAND_CAPABILITY, type HelloMessage } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../../src/version.js";
// D#845 ON-10e1: `survey_public_v1` is the newest capability of all and is dropped before everything on the ladder (pinned in surveyPublic.test.ts); these tests pin the ladder behind it.
// D#845 ON-8f2c: `project_setup_v1` is newer still and is dropped first of all (pinned in daemon/projectSetupHello.test.ts), so the ladders below start behind both.
const BUILD_BEHIND_PUBLIC = RUNNER_BUILD_CAPABILITIES.filter((c) => c !== "survey_public_v1" && c !== "project_setup_v1" && c !== "engine_session_v1");

/** D#845 ON-21b: the hello's drop ladder tries `preflight_v1` first, so an old cloud costs one retry and keeps every other capability, `kvm_fact_v1` included. */
const base: HelloMessage = { protocol_version: RUNNER_PROTOCOL_VERSION, binary_version: RUNNER_VERSION, model_auth_present: false, isolation: "host_sandbox" };
const common = [...BUILD_BEHIND_PUBLIC, SANDBOX_COMMAND_CAPABILITY];

/** A cloud that refuses each named capability with 400 invalid_message; `lists` are the capabilities its replies list (even to a hello that was retried without them). */
function cloud(refuses: string[], lists: string[]) {
  const sent: string[][] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const caps = (JSON.parse(String(init.body)).capabilities ?? []) as string[];
    sent.push(caps);
    const refuse = refuses.some((r) => caps.includes(r));
    const body = refuse ? { error: { code: "invalid_message", message: "x" } } : lists.length > 0 ? { protocol_version: 1, capabilities: lists } : {};
    return new Response(JSON.stringify(body), { status: refuse ? 400 : 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn }), sent };
}

describe("hello: preflight_v1 is dropped first", () => {
  const withBrowsers: HelloMessage["capabilities"] = [BROWSER_PLAYWRIGHT_CAPABILITY, BROWSER_CHROME_CAPABILITY, DEPLOY_ORDER_CAPABILITY];
  for (const extras of [[], withBrowsers] as const) {
    it(`a cloud that predates it costs one retry that drops only preflight_v1, and keeps kvm_fact_v1 (extras: ${extras.length})`, async () => {
      const { client, sent } = cloud([PREFLIGHT_HELLO_CAPABILITY], []);
      const answer = await client.hello({ ...base, capabilities: [...common, KVM_FACT_HELLO_CAPABILITY, PREFLIGHT_HELLO_CAPABILITY, ...(extras ?? [])] });
      expect(answer).toEqual({ kind: "ok", dropped: [PREFLIGHT_HELLO_CAPABILITY] });
      expect(sent).toHaveLength(2);
      // Byte for byte what a runner with a KVM reading and no preflight reader sends.
      expect(JSON.stringify(sent[1])).toBe(JSON.stringify([...common, KVM_FACT_HELLO_CAPABILITY, ...(extras ?? [])]));
    });
  }

  it("a cloud that predates both costs two retries, preflight_v1 first and then kvm_fact_v1, and ends at the hello a runner without either sends", async () => {
    const { client, sent } = cloud([PREFLIGHT_HELLO_CAPABILITY, KVM_FACT_HELLO_CAPABILITY], []);
    const answer = await client.hello({ ...base, capabilities: [...common, KVM_FACT_HELLO_CAPABILITY, PREFLIGHT_HELLO_CAPABILITY] });
    expect(answer).toEqual({ kind: "ok", dropped: [PREFLIGHT_HELLO_CAPABILITY, KVM_FACT_HELLO_CAPABILITY] });
    expect(sent).toHaveLength(3);
    expect(sent[1]).not.toContain(PREFLIGHT_HELLO_CAPABILITY);
    expect(sent[1]).toContain(KVM_FACT_HELLO_CAPABILITY);
    expect(JSON.stringify(sent[2])).toBe(JSON.stringify(common));
  });

  it("an old cloud is never asked twice for the same thing: a runner that declares nothing new sends one hello", async () => {
    const { client, sent } = cloud([PREFLIGHT_HELLO_CAPABILITY, KVM_FACT_HELLO_CAPABILITY], []);
    expect(await client.hello({ ...base, capabilities: common })).toEqual({ kind: "ok" });
    expect(sent).toHaveLength(1);
  });

  it("preflight is set when the cloud lists it and preflight_v1 stood; kvmFact is independent of it", async () => {
    const both = cloud([], ["kvm_fact", "preflight"]);
    expect(await both.client.hello({ ...base, capabilities: [...common, KVM_FACT_HELLO_CAPABILITY, PREFLIGHT_HELLO_CAPABILITY] })).toEqual({ kind: "ok", kvmFact: true, preflight: true });
    const onlyPreflight = cloud([], ["preflight"]);
    expect(await onlyPreflight.client.hello({ ...base, capabilities: [...common, PREFLIGHT_HELLO_CAPABILITY] })).toEqual({ kind: "ok", preflight: true });
    const onlyKvm = cloud([], ["kvm_fact"]);
    expect(await onlyKvm.client.hello({ ...base, capabilities: [...common, KVM_FACT_HELLO_CAPABILITY, PREFLIGHT_HELLO_CAPABILITY] })).toEqual({ kind: "ok", kvmFact: true });
  });

  it("preflight is not set when preflight_v1 was dropped, even if the reply to the retried hello lists preflight", async () => {
    const { client } = cloud([PREFLIGHT_HELLO_CAPABILITY], ["preflight"]);
    expect(await client.hello({ ...base, capabilities: [...common, PREFLIGHT_HELLO_CAPABILITY] })).toEqual({ kind: "ok", dropped: [PREFLIGHT_HELLO_CAPABILITY] });
  });

  it("preflight is not set when the cloud does not list it, or when the runner never declared it", async () => {
    const unlisted = cloud([], []);
    expect(await unlisted.client.hello({ ...base, capabilities: [...common, PREFLIGHT_HELLO_CAPABILITY] })).toEqual({ kind: "ok" });
  });
});
