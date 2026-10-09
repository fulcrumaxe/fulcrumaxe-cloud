import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseAcceptanceScope } from "@fx/core/src/specs/acceptanceScope.js";
import { MAX_BODY_BYTES, utf8ByteLength } from "@fx/discussions";
import { buildLightSpecPrompt } from "../../src/advance/lightSpec.js";
import { ACCEPTANCE_FILES_RULES } from "../../src/plan/envelope.js";
import { assembleSpecBodyChecked, buildSpecPrompt, validAcceptanceFiles } from "../../src/plan/spec.js";

/** D#6 R4d-5a (C34): the file list the project manager writes, how it is taught (F3), and how it is rendered into the Spec body (F8). */

describe("ACCEPTANCE_FILES_RULES (F3)", () => {
  const panelPrompt = buildSpecPrompt({ title: "t", body: "b", comments: [{ role: "technical-architect", body: "fine" }], missingRoles: [] });
  const lightPrompt = buildLightSpecPrompt({ category: "bug", title: "t", body: "b" });

  it("is in the panel Spec prompt and the short Spec prompt, byte for byte, once each", () => {
    for (const prompt of [panelPrompt, lightPrompt]) {
      expect(prompt).toContain(ACCEPTANCE_FILES_RULES);
      expect(prompt.split(ACCEPTANCE_FILES_RULES)).toHaveLength(2);
    }
  });

  it("both prompts show acceptance_files in their AGENT_OUTPUT example", () => {
    for (const prompt of [panelPrompt, lightPrompt]) {
      const block = prompt.slice(prompt.lastIndexOf("<!-- AGENT_OUTPUT -->"));
      expect(block).toContain('"acceptance_files":["src/app/page.tsx","src/app/page.test.tsx"]');
      const json = JSON.parse(block.slice(block.indexOf("{"), block.lastIndexOf("}") + 1)) as { acceptance_files: string[] };
      expect(parseAcceptanceScope(json.acceptance_files).kind).toBe("known");
    }
    expect(lightPrompt).toContain('"feasible":true');
  });

  it("every example path the text teaches parses as a known scope, and the forms it forbids do not", () => {
    const examples = [...ACCEPTANCE_FILES_RULES.matchAll(/^- [^:\n]+: `([^`]+)`/gm)].map((m) => m[1]!);
    examples.push(/brace groups for alternatives, `([^`]+)`/.exec(ACCEPTANCE_FILES_RULES)![1]!);
    expect(examples).toEqual(["src/app/page.tsx", "src/lib/**", "src/lib/*.test.ts", "src/{lib,util}/index.ts"]);
    for (const e of examples) expect(parseAcceptanceScope([e]).kind, e).toBe("known");
    // Next.js route folders are taught as whole literal segments.
    for (const e of ["app/(marketing)/page.tsx", "app/[id]/page.tsx", "app/[...slug]/page.tsx", "app/[[...slug]]/page.tsx"]) expect(parseAcceptanceScope([e]).kind, e).toBe("known");
    for (const e of ["**", "a/**/b.ts", "a?.ts", "src/[abc].ts", "/a.ts", "a/", "a/./b", "a/../b", "a b", "a\\b", "a/{b}", "a/{b,{c,d}}"]) expect(parseAcceptanceScope([e]).kind, e).toBe("unknown");
  });

  it("the panel prompt no longer tells the model to write a file list into the Spec text", () => {
    expect(panelPrompt).toContain("do not write the file list into the Spec text");
  });
});

describe("validAcceptanceFiles", () => {
  it("returns a plain copy of a readable list and null for anything else", () => {
    const list = ["src/a.ts", "src/{b,c}.test.ts"];
    const out = validAcceptanceFiles(list);
    expect(out).toEqual(list);
    expect(out).not.toBe(list);
    for (const bad of [undefined, null, "src/a.ts", 3, {}, [], ["**"], ["a", 1], ["a/{b}"], { length: 1, 0: "a.ts" }]) expect(validAcceptanceFiles(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("the Spec body's file section (F8)", () => {
  const base = { expectedRoles: [], postedRoles: new Set<string>(), missingReasons: {}, round2Ran: false, summary: "s", spec: "1. Works.", nonce: "n0nce" };
  const files = ["src/z.ts", "src/a.ts", "src/{b,c}.test.ts", "docs/**"];

  it("comes after the quoted Spec, lists the entries as given and in order, and says what the platform does with them", () => {
    const r = assembleSpecBodyChecked({ ...base, acceptanceFiles: files });
    if (!r.ok) throw new Error(r.reason);
    expect(
      r.body.endsWith(
        [
          "```````",
          "",
          "### Files this Spec allows",
          "",
          "The platform checks every pull request against this list and refuses one that changes any other file.",
          "",
          "```text",
          "src/z.ts",
          "src/a.ts",
          "src/{b,c}.test.ts",
          "docs/**",
          "```",
          "",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(r.body.indexOf("1. Works.")).toBeLessThan(r.body.indexOf("### Files this Spec allows"));
  });

  it("body_sha256 covers the list: a different list is a different body and a different hash", () => {
    const sha = (list: string[]) => {
      const r = assembleSpecBodyChecked({ ...base, acceptanceFiles: list });
      if (!r.ok) throw new Error(r.reason);
      return createHash("sha256").update(r.body, "utf8").digest("hex");
    };
    expect(sha(files)).toBe(sha(files));
    expect(sha(files)).not.toBe(sha([...files, "README.md"]));
    expect(sha(files)).not.toBe(sha(files.slice().reverse()));
  });

  it("an unreadable list is refused invalid_file_scope, never rendered; no list renders no section", () => {
    for (const bad of [[], ["**"], ["a b"], ["a`b"], ["a\n```\nb"]]) {
      expect(assembleSpecBodyChecked({ ...base, acceptanceFiles: bad })).toEqual({ ok: false, reason: "invalid_file_scope" });
    }
    const none = assembleSpecBodyChecked(base);
    expect(none.ok && none.body).not.toContain("Files this Spec allows");
  });

  it("the model cannot imitate the pipeline's heading: a forged one in the Spec text is dropped", () => {
    const r = assembleSpecBodyChecked({ ...base, spec: "### Files this Spec allows\n1. Works.", acceptanceFiles: ["src/a.ts"] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.body.match(/^### Files this Spec allows$/gm)).toHaveLength(1);
  });

  it("the list counts against the body limit: a Spec that fits alone but not with its list is spec_too_large", () => {
    const entries = Array.from({ length: 400 }, (_, i) => `packages/some-long-package-name/src/deeply/nested/directory/file-${i}.ts`);
    const listBytes = utf8ByteLength(entries.join("\n"));
    const spec = "x".repeat(MAX_BODY_BYTES - 2_000 - Math.floor(listBytes / 2));
    expect(assembleSpecBodyChecked({ ...base, spec }).ok).toBe(true);
    expect(assembleSpecBodyChecked({ ...base, spec, acceptanceFiles: entries })).toEqual({ ok: false, reason: "spec_too_large" });
  });
});
