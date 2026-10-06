// Finds imports that cross a workspace package boundary without the importing package declaring the
// target in its package.json (D#507). Two kinds of specifier count: a relative path that resolves into
// another package's directory, and a bare import of another workspace package's name.
//
// File reads (readFileSync of a sibling package's file) are not imports and are not seen here.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const DEP_KEYS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|vi\.(?:mock|importActual|importMock|doMock)\s*\(\s*)["']([^"']+)["']/g;
const isTestFile = (f) =>
  /(^|\/)(test|tests|__tests__|e2e|fixtures)\//.test(f) || /\.(test|spec)\.[cm]?[tj]sx?$/.test(f) || /\.fixture\./.test(f);

/** Every undeclared cross-package import under `root`: [{from, to, name, kind, src, test}], sorted. */
export function findUndeclared(root) {
  const files = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter(Boolean);
  const dirs = files.filter((f) => /^(apps|packages|sites)\/[^/]+\/package\.json$/.test(f)).map((f) => path.dirname(f));
  const manifests = new Map();
  const dirByName = new Map();
  for (const d of dirs) {
    const m = JSON.parse(readFileSync(path.join(root, d, "package.json"), "utf8"));
    manifests.set(d, m);
    dirByName.set(m.name, d);
  }
  const ownerOf = (f) => dirs.find((d) => f.startsWith(`${d}/`));
  const found = new Map();
  for (const f of files) {
    if (!/\.[cm]?[tj]sx?$/.test(f)) continue;
    const from = ownerOf(f);
    if (!from) continue;
    let text;
    try {
      text = readFileSync(path.join(root, f), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(SPEC)) {
      const spec = m[1];
      let to;
      if (spec.startsWith(".")) {
        to = ownerOf(`${path.posix.normalize(path.posix.join(path.posix.dirname(f), spec))}/x`);
      } else {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        to = dirByName.get(pkg);
      }
      if (!to || to === from) continue;
      const e = found.get(`${from}|${to}`) ?? { from, to, src: [], test: [] };
      e[isTestFile(f) ? "test" : "src"].push(f);
      found.set(`${from}|${to}`, e);
    }
  }
  const out = [];
  for (const e of found.values()) {
    const m = manifests.get(e.from);
    const name = manifests.get(e.to).name;
    if (DEP_KEYS.some((k) => m[k] && name in m[k])) continue;
    out.push({ ...e, name, kind: e.src.length > 0 ? "dependencies" : "devDependencies" });
  }
  return out.sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`));
}
