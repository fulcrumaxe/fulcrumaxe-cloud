import { SURVEY_ROLE, type Job, type NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { describe, expect, it } from "vitest";
import { createMemoryLedger, runJob, type RunJobDeps, type RunnableJob } from "../src/job/runJob.js";
import { roleToolsDigest } from "../src/job/roleTools.js";
import type { CreateSandboxOptions, SandboxHandle, SandboxPort, StartDetachedOptions, StartDetachedResult } from "../src/sandbox/port.js";
import { srcFiles } from "./helpers/srcFiles.js";
import { sha } from "./helpers/sampleJob.js";

/**
 * D#845 ON-10e2b (the pin Ruling 103 asks for): a public survey and a private survey run in the same sandbox. The signed `repo.private` is read once, by `verifyJob`; nothing after it does, so the
 * options the runner hands its sandbox (role, working copy, network rules, environment, prompt) are the same for both. The first test runs the real `runJob` twice, once per visibility, against a recording
 * port. The second pins the reason it holds: no source file other than the verifier reads the field.
 */
const RUN = "33333333-3333-4333-8333-333333333333";
const PROMPT = "Survey the repository and answer with the project draft.\n";
const CARD = "You are the project surveyor.\n";
const done: NormalizedEvent = { runId: RUN, role: SURVEY_ROLE, seq: 1, type: "result", ts: "2026-11-26T00:00:00.000Z", sessionId: "sess-1", agentOutput: { verdict: "done" } };

function surveyJob(isPrivate: boolean): RunnableJob {
  // `repo` is not part of what `runJob` is typed to take, so a runner that began to read it would not compile; it is carried here anyway, as the daemon's full job is.
  return {
    role: SURVEY_ROLE,
    task: { kind: "survey", prompt: PROMPT, prompt_sha256: sha(PROMPT) },
    role_card: { text: CARD, sha256: sha(CARD) },
    role_tools_sha256: roleToolsDigest(SURVEY_ROLE),
    job_id: "44444444-4444-4444-8444-444444444444",
    run_id: RUN,
    continues: null,
    model_hint: null,
    repo: { id: "5", owner: "acme", name: "widgets", private: isPrivate },
  } as RunnableJob & { repo: Job["repo"] };
}

async function oneRun(isPrivate: boolean): Promise<{ calls: string[]; created: CreateSandboxOptions[]; started: Array<Omit<StartDetachedOptions, "onEvent">> }> {
  const calls: string[] = [];
  const created: CreateSandboxOptions[] = [];
  const started: Array<Omit<StartDetachedOptions, "onEvent">> = [];
  const handle: SandboxHandle = { runId: "", sandboxName: `rn-${RUN}` };
  const port: SandboxPort = {
    async createSandbox(opts) {
      calls.push("create");
      created.push(opts);
      return handle;
    },
    startDetached: (_h, opts): StartDetachedResult => {
      calls.push("start");
      started.push(Object.fromEntries(Object.entries(opts).filter(([key]) => key !== "onEvent")) as Omit<StartDetachedOptions, "onEvent">);
      return { handle, hookFired: Promise.resolve(done) };
    },
    resume: () => {
      throw new Error("not used");
    },
    async extendTimeout() {},
    async stop() {
      calls.push("stop");
    },
    async deleteSandbox() {
      calls.push("delete");
    },
    async measure() {
      return [];
    },
    async readCounters() {
      return undefined;
    },
    async writeFiles() {},
    async runCommand(): Promise<never> {
      throw new Error("not used");
    },
    async sandboxExists() {
      return true;
    },
  };
  const deps: RunJobDeps = {
    sandbox: port,
    workspaces: { create: async (runId) => `/work/${runId}`, owns: () => true, discard: async () => undefined },
    ledger: createMemoryLedger(),
    credentials: { mode: "subscription" },
    planSession: () => ({ kind: "fresh", branch: null }),
    defaultModel: "sonnet",
  };
  expect((await runJob(surveyJob(isPrivate), deps)).status).toBe("done");
  return { calls, created, started };
}

describe("a public survey and a private survey get the same sandbox", () => {
  it("runJob hands the sandbox identical creation and start options, whatever repo.private says", async () => {
    const priv = await oneRun(true);
    const pub = await oneRun(false);
    expect(priv.started).toHaveLength(1);
    expect(pub.calls).toEqual(priv.calls);
    expect(pub.created).toEqual(priv.created);
    expect(pub.started).toEqual(priv.started);
    // And what they are: the survey role with the model host as its one network rule.
    expect(pub.started[0]).toMatchObject({ role: SURVEY_ROLE, networkPolicy: [{ host: "api.anthropic.com", purpose: "model" }] });
  });

  it("no source file but the job verifier reads the signed repo.private, so nothing after verification can branch on it", () => {
    const readers = srcFiles()
      .filter(([, text]) => /\brepo\??\.private\b|\.repo\)?\??\.private\b/.test(text))
      .map(([file]) => file);
    expect(readers).toEqual(["src/daemon/verifyJob.ts"]);
  });
});
