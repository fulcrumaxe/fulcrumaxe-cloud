import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriptionCredentialsRefused } from "../src/types.js";
import { createProductionRuntime, type ProductionDeps } from "../src/production/index.js";
import type { SandboxSpec, StartOptions } from "../src/types.js";

const AI_GATEWAY_URL = "https://ai-gateway.vercel.sh/claude-code";
const ANTHROPIC_URL = "https://api.anthropic.com";
const FAKE_OAUTH_TOKEN = "sk-ant-oat01-FAKE-TOKEN-FOR-TEST-ONLY-do-not-use";

function makeDeps(overrides: Partial<ProductionDeps> = {}): ProductionDeps {
  return {
    getConnectionStatus: vi.fn().mockResolvedValue("ok"),
    launchSandbox: vi.fn().mockResolvedValue({ handle: { runId: "r1" } }),
    stopSandbox: vi.fn().mockResolvedValue(undefined),
    resumeSandbox: vi.fn().mockResolvedValue({ handle: { runId: "r1" } }),
    ...overrides,
  };
}

function makeSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sandboxName: "ex-repo-1",
    provider: "ai_gateway",
    baseUrl: AI_GATEWAY_URL,
    tenantId: "tenant-1",
    ...overrides,
  };
}

function makeOpts(overrides: Partial<StartOptions> = {}): StartOptions {
  return {
    runId: "run-1",
    role: "executor",
    roleCard: "card",
    prompt: "do the thing",
    model: "claude-sonnet-5",
    capUsd: 1,
    onEvent: vi.fn(),
    ...overrides,
  };
}

