import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SETUP_RUNNER_STEPS } from "@fulcrumaxe/runner-protocol";
import { applyBundle } from "../../src/daemon/vmBundle.js";
import { buildWorkspaceArchive } from "../../src/daemon/vmArchive.js";
import { createProjectSetupHandler, type ProjectSetupDeps, type SetupRepos } from "../../src/setup/projectSetup.js";
import { BOOTSTRAP, COLDSTART, FINALIZE } from "../../src/setup/guestScripts.js";
import { PROJECT_SETUP_HOSTS, bundleReasonOf, projectSetupPolicy, workflowPolicy } from "../../src/setup/setupPolicy.js";
import { pullBundle } from "../../src/vm/workspace/bundleOut.js";
import { sendWorkspace } from "../../src/vm/workspace/guestWorkspace.js";
import { guestEnvOf } from "../../src/vm/sandboxd/guestEnv.js";
import { VmRegistry, type VmPort } from "../../src/vm/jobLifecycle.js";
import type { SdkSandbox } from "../../src/vm/sandboxd/sdkSlice.js";
import { DEFAULT_PACK_LIMITS } from "../../src/vm/workspace/packScan.js";
import { fixtureEngineTgz, type FixtureEngineOptions } from "../helpers/fixtureEngine.js";
import { compact, fakeCloud, serveBytes } from "../helpers/setupWorld.js";
import { fixtureRepo, git, hostDeps, hostWorkspace, localGuest, type LocalGuest } from "../vm/workspace/helpers.js";

/**
 * D#845 ON-8d, the whole handler against a LOCAL guest: the three guest commands are real processes (sh, bash, python3, git, tar) in a directory standing for the guest, the engine is a fixture that follows the
 * non-interactive coldstart contract, the host's checks (the archive in, the status stream, the bundle apply with the setup's policy) are the production code, and only the VM factory and the cloud are stand-ins.
 * What a real microVM adds (the real image, the real egress) is `test/vm/projectSetup.real.test.ts`.
 */
