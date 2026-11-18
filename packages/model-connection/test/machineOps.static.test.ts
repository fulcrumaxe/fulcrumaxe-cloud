import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envKekSource, machineKekSource } from '../src/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'test', 'tests', 'e2e', '__tests__', 'migrations', 'neon-shape.d']);

/** Every code file (not a test, a migration or a build output) under packages/ and apps/. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) sourceFiles(path.join(dir, e.name), out);
    } else if (/\.(ts|tsx|mts|js|mjs|cjs|sh)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(path.relative(ROOT, path.join(dir, e.name)));
  }
  return out;
}
const FILES = [...sourceFiles(path.join(ROOT, 'packages')), ...sourceFiles(path.join(ROOT, 'apps'))];
const filesMatching = (re: RegExp): string[] => FILES.filter((f) => re.test(readFileSync(path.join(ROOT, f), 'utf8'))).sort();

const MACHINE_OPS = 'packages/model-connection/src/machineOps.ts';

/** D#845 S-1 / MC-2: only the machine_ops code path reads the machine key, opens a sealed token, or writes `server.unsealed`. */
describe('machine_ops is the only code path that touches the machine key and the sealed token', () => {
  it('reads FX_MACHINE_KEK_V1 in machineOps.ts alone (the environment manifest names it and reads nothing)', () => {
    expect(filesMatching(/FX_MACHINE_KEK/)).toEqual([MACHINE_OPS, 'apps/web/env-manifest.ts'].sort());
  });

  it('calls machine_credential_use and writes server.unsealed in machineOps.ts alone', () => {
    expect(filesMatching(/machine_credential_use/)).toEqual([MACHINE_OPS]);
    expect(filesMatching(/server\.unsealed/)).toEqual([MACHINE_OPS]);
  });

  it('is imported only by the package index and the credential route (the route is the one caller)', () => {
    const users = filesMatching(/machineOps|machineKekSource|withHetznerToken|withManagedServer|connectHetznerCredential|removeHetznerCredential/);
    expect(users).toEqual([MACHINE_OPS, 'packages/api-client/src/generated.ts', 'packages/api/src/routes/machine-credential.ts', 'packages/model-connection/src/index.ts'].sort());
  });

  it('the guard can fail: the scan finds the three words in machineOps.ts, so an empty result is not a broken scan', () => {
    const text = readFileSync(path.join(ROOT, MACHINE_OPS), 'utf8');
    for (const word of ['FX_MACHINE_KEK_V1', 'machine_credential_use', 'server.unsealed']) expect(text).toContain(word);
  });
});

describe('the machine key is its own key', () => {
  const machine = Buffer.alloc(32, 9).toString('base64');
  const model = Buffer.alloc(32, 3).toString('base64');

  it('never falls back to the model-connection key, and the model key source never sees the machine key', () => {
    expect(() => machineKekSource({ FX_KEK_V1: model }).keyFor(1)).toThrowError(expect.objectContaining({ code: 'machine_kek_unset' }));
    expect(() => envKekSource({ FX_MACHINE_KEK_V1: machine }).keyFor(1)).toThrow(/FX_KEK_V1 is not set/);
    expect(machineKekSource({ FX_MACHINE_KEK_V1: machine, FX_KEK_V1: model }).keyFor(1)).toEqual(Buffer.alloc(32, 9));
  });

  it('refuses a missing, short, long, non-base64 or padded-wrong key and any version but 1', () => {
    for (const bad of [undefined, '', 'short', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), `${machine}!`, machine.slice(0, -1)]) {
      expect(() => machineKekSource({ FX_MACHINE_KEK_V1: bad }).keyFor(1), String(bad)).toThrowError(expect.objectContaining({ code: 'machine_kek_unset' }));
    }
    expect(() => machineKekSource({ FX_MACHINE_KEK_V1: machine }).keyFor(2)).toThrowError(expect.objectContaining({ code: 'machine_kek_unset' }));
  });
});
