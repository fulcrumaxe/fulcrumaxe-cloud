import { describe, expect, it, vi } from "vitest";
import {
  OPERATOR_ACCOUNT_IDS_ENV,
  OPERATOR_OAUTH_PLACEHOLDER,
  OPERATOR_SWITCH_ENV,
  OPERATOR_TOKEN_ENV,
  isOperatorTokenShape,
  operatorMode,
  operatorTokenFor,
  parseOperatorAccountIds,
} from "../src/operatorSubscription.js";
import { createProductionRuntime, type ProductionDeps } from "../src/production/index.js";
import { assertNoSubscriptionCredentials, assertSandboxSpecAllowed } from "../src/production/guard.js";
import { redactDeep, redactError, redactShapes, redactText } from "../src/redact.js";
import { SubscriptionCredentialsRefused } from "../src/types.js";
import type { SandboxSpec } from "../src/types.js";

const OPERATOR = "11111111-1111-4111-8111-111111111111";
const OTHER_OPERATOR = "33333333-3333-4333-8333-333333333333";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "sk-ant-oat01-FAKE-OPERATOR-TOKEN-FOR-TEST-ONLY";
const ANTHROPIC_URL = "https://api.anthropic.com";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/claude-code";

const onEnv = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  [OPERATOR_SWITCH_ENV]: "on",
  [OPERATOR_ACCOUNT_IDS_ENV]: `${OPERATOR},${OTHER_OPERATOR}`,
  [OPERATOR_TOKEN_ENV]: TOKEN,
  ...over,
});

describe("operatorMode: who gets the operator subscription", () => {
  it("admits a listed account when the switch is on and the token is configured", () => {
    expect(operatorMode(onEnv(), OPERATOR)).toEqual({ active: true });
    expect(operatorMode(onEnv(), OTHER_OPERATOR.toUpperCase())).toEqual({ active: true });
  });

  it("never admits an account that is not on the list, whatever else is set", () => {
    expect(operatorMode(onEnv(), CUSTOMER)).toEqual({ active: false, reason: "not_operator_account" });
    for (const bad of ["", "constructor", "__proto__", OPERATOR + "x", " " + OPERATOR, `${OPERATOR},${CUSTOMER}`, "*"]) {
      expect(operatorMode(onEnv(), bad).active).toBe(false);
    }
  });

  it("is off unless the switch is exactly 'on' (the kill switch)", () => {
    for (const v of [undefined, "", "ON", "On", "1", "true", "yes", " on", "on "]) {
      expect(operatorMode(onEnv({ [OPERATOR_SWITCH_ENV]: v }), OPERATOR)).toEqual({ active: false, reason: "switch_off" });
    }
  });

  it("is off with a missing or blank token, and with a value that is not subscription-token-shaped", () => {
    expect(operatorMode(onEnv({ [OPERATOR_TOKEN_ENV]: undefined }), OPERATOR)).toEqual({ active: false, reason: "token_missing" });
    expect(operatorMode(onEnv({ [OPERATOR_TOKEN_ENV]: "" }), OPERATOR)).toEqual({ active: false, reason: "token_missing" });
    for (const v of ["sk-ant-api03-FAKE-API-KEY-FOR-TEST-ONLY", `Bearer ${TOKEN}`, ` ${TOKEN}`, `${TOKEN}\n`, "brokered-at-firewall", "sk-ant-oat01-short"]) {
      expect(operatorMode(onEnv({ [OPERATOR_TOKEN_ENV]: v }), OPERATOR)).toEqual({ active: false, reason: "token_invalid" });
    }
  });

  it("is off with a missing list, and one bad entry turns the whole list off", () => {
    expect(operatorMode(onEnv({ [OPERATOR_ACCOUNT_IDS_ENV]: undefined }), OPERATOR)).toEqual({ active: false, reason: "account_list_missing" });
    expect(operatorMode(onEnv({ [OPERATOR_ACCOUNT_IDS_ENV]: "  " }), OPERATOR)).toEqual({ active: false, reason: "account_list_missing" });
    for (const v of [`${OPERATOR},not-a-uuid`, `${OPERATOR},`, `,${OPERATOR}`, `${OPERATOR};${OTHER_OPERATOR}`, "*", "all"]) {
      expect(operatorMode(onEnv({ [OPERATOR_ACCOUNT_IDS_ENV]: v }), OPERATOR)).toEqual({ active: false, reason: "account_list_invalid" });
    }
  });

  it("ignores a setting that is only inherited (a polluted prototype is not configuration)", () => {
    const env = Object.create({ [OPERATOR_SWITCH_ENV]: "on", [OPERATOR_ACCOUNT_IDS_ENV]: OPERATOR, [OPERATOR_TOKEN_ENV]: TOKEN }) as Record<string, string | undefined>;
    expect(operatorMode(env, OPERATOR).active).toBe(false);
  });

  it("carries a reason and never a value", () => {
    for (const env of [onEnv(), onEnv({ [OPERATOR_TOKEN_ENV]: "sk-ant-api03-FAKE-API-KEY-FOR-TEST-ONLY" }), onEnv({ [OPERATOR_SWITCH_ENV]: "off" })]) {
      const text = JSON.stringify(operatorMode(env, OPERATOR));
      expect(text).not.toContain("FAKE");
      expect(text).not.toContain(OPERATOR);
    }
  });
});

