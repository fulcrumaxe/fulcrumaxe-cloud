import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_KIND,
  PROGRESS_LIMITS,
  SLOW_AFTER_SECONDS,
  STAGE_KIND,
  STATUS_KIND,
  buildFeed,
  deriveProgress,
  lineFor,
  safeRepoPath,
  safeSearchTerm,
  type EventFields,
  type ProgressEvent,
  type ProgressFacts,
} from '../src/onboarding/previewProgress.js';

/** D#2 PREVIEW-LIVE-PROGRESS: the event-to-line mapper and the stage derivation, as pure functions. */

const TOKENS = ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github_pat_11AAAAAAA0abcdef', 'AKIA' + 'ABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1NiJ9', 'Bearer abc.def'];
const URLS = ['https://evil.example/x?token=1', 'http://10.0.0.1/', 'git@github.com:acme/repo.git', 'ftp://host/file'];
/** Strings that must never reach any line, whichever field an event puts them in. */
const FORBIDDEN = [...TOKENS, ...URLS, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'password=hunter2', 'const secret = process.env.KEY;'];

const act = (f: EventFields) => lineFor(ACTIVITY_KIND, f);

describe('lineFor: fixed templates only', () => {
  it('fills the four activity templates with a safe path or term', () => {
    expect(act({ tool: 'read', path: 'src/server.ts' })).toBe('Reading src/server.ts');
    expect(act({ tool: 'list', path: 'packages/api' })).toBe('Looking through packages/api');
    expect(act({ tool: 'list' })).toBe('Looking through the repository');
    expect(act({ tool: 'search', pattern: 'login' })).toBe("Searching for 'login'");
    expect(act({ tool: 'test' })).toBe('Running the tests');
    expect(act({ tool: 'command' })).toBe('Running a command');
  });

  it('names the three stage marks and the run start, and nothing else from those kinds', () => {
    expect(lineFor(STAGE_KIND, { stage: 'sandbox_ready' })).toBe('The secure sandbox is ready');
    expect(lineFor(STAGE_KIND, { stage: 'cloned' })).toBe('Repository cloned');
    expect(lineFor(STAGE_KIND, { stage: 'writing_result' })).toBe('Writing up the result');
    expect(lineFor(STAGE_KIND, { stage: 'something else' })).toBeNull();
    expect(lineFor(STATUS_KIND, { to: 'running' })).toBe('The run started');
    expect(lineFor(STATUS_KIND, { to: 'failed', failureReason: 'sandbox_error' })).toBeNull();
  });

  it('gives an unknown kind or tool no line, however much text the event carries', () => {
    expect(lineFor('agent.output', { tool: 'read', path: 'src/a.ts' })).toBeNull();
    expect(lineFor('run.input', { tool: 'read', path: 'src/a.ts' })).toBeNull();
    expect(act({ tool: 'write', path: 'src/a.ts' })).toBeNull();
    expect(act({})).toBeNull();
  });

  it('allowlist: a token, URL, secret or file content in ANY field never reaches a line', () => {
    for (const bad of FORBIDDEN) {
      const events: Array<[string, EventFields]> = [
        [ACTIVITY_KIND, { tool: 'read', path: bad }],
        [ACTIVITY_KIND, { tool: 'read', path: `src/${bad}` }],
        [ACTIVITY_KIND, { tool: 'list', path: bad }],
        [ACTIVITY_KIND, { tool: 'search', pattern: bad }],
        [ACTIVITY_KIND, { tool: 'search', pattern: `login ${bad}` }],
        [ACTIVITY_KIND, { tool: bad, path: 'src/a.ts', pattern: bad }],
        [ACTIVITY_KIND, { tool: 'test', path: bad, pattern: bad, stage: bad, to: bad }],
        [ACTIVITY_KIND, { tool: 'command', path: bad, pattern: bad }],
        [STAGE_KIND, { stage: bad, path: bad, pattern: bad }],
        [STATUS_KIND, { to: bad, failureReason: bad, path: bad }],
      ];
      for (const [kind, fields] of events) {
        const text = lineFor(kind, fields);
        for (const needle of FORBIDDEN) expect(text ?? '').not.toContain(needle);
      }
    }
  });

  it('a path outside the repository or naming a credential never reaches a line', () => {
    for (const p of ['/etc/passwd', '../secrets.txt', 'src/../../x', '~/.ssh/id_rsa', 'C:\\Users\\a', '.env', 'config/.env.production', 'keys/server.pem', '.git/config', 'src//a.ts', 'src/a.ts/', 'a b.ts', 'src/a.ts?x=1', '%2e%2e/x']) {
      expect(act({ tool: 'read', path: p })).toBeNull();
      expect(act({ tool: 'list', path: p })).toBeNull();
    }
  });

  it('a search term that looks like a credential is left out of the line, not shown', () => {
    expect(act({ tool: 'search', pattern: TOKENS[1] })).toBe('Searching the code');
    expect(act({ tool: 'search', pattern: 'x'.repeat(41) })).toBe('Searching the code');
    expect(act({ tool: 'search', pattern: "it's \"quoted\"" })).toBe('Searching the code');
    expect(act({ tool: 'search', pattern: '' })).toBe('Searching the code');
  });

  it('keeps every line within the length cap', () => {
    const long = `${'ab.'.repeat(13)}x/${'cd.'.repeat(13)}y`;
    expect(safeRepoPath(long)).toBe(long);
    expect((act({ tool: 'read', path: long }) ?? '').length).toBeLessThanOrEqual(PROGRESS_LIMITS.maxLineChars);
    expect(safeRepoPath('a'.repeat(PROGRESS_LIMITS.maxPathChars + 1))).toBeNull();
    const term = 'ab '.repeat(13).trim();
    expect(safeSearchTerm(term)).toBe(term);
    expect(safeSearchTerm(`${term} abcd`)).toBeNull();
  });
});

