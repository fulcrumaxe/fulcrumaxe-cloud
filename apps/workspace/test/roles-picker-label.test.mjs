// apps/workspace/test/roles-picker-label.test.mjs
//
// D#37 WS-F4a: the Roles tab's repo picker must name each repository the
// same way the Autonomy tab does -- repoLabel(r), never r.product -- so two
// repos under the same product can be told apart. The DOM behaviour is in
// e2e/roles.spec.ts; this checks the source directly, in node.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(fileURLToPath(new URL("../apps/roles/roles-app.js", import.meta.url)), "utf8");

describe("the Roles tab's repo picker labels options with repoLabel, not r.product", () => {
  it("imports repoLabel from ./roles-autonomy.js", () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\brepoLabel\b[^}]*\}\s*from\s*"\.\/roles-autonomy\.js"/);
  });

  it("builds the picker option's text with repoLabel(", () => {
    expect(SRC).toContain("repoLabel(");
  });

  it("no longer reads r.product", () => {
    expect(SRC).not.toContain("r.product");
  });
});
