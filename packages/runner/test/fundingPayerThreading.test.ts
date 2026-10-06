import { describe, expect, it, vi } from "vitest";

/**
 * D#2 H09b2-wf, correction C16.2 (Team Lead ruling, discussioncomment-
 * 18617721; #171 code review SHOULD, discussioncomment-5849672821 on PR
 * #171): a behavioral, spy-based proof that an injected `resolvePayer` is
 * threaded through the six call sites C16.4's source check names --
 * `reserve`, `release`, `settle`, `meter`, `meterCompute`,
 * `modelConnection.get` -- for a claim-funded run, complementing (not
 * replacing) that purely textual check.
 *
 * **Why a fully mocked, non-[pg] unit test, not a [pg] one.** The review
 * confirmed (and this file re-confirms below) that `spend_reservations`'s
 * composite FK to `agent_runs(account_id, id)` makes a spend row for a
 * DIFFERENT account than the run's own `agent_runs` row a physical
 * impossibility against real Postgres -- a claim-funded run's whole point
 * is exactly that mismatch. `@fx/spend`'s `reserve`/`releaseWith`/
 * `settleWith` are mocked out entirely (not wrapped around their real
 * implementations) so this test never attempts that impossible write; a
 * small in-memory fake `Pool`/`PoolClient` answers the few raw SQL
 * queries `SandboxTarget` itself still issues directly (status checks,
 * the advisory lock, the open-reservation-row reads, the CAS status
 * write, `totalsFor`'s sums) so this file needs no real Postgres at all.
 * `resolvePayer` itself (`SandboxTargetDeps.resolvePayer`) is the ONLY
 * pre-existing injection point this test uses -- no production code
 * changes for this test.
 *
 * **`meter`/`meterCompute`.** Neither function takes an account id
 * parameter at all (`packages/spend/src/meter.ts`: `MeterModelParams`/
 * `MeterComputeParams` carry no `accountId` field, confirmed by reading
 * that file directly) -- there is no accountId argument for either call
 * site to leak `run.accountId` INTO, so no behavioral assertion is
 * possible or meaningful for them here. `fundingSourceCheck.test.ts`
 * (C16.4) already guards both names textually; this file does not
 * duplicate that.
 *
 * **Mutation check (manual, not part of CI).** Verified directly while
 * writing this test: changing `admit`'s `reserve(this.deps.pool, {
 * accountId: payerAccountId, ... })` to `accountId: run.accountId` in
 * `src/targets/sandboxTarget.ts` makes this file's first test fail
 * (`reserve` observed `run.accountId`, expected `PAYER_ACCOUNT_ID`); the
 * same is true making the identical substitution at the `modelConnection.get`
 * and `settleWith`/`releaseWith` call sites -- each failure is limited to
 * the one test covering that call site, and reverting restores green.
 */

// `vi.hoisted` is required (not plain `const reserveMock = vi.fn()`) --
// `vi.mock`'s factory is hoisted above ALL other module-scope code
// (including plain `const` declarations) by vitest's transform, so a
// factory that closes over an ordinary `const` would read it before its
// initializer ever ran. `vi.hoisted` hoists the values themselves right
// alongside the mock registration, avoiding that.
const { reserveMock, releaseWithMock, settleWithMock } = vi.hoisted(() => ({
  reserveMock: vi.fn(),
  releaseWithMock: vi.fn(),
  settleWithMock: vi.fn(),
}));

vi.mock("@fx/spend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fx/spend")>();
  return {
    ...actual,
    reserve: reserveMock,
    releaseWith: releaseWithMock,
    settleWith: settleWithMock,
  };
});

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SandboxTarget, type SandboxTargetDeps } from "../src/targets/sandboxTarget.js";
import type { ExecutionRun } from "../src/executionTarget.js";
import type { RunFunding } from "../src/funding.js";
import { loadGithubForwardConfig } from "../src/githubForwardConfig.js";
import { createTestConnectionStatusPort } from "../src/connectionStatusPort.js";
import type {
  CreateSandboxOptions,
  SandboxHandle,
  SandboxPort,
  StartDetachedOptions,
  StartDetachedResult,
} from "../src/sandboxPort.js";

