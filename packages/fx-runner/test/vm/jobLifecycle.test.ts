import { describe, expect, it } from "vitest";
import { RUNNER_SETUP_DETAILS, runnerSetupText } from "@fulcrumaxe/runner-protocol";
import type { MicrovmCaps } from "../../src/vm/limits.js";
import { idOfRunner, sandboxIdOf, isRunnerIdPrefix, runnerIdPrefix } from "../../src/vm/sandboxd/sdkAdapter.js";
import {
  OPERATOR_LINE_UNSUPPORTED_FIELDS, StepRefusal, VM_JOB_CODES, VmRegistry, reapVms, runVmJob, vmCapBlock, vmPortOf,
  type TokenSlot, type VmJobDeps, type VmJobSteps, type VmPort,
} from "../../src/vm/jobLifecycle.js";

const SENTINEL_TOKEN = "SENTINEL-CREDENTIAL-VALUE-0001";
const SENTINEL_PATH = "/home/sentinel-user/secret-repo";
const SENTINEL_CMD = "curl --sentinel-command";
const caps = (maxVms = 1): MicrovmCaps => ({ maxVms, maxVcpus: 4, maxMemoryMb: 4096, snapshotDir: "/var/lib/fx/snap", snapshotQuotaBytes: 10 ** 12 });
const PREFIX = runnerIdPrefix("/tmp/fictional-runner-home-a");
const OWN = idOfRunner(PREFIX);

/** A fake helper that knows only ids: ending an id it does not hold changes nothing (the real one answers `unknown_sandbox`, which the live reap port counts as gone). */
function idHelper(initial: string[]): { held: Set<string>; log: string[]; list: () => Promise<string[]>; port: Pick<VmPort, "releaseEgress" | "delete"> } {
  const held = new Set(initial);
  const log: string[] = [];
  return {
    held,
    log,
    list: async () => [...held],
    port: {
      releaseEgress: async (id) => void log.push(`release ${id}`),
      delete: async (id) => {
        log.push(`delete ${id}`);
        held.delete(id);
      },
    },
  };
}
const GIB = 1024 ** 3;

interface Rig {
  log: string[];
  /** VMs the fake helper still holds, and the listeners still open. */
  live: Set<string>;
  egress: Set<string>;
  registry: VmRegistry;
  port: VmPort;
  fail: Partial<Record<"create:agent" | "create:check" | "egress" | "ready" | "stop" | "delete:agent" | "release", true>>;
  hangReady: { on: boolean };
}

function rig(): Rig {
  const log: string[] = [];
  const live = new Set<string>();
  const egress = new Set<string>();
  const fail: Rig["fail"] = {};
  const hangReady = { on: false };
  const port: VmPort = {
    async create(id, kind) {
      log.push(`create ${kind}`);
      if (fail[`create:${kind}`]) throw new Error(`${SENTINEL_PATH} refused ${SENTINEL_CMD}`);
      live.add(id);
    },
    async startEgress(id) {
      log.push(`egress ${id}`);
      if (fail.egress) throw new Error("egress down");
      egress.add(id);
    },
    async waitGuest() {
      log.push("ready");
      if (hangReady.on) await new Promise<never>(() => undefined);
      if (fail.ready) throw new Error("guest gone");
    },
    async releaseEgress(id) {
      log.push(`release ${id}`);
      if (fail.release) throw new Error("socket stuck");
      egress.delete(id);
    },
    async stop(id) {
      log.push(`stop ${id}`);
      if (fail.stop) throw new Error("stop refused");
      live.delete(id);
    },
    async destroy(id) {
      log.push(`destroy ${id}`);
      live.delete(id);
    },
    async delete(id) {
      log.push(`delete ${id}`);
      if (id === "agent-1" && fail["delete:agent"]) throw new Error("helper busy");
      live.delete(id);
    },
  };
  return { log, live, egress, registry: new VmRegistry(), port, fail, hangReady };
}

type Steps = VmJobSteps<string, string, string, string>;
function steps(r: Rig, over: Partial<Steps> = {}): Steps {
  return {
    workspaceIn: async () => void r.log.push("workspace in"),
    runAgent: async () => (r.log.push("run agent"), "agent-result"),
    bundleOut: async () => (r.log.push("bundle out"), "bundle"),
    hostApply: async () => (r.log.push("host apply"), "applied"),
    runCheck: async (vm) => (r.log.push(`check in ${vm}`), "check-result"),
    ...over,
  };
}