describe("production runner refusal (Spec H04 pass/fail 2)", () => {
  it("refuses to construct when CLAUDE_CODE_OAUTH_TOKEN is set in the orchestrator env", () => {
    expect(() => createProductionRuntime({ CLAUDE_CODE_OAUTH_TOKEN: "fake-token" }, makeDeps())).toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("refuses to start when CLAUDE_CODE_OAUTH_TOKEN is requested for the sandbox env", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("refuses to start when the ai_gateway base URL does not match the default", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ baseUrl: "https://evil.example/claude-code" });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("refuses to start when the anthropic base URL does not match the default", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ provider: "anthropic", baseUrl: "https://evil.example" });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("accepts the anthropic default base URL", async () => {
    const deps = makeDeps();
    const runtime = createProductionRuntime({}, deps);
    const spec = makeSpec({ provider: "anthropic", baseUrl: ANTHROPIC_URL });
    await runtime.start(makeOpts({ sandboxSpec: spec }));
    expect(deps.launchSandbox).toHaveBeenCalledOnce();
  });

  it("refuses to start without a model_connections row in status ok", async () => {
    const deps = makeDeps({ getConnectionStatus: vi.fn().mockResolvedValue("broken") });
    const runtime = createProductionRuntime({}, deps);
    await expect(runtime.start(makeOpts({ sandboxSpec: makeSpec() }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
    expect(deps.launchSandbox).not.toHaveBeenCalled();
  });

  it("refuses to start without a sandboxSpec at all", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    await expect(runtime.start(makeOpts())).rejects.toThrow(SubscriptionCredentialsRefused);
  });

  it("starts when every guard passes", async () => {
    const deps = makeDeps();
    const runtime = createProductionRuntime({}, deps);
    const { handle } = await runtime.start(makeOpts({ sandboxSpec: makeSpec() }));
    expect(handle.runId).toBe("r1");
    expect(deps.getConnectionStatus).toHaveBeenCalledWith("tenant-1");
  });
});

describe("production runner refuses smuggled credentials (Spec H04 fix-round item 2, CWE-522)", () => {
  it("refuses when ANTHROPIC_AUTH_TOKEN holds a subscription-token-shaped value in the orchestrator env", () => {
    expect(() =>
      createProductionRuntime({ ANTHROPIC_AUTH_TOKEN: FAKE_OAUTH_TOKEN }, makeDeps()),
    ).toThrow(SubscriptionCredentialsRefused);
  });

  it("refuses ANY env value shaped like a subscription token, under ANY key, in the orchestrator env", () => {
    expect(() => createProductionRuntime({ SOME_OTHER_VAR: FAKE_OAUTH_TOKEN }, makeDeps())).toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("refuses a spec.env.ANTHROPIC_BASE_URL override even alongside a valid spec.baseUrl", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { ANTHROPIC_BASE_URL: "https://evil.example" } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("refuses a spec.env.ANTHROPIC_API_KEY even alongside a valid spec.baseUrl", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { ANTHROPIC_API_KEY: "sk-ant-api01-fake" } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("refuses a spec.env.ANTHROPIC_AUTH_TOKEN holding an sk-ant-oat value", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { ANTHROPIC_AUTH_TOKEN: FAKE_OAUTH_TOKEN } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("refuses AI_GATEWAY_API_KEY in the sandbox env", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { AI_GATEWAY_API_KEY: "vck_fake" } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("refuses a subscription-token-shaped value under an unrelated key in the sandbox env", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { SOME_OTHER_VAR: FAKE_OAUTH_TOKEN } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("still accepts a sandbox env with no forbidden keys at all", async () => {
    const deps = makeDeps();
    const runtime = createProductionRuntime({}, deps);
    const spec = makeSpec({ env: { NODE_ENV: "production", SOME_APP_FLAG: "1" } });
    await runtime.start(makeOpts({ sandboxSpec: spec }));
    expect(deps.launchSandbox).toHaveBeenCalledOnce();
  });
});

describe("production runner resume applies the same checks as start (Spec H04 fix-round item 5)", () => {
  it("resume re-validates the sandbox spec and refuses if the connection is no longer ok", async () => {
    const deps = makeDeps();
    const runtime = createProductionRuntime({}, deps);
    const { handle } = await runtime.start(makeOpts({ sandboxSpec: makeSpec() }));

    (deps.getConnectionStatus as ReturnType<typeof vi.fn>).mockResolvedValue("broken");
    await expect(runtime.resume(handle, "session-1", "continue")).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
    expect(deps.resumeSandbox).not.toHaveBeenCalled();
  });

  it("resume calls getConnectionStatus again (not just once, at start)", async () => {
    const deps = makeDeps();
    const runtime = createProductionRuntime({}, deps);
    const { handle } = await runtime.start(makeOpts({ sandboxSpec: makeSpec() }));
    await runtime.resume(handle, "session-1", "continue");
    expect(deps.getConnectionStatus).toHaveBeenCalledTimes(2);
  });

  it("resume delegates to deps.resumeSandbox once every check passes", async () => {
    const deps = makeDeps();
    const runtime = createProductionRuntime({}, deps);
    const { handle } = await runtime.start(makeOpts({ sandboxSpec: makeSpec() }));
    await runtime.resume(handle, "session-1", "continue");
    expect(deps.resumeSandbox).toHaveBeenCalledWith(handle, "session-1", "continue");
  });

  it("refuses to resume a handle with no recorded sandboxSpec (e.g. hand-built by a caller)", async () => {
    const deps = makeDeps();
    const runtime = createProductionRuntime({}, deps);
    await expect(runtime.resume({ runId: "r1" }, "session-1", "continue")).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
    expect(deps.resumeSandbox).not.toHaveBeenCalled();
  });

  it("stop still delegates directly to deps.stopSandbox (no spec to re-check)", async () => {
    const deps = makeDeps();
    const runtime = createProductionRuntime({}, deps);
    const { handle } = await runtime.start(makeOpts({ sandboxSpec: makeSpec() }));
    await runtime.stop(handle);
    expect(deps.stopSandbox).toHaveBeenCalledWith(handle);
  });
});

/**
 * Spec H04 fix-round 2 item 1: createProductionRuntime only ever checked
 * the passed-in `env` — a call site that (accidentally or otherwise) built
 * an empty/curated env object could construct successfully even while the
 * REAL process.env carried a subscription credential. At 7262dd9,
 * `createProductionRuntime({}, deps)` with `process.env.CLAUDE_CODE_OAUTH_TOKEN`
 * set would NOT throw; every test below is red against that commit and
 * green after.
 */
describe("production runner also checks the real process.env (Spec H04 fix-round 2 item 1)", () => {
  const originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  afterEach(() => {
    if (originalOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken;
  });

  it("refuses to construct when CLAUDE_CODE_OAUTH_TOKEN is only set on process.env, not on the passed env", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-token";
    expect(() => createProductionRuntime({}, makeDeps())).toThrow(SubscriptionCredentialsRefused);
  });

  it("refuses when process.env carries a subscription-token-shaped value under an unrelated key", () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    (process.env as Record<string, string>).SOME_OTHER_VAR = FAKE_OAUTH_TOKEN;
    try {
      expect(() => createProductionRuntime({}, makeDeps())).toThrow(SubscriptionCredentialsRefused);
    } finally {
      delete (process.env as Record<string, string | undefined>).SOME_OTHER_VAR;
    }
  });

  it("still constructs when neither the passed env nor process.env carries a credential", () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(() => createProductionRuntime({}, makeDeps())).not.toThrow();
  });
});

/**
 * Spec H04 fix-round 2 item 2 (CWE-522): the subscription-token-shape check
 * used `value.startsWith(prefix)`, so a token embedded anywhere but the
 * start of the string — behind a scheme prefix, a leading space, anything
 * — passed unnoticed, in BOTH the orchestrator env and the sandbox env
 * (they share the same underlying check). Every test below is red at
 * 7262dd9 and green after.
 */
describe("subscription-token shape is matched anywhere in the value, not just as a prefix (Spec H04 fix-round 2 item 2)", () => {
  it("refuses an orchestrator env value with a 'Bearer ' prefix before the token", () => {
    expect(() =>
      createProductionRuntime({ ANTHROPIC_AUTH_TOKEN: `Bearer ${FAKE_OAUTH_TOKEN}` }, makeDeps()),
    ).toThrow(SubscriptionCredentialsRefused);
  });

  it("refuses an orchestrator env value with a leading space before the token", () => {
    expect(() =>
      createProductionRuntime({ ANTHROPIC_AUTH_TOKEN: ` ${FAKE_OAUTH_TOKEN}` }, makeDeps()),
    ).toThrow(SubscriptionCredentialsRefused);
  });

  it("refuses a sandbox env value with a 'Bearer ' prefix before the token", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { SOME_OTHER_VAR: `Bearer ${FAKE_OAUTH_TOKEN}` } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("refuses a sandbox env value with a leading space before the token", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { SOME_OTHER_VAR: ` ${FAKE_OAUTH_TOKEN}` } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });
});

/**
 * Spec H04 fix-round 2 item 3: the sandbox-env key-name ban was a blanket
 * `^ANTHROPIC_`/`^CLAUDE_CODE_` prefix (so a harmless setting like
 * `ANTHROPIC_MODEL` was refused for no reason), and the value-shape scan
 * only ever checked for the OAuth shape — a tenant key shape
 * (`sk-ant-api…`, `sk-ant-admin…`, `vck_…`) under an unrelated key name
 * sailed through. Both halves are tested below; the allow-side tests are
 * green at both 7262dd9 and after (behavior that must not regress), the
 * refuse-side new-shape tests are red at 7262dd9 and green after.
 */
describe("sandbox env key/value rules are narrower on names, broader on shapes (Spec H04 fix-round 2 item 3)", () => {
  it("allows a harmless ANTHROPIC_MODEL setting through", async () => {
    const deps = makeDeps();
    const runtime = createProductionRuntime({}, deps);
    const spec = makeSpec({ env: { ANTHROPIC_MODEL: "claude-haiku-4-5" } });
    await runtime.start(makeOpts({ sandboxSpec: spec }));
    expect(deps.launchSandbox).toHaveBeenCalledOnce();
  });

  it("still refuses a future ANTHROPIC_*_TOKEN-shaped key name even though it isn't in the exact list", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { ANTHROPIC_REFRESH_TOKEN: "whatever" } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("still refuses a future CLAUDE_CODE_*_SECRET-shaped key name", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { CLAUDE_CODE_SESSION_SECRET: "whatever" } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("refuses an sk-ant-api-shaped value under a completely unrelated key name", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { MY_SECRET_STASH: "sk-ant-api03-fake-value-not-real-0000000000" } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("refuses an sk-ant-admin-shaped value under a completely unrelated key name", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { MY_SECRET_STASH: "sk-ant-admin01-fake-value-not-real-000000000" } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });

  it("refuses a vck_-shaped value under a completely unrelated key name", async () => {
    const runtime = createProductionRuntime({}, makeDeps());
    const spec = makeSpec({ env: { MY_SECRET_STASH: "vck_fakeGatewayKeyNotRealValue1234567890" } });
    await expect(runtime.start(makeOpts({ sandboxSpec: spec }))).rejects.toThrow(
      SubscriptionCredentialsRefused,
    );
  });
});
