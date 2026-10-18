import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Text, trimmedMarker, type Job, type NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import { createJobHandler, withSpillDir, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { recordSession } from "../../src/engines/claude/session.js";
import { runJob, type RunJobDeps } from "../../src/job/runJob.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import type { SandboxPort, StartDetachedOptions } from "../../src/sandbox/port.js";
import { generateRunnerKey } from "../../src/keys.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { jobFor, KEYRING, signRaw } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/**
 * D#600 CX-4b in the job handler: a job's spill is written before the agent starts, its markers point at the run's own files, the agent's tools are given that one
 * directory and nothing else, the files go with the run, and nothing of the spill (text or path) is ever in a request body to the cloud (C8). A spill that cannot be
 * written ends the run before any sandbox exists. Planted text and paths stand for private content that must stay on the machine.
 */
const BASE = "c".repeat(40);
const NEEDLE = "PLANTED-private-finding-needle";
const FINDINGS = `src/${NEEDLE}.ts:3 - the full reviewer text, long and private\n`.repeat(30);
const NOTE = "PLANTED-note-secret ".repeat(40);

let cloud: StrictRunnerCloud;
let root: string;
let spillRoot: string;
let rigs = 0;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxr-spillhandler-"));
  spillRoot = path.join(root, "cache", "spill");
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

const clock: Clock = { now: () => new Date(), sleep: (ms, signal) => new Promise<void>((resolve) => { if (signal.aborted) return resolve(); const t = setTimeout(resolve, Math.min(ms, 1)); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); }) };

function rig(over: { spillRoot?: string | "absent"; end?: "done" | "throws" } = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const starts: StartDetachedOptions[] = [];
  /** What the spill directory held at the moment the agent was started. */
  const seenAtStart: Array<Record<string, string> | null> = [];
  let created = 0;
  const port: SandboxPort = {
    async createSandbox(opts) { created++; return { runId: "", sandboxName: opts.sandboxName }; },
    startDetached: (handle, opts) => {
      starts.push(opts);
      if (opts.spillDir === undefined) seenAtStart.push(null);
      else seenAtStart.push(Object.fromEntries(readdirSync(opts.spillDir).map((name) => [name, readFileSync(path.join(opts.spillDir!, name), "utf8")])));
      if (over.end === "throws") throw new Error("agent start failed");
      const event = { runId: opts.runId, role: opts.role, seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" } } as NormalizedEvent;
      return { handle, hookFired: Promise.resolve(event) };
    },
    resume: () => { throw new Error("not used"); },
    async extendTimeout() {}, async stop() {}, async deleteSandbox() {}, async measure() { return []; }, async readCounters() { return undefined; }, async writeFiles() {}, async runCommand(): Promise<never> { throw new Error("not used"); }, async sandboxExists() { return true; },
  };
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" };
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, `jobs-${++rigs}.json`), ledgerOptions()), git: fakeGitPath({ prepare: async () => ({ base: BASE }) }), events: createEventRelay(),
    recordSession: (id, workspace) => recordSession(path.join(root, "sessions.json"), id, workspace), heartbeatMs: 1e9, flushMs: 1e9, runJobFn: runJob,
    ...(over.spillRoot === "absent" ? {} : { spillRoot: over.spillRoot ?? spillRoot }),
  };
  return {
    starts, seenAtStart, created: () => created, handle: createJobHandler(deps),
    async claim(job: Job): Promise<Claimed> {
      cloud.enqueue(signRaw(job) as never);
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return claimed;
    },
  };
}

const spillJob = (over: Partial<Job> = {}): Job => {
  const prompt = `Fix the findings.\nFINDINGS:\nshort cut\n${trimmedMarker("findings")}\nNOTE:\n${trimmedMarker("note")}\n`;
  return jobFor({
    task: { kind: "fix", prompt, prompt_sha256: sha256Text(prompt) },
    spill: [{ code: "findings", text: FINDINGS }, { code: "note", text: NOTE }],
    ...over,
  });
};
const runEnded = (): Array<{ reason: string; detail?: string }> => cloud.seen.flatMap((s) => ((s.body as { events?: Array<{ type: string; reason: string; detail?: string }> } | undefined)?.events ?? []).filter((e) => e.type === "run_ended")) as never;