function deps(r: Rig, over: Partial<VmJobDeps<string, string, string, string>> = {}, s: Steps = steps(r)): VmJobDeps<string, string, string, string> {
  return {
    names: { agent: "agent-1", check: "check-1" },
    port: r.port,
    registry: r.registry,
    steps: s,
    needsToken: false,
    caps: caps(),
    request: { vcpus: 2, memoryMb: 1024 },
    readMemAvailableBytes: () => 8 * GIB,
    signal: new AbortController().signal,
    ...over,
  };
}

/** The helper lists nothing, no listener is open, and the table is empty. */
function expectClean(r: Rig): void {
  expect([...r.live]).toEqual([]);
  expect([...r.egress]).toEqual([]);
  expect(r.registry.ids()).toEqual([]);
}

const tokenSlot = (r: Rig, over: Partial<TokenSlot> = {}): TokenSlot => ({
  deliver: async () => void r.log.push("token deliver"),
  wipe: async () => void r.log.push("token wipe"),
  ...over,
});

describe("the order of one job (criterion 11)", () => {
  it("runs every step once, in order, and a step starts only after the one above it reported success", async () => {
    const r = rig();
    const events: string[] = [];
    const out = await runVmJob(deps(r, { needsToken: true, token: tokenSlot(r), log: (e) => events.push(`${e.phase} ${e.step}`) }));
    expect(out.ok).toBe(true);
    const order = r.log.filter((l) => !l.startsWith("egress") && !l.startsWith("release"));
    expect(order).toEqual([
      "create agent", "ready", "workspace in", "token deliver", "run agent", "token wipe", "bundle out", "stop agent-1", "host apply",
      "create check", "ready", "check in check-1", "delete check-1", "delete agent-1",
    ]);
    const steps_ = events.filter((e) => !e.startsWith("fail"));
    // every `start X` is directly preceded by the `ok` of the step above it
    for (let i = 0; i < steps_.length; i++) if (steps_[i]!.startsWith("start ") && i > 0) expect(steps_[i - 1]!.startsWith("ok ")).toBe(true);
    expect(events.at(-2)).toBe("start teardown");
    expectClean(r);
  });

  it("the agent's VM is stopped before the check VM exists, and the check never runs in the agent's VM", async () => {
    const r = rig();
    await runVmJob(deps(r));
    expect(r.log.indexOf("stop agent-1")).toBeLessThan(r.log.indexOf("create check"));
    expect(r.log).toContain("check in check-1");
    expect(r.log).not.toContain("check in agent-1");
  });

  it("a job that needs no token skips the slot; one that needs it without a slot ends with `vm_token_delivery_failed`", async () => {
    const r = rig();
    await runVmJob(deps(r));
    expect(r.log.join()).not.toContain("token");
    const r2 = rig();
    const out = await runVmJob(deps(r2, { needsToken: true }));
    expect(out).toMatchObject({ ok: false, step: "token", code: "vm_token_delivery_failed" });
    expect(r2.log).not.toContain("run agent");
    expectClean(r2);
  });

  it("without the fresh-VM check, the job ends with the fixed refusal, no check VM is made, and the agent's VM is gone", async () => {
    const r = rig();
    const out = await runVmJob(deps(r, {}, steps(r, { runCheck: undefined })));
    expect(out).toMatchObject({ ok: false, step: "check", code: "microvm_check_closed" });
    expect(r.log.filter((l) => l === "create check")).toEqual([]);
    expectClean(r);
  });
});

