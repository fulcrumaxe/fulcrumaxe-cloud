import { afterEach, describe, expect, it } from 'vitest';
import { configureErrorReporter, type ErrorClass } from '@fx/telemetry';
import { InstallationTokenError } from '../src/index.js';
import { atStage, reportSyncFailure } from '../src/syncFailureTag.js';

/**
 * syncFailureTag.ts hands the same swallowed failure to the shared reporter: one coded line and one error class,
 * with the stage `atStage` marked, and nothing from the message or from an upstream word.
 */
function capture() {
  const lines: string[] = [];
  const events: ErrorClass[] = [];
  configureErrorReporter({ service: 'web', write: (l) => lines.push(l), sink: { record: (e) => void events.push(e) } });
  return { lines, events };
}

afterEach(() => configureErrorReporter({ service: 'app' }));

describe('reportSyncFailure', () => {
  it('reports the stage atStage marked and the reason an InstallationTokenError carries, as a class', async () => {
    const { lines, events } = capture();
    const err = await atStage('mint_token', Promise.reject(new InstallationTokenError('mint_failed'))).catch((e) => e);
    reportSyncFailure(err, '/api/github/webhook');
    expect(events).toEqual([{ service: 'web', route: '/api/:id/:id', stage: 'mint_token', code: 'mint_failed' }]);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'error.reported', stage: 'mint_token', error_name: 'InstallationTokenError', error_code: 'mint_failed' });
  });

  it('stores an upstream word as other, an unmarked error under stage unknown, and never echoes either', () => {
    const { lines, events } = capture();
    reportSyncFailure(Object.assign(new Error('Not Found acme/widgets'), { reason: 'acme-widgets', fxStage: 'acme/widgets' }), '/api/github/webhook');
    reportSyncFailure('a string with acme/widgets', '/api/github/webhook');
    expect(events.map((e) => [e.stage, e.code])).toEqual([['unknown', 'other'], ['unknown', 'other']]);
    for (const l of lines) {
      expect(l).not.toContain('acme');
      expect(l).not.toContain('widgets');
    }
  });
});
