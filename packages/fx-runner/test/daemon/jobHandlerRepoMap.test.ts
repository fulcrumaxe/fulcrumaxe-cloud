import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { recordSession } from "../../src/engines/claude/session.js";
import { repoMapDigest } from "../../src/job/repoMap.js";
import { roleToolsDigest } from "../../src/job/roleTools.js";
import { runJob, type RunJobDeps } from "../../src/job/runJob.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import type { SandboxPort, StartDetachedOptions } from "../../src/sandbox/port.js";
import { generateRunnerKey } from "../../src/keys.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { jobFor, KEYRING, signRaw } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/**
 * D#600 CX-3b in the job handler: which jobs get the repository map, that it reaches the agent and nothing else, and that all the cloud ever hears
 * of it is its byte count and sha256. Planted path names stand for repository text that must stay on the machine (C8 section 6).
 */
const BASE = "c".repeat(40);
const NEEDLE_DIR = "PLANTED-private-client-name";
const MAP_TEXT = ["commit: cccccccccccc", "test command: npm test", "files:", `${NEEDLE_DIR}/src/secret-roadmap.ts`, "README.md"].join("\n");
const BRANCH = "fx/33333333-3333-4333-8333-333333333333-g1";

let cloud: StrictRunnerCloud;
let root: string;
let rigs = 0;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxr-maphandler-"));
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

const clock: Clock = { now: () => new Date(), sleep: (ms, signal) => new Promise<void>((resolve) => { if (signal.aborted) return resolve(); const t = setTimeout(resolve, Math.min(ms, 1)); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); }) };

function rig(over: { repoMap?: ((sha: string) => Promise<{ version: string; text: string } | null>) | "absent"; skips?: string[]; withLedger?: boolean } = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const starts: StartDetachedOptions[] = [];
  const port: SandboxPort = {
    async createSandbox(opts) { return { runId: "", sandboxName: opts.sandboxName }; },
    startDetached: (handle, opts) => {
      starts.push(opts);
      const measure = { basis: "measured", first_turn_input_tokens: 100, peak_context_tokens: 400, cache_read_tokens: 10, cache_write_tokens: 20, tool_output_bytes: {}, compactions: 0 } as const;
      const event = { runId: opts.runId, role: opts.role, seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" }, ...(over.withLedger === false ? {} : { contextLedger: measure }) } as NormalizedEvent;
      return { handle, hookFired: Promise.resolve(event) };
    },
    resume: () => { throw new Error("not used"); },
    async extendTimeout() {}, async stop() {}, async deleteSandbox() {}, async measure() { return []; }, async readCounters() { return undefined; }, async writeFiles() {}, async runCommand(): Promise<never> { throw new Error("not used"); }, async sandboxExists() { return true; },
  };
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" };
  const asked: string[] = [];
  const git = fakeGitPath({ prepare: async () => ({ base: BASE }) });
  if (over.repoMap !== "absent") {
    const build = over.repoMap ?? (async () => ({ version: "1", text: MAP_TEXT }));
    git.repoMap = async (_job, sha) => {
      asked.push(sha);
      return build(sha);
    };
  }
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, `jobs-${++rigs}.json`), ledgerOptions()), git, events: createEventRelay(),
    recordSession: (id, workspace) => recordSession(path.join(root, "sessions.json"), id, workspace), heartbeatMs: 1e9, flushMs: 1e9, runJobFn: runJob,
    onRepoMapSkip: (reason) => over.skips?.push(reason),
  };
  return {
    starts, asked, handle: createJobHandler(deps),
    async claim(job: ReturnType<typeof jobFor>): Promise<Claimed> {
      cloud.enqueue(signRaw(job) as never);
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return claimed;
    },
  };
}

const doneBody = (): { context_ledger?: { sections: Array<{ code: string; bytes: number; sha256: string; trimmed_bytes: number }> } } =>
  cloud.seen.filter((s) => (s.body as { context_ledger?: unknown } | undefined)?.context_ledger !== undefined).at(-1)?.body as never;

