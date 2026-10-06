import { describe, expect, it } from 'vitest';
import { ACTIVITY_KIND, PROGRESS_EVENT_FIELDS, buildFeed, lineFor, type EventFields } from '../src/onboarding/previewProgress.js';

// D#483 P4: the pipeline's activity view may show a stored command line, but the free preview's own feed must not.
// The preview reads only the fields in PROGRESS_EVENT_FIELDS and fills a fixed template; `command` is neither.
describe('the preview feed ignores a stored command line', () => {
  it('does not read a command field and keeps its fixed templates', () => {
    expect((PROGRESS_EVENT_FIELDS as readonly string[]).includes('command')).toBe(false);
    const withCommand = { tool: 'command', command: 'git push --force' } as unknown as EventFields;
    expect(lineFor(ACTIVITY_KIND, withCommand)).toBe('Running a command');
    expect(lineFor(ACTIVITY_KIND, { tool: 'test', command: 'pnpm test' } as unknown as EventFields)).toBe('Running the tests');
    const feed = buildFeed([{ seq: 1, kind: ACTIVITY_KIND, at: new Date('2026-10-03T10:00:00Z'), fields: withCommand }], null);
    expect(feed.map((l) => l.text)).toEqual(['Running a command']);
    expect(JSON.stringify(feed)).not.toContain('git push');
  });
});
