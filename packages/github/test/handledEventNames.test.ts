import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HANDLED_EVENT_NAMES } from '../src/eventMapper.js';
import { HANDLED_EVENT_NAMES as FROM_MODULE } from '../src/handledEventNames.js';

const modulePath = fileURLToPath(new URL('../src/handledEventNames.js', import.meta.url));

describe('handledEventNames.js', () => {
  it('loads under plain node with no workspace dependencies', () => {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(pathToFileURL(modulePath).href)}).then((m) => {
          process.stdout.write(JSON.stringify({ names: m.HANDLED_EVENT_NAMES, frozen: Object.isFrozen(m.HANDLED_EVENT_NAMES) }));
        })`,
      ],
      { cwd: '/', encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
    );
    const parsed = JSON.parse(out) as { names: string[]; frozen: boolean };
    expect(parsed.frozen).toBe(true);
    expect(parsed.names).toEqual([...HANDLED_EVENT_NAMES]);
  });

  it('is the same array eventMapper exports', () => {
    expect(HANDLED_EVENT_NAMES).toBe(FROM_MODULE);
  });
});
