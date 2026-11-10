import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BROWSER_METHOD_JOB_MIN_PROTOCOL, CURRENT_PROTOCOL_VERSION, DEPLOY_VERIFIER_ROLE, SignedJobSchema, deployVerifierToolsFor, verifyJob, canonicalJson, sha256Text } from "@fulcrumaxe/runner-protocol";
import type { ExecutionRun } from "../src/executionTarget.js";
import { JobIssueError, createJobIssuer, createJobSigner, createPgJobContext, roleToolsDigest } from "../src/targets/jobIssuer.js";
import { insertAgentRun } from "../src/runStatusWriter.js";
import { seedAccount, seedMember, seedRepo } from "./helpers/seed.js";
import { createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * [pg] D#749 V2c-1: the issuer signs the deploy verifier's `browser_method` into the job and the tool digest of that method's list. Only the starting code can choose the method (it is a field of the
 * run the cloud itself builds), a deploy verifier without one is no job, and no other role may carry one.
 */
describe("the job issuer and the deploy verifier's browser method [pg]", () => {
  const db = pgHarness();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signer = createJobSigner({ keyId: "job-key-1", privateKey });
  const NOW = new Date("2026-11-09T12:00:00.000Z");
  const SHA = "c".repeat(40);

  const issuer = () =>
    createJobIssuer({ pool: db.runWriterPool, signer, visibility: createFakeVisibility("private"), context: createPgJobContext(db.runWriterPool), now: () => NOW, newId: () => "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11" });

  async function world() {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId, { executionMode: "runner_local" });
    await db.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [repoId]);
    return { accountId, userId, repoId };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function run(w: World, role: string, over: Partial<ExecutionRun> = {}): Promise<ExecutionRun> {
    const id = randomUUID();
    await insertAgentRun(db.runWriterPool, { id, accountId: w.accountId, role, runtime: "runner", executionMode: "runner_local", dispatchRepoId: w.repoId, initiatedBy: w.userId, headSha: SHA });
    return { id, accountId: w.accountId, role, product: "team", repoId: w.repoId, headSha: SHA, roleCard: "You check the deploy.\n", prompt: `Check the journeys of ${SHA}.\n`, model: "windowless-model", capUsd: 0, spend: { plan: "starter", estimateComputeUsd: 0, trigger: "foreground" }, ...over } as ExecutionRun;
  }
  const stored = async (id: string) => (await db.admin.query<{ job_signed: unknown }>("SELECT job_signed FROM agent_runs WHERE id = $1", [id])).rows[0]!.job_signed;
  const codeOf = async (promise: Promise<unknown>) => promise.then(() => "returned", (e) => (e instanceof JobIssueError ? e.code : `other:${String(e)}`));
  const digestOf = (tools: readonly string[]): string => sha256Text(canonicalJson([...tools].sort()));

  it.each(["chrome_runner", "playwright_runner"] as const)("signs %s into the job and the digest of that method's tool list, and the signed job parses on the claim's schema", async (method) => {
    const w = await world();
    const r = await run(w, DEPLOY_VERIFIER_ROLE, { browserMethod: method });
    await issuer().issue({ run: r });
    const job = verifyJob(await stored(r.id), { "job-key-1": publicKey }, { now: NOW });
    expect(job.browser_method).toBe(method);
    expect(job.role_tools_sha256).toBe(digestOf(deployVerifierToolsFor(method)));
    expect(job.role_tools_sha256).toBe(roleToolsDigest(DEPLOY_VERIFIER_ROLE, method));
    expect(SignedJobSchema.safeParse(await stored(r.id)).success).toBe(true);
  });

  it("the two methods sign two different tool digests for the same run shape", async () => {
    const w = await world();
    const a = await run(w, DEPLOY_VERIFIER_ROLE, { browserMethod: "chrome_runner" });
    const b = await run(w, DEPLOY_VERIFIER_ROLE, { browserMethod: "playwright_runner" });
    await issuer().issue({ run: a });
    await issuer().issue({ run: b });
    const ja = verifyJob(await stored(a.id), { "job-key-1": publicKey }, { now: NOW });
    const jb = verifyJob(await stored(b.id), { "job-key-1": publicKey }, { now: NOW });
    expect(ja.role_tools_sha256).not.toBe(jb.role_tools_sha256);
  });

  it("refuses, and records no job, for a deploy verifier with no method or an unknown one, and for any other role that carries one", async () => {
    const w = await world();
    const none = await run(w, DEPLOY_VERIFIER_ROLE);
    expect(await codeOf(issuer().issue({ run: none }))).toBe("job_invalid");
    expect((await stored(none.id)) ?? null).toBeNull();
    const stray = await run(w, "code-reviewer", { browserMethod: "playwright_runner", headSha: SHA });
    expect(await codeOf(issuer().issue({ run: stray }))).toBe("job_invalid");
    expect((await stored(stray.id)) ?? null).toBeNull();
    const odd = await run(w, DEPLOY_VERIFIER_ROLE, { browserMethod: "playwright_sandbox" as never });
    expect(await codeOf(issuer().issue({ run: odd }))).toBe("job_invalid");
    expect((await stored(odd.id)) ?? null).toBeNull();
  });

  // D#749 V3c: a job that carries `browser_method` is never offered to a runner whose strict parse predates the key (it would fail that runner's whole claim).
  it.each(["chrome_runner", "playwright_runner"] as const)("records the protocol floor of a %s job with the job, so the claim never offers it to an older runner; any other role's job has none", async (method) => {
    expect(BROWSER_METHOD_JOB_MIN_PROTOCOL).toBe(16);
    expect(CURRENT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(BROWSER_METHOD_JOB_MIN_PROTOCOL);
    const w = await world();
    const r = await run(w, DEPLOY_VERIFIER_ROLE, { browserMethod: method });
    await issuer().issue({ run: r });
    const floor = async (id: string) => (await db.admin.query<{ min_protocol_version: number | null }>("SELECT min_protocol_version FROM agent_runs WHERE id = $1", [id])).rows[0]!.min_protocol_version;
    expect(await floor(r.id)).toBe(BROWSER_METHOD_JOB_MIN_PROTOCOL);
    const other = await run(w, "code-reviewer", { headSha: SHA });
    await issuer().issue({ run: other });
    expect(await floor(other.id)).toBeNull();
  });

  it("leaves every other role's job without the key, so its signed bytes are what they were", async () => {
    const w = await world();
    const r = await run(w, "code-reviewer", { headSha: SHA });
    await issuer().issue({ run: r });
    expect(JSON.stringify(await stored(r.id))).not.toContain("browser_method");
  });
});
