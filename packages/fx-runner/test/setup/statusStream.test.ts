import { describe, expect, it } from "vitest";
import { COLDSTART_STEPS } from "@fulcrumaxe/runner-protocol";
import { createStatusReader, MAX_STATUS_LINE_BYTES, MAX_STATUS_LINES, type StatusLine } from "../../src/setup/statusStream.js";

/** D#845 ON-8d, Ruling 43 section C: the host's reader of the engine's status stream. Every byte of it came from the guest. */
const read = (chunks: string[]): { lines: StatusLine[]; stops: number; refused: boolean; seen: StatusLine[] } => {
  const seen: StatusLine[] = [];
  const reader = createStatusReader((line) => seen.push(line));
  let stops = 0;
  for (const chunk of chunks) if (reader.feed(chunk) === "stop") stops++;
  return { lines: [...reader.lines], stops, refused: reader.refused, seen };
};

describe("what is accepted", () => {
  it("complete lines, in order, from chunks that cut them anywhere; one callback per line", () => {
    const r = read(["step=preflight sta", "te=started\nstep=prefl", "ight state=ok\nstep=interview state=failed code=missing_topic:identity\n"]);
    expect(r.refused).toBe(false);
    expect(r.seen).toEqual([{ step: "preflight", state: "started" }, { step: "preflight", state: "ok" }, { step: "interview", state: "failed", code: "missing_topic:identity" }]);
  });

  it("a partial last line is dropped, never reported", () => {
    const r = read(["step=preflight state=ok\nstep=interview state=sta"]);
    expect(r.seen).toEqual([{ step: "preflight", state: "ok" }]);
    expect(r.refused).toBe(false);
  });

  it("a skipped step may name cloud_owned, and a repeated ok of a finished step (a resumed run) is allowed", () => {
    const r = read(["step=deps state=ok\nstep=labels state=skipped code=cloud_owned\nstep=deps state=ok\nstep=sandbox_hook state=ok\n"]);
    expect(r.refused).toBe(false);
    expect(r.seen).toHaveLength(4);
  });

  it("every step of the engine's schema, in schema order, is accepted", () => {
    const r = read([COLDSTART_STEPS.map((step) => `step=${step} state=ok\n`).join("")]);
    expect(r.seen.map((l) => l.step)).toEqual([...COLDSTART_STEPS]);
  });
});

describe("what refuses the whole stream (the caller is told to stop the command)", () => {
  const refuses = (text: string): void => {
    const r = read([text, "step=done state=ok\n"]);
    expect(r.refused, JSON.stringify(text).slice(0, 60)).toBe(true);
    expect(r.stops).toBeGreaterThan(0);
    // nothing after the refused line is read, even a good one
    expect(r.seen.some((l) => l.step === "done")).toBe(false);
  };

  it.each([
    ["a line over 128 bytes", `step=preflight state=started ${"x".repeat(MAX_STATUS_LINE_BYTES)}\n`],
    ["an open line over 128 bytes with no newline", "x".repeat(MAX_STATUS_LINE_BYTES + 1)],
    ["a step outside the closed list", "step=reboot state=ok\n"],
    ["a state outside the closed list", "step=deps state=maybe\n"],
    ["a code outside the closed list", "step=deps state=failed code=oops\n"],
    ["a code with a topic that is not missing_topic", "step=deps state=failed code=deps_failed:x\n"],
    ["a failed step with no code", "step=deps state=failed\n"],
    ["a started step with a code", "step=deps state=started code=deps_failed\n"],
    ["an ok step with a code", "step=deps state=ok code=interrupted\n"],
    ["a carriage return", "step=deps state=ok\r\n"],
    ["a second space", "step=deps  state=ok\n"],
    ["a trailing space", "step=deps state=ok \n"],
    ["a non-ASCII byte", "step=deps state=ok é\n"],
    ["a NUL byte", "step=deps state=ok\0\n"],
    ["an empty line", "\n"],
    ["a skipped step with a code other than cloud_owned", "step=labels state=skipped code=interrupted\n"],
    ["a skipped step carrying a topic", "step=labels state=skipped code=missing_topic:identity\n"],
    ["a started step carrying a topic", "step=interview state=started code=missing_topic:identity\n"],
    ["a topic that is not a short plain word (too long)", `step=interview state=failed code=missing_topic:${"a".repeat(33)}\n`],
    ["a topic with a digit first", "step=interview state=failed code=missing_topic:1a\n"],
    ["a failed line with an empty topic", "step=interview state=failed code=missing_topic:\n"],
    ["any line after a failed line, even a good one", "step=deps state=failed code=deps_failed\nstep=done state=ok\n"],
    ["a second failed line", "step=deps state=failed code=deps_failed\nstep=deps state=failed code=deps_failed\n"],
    ["a field out of order", "state=ok step=deps\n"],
    ["a step going back", "step=bundle state=ok\nstep=wiring state=started\n"],
    ["a step going back with an ok it never finished", "step=bundle state=ok\nstep=wiring state=ok\n"],
  ])("%s", (_why, text) => refuses(text));

  it("an open line is refused as soon as it is over the limit, without waiting for a newline that may never come", () => {
    const reader = createStatusReader(() => undefined);
    expect(reader.feed("x".repeat(MAX_STATUS_LINE_BYTES))).toBeUndefined();
    expect(reader.feed("x")).toBe("stop");
  });

  it("64 skipped lines with long codes are refused at the first, so nothing of them can reach a progress report", () => {
    const line = `step=labels state=skipped code=missing_topic:${"a".repeat(31)}\n`;
    const r = read([line.repeat(64)]);
    expect(r.refused).toBe(true);
    expect(r.seen).toEqual([]);
  });

  it("a topic is accepted only on a failed line, as a short plain word", () => {
    expect(read([`step=interview state=failed code=missing_topic:${"a".repeat(31)}\n`]).refused).toBe(false);
    expect(read(["step=interview state=failed code=missing_topic:a_b\n"]).refused).toBe(false);
  });

  it("a 65th line", () => {
    const line = "step=preflight state=started\n";
    expect(read([line.repeat(MAX_STATUS_LINES)]).refused).toBe(false);
    expect(read([line.repeat(MAX_STATUS_LINES + 1)]).refused).toBe(true);
  });

  it("stays refused: later chunks only answer stop", () => {
    const reader = createStatusReader(() => undefined);
    expect(reader.feed("bogus\n")).toBe("stop");
    expect(reader.feed("step=done state=ok\n")).toBe("stop");
    expect(reader.lines).toEqual([]);
  });
});
