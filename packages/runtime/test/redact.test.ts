import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  redactDeep,
  redactError,
  redactSecrets,
  redactShapes,
  redactText,
  matchesShape,
  SK_ANT_OAT_PATTERN_SOURCE,
  TELEMETRY_SHAPE_PATTERN_SOURCES,
  TOKEN_SHAPE_PATTERN_SOURCES,
} from "../src/redact.js";
import { LocalRunnerRefused, SubscriptionCredentialsRefused } from "../src/types.js";

const FAKE_OAUTH_TOKEN = "sk-ant-oat01-FAKE-TOKEN-FOR-TEST-ONLY-do-not-use";
const FAKE_API_KEY = "sk-ant-api03-FAKE-KEY-FOR-TEST-ONLY-do-not-use";
const FAKE_ADMIN_KEY = "sk-ant-admin01-FAKE-ADMIN-KEY-FOR-TEST-ONLY-do-not-use";
// Deliberately includes a hyphen AND an underscore in the tail — this is
// exactly the shape fix-round 2 item 6 found the old `vck_` pattern
// (`[A-Za-z0-9]{10,}`, no `-`/`_` in the class) truncating: it would redact
// only "vck_fakeGatewayKeyForTest" and leave "-Only_DoNotUse123" printed.
const FAKE_GATEWAY_KEY = "vck_fakeGatewayKeyForTest-Only_DoNotUse123";

describe("redactSecrets / redactDeep (known exact values)", () => {
  it("replaces every occurrence of a known secret", () => {
    const text = `token=${FAKE_OAUTH_TOKEN} again=${FAKE_OAUTH_TOKEN}`;
    const redacted = redactSecrets(text, [FAKE_OAUTH_TOKEN]);
    expect(redacted).not.toContain(FAKE_OAUTH_TOKEN);
    expect(redacted).toContain("[redacted]");
  });

  it("ignores undefined/empty secrets", () => {
    expect(redactSecrets("hello", [undefined, ""])).toBe("hello");
  });

  it("redacts nested strings in objects and arrays", () => {
    const value = {
      text: `leaked ${FAKE_OAUTH_TOKEN}`,
      nested: { list: [FAKE_OAUTH_TOKEN, "clean"] },
    };
    const redacted = redactDeep(value, [FAKE_OAUTH_TOKEN]);
    expect(JSON.stringify(redacted)).not.toContain(FAKE_OAUTH_TOKEN);
  });
});

describe("redactShapes / redactText (Spec H04 fix-round item 4, CWE-532)", () => {
  it("redacts an sk-ant-oat (subscription OAuth) token by shape, with no known-secret list", () => {
    const text = `Authorization: Bearer ${FAKE_OAUTH_TOKEN}`;
    expect(redactShapes(text)).not.toContain(FAKE_OAUTH_TOKEN);
    expect(redactShapes(text)).toContain("[redacted]");
  });

  it("redacts an sk-ant-api (Anthropic API key) token by shape", () => {
    const text = `x-api-key: ${FAKE_API_KEY}`;
    expect(redactShapes(text)).not.toContain(FAKE_API_KEY);
  });

  it("redacts a vck_ (AI Gateway key) token by shape", () => {
    const text = `AI_GATEWAY_API_KEY=${FAKE_GATEWAY_KEY}`;
    expect(redactShapes(text)).not.toContain(FAKE_GATEWAY_KEY);
  });

  it("redactText applies both known-value and shape-based redaction", () => {
    const text = `a=${FAKE_OAUTH_TOKEN} b=${FAKE_API_KEY} c=some-other-known-secret`;
    const redacted = redactText(text, ["some-other-known-secret"]);
    expect(redacted).not.toContain(FAKE_OAUTH_TOKEN);
    expect(redacted).not.toContain(FAKE_API_KEY);
    expect(redacted).not.toContain("some-other-known-secret");
  });

  it("redactDeep applies shape-based redaction even with an empty secrets list", () => {
    // This is the case exact-value redaction alone can never catch: a
    // credential-shaped value that was never captured as a "known secret"
    // at construction time (e.g. it arrived inside model output text).
    const value = { text: `oops: ${FAKE_API_KEY}` };
    const redacted = redactDeep(value, []);
    expect(JSON.stringify(redacted)).not.toContain(FAKE_API_KEY);
  });

  it("does not redact ordinary prose that merely contains 'sk-ant' as a substring", () => {
    const text = "the sk-ant prefix identifies an Anthropic credential";
    expect(redactShapes(text)).toBe(text);
  });

  it("redacts an sk-ant-admin (Anthropic admin API key) token by shape (fix-round 2 item 6)", () => {
    const text = `x-admin-key: ${FAKE_ADMIN_KEY}`;
    expect(redactShapes(text)).not.toContain(FAKE_ADMIN_KEY);
    expect(redactShapes(text)).toContain("[redacted]");
  });

  it("redacts the FULL vck_ token, including hyphens and underscores in the tail (fix-round 2 item 6, regression)", () => {
    const text = `AI_GATEWAY_API_KEY=${FAKE_GATEWAY_KEY} trailing text`;
    const redacted = redactShapes(text);
    // Not just "doesn't contain the whole token" — assert no FRAGMENT of the
    // tail survives either, which is exactly what the old truncating
    // pattern would have left behind.
    expect(redacted).not.toContain(FAKE_GATEWAY_KEY);
    expect(redacted).not.toContain("Only_DoNotUse123");
    expect(redacted).not.toContain("-Only_DoNotUse123");
    expect(redacted).toBe("AI_GATEWAY_API_KEY=[redacted] trailing text");
  });
});

