import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalOnlyEvent, type NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createClaudeEngine } from "../src/engines/claude/engine.js";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { RUN_ID } from "./engines/claude/harness.js";
import { fixtureText, makeRig } from "./engines/claude/rig.js";

/**
 * The metadata-only rule, end to end through the host tier: a run whose transcript holds model text, tool output and
 * file content reaches the cloud-bound sink as `LocalOnlyEvent`s only, and none of those strings is in them. The full
 * transcript stays in the local 0600 log.
 */
describe("metadata only through hostSandbox", () => {
  it("uploads only LocalOnlyEvents, keeps the transcript local, and starts the agent under the tier's own sandbox block", async () => {
    const uploaded: unknown[] = [];
    const rig = makeRig({ onLocalEvent: (event) => void uploaded.push(event) });
    rig.fake.set("stream.jsonl", fixtureText("stream.tooluse.synthetic.jsonl").replaceAll("/work/", `${rig.workdir}/`));
    const host = createHostSandbox({
      credentials: { mode: "subscription" },
      // The engine is handed the block the tier computed; the rig's own placeholder block is replaced.
      makeRuntime: (sandbox) => createClaudeEngine({ ...rig.config, sandboxSettings: sandbox }),
      home: "/home/jane",
      stateDir: "/home/jane/.fx-runner",
      binaryDir: path.dirname(rig.fake.binary),
      tempRoot: path.join(rig.root, "tmp"),
    });
    const handle = await host.createSandbox({ sandboxName: "rn-meta", retention: { persistent: false }, timeoutMs: 60_000 });
    const events: NormalizedEvent[] = [];
    const { hookFired } = host.startDetached(handle, {
      runId: RUN_ID, role: "executor", roleCard: "card", prompt: "PROMPT-TEXT-FROM-JOB", model: "sonnet", workdir: rig.workdir, capUsd: 0,
      networkPolicy: [{ host: "api.anthropic.com", purpose: "model" }], env: cleanEnv({ mode: "subscription" }), onEvent: (event) => void events.push(event),
    });
    const terminal = await hookFired;

    expect(terminal?.type).toBe("result");
    expect(terminal?.sessionId).toBe("sess-0001");
    expect(JSON.stringify(events)).toContain("PRIVATE-MODEL-TEXT"); // the local transcript keeps it
    expect(uploaded.length).toBeGreaterThan(1);
    for (const event of uploaded) expect(LocalOnlyEvent.safeParse(event).success).toBe(true);
    expect(JSON.stringify(uploaded)).not.toMatch(/PRIVATE-|PROMPT-TEXT-FROM-JOB/);

    const log = path.join(rig.config.logDir, `${RUN_ID}.jsonl`);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(readFileSync(log, "utf8")).toContain("PRIVATE-FILE-CONTENT");

    // The agent ran under the tier's block, not the rig's placeholder.
    const settings = JSON.parse(readFileSync(path.join(rig.config.jobsDir, RUN_ID, "settings.json"), "utf8")) as { sandbox: { enabled: boolean; filesystem: { allowWrite: string[] } } };
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.filesystem.allowWrite[0]).toBe(rig.workdir);
  });
});
