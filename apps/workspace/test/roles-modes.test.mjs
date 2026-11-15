// apps/workspace/test/roles-modes.test.mjs
//
// The Roles app's Mode dropdown shows customer wording, not the stored mode code, for every mode @fx/roles defines
// (packages/roles/src/manifest.ts, RoleMode). This pins MODE_TEXT against that union read as text (so a mode added
// there and forgotten here fails loudly), and pins MERGE_COPY.debater as derived from the same map. The DOM
// behaviour is in e2e/roles.spec.ts; the vitest environment here is node.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MERGE_COPY, MODE_TEXT, word } from "../apps/roles/roles-autonomy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_SRC = readFileSync(join(HERE, "..", "..", "..", "packages", "roles", "src", "manifest.ts"), "utf8");
const ROLES_APP_SRC = readFileSync(join(HERE, "..", "apps", "roles", "roles-app.js"), "utf8");

const ROLE_MODES = MANIFEST_SRC.match(/export type RoleMode = ([^;]+);/)[1].match(/"([a-z_]+)"/g).map((s) => s.slice(1, -1));

describe("MODE_TEXT covers every RoleMode the manifest defines", () => {
  it("has non-empty wording for each member, with no underscore", () => {
    expect(ROLE_MODES.length).toBeGreaterThan(0);
    for (const m of ROLE_MODES) {
      expect(MODE_TEXT[m], m).toMatch(/\S/);
      expect(MODE_TEXT[m]).not.toMatch(/_/);
    }
  });

  it("labels each mode with the exact customer phrase", () => {
    expect(word(MODE_TEXT, "feature_critical")).toBe("On for features and critical work");
    expect(word(MODE_TEXT, "weekly")).toBe("Once a week");
    expect(word(MODE_TEXT, "always")).toBe("On for every pull request");
    expect(word(MODE_TEXT, "off")).toBe("Off");
  });

  it("word() passes an unknown or prototype-shadowing value through instead of printing undefined", () => {
    expect(word(MODE_TEXT, "not_a_mode")).toBe("not_a_mode");
    expect(word(MODE_TEXT, "constructor")).toBe("constructor");
  });
});

describe("MERGE_COPY.debater is derived from MODE_TEXT, not a second copy", () => {
  it("shares the same three phrases", () => {
    expect(MERGE_COPY.debater.off).toBe(MODE_TEXT.off);
    expect(MERGE_COPY.debater.feature_critical).toBe(MODE_TEXT.feature_critical);
    expect(MERGE_COPY.debater.always).toBe(MODE_TEXT.always);
  });
});

describe("roles-app.js labels every role's mode options the same way", () => {
  it("has no debater-only special case left", () => {
    expect(ROLES_APP_SRC).not.toMatch(/role\.role === "debater"/);
  });
});
