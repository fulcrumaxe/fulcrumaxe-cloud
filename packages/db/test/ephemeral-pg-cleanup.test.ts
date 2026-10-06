import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provisionEphemeralPostgres, reapStaleEphemeralPostgres } from './support/ephemeral-pg.js';

/** D#68: a killed harness must not leave a postmaster behind. */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const childScript = path.join(testDir, 'support', 'leak-child.ts');
const repoRoot = path.resolve(testDir, '..', '..', '..');

function clusterDirs(root: string = tmpdir()): string[] {
  return readdirSync(root)
    .filter((n) => n.startsWith('fx-leakchild-pg-'))
    .map((n) => path.join(root, n));
}

/** Every child gets its own TMPDIR, so other agents' clusters in the shared tmp never enter the count. */
const childRoots: string[] = [];

/** True while the cluster's postmaster pid (first line of postmaster.pid) is a live process. */
function postmasterAlive(dir: string): boolean {
  const pidFile = path.join(dir, 'data', 'postmaster.pid');
  if (!existsSync(pidFile)) return false;
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8').split('\n')[0]), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Postgres refuses a unix socket path over 107 bytes, and the cluster dir is
 * <root>/fx-leakchild-pg-XXXXXX/.s.PGSQL.<port>, so a deeply nested TMPDIR
 * (a nested nix-shell, a CI scratch dir) made the child die before READY.
 * Keep the child's root short: use tmpdir() when it leaves room, else /tmp.
 */
function shortTmpBase(): string {
  const base = tmpdir();
  return base.length <= 40 || !existsSync('/tmp') ? base : '/tmp';
}

async function startChild(
  instances = 1,
): Promise<{ child: ChildProcess; dir: string; dirs: string[]; root: string; exited: Promise<string | null> }> {
  const root = mkdtempSync(path.join(shortTmpBase(), 'lr-'));
  childRoots.push(root);
  const child = spawn('node', [childScript], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, LEAK_INSTANCES: String(instances), TMPDIR: root },
  });
  const exited = new Promise<string | null>((resolve) => child.once('exit', (_c, sig) => resolve(sig)));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => d.toString().includes('READY') && resolve());
    child.once('exit', () => reject(new Error('child exited before READY')));
  });
  const dirs = clusterDirs(root);
  if (dirs.length !== instances) throw new Error(`expected ${instances} cluster dir(s), found ${dirs.length}`);
  return { child, dir: dirs[0]!, dirs, root, exited };
}

