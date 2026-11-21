import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanEnv } from "../../src/job/cleanEnv.js";
import { createHostSandbox } from "../../src/sandbox/hostSandbox.js";
import { createDaemonSdk, sandboxIdOf } from "../../src/vm/sandboxd/sdkAdapter.js";
import { createMicrovmSandbox } from "../../src/vm/sandboxd/microvmSandbox.js";
import { scriptedRuntime } from "../sandboxPortContract.js";
import { makeRig, runCleanups } from "../vm/sandboxd/helpers.js";
import { ALLOWED_DIFFERENCES, describeEngineContract, type Difference } from "./engineContract.js";

afterEach(runCleanups);

const MICROVM_DIFFERENCES: ReadonlySet<Difference> = new Set<Difference>(["publishCalls", "idleState", "usageFigures", "lossShape", "jobEnv"]);

describeEngineContract(
  "host engine (stub agent runtime)",
  (runtime) => {
    const host = createHostSandbox({
      credentials: { mode: "subscription" },
      makeRuntime: () => runtime,
      home: "/home/contract-user",
      stateDir: mkdtempSync(path.join(tmpdir(), "b5a_state-")),
      binaryDir: "/opt/claude/bin",
      tempRoot: mkdtempSync(path.join(tmpdir(), "b5a_temp-")),
      workspaceRoot: tmpdir(),
    });
    return {
      port: host,
      env: () => cleanEnv({ mode: "subscription" }),
      workdir: mkdtempSync(path.join(tmpdir(), "b5a_work-")),
      timeoutMsOf: (handle) => host.timeoutMsOf(handle),
      interrupt: (handle) => host.interrupt(handle),
      lose: (handle) => host.deleteSandbox(handle),
    };
  },
  new Set<Difference>(),
);

describeEngineContract(
  "microVM engine (daemon with the B-2b real-contract fakes)",
  (runtime) => {
    const rig = makeRig({ readOnlyRoot: true }); // as the guest image is: only its tmpfs mounts take a write
    const sdk = createDaemonSdk({ daemon: rig.daemon, policy: { apply: async () => undefined, release: async () => undefined }, template: "fx-agent", memMb: 256 });
    const port = createMicrovmSandbox({ sdk, makeRuntime: () => runtime });
    return {
      port,
      env: () => ({}),
      workdir: "/work/job",
      timeoutMsOf: (handle) => port.timeoutMsOf(handle),
      interrupt: (handle) => port.interrupt(handle),
      lose: async (handle) => sdk.deleteById(sandboxIdOf(handle.sandboxName)),
      guestFile: (_handle, file) => [...rig.agents.values()][0]?.files.get(file),
    };
  },
  MICROVM_DIFFERENCES,
);

describe("the allowed differences", () => {
  it("each carries a reason, and the microVM engine declares every one the suite knows (the host engine is the baseline and declares none)", () => {
    for (const [name, reason] of Object.entries(ALLOWED_DIFFERENCES)) expect(reason.length, name).toBeGreaterThan(40);
    expect([...MICROVM_DIFFERENCES].sort()).toEqual(Object.keys(ALLOWED_DIFFERENCES).sort());
  });
});

describe("losing a sandbox by name when the daemon holds others (the real-VM suite shares one daemon between its tests)", () => {
  it("removes the named sandbox only, so a resume of that one is `SandboxNotFoundError` and the older one is untouched", async () => {
    const rig = makeRig();
    const sdk = createDaemonSdk({ daemon: rig.daemon, policy: { apply: async () => undefined, release: async () => undefined }, template: "fx-agent", memMb: 256 });
    const port = createMicrovmSandbox({ sdk, makeRuntime: () => scriptedRuntime() });
    const older = await port.createSandbox({ sandboxName: "e-older", retention: { persistent: false }, timeoutMs: 60_000 });
    const lost = await port.createSandbox({ sandboxName: "e-lost", retention: { persistent: false }, timeoutMs: 60_000 });
    expect(rig.daemon.list()[0]?.name).toBe(sandboxIdOf("e-older")); // what a "first listed" pick would have removed
    await sdk.deleteById(sandboxIdOf(lost.sandboxName));
    expect(await port.sandboxExists(lost)).toBe(false);
    expect(await port.sandboxExists(older)).toBe(true);
  });
});
