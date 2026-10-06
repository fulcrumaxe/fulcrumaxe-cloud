import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D#2 H14c-3-3a: builds `src/cardMap.json`, the card text compiled INTO the code.
 *
 * The map is COMMITTED (not built), as JSON, not as a source file: the repository's audit_log guard reads
 * source files line by line, and a card on one line would trip it on words in the card's own text. One line per
 * card, sorted by name, each card a JSON string, and nothing else in the output (no date, no host, no path),
 * so the same cards always give the same bytes and a change to one card changes one line. `test/cardMap.test.ts` regenerates it in memory and fails on any
 * difference, so a card edited without regenerating cannot merge.
 *
 *   node packages/roles/scripts/generate-card-map.mjs           writes the file
 *   node packages/roles/scripts/generate-card-map.mjs --check   exits 1 if the file is stale
 *
 * `--product` does the same for the product cards: `cards-product/*.md` -> `src/productCardMap.json`
 * (cards written for a customer's repository, with no team process in them; D#483).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const CARDS_DIR = path.join(here, "..", "cards");
export const MAP_PATH = path.join(here, "..", "src", "cardMap.json");

export const PRODUCT_CARDS_DIR = path.join(here, "..", "cards-product");
export const PRODUCT_MAP_PATH = path.join(here, "..", "src", "productCardMap.json");

export function renderCardMap(cardsDir = CARDS_DIR) {
  const names = readdirSync(cardsDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -".md".length))
    .sort();
  const lines = names.map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(readFileSync(path.join(cardsDir, `${name}.md`), "utf8"))}`);
  return ["{", lines.join(",\n"), "}", ""].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const product = process.argv.includes("--product");
  const mapPath = product ? PRODUCT_MAP_PATH : MAP_PATH;
  const next = renderCardMap(product ? PRODUCT_CARDS_DIR : CARDS_DIR);
  if (process.argv.includes("--check")) {
    if (readFileSync(mapPath, "utf8") !== next) {
      console.error(`card map is stale: run node packages/roles/scripts/generate-card-map.mjs${product ? " --product" : ""}`);
      process.exit(1);
    }
  } else {
    writeFileSync(mapPath, next);
  }
}
