/** Where the workspace lives for a profile origin. The workspace has no address per app yet, so every link is the origin itself. */
export const workspaceLink = (origin: string): string => `${origin}/`;

/** The Developer app, where tokens are made and revoked. */
export const developerTokensLink = (origin: string): string => workspaceLink(origin);
