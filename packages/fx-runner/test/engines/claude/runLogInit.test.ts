import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInitLine, initCredentialMatches } from "../../../src/engines/claude/credentialCheck.js";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { createRunLog } from "../../../src/engines/claude/stream.js";
import { RUN_ID, authText, engineFor, fixtureText, makeFake, makeRig, streamWith } from "./rig.js";

// Assembled from fragments so no token-shaped literal sits in the source.
const KEY = ["sk-ant-", "api03-", "RUNLOGINITKEY0123456789abcdefghijklmnop"].join("");

const stdoutRecords = (file: string): Record<string, unknown>[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { kind: string; line: string })
    .filter((record) => record.kind === "stdout")
    .map((record) => JSON.parse(record.line) as Record<string, unknown>);

describe("the init line in the run log (api_key mode)", () => {
  it("drives the real engine path: the check sees ANTHROPIC_API_KEY and the run proceeds, and the logged init line keeps the source name", async () => {
    const fake = makeFake({ stream: streamWith("ANTHROPIC_API_KEY"), auth: authText("auth.api_key.json") });
    const rig = makeRig({ fake, credentials: { mode: "api_key", apiKey: KEY } });
    const opts = rig.startOptions();
    const { handle } = await engineFor(rig).start(opts);
    const outcome = await outcomeOf(handle);
    expect(outcome.status).toBe("ok");
    expect(opts.events.length).toBeGreaterThan(0);

    const logFile = path.join(rig.config.logDir, `${RUN_ID}.jsonl`);
    const first = stdoutRecords(logFile)[0]!;
    expect(isInitLine(first)).toBe(true);
    expect(first.apiKeySource).toBe("ANTHROPIC_API_KEY");
    expect(initCredentialMatches("api_key", first)).toBe(true);
    expect(readFileSync(logFile, "utf8")).not.toContain("RUNLOGINITKEY");
  });

  it("keeps the subscription source name too", async () => {
    const fake = makeFake({ stream: streamWith("none") });
    const rig = makeRig({ fake });
    const { handle } = await engineFor(rig).start(rig.startOptions());
    await outcomeOf(handle);
    const first = stdoutRecords(path.join(rig.config.logDir, `${RUN_ID}.jsonl`))[0]!;
    expect(first.apiKeySource).toBe("none");
  });
});

describe("createRunLog and the init line's apiKeySource", () => {
  const dir = (): string => path.join(makeRig().root, "logs");
  const initWith = (source: string, extra: Record<string, unknown> = {}): string => {
    const init = JSON.parse(fixtureText("stream.subscription.jsonl").split("\n")[0]!) as Record<string, unknown>;
    return JSON.stringify({ ...init, apiKeySource: source, ...extra });
  };

  it("a value outside the closed set stays redacted", () => {
    const log = createRunLog(dir(), RUN_ID, []);
    log.write("stdout", initWith("apiKeyHelper"));
    log.write("stdout", initWith(KEY));
    const [a, b] = stdoutRecords(log.file);
    expect(a!.apiKeySource).toBe("[redacted]");
    expect(b!.apiKeySource).toBe("[redacted]");
    expect(readFileSync(log.file, "utf8")).not.toContain("RUNLOGINITKEY");
  });

  it("a secret elsewhere on the init line is still redacted", () => {
    const log = createRunLog(dir(), RUN_ID, [KEY]);
    log.write("stdout", initWith("ANTHROPIC_API_KEY", { cwd: `/work/${KEY}`, extra_note: `token=${KEY}` }));
    const text = readFileSync(log.file, "utf8");
    expect(text).not.toContain("RUNLOGINITKEY");
    expect(stdoutRecords(log.file)[0]!.apiKeySource).toBe("ANTHROPIC_API_KEY");
  });

  it("a non-init line, a second apiKeySource field, or a stderr line gets no pass", () => {
    const log = createRunLog(dir(), RUN_ID, []);
    log.write("stdout", JSON.stringify({ type: "assistant", apiKeySource: "none" }));
    log.write("stdout", JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none", nested: { apiKeySource: "none" } }));
    log.write("stderr", `{"type":"system","subtype":"init","apiKeySource":"none"}`);
    const records = readFileSync(log.file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { line: string }).line);
    for (const line of records) expect(line).not.toMatch(/"apiKeySource":"none"/);
  });
});
