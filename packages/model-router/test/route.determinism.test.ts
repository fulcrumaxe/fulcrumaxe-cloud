import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { route } from '../src/route.js';
import { ALL_ROUTABLE_ROLES } from '../src/roleUniverse.js';
import type { ModelId, RoutingRow, RoutingTable, Size } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.join(__dirname, '..', 'default-table', 'v1.json'), 'utf8');
const rows = (JSON.parse(raw) as { rows: RoutingRow[] }).rows;
const table: RoutingTable = { version: 1, rows };

const SIZES: readonly Size[] = ['Small', 'Feature', 'Critical'];
const MODEL_IDS: readonly ModelId[] = ['haiku-4.5', 'sonnet-5', 'opus-5'];

describe('route() determinism', () => {
  it('every (role, size) pair returns the same result when routed twice', () => {
    for (const role of ALL_ROUTABLE_ROLES) {
      for (const size of SIZES) {
        const first = route({ role, size }, table);
        const second = route({ role, size }, table);
        expect(second).toEqual(first);
      }
    }
  });

  it('property test: 1,000 seeded random inputs, each routed twice, always agree', () => {
    // Simple deterministic LCG so the "seeded" test itself never flakes.
    let seed = 42;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };

    for (let i = 0; i < 1000; i++) {
      const role = ALL_ROUTABLE_ROLES[next() % ALL_ROUTABLE_ROLES.length] as string;
      const size = SIZES[next() % SIZES.length] as Size;
      const useOverride = next() % 2 === 0;
      const modelOverride = useOverride ? (MODEL_IDS[next() % MODEL_IDS.length] as ModelId) : undefined;
      const input = { role, size, repoSettings: modelOverride ? { modelOverride } : undefined };

      const first = route(input, table);
      const second = route(input, table);
      expect(second).toEqual(first);
    }
  });

  it('throws for a table missing the requested (role, size) row', () => {
    expect(() => route({ role: 'executor', size: 'Small' }, { version: 1, rows: [] })).toThrow(/no routing row/);
  });
});
