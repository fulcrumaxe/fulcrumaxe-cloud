import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { runMergeGateForItem, type LocalReviewOptInPort } from "../../src/review/mergeGateRun.js";
import { discussingItem } from "../plan/helpers/panelFixtures.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { fakeGitHubLocal } from "./helpers/fakeGitHubLocal.js";
import { fakeGitHubRest, freshRepo, type FakeRepoState } from "./helpers/fakeGitHubRest.js";

/**
 * D#6 M1G-a [pg]: the operator's human-merge-only lock on the merge gate. Over the same fake GitHub as the R3b tests. Every
 * "no merge" below is read from the fake GitHub's merge log (`gh.merges`), a counting port, not from the gate's own answer.
 * The control tests (an unlisted repo still merges, in every mode) are what make the locked cases mean something.
 */
const h = pgHarness();
const HEAD = "a".repeat(40);
const BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
const greenCheck = { name: "ci", status: "completed", conclusion: "success" };
const ENV = "FX_HUMAN_MERGE_ONLY_REPO_IDS";
const saved = process.env[ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

type Mode = "cloud" | "runner_local_off" | "runner_local_on";
interface World {
  accountId: string;
  workItemId: string;
  repoId: string;
  ghRepoId: number;
  gh: FakeRepoState;
  local: boolean;
}

async function world(mode: Mode): Promise<World> {
  const accountId = randomUUID();
  const repoId = randomUUID();
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  // autoMerge is seeded directly (the guard PUT is refused for a listed repo, but a row written before the lock exists must be ignored).
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = $2, settings = '{\"autoMerge\":true}'::jsonb WHERE id = $1", [repoId, mode === "cloud" ? "sandbox" : "runner_local"]);
  const ghRepoId = Number((await h.admin.query("SELECT gh_repo_id FROM repos WHERE id = $1", [repoId])).rows[0].gh_repo_id);
  const { workItemId } = await discussingItem(h.runWriterPool, accountId, { title: "Add a footer", body: "Show the year in the footer.", category: "feature", repoId });
  await h.admin.query("UPDATE work_items SET gh_number = 7, repo_id = $2, stage = 'pr_opened', provenance = 'internal' WHERE id = $1", [workItemId, repoId]);
  const body = "1. The footer shows the year.";
  await h.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
  if (mode !== "cloud") {
    const admin = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [admin, `${admin}@fixture.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')", [accountId, admin]);
    const runnerId = randomUUID();
    const k = randomUUID().replace(/-/g, "").padEnd(43, "k");
    await h.admin.query(
      `INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription')`,
      [runnerId, accountId, admin, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: k }), k],
    );
    // What the runner's `done` recorded: the pull request and run branch the local-only gate checks the review against (R3c).
    const executor = randomUUID();
    await h.admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, runner_id) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded', 'runner_local', $4)`,
      [executor, accountId, workItemId, runnerId],
    );
    await h.admin.query(
      `INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`,
      [accountId, executor, JSON.stringify({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: freshRepo({ headSha: HEAD }).prNumber, branch: BRANCH })],
    );
    for (const role of ["code-reviewer", "acceptance-tester", "security-reviewer"]) {
      await h.admin.query(
        `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode, runner_id) VALUES ($1, $2, $3, 'runner', 'succeeded', '{"verdict":"pass"}'::jsonb, $4, 'runner_local', $5)`,
        [accountId, workItemId, role, HEAD, runnerId],
      );
    }
  } else {
    for (const role of ["code-reviewer", "acceptance-tester"]) {
      await h.admin.query(
        `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode) VALUES ($1, $2, $3, 'production', 'succeeded', '{"verdict":"pass"}'::jsonb, $4, 'sandbox')`,
        [accountId, workItemId, role, HEAD],
      );
    }
  }
  const gh = freshRepo({ headSha: HEAD, checks: { [HEAD]: [greenCheck] }, protectedWithoutChecks: true, runBranch: BRANCH });
  return { accountId, workItemId, repoId, ghRepoId, gh, local: mode !== "cloud" };
}

const optIn = (mode: Mode): LocalReviewOptInPort => ({ enabled: async () => mode === "runner_local_on" });
const gate = (w: World, mode: Mode) =>
  runMergeGateForItem({ pool: h.runWriterPool, http: w.local ? fakeGitHubLocal(w.gh).http : fakeGitHubRest(w.gh), localReviewOptIn: optIn(mode) }, { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.gh.prNumber });
const reasonsOf = (out: Awaited<ReturnType<typeof gate>>) => (out.outcome === "ready_human_merges" ? out.reasons : []);

const MODES: Mode[] = ["cloud", "runner_local_off", "runner_local_on"];

describe("control: an unlisted repo behaves as today", () => {
  for (const mode of ["cloud", "runner_local_on"] as const) {
    it(`${mode}: with the setting unset, the gate merges`, async () => {
      delete process.env[ENV];
      const w = await world(mode);
      expect((await gate(w, mode)).outcome).toBe("merged");
      expect(w.gh.merges).toEqual([{ sha: HEAD, method: "squash" }]);
    });
    it(`${mode}: with another repo listed, the gate still merges`, async () => {
      const w = await world(mode);
      process.env[ENV] = String(w.ghRepoId + 1);
      expect((await gate(w, mode)).outcome).toBe("merged");
      expect(w.gh.merges).toHaveLength(1);
    });
  }
  it("an empty setting locks nothing", async () => {
    process.env[ENV] = "";
    const w = await world("cloud");
    expect((await gate(w, "cloud")).outcome).toBe("merged");
  });
});

describe("a listed repo: a person merges, in every review mode", () => {
  for (const mode of MODES) {
    it(`${mode}: every reviewer passes, CI is green, autoMerge is on, and the gate still makes zero merge calls`, async () => {
      const w = await world(mode);
      process.env[ENV] = `1,${w.ghRepoId},3`;
      const out = await gate(w, mode);
      expect(out.outcome).toBe("ready_human_merges");
      expect(reasonsOf(out)).toContain("human_merge_only");
      expect(w.gh.merges).toEqual([]);
    });
  }

  it("runner_local_on: the only reason is human_merge_only (the rest of the gate is satisfied)", async () => {
    const w = await world("runner_local_on");
    process.env[ENV] = String(w.ghRepoId);
    expect(reasonsOf(await gate(w, "runner_local_on"))).toEqual(["human_merge_only"]);
  });

  it("the lock is read on each request: removing the id lifts it without a restart", async () => {
    const w = await world("cloud");
    process.env[ENV] = String(w.ghRepoId);
    expect((await gate(w, "cloud")).outcome).toBe("ready_human_merges");
    expect(w.gh.merges).toEqual([]);
    process.env[ENV] = "1";
    expect((await gate(w, "cloud")).outcome).toBe("merged");
  });
});

describe("a malformed value fails closed", () => {
  for (const bad of ["abc", "1,,2", " 1", "-1", "1,", "0", "1, 2"]) {
    for (const mode of MODES) {
      it(`${JSON.stringify(bad)} / ${mode}: every repo is human-merge-only, even one that is not named`, async () => {
        const w = await world(mode);
        process.env[ENV] = bad;
        const out = await gate(w, mode);
        expect(out.outcome).toBe("ready_human_merges");
        expect(reasonsOf(out)).toContain("human_merge_only");
        expect(w.gh.merges).toEqual([]);
      });
    }
  }
});
