import type { Pool } from "pg";
import { createFakeSandbox, type FakeSandboxController } from "../../src/fakeSandbox.js";
import { createTestConnectionStatusPort } from "../../src/connectionStatusPort.js";
import type { ConnectionStatusPort, RecordedMarkBrokenCall } from "../../src/connectionStatusPort.js";
import { loadGithubForwardConfig } from "../../src/githubForwardConfig.js";
import type { HookResumePort, ModelConnectionPort, SandboxTargetDeps } from "../../src/targets/sandboxTarget.js";
import type { TerminalReport } from "../../src/executionTarget.js";
import { createStubRuntime, type RecordedStubRuntime } from "./stubRuntime.js";

/** Records every hook resumption -- what test/executionTarget.contract.ts
 * and test/sandboxTarget.test.ts assert "resumes the hook exactly once"
 * and "with that token" against. */
export interface RecordedHookResumePort extends HookResumePort {
  readonly calls: readonly { hookToken: string; report: TerminalReport }[];
}

export function createRecordedHookResumePort(): RecordedHookResumePort {
  const calls: { hookToken: string; report: TerminalReport }[] = [];
  return {
    calls,
    async resume(hookToken, result) {
      // In the legacy mode these tests run in (finalizeBeforeResume: false) the hook carries the whole report.
      calls.push({ hookToken, report: result as TerminalReport });
    },
  };
}

/** A fixed, non-secret fake ciphertext/key -- never a real one. Matches
 * `firewallPolicy.test.ts`'s own pattern (H09a). */
export function createFakeModelConnectionPort(): ModelConnectionPort {
  return {
    async get() {
      return {
        provider: "ai_gateway",
        encryptedKey: {
          ciphertext: new Uint8Array([1, 2, 3]),
          nonce: new Uint8Array([4, 5, 6]),
          wrappedDek: new Uint8Array([7, 8, 9]),
          kekVersion: 1,
        },
        connectionId: "00000000-0000-4000-8000-0000000000c1",
      };
    },
  };
}

export const FAKE_DECRYPTED_KEY = "fake-plaintext-key-never-real";

/** D#66: a `.test` hostname, exactly as C10 requires -- "H09b ships no
 * production value, and the tests use a `.test` hostname." */
export const TEST_GITHUB_FORWARD_HOST = "gh-proxy.fixture.test";
export const TEST_GITHUB_FORWARD_CONFIG = loadGithubForwardConfig({
  FX_GH_FORWARD_SUFFIX: "fixture.test",
  FX_GH_FORWARD_HOST: TEST_GITHUB_FORWARD_HOST,
});

export interface SandboxTargetTestHarness {
  deps: SandboxTargetDeps;
  fakeSandbox: FakeSandboxController;
  hooks: RecordedHookResumePort;
  runtime: RecordedStubRuntime;
  connectionStatus: ConnectionStatusPort & { readonly calls: readonly RecordedMarkBrokenCall[] };
}

/** Builds a full `SandboxTargetDeps` over `fakeSandbox`/a stub runtime,
 * zero model tokens, for `makeTarget()` factories across this package's
 * tests. `pool` is caller-supplied (each [pg] test provides its own
 * app_user pool). */
export function createSandboxTargetHarness(
  pool: Pool,
  events: readonly import("../../src/types.js").NormalizedEvent[] = [],
): SandboxTargetTestHarness {
  const runtime = createStubRuntime(events);
  const fakeSandbox = createFakeSandbox(runtime);
  const hooks = createRecordedHookResumePort();
  const connectionStatus = createTestConnectionStatusPort();
  const deps: SandboxTargetDeps = {
    pool,
    sandboxPort: fakeSandbox.port,
    decryptTenantKey: async () => FAKE_DECRYPTED_KEY,
    githubForward: TEST_GITHUB_FORWARD_CONFIG,
    lookup: async () => [{ address: "140.82.112.3", family: 4 }],
    hooks,
    // These tests script the sequence by hand: wait for the hook's full report, then call finalize themselves.
    finalizeBeforeResume: false,
    modelConnection: createFakeModelConnectionPort(),
    connectionStatus,
  };
  return { deps, fakeSandbox, hooks, runtime, connectionStatus };
}
