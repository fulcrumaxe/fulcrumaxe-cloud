/**
 * D#31 API-8c: the one list of `installations.app_kind` values. The
 * database CHECK (migration 0647) must hold exactly this set;
 * packages/db/test/installations-app-kind.test.ts fails if they drift.
 * `team` is the write App, `team_readonly` the preview-only read App, and
 * `sitekit` the site-kit App.
 */
export const INSTALLATION_APP_KINDS = ['team', 'team_readonly', 'sitekit'] as const;

export type InstallationAppKind = (typeof INSTALLATION_APP_KINDS)[number];
