import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_TOKEN_VAR } from "../../src/job/cleanEnv.js";
import { BootFactsRefused } from "../../src/vm/bootFacts.js";
import type { TargetListing } from "../../src/vm/bootGate.js";
import { createLiveMicrovm, liveMicrovmComplete } from "../../src/vm/sandboxd/live.js";
import type { TokenSandbox } from "../../src/vm/sandboxd/jobToken.js";
import { createMicrovmParts } from "../../src/vm/liveParts.js";
import { RUN_ID } from "../engines/claude/harness.js";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";
const TEST_HOME = "/tmp/fictional-runner-home";

/**
 * D#587 B-5b-3c-iii: the entry point's parts of the live stack (`scripts/vm-live-parts.mjs`, what `bin/fx-runner.mjs` hands `run`), over fakes of the machine: the TUF listing, the
 * installed manifest, the environment and the state directory. The real listing, manifest and helper are the dispatched real-VM run's.
 */
const SENTINEL = ["sk-ant", "oat01-LIVEPARTSSENTINEL0123456789abcdef"].join("-");
const notConfigured = { ok: false, state: "not_configured" } as unknown as TargetListing;

interface Seen { env: string[]; logDir: number }
/** An environment that records which names are read, so a test can say when the token was and was not touched. */
function recordingEnv(values: Record<string, string>, seen: Seen): Record<string, string | undefined> {
  return new Proxy(values, { get: (target, name) => (typeof name === "string" && seen.env.push(name), target[name as string]) });
}

function parts(over: { euid?: number | undefined; uid?: number | undefined; env?: Record<string, string>; seen?: Seen } = {}) {
  const seen = over.seen ?? { env: [], logDir: 0 };
  const env = recordingEnv(over.env ?? { [SUBSCRIPTION_TOKEN_VAR]: SENTINEL }, seen);
  const built = createMicrovmParts({
    euid: "euid" in over ? over.euid : 4711,
    uid: "uid" in over ? over.uid : 4711,
    platform: "linux",
    helperSocket: "/fake/helper.sock",
    tuf: { listTargets: async () => notConfigured },
    readManifest: () => "{}",
    nodeArch: "x64",
    now: () => 0,
    egress: { startProxy: async () => ({ close: async () => undefined }), startReverse: async () => ({ close: async () => undefined }) },
    logDir: () => (seen.logDir++, "/fake/state/logs"),
    // what the entry point does, over a fake environment
    readToken: () => Buffer.from(env[SUBSCRIPTION_TOKEN_VAR] ?? "", "utf8"),
  });
  return { built, seen };
}

afterEach(() => vi.restoreAllMocks());

describe("the entry point supplies every part, and the stack is wired only with all of them", () => {
  it("a machine with a usable uid composes the whole stack; the parts are the production ones (boot facts, the template, its RAM, the guest runtime, the bindings)", () => {
    const { built } = parts();
    expect(liveMicrovmComplete(built)).toBe(true);
    expect(createLiveMicrovm(built, TEST_HOME)).toBeDefined();
    expect(built.template).toBe("fx-agent");
    expect(built.memMb).toBe(512);
    expect(typeof built.boot.facts).toBe("function");
    expect(typeof built.boot.listTargets).toBe("function");
    expect(typeof built.makeRuntime).toBe("function");
    expect(typeof built.bindings.binding).toBe("function");
  });

  it("a root process, or one with no uid, is not wired: the same answer `doctor` gives", () => {
    for (const over of [{ euid: 0 }, { euid: undefined }, { uid: 0 }, { uid: undefined }]) {
      const { built } = parts(over);
      expect(liveMicrovmComplete(built), JSON.stringify(over)).toBe(false);
      expect(createLiveMicrovm(built, TEST_HOME), JSON.stringify(over)).toBeUndefined();
    }
  });

  it("the boot facts are the signed-listing ones and fail closed with a closed code (no listing configured: no VM may boot), never a digest or a path", async () => {
    const { built } = parts();
    const refused = await Promise.resolve(built.boot.facts("fx-agent")).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BootFactsRefused);
    expect(refused).toMatchObject({ code: "image_not_configured" });
    expect(String((refused as Error).message)).not.toMatch(/[0-9a-f]{40}|\/fake/);
  });
});

