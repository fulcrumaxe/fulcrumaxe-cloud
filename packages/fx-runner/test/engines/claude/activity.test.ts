import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityField, normalizeMessage, type LocalOnlyEvent, type ToolUse } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../../src/daemon/client.js";
import { realClock, startLease } from "../../../src/daemon/lease.js";
import { activityOf } from "../../../src/engines/claude/activity.js";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { generateRunnerKey } from "../../../src/keys.js";
import { signedJob } from "../../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../../helpers/strictRunnerCloud.js";
import { RUN_ID, engineFor, fixtureText, makeRig } from "./rig.js";

/** A bare 40-character value: no token shape, so the shared command check (`commandIsClean`) cannot know it for a credential. */
const RUN_VALUE = ["q7Zr2LmVx9", "TnB4wKc8Hd", "Ys3PfG6aUe", "1JoN5iRt0e"].join("");

describe("activityOf: the run's real secrets are checked on top of the shared reduction", () => {
  const use = (over: Partial<ToolUse>): ToolUse => ({ id: "t1", tool: "command", ...over });

  it("keeps a clean command, path and term; a write or an unknown tool has no activity", () => {
    expect(activityOf(use({ command: "pnpm test" }), [RUN_VALUE])).toEqual({ tool: "command", command: "pnpm test" });
    expect(activityOf(use({ tool: "read", path: "src/a.ts" }), [RUN_VALUE])).toEqual({ tool: "read", path: "src/a.ts" });
    expect(activityOf(use({ tool: "search", pattern: "TODO" }), [RUN_VALUE])).toEqual({ tool: "search", pattern: "TODO" });
    expect(activityOf({ id: "w", writes: true }, [RUN_VALUE])).toBeUndefined();
  });

  it("a command that holds the run's API key or token value is sent as its kind alone, never cut down", () => {
    expect(activityOf(use({ command: `echo ${RUN_VALUE} now` }), [RUN_VALUE])).toEqual({ tool: "command" });
    expect(activityOf(use({ tool: "test", command: `run-${RUN_VALUE}` }), ["unrelated-key-value", RUN_VALUE])).toEqual({ tool: "test" });
    expect(activityOf(use({ tool: "read", path: `${RUN_VALUE}.ts` }), [RUN_VALUE])).toEqual({ tool: "read" });
    expect(activityOf(use({ tool: "search", pattern: RUN_VALUE.slice(0, 20) + RUN_VALUE.slice(20) }), [RUN_VALUE])).toEqual({ tool: "search" });
  });

  it("never returns a shape the protocol refuses: a control character or an over-long field falls back to the kind", () => {
    expect(activityOf(use({ command: "a\u0007b" }), [])).toEqual({ tool: "command" });
    expect(activityOf(use({ command: "x".repeat(201) }), [])).toEqual({ tool: "command" });
    expect(activityOf(use({ tool: "read", path: "p".repeat(91) }), [])).toEqual({ tool: "read" });
    expect(ActivityField.safeParse(activityOf(use({ command: "x".repeat(200) }), [])).success).toBe(true);
  });
});

