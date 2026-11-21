import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StartOptions } from "@fulcrumaxe/runner-protocol";
import { SUBSCRIPTION_TOKEN_VAR } from "../../../src/job/cleanEnv.js";
import { GuestBindings } from "../../../src/vm/sandboxd/guestBindings.js";
import { guestMakeRuntime } from "../../../src/vm/sandboxd/guestRuntime.js";
import { JobTokenError, type TokenSandbox } from "../../../src/vm/sandboxd/jobToken.js";
import type { StreamSpec } from "../../../src/vm/sandboxd/sandboxd.js";
import type { GuestStream } from "../../../src/vm/sandboxd/streamCommand.js";
import { FULL_HELP, RUN_ID } from "../../engines/claude/harness.js";

/**
 * D#587 B-5b-3c-i: the per-sandbox bindings, the token slot over `JobToken`, and the guest runtime reaching the token only through them. Everything here is a fake of the
 * daemon's sandbox handle (named so); the real frames and the real guest are `vmToken.real.test.ts` and the dispatched real-VM run.
 */
const WORKDIR = "/vercel/sandbox/work";
const SENTINEL = ["sk-ant", "oat01-BINDINGSENTINEL0123456789abcdef"].join("-");
const roots: string[] = [];
afterEach(() => void roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const scratch = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "fx-gb-"));
  roots.push(dir);
  return dir;
};

/** A stream that has already said its piece: the frames, then the exit. */
function streamOf(stdout: string, id = "fake"): GuestStream {
  const done = Promise.resolve({ exit: 0, signal: null, timedOut: false });
  return {
    id,
    frames: (async function* () {
      if (stdout !== "") yield { stream: "stdout" as const, data: Buffer.from(stdout) };
    })(),
    done,
    kill: async () => undefined,
    abort: () => undefined,
  };
}

interface Fake extends TokenSandbox { specs: StreamSpec[]; log: string[]; held: Buffer | undefined }
function fakeSandbox(name: string, log: string[] = []): Fake {
  const fake: Fake = {
    specs: [],
    log,
    held: undefined,
    deliverToken: async (t) => {
      log.push(`${name} deliver`);
      fake.held = Buffer.from(t);
      t.fill(0);
    },
    wipeToken: async () => {
      log.push(`${name} wipe`);
      fake.held = undefined;
    },
    runCommand: () => Promise.reject(new Error("no batch exec expected")),
    runStream: async (spec) => {
      fake.specs.push(spec);
      log.push(`${name} ${spec.withToken === true ? "cli" : "plain"}`);
      const args = spec.args ?? [];
      return streamOf(args[0] === "--version" ? "2.1.295 (Claude Code)\n" : args[0] === "--help" ? FULL_HELP : "", spec.id);
    },
    stop: async () => undefined,
    delete: async () => undefined,
  };
  return fake;
}

const startOpts = (): StartOptions => ({ runId: RUN_ID, role: "executor", roleCard: "card", prompt: "PROMPT-TEXT", model: "sonnet", workdir: WORKDIR, capUsd: 1, onEvent: () => undefined }) as StartOptions;
const token = (): Buffer => Buffer.from(SENTINEL);

