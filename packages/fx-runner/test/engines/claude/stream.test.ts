import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { LineBuffer } from "../../../src/engines/claude/stream.js";
import { RUN_ID, engineFor, fixtureText, makeRig } from "./rig.js";

describe("stream", () => {
  it("a run maps every line to the local transcript, projects metadata only, and returns the session id and envelope", async () => {
    const local: LocalOnlyEvent[] = [];
    const rig = makeRig({ onLocalEvent: (event) => void local.push(event) });
    rig.fake.set("stream.jsonl", fixtureText("stream.tooluse.synthetic.jsonl").replaceAll("/work/", `${rig.workdir}/`));
    const opts = rig.startOptions();
    const { handle } = await engineFor(rig).start(opts);
    const outcome = await outcomeOf(handle);
    expect(outcome).toEqual({ status: "ok", engineVersion: "2.1.294", sessionId: "sess-0001", agentOutput: { verdict: "done" } });
    expect((opts.events as Array<{ type: string; seq: number }>).map((event) => [event.type, event.seq])).toEqual([["system", 0], ["assistant", 1], ["user", 2], ["result", 3]]);
    // The local transcript keeps the model's text; the cloud-bound events have no field that could hold it.
    expect(JSON.stringify(opts.events)).toContain("PRIVATE-MODEL-TEXT");
    expect(local.map((event) => event.type)).toEqual(["engine_version", "tool_use", "file_changed", "usage"]);
    expect(local[1]).toMatchObject({ tool_name: "Write", file_path: "src/a.ts" });
    expect(local[2]).toMatchObject({ type: "file_changed", file_path: "src/a.ts" });
    expect(local[3]).toMatchObject({ usage: { input: 12, output: 7, usd: 0.0123 } });
    expect(local.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
    for (const event of local) expect(LocalOnlyEvent.safeParse(event).success).toBe(true);
    expect(JSON.stringify(local)).not.toMatch(/PRIVATE-/);
  });

  it("the raw stream goes only to <logDir>/<run>.jsonl, mode 0600, one JSON record per line", async () => {
    const rig = makeRig();
    const { handle } = await engineFor(rig).start(rig.startOptions());
    await outcomeOf(handle);
    const file = path.join(rig.config.logDir, `${RUN_ID}.jsonl`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const records = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; line: string });
    const expected = fixtureText("stream.subscription.jsonl").trim().split("\n");
    // The shared redactor also blanks a value under a key that looks like a credential field (the init line's key source).
    expect(records.filter((record) => record.kind === "stdout").map((record) => record.line.replace('"apiKeySource":"[redacted]"', '"apiKeySource":"none"'))).toEqual(expected);
  });

  it("a run that ends with no result line fails as agent_exit, and a result with is_error fails as agent_error", async () => {
    const lines = fixtureText("stream.tooluse.synthetic.jsonl").trim().split("\n");
    const noResult = makeRig({ fake: (await import("./rig.js")).makeFake({ stream: `${lines.slice(0, 2).join("\n")}\n` }) });
    expect((await outcomeOf((await engineFor(noResult).start(noResult.startOptions())).handle)).failureReason).toBe("agent_exit");
    const errored = (await import("./rig.js")).makeFake({ stream: `${lines.slice(0, 2).join("\n")}\n${lines[3]!.replace('"is_error":false', '"is_error":true')}\n` });
    const rig = makeRig({ fake: errored });
    expect((await outcomeOf((await engineFor(rig).start(rig.startOptions())).handle)).failureReason).toBe("agent_error");
  });

  it("a line that is not JSON is skipped, and an over-long line is dropped whole", () => {
    const buffer = new LineBuffer();
    expect(buffer.push('{"a":1}\npart')).toEqual(['{"a":1}']);
    expect(buffer.push("ial\n")).toEqual(["partial"]);
    expect(buffer.push("x".repeat(5 * 1024 * 1024))).toEqual([]);
    expect(buffer.push("tail\nok\n")).toEqual(["ok"]);
    expect(buffer.end()).toEqual([]);
  });
});
