/**
 * D#845 ON-15b: the `engine_update` handler. It brings an installed project's engine files to the release the signed job names, on the branch the job names (`fx/engine-update-<v>`), and pushes that branch. It is
 * `project_setup` (projectSetup.ts) with the install's own parts taken out:
 *   engine_fetch -> sandbox_boot -> workspace_in -> bootstrap -> finalize -> bundle_out -> push
 * The guest runs ONLY the engine's `loop-bootstrap/bootstrap.sh --repo <o/n> --branch <b> <W>` (the same fixed `BOOTSTRAP` command) and then one fixed commit command. No coldstart and no `generate.py` run, and no plan is
 * read, so the project's answers and plan are untouched. The job carries no plan, base commit or repository name: the repository's name comes from this machine's own mirror (`repoOf`, never the cloud) and the base is
 * the tip of the default branch of that mirror after a fresh sync (`baseOf`). The bundle is checked and applied by the same host code, and the push is `pushSetup` (a branch of the signed job only, never the default branch).
 * Reports go through the existing progress route; the cloud picks the update's own definer by the job's kind.
 */
import { ENGINE_UPDATE_BRANCH, SETUP_FAILURE_CODES } from "@fulcrumaxe/runner-protocol";
import type { MachineJobOf } from "@fulcrumaxe/runner-protocol";
import type { MachineJobHandler } from "../daemon/machineJobs.js";
import type { AppliedBundle } from "../daemon/vmBundle.js";
import { runVmJob, StepRefusal, type VmJobOutcome } from "../vm/jobLifecycle.js";
import { pullBundle } from "../vm/workspace/bundleOut.js";
import { DEFAULT_GUEST_PATHS, GuestWorkspaceError, sendWorkspace } from "../vm/workspace/guestWorkspace.js";
import { EngineArchiveRefused, fetchEngineArchive, type FetchedEngine } from "./engineArchive.js";
import { BOOTSTRAP, runSetupCommand, sendSetupInputs, SetupGuestError, UPDATE_COMMIT } from "./guestScripts.js";
import { handleOf, openLog, reasonOf, type ProjectSetupDeps, type RunnerStep, type SetupRepoCopy } from "./projectSetup.js";
import { bundleReasonOf, projectSetupPolicy } from "./setupPolicy.js";
import { pushSetup } from "./setupPush.js";

export interface EngineUpdateDeps extends Omit<ProjectSetupDeps, "client" | "limitsMs"> {
  /** The repository's owner and name from this machine's own mirror; undefined when it has none. */
  repoOf(repoGhId: number): Promise<{ owner: string; name: string } | undefined>;
  /** The tip of the default branch after the mirror is brought up to date. */
  baseOf(repo: { id: string; owner: string; name: string }): Promise<string>;
  limitsMs?: { bootstrap: number; finalize: number };
}

const DEFAULT_LIMITS = { bootstrap: 10 * 60_000, finalize: 5 * 60_000 };
const VM_LIMIT_MS = 60 * 60_000;

