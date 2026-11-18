// Run with: node --test scripts/ci/lanes.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAP, DEFAULT_TRIGGERS, classify, explain, loadLanes } from "./lanes.mjs";
import { globToRegExp } from "./affected.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cls = loadLanes();
const map = JSON.parse(readFileSync(DEFAULT_MAP, "utf8"));
const triggers = JSON.parse(readFileSync(DEFAULT_TRIGGERS, "utf8")).triggers;

/** Overlay paths exist only on the private checkout (the list is itself an overlay file). They are `hot` by the
 * fallback and are not what this test is about. */
function overlayMatchers() {
  const f = path.join(ROOT, "scripts/ci/publish-denylist.local");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")[0])
    .map((p) => (p.endsWith("/") ? (x) => x.startsWith(p) : (x) => x === p));
}

const sample = (glob) => glob.replace(/\*\*\//g, "d/").replace(/\*\*/g, "d/f").replace(/\*/g, "x").replace(/\?/g, "x");

test("R1.1 every tracked file gets exactly one lane, and no two non-hot rules overlap", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 1 << 28 }).toString().split("\0").filter(Boolean);
  const overlay = overlayMatchers();
  const bad = [];
  for (const f of files) {
    if (overlay.some((m) => m(f))) continue;
    const e = explain(cls, f);
    if (e.all.length === 0) bad.push(`${f}: no rule matches it (it would be hot only by the fallback)`);
    const nonHot = e.all.filter((l) => l !== "hot");
    if (nonHot.length > 1) bad.push(`${f}: two lanes ${nonHot.join(", ")}`);
    if (typeof classify(cls, f) !== "string") bad.push(`${f}: no lane`);
  }
  assert.deepEqual(bad.slice(0, 20), []);
});

test("R1.1 a missing rule makes the file hot, not an error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lanes-"));
  const m = JSON.parse(JSON.stringify(map));
  m.lanes = m.lanes.filter((l) => l.name !== "workspace");
  m.per_dir = [];
  writeFileSync(path.join(dir, "lanes.json"), JSON.stringify(m));
  const weak = loadLanes(path.join(dir, "lanes.json"));
  assert.equal(classify(weak, "apps/workspace/src/a.ts"), "hot");
  assert.equal(classify(weak, "packages/billing/src/a.ts"), "hot");
  assert.equal(classify(weak, "apps/web/app/page.tsx"), "web");
});

test("R1.1 an unreadable or malformed map makes every file hot", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lanes-"));
  writeFileSync(path.join(dir, "bad.json"), "{not json");
  for (const f of [path.join(dir, "missing.json"), path.join(dir, "bad.json")]) {
    const c = loadLanes(f);
    assert.equal(classify(c, "docs/a.md"), "hot");
  }
  writeFileSync(path.join(dir, "bad-trig.json"), JSON.stringify({ triggers: [] }));
  assert.equal(classify(loadLanes(DEFAULT_MAP, path.join(dir, "bad-trig.json")), "docs/a.md"), "hot");
  assert.equal(classify(cls, ""), "hot");
});

test("R1.2 one fixture file per lane", () => {
  const table = {
    "pnpm-lock.yaml": "hot",
    "packages/db/migrations/9999_x.sql": "hot",
    "packages/api/openapi.json": "hot",
    "packages/api-client/src/generated.ts": "hot",
    ".autonomous-team/config.json": "hot",
    "scripts/ci/lanes.json": "hot",
    "docs/ops/staging.md": "hot",
    "some/unknown/place.bin": "hot",
    "packages/runner/src/a.ts": "runner",
    "packages/runner-cloud/src/a.ts": "runner",
    "packages/runner-protocol/src/a.ts": "runner",
    "packages/fx-runner/src/a.ts": "runner",
    "apps/workspace/src/a.ts": "workspace",
    "apps/web/app/page.tsx": "web",
    "apps/web/app/_generated/x.ts": "hot",
    "docs/a/b.md": "docs",
    "wiki/Home.md": "docs",
    "README.md": "docs",
    "notes/deep/x.md": "docs",
    "packages/billing/README.md": "pkg:billing",
    "packages/billing/src/a.ts": "pkg:billing",
    "packages/spend/src/a.ts": "pkg:spend",
    "apps/ops/src/a.ts": "app:ops",
    "apps/web/README.md": "web",
  };
  for (const [f, lane] of Object.entries(table)) assert.equal(classify(cls, f), lane, f);
});

test("R1.2 every full-run trigger glob classifies hot", () => {
  assert.ok(triggers.length > 5);
  for (const t of triggers) {
    const f = sample(t.glob);
    assert.ok(globToRegExp(t.glob).test(f), `sample ${f} matches ${t.glob}`);
    assert.equal(classify(cls, f), "hot", `${t.glob} -> ${f}`);
  }
  for (const t of map.hot_extra) assert.equal(classify(cls, sample(t.glob)), "hot", t.glob);
});

test("R1.2 hot follows the trigger file: a new trigger glob is hot without touching the map", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lanes-"));
  const t = JSON.parse(readFileSync(DEFAULT_TRIGGERS, "utf8"));
  t.triggers.push({ glob: "packages/billing/**", reason: "test" });
  writeFileSync(path.join(dir, "t.json"), JSON.stringify(t));
  const c = loadLanes(DEFAULT_MAP, path.join(dir, "t.json"));
  assert.equal(classify(c, "packages/billing/src/a.ts"), "hot");
  assert.equal(classify(cls, "packages/billing/src/a.ts"), "pkg:billing");
});

test("R1.1 the command prints one lane per file, in order, and hot for what no rule matches", () => {
  const out = execFileSync("node", [path.join(ROOT, "scripts/ci/lanes.mjs"), "docs/a.md", "apps/web/x.ts", "weird/none"], { cwd: ROOT }).toString();
  assert.equal(out, "docs\tdocs/a.md\nweb\tapps/web/x.ts\nhot\tweird/none\n");
  const piped = execFileSync("node", [path.join(ROOT, "scripts/ci/lanes.mjs"), "--stdin"], { cwd: ROOT, input: "docs/a.md\npackages/core/x.ts\n" }).toString();
  assert.equal(piped, "docs\tdocs/a.md\nhot\tpackages/core/x.ts\n");
});
