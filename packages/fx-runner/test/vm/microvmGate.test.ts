import { mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { SANDBOX_UNAVAILABLE_REASONS } from "@fulcrumaxe/runner-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createMicrovmGate } from "../../src/daemon/microvmGate.js";
import { pollLoop, type PollEvent } from "../../src/daemon/pollLoop.js";
import type { ClaimResult } from "../../src/daemon/client.js";
import { REPROBE_INTERVAL_MS, type SandboxGate } from "../../src/daemon/sandboxGate.js";
import { verifyJob } from "../../src/daemon/verifyJob.js";
import { hostFactsOf } from "../../src/hostFacts.js";
import { SANDBOX_REASONS } from "../../src/sandbox/probe.js";
import { MICROVM_UNAVAILABLE_REASONS, chooseEngine, microvmUnavailableReason } from "../../src/vm/engineGate.js";
import { askHelperState } from "../../src/vm/helperProbe.js";
import { ENGINE_LINES, type EngineLine, type HelperState, type Presence, type SandboxEngine, type VmHostFacts } from "../../src/vm/limits.js";
import { HELPER_PROTOCOL } from "../../src/vm/sandboxd/helperClient.js";
import { KEYRING, NOW, signedJob } from "../helpers/signedJob.js";
import { manualClock } from "../helpers/manualClock.js";
import { runCleanups, scratch } from "./sandboxd/helpers.js";

afterEach(() => runCleanups());

const facts = (over: Partial<VmHostFacts> = {}): VmHostFacts => ({ kvm: "present", helperSocket: "present", helperSocketPath: "/fictional/helper.sock", helperState: "ready", readMemAvailableBytes: () => 8 * 1024 ** 3, ...over });
const OS_OPEN: SandboxGate = { check: async () => ({ open: true }) };

describe("the four reasons and the protocol", () => {
  it("the protocol's closed set is the probe's five and these four, in that order; the cloud and the runner cannot drift apart", () => {
    expect([...SANDBOX_UNAVAILABLE_REASONS]).toEqual([...SANDBOX_REASONS, ...MICROVM_UNAVAILABLE_REASONS]);
    expect([...MICROVM_UNAVAILABLE_REASONS]).toEqual(["microvm_no_kvm", "microvm_helper_missing", "microvm_helper_not_ready", "microvm_helper_out_of_date"]);
  });
});

describe("microvmUnavailableReason: each missing piece has its own code", () => {
  it("no KVM (absent, unreadable, or no facts at all)", () => {
    expect(microvmUnavailableReason({ engine: "microvm", facts: facts({ kvm: "absent" }) })).toBe("microvm_no_kvm");
    expect(microvmUnavailableReason({ engine: "microvm", facts: facts({ kvm: "unreadable" }) })).toBe("microvm_no_kvm");
    expect(microvmUnavailableReason({ engine: "microvm", facts: undefined })).toBe("microvm_no_kvm");
  });

  it("no helper (the socket is absent), and a socket that is there but cannot be used is not ready", () => {
    expect(microvmUnavailableReason({ engine: "microvm", facts: facts({ helperSocket: "absent", helperState: undefined }) })).toBe("microvm_helper_missing");
    expect(microvmUnavailableReason({ engine: "microvm", facts: facts({ helperSocket: "unreadable", helperState: undefined }) })).toBe("microvm_helper_not_ready");
  });

  it("a helper that is not ready, one that was not asked, and one that is out of date", () => {
    expect(microvmUnavailableReason({ engine: "microvm", facts: facts({ helperState: "not_ready" }) })).toBe("microvm_helper_not_ready");
    expect(microvmUnavailableReason({ engine: "microvm", facts: facts({ helperState: undefined }) })).toBe("microvm_helper_not_ready");
    expect(microvmUnavailableReason({ engine: "microvm", facts: facts({ helperState: "out_of_date" }) })).toBe("microvm_helper_out_of_date");
  });

  it("everything in place gives no reason, and the order is the order a person fixes things in", () => {
    expect(microvmUnavailableReason({ engine: "microvm", facts: facts() })).toBeUndefined();
    expect(microvmUnavailableReason({ engine: "microvm", facts: facts({ kvm: "absent", helperSocket: "absent", helperState: "out_of_date" }) })).toBe("microvm_no_kvm");
    expect(microvmUnavailableReason({ engine: "microvm", facts: facts({ helperSocket: "absent", helperState: "out_of_date" }) })).toBe("microvm_helper_missing");
  });

  it("answers only for the microvm setting: os_sandbox and an invalid setting never get one of the four", () => {
    const presence: Presence[] = ["present", "absent", "unreadable"];
    const states: Array<HelperState | undefined> = ["ready", "not_ready", "out_of_date", undefined];
    for (const engine of ["os_sandbox", "invalid"] as const) {
      for (const kvm of presence) for (const helperSocket of presence) for (const helperState of states) expect(microvmUnavailableReason({ engine, facts: facts({ kvm, helperSocket, helperState }) })).toBeUndefined();
      expect(microvmUnavailableReason({ engine, facts: undefined })).toBeUndefined();
    }
  });
});

describe("the claim gate of a runner set to microvm", () => {
  function rig(initial: VmHostFacts | undefined | (() => never), engine: () => SandboxEngine | "invalid" = () => "microvm", inner: SandboxGate = OS_OPEN, limitsBlocked: () => boolean = () => false) {
    const clock = manualClock();
    let answer: VmHostFacts | undefined | (() => never) = initial;
    let asked = 0;
    const gate = createMicrovmGate({
      engine,
      now: clock.now,
      inner,
      limitsBlocked,
      facts: async () => {
        asked += 1;
        if (typeof answer === "function") return answer();
        return answer;
      },
    });
    return { clock, gate, set: (next: VmHostFacts | undefined | (() => never)) => void (answer = next), asked: () => asked };
  }

  it("is closed with each reason, and the OS sandbox gate is never asked while it holds", async () => {
    let inner = 0;
    const counting: SandboxGate = { check: async () => (inner++, { open: true }) };
    const cases: Array<[VmHostFacts, string]> = [
      [facts({ kvm: "absent" }), "microvm_no_kvm"],
      [facts({ helperSocket: "absent", helperState: undefined }), "microvm_helper_missing"],
      [facts({ helperState: "not_ready" }), "microvm_helper_not_ready"],
      [facts({ helperState: "out_of_date" }), "microvm_helper_out_of_date"],
    ];
    for (const [machine, reason] of cases) {
      const r = rig(machine, () => "microvm", counting);
      expect(await r.gate.check(), reason).toEqual({ open: false, reason });
    }
    expect(inner).toBe(0);
  });

  it("opens, and then asks the OS sandbox gate as before, when the machine can start a VM", async () => {
    const closedInner: SandboxGate = { check: async () => ({ open: false, reason: "bwrap_missing" }) };
    expect(await rig(facts(), () => "microvm", closedInner).gate.check()).toEqual({ open: false, reason: "bwrap_missing" });
    expect(await rig(facts()).gate.check()).toEqual({ open: true });
  });

  it("does not look at the machine when the setting is os_sandbox or invalid", async () => {
    for (const engine of ["os_sandbox", "invalid"] as const) {
      const r = rig(facts({ kvm: "absent" }), () => engine);
      expect(await r.gate.check()).toEqual({ open: true });
      expect(r.asked()).toBe(0);
    }
  });

  it("asks again at most every 5 minutes while closed, recovers without a restart, and keeps a pass", async () => {
    const r = rig(facts({ helperState: "out_of_date" }));
    expect(await r.gate.check()).toEqual({ open: false, reason: "microvm_helper_out_of_date" });
    r.set(facts());
    await r.clock.advance(REPROBE_INTERVAL_MS - 60_000, 60_000);
    expect(await r.gate.check()).toEqual({ open: false, reason: "microvm_helper_out_of_date" });
    expect(r.asked()).toBe(1);
    await r.clock.advance(60_000, 60_000);
    expect(await r.gate.check()).toEqual({ open: true });
    expect(r.asked()).toBe(2);
    r.set(facts({ kvm: "absent" }));
    expect(await r.gate.check()).toEqual({ open: true });
    expect(r.asked()).toBe(2);
  });

  it("a pass is asked again after the same 5 minutes, so a helper that dies after start closes the gate before a later claim, and it recovers", async () => {
    const r = rig(facts());
    expect(await r.gate.check()).toEqual({ open: true });
    r.set(facts({ helperSocket: "absent", helperState: undefined }));
    await r.clock.advance(REPROBE_INTERVAL_MS - 60_000, 60_000);
    expect(await r.gate.check()).toEqual({ open: true });
    expect(r.asked()).toBe(1);
    await r.clock.advance(60_000, 60_000);
    expect(await r.gate.check()).toEqual({ open: false, reason: "microvm_helper_missing" });
    expect(r.asked()).toBe(2);
    r.set(facts());
    await r.clock.advance(REPROBE_INTERVAL_MS, 60_000);
    expect(await r.gate.check()).toEqual({ open: true });
    expect(r.asked()).toBe(3);
  });

  it("while a missing limit already holds claiming it says nothing (the claim goes out paused as before), and says its reason once the limits are set", async () => {
    let blocked = true;
    const r = rig(facts({ kvm: "absent" }), () => "microvm", OS_OPEN, () => blocked);
    expect(await r.gate.check()).toEqual({ open: true });
    expect(r.asked()).toBe(0);
    blocked = false;
    expect(await r.gate.check()).toEqual({ open: false, reason: "microvm_no_kvm" });
  });

  it("fails closed: facts that cannot be read, or a reader that throws, close the gate with a fixed reason and keep the error text out", async () => {
    expect(await rig(undefined).gate.check()).toEqual({ open: false, reason: "microvm_no_kvm" });
    const thrown = rig(() => {
      throw new Error("boom with /home/someone/secret");
    });
    expect(await thrown.gate.check()).toEqual({ open: false, reason: "microvm_no_kvm" });
    const noReader = createMicrovmGate({ engine: () => "microvm", now: manualClock().now, limitsBlocked: () => false, inner: OS_OPEN, facts: undefined });
    expect(await noReader.check()).toEqual({ open: false, reason: "microvm_no_kvm" });
  });

  it("switching the setting on checks the machine afresh, and switching it off forgets", async () => {
    let engine: SandboxEngine = "os_sandbox";
    const r = rig(facts({ kvm: "absent" }), () => engine);
    expect(await r.gate.check()).toEqual({ open: true });
    engine = "microvm";
    expect(await r.gate.check()).toEqual({ open: false, reason: "microvm_no_kvm" });
    engine = "os_sandbox";
    expect(await r.gate.check()).toEqual({ open: true });
    engine = "microvm";
    expect(await r.gate.check()).toEqual({ open: false, reason: "microvm_no_kvm" });
    expect(r.asked()).toBe(2);
  });
});

describe("a microvm runner that cannot start a VM claims nothing and never downgrades", () => {
  const signed = signedJob({ requires_engine: "microvm" });
  const plain = signedJob();

  it("every poll is a status poll with the reason; a job a stray reply hands it is discarded, not run in the OS sandbox", async () => {
    const clock = manualClock();
    const gate = createMicrovmGate({ engine: () => "microvm", now: clock.now, limitsBlocked: () => false, inner: OS_OPEN, facts: async () => facts({ kvm: "absent" }) });
    const controller = new AbortController();
    const replies: ClaimResult[] = [{ kind: "idle", retryAfter: 60 }, { kind: "claimed", signedJob: plain, runId: plain.job.run_id, leaseGeneration: 1 }, { kind: "idle", retryAfter: 60 }];
    const seen: Array<string | undefined> = [];
    const handled: string[] = [];
    const log: PollEvent[] = [];
    let i = 0;
    const client = {
      async claim(reason?: string): Promise<ClaimResult> {
        seen.push(reason);
        const next = replies[i++];
        if (next === undefined) {
          controller.abort();
          return { kind: "idle", retryAfter: 1 };
        }
        return next;
      },
    };
    const done = pollLoop({ client: client as never, clock, gate, signal: controller.signal, onClaimed: async (c) => void handled.push(c.runId), log: (e) => log.push(e), random: () => 1 });
    await clock.advance(200_000, 1000);
    expect(await done).toBe("stopped");
    expect(seen.slice(0, 3)).toEqual(["microvm_no_kvm", "microvm_no_kvm", "microvm_no_kvm"]);
    expect(handled).toEqual([]);
    expect(log[0]).toEqual({ event: "sandbox_unavailable", reason: "microvm_no_kvm", waitSeconds: 60 });
    expect(log.some((e) => e.event === "discarded")).toBe(true);
  });

  it("an os_sandbox runner never gets a job that requires a microVM: whatever the machine says, it reports os_sandbox, and the job gate refuses the signed job", () => {
    const input = { platform: "linux" as const, arch: "x64", totalMemBytes: 16 * 1024 ** 3, cpus: 4 };
    // Every engine line the machine can print, with and without a build that can start a VM, and every state of a runner set to microvm that cannot.
    const lines = Object.values(ENGINE_LINES) as EngineLine[];
    for (const line of lines) {
      for (const wired of [true, false]) {
        const engine = chooseEngine(line, wired);
        const expected: SandboxEngine = line === ENGINE_LINES.microvm && wired ? "microvm" : "os_sandbox";
        expect(engine, `${line} / ${wired}`).toBe(expected);
        expect(hostFactsOf({ ...input, engine })?.sandbox_engine).toBe(expected);
        expect(verifyJob(signed, KEYRING, NOW, engine).ok, `${line} / ${wired}`).toBe(expected === "microvm");
      }
    }
    // A runner set to microvm whose machine fails each of the four checks is not an engine of microvm either.
    const broken = [facts({ kvm: "absent" }), facts({ helperSocket: "absent", helperState: undefined }), facts({ helperState: "not_ready" }), facts({ helperState: "out_of_date" })];
    for (const machine of broken) {
      expect(microvmUnavailableReason({ engine: "microvm", facts: machine })).toBeDefined();
      expect(verifyJob(signed, KEYRING, NOW, "os_sandbox")).toEqual({ ok: false, reason: "engine_required" });
    }
    // The default, when the engine is not passed at all, is os_sandbox.
    expect(verifyJob(signed, KEYRING, NOW)).toEqual({ ok: false, reason: "engine_required" });
  });
});

describe("askHelperState: the helper's own answer, over a real socket", () => {
  async function serve(reply: (c: net.Socket) => void): Promise<{ file: string; close: () => Promise<void> }> {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "h.sock");
    const server = net.createServer((c) => {
      c.on("error", () => undefined);
      c.once("data", () => reply(c));
    });
    await new Promise<void>((resolve) => server.listen(file, resolve));
    return { file, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }
  const frame = (value: unknown) => (c: net.Socket) => void c.end(`${JSON.stringify(value)}\n`);

  it("ready: this build's protocol number and ok", async () => {
    const s = await serve(frame({ ok: true, protocol: HELPER_PROTOCOL, sandboxes: [] }));
    expect(await askHelperState(s.file, HELPER_PROTOCOL)).toBe("ready");
    await s.close();
  });

  it("out of date: another protocol number, older or newer", async () => {
    for (const protocol of [HELPER_PROTOCOL - 1, HELPER_PROTOCOL + 1]) {
      const s = await serve(frame({ ok: true, protocol }));
      expect(await askHelperState(s.file, HELPER_PROTOCOL), String(protocol)).toBe("out_of_date");
      await s.close();
    }
  });

  it("not ready: a refusal, a reply that is not a frame, no protocol number, no listener, a silent socket", async () => {
    const refusal = await serve(frame({ ok: false, protocol: HELPER_PROTOCOL, code: "unavailable" }));
    expect(await askHelperState(refusal.file, HELPER_PROTOCOL)).toBe("not_ready");
    await refusal.close();
    const garbage = await serve((c) => void c.end("not json\n"));
    expect(await askHelperState(garbage.file, HELPER_PROTOCOL)).toBe("not_ready");
    await garbage.close();
    const noNumber = await serve(frame({ ok: true, protocol: "1" }));
    expect(await askHelperState(noNumber.file, HELPER_PROTOCOL)).toBe("not_ready");
    await noNumber.close();
    const closed = await serve((c) => void c.destroy());
    expect(await askHelperState(closed.file, HELPER_PROTOCOL)).toBe("not_ready");
    await closed.close();
    const silent = await serve(() => undefined);
    expect(await askHelperState(silent.file, HELPER_PROTOCOL, 150)).toBe("not_ready");
    await silent.close();
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    expect(await askHelperState(path.join(dir, "nothing.sock"), HELPER_PROTOCOL)).toBe("not_ready");
  });
});
