
/**
 * D#8 R5 / policy 12: stored-content migration is roll-forward only, by
 * read-time upcast, chained one step at a time. The version tag lives in
 * the row (never inside the zod schema); this module owns the steps and
 * the gate that proves a chain is still readable.
 *
 * A step n -> n+1 is ONE upcaster function plus the fields it adds, each
 * with a declared default. Converting back (n+1 -> n) is derived: drop the
 * fields the step added. So an upcaster that loses or rewrites anything
 * else cannot round-trip, and the gate turns red.
 */

export type Blob = Record<string, unknown>;

export interface FieldAdd {
  readonly name: string;
  /** Avro's rule: a field added with no default is an error, not a null. */
  readonly hasDefault: boolean;
  readonly default?: unknown;
}

export interface UpcastStep {
  /** Version this step reads; it produces `from + 1`. */
  readonly from: number;
  readonly upcast: (blob: Blob) => Blob;
  readonly adds: readonly FieldAdd[];
}

export interface ShapeDef {
  readonly key: string;
  /** Table holding the blob. Evidence shapes must name an entry of the evidence-table list the caller passes in. */
  readonly table: string;
  readonly evidence: boolean;
  /** Shipped current version. Every stored row is at some version <= this. */
  readonly current: number;
  /** v1 field names, or 'untyped' when the shape has no typed schema. */
  readonly fields: "untyped" | readonly string[];
  readonly steps: readonly UpcastStep[];
}

export interface Fixture {
  readonly shape: string;
  readonly version: number;
  readonly name: string;
  readonly blob: Blob;
}

/** The production registry. Test-only shapes never live here. */
export const SHAPES: readonly ShapeDef[] = [
  {
    // site_versions.content; version in site_versions.content_schema_version.
    key: "site_content",
    table: "site_versions",
    evidence: true,
    current: 1,
    fields: ["site", "siteNameClaimId", "repo", "repo_sha", "domains", "pages", "claims"],
    steps: [],
  },
  {
    // agent_runs.envelope; an untagged envelope is v1 by definition.
    key: "agent_output_envelope",
    table: "agent_runs",
    evidence: true,
    current: 1,
    fields: "untyped",
    steps: [],
  },
];

const stepFor = (shape: ShapeDef, from: number): UpcastStep | undefined =>
  shape.steps.find((s) => s.from === from);

/** Upcast one step at a time, from `fromVersion` to `toVersion`. */
export function upcast(shape: ShapeDef, blob: Blob, fromVersion: number, toVersion: number): Blob {
  let out = blob;
  for (let v = fromVersion; v < toVersion; v++) {
    const step = stepFor(shape, v);
    if (!step) throw new Error(`${shape.key}: no upcaster for v${v} -> v${v + 1}`);
    out = step.upcast(out);
  }
  return out;
}

/** Convert back down: drop the fields each step added, newest step first. */
export function downcast(shape: ShapeDef, blob: Blob, fromVersion: number, toVersion: number): Blob {
  const out: Blob = { ...blob };
  for (let v = fromVersion - 1; v >= toVersion; v--) {
    const step = stepFor(shape, v);
    if (!step) throw new Error(`${shape.key}: no upcaster for v${v} -> v${v + 1}`);
    for (const f of step.adds) delete out[f.name];
  }
  return out;
}

const bytes = (b: Blob): string => JSON.stringify(b);

/**
 * Criterion 6 window: evidence fixtures of every version ever shipped;
 * non-evidence fixtures of the two latest reader versions only.
 */
const inWindow = (shape: ShapeDef, version: number): boolean =>
  shape.evidence || version >= shape.current - 1;

/**
 * Round trip, checked transitively (criterion 5): a fixture written at
 * version k must, for EVERY reader version r in k..current, upcast to r and
 * convert back byte-identical. Returns violations; empty is passing.
 */
export function findRoundTripViolations(shape: ShapeDef, fixtures: readonly Fixture[]): string[] {
  const out: string[] = [];
  for (const fx of fixtures.filter((f) => f.shape === shape.key && inWindow(shape, f.version))) {
    for (let r = fx.version; r <= shape.current; r++) {
      try {
        const back = downcast(shape, upcast(shape, fx.blob, fx.version, r), r, fx.version);
        if (bytes(back) !== bytes(fx.blob)) {
          out.push(`${shape.key} fixture "${fx.name}" (v${fx.version}) is not identical after v${fx.version}->v${r}->v${fx.version}`);
        }
      } catch (e) {
        // fx-swallow-ok: the failure is recorded as a finding in `out`, which the caller returns
        out.push(`${shape.key} fixture "${fx.name}" (v${fx.version}) is unreadable at v${r}: ${(e as Error).message}`);
      }
    }
  }
  return out;
}

/** Field names present at `version` (added fields only accumulate). */
export function fieldsAt(shape: ShapeDef, version: number): string[] {
  const base = shape.fields === "untyped" ? [] : [...shape.fields];
  for (const s of shape.steps) if (s.from < version) base.push(...s.adds.map((a) => a.name));
  return base;
}

/** Criterion 4: every field a step adds declares a default. */
export function findMissingDefaults(shape: ShapeDef): string[] {
  return shape.steps.flatMap((s) =>
    s.adds
      .filter((a) => !a.hasDefault || !("default" in a))
      .map((a) => `${shape.key} v${s.from + 1}: field "${a.name}" has no default`),
  );
}

/**
 * Registry rules plus the tripwire (criterion 2a): a fixture for every
 * version 1..current and a step for every 1..current-1. Raising `current`
 * without adding both turns this red, before any row is written.
 */
export function findRegistryViolations(
  shapes: readonly ShapeDef[],
  fixtures: readonly Fixture[],
  evidenceList: readonly string[],
): string[] {
  const out: string[] = [];
  for (const s of shapes) {
    if (s.evidence && !evidenceList.includes(s.table)) {
      out.push(`${s.key}: evidence shape's table "${s.table}" is not in the evidence-table list`);
    }
    if (s.current > 1 && s.fields === "untyped") {
      out.push(`${s.key}: cannot be registered at v${s.current} untyped; ship a field list (zod schema) first`);
    }
    for (let v = 1; v < s.current; v++) {
      if (!stepFor(s, v)) out.push(`${s.key}: no upcaster for v${v} -> v${v + 1}`);
    }
    for (let v = 1; v <= s.current; v++) {
      if (!fixtures.some((f) => f.shape === s.key && f.version === v)) {
        out.push(`${s.key}: no fixture for v${v}`);
      }
    }
  }
  return out;
}