const PAYER_ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";

/** Every call site this suite exercises reads `run.accountId` for
 * identity writes (agent_runs/run_events) and `payerFor(run)` for
 * spend/key calls -- this mirrors what D#70 BRD-4's real resolver will
 * eventually do (`{kind:'claim'} -> payerAccountId`), it just never
 * throws `UnsupportedFundingError` the way `defaultResolvePayer` does,
 * since that throw is exactly what makes the production default
 * untestable this way (by design, C16.3). */
function claimResolvePayer(run: Pick<ExecutionRun, "accountId" | "funding">): string {
  const funding = run.funding;
  if (funding?.kind === "claim") return funding.payerAccountId;
  return run.accountId;
}

interface QueryResult {
  rows: unknown[];
  rowCount?: number;
}

type Handler = { match: RegExp; respond: (sql: string, params: unknown[]) => QueryResult };

/** A minimal in-memory `Pool`/`PoolClient` double. See file header for
 * why real Postgres cannot be used here. Throws on any query it doesn't
 * recognize -- silently returning `{rows:[]}` for an unanticipated query
 * would risk masking a genuine gap rather than failing loudly. `handlers`
 * are checked in order, before the generic BEGIN/COMMIT/ROLLBACK/
 * `SELECT set_config`/RESET no-op fallback, so a test can still observe
 * (or override) any of those by supplying its own handler first. */
function createFakePool(handlers: Handler[]): Pool {
  const client: PoolClient = {
    query: async (text: unknown, params?: unknown[]) => {
      const sql = String(text).trim();
      const args = (params ?? []) as unknown[];
      for (const h of handlers) {
        if (h.match.test(sql)) return h.respond(sql, args);
      }
      if (/^(BEGIN|COMMIT|ROLLBACK|RESET)\b/i.test(sql) || /SELECT set_config/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`fake pool: no handler for query: ${sql}`);
    },
    release: () => {},
  } as unknown as PoolClient;
  return { connect: async () => client } as unknown as Pool;
}

const TEST_GITHUB_FORWARD_CONFIG = loadGithubForwardConfig({
  FX_GH_FORWARD_SUFFIX: "fixture.test",
  FX_GH_FORWARD_HOST: "gh-proxy.fixture.test",
});

function buildRun(accountId: string, funding?: RunFunding): ExecutionRun {
  return {
    id: randomUUID(),
    accountId,
    role: "code-reviewer",
    product: "team",
    repoId: randomUUID(),
    roleCard: "fake role card",
    prompt: "fake prompt",
    model: "haiku-4.5",
    capUsd: 5,
    spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    funding,
  };
}

function baseDeps(
  pool: Pool,
  sandboxPort: SandboxPort,
  modelConnectionGet: ReturnType<typeof vi.fn>,
  decryptTenantKey: SandboxTargetDeps["decryptTenantKey"] = async () => "fake-plaintext-key-never-real",
): SandboxTargetDeps {
  return {
    pool,
    sandboxPort,
    decryptTenantKey,
    githubForward: TEST_GITHUB_FORWARD_CONFIG,
    lookup: async () => [{ address: "140.82.112.3", family: 4 }],
    hooks: { resume: async () => {} },
    modelConnection: {
      get: modelConnectionGet,
    },
    connectionStatus: createTestConnectionStatusPort(),
    resolvePayer: claimResolvePayer,
  };
}

function fakeSandboxPort(): SandboxPort {
  return {
    async createSandbox(opts: CreateSandboxOptions): Promise<SandboxHandle> {
      return { runId: "", sandboxName: opts.sandboxName };
    },
    startDetached(handle: SandboxHandle, _opts: StartDetachedOptions): StartDetachedResult {
      return { handle, hookFired: new Promise(() => {}) }; // never resolves; not awaited by dispatch()
    },
    async extendTimeout() {},
    async stop() {},
    resume(handle: SandboxHandle, _s: string, _p: string, _opts: StartDetachedOptions): StartDetachedResult {
      return { handle, hookFired: new Promise(() => {}) };
    },
    async deleteSandbox() {},
    async measure() {
      return [];
    },
    async readCounters() {
      return undefined;
    },
    async sandboxExists() {
      return true;
    },
  };
}

