import { afterEach, describe, expect, it } from 'vitest';
import { fetchValidationHttpClient } from '../src/httpClient.js';
import { captureReports } from './helpers/captureReports.js';

// A fetch failure is reported as a coded class. The error fetch throws for a key with a control character
// carries the whole Authorization header in its message; none of that may reach the report.
const FAKE_KEY = 'sk-FAKE-h1b-secret-0123456789';

describe('the validation client reports a failed call without any of the error text', () => {
  const realFetch = globalThis.fetch;
  let reports: ReturnType<typeof captureReports>;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('keeps the fixed outcome, writes one coded line, and carries no key, message or provider code', async () => {
    reports = captureReports();
    globalThis.fetch = (async () => {
      const err = new TypeError(`Headers.append: "Bearer ${FAKE_KEY}\n" is an invalid header value`) as TypeError & { code: string };
      err.code = 'octocat-' + FAKE_KEY;
      throw err;
    }) as typeof fetch;

    const outcome = await fetchValidationHttpClient().validate({ provider: 'anthropic', plaintextKey: FAKE_KEY });

    // Behaviour unchanged: the fixed network_error answer, no text from the error.
    expect(outcome.kind).toBe('network_error');
    expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
    // One reported class with a fixed stage and the catch-all code.
    expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'model_key.validate', code: 'other' }]);
    expect(reports.lines).toHaveLength(1);
    expect(reports.lines[0]).toContain('"stage":"model_key.validate"');
    expect(reports.everything()).not.toContain(FAKE_KEY);
    expect(reports.everything()).not.toContain('Bearer');
    expect(reports.everything()).not.toContain('octocat');
  });
});
