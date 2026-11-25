import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MachineJob, SetupProgressBody, type MachineJobOf } from "@fulcrumaxe/runner-protocol";
import { createStepReporter } from "../../src/daemon/machineJobs.js";
import { applyBundle } from "../../src/daemon/vmBundle.js";
import { buildWorkspaceArchive } from "../../src/daemon/vmArchive.js";
import { createEngineUpdateHandler } from "../../src/setup/engineUpdate.js";
import { BOOTSTRAP, COLDSTART, FINALIZE, UPDATE_COMMIT } from "../../src/setup/guestScripts.js";
import type { SetupRepos } from "../../src/setup/projectSetup.js";
import { workflowPolicy } from "../../src/setup/setupPolicy.js";
import { VmRegistry, type VmPort } from "../../src/vm/jobLifecycle.js";
import type { SdkSandbox } from "../../src/vm/sandboxd/sdkSlice.js";
import { fixtureEngineTgz, type FixtureEngineOptions } from "../helpers/fixtureEngine.js";
import { pushWorld, type PushWorld } from "../helpers/pushWorld.js";
import { compact, serveBytes } from "../helpers/setupWorld.js";
import { fixtureRepo, git, hostDeps, hostWorkspace, localGuest } from "../vm/workspace/helpers.js";

/**
 * D#845 ON-15b, the `engine_update` handler against a LOCAL guest (real sh, bash, git, tar in a directory standing for the guest) and a strict stand-in cloud: the progress route parses every body with the
 * protocol's schema, the cloud has NO plan route (a handler that asked for a plan would not compile here), and the push goes to a git server that answers only to the one repository's token. The engine fixture
 * ships a coldstart and a generator too, so a handler that ran either would leave their files in the tree.
 */
