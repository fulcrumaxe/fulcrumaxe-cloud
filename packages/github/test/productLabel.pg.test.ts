import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { ENGINE_LOOP_MARKER, executePlanImport } from "@fx/core/src/plan/executeImport.js";
import { PRODUCT_LABEL } from "@fx/core/src/plan/ownerProcess.js";
import { beginPlanImport } from "@fx/core/src/plan/persist.js";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import type { GithubWebhookDbDeps, GithubWebhookPayload, HandleWebhookResult } from "../src/eventMapper.js";
import { handleGithubWebhookEventForApp } from "../src/webhookGate.js";
import { createIssueAuthorLookup } from "../src/issueAuthorLookup.js";
import { createLoginPermissionLookup } from "../src/loginPermission.js";
import { InstallationTokenCache } from "../src/installationToken.js";
import { createPlanSourceFactory } from "../src/planSource.js";
import { FETCH_DEFAULT_USER_AGENT } from "./helpers/strictGithub.js";
import { newFakeState, startPlanGithub, type FakeItem, type PlanGithub } from "./helpers/planGithubFake.js";

/**
 * D#483: the `fulcrumaxe:product` label on an issue, end to end against real Postgres. A delivery is an `issues.labeled` or `.unlabeled` payload in
 * GitHub's own shape (the `label` object and the `sender`); the sender's permission is read by the real lookup over real TLS from the strict GitHub
 * fake (the collaborator permission route, with a read-only token), and the repository's owner process by the real plan source. Discovery reads the
 * issue's label events and the actor's permission through the same fake.
 *
 * Not faked faithfully: GitHub's delivery order and retry timing (the orders are driven by hand), and the real `events` route's exact page sizes.
 */
type Role = "admin" | "maintain" | "write" | "triage" | "read" | "none";
const creds = () => ({ appId: "123", privateKeyPem: pem, webhookSecret: "unused" });
let pem: string;
const LOOP = { [ENGINE_LOOP_MARKER]: "{}" };

