import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { SandboxPort } from "../src/sandboxPort.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";

/** D#221 R1b: the run's backend is resolved once, at admit, and the port is handed that name. [pg] */
describe("D#221 R1b: the run backend [pg]", () => {
  const db = pgHarness();

  async function input(over: Partial<StartAgentRunInput> = {}): Promise<StartAgentRunInput> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return {
      accountId, repoId, role: "code-reviewer", product: "team", roleCard: "card", prompt: "prompt", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground", estimateModelUsd: 0.001, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 4.5 },
      ...over,
    };
  }

  /** A target over the fake sandbox that records every backend name the port was handed. */
  function build() {
    const base = createSandboxTargetHarness(db.runWriterPool);
    const seen: (string | undefined)[] = [];
    const created: string[] = [];
    const port = base.deps.sandboxPort;
    const sandboxPort: SandboxPort = {
      ...port,
      createSandbox: async (o) => (created.push(o.sandboxName), port.createSandbox(o)),
      startDetached: (h, o) => (seen.push(o.backend), port.startDetached(h, o)),
      resume: (h, s, p, o) => (seen.push(o.backend), port.resume(h, s, p, o)),
    };
    return { target: new SandboxTarget({ ...base.deps, sandboxPort }), seen, created };
  }

  it("a backend the registry does not select is refused at admit: refused_spend, no reservation, no sandbox", async () => {
    const { target, created } = build();
    const i = await input({ backend: "codex" });
    const r = await startAgentRun(db.runWriterPool, { sandbox: target }, i);
    expect(r).toMatchObject({ status: "refused_spend", reason: "backend_not_selectable" });
    const { rows } = await db.admin.query(`SELECT 1 FROM spend_reservations WHERE account_id = $1 AND run_id = $2`, [i.accountId, r.id]);
    expect(rows).toHaveLength(0);
    expect(created).toEqual([]);
  });

  it("a name that is not even a safe name is refused the same way", async () => {
    const { target } = build();
    for (const backend of ["", "Claude-Code", "claude-code; rm -rf /", "__proto__"]) {
      const r = await startAgentRun(db.runWriterPool, { sandbox: target }, await input({ backend }));
      expect(r, backend).toMatchObject({ status: "refused_spend", reason: "backend_not_selectable" });
    }
  });

  it("dispatch and resume skip admit, so they refuse an unselectable backend themselves, before any sandbox", async () => {
    const { target, created } = build();
    const i = await input({ backend: "codex" });
    const run = { id: randomUUID(), accountId: i.accountId, role: i.role, product: i.product, repoId: i.repoId, roleCard: i.roleCard, prompt: i.prompt, model: i.model, capUsd: i.capUsd, spend: i.spend, backend: "codex" };
    await expect(target.dispatch(run)).rejects.toThrow(/backend is not selectable/);
    await expect(target.resume(run, "sess-1")).rejects.toThrow(/backend is not selectable/);
    expect(created).toEqual([]);
  });

  it("the default backend is admitted and the port is told its name; a run with no name gets the default", async () => {
    const { target, seen } = build();
    for (const backend of ["claude-code", undefined]) {
      const i = await input(backend === undefined ? {} : { backend });
      const r = await startAgentRun(db.runWriterPool, { sandbox: target }, i);
      expect(r.status, String(backend)).toBe("running");
    }
    expect(seen).toEqual(["claude-code", undefined]);
    // The port resolves `undefined` to the default itself; the run row says so too.
    const { rows } = await db.admin.query(`SELECT DISTINCT backend FROM agent_runs WHERE role = 'code-reviewer' AND created_at > now() - interval '1 minute'`);
    expect(rows).toEqual([{ backend: "claude-code" }]);
  });
});
