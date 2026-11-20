import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOST_USAGE_LIMITS, LOST_STREAM, endOfGuestExit, runAgentStream, textChunks } from "../../../src/engines/claude/streamRun.js";
import { GOLDEN_FILE, SCENARIOS, chunked, viaEngine, viaStream } from "./streamScenarios.js";
import { fixtureText } from "./harness.js";
import { makeRig } from "./rig.js";

/**
 * The golden file was recorded by running these same scenarios through the host engine as it was before its line handling moved into
 * `runAgentStream` (events, local-only events and the outcome, clock stamps and the temporary root replaced). The host engine must still
 * produce it byte for byte, and the extracted function, fed the same text in small chunks, must produce the same bytes again.
 */
const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Record<string, string>;

describe("the host engine is unchanged by the extraction", () => {
  it("the golden file covers every scenario", () => {
    expect(Object.keys(golden)).toEqual(SCENARIOS.map((s) => s.name));
  });

  it.each(SCENARIOS)("$name: the host engine gives the recorded events, local events and outcome", async (scenario) => {
    const host = await viaEngine(scenario);
    if (scenario.racy === true) expect((JSON.parse(host.canonical) as { outcome: unknown }).outcome).toEqual((JSON.parse(golden[scenario.name]!) as { outcome: unknown }).outcome);
    else expect(host.canonical).toBe(golden[scenario.name]);
  });

  it.each(SCENARIOS)("$name: runAgentStream, fed the same text, gives the same bytes", async (scenario) => {
    const host = await viaEngine(scenario);
    const direct = await viaStream(scenario, host);
    if (scenario.racy === true) expect((JSON.parse(direct.canonical) as { outcome: unknown }).outcome).toEqual((JSON.parse(host.canonical) as { outcome: unknown }).outcome);
    else expect(direct.canonical).toBe(host.canonical);
  });

  it("the recorded outcomes are the ones each rung is meant to give", () => {
    const reason = (name: string): unknown => (JSON.parse(golden[name]!) as { outcome: { status: string; failureReason?: string } }).outcome.failureReason ?? "ok";
    expect(reason("complete subscription run")).toBe("ok");
    expect(reason("error result")).toBe("agent_error");
    expect(reason("truncated: no result line")).toBe("agent_exit");
    expect(reason("truncated: cut inside the last line")).toBe("agent_exit");
    expect(reason("result seen, then non-zero exit")).toBe("ok");
    expect(reason("resource_limit after a kill")).toBe("resource_limit");
    expect(reason("limit question answered no")).toBe("agent_exit");
    expect(reason("credential mismatch")).toBe("credential_mismatch");
    expect(reason("no init line")).toBe("no_init_line");
    expect(reason("permission mode forced")).toBe("permission_mode_forced");
    expect(reason("unknown option before any line")).toBe("claude_flags_unsupported");
  });
});

describe("a lost stream always ends agent_exit", () => {
  it("a result line that was seen stays in the outcome's fields, but the run is not ok", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "tool use with structured output")!;
    const host = await viaEngine(scenario);
    const lost = JSON.parse((await viaStream(scenario, host, LOST_STREAM)).canonical) as { events: unknown[]; outcome: Record<string, unknown> };
    expect(lost.outcome).toMatchObject({ status: "failed", failureReason: "agent_exit", sessionId: "sess-0001" });
    expect(lost.outcome.agentOutput).toBeDefined();
    expect(lost.events.length).toBeGreaterThan(0);
  });

  it("a lost stream with no lines at all is agent_exit too", async () => {
    const rig = makeRig();
    const outcome = await runAgentStream({ options: rig.startOptions(), workdir: rig.workdir, credentials: { mode: "subscription" }, engineVersion: "v", usageLimits: HOST_USAGE_LIMITS, stdout: chunked(""), stderr: chunked(""), ended: Promise.resolve(LOST_STREAM), terminate: () => undefined, log: { write: () => undefined } });
    expect(outcome).toEqual({ status: "failed", failureReason: "agent_exit", engineVersion: "v" });
  });

  it("a stream that fails while it is read ends like a closed one, and the outcome follows `ended`", async () => {
    const rig = makeRig();
    async function* broken(): AsyncGenerator<string> {
      yield "";
      throw new Error("socket reset");
    }
    const outcome = await runAgentStream({ options: rig.startOptions(), workdir: rig.workdir, credentials: { mode: "subscription" }, engineVersion: "v", usageLimits: HOST_USAGE_LIMITS, stdout: broken(), stderr: chunked(""), ended: Promise.resolve(LOST_STREAM), terminate: () => undefined, log: { write: () => undefined } });
    expect(outcome.failureReason).toBe("agent_exit");
  });

  it("the stream is read to its end before the outcome is decided, whatever order `ended` settles in", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "tool use with structured output")!;
    const rig = makeRig();
    const events: unknown[] = [];
    const outcome = await runAgentStream({
      options: { ...rig.startOptions(), onEvent: (event) => void events.push(event) },
      workdir: rig.workdir,
      credentials: { mode: "subscription" },
      engineVersion: "v",
      usageLimits: HOST_USAGE_LIMITS,
      stdout: chunked(scenario.stream, 3),
      stderr: chunked(""),
      ended: Promise.resolve({ code: 0, signal: null }),
      terminate: () => undefined,
      log: { write: () => undefined },
    });
    expect(outcome.status).toBe("ok");
    expect(events.length).toBeGreaterThan(3);
  });
});

