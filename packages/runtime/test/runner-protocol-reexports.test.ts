import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as protocolAgentRuntime from "@fulcrumaxe/runner-protocol/agentRuntime";
import * as protocolEnvelope from "@fulcrumaxe/runner-protocol/envelope";
import * as protocolRedact from "@fulcrumaxe/runner-protocol/redact";
import * as envelope from "../src/envelope.js";
import * as redact from "../src/redact.js";
import * as types from "../src/types.js";

/**
 * D#6 R1 (C2-R1.1, amended by C7): `types.ts`, `redact.ts` and `envelope.ts` moved into
 * `@fulcrumaxe/runner-protocol` and now only re-export it. `toolActivity.ts` and `streamJson.ts` followed in D#6 R4b1-2,
 * so the local runner maps stream-json with the same code. Every name each file exported must still be exported.
 *
 * The lists below are the export lists on the R1 PR's merge base (main at b74bb35a), read with the TypeScript
 * checker so type-only names count. They are a pin, not a snapshot of the new files: a name added to or dropped
 * from one of these modules fails here.
 */
const EXPORTS_ON_MERGE_BASE = {
  "types.ts": [
    "AgentHandle",
    "AgentRuntime",
    "LocalRunnerRefused",
    "ModelConnectionStatus",
    "ModelProvider",
    "NormalizedEvent",
    "NormalizedUsage",
    "SandboxSpec",
    "StartOptions",
    "SubscriptionCredentialsRefused",
  ],
  "redact.ts": [
    "SCAN_CHUNK_CHARS",
    "SCAN_OVERLAP_CHARS",
    "SK_ANT_ADMIN_PATTERN_SOURCE",
    "SK_ANT_API_PATTERN_SOURCE",
    "SK_ANT_OAT_PATTERN_SOURCE",
    "TELEMETRY_SHAPES",
    "TELEMETRY_SHAPE_PATTERN_SOURCES",
    "TOKEN_SHAPE_PATTERN_SOURCES",
    "TelemetryShape",
    "VCK_PATTERN_SOURCE",
    "matchesShape",
    "redactDeep",
    "redactError",
    "redactSecrets",
    "redactShapes",
    "redactText",
  ],
  "envelope.ts": ["MAX_ENVELOPE_INPUT_BYTES", "extractAgentOutputEnvelope"],
  "streamJson.ts": ["isKnownStreamJsonType", "isMalformedAssistant", "normalizeMessage"],
  "toolActivity.ts": [
    "ActivityTool",
    "CREDENTIALED_URL_RE", // added by #486, not an R1a name
    "TOOL_ACTIVITY_LIMITS",
    "ToolResult",
    "ToolUse",
    "commandIsClean", // added by #486, not an R1a name
    "extractToolResults",
    "extractToolUses",
    "normalizePattern",
    "normalizeRepoPath",
    "shellCommandLine", // added by #486, not an R1a name
  ],
} as const;

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function exportsOf(fileNames: readonly string[]): Record<string, string[]> {
  const files = fileNames.map((name) => path.join(PACKAGE_ROOT, "src", name));
  const config = ts.readConfigFile(path.join(PACKAGE_ROOT, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE_ROOT);
  const program = ts.createProgram(files, parsed.options);
  const checker = program.getTypeChecker();
  const out: Record<string, string[]> = {};
  for (const name of fileNames) {
    const source = program.getSourceFile(path.join(PACKAGE_ROOT, "src", name));
    const symbol = source ? checker.getSymbolAtLocation(source) : undefined;
    out[name] = symbol ? checker.getExportsOfModule(symbol).map((s) => s.getName()).sort() : [];
  }
  return out;
}

describe("D#6 R1: the moved runtime files are re-exports", () => {
  it("every file still exports exactly the names it exported on the merge base", () => {
    const actual = exportsOf(Object.keys(EXPORTS_ON_MERGE_BASE));
    for (const [file, names] of Object.entries(EXPORTS_ON_MERGE_BASE)) {
      expect({ file, names: actual[file] }).toEqual({ file, names: [...names].sort() });
    }
  });

  it("types.ts, redact.ts, envelope.ts, toolActivity.ts and streamJson.ts hold only export-from lines naming the protocol package", () => {
    for (const file of ["types.ts", "redact.ts", "envelope.ts", "toolActivity.ts", "streamJson.ts"]) {
      const code = readFileSync(path.join(PACKAGE_ROOT, "src", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .trim();
      const statements = code.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement).toMatch(/^export\s*\{[^}]*\}\s*from\s*"@fulcrumaxe\/runner-protocol\/[a-zA-Z]+"$/);
      }
    }
  });

  it("the re-exported values are the protocol package's own, not copies", () => {
    expect(types.LocalRunnerRefused).toBe(protocolAgentRuntime.LocalRunnerRefused);
    expect(types.SubscriptionCredentialsRefused).toBe(protocolAgentRuntime.SubscriptionCredentialsRefused);
    expect(envelope.extractAgentOutputEnvelope).toBe(protocolEnvelope.extractAgentOutputEnvelope);
    expect(envelope.MAX_ENVELOPE_INPUT_BYTES).toBe(protocolEnvelope.MAX_ENVELOPE_INPUT_BYTES);
    for (const name of ["redactText", "redactDeep", "redactError", "redactSecrets", "redactShapes", "matchesShape", "TELEMETRY_SHAPES"] as const) {
      expect(redact[name]).toBe(protocolRedact[name]);
    }
  });
});
