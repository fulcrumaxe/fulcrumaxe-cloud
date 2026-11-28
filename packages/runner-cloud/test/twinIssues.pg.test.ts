import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureErrorReporter, type ErrorClass } from "@fx/telemetry";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { bringTwinIssue, listTwinIssues, createRunPullRequestPort, type SetupInstallPort } from "../src/index.js";
import { FROM_PUBLIC_LABEL } from "../src/localOnlyGithub.js";
import { FAKE_APP_LOGIN, FakeGithub, type FakeRepo, openInstallationKinds } from "./helpers/githubFake.js";
import { harness, type Harness } from "./helpers.js";

/**
 * [pg] D#845 ON-27f: "Bring this issue into the private repo", over real Postgres rows and the REAL pull request port on the strict GitHub fake (the live `setup_labels` path list: the open issues, one issue, the one copy).
 * What the fake cannot show: GitHub makes a label on first use when an issue names one; the fake keeps the names it is given.
 */
describe("bring a public issue into a private twin [pg]", () => {
  let h: Harness;
  const reported: ErrorClass[] = [];
  beforeAll(async () => {
    h = await harness();
    configureErrorReporter({ service: "app", write: () => undefined, sink: { record: (e) => void reported.push(e) } });
  });
  afterAll(async () => {
    configureErrorReporter({ service: "app" });
    await h.close();
  });
  afterEach(() => {
    reported.length = 0;
  });

  interface Rig { who: SeedRefs; publicId: string; privateId: string; twinId: string; member: string; admin: string; fake: FakeGithub; pub: FakeRepo; priv: FakeRepo; port: SetupInstallPort; seen: Map<string, "private" | "public" | "unknown"> }
  async function addUser(accountId: string, role: string, name: string | null = null): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [id, `${id}@example.test`, name]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, id, role]);
    return id;
  }
  async function rig(o: { state?: string } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const publicGh = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    const privateId = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', 'widgets-private')", [privateId, who.accountId, who.installationId, publicGh + 1]);
    const twinId = randomUUID();
    await h.admin.query(
      `INSERT INTO repo_twins (id, account_id, public_repo_id, private_repo_id, private_name, private_gh_repo_id, created_by, state, removed_at)
       VALUES ($1, $2, $3, $4, 'widgets-private', $5, $6, $7, CASE WHEN $7 = 'removed' THEN now() END)`,
      [twinId, who.accountId, who.repoId, privateId, publicGh + 1, who.userId, o.state ?? "ready"],
    );
    const fake = new FakeGithub();
    const pub = fake.addRepo("acme", "widgets");
    const priv = fake.addRepo("acme", "widgets-private", { id: publicGh + 1 });
    const open = openInstallationKinds(fake);
    const port = createRunPullRequestPort({ open, appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
    const seen = new Map<string, "private" | "public" | "unknown">([[who.repoId, "public"], [privateId, "private"]]);
    return { who, publicId: who.repoId, privateId, twinId, member: await addUser(who.accountId, "member"), admin: await addUser(who.accountId, "admin", "Ada Lovelace"), fake, pub, priv, port, seen };
  }
  const deps = (r: Rig, over: Partial<{ setupInstall: SetupInstallPort | undefined }> = {}) => ({ appUserPool: h.deps().appUserPool, setupInstall: "setupInstall" in over ? over.setupInstall : r.port, repoVisibility: async (_a: string, repoId: string) => r.seen.get(repoId) ?? ("unknown" as const) });
  const issue = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, title: `Issue ${n}`, body: `Body ${n}`, labels: [], state: "open" as const, author: { login: `user${n}`, type: "User" as const }, ...extra });
  const list = (r: Rig, userId = r.admin, twinId = r.twinId) => listTwinIssues(deps(r), { accountId: r.who.accountId, userId }, twinId);
  const bring = (r: Rig, n: number, userId = r.admin, twinId = r.twinId, over: Parameters<typeof deps>[1] = {}) => bringTwinIssue(deps(r, over), { accountId: r.who.accountId, userId }, twinId, n);
  const audit = async (r: Rig) => (await h.admin.query<{ actor: string; payload: unknown }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'twin.issue_brought' ORDER BY created_at, id", [r.who.accountId])).rows;
  const imports = async (r: Rig) => (await h.admin.query<{ public_issue: number; private_issue: number | null }>("SELECT public_issue, private_issue FROM twin_issue_imports WHERE twin_id = $1", [r.twinId])).rows;
  const writes = (r: Rig) => r.fake.calls.filter((c) => c.method !== "GET");

  describe("the list", () => {
    it("shows the newest 20 open issues of the PUBLIC repository (number, title, author), no pull requests, to a member without the button and to an admin with it", async () => {
      const r = await rig();
      for (let n = 1; n <= 25; n++) r.pub.issues.push(issue(n, n === 24 ? { pull_request: true } : n === 23 ? { state: "closed" } : {}));
      r.priv.issues.push(issue(1, { title: "A private one" }));
      const asMember = await list(r, r.member);
      const asAdmin = await list(r, r.admin);
      expect(asMember).toMatchObject({ result: "ok", canBring: false });
      expect(asAdmin).toMatchObject({ result: "ok", canBring: true });
      if (asAdmin.result !== "ok") throw new Error("unreachable");
      expect(asAdmin.issues).toHaveLength(20);
      expect(asAdmin.issues.map((i) => i.number)).toEqual([25, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
      expect(asAdmin.issues[0]).toEqual({ number: 25, title: "Issue 25", author: "user25", brought: null });
      expect(JSON.stringify(asAdmin)).not.toContain("A private one");
      expect(writes(r)).toEqual([]);
    });

    it("marks an issue already brought with the private number; the marks are the twin's own", async () => {
      const r = await rig();
      const other = await rig();
      r.pub.issues.push(issue(5), issue(6));
      other.pub.issues.push(issue(5), issue(6));
      expect(await bring(r, 5)).toMatchObject({ result: "ok" });
      const got = await list(r);
      if (got.result !== "ok") throw new Error("unreachable");
      expect(got.issues.map((i) => [i.number, i.brought !== null])).toEqual([[6, false], [5, true]]);
      const theirs = await list(other);
      if (theirs.result !== "ok") throw new Error("unreachable");
      expect(theirs.issues.every((i) => i.brought === null)).toBe(true);
    });

    it.each(["seeding", "refused", "failed", "removed"])("a %s twin has no list (twin_state) and GitHub is not asked", async (state) => {
      const r = await rig({ state });
      expect(await list(r)).toEqual({ result: "twin_state", state });
      expect(r.fake.calls).toEqual([]);
    });

    it("another account's twin, an unknown twin and a malformed id are not_found; a GitHub that fails, or no App port, is github_unavailable", async () => {
      const r = await rig();
      const stranger = await rig();
      expect(await listTwinIssues(deps(r), { accountId: stranger.who.accountId, userId: stranger.admin }, r.twinId)).toEqual({ result: "not_found" });
      expect(await list(r, r.admin, randomUUID())).toEqual({ result: "not_found" });
      expect(await list(r, r.admin, "not-a-uuid")).toEqual({ result: "not_found" });
      r.fake.inject = { label: /A28/, reply: { status: 503, body: { message: "down" } } };
      expect(await list(r)).toEqual({ result: "github_unavailable" });
      expect(await listTwinIssues(deps(r, { setupInstall: undefined }), { accountId: r.who.accountId, userId: r.admin }, r.twinId)).toEqual({ result: "github_unavailable" });
    });
  });

  describe("tenant and repo filters", () => {
    /** A second twin of the SAME account, over two more repositories (gadgets and gadgets-private). */
    async function second(r: Rig): Promise<string> {
      const pubId = randomUUID();
      const privId = randomUUID();
      const gh = Math.floor(Math.random() * 1e9) + 1e10;
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', 'gadgets'), ($5, $2, $3, $6, 'team', 'acme', 'gadgets-private')", [pubId, r.who.accountId, r.who.installationId, gh, privId, gh + 1]);
      const id = randomUUID();
      await h.admin.query("INSERT INTO repo_twins (id, account_id, public_repo_id, private_repo_id, private_name, private_gh_repo_id, created_by, state) VALUES ($1, $2, $3, $4, 'gadgets-private', $5, $6, 'ready')", [id, r.who.accountId, pubId, privId, gh + 1, r.who.userId]);
      r.fake.addRepo("acme", "gadgets");
      r.fake.addRepo("acme", "gadgets-private", { id: gh + 1 });
      r.seen.set(pubId, "public");
      r.seen.set(privId, "private");
      return id;
    }

    it("a second twin of the same account never shows or marks the first twin's issues, and a bring on one is not the other's", async () => {
      const r = await rig();
      const other = await second(r);
      r.pub.issues.push(issue(5));
      r.fake.repos.get("acme/gadgets")!.issues.push(issue(5, { title: "Gadget five" }));
      expect(await bring(r, 5)).toMatchObject({ result: "ok" });
      const mine = await list(r);
      const theirs = await list(r, r.admin, other);
      if (mine.result !== "ok" || theirs.result !== "ok") throw new Error("unreachable");
      expect(mine.issues.map((i) => [i.title, i.brought !== null])).toEqual([["Issue 5", true]]);
      expect(theirs.issues.map((i) => [i.title, i.brought])).toEqual([["Gadget five", null]]);
      // the same public number on the other twin is its own: it opens its own private issue
      expect(await bring(r, 5, r.admin, other)).toMatchObject({ result: "ok" });
      expect(r.fake.repos.get("acme/gadgets-private")!.issues.map((i) => i.title)).toEqual(["Gadget five"]);
      expect(r.priv.issues.map((i) => i.title)).toEqual(["Issue 5"]);
    });

    it("read through a pool that bypasses row security, with another account's person: the explicit account predicate alone answers not_found and nothing is read or written", async () => {
      const r = await rig();
      const stranger = await rig();
      r.pub.issues.push(issue(5));
      await bring(r, 5);
      const before = r.fake.calls.length;
      const bypass = { ...deps(r), appUserPool: h.adminPool };
      expect(await listTwinIssues(bypass, { accountId: stranger.who.accountId, userId: stranger.admin }, r.twinId)).toEqual({ result: "not_found" });
      expect(await bringTwinIssue(bypass, { accountId: stranger.who.accountId, userId: stranger.admin }, r.twinId, 5)).toEqual({ result: "not_found" });
      expect(r.fake.calls.length).toBe(before);
    });
  });

  describe("bring", () => {
    it("opens one issue in the PRIVATE repository: the same title, the label from-public, a fixed header and the original quoted; the public repository is never written", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7, { title: "Crash on start", body: "It crashes.\n@mallory-fan please look", author: { login: "mallory", type: "User" } }));
      const out = await bring(r, 7);
      expect(out).toEqual({ result: "ok", privateIssue: 100 });
      expect(r.priv.issues).toHaveLength(1);
      const made = r.priv.issues[0]!;
      expect(made.title).toBe("Crash on start");
      expect(made.labels).toEqual([FROM_PUBLIC_LABEL]);
      expect(made.body.split("\n")[0]).toBe("Brought from public issue number 7 by Ada Lovelace. The text below was written by mallory on the public repo and is untrusted.");
      expect(made.body).toContain("> It crashes.\n> @mallory-fan please look\n> ```");
      expect(r.pub.issues).toHaveLength(1);
      expect(writes(r).map((c) => [c.method, c.path])).toEqual([["POST", "/repos/acme/widgets-private/issues"]]);
      expect(r.fake.denied).toBe(0);
      expect(await imports(r)).toEqual([{ public_issue: 7, private_issue: 100 }]);
      expect(await audit(r)).toEqual([{ actor: r.admin, payload: { twin_id: r.twinId, public_issue: 7, private_issue: 100 } }]);
      expect(reported).toEqual([]);
    });

    it("a hostile body arrives quoted and inert: nothing of it is outside the quotation, a long fence cannot be closed from inside, and no title or name carries markup", async () => {
      const r = await rig();
      const hostile = "```\n## owned\n```\n<img src=x onerror=alert(1)>\n@everyone #1 acme/widgets-private#1\n[x](http://evil.example)\n````````\n-->";
      r.pub.issues.push(issue(8, { title: "T\u0007itle", body: hostile, author: { login: "evil-bot[bot]", type: "Bot" } }));
      const adminId = await addUser(r.who.accountId, "admin", "Eve <b>@all</b>");
      expect(await bring(r, 8, adminId)).toMatchObject({ result: "ok" });
      const made = r.priv.issues[0]!;
      expect(made.title).toBe("T itle");
      const lines = made.body.trimEnd().split("\n");
      expect(lines[0]).toBe("Brought from public issue number 8 by Eve ballb. The text below was written by evil-bot[bot] on the public repo and is untrusted.");
      expect(lines[1]).toBe("");
      expect(lines.slice(2).every((l) => l === ">" || l.startsWith("> "))).toBe(true);
      expect(lines.slice(2)[0]).toBe(`> ${"`".repeat(9)}`);
      expect(lines.slice(3, -1).map((l) => l.slice(2)).join("\n")).toBe(hostile);
    });

    it.each([
      ["a body of 64 KiB of one long line", "x".repeat(65_536)],
      ["a body of 64 KiB of newlines", "\n".repeat(65_536)],
      ["a body of ordinary lines past the old limit", "0123456789abcdef\n".repeat(4_400)],
      ["a body of multi-byte text", "\u00e9".repeat(60_000)],
    ])("%s is cut and marked to fit what real GitHub takes (65,536 characters, the strict fake refuses more), with the fence closed", async (_name, text) => {
      const r = await rig();
      r.pub.issues.push(issue(9, { body: text }));
      expect(await bring(r, 9)).toMatchObject({ result: "ok" });
      const made = r.priv.issues[0]!.body;
      expect(made.length).toBeLessThanOrEqual(65_536);
      expect(made.trimEnd().split("\n").at(-1)).toBe("(The original was cut here to fit in an issue.)");
      expect(made.trimEnd().split("\n").at(-3)).toMatch(/^> `{3,}$/);
    });

    it("a second click answers already with the private number and makes no GitHub call at all; a different issue is its own", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7), issue(8));
      expect(await bring(r, 7)).toEqual({ result: "ok", privateIssue: 100 });
      const before = r.fake.calls.length;
      expect(await bring(r, 7, r.who.userId)).toEqual({ result: "already", privateIssue: 100 });
      expect(r.fake.calls.length).toBe(before);
      expect(r.priv.issues).toHaveLength(1);
      expect(await bring(r, 8)).toEqual({ result: "ok", privateIssue: 101 });
      expect((await audit(r)).length).toBe(2);
    });

    it("two clicks at once: one claim wins and makes the only GitHub create; the other is in_progress or already, with one pair row and one audit row", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7));
      const both = await Promise.all([bring(r, 7), bring(r, 7, r.who.userId)]);
      const results = both.map((x) => x.result).sort();
      expect(results[1]).toBe("ok");
      expect(["already", "in_progress"]).toContain(results[0]);
      expect(both.filter((x) => x.result === "ok")).toHaveLength(1);
      expect(writes(r)).toHaveLength(1);
      expect(r.priv.issues).toHaveLength(1);
      expect(await imports(r)).toEqual([{ public_issue: 7, private_issue: 100 }]);
      expect(await audit(r)).toHaveLength(1);
      expect(reported).toEqual([]);
    });

    it("a live claim without a number is in_progress and GitHub is not asked; an expired one is retaken and the bring goes through", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7));
      await h.admin.query("INSERT INTO twin_issue_imports (twin_id, account_id, public_issue, claim_until, brought_by) VALUES ($1, $2, 7, now() + interval '4 minutes', $3)", [r.twinId, r.who.accountId, r.member]);
      expect(await bring(r, 7)).toEqual({ result: "in_progress" });
      expect(r.fake.calls).toEqual([]);
      await h.admin.query("UPDATE twin_issue_imports SET claim_until = now() - interval '1 second' WHERE twin_id = $1", [r.twinId]);
      expect(await bring(r, 7)).toEqual({ result: "ok", privateIssue: 100 });
      expect(await imports(r)).toEqual([{ public_issue: 7, private_issue: 100 }]);
    });

    it("a GitHub failure after the claim (on the read or on the create) gives the claim back: the next click is not in_progress and creates exactly one issue", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7));
      r.fake.inject = { label: /A29/, reply: { status: 503, body: { message: "down" } } };
      expect(await bring(r, 7)).toEqual({ result: "github_unavailable" });
      expect(await imports(r)).toEqual([]);
      expect(r.priv.issues).toEqual([]);
      r.fake.inject = { label: /A34/, reply: { status: 503, body: { message: "down" } } };
      expect(await bring(r, 7)).toEqual({ result: "github_unavailable" });
      expect(await imports(r)).toEqual([]);
      expect(await bring(r, 7)).toEqual({ result: "ok", privateIssue: 100 });
      expect(r.priv.issues).toHaveLength(1);
    });

    it("a member may not bring (42501): nothing is read from GitHub, nothing is written", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7));
      await expect(bring(r, 7, r.member)).rejects.toMatchObject({ code: "42501" });
      expect(r.fake.calls).toEqual([]);
      expect(await imports(r)).toEqual([]);
    });

    it.each(["seeding", "refused", "failed", "removed"])("a %s twin is twin_state and GitHub is not asked", async (state) => {
      const r = await rig({ state });
      r.pub.issues.push(issue(7));
      expect(await bring(r, 7)).toEqual({ result: "twin_state", state });
      expect(r.fake.calls).toEqual([]);
    });

    it.each(["paused", "conflict"])("a %s twin may take an issue", async (state) => {
      const r = await rig({ state });
      r.pub.issues.push(issue(7));
      expect(await bring(r, 7)).toMatchObject({ result: "ok" });
    });

    it("a pull request and a closed issue are issue_not_open, a number with nothing behind it is no_issue, and nothing is written for any", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7, { pull_request: true }), issue(8, { state: "closed" }));
      expect(await bring(r, 7)).toEqual({ result: "issue_not_open" });
      expect(await bring(r, 8)).toEqual({ result: "issue_not_open" });
      expect(await bring(r, 99)).toEqual({ result: "no_issue" });
      expect(writes(r)).toEqual([]);
      expect(await imports(r)).toEqual([]);
    });

    it("another account's twin, an unknown twin, a malformed id and a bad issue number are not_found", async () => {
      const r = await rig();
      const stranger = await rig();
      expect(await bringTwinIssue(deps(r), { accountId: stranger.who.accountId, userId: stranger.admin }, r.twinId, 1)).toEqual({ result: "not_found" });
      expect(await bring(r, 1, r.admin, randomUUID())).toEqual({ result: "not_found" });
      expect(await bring(r, 1, r.admin, "nope")).toEqual({ result: "not_found" });
      for (const n of [0, -1, 1.5, Number.NaN]) expect(await bring(r, n)).toEqual({ result: "not_found" });
      expect(r.fake.calls).toEqual([]);
    });

    it("GitHub failing on the read or on the write, or no App port, is github_unavailable: nothing is recorded, so the click can be made again", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7));
      r.fake.inject = { label: /A34/, reply: { status: 503, body: { message: "down" } } };
      expect(await bring(r, 7)).toEqual({ result: "github_unavailable" });
      r.fake.inject = { label: /A29/, reply: { status: 503, body: { message: "down" } } };
      expect(await bring(r, 7)).toEqual({ result: "github_unavailable" });
      expect(await bring(r, 7, r.admin, r.twinId, { setupInstall: undefined })).toEqual({ result: "github_unavailable" });
      expect(await imports(r)).toEqual([]);
      expect(await bring(r, 7)).toMatchObject({ result: "ok" });
    });

    it("a private repository that turned public is refused before anything is written: not_private, the twin is refused, and the private repo holds nothing", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7));
      r.seen.set(r.privateId, "public");
      expect(await bring(r, 7)).toEqual({ result: "not_private" });
      expect(writes(r)).toEqual([]);
      expect(r.priv.issues).toEqual([]);
      expect((await h.admin.query<{ state: string; failure_code: string }>("SELECT state, failure_code FROM repo_twins WHERE id = $1", [r.twinId])).rows[0]).toEqual({ state: "refused", failure_code: "twin_not_private" });
      expect(await imports(r)).toEqual([]);
    });

    it("a PAUSED twin is read for visibility too: a private repository that turned public is refused (not_private, the twin goes refused with twin_not_private, one twin.refused row), and nothing is written", async () => {
      const r = await rig({ state: "paused" });
      r.pub.issues.push(issue(7));
      r.seen.set(r.privateId, "public");
      expect(await bring(r, 7)).toEqual({ result: "not_private" });
      expect(writes(r)).toEqual([]);
      expect(r.priv.issues).toEqual([]);
      expect((await h.admin.query<{ state: string; failure_code: string }>("SELECT state, failure_code FROM repo_twins WHERE id = $1", [r.twinId])).rows[0]).toEqual({ state: "refused", failure_code: "twin_not_private" });
      expect((await h.admin.query("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'twin.refused'", [r.who.accountId])).rows.map((x) => x.payload)).toEqual([{ twin_id: r.twinId, code: "twin_not_private", from: "paused" }]);
      expect(await imports(r)).toEqual([]);
    });

    it("a PAUSED twin whose visibility cannot be read is visibility_unknown: nothing is written, the twin stays paused, and the claim is given back", async () => {
      const r = await rig({ state: "paused" });
      r.pub.issues.push(issue(7));
      r.seen.set(r.privateId, "unknown");
      expect(await bring(r, 7)).toEqual({ result: "visibility_unknown" });
      expect(writes(r)).toEqual([]);
      expect((await h.admin.query<{ state: string }>("SELECT state FROM repo_twins WHERE id = $1", [r.twinId])).rows[0]!.state).toBe("paused");
      expect(await imports(r)).toEqual([]);
      r.seen.set(r.privateId, "private");
      expect(await bring(r, 7)).toMatchObject({ result: "ok" });
    });

    it("a slow bring whose claim was retaken (it ran past five minutes): its record writes nothing and is reported under the one fixed class; the retaker's number stands, with one audit row", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7));
      const real = r.port.createBroughtIssue.bind(r.port);
      let nested = false;
      r.port.createBroughtIssue = async (input) => {
        if (!nested) {
          nested = true;
          await h.admin.query("UPDATE twin_issue_imports SET claim_until = now() - interval '1 second' WHERE twin_id = $1", [r.twinId]);
          expect(await bring(r, 7, r.who.userId)).toEqual({ result: "ok", privateIssue: 100 });
        }
        return real(input);
      };
      expect(await bring(r, 7)).toEqual({ result: "ok", privateIssue: 101 });
      expect(reported.map((e) => e.code)).toEqual(["twin_issue_record_failed"]);
      expect(await imports(r)).toEqual([{ public_issue: 7, private_issue: 100 }]);
      expect(await audit(r)).toHaveLength(1);
      expect(r.priv.issues).toHaveLength(2);
    });

    it("a visibility that cannot be read is visibility_unknown: nothing is written and the twin is untouched", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7));
      r.seen.set(r.privateId, "unknown");
      expect(await bring(r, 7)).toEqual({ result: "visibility_unknown" });
      expect(writes(r)).toEqual([]);
      expect((await h.admin.query<{ state: string }>("SELECT state FROM repo_twins WHERE id = $1", [r.twinId])).rows[0]!.state).toBe("ready");
    });

    it("a twin removed while the issue is being made: GitHub has the issue, so the answer is ok, the failed record is reported under its one fixed class (no text), and nothing is recorded", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7));
      const real = r.port.createBroughtIssue.bind(r.port);
      r.port.createBroughtIssue = async (input) => {
        const n = await real(input);
        await h.admin.query("UPDATE repo_twins SET state = 'removed', removed_at = now() WHERE id = $1", [r.twinId]);
        return n;
      };
      expect(await bring(r, 7)).toEqual({ result: "ok", privateIssue: 100 });
      expect(reported.map((e) => e.code)).toEqual(["twin_issue_record_failed"]);
      expect(JSON.stringify(reported)).not.toContain("Issue 7");
      // the claim was never numbered (the twin was gone); it lapses by itself
      expect(await imports(r)).toEqual([{ public_issue: 7, private_issue: null }]);
      expect(await audit(r)).toEqual([]);
    });

    it("never calls anything outside the allowlist: the strict fake saw no denied call, and only the three issue routes of the two repositories", async () => {
      const r = await rig();
      r.pub.issues.push(issue(7));
      await list(r);
      await bring(r, 7);
      expect(r.fake.denied).toBe(0);
      expect(r.fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/acme/widgets/issues", "GET /repos/acme/widgets/issues/7", "POST /repos/acme/widgets-private/issues"]);
    });
  });
});