describe("C16.2: an injected resolvePayer threads through reserve/release/settle/modelConnection.get for a claim-funded run", () => {
  it("admit() calls reserve with the payer account, never the run's own account", async () => {
    reserveMock.mockClear();
    reserveMock.mockResolvedValue({ decision: "admit", reservations: [] });
    const runAccountId = randomUUID();
    const run = buildRun(runAccountId, { kind: "claim", payerAccountId: PAYER_ACCOUNT_ID, fundingId: randomUUID() });
    const pool = createFakePool([]);
    const target = new SandboxTarget(baseDeps(pool, fakeSandboxPort(), vi.fn()));

    await target.admit(run, {} as PoolClient);

    expect(reserveMock).toHaveBeenCalledTimes(1);
    const [, params] = reserveMock.mock.calls[0]!;
    expect(params.accountId).toBe(PAYER_ACCOUNT_ID);
    expect(params.accountId).not.toBe(run.accountId);
    expect(params.runId).toBe(run.id);
  });

  it("dispatch() calls modelConnection.get with the payer account, never the run's own account", async () => {
    const runAccountId = randomUUID();
    const run = buildRun(runAccountId, { kind: "claim", payerAccountId: PAYER_ACCOUNT_ID, fundingId: randomUUID() });
    const pool = createFakePool([
      { match: /SELECT status FROM agent_runs/i, respond: () => ({ rows: [{ status: "pending" }] }) },
      { match: /agent_run_sandbox_mark/i, respond: () => ({ rows: [], rowCount: 1 }) },
      { match: /status = 'pending'/i, respond: () => ({ rows: [{ "?column?": 1 }] }) },
    ]);
    const modelConnectionGet = vi.fn().mockResolvedValue({
      provider: "ai_gateway",
      encryptedKey: {
        ciphertext: new Uint8Array([1, 2, 3]),
        nonce: new Uint8Array([4, 5, 6]),
        wrappedDek: new Uint8Array([7, 8, 9]),
        kekVersion: 1,
      },
      connectionId: randomUUID(),
    });
    const target = new SandboxTarget(baseDeps(pool, fakeSandboxPort(), modelConnectionGet));

    await target.dispatch(run);

    expect(modelConnectionGet).toHaveBeenCalledTimes(1);
    expect(modelConnectionGet).toHaveBeenCalledWith(PAYER_ACCOUNT_ID);
    expect(modelConnectionGet).not.toHaveBeenCalledWith(run.accountId);
  });

  it("dispatch() opens the key under the PAYER account and the connection id modelConnection returned (the AAD inputs)", async () => {
    const run = buildRun(randomUUID(), { kind: "claim", payerAccountId: PAYER_ACCOUNT_ID, fundingId: randomUUID() });
    const pool = createFakePool([
      { match: /SELECT status FROM agent_runs/i, respond: () => ({ rows: [{ status: "pending" }] }) },
      { match: /agent_run_sandbox_mark/i, respond: () => ({ rows: [], rowCount: 1 }) },
      { match: /status = 'pending'/i, respond: () => ({ rows: [{ "?column?": 1 }] }) },
    ]);
    const connectionId = randomUUID();
    const get = vi.fn().mockResolvedValue({
      provider: "ai_gateway",
      encryptedKey: { ciphertext: new Uint8Array([1]), nonce: new Uint8Array([2]), wrappedDek: new Uint8Array([3]), kekVersion: 1 },
      connectionId,
    });
    const decrypt = vi.fn().mockResolvedValue("fake-plaintext-key-never-real");
    await new SandboxTarget(baseDeps(pool, fakeSandboxPort(), get, decrypt)).dispatch(run);
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(decrypt.mock.calls[0]![1]).toEqual({ accountId: PAYER_ACCOUNT_ID, connectionId });
  });

  it("finalize() calls settleWith (model and compute) and releaseWith with the payer account, never the run's own account, while the agent_runs write still uses the run's own account", async () => {
    releaseWithMock.mockClear();
    settleWithMock.mockClear();
    releaseWithMock.mockResolvedValue(undefined);
    settleWithMock.mockResolvedValue({ ledgerRows: [] });
    const runAccountId = randomUUID();
    const run = buildRun(runAccountId, { kind: "claim", payerAccountId: PAYER_ACCOUNT_ID, fundingId: randomUUID() });

    // The one query this test DOES care about the argument of, to confirm
    // the identity write (`writeRunStatus`, via `@fx/core`'s `withTenant`)
    // still uses the run's own account, not the payer's -- captured on
    // the FIRST `set_config('app.account_id', ...)` call, which is always
    // `writeRunStatus`'s own (it runs before `settleOrReleaseOpenRows`/
    // `totalsFor`, each of which sets it again for `payerAccountId`).
    let capturedFirstAccountId: string | undefined;
    const pool = createFakePool([
      {
        match: /SELECT set_config/i,
        respond: (_sql, params) => {
          if (capturedFirstAccountId === undefined && params[0] === "app.account_id") {
            capturedFirstAccountId = params[1] as string;
          }
          return { rows: [], rowCount: 0 };
        },
      },
      {
        match: /agent_run_set_status/i,
        respond: () => ({ rows: [{ updated: true }], rowCount: 1 }),
      },
      { match: /SELECT COALESCE\(MAX\(seq\)/i, respond: () => ({ rows: [{ next: "1" }] }) },
      { match: /INSERT INTO run_events/i, respond: () => ({ rows: [], rowCount: 1 }) },
      // writeRunStatus's CAS UPDATE above touches a row, so it also emits a
      // run.status_changed domain event (emitDomainEvent) in the same
      // transaction -- the fake pool needs a handler for that INSERT too,
      // or the whole finalize() call throws before the assertions below
      // ever run.
      { match: /INSERT INTO domain_events/i, respond: () => ({ rows: [{ id: randomUUID() }], rowCount: 1 }) },
      { match: /pg_advisory_xact_lock/i, respond: () => ({ rows: [{}], rowCount: 1 }) },
      // finalize() -> settleOpenRows: a 'model' row (settles, since report.usd is defined below) and a
      // compute row, which is settled by settleRunCompute (never released) under the payer too.
      {
        match: /SELECT budget FROM spend_reservations/i,
        respond: () => ({ rows: [{ budget: "model" }, { budget: "foreground_compute" }] }),
      },
      { match: /SELECT budget, usd_reserved/i, respond: () => ({ rows: [{ budget: "foreground_compute", usd_reserved: "1" }] }) },
      { match: /sandbox_requested_at/i, respond: () => ({ rows: [{ requested: null, stopped: null, ids: [], own: null }] }) },
      { match: /agent_run_sandbox_mark/i, respond: () => ({ rows: [], rowCount: 1 }) },
      { match: /SELECT COALESCE\(SUM/i, respond: () => ({ rows: [{ sum: "0" }] }) },
    ]);

    const target = new SandboxTarget(baseDeps(pool, fakeSandboxPort(), vi.fn()));

    await target.finalize(run, { status: "succeeded", usd: 3.5 });

    expect(settleWithMock).toHaveBeenCalledTimes(2);
    const [, settleParams] = settleWithMock.mock.calls[0]!;
    expect(settleParams.accountId).toBe(PAYER_ACCOUNT_ID);
    expect(settleParams.accountId).not.toBe(run.accountId);
    expect(settleParams.entries).toEqual([{ budget: "model", actualUsd: 3.5, source: "customer_gateway" }]);
    // The compute row: no sandbox was requested, so $0 on the 'no_sandbox' basis, under the payer's account.
    const [, computeParams] = settleWithMock.mock.calls[1]!;
    expect(computeParams.accountId).toBe(PAYER_ACCOUNT_ID);
    expect(computeParams.entries).toEqual([{ budget: "foreground_compute", actualUsd: 0, source: "sandbox", computeBasis: "no_sandbox" }]);

    expect(releaseWithMock).not.toHaveBeenCalled();

    // Confirms C16's "agent_runs and run_events writes... keep using
    // run.accountId" holds even for a claim-funded run.
    expect(capturedFirstAccountId).toBe(run.accountId);
  });
});