describe("operatorTokenFor: the one reader of the token", () => {
  it("returns the token only when every named account is admitted", () => {
    expect(operatorTokenFor(onEnv(), OPERATOR)).toBe(TOKEN);
    expect(operatorTokenFor(onEnv(), OPERATOR, OTHER_OPERATOR)).toBe(TOKEN);
  });

  it("returns nothing when the run's account or its payer is a customer (a customer can never borrow an operator's mode)", () => {
    expect(operatorTokenFor(onEnv(), CUSTOMER)).toBeUndefined();
    expect(operatorTokenFor(onEnv(), CUSTOMER, OPERATOR)).toBeUndefined();
    expect(operatorTokenFor(onEnv(), OPERATOR, CUSTOMER)).toBeUndefined();
  });

  it("returns nothing for no account, and nothing once the switch is off or the token revoked from the env", () => {
    expect(operatorTokenFor(onEnv())).toBeUndefined();
    expect(operatorTokenFor(onEnv({ [OPERATOR_SWITCH_ENV]: "off" }), OPERATOR)).toBeUndefined();
    expect(operatorTokenFor(onEnv({ [OPERATOR_TOKEN_ENV]: undefined }), OPERATOR)).toBeUndefined();
  });

});

describe("parse and shape helpers", () => {
  it("parses a clean list, lower-casing and trimming", () => {
    expect([...(parseOperatorAccountIds(` ${OPERATOR.toUpperCase()} , ${CUSTOMER}`) ?? [])]).toEqual([OPERATOR, CUSTOMER]);
    expect(parseOperatorAccountIds(undefined)).toBeNull();
    expect(parseOperatorAccountIds("")).toBeNull();
  });

  it("recognises only the setup-token shape", () => {
    expect(isOperatorTokenShape(TOKEN)).toBe(true);
    expect(isOperatorTokenShape("sk-ant-admin01-FAKE-ADMIN-KEY-FOR-TEST-ONLY")).toBe(false);
    expect(isOperatorTokenShape(undefined)).toBe(false);
  });
});

function makeDeps(): ProductionDeps {
  return {
    getConnectionStatus: vi.fn().mockResolvedValue("ok"),
    launchSandbox: vi.fn().mockResolvedValue({ handle: { runId: "r1" } }),
    stopSandbox: vi.fn().mockResolvedValue(undefined),
    resumeSandbox: vi.fn().mockResolvedValue({ handle: { runId: "r1" } }),
  };
}

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  sandboxName: "ex-repo-1",
  provider: "anthropic",
  baseUrl: ANTHROPIC_URL,
  tenantId: "tenant-1",
  operatorSubscription: true,
  env: { CLAUDE_CODE_OAUTH_TOKEN: OPERATOR_OAUTH_PLACEHOLDER },
  ...over,
});

describe("guard: the orchestrator holds the operator token under its one name only", () => {
  it("allows the operator token under FX_OPERATOR_CLAUDE_OAUTH_TOKEN", () => {
    expect(() => assertNoSubscriptionCredentials({ [OPERATOR_TOKEN_ENV]: TOKEN })).not.toThrow();
    expect(() => createProductionRuntime({ [OPERATOR_TOKEN_ENV]: TOKEN }, makeDeps())).not.toThrow();
  });

  it("still refuses the same value under any other name", () => {
    for (const name of ["ANTHROPIC_AUTH_TOKEN", "FX_OPERATOR_CLAUDE_OAUTH_TOKEN_COPY", "FX_OPERATOR_TOKEN", "FX_OPERATOR_CLAUDE_OAUTH_TOKE", "SOME_OTHER_VAR"]) {
      expect(() => assertNoSubscriptionCredentials({ [name]: TOKEN }), name).toThrow(SubscriptionCredentialsRefused);
    }
  });

  it("still refuses CLAUDE_CODE_OAUTH_TOKEN, even alongside the operator setting", () => {
    expect(() => assertNoSubscriptionCredentials({ [OPERATOR_TOKEN_ENV]: TOKEN, CLAUDE_CODE_OAUTH_TOKEN: OPERATOR_OAUTH_PLACEHOLDER })).toThrow(SubscriptionCredentialsRefused);
    expect(() => assertNoSubscriptionCredentials({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN })).toThrow(SubscriptionCredentialsRefused);
  });
});

