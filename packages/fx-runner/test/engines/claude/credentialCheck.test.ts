import { describe, expect, it } from "vitest";
import { initCredentialMatches } from "../../../src/engines/claude/credentialCheck.js";

// The values the init line can carry (from the pinned build's type declarations), by mode.
const SOURCES = ["ANTHROPIC_API_KEY", "apiKeyHelper", ["/login", "managed key"].join(" "), "none", "user", "project", "org", "temporary", "oauth"];

describe("init-line credential check", () => {
  it("subscription mode accepts only `none`; API-key mode accepts only ANTHROPIC_API_KEY", () => {
    for (const source of SOURCES) {
      expect(initCredentialMatches("subscription", { apiKeySource: source }), source).toBe(source === "none");
      expect(initCredentialMatches("api_key", { apiKeySource: source }), source).toBe(source === "ANTHROPIC_API_KEY");
    }
    expect(initCredentialMatches("subscription", {})).toBe(false);
    expect(initCredentialMatches("api_key", { apiKeySource: 1 })).toBe(false);
  });
});
