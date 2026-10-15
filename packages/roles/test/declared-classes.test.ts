/**
 * D#7 DP5 criteria 1, 2 and 5 -- the real-tree half of the "declared
 * classes" guard. `@fx/decisions`'s `declared.ts` owns the pure resolution
 * mechanism (see `packages/decisions/test/declared.test.ts` for that);
 * this file owns the two things only this package can scan:
 * `packages/roles/src/tools.ts` (the tool registry) and
 * `packages/roles/cards/*.md` (the role cards).
 *
 * Declaration convention (DP5, ratified by DP-C2a; DP4a added the first real
 * declarations, on the executor card):
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
  getCatalogueEntry,
  type DeclaredEntry,
} from "@fx/decisions";
import { loadProductCard } from "../src/cards.js";
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

function realCardDeclarations(): DeclaredEntry[] {
  return cardFiles().flatMap((file) => parseCardDeclarations(readFileSync(path.join(CARDS_DIR, file), "utf8"), file));
}

/**
 * D#7 DP-C2c: the exact real declaration set. Not `[]` and not "non-empty": a card that gains or loses a
 * declaration changes this list on purpose, in a reviewed diff.
 */
const EXPECTED_CARD_DECLARATIONS: DeclaredEntry[] = [
  { source: "executor.md", decisionType: "nonbreaking_refactor_approach" },
  { source: "executor.md", decisionType: "test_strategy_choice" },
];

describe("D#7 DP5 criterion 1: every declaration in tools.ts resolves to exactly one catalogue entry", () => {
  it("real tree: the exact tool declarations are [] -- DP4a declares through a card, not a tool (DP-C2c allows either)", () => {
    // Explicit today-state assertion, not just an empty findUnresolvedDeclarations() check.
    // A tool that gains a declaration must change this list in the same reviewed diff.
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
  it("real tree: the exact list of card declarations (DP-C2c criterion 9) -- not [] and not merely non-empty", () => {
    expect(realCardDeclarations()).toEqual(EXPECTED_CARD_DECLARATIONS);
  });

  it("real tree: the real declarations resolve cleanly, and none is a class-1 entry (class 1 is never raised)", () => {
    const all = [...extractToolDeclarations(), ...realCardDeclarations()];
    expect(findUnresolvedDeclarations(all)).toEqual([]);
    expect(() => assertDeclarationsResolve(all)).not.toThrow();
    for (const d of all) expect(getCatalogueEntry(d.decisionType)?.class, d.decisionType).not.toBe("automated_with_monitoring");
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

/**
 * D#7 DP-C2b: criterion 5 scans a card for catalogue ids EXCEPT the one machine-read `decision_types:` line in
 * the frontmatter. The exemption is exactly that line: an id in the body, in another frontmatter key, or on a
 * `decision_types:` line that sits in the body, still counts.
 */
function withoutDeclarationLine(text: string): string {
  const fm = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fm) return text;
  const kept = (fm[2] ?? "").split(/\r?\n/).filter((line) => !/^decision_types:\s*\[[^\]]*\]\s*$/.test(line));
  return `${fm[1]}${kept.join("\n")}${fm[3]}${text.slice(fm[0].length)}`;
}

const idsIn = (text: string): string[] => CATALOGUE_IDS.filter((id) => text.includes(id));

describe("D#7 DP5 criterion 5 (as carved out by DP-C2b): no dial name appears in any role card outside its decision_types line", () => {
  it("no CATALOGUE_IDS entry appears as text in any packages/roles/cards/*.md file, once the declaration line is set aside", () => {
    for (const file of cardFiles()) {
      const text = readFileSync(path.join(CARDS_DIR, file), "utf8");
      expect({ file, found: idsIn(withoutDeclarationLine(text)) }).toEqual({ file, found: [] });
    }
  });

  it("the carve-out is exactly the declaration line: the executor card's own ids are found before it is set aside, and none after", () => {
    const text = readFileSync(path.join(CARDS_DIR, "executor.md"), "utf8");
    expect(idsIn(text).sort()).toEqual(["nonbreaking_refactor_approach", "test_strategy_choice"]);
    expect(idsIn(withoutDeclarationLine(text))).toEqual([]);
  });

  it("deliberate-failure fixture: a dial name in card BODY prose is still caught", () => {
    const hostile = `---\nname: fixture-role\ndecision_types: [${FIRST_CATALOGUE_ID}]\n---\n\nThis role can directly request ${FIRST_CATALOGUE_ID}.`;
    expect(idsIn(withoutDeclarationLine(hostile))).toEqual([FIRST_CATALOGUE_ID]);
  });

  it("deliberate-failure fixture: a dial name in a frontmatter key OTHER than decision_types is still caught", () => {
    const hostile = `---\nname: fixture-role\ndescription: asks for ${FIRST_CATALOGUE_ID}\ndecision_types: [${FIRST_CATALOGUE_ID}]\n---\n\nbody`;
    expect(idsIn(withoutDeclarationLine(hostile))).toEqual([FIRST_CATALOGUE_ID]);
    const sneaky = `---\nname: fixture-role\ndecision_types_note: [${FIRST_CATALOGUE_ID}]\n---\n\nbody`;
    expect(idsIn(withoutDeclarationLine(sneaky))).toEqual([FIRST_CATALOGUE_ID]);
  });

  it("deliberate-failure fixture: a decision_types line in the BODY is not exempt", () => {
    const hostile = `---\nname: fixture-role\n---\n\ndecision_types: [${FIRST_CATALOGUE_ID}]`;
    expect(idsIn(withoutDeclarationLine(hostile))).toEqual([FIRST_CATALOGUE_ID]);
  });
});

describe("D#7 DP-C2b: a declaration never reaches the agent -- the text a role is actually given has no catalogue id", () => {
  // The prompt a role runs under is its product card: the seat loads loadProductCard, never a dev card
  // (packages/worker/test/seat.pg.test.ts pins "a dev-team card exists, and must not be used"). So the
  // rendered text of a declaring role is its product card, for each runtime it can run under.
  const declaringRoles = [...new Set(EXPECTED_CARD_DECLARATIONS.map((d) => d.source.replace(/\.md$/, "")))];

  it("every role that declares a type has a rendered card, and it names no catalogue id and no declaration key", () => {
    expect(declaringRoles).toEqual(["executor"]);
    for (const role of declaringRoles) {
      for (const runtime of ["sandbox", "runner"] as const) {
        const rendered = loadProductCard(role, { runtime });
        expect(rendered, `${role}/${runtime}`).toBeDefined();
        expect({ role, runtime, found: idsIn(rendered ?? "") }).toEqual({ role, runtime, found: [] });
        expect(rendered ?? "", `${role}/${runtime}`).not.toContain("decision_types");
      }
    }
  });

  it("the check is not vacuous: the same scan flags a rendered text that does carry a declaration", () => {
    const leaked = `# Executor\n\ndecision_types: [${FIRST_CATALOGUE_ID}]`;
    expect(idsIn(leaked)).toEqual([FIRST_CATALOGUE_ID]);
    expect(leaked).toContain("decision_types");
  });
});