describe("D#600 CX-3b: the repository map in the job handler", () => {
  it("a first executor run is asked for the map of the commit it starts from, and the agent's prompt carries it inside the untrusted block", async () => {
    const r = rig();
    expect((await r.handle(await r.claim(jobFor()))).status).toBe("completed");
    expect(r.asked).toEqual([BASE]);
    const prompt = r.starts[0]!.prompt;
    expect(prompt).toContain(`${NEEDLE_DIR}/src/secret-roadmap.ts`);
    expect(prompt.indexOf("REPOSITORY MAP (version 1):")).toBeGreaterThan(prompt.indexOf("<untrusted>"));
    expect(prompt.indexOf("README.md")).toBeLessThan(prompt.indexOf("Implement the change."));
  });

  it("the cloud hears the map's byte count and sha256 in the ledger's map section, and none of its text or paths in any request body (the C8 walk)", async () => {
    const r = rig();
    expect((await r.handle(await r.claim(jobFor()))).status).toBe("completed");
    expect(doneBody().context_ledger!.sections).toEqual([{ code: "map", ...repoMapDigest(MAP_TEXT), trimmed_bytes: 0 }]);
    const bodies = JSON.stringify(cloud.seen.map((s) => s.body));
    for (const needle of [NEEDLE_DIR, "secret-roadmap", "README.md", "npm test", "files:"]) expect(bodies).not.toContain(needle);
    expect(bodies).toContain(repoMapDigest(MAP_TEXT).sha256);
  });

  it("a fix round gets no map and is not asked for one; nor does any role but the executor", async () => {
    const fix = rig();
    expect((await fix.handle(await fix.claim(jobFor({ continues: { parent_run_id: "33333333-3333-4333-8333-333333333333", session_id: "s1", branch: BRANCH } })))).status).toBe("completed");
    expect(fix.asked).toEqual([]);
    expect(fix.starts[0]!.prompt).not.toContain("REPOSITORY MAP");

    const docs = rig();
    expect((await docs.handle(await docs.claim(jobFor({ role: "docs-writer", role_tools_sha256: roleToolsDigest("docs-writer") })))).status).toBe("completed");
    expect(docs.asked).toEqual([]);
    expect(docs.starts[0]!.prompt).not.toContain("REPOSITORY MAP");
  });

  it("a map that cannot be built (null) leaves the run going without one, says why in one closed word, and sends no map section", async () => {
    const skips: string[] = [];
    const r = rig({ repoMap: async () => null, skips });
    expect((await r.handle(await r.claim(jobFor()))).status).toBe("completed");
    expect(skips).toEqual(["unavailable"]);
    expect(r.starts[0]!.prompt).not.toContain("REPOSITORY MAP");
    expect(doneBody().context_ledger!.sections).toEqual([]);
  });

  it("a map that throws is the same: the run goes on, and the error text (it could hold a path) goes nowhere", async () => {
    const skips: string[] = [];
    const r = rig({ repoMap: async () => { throw new Error(`/home/victim/${NEEDLE_DIR}`); }, skips });
    expect((await r.handle(await r.claim(jobFor()))).status).toBe("completed");
    expect(skips).toEqual(["unavailable"]);
    expect(JSON.stringify(cloud.seen.map((s) => s.body))).not.toContain(NEEDLE_DIR);
  });

  it("a git path with no mirror to read (path A) gives no map, and the run is unchanged", async () => {
    const skips: string[] = [];
    const r = rig({ repoMap: "absent", skips });
    expect((await r.handle(await r.claim(jobFor()))).status).toBe("completed");
    expect(skips).toEqual(["no_mirror"]);
    expect(r.starts[0]!.prompt).not.toContain("REPOSITORY MAP");
  });

  it("an older cloud shape is untouched: a run that measured nothing sends no ledger at all, map or not", async () => {
    const r = rig({ withLedger: false });
    expect((await r.handle(await r.claim(jobFor()))).status).toBe("completed");
    expect(r.asked).toEqual([BASE]);
    expect(doneBody()).toBeUndefined();
  });
});