describe("teardown on every path (criterion 12)", () => {
  const paths: Array<[string, (r: Rig) => Partial<VmJobDeps<string, string, string, string>>, Partial<Steps> | ((r: Rig) => Partial<Steps>), string, string]> = [
    ["agent error", () => ({}), (r) => ({ runAgent: async () => { r.log.push("run agent"); throw new Error(`${SENTINEL_CMD} died`); } }), "run", "agent_failed"],
    ["workspace crossing fails", () => ({}), { workspaceIn: async () => { throw new Error(SENTINEL_PATH); } }, "workspace_in", "vm_workspace_failed"],
    ["bundle out fails", () => ({}), { bundleOut: async () => { throw new Error(SENTINEL_PATH); } }, "bundle_out", "vm_workspace_failed"],
    ["host apply refuses with a fixed word", () => ({}), { hostApply: async () => { throw new StepRefusal("bundle_refused"); } }, "host_apply", "bundle_refused"],
    ["check fails to run", () => ({}), { runCheck: async () => { throw new Error("check blew up"); } }, "check", "vm_workspace_failed"],
  ];
  for (const [name, depsOver, stepsOver, step, code] of paths) {
    it(`${name}: ends with a closed code and leaves nothing behind`, async () => {
      const r = rig();
      const out = await runVmJob(deps(r, depsOver(r), steps(r, typeof stepsOver === "function" ? stepsOver(r) : stepsOver)));
      expect(out).toMatchObject({ ok: false, step, code, teardownIncomplete: false });
      expectClean(r);
    });
  }

  it("a cancel or a timeout (the signal) during the run ends the job `aborted` and tears both VMs down", async () => {
    const r = rig();
    const abort = new AbortController();
    const out = await runVmJob(deps(r, { signal: abort.signal }, steps(r, { runAgent: () => (queueMicrotask(() => abort.abort()), new Promise<never>(() => undefined)) })));
    expect(out).toMatchObject({ ok: false, step: "run", code: "aborted" });
    expectClean(r);
  });

  it("a signal that is already aborted starts nothing", async () => {
    const r = rig();
    const abort = new AbortController();
    abort.abort();
    const out = await runVmJob(deps(r, { signal: abort.signal }));
    expect(out).toMatchObject({ ok: false, step: "admit", code: "aborted" });
    expect(r.log).toEqual([]);
    expectClean(r);
  });

  it("the guest never answering ends with `vm_boot_failed` at the step deadline", async () => {
    const r = rig();
    r.hangReady.on = true;
    const out = await runVmJob(deps(r, { stepTimeoutMs: 40 }));
    expect(out).toMatchObject({ ok: false, step: "guest_ready", code: "vm_boot_failed" });
    expectClean(r);
  });

  it("a create that fails is deleted, not kept (agent VM and check VM)", async () => {
    const r = rig();
    r.fail["create:agent"] = true;
    expect(await runVmJob(deps(r))).toMatchObject({ ok: false, step: "create", code: "vm_boot_failed" });
    expect(r.log).toContain("delete agent-1");
    expectClean(r);
    const r2 = rig();
    r2.fail["create:check"] = true;
    expect(await runVmJob(deps(r2))).toMatchObject({ ok: false, step: "check_vm", code: "vm_boot_failed" });
    expect(r2.log).toContain("delete check-1");
    expectClean(r2);
  });

  it("an egress that cannot start ends with `vm_egress_unavailable` before the guest is waited for", async () => {
    const r = rig();
    r.fail.egress = true;
    expect(await runVmJob(deps(r))).toMatchObject({ ok: false, step: "egress", code: "vm_egress_unavailable" });
    expect(r.log).not.toContain("ready");
    expectClean(r);
  });

  it("the host-memory guard refusing leaves nothing registered and calls nothing", async () => {
    const r = rig();
    const out = await runVmJob(deps(r, { readMemAvailableBytes: () => 1.5 * GIB }));
    expect(out).toMatchObject({ ok: false, step: "admit", code: "vm_admission_refused" });
    expect(r.log).toEqual([]);
    expectClean(r);
  });

  it("a failed token delivery ends with `vm_token_delivery_failed` and no agent runs", async () => {
    const r = rig();
    const out = await runVmJob(deps(r, { needsToken: true, token: tokenSlot(r, { deliver: async () => { throw new Error(SENTINEL_TOKEN); } }) }));
    expect(out).toMatchObject({ ok: false, step: "token", code: "vm_token_delivery_failed" });
    expect(r.log).not.toContain("run agent");
    expectClean(r);
  });

  it("a failed teardown step does not stop the next ones, is reported, and the reaper finishes it", async () => {
    const r = rig();
    r.fail["delete:agent"] = true;
    const out = await runVmJob(deps(r));
    expect(out).toMatchObject({ ok: false, step: "teardown", code: "vm_teardown_incomplete", teardownIncomplete: true });
    expect(r.log).toContain("delete check-1"); // the check VM was still ended
    expect(r.log).toContain("release agent-1"); // and the listeners of the agent's VM were still closed
    expect(r.registry.leftovers()).toEqual(["agent-1"]);
    delete r.fail["delete:agent"];
    // the table holds the NAME the job used; the helper knows only the id. The reaper maps it, so the VM the helper still holds is the one ended, and the list need not show it.
    const h = idHelper([OWN("agent-1")]);
    expect(await reapVms({ prefix: PREFIX, idOf: OWN, list: async () => [], port: h.port, registry: r.registry })).toEqual({ reaped: 1, failed: 0 });
    expect(h.log).toEqual([`release ${OWN("agent-1")}`, `delete ${OWN("agent-1")}`]);
    expect([...h.held]).toEqual([]);
    expectClean(r);
  });

  it("a failed listener release is reported too, and the VM is still deleted", async () => {
    const r = rig();
    r.fail.release = true;
    const out = await runVmJob(deps(r));
    expect(out).toMatchObject({ ok: false, code: "vm_teardown_incomplete", teardownIncomplete: true });
    expect(r.log).toContain("delete agent-1");
  });

  it("a job's own failure keeps its code when teardown is also incomplete, and says so", async () => {
    const r = rig();
    r.fail["delete:agent"] = true;
    const out = await runVmJob(deps(r, {}, steps(r, { hostApply: async () => { throw new StepRefusal("bundle_refused"); } })));
    expect(out).toMatchObject({ ok: false, code: "bundle_refused", teardownIncomplete: true });
  });

  it("start-up reaping removes an orphan the table never held, and skips a live job's VM registered by name when the list holds its mapped id", async () => {
    const r = rig();
    r.registry.add("rn-live", "agent", { vcpus: 1, memoryMb: 512 }); // the table holds the name
    const h = idHelper([OWN("rn-orphan"), OWN("rn-live")]);
    const out = await reapVms({ prefix: PREFIX, idOf: OWN, list: h.list, port: h.port, registry: r.registry });
    expect(out).toEqual({ reaped: 1, failed: 0 });
    expect(h.log).toContain(`delete ${OWN("rn-orphan")}`);
    expect(h.log).not.toContain(`delete ${OWN("rn-live")}`);
    expect([...h.held]).toEqual([OWN("rn-live")]);
    expect(r.registry.ids()).toEqual(["rn-live"]);
  });

  it("a leftover that cannot be ended stays in the table by name and is counted failed; the next pass ends it", async () => {
    const r = rig();
    r.registry.add("rn-x", "agent", { vcpus: 1, memoryMb: 512 });
    r.registry.markLeftover("rn-x");
    const h = idHelper([OWN("rn-x")]);
    let stuck = true;
    const port: Pick<VmPort, "releaseEgress" | "delete"> = { releaseEgress: h.port.releaseEgress, delete: async (id) => { if (stuck) throw new Error("stuck"); await h.port.delete(id); } };
    expect(await reapVms({ prefix: PREFIX, idOf: OWN, list: h.list, port, registry: r.registry })).toEqual({ reaped: 0, failed: 1 });
    expect(r.registry.leftovers()).toEqual(["rn-x"]);
    stuck = false;
    expect(await reapVms({ prefix: PREFIX, idOf: OWN, list: h.list, port, registry: r.registry })).toEqual({ reaped: 1, failed: 0 });
    expect([...h.held]).toEqual([]);
    expect(r.registry.ids()).toEqual([]);
  });

  it("two runners of one uid with different homes never reap each other's VMs", async () => {
    const a = runnerIdPrefix("/tmp/fictional-runner-home-a");
    const b = runnerIdPrefix("/tmp/fictional-runner-home-b");
    expect(a).not.toBe(b);
    expect(runnerIdPrefix("/tmp/fictional-runner-home-a")).toBe(a); // stable across restarts
    const unmarked = sandboxIdOf("rn-some-run");
    const h = idHelper([idOfRunner(a)("rn-1"), idOfRunner(b)("rn-1"), unmarked, "sb-0000000000-x"]);
    expect(await reapVms({ prefix: a, idOf: idOfRunner(a), list: h.list, port: h.port, registry: new VmRegistry() })).toEqual({ reaped: 1, failed: 0 });
    expect([...h.held].sort()).toEqual([idOfRunner(b)("rn-1"), unmarked, "sb-0000000000-x"].sort());
    expect(await reapVms({ prefix: b, idOf: idOfRunner(b), list: h.list, port: h.port, registry: new VmRegistry() })).toEqual({ reaped: 1, failed: 0 });
    expect([...h.held].sort()).toEqual([unmarked, "sb-0000000000-x"].sort()); // unmarked VMs are never reaped by name guess
  });

  it("a runner reaps its own leftovers after a crash (a fresh table, the helper still lists them)", async () => {
    const h = idHelper([OWN("rn-9"), OWN("rc-9")]);
    const out = await reapVms({ prefix: PREFIX, idOf: OWN, list: h.list, port: h.port, registry: new VmRegistry() });
    expect(out).toEqual({ reaped: 2, failed: 0 });
    expect([...h.held]).toEqual([]);
  });

  it("an unusable prefix reaps nothing from the list, and ids made for a runner fit the helper's id pattern", async () => {
    const h = idHelper(["anything", "sb-0123456789-x"]);
    for (const prefix of ["", "sb-", "agent-", "sb-0123456789"]) {
      expect(isRunnerIdPrefix(prefix)).toBe(false);
      expect(await reapVms({ prefix, idOf: OWN, list: h.list, port: h.port, registry: new VmRegistry() })).toEqual({ reaped: 0, failed: 0 });
    }
    expect([...h.held]).toEqual(["anything", "sb-0123456789-x"]);
    expect(OWN("rn-" + "a".repeat(200))).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    expect(() => idOfRunner("sb-")).toThrow("bad_runner_id_prefix");
  });
});

