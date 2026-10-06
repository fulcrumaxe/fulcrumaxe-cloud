import { describe, expect, it, vi } from "vitest";
import { EVIDENCE_TABLES } from "@fx/db/test/support/evidenceTables.js";
import { extractAgentOutputEnvelope } from "@fx/runtime/src/envelope.js";
import {
  SHAPES,
  downcast,
  fieldsAt,
  findMissingDefaults,
  findRegistryViolations,
  findRoundTripViolations,
  upcast,
  type Fixture,
  type ShapeDef,
} from "../src/upcast.js";
import {
  DEMO_FIXTURES,
  DEMO_STEPS,
  DROPPING_V2_STEP,
  LEGACY_V1_FIXTURE,
  LOSSY_V4_STEP,
  NO_DEFAULT_STEP,
  demoShape,
} from "./fixtures/demo.js";
import { ENVELOPE_TRANSCRIPT_V1, SITE_CONTENT_V1, realFixtures } from "./fixtures/real.js";

// Imported by a non-literal specifier on purpose: this package compiles with
// noUncheckedIndexedAccess and sitekit-claims' source does not, so a static
// import would make `tsc` here typecheck (and fail on) that package's source.
const SITEKIT = "@fx/sitekit-claims";
const { SiteContent } = (await import(SITEKIT)) as {
  SiteContent: { parse(v: unknown): unknown; _def: { schema: { shape: object } } };
};

const envelope = extractAgentOutputEnvelope(ENVELOPE_TRANSCRIPT_V1)!;
const REAL_FIXTURES = realFixtures(envelope);
const shapeOf = (key: string): ShapeDef => SHAPES.find((s) => s.key === key)!;

describe("criterion 1: one step, one function", () => {
  it("shipping v4 on top of v3 adds exactly one upcaster", () => {
    const v3 = demoShape({ current: 3, steps: DEMO_STEPS.slice(0, 2) });
    const v4 = demoShape();
    expect(v4.steps.length - v3.steps.length).toBe(1);
    expect(v4.steps.slice(0, 2)).toEqual(v3.steps);
  });

  it("upcast(v1 -> v4) calls each step's function exactly once", () => {
    const spies = DEMO_STEPS.map((s) => ({ ...s, upcast: vi.fn(s.upcast) }));
    const out = upcast(demoShape({ steps: spies }), DEMO_FIXTURES[0]!.blob, 1, 4);
    spies.forEach((s) => expect(s.upcast).toHaveBeenCalledTimes(1));
    expect(out).toEqual({ id: "a", name: "Alpha", tier: "free", tags: [], region: "eu" });
  });

  it("converting back drops what the steps added", () => {
    const up = upcast(demoShape(), DEMO_FIXTURES[1]!.blob, 2, 4);
    expect(downcast(demoShape(), up, 4, 2)).toEqual(DEMO_FIXTURES[1]!.blob);
  });
});

describe("criterion 2: round trip over the real shapes", () => {
  it("has one fixture per shipped version for each real shape, and they pass the gate", () => {
    for (const shape of SHAPES) {
      expect(findRoundTripViolations(shape, REAL_FIXTURES)).toEqual([]);
    }
  });

  it("site_content v1: the real reader reads the stored document and writes it back byte-identical", () => {
    const read = SiteContent.parse(SITE_CONTENT_V1);
    expect(JSON.stringify(read)).toBe(JSON.stringify(SITE_CONTENT_V1));
  });

  it("agent_output_envelope v1: the envelope extractAgentOutputEnvelope produced survives a store round trip byte-identical", () => {
    expect(envelope).toMatchObject({ agent: "executor", verdict: "done" });
    const stored = JSON.stringify(envelope);
    expect(JSON.stringify(JSON.parse(stored))).toBe(stored);
  });

  it("the demo chain round-trips over every version, as evidence", () => {
    expect(findRoundTripViolations(demoShape(), DEMO_FIXTURES)).toEqual([]);
  });
});

describe("criterion 2a: the tripwire", () => {
  it("every registered shape has a fixture for every version and a step for every gap", () => {
    expect(findRegistryViolations(SHAPES, REAL_FIXTURES, EVIDENCE_TABLES)).toEqual([]);
  });

  it("is not vacuous: bumping site_content to 2 in a copy of the registry fails", () => {
    const bumped = SHAPES.map((s) => (s.key === "site_content" ? { ...s, current: 2 } : s));
    const v = findRegistryViolations(bumped, REAL_FIXTURES, EVIDENCE_TABLES);
    expect(v).toContain("site_content: no upcaster for v1 -> v2");
    expect(v).toContain("site_content: no fixture for v2");
  });

  it("the demo chain, complete, passes the tripwire; missing its last step does not", () => {
    expect(findRegistryViolations([demoShape()], DEMO_FIXTURES, EVIDENCE_TABLES)).toEqual([]);
    expect(findRegistryViolations([demoShape({ steps: DEMO_STEPS.slice(0, 2) })], DEMO_FIXTURES, EVIDENCE_TABLES)).toEqual([
      "demo: no upcaster for v3 -> v4",
    ]);
  });
});

