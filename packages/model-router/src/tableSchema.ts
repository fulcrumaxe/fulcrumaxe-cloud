import { z } from 'zod';
import { ALL_ROUTABLE_ROLES } from './roleUniverse.js';
import { meetsFloor } from './floors.js';
import type { ModelId, RoutingRow, Size } from './types.js';

const SIZES: readonly Size[] = ['Small', 'Feature', 'Critical'];
const MODEL_IDS: readonly ModelId[] = ['haiku-4.5', 'sonnet-5', 'opus-5'];

export const RoutingRowSchema = z.object({
  role: z.string().min(1),
  size: z.enum(['Small', 'Feature', 'Critical']),
  model: z.enum(['haiku-4.5', 'sonnet-5', 'opus-5']),
  rationale: z.string().min(1),
});

export const DefaultTableFileSchema = z.object({
  version: z.number().int().positive(),
  fetchedPricesAt: z.string().min(1),
  rows: z.array(RoutingRowSchema),
});

export type DefaultTableFile = z.infer<typeof DefaultTableFileSchema>;

/**
 * Validates a routing table's rows against the zod shape above AND the
 * two structural requirements the amendment names explicitly:
 *   - every (role, size) pair for ALL_ROUTABLE_ROLES x the three sizes is
 *     present exactly once (a missing pair fails);
 *   - no row violates its role's floor (a table putting security-reviewer
 *     on Haiku is rejected at load).
 * Throws on the first problem found, with every problem's role/size
 * listed in the message so a failure is diagnosable in one read.
 */
export function validateRoutingRows(rows: readonly RoutingRow[]): void {
  const parsed = z.array(RoutingRowSchema).parse(rows);

  const seen = new Map<string, RoutingRow>();
  for (const row of parsed) {
    const key = `${row.role}:${row.size}`;
    if (seen.has(key)) {
      throw new Error(`routing table has a duplicate row for role "${row.role}", size "${row.size}"`);
    }
    seen.set(key, row as RoutingRow);
    assertMeetsFloorOrThrow(row as RoutingRow);
  }

  const missing: string[] = [];
  for (const role of ALL_ROUTABLE_ROLES) {
    for (const size of SIZES) {
      if (!seen.has(`${role}:${size}`)) missing.push(`${role}:${size}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`routing table is missing rows for: ${missing.join(', ')}`);
  }
}

function assertMeetsFloorOrThrow(row: RoutingRow): void {
  if (!meetsFloor(row.role, row.model)) {
    throw new Error(`routing table row violates floor: role "${row.role}" is set to "${row.model}"`);
  }
}

export function isKnownModelId(value: string): value is ModelId {
  return (MODEL_IDS as readonly string[]).includes(value);
}
