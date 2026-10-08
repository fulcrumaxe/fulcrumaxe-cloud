import { describe, expect, it } from "vitest";
import { authPresent, type AuthMode } from "../../../src/engines/claude/authStatus.js";
import { cleanEnv } from "../../../src/job/cleanEnv.js";
import { authText, makeFake } from "./harness.js";
import { spawn } from "node:child_process";

const opts = (binaryPath: string, timeoutMs?: number) => ({ binaryPath, env: cleanEnv({ mode: "subscription" }), spawn, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

const CASES: Array<[string, AuthMode, boolean]> = [
  ["auth.claude_ai.json", "subscription", true],
  ["auth.api_key.json", "subscription", false],
  ["auth.none.json", "subscription", false],
  ["auth.third_party.json", "subscription", false],
  ["auth.api_key.json", "api_key", true],
  ["auth.claude_ai.json", "api_key", false],
  ["auth.none.json", "api_key", false],
  ["auth.third_party.json", "api_key", false],
];

describe("authPresent", () => {
  it.each(CASES)("%s in %s mode is %s", async (fixture, mode, expected) => {
    const fake = makeFake({ auth: authText(fixture) });
    expect((await authPresent(mode, opts(fake.binary))).present).toBe(expected);
  });

  it("oauth_token counts as a subscription login", async () => {
    const fake = makeFake({ auth: JSON.stringify({ authMethod: "oauth_token" }) });
    expect((await authPresent("subscription", opts(fake.binary))).present).toBe(true);
  });

  it("a non-zero exit, output that is not JSON, a missing or odd authMethod and a timeout are all false", async () => {
    const failing = makeFake({ auth: authText("auth.claude_ai.json") });
    failing.set("auth.fail", "1");
    expect((await authPresent("subscription", opts(failing.binary))).present).toBe(false);
    for (const auth of ["not json", "null", "{}", JSON.stringify({ authMethod: "claude.ai\nx" }), JSON.stringify({ authMethod: 5 })]) {
      expect((await authPresent("subscription", opts(makeFake({ auth }).binary))).present, auth).toBe(false);
    }
    const slow = makeFake();
    slow.set("auth.sleep", "1");
    expect((await authPresent("subscription", opts(slow.binary, 200))).present).toBe(false);
  });

  it("asks only `auth status` and keeps only the method label: no email or organisation comes back", async () => {
    const fake = makeFake();
    const result = await authPresent("subscription", opts(fake.binary));
    expect(fake.calls()).toEqual(["auth status"]);
    expect(Object.keys(result).sort()).toEqual(["authMethod", "present"]);
    expect(JSON.stringify(result)).not.toMatch(/example|someone/);
  });
});
