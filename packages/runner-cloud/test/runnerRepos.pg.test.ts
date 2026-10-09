import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { listRunners } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

type Row = { id: string; repos: Array<{ id: string; name: string }> };

/**
 * [pg] D#6 R2b-4a follow-up: `GET /api/runners` names each runner's repos for the consent dialog. The runners table already lets the app role read
 * `allowed_repo_ids` (row security by account), so no grant or definer is involved: the only thing to get right is that a repo id is turned into a
 * name through the caller's own tenant, so an id from another account is never named.
 */
describe("GET /api/runners names each runner's repos [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const deps = () => h.deps({ now: () => new Date() });
  const installations = new Map<string, string>();
  async function newRepo(f: F2Fixture, owner: string | null, name: string | null): Promise<string> {
    let installationId = installations.get(f.accountId);
    if (!installationId) {
      installationId = randomUUID();
      await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team')", [installationId, f.accountId]);
      installations.set(f.accountId, installationId);
    }
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, floor(random() * 2000000000)::bigint + 1, 'team', $4, $5)", [id, f.accountId, installationId, owner, name]);
    return id;
  }
  async function runner(f: F2Fixture, by: string, repos: string[], revoked = false): Promise<string> {
    const id = await insertRunner(h.admin, f.accountId, by, { credentialMode: "subscription" });
    await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], revoked_at = $3 WHERE id = $1", [id, repos, revoked ? new Date() : null]);
    return id;
  }
  const list = async (f: F2Fixture, userId: string): Promise<Row[]> => ((await respond(() => listRunners(deps(), { accountId: f.accountId, userId }))).body as { runners: Row[] }).runners;

  it("returns { id, name } for each repo, sorted by name, to any member of the account", async () => {
    const f = await seedF2(h.admin);
    const b = await newRepo(f, "acme", "beta");
    const a = await newRepo(f, "acme", "alpha");
    const r = await runner(f, f.a1, [b, a]);
    for (const who of [f.a1, f.m1, f.o1]) {
      expect((await list(f, who)).find((x) => x.id === r)!.repos).toEqual([
        { id: a, name: "acme/alpha" },
        { id: b, name: "acme/beta" },
      ]);
    }
  });

  it("never names a repo of another account, even when a runner's list holds its id", async () => {
    const f = await seedF2(h.admin);
    const g = await seedF2(h.admin);
    const mine = await newRepo(f, "acme", "mine");
    const theirs = await newRepo(g, "rival", "secret-project");
    const r = await runner(f, f.a1, [mine, theirs]);
    const row = (await list(f, f.m1)).find((x) => x.id === r)!;
    expect(row.repos).toEqual([{ id: mine, name: "acme/mine" }]);
    expect(JSON.stringify(row)).not.toContain("secret-project");
    expect(JSON.stringify(row)).not.toContain(theirs);
    // and the other account never sees this account's repos
    expect(JSON.stringify(await list(g, g.o1))).not.toContain("acme/mine");
  });

  it("drops an id that names no repo, lists none for a revoked runner and for an empty list, and counts a repeated id once", async () => {
    const f = await seedF2(h.admin);
    const repo = await newRepo(f, "acme", "app");
    const gone = randomUUID();
    const withGone = await runner(f, f.a1, [repo, repo, gone]);
    const revoked = await runner(f, f.a1, [repo], true);
    const empty = await runner(f, f.a1, []);
    const rows = await list(f, f.m1);
    expect(rows.find((x) => x.id === withGone)!.repos).toEqual([{ id: repo, name: "acme/app" }]);
    expect(rows.find((x) => x.id === revoked)!.repos).toEqual([]);
    expect(rows.find((x) => x.id === empty)!.repos).toEqual([]);
  });

  it("shows a fixed fallback, never null or an id, for a repo with no owner or name on record", async () => {
    const f = await seedF2(h.admin);
    const nameless = await newRepo(f, null, null);
    const r = await runner(f, f.a1, [nameless]);
    expect((await list(f, f.m1)).find((x) => x.id === r)!.repos).toEqual([{ id: nameless, name: "a repository" }]);
  });

  it("is still a 403 for someone who is not a member of the account", async () => {
    const f = await seedF2(h.admin);
    const g = await seedF2(h.admin);
    await runner(f, f.a1, [await newRepo(f, "acme", "app")]);
    expect((await respond(() => listRunners(deps(), { accountId: f.accountId, userId: g.o1 }))).status).toBe(403);
  });
});
