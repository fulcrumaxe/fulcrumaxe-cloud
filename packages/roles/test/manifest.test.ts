import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ROLE_MANIFEST, ROLE_NAMES, type RoleMode } from "../src/manifest";

const CARDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cards");

/**
 * The 26 role names present in the engine's .claude/agents/*.md at the time
 * of porting (H08). This is a frozen snapshot, not a live read of the engine
 * repo — the product doesn't have that repo checked out in its own CI.
 */
const EXPECTED_ROLE_NAMES = [
  "acceptance-tester",
  "accessibility-reviewer",
  "analytics-engineer",
  "browser-tester",
  "code-reviewer",
  "cost-analyst",
  "debater",
  "docs-writer",
  "executor",
  "feedback-scanner",
  "incident-commander",
  "mission-analyst",
  "performance-expert",
  "product-owner",
  "project-manager",
  "quality-sweep",
  "release-manager",
  "researcher",
  "run-analyst",
  "runbook-writer",
  "security-expert",
  "security-reviewer",
  "technical-architect",
  "tui-tester",
  "ux-designer",
  "visual-verifier",
].sort();

describe("role manifest", () => {
  it("lists exactly 26 roles", () => {
    expect(ROLE_MANIFEST).toHaveLength(26);
  });

  it("matches the frozen set of 26 role names from the engine's .claude/agents/", () => {
    expect([...ROLE_NAMES].sort()).toEqual(EXPECTED_ROLE_NAMES);
  });

  it("has a manifest entry name for every card file, and a card file for every manifest entry", () => {
    const cardFiles = readdirSync(CARDS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    expect(cardFiles).toEqual([...ROLE_NAMES].sort());
  });

  it("has no duplicate role names", () => {
    expect(new Set(ROLE_NAMES).size).toBe(ROLE_NAMES.length);
  });

  const requiredFields: Array<keyof (typeof ROLE_MANIFEST)[number]> = [
    "trigger",
    "defaultMode",
    "allowedModes",
    "defaultModel",
    "perSpawnCapUsd",
    "needsBrowser",
    "writeAccess",
  ];

  it.each(ROLE_MANIFEST.map((r) => [r.name, r] as const))(
    "%s has every required field",
    (_name, entry) => {
      for (const field of requiredFields) {
        expect(entry[field], `missing field ${field}`).not.toBeUndefined();
      }
      expect(entry.allowedModes.length).toBeGreaterThan(0);
      expect(entry.allowedModes).toContain(entry.defaultMode);
      expect(entry.perSpawnCapUsd).toBeGreaterThan(0);
      expect(["haiku", "sonnet", "opus"]).toContain(entry.defaultModel);
    },
  );

  it("sets needsBrowser=true for exactly browser-tester, visual-verifier, and tui-tester", () => {
    const browserRoles = ROLE_MANIFEST.filter((r) => r.needsBrowser)
      .map((r) => r.name)
      .sort();
    expect(browserRoles).toEqual(["browser-tester", "tui-tester", "visual-verifier"]);
  });

  it("matches the Spec's frozen default-mode table (H08 criterion 6)", () => {
    const expected: Record<string, RoleMode> = {
      "project-manager": "always",
      "quality-sweep": "off",
      "mission-analyst": "weekly",
      "run-analyst": "weekly",
      "analytics-engineer": "weekly",
      "visual-verifier": "weekly",
      debater: "off",
      "runbook-writer": "feature_critical",
      "accessibility-reviewer": "feature_critical",
      "ux-designer": "feature_critical",
      "docs-writer": "always",
      "release-manager": "always",
      "feedback-scanner": "always",
      "incident-commander": "always",
      "product-owner": "always",
      "cost-analyst": "always",
      "performance-expert": "always",
      "security-expert": "always",
      "technical-architect": "always",
      researcher: "always",
      executor: "always",
      "code-reviewer": "always",
      "security-reviewer": "always",
      "acceptance-tester": "always",
      "browser-tester": "always",
      "tui-tester": "always",
    };

    for (const [name, mode] of Object.entries(expected)) {
      const entry = ROLE_MANIFEST.find((r) => r.name === name);
      expect(entry, `no manifest entry for ${name}`).toBeDefined();
      expect(entry?.defaultMode, `${name} defaultMode`).toBe(mode);
    }

    // The table above must cover every role — no silent gaps either way.
    expect(Object.keys(expected).sort()).toEqual([...ROLE_NAMES].sort());
  });

  // D#2 H08-followup: migration 0687 writes each role's default mode into every
  // existing repo as a literal. A row's presence carries the meaning, so the manifest
  // and that literal list must not drift apart silently.
  describe("migration 0687 role_settings backfill list", () => {
    const MIGRATION = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "db",
      "migrations",
      "0687_role_settings_materialize.sql",
    );
    const sql = readFileSync(MIGRATION, "utf8");
    const block = sql.slice(sql.indexOf("defaults (role, mode) AS ("), sql.indexOf("ins AS ("));
    const backfill = [...block.matchAll(/\('([a-z-]+)',\s*'([a-z_]+)'\)/g)].map((m) => [m[1]!, m[2]!] as const);

    it("parses a non-empty list with no duplicate role", () => {
      expect(backfill.length).toBeGreaterThan(0);
      expect(new Set(backfill.map(([name]) => name)).size).toBe(backfill.length);
    });

    it("lists each role at exactly its manifest defaultMode", () => {
      // Roles whose default a LATER migration changed, as that migration decided it: 0710 turned the debater off (owner ruling,
      // D#483 P3) for rows still as 0687 seeded them. 0687 itself is never edited.
      const changedLater: Record<string, string> = { debater: "off" };
      for (const [seeded, name] of backfill.map(([n, m]) => [m, n] as const)) {
        const mode = changedLater[name] !== undefined ? changedLater[name]! : seeded;
        const entry = ROLE_MANIFEST.find((r) => r.name === name);
        expect(entry, `0687 backfills ${name}, which is not in the manifest`).toBeDefined();
        expect(
          entry?.defaultMode,
          `${name}: the manifest says ${entry?.defaultMode} but 0687 materialized ${mode} into every existing repo. ` +
            `Changing a defaultMode does not change existing repos' rows; do not edit 0687, decide the change in a new migration.`,
        ).toBe(mode);
      }
    });

    it("has every manifest role whose defaultMode is not 'off' (a new role needs its own materialization)", () => {
      const listed = new Set(backfill.map(([name]) => name));
      const missing = ROLE_MANIFEST.filter((r) => r.defaultMode !== "off" && !listed.has(r.name)).map((r) => r.name);
      expect(
        missing,
        `manifest role(s) ${missing.join(", ")} have a defaultMode other than 'off' but are not in migration 0687's backfill list. ` +
          `A new role needs its own materialization: a migration that inserts its role_settings row into every existing repo ` +
          `(a role with no row is off), or ship it with defaultMode "off". New repos get the full manifest automatically.`,
      ).toEqual([]);
    });
  });
});
