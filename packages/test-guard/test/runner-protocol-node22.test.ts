/**
 * The runner protocol package supports Node 22.22.2 and up on customer machines while the repository builds on
 * Node 24. Two things keep that honest and are checked here as text, because the first runs only in CI:
 *   - `.github/workflows/ci.yml` has one step, in the existing `check` job, that runs the package's tests under the
 *     flake's Node 22, and fails when that Node is older than 22.22.2;
 *   - `.autonomous-team/project.json` records the repository's real toolchain, Node 24.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
const STEP = "Runner protocol tests on Node 22";

/** The text of the named step, up to the next step or job. */
function stepText(name: string): string {
  const lines = ci.split("\n");
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  expect(at, `ci.yml has no step "${name}"`).toBeGreaterThan(-1);
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((line) => /^\s*- (name|uses):/.test(line) || /^ {2}\S/.test(line));
  return [lines[at], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

describe("the Node 22 step in CI", () => {
  const checkJob = ci.slice(ci.indexOf("\n  check:"), ci.indexOf("\n  workspace-e2e:"));
  const step = stepText(STEP);

  it("is a step of the existing check job, after the checks, with no job, matrix or hosted runner of its own", () => {
    expect(checkJob).toContain(`- name: ${STEP}`);
    expect(ci.indexOf(`- name: ${STEP}`)).toBeGreaterThan(ci.indexOf("- name: Run checks"));
    // The jobs are the public-PR gates, the check job and the e2e job; the Node 22 step adds no job to them.
    expect(ci.slice(ci.indexOf("\njobs:")).match(/^ {2}[a-z][a-z0-9-]*:\s*$/gm)).toEqual(["  pr-gates:", "  check:", "  workspace-e2e:"]);
    // The check job's runner is the repository-wide guarded expression, not something the step chose.
    expect(checkJob).toContain("runs-on: ${{ github.event.repository.private && (vars.CI_RUNS_ON || 'self-hosted') || 'ubuntu-latest' }}");
    expect(step).not.toMatch(/^\s*(continue-on-error|runs-on|strategy):/m);
  });

  it("is skipped only by the pull-request scope decision: it runs on every push, and on a pull request unless the scope step said the package is unaffected", () => {
    // D#507: an affected-only pull request run leaves the step out when packages/runner-protocol is not in
    // scripts/ci/affected.mjs's answer. Any other condition would be a quiet way to stop checking Node 22.
    const conditions = step.split("\n").filter((line) => /^\s*if:/.test(line));
    expect(conditions.map((line) => line.trim())).toEqual(["if: github.event_name != 'pull_request' || env.CI_SCOPE_RUNNER_PROTOCOL != 'false'"]);
  });

  it("takes Node 22 from the flake's locked nixpkgs and fails below 22.22.2", () => {
    expect(step).toMatch(/nix shell --inputs-from \S+ nixpkgs#nodejs_22 --command node --version/);
    expect(step).toContain("major !== 22 || minor < 22 || (minor === 22 && patch < 2)");
    expect(step).toContain("process.exit(1)");
    expect(step).toContain("set -euo pipefail");
  });

  it("runs the protocol package's vitest entry with that node, directly, not through pnpm", () => {
    expect(step).toContain("cd packages/runner-protocol");
    expect(step).toMatch(/nixpkgs#nodejs_22 --command node node_modules\/vitest\/vitest\.mjs run/);
    expect(step).not.toMatch(/pnpm|npx/);
  });
});

describe("the toolchain record", () => {
  // .autonomous-team/ is a private overlay directory, absent from the public tree.
  it.skipIf(!existsSync(join(REPO_ROOT, ".autonomous-team/project.json")))("project.json says Node 24, the repository's real toolchain", () => {
    const project = JSON.parse(readFileSync(join(REPO_ROOT, ".autonomous-team/project.json"), "utf8")) as { toolchain: { node_version: string } };
    expect(project.toolchain.node_version).toBe("24");
  });

  it("the toolchain itself is still Node 24: .nvmrc, the root engines and the flake", () => {
    expect(readFileSync(join(REPO_ROOT, ".nvmrc"), "utf8").trim()).toBe("24");
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { engines: { node: string } };
    expect(root.engines.node).toBe(">=24");
    expect(readFileSync(join(REPO_ROOT, "flake.nix"), "utf8")).toContain("nodejs_24");
  });
});
