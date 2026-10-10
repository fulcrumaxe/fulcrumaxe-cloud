import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "@fulcrumaxe/runner-protocol";
import { buildSandboxEnv, createFakeSandbox, type SandboxPort } from "@fx/runner";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import type { SandboxPort as FxSandboxPort } from "../src/sandbox/port.js";
import { describeSandboxPortContract } from "./sandboxPortContract.js";

// The two copies of the port must stay assignable to each other. If either side drifts, `tsc` fails here.
const asReal = (port: FxSandboxPort): SandboxPort => port;
const asFx = (port: SandboxPort): FxSandboxPort => port;

/** The fake wraps the H04-style runtime whose `start` resolves when the run ends; the local engine's resolves when the process exists. */
const endsInStart = (runtime: AgentRuntime): AgentRuntime => ({
  ...runtime,
  start: async (opts) => {
    const started = await runtime.start(opts);
    await started.handle.done;
    return started;
  },
});

describeSandboxPortContract("fakeSandbox", (runtime) => {
  const fake = createFakeSandbox(endsInStart(runtime) as Parameters<typeof createFakeSandbox>[0]);
  return {
    port: asFx(fake.port),
    env: (role) => buildSandboxEnv(role as Parameters<typeof buildSandboxEnv>[0]),
    workdir: tmpdir(),
    afterDelete: (handle) => fake.failResumeWithNotFound(handle.sandboxName),
    timeoutMsOf: (handle) => (fake.state.created.find((c) => c.sandboxName === handle.sandboxName)?.timeoutMs ?? 0) + fake.state.extended.filter((e) => e.handle.sandboxName === handle.sandboxName).reduce((sum, e) => sum + e.additionalMs, 0),
  };
});

describeSandboxPortContract("hostSandbox", (runtime) => {
  const host = createHostSandbox({
    credentials: { mode: "subscription" },
    makeRuntime: () => runtime,
    home: "/home/contract-user",
    stateDir: mkdtempSync(path.join(tmpdir(), "r4b13_state-")),
    binaryDir: "/opt/claude/bin",
    tempRoot: mkdtempSync(path.join(tmpdir(), "r4b13_contract-")),
    workspaceRoot: tmpdir(),
  });
  return { port: host, env: () => cleanEnv({ mode: "subscription" }), workdir: mkdtempSync(path.join(tmpdir(), "r4b13_work-")), timeoutMsOf: (handle) => host.timeoutMsOf(handle) };
}, { reportsOutcomes: true });

describe("the two copies of the port", () => {
  it("are assignable in both directions (checked by tsc; this runs the assignments)", () => {
    const host = createHostSandbox({ credentials: { mode: "subscription" }, makeRuntime: () => { throw new Error("unused"); }, home: "/h", stateDir: "/h/.fx-runner", binaryDir: "/opt/bin", tempRoot: tmpdir(), workspaceRoot: tmpdir() });
    expect(asReal(host)).toBe(host);
  });
});
