// apps/workspace/test/roles-repo-picker.test.mjs
//
// D#37 WS-F4a: the Roles tab's repository picker labels each option by the
// repo's full name, not its product, so two repos sharing a product can be
// told apart. The DOM behaviour is in e2e/roles.spec.ts; this file pins the
// source wiring and the labeller against the committed fixture, in node.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoLabel } from "../apps/roles/roles-autonomy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "apps", "roles", "roles-app.js"), "utf8");
const REPOS = JSON.parse(readFileSync(join(HERE, "..", "..", "..", "packages", "api", "fixtures", "v1", "listRepos", "200-page.json"), "utf8"));
const INSTALLED = REPOS.data.find((r) => r.install_state === "installed");

describe("roles-app.js labels the repo picker by full name", () => {
  it("imports repoLabel from ./roles-autonomy.js", () => {
    expect(SRC).toMatch(/import\s*{[^}]*\brepoLabel\b[^}]*}\s*from\s*"\.\/roles-autonomy\.js"/);
  });
  it("builds no option text from r.product", () => {
    expect(SRC).not.toMatch(/r\.product/);
  });
  it("labels the fixture's installed repo by its full name", () => {
    expect(repoLabel(INSTALLED)).toBe("acme/widgets");
  });
  it("tells apart two repos that share a product but differ in full name", () => {
    const widgets = { ...INSTALLED, product: "team", full_name: "acme/widgets" };
    const docs = { ...INSTALLED, product: "team", full_name: "acme/docs" };
    expect(repoLabel(widgets)).toBe("acme/widgets");
    expect(repoLabel(docs)).toBe("acme/docs");
    expect(repoLabel(widgets)).not.toBe(repoLabel(docs));
  });
});
