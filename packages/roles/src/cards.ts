import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cardMap from "./cardMap.json" with { type: "json" };
import productCardMap from "./productCardMap.json" with { type: "json" };
import { ROLE_MANIFEST } from "./manifest.js";

/**
 * D#2 H14c-3-2d-2 / H14c-3-3a: the text of a role's card. Only a name in the manifest is ever looked up
 * (a role string from a caller never reaches a path), and a manifest role with no card gives `undefined`:
 * the caller refuses, it never substitutes a default card.
 *
 * The cards are COMPILED INTO the code (cardMap.json, built from `cards/*.md` by
 * scripts/generate-card-map.mjs; a test fails if it is stale). A deployed function cannot read them from disk:
 * webpack bakes `import.meta.url` to the build machine's path, which does not exist where the function runs.
 * Reading `cards/<name>.md` is a fallback for tests and dev only, never in production.
 */
const CARD_MAP: Readonly<Record<string, string>> = cardMap;
const cache = new Map<string, string | undefined>();

function readFromDisk(role: string): string | undefined {
  // Not `new URL("../cards/", import.meta.url)`: Next's webpack tries to resolve that as an asset and the build fails.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cards");
  try {
    return readFileSync(path.join(dir, `${role}.md`), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return undefined;
  }
}

export function loadRoleCard(role: string): string | undefined {
  if (!ROLE_MANIFEST.some((entry) => entry.name === role)) return undefined;
  if (Object.hasOwn(CARD_MAP, role)) return CARD_MAP[role];
  if (process.env.NODE_ENV === "production") return undefined;
  if (!cache.has(role)) cache.set(role, readFromDisk(role));
  return cache.get(role);
}

/**
 * D#483 P3: the card a PRODUCT run uses for a role: its card in `cards-product/`, written for a customer's repository and
 * the platform's process. There is NO fallback to the dev-team card (`loadRoleCard`): those carry our own team's process
 * (Discussions, panels, state changes, the gh CLI) and conflicted with the product's step prompts. A manifest role with no
 * product card, and any name outside the manifest, gives `undefined`, and the seat refuses the run (`no_card`).
 */
const PRODUCT_CARD_MAP: Readonly<Record<string, string>> = productCardMap;
export function loadProductCard(role: string): string | undefined {
  if (!ROLE_MANIFEST.some((entry) => entry.name === role)) return undefined;
  return Object.hasOwn(PRODUCT_CARD_MAP, role) ? PRODUCT_CARD_MAP[role] : undefined;
}
