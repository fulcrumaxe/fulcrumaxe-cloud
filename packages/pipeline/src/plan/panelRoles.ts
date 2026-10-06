/**
 * D#2 H15 criterion 2, panel composition, as ruled by C41 section 1: the
 * triple is chosen by the discussion's KIND, never by its text.
 *
 *   critical -> technical-architect, security-expert, cost-analyst
 *   feature  -> technical-architect, product-owner, performance-expert
 *
 * (the project-manager card's "Consensus Panel Protocol" default panels).
 * The title and body can only ADD seats: `researcher` on an
 * external-dependency word and `ux-designer` on a UI word, never twice, and
 * never removing anyone. The text is untrusted, so it must not be able to
 * pick its own reviewers. Pure: it only chooses roles, and the text is
 * scanned raw and never reaches a prompt from here.
 */

export const PANEL_ROLES = [
  "technical-architect",
  "security-expert",
  "cost-analyst",
  "product-owner",
  "performance-expert",
  "researcher",
  "ux-designer",
] as const;
export type PanelRole = (typeof PANEL_ROLES)[number];

const EXTERNAL_DEPENDENCY = ["npm", "pip", "cargo", "RFC", "W3C", "API", "library", "package", "mcp", "sdk"];
const UI = ["UI", "UX", "overlay", "popup", "button", "display", "screen", "layout", "wireframe"];

/** Bounds the scan: the text is untrusted and arbitrarily long. */
const SCAN_MAX_CHARS = 50_000;

const escape = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function matched(words: readonly string[], text: string): string[] {
  return words.filter((w) => new RegExp(`(?<![A-Za-z0-9_])${escape(w)}(?![A-Za-z0-9_])`, "i").test(text));
}

/** The seats fixed by kind, in order. */
const TRIPLE: Record<"critical" | "feature", readonly PanelRole[]> = {
  critical: ["technical-architect", "security-expert", "cost-analyst"],
  feature: ["technical-architect", "product-owner", "performance-expert"],
};

/**
 * The expected panel for a Critical/Feature discussion: the kind's triple
 * (technical-architect first), then `researcher` on an external-dependency
 * trigger, then `ux-designer` on a UI trigger. At most 5 seats.
 */
export function selectPanel(kind: "critical" | "feature", title: string, body: string): PanelRole[] {
  const text = `${title}\n${body}`.slice(0, SCAN_MAX_CHARS);
  const roles: PanelRole[] = [...TRIPLE[kind]];
  if (matched(EXTERNAL_DEPENDENCY, text).length > 0) roles.push("researcher");
  if (matched(UI, text).length > 0) roles.push("ux-designer");
  return roles;
}