describe("a lost stream is decided first (ruling 17)", () => {
  const toolText = fixtureText("stream.tooluse.synthetic.jsonl");
  const noInitText = toolText.split("\n").filter((l) => l !== "").slice(2).join("\n") + "\n";
  const mismatchText = SCENARIOS.find((s) => s.name === "credential mismatch")!.stream;
  const forced = "warning: Permission mode forced to default\n";
  const unknownOption = "error: unknown option '--bogus'\n";
  const run = async (o: { stdout: string; stderr?: string; credentials?: "subscription"; verify?: boolean; asks?: { n: number } }) => {
    const rig = makeRig();
    let terminated = 0;
    const outcome = await runAgentStream({
      options: rig.startOptions(),
      workdir: rig.workdir,
      credentials: { mode: "subscription" },
      engineVersion: "v",
      usageLimits: HOST_USAGE_LIMITS,
      stdout: chunked(o.stdout),
      stderr: chunked(o.stderr ?? ""),
      ended: Promise.resolve(LOST_STREAM),
      terminate: () => void terminated++,
      log: { write: () => undefined },
      checkVerifyServer: o.verify === true,
      onSession: async () => undefined,
      resourceLimitExceeded: async () => (o.asks !== undefined && o.asks.n++, true),
    });
    return { outcome, terminated };
  };

  it("a lost stream never asks the memory question, even when the answer would be yes", async () => {
    const asks = { n: 0 };
    const { outcome } = await run({ stdout: toolText.split("\n").filter((l) => !l.includes('"type":"result"')).join("\n"), asks });
    expect(outcome).toMatchObject({ status: "failed", failureReason: "agent_exit" });
    expect(asks.n).toBe(0);
  });

  it.each([
    ["credential mismatch", { stdout: mismatchText }],
    ["no init line", { stdout: noInitText }],
    ["permission mode forced", { stdout: toolText, stderr: forced }],
    ["verify browser down", { stdout: toolText.split("\n").slice(0, 1).join("\n") + "\n", verify: true }],
    ["unsupported flag", { stdout: "", stderr: unknownOption }],
  ])("lost + %s ends agent_exit, not the rung's own reason, and asks nothing", async (_name, o) => {
    const asks = { n: 0 };
    const { outcome } = await run({ ...o, asks });
    expect(outcome).toMatchObject({ status: "failed", failureReason: "agent_exit" });
    expect(asks.n).toBe(0);
  });

  it("a rung that stopped the agent still stops it, and its outcome carries no session to resume", async () => {
    const { outcome, terminated } = await run({ stdout: toolText, stderr: forced });
    expect(terminated).toBe(1);
    expect(outcome).toEqual({ status: "failed", failureReason: "agent_exit", engineVersion: "v" });
  });
});

