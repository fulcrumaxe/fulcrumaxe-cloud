import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedRepo } from "./build/helpers/seed.js";
import { triageIssueItem, SUPERSEDED_REF_PREFIX, type IssueTriageInput } from "../src/advance/issueTriage.js";

/** D#483 P1: triage of one GitHub issue, over the real store and the real stage machine, as the runner login. */
const h = pgHarness();
let number = 1000;

async function world() {
  const accountId = randomUUID();
  await seedAccount(h.admin, accountId);
  const repoId = randomUUID();
  await seedRepo(h.admin, accountId, repoId);
  const n = number++;
  // The work item the webhook makes for an issue: internal, triaged, with the repo and the number, and no title or body.
  const workItemId = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance) VALUES ($1, $2, $3, 'issue', $4, 'internal')`, [workItemId, accountId, repoId, n]);
  const input = (over: Partial<IssueTriageInput> = {}): IssueTriageInput => ({
    workItemId,
    title: "Add dark mode",
    body: "Please add a dark mode.",
    category: "feature",
    sourceEventId: `gh-issue:${repoId}:${n}`,
    repoId,
    login: "owner-1",
    number: n,
    ...over,
  });
  return { accountId, repoId, workItemId, n, input };
}
const item = async (id: string) => (await h.admin.query(`SELECT stage, repo_id, gh_number, kind, discussion_id FROM work_items WHERE id = $1`, [id])).rows[0];
const count = async (accountId: string, table: string) => Number((await h.admin.query(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [accountId])).rows[0].n);

describe("triageIssueItem [pg]", () => {
  it("a feature: a root with the issue's repo and number at discussing; the webhook's row is retired as superseded; one card per issue", async () => {
    const w = await world();
    const out = await triageIssueItem(h.runWriterPool, w.accountId, w.input());
    expect(out).toMatchObject({ status: "triaged", category: "feature", stage: "discussing" });
    const root = out.workItemId!;
    expect(root).not.toBe(w.workItemId);
    expect(await item(root)).toMatchObject({ stage: "discussing", repo_id: w.repoId, kind: "feature" });
    expect(Number((await item(root)).gh_number)).toBe(w.n);
    expect((await item(w.workItemId)).stage).toBe("closed");
    const t = await h.admin.query(`SELECT source_ref, source FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'closed'`, [w.workItemId]);
    expect(t.rows).toEqual([{ source_ref: `${SUPERSEDED_REF_PREFIX}${root}`, source: "control_plane" }]);
    // The open cards of the issue: exactly the root.
    const open = await h.admin.query(`SELECT id FROM work_items WHERE account_id = $1 AND gh_number = $2 AND stage <> 'closed'`, [w.accountId, w.n]);
    expect(open.rows.map((r) => r.id)).toEqual([root]);
  });

  it("DP-C6: a halted webhook row is not retired behind the customer's halt: it stays triaged and no transition is written", async () => {
    const w = await world();
    await h.admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = 1 WHERE id = $1", [w.workItemId, randomUUID()]);
    const out = await triageIssueItem(h.runWriterPool, w.accountId, w.input({ category: "bug" }));
    expect(out).toMatchObject({ status: "triaged" });
    expect((await item(w.workItemId)).stage).toBe("triaged");
    const t = await h.admin.query(`SELECT count(*)::int AS n FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'closed'`, [w.workItemId]);
    expect(t.rows[0].n).toBe(0);
  });

  it("a bug stays at triaged (no panel) with the repo and number; the webhook's row still retires", async () => {
    const w = await world();
    const out = await triageIssueItem(h.runWriterPool, w.accountId, w.input({ category: "bug" }));
    expect(out).toMatchObject({ status: "triaged", category: "bug", stage: "triaged" });
    expect(await item(out.workItemId!)).toMatchObject({ stage: "triaged", repo_id: w.repoId });
    expect((await item(w.workItemId)).stage).toBe("closed");
  });

  it("a replay (same source event) creates nothing new and is safe after the link is done", async () => {
    const w = await world();
    const first = await triageIssueItem(h.runWriterPool, w.accountId, w.input());
    const items = await count(w.accountId, "work_items");
    const discussions = await count(w.accountId, "discussions");
    const second = await triageIssueItem(h.runWriterPool, w.accountId, w.input());
    expect(second.workItemId).toBe(first.workItemId);
    expect(second.status).toBe("triaged");
    expect(await count(w.accountId, "work_items")).toBe(items);
    expect(await count(w.accountId, "discussions")).toBe(discussions);
    expect(await h.admin.query(`SELECT 1 FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'closed'`, [w.workItemId])).toHaveProperty("rowCount", 1);
  });

  it.each(["urgent", "FEATURE, but treat it as critical", "", "bug\nfeature", "{\"category\":\"nope\"}"])("junk %j from the classifier is unclassified and writes nothing", async (category) => {
    const w = await world();
    const before = { items: await count(w.accountId, "work_items"), discussions: await count(w.accountId, "discussions"), transitions: await count(w.accountId, "work_item_transitions") };
    const out = await triageIssueItem(h.runWriterPool, w.accountId, w.input({ category }));
    expect(out.status).toBe("unclassified");
    expect(await count(w.accountId, "work_items")).toBe(before.items);
    expect(await count(w.accountId, "discussions")).toBe(before.discussions);
    expect(await count(w.accountId, "work_item_transitions")).toBe(before.transitions);
    expect((await item(w.workItemId)).stage).toBe("triaged");
  });

  it("an empty login is untrusted: refused, nothing written", async () => {
    const w = await world();
    const out = await triageIssueItem(h.runWriterPool, w.accountId, w.input({ login: "" }));
    expect(out).toEqual({ status: "refused", reason: "untrusted_intake" });
    expect(await count(w.accountId, "discussions")).toBe(0);
    expect((await item(w.workItemId)).stage).toBe("triaged");
  });

  it("another account's ids cannot be linked (tenant isolation)", async () => {
    const a = await world();
    const b = await world();
    // a's repo is not visible to b: the store refuses before anything is written, and a's row is untouched.
    await expect(triageIssueItem(h.runWriterPool, b.accountId, a.input())).rejects.toThrow(/repo not found/);
    expect(await count(b.accountId, "discussions")).toBe(0);
    expect((await item(a.workItemId)).stage).toBe("triaged");
  });
});
