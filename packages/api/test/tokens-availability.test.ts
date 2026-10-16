import { afterEach, describe, expect, it } from "vitest";
import { tokensAvailable } from "../src/tokens/availability.js";
import { assertTokensAvailable } from "../src/routes/tokens.js";
import { PRE_TOKEN_DESCRIPTION, TOKENS_DESCRIPTION, describeTokens } from "../src/openapi.js";

const saved = { env: process.env.NODE_ENV, flag: process.env.FX_API_TOKENS_ENABLED };
const setEnv = (nodeEnv: string, flag?: string) => {
  (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
  if (flag === undefined) delete process.env.FX_API_TOKENS_ENABLED;
  else process.env.FX_API_TOKENS_ENABLED = flag;
};
afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = saved.env;
  if (saved.flag === undefined) delete process.env.FX_API_TOKENS_ENABLED;
  else process.env.FX_API_TOKENS_ENABLED = saved.flag;
});

describe("API tokens availability: one test behind the mint route and the reference's opening sentence", () => {
  it("production needs FX_API_TOKENS_ENABLED to be exactly 1 and no open blocker", () => {
    setEnv("production");
    expect(tokensAvailable()).toBe(false);
    setEnv("production", "true");
    expect(tokensAvailable()).toBe(false);
    setEnv("production", "1");
    expect(tokensAvailable()).toBe(true);
    expect(tokensAvailable(["API-9"])).toBe(false);
  });
  it("outside production tokens are always available", () => {
    setEnv("test");
    expect(tokensAvailable()).toBe(true);
  });
  it("the mint guard agrees with it in every case", () => {
    for (const [env, flag, blockers] of [["production", undefined, []], ["production", "1", []], ["production", "1", ["X"]], ["test", undefined, []]] as const) {
      setEnv(env, flag);
      let throws = false;
      try {
        assertTokensAvailable(blockers);
      } catch {
        throws = true;
      }
      expect(throws).toBe(!tokensAvailable(blockers));
    }
  });
  it("the reference says tokens aren't available only while they are not, and never claims it when they are", () => {
    const doc = { info: { title: "t", description: PRE_TOKEN_DESCRIPTION } };
    expect(describeTokens(doc, false).info.description).toBe(PRE_TOKEN_DESCRIPTION);
    const on = describeTokens(doc, true);
    expect(on.info.description).toBe(TOKENS_DESCRIPTION);
    expect(on.info.description).not.toMatch(/aren't available/);
    expect(doc.info.description).toBe(PRE_TOKEN_DESCRIPTION); // the committed document is not mutated
  });
});
