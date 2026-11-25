import { describe, expect, it } from "vitest";
import { HEARTBEAT_INVENTORY_HELLO_CAPABILITY, KVM_FACT_HELLO_CAPABILITY, SANDBOX_COMMAND_CAPABILITY, SANDBOX_INVENTORY_MIN_PROTOCOL, type HelloMessage, type SandboxInventoryRow } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { createInventoryReporter, type InventorySource } from "../../src/daemon/sandboxInventory.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../../src/version.js";
// D#845 ON-10e1: `survey_public_v1` is the newest capability of all and is dropped before everything on the ladder (pinned in surveyPublic.test.ts); these tests pin the ladder behind it.
const BUILD_BEHIND_PUBLIC = RUNNER_BUILD_CAPABILITIES.filter((c) => c !== "survey_public_v1");

const RUN = "11111111-1111-4111-8111-111111111111";
const vm = (name: string): SandboxInventoryRow => ({ name, state: "running", created_at: "2026-11-21T10:00:00Z", last_used_at: null, disk_bytes: 1, snapshot_count: 0, snapshot_age_s: null });
const base: HelloMessage = { protocol_version: RUNNER_PROTOCOL_VERSION, binary_version: RUNNER_VERSION, model_auth_present: false, isolation: "host_sandbox" };
const common = [...BUILD_BEHIND_PUBLIC, SANDBOX_COMMAND_CAPABILITY];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A cloud at one of three ages. `old` (before D#587 FU-179): strict messages, so a hello that names `heartbeat_inventory_v1` and a heartbeat that carries `sandboxes` are both 400 invalid_message.
 * `new`: lists `heartbeat_inventory`, stores what a heartbeat carries and says so with `sandboxes_recorded` (unless `forgets`: it answers 200 without having stored).
 */
function cloud(kind: "old" | "new", options: { forgets?: boolean } = {}) {
  const hellos: string[][] = [];
  const beats: Array<Record<string, unknown>> = [];
  const claims: Array<Record<string, unknown>> = [];
  /** What the cloud holds for this runner, as the definer would: replaced whole by each block it stores. */
  let stored: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith("/api/runner/hello")) {
      const caps = (body.capabilities ?? []) as string[];
      hellos.push(caps);
      if (kind === "old" && caps.includes(HEARTBEAT_INVENTORY_HELLO_CAPABILITY)) return json(400, { error: { code: "invalid_message", message: "x" } });
      return json(200, { protocol_version: 1, ...(kind === "new" && caps.includes(HEARTBEAT_INVENTORY_HELLO_CAPABILITY) ? { capabilities: ["heartbeat_inventory"] } : {}) });
    }
    if (url.endsWith("/api/runner/heartbeat")) {
      beats.push(body);
      if (kind === "old" && "sandboxes" in body) return json(400, { error: { code: "invalid_message", message: "x" } });
      if ("sandboxes" in body && !options.forgets) stored = (body.sandboxes as SandboxInventoryRow[]).map((r) => r.name);
      return json(200, { continue: true, lease_expires_at: "2026-11-21T12:01:30.000Z", ...("sandboxes" in body && !options.forgets ? { sandboxes_recorded: true } : {}) });
    }
    claims.push(body);
    if ("sandboxes" in body) stored = (body.sandboxes as SandboxInventoryRow[]).map((r) => r.name);
    return json(200, { retry_after: 5 });
  }) as unknown as typeof fetch;
  return { fetchFn, hellos, beats, claims, stored: () => stored };
}

function runner(c: ReturnType<typeof cloud>, over: { protocolVersion?: number; flag?: () => boolean } = {}) {
  let listed: SandboxInventoryRow[] = [];
  const source: InventorySource = { list: async () => listed };
  const reporter = createInventoryReporter({ source, now: () => new Date("2026-11-21T10:00:00Z") });
  const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn: c.fetchFn, sandboxInventory: reporter, heartbeatInventory: over.flag ?? (() => true), ...(over.protocolVersion === undefined ? {} : { protocolVersion: over.protocolVersion }) });
  return { client, set: (rows: SandboxInventoryRow[]) => void (listed = rows) };
}

