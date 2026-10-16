/**
 * `plan` and `run` with packs that need sessions: where the network needs are probed (only `run`, only for packs
 * about to start, only against a deployment that identified as staging), what a pack is handed, and the exit codes.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStrictGithubServer, type LocalTlsServer } from "../../../packages/github/test/helpers/localTlsServer.js";
import { ghError, type GhReply, type GhRequest } from "../../../packages/github/test/helpers/strictGithub.js";
import { main, type Io } from "../src/cli.js";
import type { Plan } from "../src/plan.js";
import type { Invocation } from "../src/run.js";
import { MaskRegistry } from "../src/mask.js";
import { putRole, readStore, storePath } from "../src/store.js";
import { CHEAPEST_MODEL, FIXTURE_BASELINE_TAG } from "../src/needs-network.js";
import { BYPASS_VALUE, FakeApp, signSession } from "./session-helpers.js";
import { makeIo, makePack, scratchRoot, tmpDir } from "./helpers.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const D = 86_400_000;
const keyBytes = randomBytes(32);
const STAGING = "https://staging.example.test";
const REPO_ID = "11111111-1111-4111-8111-111111111111";
const FIXTURE = "test-org/fixture";

const TOKEN = ["fixture", "token", "for", "tests", "0002"].join("-"); // gitleaks:allow
const openServers: LocalTlsServer[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

/** A local TLS stand-in for the code host that has the fixture repo's baseline tag, so `test-repo` is met (caps-set needs it). */
async function testRepoHost(): Promise<{ env: Record<string, string>; githubCa: string }> {
  const server = await startStrictGithubServer((req: GhRequest): GhReply =>
    req.headers["authorization"] !== `Bearer ${TOKEN}` ? ghError(401, "Bad credentials") : req.path === `/repos/${FIXTURE}/git/ref/tags/${FIXTURE_BASELINE_TAG}` ? { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: `refs/tags/${FIXTURE_BASELINE_TAG}` }) } : ghError(404, "Not Found"));
  openServers.push(server);
  return { env: { LIVE_E2E_FIXTURE_REPO_TOKEN: TOKEN, GITHUB_API_URL: `https://127.0.0.1:${server.port}` }, githubCa: server.ca };
}

async function rig(world: { perRun?: number } = {}, extraPacks: Record<string, string[]> = {}, opts: { testRepo?: boolean } = {}) {
  const host = opts.testRepo === false ? undefined : await testRepoHost();
  const home = tmpDir();
  await putRole(storePath(home, "staging"), "staging", keyBytes, "owner", signSession({ sid: "s1", sessionStart: NOW - 2 * D, lastSeenAt: NOW - 3_600_000 }));
  const app = new FakeApp(STAGING, () => NOW);
  app.open["/api/health"] = () => ({ ok: true, deploy_env: "staging", project_id: "prj_Staging1", commit: "abcdef1" });
  app.api["/api/v1/repos"] = () => ({ data: [{ id: REPO_ID, product: "p", gh_repo_id: 1, install_state: "installed", app_kind: "team", full_name: FIXTURE }], next_cursor: null });
  app.api["/api/v1/model-connection"] = () => ({ status: "ok" });
  app.api["/api/v1/run-limits"] = () => ({ default: { resolved: { per_run_usd: world.perRun ?? 0, max_run_minutes: 20 } }, roles: [] });
  app.api["/api/v1/budgets"] = () => ({ model_usd_month: 30 });
  app.api[`/api/v1/repos/${REPO_ID}/roles`] = () => ({ data: [{ role: "executor", model: CHEAPEST_MODEL, model_floor: null }] });
  const pack = (id: string, needs: string[]) => makePack({ id, needs, tier: "smoke", destructive: false });
  // `spends` leaves out `sandbox` on purpose: the manifest rejects a sandbox pack without test-repo, and a passing
  // test-repo probe needs a GitHub fake. The R-441-T3-21 tests below pass `extraPacks` (replacing these) for sandbox packs.
  const defaults = [pack("reads-only", ["bypass"]), pack("signed-in", ["bypass", "session:owner"]), pack("spends", ["bypass", "session:owner", "github-app:team", "model-key", "caps-set"])];
  const given = Object.entries(extraPacks).map(([id, needs]) => pack(id, needs));
  const root = scratchRoot(given.length > 0 ? given : defaults);
  const started: Invocation[] = [];
  const { io, out, err } = makeIo(root, { HOME: home, LIVE_E2E_SESSION_KEY: keyBytes.toString("base64"), VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS_VALUE, LIVE_E2E_FIXTURE_REPO: FIXTURE, ...host?.env });
  const full: Io = { ...io, ...(host ? { githubCa: host.githubCa } : {}), fetch: app.fetch, now: () => NOW, cli: "/pw/cli.js", exec: async (inv) => (started.push(inv), { code: 0, output: "" }) };
  const plan = (): Plan => JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as Plan;
  return { io: full, out, err, app, started, plan, home, root };
}

