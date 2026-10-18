import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
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
 * D#601 MEM-3b in the job handler: a signed job that carries memory is claimed, verified and run, the agent's prompt holds the memory where the runner puts it, and
 * nothing of it goes back to the cloud or onto the disk (C8 section 6). Planted strings stand for memory text that must stay in the prompt.
 */
const BASE = "c".repeat(40);
const PERSON = "PLANTED-PERSON-MEMORY-77aa use pnpm";
const FENCED = "PLANTED-FENCED-MEMORY-99bb an agent wrote this";
const SECRET = ["ghs_", "PLANTEDINSTALLATIONTOKEN0123456789abcd"].join("");
const NEEDLES = ["PLANTED-PERSON-MEMORY-77aa", "PLANTED-FENCED-MEMORY-99bb", "an agent wrote this", SECRET];

let cloud: StrictRunnerCloud;
let root: string;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxr-memhandler-"));
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

const clock: Clock = { now: () => new Date(), sleep: (ms, signal) => new Promise<void>((resolve) => { if (signal.aborted) return resolve(); const t = setTimeout(resolve, Math.min(ms, 1)); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); }) };

function rig() {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const starts: StartDetachedOptions[] = [];
  const port: SandboxPort = {
    async createSandbox(opts) { return { runId: "", sandboxName: opts.sandboxName }; },
    startDetached: (handle, opts) => {
      starts.push(opts);
      const event = { runId: opts.runId, role: opts.role, seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" } } as NormalizedEvent;
      return { handle, hookFired: Promise.resolve(event) };
    },
    resume: () => { throw new Error("not used"); },
    async extendTimeout() {}, async stop() {}, async deleteSandbox() {}, async measure() { return []; }, async readCounters() { return undefined; }, async sandboxExists() { return true; },
  };
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" };
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, "jobs.json"), ledgerOptions()), git: fakeGitPath({ prepare: async () => ({ base: BASE }) }), events: createEventRelay(),
    recordSession: (id, workspace) => recordSession(path.join(root, "sessions.json"), id, workspace), heartbeatMs: 1e9, flushMs: 1e9, runJobFn: runJob,
  };
  return {
    starts, client, handle: createJobHandler(deps),
    async claim(job: ReturnType<typeof jobFor>): Promise<Claimed> {
      cloud.enqueue(signRaw(job) as never);
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return claimed;
    },
  };
}

function everyFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return everyFile(full);
    return lstatSync(full).isFile() ? [full] : [];
  });
}

describe("D#601 MEM-3b: memory in the job handler", () => {
  it("runs a job that carries memory: the person's lines come before the untrusted block, the fenced lines are inside it", async () => {
    const r = rig();
    expect((await r.handle(await r.claim(jobFor({ memory: { person: PERSON, fenced: FENCED } })))).status).toBe("completed");
    const prompt = r.starts[0]!.prompt;
    expect(prompt.indexOf(PERSON)).toBeGreaterThan(prompt.indexOf("You are the executor."));
    expect(prompt.indexOf(PERSON)).toBeLessThan(prompt.indexOf("<untrusted>"));
    expect(prompt.indexOf(FENCED)).toBeGreaterThan(prompt.indexOf("<untrusted>"));
    expect(prompt.indexOf(FENCED)).toBeLessThan(prompt.indexOf("Implement the change."));
  });

  it("a job whose memory has an extra key is refused by the strict parse and starts nothing", async () => {
    const r = rig();
    cloud.enqueue(signRaw({ ...jobFor({ memory: { person: PERSON, fenced: FENCED } }), memory: { person: PERSON, fenced: FENCED, extra: "x" } }) as never);
    const outcome = await r.client.claim().then((claimed) => claimed.kind, () => "refused");
    expect(outcome).not.toBe("claimed");
    expect(r.starts).toEqual([]);
  });

  it("no request body to the cloud and no file under the runner's directories holds the memory text (the C8 walk)", async () => {
    const r = rig();
    expect((await r.handle(await r.claim(jobFor({ memory: { person: PERSON, fenced: `${FENCED} ${SECRET}` } })))).status).toBe("completed");
    // Control: the text did reach the agent.
    expect(r.starts[0]!.prompt).toContain(PERSON);
    expect(r.starts[0]!.prompt).toContain(SECRET);
    const bodies = JSON.stringify(cloud.seen.map((s) => s.body));
    expect(cloud.seen.length).toBeGreaterThan(0);
    for (const needle of NEEDLES) expect(bodies).not.toContain(needle);
    const files = everyFile(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = readFileSync(file);
      for (const needle of NEEDLES) expect(bytes.includes(Buffer.from(needle, "utf8")), `${file} holds ${needle}`).toBe(false);
    }
  });
});
