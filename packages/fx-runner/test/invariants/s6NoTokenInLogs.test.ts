import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { SUBSCRIPTION_TOKEN_VAR } from "../../src/job/cleanEnv.js";
import { outcomeOf } from "../../src/engines/claude/engine.js";
import { RUN_ID, engineFor, fixtureText, makeFake, makeRig } from "../engines/claude/rig.js";

// Assembled from fragments so no token-shaped literal sits in the source.
const OAUTH = ["sk-ant-", "oat01-", "OAUTHVALUE0123456789abcdef"].join("");
const CONFIG_KEY = ["sk-ant-", "api03-", "CONFIGKEY0123456789abcdef"].join("");
const SHELL_KEY = ["sk-ant-", "api03-", "SHELLKEY0123456789abcdefg"].join("");

beforeEach(() => {
  vi.stubEnv(SUBSCRIPTION_TOKEN_VAR, OAUTH);
  vi.stubEnv("ANTHROPIC_API_KEY", SHELL_KEY);
});
afterEach(() => vi.unstubAllEnvs());

function everyFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? everyFile(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

describe("S6: no credential value in any log", () => {
  async function leakyRun(mode: "subscription" | "api_key") {
    const lines = fixtureText("stream.tooluse.synthetic.jsonl").trim().split("\n");
    // The binary echoes its environment on stdout (inside a result-like line) and on stderr, as an SDK error would.
    const echoed = JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "text", text: `env dump ${OAUTH} ${CONFIG_KEY} ${SHELL_KEY}` }] } });
    const fake = makeFake({ stream: [lines[0], echoed, ...lines.slice(1)].join("\n").replace('"none"', mode === "api_key" ? '"ANTHROPIC_API_KEY"' : '"none"') + "\n", auth: JSON.stringify({ authMethod: mode === "api_key" ? "api_key" : "claude.ai" }) });
    fake.set("stderr.txt", `error: request failed with ${OAUTH} and ${CONFIG_KEY}\n`);
    const uploaded: LocalOnlyEvent[] = [];
    const rig = makeRig({ fake, credentials: mode === "api_key" ? { mode, apiKey: CONFIG_KEY } : { mode }, onLocalEvent: (event) => void uploaded.push(event) });
    const { handle } = await engineFor(rig).start(rig.startOptions());
    await outcomeOf(handle);
    return { rig, uploaded };
  }

  it.each(["subscription", "api_key"] as const)("%s mode: not in the run log, any uploaded event, the engine's files or a thrown error", async (mode) => {
    const { rig, uploaded } = await leakyRun(mode);
    const logs = readFileSync(path.join(rig.config.logDir, `${RUN_ID}.jsonl`), "utf8");
    expect(logs).toContain("[redacted]");
    for (const text of [logs, JSON.stringify(uploaded), ...everyFile(rig.config.jobsDir).map((file) => readFileSync(file, "utf8")), readFileSync(rig.config.sessionsFile, "utf8")]) {
      for (const secret of [OAUTH, CONFIG_KEY, SHELL_KEY]) expect(text).not.toContain(secret);
    }
  });

  it("the shell's key never reaches the child's environment, and a refusal's message names no value", async () => {
    const { rig } = await leakyRun("subscription");
    expect(rig.fake.envText()).not.toContain(SHELL_KEY);
    const bad = makeRig({ fake: makeFake({ auth: JSON.stringify({ authMethod: "none" }) }), credentials: { mode: "api_key", apiKey: CONFIG_KEY } });
    const error = await engineFor(bad).start(bad.startOptions()).catch((caught: unknown) => caught as Error);
    expect(String((error as Error).message) + String((error as Error).stack)).not.toContain(CONFIG_KEY);
  });
});
