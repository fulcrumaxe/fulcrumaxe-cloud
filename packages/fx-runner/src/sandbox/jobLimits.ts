/**
 * Per-job hard limits (D#6 C43-5): the backstop behind resource-aware admission. On Linux with a systemd user manager each job's agent is
 * started inside its own transient scope (`systemd-run --user --scope`) whose `MemoryMax` and `TasksMax` are the job class's budget, with swap
 * off for the job and `OOMPolicy=kill` so the kernel ends the whole job together. A job past its memory budget is killed on its own; the
 * scopes of the other jobs are separate cgroups and are not touched. The runner never kills a job for back-pressure: only this limit does.
 *
 * Where there is no user manager (a server without a login session, a container) or on macOS, nothing can be enforced. The runner then holds
 * back instead: at most 2 jobs in all and 1 heavy whatever the settings say (`capUnenforced`), and `doctor` says so.
 *
 * The scope is created by the agent's own process start (`wrap` only changes the program and its arguments); everything else here runs through the
 * bounded capture the runner already has, so this file starts no program. Unit names are `fxr-<run id>-<tag><n>`, the tag being this runner's own: a
 * failed scope that is left over (the runner stopped before it read the verdict) can never block the next one.
 */
import path from "node:path";
import { jobClassOfRole, type JobClass } from "@fulcrumaxe/runner-protocol";
import type { GitCapture } from "../daemon/git.js";
import { findTool } from "../daemon/nixShell.js";
import { GIB } from "../daemon/footprints.js";
import type { RunnerSettings } from "../runnerSettings.js";

/** Without hard limits the runner takes at most this many jobs, and this many heavy ones. */
export const UNENFORCED_TOTAL = 2;
export const UNENFORCED_HEAVY = 1;
export const UNENFORCED_LINE = `per-job limits not enforced on this machine; concurrency capped (heavy ${UNENFORCED_HEAVY}, total ${UNENFORCED_TOTAL})`;

export interface Budget {
  memoryBytes: number;
  tasks: number;
}
export type Budgets = Record<JobClass, Budget>;

export function budgetsOf(settings: Pick<RunnerSettings, "budget">): Budgets {
  const of = (cls: JobClass): Budget => ({ memoryBytes: settings.budget[cls].memoryGb * GIB, tasks: settings.budget[cls].tasks });
  return { light: of("light"), heavy: of("heavy") };
}

/** The ceilings in force when limits cannot be enforced: never above the person's own setting. */
export function capUnenforced(settings: RunnerSettings, enforced: boolean): RunnerSettings {
  return enforced ? settings : { ...settings, ceilingTotal: Math.min(settings.ceilingTotal, UNENFORCED_TOTAL), ceilingHeavy: Math.min(settings.ceilingHeavy, UNENFORCED_HEAVY) };
}

/** What the engine asks of the limits for one job. */
export interface JobLimits {
  /** The program and arguments to start the agent with, and the environment the start needs. The agent's own environment is unchanged. */
  wrap(job: { runId: string; role: string }, command: string, args: readonly string[], env: Record<string, string>): { command: string; args: string[]; env: Record<string, string> };
  /** After the agent ended: whether the kernel killed the job for its memory budget. Clears the unit's record either way. */
  exceeded(runId: string): Promise<boolean>;
}

export interface ScopeTools {
  systemdRun: string;
  systemctl: string;
  /** `env`, used inside the scope to take the runner's bus variables back out of the job's environment. */
  env: string;
}

export type ScopeSupport = { ok: true; tools: ScopeTools; runtimeDir: string } | { ok: false; reason: string };

export interface SupportDeps {
  platform: NodeJS.Platform;
  uid: number | undefined;
  /** `XDG_RUNTIME_DIR` as the runner has it; `/run/user/<uid>` when absent. */
  runtimeDir?: string | undefined;
  searchPath: string;
  /** Directories tried after `searchPath` (a service's PATH is often short). Default: the NixOS system profile, `/usr/bin` and `/bin`. */
  fallbackDirs?: readonly string[];
  capture: GitCapture;
  isDir(target: string): boolean;
  readText(target: string): string | undefined;
}

const FALLBACK_DIRS = ["/run/current-system/sw/bin", "/usr/bin", "/bin"];
const PROBE_MS = 10_000;

/**
 * Whether per-job scopes work here, by trying one: the tools are found, the user manager's runtime directory exists, memory and pids are
 * delegated to the user manager, and a real throw-away scope with both limits starts and exits 0. The reason is a short fixed sentence.
 */
