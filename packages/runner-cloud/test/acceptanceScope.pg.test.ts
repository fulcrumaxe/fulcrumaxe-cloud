import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Text } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { loadAcceptanceScope } from "../src/acceptanceScope.js";
import { loadRunPullRequestText } from "../src/runPullRequest.js";
import { harness, type Harness } from "./helpers.js";

/** [pg] D#6 R2b-3e: the scope is read from the run's own spec version, under the run's tenant, against the real tables. */
describe("loadAcceptanceScope [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let B: SeedRefs;

  beforeAll(async () => {
    h = await harness();
    A = await seedAccount(h.admin, randomUUID());
    B = await seedAccount(h.admin, randomUUID());
  });
  afterAll(() => h.close());

  /** A spec version of `account`'s work item with this frontmatter, attached to the account's seeded run (or not). */
  async function specFor(account: SeedRefs, frontmatter: unknown, o: { attach?: boolean; erased?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await h.admin.query(
      `INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, frontmatter, created_by_kind, erased_at)
       VALUES ($1, $2, $3, (SELECT COALESCE(max(version), 0) + 1 FROM spec_versions WHERE work_item_id = $3), 'spec', $4, $5::jsonb, 'system', $6)`,
      [id, account.accountId, account.workItemId, sha256Text("spec"), JSON.stringify(frontmatter), o.erased ? new Date() : null],
    );
    await h.admin.query("SET session_replication_role = replica");
    try {
      await h.admin.query("UPDATE agent_runs SET spec_version_id = $1 WHERE id = $2", [o.attach === false ? null : id, account.runId]);
    } finally {
      await h.admin.query("SET session_replication_role = DEFAULT");
    }
    return id;
  }

  const read = (account: SeedRefs, runId = account.runId) => withTenant(h.appPool, account.accountId, (client) => loadAcceptanceScope(client, { accountId: account.accountId, runId }));

  it("reads acceptance_files of the run's spec version, as the tenant", async () => {
    await specFor(A, { acceptance_files: ["packages/web/**", "README.md"], other: 1 });
    expect(await read(A)).toEqual({ kind: "known", entries: ["packages/web/**", "README.md"] });
  });

  it("is unknown for a spec version with no list, an unreadable list, an erased version, and a run with no spec version, with the reason", async () => {
    await specFor(A, {});
    expect(await read(A)).toEqual({ kind: "unknown", reason: "absent" });
    await specFor(A, { acceptance_files: [] });
    expect(await read(A)).toEqual({ kind: "unknown", reason: "absent" });
    await specFor(A, { acceptance_files: "src/**" });
    expect(await read(A)).toEqual({ kind: "unknown", reason: "unreadable" });
    await specFor(A, { acceptance_files: ["src/{a}.ts"] });
    expect(await read(A)).toEqual({ kind: "unknown", reason: "unreadable" });
    await specFor(A, { acceptance_files: ["src/**"] }, { erased: true });
    expect(await read(A)).toEqual({ kind: "unknown", reason: "unreadable" });
    await specFor(A, { acceptance_files: ["src/**"] }, { attach: false });
    expect(await read(A)).toEqual({ kind: "unknown", reason: "unreadable" });
  });

  it("never reads another account's run, even by id", async () => {
    await specFor(B, { acceptance_files: ["secret/**"] });
    expect(await withTenant(h.appPool, A.accountId, (client) => loadAcceptanceScope(client, { accountId: A.accountId, runId: B.runId }))).toEqual({ kind: "unknown", reason: "unreadable" });
    expect(await withTenant(h.appPool, A.accountId, (client) => loadAcceptanceScope(client, { accountId: B.accountId, runId: B.runId }))).toEqual({ kind: "unknown", reason: "unreadable" });
  });

  it("loads the pull request text inputs: the run id, its work item's id and the work item's title, tenant-scoped", async () => {
    await h.admin.query("UPDATE work_items SET title = $2 WHERE id = $1", [A.workItemId, "Add the footer"]);
    const text = await withTenant(h.appPool, A.accountId, (client) => loadRunPullRequestText(client, { accountId: A.accountId, runId: A.runId }));
    expect(text).toEqual({ runId: A.runId, workItemId: A.workItemId, workItemTitle: "Add the footer", issueNumber: null });
    // The issue number is read from our own work item row; one that cannot be a reference (past 9 digits) reads as none.
    await h.admin.query("UPDATE work_items SET gh_number = 595 WHERE id = $1", [A.workItemId]);
    expect(await withTenant(h.appPool, A.accountId, (client) => loadRunPullRequestText(client, { accountId: A.accountId, runId: A.runId }))).toMatchObject({ issueNumber: 595 });
    await h.admin.query("UPDATE work_items SET gh_number = 1234567890 WHERE id = $1", [A.workItemId]);
    expect(await withTenant(h.appPool, A.accountId, (client) => loadRunPullRequestText(client, { accountId: A.accountId, runId: A.runId }))).toMatchObject({ issueNumber: null });
    expect(await withTenant(h.appPool, A.accountId, (client) => loadRunPullRequestText(client, { accountId: A.accountId, runId: B.runId }))).toBeNull();
    expect(await withTenant(h.appPool, A.accountId, (client) => loadRunPullRequestText(client, { accountId: A.accountId, runId: randomUUID() }))).toBeNull();
  });
});
