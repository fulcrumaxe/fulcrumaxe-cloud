import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fingerprint, run as checkI18nCatalogue } from "../../src/checks/i18nCatalogue.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "check-i18n-catalogue");

describe("check-i18n-catalogue", () => {
  it("passes a fresh, structurally faithful translation", async () => {
    const result = await checkI18nCatalogue(path.join(FIXTURES, "pass"));
    expect(result.ok).toBe(true);
  });

  it("fails a stale fingerprint and a dropped price token", async () => {
    const result = await checkI18nCatalogue(path.join(FIXTURES, "fail"));
    expect(result.ok).toBe(false);
    const messages = result.findings.map((f) => f.message).join("\n");
    expect(messages).toMatch(/fingerprint does not match/);
    expect(messages).toMatch(/\$99.*appears 1x in English, 0x in translation/);
  });

  it("fingerprint() is a stable sha256 of the whitespace-normalized text", () => {
    expect(fingerprint("  a   b  ")).toBe(fingerprint("a b"));
    expect(fingerprint("a b")).toHaveLength(64);
  });
});
