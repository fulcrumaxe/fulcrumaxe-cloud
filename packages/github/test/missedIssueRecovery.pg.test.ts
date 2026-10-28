import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { missedOpenedCandidate, type GithubWebhookDbDeps, type GithubWebhookEventName, type GithubWebhookPayload } from "../src/eventMapper.js";
import { handleGithubWebhookEventForApp } from "../src/webhookGate.js";

/**
 * A lost `issues.opened` delivery is not retried by GitHub. A later edited, labeled, reopened or assigned event, or a new comment, for the same OPEN issue
 * must bring it in through the opened path's own rules, exactly once. Real Postgres; the author's permission is the only stubbed input (it is what the
 * opened path asks GitHub for), and the stub counts its calls so "no GitHub call for an issue we know" is checked.
 */
describe("a later event brings in an open issue whose opened delivery was lost [pg]", () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });

  async function tenant(): Promise<SeedRefs & { ghInstallationId: number; ghRepoId: number }> {
    const r = await seedAccount(admin, randomUUID());
    await admin.query(`UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1`, [r.repoId]);
    const ghInstallationId = Number((await admin.query(`SELECT gh_installation_id FROM installations WHERE id = $1`, [r.installationId])).rows[0].gh_installation_id);
    const ghRepoId = Number((await admin.query(`SELECT gh_repo_id FROM repos WHERE id = $1`, [r.repoId])).rows[0].gh_repo_id);
    return { ...r, ghInstallationId, ghRepoId };
  }

  function deps(roles: Record<string, "admin" | "read">) {
    const lookups: number[] = [];
    const d: GithubWebhookDbDeps = {
      appUserPool,
      platformOpsPool,
      issueAuthorPermission: async (input) => {
        lookups.push(input.number);
        // The author is whoever the test's issue says; the test names it by issue number's login map below.
        const login = loginOf.get(input.number) ?? "nobody";
        return { login, permission: roles[login] ?? "none" };
      },
      repoHasEngineLoop: async () => false,
      warn: () => {},
    };
    return { d, lookups };
  }
  const loginOf = new Map<number, string>();

  type Over = { state?: string; pull?: boolean; login?: string; createdAt?: string | null };
  function body(r: { ghInstallationId: number; ghRepoId: number }, event: GithubWebhookEventName, action: string, n: number, over: Over = {}): GithubWebhookPayload {
    const login = over.login ?? "boss";
    loginOf.set(n, login);
    const issue = {
      number: n,
      title: `Issue ${n}`,
      body: `Body ${n}`,
      state: over.state ?? "open",
      ...(over.createdAt === null ? {} : { created_at: over.createdAt ?? new Date(Date.now() + 60_000).toISOString() }),
      user: { login },
      author_association: "NONE",
      ...(over.pull ? { pull_request: { url: "https://api.github.com/x" } } : {}),
    };
    return {
      action,
      issue,
      ...(event === "issue_comment" ? { comment: { user: { login: "someone" }, author_association: "NONE" } } : {}),
      installation: { id: r.ghInstallationId },
      repository: { id: r.ghRepoId, full_name: "acme/widgets", default_branch: "main" },
    } as unknown as GithubWebhookPayload;
  }

  const send = (d: GithubWebhookDbDeps, event: GithubWebhookEventName, payload: GithubWebhookPayload) => handleGithubWebhookEventForApp(d, event, payload, randomUUID(), "team");
  const items = async (r: SeedRefs, n: number) => (await admin.query(`SELECT kind, provenance FROM work_items WHERE account_id = $1 AND gh_number = $2`, [r.accountId, n])).rows;
  const proposals = async (r: SeedRefs, n: number) => (await admin.query(`SELECT state, provenance FROM proposals WHERE account_id = $1 AND gh_number = $2`, [r.accountId, n])).rows;

  it("each of edited, labeled, reopened and assigned, and a created comment, creates the work item of a trusted author", async () => {
    const r = await tenant();
    const { d } = deps({ boss: "admin" });
    const cases: Array<[GithubWebhookEventName, string]> = [["issues", "edited"], ["issues", "labeled"], ["issues", "reopened"], ["issues", "assigned"], ["issue_comment", "created"]];
    let n = 10;
    for (const [event, action] of cases) {
      n += 1;
      const out = await send(d, event, body(r, event, action, n));
      expect(out, `${event}.${action}`).toMatchObject({ handled: true, result: { applied: "created" } });
      expect(await items(r, n)).toEqual([{ kind: "issue", provenance: "internal" }]);
    }
  });

  it("opened then edited, and edited then edited, leave exactly one work item; a known issue costs no permission lookup", async () => {
    const r = await tenant();
    const { d, lookups } = deps({ boss: "admin" });

    expect(await send(d, "issues", body(r, "issues", "opened", 20))).toMatchObject({ result: { applied: "created" } });
    const second = await send(d, "issues", body(r, "issues", "edited", 20));
    expect(second).toMatchObject({ handled: true, result: { applied: "proposal_changed", count: 0 } });
    expect(await items(r, 20)).toHaveLength(1);
    expect(lookups).toEqual([20]);

    expect(await send(d, "issues", body(r, "issues", "edited", 21))).toMatchObject({ result: { applied: "created" } });
    expect(await send(d, "issues", body(r, "issues", "edited", 21))).toMatchObject({ result: { applied: "proposal_changed" } });
    expect(await send(d, "issue_comment", body(r, "issue_comment", "created", 21))).toMatchObject({ result: { applied: "skipped" } });
    expect(await items(r, 21)).toHaveLength(1);
    expect(lookups).toEqual([20, 21]);

    // Two deliveries in flight at once still make one.
    const both = await Promise.all([send(d, "issues", body(r, "issues", "edited", 22)), send(d, "issues", body(r, "issues", "labeled", 22))]);
    expect(both).toHaveLength(2);
    expect(await items(r, 22)).toHaveLength(1);
  });

  it("an outside author's issue becomes one proposal (never a work item), and a later edit updates it instead of adding another", async () => {
    const r = await tenant();
    const { d } = deps({ boss: "admin" });
    expect(await send(d, "issues", body(r, "issues", "labeled", 30, { login: "stranger" }))).toMatchObject({ result: { applied: "proposed", created: true } });
    expect(await send(d, "issues", body(r, "issues", "edited", 30, { login: "stranger" }))).toMatchObject({ result: { applied: "proposal_changed", count: 1 } });
    expect(await send(d, "issue_comment", body(r, "issue_comment", "created", 30, { login: "stranger" }))).toMatchObject({ result: { applied: "skipped" } });
    expect(await proposals(r, 30)).toEqual([{ state: "new", provenance: "external" }]);
    expect(await items(r, 30)).toEqual([]);
  });

  it("a closed issue, a pull request's comment and a comment that is not 'created' create nothing", async () => {
    const r = await tenant();
    const { d, lookups } = deps({ boss: "admin" });
    expect(await send(d, "issues", body(r, "issues", "edited", 40, { state: "closed" }))).toMatchObject({ result: { applied: "proposal_changed", count: 0 } });
    expect(await send(d, "issue_comment", body(r, "issue_comment", "created", 41, { pull: true }))).toMatchObject({ result: { applied: "skipped" } });
    expect(await send(d, "issue_comment", body(r, "issue_comment", "edited", 42))).toMatchObject({ result: { applied: "skipped" } });
    expect(await send(d, "issue_comment", body(r, "issue_comment", "deleted", 42))).toMatchObject({ result: { applied: "skipped" } });
    for (const n of [40, 41, 42]) {
      expect(await items(r, n)).toEqual([]);
      expect(await proposals(r, n)).toEqual([]);
    }
    expect(lookups).toEqual([]);
  });

  it("an issue created before the repository's own row is never recovered, whoever comments; the same issue created after it is", async () => {
    const r = await tenant();
    const { d, lookups } = deps({ boss: "admin" });
    const old = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    // A maintainer's old open issue (no item, no proposal: install discovery reads only the 50 most recently updated) and an outsider's comment on it.
    expect(await send(d, "issue_comment", body(r, "issue_comment", "created", 60, { createdAt: old }))).toMatchObject({ result: { applied: "skipped" } });
    expect(await send(d, "issues", body(r, "issues", "edited", 60, { createdAt: old }))).toMatchObject({ result: { applied: "proposal_changed", count: 0 } });
    // A missing or unreadable date is no intake either.
    await send(d, "issue_comment", body(r, "issue_comment", "created", 61, { createdAt: null }));
    await send(d, "issue_comment", body(r, "issue_comment", "created", 62, { createdAt: "yesterday-ish" }));
    for (const n of [60, 61, 62]) {
      expect(await items(r, n)).toEqual([]);
      expect(await proposals(r, n)).toEqual([]);
    }
    expect(lookups).toEqual([]);
    // Created after the repository row: recovered.
    expect(await send(d, "issue_comment", body(r, "issue_comment", "created", 63))).toMatchObject({ result: { applied: "created" } });
    expect(await items(r, 63)).toHaveLength(1);
  });

  it("a repository detached from its installation takes nothing in", async () => {
    const r = await tenant();
    await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [r.repoId]);
    const { d, lookups } = deps({ boss: "admin" });
    await send(d, "issues", body(r, "issues", "edited", 50));
    expect(await items(r, 50)).toEqual([]);
    expect(lookups).toEqual([]);
  });

  it("the candidate rule on its own: only the five event shapes of an open, non-pull-request issue qualify", () => {
    const base = { issue: { number: 1, state: "open", created_at: "2026-01-01T00:00:00Z", user: { login: "a" }, author_association: "NONE" }, comment: { user: { login: "b" }, author_association: "NONE" } };
    const pick = (event: GithubWebhookEventName, action: string, issue: Record<string, unknown> = {}) =>
      missedOpenedCandidate(event, { ...base, action, issue: { ...base.issue, ...issue } } as unknown as GithubWebhookPayload);
    for (const a of ["edited", "labeled", "reopened", "assigned"]) expect(pick("issues", a)?.action).toBe("opened");
    expect(pick("issue_comment", "created")?.issue.number).toBe(1);
    for (const a of ["opened", "closed", "unlabeled", "deleted", "transferred"]) expect(pick("issues", a)).toBeNull();
    expect(pick("issue_comment", "edited")).toBeNull();
    expect(pick("issues", "edited", { state: "closed" })).toBeNull();
    expect(pick("issues", "edited", { pull_request: {} })).toBeNull();
    expect(pick("issues", "edited", { number: 0 })).toBeNull();
    expect(pick("issues", "edited", { created_at: undefined })).toBeNull();
    expect(pick("issues", "edited", { created_at: "not a date" })).toBeNull();
    expect(pick("pull_request", "edited")).toBeNull();
  });
});
