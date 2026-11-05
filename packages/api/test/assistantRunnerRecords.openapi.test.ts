import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RECORD_FIELDS, STRUCTURAL_VOCAB } from '../../fx-runner/src/assistant/fence.js';
import { runnerReadRoutes } from '../../fx-runner/src/assistant/readTools.js';
import { ROLE_NAMES } from '../../roles/src/manifest.js';

/**
 * D#597 CC-6a-1 (RUNNER-RECORD-KEYS-FENCE): every record-typed field (an object with `additionalProperties`, or an object with no listed properties)
 * in the reply of a route the runner reads must be named in `RECORD_FIELDS`, whose keys the runner fences (the runner's list is pinned to `@fx/trust`'s
 * by a runner test). A route that gains such a field fails here.
 */
type Schema = { $ref?: string; type?: string; enum?: unknown[]; properties?: Record<string, Schema>; additionalProperties?: unknown; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[] };
const doc = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'openapi.json'), 'utf8')) as {
  paths: Record<string, { get: { responses: Record<string, { content: { 'application/json': { schema: Schema } } }> } }>;
  components: { schemas: Record<string, Schema> };
};
/** Derived from the runner's read tools (and its corrections read), so a new tool's route is walked without editing this file. */
const RUNNER_READ_ROUTES = runnerReadRoutes();
/** `counts` is the server's own totals (its keys are written by the import, and the runner renames any key that is not plain); its one nested record, `per_milestone`, is in RECORD_FIELDS. */
const SERVER_KEYED = new Set(['counts']);

const variants = (s: Schema): Schema[] => {
  const r = s.$ref === undefined ? s : doc.components.schemas[s.$ref.split('/').pop()!]!;
  return [r, ...[...(r.anyOf ?? []), ...(r.oneOf ?? []), ...(r.allOf ?? [])].flatMap(variants)];
};
const isRecord = (s: Schema): boolean => s.type === 'object' && ((s.additionalProperties !== undefined && s.additionalProperties !== false) || s.properties === undefined);
function recordFields(s: Schema, seen: Set<Schema>, out: Set<string>): void {
  for (const v of variants(s)) {
    if (seen.has(v)) continue;
    seen.add(v);
    if (v.items !== undefined) recordFields(v.items, seen, out);
    for (const [name, child] of Object.entries(v.properties ?? {})) {
      if (variants(child).some(isRecord)) out.add(name);
      recordFields(child, seen, out);
    }
  }
}

describe('record-typed fields in the runner-read replies (D#597 CC-6a-1)', () => {
  it('are all named in RECORD_FIELDS', () => {
    const found = new Set<string>();
    for (const route of RUNNER_READ_ROUTES) recordFields(doc.paths[route]!.get.responses['200']!.content['application/json'].schema, new Set(), found);
    expect(found.has('token_permissions'), 'the walk reads the plan route').toBe(true);
    expect([...found].filter((n) => !RECORD_FIELDS.has(n) && !SERVER_KEYED.has(n))).toEqual([]);
  });

  it('are derived from the runner tools and are all documented routes', () => {
    expect([...RUNNER_READ_ROUTES].sort()).toEqual(['/api/v1/repos/{id}/plan', '/api/v1/runs', '/api/v1/runs/{id}', '/api/v1/runs/{id}/events', '/api/v1/work-items/{id}', '/api/v1/work-items/{id}/corrections', '/api/v1/work-items/{id}/receipts']);
    for (const route of RUNNER_READ_ROUTES) expect(doc.paths[route]?.get, route).toBeDefined();
  });

  it('know every role of the manifest (the runner copy is hand-copied)', () => {
    expect(ROLE_NAMES.filter((r) => !STRUCTURAL_VOCAB.role!.has(r))).toEqual([]);
    for (const extra of ['fix', 'plane_publish', 'proposal-verifier', 'discovery-analyst']) expect(STRUCTURAL_VOCAB.role!.has(extra), extra).toBe(true);
  });

  it('keep every enum the API declares for a closed structural key inside the runner vocabulary', () => {
    const declared = new Map<string, Set<string>>();
    const seen = new Set<Schema>();
    const walk = (s: Schema): void => {
      for (const v of variants(s)) {
        if (seen.has(v)) continue;
        seen.add(v);
        if (v.items !== undefined) walk(v.items);
        for (const [name, child] of Object.entries(v.properties ?? {})) {
          for (const c of variants(child)) if (Array.isArray(c.enum)) declared.set(name, new Set([...(declared.get(name) ?? []), ...c.enum.map(String)]));
          walk(child);
        }
      }
    };
    for (const route of RUNNER_READ_ROUTES) walk(doc.paths[route]!.get.responses['200']!.content['application/json'].schema);
    expect(declared.has('stage'), 'the walk reads the item route').toBe(true);
    const missing = [...declared].flatMap(([key, words]) => (STRUCTURAL_VOCAB[key] === undefined ? [] : [...words].filter((w) => !STRUCTURAL_VOCAB[key]!.has(w)).map((w) => `${key}:${w}`)));
    expect(missing).toEqual([]);
  });
});
