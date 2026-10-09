import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SpecVersionMismatchError,
  insertAgentRun,
  startAgentRun,
  writeRunStatus,
  type ExecutionTargetRegistry,
  type StartAgentRunInput,
} from "@fx/runner";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { continueAfterLimit } from "../../src/build/continuation.js";
import { recordReviewVerdict } from "../../src/build/fixLoop.js";
import { resumeAgentRun } from "../../src/build/resumeAgentRun.js";
import { createFakeExecutionTarget } from "./helpers/fakeExecutionTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#6 R4d-5c (C36) [pg]: a follow-on run (an inline fix round, a continuation of an executor or of another role, a start with a parent) is written with the
 * Spec version of the run it follows, read inside the create under the tenant, and never the work item's latest version. Every world has TWO versions: N
 * (acceptance_files src/a.ts), which the parent was built against, and N+1 (src/z.ts), published after the build, so inheriting and taking the latest give
 * different answers in every test. Real Postgres, RLS and the `agent_run_create` definer (with 0642's freeze trigger); no test writes a child row by hand.
 */
describe("D#6 R4d-5c follow-on runs inherit the parent's Spec version [pg]", () => {
  const db = pgHarness();

  async function world(mode: "sandbox" | "runner_local") {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    if (mode === "runner_local") await db.admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [repoId]);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 7 });
    const versionN = randomUUID();
    const versionN1 = randomUUID();
    for (const [id, version, file] of [[versionN, 1, "src/a.ts"], [versionN1, 2, "src/z.ts"]] as const) {
      await db.admin.query(
        `INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, frontmatter, created_by_kind)
         VALUES ($1, $2, $3, $4, $5, encode(sha256(convert_to($5, 'UTF8')), 'hex'), $6::jsonb, 'system')`,
        [id, accountId, workItemId, version, `spec body ${version}`, JSON.stringify({ acceptance_files: [file] })],
      );
    }
    await withTenant(db.runWriterPool, accountId, async (c) => {
      for (const toStage of ["spec_ready", "in_progress"] as const) await recordStage(c, { workItemId, toStage, at: new Date(), source: "control_plane", sourceRef: `seed-${toStage}` });
    });
    // A sandbox target for a sandbox repo; a queued (runner) target for a runner_local one, which must never be reached by a refused start.
    const fake = createFakeExecutionTarget({ queued: mode === "runner_local" });
    const registry: ExecutionTargetRegistry = mode === "runner_local" ? { runner_local: fake.target } : { sandbox: fake.target };
    const input: Omit<StartAgentRunInput, "accountId" | "workItemId" | "role"> = {
      repoId, pr: 7, product: "team", roleCard: "card", prompt: "p", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
    return { accountId, repoId, workItemId, versionN, versionN1, fake, registry, input, mode };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const pinOf = async (runId: string) => (await db.admin.query<{ spec_version_id: string | null }>("SELECT spec_version_id FROM agent_runs WHERE id = $1", [runId])).rows[0]!.spec_version_id;
  const runCount = async (w: World) => Number((await db.admin.query("SELECT count(*) FROM agent_runs WHERE work_item_id = $1", [w.workItemId])).rows[0].count);
  const jobCount = async (w: World) => Number((await db.admin.query("SELECT count(*) FROM agent_runs WHERE work_item_id = $1 AND job_signed IS NOT NULL", [w.workItemId])).rows[0].count);
  const stageOf = async (w: World) => (await db.admin.query("SELECT stage FROM work_items WHERE id = $1", [w.workItemId])).rows[0].stage as string;

  /**
   * A finished run of `role` with a session and a checkpoint. `pin` true writes version N on it through the start (the new-build path of R4d-5a); false leaves it
   * null, the way a run built before the pin is. A null parent on a runner_local repo is inserted directly: a start of that shape is the very thing under test.
   */
  async function parent(w: World, o: { role?: "executor" | "docs-writer" | "code-reviewer"; pin: boolean; finish?: "timed_out" | "succeeded" }): Promise<string> {
    const role = o.role ?? "executor";
    let id: string;
    if (w.mode === "runner_local") {
      ({ id } = await insertAgentRun(db.runWriterPool, {
        id: randomUUID(), accountId: w.accountId, workItemId: w.workItemId, role, runtime: "runner", executionMode: "runner_local", dispatchRepoId: w.repoId,
        dispatchPrNumber: 7, ...(o.pin ? { specVersionId: w.versionN } : {}),
      }));
    } else {
      const started = await startAgentRun(db.runWriterPool, w.registry, { ...w.input, accountId: w.accountId, workItemId: w.workItemId, role, ...(o.pin ? { specVersionId: w.versionN } : {}) });
      if (started.status !== "running") throw new Error("test setup: dispatch failed");
      id = started.id;
    }
    if (w.mode === "runner_local") await writeRunStatus(db.runWriterPool, { accountId: w.accountId, runId: id, from: "pending", to: "running", result: { sessionId: "cc-owned" } });
    const finish = o.finish ?? "timed_out";
    await writeRunStatus(db.runWriterPool, {
      accountId: w.accountId, runId: id, from: "running", to: finish, result: { sessionId: "cc-owned" },
      ...(finish === "timed_out" ? { checkpoint: { kind: "run_time", ccSessionId: "cc-forged", meteredUsd: 1, extensionsUsed: 0 } } : {}),
    });
    expect(await pinOf(id)).toBe(o.pin ? w.versionN : null);
    return id;
  }

  const prOpened = (w: World) =>
    withTenant(db.runWriterPool, w.accountId, (c) => recordStage(c, { workItemId: w.workItemId, toStage: "pr_opened", at: new Date(), source: "control_plane", sourceRef: "seed-pr" }));

  /** A finished reviewer run on a head, whose needs-fix verdict triggers the inline fix round. */
  async function reviewer(w: World): Promise<string> {
    const id = randomUUID();
    await db.admin.query(
      "INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, 'code-reviewer', 'production', 'succeeded', 'sha-1')",
      [id, w.accountId, w.workItemId],
    );
    return id;
  }
  const verdict = async (w: World, reviewerRun: string) =>
    recordReviewVerdict(db.runWriterPool, w.registry, { accountId: w.accountId, workItemId: w.workItemId, role: "code-reviewer", runId: reviewerRun, verdict: "needs-fix", resumeInput: w.input });
  const resumeId = (out: Awaited<ReturnType<typeof recordReviewVerdict>>): string => {
    if (out.outcome !== "fix_dispatched") throw new Error(`expected fix_dispatched, got ${out.outcome}`);
    return out.resume.id;
  };

  describe("G3 the fix loop's inline fix round", () => {
    it("inserts a run pinned to the build's version N, not the latest N+1", async () => {
      const w = await world("sandbox");
      const build = await parent(w, { pin: true, finish: "succeeded" });
      await prOpened(w);
      const out = await verdict(w, await reviewer(w));
      const fix = resumeId(out);
      expect(fix).not.toBe(build);
      expect(await pinOf(fix)).toBe(w.versionN);
      expect(await pinOf(fix)).not.toBe(w.versionN1);
    });
  });

  describe("resumeAgentRun", () => {
    it("inherits from the run whose session it continues, not from parentRunId: a newer unpinned executor with no session is the named parent, and the round is neither refused nor unpinned", async () => {
      const w = await world("runner_local");
      const session = await parent(w, { pin: true, finish: "succeeded" });
      // A later executor run of the item that never got a session (it failed first) and was built before the pin: what the advance step names as the parent.
      const { id: later } = await insertAgentRun(db.runWriterPool, {
        id: randomUUID(), accountId: w.accountId, workItemId: w.workItemId, role: "executor", runtime: "runner", executionMode: "runner_local", dispatchRepoId: w.repoId,
        parentRunId: session,
      });
      await writeRunStatus(db.runWriterPool, { accountId: w.accountId, runId: later, from: "pending", to: "failed", failureReason: "internal_error" });
      expect(await pinOf(later)).toBe(w.versionN); // it inherited from its own parent; the next line makes it the unpinned one the test needs
      await db.admin.query("SET session_replication_role = replica");
      try {
        await db.admin.query("UPDATE agent_runs SET spec_version_id = NULL WHERE id = $1", [later]);
      } finally {
        await db.admin.query("SET session_replication_role = DEFAULT");
      }
      expect(await pinOf(later)).toBeNull();
      const out = await resumeAgentRun(db.runWriterPool, w.registry, { ...w.input, accountId: w.accountId, workItemId: w.workItemId, role: "executor", parentRunId: later });
      expect(out).toMatchObject({ status: "pending", queued: true });
      expect(await pinOf(out.id)).toBe(w.versionN);
      expect((await db.admin.query("SELECT parent_run_id FROM agent_runs WHERE id = $1", [out.id])).rows[0].parent_run_id).toBe(later);
      expect(w.fake.calls.at(-1)).toMatchObject({ method: "resume", sessionId: "cc-owned" });
    });

    it("an explicit version that is not the session run's is refused spec_version_mismatch, and no row is written", async () => {
      const w = await world("sandbox");
      await parent(w, { pin: true, finish: "succeeded" });
      const before = await runCount(w);
      await expect(
        resumeAgentRun(db.runWriterPool, w.registry, { ...w.input, accountId: w.accountId, workItemId: w.workItemId, role: "executor", specVersionId: w.versionN1 }),
      ).rejects.toBeInstanceOf(SpecVersionMismatchError);
      expect(await runCount(w)).toBe(before);
    });
  });

  describe("G4 continuation after a limit", () => {
    it("(a) an executor run pinned to N is continued through resumeAgentRun, pinned to N", async () => {
      const w = await world("sandbox");
      const prev = await parent(w, { pin: true });
      const r = await continueAfterLimit(db.runWriterPool, w.registry, { accountId: w.accountId, runId: prev, resumeInput: w.input });
      expect(r).toMatchObject({ outcome: "continued" });
      const id = (r as { resume: { id: string } }).resume.id;
      expect(w.fake.calls.at(-1)).toMatchObject({ method: "resume" });
      expect(await pinOf(id)).toBe(w.versionN);
    });

    it("(b) a docs-writer run pinned to N is continued through startAgentRun with its parent, pinned to N", async () => {
      const w = await world("sandbox");
      const prev = await parent(w, { role: "docs-writer", pin: true });
      const r = await continueAfterLimit(db.runWriterPool, w.registry, { accountId: w.accountId, runId: prev, resumeInput: w.input });
      expect(r).toMatchObject({ outcome: "continued" });
      expect(w.fake.calls.at(-1)).toMatchObject({ method: "dispatch" });
      expect(await pinOf((r as { resume: { id: string } }).resume.id)).toBe(w.versionN);
    });
  });

  describe("startAgentRun with a parent", () => {
    it("takes the parent's version when none is named, and accepts the same one named", async () => {
      const w = await world("sandbox");
      const prev = await parent(w, { pin: true, finish: "succeeded" });
      const implicit = await startAgentRun(db.runWriterPool, w.registry, { ...w.input, accountId: w.accountId, workItemId: w.workItemId, role: "code-reviewer", parentRunId: prev, headSha: "h1" });
      expect(await pinOf(implicit.id)).toBe(w.versionN);
      await writeRunStatus(db.runWriterPool, { accountId: w.accountId, runId: implicit.id, from: "running", to: "succeeded" });
      const named = await startAgentRun(db.runWriterPool, w.registry, { ...w.input, accountId: w.accountId, workItemId: w.workItemId, role: "code-reviewer", parentRunId: prev, specVersionId: w.versionN, headSha: "h2" });
      expect(await pinOf(named.id)).toBe(w.versionN);
    });

    it("G9: an explicit version that is not the parent's is refused spec_version_mismatch, and no row is written", async () => {
      const w = await world("sandbox");
      const prev = await parent(w, { pin: true, finish: "succeeded" });
      const before = await runCount(w);
      const err = await startAgentRun(db.runWriterPool, w.registry, { ...w.input, accountId: w.accountId, workItemId: w.workItemId, role: "executor", parentRunId: prev, specVersionId: w.versionN1 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpecVersionMismatchError);
      expect((err as SpecVersionMismatchError).code).toBe("spec_version_mismatch");
      expect(await runCount(w)).toBe(before);
      expect(w.fake.calls.filter((c) => c.method === "admit")).toHaveLength(1); // the parent's own admit only
    });
  });

  describe("G8 refusal when the parent has no Spec version", () => {
    it("the fix loop returns refused/no_spec_version: no run row, no job, the stage write that precedes the start stands", async () => {
      const w = await world("runner_local");
      await parent(w, { pin: false, finish: "succeeded" });
      await prOpened(w);
      const rev = await reviewer(w);
      const before = await runCount(w);
      const out = await verdict(w, rev);
      expect(out).toMatchObject({ outcome: "refused", reason: "no_spec_version" });
      expect(await runCount(w)).toBe(before);
      expect(await jobCount(w)).toBe(0);
      expect(await stageOf(w)).toBe("changes_requested"); // written by recordStage before the start, as it always was
      expect(w.fake.calls).toEqual([]);
    });

    it("continuation of an executor returns refused/no_spec_version: no run row, no job, the stage is unchanged", async () => {
      const w = await world("runner_local");
      const prev = await parent(w, { pin: false });
      const before = await runCount(w);
      expect(await continueAfterLimit(db.runWriterPool, w.registry, { accountId: w.accountId, runId: prev, resumeInput: w.input })).toEqual({ outcome: "refused", reason: "no_spec_version" });
      expect(await runCount(w)).toBe(before);
      expect(await jobCount(w)).toBe(0);
      expect(await stageOf(w)).toBe("in_progress");
      expect(w.fake.calls).toEqual([]);
    });

    it("continuation of a docs-writer returns refused/no_spec_version in the same way", async () => {
      const w = await world("runner_local");
      const prev = await parent(w, { role: "docs-writer", pin: false });
      const before = await runCount(w);
      expect(await continueAfterLimit(db.runWriterPool, w.registry, { accountId: w.accountId, runId: prev, resumeInput: w.input })).toEqual({ outcome: "refused", reason: "no_spec_version" });
      expect(await runCount(w)).toBe(before);
      expect(await jobCount(w)).toBe(0);
      expect(await stageOf(w)).toBe("in_progress");
    });

    it("control: on a sandbox repo the same fix round and both continuations start, with a null version", async () => {
      const w = await world("sandbox");
      await parent(w, { pin: false, finish: "succeeded" });
      await prOpened(w);
      expect(await pinOf(resumeId(await verdict(w, await reviewer(w))))).toBeNull();

      const w2 = await world("sandbox");
      const prev = await parent(w2, { pin: false });
      const r = await continueAfterLimit(db.runWriterPool, w2.registry, { accountId: w2.accountId, runId: prev, resumeInput: w2.input });
      expect(r).toMatchObject({ outcome: "continued" });
      expect(await pinOf((r as { resume: { id: string } }).resume.id)).toBeNull();

      const w3 = await world("sandbox");
      const docs = await parent(w3, { role: "docs-writer", pin: false });
      const d = await continueAfterLimit(db.runWriterPool, w3.registry, { accountId: w3.accountId, runId: docs, resumeInput: w3.input });
      expect(d).toMatchObject({ outcome: "continued" });
      expect(await pinOf((d as { resume: { id: string } }).resume.id)).toBeNull();
    });

    it("control: a null-version REVIEWER parent on a runner_local repo is not refused, and the child starts with a null version", async () => {
      const w = await world("runner_local");
      const rev = await parent(w, { role: "code-reviewer", pin: false, finish: "succeeded" });
      const child = await startAgentRun(db.runWriterPool, w.registry, { ...w.input, accountId: w.accountId, workItemId: w.workItemId, role: "code-reviewer", parentRunId: rev, headSha: "h3" });
      expect(child).toMatchObject({ status: "pending", queued: true });
      expect(await pinOf(child.id)).toBeNull();
    });
  });
});