describe("the cap counts the check VM (criterion 16)", () => {
  it("while one VM runs under max_vms = 1 a second job is refused at admission and creates nothing", async () => {
    const r = rig();
    r.registry.add("other", "agent", { vcpus: 1, memoryMb: 512 });
    expect(vmCapBlock(r.registry, caps(1))).toBe("vm_cap_reached");
    const out = await runVmJob(deps(r));
    expect(out).toMatchObject({ ok: false, step: "admit", code: "vm_admission_refused" });
    expect(r.log).toEqual([]);
    expect(vmCapBlock(r.registry, caps(2))).toBeUndefined();
    expect(vmCapBlock(r.registry, undefined)).toBeUndefined();
  });

  it("the job holding the one slot still gets its check VM once its agent VM is stopped", async () => {
    const r = rig();
    let seenDuringCheck: string | undefined;
    const out = await runVmJob(deps(r, {}, steps(r, { runCheck: async () => ((seenDuringCheck = vmCapBlock(r.registry, caps(1))), "ok") })));
    expect(out.ok).toBe(true);
    expect(seenDuringCheck).toBe("vm_cap_reached"); // the check VM is the one running VM
  });

  it("a stopped agent VM does not count as running, so it cannot block its own check", async () => {
    const r = rig();
    r.registry.add("a", "agent", { vcpus: 1, memoryMb: 512 });
    r.registry.markStopped("a");
    expect(r.registry.running()).toEqual([]);
  });
});

