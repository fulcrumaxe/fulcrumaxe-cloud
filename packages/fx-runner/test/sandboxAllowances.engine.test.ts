import { readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { withAllowances } from "../src/daemon/jobHandler.js";
import { createClaudeKit } from "../src/engines/claude/kit.js";
import { createMemoryLedger, runJob } from "../src/job/runJob.js";
import { createWorkspaceStore } from "../src/job/workspace.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { RUN_ID, makeFake, makeRig } from "./engines/claude/rig.js";
import { sampleJob } from "./helpers/sampleJob.js";

/**
 * D#6 R7b: a unit test that `command_timeout_s` reaches the engine's settings, over the whole path with nothing stubbed between the parts: the
 * job handler's port wrapper, the real host tier, the real kit and engine, and a fake binary that records what it was started with. The live
 * proof of how the installed CLI reads the variables is R7e's and the executor's own live run (a model turn); this proves they reach it.
 */
async function runWith(allowances: boolean) {
  const fake = makeFake();
  const rig = makeRig({ fake });
  const stateDir = path.join(rig.root, "state");
  const kit = createClaudeKit(spawn);
  const host = createHostSandbox({
    credentials: { mode: "subscription" },
    makeRuntime: (sandbox, protectedList, jobEnv) =>
      kit.makeRuntime({ binaryPath: fake.binary, credentials: { mode: "subscription" }, envOptions: {}, sandboxSettings: sandbox, protectedPaths: protectedList, stateDir, onLocalEvent: () => undefined, ...(jobEnv === undefined ? {} : { jobEnv }) }),
    home: path.join(rig.root, "home"),
    stateDir,
    binaryDir: path.dirname(fake.binary),
    tempRoot: path.join(rig.root, "tmp"),
    workspaceRoot: path.join(rig.root, "work"),
    packageStoreRoot: path.join(rig.root, "pnpm-store"),
  });
  const sandbox = allowances
    ? withAllowances(host, { entries: [{ kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "install" }], commandTimeoutS: 1500, storeKey: "acme__widgets" })
    : host;
  const job = { ...sampleJob(), job_id: "33333333-3333-4333-8333-333333333333", run_id: RUN_ID, continues: null, model_hint: null };
  const out = await runJob(job, { sandbox, workspaces: createWorkspaceStore(path.join(rig.root, "work")), ledger: createMemoryLedger(), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" });
  const jobDir = path.join(stateDir, "jobs", RUN_ID);
  return { out, env: fake.envText(), settings: JSON.parse(readFileSync(path.join(jobDir, "settings.json"), "utf8")) as { sandbox: { network: { allowedDomains: string[] } } }, rig };
}

describe("R7b: a job with allowances reaches the engine", () => {
  it("the agent starts with the timeout in milliseconds, the repo's store and a cache directory under the job's temp directory; its settings name the domain", async () => {
    const { out, env, settings, rig } = await runWith(true);
    expect(out).toMatchObject({ status: "done" });
    expect(env).toContain("BASH_DEFAULT_TIMEOUT_MS=1500000");
    expect(env).toContain("BASH_MAX_TIMEOUT_MS=1500000");
    expect(env).toContain(`npm_config_store_dir=${path.join(rig.root, "pnpm-store", "acme__widgets")}`);
    expect(env).toContain("npm_config_verify_store_integrity=true");
    expect(env).toMatch(new RegExp(`XDG_CACHE_HOME=${path.join(rig.root, "tmp").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/rn-[^/\\n]+/xdg-cache`));
    expect(settings.sandbox.network.allowedDomains).toEqual(["api.anthropic.com", "registry.npmjs.org"]);
  });

  it("a job without them starts with none of it: the same environment as before this change", async () => {
    const { out, env, settings } = await runWith(false);
    expect(out).toMatchObject({ status: "done" });
    for (const name of ["BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS", "npm_config_store_dir", "XDG_CACHE_HOME", "npm_config_verify_store_integrity"]) expect(env, name).not.toContain(`${name}=`);
    expect(settings.sandbox.network.allowedDomains).toEqual(["api.anthropic.com"]);
  });
});
