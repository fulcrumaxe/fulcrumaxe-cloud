/**
 * D#221 KS: the two plan-based credential kinds, defined here so the model-connection kinds work imports them from
 * the kill switch and does not redefine them. Both run on the customer's own OpenAI account, and both are covered by
 * the server-side kill switch and the customer notice. Codex on an API key or the gateway, and opencode, are not.
 */
export const PLAN_PATH_KINDS = ['codex_access_token', 'chatgpt_oauth'] as const;

export type PlanPathKind = (typeof PLAN_PATH_KINDS)[number];

export function isPlanPathKind(value: unknown): value is PlanPathKind {
  return typeof value === 'string' && (PLAN_PATH_KINDS as readonly string[]).includes(value);
}

/**
 * The CURRENT notice version per kind. Bump a version when the notice text changes in a way a customer must
 * re-acknowledge: an acknowledgement recorded against an older version no longer counts (hasAcknowledgement).
 * The notice text itself belongs to the settings UI; only the version is recorded here.
 */
export const NOTICE_VERSIONS: Readonly<Record<PlanPathKind, string>> = {
  codex_access_token: 'v1',
  chatgpt_oauth: 'v1',
};

/** Thrown for a kind outside PLAN_PATH_KINDS. A programming error, not a customer-facing refusal. */
export class UnknownPlanKindError extends Error {
  constructor() {
    super('model-connection: not a plan-path credential kind');
    this.name = 'UnknownPlanKindError';
  }
}

export function assertPlanPathKind(value: unknown): asserts value is PlanPathKind {
  if (!isPlanPathKind(value)) throw new UnknownPlanKindError();
}
