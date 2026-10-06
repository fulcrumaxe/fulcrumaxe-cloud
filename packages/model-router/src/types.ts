import type { ModelId } from '@fx/spend';

export type { ModelId };

/** Work-item size, the second routing dimension (Spec H22). Distinct from
 * @fx/spend's WorkItemKind ('feature' | 'small' | null, H05's cap-checking
 * dimension) -- H22 introduces its own three-value Size, including
 * 'Critical', which H05 has no cap tier for. */
export type Size = 'Small' | 'Feature' | 'Critical';

export interface RoutingRow {
  role: string;
  size: Size;
  model: ModelId;
  rationale: string;
}

export interface RoutingTable {
  version: number;
  rows: readonly RoutingRow[];
}

/** The per-repo customer override this router honours: role_settings.model
 * (H12), already resolved by the caller -- this package never queries
 * role_settings itself (H22's file scope is packages/model-router/**). */
export interface RepoSettings {
  modelOverride?: ModelId;
}

export interface RouteInput {
  role: string;
  size: Size;
  /** The account's default backend; ignored for floored roles. */
  accountBackend?: { backend: string; provider: string };
  repoSettings?: RepoSettings;
}

export interface RouteResult {
  model: ModelId;
  reason: string;
  tableVersion: number;
  /** Backend/provider the run must use; floored roles are pinned. */
  backend: string;
  provider: string;
}

/** Model tier order, low to high. Shared by escalate.ts (next tier up) and
 * floors.ts (is this model at or above a floor). */
export const MODEL_TIER_ORDER: readonly ModelId[] = ['haiku-4.5', 'sonnet-5', 'opus-5'];

export function tierRank(model: ModelId): number {
  return MODEL_TIER_ORDER.indexOf(model);
}
