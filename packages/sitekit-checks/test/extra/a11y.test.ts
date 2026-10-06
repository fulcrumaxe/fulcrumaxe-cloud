import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run as checkA11y } from "../../src/extra/a11y.js";
import { CHECKS } from "../../src/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "check-a11y");

describe("check-a11y", () => {
  it("is registered under its os-site-v2 name", () => {
    expect(CHECKS["check-a11y"]).toBe(checkA11y);
  });

  it("passes a site meeting all five rules, including a wrapped input and a translated page", async () => {
    const result = await checkA11y(path.join(FIXTURES, "pass"));
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary?.pages).toBe(2); // index.html and es/index.html
  });

  it.each(["img_missing_alt", "h1_count", "html_missing_lang", "input_missing_label", "missing_skip_link"])(
    "fails the %s fixture with exactly that finding",
    async (kind) => {
      const result = await checkA11y(path.join(FIXTURES, "fail", kind));
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.kind)).toEqual([kind]);
      expect(result.findings[0].severity).toBe("error");
    },
  );

  it("exempts /404.html from the skip link by default, but not from the h1 rule", async () => {
    const result = await checkA11y(path.join(FIXTURES, "exempt"), {});
    // locked.html has no h1 and no skip link; 404.html has no skip link.
    expect(result.findings.map((f) => `${f.path} ${f.kind}`).sort()).toEqual([
      "/locked.html h1_count",
      "/locked.html missing_skip_link",
    ]);
  });

  it("honours h1ExemptPaths and skipLinkExemptPaths", async () => {
    const result = await checkA11y(path.join(FIXTURES, "exempt"), {
      h1ExemptPaths: ["/locked.html"],
      skipLinkExemptPaths: ["/404.html", "/locked.html"],
    });
    expect(result.ok).toBe(true);
  });

  it("honours skipLinkClass", async () => {
    const result = await checkA11y(path.join(FIXTURES, "pass"), { skipLinkClass: "jump" });
    expect(result.findings.map((f) => f.kind)).toEqual(["missing_skip_link", "missing_skip_link"]);
  });
});
