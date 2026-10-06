#!/usr/bin/env tsx
/**
 * Generates fixture/page.html from the real H24 renderers — the same
 * html/index.ts and css/tokens.ts every consumer (H25, apps/web, K03) uses.
 * Run: `pnpm --filter @fx/design build:fixture`.
 *
 * test/fixture-checks.test.ts re-runs this generator in memory and asserts
 * it matches the checked-in file, so fixture/page.html can never silently
 * drift from what the renderers actually produce.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixturePage, buildFixtureStylesheet } from "../test/lib/fixturePage.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "..", "fixture");

async function main() {
  await fs.writeFile(path.join(FIXTURE_DIR, "page.html"), buildFixturePage(), "utf-8");
  // Regenerated, gitignored (see fixture/.gitignore) — for opening page.html
  // in a real browser locally. Not needed by the checked-in page.html or by
  // K02's checks, which never look at CSS.
  await fs.writeFile(path.join(FIXTURE_DIR, "site.css"), buildFixtureStylesheet(), "utf-8");
  console.log(`wrote ${FIXTURE_DIR}/page.html and ${FIXTURE_DIR}/site.css`);
}

main();
