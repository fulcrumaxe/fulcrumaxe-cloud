import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { getRunWait } from "../src/index.js";
import { harness, type Harness } from "./helpers.js";

/**
 * [pg] D#7 DW-R7 follow-up: the Runs read model and the claim's approval test read one rule for a run whose member-plan ask was answered "no" (0987). With the
 * dial at announce and the holder's consent on, an unasked run reads as runnable without a click; once the holder said no it reads as waiting for approval,
 * which is the state the Runs card's Approve button answers (a person's change of mind), and an answer of yes, or no answer yet, changes nothing.
 */
describe("a declined run is waiting for approval, not runnable [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let holder: string;
  let teammate: string;
  let repo: string;

  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  async function user(role: "admin" | "member"): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [id, `${id}@example.test`, role]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [A.accountId, id, role]);
    return id;
  }
  async function pending(): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, work_item_id, initiated_by) VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local', $3, $4, $5)", [id, A.accountId, repo, A.workItemId, teammate]);
    return id;
  }
  /** The ask row and its holder link as the worker's writers leave them, answered with `option` (or still open when null). */
  async function asked(runId: string, runner: string, option: string | null): Promise<void> {
    const ask = randomUUID();
    const answered = option === null ? "NULL, NULL, NULL" : `'${option}', '${holder}', now()`;
    await h.admin.query(
      `INSERT INTO decision_asks (id, account_id, repo_id, work_item_id, run_id, decision_type, options, proposed, rationale, input_trust_classes, answer_due_at, timeout_outcome, state, answered_option, answered_by, answered_at)
       VALUES ($1, $2, $3, $4, $5, 'runner_run_on_member_plan', '[{"id":"approve","label":"Yes"},{"id":"decline","label":"No"}]'::jsonb, 'approve', 'r', '[]'::jsonb, now() + interval '1 day', 'stop_and_flag', '${option === null ? "open" : "answered"}', ${answered})`,
      [ask, A.accountId, repo, A.workItemId, runId],
    );
    await h.admin.query("INSERT INTO runner_plan_asks (account_id, run_id, ask_id, runner_id, plan_holder) VALUES ($1, $2, $3, $4, $5)", [A.accountId, runId, ask, runner, holder]);
  }

  let runner: string;
  beforeEach(async () => {
    A = await seedAccount(h.admin, randomUUID());
    repo = A.repoId;
    holder = await user("admin");
    teammate = await user("member");
    runner = await insertRunner(h.admin, A.accountId, holder, { credentialMode: "subscription" });
    await h.admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2::uuid], last_seen_at = now() WHERE id = $1", [runner, repo]);
    await h.admin.query("INSERT INTO runner_plan_consents (account_id, runner_id, granted, version, changed_by) VALUES ($1, $2, true, 1, $3)", [A.accountId, runner, holder]);
    await h.admin.query("INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'runner_run_on_member_plan', 'announce', 1, $3)", [A.accountId, repo, A.userId]);
  });

  const reason = async (id: string) => (await getRunWait(h.deps({}), A.accountId, id)).reason;

  it("an unasked run is runnable under announce; the same run after a no (decline or deny) waits for approval; after a yes, or while the ask is open, it is as before", async () => {
    const unasked = await pending();
    expect(await reason(unasked)).not.toBe("waiting_for_approval");
    for (const option of ["decline", "deny"]) {
      const no = await pending();
      await asked(no, runner, option);
      expect(await reason(no)).toBe("waiting_for_approval");
    }
    const yes = await pending();
    await asked(yes, runner, "approve");
    expect(await reason(yes)).not.toBe("waiting_for_approval");
    const open = await pending();
    await asked(open, runner, null);
    expect(await reason(open)).not.toBe("waiting_for_approval");
  });
});
