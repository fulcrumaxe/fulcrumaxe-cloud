import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubViolations } from "./helpers/githubScan.js";

const PLAN_DIR = join(import.meta.dirname, "../../src/plan");

/** Every TypeScript source under packages/pipeline/src/plan/, recursively. */
function planSources(dir: string = PLAN_DIR): Array<{ file: string; raw: string; code: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return planSources(join(dir, e.name));
    if (!e.name.endsWith(".ts")) return [];
    const raw = readFileSync(join(dir, e.name), "utf8");
    // Comments explain the rules and may name the things forbidden below.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return [{ file: join(dir, e.name).slice(PLAN_DIR.length + 1), raw, code }];
  });
}

const IMPORT_STORE = `import { createDiscussion } from "@fx/discussions";\n`;

describe("C20 criterion 8 as ruled by C39 (a): no GitHub Discussions call anywhere in packages/pipeline/src/plan/**", () => {
  it("every plan source is clean under the five rules (parsed, not grepped)", () => {
    const sources = planSources();
    expect(sources.length).toBeGreaterThan(5);
    for (const { file, raw } of sources) expect(githubViolations(raw, file), file).toEqual([]);
  });

  it("the store's createDiscussion is still used, exactly as the named import: the rule tests the real binding", () => {
    const triage = planSources().find((s) => s.file === "triage.ts")!;
    expect(triage.raw).toMatch(/import\s*\{[^}]*\bcreateDiscussion\b[^}]*\}\s*from\s*"@fx\/discussions"/);
  });

  // Mutation proof: each of these scratch changes turns the rule red.
  it("rule 1: GraphQL mutation text in a template literal, string or tagged template is a violation", () => {
    expect(githubViolations("const q = `mutation { createDiscussion(input: ${x}) { discussion { id } } }`;")).not.toEqual([]);
    expect(githubViolations('const q = "mutation { addDiscussionComment(input: {}) }";')).not.toEqual([]);
    expect(githubViolations("const q = gql`mutation { updateDiscussion(input: {}) }`;")).not.toEqual([]);
    expect(githubViolations("const q = `a ${b} updateDiscussion ${c}`;")).not.toEqual([]);
  });

  it("rule 2: a GitHub client import (any form) or api.github.com is a violation", () => {
    expect(githubViolations('import { graphql } from "@octokit/graphql";')).not.toEqual([]);
    expect(githubViolations('import { Octokit } from "octokit";')).not.toEqual([]);
    expect(githubViolations('export * from "@octokit/rest";')).not.toEqual([]);
    expect(githubViolations('const o = await import("@octokit/core");')).not.toEqual([]);
    expect(githubViolations('const o = require("@octokit/core");')).not.toEqual([]);
    expect(githubViolations('const u = "https://api.github.com/graphql";')).not.toEqual([]);
    expect(githubViolations('import { x } from "@fx/github/client";')).not.toEqual([]);
  });

  it("rule 3: addDiscussionComment / updateDiscussion are violations even as bare identifiers", () => {
    expect(githubViolations("const addDiscussionComment = 1;")).not.toEqual([]);
    expect(githubViolations("client.updateDiscussion(x);")).not.toEqual([]);
    expect(githubViolations("const o = { updateDiscussion: 1 };")).not.toEqual([]);
  });

  it("rule 4: createDiscussion is only the store import and bare references to it", () => {
    expect(githubViolations(IMPORT_STORE + "await createDiscussion(ctx, x);")).toEqual([]);
    expect(githubViolations('import { createDiscussion } from "@fx/discussions/server";\nawait createDiscussion(ctx, x);')).toEqual([]);
    expect(githubViolations("function createDiscussion() {}")).not.toEqual([]); // a local declaration alone
    expect(githubViolations(IMPORT_STORE + "async function createDiscussion(a) { return gh.post(a); }")).not.toEqual([]);
    expect(githubViolations(IMPORT_STORE + "const createDiscussion = (a) => gh.post(a);")).not.toEqual([]);
    expect(githubViolations(IMPORT_STORE + "class createDiscussion {}")).not.toEqual([]);
    expect(githubViolations(IMPORT_STORE + "function f(createDiscussion) {}")).not.toEqual([]);
    expect(githubViolations(IMPORT_STORE + "const { createDiscussion } = other;")).not.toEqual([]);
    expect(githubViolations(IMPORT_STORE + "type createDiscussion = string;")).not.toEqual([]);
    expect(githubViolations(IMPORT_STORE + "await github.createDiscussion(x);")).not.toEqual([]);
    expect(githubViolations(IMPORT_STORE + "const o = { createDiscussion: gh.post };")).not.toEqual([]);
    expect(githubViolations(IMPORT_STORE + "const o = { createDiscussion };")).not.toEqual([]);
    expect(githubViolations(IMPORT_STORE + "class K { createDiscussion() {} }")).not.toEqual([]);
    expect(githubViolations(`import { createDiscussion } from "./github.js";\ncreateDiscussion(x);`)).not.toEqual([]);
    expect(githubViolations(`import { createDiscussion as create } from "@fx/discussions";\ncreate(x);`)).not.toEqual([]);
    expect(githubViolations(`import { make as createDiscussion } from "@fx/discussions";\ncreateDiscussion(x);`)).not.toEqual([]);
    expect(githubViolations(`import * as createDiscussion from "@fx/discussions";`)).not.toEqual([]);
    expect(githubViolations(`import createDiscussion from "@fx/discussions";`)).not.toEqual([]);
    expect(githubViolations(IMPORT_STORE + "export { createDiscussion };")).not.toEqual([]);
    expect(githubViolations(IMPORT_STORE + "export { make as createDiscussion };")).not.toEqual([]);
    expect(githubViolations(`export { createDiscussion } from "@fx/discussions";`)).not.toEqual([]);
    expect(githubViolations(IMPORT_STORE + IMPORT_STORE + "createDiscussion(x);")).not.toEqual([]);
    expect(githubViolations("createDiscussion(x);")).not.toEqual([]); // used with no import at all
    expect(githubViolations(`import { createDiscussion } from "@fx/discussions";\nconst a = ${JSON.stringify("x")};`)).toEqual([]); // imported and unused is fine
  });
});