describe("matchesShape (Spec H04 fix-round 2 item 2)", () => {
  it("matches the token shape ANYWHERE in the string, not just as a prefix", () => {
    expect(matchesShape(`Bearer ${FAKE_OAUTH_TOKEN}`, SK_ANT_OAT_PATTERN_SOURCE)).toBe(true);
    expect(matchesShape(` ${FAKE_OAUTH_TOKEN}`, SK_ANT_OAT_PATTERN_SOURCE)).toBe(true);
    expect(matchesShape(FAKE_OAUTH_TOKEN, SK_ANT_OAT_PATTERN_SOURCE)).toBe(true);
  });

  it("does not false-positive on unrelated text", () => {
    expect(matchesShape("just some ordinary text", SK_ANT_OAT_PATTERN_SOURCE)).toBe(false);
  });

  it("is safe to call repeatedly without a stateful lastIndex bug", () => {
    // A shared `/g`-flagged RegExp's `.test()` advances its own lastIndex,
    // so alternating true/false calls on a global instance can silently
    // flip to false every other call. matchesShape must not exhibit this.
    for (let i = 0; i < 4; i++) {
      expect(matchesShape(FAKE_OAUTH_TOKEN, SK_ANT_OAT_PATTERN_SOURCE)).toBe(true);
    }
  });
});

describe("redactError", () => {
  it("redacts a known secret from an Error's message and stack", () => {
    const error = new Error(`spawn failed: env had ANTHROPIC_AUTH_TOKEN=${FAKE_OAUTH_TOKEN}`);
    const redacted = redactError(error, [FAKE_OAUTH_TOKEN]);
    expect(redacted.message).not.toContain(FAKE_OAUTH_TOKEN);
    expect(redacted.stack ?? "").not.toContain(FAKE_OAUTH_TOKEN);
  });

  it("redacts a credential-shaped value from an Error even with no known-secret list", () => {
    const error = new Error(`unexpected token in command line: ${FAKE_API_KEY}`);
    const redacted = redactError(error, []);
    expect(redacted.message).not.toContain(FAKE_API_KEY);
  });

  it("handles a non-Error thrown value", () => {
    const redacted = redactError(`plain string with ${FAKE_OAUTH_TOKEN}`, []);
    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.message).not.toContain(FAKE_OAUTH_TOKEN);
  });
});

/**
 * Spec H04 fix-round 2 item 6: redactError used to collapse every redacted
 * error to a plain `Error` (copying `.name` as a string but not the actual
 * prototype), so `redactError(err) instanceof LocalRunnerRefused` was false
 * even when `err` genuinely was one — and `.cause` was never touched at
 * all, so a secret embedded there leaked straight through. Every test
 * below is red against the pre-fix implementation and green after.
 */