export async function detectScopeSupport(deps: SupportDeps): Promise<ScopeSupport> {
  if (deps.platform !== "linux") return { ok: false, reason: "this is not Linux" };
  const search = [deps.searchPath, ...(deps.fallbackDirs ?? FALLBACK_DIRS)].join(path.delimiter);
  const systemdRun = findTool("systemd-run", search);
  const systemctl = findTool("systemctl", search);
  const env = findTool("env", search);
  if (systemdRun === undefined || systemctl === undefined || env === undefined) return { ok: false, reason: "systemd-run, systemctl or env was not found" };
  const uid = deps.uid;
  const runtimeDir = deps.runtimeDir ?? (uid === undefined ? undefined : `/run/user/${uid}`);
  if (uid === undefined || runtimeDir === undefined || !path.isAbsolute(runtimeDir) || !deps.isDir(runtimeDir)) return { ok: false, reason: "no systemd user manager is running for this user" };
  const controllers = deps.readText(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`)?.split(/\s+/) ?? [];
  if (!controllers.includes("memory") || !controllers.includes("pids")) return { ok: false, reason: "the memory and pids controllers are not delegated to the user manager" };
  const probe = await deps.capture(systemdRun, ["--user", "--scope", "--quiet", "--collect", `--unit=fxr-probe-${Math.random().toString(36).slice(2, 10)}`, "-p", "MemoryMax=64M", "-p", "TasksMax=64", "--", env, "true"], { XDG_RUNTIME_DIR: runtimeDir, PATH: search }, PROBE_MS);
  if (probe.code !== 0) return { ok: false, reason: "a test scope could not be started" };
  return { ok: true, tools: { systemdRun, systemctl, env }, runtimeDir };
}

export interface ScopeLimitsConfig {
  tools: ScopeTools;
  runtimeDir: string;
  /** Read for every job, so a changed budget applies to the next job. */
  budgets: () => Budgets;
  capture: GitCapture;
  sleep?: (ms: number) => Promise<void>;
}

/** The limits for this machine: the scope limits where scopes work (and then they are enforced), else none and the reason. */
export async function setUpJobLimits(deps: SupportDeps, budgets: () => Budgets): Promise<{ enforced: boolean; limits?: JobLimits; reason?: string }> {
  const support = await detectScopeSupport(deps);
  if (!support.ok) return { enforced: false, reason: support.reason };
  return { enforced: true, limits: createScopeLimits({ tools: support.tools, runtimeDir: support.runtimeDir, budgets, capture: deps.capture }) };
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTLE_TRIES = 30;
const SETTLE_MS = 100;

export function createScopeLimits(config: ScopeLimitsConfig): JobLimits {
  const units = new Map<string, string>();
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let counter = 0;
  // A tag of this runner process in every unit name: a failed scope left by an earlier runner process can never take a name this one wants.
  const tag = Math.random().toString(36).slice(2, 8);
  const busEnv = { XDG_RUNTIME_DIR: config.runtimeDir };

  return {
    wrap(job, command, args, env) {
      if (!RUN_ID.test(job.runId)) throw new TypeError("run id is not a uuid");
      const budget = config.budgets()[jobClassOfRole(job.role)];
      const unit = `fxr-${job.runId}-${tag}${++counter}`;
      units.set(job.runId, unit);
      return {
        command: config.tools.systemdRun,
        args: [
          "--user", "--scope", "--quiet", `--unit=${unit}`,
          "-p", `MemoryMax=${budget.memoryBytes}`, "-p", "MemorySwapMax=0", "-p", `TasksMax=${budget.tasks}`, "-p", "CPUWeight=100", "-p", "OOMPolicy=kill",
          "--", config.tools.env, "-u", "XDG_RUNTIME_DIR", "-u", "DBUS_SESSION_BUS_ADDRESS", command, ...args,
        ],
        env: { ...env, ...busEnv },
      };
    },
    async exceeded(runId) {
      const unit = units.get(runId);
      units.delete(runId);
      if (unit === undefined) return false;
      const scope = `${unit}.scope`;
      // The manager notices the empty cgroup a moment after the last process is gone, so wait until the scope has left the active state.
      let result = "";
      for (let i = 0; i < SETTLE_TRIES; i++) {
        const shown = await config.capture(config.tools.systemctl, ["--user", "show", scope, "-p", "ActiveState", "-p", "Result"], busEnv, 5_000);
        const state = shown.stdout.match(/^ActiveState=(\S*)/m)?.[1];
        result = shown.stdout.match(/^Result=(\S*)/m)?.[1] ?? "";
        if (shown.code !== 0 || (state !== "active" && state !== "deactivating")) break;
        await sleep(SETTLE_MS);
      }
      // A scope that failed stays loaded until it is reset; clear it whatever the reason, so nothing is left behind.
      if (result !== "" && result !== "success") await config.capture(config.tools.systemctl, ["--user", "reset-failed", scope], busEnv, 5_000).catch(() => undefined);
      return result === "oom-kill";
    },
  };
}
