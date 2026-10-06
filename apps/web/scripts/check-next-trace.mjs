// Regression check for the Vercel cold-start crash "Cannot find module
// 'next/dist/compiled/source-map'". Run AFTER `next build`.
//
// Vercel packs each serverless function from the build's .nft.json file
// traces. If outputFileTracingRoot sits below the pnpm store that holds
// `next` (the monorepo root's node_modules/.pnpm), the traces for
// next-server drop files its runtime requires lazily, and every function
// 500s on its first request while the build itself stays green.
//
// This check reads the `require("next/...")` literals out of Next's own
// compiled server runtime and fails if any of them is missing from the
// traces Vercel uses for next-server (full and minimal).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = path.join(webDir, ".next");
const failures = [];

const nextPkg = fs.realpathSync(path.join(webDir, "node_modules", "next"));
const runtimeFile = path.join(nextPkg, "dist/compiled/next-server/server.runtime.prod.js");
const source = fs.readFileSync(runtimeFile, "utf8");
const specs = [...new Set([...source.matchAll(/require\("(next\/[^"]+)"\)/g)].map((m) => m[1]))].sort();
if (specs.length === 0) failures.push(`found no require("next/...") literals in ${runtimeFile}; this check needs updating`);

// Next deliberately leaves the edge-runtime sandbox out of the minimal server
// trace (its own tracer omits it; the app has no edge routes -- middleware is
// bundled separately). Everything else the runtime requires must be present.
const NOT_IN_MINIMAL = new Set(["next/dist/server/web/sandbox"]);

const MARK = "/node_modules/next/";

function isTraced(traced, spec) {
  const rel = spec.slice("next/".length);
  return traced.some((f) => {
    const i = f.lastIndexOf(MARK);
    if (i < 0) return false;
    const inNext = f.slice(i + MARK.length);
    return inNext === rel || inNext === `${rel}.js` || inNext.startsWith(`${rel}/`);
  });
}

for (const trace of ["next-server.js.nft.json", "next-minimal-server.js.nft.json"]) {
  const file = path.join(nextDir, trace);
  if (!fs.existsSync(file)) {
    failures.push(`${trace} is missing; run \`next build\` first`);
    continue;
  }
  const traced = JSON.parse(fs.readFileSync(file, "utf8")).files.map((f) => path.resolve(path.dirname(file), f));
  for (const spec of specs) {
    if (trace.includes("minimal") && NOT_IN_MINIMAL.has(spec)) continue;
    if (!isTraced(traced, spec)) failures.push(`${trace} does not include ${spec}`);
  }
}

if (failures.length > 0) {
  console.error("check-next-trace: FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  console.error("Check outputFileTracingRoot in apps/web/next.config.mjs: it must be the monorepo root.");
  process.exit(1);
}
console.log(`check-next-trace: ok (${specs.length} next-server requires traced)`);