describe("scope guards over packages/pipeline/src/plan/**", () => {
  it("stage moves: only triage requests `discussing` (setStage); only spec.ts publishes a Spec (publishSpec moves to spec_ready); nothing writes stages by SQL", () => {
    for (const { file, code } of planSources()) {
      expect(code, file).not.toMatch(/\bin_progress\b|\bpr_opened\b|\bneeds_human\b|\brecordStage\b/);
      expect(code, file).not.toMatch(/\b(UPDATE\s+work_items|INSERT\s+INTO\s+(work_item_transitions|spec_versions|spec_corrections))\b/i);
      if (file !== "triage.ts") expect(code, file).not.toMatch(/\bsetStage\b/);
      if (file !== "spec.ts") expect(code, file).not.toMatch(/\bpublishSpec\b/);
    }
  });

  it("spec.ts uses publishSpec only as the named import from @fx/discussions and a direct call; spec_ready is only ever READ there", () => {
    const spec = planSources().find((s) => s.file === "spec.ts")!.code;
    expect(spec).toMatch(/import\s*\{[^}]*\bpublishSpec\b[^}]*\}\s*from\s*"@fx\/discussions"/);
    for (const m of spec.matchAll(/\bpublishSpec\b/g)) {
      const before = spec.slice(0, m.index).replace(/\s+$/, "");
      const after = spec.slice(m.index! + m[0].length);
      const isImport = /[{,]\s*$/.test(before) && /^\s*[,}]/.test(after);
      const isCall = /^\s*\(/.test(after) && !/[.]$/.test(before) && !/\b(function|const|let|var|class|as)$/.test(before);
      expect(isImport || isCall, "publishSpec must be the store import or a direct call").toBe(true);
    }
    // The stage is only ever read or reported in spec.ts, never requested: no `toStage` anywhere.
    expect(spec).not.toMatch(/\btoStage\b/);
  });

  it("H15b-2: comments are written only by postAgentComment (imported from @fx/discussions/server), never by SQL or postComment; agent_runs is never written", () => {
    for (const { file, code } of planSources()) {
      expect(code, file).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(discussion_comments|agent_runs)\b/i);
      expect(code, file).not.toMatch(/\bpostComment\b/);
      for (const m of code.matchAll(/\bpostAgentComment\b/g)) {
        const before = code.slice(0, m.index).replace(/\s+$/, "");
        const after = code.slice(m.index! + m[0].length);
        const isImport = /[{,]\s*$/.test(before) && /^\s*[,}]/.test(after);
        const isCall = /^\s*\(/.test(after) && !/[.]$/.test(before) && !/\b(function|const|let|var|class|as)$/.test(before);
        expect(isImport || isCall, `${file}: postAgentComment used other than as the store import or a direct call`).toBe(true);
      }
      const importsIt = /import\s*\{[^}]*\bpostAgentComment\b[^}]*\}\s*from\s*"([^"]+)"/.exec(code);
      if (importsIt) expect(importsIt[1], file).toBe("@fx/discussions/server");
    }
  });

  it("reaches the store only through @fx/discussions, never a relative cross-package import", () => {
    for (const { file, code } of planSources()) {
      expect(code, file).not.toMatch(/from\s*"(\.\.\/)+(discussions|core|trust)\b/);
      expect(code, file).not.toMatch(/packages\/discussions/);
    }
  });

  it("plan/** does not import from build/** (H14 is reached through the injected trigger port only)", () => {
    for (const { file, code } of planSources()) expect(code, file).not.toMatch(/from\s*"(\.\.\/)+build\//);
  });
});
