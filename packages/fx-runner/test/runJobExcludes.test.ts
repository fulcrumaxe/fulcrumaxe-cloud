import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXCLUDE_PROMPT_LINE, JobSignatureError, excludeDenyRules, verifyJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createClaudeEngine } from "../src/engines/claude/engine.js";
import { createMemoryLedger, runJob } from "../src/job/runJob.js";
import { createWorkspaceStore } from "../src/job/workspace.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { RUN_ID, makeFake, makeRig } from "./engines/claude/rig.js";
import { KEYRING, NOW, signRaw, signedJob } from "./helpers/signedJob.js";

/**
 * D#600 CX-5c, acceptance 1 and 2 over the real job runner, the real engine and the host tier (a fake binary stands in for the CLI): a job signed with the
 * `excludes` field gets Read, Grep and Glob deny entries in the daemon's settings file; an older job without the field gets the settings it always did; a
 * job altered after signing is refused before anything runs.
 */
const EXCLUDES = ["secret/a.txt", "keys", "src/**/[ab].ts"];
/** An entry of the protected-path floor: `Read(//abs/path)` or `Edit(//abs/path)`. */
const isFloorEntry = (rule: string): boolean => /^(Read|Edit)\(\/\/.+\)$/.test(rule);

async function runWith(job: Job, resume = false) {
  const fake = makeFake();
  const rig = makeRig({ fake });
  const stateDir = path.join(rig.root, "state");
  const host = createHostSandbox({
    credentials: { mode: "subscription" },
    makeRuntime: (sandbox, protectedList) => createClaudeEngine({ ...rig.config, sandboxSettings: sandbox, protectedPaths: protectedList }),
    home: rig.root,
    stateDir,
    binaryDir: path.dirname(fake.binary),
    tempRoot: path.join(rig.root, "tmp"),
    workspaceRoot: path.join(rig.root, "work"),
  });
  const workspaces = createWorkspaceStore(path.join(rig.root, "work"));
  // A continuing job resumes the session this machine kept, in the workspace it kept.
  const kept = resume ? await workspaces.create(RUN_ID) : "";
  const continues = resume ? { parent_run_id: "33333333-3333-4333-8333-333333333333", session_id: "sess-0001", branch: "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1" } : null;
  const out = await runJob({ ...job, job_id: "22222222-2222-4222-8222-222222222222", run_id: RUN_ID, continues, model_hint: null }, { sandbox: host, workspaces, ledger: createMemoryLedger(), credentials: { mode: "subscription" }, planSession: () => (resume ? { kind: "resume", sessionId: "sess-0001", workspace: kept } : { kind: "fresh", branch: null }), defaultModel: "sonnet" });
  const settings = (): { permissions: { deny: string[] } } => JSON.parse(readFileSync(path.join(rig.config.jobsDir, RUN_ID, "settings.json"), "utf8"));
  return { out, rig, fake, settings };
}