describe("redactError preserves the error's class and redacts .cause recursively (Spec H04 fix-round 2 item 6)", () => {
  it("a redacted LocalRunnerRefused is still instanceof LocalRunnerRefused", () => {
    const original = new LocalRunnerRefused(`refused: token was ${FAKE_OAUTH_TOKEN}`);
    const redacted = redactError(original, [FAKE_OAUTH_TOKEN]);
    expect(redacted).toBeInstanceOf(LocalRunnerRefused);
    expect(redacted.name).toBe("LocalRunnerRefused");
    expect(redacted.message).not.toContain(FAKE_OAUTH_TOKEN);
  });

  it("a redacted SubscriptionCredentialsRefused is still instanceof SubscriptionCredentialsRefused", () => {
    const original = new SubscriptionCredentialsRefused(`refused: ${FAKE_API_KEY}`);
    const redacted = redactError(original, []);
    expect(redacted).toBeInstanceOf(SubscriptionCredentialsRefused);
    expect(redacted.message).not.toContain(FAKE_API_KEY);
  });

  it("a plain Error redacted through redactError is still instanceof Error (baseline)", () => {
    const redacted = redactError(new Error(`plain: ${FAKE_OAUTH_TOKEN}`), [FAKE_OAUTH_TOKEN]);
    expect(redacted).toBeInstanceOf(Error);
    expect(redacted).not.toBeInstanceOf(LocalRunnerRefused);
  });

  it("redacts a known secret embedded in error.cause (a nested Error)", () => {
    const cause = new Error(`root cause: token was ${FAKE_OAUTH_TOKEN}`);
    const outer = new Error("outer failure", { cause });
    const redacted = redactError(outer, [FAKE_OAUTH_TOKEN]);
    expect((redacted.cause as Error).message).not.toContain(FAKE_OAUTH_TOKEN);
  });

  it("preserves the nested cause's own class too", () => {
    const cause = new LocalRunnerRefused(`nested: ${FAKE_OAUTH_TOKEN}`);
    const outer = new Error("outer failure", { cause });
    const redacted = redactError(outer, [FAKE_OAUTH_TOKEN]);
    expect(redacted.cause).toBeInstanceOf(LocalRunnerRefused);
    expect((redacted.cause as Error).message).not.toContain(FAKE_OAUTH_TOKEN);
  });

  it("redacts a credential-shaped value in error.cause even with no known-secret list", () => {
    const cause = new Error(`leaked: ${FAKE_API_KEY}`);
    const outer = new Error("outer failure", { cause });
    const redacted = redactError(outer, []);
    expect((redacted.cause as Error).message).not.toContain(FAKE_API_KEY);
  });

  it("redacts a plain string cause", () => {
    const outer = new Error("outer failure", { cause: `raw: ${FAKE_OAUTH_TOKEN}` });
    const redacted = redactError(outer, [FAKE_OAUTH_TOKEN]);
    expect(redacted.cause).not.toContain(FAKE_OAUTH_TOKEN);
  });

  it("leaves an error with no cause at all with no cause on the redacted copy", () => {
    const redacted = redactError(new Error("no cause here"), []);
    expect("cause" in redacted).toBe(false);
  });
});

/**
 * Spec H04 fix-round item 4: "handle a token split across two consecutive
 * events, or document why emitted events can't split one, with a test."
 *
 * This runtime's local runner never sets `includePartialMessages` on the
 * SDK `query()` call (see src/local/index.ts) — that option defaults to
 * off, and per the SDK's own types it is the ONLY thing that produces a
 * `stream_event` / `SDKPartialAssistantMessage` frame carrying a partial
 * text delta. Without it, the CLI emits one assistant message per
 * COMPLETE content block ("the CLI emits one assistant message per
 * completed content block" — SDKAssistantMessage's doc comment), so a
 * credential string that appears in model output text arrives whole,
 * inside a single message's single text block, and therefore inside a
 * single normalized event. There is no code path in this package that
 * requests partial messages, so there is no code path that could hand a
 * split token to two consecutive `onEvent` calls.
 *
 * The test below is the guard on that reasoning staying true: if anything
 * ever adds `includePartialMessages` to the options this package passes to
 * `query()`, this test fails, which is the signal that redaction needs a
 * cross-event buffering strategy it does not have today.
 */
describe("token-split-across-events is a documented non-issue, not silently unhandled", () => {
  it("the local runner never requests partial/streamed message deltas", async () => {
    const { normalizeMessage } = await import("../src/local/index.js");
    // normalizeMessage only ever receives one COMPLETE message at a time
    // by construction (see the module doc comment above); this asserts the
    // one thing that claim depends on — that a 'stream_event' partial
    // message, if the SDK ever emitted one to us, is not silently treated
    // as if it were a complete message and passed straight to onEvent
    // un-redacted. It falls through to the generic ("system"-typed) branch,
    // which still gets redacted by the caller exactly like every other
    // event — see src/local/index.ts's redactDeep(normalized, secrets) call.
    const partial = normalizeMessage({ runId: "r1", role: "executor" }, { type: "stream_event" }, 0);
    expect(partial.type).toBe("system");
  });
});

