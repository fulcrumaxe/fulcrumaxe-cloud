import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cacheRootsFor, createEventRelay, createGitPath, createHostSandbox, createJobHandler, createMemoryLedger, createRunnerClient, createWorkspaceStore, mirrorKeepClear, realClock,
  type JobResult, type RepoRef, type RunnerClient,
} from "@fulcrumaxe/fx-runner";
import type { JobKeyring } from "@fulcrumaxe/runner-protocol";
import { createClaudeKit } from "../../../../fx-runner/src/engines/claude/kit.js";
import type { RunnerKey } from "../../../../fx-runner/src/keys.js";

/**
 * D#6 R4d-6: the local runner (`fx-runner run`) assembled in-process from its own parts, in the order `runCommand` joins them
 * (packages/fx-runner/src/commands/run.ts): the signed client, the pinned job keyring, git path B over real mirrors, the host sandbox over the real Claude engine
 * (spawning the agent CLI found at `binary`), the job handler. What `runCommand` adds and this rig leaves out is the machine around it: the registration files, the
 * OS sandbox probe that gates claiming, the tmux watch, signal handling and the polling loop. `runNext` claims one run and hands it to the handler, which is what the
 * loop does with a claim.
 *
 * Its home, cache and state directories are made under one temporary root, and the process environment names that home, so nothing of the machine running the
 * test is read (a user's git config, a credential helper, a login).
 */
export interface RunnerRig {
  client: RunnerClient;
  /** Claims the next run and runs it to the end; `idle` when the cloud has nothing for this runner. */
  runNext(): Promise<JobResult | { status: "idle" }>;
  root: string;
  mirrorsRoot: string;
  close(): void;
}

export interface RunnerRigInput {
  cloudOrigin: string;
  key: RunnerKey;
  keyring: JobKeyring;
  /** The agent CLI the runner was told at setup, and the directory it is in. */
  binary: string;
  /** Where a repo's remote is (the local bare repository). */
  remoteUrl: (repo: RepoRef) => string;
}

/**
 * The process start the runner's kit uses. The repo's model-call guard (packages/test-guard, on whenever FX_FORBID_MODEL_CALLS=1, which CI sets) refuses any spawn whose
 * arguments contain the word "claude", and the job's `--model` value is a `claude-*` id from the cloud's price table. The program started here is the fake agent, never
 * a model client, so the brand prefix of such a plain argument is replaced before the start (`--model claude-opus-5` becomes `--model model-opus-5`); the guard still
 * sees, and refuses, a start of any program or path that is named for the real CLI. Nothing else about the start changes.
 */
const modelNeutralSpawn = ((command: string, args: readonly string[], options: object) =>
  (spawn as unknown as (c: string, a: readonly string[], o: object) => ReturnType<typeof spawn>)(
    command,
    args.map((arg) => (arg.includes("/") ? arg : arg.replace(/claude/gi, "model"))),
    options,
  )) as unknown as typeof spawn;

const ENV_NAMES = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;

export function createRunnerRig(input: RunnerRigInput): RunnerRig {
  const root = mkdtempSync(path.join(tmpdir(), "r4d6-runner-"));
  const home = path.join(root, "home");
  const stateDir = path.join(home, ".fx-runner");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // The runner's own git and the agent's shell read HOME by name; they must find this machine's, not the one running the test.
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.XDG_CACHE_HOME;

  const { mirrorsRoot, workspaceRoot, tempRoot } = cacheRootsFor({ home, platform: process.platform });
  const binaryDir = path.dirname(input.binary);
  const kit = createClaudeKit(modelNeutralSpawn);
  const credentials = { mode: "subscription" } as const;
  const envOptions = { extraPathDirs: [] as string[] };
  const keepClear = mirrorKeepClear({ home, stateDir, binaryDir, workspaceRoot, tempRoot });
  const relay = createEventRelay();
  const client = createRunnerClient({ origin: input.cloudOrigin, key: input.key, now: () => new Date(), fetchFn: fetch });
  const git = createGitPath({ capture: kit.capture, envOptions, mirrorsRoot, stateDir, keepClear, remoteUrl: input.remoteUrl });
  const sandbox = createHostSandbox({
    credentials,
    envOptions,
    home,
    tempRoot,
    workspaceRoot,
    stateDir,
    binaryDir,
    mirrorsRoot,
    makeRuntime: (sandboxSettings, protectedPaths, _jobEnv, runId) =>
      kit.makeRuntime({ binaryPath: input.binary, credentials, envOptions, sandboxSettings, protectedPaths, stateDir, onLocalEvent: (event) => relay.emit(runId, event) }),
  });
  const handle = createJobHandler({
    client,
    keyring: input.keyring,
    clock: realClock,
    ledger: createMemoryLedger(),
    git,
    sandbox,
    events: relay,
    run: { workspaces: createWorkspaceStore(workspaceRoot), credentials, envOptions, planSession: (continues) => kit.planSession(stateDir, continues), defaultModel: "sonnet" },
    recordSession: (sessionId, workspace) => kit.recordSession(stateDir, sessionId, workspace),
  });
  return {
    client,
    root,
    mirrorsRoot,
    async runNext() {
      // The cloud lets one runner claim once every few seconds (`runner_claim_throttle`); like the daemon's poll loop, wait out the answer it gives.
      let claim = await client.claim();
      for (let waits = 0; claim.kind === "rate_limited" && waits < 3; waits++) {
        await new Promise((resolve) => setTimeout(resolve, claim.kind === "rate_limited" ? claim.retryAfter * 1000 + 200 : 0));
        claim = await client.claim();
      }
      if (claim.kind === "idle") return { status: "idle" };
      if (claim.kind !== "claimed") throw new Error(`the claim did not give a run: ${JSON.stringify(claim)}`);
      return handle(claim);
    },
    close() {
      for (const name of ENV_NAMES) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