describe("heartbeat carries the sandbox inventory while a run is held (FU-179)", () => {
  it("a job VM reaches the cloud on the heartbeat while the job runs, and is gone after the heartbeat that follows its destroy", async () => {
    const c = cloud("new");
    const { client, set } = runner(c);
    set([]);
    expect(await client.heartbeat(RUN, 1)).toMatchObject({ kind: "ok" });
    expect(c.stored()).toEqual([]);
    set([vm("job-vm-1")]); // VM created for the job; no claim is sent while the run is held
    expect(await client.heartbeat(RUN, 1)).toMatchObject({ kind: "ok" });
    expect(c.stored()).toEqual(["job-vm-1"]);
    expect(c.claims).toEqual([]);
    set([]); // VM destroyed
    await client.heartbeat(RUN, 1);
    expect(c.stored()).toEqual([]);
  });

  it("the fingerprint dedupe holds: an unchanged list rides no further heartbeat, and a changed one rides the next", async () => {
    const c = cloud("new");
    const { client, set } = runner(c);
    set([vm("a")]);
    for (let i = 0; i < 4; i++) await client.heartbeat(RUN, 1);
    expect(c.beats.map((b) => "sandboxes" in b)).toEqual([true, false, false, false]);
    set([vm("a"), vm("b")]);
    await client.heartbeat(RUN, 1);
    expect(c.beats.map((b) => "sandboxes" in b)).toEqual([true, false, false, false, true]);
  });

  it("the dedupe state is shared with the claim: a list a heartbeat stored is not sent again on the claim after the job", async () => {
    const c = cloud("new");
    const { client, set } = runner(c);
    set([vm("a")]);
    await client.heartbeat(RUN, 1);
    await client.claim(undefined, undefined);
    expect("sandboxes" in c.claims[0]!).toBe(false);
    set([]);
    await client.claim(undefined, undefined);
    expect(c.claims[1]!.sandboxes).toEqual([]);
  });

  it("a 200 that does not say sandboxes_recorded is not counted: the same list goes again", async () => {
    const c = cloud("new", { forgets: true });
    const { client, set } = runner(c);
    set([vm("a")]);
    await client.heartbeat(RUN, 1);
    await client.heartbeat(RUN, 1);
    expect(c.beats.map((b) => "sandboxes" in b)).toEqual([true, true]);
  });

  it("an old cloud (flag off): the heartbeat body is exactly what it always was", async () => {
    const c = cloud("old");
    const { client, set } = runner(c, { flag: () => false });
    set([vm("a")]);
    expect(await client.heartbeat(RUN, 1)).toMatchObject({ kind: "ok" });
    expect(c.beats).toEqual([{ run_id: RUN, lease_generation: 1 }]);
  });

  it("a protocol below 21 never sends the block", async () => {
    const c = cloud("new");
    const { client, set } = runner(c, { protocolVersion: SANDBOX_INVENTORY_MIN_PROTOCOL - 1 });
    set([vm("a")]);
    await client.heartbeat(RUN, 1);
    expect(c.beats).toEqual([{ run_id: RUN, lease_generation: 1 }]);
  });

  it("a runner with no reporter (no VM stack) sends the plain heartbeat even when the cloud listed the capability", async () => {
    const c = cloud("new");
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn: c.fetchFn, heartbeatInventory: () => true });
    await client.heartbeat(RUN, 1);
    expect(c.beats).toEqual([{ run_id: RUN, lease_generation: 1 }]);
  });
});

describe("hello: heartbeat_inventory_v1 is dropped first", () => {
  const declared = [...common, KVM_FACT_HELLO_CAPABILITY, HEARTBEAT_INVENTORY_HELLO_CAPABILITY];
  it("old cloud x new runner: one retry drops only heartbeat_inventory_v1 (kvm_fact_v1 stays), and the runner's flag stays off", async () => {
    const c = cloud("old");
    const { client } = runner(c);
    const answer = await client.hello({ ...base, capabilities: declared });
    expect(answer).toEqual({ kind: "ok", dropped: [HEARTBEAT_INVENTORY_HELLO_CAPABILITY] });
    expect(c.hellos).toHaveLength(2);
    expect(JSON.stringify(c.hellos[1])).toBe(JSON.stringify([...common, KVM_FACT_HELLO_CAPABILITY]));
  });

  it("new cloud x new runner: heartbeatInventory is set", async () => {
    const c = cloud("new");
    const { client } = runner(c);
    expect(await client.hello({ ...base, capabilities: declared })).toEqual({ kind: "ok", heartbeatInventory: true });
  });

  it("new cloud x old runner: a hello that never declared it gets the reply it always did, and no flag", async () => {
    const c = cloud("new");
    const { client } = runner(c);
    expect(await client.hello({ ...base, capabilities: common })).toEqual({ kind: "ok" });
    expect(c.hellos).toEqual([common]);
  });
});