const ev = (seq: number, kind: string, fields: EventFields): ProgressEvent => ({ seq, kind, at: new Date(Date.UTC(2026, 8, 21, 14, 0, seq)), fields });

describe('buildFeed', () => {
  it('drops events with no line, orders oldest first and keeps only the newest maxLines', () => {
    const events: ProgressEvent[] = [];
    for (let i = 1; i <= 100; i++) events.push(ev(i, ACTIVITY_KIND, i % 2 ? { tool: 'read', path: `src/f${i}.ts` } : { tool: 'bogus' }));
    const feed = buildFeed([...events].reverse(), null);
    expect(feed).toHaveLength(PROGRESS_LIMITS.maxLines);
    expect(feed.map((l) => l.seq)).toEqual([...feed.map((l) => l.seq)].sort((a, b) => a - b));
    expect(feed.at(-1)).toMatchObject({ seq: 99, text: 'Reading src/f99.ts' });
    expect(feed.every((l) => l.text.length <= PROGRESS_LIMITS.maxLineChars)).toBe(true);
  });

  it('adds one line for the first agent message without reading its text', () => {
    const feed = buildFeed([ev(2, STATUS_KIND, { to: 'running' })], { seq: 9, at: new Date(Date.UTC(2026, 8, 21, 14, 1, 0)) });
    expect(feed.map((l) => l.text)).toEqual(['The run started', 'The agent sent its first message']);
  });
});

const T0 = new Date('2026-09-21T14:00:00.000Z');
const facts = (over: Partial<ProgressFacts> = {}): ProgressFacts => ({
  now: new Date(T0.getTime() + 60_000),
  previewState: 'running',
  voidReason: null,
  createdAt: T0,
  startedAt: new Date(T0.getTime() + 5_000),
  endedAt: null,
  runStatus: 'running',
  failureReason: null,
  marks: {},
  activityCount: 0,
  agentOutputCount: 0,
  ...over,
});
const statuses = (d: ReturnType<typeof deriveProgress>) => d.stages.map((s) => `${s.id}:${s.status}`).join(' ');

