import type { AgentRuntime, NormalizedEvent, Role } from "./types.js";
import { OPERATOR_OAUTH_ENV_NAME, buildSandboxEnv } from "./sandboxEnv.js";
import {
  LISTABLE_PREFIXES,
  SandboxNotFoundError,
  type CreateSandboxOptions,
  type DeleteSandboxOptions,
  type ListSandboxesOptions,
  type ListedSandbox,
  type SandboxComputeState,
  type SandboxListPage,
  type SandboxProviderStatus,
  type SandboxHandle,
  type SandboxPort,
  type SandboxCounters,
  type SandboxSessionUsage,
  type StartDetachedOptions,
  type StartDetachedResult,
} from "./sandboxPort.js";

/**
 * H09 security review, "informational" 1: `StartDetachedOptions.env`
 * accepted any map -- the real port should check that `env` equals
 * `buildSandboxEnv(role)` rather than trusting that every caller builds
 * it correctly. This fake stands in for "the port" in this PR (no real
 * `@vercel/sandbox` implementation ships here -- see sandboxPort.ts's
 * file header), so it is the one place that assertion belongs today.
 */
export function assertSandboxEnvMatchesRole(role: Role, env: Record<string, string>): void {
  // Either of the two envs `buildSandboxEnv` can build; the operator one holds only the fixed placeholder.
  const expected = Object.hasOwn(env, OPERATOR_OAUTH_ENV_NAME) ? buildSandboxEnv(role, "operator_subscription") : buildSandboxEnv(role);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(env).sort();
  const matches =
    expectedKeys.length === actualKeys.length &&
    expectedKeys.every((key, i) => key === actualKeys[i] && expected[key] === env[key]);
  if (!matches) {
    // Key NAMES only, never a value (H09 security re-review, "should
    // fix" 3): this assertion fires exactly when a caller put something
    // it shouldn't have in `env`, so the rejected env is, by definition,
    // the one case most likely to be carrying a real secret -- the same
    // leak pattern "must fix" 3 of the first review closed in
    // `buildFirewallPolicy`. Reporting which keys are missing, extra, or
    // hold a different value than expected is enough to debug a mismatch
    // without ever printing what any of those values actually are.
    const actualKeySet = new Set(actualKeys);
    const expectedKeySet = new Set(expectedKeys);
    const missingKeys = expectedKeys.filter((key) => !actualKeySet.has(key));
    const extraKeys = actualKeys.filter((key) => !expectedKeySet.has(key));
    const mismatchedKeys = expectedKeys.filter(
      (key) => actualKeySet.has(key) && expected[key] !== env[key],
    );
    throw new Error(
      `fakeSandbox: env must equal buildSandboxEnv(${JSON.stringify(role)}) -- missing keys: ${JSON.stringify(missingKeys)}, extra keys: ${JSON.stringify(extraKeys)}, mismatched keys: ${JSON.stringify(mismatchedKeys)}`,
    );
  }
}

/**
 * Test double for `SandboxPort`, zero model tokens. Wraps a caller-supplied
 * `AgentRuntime` (H04) -- pass `createFakeRuntime(fixtureDir)` from
 * `@fx/runtime` for a realistic replay, or a small hand-written stub for a
 * test that only cares about the sandbox-lifecycle bookkeeping below.
 * `runtime` is a required parameter, not defaulted, so this package never
 * needs its own fixture directory.
 *
 * Every lifecycle call is recorded on `state`, which is what
 * `test/sandboxNaming.test.ts` and `test/fakeSandbox.test.ts` assert
 * against (Spec pass/fail 6: naming, persistence, `keepLastSnapshots`,
 * deletion on `pr.closed`/`pr.merged`).
 */
export interface FakeSandboxState {
  readonly created: readonly CreateSandboxOptions[];
  readonly extended: readonly { handle: SandboxHandle; additionalMs: number }[];
  readonly stopped: readonly SandboxHandle[];
  readonly deleted: readonly SandboxHandle[];
  /** Every `stop` / `readCounters` / `measure` / `deleteSandbox` / `state` / `exists` / `list` call in order, as `"<op>:<sandboxName>"` (a list is `"list:<prefix>"`). */
  readonly calls: readonly string[];
  /** Names whose snapshot the provider still holds. A delete without `deleteSnapshots` leaves it, one with it removes it. */
  readonly snapshots: readonly string[];
}