describe("plan stays offline", () => {
  it("lists a pack that needs a session as SKIPPED-NEED, exits 0, and makes no request", async () => {
    const r = await rig();
    expect(await main(["plan", "--target", "staging", "--tier", "smoke"], r.io)).toBe(0);
    expect(r.out).toEqual(expect.arrayContaining(["reads-only: RUN", "signed-in: SKIPPED-NEED session:owner", "spends: SKIPPED-NEED session:owner"]));
    expect(r.app.seen).toEqual([]);
  });
});

describe("run probes the network needs", () => {
  it("starts the packs whose needs are met, hands the session key only to a pack that declares a session need, and writes the cookie back", async () => {
    const r = await rig();
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], r.io)).toBe(0);
    expect(r.plan().packs.map((p) => `${p.id}:${p.outcome}`)).toEqual(["reads-only:RUN", "signed-in:RUN", "spends:RUN"]);
    const env = Object.fromEntries(r.started.map((i) => [i.packId, i.env]));
    expect(env["reads-only"]?.["LIVE_E2E_SESSION_KEY"]).toBeUndefined();
    expect(env["signed-in"]?.["LIVE_E2E_SESSION_KEY"]).toBe(keyBytes.toString("base64"));
    expect(env["signed-in"]?.["HOME"]).toBe(r.home);
    expect(env["spends"]?.["LIVE_E2E_FIXTURE_REPO"]).toBeUndefined();
    expect(r.app.seen.filter((s) => s.url.endsWith("/api/cloud/auth/me"))).toHaveLength(1);
  });

  it("a session that is not stored skips the packs that need it (green) and still runs the rest", async () => {
    const r = await rig();
    const env = { ...r.io.env, HOME: tmpDir() };
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], { ...r.io, env })).toBe(0);
    expect(r.plan().skipped.map((s) => `${s.id}:${s.need}`)).toEqual(["signed-in:session:owner", "spends:session:owner"]);
    expect(r.started.map((i) => i.packId)).toEqual(["reads-only"]);
  });

  it("REFUSED caps is not started and exits non-zero even though no pack was named", async () => {
    const r = await rig({ perRun: 40 });
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], r.io)).toBe(1);
    expect(r.plan().refused).toEqual([{ id: "spends", reason: "caps", named: false }]);
    expect(r.err.join("\n")).toContain("REFUSED caps (pack spends)");
    expect(r.started.map((i) => i.packId)).toEqual(["reads-only", "signed-in"]);
  });

  it("a deployment that does not identify as staging is refused before any login is used", async () => {
    const r = await rig();
    r.app.open["/api/health"] = () => ({ ok: true, deploy_env: "production", project_id: "prj_Staging1", commit: "abcdef1" });
    await main(["run", "--target", "staging", "--tier", "smoke"], r.io);
    expect(r.plan().refused.map((x) => `${x.id}:${x.reason}`)).toEqual(["reads-only:layer2-deploy-env-not-staging", "signed-in:layer2-deploy-env-not-staging", "spends:layer2-deploy-env-not-staging"]);
    expect(r.started).toEqual([]);
    expect(r.app.seen.filter((s) => s.headers["cookie"] !== undefined)).toEqual([]);
  });

  it("a fixture repo name that is set but malformed is a setup error naming the variable, not a skip; unset is a skip", async () => {
    const r = await rig();
    for (const bad of ["no-slash", "owner/", "ow_ner/repo", "-a/b b", `${"a".repeat(40)}/repo`]) {
      const out = r.out.length;
      expect(await main(["run", "--target", "staging", "--tier", "smoke"], { ...r.io, env: { ...r.io.env, LIVE_E2E_FIXTURE_REPO: bad } }), bad).toBe(2);
      expect(r.err.join("\n")).toContain("LIVE_E2E_FIXTURE_REPO");
      expect(r.out.length).toBe(out);
    }
    expect(r.started).toEqual([]);
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], { ...r.io, env: { ...r.io.env, LIVE_E2E_FIXTURE_REPO: undefined } })).toBe(0);
    expect(r.plan().skipped.map((s) => s.id)).toContain("spends");
  });

  it("signin:scripted is skipped for every role, whatever else the pack needs", async () => {
    for (const role of ["owner", "member", "outsider", "revoke", "canary"]) {
      const root = scratchRoot([makePack({ id: "scripted", needs: ["signin:scripted", `session:${role}`] })]);
      const { io, out } = makeIo(root, { VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS_VALUE });
      expect(await main(["plan", "--target", "staging", "--tier", "smoke"], io), role).toBe(0);
      expect(out, role).toContain("scripted: SKIPPED-NEED signin:scripted");
    }
  });

  it("a pack that starts from first-sign-in says what that proves", async () => {
    const r = await rig();
    const root = scratchRoot([makePack({ id: "fresh", needs: ["bypass", "session:owner", "fresh-state:first-sign-in"] })]);
    r.app.api["/api/v1/onboarding"] = () => ({ started_at: "x", steps: [{ step: "preview", completed_at: null, skipped: false }] });
    await main(["run", "--target", "staging", "--tier", "smoke"], { ...r.io, root, cwd: root });
    expect(r.out).toContain("fresh: fresh-state:first-sign-in (onboarding untouched)");
  });

  it("a session cookie planted in the store is in neither results.json, the summary, the pack log nor the console after a session pack ran, even when the pack printed it", async () => {
    const r = await rig();
    // The workflow gives the run a mask file, so values registered while probing reach the scrub of the run's artifacts.
    const maskFile = join(tmpDir(), "mask");
    new MaskRegistry({ emit: () => undefined, file: maskFile, create: true });
    // A cookie whose shape the scrub's JWT pattern would not catch by itself (its header is not a JSON object), so only the
    // registration of the stored value keeps it out of the artifacts.
    const planted = signSession({ sid: "planted", sessionStart: NOW - 2 * D, lastSeenAt: NOW - 1_000 }, "plantedheaderthatisnotjson");
    await putRole(storePath(r.home, "staging"), "staging", keyBytes, "owner", planted);
    const leaky: Io = {
      ...r.io,
      env: { ...r.io.env, LIVE_E2E_MASK_FILE: maskFile },
      exec: async (inv) => (r.started.push(inv), { code: inv.packId === "signed-in" ? 1 : 0, output: `debug: value ${planted} (pack ${inv.packId})\n` }),
    };
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], leaky)).toBe(1); // the signed-in pack "failed", so its output is in the report path
    expect(r.started.map((i) => i.packId)).toContain("signed-in");
    const files = ["results.json", "summary.md", ...readdirSync(join(r.root, "logs")).map((n) => join("logs", n))];
    expect(files.length).toBeGreaterThan(3);
    const seen = [...files.map((f) => readFileSync(join(r.root, f), "utf8")), ...[...r.out, ...r.err].filter((l) => !l.startsWith("::add-mask::"))].join("\n");
    expect(seen).not.toContain(planted);
    for (const part of planted.split(".")) expect(seen).not.toContain(part);
    // The cookie the app refreshed it to is not there either.
    const stored = readStore(storePath(r.home, "staging"), "staging", keyBytes)["owner"] as string;
    expect(stored).not.toBe(planted);
    expect(seen).not.toContain(stored);
  });

  it("probes nothing for a pack that is not selected", async () => {
    const r = await rig();
    expect(await main(["run", "--target", "staging", "--pack", "reads-only"], r.io)).toBe(0);
    expect(r.app.seen.filter((s) => s.url.includes("/api/v1/") || s.url.includes("/auth/me"))).toEqual([]);
  });
});

