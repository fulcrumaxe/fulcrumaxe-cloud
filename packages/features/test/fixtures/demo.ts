import type { Blob, Fixture, ShapeDef, UpcastStep } from "../../src/upcast.js";

/**
 * Test-only synthetic shape `demo`, four versions (four, so "readable from
 * vN-1 but not from vN-3" has a vN-3). Each step adds one field with a
 * declared default. Never exported from src/ and never in SHAPES.
 */
const add = (from: number, name: string, dflt: unknown): UpcastStep => ({
  from,
  adds: [{ name, hasDefault: true, default: dflt }],
  upcast: (b) => ({ ...b, [name]: dflt }),
});

export const DEMO_STEPS: readonly UpcastStep[] = [
  add(1, "tier", "free"),
  add(2, "tags", []),
  add(3, "region", "eu"),
];

export const demoShape = (over: Partial<ShapeDef> = {}): ShapeDef => ({
  key: "demo",
  table: "site_versions",
  evidence: true,
  current: 4,
  fields: ["id", "name"],
  steps: DEMO_STEPS,
  ...over,
});

const fx = (version: number, blob: Blob, name = `demo-v${version}`): Fixture => ({ shape: "demo", version, name, blob });

export const DEMO_FIXTURES: readonly Fixture[] = [
  fx(1, { id: "a", name: "Alpha" }),
  fx(2, { id: "b", name: "Beta", tier: "pro" }),
  fx(3, { id: "c", name: "Gamma", tier: "pro", tags: ["x"] }),
  fx(4, { id: "d", name: "Delta", tier: "free", tags: [], region: "us" }),
];

/** Criterion 3: the v2 upcaster silently drops `name`. */
export const DROPPING_V2_STEP: UpcastStep = {
  from: 1,
  adds: [{ name: "tier", hasDefault: true, default: "free" }],
  upcast: ({ name: _dropped, ...rest }) => ({ ...rest, tier: "free" }),
};

/** Criterion 4: a version whose added field has no default. */
export const NO_DEFAULT_STEP: UpcastStep = {
  from: 3,
  adds: [{ name: "region", hasDefault: false }],
  upcast: (b) => b,
};

/**
 * Criterion 5: a v1 fixture carrying `legacy_note`, which the v4 upcaster
 * drops. v1 -> v3 is fine; v1 -> v4 is not. v3/v4 writers never emitted
 * `legacy_note`, so their own fixtures pass: checking the last version
 * alone would call this chain healthy.
 */
export const LEGACY_V1_FIXTURE: Fixture = fx(1, { id: "z", name: "Zeta", legacy_note: "old" }, "demo-v1-legacy");

export const LOSSY_V4_STEP: UpcastStep = {
  from: 3,
  adds: [{ name: "region", hasDefault: true, default: "eu" }],
  upcast: ({ legacy_note: _dropped, ...rest }) => ({ ...rest, region: "eu" }),
};
