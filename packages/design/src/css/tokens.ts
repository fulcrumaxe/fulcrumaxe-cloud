import { TokenSet } from "../schema/tokenSet.js";
import darkJson from "../../tokens/dark.json" with { type: "json" };
import terminalJson from "../../tokens/terminal.json" with { type: "json" };

// The token files are imported, not read from disk: a deployed function cannot find them by a path built from
// `import.meta.url` (webpack bakes it to the build machine's path), but the bundler inlines a JSON import.
function loadTokenSet(raw: unknown): TokenSet {
  return TokenSet.parse(raw);
}

/** The two shipped token sets, lifted from `formal-support/assets/css/style.css`'s
 * `terminal` and `dark` value sets (D#2 spec amendment, H24). */
export const TOKEN_SETS = {
  terminal: loadTokenSet(terminalJson),
  dark: loadTokenSet(darkJson),
} as const;

/** Emits one `:root { --token: value; ... }` block from a TokenSet. This is
 * the ONLY place a TokenSet's values turn into CSS custom properties — every
 * component rule in base.css and src/components/** consumes these var()
 * names, never a literal, so swapping the set passed here is the entire
 * mechanism for both theme switching (D#2 amendment item 2) and white-label
 * branding (item 6). */
export function renderTokens(set: TokenSet): string {
  const c = set.colors;
  const s = set.spacing;
  const t = set.type;
  const lines = [
    `--bg: ${c.bg};`,
    `--bg-raised: ${c.bgRaised};`,
    `--bg-card: ${c.bgCard};`,
    `--bg-footer: ${c.bgFooter};`,
    `--fg: ${c.fg};`,
    `--fg-dim: ${c.fgDim};`,
    `--accent: ${c.accent};`,
    `--accent-faint: ${c.accentFaint};`,
    `--accent-dim: ${c.accentDim};`,
    `--accent-wash: ${c.accentWash};`,
    `--muted: ${c.muted};`,
    `--border: ${c.border};`,
    `--danger: ${c.danger};`,
    `--danger-dim: ${c.dangerDim};`,
    `--warn: ${c.warn};`,
    `--warn-dim: ${c.warnDim};`,
    `--space-3xs: ${s["3xs"]};`,
    `--space-2xs: ${s["2xs"]};`,
    `--space-xs: ${s.xs};`,
    `--space-sm: ${s.sm};`,
    `--space-md: ${s.md};`,
    `--space-lg: ${s.lg};`,
    `--space-xl: ${s.xl};`,
    `--font-mono: ${t.fontFamily};`,
    `--text-2xs: ${t.size2xs};`,
    `--text-xs: ${t.sizeXs};`,
    `--text-sm: ${t.sizeSm};`,
    `--text-md: ${t.sizeMd};`,
    `--text-lg: ${t.sizeLg};`,
    `--text-xl: ${t.sizeXl};`,
    `--tracking-normal: ${t.trackingNormal};`,
    `--tracking-wide: ${t.trackingWide};`,
    `--tracking-wider: ${t.trackingWider};`,
    `--radius: ${set.radius};`,
    `--max: ${set.container.max};`,
    `--card-min: ${set.container.cardMin};`,
  ];
  return `:root {\n  ${lines.join("\n  ")}\n}\n`;
}
