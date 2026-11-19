/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_ID_PATTERN, ASK_ID_PATTERN, AgentId, AskId, ENGINE_COUNT_MAX, ENGINE_DURATION_S_MAX, ENGINE_EVENT_KINDS, ENGINE_FORBIDDEN_KEY_PREFIX, ENGINE_ORIGINS, ENGINE_VERSION_PATTERN, EngineEvent, LINE_ID_PATTERN, LineId, MODEL_ID_PATTERN, ModelId, ROW_KEY_PATTERN, RowKey, SHA40_PATTERN, SPAWN_ID_PATTERN, Sha40, SpawnId,
  type EngineEventKind, type EngineEventOf,
} from "../src/engineEvents.js";

const DIR = join(import.meta.dirname, "..");
const SCHEMA_PATH = join(DIR, "schema", "engine-events.v1.json");
const FIXTURES = join(import.meta.dirname, "fixtures", "engine-events");
const schemaText = readFileSync(SCHEMA_PATH, "utf8");
const schema = JSON.parse(schemaText) as Record<string, any>;
const load = (dir: string) => readdirSync(join(FIXTURES, dir)).sort().map((file) => ({ file, value: JSON.parse(readFileSync(join(FIXTURES, dir, file), "utf8")) as unknown }));

/** The smallest JSON Schema checker that covers every keyword the file uses; a keyword it does not know fails the test, so the file cannot grow past what is checked. */
const KEYWORDS = new Set(["$schema", "title", "description", "$defs", "$ref", "oneOf", "type", "const", "enum", "pattern", "minimum", "maximum", "maxItems", "items", "properties", "required", "additionalProperties", "format"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function valid(node: any, value: unknown): boolean {
  for (const key of Object.keys(node)) if (!KEYWORDS.has(key)) throw new Error(`unsupported keyword ${key}`);
  if (node.$ref !== undefined) return valid(schema.$defs[String(node.$ref).replace("#/$defs/", "")], value);
  if (node.oneOf !== undefined) return node.oneOf.filter((option: any) => valid(option, value)).length === 1;
  if ("const" in node && value !== node.const) return false;
  if (node.enum !== undefined && !node.enum.includes(value)) return false;
  switch (node.type) {
    case "string":
      if (typeof value !== "string") return false;
      if (node.pattern !== undefined && !new RegExp(node.pattern, "u").test(value)) return false;
      if (node.format === "date-time" && !(DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)))) return false;
      if (node.format === "uuid" && !UUID.test(value)) return false;
      return true;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return false;
      return (node.minimum === undefined || value >= node.minimum) && (node.maximum === undefined || value <= node.maximum);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value) && (node.maxItems === undefined || value.length <= node.maxItems) && value.every((item) => valid(node.items, item));
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      if ((node.required ?? []).some((key: string) => !(key in record))) return false;
      return Object.keys(record).every((key) => (key in node.properties ? valid(node.properties[key], record[key]) : node.additionalProperties !== false));
    }
    default:
      return node.type === undefined;
  }
}
const jsonSchemaAccepts = (value: unknown) => valid(schema, value);

describe("schema/engine-events.v1.json against the zod schemas", () => {
  it("prints the file's sha256, which the engine pins", () => {
    const hash = createHash("sha256").update(readFileSync(SCHEMA_PATH)).digest("hex");
    console.log(`engine-events.v1.json sha256 ${hash}`);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe("996aaa828cd0dbfda10c67e9fc22ed297796d4b2b48cfea5715d703503ff4730");
  });

  it("names one option per kind, with the closed envelope", () => {
    const kinds = schema.oneOf.map((option: any) => option.properties.kind.const);
    expect([...kinds].sort()).toEqual([...ENGINE_EVENT_KINDS].sort());
    for (const option of schema.oneOf) {
      expect(option.additionalProperties).toBe(false);
      expect(option.required).toEqual(expect.arrayContaining(["v", "engine_instance_id", "seq", "ts", "kind"]));
    }
  });

  it("passes every valid fixture in both", () => {
    const fixtures = load("valid");
    expect(fixtures.length).toBeGreaterThanOrEqual(ENGINE_EVENT_KINDS.length);
    for (const { file, value } of fixtures) {
      expect(EngineEvent.safeParse(value).success, `zod ${file}`).toBe(true);
      expect(jsonSchemaAccepts(value), `json schema ${file}`).toBe(true);
    }
  });

  it("fails every invalid fixture in both", () => {
    const fixtures = load("invalid");
    expect(fixtures.length).toBeGreaterThan(60);
    for (const { file, value } of fixtures) {
      expect(EngineEvent.safeParse(value).success, `zod ${file}`).toBe(false);
      expect(jsonSchemaAccepts(value), `json schema ${file}`).toBe(false);
    }
  });

  it("holds a valid fixture for every kind", () => {
    const kinds = new Set(load("valid").map(({ value }) => (value as { kind: string }).kind));
    expect([...kinds].sort()).toEqual([...ENGINE_EVENT_KINDS].sort());
  });

  it("uses the same pattern, range and enum as the zod schemas", () => {
    const defs = schema.$defs;
    const pairs: [string, RegExp, { safeParse(v: unknown): { success: boolean } }][] = [["agent_id", AGENT_ID_PATTERN, AgentId], ["spawn_id", SPAWN_ID_PATTERN, SpawnId], ["ask_id", ASK_ID_PATTERN, AskId], ["line_id", LINE_ID_PATTERN, LineId], ["sha40", SHA40_PATTERN, Sha40], ["row_key", ROW_KEY_PATTERN, RowKey], ["model_id", MODEL_ID_PATTERN, ModelId]];
    for (const [name, pattern, zod] of pairs) {
      expect(defs[name].pattern, name).toBe(pattern.source);
      for (const sample of ["a", "A", "toolu_x", "0123456789abcdef", "a".repeat(40), "a b", ""]) expect(zod.safeParse(sample).success, `${name} ${sample}`).toBe(pattern.test(sample));
    }
    expect(defs.row_key_or_empty.pattern).toBe(`^(${ROW_KEY_PATTERN.source.slice(1, -1)})?$`);
    expect(ENGINE_VERSION_PATTERN.test("1.2.3")).toBe(true);
    expect(defs.count.maximum).toBe(ENGINE_COUNT_MAX);
    expect(defs.gh_number.maximum).toBe(ENGINE_COUNT_MAX);
    expect(defs.seconds.maximum).toBe(ENGINE_DURATION_S_MAX);
    expect(defs.origin.enum).toEqual([...ENGINE_ORIGINS]);
    expect(ENGINE_FORBIDDEN_KEY_PREFIX).toBe("total_");
    const kind: EngineEventKind = "merged";
    const typed: EngineEventOf<"merged"> = EngineEvent.parse(load("valid").find(({ value }) => (value as { kind: string }).kind === kind)!.value) as EngineEventOf<"merged">;
    expect(typed.closes).toBe(true);
  });

  it("states the limits only zod enforces", () => {
    expect(String(schema.description)).toMatch(/64 KiB/);
  });
});
