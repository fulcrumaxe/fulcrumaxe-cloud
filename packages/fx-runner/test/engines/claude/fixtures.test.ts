import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_FLAGS } from "../../../src/engines/claude/argv.js";
import { parseVersion } from "../../../src/engines/claude/pin.js";
import { CAPTURED_VERSION, FULL_HELP, helpWithout } from "./harness.js";

const DIR = path.join(import.meta.dirname, "fixtures");
const read = (name: string): string => readFileSync(path.join(DIR, name), "utf8");
const header = (name: string): Record<string, unknown> => (JSON.parse(name.endsWith(".jsonl") ? read(name).split("\n")[0]! : read(name)) as { _fixture: Record<string, unknown> })._fixture;

describe("fixtures: what is real and what is not, and nothing that identifies an account", () => {
  it.each([["auth.claude_ai.json", "captured, redacted"]])("%s is a capture of the installed build, dated", (name, status) => {
    expect(header(name)).toEqual({ binary_version: "2.1.289", capture_date: "2026-10-06", status });
  });

  it.each(["auth.api_key.json", "auth.none.json", "auth.third_party.json"])("%s says it is synthetic", (name) => {
    expect(String(header(name).status)).toMatch(/^synthetic, not captured/);
  });

  it("the captured text files are listed with their version, date and status", () => {
    const captures = JSON.parse(read("CAPTURES.json")) as Record<string, Record<string, unknown>>;
    expect(captures["help.2.1.289.txt"]).toMatchObject({ binary_version: "2.1.289", capture_date: "2026-10-06", status: "captured, redacted" });
    expect(captures.version).toMatchObject({ output: `${CAPTURED_VERSION} (Claude Code)`, status: "captured, redacted" });
  });

  it("the captured auth status keeps every identifying field redacted, and has no address", () => {
    const real = JSON.parse(read("auth.claude_ai.json")) as Record<string, unknown>;
    for (const key of ["email", "orgId", "orgName", "projectsDirectory", "configDirectory", "subscriptionType"]) expect(real[key], key).toBe("REDACTED");
    expect(real.authMethod).toBe("claude.ai");
    for (const name of ["auth.claude_ai.json", "help.2.1.289.txt"]) expect(read(name), name).not.toMatch(/@|\/home\/|\/Users\//);
  });

  it("the captured --version parses, and the captured --help lists every flag the argument list uses", () => {
    expect(parseVersion(`${CAPTURED_VERSION} (Claude Code)`)).toBe("2.1.289");
    for (const flag of REQUIRED_FLAGS) expect(helpWithout(FULL_HELP, flag), flag).not.toBe(FULL_HELP);
  });
});
