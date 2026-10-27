import { cleanWorkItemTitle } from "@fx/core/src/work-items/title.js";
import { CHILD_TITLE_FALLBACK as FALLBACK, safeChildTitle } from "@fx/core/src/work-items/childTitle.js";

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

/** What stands in for a title that is empty, or that would carry a closing keyword into the prompt (the one fallback of the whole child path). */
export const CHILD_TITLE_FALLBACK = FALLBACK;

/**
 * The child's title as it may appear in a prompt: `cleanWorkItemTitle`'s output (the stored title is not trusted as prompt text), or the fixed fallback when nothing printable
 * is left or the cleaned text would read as a closing keyword. The closing-keyword pattern is the runner protocol's, shared with both pull request texts. The prompt never names a title any other way.
 */
export function childPromptTitle(stored: unknown): string {
  return safeChildTitle(cleanWorkItemTitle(stored));
}