export interface FakeSandboxController {
  readonly state: FakeSandboxState;
  /** After this call, `startDetached`/`resume` on this sandbox name
   * return a `hookFired` promise that never settles -- Spec pass/fail 7's
   * "the hook never fires" watchdog scenario (H09b's own test). */
  hang(sandboxName: string): void;
  /** After this call, `startDetached` on this sandbox name never gets as far as the agent command: `launched` and
   * `hookFired` never settle (a launch the provider never completes). */
  hangLaunch(sandboxName: string): void;
  /** What `sandboxState` answers for this sandbox, as if something outside stopped (or lost) it. Unscripted: the fake
   * follows its own `stop`/`deleteSandbox` calls. */
  scriptComputeState(sandboxName: string, state: SandboxComputeState): void;
  /** After this call, `resume` on this sandbox name throws
   * `SandboxNotFoundError` -- Spec pass/fail 9's expired-snapshot
   * fallback scenario (H09b's own test). */
  failResumeWithNotFound(sandboxName: string): void;
  /** D#2 COMPUTE-SETTLE CS-1: what `measure` reports for this sandbox (filtered to the ids asked for); unscripted, every figure. */
  scriptUsage(sandboxName: string, usage: SandboxSessionUsage[]): void;
  /** What `readCounters` reports for this sandbox. */
  scriptCounters(sandboxName: string, counters: Omit<SandboxCounters, "sessionId">): void;
  /** After this call, `measure` on this sandbox name throws (an API failure). */
  failMeasure(sandboxName: string): void;
  /** After this call, `deleteSandbox` on this sandbox name throws (an API failure, with `status` when given: 429, 500, ...) and the sandbox stays. */
  failDelete(sandboxName: string, status?: number): void;
  /** Undoes `failDelete` for this sandbox. */
  healDelete(sandboxName: string): void;
  /** Puts a sandbox in the provider's project without going through the port (another tool's, a spike script's): it is listed and has a state. */
  seedProviderSandbox(sandboxName: string, init?: { status?: SandboxProviderStatus; persistent?: boolean; snapshot?: boolean }): void;
  /** How many sandboxes one `listSandboxes` page holds (default 100). */
  setListPageSize(size: number): void;
  /** After this call, `listSandboxes` throws a provider error with this status (429, 500, ...). */
  failList(status: number): void;
  /** What `sandboxExists` does for this sandbox: answers `false` (a 404), or "unknown" (it THROWS, as a port that could not answer would). Unscripted: it exists. */
  scriptExists(sandboxName: string, answer: false | "unknown"): void;
}

/** What the fake reports for a session nobody scripted: every figure present, so a run prices as 'measured'. */
const HEALTHY_USAGE = { memoryMb: 4096, region: "iad1", durationMs: 60_000, activeCpuMs: 1_000, egressBytes: 0 };