describe("fields a VM run does not carry yet (criterion 17)", () => {
  for (const needs of [{ allowances: {} }, { extraReadPaths: ["/x"] }, { spillDir: "/s" }]) {
    it(`${Object.keys(needs)[0]} ends with a closed code and one fixed operator line, never an exception`, async () => {
      const r = rig();
      const lines: string[] = [];
      const out = await runVmJob(deps(r, { needs, operatorLine: (l) => lines.push(l) }));
      expect(out).toMatchObject({ ok: false, step: "admit", code: "vm_admission_refused" });
      expect(lines).toEqual([OPERATOR_LINE_UNSUPPORTED_FIELDS]);
      expect(r.log).toEqual([]);
    });
  }
});

describe("the token's wipe (FU-155 decision)", () => {
  it("the wipe is confirmed before the bundle comes out and before the VM stops", async () => {
    const r = rig();
    await runVmJob(deps(r, { needsToken: true, token: tokenSlot(r) }));
    expect(r.log.indexOf("token wipe")).toBeLessThan(r.log.indexOf("bundle out"));
    expect(r.log.indexOf("token wipe")).toBeLessThan(r.log.indexOf("stop agent-1"));
  });

  it("an unconfirmed wipe ends `vm_teardown_incomplete`, never stops or snapshots the VM, and destroys it (earlier snapshots stay) instead of deleting it", async () => {
    const r = rig();
    const out = await runVmJob(deps(r, { needsToken: true, keepAgentVm: true, token: tokenSlot(r, { wipe: async () => { throw new Error("unconfirmed"); } }) }));
    expect(out).toMatchObject({ ok: false, step: "quiesce", code: "vm_teardown_incomplete", teardownIncomplete: true });
    expect(r.log).not.toContain("bundle out");
    expect(r.log.some((l) => l.startsWith("stop "))).toBe(false);
    expect(r.log).toContain("destroy agent-1");
    expect(r.log).not.toContain("delete agent-1");
    expect(r.live.size).toBe(0);
  });

  it("a wipe that never answers is ended by the step bound, counts as unconfirmed, and the VM is destroyed, never stopped or deleted", async () => {
    const r = rig();
    const started = Date.now();
    const out = await runVmJob(deps(r, { stepTimeoutMs: 40, needsToken: true, keepAgentVm: true, token: tokenSlot(r, { wipe: () => new Promise<never>(() => undefined) }) }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).toMatchObject({ ok: false, step: "quiesce", code: "vm_teardown_incomplete", teardownIncomplete: true });
    expect(r.log).toContain("destroy agent-1");
    expect(r.log).not.toContain("delete agent-1");
    expect(r.log).not.toContain("bundle out");
    expect(r.log.some((l) => l.startsWith("stop "))).toBe(false);
    expect(r.live.size).toBe(0);
  });

  it("a wipe that answers only after its bound is still unconfirmed: the VM is destroyed and the job does not succeed", async () => {
    const r = rig();
    const release = r.port.releaseEgress.bind(r.port);
    r.port.releaseEgress = async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 250)); // the late answer arrives while teardown is still running
      return release(id);
    };
    const out = await runVmJob(deps(r, { stepTimeoutMs: 40, needsToken: true, keepAgentVm: true, token: tokenSlot(r, { wipe: () => new Promise<void>((resolve) => setTimeout(resolve, 120)) }) }));
    expect(out).toMatchObject({ ok: false, step: "quiesce", code: "vm_teardown_incomplete", teardownIncomplete: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(r.log).toContain("destroy agent-1");
    expect(r.log).not.toContain("delete agent-1");
  });

  it("a VM kept for a resume is stopped, not deleted; the check VM is never kept", async () => {
    const r = rig();
    const out = await runVmJob(deps(r, { keepAgentVm: true }));
    expect(out.ok).toBe(true);
    expect(r.log).toContain("stop agent-1");
    expect(r.log).not.toContain("delete agent-1");
    expect(r.log).toContain("delete check-1");
    expect(r.registry.ids()).toEqual([]);
  });
});

