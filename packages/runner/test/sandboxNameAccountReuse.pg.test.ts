import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { startAgentRun } from "../src/startAgentRun.js";
import { cancelRun } from "../src/cancelRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { SandboxPort } from "../src/sandboxPort.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * PR #85 fix round 3, must-fix 2 (CWE-639/706/200): `repos.id` has no
 * UNIQUE constraint across accounts and no protection against reuse
 * after a delete. Ported from the reviewer's attack file: tenant B
 * dispatches an executor run against `repos.id = X`, then deletes that
 * repo; tenant A then inserts its OWN `repos` row reusing the exact same
 * `id = X` (accepted -- nothing at the database stops a caller from
 * choosing a UUID that used to belong to someone else) and dispatches
 * its own executor run against the SAME (repoId, pr) pair B used.
 *
 * Before the fix (`ex-{repoId}-{pr}`), A's sandbox name was IDENTICAL to
 * B's still-live persistent sandbox name -- on a provider where the name
 * is the resume identity, A could land in or stop B's sandbox. After the
 * fix (`ex-{accountId}-{repoId}-{pr}`), the two names can never collide
 * even though `repoId` and `pr` really are identical, because `accountId`
 * is part of the injective triple.
 */
describe("PR #85 fix round 3, must-fix 2: repo-id reuse after delete produces distinct sandbox names per tenant [pg]", () => {
  const db = pgHarness();
  it("tenant A reusing tenant B's deleted repos.id never produces B's sandbox name, and A's own cancel only ever targets A's name", async () => {
    const A = randomUUID(), B = randomUUID(), ua = randomUUID(), ub = randomUUID(), X = randomUUID(), wi = randomUUID();
    await seedAccount(db.admin, A);
    await seedAccount(db.admin, B);
    await seedMember(db.admin, A, ua);
    await seedMember(db.admin, B, ub);
    await seedRepo(db.admin, B, X);
    await seedWorkItem(db.admin, B, wi, X, { ghNumber: 5 });
    const log: string[] = [];
    const wrap = (p: SandboxPort, who: string): SandboxPort => ({
      ...p,
      async createSandbox(o) { log.push(`${who} create:${o.sandboxName}`); return p.createSandbox(o); },
      startDetached(h, o) { log.push(`${who} start:${h.sandboxName}`); return p.startDetached(h, o); },
      async stop(h) { log.push(`${who} stop:${h.sandboxName}`); return p.stop(h); },
    });
    const spend = { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const };
    const hb = createSandboxTargetHarness(db.runWriterPool);
    await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget({ ...hb.deps, sandboxPort: wrap(hb.deps.sandboxPort, "B") }) },
      { accountId: B, repoId: X, workItemId: wi, role: "executor", product: "team", pr: 5, roleCard: "r", prompt: "p", model: "haiku-4.5", capUsd: 5, spend });
    const del = await withTenant(db.runWriterPool, B, (c) => c.query(`DELETE FROM repos WHERE id=$1`, [X]).then((r) => r.rowCount)).catch((e) => String(e));
    const ins = await withTenant(db.runWriterPool, A, (c) =>
      c.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1,$2,$3,'team')`, [X, A, 424242]).then((r) => r.rowCount),
    ).catch((e) => String(e));
    expect(del).toBe(1);
    expect(ins).toBe(1);

    const ha = createSandboxTargetHarness(db.runWriterPool);
    const r = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget({ ...ha.deps, sandboxPort: wrap(ha.deps.sandboxPort, "A") }) },
      { accountId: A, repoId: X, role: "executor", product: "team", pr: 5, roleCard: "r", prompt: "p", model: "haiku-4.5", capUsd: 5, spend });
    const out = await cancelRun({ pool: db.runWriterPool, principal: { accountId: A, userId: ua } }, r.id,
      { sandbox: new SandboxTarget({ ...ha.deps, sandboxPort: wrap(ha.deps.sandboxPort, "A") }) });
    console.log("REUSE", JSON.stringify({ del, ins, out, log }, null, 1));

    const bCreate = log.find((l) => l.startsWith("B create:"));
    const aCreate = log.find((l) => l.startsWith("A create:"));
    expect(bCreate).toBeDefined();
    expect(aCreate).toBeDefined();
    const bName = bCreate!.slice("B create:".length);
    const aName = aCreate!.slice("A create:".length);
    // The must-fix-2 assertion: same (repoId, pr), reused across a
    // delete, still produces two DIFFERENT sandbox names.
    expect(aName).not.toBe(bName);
    // A's own cancel only ever stops A's OWN sandbox, never B's.
    expect(log).not.toContain(`A stop:${bName}`);
    const aStop = log.find((l) => l.startsWith("A stop:"));
    expect(aStop).toBe(`A stop:${aName}`);
  });
});
