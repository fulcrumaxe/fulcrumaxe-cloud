import { describe, expect, it } from "vitest";
import { EngineUnavailable, chooseEngine, engineRefusal, selectSandbox } from "../../src/vm/engineGate.js";
import { ENGINE_LINES, type EngineLine } from "../../src/vm/limits.js";
import { hostFactsOf, readHostFacts } from "../../src/hostFacts.js";
import { verifyJob } from "../../src/daemon/verifyJob.js";
import { KEYRING, NOW, signedJob } from "../helpers/signedJob.js";

describe("the engine a runner reports", () => {
  it("is microvm only when the machine's line says so and this build can start a job in a VM", () => {
    const lines = Object.values(ENGINE_LINES) as EngineLine[];
    for (const line of lines) {
      expect(chooseEngine(line, true), `${line} / wired`).toBe(line === ENGINE_LINES.microvm ? "microvm" : "os_sandbox");
      expect(chooseEngine(line, false), `${line} / not wired`).toBe("os_sandbox");
    }
    expect(chooseEngine(undefined, true)).toBe("os_sandbox");
  });

  it("is the engine the hello facts carry, and os_sandbox when none is given", () => {
    const input = { platform: "linux" as const, arch: "x64", totalMemBytes: 16 * 1024 ** 3, cpus: 4 };
    expect(hostFactsOf(input)?.sandbox_engine).toBe("os_sandbox");
    expect(hostFactsOf({ ...input, engine: "microvm" })?.sandbox_engine).toBe("microvm");
    expect(readHostFacts()?.sandbox_engine).toBe("os_sandbox");
  });
});

describe("a job that needs a VM is never run on anything else", () => {
  it("engineRefusal names the mismatch, and only that", () => {
    expect(engineRefusal("microvm", "os_sandbox")).toBe("engine_required");
    expect(engineRefusal("microvm", "microvm")).toBeUndefined();
    expect(engineRefusal(undefined, "os_sandbox")).toBeUndefined();
    expect(engineRefusal(undefined, "microvm")).toBeUndefined();
  });

  it("the job gate refuses a signed requires_engine job on an os_sandbox runner, whether the engine is passed or left out", () => {
    const signed = signedJob({ requires_engine: "microvm" });
    expect(verifyJob(signed, KEYRING, NOW)).toEqual({ ok: false, reason: "engine_required" });
    expect(verifyJob(signed, KEYRING, NOW, "os_sandbox")).toEqual({ ok: false, reason: "engine_required" });
    expect(verifyJob(signed, KEYRING, NOW, "microvm")).toEqual({ ok: true, job: signed.job });
  });

  it("a job with no requirement runs on either engine, and the signature is still checked first", () => {
    const plain = signedJob();
    expect(verifyJob(plain, KEYRING, NOW, "os_sandbox").ok).toBe(true);
    expect(verifyJob(plain, KEYRING, NOW, "microvm").ok).toBe(true);
    const tampered = { ...signedJob({ requires_engine: "microvm" }), job: { ...signedJob({ requires_engine: "microvm" }).job, model_hint: "opus" } };
    expect(verifyJob(tampered, KEYRING, NOW, "microvm")).toEqual({ ok: false, reason: "job_signature_invalid" });
  });
});

describe("the sandbox for an engine", () => {
  it("os_sandbox gets the OS sandbox, microvm gets the microVM one", () => {
    expect(selectSandbox("os_sandbox", { os_sandbox: "os", microvm: "vm" })).toBe("os");
    expect(selectSandbox("microvm", { os_sandbox: "os", microvm: "vm" })).toBe("vm");
    expect(selectSandbox("os_sandbox", { os_sandbox: "os" })).toBe("os");
  });

  it("microvm without a microVM sandbox is an error, never the OS sandbox", () => {
    expect(() => selectSandbox("microvm", { os_sandbox: "os" })).toThrow(EngineUnavailable);
    expect(() => selectSandbox("microvm", { os_sandbox: "os", microvm: undefined })).toThrow(EngineUnavailable);
  });
});