describe("closed codes and what may be recorded (criterion 23)", () => {
  it("the six codes are the protocol's details, each has its own plain line, and nothing else is added", () => {
    expect([...VM_JOB_CODES]).toEqual(RUNNER_SETUP_DETAILS.filter((d) => d.startsWith("vm_")));
    for (const code of VM_JOB_CODES) {
      const line = runnerSetupText(code);
      expect(line, code).not.toContain(code);
      expect(line.length).toBeGreaterThan(40);
    }
  });

  it("a refusal word that is not one plain word, and an error's text, never become a code", async () => {
    const r = rig();
    const out = await runVmJob(deps(r, {}, steps(r, { workspaceIn: async () => { throw new StepRefusal(`${SENTINEL_PATH} Not A Word`); } })));
    expect(out).toMatchObject({ code: "vm_workspace_failed" });
  });

  it("no record, outcome or operator line of any failure carries a path, a command or the token", async () => {
    const failures: Array<(r: Rig) => void | Partial<Steps>> = [
      (r) => void (r.fail["create:agent"] = true),
      (r) => void (r.fail.egress = true),
      () => ({ workspaceIn: async () => { throw new Error(`${SENTINEL_PATH} ${SENTINEL_TOKEN}`); } }),
      () => ({ runAgent: async () => { throw new Error(SENTINEL_CMD); } }),
      (r) => void (r.fail["delete:agent"] = true),
    ];
    for (const make of failures) {
      const r = rig();
      const lines: string[] = [];
      const over = make(r) ?? {};
      const out = await runVmJob(deps(r, { needsToken: true, token: tokenSlot(r), operatorLine: (l) => lines.push(l) }, steps(r, over)));
      const seen = JSON.stringify([out, lines, r.log]);
      for (const secret of [SENTINEL_TOKEN, SENTINEL_PATH, SENTINEL_CMD, "sentinel"]) expect(seen).not.toContain(secret);
      expect(Object.keys(out.record).sort()).toEqual(["code", "durationMs", "engine", "ok", "step", "teardownIncomplete", "vms"].filter((k) => k in out.record).sort());
      expect(Number.isInteger(out.record.durationMs)).toBe(true);
    }
  });

  it("a success's record holds only the engine, counts and a whole-millisecond duration", async () => {
    const r = rig();
    let t = 1000;
    const out = await runVmJob(deps(r, { now: () => (t += 7.5) }));
    expect(out.record).toEqual({ engine: "microvm", ok: true, teardownIncomplete: false, vms: 2, durationMs: expect.any(Number) as number });
    expect(Number.isInteger(out.record.durationMs)).toBe(true);
  });
});

