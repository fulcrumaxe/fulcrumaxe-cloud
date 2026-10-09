// Re-exported, not reimplemented (same rationale as
// packages/model-connection/src/errors.ts): a cross-account repo lookup
// and a non-admin mutation must throw the SAME NotFoundError/ForbiddenError
// a route handler already maps to 404/403, not a second, incompatible type.
export { NotFoundError, ForbiddenError } from '../tenancy/errors.js';

/**
 * Thrown for a well-formed-but-invalid request this module rejects before
 * touching the database: an unknown role name, or a mode outside that
 * role's `allowedModes`, or a guard-off change missing the required
 * `confirmed: true`. Deliberately NOT a NotFoundError/ForbiddenError --
 * this is "the input doesn't make sense," a distinct condition a route
 * handler maps to 400/422, not 403/404.
 */
export class InvalidRoleSettingsInputError extends Error {
  /**
   * `field` names the offending input (`role`, `mode`, `auto_merge`,
   * `block_external_auto_merge`, `acknowledge_external_risk`); the API
   * layer surfaces it as the 422's `details[].path`. Defaults to `''`.
   */
  constructor(
    message: string,
    public readonly field: string = '',
  ) {
    super(message);
    this.name = 'InvalidRoleSettingsInputError';
  }
}

/**
 * D#6 M1G-a: the operator locked this repository to human merges (`FX_HUMAN_MERGE_ONLY_REPO_IDS`), so auto-merge cannot be
 * turned on. Nothing was written. The API layer maps it to 409 `human_merge_only`.
 */
export class HumanMergeOnlyError extends Error {
  constructor(message = 'a person merges every pull request in this repository; the operator set this') {
    super(message);
    this.name = 'HumanMergeOnlyError';
  }
}
