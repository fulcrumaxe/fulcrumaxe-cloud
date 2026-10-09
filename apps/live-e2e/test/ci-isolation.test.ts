/**
 * The live runner serves the PRIVATE repository only. Two guards, both runnable on either plane:
 *   - no workflow file other than live-e2e.yml (which exists on the private plane only) may ask for the
 *     `live-e2e` runner label in `runs-on`;
 *   - the PR workflows (ci.yml, ci-full-label.yml) never mention `live-e2e` at all, so PR code can never land
 *     on the live runner.
 * The workflow's own checks and the denylist entry for it are in test/workflow.test.ts, which is private-only.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOWS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".github", "workflows");
const LIVE_WORKFLOW = "live-e2e.yml";

const stripComments = (text: string): string => text.replace(/^\s*#.*$/gm, "").replace(/\s#\s.*$/gm, "");

/** True when any `runs-on` value (scalar, flow list or block list, with comments ignored) names `live-e2e`. */
function runsOnLiveE2e(text: string): boolean {
  const lines = stripComments(text).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)runs-on:(.*)$/.exec(lines[i] as string);
    if (!m) continue;
    let value = m[2] as string;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] as string;
      if (next.trim() === "") continue;
      if (!/^\s*-\s|^\s{2,}\S/.test(next) || (next.search(/\S/) <= (m[1] as string).length && !/^\s*-\s/.test(next))) break;
      value += ` ${next}`;
    }
    if (value.includes("live-e2e")) return true;
  }
  return false;
}

describe("runsOnLiveE2e", () => {
  it("sees the label as a scalar, in a flow list, in a block list and inside an expression", () => {
    expect(runsOnLiveE2e("jobs:\n  a:\n    runs-on: live-e2e\n")).toBe(true);
    expect(runsOnLiveE2e("jobs:\n  a:\n    runs-on: [self-hosted, live-e2e]\n")).toBe(true);
    expect(runsOnLiveE2e("jobs:\n  a:\n    runs-on:\n      - self-hosted\n      - live-e2e\n    steps: []\n")).toBe(true);
    expect(runsOnLiveE2e("jobs:\n  a:\n    runs-on: ${{ vars.X || 'live-e2e' }}\n")).toBe(true);
  });
  it("ignores other labels, comments, and other keys that mention the name", () => {
    expect(runsOnLiveE2e("jobs:\n  a:\n    runs-on: ubuntu-latest\n    name: live-e2e\n")).toBe(false);
    expect(runsOnLiveE2e("jobs:\n  a:\n    # runs-on: live-e2e\n    runs-on: self-hosted\n")).toBe(false);
    expect(runsOnLiveE2e("jobs:\n  a:\n    runs-on:\n      - self-hosted\n    steps:\n      - run: echo live-e2e\n")).toBe(false);
  });
});

describe("the public workflows", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f) && f !== LIVE_WORKFLOW);

  it("the folder has workflows to check (so the checks below are not vacuous)", () => {
    expect(files).toContain("ci.yml");
  });
  for (const f of files) {
    it(`${f} does not run on the live-e2e runner`, () => {
      expect(runsOnLiveE2e(readFileSync(join(WORKFLOWS, f), "utf8"))).toBe(false);
    });
  }
  for (const f of ["ci.yml", "ci-full-label.yml"]) {
    it(`${f} never mentions live-e2e`, () => {
      expect(readFileSync(join(WORKFLOWS, f), "utf8")).not.toContain("live-e2e");
    });
  }
});
