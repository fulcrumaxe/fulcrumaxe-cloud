// Regression check for baked build-machine paths. Run AFTER `next build`.
//
// webpack replaces `import.meta.url` (and some absolute module paths) with the path of the machine that ran the
// build. On Vercel that is /vercel/path0/..., which does not exist where the function runs, so any file read
// built from it throws ENOENT on the first request while the build itself stays green. (This is what took down
// every /api/v1 route that pulled in @fx/design: it read tokens/terminal.json that way.)
//
// This check fails if any file under .next/server contains the monorepo root as seen at build time, unless the
// occurrence is on the allowlist below. Every allowlist entry says why it is harmless; anything new fails, so a
// new baked path is either fixed (compile the file into the code) or deliberately reviewed and listed here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(webDir, ".next", "server");

// An occurrence is allowed when every condition an entry names holds:
//   file     matches the build file's path relative to .next/server (posix slashes);
//   rest     matches the path after the root (leading "/" kept);
//   before   matches the text just before the root;
//   fileUrl  must be exactly `true` for the entry to accept a root written inside a `file://` URL (what a baked
//            import.meta.url looks like). An entry without `fileUrl: true` REJECTS every file:// match, however
//            well its other conditions fit, because a file:// URL is the shape that gets opened at runtime.
// Only the three reviewed harmless file-URL uses at the bottom carry `fileUrl: true`, each pinned to its exact
// source file and to the numbered-chunk pattern webpack emits them in.
export const ALLOWED = [
  {
    file: /^app\/.+_client-reference-manifest\.js$/,
    rest: /^\/(apps\/web(\/|$)|node_modules\/\.pnpm\/next@[^/]+\/node_modules\/next\/dist\/)/,
    why: "Next's client-reference manifests key modules by their source path; the keys are labels, never opened.",
  },
  {
    file: /^app\/.+\.js$/,
    rest: /^\/apps\/web\/app\//,
    why: "Next's page and route loaders under server/app carry the route source path (resolvedPagePath, loader tuples) as an id, never opened.",
  },
  {
    file: /^chunks\/\d+\.js$/,
    // minified shape: `let{createProxy:d}=c(88226);a.exports=d("<path>")`
    before: /\{createProxy:[\w$]+\}=[^;]{0,40};[\w$.]+=[\w$]+\("$/,
    rest: /^\/node_modules\/\.pnpm\/next@[^/]+\/node_modules\/next\/dist\/[^"]*\.js$/,
    why: 'Next\'s client-component proxies (createProxy("<module path>")) name Next\'s own dist modules as ids; the path is a label, never opened.',
  },
  {
    file: /^chunks\/\d+\.js$/,
    fileUrl: true,
    rest: /^\/node_modules\/\.pnpm\/@workflow\+world-local@[^/]+\/node_modules\/@workflow\/world-local\/dist\/init\.js$/,
    why: "@workflow/world-local reads its package.json for a version string inside try/catch and falls back when it is absent.",
  },
  {
    file: /^chunks\/\d+\.js$/,
    fileUrl: true,
    rest: /^\/node_modules\/\.pnpm\/cbor-x@[^/]+\/node_modules\/cbor-x\/node-index\.js$/,
    why: "cbor-x tries require('cbor-extract') first and only uses this createRequire path as a guarded fallback.",
  },
  {
    file: /^chunks\/\d+\.js$/,
    fileUrl: true,
    rest: /^\/packages\/webhooks\/src\/adoption\.ts$/,
    why: "adoption.ts only compares import.meta.url with argv[1] to detect being run as a script; it opens no file.",
  },
];

/** True when the occurrence sits inside a file:// URL: the token that holds it began with `file://`. */
function insideFileUrl(before) {
  return /file:\/\/[^"'`\s]*$/.test(before);
}

/** `relFile` is relative to .next/server, `rest` is the path after the root, `before` is the text ahead of the root. */
export function isAllowed({ relFile, rest, before }) {
  const fileUrl = insideFileUrl(before);
  return ALLOWED.some(
    (a) =>
      (!fileUrl || a.fileUrl === true) &&
      (!a.file || a.file.test(relFile)) &&
      (!a.rest || a.rest.test(rest)) &&
      (!a.before || a.before.test(before)),
  );
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|json|html|rsc|mjs|cjs|txt|map)$/.test(e.name)) out.push(p);
  }
  return out;
}

export function findBaked(serverDirectory, roots) {
  const bad = new Set();
  for (const file of walk(serverDirectory)) {
    const text = fs.readFileSync(file, "utf8");
    const relFile = path.relative(serverDirectory, file).split(path.sep).join("/");
    for (const root of roots) {
      let i = 0;
      while ((i = text.indexOf(root, i)) >= 0) {
        const after = text.slice(i + root.length, i + root.length + 200).match(/^[^"'`)\s,;]*/)[0];
        // the root must end at a path boundary, not be a prefix of a longer directory name
        if (after === "" || after.startsWith("/")) {
          const before = text.slice(Math.max(0, i - 200), i);
          if (!isAllowed({ relFile, rest: after, before })) {
            bad.add(`${relFile}: ${insideFileUrl(before) ? "file://" : ""}<root>${after}`);
          }
        }
        i += root.length;
      }
    }
  }
  return [...bad];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(serverDir)) {
    console.error(`check-baked-paths: no build output at ${serverDir}; run \`next build\` first`);
    process.exit(1);
  }
  const repoRoot = path.resolve(webDir, "../..");
  const roots = [...new Set([repoRoot, fs.realpathSync(repoRoot)])];
  const bad = findBaked(serverDir, roots);
  if (bad.length > 0) {
    console.error("check-baked-paths: FAIL -- the build output contains the build machine's path:");
    for (const b of bad) console.error(`  - ${b}`);
    console.error("A file read from import.meta.url (or a path built at build time) fails in a deployed function.");
    console.error("Compile the file into the code (static JSON import or a generated module) instead of reading it.");
    process.exit(1);
  }
  console.log("check-baked-paths: ok (no un-allowlisted build-machine path in .next/server)");
}
