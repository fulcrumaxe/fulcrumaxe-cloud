#!/usr/bin/env node
// Prints the vitest project names (one per line) that own tests under the given workspace directories:
//
//   node scripts/ci/vitest-projects.mjs packages/api apps/web
//
// The names come from vitest itself (`vitest list --filesOnly` prints "[project] file"), because a
// project's name is not always its directory: some entries in vitest.workspace.ts are inline and carry their
// own `name`, and the rest take it from package.json. A directory with no test files prints nothing.
import { execFileSync } from "node:child_process";

/** "[name] path" lines to a Map<name, string[]> of test files. */
export function parseList(output) {
  const byProject = new Map();
  for (const line of output.split("\n")) {
    const m = line.match(/^\[([^\]]+)\]\s+(\S.*)$/);
    if (!m) continue;
    if (!byProject.has(m[1])) byProject.set(m[1], []);
    byProject.get(m[1]).push(m[2].trim());
  }
  return byProject;
}

/** The project names with at least one test file under one of `dirs`. Sorted. */
export function projectsFor(byProject, dirs) {
  const names = [];
  for (const [name, files] of byProject) {
    if (files.some((f) => dirs.some((d) => f.startsWith(`${d.replace(/\/$/, "")}/`)))) names.push(name);
  }
  return names.sort();
}

function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error("usage: vitest-projects.mjs <workspace dir>...");
    process.exit(2);
  }
  const out = execFileSync("pnpm", ["exec", "vitest", "list", "--filesOnly"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const byProject = parseList(out);
  if (byProject.size === 0) {
    console.error("vitest-projects: `vitest list` reported no projects; refusing to guess");
    process.exit(1);
  }
  for (const name of projectsFor(byProject, dirs)) console.log(name);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
