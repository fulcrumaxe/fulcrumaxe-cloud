import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { applyMappedEvent, mapEvent, type GithubPullRequestPayload } from "@fx/github";
import { pullRequestBody } from "@fx/runner-cloud";

/**
 * [pg] D#6 C42-5: the pull request a runner run opens moves its work item the same way a sandbox run's does. The pull_request webhook only
 * moves an item whose pull request body says `Closes #<issue>`; the runner path used to say nothing, so the item sat at In progress until the
 * stage driver's grace loop found the pull request. One shared test runs both bodies through the real webhook mapping and the real stage write.
 */
const FIXTURE = new URL("../../github/test/fixtures/pull_request.opened.json", import.meta.url);
const ISSUE = 595;

describe("a pull request opened for a run moves its item (webhook) [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let A: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await appPool.end();
    await adminPool.end();
  });
  beforeEach(async () => {
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE work_items SET gh_number = $2, stage = 'in_progress' WHERE id = $1", [A.workItemId, ISSUE]);
  });

  const stage = async () => (await admin.query("SELECT stage FROM work_items WHERE id = $1", [A.workItemId])).rows[0].stage as string;

  /** A signed-shape `pull_request.opened` by the platform's App (not a fork) with `body`, applied through the real mapper and stage write. */
  async function deliver(body: string) {
    const payload = JSON.parse(readFileSync(FIXTURE, "utf8")) as GithubPullRequestPayload;
    payload.pull_request.body = body;
    payload.pull_request.user = { ...payload.pull_request.user, login: "fulcrumaxe[bot]" } as never;
    const mapped = mapEvent("pull_request", payload, { allowlist: [] });
    return withTenant(appPool, A.accountId, (client) =>
      applyMappedEvent(client, { accountId: A.accountId, installationId: randomUUID(), repoId: A.repoId, repo: { accountId: A.accountId, repoId: A.repoId, ghRepoId: 9001, fullName: "acme-corp/widgets" }, deliveryId: `d-${randomUUID()}` }, mapped),
    );
  }

  const runId = randomUUID();
  const sandboxBody = `Closes #${ISSUE}\n\nDescribed in the agent's own words.`;
  const runnerBody = () => pullRequestBody({ runId, workItemId: A.workItemId, issueNumber: ISSUE });

  for (const [runtime, body] of [
    ["sandbox", () => sandboxBody],
    ["runner", runnerBody],
  ] as const) {
    it(`a ${runtime} run's pull request body moves the item off in_progress in the same webhook handling`, async () => {
      expect(await stage()).toBe("in_progress");
      expect(await deliver(body())).toMatchObject({ applied: "transitioned", workItemId: A.workItemId, recorded: true });
      expect(await stage()).toBe("pr_opened");
      const { rows } = await admin.query("SELECT source FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'pr_opened'", [A.workItemId]);
      expect(rows).toEqual([{ source: "webhook" }]);
    });
  }

  it("the body the runner path used to send (no issue number) is skipped by the webhook, so the item stays where it was", async () => {
    expect(await deliver(pullRequestBody({ runId, workItemId: A.workItemId }))).toMatchObject({ applied: "skipped" });
    expect(await stage()).toBe("in_progress");
  });

  it("with the ready-fallback line the reference still links", async () => {
    expect(await deliver(pullRequestBody({ runId, workItemId: A.workItemId, issueNumber: ISSUE }, { readyFallback: true }))).toMatchObject({ applied: "transitioned" });
    expect(await stage()).toBe("pr_opened");
  });
});
