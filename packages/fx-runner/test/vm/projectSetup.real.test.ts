import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { freemem } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceArchive } from "../../src/daemon/vmArchive.js";
import { applyBundle } from "../../src/daemon/vmBundle.js";
import { createProjectSetupHandler, type SetupRepos } from "../../src/setup/projectSetup.js";
import { projectSetupPolicy, workflowPolicy } from "../../src/setup/setupPolicy.js";
import type { BootDigests, TargetListing } from "../../src/vm/bootGate.js";
import { parseEgressPolicy } from "../../src/vm/egress/policy.js";
import { startEgressProxy } from "../../src/vm/egress/proxy.js";
import { startReverseEndpoint } from "../../src/vm/egress/reverse.js";
import { VmRegistry, vmPortOf } from "../../src/vm/jobLifecycle.js";
import type { Arch } from "../../src/vm/lock.js";
import { createHelperClient } from "../../src/vm/sandboxd/helperClient.js";
import { createMicrovmSandbox } from "../../src/vm/sandboxd/microvmSandbox.js";
import { createEgressPolicyPort } from "../../src/vm/sandboxd/policyPort.js";
import { createProductionSandboxd } from "../../src/vm/sandboxd/production.js";
import { createDaemonSdk, sandboxIdOf } from "../../src/vm/sandboxd/sdkAdapter.js";
import { fixtureEngineTgz, type FixtureEngineOptions } from "../helpers/fixtureEngine.js";
import { compact, fakeCloud, serveBytes } from "../helpers/setupWorld.js";
import { connectUnix } from "./sandboxd/helpers.js";
import { fixtureRepo, git, hostDeps, hostWorkspace } from "./workspace/helpers.js";

/**
 * D#845 ON-8d against a REAL microVM: a whole project setup, from the engine archive and the plan through the three guest commands to the verified tree in the host copy. The stand-ins are the least that can be: the cloud
 * (its plan route and its progress route, strict on every body), the network that serves the engine archive (the host check is the code's own), and the ENGINE, a fixture release archive that follows the
 * non-interactive coldstart contract. Everything between is production code: `createProjectSetupHandler`, `runVmJob` over the production VM port and daemon, the real helper, the real egress policy port with the
 * real proxy, the guest crossing in and out and `applyBundle` with the setup's bundle policy.
 *
 * The environment is the same as `workspaceCrossing.real.test.ts` (a dispatched `microvm-image.yml` host sets it); anywhere else the suite says so and skips. It runs as the ordinary user, never as root.
 * Reaching the package hosts from inside the guest needs the guest-side CONNECT relay, which the relay PRs (#1161, #1162) add; this suite checks the template the real policy port took, and the guest-side reachability waits for them.
 */
const env = { helper: process.env["FX_VM_HELPER_SOCKET"], template: process.env["FX_VM_TEMPLATE"], facts: process.env["FX_VM_BOOT_FACTS"] };
const ready = env.helper !== undefined && env.template !== undefined && env.facts !== undefined && process.geteuid !== undefined && process.geteuid() !== 0 && freemem() > 2.5 * 2 ** 30;
if (!ready) console.warn("projectSetup.real: FX_VM_HELPER_SOCKET, FX_VM_TEMPLATE and FX_VM_BOOT_FACTS are not all set (or this is root, or memory is low); the real-VM project setup suite is skipped");

const BEFORE = ["engine_fetch:started", "engine_fetch:ok", "plan_fetch:started", "plan_fetch:ok", "sandbox_boot:started", "sandbox_boot:ok", "workspace_in:started", "workspace_in:ok", "bootstrap:started", "bootstrap:ok"];
const CORE = ["preflight:started", "preflight:ok", "interview:started", "interview:ok", "wiring:started", "wiring:ok", "deps:started", "deps:ok", "labels:skipped:cloud_owned", "sandbox_hook:started", "sandbox_hook:ok", "bundle:ok", "done:ok"];

