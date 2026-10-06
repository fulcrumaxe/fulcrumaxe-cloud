import { describe, expect, it } from "vitest";
import { TOKEN_SETS, renderTokens } from "../src/css/tokens.js";
import { getBaseCss } from "../src/css/index.js";
import * as html from "../src/html/index.js";
import { SEMANTIC_CONSTANT_KEYS, type ColorTokens, type SpacingTokens } from "../src/schema/tokenSet.js";

/**
 * D#2 spec amendment pass/fail item 2: swapping the token set changes every
 * colour and spacing value with NO markup edit. Proven by a rendered diff:
 * render the same page markup once per set, assert the markup is
 * byte-identical apart from the token stylesheet, and assert no colour or
 * spacing value from set A survives in set B's render.
 *
 * D#2 H24 criterion 2 ruling
 * (D#2 comment 18505329):
 * `SEMANTIC_CONSTANT_KEYS` (danger/dangerDim/warn/warnDim) are the ONLY
 * colour keys allowed to agree between set A and set B, and that agreement
 * is asserted explicitly below — not inferred from whichever values happen
 * to coincide. Every other colour and spacing key must differ.
 */

/** Maps each `ColorTokens`/`SpacingTokens` key to the exact `--name` custom
 * property `renderTokens()` emits for it — the same naming `renderTokens.ts`
 * uses, kept here (not derived) so this file has no hidden dependency on
 * that function's internal naming scheme continuing to camelCase-to-kebab
 * cleanly. */
const COLOR_VAR_NAMES: Record<keyof ColorTokens, string> = {
  bg: "--bg",
  bgRaised: "--bg-raised",
  bgCard: "--bg-card",
  bgFooter: "--bg-footer",
  fg: "--fg",
  fgDim: "--fg-dim",
  accent: "--accent",
  accentFaint: "--accent-faint",
  accentDim: "--accent-dim",
  accentWash: "--accent-wash",
  muted: "--muted",
  border: "--border",
  danger: "--danger",
  dangerDim: "--danger-dim",
  warn: "--warn",
  warnDim: "--warn-dim",
};

const SPACING_VAR_NAMES: Record<keyof SpacingTokens, string> = {
  "3xs": "--space-3xs",
  "2xs": "--space-2xs",
  xs: "--space-xs",
  sm: "--space-sm",
  md: "--space-md",
  lg: "--space-lg",
  xl: "--space-xl",
};

/** The exact set of CSS custom-property names allowed to match between set A
 * and set B — derived from `SEMANTIC_CONSTANT_KEYS`, the schema's own
 * declared list, not from which values happen to coincide. */
const SEMANTIC_CONSTANT_VAR_NAMES = new Set(SEMANTIC_CONSTANT_KEYS.map((k) => COLOR_VAR_NAMES[k]));

/** Every colour and spacing custom-property name — the full set the D#2
 * criterion 2 "must differ" requirement applies to, before excluding the
 * semantic constants. Deliberately excludes type/radius/container names:
 * the criterion is scoped to colour and spacing only. */
const COLOR_AND_SPACING_VAR_NAMES = [...Object.values(COLOR_VAR_NAMES), ...Object.values(SPACING_VAR_NAMES)];

function buildPageMarkup(): string {
  const parts = [
    html.header({ siteName: "Example", links: [{ label: "Docs", href: "/docs" }] }),
    html.card({ label: "Feature", title: "Ships fast", body: "One package, one style.", href: "/features" }),
    html.button({ label: "Get started", href: "/start", variant: "primary" }),
    html.codeBlock({ label: "install", code: "pnpm add @fx/design" }),
    html.stateMessage({ variant: "empty", message: "Nothing here yet." }),
    html.footer({ creditText: "Built with fulcrumaxe" }),
  ];
  return parts.join("\n");
}

function buildDocument(setId: keyof typeof TOKEN_SETS): { markup: string; stylesheet: string } {
  const set = TOKEN_SETS[setId];
  return { markup: buildPageMarkup(), stylesheet: renderTokens(set) + getBaseCss() };
}