describe("the stderr permission-mode scan does not depend on the log sink", () => {
  const rig0 = () => makeRig();
  const forced = "warning: Permission mode forced to default\n";
  const throwing = { write: (kind: string) => { if (kind === "stderr") throw new Error("ENOSPC"); } };
  it("a throwing stderr sink and the warning on stderr ends permission_mode_forced and stops the agent", async () => {
    const rig = rig0();
    let terminated = 0;
    const outcome = await runAgentStream({
      options: rig.startOptions(), workdir: rig.workdir, credentials: { mode: "subscription" }, engineVersion: "v", usageLimits: HOST_USAGE_LIMITS,
      stdout: chunked(fixtureText("stream.tooluse.synthetic.jsonl")), stderr: chunked(forced), ended: Promise.resolve({ code: 0, signal: null }),
      terminate: () => void terminated++, log: throwing,
    });
    expect(outcome).toEqual({ status: "failed", failureReason: "permission_mode_forced", engineVersion: "v" });
    expect(terminated).toBe(1);
  });

  it("the warning split across chunks, with the sink throwing on every chunk, is still found", async () => {
    const rig = rig0();
    let terminated = 0;
    const outcome = await runAgentStream({
      options: rig.startOptions(), workdir: rig.workdir, credentials: { mode: "subscription" }, engineVersion: "v", usageLimits: HOST_USAGE_LIMITS,
      stdout: chunked(fixtureText("stream.tooluse.synthetic.jsonl")), stderr: chunked("noise\n" + forced, 4), ended: Promise.resolve({ code: 0, signal: null }),
      terminate: () => void terminated++, log: throwing,
    });
    expect(outcome.failureReason).toBe("permission_mode_forced");
    expect(terminated).toBe(1);
  });
});

describe("the usage meter's ceilings come from the caller", () => {
  it("a bounded ceiling is applied: a line claiming more output tokens than the limit is not counted past it", async () => {
    const scenario = SCENARIOS.find((s) => s.name === "tool use with structured output")!;
    const run = async (usageLimits: typeof HOST_USAGE_LIMITS) => {
      const rig = makeRig();
      const locals: Array<{ type?: string; usage?: unknown }> = [];
      await runAgentStream({ options: rig.startOptions(), workdir: rig.workdir, credentials: { mode: "subscription" }, engineVersion: "v", usageLimits, stdout: chunked(scenario.stream), stderr: chunked(""), ended: Promise.resolve({ code: 0, signal: null }), terminate: () => undefined, log: { write: () => undefined }, onLocalEvent: (e) => void locals.push(e as { type?: string; usage?: unknown }) });
      return JSON.stringify(locals.filter((e) => e.type === "usage").map((e) => e.usage));
    };
    const host = await run(HOST_USAGE_LIMITS);
    const bounded = await run({ maxLineInputSideTokens: 1, maxLineOutputTokens: 1, maxIds: 1 });
    expect(host).not.toBe("[]");
    expect(bounded).not.toBe(host);
  });
});

describe("a session id that fails the pattern is dropped", () => {
  it("the outcome carries no session id, and the session hook is not called", async () => {
    const rig = makeRig();
    const bad = fixtureText("stream.tooluse.synthetic.jsonl").replaceAll("sess-0001", "bad id/with spaces");
    let sessions = 0;
    const outcome = await runAgentStream({ options: rig.startOptions(), workdir: rig.workdir, credentials: { mode: "subscription" }, engineVersion: "v", usageLimits: HOST_USAGE_LIMITS, stdout: chunked(bad), stderr: chunked(""), ended: Promise.resolve({ code: 0, signal: null }), terminate: () => undefined, log: { write: () => undefined }, onSession: async () => void sessions++ });
    expect(outcome.status).toBe("ok");
    expect(outcome).not.toHaveProperty("sessionId");
    expect(sessions).toBe(0);
  });
});

