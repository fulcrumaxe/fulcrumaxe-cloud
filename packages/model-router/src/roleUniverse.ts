import { ROLE_NAMES, SITEKIT_ROLE_NAMES } from '@fx/roles';

/**
 * The routing table covers every (role, size) pair for the hosted team's roles (ROLE_NAMES, the 26 in
 * ROLE_MANIFEST) plus the two site-kit roles (SITEKIT_ROLE_NAMES: site-extractor and site-verifier, defined by
 * D#3 K05 and kept out of ROLE_MANIFEST on purpose, since the hosted team's per-repo role settings list exactly
 * the 26). 28 entries, no duplicates.
 */
export const ALL_ROUTABLE_ROLES: readonly string[] = [...ROLE_NAMES, ...SITEKIT_ROLE_NAMES];
