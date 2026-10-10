// Run with: node --test scripts/ci/ci-workflow.test.mjs
//
// Reads .github/workflows/ci.yml and scripts/check.sh and pins how the scope decision (scripts/ci/affected.mjs)
// is wired in. The behaviour on a real runner is shown by the pull request's own CI run; these tests keep the
// wiring from drifting between runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const ci = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const noComments = (s) => s.replace(/^\s*#.*$/gm, "");
const rerunScript = readFileSync(path.join(here, "rerun-ci-full.sh"), "utf8");

const checkJob = ci.slice(ci.indexOf("\n  check:"), ci.indexOf("\n  workspace-e2e:"));
const e2eJob = ci.slice(ci.indexOf("\n  workspace-e2e:"), ci.indexOf("\n  e2e-runner:"));
const runnerE2eJob = ci.slice(ci.indexOf("\n  e2e-runner:"));

/** Step blocks of a job, in order: [{ name, text }] (text without comment lines). */
function stepsOf(job) {
  const parts = job.split(/\n(?=      - (?:name|uses):)/).slice(1);
  return parts.map((raw) => {
    const text = noComments(raw);
    return { raw, text, name: (/^ {6}- name: (.*)$/m.exec(text) ?? [, text.split("\n")[0]])[1] };
  });
}
const checkSteps = stepsOf(checkJob);
const e2eSteps = stepsOf(e2eJob);
const runnerE2eSteps = stepsOf(runnerE2eJob);
const stepNamed = (steps, name) => {
  const s = steps.find((x) => x.name === name);
  assert.ok(s, `no step "${name}"`);
  return s;
};
// Ubicloud runners register as self-hosted, so the hosted setup keys off CI_RUNS_ON too. `self-hosted` itself
// names the owner's machine (which already has Nix), so it does not count.
const GUARD = "${{ github.event.repository.private && (vars.CI_RUNS_ON || 'self-hosted') || 'ubuntu-latest' }}";
const EPHEMERAL = "(runner.environment == 'github-hosted' || (vars.CI_RUNS_ON != '' && vars.CI_RUNS_ON != 'self-hosted'))";
const ifOf = (step) => (/^ {8}if: (.*)$/m.exec(step.text) ?? [, null])[1];

