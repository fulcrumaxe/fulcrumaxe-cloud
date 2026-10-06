import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "../src/routes/index.js";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `pnpm --filter @fx/api gen-openapi`. Regenerates `openapi.json` byte
 * for byte from the registry's own zod schemas -- criterion 1's drift
 * test (`test/openapi-drift.test.ts`) re-runs this same pair of calls in
 * memory and diffs the result against the committed file, so this
 * script and the test MUST serialize identically (both go through
 * `serializeOpenApiDocument`, never `JSON.stringify` directly).
 */
const doc = buildOpenApiDocument(ROUTES);
const outPath = path.join(__dirname, "..", "openapi.json");
writeFileSync(outPath, serializeOpenApiDocument(doc));
console.log(`wrote ${outPath}`);