describe("rungs the host scenarios do not reach", () => {
  const initText = fixtureText("stream.tooluse.synthetic.jsonl");
  const base = (rig: ReturnType<typeof makeRig>) => ({ options: rig.startOptions(), workdir: rig.workdir, credentials: { mode: "subscription" } as const, engineVersion: "v", usageLimits: HOST_USAGE_LIMITS, stderr: chunked(""), log: { write: () => undefined } });

  it("a playwright job whose fxverify server is not up at the init line ends verify_browser_unavailable and stops the agent", async () => {
    const rig = makeRig();
    let terminated = 0;
    const outcome = await runAgentStream({ ...base(rig), stdout: chunked(initText), ended: Promise.resolve({ code: 0, signal: null }), terminate: () => void terminated++, checkVerifyServer: true });
    expect(outcome).toEqual({ status: "failed", failureReason: "verify_browser_unavailable", engineVersion: "v" });
    expect(terminated).toBe(1);
  });

  it("without the playwright check the same stream is a normal run", async () => {
    const rig = makeRig();
    expect((await runAgentStream({ ...base(rig), stdout: chunked(initText), ended: Promise.resolve({ code: 0, signal: null }), terminate: () => undefined })).status).toBe("ok");
  });

  it("a clean end never asks the memory question", async () => {
    const rig = makeRig();
    let asked = 0;
    await runAgentStream({ ...base(rig), stdout: chunked(initText), ended: Promise.resolve({ code: 0, signal: null }), terminate: () => undefined, resourceLimitExceeded: async () => (asked++, true) });
    expect(asked).toBe(0);
  });

  it("a credential mismatch stops the agent exactly once", async () => {
    const mismatch = SCENARIOS.find((s) => s.name === "credential mismatch")!;
    expect((await viaStream(mismatch, await viaEngine(mismatch))).terminated).toBe(1);
  });
});

describe("the guest's exit frame becomes the engine's end", () => {
  it.each([
    ["an exit code", { exit: 0, signal: null, timedOut: false }, { code: 0, signal: null }],
    ["a non-zero code", { exit: 3, signal: null, timedOut: false }, { code: 3, signal: null }],
    ["a signal", { exit: null, signal: 9, timedOut: false }, { code: 137, signal: 9 }],
    ["a timeout (the guest's kill signal is not the reason)", { exit: null, signal: 9, timedOut: true }, { code: 124, signal: 9 }],
    ["a timeout with no signal reported", { exit: null, signal: null, timedOut: true }, { code: 124, signal: null }],
    ["an exit code and a timeout together: the timeout is the reason", { exit: 0, signal: null, timedOut: true }, { code: 124, signal: null }],
    ["a non-zero code, a signal and a timeout together", { exit: 3, signal: 9, timedOut: true }, { code: 124, signal: 9 }],
    ["an exit code and a signal together: the code wins", { exit: 3, signal: 9, timedOut: false }, { code: 3, signal: null }],
    ["nothing at all is a lost command", { exit: null, signal: null, timedOut: false }, LOST_STREAM],
  ])("%s", (_name, frame, expected) => {
    expect(endOfGuestExit(frame)).toEqual(expected);
  });

  it("each end gives the outcome its code implies", async () => {
    const run = async (end: ReturnType<typeof endOfGuestExit>, stream: string): Promise<unknown> => {
      const rig = makeRig();
      return runAgentStream({ options: rig.startOptions(), workdir: rig.workdir, credentials: { mode: "subscription" }, engineVersion: "v", usageLimits: HOST_USAGE_LIMITS, stdout: chunked(stream), stderr: chunked(""), ended: Promise.resolve(end), terminate: () => undefined, log: { write: () => undefined }, resourceLimitExceeded: async () => false });
    };
    const noResult = fixtureText("stream.tooluse.synthetic.jsonl").split("\n").filter((l) => !l.includes('"type":"result"')).join("\n");
    expect(await run(endOfGuestExit({ exit: 1, signal: null, timedOut: false }), noResult)).toMatchObject({ failureReason: "agent_exit" });
    expect(await run(endOfGuestExit({ exit: null, signal: 9, timedOut: false }), noResult)).toMatchObject({ failureReason: "agent_exit" });
    expect(await run(endOfGuestExit({ exit: null, signal: 9, timedOut: true }), noResult)).toMatchObject({ failureReason: "agent_exit" });
    expect(await run(endOfGuestExit({ exit: null, signal: null, timedOut: false }), fixtureText("stream.tooluse.synthetic.jsonl"))).toMatchObject({ failureReason: "agent_exit" });
    expect(await run(endOfGuestExit({ exit: 0, signal: null, timedOut: false }), fixtureText("stream.tooluse.synthetic.jsonl"))).toMatchObject({ status: "ok" });
  });
});

describe("textChunks", () => {
  it("never splits a multi-byte character across chunks", async () => {
    const bytes = Buffer.from("héllo wörld ✓", "utf8");
    async function* parts(): AsyncGenerator<Buffer> {
      for (let i = 0; i < bytes.length; i += 1) yield bytes.subarray(i, i + 1);
    }
    let text = "";
    for await (const chunk of textChunks(parts())) text += chunk;
    expect(text).toBe("héllo wörld ✓");
  });
});