describe("caps-set when no read can be attempted (R-441-T3-21)", () => {
  // The three reads a caps-set check makes; the app is asked for them only with the owner session AND the fixture repo.
  const capReads = (r: Awaited<ReturnType<typeof rig>>) => r.app.seen.filter((s) => /\/api\/v1\/(run-limits|budgets|repos\/[^/]+\/roles)/.test(s.url));
  const appCalls = (r: Awaited<ReturnType<typeof rig>>) => r.app.seen.filter((s) => s.url.includes("/api/v1/") || s.url.includes("/auth/me"));
  const SANDBOX = ["bypass", "session:owner", "test-repo", "model-key", "caps-set", "sandbox"];

  it("no owner session, fixture repo set: SKIPPED-NEED session:owner, exit 0, no request to the app, nothing started", async () => {
    const r = await rig({}, { sandboxed: SANDBOX });
    const env = { ...r.io.env, HOME: tmpDir() };
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], { ...r.io, env })).toBe(0);
    expect(r.out).toContain("sandboxed: SKIPPED-NEED session:owner");
    expect(r.out.join("\n")).not.toContain("caps");
    expect(appCalls(r)).toEqual([]);
    expect(r.started).toEqual([]);
  });

  it("owner session present, fixture variable unset: SKIPPED-NEED test-repo, exit 0, none of the three cap reads is made", async () => {
    const r = await rig({}, { sandboxed: SANDBOX });
    const env = { ...r.io.env, LIVE_E2E_FIXTURE_REPO: undefined };
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], { ...r.io, env })).toBe(0);
    expect(r.out).toContain("sandboxed: SKIPPED-NEED test-repo");
    expect(capReads(r)).toEqual([]);
    expect(r.started).toEqual([]);
  });

  it("owner session present, fixture variable set but the fixture token missing: SKIPPED-NEED test-repo, exit 0, none of the three cap reads is made", async () => {
    const r = await rig({}, { sandboxed: SANDBOX }, { testRepo: false });
    expect(r.io.env["LIVE_E2E_FIXTURE_REPO"]).toBe(FIXTURE);
    expect(r.io.env["LIVE_E2E_FIXTURE_REPO_TOKEN"]).toBeUndefined();
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], r.io)).toBe(0);
    expect(r.out).toContain("sandboxed: SKIPPED-NEED test-repo");
    expect(capReads(r)).toEqual([]);
    expect(r.started).toEqual([]);
  });

  it("neither present, a pack that declares only caps-set: SKIPPED-NEED caps-set, exit 0, no request, nothing started", async () => {
    const r = await rig({}, { "caps-only": ["caps-set"] });
    const env = { ...r.io.env, HOME: tmpDir(), LIVE_E2E_FIXTURE_REPO: undefined };
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], { ...r.io, env })).toBe(0);
    expect(r.out).toContain("caps-only: SKIPPED-NEED caps-set");
    expect(appCalls(r)).toEqual([]);
    expect(r.started).toEqual([]);
    expect(r.plan().skipped).toEqual([{ id: "caps-only", need: "caps-set" }]);
  });

  it("a declared order does not change which need a skip names: caps-set listed first still reports the session", async () => {
    const r = await rig({}, { backwards: ["caps-set", "model-key", "session:owner"] });
    const env = { ...r.io.env, HOME: tmpDir() };
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], { ...r.io, env })).toBe(0);
    expect(r.out).toContain("backwards: SKIPPED-NEED session:owner");
  });

  it("both present and one read fails: REFUSED caps (read failed: <endpoint>), exit non-zero, the pack is not started", async () => {
    for (const [path, shown] of [["/api/v1/run-limits", "/api/v1/run-limits"], ["/api/v1/budgets", "/api/v1/budgets"], [`/api/v1/repos/${REPO_ID}/roles`, "/api/v1/repos/{id}/roles"]] as const) {
      const r = await rig({}, { "caps-reader": ["bypass", "session:owner", "caps-set"] });
      r.app.api[path] = () => {
        throw new Error("boom");
      };
      expect(await main(["run", "--target", "staging", "--tier", "smoke"], r.io), path).toBe(1);
      expect(r.out, path).toContain(`caps-reader: REFUSED caps (read failed: ${shown})`);
      expect(r.started, path).toEqual([]);
    }
  });

  it("an app answer with a repo id that cannot be encoded is REFUSED caps (read failed), not a skip", async () => {
    const r = await rig({}, { "caps-reader": ["bypass", "session:owner", "caps-set"] });
    r.app.api["/api/v1/repos"] = () => ({ data: [{ id: "\uD800", product: "p", gh_repo_id: 1, install_state: "installed", app_kind: "team", full_name: FIXTURE }], next_cursor: null });
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], r.io)).toBe(1);
    expect(r.out).toContain("caps-reader: REFUSED caps (read failed: /api/v1/repos/{id}/roles)");
    expect(r.started).toEqual([]);
  });

  it("an app-supplied role or model that is long or odd is shown as <invalid>, never echoed", async () => {
    const r = await rig({}, { "caps-reader": ["bypass", "session:owner", "caps-set"] });
    r.app.api[`/api/v1/repos/${REPO_ID}/roles`] = () => ({ data: [{ role: "x".repeat(65), model: "bad model\nINJECTED line", model_floor: null }] });
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], r.io)).toBe(1);
    expect(r.out).toContain("caps-reader: REFUSED caps (role <invalid>: model <invalid> above haiku-4.5)");
    expect(r.out.join("\n")).not.toContain("INJECTED");
  });

  it("an excess names the field, the value and the limit", async () => {
    const r = await rig({ perRun: 40 }, { "caps-reader": ["bypass", "session:owner", "caps-set"] });
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], r.io)).toBe(1);
    expect(r.out).toContain("caps-reader: REFUSED caps (per_run_usd: 40 above 0)");
  });
});
