// Run with: node --test scripts/ci/declared-imports.test.mjs
// Fails when a workspace package imports another workspace package without declaring it (D#507).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findUndeclared } from "./declared-imports.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Edges that cannot be declared because they would close a dependency cycle between workspace packages
// (each is a test-only import; the reverse path already exists). They stay listed as extra_edges in
// scripts/ci/full-run-triggers.json. The test fails if one of these stops being needed, so the list shrinks.
const CYCLES = [
  ["packages/core", "packages/github"],
  ["packages/db", "packages/api"],
  ["packages/db", "packages/core"],
  ["packages/db", "packages/webhooks"],
  ["packages/decisions", "packages/db"],
  // discussions may not depend on runner (packages/discussions/src/comments.ts), so this direction stays
  // undeclared and runner declares discussions instead.
  ["packages/discussions", "packages/runner"],
  ["packages/pipeline", "packages/github"],
  ["packages/pipeline", "packages/worker"],
  ["packages/runner", "packages/github"],
  ["packages/spend", "packages/billing"],
  ["packages/spend", "packages/runner"],
  ["packages/telemetry", "packages/api"],
];
const key = (e) => `${e.from} -> ${e.to}`;

test("every cross-package import is declared in package.json (cycle pairs excepted)", () => {
  const allowed = new Set(CYCLES.map(([f, t]) => `${f} -> ${t}`));
  const bad = findUndeclared(repoRoot).filter((e) => !allowed.has(key(e)));
  assert.deepEqual(
    bad.map((e) => `${key(e)}: add "${e.name}": "workspace:*" to ${e.from}/package.json ${e.kind} (e.g. ${e.src[0] ?? e.test[0]})`),
    [],
  );
});

test("each excepted cycle pair is still an undeclared import", () => {
  const live = new Set(findUndeclared(repoRoot).map(key));
  const stale = CYCLES.map(([f, t]) => `${f} -> ${t}`).filter((k) => !live.has(k));
  assert.deepEqual(stale, [], "drop these from CYCLES: the import is gone or now declared");
});

test("the scanner flags an undeclared relative and a bare import, and accepts a declared one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "decl507-"));
  try {
    const pkg = (d, name, deps = {}) => {
      mkdirSync(path.join(dir, d, "src"), { recursive: true });
      writeFileSync(path.join(dir, d, "package.json"), JSON.stringify({ name, dependencies: deps }));
    };
    pkg("packages/a", "@x/a");
    pkg("packages/b", "@x/b");
    pkg("packages/c", "@x/c", { "@x/a": "workspace:*" });
    writeFileSync(path.join(dir, "packages/a/src/i.ts"), 'import { b } from "../../b/src/i.js";\n');
    writeFileSync(path.join(dir, "packages/b/src/i.ts"), "export const b = 1;\n");
    writeFileSync(path.join(dir, "packages/c/src/i.ts"), 'import "@x/a";\nimport "@x/b";\n');
    execFileSync("git", ["-C", dir, "init", "-q"]);
    const got = findUndeclared(dir).map((e) => `${e.from} -> ${e.to} ${e.kind}`);
    assert.deepEqual(got, ["packages/a -> packages/b dependencies", "packages/c -> packages/b dependencies"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
