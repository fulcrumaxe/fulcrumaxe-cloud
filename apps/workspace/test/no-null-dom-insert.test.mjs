import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import fxDom from "../lint/index.mjs";

// The native DOM insertion methods print "null" for a null argument. These tests run the rule on small
// fixtures (the original repos-app shape must be reported; the spread shape and h() calls must not) and
// check the repo's real eslint config applies it to the first-party apps and the shell, and to nothing built.
const FIXTURES = fileURLToPath(new URL("./fixtures/dom-insert/", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const fixtureLinter = new ESLint({
  cwd: FIXTURES,
  overrideConfigFile: true,
  overrideConfig: [{ files: ["**/*.js"], plugins: { "fx-dom": fxDom }, rules: { "fx-dom/no-null-dom-insert": "error" } }],
});
const lint = async (file) => (await fixtureLinter.lintFiles([FIXTURES + file]))[0].messages;
const lineOf = (src, marker) => src.split("\n").findIndex((l) => l.includes(marker)) + 1;

describe("no-null-dom-insert rule", () => {
  it("reports the original repos-app shape and every other unsafe argument", async () => {
    const messages = await lint("flagged.js");
    const flagLines = readFileSync(FIXTURES + "flagged.js", "utf8")
      .split("\n")
      .flatMap((l, i) => (l.endsWith("// FLAG") ? [i + 1] : []));
    expect(flagLines).toHaveLength(11);
    expect(messages.map((m) => m.line)).toEqual(flagLines);
    expect(messages.every((m) => m.ruleId === "fx-dom/no-null-dom-insert")).toBe(true);
    expect(messages.map((m) => m.messageId)).toEqual([
      "conditionalNullish",
      "nullish",
      "nullish",
      "conditionalNullish",
      "andFalsy",
      "unproven",
      "unproven",
      "conditionalNullish",
      "unproven",
      "nullish",
      "unproven",
    ]);
  });

  it("names the repos-app pattern: a null branch in replaceChildren", async () => {
    const [first] = await lint("flagged.js");
    expect(first.message).toContain("replaceChildren()");
    expect(first.message).toContain("nullish branch");
  });

  it("leaves the spread pattern, h() calls, guards and a reasoned opt-out alone", async () => {
    expect(await lint("allowed.js")).toEqual([]);
  });

  it("does not accept an opt-out comment that gives no reason", async () => {
    const messages = await lint("flagged.js");
    const src = readFileSync(FIXTURES + "flagged.js", "utf8");
    expect(messages.at(-1).line).toBe(lineOf(src, "// dom-insert-ok:") + 1);
  });
});

describe("repo eslint config", () => {
  const eslint = new ESLint({ cwd: ROOT });
  const rulesFor = async (file) => (await eslint.calculateConfigForFile(ROOT + file))?.rules ?? {};

  it("applies the rule to the first-party apps and to the shell sources", async () => {
    for (const f of ["apps/workspace/apps/repos/repos-app.js", "apps/workspace/apps/_lib/dom.js", "apps/workspace/shell/core/modals.js", "apps/workspace/shell/script.js"]) {
      expect(await eslint.isPathIgnored(ROOT + f), f).toBe(false);
      expect((await rulesFor(f))["fx-dom/no-null-dom-insert"]?.[0], f).toBe(2);
    }
  });

  it("runs only this rule on the shell: the general rules stay off there", async () => {
    const shell = await rulesFor("apps/workspace/shell/core/modals.js");
    expect(shell["@typescript-eslint/no-unused-vars"]).toBeUndefined();
    expect(Object.keys(shell).filter((r) => r.startsWith("@typescript-eslint/"))).toEqual([]);
  });

  it("keeps build and dist output out", async () => {
    for (const f of ["apps/workspace/dist/index.js", "apps/workspace/shell/dist/x.js", "apps/web/public/workspace/script.js"]) {
      expect(await eslint.isPathIgnored(ROOT + f), f).toBe(true);
    }
  });
});
