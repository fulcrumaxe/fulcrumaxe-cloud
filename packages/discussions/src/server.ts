import type { Principal } from "./principals.js";

/**
 * D#71 DS-2 Conventions: "system: Only by systemPrincipal(reason),
 * exported from @fx/discussions/server and never from the package
 * index." Import this from '@fx/discussions/server' -- never from the
 * package root (src/index.ts never re-exports it; criterion 2 tests
 * that). Workflow steps, webhook handlers and cron (D#71's H15, D#2
 * correction C20) are the only legitimate callers -- nothing that
 * resolves a request from outside our own server code should ever be
 * able to construct a 'system' principal.
 */
export function systemPrincipal(accountId: string, reason: string): Principal {
  return { kind: "system", accountId, reason };
}

/**
 * D#71 DS-2d: the system-only signed agent comment. Exported here and never
 * from the package index, for the same reason as `systemPrincipal`: only
 * server code that holds a system principal can call it, and the operation
 * table refuses every other principal kind.
 */
export { postAgentComment } from "./comments.js";
export type { PostAgentCommentInput } from "./comments.js";