/** Parses a `renderTokens()` block into `--var-name` -> value. Comparing by
 * the exact `--name: value;` declaration line (not a bare substring search
 * over the whole stylesheet) is deliberate: a raw value like ".25rem" is a
 * textual substring of an unrelated "1.25rem", so a plain
 * `stylesheet.includes(value)` would false-positive on that coincidence.
 * The declaration line is unambiguous because the variable name anchors it. */
function parseDeclarations(tokensBlock: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tokensBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/** Declaration lines (`--name: value;`) present in `fromId`'s rendered
 * tokens whose value differs from `toId`'s for that same variable — the
 * candidate set for the "did A's value leak verbatim into B's stylesheet"
 * check below. `SEMANTIC_CONSTANT_VAR_NAMES` is excluded by name, not by
 * value: previously this function excluded whichever variable's value
 * *happened* to match between the two sets, which silently swallowed any
 * variable a bug left un-diverged (D#2 H24 criterion 2 ruling — "a set B
 * that forgot to change any value would still pass"). The explicit
 * equal/differ assertions in the two `it` blocks below are what actually
 * enforce "only these four may agree, everything else must differ"; this
 * function only feeds the separate verbatim-leak check. */
function diffOnlyDeclarationLines(fromId: keyof typeof TOKEN_SETS, toId: keyof typeof TOKEN_SETS): string[] {
  const from = parseDeclarations(renderTokens(TOKEN_SETS[fromId]));
  const to = parseDeclarations(renderTokens(TOKEN_SETS[toId]));
  const out: string[] = [];
  for (const [name, value] of from) {
    if (SEMANTIC_CONSTANT_VAR_NAMES.has(name)) continue;
    if (to.get(name) !== value) out.push(`${name}: ${value};`);
  }
  return out;
}

describe("token-swap diff (D#2 spec amendment item 2)", () => {
  it("renders byte-identical markup for set A and set B", () => {
    const a = buildDocument("terminal");
    const b = buildDocument("dark");
    expect(a.markup).toBe(b.markup);
  });

  it("emits a different stylesheet for each set", () => {
    const a = buildDocument("terminal");
    const b = buildDocument("dark");
    expect(a.stylesheet).not.toBe(b.stylesheet);
  });

  it("carries no colour or spacing declaration from set A into set B's stylesheet", () => {
    const b = buildDocument("dark");
    for (const line of diffOnlyDeclarationLines("terminal", "dark")) {
      expect(b.stylesheet.includes(line), `set A's "${line}" leaked into set B's stylesheet`).toBe(false);
    }
  });

  it("carries no colour or spacing declaration from set B into set A's stylesheet", () => {
    const a = buildDocument("terminal");
    for (const line of diffOnlyDeclarationLines("dark", "terminal")) {
      expect(a.stylesheet.includes(line), `set B's "${line}" leaked into set A's stylesheet`).toBe(false);
    }
  });

  it("keeps every SEMANTIC_CONSTANT_KEYS variable equal between set A and set B", () => {
    const a = parseDeclarations(renderTokens(TOKEN_SETS.terminal));
    const b = parseDeclarations(renderTokens(TOKEN_SETS.dark));
    for (const varName of SEMANTIC_CONSTANT_VAR_NAMES) {
      expect(b.get(varName), `${varName} should equal set A's value — it is a semantic constant`).toBe(a.get(varName));
    }
  });

  it("changes every colour and spacing variable OTHER than SEMANTIC_CONSTANT_KEYS between set A and set B", () => {
    const a = parseDeclarations(renderTokens(TOKEN_SETS.terminal));
    const b = parseDeclarations(renderTokens(TOKEN_SETS.dark));
    for (const varName of COLOR_AND_SPACING_VAR_NAMES) {
      if (SEMANTIC_CONSTANT_VAR_NAMES.has(varName)) continue;
      expect(b.get(varName), `${varName} did not change between set A and set B — set B's token file is wrong`).not.toBe(
        a.get(varName),
      );
    }
  });
});