describe("the product label on an issue (D#483)", () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let admin: PoolClient;
  let gh: PlanGithub | undefined;
  const warnings: string[] = [];

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });
  afterEach(async () => {
    await gh?.close();
    gh = undefined;
    warnings.length = 0;
    setPendingHooks(null);
  });

  async function tenant(): Promise<SeedRefs & { ghInstallationId: number; ghRepoId: number }> {
    const r = await seedAccount(admin, randomUUID());
    await admin.query(`UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1`, [r.repoId]);
    const ghInstallationId = Number((await admin.query(`SELECT gh_installation_id FROM installations WHERE id = $1`, [r.installationId])).rows[0].gh_installation_id);
    const ghRepoId = Number((await admin.query(`SELECT gh_repo_id FROM repos WHERE id = $1`, [r.repoId])).rows[0].gh_repo_id);
    return { ...r, ghInstallationId, ghRepoId };
  }

  async function github(collaborators: Record<string, Role>, items: FakeItem[] = [], files: Record<string, string> = LOOP, wire: { sender?: boolean } = {}) {
    gh = await startPlanGithub(newFakeState({ collaborators, items, files: new Map(Object.entries(files)) }));
    const fetchImpl = ((url, init) => gh!.fetch(url, { ...init, headers: { "user-agent": FETCH_DEFAULT_USER_AGENT, ...(init?.headers as Record<string, string>) } })) as typeof fetch;
    const base = { resolveInstallation: async () => ({ installationId: 777, appKind: "team" }), appCredentials: creds, requester: gh.requester, cache: new InstallationTokenCache(), fetchImpl };
    const lookup = createIssueAuthorLookup(base);
    const permission = createLoginPermissionLookup(base);
    const factory = createPlanSourceFactory({ resolveInstallation: base.resolveInstallation, appCredentials: creds, requester: gh.requester, fetchImpl: gh.fetch });
    const deps: GithubWebhookDbDeps = {
      appUserPool,
      platformOpsPool,
      issueAuthorPermission: async (input) => {
        const found = await lookup(input);
        return found.status === "found" ? { login: found.login, permission: found.permission } : null;
      },
      ...(wire.sender === false ? {} : { senderPermission: (input) => permission(input) }),
      repoHasEngineLoop: async (input) => {
        const source = factory(input);
        const head = await source.head();
        return (await source.file(ENGINE_LOOP_MARKER, head.sha, 1024 * 1024)) !== null;
      },
      warn: (m) => warnings.push(m),
    };
    return { deps, factory };
  }

  const issueItem = (n: number, login: string, extra: Partial<FakeItem> = {}): FakeItem => ({ number: n, title: `Issue ${n}`, body: "", state: "open", login, ...extra });
  const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

  /** GitHub's own payload shape for `issues.labeled` / `.unlabeled`: the `label` object, the `sender`, and the issue with its labels. */
  function labelPayload(r: { ghInstallationId: number; ghRepoId: number }, n: number, action: "labeled" | "unlabeled", sender: string, over: { label?: string; state?: string; pull?: boolean; author?: string; createdAt?: string } = {}): GithubWebhookPayload {
    const name = over.label ?? PRODUCT_LABEL;
    const label = { id: 208045946, node_id: "MDU6TGFiZWwyMDgwNDU5NDY=", url: `https://api.github.com/repos/acme/widgets/labels/${encodeURIComponent(name)}`, name, color: "ededed", default: false, description: null };
    return {
      action,
      issue: {
        number: n,
        title: `Issue ${n}`,
        body: `Body of issue ${n}`,
        user: { login: over.author ?? "stranger", type: "User" },
        author_association: "NONE",
        state: over.state ?? "open",
        created_at: over.createdAt ?? FUTURE(),
        labels: action === "labeled" ? [label] : [],
        ...(over.pull ? { pull_request: { url: `https://api.github.com/repos/acme/widgets/pulls/${n}` } } : {}),
      },
      label,
      sender: { login: sender, id: 583231, type: "User", site_admin: false },
      installation: { id: r.ghInstallationId },
      repository: { id: r.ghRepoId, full_name: "acme/widgets", default_branch: "main" },
    } as unknown as GithubWebhookPayload;
  }
  function openedPayload(r: { ghInstallationId: number; ghRepoId: number }, n: number, login: string): GithubWebhookPayload {
    return {
      action: "opened",
      issue: { number: n, title: `Issue ${n}`, body: `Body of issue ${n}`, user: { login }, author_association: "NONE", state: "open", created_at: FUTURE() },
      installation: { id: r.ghInstallationId },
      repository: { id: r.ghRepoId, full_name: "acme/widgets", default_branch: "main" },
    } as unknown as GithubWebhookPayload;
  }
  const deliver = async (deps: GithubWebhookDbDeps, body: GithubWebhookPayload): Promise<HandleWebhookResult> => handleGithubWebhookEventForApp(deps, "issues", body, randomUUID(), "team");
  const applied = (out: HandleWebhookResult) => (out.handled ? out.result : out);

  const proposal = async (r: SeedRefs, n: number) =>
    (await admin.query(`SELECT owner_process, state, verification, provenance FROM proposals WHERE account_id = $1 AND gh_number = $2`, [r.accountId, n])).rows[0] as { owner_process: string; state: string; verification: string; provenance: string } | undefined;
  const audits = async (r: SeedRefs) => (await admin.query(`SELECT payload->>'to' AS to, payload->>'permission' AS permission FROM audit_log WHERE account_id = $1 AND action = 'proposal.owner_changed' ORDER BY created_at`, [r.accountId])).rows as Array<{ to: string; permission: string }>;
  const permissionReads = () => gh!.server.seen.filter((s) => /\/collaborators\/[^/]+\/permission$/.test(s.path)).map((s) => decodeURIComponent(s.path.split("/")[5]!));
  const proposalsCount = async (r: SeedRefs) => (await admin.query(`SELECT count(*)::int n FROM proposals WHERE account_id = $1`, [r.accountId])).rows[0].n as number;

  it("open then label: a maintainer's or an admin's label hands an existing internal_loop proposal to the product, re-queues its check and audits it; a replay changes nothing", async () => {
    for (const role of ["maintain", "admin"] as const) {
      const r = await tenant();
      const { deps } = await github({ stranger: "read", boss: role }, [issueItem(10, "stranger")]);
      expect(applied(await deliver(deps, openedPayload(r, 10, "stranger")))).toMatchObject({ applied: "proposed", created: true });
      expect(await proposal(r, 10)).toMatchObject({ owner_process: "internal_loop", verification: "pending" });
      await admin.query(`UPDATE proposals SET verification = 'check_failed', verified_at = now(), verify_attempts = 2 WHERE account_id = $1`, [r.accountId]);

      expect(applied(await deliver(deps, labelPayload(r, 10, "labeled", "boss")))).toEqual({ applied: "proposal_owner_changed", to: "product", count: 1 });
      expect(await proposal(r, 10)).toEqual({ owner_process: "product", state: "new", verification: "pending", provenance: "external" });
      expect(await audits(r)).toEqual([{ to: "product", permission: role }]);
      expect(applied(await deliver(deps, labelPayload(r, 10, "labeled", "boss")))).toEqual({ applied: "proposal_owner_changed", to: "product", count: 0 });
      expect(await audits(r)).toHaveLength(1);
      expect(await proposalsCount(r)).toBe(1);
    }
  });

  it("a flip wakes the verify sweep, as a new proposal does; a replay does not", async () => {
    const markers = new Map<string, number>();
    setPendingHooks({ store: { get: async (k) => markers.get(k) ?? null, set: async (k, v) => void markers.set(k, v), delete: async (k) => void markers.delete(k) } });
    const r = await tenant();
    const { deps } = await github({ stranger: "read", boss: "admin" }, [issueItem(11, "stranger")]);
    await deliver(deps, openedPayload(r, 11, "stranger"));
    markers.clear();
    await deliver(deps, labelPayload(r, 11, "labeled", "boss"));
    expect(markers.has("pending:proposal-verify-sweep")).toBe(true);
    markers.clear();
    await deliver(deps, labelPayload(r, 11, "labeled", "boss"));
    expect(markers.has("pending:proposal-verify-sweep")).toBe(false);
  });

  it("label then open: the label brings the issue in as a product proposal, and the opened delivery that follows does not overwrite it; the reverse order ends the same", async () => {
    const r = await tenant();
    const { deps } = await github({ stranger: "read", boss: "maintain" }, [issueItem(20, "stranger"), issueItem(21, "stranger")]);
    expect(applied(await deliver(deps, labelPayload(r, 20, "labeled", "boss")))).toMatchObject({ applied: "proposed", created: true });
    expect(await proposal(r, 20)).toMatchObject({ owner_process: "product", state: "new", verification: "pending", provenance: "external" });
    expect(applied(await deliver(deps, openedPayload(r, 20, "stranger")))).toMatchObject({ applied: "proposed", created: false });
    expect((await proposal(r, 20))!.owner_process).toBe("product");
    // Both orders: open, then label.
    await deliver(deps, openedPayload(r, 21, "stranger"));
    await deliver(deps, labelPayload(r, 21, "labeled", "boss"));
    expect((await proposal(r, 21))!.owner_process).toBe("product");
    expect(await proposalsCount(r)).toBe(2);
    // The label's hand-over of a brand new proposal is not a "move": only the flip of an existing one is audited.
    expect(await audits(r)).toEqual([{ to: "product", permission: "maintain" }]);
  });

  it("an issue older than the repository's own row is brought in by a maintainer's label (an explicit hand-over) but not by any other label", async () => {
    const r = await tenant();
    const { deps } = await github({ stranger: "read", boss: "admin", other: "write" }, [issueItem(30, "stranger"), issueItem(31, "stranger")]);
    const old = "2019-01-01T00:00:00Z";
    expect(applied(await deliver(deps, labelPayload(r, 30, "labeled", "boss", { createdAt: old })))).toMatchObject({ applied: "proposed", created: true });
    expect((await proposal(r, 30))!.owner_process).toBe("product");
    expect(applied(await deliver(deps, labelPayload(r, 31, "labeled", "boss", { createdAt: old, label: "bug" })))).toMatchObject({ applied: "skipped" });
    expect(await proposal(r, 31)).toBeUndefined();
  });

  it("every permission below maintain, a sender GitHub does not know and a failing read leave the proposal as it was: no change, no outbound call, no comment", async () => {
    const roles: Record<string, Role> = { w: "write", t: "triage", r: "read", n: "none" };
    for (const sender of [...Object.keys(roles), "ghost"]) {
      const r = await tenant();
      const { deps } = await github({ stranger: "read", ...roles }, [issueItem(40, "stranger")]);
      await deliver(deps, openedPayload(r, 40, "stranger"));
      const out = applied(await deliver(deps, labelPayload(r, 40, "labeled", sender)));
      expect(out).not.toMatchObject({ applied: "proposal_owner_changed" });
      expect((await proposal(r, 40))!.owner_process).toBe("internal_loop");
      expect(await audits(r)).toEqual([]);
      // The only writes the platform makes are the token mint and the read-only GraphQL query; nothing is posted to the issue.
      expect(gh!.server.seen.filter((s) => s.method !== "GET" && !s.path.startsWith("/app/") && s.path !== "/graphql")).toEqual([]);
    }
    // A server error on the permission route: fail closed, and the warning is one fixed line without the login.
    const r = await tenant();
    const { deps } = await github({ stranger: "read", boss: "admin" }, [issueItem(41, "stranger")]);
    await deliver(deps, openedPayload(r, 41, "stranger"));
    gh!.state.faults.permissionStatus = 503;
    await deliver(deps, labelPayload(r, 41, "labeled", "boss"));
    expect((await proposal(r, 41))!.owner_process).toBe("internal_loop");
    expect(warnings).toEqual(["github webhook: product label sender permission lookup failed; the label is not honoured"]);
    expect(warnings.join()).not.toMatch(/boss/);
    // No reader wired at all: the same.
    const r2 = await tenant();
    const { deps: bare } = await github({ stranger: "read", boss: "admin" }, [issueItem(42, "stranger")], LOOP, { sender: false });
    await deliver(bare, openedPayload(r2, 42, "stranger"));
    await deliver(bare, labelPayload(r2, 42, "labeled", "boss"));
    expect((await proposal(r2, 42))!.owner_process).toBe("internal_loop");
  });

  it("a different label costs no permission read; a closed issue and a pull request change nothing and cost no read either", async () => {
    const r = await tenant();
    const { deps } = await github({ stranger: "read", boss: "admin" }, [issueItem(50, "stranger"), issueItem(51, "stranger")]);
    await deliver(deps, openedPayload(r, 50, "stranger"));
    const before = permissionReads().length;
    await deliver(deps, labelPayload(r, 50, "labeled", "boss", { label: "bug" }));
    await deliver(deps, labelPayload(r, 50, "labeled", "boss", { label: `${PRODUCT_LABEL}-x` }));
    await deliver(deps, labelPayload(r, 50, "unlabeled", "boss", { label: "bug" }));
    expect(permissionReads().length).toBe(before);
    expect((await proposal(r, 50))!.owner_process).toBe("internal_loop");

    await deliver(deps, labelPayload(r, 50, "labeled", "boss", { state: "closed" }));
    expect((await proposal(r, 50))!.owner_process).toBe("internal_loop");
    await deliver(deps, labelPayload(r, 51, "labeled", "boss", { pull: true }));
    expect(await proposal(r, 51)).toBeUndefined();
    expect(permissionReads().filter((l) => l === "boss")).toHaveLength(0);
  });

  it("flip then unlabel: a maintainer's removal of the label hands a new, unstarted proposal back; a lesser sender's removal does not; and so does one without the engine loop", async () => {
    const r = await tenant();
    const { deps } = await github({ stranger: "read", boss: "maintain", dev: "write" }, [issueItem(60, "stranger")]);
    await deliver(deps, openedPayload(r, 60, "stranger"));
    await deliver(deps, labelPayload(r, 60, "labeled", "boss"));
    expect((await proposal(r, 60))!.owner_process).toBe("product");
    expect(applied(await deliver(deps, labelPayload(r, 60, "unlabeled", "dev")))).not.toMatchObject({ applied: "proposal_owner_changed" });
    expect((await proposal(r, 60))!.owner_process).toBe("product");
    expect(applied(await deliver(deps, labelPayload(r, 60, "unlabeled", "boss")))).toEqual({ applied: "proposal_owner_changed", to: "internal_loop", count: 1 });
    expect((await proposal(r, 60))!.owner_process).toBe("internal_loop");
    expect(applied(await deliver(deps, labelPayload(r, 60, "unlabeled", "boss")))).toEqual({ applied: "proposal_owner_changed", to: "internal_loop", count: 0 });
    expect(await audits(r)).toEqual([{ to: "product", permission: "maintain" }, { to: "internal_loop", permission: "maintain" }]);

    // A repository without the engine loop: everything is the product's already, so removing the label hands nothing back.
    const q = await tenant();
    const { deps: noLoop } = await github({ stranger: "read", boss: "admin" }, [issueItem(61, "stranger")], {});
    await deliver(noLoop, openedPayload(q, 61, "stranger"));
    expect((await proposal(q, 61))!.owner_process).toBe("product");
    await deliver(noLoop, labelPayload(q, 61, "unlabeled", "boss"));
    expect((await proposal(q, 61))!.owner_process).toBe("product");
  });

  it("after a decision or a work item the owner stays: unlabel after the proposal is decided, a label after it was rejected, and either once a work item carries the number", async () => {
    const r = await tenant();
    const { deps } = await github({ stranger: "read", boss: "admin" }, [issueItem(70, "stranger"), issueItem(71, "stranger"), issueItem(72, "stranger")]);
    for (const n of [70, 71, 72]) await deliver(deps, openedPayload(r, n, "stranger"));
    await deliver(deps, labelPayload(r, 70, "labeled", "boss"));
    await admin.query(`UPDATE proposals SET state = 'rejected', decided_at = now() WHERE account_id = $1 AND gh_number = 70`, [r.accountId]);
    await deliver(deps, labelPayload(r, 70, "unlabeled", "boss"));
    expect((await proposal(r, 70))!.owner_process).toBe("product");
    await admin.query(`UPDATE proposals SET state = 'rejected', decided_at = now() WHERE account_id = $1 AND gh_number = 71`, [r.accountId]);
    await deliver(deps, labelPayload(r, 71, "labeled", "boss"));
    expect((await proposal(r, 71))!.owner_process).toBe("internal_loop");
    await admin.query(`INSERT INTO work_items (account_id, repo_id, kind, provenance, gh_number) VALUES ($1, $2, 'bug', 'internal', 72)`, [r.accountId, r.repoId]);
    await deliver(deps, labelPayload(r, 72, "labeled", "boss"));
    expect((await proposal(r, 72))!.owner_process).toBe("internal_loop");
    expect(await audits(r)).toEqual([{ to: "product", permission: "admin" }]);
  });

  describe("discovery", () => {
    async function runImport(r: SeedRefs, factory: ReturnType<typeof createPlanSourceFactory>) {
      const principal = { accountId: r.accountId, userId: r.userId };
      const importId = await beginPlanImport(appUserPool, principal, r.repoId);
      const out = await executePlanImport({ pool: appUserPool, principal, repoId: r.repoId, importId, source: factory({ owner: "acme", name: "widgets", repoId: r.repoId } as never) });
      expect(out.state).toBe("succeeded");
      return out;
    }

    it("reads the label's events and the actor's permission now: a maintainer's label flips an existing proposal (a webhook that was missed); a writer's, an unknown actor's and a failing read do not", async () => {
      const r = await tenant();
      const label = (actor: string) => [{ event: "labeled" as const, label: PRODUCT_LABEL, actor }];
      const items = [
        issueItem(1, "stranger", { labels: [PRODUCT_LABEL], events: label("boss") }),
        issueItem(2, "stranger", { labels: [PRODUCT_LABEL], events: label("dev") }),
        issueItem(3, "stranger", { labels: [PRODUCT_LABEL], events: label("ghost") }),
        // Labelled by the maintainer, then unlabelled and relabelled by a writer: the LATEST application counts.
        issueItem(4, "stranger", { labels: [PRODUCT_LABEL], events: [...label("boss"), { event: "unlabeled", label: PRODUCT_LABEL, actor: "boss" }, ...label("dev")] }),
        issueItem(5, "stranger", { labels: ["bug"] }),
        // Carries the label but a maintainer's application sits in a label that is gone now: no current application, so not trusted.
        issueItem(6, "stranger", { labels: [PRODUCT_LABEL], events: [...label("boss"), { event: "unlabeled", label: PRODUCT_LABEL, actor: "boss" }] }),
      ];
      const { factory } = await github({ stranger: "read", boss: "admin", dev: "write" }, items);
      const first = await runImport(r, factory);
      expect(first).toBeTruthy();
      // The first pass creates them: only the maintainer's is the product's from the start, and nothing is audited as a move.
      expect(await Promise.all([1, 2, 3, 4, 5, 6].map(async (n) => (await proposal(r, n))!.owner_process))).toEqual(["product", "internal_loop", "internal_loop", "internal_loop", "internal_loop", "internal_loop"]);
      expect(await audits(r)).toEqual([]);
      // Only issues carrying the label cost events reads: five of them.
      expect(gh!.server.seen.filter((s) => /\/issues\/\d+\/events$/.test(s.path)).map((s) => s.path.split("/")[5])).toEqual(["1", "2", "3", "4", "6"]);
    });

    it("a re-run flips an existing new internal_loop proposal once the label is there, never undoes it, and a failing events read changes nothing and does not fail the import", async () => {
      const r = await tenant();
      const plain = issueItem(1, "stranger");
      const { factory } = await github({ stranger: "read", boss: "maintain" }, [plain]);
      await runImport(r, factory);
      expect((await proposal(r, 1))!.owner_process).toBe("internal_loop");
      plain.labels = [PRODUCT_LABEL];
      plain.events = [{ event: "labeled", label: PRODUCT_LABEL, actor: "boss" }];
      gh!.state.faults.eventsStatus = 500;
      await runImport(r, factory);
      expect((await proposal(r, 1))!.owner_process).toBe("internal_loop");
      gh!.state.faults.eventsStatus = undefined;
      await runImport(r, factory);
      expect(await proposal(r, 1)).toMatchObject({ owner_process: "product", verification: "pending" });
      expect(await audits(r)).toEqual([{ to: "product", permission: "maintain" }]);
      // The label goes away on GitHub: the proposal stays the product's (an unlabel is the webhook's undo, never discovery's).
      plain.labels = [];
      await runImport(r, factory);
      expect((await proposal(r, 1))!.owner_process).toBe("product");
      expect(await audits(r)).toHaveLength(1);
    });
  });
});