describe("a recorded stream through the engine, the lease and the real client, against a strict cloud", () => {
  let cloud: StrictRunnerCloud;
  let saved: string | undefined;
  beforeEach(async () => {
    cloud = await startStrictRunnerCloud();
    saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    await cloud.close();
  });

  const streamText = (): string => fixtureText("stream.activity.synthetic.jsonl").replaceAll("__RUN_SECRET__", RUN_VALUE);

  /** Runs the fixture through a real engine whose events feed a real lease, which sends them with the real signing client. */
  async function runFixture(mode: "subscription" | "api_key") {
    if (mode === "subscription") process.env.CLAUDE_CODE_OAUTH_TOKEN = RUN_VALUE;
    const key = generateRunnerKey();
    cloud.trust(key.publicJwk);
    const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
    cloud.enqueue(signedJob({ run_id: RUN_ID }));
    const claimed = await client.claim();
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    const lease = startLease({ client, clock: realClock, runId: claimed.runId, leaseGeneration: claimed.leaseGeneration, heartbeatMs: 1e9, flushMs: 1e9, activityFlushMs: 1e9 });
    const local: LocalOnlyEvent[] = [];
    const rig = makeRig({
      credentials: mode === "api_key" ? { mode: "api_key", apiKey: RUN_VALUE } : { mode: "subscription" },
      onLocalEvent: (event) => {
        local.push(event);
        // A real run's tool uses are seconds apart; the fixture is replayed in milliseconds, so they are spaced here and the lease's 250 ms
        // coalescing (tested in leaseActivity.test.ts) does not fold them.
        lease.push({ ...event, ts: new Date(Date.parse("2026-10-09T12:00:00.000Z") + local.length * 1000).toISOString() });
      },
    });
    const text = streamText().replaceAll('"cwd":"/work"', `"cwd":"${rig.workdir}"`).replaceAll("/work/", `${rig.workdir}/`).replaceAll('"path":"/work"', `"path":"${rig.workdir}"`);
    rig.fake.set("stream.jsonl", mode === "api_key" ? text.replace('"apiKeySource":"none"', '"apiKeySource":"ANTHROPIC_API_KEY"') : text);
    if (mode === "api_key") rig.fake.set("auth.json", JSON.stringify({ authMethod: "api_key" }));
    const { handle } = await engineFor(rig).start(rig.startOptions());
    const outcome = await outcomeOf(handle);
    await lease.flush();
    await lease.close();
    return { claimed, local, rig, outcome, stored: cloud.runs.get(claimed.runId)!.events, text };
  }

  for (const mode of ["subscription", "api_key"] as const) {
    it(`${mode}: the activity equals the shared reducer's, the secret command goes as its kind alone, and the strict cloud accepted every event`, async () => {
      expect(RUN_VALUE).toHaveLength(40);
      const { claimed, local, rig, outcome, stored, text } = await runFixture(mode);
      expect(outcome.status).toBe("ok");
      // The cloud's strict schema parsed every batch (a refused one would have stored nothing), and what it stored is what the engine made.
      expect(stored.length).toBe(local.length);
      expect(stored.map((e) => e.type)).toEqual(local.map((e) => e.type));
      expect(cloud.seen.filter((s) => s.path.endsWith("/events")).length).toBeGreaterThan(0);

      // Acceptance 1: for every tool-use block of the recorded lines, the event's activity is the reducer's output for the same line.
      const expected: Array<{ tool: string; path?: string; pattern?: string; command?: string }> = [];
      for (const line of text.split("\n").filter((l) => l.startsWith('{"type":"assistant"'))) {
        const message = JSON.parse(line) as Record<string, unknown>;
        const uses = normalizeMessage({ runId: RUN_ID, role: "executor" }, message, 0, rig.workdir).toolUses ?? [];
        for (const u of uses) if (u.tool !== undefined) expected.push({ tool: u.tool, ...(u.path === undefined ? {} : { path: u.path }), ...(u.pattern === undefined ? {} : { pattern: u.pattern }), ...(u.command === undefined ? {} : { command: u.command }) });
      }
      const sent = local.filter((e) => e.type === "tool_use" && e.activity !== undefined).map((e) => e.activity);
      expect(stored.filter((e) => e.type === "tool_use").map((e) => e.activity)).toEqual(local.filter((e) => e.type === "tool_use").map((e) => e.activity));
      // The one command holding the secret: the reducer kept it (the shared check cannot know the value), the runner dropped the line.
      const withSecret = expected.findIndex((a) => a.command?.includes(RUN_VALUE));
      expect(withSecret).toBeGreaterThanOrEqual(0);
      const want = expected.map((a, i) => (i === withSecret ? { tool: a.tool } : a));
      expect(sent).toEqual(want);
      expect(sent).toContainEqual({ tool: "test", command: "pnpm test --run" });
      expect(sent).toContainEqual({ tool: "command", command: "ls -la src" });
      expect(sent).toContainEqual({ tool: "read", path: "src/a.ts" });
      expect(sent).toContainEqual({ tool: "search", pattern: "TODO" });
      expect(sent).toContainEqual({ tool: "command" }); // the clone and the secret command

      // The credential value is in no body the cloud received, and neither is the second line of a command or any model text.
      const bodies = JSON.stringify(cloud.seen.map((s) => s.body));
      expect(bodies).not.toContain(RUN_VALUE);
      expect(bodies).not.toContain("PRIVATE-");
      expect(claimed.runId).toBe(RUN_ID);

      // The stage: writing_result once, before the write's tool use.
      const stages = stored.filter((e) => e.type === "stage").map((e) => e.stage);
      expect(stages).toEqual(["writing_result"]);
      const order = stored.map((e) => e.type);
      expect(order.indexOf("stage")).toBeLessThan(order.lastIndexOf("tool_use"));
    });
  }
});
