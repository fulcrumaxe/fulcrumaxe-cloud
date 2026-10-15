/** Where the workspace lives for a profile origin. The workspace has no address per app yet, so every link is the origin itself. */
export const workspaceLink = (origin: string): string => `${origin}/`;

/** The Developer app, where tokens are made and revoked. */
export const developerTokensLink = (origin: string): string => workspaceLink(origin);

/**
 * The actions a token can never do, and the workspace app each one lives in. This is the one table, and `pointerLink` is its only reader.
 * Every link falls back to the workspace origin until the workspace gains per-app addresses; then only `pointerLink` changes.
 */
export const SESSION_ONLY = {
  "webhooks add": "developer",
  "webhooks test": "developer",
  "webhooks edit": "developer",
  "webhooks delete": "developer",
  "webhooks rotate-secret": "developer",
  sites: "site-review",
  "runs retry": "runs",
  "work-items approve": "pipeline",
  "work-items close": "pipeline",
  "work-items reopen": "pipeline",
  "work-items respec": "pipeline",
  "budgets set": "budget-billing",
  tokens: "developer",
} as const;

export type SessionOnlyAction = keyof typeof SESSION_ONLY;

export const isSessionOnly = (action: string): action is SessionOnlyAction => Object.hasOwn(SESSION_ONLY, action);

/** The workspace page for a session-only action: the app's own page, which today is the workspace origin. */
export const pointerLink = (origin: string, _action: SessionOnlyAction): string => workspaceLink(origin);
