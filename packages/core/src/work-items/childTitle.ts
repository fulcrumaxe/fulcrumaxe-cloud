import { hasClosingKeywordReference } from '../repos/planePushText.js';

/** What stands in for a planned PR child's title that is empty or would carry a closing keyword (the one fallback of the whole child path: prompt, private draft, public pull request). */
export const CHILD_TITLE_FALLBACK = 'this planned PR';

/**
 * A planned PR child's cleaned title (`cleanWorkItemTitle`'s output, or null) as it may appear in a prompt or a pull request: the fallback when nothing is left or the text reads as a closing
 * keyword. The closing-keyword pattern is the runner protocol's `hasClosingKeywordReference`, the same one the pull request text builder and its final body guard use.
 */
export const safeChildTitle = (cleaned: string | null): string => (cleaned === null || hasClosingKeywordReference(cleaned) ? CHILD_TITLE_FALLBACK : cleaned);