describe("D#600 CX-5c: a signed job's excludes through the job runner", () => {
  it("acceptance 1: a job signed with the field gets the deny entries in the settings file, and the prompt says so exactly once", async () => {
    const job = verifyJob(signedJob({ excludes: EXCLUDES }), KEYRING, { now: NOW });
    expect(job.excludes).toEqual(EXCLUDES);
    const { out, fake, settings } = await runWith(job);
    expect(out.status).toBe("done");
    const deny = settings().permissions.deny;
    const wanted = excludeDenyRules(EXCLUDES);
    // The exclude entries come last, after the protected-path floor (every floor entry is an anchored absolute path).
    expect(deny.slice(-wanted.length)).toEqual(wanted);
    expect(deny.slice(0, -wanted.length).every(isFloorEntry)).toBe(true);
    expect(deny.length).toBeGreaterThan(wanted.length);
    expect(fake.stdin().split(EXCLUDE_PROMPT_LINE)).toHaveLength(2);
    // The line sits before the untrusted block, as runner text.
    expect(fake.stdin().indexOf(EXCLUDE_PROMPT_LINE)).toBeLessThan(fake.stdin().indexOf("<untrusted>"));
  });

  it("acceptance 1, golden: an older job without the field gets the settings it always got, and no prompt line", async () => {
    const job = verifyJob(signedJob(), KEYRING, { now: NOW });
    expect("excludes" in job).toBe(false);
    const { out, fake, settings } = await runWith(job);
    expect(out.status).toBe("done");
    expect(settings().permissions.deny.every(isFloorEntry)).toBe(true);
    expect(settings().permissions.deny).not.toContain("Grep");
    expect(settings().permissions.deny).not.toContain("Glob");
    expect(fake.stdin()).not.toContain(EXCLUDE_PROMPT_LINE);
  });

  it("acceptance 2: a job with the field altered after signing is refused before anything runs", () => {
    const signed = signedJob({ excludes: EXCLUDES });
    const alterations: Array<(job: Record<string, unknown>) => Record<string, unknown>> = [
      (job) => ({ ...job, excludes: ["secret/a.txt"] }),
      (job) => ({ ...job, excludes: [...(job.excludes as string[]), "extra"] }),
      (job) => ({ ...job, excludes: [...(job.excludes as string[])].reverse() }),
      (job) => Object.fromEntries(Object.entries(job).filter(([key]) => key !== "excludes")),
    ];
    for (const alter of alterations) {
      const altered = { ...signed, job: alter(signed.job as unknown as Record<string, unknown>) };
      expect(() => verifyJob(altered, KEYRING, { now: NOW })).toThrow(JobSignatureError);
    }
    // A job the cloud would never sign (a path that cannot be a rule) is refused at the schema even when it is validly signed.
    expect(() => verifyJob(signRaw({ ...(signed.job as object), excludes: ["../outside"] }), KEYRING, { now: NOW })).toThrow(JobSignatureError);
  });

  it("a continuing job (a fix round that resumes a kept session) still writes the deny entries: runJob hands them to the host tier's resume path", async () => {
    const job = verifyJob(signedJob({ excludes: EXCLUDES }), KEYRING, { now: NOW });
    const { out, fake, settings } = await runWith(job, true);
    expect(out.status).toBe("done");
    expect(fake.argv().slice(-2)).toEqual(["--resume", "sess-0001"]);
    const deny = settings().permissions.deny;
    const wanted = excludeDenyRules(EXCLUDES);
    expect(deny.slice(-wanted.length)).toEqual(wanted);
    expect(fake.stdin().split(EXCLUDE_PROMPT_LINE)).toHaveLength(2);
  });

  it("a continuing job without excludes writes none (golden)", async () => {
    const { out, fake, settings } = await runWith(verifyJob(signedJob(), KEYRING, { now: NOW }), true);
    expect(out.status).toBe("done");
    expect(fake.argv().slice(-2)).toEqual(["--resume", "sess-0001"]);
    expect(settings().permissions.deny.every(isFloorEntry)).toBe(true);
  });

  it("fails closed in the runner too: a job whose list cannot be written never starts the agent", async () => {
    const job = { ...verifyJob(signedJob(), KEYRING, { now: NOW }), excludes: ["fine", "../outside"] } as Job;
    const { out, fake } = await runWith(job);
    expect(out.status).toBe("failed");
    expect(fake.calls().some((call) => call.startsWith("-p"))).toBe(false);
  });

  it("the exclude paths are not written anywhere the run leaves behind but the job's own settings file and the raw log's prompt", async () => {
    const job = verifyJob(signedJob({ excludes: ["PLANTED-EXCLUDE-3d7f/secret.txt"] }), KEYRING, { now: NOW });
    const { out, rig } = await runWith(job);
    expect(out.status).toBe("done");
    // The metadata-only events leave this machine; the paths must not be in them (the paths are the person's, and they came from the cloud: nothing is sent back).
    const logs = readFileSync(path.join(rig.config.logDir, `${RUN_ID}.jsonl`), "utf8");
    expect(logs).not.toContain("PLANTED-EXCLUDE-3d7f");
  });
});
