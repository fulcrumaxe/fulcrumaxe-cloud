import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds `src/css/baseCss.json`: the text of `src/css/base.css` as one JSON string, so the stylesheet is
 * COMPILED INTO the code that imports it. A deployed function cannot read `base.css` from disk: webpack bakes
 * `import.meta.url` to the build machine's path, which does not exist where the function runs. The file is
 * COMMITTED, and `test/baseCss.test.ts` regenerates it in memory and fails on any difference, so an edit to
 * base.css that was not regenerated cannot merge.
 *
 *   node packages/design/scripts/generate-base-css.mjs           writes the file
 *   node packages/design/scripts/generate-base-css.mjs --check   exits 1 if the file is stale
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const CSS_PATH = path.join(here, "..", "src", "css", "base.css");
export const JSON_PATH = path.join(here, "..", "src", "css", "baseCss.json");

export function renderBaseCss(cssPath = CSS_PATH) {
  return `${JSON.stringify(readFileSync(cssPath, "utf8"))}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = renderBaseCss();
  if (process.argv.includes("--check")) {
    if (readFileSync(JSON_PATH, "utf8") !== next) {
      console.error("baseCss.json is stale: run node packages/design/scripts/generate-base-css.mjs");
      process.exit(1);
    }
  } else {
    writeFileSync(JSON_PATH, next);
  }
}
