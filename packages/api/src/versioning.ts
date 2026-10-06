/**
 * D#31 API-1, "The v1 contract": the API is additive-only from the
 * version that first ships it. `SUPPORTED_VERSIONS` names every version
 * the catch-all will dispatch for -- today only `v1` -- and `DEPRECATIONS`
 * is the literal, append-only table of sunset dates a future task fills
 * in (TA: "Deprecation/Sunset dates are stored as data", with at least 6
 * months' notice). Both are plain data, not enforcement: the catch-all
 * route itself only exists at `apps/web/app/api/v1/[...path]/route.ts`,
 * so a request to `/api/<resource>` or `/api/v2/*` already 404s via
 * Next's own routing (no route file matches it) without either constant
 * being consulted. These exist so a later task (deprecation headers, a
 * v2 catch-all) has one place to read the supported/sunset set from
 * rather than re-deriving it.
 */
export const SUPPORTED_VERSIONS = ["v1"] as const;

export type ApiVersion = (typeof SUPPORTED_VERSIONS)[number];

export interface Deprecation {
  /** The operationId or path being deprecated. */
  target: string;
  /** ISO date the deprecation was announced. */
  since: string;
  /** ISO date the route stops working -- at least 6 months after `since`. */
  sunset: string;
}

/** Empty at launch (TA point 9 / C1 file-ownership note: additive-only binds from the first merge). */
export const DEPRECATIONS: readonly Deprecation[] = [];