export function createEngineUpdateHandler(deps: EngineUpdateDeps): MachineJobHandler<"engine_update"> {
  return async ({ job, reporter, signal }) => {
    const life = deps.vm.lifecycle;
    const limits = deps.limitsMs ?? DEFAULT_LIMITS;
    const names = { agent: `su-${job.job_id}`, check: `sc-${job.job_id}` };
    const paths = deps.paths ?? deps.vm.pathsOf?.(names.agent) ?? DEFAULT_GUEST_PATHS;
    const log = openLog(deps.logDir, job.setup_id);
    let copy: SetupRepoCopy | undefined;
    let who: { owner: string; name: string } | undefined;
    let base = "";
    let current: RunnerStep = "engine_fetch";
    let bundleBytes = 0;

    const step = async (sub: RunnerStep, state: "started" | "ok"): Promise<void> => {
      current = sub;
      await reporter.report({ sub_step: sub, state });
    };
    /** Reports the failure (which closes the job) and unwinds `runVmJob`; teardown then runs as for any other way out. */
    const fail = async (sub: RunnerStep, code: string, reason?: string): Promise<never> => {
      const closed = reasonOf(reason);
      await reporter.report({ sub_step: sub, state: "failed", failure_code: code, ...(closed === undefined ? {} : { failure_reason: closed }) });
      throw new StepRefusal("setup_failed");
    };
    const refused = (error: unknown, why: string): Promise<never> => fail("bundle_out", bundleReasonOf(error) === undefined ? "vm_workspace_failed" : "bundle_refused", bundleReasonOf(error) ?? why);
    const guestOf = (name: string) => deps.vm.guestOf(handleOf(name));
    const sink = (_stream: string, text: string): undefined => (log.write(text), undefined);

    // The cloud cannot limit the push credential to one branch, so this check is the fence: only the update branch, whatever the job says (`pushSetup` checks it again).
    if (!ENGINE_UPDATE_BRANCH.test(job.args.branch)) {
      await reporter.report({ sub_step: "engine_fetch", state: "failed", failure_code: "push_failed", failure_reason: "branch" });
      log.close();
      return;
    }
    try {
      await step("engine_fetch", "started");
      let engine: FetchedEngine;
      try {
        engine = await fetchEngineArchive(job.args.engine, { ...(deps.transport === undefined ? {} : { transport: deps.transport }), signal });
      } catch (error) {
        // fx-swallow-ok: not swallowed, reported as a closed code and reason; any other error is one `request` failure
        const why = error instanceof EngineArchiveRefused ? error : new EngineArchiveRefused("engine_fetch_failed", "request");
        await reporter.report({ sub_step: "engine_fetch", state: "failed", failure_code: why.code, failure_reason: why.reason });
        return;
      }
      await step("engine_fetch", "ok");
      await step("sandbox_boot", "started");
      const outcome: VmJobOutcome<void, AppliedBundle, void> = await runVmJob<void, { bundle: Buffer; base: string }, AppliedBundle, void>({
        names,
        port: typeof life.port === "function" ? life.port({ timeoutMs: VM_LIMIT_MS, runId: job.job_id }) : life.port,
        registry: life.registry, caps: life.caps, request: life.request, readMemAvailableBytes: life.readMemAvailableBytes,
        needsToken: false, keepAgentVm: false, signal, stepTimeoutMs: deps.stepTimeoutMs ?? 5 * 60_000,
        steps: {
          async workspaceIn(name) {
            await step("sandbox_boot", "ok");
            await step("workspace_in", "started");
            const guest = await guestOf(name);
            await guest.updateNetworkPolicy(projectSetupPolicy()).catch(() => fail("workspace_in", "vm_egress_unavailable", "policy"));
            who = await deps.repoOf(job.repo_gh_id).catch(() => undefined);
            if (who === undefined) await fail("workspace_in", "vm_workspace_failed", "repo");
            const repo = { id: String(job.repo_gh_id), owner: (who as { owner: string }).owner, name: (who as { name: string }).name };
            base = await deps.baseOf(repo).catch(() => fail("workspace_in", "vm_workspace_failed", "repo"));
            copy = await deps.repos.open({ repoId: job.repo_gh_id, owner: repo.owner, name: repo.name, baseSha: base, mode: "pr", signal }).catch(() => fail("workspace_in", "vm_workspace_failed", "repo"));
            await sendWorkspace(guest, copy.archive, paths).catch((error: unknown) => fail("workspace_in", "vm_workspace_failed", error instanceof GuestWorkspaceError ? error.code : "workspace"));
            await sendSetupInputs(guest, { engineTar: engine.tar, answers: {}, files: [] }, paths).catch((error: unknown) => fail("workspace_in", "vm_workspace_failed", error instanceof SetupGuestError ? error.code : "inputs"));
            await step("workspace_in", "ok");
          },
          async runAgent(name) {
            const guest = await guestOf(name);
            await step("bootstrap", "started");
            const boot = await runSetupCommand(guest, { script: BOOTSTRAP, args: [job.args.branch, `${(who as { owner: string }).owner}/${(who as { name: string }).name}`], limitMs: limits.bootstrap, onText: sink, signal }, paths);
            if (boot.exitCode !== 0) await fail("bootstrap", "bootstrap_failed", boot.timedOut ? "timeout" : "exit");
            await step("bootstrap", "ok");
            await step("finalize", "started");
            const when = `${String(Math.floor(Date.parse(job.issued_at) / 1000))} +0000`;
            const done = await runSetupCommand(guest, { script: UPDATE_COMMIT, args: [job.args.engine.version, when, base], limitMs: limits.finalize, onText: sink, signal }, paths);
            if (done.exitCode !== 0) await fail("finalize", "finalize_failed", done.timedOut ? "timeout" : "exit");
            await step("finalize", "ok");
          },
          async bundleOut(name) {
            await step("bundle_out", "started");
            const pulled = await pullBundle(await guestOf(name), base, { paths }).then((bundle) => ({ bundle }), (error: unknown) => ({ error }));
            if ("error" in pulled) return refused(pulled.error, "pull");
            if (pulled.bundle === null) return fail("bundle_out", "finalize_failed", "no_commit");
            bundleBytes = pulled.bundle.length;
            return { bundle: pulled.bundle, base };
          },
          async hostApply(collected) {
            const { mirrorDir, workspace } = copy as SetupRepoCopy;
            return deps.apply({ ...collected, mirrorDir, workspace }).catch((error: unknown) => refused(error, "apply"));
          },
          needsCheck: () => false,
        },
      });
      if (outcome.ok) {
        await reporter.report({ sub_step: "bundle_out", state: "ok", bundle_bytes: bundleBytes });
        if (reporter.closed || signal.aborted) return;
        await step("push", "started");
        const { mirrorDir, workspace } = copy as SetupRepoCopy;
        const { owner, name } = who as { owner: string; name: string };
        const result = await pushSetup(deps.push, { job: job as MachineJobOf<"engine_update">, base, repo: { id: String(job.repo_gh_id), owner, name, defaultBranch: null }, mirrorDir, workspace, tip: outcome.applied.tip });
        if (result.ok) await reporter.report({ sub_step: "push", state: "ok", head_sha: result.head });
        else await reporter.report({ sub_step: "push", state: "failed", failure_code: result.code, failure_reason: result.reason });
      } else if (!reporter.closed && !signal.aborted) {
        const code = (SETUP_FAILURE_CODES as readonly string[]).includes(outcome.code) ? outcome.code : "vm_workspace_failed";
        await reporter.report({ sub_step: current, state: "failed", failure_code: code, ...(reasonOf(outcome.step) === undefined ? {} : { failure_reason: reasonOf(outcome.step) as string }) });
      }
    } finally {
      await copy?.release().catch(() => undefined); // fx-swallow-ok: a host copy that cannot be removed now is swept with the runner's other workspaces
      log.close();
    }
  };
}
