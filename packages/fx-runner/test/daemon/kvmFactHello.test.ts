import { describe, expect, it } from "vitest";
import { BROWSER_CHROME_CAPABILITY, BROWSER_PLAYWRIGHT_CAPABILITY, DEPLOY_ORDER_CAPABILITY, KVM_FACT_HELLO_CAPABILITY, SANDBOX_COMMAND_CAPABILITY, type HelloMessage } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../../src/version.js";

/** D#845 ON-6c: the hello's drop ladder tries `kvm_fact_v1` first, so an old cloud costs one retry and keeps every other capability. */
const base: HelloMessage = { protocol_version: RUNNER_PROTOCOL_VERSION, binary_version: RUNNER_VERSION, model_auth_present: false, isolation: "host_sandbox" };
const common = [...RUNNER_BUILD_CAPABILITIES, SANDBOX_COMMAND_CAPABILITY];

/** A cloud that refuses `kvm_fact_v1` with 400 invalid_message; when `listsKvm`, its replies list `kvm_fact` (even to a hello that was retried without it). */
function cloud(refusesKvm: boolean, listsKvm: boolean) {
  const sent: string[][] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const caps = (JSON.parse(String(init.body)).capabilities ?? []) as string[];
    sent.push(caps);
    const refuse = refusesKvm && caps.includes(KVM_FACT_HELLO_CAPABILITY);
    const body = refuse ? { error: { code: "invalid_message", message: "x" } } : listsKvm ? { protocol_version: 1, capabilities: ["kvm_fact"] } : {};
    return new Response(JSON.stringify(body), { status: refuse ? 400 : 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn }), sent };
}

describe("hello: kvm_fact_v1 is dropped first", () => {
  const withBrowsers: HelloMessage["capabilities"] = [BROWSER_PLAYWRIGHT_CAPABILITY, BROWSER_CHROME_CAPABILITY, DEPLOY_ORDER_CAPABILITY];
  for (const extras of [[], withBrowsers] as const) {
    it(`an old cloud costs one retry that drops only kvm_fact_v1 (extras: ${extras.length})`, async () => {
      const { client, sent } = cloud(true, false);
      const answer = await client.hello({ ...base, capabilities: [...common, KVM_FACT_HELLO_CAPABILITY, ...(extras ?? [])] });
      expect(answer).toEqual({ kind: "ok", dropped: [KVM_FACT_HELLO_CAPABILITY] });
      expect(sent).toHaveLength(2);
      // Byte for byte what a runner with no KVM reading sends.
      expect(JSON.stringify(sent[1])).toBe(JSON.stringify([...common, ...(extras ?? [])]));
    });
  }

  it("kvmFact is set when the cloud lists kvm_fact and kvm_fact_v1 stood", async () => {
    const { client } = cloud(false, true);
    expect(await client.hello({ ...base, capabilities: [...common, KVM_FACT_HELLO_CAPABILITY] })).toEqual({ kind: "ok", kvmFact: true });
  });

  it("kvmFact is not set when kvm_fact_v1 was dropped, even if the reply to the retried hello lists kvm_fact", async () => {
    const { client } = cloud(true, true);
    expect(await client.hello({ ...base, capabilities: [...common, KVM_FACT_HELLO_CAPABILITY] })).toEqual({ kind: "ok", dropped: [KVM_FACT_HELLO_CAPABILITY] });
  });
});
