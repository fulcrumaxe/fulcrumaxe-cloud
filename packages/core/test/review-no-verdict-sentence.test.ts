import { describe, expect, it } from 'vitest';
import { reviewerNoVerdictSentence } from '../src/work-items/activity.js';

describe('reviewerNoVerdictSentence', () => {
  it('names the reviewer and how it ended, and tells the person Approve reviews again', () => {
    const s = reviewerNoVerdictSentence(['security_reviewer', 'resource_limit']);
    expect(s).toContain('The security reviewer could not finish reviewing this pull request: it was stopped at its memory limit');
    expect(s).toContain('Press Approve to have the reviewers look at the pull request again');
  });

  it.each(['succeeded', 'no_verdict', 'empty_agent_output'])('a run that finished with no verdict block (%s) reads as finished without a verdict, not as an environment problem', (end) => {
    const s = reviewerNoVerdictSentence(['security_reviewer', end]);
    expect(s).toContain('The security reviewer could not finish reviewing this pull request: it finished without giving a verdict');
    expect(s).not.toMatch(/environment|tests/);
    expect(s).toContain('No verdict was recorded and no changes were requested');
  });

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'])('a reviewer code that is the object property "%s" is not a reviewer: null, never an inherited value', (key) => {
    expect(reviewerNoVerdictSentence([key, 'agent_failed'])).toBeNull();
  });

  it.each(['constructor', 'toString', '__proto__'])('an end code that is the object property "%s" reads as the generic end', (key) => {
    expect(reviewerNoVerdictSentence(['code_reviewer', key])).toContain('its run ended without a verdict');
  });

  it('no reasons: null', () => {
    expect(reviewerNoVerdictSentence([])).toBeNull();
  });
});