export function createFakeSandbox(runtime: AgentRuntime): { port: SandboxPort } & FakeSandboxController {
  const created: CreateSandboxOptions[] = [];
  const extended: { handle: SandboxHandle; additionalMs: number }[] = [];
  const stopped: SandboxHandle[] = [];
  const deleted: SandboxHandle[] = [];
  const hungSandboxNames = new Set<string>();
  /** Sandboxes whose launch never reaches the agent command (`launched` never settles). */
  const hungLaunchNames = new Set<string>();
  /** A compute state a test scripted from outside (a stop the runner did not make). */
  const scriptedState = new Map<string, SandboxComputeState>();
  const notFoundOnResume = new Set<string>();
  const calls: string[] = [];
  const usage = new Map<string, SandboxSessionUsage[]>();
  const counters = new Map<string, Omit<SandboxCounters, "sessionId">>();
  const measureFails = new Set<string>();
  const deleteFails = new Map<string, number | undefined>();
  /** The provider's project: every sandbox the port created or a test seeded, in creation order. A deleted one is gone from it. */
  const provider = new Map<string, ListedSandbox>();
  const snapshots = new Set<string>();
  let listPageSize = 100;
  let listFailStatus: number | undefined;
  let clockMs = 1_700_000_000_000;
  const existence = new Map<string, false | "unknown">();
  /** The session each sandbox is in; a created or resumed sandbox gets a new one. */
  const sessionOf = new Map<string, string>();
  let sessionSeq = 0;
  const newSession = (sandboxName: string): string => {
    const id = `sess-${++sessionSeq}`;
    sessionOf.set(sandboxName, id);
    return id;
  };
  /** Runs `start` after `onSession` has been awaited with the run's session id (before the command starts). */
  const afterSession = <T,>(handle: SandboxHandle, opts: StartDetachedOptions, start: () => Promise<T>): Promise<T> =>
    opts.onSession
      ? Promise.resolve(opts.onSession(sessionOf.get(handle.sandboxName) ?? newSession(handle.sandboxName))).then(start)
      : start();

  function runStart(handle: SandboxHandle, opts: StartDetachedOptions): StartDetachedResult {
    assertSandboxEnvMatchesRole(opts.role, opts.env);
    if (hungLaunchNames.has(handle.sandboxName)) {
      return { handle, hookFired: new Promise<NormalizedEvent | undefined>(() => {}), launched: new Promise<void>(() => {}) };
    }
    if (hungSandboxNames.has(handle.sandboxName)) {
      return { handle, hookFired: afterSession(handle, opts, () => new Promise<NormalizedEvent | undefined>(() => {})), launched: Promise.resolve() };
    }
    let lastEvent: NormalizedEvent | undefined;
    const hookFired = afterSession(handle, opts, () => runtime
      .start({
        runId: opts.runId,
        role: opts.role,
        roleCard: opts.roleCard,
        prompt: opts.prompt,
        model: opts.model,
        workdir: opts.workdir,
        capUsd: opts.capUsd,
        onEvent: (event) => {
          lastEvent = event;
          // D#2 H09b2 fix round 1 (S-MUST 2): propagate the promise so
          // `runtime.start`'s own loop awaits `opts.onEvent` (this class's
          // onEvent) before producing the next event.
          return opts.onEvent(event);
        },
      })
      .then(() => lastEvent));
    return { handle, hookFired, launched: Promise.resolve() };
  }

  const port: SandboxPort = {
    async createSandbox(opts: CreateSandboxOptions): Promise<SandboxHandle> {
      created.push(opts);
      provider.set(opts.sandboxName, { name: opts.sandboxName, persistent: opts.retention.persistent, status: "running", createdAt: ++clockMs, updatedAt: clockMs });
      if (opts.retention.persistent) snapshots.add(opts.sandboxName);
      // `runId` is unset until `startDetached` supplies one -- a created
      // sandbox has no run in it yet. Held as an empty string (AgentHandle
      // requires the field) rather than made optional, so every
      // `SandboxHandle` in this package has the same shape everywhere.
      return { runId: "", sandboxName: opts.sandboxName, sessionId: newSession(opts.sandboxName) };
    },

    startDetached(handle, opts) {
      return runStart(handle, opts);
    },

    async extendTimeout(handle, additionalMs) {
      extended.push({ handle, additionalMs });
    },

    async stop(handle) {
      stopped.push(handle);
      calls.push(`stop:${handle.sandboxName}`);
      const listed = provider.get(handle.sandboxName);
      if (listed) provider.set(handle.sandboxName, { ...listed, status: "stopped", updatedAt: ++clockMs });
      // Idempotent (SandboxPort's own contract): swallow a runtime.stop()
      // that errors because there was nothing running -- the fake runtime
      // never errors here today, but a real one might.
      await runtime.stop(handle).catch(() => undefined);
    },

    resume(handle, sessionId, prompt, opts) {
      assertSandboxEnvMatchesRole(opts.role, opts.env);
      if (notFoundOnResume.has(handle.sandboxName)) {
        throw new SandboxNotFoundError(handle.sandboxName);
      }
      // A resumed sandbox runs in a new session.
      newSession(handle.sandboxName);
      if (hungSandboxNames.has(handle.sandboxName)) {
        return { handle, hookFired: afterSession(handle, opts, () => new Promise<NormalizedEvent | undefined>(() => {})) };
      }
      // NOTE: @fx/runtime's `AgentRuntime.resume` (H04) takes no `onEvent`
      // -- the fake runtime replays using whichever `onEvent` was captured
      // on `handle` by the original `start()` call, not `opts.onEvent`
      // passed here. Capturing THIS call's terminal event therefore isn't
      // possible through H04's current interface. None of H09a's own
      // pass/fail items (2, 3, 4, 6, A8) exercise `resume` -- Spec
      // pass/fail 9 is H09b's, and closing this gap (most likely by H04
      // growing an `onEvent` parameter on `resume`) is H09b's to do
      // alongside it.
      const hookFired = afterSession(handle, opts, () => runtime.resume(handle, sessionId, prompt).then(() => undefined));
      return { handle, hookFired };
    },

    async deleteSandbox(handle, opts?: DeleteSandboxOptions) {
      if (deleteFails.has(handle.sandboxName)) throw Object.assign(new Error("fakeSandbox: deleteSandbox failed"), { status: deleteFails.get(handle.sandboxName) });
      // A second delete of a sandbox that is already gone is a 404 at the provider, which the real port treats as done: the fake does not throw either.
      deleted.push(handle);
      calls.push(`delete:${handle.sandboxName}`);
      existence.set(handle.sandboxName, false); // a deleted sandbox is gone: the provider now answers 404
      provider.delete(handle.sandboxName);
      // The provider keeps a deleted sandbox's snapshot until it expires, unless asked to remove it (the SDK's `deleteOrphanSnapshots`).
      if (opts?.deleteSnapshots === true) snapshots.delete(handle.sandboxName);
    },

    async listSandboxes(opts: ListSandboxesOptions): Promise<SandboxListPage> {
      calls.push(`list:${opts.prefix}`);
      if (!LISTABLE_PREFIXES.includes(opts.prefix)) throw new Error("fakeSandbox: listSandboxes accepts only the ex- and rn- prefixes");
      if (listFailStatus !== undefined) throw Object.assign(new Error("fakeSandbox: listSandboxes failed"), { status: listFailStatus });
      const all = [...provider.values()].filter((s) => s.name.startsWith(opts.prefix));
      const from = opts.cursor === undefined ? 0 : Number(opts.cursor);
      if (!Number.isSafeInteger(from) || from < 0) throw Object.assign(new Error("fakeSandbox: bad cursor"), { status: 400 });
      const page = all.slice(from, from + listPageSize);
      return { sandboxes: page.map((s) => ({ ...s })), next: from + listPageSize < all.length ? String(from + listPageSize) : null };
    },

    async measure(handle, sessionIds) {
      calls.push(`measure:${handle.sandboxName}`);
      if (measureFails.has(handle.sandboxName)) throw new Error("fakeSandbox: measure failed");
      // Unscripted: a provider that already reports every figure (a script of [] is one that reports nothing yet).
      const reported = usage.get(handle.sandboxName) ?? sessionIds.map((sessionId): SandboxSessionUsage => ({ sessionId, ...HEALTHY_USAGE }));
      return reported.filter((u) => sessionIds.includes(u.sessionId));
    },

    async sandboxState(handle) {
      calls.push(`state:${handle.sandboxName}`);
      const scripted = scriptedState.get(handle.sandboxName);
      if (scripted) return scripted;
      if (existence.get(handle.sandboxName) === false || deleted.some((h) => h.sandboxName === handle.sandboxName)) return "gone";
      const listed = provider.get(handle.sandboxName);
      if (listed) return listed.status === "running" || listed.status === "pending" ? "running" : listed.status === "stopped" || listed.status === "failed" || listed.status === "aborted" ? "stopped" : "unknown";
      return stopped.some((h) => h.sandboxName === handle.sandboxName) ? "stopped" : "running";
    },

    async sandboxExists(handle) {
      calls.push(`exists:${handle.sandboxName}`);
      if (existence.get(handle.sandboxName) === "unknown") throw new Error("fakeSandbox: sandboxExists could not answer");
      return existence.get(handle.sandboxName) !== false;
    },

    async readCounters(handle) {
      calls.push(`readCounters:${handle.sandboxName}`);
      const c = counters.get(handle.sandboxName);
      const sessionId = sessionOf.get(handle.sandboxName);
      return c && sessionId ? { sessionId, ...c } : undefined;
    },
  };

  return {
    port,
    state: { created, extended, stopped, deleted, calls, get snapshots() { return [...snapshots]; } },
    hang(sandboxName) {
      hungSandboxNames.add(sandboxName);
    },
    hangLaunch(sandboxName) {
      hungLaunchNames.add(sandboxName);
    },
    scriptComputeState(sandboxName, state) {
      scriptedState.set(sandboxName, state);
    },
    failResumeWithNotFound(sandboxName) {
      notFoundOnResume.add(sandboxName);
    },
    scriptUsage(sandboxName, scripted) {
      usage.set(sandboxName, scripted);
    },
    scriptCounters(sandboxName, scripted) {
      counters.set(sandboxName, scripted);
    },
    failMeasure(sandboxName) {
      measureFails.add(sandboxName);
    },
    failDelete(sandboxName, status) {
      deleteFails.set(sandboxName, status);
    },
    healDelete(sandboxName) {
      deleteFails.delete(sandboxName);
    },
    seedProviderSandbox(sandboxName, init = {}) {
      provider.set(sandboxName, { name: sandboxName, persistent: init.persistent ?? false, status: init.status ?? "stopped", createdAt: ++clockMs, updatedAt: clockMs });
      if (init.snapshot) snapshots.add(sandboxName);
      existence.delete(sandboxName);
    },
    setListPageSize(size) {
      listPageSize = size;
    },
    failList(status) {
      listFailStatus = status;
    },
    scriptExists(sandboxName, answer) {
      existence.set(sandboxName, answer);
    },
  };
}
