import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// D#6 R6-5 acceptance 1: a static read of both release workflows. What a run does on a real runner is shown by the live dispatch; this keeps
// the wiring (triggers, runners, pins, where secrets and write permission may appear) from drifting.
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
}
interface Job {
  environment?: string;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  steps: Step[];
  strategy?: { matrix: { include: { runner: string }[] } };
}
type Workflow<K extends string = string> = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<K, Job>;
};

const text = (name: string): string => readFileSync(path.join(REPO, ".github", "workflows", name), "utf8");
const parse = <K extends string>(name: string): Workflow<K> => load(text(name)) as Workflow<K>;
const release = parse<"build" | "draft" | "sign">("runner-release.yml");
const timestamp = parse<"refresh">("tuf-timestamp.yml");
const workflows: [string, Workflow][] = [
  ["runner-release.yml", release],
  ["tuf-timestamp.yml", timestamp],
];

describe("triggers", () => {
  it("runner-release runs on workflow_dispatch only, with a version input", () => {
    expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
    expect(JSON.stringify(release.on)).toContain('"version"');
  });

  it("tuf-timestamp runs on a weekly schedule and workflow_dispatch, and nothing else", () => {
    expect(Object.keys(timestamp.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    const cron = ((timestamp.on.schedule as { cron: string }[])[0]?.cron ?? "").split(" ");
    expect(cron).toHaveLength(5);
    expect(cron[2]).toBe("*");
    expect(cron[3]).toBe("*");
    expect(cron[4]).toMatch(/^\d$/);
  });
});

describe.each(workflows)("%s", (name, workflow) => {
  const jobs = Object.entries(workflow.jobs);

  it("uses GitHub-hosted runners only, and builds on the four platforms (release)", () => {
    expect(text(name)).not.toMatch(/self-hosted/);
    const labels = jobs.flatMap(([, job]) => [job["runs-on"], ...(job.strategy?.matrix.include.map((entry) => entry.runner) ?? [])]);
    for (const label of labels) expect(label).toMatch(/^(ubuntu-latest|ubuntu-24\.04-arm|macos-15|macos-15-intel|\$\{\{ matrix\.runner \}\})$/);
    if (name === "runner-release.yml") expect(release.jobs.build.strategy?.matrix.include.map((entry) => entry.runner).sort()).toEqual(["macos-15", "macos-15-intel", "ubuntu-24.04-arm", "ubuntu-latest"]);
  });

  it("pins every action by a full commit SHA", () => {
    const uses = jobs.flatMap(([, job]) => job.steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses])));
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it("starts from a read-only token and grants contents: write only to the jobs that publish", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    const writers = jobs.filter(([, job]) => job.permissions !== undefined).map(([jobName, job]) => [jobName, job.permissions]);
    for (const [, permissions] of writers) expect(permissions).toEqual({ contents: "write" });
    expect(writers.map(([jobName]) => jobName)).toEqual(name === "runner-release.yml" ? ["draft", "sign"] : ["refresh"]);
  });

  it("references a secret other than the token only in a job that declares an environment", () => {
    for (const [jobName, job] of jobs) {
      const body = JSON.stringify(job);
      const secrets = [...body.matchAll(/secrets\.(\w+)/g)].map((match) => match[1] ?? "");
      if (job.environment === undefined) expect(secrets, jobName).toEqual([]);
      else for (const secret of secrets) expect(secret, jobName).toMatch(/^TUF_(TARGETS|ONLINE)_KEY$/);
    }
    expect(text(name)).not.toMatch(/secrets\.GITHUB_TOKEN/);
  });

  it("never expands an input or a secret inside a shell command, only through env", () => {
    for (const [, job] of jobs) for (const step of job.steps) expect(step.run ?? "").not.toMatch(/\$\{\{\s*(inputs|secrets|github\.event)/);
  });

  it("runs only on the public code-plane repository and only from main, with the kill switch first (never decided by the event payload)", () => {
    for (const [, job] of jobs) {
      const condition = (job as Job & { if?: string }).if ?? "";
      expect(condition.startsWith("vars.CI_DISABLED != 'true' && ")).toBe(true);
      expect(condition).toContain("github.repository == 'fulcrumaxe/fulcrumaxe-cloud'");
      expect(condition).toContain("github.ref == 'refs/heads/main'");
      expect(condition).not.toContain("github.event.repository");
    }
  });

  it("installs without lifecycle scripts in every job that later handles a signing key", () => {
    for (const [jobName, job] of jobs) {
      if (job.environment === undefined) continue;
      const installs = job.steps.filter((step) => (step.run ?? "").includes("pnpm install"));
      expect(installs.length, jobName).toBeGreaterThan(0);
      for (const step of installs) expect(step.run, jobName).toContain("--ignore-scripts");
    }
  });
});

describe("environments and secrets", () => {
  it("signs in `release` (targets and online keys) and refreshes in `tuf-timestamp` (the online key alone)", () => {
    expect(release.jobs.sign.environment).toBe("release");
    expect(timestamp.jobs.refresh.environment).toBe("tuf-timestamp");
    const secretsOf = (job: Job): string[] => [...JSON.stringify(job).matchAll(/secrets\.(\w+)/g)].map((match) => match[1] ?? "");
    expect([...new Set(secretsOf(release.jobs.sign))].sort()).toEqual(["TUF_ONLINE_KEY", "TUF_TARGETS_KEY"]);
    expect([...new Set(secretsOf(timestamp.jobs.refresh))]).toEqual(["TUF_ONLINE_KEY"]);
    expect(release.jobs.build.environment).toBeUndefined();
    expect(release.jobs.draft.environment).toBeUndefined();
  });

  it("checks the secrets before it installs or signs anything, and the trusted root before it signs, the artifacts after", () => {
    const steps = release.jobs.sign.steps.map((step) => `${step.run ?? ""}`);
    const at = (needle: string): number => steps.findIndex((run) => run.includes(needle));
    expect(at("signing-configured")).toBeGreaterThanOrEqual(0);
    expect(at("signing-configured")).toBeLessThan(at("pnpm install"));
    const preCheck = at("check --dir meta --trusted-root");
    const sign = at("tuf-release.mjs\" release");
    const postCheck = at("--artifacts artifacts");
    expect(preCheck).toBeGreaterThanOrEqual(0);
    expect(preCheck).toBeLessThan(sign);
    expect(sign).toBeLessThan(postCheck);
    expect(postCheck).toBeLessThan(at("release-metadata.sh\" publish"));
    expect(steps.some((run) => run.includes("--trusted-root \"$TRUSTED_ROOT\""))).toBe(true);
  });

  it("declares a first release explicitly (default false) and passes it to the metadata fetch", () => {
    const inputs = (release.on.workflow_dispatch as { inputs: Record<string, { default?: unknown; type?: string }> }).inputs;
    expect(inputs.first_release).toMatchObject({ default: false, type: "boolean" });
    const fetch = release.jobs.sign.steps.find((step) => (step.run ?? "").includes('release-metadata.sh" fetch'));
    expect(fetch?.run).toContain('fetch meta "$FIRST_RELEASE"');
    expect(JSON.stringify(timestamp)).not.toContain("first_release");
  });

  it("requires all four files to have been checked, and the draft to match the build, before publishing", () => {
    const runs = release.jobs.sign.steps.map((step) => step.run ?? "");
    const at = (needle: string): number => runs.findIndex((run) => run.includes(needle));
    expect(runs[at("--artifacts artifacts")]).toContain("| tee");
    expect(at("all-checked")).toBe(at("--artifacts artifacts"));
    expect(at("release-verify-draft.sh")).toBeGreaterThan(at("all-checked"));
    expect(at("release-verify-draft.sh")).toBeLessThan(at("gh release edit"));
  });

  it("publishes the release before its metadata, so metadata never points at a draft", () => {
    const publish = release.jobs.sign.steps.at(-1)?.run ?? "";
    expect(publish.indexOf("gh release edit")).toBeLessThan(publish.indexOf("release-metadata.sh"));
  });

  it("the timestamp job requires its secret before it installs, and checks before and after it re-signs", () => {
    const steps = timestamp.jobs.refresh.steps.map((step) => `${step.run ?? ""}`);
    expect(steps.findIndex((run) => run.includes("signing-configured"))).toBeLessThan(steps.findIndex((run) => run.includes("pnpm install")));
    expect(steps.filter((run) => run.includes("tuf-release.mjs\" check")).length).toBe(2);
    expect(steps.findIndex((run) => run.includes("refresh-timestamp"))).toBeGreaterThan(0);
  });
});

describe("the build job", () => {
  const runs = release.jobs.build.steps.map((step) => step.run ?? "");

  it("builds into fresh directories and compares, runs the program, and requires seaReal.test.ts to have run on Linux x64", () => {
    expect(runs.some((run) => run.includes("release-build.sh"))).toBe(true);
    expect(runs.some((run) => run.includes("release-check.mjs\" smoke"))).toBe(true);
    const sea = release.jobs.build.steps.find((step) => (step.run ?? "").includes("seaReal.test.ts"));
    expect(sea?.if).toBe("matrix.platform == 'linux-x64'");
    expect(sea?.run).toContain("sea-real-ran");
    expect(JSON.stringify(release)).not.toContain("FX_SEA_SKIP_REAL");
  });

  it("strips the code signature before comparing only on macOS", () => {
    const include = (release.jobs.build.strategy?.matrix.include ?? []) as unknown as { platform: string; strip: string }[];
    expect(Object.fromEntries(include.map((entry) => [entry.platform, entry.strip]))).toEqual({ "linux-x64": "", "linux-arm64": "", "darwin-arm64": "--strip-signature", "darwin-x64": "--strip-signature" });
  });

  it("the draft job writes the eight release files and creates a draft", () => {
    const body = release.jobs.draft.steps.map((step) => step.run ?? "").join("\n");
    for (const file of ["release-manifest.json", "install.sh", "fx-runner.rb", "SHA256SUMS"]) expect(body).toContain(`files/${file}`);
    expect(body).toContain("gh release create");
    expect(body).toContain("--draft");
    expect(release.jobs.sign.steps.map((step) => step.run ?? "").join("\n")).not.toContain("gh release create");
  });
});