describe('deriveProgress', () => {
  it('requested: queued, the first stage active, nothing else reached', () => {
    const d = deriveProgress(facts({ previewState: 'requested', startedAt: null, runStatus: null }));
    expect(d.outcome).toBe('queued');
    expect(statuses(d)).toBe('queued:active sandbox:pending clone:pending read:pending plan:pending write:pending done:pending');
  });

  it('a run with nothing recorded after it sits on the sandbox stage, whatever the elapsed time', () => {
    for (const secs of [10, 120, 10_000]) {
      const d = deriveProgress(facts({ now: new Date(T0.getTime() + secs * 1000) }));
      expect(d.outcome).toBe('starting');
      expect(statuses(d)).toBe('queued:done sandbox:active clone:pending read:pending plan:pending write:pending done:pending');
    }
  });

  it('each stage moves only on its own evidence, and earlier stages are then done', () => {
    const at = new Date(T0.getTime() + 20_000);
    expect(statuses(deriveProgress(facts({ marks: { sandbox_ready: at } })))).toContain('sandbox:done clone:active');
    expect(statuses(deriveProgress(facts({ marks: { cloned: at } })))).toContain('clone:done read:active');
    expect(statuses(deriveProgress(facts({ activityCount: 1 })))).toContain('clone:done read:active plan:pending');
    expect(statuses(deriveProgress(facts({ agentOutputCount: 1 })))).toContain('read:done plan:active write:pending');
    expect(statuses(deriveProgress(facts({ agentOutputCount: 1, marks: { writing_result: at } })))).toContain('plan:done write:active done:pending');
    expect(deriveProgress(facts({ agentOutputCount: 1 })).outcome).toBe('running');
  });

  it('finished: every stage done, the end time on the last, elapsed measured to the run end', () => {
    const end = new Date(T0.getTime() + 540_000);
    const d = deriveProgress(facts({ previewState: 'finished', runStatus: 'succeeded', endedAt: end, now: new Date(T0.getTime() + 999_000) }));
    expect(d.outcome).toBe('finished');
    expect(d.elapsedSeconds).toBe(540);
    expect(d.stages.every((s) => s.status === 'done')).toBe(true);
    expect(d.stages.at(-1)?.at).toBe(end.toISOString());
    expect(d.slow).toBe(false);
  });

  it('slow only while live and past the threshold', () => {
    const late = new Date(T0.getTime() + (SLOW_AFTER_SECONDS + 1) * 1000);
    expect(deriveProgress(facts({ now: late })).slow).toBe(true);
    expect(deriveProgress(facts({ now: late, previewState: 'requested', startedAt: null, runStatus: null })).slow).toBe(true);
    expect(deriveProgress(facts({ now: new Date(T0.getTime() + SLOW_AFTER_SECONDS * 1000) })).slow).toBe(false);
    expect(deriveProgress(facts({ now: late, previewState: 'finished', runStatus: 'failed', endedAt: late })).slow).toBe(false);
  });

  it('failure screens: failed, cancelled, sandbox stopped, with the reached stage marked failed', () => {
    const end = new Date(T0.getTime() + 100_000);
    const ended = { previewState: 'finished' as const, endedAt: end, agentOutputCount: 1 };
    const failed = deriveProgress(facts({ ...ended, runStatus: 'failed', failureReason: 'model_key_broken' }));
    expect(failed).toMatchObject({ outcome: 'failed', reason: 'model_key_broken', slow: false });
    expect(statuses(failed)).toContain('plan:failed write:pending');
    expect(deriveProgress(facts({ ...ended, runStatus: 'timed_out' }))).toMatchObject({ outcome: 'failed', reason: 'timed_out' });
    expect(deriveProgress(facts({ ...ended, runStatus: 'cancelled' })).outcome).toBe('cancelled');
    for (const failureReason of ['runner_lost', 'sandbox_error', 'sandbox_stopped']) {
      expect(deriveProgress(facts({ ...ended, runStatus: 'failed', failureReason })).outcome).toBe('sandbox_stopped');
    }
  });

  it('agent never started: the RUN\'s recorded failure reason picks the screen and the stage stops at the sandbox; the slot is freed only once the row is void', () => {
    const end = new Date(T0.getTime() + 600_000);
    // The shape a real start timeout leaves: a preview linked to a failed run, the reason on the run's status event.
    const never = deriveProgress(facts({ previewState: 'finished', runStatus: 'failed', failureReason: 'agent_start_timeout', endedAt: end }));
    expect(never).toMatchObject({ outcome: 'agent_never_started', reason: 'agent_start_timeout', slotFreed: false, elapsedSeconds: 600 });
    expect(statuses(never)).toContain('queued:done sandbox:failed clone:pending');
    // The same run once migration 0705 has voided the preview with that reason: the same screen.
    expect(deriveProgress(facts({ previewState: 'void', voidReason: 'agent_start_timeout', runStatus: 'failed', failureReason: 'agent_start_timeout', endedAt: end }))).toMatchObject({ outcome: 'agent_never_started', slotFreed: true });
    // A void preview with no run is a plain void; the slot flag still comes from the row.
    expect(deriveProgress(facts({ previewState: 'void', voidReason: 'agent_start_timeout', startedAt: null, runStatus: null }))).toMatchObject({ outcome: 'void', slotFreed: true });
  });

  it('slot_freed is READ from the preview row (void plus a freeing reason), never worked out from the failure', () => {
    const end = new Date(T0.getTime() + 100_000);
    const row = (previewState: 'finished' | 'void', voidReason: string | null, failureReason: string | null, runStatus = 'failed') =>
      deriveProgress(facts({ previewState, voidReason, runStatus, failureReason, endedAt: end }));
    for (const r of ['agent_start_timeout', 'clone_failed']) {
      expect(row('void', r, r).slotFreed).toBe(true);
      // the same failure on a preview that was NOT voided (over the daily bound, a skipped write): still used up
      expect(row('finished', null, r).slotFreed).toBe(false);
    }
    // a void row is only "freed" for the freeing reasons
    for (const r of ['sandbox_error', 'clone_too_large', 'spend_refused', 'runner_lost']) expect(row('void', r, r).slotFreed).toBe(false);
    expect(row('finished', null, 'sandbox_error')).toMatchObject({ slotFreed: false, outcome: 'sandbox_stopped' });
    expect(row('finished', null, 'clone_too_large')).toMatchObject({ slotFreed: false, outcome: 'failed', reason: 'clone_too_large' });
    expect(row('finished', null, 'clone_failed')).toMatchObject({ outcome: 'failed', reason: 'clone_failed' });
    expect(deriveProgress(facts()).slotFreed).toBe(false); // still running
  });

  it('a void preview with no run is a plain void with no timer', () => {
    const plain = deriveProgress(facts({ previewState: 'void', voidReason: 'preview_unavailable', startedAt: null, runStatus: null }));
    expect(plain).toMatchObject({ outcome: 'void', reason: 'preview_unavailable', elapsedSeconds: null });
    expect(statuses(plain)).toContain('queued:failed');
  });

  it('a reason that is not a plain lower-case code is not passed on', () => {
    const d = deriveProgress(facts({ previewState: 'finished', endedAt: T0, runStatus: 'failed', failureReason: 'Boom <script>' }));
    expect(d.reason).toBe('failed');
  });
});