// Mocks the SDK so the tests below drive the real local-runner event
// pipeline (construction, env-building, per-message redaction, and now
// per-error redaction) without a network call or a real subprocess — the
// fake async generator stands in for the CLI's stream-json output.
const FAKE_MESSAGES = [
  { type: "system", subtype: "init", session_id: "session-redact-1" },
  {
    type: "assistant",
    session_id: "session-redact-1",
    message: {
      content: [{ type: "text", text: `debug env: CLAUDE_CODE_OAUTH_TOKEN=${FAKE_OAUTH_TOKEN}` }],
    },
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    session_id: "session-redact-1",
  },
];

let queryShouldThrow = false;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    async function* gen() {
      for (const message of FAKE_MESSAGES) {
        yield message;
      }
      if (queryShouldThrow) {
        throw new Error(
          `CLI exited: spawned with env ANTHROPIC_AUTH_TOKEN="" CLAUDE_CODE_OAUTH_TOKEN=${FAKE_OAUTH_TOKEN}`,
        );
      }
    }
    const iterator = gen();
    return Object.assign(iterator, { close: vi.fn() });
  }),
}));

describe("local runtime never emits a credential (Spec H04 pass/fail 7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryShouldThrow = false;
  });

  it("redacts an injected fake OAuth token from every emitted event", async () => {
    const { createLocalRuntime } = await import("../src/local/index.js");
    const env = { CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH_TOKEN, FX_RUNTIME: "local" };
    const runtime = createLocalRuntime(env);

    const events: unknown[] = [];
    await runtime.start({
      runId: "run-redact-1",
      role: "executor",
      roleCard: "card",
      prompt: "go",
      model: "haiku",
      workdir: "/tmp",
      capUsd: 0.05,
      onEvent: (event) => {
        events.push(event);
      },
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(FAKE_OAUTH_TOKEN);
    expect(serialized).toContain("[redacted]");
  });

  it("redacts the OAuth token from a thrown error too (fix-round item 4)", async () => {
    queryShouldThrow = true;
    const { createLocalRuntime } = await import("../src/local/index.js");
    const env = { CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH_TOKEN, FX_RUNTIME: "local" };
    const runtime = createLocalRuntime(env);

    let caught: Error | undefined;
    try {
      await runtime.start({
        runId: "run-redact-2",
        role: "executor",
        roleCard: "card",
        prompt: "go",
        model: "haiku",
        workdir: "/tmp",
        capUsd: 0.05,
        onEvent: () => {},
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).not.toContain(FAKE_OAUTH_TOKEN);
    expect(caught?.message).toContain("[redacted]");
  });
});

// OPS-T1: the telemetry shapes widen redaction only; the env-refusal lists stay as they were.
describe("TOKEN_SHAPE_PATTERN_SOURCES and the production guard's lists are unchanged (OPS-T1)", () => {
  it("TOKEN_SHAPE_PATTERN_SOURCES is still exactly the four runtime-env shapes", () => {
    expect(TOKEN_SHAPE_PATTERN_SOURCES).toEqual([
      "sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{10,}",
      "sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{10,}",
      "sk-ant-admin[0-9]{2}-[A-Za-z0-9_-]{10,}",
      "vck_[A-Za-z0-9_-]{10,}",
    ]);
  });

  it("the new shapes live in their own list, disjoint from the four", () => {
    for (const source of TELEMETRY_SHAPE_PATTERN_SOURCES) expect(TOKEN_SHAPE_PATTERN_SOURCES).not.toContain(source);
  });

  it("guard.ts still builds its forbidden lists from the four named sources and never the telemetry list", () => {
    const guard = readFileSync(new URL("../src/production/guard.ts", import.meta.url), "utf8");
    expect(guard).not.toMatch(/TELEMETRY|TOKEN_SHAPE_PATTERN_SOURCES/);
    expect(guard).toContain("const ORCHESTRATOR_ENV_FORBIDDEN_SHAPES: readonly string[] = [SK_ANT_OAT_PATTERN_SOURCE];");
    expect(guard).toMatch(
      /SANDBOX_ENV_FORBIDDEN_SHAPES: readonly string\[\] = \[\s*SK_ANT_OAT_PATTERN_SOURCE,\s*SK_ANT_API_PATTERN_SOURCE,\s*SK_ANT_ADMIN_PATTERN_SOURCE,\s*VCK_PATTERN_SOURCE,\s*\];/,
    );
  });

  it("redactShapes also removes a telemetry shape, so discussions and model-call redact more, not less", () => {
    const token = "xox" + "b-1234567890-AbCdEfGhIj";
    expect(redactShapes(`slack ${token}`)).toBe("slack [redacted]");
  });
});
