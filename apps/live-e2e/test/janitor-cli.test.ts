/**
 * The janitor through the command line: `janitor account` (dry-run by default, `--apply` to write), the owner session
 * and layer 2 in front of it, `plan` listing it, and `run` calling it only when a destructive pack is about to start.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli.js";
import type { Plan } from "../src/plan.js";
import type { Invocation } from "../src/run.js";
import { openOwnerSession } from "../src/janitor/account.js";
import { parseClaims } from "../src/sessions.js";
import { putRole, readStore, storePath } from "../src/store.js";
import { BYPASS_VALUE, signSession } from "./session-helpers.js";
import { makeIo, makePack, makeTarget, scratchRoot, tmpDir, PACKAGE_ROOT, TARGET_ENV } from "./helpers.js";
import { FakeProduct, FIXTURE, FIXTURE_ID, OTHER_ORG_REPO_ID, nonGets, repo, snapshot, spendyState } from "./janitor-helpers.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const D = 86_400_000;
const keyBytes = randomBytes(32);
const STAGING = "https://staging.example.test";

async function rig(opts: { stored?: boolean; packs?: ReturnType<typeof makePack>[] } = {}) {
  const home = tmpDir();
  if (opts.stored !== false) await putRole(storePath(home, "staging"), "staging", keyBytes, "owner", signSession({ sid: "s1", sessionStart: NOW - 2 * D, lastSeenAt: NOW - 3_600_000 }));
  const app = new FakeProduct(STAGING, () => NOW, spendyState());
  const root = scratchRoot(opts.packs ?? [makePack({ id: "reads", needs: ["bypass"] }), makePack({ id: "wipes", needs: ["bypass", "session:owner"], destructive: true, tier: "standard" })]);
  const { io, out, err } = makeIo(root, { HOME: home, LIVE_E2E_SESSION_KEY: keyBytes.toString("base64"), VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS_VALUE, LIVE_E2E_FIXTURE_REPO: FIXTURE });
  const started: Invocation[] = [];
  const full: Io = { ...io, fetch: app.fetch, now: () => NOW, cli: "/pw/cli.js", exec: async (inv) => (started.push(inv), { code: 0, output: "" }) };
  const plan = (): Plan => JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as Plan;
  return { io: full, out, err, app, started, plan, home, root };
}

describe("janitor account", () => {
  it("is a dry-run without --apply: exit 0, the changes printed, nothing written", async () => {
    const r = await rig();
    const before = snapshot(r.app.state);
    expect(await main(["janitor", "account", "--target", "staging"], r.io)).toBe(0);
    expect(r.out.some((l) => l.startsWith("janitor account: would set budgets"))).toBe(true);
    expect(nonGets(r.app)).toEqual([]);
    expect(snapshot(r.app.state)).toBe(before);
  });

  it("--apply writes the baseline and exits 0", async () => {
    const r = await rig();
    expect(await main(["janitor", "account", "--target", "staging", "--apply"], r.io)).toBe(0);
    expect(r.app.state.monthly).toBe(30);
    expect(r.out.at(-1)).toMatch(/change\(s\) applied and read back/);
    expect(r.out.some((l) => l.startsWith("::add-mask::"))).toBe(false);
  });

  it("an account with a repo outside the test org: REFUSED janitor-account-in-use on stderr, exit 1, nothing written", async () => {
    const r = await rig();
    r.app.state.repos.push(repo(OTHER_ORG_REPO_ID, "personal-login/cloud", 2));
    const before = snapshot(r.app.state);
    expect(await main(["janitor", "account", "--target", "staging", "--apply"], r.io)).toBe(1);
    expect(r.err).toEqual(["REFUSED janitor-account-in-use (1 connected repo(s) outside test-org)"]);
    expect(nonGets(r.app)).toEqual([]);
    expect(snapshot(r.app.state)).toBe(before);
  });

  it("no stored owner session: REFUSED janitor-no-session, exit 1, no request after the identity check", async () => {
    const r = await rig({ stored: false });
    expect(await main(["janitor", "account", "--target", "staging", "--apply"], r.io)).toBe(1);
    expect(r.err[0]).toMatch(/^REFUSED janitor-no-session/);
    expect(r.app.seen.map((s) => new URL(s.url).pathname)).toEqual(["/api/health"]);
  });

  it("a deployment that does not identify as staging is refused before the login is used", async () => {
    const r = await rig();
    r.app.open["/api/health"] = () => ({ ok: true, deploy_env: "production", project_id: "prj_Staging1", commit: "abcdef1" });
    expect(await main(["janitor", "account", "--target", "staging", "--apply"], r.io)).toBe(1);
    expect(r.err).toEqual(["REFUSED layer2-deploy-env-not-staging"]);
    expect(r.app.seen.filter((s) => s.headers["cookie"] !== undefined)).toEqual([]);
  });

  it("production is refused before any request, even a read of its health route", async () => {
    const r = await rig();
    expect(await main(["janitor", "account", "--target", "production"], r.io)).toBe(1);
    expect(r.err).toEqual(["REFUSED janitor-not-staging"]);
    expect(r.app.seen).toEqual([]);
  });

  it("announces the cookie mask only in CI (the runner reads it); at a terminal nothing masks-by-printing", async () => {
    const terminal = await rig();
    await main(["janitor", "account", "--target", "staging"], terminal.io);
    expect(terminal.out.filter((l) => l.startsWith("::add-mask::"))).toEqual([]);
    const ci = await rig();
    await main(["janitor", "account", "--target", "staging"], { ...ci.io, env: { ...ci.io.env, GITHUB_ACTIONS: "true" } });
    expect(ci.out.filter((l) => l.startsWith("::add-mask::")).length).toBeGreaterThan(0);
  });

  it("usage errors are exit 2 and send nothing", async () => {
    for (const argv of [["janitor"], ["janitor", "account"], ["janitor", "account", "--target"], ["janitor", "account", "--target", "staging", "--apply", "--apply"], ["janitor", "account", "--target", "staging", "--force"], ["janitor", "account", "--target", "nowhere"]]) {
      const r = await rig();
      expect(await main(argv, r.io), argv.join(" ")).toBe(2);
      expect(r.app.seen).toEqual([]);
    }
  });

  it("a missing fixture variable is REFUSED janitor-no-test-org, not a crash", async () => {
    const r = await rig();
    const env = { ...r.io.env, LIVE_E2E_FIXTURE_REPO: undefined };
    expect(await main(["janitor", "account", "--target", "staging", "--apply"], { ...r.io, env })).toBe(1);
    expect(r.err[0]).toMatch(/^REFUSED janitor-no-test-org/);
    expect(nonGets(r.app)).toEqual([]);
  });

  it("writes the refreshed owner cookie back to the store", async () => {
    const r = await rig();
    await main(["janitor", "account", "--target", "staging"], r.io);
    const cookie = readStore(storePath(r.home, "staging"), "staging", keyBytes)["owner"] as string;
    expect(parseClaims(cookie)?.lastSeenAt).toBe(NOW);
  });

  it("prints no credential", async () => {
    const r = await rig();
    await main(["janitor", "account", "--target", "staging", "--apply"], r.io);
    const all = [...r.out, ...r.err].join("\n");
    expect(all).not.toContain(BYPASS_VALUE);
    expect(all).not.toContain(keyBytes.toString("base64"));
    expect(all).not.toMatch(/__Host-fx_session=/);
  });
});

describe("openOwnerSession", () => {
  const deps = async (cookie?: string) => {
    const home = tmpDir();
    if (cookie !== undefined) await putRole(storePath(home, "staging"), "staging", keyBytes, "owner", cookie);
    const app = new FakeProduct(STAGING, () => NOW, spendyState());
    return { app, d: { target: makeTarget(), targetsDir: join(PACKAGE_ROOT, "targets"), env: { ...TARGET_ENV, HOME: home, LIVE_E2E_SESSION_KEY: keyBytes.toString("base64"), VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS_VALUE }, now: NOW, fetchImpl: app.fetch } };
  };

  it("is null without a stored cookie, with a lapsed one, with a revoked one, and without the key", async () => {
    expect(await openOwnerSession((await deps()).d)).toBeNull();
    expect(await openOwnerSession((await deps(signSession({ sid: "s1", sessionStart: NOW - 2 * D, lastSeenAt: NOW - 25 * 3_600_000 }))).d)).toBeNull();
    const revoked = await deps(signSession({ sid: "gone", sessionStart: NOW - 2 * D, lastSeenAt: NOW - 3_600_000 }));
    revoked.app.revoked.add("gone");
    expect(await openOwnerSession(revoked.d)).toBeNull();
    const ok = await deps(signSession({ sid: "s1", sessionStart: NOW - 2 * D, lastSeenAt: NOW - 3_600_000 }));
    expect(await openOwnerSession({ ...ok.d, env: { ...ok.d.env, LIVE_E2E_SESSION_KEY: undefined } })).toBeNull();
  });

  it("is a usable session otherwise", async () => {
    const ok = await deps(signSession({ sid: "s1", sessionStart: NOW - 2 * D, lastSeenAt: NOW - 3_600_000 }));
    const s = await openOwnerSession(ok.d);
    expect(s).not.toBeNull();
    expect(FIXTURE_ID).toBeDefined();
  });
});

describe("plan and run", () => {
  const BASELINE_LINE = "janitor account: baseline per_run_usd 3, max_model_calls 60, max_run_minutes 20, max_extensions 0, max_resumes 0; model_usd_month 30; role model haiku-4.5 (security-reviewer, security-expert sonnet-5); lowers only";

  it("plan lists the janitor as pending when the destructive pack waits on the owner session (plan is offline), and makes no request", async () => {
    const r = await rig();
    expect(await main(["plan", "--target", "staging", "--tier", "standard"], r.io)).toBe(0);
    expect(r.out).toEqual(expect.arrayContaining(["janitor account: would run before wipes once their needs are met (dry-run: live-e2e janitor account --target staging)", BASELINE_LINE]));
    expect(r.plan().janitors.account).toMatchObject({ needed: false, packs: [], pending: ["wipes"] });
    expect(r.app.seen).toEqual([]);
  });

  it("plan lists the janitor as needed when a destructive pack will run", async () => {
    const r = await rig({ packs: [makePack({ id: "reads", needs: ["bypass"] }), makePack({ id: "wipes", needs: ["bypass"], destructive: true, tier: "standard" })] });
    expect(await main(["plan", "--target", "staging", "--tier", "standard"], r.io)).toBe(0);
    expect(r.out).toEqual(expect.arrayContaining(["janitor account: runs before wipes (dry-run: live-e2e janitor account --target staging)", BASELINE_LINE]));
    expect(r.plan().janitors.account).toMatchObject({ needed: true, packs: ["wipes"], pending: [] });
    expect(r.app.seen).toEqual([]);
  });

  it("plan lists it as not needed when no destructive pack is selected (smoke does not select one)", async () => {
    const r = await rig();
    expect(await main(["plan", "--target", "staging", "--tier", "smoke"], r.io)).toBe(0);
    expect(r.out).toContain("janitor account: not needed (no destructive pack selected)");
    expect(r.plan().janitors.account).toMatchObject({ needed: false, packs: [] });
  });

  it("run: a destructive pack skipped for a missing session does not call the janitor", async () => {
    const r = await rig({ stored: false });
    expect(await main(["run", "--target", "staging", "--tier", "standard"], r.io)).toBe(0);
    expect(r.started.map((i) => i.packId)).toEqual(["reads"]);
    expect(nonGets(r.app)).toEqual([]);
    expect(r.app.seen.some((s) => s.url.includes("/api/v1/"))).toBe(false);
  });

  it("run with no destructive pack never calls the janitor: nothing is read from the account either", async () => {
    const r = await rig();
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], r.io)).toBe(0);
    expect(r.app.seen.some((s) => s.url.includes("/api/v1/"))).toBe(false);
    expect(nonGets(r.app)).toEqual([]);
    expect(r.started.map((i) => i.packId)).toEqual(["reads"]);
  });

  it("run with a destructive pack runs the janitor first (apply), then the pack", async () => {
    const r = await rig();
    expect(await main(["run", "--target", "staging", "--tier", "standard"], r.io)).toBe(0);
    expect(r.app.state.monthly).toBe(30);
    expect(r.started.map((i) => i.packId)).toEqual(["reads", "wipes"]);
    expect(nonGets(r.app).length).toBeGreaterThan(0);
  });

  it("run with a destructive pack and a repo outside the test org: REFUSED, exit 1, no pack starts, nothing written", async () => {
    const r = await rig();
    r.app.state.repos.push(repo(OTHER_ORG_REPO_ID, "personal-login/cloud", 2));
    const before = snapshot(r.app.state);
    expect(await main(["run", "--target", "staging", "--tier", "standard"], r.io)).toBe(1);
    expect(r.err.join("\n")).toContain("REFUSED janitor-account-in-use");
    expect(r.started).toEqual([]);
    expect(nonGets(r.app)).toEqual([]);
    expect(snapshot(r.app.state)).toBe(before);
  });

  it("run when layer 2 fails: the destructive pack is refused by the plan and the janitor never runs", async () => {
    const r = await rig();
    r.app.open["/api/health"] = () => ({ ok: true, deploy_env: "production", project_id: "prj_Staging1", commit: "abcdef1" });
    await main(["run", "--target", "staging", "--tier", "standard"], r.io);
    expect(r.started).toEqual([]);
    expect(nonGets(r.app)).toEqual([]);
    expect(r.app.seen.some((s) => s.url.includes("/api/v1/"))).toBe(false);
  });
});