describe("the model token is read at the entry point's reader only", () => {
  it("building the parts and the stack never reads the environment's token; each call of the reader is a fresh buffer, and zeroing one does not touch the next", () => {
    const { built, seen } = parts();
    createLiveMicrovm(built, TEST_HOME);
    expect(seen.env).not.toContain(SUBSCRIPTION_TOKEN_VAR);
    const first = built.readToken();
    expect(first.toString()).toBe(SENTINEL);
    first.fill(0);
    const second = built.readToken();
    expect(second).not.toBe(first);
    expect(second.toString()).toBe(SENTINEL);
    expect(seen.env.filter((n) => n === SUBSCRIPTION_TOKEN_VAR)).toHaveLength(2);
  });

  it("an absent or empty token is an empty buffer, which the token step refuses with its one closed code (nothing is sent, the VM never holds one)", async () => {
    for (const env of [{}, { [SUBSCRIPTION_TOKEN_VAR]: "" }] as Array<Record<string, string>>) {
      const { built } = parts({ env });
      expect(built.readToken()).toHaveLength(0);
      const sent: Buffer[] = [];
      const guest = { deliverToken: async (t: Buffer) => void sent.push(Buffer.from(t)), wipeToken: async () => undefined } as unknown as TokenSandbox;
      built.bindings.bind("rn-a", guest);
      await expect(built.bindings.slot("rn-a", built.readToken).deliver(new AbortController().signal)).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
      expect(sent).toEqual([]);
    }
  });

  it("through the token step the guest gets the token once; a failing delivery, with the token in the helper's own error text, puts it in no log line and no error", async () => {
    const lines: string[] = [];
    for (const method of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
    const { built } = parts();
    const ok: Buffer[] = [];
    built.bindings.bind("rn-ok", { deliverToken: async (t: Buffer) => void ok.push(Buffer.from(t)), wipeToken: async () => undefined } as unknown as TokenSandbox);
    await built.bindings.slot("rn-ok", built.readToken).deliver(new AbortController().signal);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.toString()).toBe(SENTINEL);
    built.bindings.bind("rn-bad", { deliverToken: async (t: Buffer) => { throw new Error(`the guest said no to ${t.toString()}`); }, wipeToken: async () => undefined } as unknown as TokenSandbox);
    const failure = await built.bindings.slot("rn-bad", built.readToken).deliver(new AbortController().signal).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "vm_token_delivery_failed" });
    expect(JSON.stringify(failure) + String((failure as Error).message) + String((failure as Error).stack)).not.toContain(SENTINEL);
    expect(lines.join("\n")).not.toContain(SENTINEL);
  });

  it("the guest runtime is built per start, and the state directory is asked for then, not when the parts are made", () => {
    const { built, seen } = parts();
    expect(seen.logDir).toBe(0);
    const guest = { name: "rn-live", writeFiles: async () => undefined };
    const runtime = built.makeRuntime(guest as never, { runId: RUN_ID, role: "executor", roleCard: "c", prompt: "p", model: "sonnet", workdir: "/w", capUsd: 1, networkPolicy: [], env: {}, onEvent: () => undefined } as never);
    expect(typeof runtime.start).toBe("function");
    expect(seen.logDir).toBe(1);
  });
});

describe("the source of the entry point (guards)", () => {
  const bin = readFileSync(path.join(PACKAGE_DIR, "bin", "fx-runner.mjs"), "utf8");
  const partsSource = readFileSync(path.join(PACKAGE_DIR, "src", "vm", "liveParts.ts"), "utf8");
  const runSource = readFileSync(path.join(PACKAGE_DIR, "src", "commands", "run.ts"), "utf8");

  it("the bin builds the parts through the one function, with no hand-written object that could leave a part out, and hands them to both `run` and `doctor`", () => {
    expect(bin).toMatch(/const microvmParts = createMicrovmParts\(/);
    expect(bin).not.toMatch(/microvmParts = \{/);
    expect(bin).toMatch(/microvm: microvmParts,/);
    expect(bin).toMatch(/liveMicrovmComplete\(microvmParts\)/);
  });

  it("the model token is read in one place, the bin's `readToken`, and nowhere else in the wiring", () => {
    expect(bin.match(/process\.env\[SUBSCRIPTION_TOKEN_VAR\]/g)).toHaveLength(1);
    expect(bin).toMatch(/readToken: \(\) => readVmToken\(stateDirFor\(process\.env\.HOME, process\.env\.FX_RUNNER_HOME\), process\.getuid\?\.\(\), \(\) => process\.env\[SUBSCRIPTION_TOKEN_VAR\]\)/);
    expect(partsSource).not.toContain(SUBSCRIPTION_TOKEN_VAR);
    expect(partsSource).not.toMatch(/readToken\s*\(/);
    expect(runSource).not.toMatch(/readToken\s*\(/);
    expect(runSource).not.toContain(SUBSCRIPTION_TOKEN_VAR);
  });
});