async function setup(engineOptions: FixtureEngineOptions, fx = fixtureRepo()) {
  const facts = JSON.parse(readFileSync(env.facts as string, "utf8")) as { arch: Arch; digests: BootDigests; listing: TargetListing };
  const uid = process.geteuid?.() ?? -1;
  const daemon = createProductionSandboxd({ helperSocket: env.helper as string, host: { euid: uid, platform: process.platform }, boot: { listTargets: async () => facts.listing, facts: () => ({ arch: facts.arch, digests: facts.digests }) } });
  const helper = createHelperClient(connectUnix(env.helper as string));
  const policy = createEgressPolicyPort({ helper, uid, egress: { startProxy: startEgressProxy, startReverse: startReverseEndpoint } });
  const sdk = createDaemonSdk({ daemon, policy, template: env.template as string, memMb: 512 });
  const port = createMicrovmSandbox({ sdk, makeRuntime: () => { throw new Error("a project setup starts no agent"); } });
  const handleOf = (name: string) => ({ runId: "", sandboxName: name, sessionId: "" });
  const made = new Set<string>();
  const vmPort = vmPortOf({ sandbox: { createSandbox: async (opts) => (made.add(sandboxIdOf(opts.sandboxName)), port.createSandbox(opts)), stop: (h) => port.stop(h), deleteSandbox: (h) => port.deleteSandbox(h) }, timeoutMs: 20 * 60_000, startEgress: async () => undefined, releaseEgress: (id) => policy.release(sandboxIdOf(id)), waitGuest: async (id) => void (await port.guestOf(handleOf(id))), destroy: (id) => port.deleteSandbox(handleOf(id)) });

  const engine = fixtureEngineTgz(engineOptions);
  const world = fakeCloud({ engine, baseSha: fx.commit });
  const policies: unknown[] = [];
  const deps = hostDeps();
  const hostWs = hostWorkspace(fx.mirror, fx.commit);
  const repos: SetupRepos = { open: async () => ({ mirrorDir: fx.mirror, workspace: hostWs, archive: await buildWorkspaceArchive(deps, fx.mirror, fx.commit), release: async () => undefined }) };
  const handler = createProjectSetupHandler({
    client: world.client,
    vm: { guestOf: async (handle) => { const guest = await port.guestOf(handle); return { ...guest, name: guest.name, status: guest.status, runCommand: guest.runCommand.bind(guest), writeFiles: guest.writeFiles.bind(guest), updateNetworkPolicy: async (policy: unknown) => { const answered = await guest.updateNetworkPolicy(policy); policies.push(policy); return answered; } } as typeof guest; }, lifecycle: { port: vmPort, registry: new VmRegistry(), caps: { maxVms: 2, maxVcpus: 2, maxMemoryMb: 2048, snapshotDir: "/unused", snapshotQuotaBytes: 0 }, request: { vcpus: 1, memoryMb: 512 }, readMemAvailableBytes: () => freemem() } },
    repos,
    apply: (input) => applyBundle({ git: deps.git, gitLarge: deps.gitLarge, scratchDir: deps.scratchDir, policy: workflowPolicy(deps.gitLarge) }, input),
    logDir: path.join(deps.scratchDir, "log"),
    transport: serveBytes(engine),
  });
  await handler({ job: world.job, reporter: world.reporter, signal: world.signal });
  const left = (await helper.list()).map((entry) => entry.sandboxId).filter((id) => made.has(id));
  // the guest's own text is in the local log only; it is shown with a failed assertion so a dispatched run explains itself
  let log = "";
  try {
    for (const name of readdirSync(path.join(deps.scratchDir, "log"))) log += readFileSync(path.join(deps.scratchDir, "log", name), "utf8");
  } catch {
    // fx-swallow-ok: no log means nothing to show
  }
  return { world, hostWs, fx, left, log, policies };
}

describe.skipIf(!ready)("a project setup in a real microVM", () => {
  it("runs the engine archive and the plan through bootstrap, coldstart and finalize in the guest, reports every step in order, and brings back one verified commit; the real egress policy port took the closed package-host template", async () => {
    const r = await setup({});
    expect(compact(r.world.progress), r.log).toEqual([...BEFORE, ...CORE, "finalize:started", "finalize:ok", "bundle_out:started", "bundle_out:ok"]);
    expect(r.world.progress.map((p) => p.seq)).toEqual(r.world.progress.map((_, i) => i));
    expect(r.world.progress[r.world.progress.length - 1]?.bundle_bytes).toBeGreaterThan(0);
    expect(git(r.hostWs, "rev-list", "--count", `${r.fx.commit}..HEAD`)).toBe("1");
    expect(git(r.hostWs, "log", "-1", "--format=%an|%s"), "one commit with the fixed identity").toBe("fulcrumaxe|Install the fulcrumaxe engine 1.2.3");
    const files = git(r.hostWs, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    expect(files).toEqual(expect.arrayContaining([".autonomous-team/config.json", ".autonomous-team/CLAUDE.project.md", ".autonomous-team/roadmap.json", "docs/PRD.md", "epics/01-A1.md", "README.md"]));
    // the real egress policy port took the closed template for the real VM (it parses and enforces it), exactly once and before the workspace went in: the three package hosts and nothing else
    expect(r.policies).toEqual([projectSetupPolicy()]);
    expect(parseEgressPolicy(r.policies[0]).hosts.size).toBe(3);
    expect(r.left, "the setup's VM was ended").toEqual([]);
  }, 600_000);

  it("a guest that changes a workflow file is refused bundle_refused/workflow, the host copy is as it was, and the VM is ended", async () => {
    const fx = fixtureRepo((dir) => {
      execFileSync("mkdir", ["-p", path.join(dir, ".github", "workflows")]);
      execFileSync("sh", ["-c", `echo 'name: ci' > "${path.join(dir, ".github", "workflows", "ci.yml")}"`]);
    });
    const r = await setup({ extraWrite: 'echo "# edited" >>"$P/.github/workflows/ci.yml"' }, fx);
    expect(compact(r.world.progress).at(-1)).toBe("bundle_out:failed:bundle_refused/workflow");
    expect(git(r.hostWs, "rev-parse", "HEAD")).toBe(fx.commit);
    expect(git(r.hostWs, "status", "--porcelain")).toBe("");
    expect(r.left).toEqual([]);
  }, 600_000);

  it("an engine that drops a core topic ends missing_topic:<id>, with no finalize and no bundle", async () => {
    const r = await setup({ coreTopics: ["identity", "stack", "deploy", "autonomy", "mission", "roster"] });
    expect(compact(r.world.progress)).toEqual([...BEFORE, "preflight:started", "preflight:ok", "interview:started", "interview:failed:missing_topic:roster"]);
    expect(git(r.hostWs, "rev-parse", "HEAD")).toBe(r.fx.commit);
    expect(r.left).toEqual([]);
  }, 600_000);
});
