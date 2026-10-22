// apps/workspace/test/runs-check.test.mjs
//
// D#6 R-CHK-3b: the Check block of the Runs detail, one test per state, on the bodies the real route produced (the getRunInsight check fixtures,
// pinned by packages/api/test/run-check-states.test.ts). The model half is checked as data; the same bodies are drawn in a browser by e2e/runs-check.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_CHANGED, CHECK_COPY, checkView, readInsight, showArg } from "../apps/runs/runs-detail.js";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages");
const fx = (name) => readInsight(JSON.parse(readFileSync(join(PACKAGES, "api", "fixtures", "v1", "getRunInsight", `200-check-${name}.json`), "utf8")));
const view = (name) => checkView(fx(name));

describe("the Check block, one state each", () => {
  it("not set: a runner run whose job carried no check says so", () => {
    expect(view("not-set")).toMatchObject({ state: "not_set", label: "Not set", copy: CHECK_COPY.not_set[1], argv: [], facts: [] });
  });
  it("not run: the run ended before the check", () => {
    expect(view("not-run")).toMatchObject({ state: "not_run", label: "Not run", copy: "The run ended before the check ran." });
  });
  it("running: a live run has no result yet", () => {
    expect(view("running")).toMatchObject({ state: "running", copy: expect.stringContaining("after the agent finishes") });
  });
  it("passed: exit status, duration and the skipped count; the first line is highlighted", () => {
    const v = view("passed");
    expect(v.state).toBe("passed");
    expect(v.facts).toEqual(["Runs in the dev shell", "Time limit 30m 00s", "Exit status 0", "Took 1m 35s", "Skipped tests: 3"]);
    expect(v.changed).toBe(CHECK_CHANGED + "scripts/check.sh");
    expect(v.tail).toBe("Tests  12 passed | 3 skipped (15)");
  });
  it("failed: the exit status, no highlight when the first line is not the changed-files line, and a skipped count that was not recorded", () => {
    const v = view("failed");
    expect(v.state).toBe("failed");
    expect(v.facts).toContain("Exit status 1");
    expect(v.facts).toContain("Skipped tests: Not recorded");
    expect(v.changed).toBeNull();
    expect(v.tail).toBe("FAIL src/a.test.ts\n  expected 1 to be 2 <b>x</b>");
  });
  it("timed out: stopped at its limit, with no exit status and no skipped count", () => {
    const v = view("timed-out");
    expect(v.state).toBe("timed_out");
    expect(v.facts.join(" ")).toContain("Took 30m 00s");
    expect(v.facts.join(" ")).not.toMatch(/Exit status|Skipped/);
  });
  it("no dev shell: told from the runner's run_ended detail, with no duration of a check that never ran", () => {
    const v = view("no-dev-shell");
    expect(v).toMatchObject({ state: "no_dev_shell", label: "No dev shell", tail: "" });
    expect(v.facts.join(" ")).not.toMatch(/Took|Exit status|Skipped/);
  });
  it("could not run safely: the runner's refusal in the summary is not read as a failing check", () => {
    const v = view("not-safe");
    expect(v.state).toBe("unsafe");
    expect(v.label).toBe("Could not run safely");
    expect(v.tail).toMatch(/^the check was not run: these files could not be pinned/);
    expect(v.facts.join(" ")).not.toMatch(/Exit status|Skipped/);
  });
  it("runner too old: the server's own sentence from the wait", () => {
    const body = fx("runner-too-old");
    expect(checkView(body)).toMatchObject({ state: "runner_too_old", copy: body.wait.text });
  });
});

describe("what is never guessed", () => {
  it("a sandbox run has no Check block", () => {
    const body = fx("not-set");
    expect(checkView({ ...body, run: { ...body.run, runtime: "production" } })).toBeNull();
  });
  it("the command shows every space: quoted, with a mark for each", () => {
    expect(view("failed").argv.map(showArg)).toEqual(['"pnpm"', '"run"', '"check"', '"--"', '"a␣␣b"']);
    expect(showArg(" x ")).toBe('"␣x␣"');
  });
  it("a body with a malformed check reads as not set rather than throwing", () => {
    const body = fx("passed");
    for (const bad of [{ argv: "x" }, { argv: null }, 5, "a", []]) expect(checkView({ ...body, check: bad }).state).toBe("not_set");
  });
  it("a result with no exit status and a plain summary is a failure, not a pass", () => {
    const body = fx("failed");
    expect(checkView({ ...body, check: { ...body.check, result: { ...body.check.result, exit_code: null, summary: "the check stopped" } } }).state).toBe("failed");
  });
  it("the copy of every state is a sentence, never a code or a hole", () => {
    for (const [label, copy] of Object.values(CHECK_COPY)) {
      expect(label).toMatch(/^[A-Z]/);
      expect(copy).toMatch(/\.$/);
      expect(label + copy).not.toMatch(/null|undefined|NaN|_/);
    }
  });
});
