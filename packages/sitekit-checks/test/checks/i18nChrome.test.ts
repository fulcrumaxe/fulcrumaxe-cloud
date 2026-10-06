import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run as checkI18nChrome } from "../../src/checks/i18nChrome.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "check-i18n-chrome");
const WANTED = ["Learn more", "Sign in"];

describe("check-i18n-chrome", () => {
  it("passes when every language translates every wanted label", async () => {
    const result = await checkI18nChrome(path.join(FIXTURES, "pass"), { wantedLabels: WANTED });
    expect(result.ok).toBe(true);
  });

  it("fails a language missing a label and flags a stale extra translation", async () => {
    const result = await checkI18nChrome(path.join(FIXTURES, "fail"), { wantedLabels: WANTED });
    expect(result.ok).toBe(false);
    const kinds = result.findings.map((f) => f.kind);
    expect(kinds).toContain("missing_chrome_translation");
    expect(kinds).toContain("stale_chrome_translation");
    expect(result.findings.every((f) => f.message.startsWith("es "))).toBe(true);
  });
});
