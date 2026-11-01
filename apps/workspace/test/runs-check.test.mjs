// apps/workspace/test/runs-check.test.mjs
//
// D#6 R-CHK-3b: the Check block of the Runs detail, one test per state, on the bodies the real route produced (the getRunInsight check fixtures,
// pinned by packages/api/test/run-check-states.test.ts). The model half is checked as data; the same bodies are drawn in a browser by e2e/runs-check.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_CHANGED, CHECK_COPY, CHECK_FAILED_FILES_LABEL, CHECK_FAILED_FILES_MORE, CHECK_REASON_COPY, checkView, readInsight, showArg } from "../apps/runs/runs-detail.js";
import { CHECK_NOT_RUN_LINES } from "../../../packages/runner-protocol/src/copy.ts";
import { CHECK_NOT_RUN_REASONS } from "../../../packages/runner-protocol/src/messages.ts";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages");
const fx = (name) => readInsight(JSON.parse(readFileSync(join(PACKAGES, "api", "fixtures", "v1", "getRunInsight", `200-check-${name}.json`), "utf8")));
const view = (name) => checkView(fx(name));

describe("the Check block, one state each", () => {
  it("failing test files: the names the runner sent as a short list with a count of the rest, in fixed words; none for a pass, an odd list, or a run that sent none (D#6 CHECK-FAILFILES-TO-CLOUD)", () => {
    const v = view("failed-files");
    expect(v.state).toBe("failed");
    expect(v.failed).toEqual({ files: ["apps/ops/test/scan.test.ts", "packages/db/test/a.pg.test.ts"], more: 3 });
    expect(CHECK_FAILED_FILES_LABEL).toBe("Failing test files");
    expect(CHECK_FAILED_FILES_MORE(3)).toBe("+3 more");
    expect(view("failed").failed).toBeNull();
    const body = fx("failed-files");
    const withFiles = (failed_files, state = {}) => checkView({ ...body, check: { ...body.check, result: { ...body.check.result, ...state, failed_files } } }).failed;
    expect(withFiles([1, 2])).toBeNull();
    expect(withFiles([])).toBeNull();
    expect(withFiles(["a.test.ts"], { exit_code: 0 })).toBeNull();
  });

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
  it("a read-only run says the check runs only on code runs", () => {
    const body = fx("not-set");
    for (const role of ["code-reviewer", "release-manager"]) {
      expect(checkView({ ...body, run: { ...body.run, role } })).toMatchObject({ state: "read_only", label: "Not run", copy: CHECK_COPY.read_only[1], argv: [], facts: [] });
    }
  });
  it("a run that can change code with no check still says the repository has no approved check", () => {
    const body = fx("not-set");
    for (const role of ["executor", "docs-writer"]) {
      expect(checkView({ ...body, run: { ...body.run, role } })).toMatchObject({ state: "not_set", label: "Not set", copy: CHECK_COPY.not_set[1] });
    }
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
  it("a malformed check on a read-only run is never read as a check that ran", () => {
    const body = fx("passed");
    for (const bad of [{ argv: "x" }, { argv: null }, 5, "a", []]) {
      expect(checkView({ ...body, check: bad, run: { ...body.run, role: "code-reviewer" } }).state).toBe("read_only");
      expect(checkView({ ...body, check: bad, run: { ...body.run, role: "executor" } }).state).toBe("not_set");
    }
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

// D#6 R-CHK-3d: the "could not run safely" state is told from the runner's closed reason code, not from its words.
describe("the reason code", () => {
  const withReason = (name, reason, over = {}) => {
    const body = fx(name);
    return { ...body, check: { ...body.check, result: { ...body.check.result, reason, ...over } } };
  };
  it("the copy of every code is the runner protocol's sentence, so the page and the end line cannot word it differently", () => {
    expect(CHECK_REASON_COPY).toEqual(CHECK_NOT_RUN_LINES);
    expect(Object.keys(CHECK_REASON_COPY).sort()).toEqual([...CHECK_NOT_RUN_REASONS].sort());
  });
  it.each(CHECK_NOT_RUN_REASONS)("%s: could not run safely, with its own sentence, no exit status or duration, and the output still shown as text", (code) => {
    const v = checkView(withReason("failed", code, { exit_code: null }));
    expect(v.state).toBe("unsafe");
    expect(v.label).toBe("Could not run safely");
    expect(v.copy).toBe(CHECK_NOT_RUN_LINES[code] + " This run ended without a pull request.");
    expect(v.facts.join(" ")).not.toMatch(/Exit status|Took|Skipped/);
    expect(v.tail).toBe("FAIL src/a.test.ts\n  expected 1 to be 2 <b>x</b>");
  });
  it("a reason decides, whatever the summary says: words that look like a failing test do not make it a failed check, and an exit status of 0 does not make it a pass", () => {
    expect(checkView(withReason("failed", "start_failed", { exit_code: null, summary: "FAIL src/a.test.ts" })).state).toBe("unsafe");
    expect(checkView(withReason("passed", "protected_changed")).state).toBe("unsafe");
    expect(checkView(withReason("timed-out", "sandbox_refused")).state).toBe("unsafe");
  });
  it("the words alone no longer decide: a result with no reason and the old refusal words is read by the legacy rule only for rows that predate the code, and a failing summary with a reason is not", () => {
    expect(view("not-safe")).toMatchObject({ state: "unsafe", copy: CHECK_COPY.unsafe[1] });
    expect(checkView(withReason("not-safe", null, { summary: "the check was not run: x", exit_code: 1 })).state).toBe("failed");
  });
  it("a code this page does not know, or a value that is not a code, reads as the generic sentence and is never drawn", () => {
    for (const odd of ["a_newer_reason", "<b>x</b>", 7, {}, "constructor", "__proto__"]) {
      const v = checkView(withReason("failed", odd, { exit_code: null }));
      expect(v.state).toBe("unsafe");
      expect(v.copy).toBe(CHECK_NOT_RUN_LINES.other + " This run ended without a pull request.");
      expect(JSON.stringify(v.copy)).not.toContain("newer");
    }
  });
  it("is the same on the bodies the real route produced for three of the codes", () => {
    expect(view("unsafe-sandbox-refused").copy).toBe(CHECK_NOT_RUN_LINES.sandbox_refused + " This run ended without a pull request.");
    expect(view("unsafe-pin-failed").copy).toBe(CHECK_NOT_RUN_LINES.pin_failed + " This run ended without a pull request.");
    expect(view("unsafe-protected-changed")).toMatchObject({ state: "unsafe", copy: CHECK_NOT_RUN_LINES.protected_changed + " This run ended without a pull request." });
  });
  it("the run's end line on the route's body names the approved check", () => {
    const line = fx("failed").lines.find((l) => /approved check/.test(l.text));
    expect(line.text).toBe("The approved check (pnpm run check -- a  b) failed, so this run ended without a pull request.");
  });
});
