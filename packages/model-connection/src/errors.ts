// Re-exported, not reimplemented (same rationale as
// packages/core/src/tenancy/withTenant.ts re-exporting @fx/db's
// withTenant): criterion 7's "cross-tenant decrypt returns not-found"
// means this package must throw the SAME NotFoundError a route handler
// already maps to 404, not a second, incompatible type.
export { NotFoundError, ForbiddenError } from '@fx/core/src/tenancy/errors.js';

/**
 * Criterion 3: "401/403 -> rejected ... nothing stored." Thrown by
 * connect()/replace() before any row is written. Deliberately NOT a
 * NotFoundError/ForbiddenError -- "the key doesn't work" is a distinct
 * condition a route handler maps to 422/400.
 */
export class InvalidModelKeyError extends Error {
  constructor(
    message: string,
    public readonly providerCode: string,
  ) {
    super(message);
    this.name = 'InvalidModelKeyError';
  }
}

/**
 * Criterion 2's "tampered ciphertext fails closed": thrown when GCM
 * authentication fails on decrypt. One stable, package-owned type to
 * catch instead of matching on node:crypto's own error text/code.
 */
export class DecryptionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionFailedError';
  }
}