// ---- the file is valid YAML --------------------------------------------------
// A workflow GitHub cannot parse fails every run at once ("workflow file issue"), including the push run on
// main. Two layers: a dependency-free check for the mistake that actually happened (a plain scalar with a
// ": " inside), and a real parse with PyYAML, which the dev shell provides (a parse error or a missing parser fails).
test("no plain scalar value contains a colon and a space (the shape GitHub rejects as a workflow file issue)", () => {
  const lines = noComments(ci).split("\n");
  lines.forEach((line, i) => {
    const m = /^\s*(?:- )?[A-Za-z_-]+:\s+(\S.*)$/.exec(line);
    if (!m) return;
    const value = m[1];
    if (/^["'|>\[{]/.test(value) || value.startsWith("${{")) return;
    assert.ok(!/: |:$/.test(value.replace(/\$\{\{.*?\}\}/g, "")), `line ${i + 1} is an unquoted scalar with ": " in it: ${line.trim()}`);
  });
});

test("the workflow parses as YAML and has its four jobs", () => {
  const py = spawnSync("python3", ["-c", "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", path.join(repoRoot, ".github/workflows/ci.yml")], { encoding: "utf8" });
  assert.equal(py.status, 0, `ci.yml does not parse as YAML (or PyYAML is missing from the dev shell): ${py.stderr}`);
  const doc = JSON.parse(py.stdout);
  assert.deepEqual(Object.keys(doc.jobs), ["pr-gates", "check", "workspace-e2e", "e2e-runner"]);
  assert.deepEqual(doc.jobs["workspace-e2e"].strategy.matrix.project, ["desktop", "phone", "tablet"]);
  const pr = (doc.on ?? doc.true).pull_request; // YAML 1.1 reads the key `on` as the boolean true
  assert.deepEqual(pr.types, ["opened", "synchronize", "reopened"]);
});

// ---- triggers -------------------------------------------------------------
test("ci.yml: pull_request runs on opened, synchronize and reopened, and NOT on labeled", () => {
  const on = ci.slice(ci.indexOf("\non:"), ci.indexOf("\nconcurrency:"));
  const m = /pull_request:\s*\n\s+types: \[([^\]]*)\]/.exec(noComments(on));
  assert.ok(m, "pull_request has an explicit types list");
  const types = m[1].split(",").map((s) => s.trim());
  for (const t of ["opened", "synchronize", "reopened"]) assert.ok(types.includes(t), `${t} is missing`);
  // GitHub cannot filter `labeled` by label name: any label event would join CI's concurrency group, cancel the
  // real run and take runner time. Nor does the file's own `types` list (or any other trigger) say it.
  assert.ok(!types.includes("labeled"), "ci.yml must not listen to labeled");
  assert.doesNotMatch(noComments(on), /labeled|unlabeled/, "no label trigger of any kind in ci.yml");
  assert.match(on, /push:\s*\n\s+branches: \[main\]/);
});

// ---- the ci:full label: its own small workflow ----------------------------------------------
const labelYml = readFileSync(path.join(repoRoot, ".github/workflows/ci-full-label.yml"), "utf8");
const labelDoc = (() => {
  const py = spawnSync("python3", ["-c", "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", path.join(repoRoot, ".github/workflows/ci-full-label.yml")], { encoding: "utf8" });
  assert.equal(py.status, 0, `ci-full-label.yml does not parse as YAML: ${py.stderr}`);
  return JSON.parse(py.stdout);
})();
const ciDoc = (() => {
  const py = spawnSync("python3", ["-c", "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", path.join(repoRoot, ".github/workflows/ci.yml")], { encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  return JSON.parse(py.stdout);
})();

test("label workflow: triggers only on pull_request labeled", () => {
  const on = labelDoc.on ?? labelDoc.true;
  assert.deepEqual(Object.keys(on), ["pull_request"]);
  assert.deepEqual(on.pull_request.types, ["labeled"]);
});

test("label workflow: its one job runs only for exactly the ci:full label, and not for a fork (and stands down with CI_DISABLED)", () => {
  const jobs = Object.entries(labelDoc.jobs);
  assert.equal(jobs.length, 1);
  const [name, job] = jobs[0];
  // never a name the merge wrapper reads
  assert.ok(!["check", "workspace-e2e"].includes(name) && !job.name, `job name ${name}`);
  assert.equal(job.if, "vars.CI_DISABLED != 'true' && github.event.label.name == 'ci:full' && github.event.pull_request.head.repo.full_name == github.repository");
  // the gate is on the label NAME, an equality, not a contains() or a regex that a lookalike could pass
  assert.doesNotMatch(job.if, /contains|startsWith|endsWith|\|\|/);
  assert.equal(job["runs-on"], GUARD);
});

test("label workflow: minimal permissions, and the label name is never spliced into shell", () => {
  assert.deepEqual(labelDoc.permissions, { contents: "read" });
  assert.deepEqual(Object.values(labelDoc.jobs)[0].permissions, { contents: "read", actions: "write", "pull-requests": "read" });
  const text = noComments(labelYml);
  for (const run of text.split("\n").filter((l) => /^\s+run:/.test(l))) assert.doesNotMatch(run, /\$\{\{/, run);
  // the only secret-like input is the job's own token, and it is not read from `secrets.`
  assert.doesNotMatch(text, /secrets\./);
});

test("label workflow: its concurrency group never matches CI's, and never joins another label's", () => {
  const ciGroup = ciDoc.concurrency.group;
  const lbGroup = labelDoc.concurrency.group;
  assert.equal(ciGroup, "ci-${{ github.workflow }}-${{ github.head_ref || github.ref }}");
  assert.notEqual(lbGroup, ciGroup);
  assert.ok(lbGroup.startsWith("ci-full-label-"), lbGroup);
  assert.doesNotMatch(lbGroup, /github\.workflow|head_ref|github\.ref/, "the group must not be derived from the branch");
  // Render both groups for an ordinary PR event: they differ for every branch name and label.
  const render = (g, ctx) => g.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr) => expr.split("||").map((s) => ctx[s.trim()]).find(Boolean) ?? "");
  for (const branch of ["ci-affected-only", "ci-full-label", "ci", "x"]) {
    const ctx = { "github.workflow": "CI", "github.head_ref": branch, "github.ref": `refs/pull/7/merge`, "github.event.pull_request.number": "7", "github.event.label.name": "ci:full" };
    assert.notEqual(render(ciGroup, ctx), render(lbGroup, ctx), branch);
  }
  // ci:full has a group of its own, so another label cannot replace its waiting run
  assert.match(lbGroup, /github\.event\.label\.name/);
  assert.equal(labelDoc.concurrency["cancel-in-progress"], false);
});

test("label workflow: the step re-runs CI through the script, pinned to this repository, with the head SHA as data", () => {
  const job = Object.values(labelDoc.jobs)[0];
  const step = job.steps.find((s) => s.name === "Re-run CI at full scope");
  assert.ok(step);
  assert.match(step.run, /scripts\/ci\/rerun-ci-full\.sh$/);
  assert.equal(step.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(step.env.HEAD_SHA, "${{ github.event.pull_request.head.sha }}");
  assert.equal(step.env.PR_NUMBER, "${{ github.event.pull_request.number }}");
  assert.equal(job.steps[0].with["persist-credentials"], false);
  // the script pins the repository from GITHUB_REPOSITORY on every gh call, and the workflow it re-runs is CI's file
  const code = noComments(rerunScript);
  assert.ok(code.includes("--workflow ci.yml"));
  assert.equal((code.match(/\bgh \w+/g) ?? []).length, 5, "gh calls: pr view, list, cancel, rerun, rerun retry");
  assert.equal((code.match(/--repo "\$GITHUB_REPOSITORY"/g) ?? []).length, 5, "each one pinned");
});

// ---- the script, run for real against a fake gh that enforces what GitHub does -----------------------
const SHA = "a".repeat(40);

/**
 * Runs scripts/ci/rerun-ci-full.sh with a `gh` first on PATH. The fake keeps one run whose status changes as
 * the script acts on it, refuses `rerun` of a run that is not completed (as GitHub does), and logs every call.
 * `runs`: the statuses `gh run list` shows on successive calls (the last one repeats); null = no run.
 */
function runRerun({ runs, env = {}, head = SHA, rerunFailures = 0 }) {
  const dir = mkdtempSync(path.join(tmpdir(), "fix511_rerun-"));
  try {
    const calls = path.join(dir, "calls.log");
    const state = path.join(dir, "state");
    writeFileSync(state, "0");
    writeFileSync(path.join(dir, "rerunfail"), String(rerunFailures));
    writeFileSync(path.join(dir, "runs.json"), JSON.stringify(runs));
    writeFileSync(
      path.join(dir, "gh"),
      [
        "#!/usr/bin/env bash",
        `echo "$*" >> '${calls}'`,
        `n=$(cat '${state}')`,
        'case "$1 $2" in',
        '  "pr view")',
        ...(head === null ? ['    echo "HTTP 502" >&2; exit 1'] : [`    echo '${head}'`]),
        "    ;;",
        '  "run list")',
        `    echo $((n + 1)) > '${state}'`,
        `    node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const s = r[Math.min(Number(process.argv[2]), r.length - 1)]; console.log(s === null ? "" : "4242 " + s)' '${path.join(dir, "runs.json")}' "$n"`,
        "    ;;",
        '  "run rerun")',
        `    f='${path.join(dir, "rerunfail")}'; left=$(cat "$f")`,
        '    if [ "$left" -gt 0 ]; then echo $((left - 1)) > "$f"; echo "HTTP 500" >&2; exit 1; fi',
        `    last=$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(r[Math.min(Number(process.argv[2]) - 1, r.length - 1)])' '${path.join(dir, "runs.json")}' "$n")`,
        '    if [ "$last" != completed ]; then echo "run 4242 cannot be rerun: it is still $last" >&2; exit 1; fi',
        "    ;;",
        '  "run cancel") ;;',
        '  *) echo "unexpected gh call: $*" >&2; exit 99 ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const r = spawnSync("bash", [path.join(here, "rerun-ci-full.sh")], {
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: "t", GITHUB_REPOSITORY: "acme/widgets", HEAD_SHA: SHA, PR_NUMBER: "7", CI_FULL_RETRY_SECONDS: "0", CI_FULL_POLL_SECONDS: "0", CI_FULL_FIND_SECONDS: "0", CI_FULL_WAIT_SECONDS: "0", ...env },
    });
    const log = (() => {
      try {
        return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    })();
    return { status: r.status, out: r.stdout, err: r.stderr, log, verbs: log.map((l) => l.split(" ").slice(0, 2).join(" ")).filter((v) => v !== "run list" && v !== "pr view") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rerun script: a completed run is re-run (same run id), against this repository and CI's workflow file", () => {
  const r = runRerun({ runs: ["completed"] });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.verbs, ["run rerun"]);
  assert.ok(r.log.includes("run rerun 4242 --repo acme/widgets"));
  const list = r.log.find((l) => l.startsWith("run list"));
  assert.match(list, /--repo acme\/widgets/);
  assert.match(list, /--workflow ci\.yml/);
  assert.match(list, new RegExp(`--commit ${SHA}`));
  assert.match(list, /--event pull_request/);
});

test("rerun script: a queued run is left alone (it reads the label itself when it starts), not cancelled", () => {
  for (const status of ["queued", "waiting", "pending", "requested"]) {
    const r = runRerun({ runs: [status] });
    assert.equal(r.status, 0, `${status}: ${r.err}`);
    assert.deepEqual(r.verbs, [], status);
  }
});

test("rerun script: an in-progress run is cancelled, awaited until completed, then re-run", () => {
  const r = runRerun({ runs: ["in_progress", "in_progress", "completed"], env: { CI_FULL_WAIT_SECONDS: "10", CI_FULL_POLL_SECONDS: "1" } });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.verbs, ["run cancel", "run rerun"]);
});

test("rerun script: a run that never finishes cancelling fails loudly and is not re-run", () => {
  const r = runRerun({ runs: ["in_progress"], env: { CI_FULL_WAIT_SECONDS: "0" } });
  assert.notEqual(r.status, 0);
  assert.match(r.err, /did not finish cancelling/);
  assert.deepEqual(r.verbs, ["run cancel"]);
});

test("rerun script: with no run for the head it fails loudly instead of doing nothing", () => {
  const r = runRerun({ runs: [null] });
  assert.notEqual(r.status, 0);
  assert.match(r.err, /no CI run found/);
  assert.deepEqual(r.verbs, []);
});

test("rerun script: if the PR head has moved on since the label event, no run is cancelled or re-run", () => {
  for (const runs of [["completed"], ["in_progress", "completed"], ["queued"]]) {
    const r = runRerun({ runs, head: "b".repeat(40) });
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.log.map((l) => l.split(" ").slice(0, 2).join(" ")), ["pr view"], runs.join());
    assert.equal(r.log.filter((l) => l.startsWith("run ")).length, 0, "not even a run list");
    assert.match(r.out, /moved on/);
  }
});

test("rerun script: if the current head cannot be read, no run is touched and the job does not fail", () => {
  const r = runRerun({ runs: ["in_progress", "completed"], head: null });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.log.map((l) => l.split(" ").slice(0, 2).join(" ")), ["pr view"]);
  assert.match(r.err, /could not read the current head/);
});

test("rerun script: the head check asks the PR in this repository", () => {
  const r = runRerun({ runs: ["completed"] });
  assert.equal(r.log[0], "pr view 7 --repo acme/widgets --json headRefOid --jq .headRefOid");
});

test("rerun script: a failed re-run is retried once; a second failure fails the job loudly", () => {
  const once = runRerun({ runs: ["completed"], rerunFailures: 1 });
  assert.equal(once.status, 0, once.err);
  assert.equal(once.verbs.filter((v) => v === "run rerun").length, 2);
  const twice = runRerun({ runs: ["in_progress", "completed"], rerunFailures: 2, env: { CI_FULL_WAIT_SECONDS: "10", CI_FULL_POLL_SECONDS: "1" } });
  assert.notEqual(twice.status, 0);
  assert.match(twice.err, /failed twice/);
  assert.equal(twice.verbs.filter((v) => v === "run rerun").length, 2, "exactly one retry");
});

test("rerun script: a missing token, repository or a malformed SHA is refused before any gh call", () => {
  for (const env of [{ GH_TOKEN: "" }, { GITHUB_REPOSITORY: "" }, { GITHUB_REPOSITORY: "a b/c" }, { HEAD_SHA: "main" }, { HEAD_SHA: `${SHA};x` }, { PR_NUMBER: "" }, { PR_NUMBER: "7/x" }]) {
    const r = runRerun({ runs: ["completed"], env });
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.deepEqual(r.log, [], JSON.stringify(env));
  }
});

test("ci.yml: the token stays read-only (top level contents read; jobs add at most pull-requests read; nothing that writes)", () => {
  assert.deepEqual(ciDoc.permissions, { contents: "read" });
  for (const [name, job] of Object.entries(ciDoc.jobs)) {
    if (name === "pr-gates") assert.equal(job.permissions, undefined, "pr-gates takes the top-level token as it is");
    else assert.deepEqual(job.permissions, { contents: "read", "pull-requests": "read" }, name);
  }
});

test("label workflow: no plain scalar value contains a colon and a space", () => {
  noComments(labelYml).split("\n").forEach((line, i) => {
    const m = /^\s*(?:- )?[A-Za-z_-]+:\s+(\S.*)$/.exec(line);
    if (!m) return;
    const value = m[1];
    if (/^["'|>\[{]/.test(value) || value.startsWith("${{")) return;
    assert.ok(!/: |:$/.test(value.replace(/\$\{\{.*?\}\}/g, "").replace(/'[^']*'/g, "")), `line ${i + 1}: ${line.trim()}`);
  });
});

// ---- the scope steps read the label from the API, not the payload ----------------------------------
test("ci.yml: no step passes the event payload's labels to the classifier", () => {
  assert.doesNotMatch(noComments(ci), /pull_request\.labels/, "the payload label list is stale on a re-run");
  assert.doesNotMatch(noComments(ci), /CI_PR_LABELS|--labels "/);
});

// ---- the check job -----------------------------------------------------------
const CLASSIFIER = /node scripts\/ci\/affected\.mjs --base HEAD\^1 --head HEAD --force-full "\$CI_FORCE_FULL" --labels-api --github/;

// The label is read from the API with a read-only token, as data in the environment; the event payload's
// label list is never used (a re-run replays it stale).
function assertReadsLabelsFromApi(text) {
  assert.match(text, /CI_PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(text, /pull_request\.labels|CI_PR_LABELS/);
}

test("check job: a pull-request-only step runs the classifier on HEAD^1..HEAD with both kill-switch inputs", () => {
  const s = stepNamed(checkSteps, "CI scope");
  assert.equal(ifOf(s), "github.event_name == 'pull_request'");
  assert.match(s.text, CLASSIFIER);
  assert.match(s.text, /CI_FORCE_FULL: \$\{\{ vars\.CI_FORCE_FULL \}\}/);
  assertReadsLabelsFromApi(s.text);
  // the labels reach the script as data: never spliced into the shell text
  assert.doesNotMatch(s.text.split("run:")[1], /\$\{\{/);
  assert.match(checkJob, /fetch-depth: 2/);
});

test("check job: the classifier runs before the checks and after the unconditional safety steps", () => {
  const idx = (n) => checkSteps.findIndex((s) => s.name === n);
  assert.ok(idx("Secret scan of the change") < idx("CI scope"));
  assert.ok(idx("Migration compatibility lint") < idx("CI scope"));
  assert.ok(idx("CI scope") < idx("Run checks"));
});

test("check job: the secret scan, the migration lint and its tests have no if:", () => {
  for (const name of ["Secret scan of the change", "Migration compatibility lint", "Migration lint and secret scan tests"]) {
    assert.equal(ifOf(stepNamed(checkSteps, name)), null, `${name} has an if:`);
    assert.doesNotMatch(stepNamed(checkSteps, name).text, /continue-on-error/);
  }
});

test("check job: the scope tests run in the same step as the migration lint tests", () => {
  const run = stepNamed(checkSteps, "Migration lint and secret scan tests").text;
  for (const f of ["check-migration-compat.test.mjs", "affected.test.mjs", "ci-workflow.test.mjs"]) assert.ok(run.includes(f), f);
});

test("push to main: the classifier is not consulted and check.sh runs with no affected list", () => {
  assert.equal(ifOf(stepNamed(checkSteps, "CI scope")), "github.event_name == 'pull_request'");
  const push = stepNamed(checkSteps, "CI scope (push to main)");
  assert.equal(ifOf(push), "github.event_name != 'pull_request'");
  assert.match(push.text, /CI scope: full \(push to main\)/);
  assert.doesNotMatch(push.text, /affected\.mjs/);
  const run = stepNamed(checkSteps, "Run checks");
  assert.match(run.text, /if \[ "\$GITHUB_EVENT_NAME" != pull_request \]; then unset FX_CHECK_AFFECTED; fi\n\s+nix develop \.#ci --command bash scripts\/check\.sh/);
  assert.doesNotMatch(run.text.split("env:")[1]?.split("run:")[0] ?? "", /FX_CHECK_AFFECTED/, "not set from the step's own env");
  assert.equal(ifOf(run), null, "the checks always run");
  // the only mention of the classifier in the job is the pull-request step
  assert.equal(checkSteps.filter((s) => /affected\.mjs/.test(s.text.replace(/node --test.*/g, ""))).length, 1);
});

test("check job: the Node 22 runner-protocol step runs on push and when the package is affected", () => {
  const s = stepNamed(checkSteps, "Runner protocol tests on Node 22");
  assert.equal(ifOf(s), "github.event_name != 'pull_request' || env.CI_SCOPE_RUNNER_PROTOCOL != 'false'");
});

test("check job: nothing is narrowed outside Run checks and the Node 22 step", () => {
  const guarded = checkSteps.filter((s) => ifOf(s) !== null).map((s) => s.name).sort();
  assert.deepEqual(guarded, [
    "CI scope",
    "CI scope (push to main)",
    "Install Nix (hosted)",
    "Allow Chromium's user-namespace sandbox (hosted)",
    "Nix store cache (hosted)",
    "Runner protocol tests on Node 22",
    "pnpm store cache (hosted)",
  ].sort());
});

// ---- the e2e job -----------------------------------------------------------
test("e2e job: the job-level if (pull requests only, any head repo, CI_DISABLED stands it down) and the matrix", () => {
  const head = e2eJob.slice(0, e2eJob.indexOf("\n    steps:"));
  assert.match(head, /\n    name: workspace-e2e \(\$\{\{ matrix\.project \}\}\)\n/);
  assert.match(head, /\n    if: vars\.CI_DISABLED != 'true' && github\.event_name == 'pull_request'\n/);
  assert.match(head, /\n        project: \[desktop, phone, tablet\](\n|$)/);
  assert.match(head, /\n      fail-fast: false\n/);
});

test("e2e job: the skip is not a job-level if", () => {
  const head = noComments(e2eJob.slice(0, e2eJob.indexOf("\n    steps:")));
  const jobIfs = head.split("\n").filter((l) => /^ {4}if:/.test(l));
  assert.equal(jobIfs.length, 1);
  assert.doesNotMatch(jobIfs[0], /CI_SCOPE|affected|e2e/i, "the job-level if must not depend on the scope");
  assert.doesNotMatch(head, /\n {4}needs:/, "the job must not wait on another job: a skipped dependency skips it by name");
});

test("e2e job: the first step after checkout (and the hosted-only Nix install) runs the classifier and prints the skip line", () => {
  assert.match(e2eSteps[0].text, /actions\/checkout@v4/);
  assert.match(e2eSteps[0].text, /fetch-depth: 2/);
  const rest = e2eSteps.slice(1);
  const first = rest.find((s) => !/\(hosted\)$/.test(s.name));
  assert.equal(first.name, "E2E scope (${{ matrix.project }})");
  assert.match(first.text, CLASSIFIER);
  assert.match(first.text, /--e2e-step/);
  assert.match(first.text, /CI_FORCE_FULL: \$\{\{ vars\.CI_FORCE_FULL \}\}/);
  assertReadsLabelsFromApi(first.text);
  assert.equal(ifOf(first), null, "the scope step itself always runs");
  // only the Nix install (needed to run the step on a hosted runner) may come before it
  const before = rest.slice(0, rest.indexOf(first));
  assert.deepEqual(before.map((s) => s.name), ["Install Nix (hosted)"]);
  assert.equal(ifOf(before[0]), EPHEMERAL);
});

test("e2e job: every step after the scope step is guarded on the scope answer", () => {
  const at = e2eSteps.findIndex((s) => s.name === "E2E scope (${{ matrix.project }})");
  const later = e2eSteps.slice(at + 1);
  assert.ok(later.length >= 4);
  for (const s of later) {
    assert.match(ifOf(s) ?? "", /env\.CI_SCOPE_E2E == 'true'/, `${s.name} is not guarded`);
  }
  assert.match(ifOf(stepNamed(e2eSteps, "Run workspace e2e (${{ matrix.project }})")), /^env\.CI_SCOPE_E2E == 'true'$/);
  assert.match(ifOf(stepNamed(e2eSteps, "Pick free e2e ports (${{ matrix.project }})")), /^env\.CI_SCOPE_E2E == 'true'$/);
  // Only the Nix store cache may be continue-on-error: a cache problem must never fail CI.
  for (const s of e2eSteps.filter((x) => !isNixCache(x))) assert.doesNotMatch(s.text, /continue-on-error/, s.name);
});


// ---- the runner end-to-end job (D#6 R4d-6) -------------------------------------
test("e2e-runner job: runs on every pull request and push (only CI_DISABLED stands it down), never narrowed by the scope classifier, and waits on no other job", () => {
  const job = ciDoc.jobs["e2e-runner"];
  assert.equal(job.if, "vars.CI_DISABLED != 'true'");
  assert.equal(job["runs-on"], GUARD);
  assert.deepEqual(job.permissions, { contents: "read", "pull-requests": "read" });
  assert.equal(job.needs, undefined);
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 60);
  const text = noComments(runnerE2eJob);
  assert.doesNotMatch(text, /CI_SCOPE|affected\.mjs/, "the job must not depend on the scope classifier");
  assert.doesNotMatch(text, /secrets\./);
});

test("e2e-runner job: no model call and no secret: the workflow forbids model calls, and the one run step is the package script under the ci shell", () => {
  assert.equal(ciDoc.env.FX_FORBID_MODEL_CALLS, "1");
  const steps = runnerE2eSteps;
  assert.equal(steps[0].text.includes("actions/checkout@v4"), true);
  assert.match(steps[0].text, /persist-credentials: false/);
  const run = stepNamed(steps, "Run the end-to-end runner test");
  assert.equal(ifOf(run), null, "the test step always runs");
  assert.doesNotMatch(run.text, /continue-on-error/);
  assert.match(run.text, /\n {8}run: nix develop \.#ci --command bash -euo pipefail -c 'pnpm install --frozen-lockfile && pnpm test:e2e-runner'\n?$/);
  assert.equal(steps[steps.length - 1].name, run.name, "nothing runs after the test, so its result is the job's");
});

test("e2e-runner job: the hosted setup is the check job's: gated on an ephemeral runner, each step with a short timeout, only the Nix store cache may fail softly", () => {
  const hosted = installers(runnerE2eSteps);
  assert.deepEqual(hosted.map((s) => s.name), ["Install Nix (hosted)", "Nix store cache (hosted)", "pnpm store cache (hosted)"]);
  assert.equal(ifOf(hosted[0]), EPHEMERAL);
  assert.equal(ifOf(hosted[2]), EPHEMERAL);
  assert.match(ifOf(hosted[1]), /^runner\.environment == 'github-hosted' && !startsWith\(vars\.CI_RUNS_ON, 'ubicloud'\)$/);
  for (const s of hosted) {
    const t = Number((/^ {8}timeout-minutes: (\d+)$/m.exec(s.text) ?? [])[1]);
    assert.ok(Number.isInteger(t) && t > 0 && t <= 10, `${s.name}: timeout-minutes ${t}`);
    assert.equal(/continue-on-error/.test(s.text), isNixCache(s), s.name);
  }
  // the same steps, word for word, as the check job's (same pinned actions)
  for (const name of ["Install Nix (hosted)", "Nix store cache (hosted)", "pnpm store cache (hosted)"]) {
    assert.equal(stepNamed(runnerE2eSteps, name).text.trim(), stepNamed(checkSteps, name).text.trim(), name);
  }
});

test("e2e-runner job: the ordinary vitest run leaves the end-to-end test out, and the package script, with its own config, is the only way in", () => {
  const config = readFileSync(path.join(repoRoot, "packages/worker/vitest.config.ts"), "utf8");
  assert.match(config, /\n {4}exclude: \[\.\.\.configDefaults\.exclude, "test\/e2e\/\*\*"\],\n/);
  const e2eConfig = readFileSync(path.join(repoRoot, "packages/worker/vitest.e2e.config.ts"), "utf8");
  assert.match(e2eConfig, /include: \["test\/e2e\/\*\*\/\*\.test\.ts"\]/);
  assert.match(e2eConfig, /setupFiles: \["\.\.\/test-guard\/src\/setup\.ts"/, "the model-call guard stays wired in");
  const workerPkg = JSON.parse(readFileSync(path.join(repoRoot, "packages/worker/package.json"), "utf8"));
  assert.match(workerPkg.scripts["test:e2e-runner"], /FX_FORBID_MODEL_CALLS=1 vitest run --config vitest\.e2e\.config\.ts$/);
  assert.match(workerPkg.scripts["test:e2e-runner"], /-u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN/);
  const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(rootPkg.scripts["test:e2e-runner"], "pnpm --filter @fx/worker run test:e2e-runner");
});

// ---- hosted setup gating (GitHub-hosted and Ubicloud) ---------------------------
/** Evaluate a step's `if:` for the hosted-gate subset: env.CI_SCOPE_E2E, runner.environment, vars.CI_RUNS_ON. */
function evalIf(expr, { runnerEnv, runsOn, scope = "true" }) {
  if (expr === null) return true;
  const js = expr
    .replace(/!startsWith\(vars\.CI_RUNS_ON, 'ubicloud'\)/g, () => String(!runsOn.startsWith("ubicloud")))
    .replace(/runner\.environment/g, JSON.stringify(runnerEnv))
    .replace(/vars\.CI_RUNS_ON/g, JSON.stringify(runsOn))
    .replace(/env\.CI_SCOPE_E2E/g, JSON.stringify(scope));
  assert.match(js, /^[\s"'a-z0-9_=!&|()-]*$/i, `unexpected syntax in if: ${expr}`);
  return Function(`return (${js.replace(/ == /g, " === ").replace(/ != /g, " !== ")})`)();
}
const installers = (steps) => steps.filter((s) => /\(hosted\)$/.test(s.name));
const isNixCache = (s) => s.name === "Nix store cache (hosted)";
const gated = (steps) => installers(steps).filter((s) => /runner\.environment/.test(ifOf(s) ?? ""));

test("hosted setup: with CI_RUNS_ON unset, the owner's machine runs no installer", () => {
  for (const steps of [checkSteps, e2eSteps]) {
    assert.ok(gated(steps).length >= 3);
    for (const s of installers(steps)) {
      assert.equal(evalIf(ifOf(s), { runnerEnv: "self-hosted", runsOn: "" }), false, s.name);
    }
  }
});

test("hosted setup: with CI_RUNS_ON set (Ubicloud, self-hosted environment) Nix installs and the Nix store cache does not run", () => {
  for (const runsOn of ["ubicloud-standard-2", "ubuntu-latest"]) {
    for (const steps of [checkSteps, e2eSteps]) {
      for (const s of installers(steps)) {
        // magic-nix-cache hangs against Ubicloud's replacement cache service: it must not run there.
        const want = !isNixCache(s);
        assert.equal(evalIf(ifOf(s), { runnerEnv: "self-hosted", runsOn }), want, `${s.name} on ${runsOn}`);
      }
    }
  }
});

test("Nix store cache: Ubicloud reporting github-hosted still skips it; unset runs it; it is continue-on-error", () => {
  for (const steps of [checkSteps, e2eSteps]) {
    const cache = installers(steps).find(isNixCache);
    assert.equal(evalIf(ifOf(cache), { runnerEnv: "github-hosted", runsOn: "ubicloud-standard-2" }), false);
    assert.equal(evalIf(ifOf(cache), { runnerEnv: "github-hosted", runsOn: "" }), true);
    assert.equal(evalIf(ifOf(cache), { runnerEnv: "self-hosted", runsOn: "" }), false);
    assert.match(cache.text, /^ {8}continue-on-error: true$/m);
  }
});

test("hosted setup: CI_RUNS_ON=self-hosted names the owner's machine, so no installer runs there either", () => {
  for (const steps of [checkSteps, e2eSteps]) {
    for (const s of installers(steps)) {
      assert.equal(evalIf(ifOf(s), { runnerEnv: "self-hosted", runsOn: "self-hosted" }), false, s.name);
    }
  }
});

test("hosted setup: a GitHub-hosted runner still runs the installers, and e2e ones stay scope-guarded", () => {
  for (const steps of [checkSteps, e2eSteps]) {
    for (const s of installers(steps)) {
      assert.equal(evalIf(ifOf(s), { runnerEnv: "github-hosted", runsOn: "" }), true, s.name);
    }
  }
  for (const s of installers(e2eSteps).filter((x) => x.name !== "Install Nix (hosted)")) {
    assert.equal(evalIf(ifOf(s), { runnerEnv: "self-hosted", runsOn: "ubicloud-standard-2", scope: "false" }), false, s.name);
  }
});

test("hosted setup: every hosted step has a timeout-minutes, so a hang cannot burn the budget", () => {
  for (const steps of [checkSteps, e2eSteps]) {
    assert.ok(installers(steps).length >= 4);
    for (const s of installers(steps)) {
      const t = Number((/^ {8}timeout-minutes: (\d+)$/m.exec(s.text) ?? [])[1]);
      assert.ok(Number.isInteger(t) && t > 0 && t <= 10, `${s.name}: timeout-minutes ${t}`);
    }
  }
  assert.ok(installers(checkSteps).some(isNixCache) && installers(e2eSteps).some(isNixCache));
});

// ---- scripts/check.sh --------------------------------------------------------
const TODAY = [
  "pnpm install",
  "declared cross-package imports",
  "pnpm lint",
  "pnpm typecheck",
  "scripts/check-globalsetup-env.sh",
  "scripts/check-agent-run-columns.sh",
  "pnpm test",
  "sitekit-checks browser tier",
  "packages/db neon-shape migrations",
  "packages/db migration order",
  "pnpm --filter web build",
  "apps/web next-server trace check",
  "apps/web baked build-path check",
  "pnpm test:guard",
];

function checkSh(env) {
  const clean = { ...process.env };
  for (const k of ["FX_CHECK_AFFECTED", "FX_CHECK_DRY_RUN", "FX_BROWSER_TIER", "GITHUB_EVENT_NAME"]) delete clean[k];
  delete clean.FX_CHECK_LINT_PATHS;
  const r = spawnSync("bash", ["scripts/check.sh"], { cwd: repoRoot, encoding: "utf8", env: { ...clean, FX_CHECK_DRY_RUN: "1", PLAYWRIGHT_BROWSERS_PATH: "/x", ...env } });
  const lines = r.stdout.split("\n");
  return { status: r.status, out: r.stdout, err: r.stderr, headers: lines.filter((l) => l.startsWith("==> ")), lines };
}
const headerNames = (r) => r.headers.map((h) => h.slice(4).replace(/ -- skipped.*$/, "").replace(/ \(affected [a-z]+\)$/, ""));

test("check.sh with nothing set prints every step header it printed before, in order", () => {
  const r = checkSh({});
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.headers, TODAY.map((h) => `==> ${h}`));
  assert.ok(r.lines.includes("(dry run) pnpm lint"));
  assert.ok(r.lines.includes("(dry run) pnpm typecheck"));
  assert.ok(r.lines.some((l) => /^\(dry run\) env -u ANTHROPIC_API_KEY .* pnpm test$/.test(l)));
  assert.doesNotMatch(r.out, /affected mode/);
});

test("an empty FX_CHECK_AFFECTED is a full run: a variable that failed to populate must widen", () => {
  const r = checkSh({ FX_CHECK_AFFECTED: "" });
  assert.deepEqual(r.headers, TODAY.map((h) => `==> ${h}`));
});

test("check.sh in affected mode narrows lint, typecheck and tests to the listed packages", () => {
  const r = checkSh({ FX_CHECK_AFFECTED: "packages/env-spec,packages/env-build" });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.lines.includes("(dry run) pnpm exec eslint packages/env-spec packages/env-build"));
  assert.ok(r.lines.includes("(dry run) pnpm --filter ./packages/env-spec --filter ./packages/env-build --if-present run typecheck"));
  assert.ok(r.headers.includes("==> pnpm lint (affected packages)"));
  assert.ok(r.headers.includes("==> pnpm typecheck (affected packages)"));
  assert.ok(r.headers.includes("==> pnpm test (affected projects)"));
  // every step is still accounted for, run or visibly skipped
  assert.deepEqual(headerNames(r), TODAY);
  assert.equal(r.headers.length, TODAY.length);
});

test("check.sh in affected mode runs the web build only when apps/web is affected", () => {
  const without = checkSh({ FX_CHECK_AFFECTED: "packages/env-spec" });
  for (const h of ["pnpm --filter web build", "apps/web next-server trace check", "apps/web baked build-path check"]) {
    assert.ok(without.headers.includes(`==> ${h} -- skipped, apps/web not affected`), h);
  }
  assert.ok(!without.out.includes("(dry run) pnpm --filter web build"));
  const withWeb = checkSh({ FX_CHECK_AFFECTED: "packages/env-spec,apps/web" });
  for (const h of ["pnpm --filter web build", "apps/web next-server trace check", "apps/web baked build-path check"]) {
    assert.ok(withWeb.headers.includes(`==> ${h}`), h);
  }
});

test("check.sh in affected mode runs the browser tier only when sitekit-checks is affected, the neon-shape test only for db", () => {
  const without = checkSh({ FX_CHECK_AFFECTED: "packages/env-spec" });
  assert.match(without.out, /SKIPPED browser tier: packages\/sitekit-checks is not affected/);
  assert.ok(!without.out.includes("test:browser"));
  assert.ok(without.headers.includes("==> packages/db neon-shape migrations -- skipped, packages/db not affected"));
  const withBoth = checkSh({ FX_CHECK_AFFECTED: "packages/sitekit-checks,packages/db" });
  assert.ok(withBoth.out.includes("(dry run) pnpm --filter @fx/sitekit-checks test:browser"));
  assert.ok(withBoth.headers.includes("==> packages/db neon-shape migrations"));
});

test("check.sh in affected mode still runs the cheap guards, always", () => {
  for (const affected of ["packages/env-spec", "none"]) {
    const r = checkSh({ FX_CHECK_AFFECTED: affected });
    for (const h of ["pnpm install", "declared cross-package imports", "scripts/check-globalsetup-env.sh", "packages/db migration order", "pnpm test:guard"]) {
      assert.ok(r.headers.includes(`==> ${h}`), `${h} (${affected})`);
    }
    assert.ok(r.out.includes("(dry run) bash packages/db/scripts/check-migration-order.sh"));
    assert.ok(r.out.includes("(dry run) pnpm test:guard"));
  }
});

test("check.sh with `none` runs no lint, typecheck or tests and says so", () => {
  const r = checkSh({ FX_CHECK_AFFECTED: "none" });
  assert.equal(r.status, 0, r.err);
  for (const h of ["pnpm lint", "pnpm typecheck", "pnpm test"]) assert.ok(r.headers.includes(`==> ${h} -- skipped, no affected package`), h);
  assert.ok(!r.out.includes("eslint"));
});

test("check.sh refuses the browser-tier skip on pull_request, in both modes", () => {
  for (const affected of [undefined, "packages/env-spec"]) {
    const r = checkSh({ FX_BROWSER_TIER: "skip", GITHUB_EVENT_NAME: "pull_request", ...(affected ? { FX_CHECK_AFFECTED: affected } : {}) });
    assert.equal(r.status, 1, `${affected}`);
    assert.match(r.err, /FX_BROWSER_TIER=skip is not allowed on pull_request runs/);
  }
});

// ---- the shapes the content rules of the classifier rely on ------------------
// scripts/ci/affected.mjs reads ci.yml by content (ciWorkflowEffect): an edit confined to the node-test step's
// run line is exempt, an edit confined to the check job is not an e2e trigger. Both depend on the file keeping
// this shape, and both fail safe (full run, e2e on) when it does not, so a drift costs CI time, not coverage.
// This test makes the drift visible instead.
test("the classifier's content rules still find what they look for in ci.yml", async () => {
  const { ciWorkflowEffect, loadTriggers } = await import("./affected.mjs");
  const cw = loadTriggers().ci_workflow;
  assert.equal(cw.file, ".github/workflows/ci.yml");
  const step = checkSteps.filter((s) => s.name === cw.test_step);
  assert.equal(step.length, 1, `exactly one step named "${cw.test_step}"`);
  assert.match(step[0].text, /\n {8}run: nix develop .#ci --command node --test( [A-Za-z0-9_./-]+\.test\.mjs)+\s*$/);
  assert.match(ci, new RegExp(`\\n  ${cw.unit_job}:\\n`));
  assert.match(ci, /\n {2}workspace-e2e:\n/);
  // the e2e job does not read anything the check job produces
  assert.doesNotMatch(noComments(e2eJob), /needs:/);
  // required checks: the e2e job still reports under its real names, because it never skips at job level (above)
  // end to end, on a scratch repository holding this very file
  const dir = mkdtempSync(path.join(tmpdir(), "d507c-ci-"));
  try {
    const run = (...args) => spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
    run("init", "-q", "-b", "main");
    run("config", "commit.gpgsign", "false");
    const put = (text) => {
      const f = path.join(dir, ".github/workflows/ci.yml");
      spawnSync("mkdir", ["-p", path.dirname(f)]);
      writeFileSync(f, text);
      run("add", "-A");
      run("commit", "-q", "-m", "c");
      return run("rev-parse", "HEAD").stdout.trim();
    };
    const base = put(ci);
    const head = put(ci.replace(/^( {8}run: nix develop .#ci --command node --test .*)$/m, "$1 scripts/ci/new.test.mjs"));
    assert.deepEqual(ciWorkflowEffect(dir, base, head, cw), { exempt: true, e2e: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- standalone CI tests are linted in an affected run -----------------------
test("check.sh: FX_CHECK_LINT_PATHS adds paths to the affected lint, and alone it turns the lint on", () => {
  const withPkg = checkSh({ FX_CHECK_AFFECTED: "packages/env-spec", FX_CHECK_LINT_PATHS: "scripts/ci" });
  assert.equal(withPkg.status, 0, withPkg.err);
  assert.ok(withPkg.lines.includes("(dry run) pnpm exec eslint packages/env-spec scripts/ci"), withPkg.out);
  const alone = checkSh({ FX_CHECK_AFFECTED: "none", FX_CHECK_LINT_PATHS: "scripts/ci" });
  assert.equal(alone.status, 0, alone.err);
  assert.ok(alone.lines.includes("(dry run) pnpm exec eslint scripts/ci"), alone.out);
  // unset: unchanged
  assert.ok(checkSh({ FX_CHECK_AFFECTED: "packages/env-spec" }).lines.includes("(dry run) pnpm exec eslint packages/env-spec"));
  assert.ok(checkSh({ FX_CHECK_AFFECTED: "none" }).out.includes("pnpm lint -- skipped, no affected package"));
});

test("the classifier asks for scripts/ci to be linted exactly when a standalone test changed, and the environment file carries it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "d507c-lint-"));
  const envFile = path.join(tmpdir(), `d507c-env-${process.pid}`);
  try {
    const vcs = (...a) => spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
    vcs("init", "-q", "-b", "main");
    mkdirSync(path.join(dir, "packages/a"), { recursive: true });
    writeFileSync(path.join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    writeFileSync(path.join(dir, "packages/a/package.json"), '{"name":"a"}\n');
    vcs("add", "-A");
    vcs("commit", "-q", "-m", "base");
    const base = vcs("rev-parse", "HEAD").stdout.trim();
    mkdirSync(path.join(dir, "scripts/ci"), { recursive: true });
    writeFileSync(path.join(dir, "scripts/ci/new.test.mjs"), "// x\n");
    vcs("add", "-A");
    vcs("commit", "-q", "-m", "c");
    const head = vcs("rev-parse", "HEAD").stdout.trim();
    writeFileSync(envFile, "");
    // the scratch workspace has one package, so the real extra edges (which name real packages) are dropped
    const triggers = path.join(dir, "..", `d507c-triggers-${process.pid}.json`);
    writeFileSync(triggers, JSON.stringify({ ...JSON.parse(readFileSync(path.join(here, "full-run-triggers.json"), "utf8")), extra_edges: [] }));
    const r = spawnSync(process.execPath, [path.join(here, "affected.mjs"), "--repo", dir, "--base", base, "--head", head, "--triggers", triggers, "--github"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ENV: envFile },
    });
    const out = JSON.parse(r.stdout);
    assert.equal(out.mode, "affected");
    assert.deepEqual(out.lint, ["scripts/ci"]);
    const env = readFileSync(envFile, "utf8");
    assert.match(env, /^FX_CHECK_AFFECTED=none$/m);
    assert.match(env, /^FX_CHECK_LINT_PATHS=scripts\/ci$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(envFile, { force: true });
    rmSync(path.join(dir, "..", `d507c-triggers-${process.pid}.json`), { force: true });
  }
});

test("eslint does not lint archive/** (archived material is not maintained)", async () => {
  // Read as text: this step runs before `pnpm install`, so no npm package can be imported here.
  const config = readFileSync(path.join(repoRoot, "eslint.config.mjs"), "utf8");
  const ignores = /\n {4}ignores: \[([\s\S]*?)\n {4}\],/.exec(config)?.[1] ?? "";
  const entries = ignores.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.match(entries, /^\s*"archive\/\*\*",\s*$/m, "archive/** must be in the global ignores array");
  assert.doesNotMatch(entries, /"!archive/);
});

test("every nix develop in the workflow enters the lean ci shell (D#507)", () => {
  const uses = noComments(ci).match(/nix develop[^\n]*/g) ?? [];
  assert.ok(uses.length >= 7, `expected the workflow's nix develop calls, found ${uses.length}`);
  for (const u of uses) assert.match(u, /^nix develop \.#ci --command /, u);
});

test("flake: the ci shell shares its packages with default and has only python3 plus pyyaml, actionlint, dash and shellcheck (no pythonEnv, anthropic, fastapi, sqlite or duckdb)", () => {
  const flake = readFileSync(path.join(repoRoot, "flake.nix"), "utf8");
  const ciShell = /\bci = pkgs\.mkShell \{([\s\S]*?)\n      \};/.exec(flake)?.[1];
  assert.ok(ciShell, "no ci shell in flake.nix");
  assert.match(ciShell, /packages = sharedPackages \+\+ \[ \(pkgs\.python312\.withPackages \(ps: \[ ps\.pyyaml \]\)\) pkgs\.actionlint pkgs\.dash pkgs\.shellcheck \];/);
  assert.doesNotMatch(ciShell.replace(/^\s*#.*$/gm, ""), /pythonEnv|python312Override|anthropic|fastapi|sqlite|duckdb/);
  const defaultShell = /\bdefault = pkgs\.mkShell \{([\s\S]*?)\n        shellHook/.exec(flake)?.[1] ?? "";
  assert.match(defaultShell, /sharedPackages \+\+/);
  assert.match(defaultShell, /pythonEnv/);
});

test("flake: PLAYWRIGHT_BROWSERS_PATH is a real mkShell attribute in both shells, so nix print-dev-env lists it, and is not exported from shellHook", () => {
  const flake = readFileSync(path.join(repoRoot, "flake.nix"), "utf8");
  const code = flake.replace(/^\s*#.*$/gm, "");
  const attrs = code.match(/^\s+PLAYWRIGHT_BROWSERS_PATH = "\$\{playwrightBrowsers\}";$/gm) ?? [];
  assert.equal(attrs.length, 2, "one attribute in the ci shell and one in the default shell");
  assert.doesNotMatch(code, /export PLAYWRIGHT_BROWSERS_PATH/);
});

// =================================================================================================
// D#536 P6: CI on a public repository.
//
// A public repository gets free GitHub-hosted runners, and must never reach the owner's self-hosted one: not
// through CI_RUNS_ON, not from a fork pull request, not through a second workflow. These tests read every file
// in .github/workflows, evaluate the `runs-on` and `if:` expressions with GitHub's own `&&` / `||` / `==`
// semantics (not a string match), and run the two public-plane gate scripts on fixture inputs.
// No npm packages: this file runs before `pnpm install`. Python with PyYAML (the dev shell has it) parses YAML.
// =================================================================================================
import { copyFileSync, existsSync, readdirSync } from "node:fs";

function parseYamlText(text) {
  const py = spawnSync("python3", ["-c", "import sys, json, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))"], { input: text, encoding: "utf8" });
  assert.equal(py.status, 0, `YAML did not parse (or PyYAML is missing from the dev shell): ${py.stderr}`);
  return JSON.parse(py.stdout);
}
const triggersOf = (doc) => doc.on ?? doc.true; // YAML 1.1 reads the key `on` as the boolean true
const WORKFLOW_DIR = path.join(repoRoot, ".github/workflows");
const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .map((file) => {
    const text = readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
    return { file, text, doc: parseYamlText(text) };
  });
const jobsOf = (doc) => Object.entries(doc.jobs ?? {});

// ---- an evaluator for the subset of GitHub expressions these workflows use ----------------------------------
// Values: string, boolean, null. `a && b` is a when a is falsy, else b; `a || b` is a when a is truthy, else b
// (so `false && x` is `false`, and `'' || 'y'` is `'y'`). Falsy: false, null, '', 0, NaN. `==` / `!=` compare
// strings case-insensitively and coerce mixed types to numbers, as GitHub does. Anything else (a function
// call, a matrix context, an unknown context name) throws, so an expression this file does not understand
// can never be taken for a safe one.
function evalExpr(src, ctx) {
  const toks = [];
  const re = /\s*(?:('(?:[^']|'')*')|(&&|\|\||==|!=|[()!])|([A-Za-z_][A-Za-z0-9_.-]*))/y;
  let pos = 0;
  while (pos < src.length && src.slice(pos).trim() !== "") {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error(`unsupported expression syntax at "${src.slice(pos)}" in: ${src}`);
    pos = re.lastIndex;
    if (m[1] !== undefined) toks.push({ t: "val", v: m[1].slice(1, -1).replace(/''/g, "'") });
    else if (m[2] !== undefined) toks.push({ t: "op", v: m[2] });
    else if (m[3] === "true" || m[3] === "false") toks.push({ t: "val", v: m[3] === "true" });
    else if (m[3] === "null") toks.push({ t: "val", v: null });
    else toks.push({ t: "ctx", v: m[3] });
  }
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  const truthy = (v) => !(v === false || v === null || v === "" || v === 0 || Number.isNaN(v));
  const num = (v) => (v === null ? 0 : typeof v === "boolean" ? Number(v) : v === "" ? 0 : Number(v));
  const eq = (a, b) => {
    if (typeof a === typeof b) return typeof a === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
    return num(a) === num(b);
  };
  function primary() {
    const t = take();
    if (!t) throw new Error(`unexpected end of expression: ${src}`);
    if (t.t === "val") return t.v;
    if (t.t === "ctx") {
      if (!(t.v in ctx)) throw new Error(`unsupported context "${t.v}" in: ${src}`);
      return ctx[t.v];
    }
    if (t.v === "(") {
      const v = or();
      if (take()?.v !== ")") throw new Error(`missing ) in: ${src}`);
      return v;
    }
    if (t.v === "!") return !truthy(primary());
    throw new Error(`unexpected "${t.v}" in: ${src}`);
  }
  function equality() {
    let l = primary();
    while (peek()?.t === "op" && (peek().v === "==" || peek().v === "!=")) {
      const op = take().v;
      const r = primary();
      l = op === "==" ? eq(l, r) : !eq(l, r);
    }
    return l;
  }
  function and() {
    let l = equality();
    while (peek()?.t === "op" && peek().v === "&&") {
      take();
      const r = equality();
      l = truthy(l) ? r : l;
    }
    return l;
  }
  function or() {
    let l = and();
    while (peek()?.t === "op" && peek().v === "||") {
      take();
      const r = and();
      l = truthy(l) ? l : r;
    }
    return l;
  }
  const v = or();
  if (i !== toks.length) throw new Error(`trailing tokens in: ${src}`);
  return v;
}
const unwrap = (s) => (/^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(String(s).trim()) ?? [, null])[1];

// ---- the runner guard ------------------------------------------------------------------------------------
const HOSTED_LABEL = /^(ubuntu|macos|windows)-[A-Za-z0-9._-]+$/;
/** null when this `runs-on` value is allowed in a public repository's workflow, else the reason it is not. */
function judgeRunsOn(value) {
  if (typeof value !== "string") return `runs-on is not a plain string (${JSON.stringify(value)}): a list, mapping or group could name a self-hosted runner`;
  if (value === GUARD) return null;
  if (HOSTED_LABEL.test(value)) return null;
  return `runs-on ${JSON.stringify(value)} is neither the guarded expression nor a literal ubuntu-*, macos-* or windows-* label`;
}
/**
 * The literal runs-on values a job can have: its own, or, for exactly `${{ matrix.runner }}`, the `runner` of every entry in the
 * matrix's `include` list (a release matrix of four hosted platforms). A missing or non-literal entry stays an unreadable value, so
 * `judgeRunsOn` rejects it; any other matrix expression is still rejected as before.
 */
function runsOnValues(job) {
  if (unwrap(job["runs-on"]) !== "matrix.runner") return [job["runs-on"]];
  // Only a matrix made of `include` and nothing else: another axis (`runner: [self-hosted]`) or an `exclude` could add or hide runners.
  const matrix = job.strategy?.matrix;
  const include = matrix?.include;
  const onlyInclude = matrix !== null && typeof matrix === "object" && Object.keys(matrix).length === 1 && Array.isArray(include) && include.length > 0;
  return onlyInclude ? include.map((entry) => entry?.runner) : [job["runs-on"]];
}
/** What a job's runs-on resolves to for a repository with this `private` flag and CI_RUNS_ON value. */
function resolveRunsOn(value, { isPrivate, ciRunsOn }) {
  const expr = unwrap(value);
  if (expr === null) return value; // a literal label
  return evalExpr(expr, { "github.event.repository.private": isPrivate, "vars.CI_RUNS_ON": ciRunsOn });
}
const CI_RUNS_ON_VALUES = ["", "self-hosted", "[self-hosted, linux]", "self-hosted-2", "ubicloud-standard-2", "ubuntu-latest", "macos-latest", "my-own-runner"];

test("runner guard: every job of every workflow runs-on exactly the guarded expression or a literal ubuntu/macos/windows label", () => {
  assert.ok(workflows.length >= 2);
  let jobs = 0;
  for (const { file, doc } of workflows) {
    for (const [name, job] of jobsOf(doc)) {
      jobs += 1;
      for (const value of runsOnValues(job)) assert.equal(judgeRunsOn(value), null, `${file}: job ${name}`);
    }
  }
  assert.ok(jobs >= 4, "ci.yml has pr-gates, check and workspace-e2e; ci-full-label.yml has one");
});

test("runner guard: fixture workflows with a self-hosted-capable runs-on are rejected", () => {
  const fixtures = {
    "self-hosted": "self-hosted",
    "the old default expression": "${{ vars.CI_RUNS_ON || 'self-hosted' }}",
    "a label list": "[self-hosted, linux]",
    "the variable alone": "${{ vars.CI_RUNS_ON }}",
    "a matrix value": "${{ matrix.os }}",
    "fromJSON": "${{ fromJSON('[\"self-hosted\"]') }}",
    "a differently gated expression": "${{ github.event.repository.private && vars.CI_RUNS_ON || 'ubuntu-latest' }}",
    "the guard with the wrong fallback": "${{ github.event.repository.private && (vars.CI_RUNS_ON || 'self-hosted') || 'self-hosted' }}",
    "the guard without the private test": "${{ vars.CI_RUNS_ON || 'ubuntu-latest' }}",
    "a runner group": "{ group: owners-machine }",
  };
  for (const [what, runsOn] of Object.entries(fixtures)) {
    const doc = parseYamlText(`on: pull_request\njobs:\n  j:\n    runs-on: ${runsOn}\n    steps:\n      - run: echo\n`);
    assert.notEqual(judgeRunsOn(doc.jobs.j["runs-on"]), null, `${what} must be rejected`);
  }
  // A matrix job also names its runner outside the `runs-on:` line, which is why the value above is a plain string.
  const matrixDoc = parseYamlText("on: pull_request\njobs:\n  j:\n    strategy:\n      matrix:\n        os: [self-hosted]\n    runs-on: ${{ matrix.os }}\n    steps:\n      - run: echo\n");
  assert.notEqual(judgeRunsOn(matrixDoc.jobs.j["runs-on"]), null);
  // The one allowed matrix form is `${{ matrix.runner }}` over an include list of literal hosted labels, and one bad entry fails it.
  const matrixRunner = (runners) => parseYamlText(`on: workflow_dispatch\njobs:\n  j:\n    strategy:\n      matrix:\n        include:\n${runners.map((r) => `          - { runner: ${r} }\n`).join("")}    runs-on: \${{ matrix.runner }}\n    steps:\n      - run: echo\n`).jobs.j;
  assert.deepEqual(runsOnValues(matrixRunner(["ubuntu-latest", "macos-15"])).map(judgeRunsOn), [null, null]);
  assert.notEqual(runsOnValues(matrixRunner(["ubuntu-latest", "self-hosted"])).map(judgeRunsOn).find((reason) => reason !== null), undefined);
  // A second axis next to `include`, or an `exclude`, is refused: the axis can name a self-hosted runner.
  for (const extra of ["        runner: [self-hosted]\n", "        exclude:\n          - { runner: ubuntu-latest }\n", "        os: [self-hosted]\n"]) {
    const doc = parseYamlText(`on: workflow_dispatch\njobs:\n  j:\n    strategy:\n      matrix:\n${extra}        include:\n          - { runner: ubuntu-latest }\n    runs-on: \${{ matrix.runner }}\n    steps:\n      - run: echo\n`);
    assert.notEqual(runsOnValues(doc.jobs.j).map(judgeRunsOn).find((reason) => reason !== null), undefined, extra);
  }
  assert.notEqual(judgeRunsOn(runsOnValues(parseYamlText("on: workflow_dispatch\njobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - { platform: x }\n    runs-on: ${{ matrix.runner }}\n    steps:\n      - run: echo\n").jobs.j)[0]), null);
  for (const ok of [GUARD, "ubuntu-latest", "ubuntu-24.04", "macos-14", "macos-latest", "windows-2022"]) {
    assert.equal(judgeRunsOn(ok), null, ok);
  }
});

test("runner guard: the evaluator has GitHub's semantics (false && x is false, '' || y is y), and rejects what it cannot read", () => {
  assert.equal(evalExpr("a && b || 'z'", { a: false, b: "x" }), "z");
  assert.equal(evalExpr("a && b || 'z'", { a: true, b: "x" }), "x");
  assert.equal(evalExpr("a && b || 'z'", { a: true, b: "" }), "z");
  assert.equal(evalExpr("a && (b || 'y') || 'z'", { a: true, b: "" }), "y");
  assert.equal(evalExpr("v != 'true'", { v: "TRUE" }), false, "string comparison is case-insensitive");
  assert.equal(evalExpr("v != 'true'", { v: "" }), true);
  assert.equal(evalExpr("p == false", { p: false }), true);
  assert.throws(() => evalExpr("fromJSON(x)", { x: 1 }));
  assert.throws(() => evalExpr("matrix.os", {}));
});

test("runner guard: with repository.private == false every job resolves to a GitHub-hosted label, for every CI_RUNS_ON value", () => {
  let checked = 0;
  for (const { file, doc } of workflows) {
    for (const [name, job] of jobsOf(doc)) {
      for (const ciRunsOn of CI_RUNS_ON_VALUES) {
        for (const value of runsOnValues(job)) {
          const got = resolveRunsOn(value, { isPrivate: false, ciRunsOn });
          assert.match(String(got), HOSTED_LABEL, `${file}: ${name} with CI_RUNS_ON=${JSON.stringify(ciRunsOn)} resolved to ${JSON.stringify(got)}`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked >= 4 * CI_RUNS_ON_VALUES.length);
  // The case the Spec names.
  assert.equal(evalExpr(unwrap(GUARD), { "github.event.repository.private": false, "vars.CI_RUNS_ON": "self-hosted" }), "ubuntu-latest");
  // A fork PR runs in the base repository's context, so a public repo's fork PR resolves the same way.
  assert.equal(evalExpr(unwrap(GUARD), { "github.event.repository.private": false, "vars.CI_RUNS_ON": "" }), "ubuntu-latest");
});

test("runner guard: a private repo keeps the self-hosted default and honours CI_RUNS_ON; the check has teeth", () => {
  const old = unwrap("${{ vars.CI_RUNS_ON || 'self-hosted' }}");
  assert.equal(evalExpr(old, { "vars.CI_RUNS_ON": "" }), "self-hosted", "the unguarded expression would reach the self-hosted runner");
  const guard = unwrap(GUARD);
  const priv = (v) => evalExpr(guard, { "github.event.repository.private": true, "vars.CI_RUNS_ON": v });
  assert.equal(priv(""), "self-hosted", "unset on a private repo: no hosted minutes by accident");
  assert.equal(priv("self-hosted"), "self-hosted");
  assert.equal(priv("ubicloud-standard-4"), "ubicloud-standard-4");
  assert.equal(priv("ubuntu-latest"), "ubuntu-latest");
});

// ---- the fork-PR model: what a workflow may be triggered by, read, and splice into a shell -------------------
const UNTRUSTED_IN_RUN = /\$\{\{[^}]*\b(github\.event\.pull_request\.(title|body|head\.ref|head\.label)|github\.head_ref|github\.event\.head_commit\.message|github\.event\.(issue|comment)\.(title|body))\b[^}]*\}\}/;
/** Every `run:` block in a workflow document that splices an attacker-chosen string into the shell. */
function untrustedInRun(doc) {
  const hits = [];
  for (const [name, job] of jobsOf(doc)) {
    for (const [i, step] of (job.steps ?? []).entries()) {
      if (typeof step.run === "string" && UNTRUSTED_IN_RUN.test(step.run)) hits.push(`${name} step ${i + 1}`);
    }
  }
  return hits;
}

/**
 * Every secret a workflow reads, by (file, job): this list is exhaustive. Naming a GitHub environment does not gate a secret by itself
 * (an unknown environment name is created on first use, unprotected), so a job may read a secret only if it is listed here with exactly
 * its environment and exactly these secrets: the two signing jobs of D#6 R6-5, whose environments the owner restricts to protected main.
 */
const RELEASE_PUBLISHERS = { "runner-release.yml": ["draft", "sign"], "tuf-timestamp.yml": ["refresh"] };
const SECRET_ALLOWLIST = {
  "runner-release.yml": { sign: { environment: "release", secrets: ["TUF_ONLINE_KEY", "TUF_TARGETS_KEY"] } },
  "tuf-timestamp.yml": { refresh: { environment: "tuf-timestamp", secrets: ["TUF_ONLINE_KEY"] } },
};
/** The text of every `${{ }}` expression under a node, and of every `if:` value (which needs no braces). Plain words in names and comments do not count. */
function expressionTexts(node, key = "", out = []) {
  if (typeof node === "string") {
    for (const m of node.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) out.push(m[1]);
    if (key === "if") out.push(node);
  } else if (Array.isArray(node)) for (const v of node) expressionTexts(v, key, out);
  else if (node !== null && typeof node === "object") for (const [k, v] of Object.entries(node)) expressionTexts(v, k, out);
  return out;
}
/** The secrets a node reads by name, and whether it reads them any other way (`toJSON(secrets)`, `secrets['X']`, `secrets[...]`, `secrets` alone). */
function secretUse(node) {
  const texts = expressionTexts(node);
  const names = texts.flatMap((t) => [...t.matchAll(/\bsecrets\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
  const dynamic = texts.some((t) => /\bsecrets\b(?!\.[A-Za-z_])/.test(t));
  return { names, dynamic, used: names.length > 0 || dynamic };
}
function secretViolations(file, doc) {
  const out = [];
  const { jobs, ...rest } = doc;
  if (secretUse(rest).used) out.push("top level");
  for (const [name, job] of Object.entries(jobs ?? {})) {
    const use = secretUse(job);
    if (!use.used) continue;
    const allowed = SECRET_ALLOWLIST[file]?.[name];
    if (allowed === undefined) {
      out.push(`${name} is not an allowed secret reader`);
      continue;
    }
    if (job.environment !== allowed.environment) out.push(`${name} must run in environment ${allowed.environment}`);
    if (use.dynamic) out.push(`${name} reads secrets by a dynamic name`);
    for (const n of new Set(use.names)) if (!allowed.secrets.includes(n)) out.push(`${name} reads ${n}`);
    if (runsOnValues(job).some((value) => /^macos-/.test(String(value)))) out.push(`${name} runs on macOS`);
  }
  return out;
}

test("workflows: no pull_request_target or workflow_run trigger, secrets only in the two allowlisted signing jobs, top-level permissions contents read only", () => {
  for (const { file, text, doc } of workflows) {
    const on = triggersOf(doc);
    const keys = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
    for (const k of keys) assert.ok(!["pull_request_target", "workflow_run"].includes(k), `${file} has a ${k} trigger`);
    assert.deepEqual(secretViolations(file, doc), [], `${file} reads a secret where it may not`);
    assert.doesNotMatch(noComments(text), /secrets\.GITHUB_TOKEN/, `${file} reads the token as a secret`);
    assert.deepEqual(doc.permissions, { contents: "read" }, `${file}: top-level permissions`);
  }
  const fixture = ({ on = "workflow_dispatch", job = "sign", environment = "release", expr = "secrets.TUF_ONLINE_KEY", runsOn = "ubuntu-latest", top = "" } = {}) =>
    parseYamlText(`on: ${on}\n${top}jobs:\n  ${job}:\n    runs-on: ${runsOn}\n${environment === null ? "" : `    environment: ${environment}\n`}    steps:\n      - run: echo \${{ ${expr} }}\n`);
  const rr = "runner-release.yml";
  assert.deepEqual(secretViolations(rr, fixture()), []);
  // teeth: an unlisted file, with a push trigger and any environment name
  assert.deepEqual(secretViolations("evil.yml", fixture({ on: "push", environment: "anything", expr: "secrets.TUF_TARGETS_KEY" })), ["sign is not an allowed secret reader"]);
  assert.deepEqual(secretViolations(rr, fixture({ job: "build" })), ["build is not an allowed secret reader"]);
  // the right job with the wrong secret, without its environment, in the wrong environment, or on macOS
  assert.deepEqual(secretViolations(rr, fixture({ expr: "secrets.OTHER_KEY" })), ["sign reads OTHER_KEY"]);
  assert.deepEqual(secretViolations(rr, fixture({ environment: null })), ["sign must run in environment release"]);
  assert.deepEqual(secretViolations(rr, fixture({ environment: "tuf-timestamp" })), ["sign must run in environment release"]);
  assert.deepEqual(secretViolations(rr, fixture({ runsOn: "macos-15" })), ["sign runs on macOS"]);
  assert.deepEqual(secretViolations("tuf-timestamp.yml", fixture({ job: "refresh", environment: "tuf-timestamp", expr: "secrets.TUF_TARGETS_KEY" })), ["refresh reads TUF_TARGETS_KEY"]);
  // every other way of reading a secret is seen
  assert.deepEqual(secretViolations(rr, fixture({ expr: "toJSON(secrets)" })), ["sign reads secrets by a dynamic name"]);
  assert.deepEqual(secretViolations(rr, fixture({ expr: "secrets['TUF_TARGETS_KEY']" })), ["sign reads secrets by a dynamic name"]);
  assert.deepEqual(secretViolations("ci.yml", fixture({ job: "check", environment: null, expr: "toJSON(secrets)" })), ["check is not an allowed secret reader"]);
  assert.deepEqual(secretViolations(rr, fixture({ top: "env:\n  K: \${{ secrets.TUF_ONLINE_KEY }}\n" })), ["top level"]);
  // a plain word "secrets" in a name is not a read
  assert.deepEqual(secretViolations("ci.yml", parseYamlText("on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - name: no secrets here\n        run: echo secrets\n")), []);
});

test("workflows: no job asks for more than read except the label job's actions write and the release publishers' contents write, and no secrets are declared for a reusable call", () => {
  for (const { file, doc } of workflows) {
    for (const [name, job] of jobsOf(doc)) {
      for (const [scope, level] of Object.entries(job.permissions ?? {})) {
        if (level === "read") continue;
        // The release workflows publish a release and the update metadata: `contents: write`, in exactly these jobs (D#6 R6-5).
        const publisher = scope === "contents" && level === "write" && (RELEASE_PUBLISHERS[file] ?? []).includes(name);
        assert.ok(publisher || (file === "ci-full-label.yml" && scope === "actions" && level === "write"), `${file}: ${name} asks for ${scope}: ${level}`);
      }
      assert.equal(job.secrets, undefined, `${file}: ${name} passes secrets`);
      assert.equal(job.uses, undefined, `${file}: ${name} calls a reusable workflow`);
    }
  }
});

test("workflows: every checkout sets persist-credentials: false", () => {
  let checkouts = 0;
  for (const { file, doc } of workflows) {
    for (const [name, job] of jobsOf(doc)) {
      for (const step of job.steps ?? []) {
        if (!String(step.uses ?? "").startsWith("actions/checkout@")) continue;
        checkouts += 1;
        assert.equal(step.with?.["persist-credentials"], false, `${file}: ${name} checkout persists credentials`);
      }
    }
  }
  assert.ok(checkouts >= 4);
});

test("workflows: the pull request's title, body and branch name never appear inside a run block", () => {
  for (const { file, doc } of workflows) assert.deepEqual(untrustedInRun(doc), [], file);
  const bad = parseYamlText("on: pull_request\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo \"${{ github.event.pull_request.title }}\"\n      - run: git fetch origin ${{ github.head_ref }}\n      - run: echo ${{ github.event.pull_request.body }}\n      - run: echo ${{ github.event.pull_request.head.ref }}\n");
  assert.equal(untrustedInRun(bad).length, 4);
  const good = parseYamlText("on: pull_request\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          TITLE: ${{ github.event.pull_request.title }}\n        run: echo \"$TITLE\"\n");
  assert.deepEqual(untrustedInRun(good), []);
});

test("fork PRs: check, workspace-e2e and pr-gates have no same-repository condition; ci-full-label keeps it", () => {
  const ctx = (over = {}) => ({
    "github.event_name": "pull_request",
    "github.event.repository.private": false,
    "github.event.label.name": "ci:full",
    "github.event.pull_request.head.repo.full_name": "someone/fork",
    "github.repository": "org/repo",
    "vars.CI_DISABLED": "false",
    ...over,
  });
  for (const name of ["check", "workspace-e2e", "pr-gates"]) {
    const job = ciDoc.jobs[name];
    assert.doesNotMatch(job.if, /head\.repo|github\.repository/, `${name} has a same-repository condition`);
    assert.equal(evalExpr(job.if, ctx()), true, `${name} skipped for a fork PR`);
    assert.equal(evalExpr(job.if, ctx({ "github.event.pull_request.head.repo.full_name": "org/repo" })), true, name);
  }
  const labelJob = Object.values(labelDoc.jobs)[0];
  assert.match(labelJob.if, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.equal(evalExpr(labelJob.if, ctx()), false, "the label job must not run for a fork PR");
  assert.equal(evalExpr(labelJob.if, ctx({ "github.event.pull_request.head.repo.full_name": "org/repo" })), true);
});

// ---- CI_DISABLED -------------------------------------------------------------------------------------------
test("CI_DISABLED: with the variable set to true every job of every workflow is skipped, whatever the event", () => {
  const events = [
    { "github.event_name": "pull_request", "github.event.repository.private": false },
    { "github.event_name": "pull_request", "github.event.repository.private": true },
    { "github.event_name": "push", "github.event.repository.private": false },
    { "github.event_name": "push", "github.event.repository.private": true },
  ];
  const base = { "github.event.label.name": "ci:full", "github.event.pull_request.head.repo.full_name": "org/repo", "github.repository": "org/repo", "github.ref": "refs/heads/main" };
  let jobs = 0;
  for (const { file, doc } of workflows) {
    for (const [name, job] of jobsOf(doc)) {
      jobs += 1;
      assert.equal(typeof job.if, "string", `${file}: ${name} has no job-level if`);
      assert.ok(job.if.startsWith("vars.CI_DISABLED != 'true'"), `${file}: ${name} does not start with the kill switch`);
      for (const ev of events) {
        assert.equal(Boolean(evalExpr(job.if, { ...base, ...ev, "vars.CI_DISABLED": "true" })), false, `${file}: ${name} ran with CI_DISABLED=true`);
      }
    }
  }
  assert.ok(jobs >= 4);
});

test("CI_DISABLED: unset, empty or anything but true leaves CI on (public pull request: check, e2e, pr-gates and the label job run)", () => {
  const ctx = (v) => ({
    "github.event_name": "pull_request",
    "github.event.repository.private": false,
    "github.event.label.name": "ci:full",
    "github.event.pull_request.head.repo.full_name": "org/repo",
    "github.repository": "org/repo",
    "github.ref": "refs/heads/main",
    "vars.CI_DISABLED": v,
  });
  // The release jobs (D#6 R6-5) also require the public code-plane repository and main; they are shown to run there.
  const RELEASE_REPO = "fulcrumaxe/fulcrumaxe-cloud";
  for (const v of ["", "false", "TRUE-ish", "1", "yes"]) {
    for (const { file, doc } of workflows) {
      const here = RELEASE_PUBLISHERS[file] === undefined ? ctx(v) : { ...ctx(v), "github.repository": RELEASE_REPO };
      for (const [, job] of jobsOf(doc)) assert.equal(Boolean(evalExpr(job.if, here)), true, JSON.stringify(v));
    }
  }
  for (const file of Object.keys(RELEASE_PUBLISHERS)) {
    const { doc } = workflows.find((w) => w.file === file);
    for (const [name, job] of jobsOf(doc)) {
      const base = { ...ctx(""), "github.repository": RELEASE_REPO };
      assert.equal(Boolean(evalExpr(job.if, { ...base, "github.ref": "refs/heads/some-branch" })), false, `${file}: ${name} ran from a branch`);
      assert.equal(Boolean(evalExpr(job.if, { ...base, "github.repository": "someone/fork" })), false, `${file}: ${name} ran in another repository`);
    }
  }
});

// ---- pr-gates ----------------------------------------------------------------------------------------------
const prGates = ciDoc.jobs["pr-gates"];

test("pr-gates: public pull requests only, no secrets, read-only token, body and base ref never spliced into the shell", () => {
  assert.equal(prGates.if, "vars.CI_DISABLED != 'true' && github.event_name == 'pull_request' && github.event.repository.private == false");
  const ctx = (event, isPrivate) => ({ "github.event_name": event, "github.event.repository.private": isPrivate, "vars.CI_DISABLED": "false" });
  assert.equal(evalExpr(prGates.if, ctx("pull_request", false)), true);
  assert.equal(evalExpr(prGates.if, ctx("pull_request", true)), false, "the overlay paths are the point of the private repo");
  assert.equal(evalExpr(prGates.if, ctx("push", false)), false);
  const text = JSON.stringify(prGates);
  assert.doesNotMatch(text, /secrets\./);
  const runs = prGates.steps.filter((s) => s.run);
  assert.equal(runs.length, 2);
  for (const s of runs) assert.doesNotMatch(s.run, /\$\{\{/, "an expression inside a run block");
  const link = prGates.steps.find((s) => s.name === "PR link policy");
  assert.match(link.run, /\.pull_request\.body/);
  assert.match(link.run, /GITHUB_EVENT_PATH/);
  assert.match(link.run, /PR_BODY_FILE="\$body_file" bash scripts\/ci\/pr-link-policy\.sh/);
  assert.equal(link.env, undefined, "the body must not sit in an env: block: the runner prints that block into the log");
  const deny = prGates.steps.find((s) => s.name === "Publish denylist");
  assert.deepEqual(deny.env, { BASE_REF: "${{ github.event.pull_request.base.ref }}" });
  assert.equal(deny.run, 'bash scripts/ci/publish-denylist.sh "origin/${BASE_REF}"');
  const checkout = prGates.steps[0];
  assert.equal(checkout.with["fetch-depth"], 0, "the denylist diffs against the merge base");
});

const fixtureTmp = [];
const mkTmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "ex536p6_"));
  fixtureTmp.push(d);
  return d;
};
process.on("exit", () => {
  for (const d of fixtureTmp) rmSync(d, { recursive: true, force: true });
});

function runLinkPolicy(body) {
  const dir = mkTmp();
  const file = path.join(dir, "body.txt");
  writeFileSync(file, body);
  return spawnSync("bash", [path.join(repoRoot, "scripts/ci/pr-link-policy.sh")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, PR_BODY_FILE: file, PR_LINK_POLICY_CODE_REPO: "example-org/public-plane", PR_LINK_POLICY_ALLOW_REPOS: "" },
  });
}

test("pr-gates fixture: a body with Refs D#123 passes the link policy", () => {
  const r = runLinkPolicy("Adds the thing.\n\nRefs D#123\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("pr-gates fixture: a body linking the private repo's Discussion fails the link policy, and so does one with no D# reference", () => {
  // The private plane is a fictional repo: any repo other than the code repo (example-org/public-plane) is foreign.
  const link = runLinkPolicy("Refs D#123\n\nSee https://github.com/example-org/private-plane/discussions/1\n");
  assert.equal(link.status, 1, link.stdout + link.stderr);
  const pub = runLinkPolicy("Refs D#123\n\nSee https://github.com/example-org/public-plane/pull/1\n");
  assert.equal(pub.status, 0, pub.stdout + pub.stderr);
  const none = runLinkPolicy("Adds the thing.\n");
  assert.equal(none.status, 1, none.stdout + none.stderr);
});

/**
 * Run publish-denylist.sh on a fixture repository where a branch adds `added` on top of main. The script is a
 * copy next to a one-line overlay list, so the result does not depend on whether this tree has the private
 * publish-denylist.local (the public tree does not).
 */
function runDenylist(added) {
  const dir = mkTmp();
  const tool = path.join(dir, "tool");
  mkdirSync(tool);
  copyFileSync(path.join(repoRoot, "scripts/ci/publish-denylist.sh"), path.join(tool, "publish-denylist.sh"));
  writeFileSync(path.join(tool, "publish-denylist.local"), "docs/ops/\tops-material\n");
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "pr");
  for (const f of added) {
    mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    writeFileSync(path.join(repo, f), "x\n");
    git("add", f);
  }
  git("commit", "-q", "-m", "change");
  return spawnSync("bash", [path.join(tool, "publish-denylist.sh"), "main"], { cwd: repo, env, encoding: "utf8" });
}

test("pr-gates fixture: a diff adding a product file passes the denylist", () => {
  const r = runDenylist(["apps/web/page.tsx"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("pr-gates fixture: a diff adding .autonomous-team/x fails the denylist and names the path", () => {
  const r = runDenylist(["apps/web/page.tsx", ".autonomous-team/x"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /\.autonomous-team\/x/);
});

test("pr-gates fixture: a diff adding docs/ops/x.md fails the denylist and names the path", () => {
  const r = runDenylist(["docs/ops/x.md"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /docs\/ops\/x\.md/);
});

// ---- a skipped required check is not a pass ---------------------------------------------------------------
// The merge wrapper's CI gate is scripts/lib/ci-status-check.sh. GitHub's branch protection counts a skipped
// required check as passing; the wrapper must not. That script is private-plane tooling (it is not in the
// public tree), so this block runs only where it exists.
const statusLib = path.join(repoRoot, "scripts/lib/ci-status-check.sh");
// What the last gate run printed, so a red assertion says why instead of just "fail".
let lastStatusDetail = "";
// The gate shells out to python3. Whatever PATH a nested `bash -c` ends up with on a given runner, python3 must
// be reachable: the directory is taken from the interpreter this process itself can run, and put first inside
// the script, so the control case does not depend on the runner's own PATH (on the CI runner the nested bash
// saw the service PATH, which has no python3, and the gate failed closed with "unrecognized evaluator response").
const pythonDir = (() => {
  const py = spawnSync("python3", ["-c", "import sys, os; print(os.path.dirname(sys.executable))"], { encoding: "utf8" });
  return py.status === 0 ? py.stdout.trim() : "";
})();
function runStatusGate(runs, { disabled = false } = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? "/nonexistent",
    LIB: statusLib,
    PY_DIR: pythonDir,
    CI_STATUS_TEST_MODE: "1",
    CI_KILL_SWITCH_OVERRIDE: disabled ? "true" : "HTTP_404",
    CI_STATUS_HEAD_SHA_1: "abc1234",
    CI_STATUS_OVERRIDE_1: JSON.stringify(runs),
  };
  const r = spawnSync("bash", ["-c", '[ -z "$PY_DIR" ] || PATH="$PY_DIR:$PATH"; source "$LIB"; CI_REQUIRED_CHECKS=("check" "pr-gates"); check_ci_status 1 example/example >"$GATE_OUT" 2>&1; rc=$?; echo "rc=$rc state=$CI_STATUS_STATE"; echo "reason=$CI_STATUS_FAIL_REASON"; echo "bash=$BASH python3=$(command -v python3) PATH=$PATH"; sed "s/^/gate-output: /" "$GATE_OUT"'], { env: { ...env, GATE_OUT: path.join(tmpdir(), `ci-status-gate-${process.pid}.out`) }, encoding: "utf8" });
  lastStatusDetail = r.stdout + r.stderr;
  const m = /rc=(\d+) state=(\S*)/.exec(r.stdout);
  assert.ok(m, `no result line: ${r.stdout} ${r.stderr}`);
  return { rc: Number(m[1]), state: m[2] };
}
const run = (name, conclusion) => ({ name, status: "completed", conclusion, app: { slug: "github-actions" } });
const skipUnlessGate = { skip: existsSync(statusLib) ? false : "scripts/lib/ci-status-check.sh is private-plane tooling and is not in this tree" };

test("merge gate: every required check green is a pass (the control)", skipUnlessGate, () => {
  const got = runStatusGate([run("check", "success"), run("pr-gates", "success")]);
  assert.deepEqual(got, { rc: 0, state: "pass" }, lastStatusDetail);
});

test("merge gate: a required check that concluded skipped is not a pass", skipUnlessGate, () => {
  const one = runStatusGate([run("check", "success"), run("pr-gates", "skipped")]);
  assert.notEqual(one.rc, 0);
  assert.notEqual(one.state, "pass");
  const all = runStatusGate([run("check", "skipped"), run("pr-gates", "skipped")]);
  assert.notEqual(all.rc, 0);
  assert.notEqual(all.state, "pass");
});

test("merge gate: a required check that concluded neutral is not a pass", skipUnlessGate, () => {
  const r = runStatusGate([run("check", "success"), run("pr-gates", "neutral")]);
  assert.notEqual(r.rc, 0);
  assert.notEqual(r.state, "pass");
});

test("merge gate: CI_DISABLED=true is a stand-down (exit 2), not a green result", skipUnlessGate, () => {
  const r = runStatusGate([], { disabled: true });
  assert.equal(r.rc, 2);
  assert.notEqual(r.state, "pass");
});

// ---- macOS -------------------------------------------------------------------------------------------------
// GitHub-hosted macOS is free on a public repository and costs minutes at a 10x rate on a private one, so a
// workflow that runs on macOS is manual only: it can only be started by hand (workflow_dispatch), never by a
// pull request or a push, and it reads no secret.
/** Names of jobs that run on macOS in a workflow that something other than a manual dispatch can start. */
function macosViolations(doc) {
  const on = triggersOf(doc);
  const keys = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
  const manualOnly = keys.length === 1 && keys[0] === "workflow_dispatch";
  const out = [];
  for (const [name, job] of jobsOf(doc)) {
    const onMacos = runsOnValues(job).some((value) => typeof value === "string" && /^macos-/.test(value));
    // The macOS job itself reads no secret; a signing job on Linux in the same manual workflow may (secretViolations checks it).
    if (onMacos && (!manualOnly || secretUse(job).used)) out.push(name);
  }
  return out;
}

test("macOS: any workflow with a macos-* job is workflow_dispatch only and reads no secret", () => {
  for (const { file, doc } of workflows) assert.deepEqual(macosViolations(doc), [], file);
  const auto = "on:\n  pull_request:\njobs:\n  mac:\n    runs-on: macos-latest\n    steps:\n      - run: echo\n";
  assert.deepEqual(macosViolations(parseYamlText(auto)), ["mac"]);
  const manual = "on:\n  workflow_dispatch:\njobs:\n  mac:\n    runs-on: macos-latest\n    steps:\n      - run: echo\n";
  assert.deepEqual(macosViolations(parseYamlText(manual)), []);
  const both = "on:\n  workflow_dispatch:\n  push:\njobs:\n  mac:\n    runs-on: macos-14\n    steps:\n      - run: echo\n";
  assert.deepEqual(macosViolations(parseYamlText(both)), ["mac"]);
  const secret = "on:\n  workflow_dispatch:\njobs:\n  mac:\n    runs-on: macos-14\n    steps:\n      - run: echo ${{ secrets.X }}\n";
  assert.deepEqual(macosViolations(parseYamlText(secret)), ["mac"]);
});

// ---- the runner guard and the hosted setup, composed ---------------------------------------------------------
// For each (repository privacy, CI_RUNS_ON): which runner the job gets, how that runner reports itself, and so
// whether the Nix installers and the Nix store cache run. Ubicloud reports either environment (seen both ways),
// so it is checked both ways.
test("runner guard and hosted setup compose: installers run on hosted and Ubicloud runners, nowhere on the owner's machine, the Nix cache never on Ubicloud", () => {
  const cases = [
    // [private, CI_RUNS_ON, runner, environments the runner may report, installers, nix cache]
    [false, "", "ubuntu-latest", ["github-hosted"], true, true],
    [false, "self-hosted", "ubuntu-latest", ["github-hosted"], true, true],
    [false, "ubicloud-standard-4", "ubuntu-latest", ["github-hosted"], true, false],
    [true, "", "self-hosted", ["self-hosted"], false, false],
    [true, "self-hosted", "self-hosted", ["self-hosted"], false, false],
    [true, "ubuntu-latest", "ubuntu-latest", ["github-hosted"], true, true],
    [true, "ubicloud-standard-4", "ubicloud-standard-4", ["self-hosted", "github-hosted"], true, false],
  ];
  for (const [isPrivate, ciRunsOn, runner, envs, wantInstallers, wantCache] of cases) {
    const label = `private=${isPrivate} CI_RUNS_ON=${JSON.stringify(ciRunsOn)}`;
    for (const job of [ciDoc.jobs.check, ciDoc.jobs["workspace-e2e"], Object.values(labelDoc.jobs)[0]]) {
      assert.equal(resolveRunsOn(job["runs-on"], { isPrivate, ciRunsOn }), runner, label);
    }
    for (const runnerEnv of envs) {
      for (const steps of [checkSteps, e2eSteps]) {
        for (const s of installers(steps)) {
          const want = isNixCache(s) ? wantCache : wantInstallers;
          assert.equal(evalIf(ifOf(s), { runnerEnv, runsOn: ciRunsOn }), want, `${s.name}: ${label}, runner reports ${runnerEnv}`);
        }
      }
    }
  }
});

// ---- the macOS VM spike workflow (D#587 B-0-mac) --------------------------------------------------------------
// A hand-started measurement on free hosted macOS runners. It may only be started by hand, holds no secret and no
// write permission, never runs on the private plane, and checks every download against a sha256 in its script.
const spike = workflows.find((w) => w.file === "macos-vm-spike.yml");

test("macos spike: workflow_dispatch is the only trigger, and any input is a choice that is never spliced into a run", () => {
  assert.ok(spike, "macos-vm-spike.yml is missing");
  const on = triggersOf(spike.doc);
  assert.deepEqual(Object.keys(on), ["workflow_dispatch"]);
  const inputs = on.workflow_dispatch?.inputs ?? {};
  for (const [name, input] of Object.entries(inputs)) assert.equal(input.type, "choice", `input ${name} must be a choice`);
  for (const [, job] of jobsOf(spike.doc)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === "string") assert.doesNotMatch(step.run, /\$\{\{\s*(inputs|github\.event\.inputs)\./, "an input is spliced into a run block");
    }
  }
});

test("macos spike: read-only, no secrets, literal macOS runners, a timeout of 45 minutes or less, public repositories only", () => {
  assert.deepEqual(spike.doc.permissions, { contents: "read" });
  assert.doesNotMatch(noComments(spike.text), /secrets\./);
  const jobs = jobsOf(spike.doc);
  assert.ok(jobs.length >= 1);
  for (const [name, job] of jobs) {
    assert.equal(job.permissions, undefined, `${name} asks for its own permissions`);
    assert.match(job["runs-on"], /^macos-[A-Za-z0-9._-]+$/, `${name} runs-on is not a literal macos label`);
    assert.ok(job["timeout-minutes"] <= 45, `${name} timeout`);
    assert.ok(job.if.startsWith("vars.CI_DISABLED != 'true'"), `${name} kill switch`);
    const ctx = (isPrivate) => ({ "vars.CI_DISABLED": "", "github.event.repository.private": isPrivate });
    assert.equal(Boolean(evalExpr(job.if, ctx(false))), true, `${name} must run on the public plane`);
    assert.equal(Boolean(evalExpr(job.if, ctx(true))), false, `${name} must not run on the private plane`);
    for (const step of job.steps ?? []) {
      const uses = String(step.uses ?? "");
      if (uses) assert.match(uses, /^actions\/[a-z-]+@v\d+$|@[0-9a-f]{40}( |$)/, `${name}: ${uses} is neither a GitHub action at a major tag nor a full sha`);
    }
  }
});

test("macos spike: the script is bash-valid, lives on a public path, and checks every download against a sha256", () => {
  const script = path.join(repoRoot, "scripts/spike/macos-vm-spike.sh");
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const src = readFileSync(script, "utf8");
  assert.ok((src.match(/\bfetch "\$/g) ?? []).length >= 3, "vfkit, kernel and initrd are all fetched");
  assert.ok((src.match(/SHA256="[0-9a-f]{64}"/g) ?? []).length >= 3, "pinned sha256 values");
  assert.doesNotMatch(src, /curl [^\n]*\|\s*(ba)?sh/, "piping a download into a shell");
  // The overlay list is private and absent on the public plane; public CI runs publish-denylist.sh itself.
  const denyFile = path.join(here, "publish-denylist.local");
  if (existsSync(denyFile)) assert.doesNotMatch(readFileSync(denyFile, "utf8"), /^scripts\/spike\//m, "the spike script must stay on a public path");
});

test("workflows: no job-level env value reads the runner context (it is not available there; step-level env and run lines may)", () => {
  for (const w of workflows) {
    for (const [name, job] of jobsOf(w.doc)) {
      for (const [key, value] of Object.entries(job.env ?? {})) {
        assert.doesNotMatch(String(value), /\$\{\{[^}]*\brunner\./, `${w.file}: job ${name} env ${key} reads the runner context`);
      }
    }
  }
});

// actionlint checks contexts, expressions and schema the way the hosted service does. Its shell and Python linters
// are off: they judge run-block style, where ci.yml already has findings; this test is about the files being valid.
const actionlint = spawnSync("actionlint", ["-version"], { encoding: "utf8" });
test("workflows: actionlint accepts every workflow file", {
  skip: actionlint.status === 0 ? false : "actionlint is not on PATH in this shell; the contexts check above still runs (the ci dev shell provides actionlint)",
}, () => {
  const r = spawnSync("actionlint", ["-no-color", "-shellcheck", "", "-pyflakes", "", ...workflows.map((w) => path.join(WORKFLOW_DIR, w.file))], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

// ---- the spike's report: each step-1 verdict, from fake results.jsonl rows -------------------------------------
const reportScript = path.join(repoRoot, "scripts/spike/macos-spike-report.py");
const spikeRow = (id, value, command = "cmd", note = "") => ({ id, value, unit: "text", command, load: "1.0", note });
function reportFor(rows) {
  const dir = mkdtempSync(path.join(tmpdir(), "spike-report-"));
  try {
    writeFileSync(path.join(dir, "results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = spawnSync("python3", ["-I", reportScript, dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("macos spike report: a guest that wrote console output is YES", () => {
  const out = reportFor([spikeRow("host.arch", "arm64"), spikeRow("result.vm_booted", "yes")]);
  assert.match(out, /\*\*YES, a guest wrote console output\.\*\*/);
  assert.doesNotMatch(out, /NOT TESTED/);
});

test("macos spike report: a boot that was tried and failed is NO, with its exact error", () => {
  const out = reportFor([spikeRow("result.vm_booted", "no"), spikeRow("vm.boot.error", "Virtualization is not available", "vfkit ...")]);
  assert.match(out, /\*\*NO, no guest console output\.\*\*/);
  assert.match(out, /Virtualization is not available/);
  assert.doesNotMatch(out, /NOT TESTED/);
});

test("macos spike report: a failed download or sha256 mismatch is NOT TESTED, never NO", () => {
  for (const [id, value] of [["download.vfkit", "failed"], ["download.vmlinuz-virt", "sha256 mismatch: got abc"]]) {
    // The script records vm_booted=not_tested; the report must say so from the download row alone as well.
    for (const booted of ["not_tested", "no"]) {
      const out = reportFor([spikeRow("result.vm_booted", booted), spikeRow(id, value, "curl -fsSL https://example.invalid/x", "expected def")]);
      assert.match(out, /\*\*NOT TESTED \(download\/checksum failed\)\.\*\*/, `${id} / ${booted}`);
      assert.doesNotMatch(out, /\*\*NO, no guest console output/);
      assert.ok(out.includes(`- ${id}: ${value}`), `${id} is listed with its value`);
    }
  }
});

test("macos spike report: not_tested without any download row is still NOT TESTED, and a directory without results says so", () => {
  assert.match(reportFor([spikeRow("result.vm_booted", "not_tested")]), /NOT TESTED \(download\/checksum failed\)/);
  const dir = mkdtempSync(path.join(tmpdir(), "spike-report-"));
  try {
    const r = spawnSync("python3", ["-I", reportScript, dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No results\.jsonl in this directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("macos spike report: the Seatbelt section names the profile's extra write allowances", () => {
  const out = reportFor([spikeRow("result.vm_booted", "no")]);
  assert.match(out, /\/private\/tmp and \/private\/var\/folders/);
});

test("macos spike script: a failed or unverified download sets a flag, records not_tested and ends the script non-zero", () => {
  const src = readFileSync(path.join(repoRoot, "scripts/spike/macos-vm-spike.sh"), "utf8");
  const fetchFn = /\nfetch\(\) \{[\s\S]*?\n\}\n/.exec(src)?.[0] ?? "";
  assert.equal((fetchFn.match(/DOWNLOAD_FAILED=1/g) ?? []).length, 2, "both the curl failure and the mismatch set the flag");
  assert.match(src, /if \[ "\$DOWNLOAD_FAILED" = 1 \]; then VM_BOOTED=not_tested; fi\nrec result\.vm_booted/);
  assert.match(src, /\nrm -rf "\$WORK"\n[\s\S]*if \[ "\$DOWNLOAD_FAILED" = 1 \]; then[\s\S]*exit 1\nfi\nexit 0\n$/);
});