const dirs: string[] = [];
const worlds: PushWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(options: { engine?: FixtureEngineOptions; branch?: string; knownRepo?: boolean; token?: (n: number) => string | undefined } = {}) {
  const fx = fixtureRepo();
  const engine = fixtureEngineTgz(options.engine);
  const job = MachineJob.parse({
    v: 1, job_id: randomUUID(), runner_id: randomUUID(), repo_gh_id: 77, setup_id: randomUUID(), requires_engine: "any", issued_at: "2026-11-25T12:00:00.000Z", expires_at: "2026-11-25T12:10:00.000Z", kind: "engine_update",
    args: { engine: { version: "1.2.4", commit_sha: "a".repeat(40), tarball_url: `https://codeload.github.com/acme/engine/tar.gz/${"a".repeat(40)}`, tarball_sha256: createHash("sha256").update(engine).digest("hex") }, branch: "fx/engine-update-1.2.4" },
  }) as MachineJobOf<"engine_update">;
  // a job that names another branch is not schema-valid; the handler must refuse it anyway (the cloud cannot limit the credential to one branch)
  if (options.branch !== undefined) (job.args as { branch: string }).branch = options.branch;
  const progress: SetupProgressBody[] = [];
  // the cloud ends an update job on `push` ok with a head: a report that arrives after it is refused there, so it is counted here (and the stand-in refuses it as the cloud does)
  const late: SetupProgressBody[] = [];
  let endedByPush = false;
  const client = {
    async setupProgress(_id: string, body: unknown) {
      const parsed = SetupProgressBody.parse(body);
      if (endedByPush) {
        late.push(parsed);
        return { kind: "refused" as const, status: 409 as const, code: "job_not_running" };
      }
      progress.push(parsed);
      if (parsed.sub_step === "push" && parsed.state === "ok" && parsed.head_sha !== undefined) endedByPush = true;
      return { kind: "recorded" as const };
    },
  };
  const ended = new AbortController();
  const reporter = createStepReporter({ client }, job, ended);
  const guest = localGuest();
  const realRun = guest.guest.runCommand.bind(guest.guest);
  // the local guest is this machine: its PATH and HOME would hide git and python here, so they are not applied (see projectSetup.test.ts)
  const wrapped = { ...guest.guest, runCommand: (params: Parameters<SdkSandbox["runCommand"]>[0]) => realRun({ ...params, env: Object.fromEntries(Object.entries(params.env ?? {}).filter(([name]) => name !== "PATH" && name !== "HOME")) }) } as unknown as SdkSandbox;
  const vmCalls: string[] = [];
  const port: VmPort = { create: async (_id, kind) => void vmCalls.push(`create:${kind}`), startEgress: async () => undefined, waitGuest: async () => undefined, releaseEgress: async () => undefined, stop: async () => undefined, destroy: async () => undefined, delete: async () => void vmCalls.push("delete") };
  const deps = hostDeps();
  const hostWs = hostWorkspace(fx.mirror, fx.commit);
  const repos: SetupRepos & { opened: Array<{ baseSha: string; mode: string }> } = {
    opened: [],
    async open(input) {
      repos.opened.push({ baseSha: input.baseSha, mode: input.mode });
      return { mirrorDir: fx.mirror, workspace: hostWs, archive: await buildWorkspaceArchive(deps, fx.mirror, input.baseSha), release: async () => undefined };
    },
  };
  const push = await pushWorld({ seed: { repo: fx.repo, branch: "main" }, ...(options.token === undefined ? {} : { token: options.token }) });
  worlds.push(push);
  const logDir = mkdtempSync(path.join(tmpdir(), "fx-update-log-"));
  dirs.push(logDir);
  await createEngineUpdateHandler({
    vm: { guestOf: async () => wrapped, lifecycle: { port, registry: new VmRegistry(), caps: { maxVms: 2, maxVcpus: 2, maxMemoryMb: 2048, snapshotDir: "/unused", snapshotQuotaBytes: 0 }, request: { vcpus: 1, memoryMb: 512 }, readMemAvailableBytes: () => 64 * 2 ** 30, token: { needed: () => true, slot: () => undefined } } },
    repos,
    repoOf: async () => (options.knownRepo === false ? undefined : { owner: "acme", name: "Widgets.Service" }),
    baseOf: async () => fx.commit,
    apply: (input) => applyBundle({ git: deps.git, gitLarge: deps.gitLarge, scratchDir: deps.scratchDir, policy: workflowPolicy(deps.gitLarge) }, input),
    logDir, push: push.deps, transport: serveBytes(engine), paths: guest.paths,
  })({ job, reporter, signal: ended.signal });
  return { progress, late, guest, push, fx, hostWs, repos, vmCalls, job };
}

const BEFORE = ["engine_fetch:started", "engine_fetch:ok", "sandbox_boot:started", "sandbox_boot:ok", "workspace_in:started", "workspace_in:ok", "bootstrap:started", "bootstrap:ok"];