describe("the VM factory over the sandbox port", () => {
  it("creates a closed, non-persistent sandbox by name, and stops and deletes through the handle the port returned", async () => {
    const calls: string[] = [];
    const port = vmPortOf({
      sandbox: {
        createSandbox: async (o) => (calls.push(`create ${o.sandboxName} ${o.retention.persistent} ${o.timeoutMs}`), { runId: "", sandboxName: o.sandboxName, sessionId: "s-1" }),
        stop: async (h) => void calls.push(`stop ${h.sandboxName} ${h.sessionId}`),
        deleteSandbox: async (h) => void calls.push(`delete ${h.sandboxName}`),
      },
      timeoutMs: 5000,
      startEgress: async () => undefined,
      releaseEgress: async () => undefined,
      waitGuest: async () => undefined,
      destroy: async () => undefined,
    });
    await port.create("vm-a", "agent");
    await port.stop("vm-a");
    await port.delete("vm-a");
    expect(calls).toEqual(["create vm-a false 5000", "stop vm-a s-1", "delete vm-a"]);
  });
});

describe("teardown covers only what this run registered", () => {
  it("a name another job already holds is refused at registration and its VM is left alone", async () => {
    const r = rig();
    r.registry.add("agent-1", "agent", { vcpus: 1, memoryMb: 512 }); // another job's entry, under the name this run wants
    r.live.add("agent-1");
    r.egress.add("agent-1");
    const out = await runVmJob(deps(r, { caps: caps(4) }));
    expect(out).toMatchObject({ ok: false, step: "register", code: "vm_boot_failed" });
    expect(r.log.filter((l) => l.includes("agent-1"))).toEqual([]); // no release, stop, delete or destroy of it
    expect(r.registry.ids()).toEqual(["agent-1"]);
    expect([...r.live]).toEqual(["agent-1"]);
    expect([...r.egress]).toEqual(["agent-1"]);
  });

  it("a check name that is already held is left alone, while this run's own agent VM is still torn down", async () => {
    const r = rig();
    r.registry.add("check-1", "check", { vcpus: 1, memoryMb: 512 });
    r.live.add("check-1");
    const out = await runVmJob(deps(r, { caps: caps(4) }));
    expect(out).toMatchObject({ ok: false, step: "check_vm", teardownIncomplete: false });
    expect(r.log).toContain("delete agent-1");
    expect(r.log.filter((l) => l.includes("check-1"))).toEqual([]);
    expect(r.registry.ids()).toEqual(["check-1"]);
    expect([...r.live]).toEqual(["check-1"]);
  });
});

