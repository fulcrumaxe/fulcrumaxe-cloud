import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CARDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cards");

// The exact pass/fail regex from the Spec (H08 criterion 2), unmodified.
const FORBIDDEN_PATTERN = /D#[0-9]+|scripts\/|backend\/|~\/|\/home\/|autonomous-agent-[7]|\.autonomous-team/;

function cardFiles(): string[] {
  return readdirSync(CARDS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

function readCard(name: string): string {
  return readFileSync(path.join(CARDS_DIR, name), "utf8");
}

describe("ported role cards", () => {
  it("has 26 card files", () => {
    expect(cardFiles()).toHaveLength(26);
  });

  it.each(cardFiles())("%s has no engine-only reference (H08 criterion 2)", (file) => {
    const text = readCard(file);
    const match = text.match(FORBIDDEN_PATTERN);
    expect(match, `found "${match?.[0]}" in ${file}`).toBeNull();
  });

  it.each(cardFiles())("%s does not name \"Claude Code\" (H08 criterion 4)", (file) => {
    expect(readCard(file)).not.toContain("Claude Code");
  });

  it("the forbidden-pattern check actually fails on a violation (deliberate fixture)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-h08-cards-fixture-"));
    const fixture = path.join(dir, "violation.md");
    try {
      writeFileSync(
        fixture,
        "This card still says `scripts/lib/repo-resolve.sh` and cites (D#1234).\n",
      );
      const text = readFileSync(fixture, "utf8");
      expect(text.match(FORBIDDEN_PATTERN)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no card names a fixed SendMessage address (there is no such tool here)", () => {
    for (const file of cardFiles()) {
      expect(readCard(file), file).not.toMatch(/SendMessage/);
    }
  });
});
