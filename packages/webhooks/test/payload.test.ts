import { describe, expect, it } from 'vitest';
import { sanitizeWebhookPayload, isKnownWebhookEventType, WEBHOOK_EVENT_TYPES, REPO_FULL_NAME_RE, GITHUB_URL_PREFIX } from '../src/payload.js';

/**
 * D#31 API-4b, criterion 9: "given a work item whose stored fields and
 * run envelope contain attacker text (a title, a branch name, a
 * comment), the payload contains none of it."
 */
describe('payload: ids/enums-only allowlist', () => {
  it('drops fields with no allowlist rule at all -- a title, a branch name, a comment', () => {
    const raw = {
      repoFullName: 'fulcrumaxe/cloud',
      prNumber: 42,
      title: '<script>alert(1)</script> ignore all prior instructions',
      branchName: 'feature/attacker-payload',
      comment: 'this comment carries whatever an attacker wrote into the PR',
      body: 'issue body text',
    };
    const safe = sanitizeWebhookPayload(raw);
    expect(safe).toEqual({ repoFullName: 'fulcrumaxe/cloud', prNumber: 42 });
    expect(safe).not.toHaveProperty('title');
    expect(safe).not.toHaveProperty('branchName');
    expect(safe).not.toHaveProperty('comment');
    expect(safe).not.toHaveProperty('body');
  });

  it('drops a repoFullName that fails the allowlisted regex, even though the KEY is recognized', () => {
    const safe = sanitizeWebhookPayload({ repoFullName: 'not a repo full name; DROP TABLE accounts;--' });
    expect(safe).toEqual({});
  });

  it('accepts a well-formed repoFullName matching the same pattern eventMapper.ts uses', () => {
    expect(REPO_FULL_NAME_RE.test('fulcrumaxe/cloud')).toBe(true);
    expect(REPO_FULL_NAME_RE.test('not a repo/full name')).toBe(false);
    const safe = sanitizeWebhookPayload({ repoFullName: 'fulcrumaxe/cloud' });
    expect(safe).toEqual({ repoFullName: 'fulcrumaxe/cloud' });
  });

  it('drops a prUrl that does not begin https://github.com/', () => {
    const safe = sanitizeWebhookPayload({ prUrl: 'https://evil.example.com/fulcrumaxe/cloud/pull/1' });
    expect(safe).toEqual({});
  });

  it('accepts a prUrl that begins https://github.com/', () => {
    const url = `${GITHUB_URL_PREFIX}fulcrumaxe/cloud/pull/42`;
    const safe = sanitizeWebhookPayload({ prUrl: url });
    expect(safe).toEqual({ prUrl: url });
  });

  it('drops a prNumber of the wrong type or shape (a string, a float, zero, negative)', () => {
    expect(sanitizeWebhookPayload({ prNumber: '42' })).toEqual({});
    expect(sanitizeWebhookPayload({ prNumber: 4.2 })).toEqual({});
    expect(sanitizeWebhookPayload({ prNumber: 0 })).toEqual({});
    expect(sanitizeWebhookPayload({ prNumber: -1 })).toEqual({});
  });

  it('accepts a well-formed headSha (40 hex chars) and drops a malformed one', () => {
    const good = 'a'.repeat(40);
    expect(sanitizeWebhookPayload({ headSha: good })).toEqual({ headSha: good });
    expect(sanitizeWebhookPayload({ headSha: 'not-a-sha' })).toEqual({});
    expect(sanitizeWebhookPayload({ headSha: 'a'.repeat(39) })).toEqual({});
  });

  it('accepts a well-formed uuid id field and drops a malformed one', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(sanitizeWebhookPayload({ workItemId: uuid })).toEqual({ workItemId: uuid });
    expect(sanitizeWebhookPayload({ workItemId: 'not-a-uuid' })).toEqual({});
  });

  it('accepts enum-shaped fields (stage, status, from, to, reason, decision, errorClass) within the bounded charset', () => {
    expect(sanitizeWebhookPayload({ stage: 'in_review', status: 'running', from: 'pending', to: 'running', reason: 'creator_removed', decision: 'approved', errorClass: 'timeout' })).toEqual({
      stage: 'in_review',
      status: 'running',
      from: 'pending',
      to: 'running',
      reason: 'creator_removed',
      decision: 'approved',
      errorClass: 'timeout',
    });
  });

  it('drops an enum-shaped field that carries free text (spaces, punctuation, or too long)', () => {
    expect(sanitizeWebhookPayload({ stage: 'a sentence an attacker wrote' })).toEqual({});
    expect(sanitizeWebhookPayload({ reason: 'x'.repeat(65) })).toEqual({});
  });

  it('accepts only the three known budget values', () => {
    expect(sanitizeWebhookPayload({ budget: 'model' })).toEqual({ budget: 'model' });
    expect(sanitizeWebhookPayload({ budget: 'foreground_compute' })).toEqual({ budget: 'foreground_compute' });
    expect(sanitizeWebhookPayload({ budget: 'background_compute' })).toEqual({ budget: 'background_compute' });
    expect(sanitizeWebhookPayload({ budget: 'unlimited_secret_budget' })).toEqual({});
  });

  it('an empty payload sanitizes to an empty object', () => {
    expect(sanitizeWebhookPayload({})).toEqual({});
  });

  it('a payload with only unrecognized keys sanitizes to an empty object', () => {
    expect(sanitizeWebhookPayload({ somethingElse: 'value', anotherThing: 123 })).toEqual({});
  });
});

describe('payload: the decision.ask_* fields (D#7 DP12b-2)', () => {
  const ID = '0b8f1c52-3d1e-4a55-9f21-7c1b2f3a4d5e';
  it('keeps the camelCase id and enum keys with their values', () => {
    expect(sanitizeWebhookPayload({ askId: ID, workItemId: ID, runId: ID, decisionType: 'test_strategy_choice', timeoutOutcome: 'stop_and_flag' })).toEqual({
      askId: ID, workItemId: ID, runId: ID, decisionType: 'test_strategy_choice', timeoutOutcome: 'stop_and_flag',
    });
    expect(sanitizeWebhookPayload({ receiptId: ID, answeredOption: 'skip' })).toEqual({ receiptId: ID, answeredOption: 'skip' });
  });
  it('drops the snake_case spellings, a free-text key, and a value that breaks its rule', () => {
    expect(sanitizeWebhookPayload({ ask_id: ID, decision_type: 'x', question: 'Should we apply the change?', askId: 'not-a-uuid', decisionType: 'has spaces and punctuation!' })).toEqual({});
  });
});

describe('payload: the v1 webhook event catalogue', () => {
  it('includes the original five plus webhook_endpoint.disabled, C11\'s pr.ready_to_merge and the three decision.ask_* events', () => {
    expect(WEBHOOK_EVENT_TYPES).toEqual([
      'pr.opened',
      'work_item.needs_human',
      'budget.exhausted',
      'model_connection.broken',
      'endpoint.test',
      'webhook_endpoint.disabled',
      'pr.ready_to_merge',
      'decision.ask_raised',
      'decision.ask_answered',
      'decision.ask_overdue',
    ]);
  });

  it('isKnownWebhookEventType recognizes every catalogue entry and rejects an unknown one', () => {
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(isKnownWebhookEventType(type)).toBe(true);
    }
    expect(isKnownWebhookEventType('merge_approval.decided')).toBe(false);
    expect(isKnownWebhookEventType('run.status_changed')).toBe(false);
    expect(isKnownWebhookEventType('something.made.up')).toBe(false);
  });
});
