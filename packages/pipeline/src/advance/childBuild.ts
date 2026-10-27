import { cleanWorkItemTitle } from "@fx/core/src/work-items/title.js";

/**
 * D#483 S5-b2c-1 / S5-b2c-2: the pairing guard between the child launch gate and the build.
 *
 * The launch gate (the sweep's child pass, a person's Approve on a planned PR) files a child's start only while this is true. It is true now: `startBuildForItem` builds for a
 * planned PR child (the parent's issue number, the parent's Spec version named by the child, its own branch `childBranchFor`). It stays code, not a setting: no environment
 * variable or database value can turn the gate on ahead of the build.
 */
export const CHILD_BUILD_SUPPORTED = true;

/**
 * D#483 S5-b2c-3 (R7): the branch name and the blocker live in @fx/core's `buildIdentity.ts`, the one definition every consumer shares (the pipeline cannot be imported from core, which
 * the resolver needs). They are re-exported here for the callers that imported them from this file.
 */
export { childBranchFor, childBuildBlocker, type ChildBuildBlocker } from "@fx/core/src/work-items/buildIdentity.js";

/** What stands in for a title that is empty, or that would carry a closing keyword into the prompt. */
export const CHILD_TITLE_FALLBACK = "this planned PR";

/** `Closes #1`, `fixed: #2`, `resolves owner/repo#3`, `closes https://github.com/o/r/issues/4`: the words GitHub reads as closing an issue when they sit in a pull request body. */
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:]*(?:(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d|(?:[\w.-]+\/[\w.-]+)?#\d)/i;

/**
 * The child's title as it may appear in a prompt: `cleanWorkItemTitle`'s output (the stored title is not trusted as prompt text), or the fixed fallback when nothing printable
 * is left or the cleaned text would read as a closing keyword. The prompt never names a title any other way.
 */
export function childPromptTitle(stored: unknown): string {
  const cleaned = cleanWorkItemTitle(stored);
  return cleaned === null || CLOSING_KEYWORD.test(cleaned) ? CHILD_TITLE_FALLBACK : cleaned;
}