const lstatOrNull = (target: string): unknown => {
  try {
    return lstatSync(target);
  } catch {
    // fx-swallow-ok: a test reads "no such file" as null
    return null;
  }
};
const logDirs: string[] = [];
afterEach(() => {
  for (const dir of logDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  progress: ReturnType<typeof fakeCloud>["progress"];
  guest: LocalGuest;
  events: string[];
  vmCalls: string[];
  tokenAsked: number;
  logDir: string;
  hostWs: string;
  fx: ReturnType<typeof fixtureRepo>;
  job: ReturnType<typeof fakeCloud>["job"];
  released: number;
  copyDirs: string[];
}

async function run(options: { engine?: FixtureEngineOptions; fx?: ReturnType<typeof fixtureRepo>; failCreate?: boolean; failPolicy?: boolean; limits?: Partial<typeof DEFAULT_PACK_LIMITS>; logDir?: string; kind?: "existing" | "new" } = {}): Promise<Run> {
  const fx = options.fx ?? fixtureRepo();
  const engine = fixtureEngineTgz(options.engine);
  const world = fakeCloud({ engine, baseSha: fx.commit, issuedAt: "2026-11-21T12:00:00.000Z", ...(options.kind === undefined ? {} : { kind: options.kind }) });
  const guest = localGuest();
  const events: string[] = [];
  const realWrite = guest.guest.writeFiles.bind(guest.guest);
  const realPolicy = guest.guest.updateNetworkPolicy.bind(guest.guest);
  const realRun = guest.guest.runCommand.bind(guest.guest);
  // the local guest is this machine: the guest's own PATH and HOME values would hide git and python here, so they are not applied (every other name in the guest environment is)
  const wrapped = {
    ...guest.guest,
    writeFiles: (files: Parameters<SdkSandbox["writeFiles"]>[0]) => (events.push("writeFiles"), realWrite(files)),
    updateNetworkPolicy: async (policy: unknown) => {
      events.push("policy");
      if (options.failPolicy === true) throw new Error("refused");
      return realPolicy(policy);
    },
    runCommand: (params: Parameters<SdkSandbox["runCommand"]>[0]) => {
      const rest = Object.fromEntries(Object.entries(params.env ?? {}).filter(([name]) => name !== "PATH" && name !== "HOME"));
      return realRun({ ...params, env: rest });
    },
  } as unknown as SdkSandbox;
  const vmCalls: string[] = [];
  const port: VmPort = {
    create: async (_id, kind) => {
      if (options.failCreate === true) throw new Error("no vm");
      vmCalls.push(`create:${kind}`);
    },
    startEgress: async () => void vmCalls.push("egress"),
    waitGuest: async () => void vmCalls.push("guest"),
    releaseEgress: async () => void vmCalls.push("release"),
    stop: async () => void vmCalls.push("stop"),
    destroy: async () => void vmCalls.push("destroy"),
    delete: async () => void vmCalls.push("delete"),
  };
  const state = { tokenAsked: 0, released: 0, copyDirs: [] as string[] };
  const deps = hostDeps();
  const hostWs = hostWorkspace(fx.mirror, fx.commit);
  const repos: SetupRepos = {
    async open() {
      events.push("repo");
      state.copyDirs.push(hostWs, fx.mirror);
      return { mirrorDir: fx.mirror, workspace: hostWs, archive: await buildWorkspaceArchive(deps, fx.mirror, fx.commit), release: async () => void state.released++ };
    },
  };
  const logDir = options.logDir ?? mkdtempSync(path.join(tmpdir(), "fx-setup-log-"));
  if (options.logDir === undefined) logDirs.push(logDir);
  const handlerDeps: ProjectSetupDeps = {
    client: world.client,
    vm: {
      guestOf: async () => wrapped,
      lifecycle: { port, registry: new VmRegistry(), caps: { maxVms: 2, maxVcpus: 2, maxMemoryMb: 2048, snapshotDir: "/unused", snapshotQuotaBytes: 0 }, request: { vcpus: 1, memoryMb: 512 }, readMemAvailableBytes: () => 64 * 2 ** 30, token: { needed: () => (state.tokenAsked++, true), slot: () => undefined } },
    },
    repos,
    apply: (input) => applyBundle({ git: deps.git, gitLarge: deps.gitLarge, scratchDir: deps.scratchDir, ...(options.limits === undefined ? {} : { limits: options.limits }), policy: workflowPolicy(deps.gitLarge) }, input),
    logDir,
    transport: serveBytes(engine),
    paths: guest.paths,
  };
  await createProjectSetupHandler(handlerDeps)({ job: world.job, reporter: world.reporter, signal: world.signal });
  return { progress: world.progress, guest, events, vmCalls, get tokenAsked() { return state.tokenAsked; }, logDir, hostWs, fx, job: world.job, get released() { return state.released; }, copyDirs: state.copyDirs };
}

const CORE = ["preflight:started", "preflight:ok", "interview:started", "interview:ok", "wiring:started", "wiring:ok", "deps:started", "deps:ok", "labels:skipped:cloud_owned", "sandbox_hook:started", "sandbox_hook:ok", "bundle:ok", "done:ok"];
const BEFORE = ["engine_fetch:started", "engine_fetch:ok", "plan_fetch:started", "plan_fetch:ok", "sandbox_boot:started", "sandbox_boot:ok", "workspace_in:started", "workspace_in:ok", "bootstrap:started", "bootstrap:ok"];

describe("a whole setup, on the three fixed guest commands", () => {
  it("reports every step in order, one report per status line, ends on bundle_out ok, and applies the verified tree to the host copy", async () => {
    const r = await run();
    expect(compact(r.progress)).toEqual([...BEFORE, ...CORE, "finalize:started", "finalize:ok", "bundle_out:started", "bundle_out:ok"]);
    expect(r.progress.map((p) => p.seq)).toEqual(r.progress.map((_, i) => i));
    expect(r.progress[r.progress.length - 1]?.bundle_bytes).toBeGreaterThan(0);
    // the runner's own steps are the protocol's, in its order
    const own = r.progress.map((p) => p.sub_step).filter((s): s is (typeof SETUP_RUNNER_STEPS)[number] => (SETUP_RUNNER_STEPS as readonly string[]).includes(s));
    expect(own.map((s) => SETUP_RUNNER_STEPS.indexOf(s))).toEqual([...own.map((s) => SETUP_RUNNER_STEPS.indexOf(s))].sort((a, b) => a - b));
    // the host copy holds the guest's tree: the engine's files, the generated config and the rendered plan files, in ONE commit on the base, with the job's time
    const files = git(r.hostWs, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    expect(files).toEqual(expect.arrayContaining([".autonomous-team/project.json", ".autonomous-team/wired.json", ".autonomous-team/config.json", ".autonomous-team/CLAUDE.project.md", ".autonomous-team/roadmap.json", "docs/PRD.md", "epics/01-A1.md", "epics/02-B-2.md", "README.md"]));
    expect(git(r.hostWs, "rev-list", "--count", `${r.fx.commit}..HEAD`)).toBe("1");
    expect(git(r.hostWs, "log", "-1", "--format=%an|%cn|%s|%aI")).toBe("fulcrumaxe|fulcrumaxe|Install the fulcrumaxe engine 1.2.3|2026-11-21T12:00:00Z");
    expect(git(r.hostWs, "rev-parse", "HEAD^")).toBe(r.fx.commit);
    expect(r.released).toBe(1);
  }, 60_000);

  it("runs exactly the three fixed scripts in order, with the host's values as separate arguments, under the guest's clean environment and with no model credential", async () => {
    const r = await run();
    const scripts = r.guest.sent.commands.filter((c) => c.cmd === "sh" && [BOOTSTRAP, COLDSTART, FINALIZE].includes(c.args[1] ?? ""));
    expect(scripts.map((c) => [BOOTSTRAP, COLDSTART, FINALIZE].indexOf(c.args[1] as string))).toEqual([0, 1, 2]);
    expect(scripts[0]?.args.slice(3)).toEqual([r.guest.paths.workspace, r.guest.paths.stage, "fx/engine-install-1.2.3", "acme/Widgets.Service"]);
    expect(scripts[2]?.args.slice(3)).toEqual([r.guest.paths.workspace, r.guest.paths.stage, "1.2.3", "1795262400 +0000", r.fx.commit]);
    // every name is one of the guest's own table (PATH and HOME are not applied to a local guest, see `run`); no credential name is in it
    for (const c of scripts) expect(Object.keys(c.env ?? {}).sort()).toEqual(Object.keys(guestEnvOf({})).filter((k) => k !== "PATH" && k !== "HOME").sort());
    expect(r.tokenAsked).toBe(0);
    // one VM, the agent's: no check VM was made, and it was deleted at the end
    expect(r.vmCalls.filter((c) => c.startsWith("create"))).toEqual(["create:agent"]);
    expect(r.vmCalls.at(-1)).toBe("delete");
    // no host path of this machine is in anything sent to the guest
    const sent = JSON.stringify([r.guest.sent.commands, r.guest.sent.files.map((f) => f.path)]);
    for (const hostPath of [r.fx.repo, r.fx.mirror, r.hostWs, r.logDir]) expect(sent.includes(hostPath), hostPath).toBe(false);
  }, 60_000);

  it("puts the closed project_setup egress in force before anything is sent in, and it is the three package hosts and nothing else", async () => {
    const r = await run();
    expect(r.events.indexOf("policy")).toBeGreaterThanOrEqual(0);
    expect(r.events.indexOf("policy")).toBeLessThan(r.events.indexOf("repo"));
    expect(r.events.indexOf("policy")).toBeLessThan(r.events.indexOf("writeFiles"));
    expect(r.guest.sent.policies).toEqual([projectSetupPolicy()]);
    expect(r.guest.sent.policies).toEqual([{ allow: [...PROJECT_SETUP_HOSTS] }]);
  }, 60_000);

  it("a gh call in the guest is refused by the shim and logged there; the guest's stderr goes to a local 0600 log and into no report", async () => {
    const r = await run();
    expect(readFileSync(path.join(r.guest.paths.stage, "gh.log"), "utf8")).toBe("label create bug\n");
    const log = path.join(r.logDir, `${r.job.setup_id}.log`);
    expect(lstatSync(log).mode & 0o777).toBe(0o600);
    expect(readFileSync(log, "utf8")).toContain("coldstart output that must not be read as status");
    expect(JSON.stringify(r.progress)).not.toContain("coldstart output");
  }, 60_000);

  it("the engine's own commits during bootstrap are folded: still exactly one commit on the base, with the same tree as a run with none", async () => {
    const fx = fixtureRepo();
    const plain = await run({ fx });
    const withCommits = await run({ fx, engine: { bootstrapCommits: "second" } });
    expect(compact(withCommits.progress).at(-1)).toBe("bundle_out:ok");
    expect(git(withCommits.hostWs, "rev-list", "--count", `${fx.commit}..HEAD`)).toBe("1");
    expect(git(withCommits.hostWs, "rev-parse", "HEAD^")).toBe(fx.commit);
    expect(git(withCommits.hostWs, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual([...git(plain.hostWs, "ls-tree", "-r", "--name-only", "HEAD").split("\n"), "engine-note.txt"].sort());
  }, 120_000);

  it("a link the engine committed and then removed is not in the bundle's history", async () => {
    const r = await run({ engine: { bootstrapCommits: "link_removed" } });
    expect(compact(r.progress).at(-1)).toBe("bundle_out:ok");
    expect(git(r.hostWs, "rev-list", "--count", `${r.fx.commit}..HEAD`)).toBe("1");
    expect(git(r.hostWs, "log", "--format=%H", `${r.fx.commit}..HEAD`, "--", "escape")).toBe("");
  }, 60_000);

  it("a link the engine committed and left is refused as a symlink", async () => {
    const r = await run({ engine: { bootstrapCommits: "link_kept" } });
    expect(compact(r.progress).at(-1)).toBe("bundle_out:failed:bundle_refused/symlink");
    expect(git(r.hostWs, "rev-parse", "HEAD")).toBe(r.fx.commit);
  }, 60_000);

  it("makes its commit whatever hooks the engine installed in the repository (none runs)", async () => {
    const r = await run({ engine: { failingHook: true } });
    expect(compact(r.progress).at(-1)).toBe("bundle_out:ok");
    expect(git(r.hostWs, "rev-list", "--count", `${r.fx.commit}..HEAD`)).toBe("1");
    expect(lstatOrNull(path.join(r.guest.paths.workspace, "hook-ran.txt"))).toBeNull();
  }, 60_000);

  it("is deterministic: the same job on the same base gives the same commit id", async () => {
    const fx = fixtureRepo();
    const a = await run({ fx });
    const b = await run({ fx });
    expect(git(a.hostWs, "rev-parse", "HEAD")).toBe(git(b.hostWs, "rev-parse", "HEAD"));
  }, 120_000);

  it("a new project is told its language is polyglot and gets the five default stack answers; an existing one is told by the engine's own scan", async () => {
    const created = await run({ kind: "new" });
    expect(JSON.parse(readFileSync(path.join(created.hostWs, ".autonomous-team", "wired.json"), "utf8"))).toMatchObject({ language: "polyglot", name: "widgets-service", visibility: "private" });
    const answers = JSON.parse(readFileSync(path.join(created.guest.paths.stage, "answers.json"), "utf8")) as Record<string, Record<string, unknown>>;
    expect(answers["stack"]).toEqual({ primary_language: "other", runtime_framework: "none", package_manager: "other", test_framework: "unknown", has_frontend: "no" });
    const existing = await run();
    expect(JSON.parse(readFileSync(path.join(existing.hostWs, ".autonomous-team", "wired.json"), "utf8"))).toMatchObject({ language: "python" });
    // the answers file is canonical JSON (the fixture engine exits 1 on any other form, so a setup that got this far wrote it that way)
    expect(JSON.parse(readFileSync(path.join(existing.guest.paths.stage, "answers.json"), "utf8"))["stack"]).toMatchObject({ primary_language: "python", package_manager: "other" });
  }, 120_000);
});

describe("each way a setup fails ends it with one closed code, and nothing is pushed or applied after it", () => {
  const last = (r: Run): string => compact(r.progress).at(-1) as string;
  const applied = (r: Run): boolean => git(r.hostWs, "rev-parse", "HEAD") !== r.fx.commit;

  it("an engine that drops a core topic ends missing_topic:<id> on the interview step, with no finalize and no bundle", async () => {
    const r = await run({ engine: { coreTopics: ["identity", "stack", "deploy", "autonomy", "mission", "roster"] } });
    expect(compact(r.progress)).toEqual([...BEFORE, "preflight:started", "preflight:ok", "interview:started", "interview:failed:missing_topic:roster"]);
    expect(applied(r)).toBe(false);
    expect(r.vmCalls.at(-1)).toBe("delete");
  }, 60_000);

  it("a status line over 128 bytes, a name outside the closed lists, a step going back and a 65th line each refuse the stream and fail setup_status_refused", async () => {
    const stream = (lines: string[]) => run({ engine: { statusLines: lines } });
    for (const lines of [[`step=preflight state=started ${"x".repeat(200)}`], ["step=bogus state=ok"], ["step=deps state=ok", "step=wiring state=ok"], ["step=preflight state=failed"], ["step=preflight state=started code=interrupted"], ["step=preflight state=started\r"], Array.from({ length: 65 }, () => "step=preflight state=started")]) {
      const r = await stream(lines);
      expect(last(r), JSON.stringify(lines).slice(0, 60)).toMatch(/:failed:setup_status_refused$/);
      expect(applied(r)).toBe(false);
    }
  }, 240_000);

  it("a stream that ends without its done line is interrupted, with a closed reason when it ran out of time", async () => {
    expect(last(await run({ engine: { exitWithoutDone: 0 } }))).toBe("bundle:failed:interrupted");
    expect(last(await run({ engine: { exitWithoutDone: 1 } }))).toMatch(/:failed:interrupted$/);
  }, 120_000);

  it("a bootstrap that fails is bootstrap_failed and coldstart never starts", async () => {
    const r = await run({ engine: { bootstrapExit: 1 } });
    expect(compact(r.progress)).toEqual([...BEFORE.slice(0, -2), "bootstrap:started", "bootstrap:failed:bootstrap_failed/exit"]);
  }, 60_000);

  it("a VM that cannot be made ends vm_boot_failed on sandbox_boot, with no policy and nothing sent", async () => {
    const r = await run({ failCreate: true });
    expect(compact(r.progress)).toEqual([...BEFORE.slice(0, 4), "sandbox_boot:started", "sandbox_boot:failed:vm_boot_failed/create"]);
    expect(r.events).toEqual([]);
  }, 60_000);

  it("an egress policy that cannot be put in force ends vm_egress_unavailable before anything is sent in", async () => {
    const r = await run({ failPolicy: true });
    expect(last(r)).toBe("workspace_in:failed:vm_egress_unavailable/policy");
    expect(r.events).toEqual(["policy"]);
  }, 60_000);
});

describe("the bundle policy: a hostile guest is refused with its closed reason, and the host copy is untouched", () => {
  const hostile = async (write: string, limits?: Partial<typeof DEFAULT_PACK_LIMITS>): Promise<Run> => run({ engine: { extraWrite: write }, ...(limits === undefined ? {} : { limits }) });
  const refused = (r: Run): string => compact(r.progress).at(-1) as string;
  const untouched = (r: Run): boolean => git(r.hostWs, "rev-parse", "HEAD") === r.fx.commit && git(r.hostWs, "status", "--porcelain") === "";

  it("a workflow file added, changed or deleted is bundle_refused/workflow, whatever its content and however its path is cased", async () => {
    const withWorkflow = () =>
      fixtureRepo((dir) => {
        execFileSync("mkdir", ["-p", path.join(dir, ".github", "workflows")]);
        execFileSync("sh", ["-c", `echo 'name: ci' > "${path.join(dir, ".github", "workflows", "ci.yml")}"`]);
      });
    for (const write of ['mkdir -p "$P/.github/workflows"; echo "on: push" >"$P/.github/workflows/new.yml"', 'echo "# edited" >>"$P/.github/workflows/ci.yml"', 'rm "$P/.github/workflows/ci.yml"', 'mkdir -p "$P/.GitHub/Workflows"; echo x >"$P/.GitHub/Workflows/x.yml"']) {
      const r = await run({ fx: withWorkflow(), engine: { extraWrite: write } });
      expect(refused(r), write).toBe("bundle_out:failed:bundle_refused/workflow");
      expect(untouched(r)).toBe(true);
    }
  }, 240_000);

  it("a link out of the tree is bundle_refused/symlink", async () => {
    const r = await hostile('ln -s ../../outside "$P/escape"');
    expect(refused(r)).toBe("bundle_out:failed:bundle_refused/symlink");
    expect(untouched(r)).toBe(true);
  }, 60_000);

  it("commits made in the guest before finalize are folded into the one install commit: a link added and removed again never reaches the bundle's history", async () => {
    const r = await hostile('ln -s ../../outside "$P/escape"; git -C "$P" add escape; git -C "$P" -c user.name=g -c user.email=g@example.test commit -qm guest; rm "$P/escape"');
    expect(refused(r)).toBe("bundle_out:ok");
    expect(git(r.hostWs, "rev-list", "--count", `${r.fx.commit}..HEAD`)).toBe("1");
    expect(git(r.hostWs, "log", "--all", "--format=%H", "--diff-filter=A", "--name-only", "-1", "--", "escape")).toBe("");
    expect(git(r.hostWs, "rev-parse", "HEAD^")).toBe(r.fx.commit);
  }, 60_000);

  it("a guest that bypasses finalize and hands back two commits is still refused bundle_commits, reason path, by the policy", async () => {
    const fx = fixtureRepo();
    const deps = hostDeps();
    const g = localGuest();
    await sendWorkspace(g.guest, await buildWorkspaceArchive(deps, fx.mirror, fx.commit), g.paths);
    for (const name of ["a.txt", "b.txt"]) {
      writeFileSync(path.join(g.paths.workspace, name), "x\n");
      git(g.paths.workspace, "add", "-A");
      git(g.paths.workspace, "commit", "-qm", name);
    }
    const bundle = (await pullBundle(g.guest, fx.commit, { paths: g.paths })) as Buffer;
    const hostWs = hostWorkspace(fx.mirror, fx.commit);
    const error = await applyBundle({ git: deps.git, gitLarge: deps.gitLarge, scratchDir: deps.scratchDir, policy: workflowPolicy(deps.gitLarge) }, { bundle, base: fx.commit, mirrorDir: fx.mirror, workspace: hostWs }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "bundle_commits", detail: "path" });
    expect(bundleReasonOf(error)).toBe("path");
    expect(git(hostWs, "rev-parse", "HEAD")).toBe(fx.commit);
  }, 60_000);

  it("a link still in the tree at finalize is refused as a symlink, however many commits the guest made", async () => {
    const r = await hostile('ln -s ../../outside "$P/escape"; git -C "$P" add escape; git -C "$P" -c user.name=g -c user.email=g@example.test commit -qm guest');
    expect(refused(r)).toBe("bundle_out:failed:bundle_refused/symlink");
    expect(untouched(r)).toBe(true);
  }, 60_000);

  it("a log file left by an earlier run keeps no wider mode: it is 0600 after the setup writes it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-setup-oldlog-"));
    logDirs.push(dir);
    const fx = fixtureRepo();
    const r0 = await run({ fx, logDir: dir });
    const file = path.join(dir, `${r0.job.setup_id}.log`);
    chmodSync(file, 0o644);
    await run({ fx, logDir: dir });
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  }, 120_000);

  it("a file over the pack's per-object cap is bundle_refused/size", async () => {
    const r = await hostile('head -c 300000 /dev/zero | tr "\\0" "a" >"$P/big.txt"', { perObject: 100_000 });
    expect(refused(r)).toBe("bundle_out:failed:bundle_refused/size");
    expect(untouched(r)).toBe(true);
  }, 60_000);
});
