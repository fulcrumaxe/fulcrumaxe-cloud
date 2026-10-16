import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitText } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { RUN_WAIT_REASONS, getRunWait, getRunWaitReason } from "../src/index.js";
import { harness, type Harness } from "./helpers.js";

/**
 * [pg] D#599 PL-2b-2: "Waiting for a runner update (version V or later)". A run whose job is in the cross-side shape carries the lowest runner protocol
 * that may claim it. While every live runner that covers its repo is below that, it waits for an update. The reason is derived from the rows at read
 * time (the runners' stored versions now); nothing is stamped, so an updated runner's hello clears it.
 */
const NOW = new Date("2026-10-15T12:00:00.000Z");
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

describe("waiting_for_runner_update [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());
  const deps = () => h.deps({ now: () => NOW, minSupportedProtocolVersion: 1 });

  async function world() {
    const f: F2Fixture = await seedF2(h.admin);
    const installationId = randomUUID();
    await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team')", [installationId, f.accountId]);
    const repoId = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, floor(random() * 2000000000)::bigint + 1, 'team')", [repoId, f.accountId, installationId]);
    return { f, repoId };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function runner(w: World, over: { protocol?: number | null; lastSeen?: Date; paused?: boolean } = {}): Promise<string> {
    const id = await insertRunner(h.admin, w.f.accountId, w.f.a1, { credentialMode: "api_key" });
    await h.admin.query("UPDATE runners SET last_seen_at = $2, protocol_version = $3, binary_version = '0.9.1', allowed_repo_ids = $4::uuid[] WHERE id = $1", [
      id,
      over.lastSeen ?? ago(5),
      over.protocol === undefined ? 2 : over.protocol,
      [w.repoId],
    ]);
    if (over.paused) await h.admin.query("INSERT INTO runner_settings (runner_id, account_id, paused_at, paused_by, draining, drained_by) VALUES ($1, $2, $3, $4, false, NULL)", [id, w.f.accountId, ago(10), w.f.a1]);
    return id;
  }
  async function run(w: World, min: number | null): Promise<string> {
    const id = randomUUID();
    await h.admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, initiated_by, approved_by, dispatch_repo_id, min_protocol_version)
       VALUES ($1, $2, 'executor', 'runner', 'pending', $3, $3, $4, $5)`,
      [id, w.f.accountId, w.f.a1, w.repoId, min],
    );
    return id;
  }
  const reason = (w: World, id: string) => getRunWaitReason(deps(), w.f.accountId, id);

  it("is a wait reason with a plain sentence that names the version when it is known", () => {
    expect(RUN_WAIT_REASONS).toContain("waiting_for_runner_update");
    expect(waitText("waiting_for_runner_update", null)).toBe("Waiting for a runner update to continue this pull request");
    expect(waitText("waiting_for_runner_update", null, 3)).toBe("Waiting for a runner update (version 3 or later) to continue this pull request");
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(waitText("waiting_for_runner_update", null, bad)).toBe("Waiting for a runner update to continue this pull request");
  });

  it("waits for an update while every live covering runner is below the job's minimum, and says which version", async () => {
    const w = await world();
    await runner(w, { protocol: 2 });
    const id = await run(w, 3);
    expect(await reason(w, id)).toBe("waiting_for_runner_update");
    expect(await getRunWait(deps(), w.f.accountId, id)).toEqual({ reason: "waiting_for_runner_update", limited_by: null, min_protocol: 3 });
  });

  it("clears as soon as one live covering runner has said the minimum: derived from the stored versions, nothing stamped", async () => {
    const w = await world();
    const old = await runner(w, { protocol: 2 });
    const id = await run(w, 3);
    expect(await reason(w, id)).toBe("waiting_for_runner_update");
    await h.admin.query("UPDATE runners SET protocol_version = 3 WHERE id = $1", [old]);
    expect(await reason(w, id)).toBeNull();
    await h.admin.query("UPDATE runners SET protocol_version = 2 WHERE id = $1", [old]);
    expect(await reason(w, id)).toBe("waiting_for_runner_update");
  });

  it("does not wait when an updated runner is among the covering ones", async () => {
    const w = await world();
    await runner(w, { protocol: 2 });
    await runner(w, { protocol: 3 });
    expect(await reason(w, await run(w, 3))).toBeNull();
  });

  it("does not count a runner that is offline or paused: an updated runner that cannot claim does not clear the wait", async () => {
    const w = await world();
    await runner(w, { protocol: 2 });
    await runner(w, { protocol: 3, lastSeen: ago(500) });
    await runner(w, { protocol: 3, paused: true });
    expect(await reason(w, await run(w, 3))).toBe("waiting_for_runner_update");
  });

  it("a job with no minimum is unaffected, and with no live runner at all the older reason stands", async () => {
    const w = await world();
    await runner(w, { protocol: 2 });
    expect(await reason(w, await run(w, null))).toBeNull();
    const empty = await world();
    expect(await reason(empty, await run(empty, 3))).toBe("waiting_for_runner");
    const stale = await world();
    await runner(stale, { protocol: 2, lastSeen: ago(900) });
    expect(await reason(stale, await run(stale, 3))).toBe("waiting_for_runner");
  });

  it("a runner that stored no version counts as below any minimum", async () => {
    const w = await world();
    await runner(w, { protocol: null });
    expect(await reason(w, await run(w, 3))).toBe("waiting_for_runner_update");
  });
});