describe("the bindings (sandbox name -> handle and JobToken)", () => {
  it("a name is bound once; unbinding frees it; two names stay apart", () => {
    const b = new GuestBindings();
    const one = fakeSandbox("a");
    b.bind("a", one);
    expect(() => b.bind("a", fakeSandbox("a2"))).toThrow("guest_already_bound");
    const second = b.bind("b", fakeSandbox("b"));
    expect(b.tokenOf("a")).not.toBe(second);
    b.unbind("a");
    b.unbind("a"); // repeating is safe
    expect(b.tokenOf("a")).toBeUndefined();
    expect(() => b.bind("a", fakeSandbox("a3"))).not.toThrow();
  });

  it("launch: the token spec goes through launchStream (flag on, ordinary user), every other spec through the plain stream with the flag off", async () => {
    const b = new GuestBindings();
    const sb = fakeSandbox("a");
    b.bind("a", sb);
    await b.slot("a", token).deliver(new AbortController().signal);
    await b.launch("a")({ id: "q-1", cmd: "claude", args: ["--version"], user: "ubuntu" });
    await b.launch("a")({ id: "cli-1", cmd: "/bin/sh", args: ["-c", "x"], withToken: true, user: "root" });
    expect(sb.specs[0]).toMatchObject({ id: "q-1", withToken: false, user: "ubuntu" });
    expect(sb.specs[1]).toMatchObject({ id: "cli-1", withToken: true, user: "ubuntu" }); // a root request is overridden by the module's pin
  });

  it("with three bindings, a slot and a launch reach their own VM, never the first one bound (FU-175)", async () => {
    const log: string[] = [];
    const b = new GuestBindings();
    const [one, two, three] = [fakeSandbox("one", log), fakeSandbox("two", log), fakeSandbox("three", log)];
    b.bind("one", one);
    b.bind("two", two);
    b.bind("three", three);
    const slot = b.slot("three", token);
    await slot.deliver(new AbortController().signal);
    expect(log).toEqual(["three deliver"]);
    expect(one.held).toBeUndefined();
    expect(three.held?.toString()).toBe(SENTINEL);
    await b.launch("two")({ id: "q-2", cmd: "claude", args: ["--version"] });
    await slot.wipe();
    expect(log).toEqual(["three deliver", "two plain", "three wipe"]);
    expect(one.specs).toEqual([]);
  });

  it("an unbound name, a name after unbind and a launch with no delivery are refused with the closed code, and the guest is not touched", async () => {
    const b = new GuestBindings();
    const sb = fakeSandbox("a");
    await expect(b.launch("nope")({ id: "x-1", cmd: "c" })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    b.bind("a", sb);
    await expect(b.launch("a")({ id: "x-2", cmd: "c", withToken: true })).rejects.toBeInstanceOf(JobTokenError);
    b.unbind("a");
    await expect(b.launch("a")({ id: "x-3", cmd: "c" })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    expect(sb.specs).toEqual([]);
    await expect(b.slot("nope", token).wipe()).rejects.toBeInstanceOf(JobTokenError);
    await expect(b.slot("nope", token).deliver(new AbortController().signal)).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
  });

  it("the slot delivers a fresh buffer (zeroed afterwards) and wipes through the same JobToken", async () => {
    const b = new GuestBindings();
    const sb = fakeSandbox("a");
    b.bind("a", sb);
    const given = token();
    const slot = b.slot("a", () => given);
    await slot.deliver(new AbortController().signal);
    expect(sb.held?.toString()).toBe(SENTINEL);
    expect(given.every((x) => x === 0)).toBe(true);
    await slot.wipe();
    expect(sb.log).toEqual(["a deliver", "a wipe"]);
    expect(sb.held).toBeUndefined();
  });

  it("an unconfirmed wipe is the module's closed code, and no new launch starts", async () => {
    const b = new GuestBindings();
    const sb = fakeSandbox("a");
    sb.wipeToken = async () => {
      throw new Error("guest said no");
    };
    b.bind("a", sb);
    const slot = b.slot("a", token);
    await slot.deliver(new AbortController().signal);
    await expect(slot.wipe()).rejects.toMatchObject({ code: "vm_teardown_incomplete" });
    await expect(b.launch("a")({ id: "late-1", cmd: "c", withToken: true })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
  });

  it("the timeout hook is always passed (FU-170): the limit the VM was bound with first, else the port's own answer, else nothing so the runtime's bounded fallback applies", () => {
    const limits = new Map([["a", 90_000]]);
    const b = new GuestBindings({ timeoutMsOf: (n) => limits.get(n) });
    expect(b.binding({ name: "a" } as never).timeoutMs?.()).toBe(90_000);
    expect(b.binding({ name: "zz" } as never).timeoutMs?.()).toBeUndefined();
    const plain = new GuestBindings();
    expect(typeof plain.binding({ name: "a" } as never).timeoutMs).toBe("function");
    expect(plain.binding({ name: "a" } as never).timeoutMs?.()).toBeUndefined();
    plain.bind("a", fakeSandbox("a"), 7_200_000);
    expect(plain.binding({ name: "a" } as never).timeoutMs?.()).toBe(7_200_000);
    plain.bind("b", fakeSandbox("b"));
    expect(plain.binding({ name: "b" } as never).timeoutMs?.()).toBeUndefined();
    plain.unbind("a");
    expect(plain.binding({ name: "a" } as never).timeoutMs?.()).toBeUndefined();
  });
});

describe("the guest runtime reaches the token only through the bindings (scrub and sentinel, over fakes)", () => {
  async function run(over: { deliver: boolean }) {
    const log: string[] = [];
    const logDir = scratch();
    const sb = fakeSandbox("vm-a", log);
    const other = fakeSandbox("vm-b", log);
    const b = new GuestBindings();
    b.bind("vm-a", sb);
    b.bind("vm-b", other);
    const written: Array<Array<{ path: string; content: string; mode?: number }>> = [];
    const make = guestMakeRuntime({ credentials: { mode: "subscription" }, logDir }, b.binding);
    const guest = { name: "vm-a", writeFiles: async (files: Array<{ path: string; content: string; mode?: number }>) => void written.push(files) };
    const runtime = make(guest as never, { env: {} } as never);
    if (over.deliver) await b.slot("vm-a", token).deliver(new AbortController().signal);
    const started = await runtime.start(startOpts()).then((r) => ({ handle: r.handle }), (error: unknown) => ({ error }));
    if ("handle" in started) await Promise.resolve(started.handle.done).catch(() => undefined);
    return { b, sb, other, log, logDir, written, started };
  }

  it("with a delivery: the CLI is the one token launch (ordinary user, scrub on), the probes are plain, and the other sandbox is untouched", async () => {
    const { sb, other, log, started } = await run({ deliver: true });
    expect("handle" in started).toBe(true);
    const cli = sb.specs.filter((s) => s.withToken === true);
    expect(cli).toHaveLength(1);
    expect(cli[0]).toMatchObject({ withToken: true, user: "ubuntu", cmd: "/bin/sh" });
    expect(cli[0]!.env?.["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"]).toBe("1");
    for (const s of sb.specs.filter((x) => x.withToken !== true)) expect(s).toMatchObject({ withToken: false, user: "ubuntu" });
    expect(log.indexOf("vm-a deliver")).toBeLessThan(log.indexOf("vm-a cli"));
    expect(other.specs).toEqual([]);
    expect(log.filter((l) => l.startsWith("vm-b"))).toEqual([]);
  });

  it("the token's variable and value are in no argv, env, written file, stdin or log file the wiring builds", async () => {
    const { sb, written, logDir } = await run({ deliver: true });
    for (const spec of sb.specs) {
      expect(Object.keys(spec.env ?? {})).not.toContain(SUBSCRIPTION_TOKEN_VAR);
      const seen = JSON.stringify({ ...spec, stdin: spec.stdin?.toString("latin1") });
      expect(seen).not.toContain(SENTINEL);
      expect(seen).not.toContain(SUBSCRIPTION_TOKEN_VAR);
    }
    expect(JSON.stringify(written)).not.toContain(SENTINEL);
    expect(JSON.stringify(written)).not.toContain(SUBSCRIPTION_TOKEN_VAR);
    for (const file of readdirSync(logDir)) expect(readFileSync(path.join(logDir, file), "utf8")).not.toContain(SENTINEL);
  });

  it("with no delivery, the start fails with the closed code and no CLI launch is made", async () => {
    const { sb, started } = await run({ deliver: false });
    expect(started).toMatchObject({ error: expect.objectContaining({ code: "vm_token_delivery_failed" }) as unknown });
    expect(sb.specs.filter((s) => s.withToken === true)).toEqual([]);
  });

  it("after the wipe a second CLI launch (a resume without a new delivery) is refused", async () => {
    const { b, sb } = await run({ deliver: true });
    await b.slot("vm-a", token).wipe();
    await expect(b.launch("vm-a")({ id: "resume-1", cmd: "/bin/sh", withToken: true })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    expect(sb.specs.filter((s) => s.withToken === true)).toHaveLength(1);
  });
});