describe("engine_update", () => {
  it("reports its steps in order and ends on push ok, with the pushed commit on the update branch only", async () => {
    const r = await run();
    expect(compact(r.progress)).toEqual([...BEFORE, "finalize:started", "finalize:ok", "bundle_out:started", "bundle_out:ok", "push:started", "push:ok"]);
    expect(r.progress.map((p) => p.seq)).toEqual(r.progress.map((_, i) => i));
    const head = git(r.hostWs, "rev-parse", "HEAD");
    expect(r.progress.at(-1)).toMatchObject({ sub_step: "push", state: "ok", head_sha: head });
    // nothing at all is reported after push ok: the cloud has already ended the job as done
    expect(r.late).toEqual([]);
    expect(r.push.tip("fx/engine-update-1.2.4")).toBe(head);
    expect(r.push.tip("main")).toBe(r.fx.commit);
    expect(r.push.tip("fx/engine-install-1.2.4")).toBeNull();
    // one commit on the default branch's tip, with the job's own time and the update's message
    expect(git(r.hostWs, "rev-list", "--count", `${r.fx.commit}..HEAD`)).toBe("1");
    expect(git(r.hostWs, "log", "-1", "--format=%an|%s|%aI")).toBe("fulcrumaxe|Update the fulcrumaxe engine to 1.2.4|2026-11-25T12:00:00Z");
    expect(r.repos.opened).toEqual([{ baseSha: r.fx.commit, mode: "pr" }]);
    expect(r.push.asked).toHaveLength(1);
    expect(r.push.asked[0]?.jobId).toBe(r.job.job_id);
    expect(r.push.revoked).toHaveLength(1);
    expect(r.vmCalls.filter((c) => c.startsWith("create"))).toEqual(["create:agent"]);
  }, 60_000);

  it("runs the engine's bootstrap line and one commit command: no coldstart, no generator, no plan", async () => {
    const r = await run();
    const all = [BOOTSTRAP, COLDSTART, FINALIZE, UPDATE_COMMIT];
    const scripts = r.guest.sent.commands.filter((c) => c.cmd === "sh" && all.includes(c.args[1] ?? ""));
    expect(scripts.map((c) => all.indexOf(c.args[1] as string))).toEqual([0, 3]);
    expect(scripts[0]?.args.slice(3)).toEqual([r.guest.paths.workspace, r.guest.paths.stage, "fx/engine-update-1.2.4", "acme/Widgets.Service"]);
    expect(scripts[1]?.args.slice(3)).toEqual([r.guest.paths.workspace, r.guest.paths.stage, "1.2.4", "1795608000 +0000", r.fx.commit]);
    expect(BOOTSTRAP).toContain('bash "$E/loop-bootstrap/bootstrap.sh" --repo "$REPO" --branch "$BRANCH" "$W"');
    expect(UPDATE_COMMIT).not.toMatch(/coldstart|generate\.py/);
    // what the fixture's coldstart and generator write is not in the tree; what its bootstrap writes is
    const files = git(r.hostWs, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    expect(files).toContain(".autonomous-team/project.json");
    for (const absent of [".autonomous-team/wired.json", ".autonomous-team/config.json", "docs/PRD.md", "epics/01-A1.md"]) expect(files).not.toContain(absent);
    expect(r.guest.sent.files.map((f) => path.basename(f.path)).filter((n) => n.startsWith("plan-"))).toEqual([]);
  }, 60_000);

  it("a push the cloud will not give a credential for ends push_failed with its reason, and nothing reaches the remote", async () => {
    const r = await run({ token: () => undefined });
    expect(compact(r.progress).slice(-3)).toEqual(["bundle_out:ok", "push:started", "push:failed:push_failed/token_refused"]);
    expect(r.push.tip("fx/engine-update-1.2.4")).toBeNull();
    expect(r.push.tip("main")).toBe(r.fx.commit);
  }, 60_000);

  it("a bootstrap that fails is bootstrap_failed, with no commit, no bundle and no push credential asked", async () => {
    const r = await run({ engine: { bootstrapExit: 5 } });
    expect(compact(r.progress)).toEqual([...BEFORE.slice(0, 7), "bootstrap:failed:bootstrap_failed/exit"]);
    expect(r.push.asked).toHaveLength(0);
    expect(r.vmCalls.at(-1)).toBe("delete");
  }, 60_000);

  it.each(["main", "fx/engine-install-1.2.4", "fx/engine-update-1.2.4/../main", "fx/engine-update-x"])("a job naming %s is refused before anything starts: no VM, no guest command, no credential, nothing pushed", async (branch) => {
    const r = await run({ branch });
    expect(compact(r.progress)).toEqual(["engine_fetch:failed:push_failed/branch"]);
    expect(r.vmCalls).toEqual([]);
    expect(r.guest.sent.commands).toEqual([]);
    expect(r.push.asked).toHaveLength(0);
    expect(r.push.tip("main")).toBe(r.fx.commit);
    expect(r.push.tip(branch)).toBe(branch === "main" ? r.fx.commit : null);
  }, 60_000);

  it("a repository this machine has no mirror of fails workspace_in and sends nothing to the guest", async () => {
    const r = await run({ knownRepo: false });
    expect(compact(r.progress).at(-1)).toBe("workspace_in:failed:vm_workspace_failed/repo");
    expect(r.guest.sent.commands).toEqual([]);
    expect(r.push.asked).toHaveLength(0);
  }, 60_000);
});
