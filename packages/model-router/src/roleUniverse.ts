import { ROLE_NAMES } from '@fx/roles';

/**
 * The H22 amendment (D#2, discussioncomment-18488776) requires the routing
 * table's zod schema to cover "every (role, size) pair for all 26 roles
 * plus the two site-kit roles". ROLE_NAMES below is the real, current
 * source of the 26 -- it is exactly ROLE_MANIFEST's 26 entries, confirmed
 * against packages/roles/test/manifest.test.ts's "lists exactly 26 roles"
 * assertion.
 *
 * "The two site-kit roles" have NO definition anywhere: not in this
 * repo's D#2 Discussion (every comment naming H22, C1-C11, and every other
 * comment mentioning "H22" or "site-kit" were checked), not in
 * packages/roles, not in packages/gh-policy/src/rolePermissions.ts (which
 * has a `sitekit` PRODUCT scope, not two extra AI-agent roles), and not in
 * packages/sitekit-template (a static-site-builder product with no agent
 * roles of its own). None of H22's own dependencies (H02, H05, H08) name
 * them either.
 *
 * Rather than invent two role names the Spec never wrote down (or silently
 * drop the requirement), this is left as an explicit, empty extension
 * point -- the same shape packages/db/src/platformWideTables.ts used for
 * H22's own tables before H22 existed. Adding the two roles later is a
 * one-line data change here, not a code change, matching "table is data,
 * not code". Flagged in the PR description for the Team Lead/PM to name
 * them.
 */
export const SITE_KIT_ROLES: readonly string[] = [];

export const ALL_ROUTABLE_ROLES: readonly string[] = [...ROLE_NAMES, ...SITE_KIT_ROLES];