describe("guard: the sandbox env gets the placeholder in operator mode and nothing else", () => {
  it("allows exactly the operator spec: the Anthropic default, the placeholder, the flag", () => {
    expect(() => assertSandboxSpecAllowed(spec())).not.toThrow();
  });

  it("refuses the placeholder when the spec is not an operator spec", () => {
    expect(() => assertSandboxSpecAllowed(spec({ operatorSubscription: undefined }))).toThrow(SubscriptionCredentialsRefused);
    expect(() => assertSandboxSpecAllowed(spec({ provider: "ai_gateway", baseUrl: GATEWAY_URL, operatorSubscription: undefined }))).toThrow(SubscriptionCredentialsRefused);
  });

  it("refuses any other value under CLAUDE_CODE_OAUTH_TOKEN, a real token included", () => {
    for (const value of [TOKEN, "x", "", `${OPERATOR_OAUTH_PLACEHOLDER} `, "Brokered-At-Firewall"]) {
      expect(() => assertSandboxSpecAllowed(spec({ env: { CLAUDE_CODE_OAUTH_TOKEN: value } })), value).toThrow(SubscriptionCredentialsRefused);
    }
  });

  it("refuses the flag toward the gateway, a different base URL, or as anything but exactly true", () => {
    expect(() => assertSandboxSpecAllowed(spec({ provider: "ai_gateway", baseUrl: GATEWAY_URL }))).toThrow(SubscriptionCredentialsRefused);
    expect(() => assertSandboxSpecAllowed(spec({ baseUrl: "https://evil.example" }))).toThrow(SubscriptionCredentialsRefused);
    expect(() => assertSandboxSpecAllowed(spec({ operatorSubscription: "true" as unknown as true }))).toThrow(SubscriptionCredentialsRefused);
    expect(() => assertSandboxSpecAllowed(spec({ operatorSubscription: 1 as unknown as true }))).toThrow(SubscriptionCredentialsRefused);
  });

  it("keeps every other credential refused in operator mode", () => {
    for (const extra of <Record<string, string>[]>[
      { ANTHROPIC_AUTH_TOKEN: OPERATOR_OAUTH_PLACEHOLDER },
      { ANTHROPIC_API_KEY: "k" },
      { ANTHROPIC_BASE_URL: "https://evil.example" },
      { SOMETHING: TOKEN },
      { SOMETHING: "sk-ant-api03-FAKE-API-KEY-FOR-TEST-ONLY" },
    ]) {
      expect(() => assertSandboxSpecAllowed(spec({ env: { CLAUDE_CODE_OAUTH_TOKEN: OPERATOR_OAUTH_PLACEHOLDER, ...extra } }))).toThrow(SubscriptionCredentialsRefused);
    }
  });

  it("starts through the production runtime only for an operator spec", async () => {
    const deps = makeDeps();
    const runtime = createProductionRuntime({}, deps);
    const opts = { runId: "run-1", role: "executor", roleCard: "c", prompt: "p", model: "m", capUsd: 1, onEvent: vi.fn() };
    await runtime.start({ ...opts, sandboxSpec: spec() });
    expect(deps.launchSandbox).toHaveBeenCalledOnce();
    await expect(runtime.start({ ...opts, sandboxSpec: spec({ operatorSubscription: undefined }) })).rejects.toThrow(SubscriptionCredentialsRefused);
  });
});

describe("redaction covers the operator token on every log path", () => {
  const sentence = `request failed with ${TOKEN} in the header`;

  it("shape redaction removes a token it never saw verbatim", () => {
    expect(redactShapes(sentence)).not.toContain("FAKE-OPERATOR");
    expect(redactText(sentence, [])).not.toContain("FAKE-OPERATOR");
  });

  it("deep and error redaction remove it from nested values, messages and causes", () => {
    const deep = redactDeep({ a: { b: [sentence] } }, []);
    expect(JSON.stringify(deep)).not.toContain("FAKE-OPERATOR");
    const err = redactError(new Error(sentence, { cause: new Error(sentence) }), []);
    expect(err.message).not.toContain("FAKE-OPERATOR");
    expect(String((err as Error & { cause?: Error }).cause?.message)).not.toContain("FAKE-OPERATOR");
  });

  it("exact-value redaction removes it when the worker names it as a secret", () => {
    expect(redactText("x " + TOKEN + " y", [TOKEN])).toBe("x [redacted] y");
  });
});
