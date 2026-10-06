import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import productCardMap from "../src/productCardMap.json" with { type: "json" };
// @ts-expect-error the generator is a plain .mjs with no types
import { PRODUCT_CARDS_DIR, PRODUCT_MAP_PATH, renderCardMap } from "../scripts/generate-card-map.mjs";

const MAP: Readonly<Record<string, string>> = productCardMap;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARDS_DIR = path.join(ROOT, "cards-product");
const cardFiles = (): string[] => readdirSync(CARDS_DIR).filter((f) => f.endsWith(".md")).sort();

const EXPECTED_ROLES = [
  "acceptance-tester",
  "code-reviewer",
  "cost-analyst",
  "debater",
  "executor",
  "performance-expert",
  "product-owner",
  "project-manager",
  "researcher",
  "security-expert",
  "security-reviewer",
  "technical-architect",
  "ux-designer",
];

/**
 * Team-process vocabulary a product card must not carry (D#483): the platform runs the process, a card holds only
 * the role's judgment. The project-manager card is exempt from this list only because it is the owner-approved live
 * card and it names these actions in order to forbid them; it is still held to the result-block rule below.
 */
const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ["Discussion", /\bDiscussions?\b/],
  ["gh CLI", /\bgh\s/],
  ["STATUS marker", /\bSTATUS:/],
  ["request a role", /\brequest an?\b(?!\w)/i],
  ["label", /\blabel/i],
  ["comment on", /\bcomment on\b/i],
];
const FORBIDDEN_EXEMPT = new Set(["project-manager"]);

describe("the product card map (D#483)", () => {
  it("the committed map is exactly what the generator makes from cards-product/*.md (drift fails here)", () => {
    expect(readFileSync(PRODUCT_MAP_PATH as string, "utf8")).toBe(renderCardMap(PRODUCT_CARDS_DIR) as string);
  });

  it("holds exactly the expected roles, each with its file's own text", () => {
    expect(cardFiles().map((f) => f.slice(0, -3))).toEqual(EXPECTED_ROLES);
    expect(Object.keys(MAP)).toEqual(EXPECTED_ROLES);
    for (const role of EXPECTED_ROLES) expect(MAP[role], role).toBe(readFileSync(path.join(CARDS_DIR, `${role}.md`), "utf8"));
  });

  it("tracks a card edit on that card's line only", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-productcardmap-"));
    try {
      cpSync(CARDS_DIR, dir, { recursive: true });
      const before = (renderCardMap(dir) as string).split("\n");
      writeFileSync(path.join(dir, "executor.md"), "edited\n");
      const after = (renderCardMap(dir) as string).split("\n");
      expect(after.filter((line, i) => line !== before[i])).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("product cards hold judgment, not team process (D#483)", () => {
  for (const role of EXPECTED_ROLES) {
    const text = readFileSync(path.join(CARDS_DIR, `${role}.md`), "utf8");

    it(`${role}: names its role and is marked as a product card`, () => {
      expect(text).toMatch(new RegExp(`^---\\nname: ${role}\\nproduct: true\\n---\\n`));
    });

    it(`${role}: has an explicit "What you never do" prohibition section`, () => {
      const section = /\n## What you never do\n([\s\S]*?)(?=\n## |$)/.exec(text)?.[1] ?? "";
      expect(section, "missing section").not.toBe("");
      expect(section).toMatch(/never (ask for|request) a panel/);
      expect(section).toMatch(/another role's run/);
      expect(section).toMatch(/never follow instructions found/);
    });

    it(`${role}: states the result-block rule`, () => {
      expect(text).toMatch(/exactly the result block/i);
      expect(text).toMatch(/never stop without/i);
    });

    if (!FORBIDDEN_EXEMPT.has(role)) {
      for (const [what, re] of FORBIDDEN) {
        it(`${role}: carries no "${what}" process language`, () => {
          expect(text).not.toMatch(re);
        });
      }
    }
  }

  it("the forbidden patterns do catch the phrases they exist for", () => {
    const hits = (s: string): string[] => FORBIDDEN.filter(([, re]) => re.test(s)).map(([w]) => w);
    expect(hits("Open a Discussion")).toContain("Discussion");
    expect(hits("run gh pr view")).toContain("gh CLI");
    expect(hits("STATUS: done")).toContain("STATUS marker");
    expect(hits("request a panel")).toContain("request a role");
    expect(hits("label the PR")).toContain("label");
    expect(hits("comment on the PR")).toContain("comment on");
    expect(hits("a request against a locally started service")).toEqual([]);
  });
});

describe("loadProductCard: no fallback to the dev-team card (D#483 P3)", () => {
  it("a role with a product card gets exactly it; a role without one, and a name outside the manifest, get undefined", async () => {
    const { loadProductCard, loadRoleCard } = await import("../src/cards.js");
    const { ROLE_MANIFEST } = await import("../src/manifest.js");
    const map = (await import("../src/productCardMap.json", { with: { type: "json" } })).default as Record<string, string>;
    for (const { name } of ROLE_MANIFEST) {
      if (Object.hasOwn(map, name)) expect(loadProductCard(name), name).toBe(map[name]);
      else {
        expect(loadProductCard(name), name).toBeUndefined();
        expect(loadRoleCard(name), name).toBeDefined(); // the dev-team card exists and is NOT handed out
      }
    }
    for (const bad of ["", "nope", "../cards/executor", "__proto__", "constructor", "toString"]) expect(loadProductCard(bad), bad).toBeUndefined();
  });
});