describe("the wipe after a job that ended before its quiesce (criterion 24)", () => {
  const failRun = (code?: string): Partial<Steps> => ({ runAgent: async () => { throw code === undefined ? new Error("agent exploded") : new StepRefusal(code); } });

  it.each([
    ["the agent threw", failRun(), "agent_failed"],
    ["the agent refused with a closed word", failRun("agent_failed"), "agent_failed"],
  ])("%s: the token is wiped once, before the VM is ended, and the job keeps its own code", async (_name, over, code) => {
    const r = rig();
    const out = await runVmJob(deps(r, { needsToken: true, token: tokenSlot(r) }, steps(r, over)));
    expect(out).toMatchObject({ ok: false, step: "run", code, teardownIncomplete: false });
    expect(r.log.indexOf("token wipe")).toBeGreaterThan(r.log.indexOf("token deliver"));
    expect(r.log.indexOf("token wipe")).toBeLessThan(r.log.indexOf("delete agent-1"));
    expect(r.log.filter((l) => l === "token wipe")).toHaveLength(1);
    expectClean(r);
  });

  it("a cancel (abort) during the run still wipes before the VM is ended", async () => {
    const r = rig();
    const abort = new AbortController();
    const out = await runVmJob(deps(r, { needsToken: true, token: tokenSlot(r), signal: abort.signal }, steps(r, { runAgent: () => { setTimeout(() => abort.abort(), 10); return new Promise<never>(() => undefined); } })));
    expect(out).toMatchObject({ ok: false, step: "run", code: "aborted" });
    expect(r.log).toContain("token wipe");
    expect(r.log.indexOf("token wipe")).toBeLessThan(r.log.indexOf("delete agent-1"));
    expectClean(r);
  });

  it("a wipe that is not confirmed on such a path destroys the VM (never keeps it), and the job ends vm_teardown_incomplete at the step it failed in", async () => {
    const r = rig();
    const out = await runVmJob(deps(r, { needsToken: true, keepAgentVm: true, token: tokenSlot(r, { wipe: async () => { throw new Error("unconfirmed"); } }) }, steps(r, failRun())));
    expect(out).toMatchObject({ ok: false, step: "run", code: "vm_teardown_incomplete", teardownIncomplete: true });
    expect(out.record).toMatchObject({ code: "vm_teardown_incomplete", teardownIncomplete: true });
    expect(r.log).toContain("destroy agent-1");
    expect(r.log).not.toContain("delete agent-1");
    expect(r.log.some((l) => l.startsWith("stop "))).toBe(false);
  });

  it("a wipe that answers only after its bound is ended by the bound, and the late answer does not clear the unconfirmed state", async () => {
    const r = rig();
    const out = await runVmJob(deps(r, { stepTimeoutMs: 40, needsToken: true, keepAgentVm: true, token: tokenSlot(r, { wipe: () => new Promise<void>((resolve) => setTimeout(resolve, 120)) }) }, steps(r, failRun())));
    expect(out).toMatchObject({ ok: false, code: "vm_teardown_incomplete", teardownIncomplete: true });
    expect(r.log).toContain("destroy agent-1");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(r.log).not.toContain("delete agent-1");
  });

  it("a wipe whose answer lands while teardown is still ending the check and agent VMs does not turn the destroy into a delete", async () => {
    const r = rig();
    const release = r.port.releaseEgress.bind(r.port);
    r.port.releaseEgress = async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 150)); // teardown is inside this window when the wipe answers (at 80 ms, after the 40 ms bound)
      return release(id);
    };
    const out = await runVmJob(deps(r, { stepTimeoutMs: 40, needsToken: true, keepAgentVm: true, token: tokenSlot(r, { wipe: () => new Promise<void>((resolve) => setTimeout(resolve, 80)) }) }, steps(r, failRun())));
    expect(out).toMatchObject({ ok: false, code: "vm_teardown_incomplete", teardownIncomplete: true });
    expect(r.log).toContain("destroy agent-1");
    expect(r.log).not.toContain("delete agent-1");
  });

  describe("a cancel that lands as the agent returns, before the quiesce step starts", () => {
    const cancelAtReturn = (abort: AbortController): Partial<Steps> => ({ runAgent: async () => { queueMicrotask(() => abort.abort()); return "agent-result"; } });

    it("still wipes the token before the VM is ended, and a confirmed wipe ends the job with the cancel's own code", async () => {
      const r = rig();
      const abort = new AbortController();
      const out = await runVmJob(deps(r, { needsToken: true, keepAgentVm: true, token: tokenSlot(r), signal: abort.signal }, steps(r, cancelAtReturn(abort))));
      expect(out).toMatchObject({ ok: false, step: "quiesce", code: "aborted", teardownIncomplete: false });
      expect(r.log.filter((l) => l === "token wipe")).toHaveLength(1);
      expect(r.log.indexOf("token wipe")).toBeLessThan(r.log.indexOf("delete agent-1"));
      expectClean(r);
    });

    it("an unconfirmed wipe there destroys the VM and ends the job vm_teardown_incomplete", async () => {
      const r = rig();
      const abort = new AbortController();
      const out = await runVmJob(deps(r, { needsToken: true, keepAgentVm: true, token: tokenSlot(r, { wipe: async () => { throw new Error("unconfirmed"); } }), signal: abort.signal }, steps(r, cancelAtReturn(abort))));
      expect(out).toMatchObject({ ok: false, step: "quiesce", code: "vm_teardown_incomplete", teardownIncomplete: true });
      expect(r.log).toContain("destroy agent-1");
      expect(r.log).not.toContain("delete agent-1");
    });
  });

  it("a job that needs no token, and a failure before the token step, never call the wipe", async () => {
    const r = rig();
    await runVmJob(deps(r, { needsToken: false, token: tokenSlot(r) }, steps(r, failRun())));
    expect(r.log).not.toContain("token wipe");
    const r2 = rig();
    await runVmJob(deps(r2, { needsToken: true, token: tokenSlot(r2) }, steps(r2, { workspaceIn: async () => { throw new Error("x"); } })));
    expect(r2.log).not.toContain("token wipe");
    expect(r2.log).not.toContain("token deliver");
  });

  it("a failed delivery also asks for the wipe, and a confirmed one leaves the job's own code", async () => {
    const r = rig();
    const out = await runVmJob(deps(r, { needsToken: true, token: tokenSlot(r, { deliver: async () => { throw new Error("x"); } }) }));
    expect(out).toMatchObject({ ok: false, step: "token", code: "vm_token_delivery_failed", teardownIncomplete: false });
    expect(r.log).toContain("token wipe");
    expectClean(r);
  });
});