async function waitGone(dir: string): Promise<void> {
  for (let i = 0; i < 100 && (existsSync(dir) || postmasterAlive(dir)); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) c.kill('SIGKILL');
  reapStaleEphemeralPostgres([tmpdir(), ...childRoots]);
  for (const r of childRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('ephemeral-pg cleanup', () => {
  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
    '%s mid-run stops the postmaster and removes the dir',
    async (sig) => {
      const { child, dir, exited } = await startChild();
      spawned.push(child);
      expect(postmasterAlive(dir)).toBe(true);
      child.kill(sig);
      expect(await exited).toBe(sig); // the signal was re-raised, not swallowed
      await waitGone(dir);
      expect(postmasterAlive(dir)).toBe(false);
      expect(existsSync(dir)).toBe(false);
    },
    60_000,
  );

  it('one SIGTERM stops the clusters of two evaluations of the module', async () => {
    const { child, dirs, exited } = await startChild(2);
    spawned.push(child);
    expect(dirs.every(postmasterAlive)).toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
    for (const d of dirs) await waitGone(d);
    expect(dirs.filter((d) => postmasterAlive(d) || existsSync(d))).toEqual([]);
  }, 60_000);

  it('startup reaper stops a cluster whose owner was SIGKILLed', async () => {
    const { child, dir, root, exited } = await startChild();
    spawned.push(child);
    child.kill('SIGKILL');
    await exited;
    expect(postmasterAlive(dir)).toBe(true); // uncatchable kill: nothing cleaned up
    expect(reapStaleEphemeralPostgres([root])).toContain(dir);
    await waitGone(dir);
    expect(postmasterAlive(dir)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  }, 60_000);

  describe('reaper safety (private root)', () => {
    let root: string;
    const bystanders: ChildProcess[] = [];
    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), 'privroot-'));
    });
    afterEach(() => {
      for (const b of bystanders.splice(0)) b.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    });
    const deadPid = '2147483000';
    function fakeCluster(name: string, ownerPid: string | null, postmasterPid?: number): string {
      const dir = path.join(root, name);
      mkdirSync(path.join(dir, 'data'), { recursive: true });
      if (ownerPid !== null) writeFileSync(path.join(dir, 'owner.pid'), ownerPid);
      if (postmasterPid) writeFileSync(path.join(dir, 'data', 'postmaster.pid'), `${postmasterPid}\n`);
      return dir;
    }

    it('does not signal a live non-postgres process named by a forged postmaster.pid', () => {
      const bystander = spawn('sleep', ['300'], { stdio: 'ignore' });
      bystanders.push(bystander);
      const dir = fakeCluster('fx-forged-pg-1', deadPid, bystander.pid);
      expect(reapStaleEphemeralPostgres([root])).toEqual([]);
      expect(existsSync(dir)).toBe(true);
      expect(bystander.killed || bystander.exitCode !== null).toBe(false);
      process.kill(bystander.pid!, 0); // still alive
    });

    it('skips a symlinked fx-*-pg-* dir', () => {
      const target = fakeCluster('real-target', deadPid);
      symlinkSync(target, path.join(root, 'fx-link-pg-1'));
      expect(reapStaleEphemeralPostgres([root])).toEqual([]);
      expect(existsSync(target)).toBe(true);
    });

    it.each(['', 'not-a-pid', '12abc', '-5'])('skips a dir whose owner.pid is %j', (content) => {
      const dir = fakeCluster('fx-garbage-pg-1', content);
      expect(reapStaleEphemeralPostgres([root])).toEqual([]);
      expect(existsSync(dir)).toBe(true);
    });
  });

  describe('script (--root private dir, dry run)', () => {
    const run = (root: string): string =>
      execFileSync('bash', [path.join(repoRoot, 'scripts', 'reap-orphan-test-pg.sh'), '--root', root], {
        encoding: 'utf8',
      });
    it('lists nothing outside --root', () => {
      const inside = mkdtempSync(path.join(tmpdir(), 'privroot-'));
      const outside = mkdtempSync(path.join(tmpdir(), 'privroot-'));
      try {
        for (const r of [inside, outside]) {
          mkdirSync(path.join(r, 'fx-scope-pg-1', 'data'), { recursive: true });
          writeFileSync(path.join(r, 'fx-scope-pg-1', 'owner.pid'), '2147483000');
        }
        const out = run(inside);
        expect(out).toContain(path.join(inside, 'fx-scope-pg-1'));
        expect(out).not.toContain(outside);
      } finally {
        rmSync(inside, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
    it.each([
      ['1 2', false],
      ['0', false],
      ['  0\n', false],
      ['2147483000\n', true], // control: a dead pid with surrounding whitespace is still reaped
    ])('owner.pid %j -> reaped=%s', (content, reaped) => {
      const root = mkdtempSync(path.join(tmpdir(), 'privroot-'));
      try {
        mkdirSync(path.join(root, 'fx-parse-pg-1', 'data'), { recursive: true });
        writeFileSync(path.join(root, 'fx-parse-pg-1', 'owner.pid'), content);
        expect(run(root).includes('would reap')).toBe(reaped);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('script keeps an ownerless cluster younger than 6 h', async () => {
    const pg = await provisionEphemeralPostgres({ database: 'fx_ownerless', tmpPrefix: 'fx-leakchild-pg-' });
    try {
      const dir = clusterDirs().find((d) => readFileSync(path.join(d, 'owner.pid'), 'utf8') === String(process.pid))!;
      rmSync(path.join(dir, 'owner.pid'));
      const out = execFileSync(
        'bash',
        [path.join(repoRoot, 'scripts', 'reap-orphan-test-pg.sh'), '--root', path.dirname(dir)],
        { encoding: 'utf8' },
      );
      expect(out).not.toContain(dir);
      expect(postmasterAlive(dir)).toBe(true);
    } finally {
      pg.cleanup();
    }
  }, 60_000);

  it('startup reaper leaves a cluster with a live owner alone', async () => {
    const pg = await provisionEphemeralPostgres({ database: 'fx_live_owner', tmpPrefix: 'fx-leakchild-pg-' });
    try {
      const dir = clusterDirs().find(
        (d) => existsSync(path.join(d, 'owner.pid')) && readFileSync(path.join(d, 'owner.pid'), 'utf8') === String(process.pid),
      )!;
      expect(postmasterAlive(dir)).toBe(true);
      expect(reapStaleEphemeralPostgres()).not.toContain(dir);
      expect(postmasterAlive(dir)).toBe(true);
    } finally {
      pg.cleanup();
    }
  }, 60_000);
});