describe("criterion 3: a deliberately broken fixture fails the gate", () => {
  it("an upcaster that drops a field is caught", () => {
    const broken = demoShape({ current: 2, steps: [DROPPING_V2_STEP] });
    const v = findRoundTripViolations(broken, DEMO_FIXTURES.slice(0, 2));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("not identical");
  });
});

describe("criterion 4: every added field declares a default", () => {
  it("passes for the registry and the demo chain", () => {
    for (const s of [...SHAPES, demoShape()]) expect(findMissingDefaults(s)).toEqual([]);
  });

  it("fails for a version with a default-less field", () => {
    const bad = demoShape({ steps: [...DEMO_STEPS.slice(0, 2), NO_DEFAULT_STEP] });
    expect(findMissingDefaults(bad)).toEqual(['demo v4: field "region" has no default']);
  });

  it("enumerates the fields of every version", () => {
    expect(fieldsAt(demoShape(), 1)).toEqual(["id", "name"]);
    expect(fieldsAt(demoShape(), 4)).toEqual(["id", "name", "tier", "tags", "region"]);
  });

  it("site_content's registered v1 fields are exactly the zod schema's keys", () => {
    const zodKeys = Object.keys(SiteContent._def.schema.shape);
    expect(fieldsAt(shapeOf("site_content"), 1)).toEqual(zodKeys);
  });

  it("the untyped envelope is refused at v2 until it ships a field list", () => {
    const env = shapeOf("agent_output_envelope");
    expect(env.fields).toBe("untyped");
    const v2 = { ...env, current: 2, steps: [DEMO_STEPS[0]!] };
    const fx: Fixture[] = [1, 2].map((version) => ({ shape: env.key, version, name: `e${version}`, blob: {} }));
    expect(findRegistryViolations([v2], fx, EVIDENCE_TABLES).join("\n")).toContain("cannot be registered at v2 untyped");
    expect(findRegistryViolations([{ ...v2, fields: ["agent", "verdict"] }], fx, EVIDENCE_TABLES)).toEqual([]);
  });
});

describe("criterion 5: compatibility is transitive", () => {
  const lossy = demoShape({ steps: [DEMO_STEPS[0]!, DEMO_STEPS[1]!, LOSSY_V4_STEP] });
  const fixtures = [LEGACY_V1_FIXTURE, DEMO_FIXTURES[2]!, DEMO_FIXTURES[3]!];

  it("a v1 fixture readable at v3 but not v4 fails", () => {
    const v = findRoundTripViolations(lossy, fixtures);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("v1->v4->v1");
    expect(findRoundTripViolations({ ...lossy, current: 3, steps: lossy.steps.slice(0, 2) }, [LEGACY_V1_FIXTURE])).toEqual([]);
  });

  it("checking the last version alone would have passed it", () => {
    const lastOnly = fixtures.filter((f) => f.version >= lossy.current - 1);
    expect(findRoundTripViolations(lossy, lastOnly)).toEqual([]);
  });
});

describe("criterion 6: evidence has no window, non-evidence has two reader versions", () => {
  const lossy = demoShape({ steps: [DEMO_STEPS[0]!, DEMO_STEPS[1]!, LOSSY_V4_STEP] });
  const fixtures = [LEGACY_V1_FIXTURE, DEMO_FIXTURES[2]!, DEMO_FIXTURES[3]!];

  it("the same v1 fixture fails as evidence and passes as non-evidence", () => {
    expect(findRoundTripViolations({ ...lossy, evidence: true }, fixtures)).not.toEqual([]);
    expect(findRoundTripViolations({ ...lossy, evidence: false }, fixtures)).toEqual([]);
  });

  it("every evidence shape's table is in the single EVIDENCE_TABLES list", () => {
    for (const s of SHAPES.filter((x) => x.evidence)) expect(EVIDENCE_TABLES).toContain(s.table);
    const stray = demoShape({ table: "not_evidence" });
    expect(findRegistryViolations([stray], DEMO_FIXTURES, EVIDENCE_TABLES)).toEqual([
      "demo: evidence shape's table \"not_evidence\" is not in the evidence-table list",
    ]);
    expect(findRegistryViolations([{ ...stray, evidence: false }], DEMO_FIXTURES, EVIDENCE_TABLES)).toEqual([]);
  });

  it("the demo shape is test-only: not in the production registry", () => {
    expect(SHAPES.map((s) => s.key)).not.toContain("demo");
    expect(SHAPES.map((s) => s.key).sort()).toEqual(["agent_output_envelope", "site_content"]);
  });
});