describe("a job with a spill (acceptance 1)", () => {
  it("writes the files before the agent starts, with the full text, and the agent's prompt points at them (not at the sandbox's path)", async () => {
    const r = rig();
    const job = spillJob();
    expect((await r.handle(await r.claim(job))).status).toBe("completed");
    const dir = path.join(spillRoot, job.run_id);
    expect(r.seenAtStart[0]).toEqual({ "findings.md": FINDINGS, "note.md": NOTE });
    const prompt = r.starts[0]!.prompt;
    expect(prompt).toContain(`[trimmed: full text at ${path.join(dir, "findings.md")}]`);
    expect(prompt).toContain(`[trimmed: full text at ${path.join(dir, "note.md")}]`);
    expect(prompt).not.toContain("/fx/context/");
    expect(prompt).toContain("short cut");
    // The signed text was hashed as sent; the rewrite is on the copy the agent gets.
    expect(job.task.prompt).toContain("/fx/context/findings.md");
  });

  it("gives the agent that one directory to read (the shell sandbox grant and the file tools' rule) and no other", async () => {
    const r = rig();
    const job = spillJob();
    await r.handle(await r.claim(job));
    const dir = path.join(spillRoot, job.run_id);
    expect(r.starts[0]!.spillDir).toBe(dir);
    expect(r.starts[0]!.extraReadPaths).toContain(dir);
    expect(r.starts[0]!.extraReadPaths).not.toContain(spillRoot);
  });

  it("removes the run's directory when the run ends, and the root stays", async () => {
    const r = rig();
    const job = spillJob();
    await r.handle(await r.claim(job));
    expect(existsSync(path.join(spillRoot, job.run_id))).toBe(false);
    expect(existsSync(spillRoot)).toBe(true);
  });

  it("removes it when the agent cannot start too (the undo path on failure)", async () => {
    const r = rig({ end: "throws" });
    const job = spillJob();
    expect((await r.handle(await r.claim(job))).status).toBe("failed");
    expect(existsSync(path.join(spillRoot, job.run_id))).toBe(false);
  });

  it("the spill text and the spill path are in no request body to the cloud, in any event or in done (the C8 walk)", async () => {
    const r = rig();
    const job = spillJob();
    expect((await r.handle(await r.claim(job))).status).toBe("completed");
    const bodies = JSON.stringify(cloud.seen.map((s) => s.body));
    for (const needle of [NEEDLE, "PLANTED-note-secret", "full reviewer text", spillRoot, job.run_id + "/findings", "findings.md", "note.md", root]) expect(bodies, needle).not.toContain(needle);
  });
});

describe("a spill that cannot be made ends the run before anything starts (acceptance: no dangling marker)", () => {
  it("no spill root configured: no sandbox, no agent, run_ended runner_setup / context_spill_unwritable", async () => {
    const r = rig({ spillRoot: "absent" });
    const result = await r.handle(await r.claim(spillJob()));
    expect(result).toEqual({ status: "failed", reason: "context_spill_unwritable" });
    expect(r.created()).toBe(0);
    expect(r.starts).toEqual([]);
    expect(runEnded()).toEqual([{ type: "run_ended", reason: "runner_setup", detail: "context_spill_unwritable", seq: expect.any(Number), ts: expect.any(String) }]);
  });

  it("a symlinked spill root: refused, nothing written through it, no agent", async () => {
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    mkdirSync(path.dirname(spillRoot), { recursive: true });
    symlinkSync(outside, spillRoot);
    const r = rig();
    expect((await r.handle(await r.claim(spillJob()))).status).toBe("failed");
    expect(readdirSync(outside)).toEqual([]);
    expect(r.starts).toEqual([]);
    expect(runEnded().map((e) => e.detail)).toEqual(["context_spill_unwritable"]);
  });

  it("a marker for a code the job has no text for: refused, and no file is written", async () => {
    const prompt = `Fix.\n${trimmedMarker("findings")}\n${trimmedMarker("map")}\n`;
    const job = spillJob({ task: { kind: "fix", prompt, prompt_sha256: sha256Text(prompt) } });
    const r = rig();
    expect((await r.handle(await r.claim(job))).status).toBe("failed");
    expect(r.starts).toEqual([]);
    expect(existsSync(path.join(spillRoot, job.run_id))).toBe(false);
  });

  it("a spill entry outside the closed list never reaches the writer: the signed job is refused by the schema, nothing is written", async () => {
    const job = spillJob({ spill: [{ code: "../outside", text: "x" }] as never });
    const r = rig();
    const claimed = await r.claim(job).catch(() => undefined);
    if (claimed !== undefined) expect((await r.handle(claimed)).status).not.toBe("completed");
    expect(r.starts).toEqual([]);
    expect(existsSync(spillRoot)).toBe(false);
  });
});

describe("a job without a spill is unchanged (additive)", () => {
  it("writes nothing, grants nothing, and starts exactly as before", async () => {
    const r = rig();
    const job = jobFor();
    expect((await r.handle(await r.claim(job))).status).toBe("completed");
    expect(r.starts[0]!.spillDir).toBeUndefined();
    expect(r.starts[0]!.extraReadPaths ?? []).toEqual([]);
    expect(existsSync(spillRoot)).toBe(false);
    expect(r.starts[0]!.prompt).toContain(job.task.prompt.trim());
  });

  it("a job whose text merely quotes a marker, with no spill, is not refused", async () => {
    const prompt = `The Spec says the prompt shows ${trimmedMarker("note")} where text was cut.\n`;
    const r = rig({ spillRoot: "absent" });
    expect((await r.handle(await r.claim(jobFor({ task: { kind: "implement", prompt, prompt_sha256: sha256Text(prompt) } })))).status).toBe("completed");
  });

  it("withSpillDir hands back the same port when there is no directory, and carries it on a start and a resume otherwise", () => {
    const port = {} as SandboxPort;
    expect(withSpillDir(port, undefined)).toBe(port);
    const seen: StartDetachedOptions[] = [];
    const wrapped = withSpillDir({ startDetached: (_h: never, o: StartDetachedOptions) => (seen.push(o), {} as never), resume: (_h: never, _s: string, _p: string, o: StartDetachedOptions) => (seen.push(o), {} as never) } as unknown as SandboxPort, "/d");
    wrapped.startDetached({} as never, { extraReadPaths: ["/m"] } as never);
    wrapped.resume({} as never, "s", "p", {} as never);
    expect(seen.map((o) => [o.spillDir, o.extraReadPaths])).toEqual([["/d", ["/m", "/d"]], ["/d", ["/d"]]]);
  });
});
