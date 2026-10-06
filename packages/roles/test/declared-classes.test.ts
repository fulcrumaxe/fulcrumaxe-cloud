/**
 * D#7 DP5 criteria 1, 2 and 5 -- the real-tree half of the "declared
 * classes" guard. `@fx/decisions`'s `declared.ts` owns the pure resolution
 * mechanism (see `packages/decisions/test/declared.test.ts` for that);
 * this file owns the two things only this package can scan:
 * `packages/roles/src/tools.ts` (the tool registry) and
 * `packages/roles/cards/*.md` (the role cards).
 *
 * Declaration convention (DP5; no tool or card currently uses it -- DP4,
 * which would give a card a reason to, has not landed):
 *   - A tool declares a decision type by carrying an own `decisionType`
 *     property on its `ToolRegistryEntry` object, naming a catalogue id.
 *   - A card declares one or more decision types via a `decision_types:
 *     [id, id, ...]` key in its YAML frontmatter.
 * Both are read structurally (no edits to tools.ts or cards/*.md needed for
 * the guard itself to exist and be correct -- see declared.ts's header),
 * and both are exercised below against fixtures that use the convention,
 * to prove the scan+resolve mechanism actually works and isn't just
 * finding nothing because it's broken.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDeclarationsResolve,
  CATALOGUE_IDS,
  findUnresolvedDeclarations,
  type DeclaredEntry,
} from "@fx/decisions";
import { TOOL_REGISTRY } from "../src/tools.js";

const CARDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cards");
const FIRST_CATALOGUE_ID: string = CATALOGUE_IDS.at(0) ?? "";

function cardFiles(): string[] {
  return readdirSync(CARDS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/** Every `decisionType` a real ToolRegistryEntry carries as an own property. */
function extractToolDeclarations(): DeclaredEntry[] {
  const out: DeclaredEntry[] = [];
  for (const entry of TOOL_REGISTRY) {
    const raw = entry as unknown as Record<string, unknown>;
    if (Object.hasOwn(raw, "decisionType") && typeof raw.decisionType === "string") {
      out.push({ source: `tools.ts:${entry.name}`, decisionType: raw.decisionType });
    }
  }
  return out;
}

/** Extracts a card's `decision_types: [a, b]` frontmatter key, if present. */
function parseCardDeclarations(text: string, source: string): DeclaredEntry[] {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatterBody = frontmatter?.[1];
  if (!frontmatterBody) return [];
  const field = frontmatterBody.match(/^decision_types:\s*\[([^\]]*)\]\s*$/m);
  const listText = field?.[1];
  if (listText === undefined) return [];
  return listText
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0)
    .map((decisionType) => ({ source, decisionType }));
}

describe("D#7 DP5 criterion 1: every declaration in tools.ts resolves to exactly one catalogue entry", () => {
  it("real tree: tools.ts carries zero decisionType declarations today, so the scan is vacuously []", () => {
    // Explicit today-state assertion, not just an empty findUnresolvedDeclarations() check --
    // this is what makes the next test's [] meaningful rather than an accident.
    expect(extractToolDeclarations()).toEqual([]);
  });

  it("real tree: whatever tools.ts declares resolves cleanly", () => {
    expect(findUnresolvedDeclarations(extractToolDeclarations())).toEqual([]);
  });

  it("sanity: the scanner is not vacuous -- it does find a declaration when one is present, and resolves it", () => {
    const fixtureEntry = { name: "fixture_tool", description: "x", replaces: "none", decisionType: FIRST_CATALOGUE_ID };
    const raw = fixtureEntry as unknown as Record<string, unknown>;
    const found: DeclaredEntry[] = Object.hasOwn(raw, "decisionType")
      ? [{ source: `tools.ts:${fixtureEntry.name}`, decisionType: raw.decisionType as string }]
      : [];
    expect(found).toEqual([{ source: "tools.ts:fixture_tool", decisionType: FIRST_CATALOGUE_ID }]);
    expect(findUnresolvedDeclarations(found)).toEqual([]);
  });

  it("deliberate-failure fixture: a tool declaring an undeclared class is caught, not silently defaulted (criterion 2)", () => {
    const bad: DeclaredEntry = { source: "tools.ts:fixture_tool", decisionType: "not_a_real_catalogue_id" };
    expect(findUnresolvedDeclarations([bad])).toEqual([bad]);
    expect(() => assertDeclarationsResolve([bad])).toThrow();
  });
});

describe("D#7 DP5 criterion 1: every declaration in packages/roles/cards/*.md resolves to exactly one catalogue entry", () => {
  it("real tree: no card carries a decision_types frontmatter key today, so the scan is vacuously []", () => {
    const declarations = cardFiles().flatMap((file) =>
      parseCardDeclarations(readFileSync(path.join(CARDS_DIR, file), "utf8"), file),
    );
    expect(declarations).toEqual([]);
  });

  it("real tree: whatever the cards declare resolves cleanly", () => {
    const declarations = cardFiles().flatMap((file) =>
      parseCardDeclarations(readFileSync(path.join(CARDS_DIR, file), "utf8"), file),
    );
    expect(findUnresolvedDeclarations(declarations)).toEqual([]);
  });

  it("sanity: the parser is not vacuous -- it finds and correctly resolves a real declaration when present", () => {
    const realId = FIRST_CATALOGUE_ID;
    const fixtureCardText = `---\nname: fixture-role\ndescription: x\ndecision_types: [${realId}]\n---\n\nbody`;
    const declarations = parseCardDeclarations(fixtureCardText, "fixture-card.md");
    expect(declarations).toEqual([{ source: "fixture-card.md", decisionType: realId }]);
    expect(findUnresolvedDeclarations(declarations)).toEqual([]);
  });

  it("deliberate-failure fixture: a card declaring an undeclared class is caught, not silently defaulted (criterion 2)", () => {
    const fixtureCardText =
      `---\nname: fixture-role\ndescription: x\ndecision_types: [not_a_real_catalogue_id]\n---\n\nbody`;
    const declarations = parseCardDeclarations(fixtureCardText, "fixture-card.md");
    expect(declarations).toEqual([{ source: "fixture-card.md", decisionType: "not_a_real_catalogue_id" }]);
    expect(findUnresolvedDeclarations(declarations)).toEqual(declarations);
    expect(() => assertDeclarationsResolve(declarations)).toThrow();
  });
});

describe("D#7 DP5 criterion 5: no dial name appears in any role card", () => {
  it("no CATALOGUE_IDS entry appears as text in any packages/roles/cards/*.md file", () => {
    for (const file of cardFiles()) {
      const text = readFileSync(path.join(CARDS_DIR, file), "utf8");
      for (const id of CATALOGUE_IDS) {
        expect({ file, id, found: text.includes(id) }).toEqual({ file, id, found: false });
      }
    }
  });

  it("deliberate-failure fixture: the same check does catch a dial name embedded in card-shaped prose (not vacuous)", () => {
    const hostileText = `---\nname: fixture-role\n---\n\nThis role can directly request ${FIRST_CATALOGUE_ID}.`;
    expect(hostileText.includes(FIRST_CATALOGUE_ID)).toBe(true);
  });
});
