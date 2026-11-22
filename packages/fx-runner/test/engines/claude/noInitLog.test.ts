import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { AgentRunFailed, failureOf, firstLineOf } from "../../../src/sandbox/agentOutcome.js";
import { errorDetail } from "../../../src/daemon/jobHandler.js";
import { RUN_ID, engineFor, makeFake, makeRig } from "./rig.js";

// Assembled at run time, so no token-shaped literal sits in the source.
const TOKEN = `sk-ant-${"api03"}-${"Q9w8E7r6T5".repeat(4)}`;

interface Diag {
  first_type: string;
  first_subtype: string;
  first_is_error: boolean | null;
  line_count: number;
  stderr_tail: string;
}

async function run(stream: string, stderr = ""): Promise<{ outcome: Awaited<ReturnType<typeof outcomeOf>>; diag: Diag | undefined; raw: string }> {
  const fake = makeFake({ stream });
  if (stderr !== "") fake.set("stderr-first.txt", stderr);
  fake.set("hang", "1");
  const rig = makeRig({ fake });
  const { handle } = await engineFor(rig).start(rig.startOptions());
  const outcome = await outcomeOf(handle);
  const raw = readFileSync(path.join(rig.config.logDir, `${RUN_ID}.jsonl`), "utf8");
  const metas = raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { kind: string; line: string })
    .filter((record) => record.kind === "meta")
    .map((record) => JSON.parse(record.line) as { no_init_line?: Diag });
  return { outcome, diag: metas.find((m) => m.no_init_line !== undefined)?.no_init_line, raw };
}

describe("a stream that does not open with the init line says what its first line was", () => {
  it("a result line with is_error: type, subtype and the flag are logged, and the result text is not", async () => {
    const first = JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "SECRET-RESULT-TEXT-XYZ", session_id: "sess-0009" });
    const { outcome, diag } = await run(`${first}\n`);
    expect(outcome).toMatchObject({ status: "failed", failureReason: "no_init_line", firstLine: "result/error" });
    expect(diag).toMatchObject({ first_type: "result", first_subtype: "error", first_is_error: true, line_count: 1 });
    expect(Object.keys(diag!).sort()).toEqual(["first_is_error", "first_subtype", "first_type", "line_count", "stderr_tail"]);
    expect(JSON.stringify(diag)).not.toContain("SECRET-RESULT-TEXT");
  });

  it("a pre-init system line (hook_started): is_error is null", async () => {
    const first = JSON.stringify({ type: "system", subtype: "hook_started", hook_name: "SessionStart" });
    const second = JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none" });
    const { outcome, diag } = await run(`${first}\n${second}\n`);
    expect(outcome).toMatchObject({ failureReason: "no_init_line", firstLine: "system/hook_started" });
    expect(diag).toMatchObject({ first_type: "system", first_subtype: "hook_started", first_is_error: null });
  });

  it("a type or subtype outside the closed charset becomes other, and so does a missing subtype", async () => {
    const first = JSON.stringify({ type: "Weird Type/../x", subtype: 7, is_error: "yes" });
    const { outcome, diag } = await run(`${first}\n`);
    expect(diag).toMatchObject({ first_type: "other", first_subtype: "other", first_is_error: null });
    expect(outcome.firstLine).toBe("other/other");
    const long = JSON.stringify({ type: "a".repeat(41) });
    expect((await run(`${long}\n`)).diag).toMatchObject({ first_type: "other", first_subtype: "other" });
  });

  it("a token in the stderr tail is redacted, and the tail is at most 512 characters", async () => {
    const first = JSON.stringify({ type: "result", subtype: "success", is_error: false });
    const { diag, raw } = await run(`${first}\n`, `${"filler ".repeat(200)}auth failed for ${TOKEN} ‮ end\n`);
    expect(diag!.stderr_tail).toContain("auth failed for");
    expect(diag!.stderr_tail).not.toContain(TOKEN);
    expect(diag!.stderr_tail).not.toContain("Q9w8E7r6T5");
    expect(diag!.stderr_tail).not.toContain("‮");
    expect(diag!.stderr_tail.length).toBeLessThanOrEqual(512);
    expect(diag!.first_is_error).toBe(false);
    expect(raw).not.toContain("Q9w8E7r6T5");
  });

  it("a normal run writes no such line", async () => {
    const init = JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none" });
    const fake = makeFake({ stream: `${init}\n` });
    const rig = makeRig({ fake });
    const { handle } = await engineFor(rig).start(rig.startOptions());
    await outcomeOf(handle);
    expect(readFileSync(path.join(rig.config.logDir, `${RUN_ID}.jsonl`), "utf8")).not.toContain("no_init_line");
  });
});

describe("the journal line carries the first line's words", () => {
  it("errorDetail adds first=type/subtype after the code", () => {
    const error = new AgentRunFailed("no_init_line", undefined, "result/error");
    expect(errorDetail(error)).toBe(": no_init_line; first=result/error");
  });

  it("firstLineOf keeps only a well-formed pair", () => {
    expect(firstLineOf({ firstLine: "system/hook_started" })).toBe("system/hook_started");
    expect(firstLineOf({ firstLine: "System/x y" })).toBeUndefined();
    expect(firstLineOf({})).toBeUndefined();
    expect(failureOf({ status: "failed", failureReason: "no_init_line" })).toBe("no_init_line");
    expect(errorDetail(new AgentRunFailed("no_init_line"))).toBe(": no_init_line");
  });
});
