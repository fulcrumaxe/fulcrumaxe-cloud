import type { GithubWebhookDbDeps } from "@fx/github";
import { getAuthorCheck } from "./authorCheck";

/**
 * D#483 P1: the webhook's author-permission lookup, the retry author check's own GitHub lookup (./authorCheck.ts), so one
 * implementation answers "what can this issue's author really do in this repo". It reads the issue (the author's login,
 * as GitHub resolves it now) and that login's repository permission with a read-only installation token.
 *
 * On an organization repo even the org owner's issue arrives as MEMBER, or CONTRIBUTOR when the membership is private, so
 * the payload's `author_association` alone could never trust anyone there. The webhook asks only for an `issues.opened`
 * whose association is not OWNER, and uses the answer for that one delivery.
 *
 * Fail closed: no check built, a missing issue, or any throw (GitHub down, over the cap, a failed token mint) answers
 * null or throws, and the webhook then lets the association alone decide. The whole lookup is bounded so a slow GitHub
 * cannot hold a webhook delivery open.
 */
export const LOOKUP_DEADLINE_MS = 8_000;

export const issueAuthorPermission: NonNullable<GithubWebhookDbDeps["issueAuthorPermission"]> = async (input) => {
  const check = getAuthorCheck();
  if (!check) return null;
  const found = await check.lookup({ ...input, signal: AbortSignal.timeout(LOOKUP_DEADLINE_MS) });
  return found.status === "found" ? { login: found.login, permission: found.permission } : null;
};
