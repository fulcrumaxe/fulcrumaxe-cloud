import {
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * D#56: the ONE shared throwaway-Postgres provisioner, replacing the four
 * near-identical copies that used to live in packages/{db,core,spend,
 * model-connection}/test/globalSetup.ts. This module has no opinion about
 * `process.env` -- see globalSetup.ts's own header for why: with
 * `vitest.workspace.ts` running every project's globalSetup in one
 * orchestrator process, `process.env` is that process's single shared
 * object, and two projects' globalSetups writing the same variable name
 * raced each other for which project's TEST WORKERS ended up reading which
 * project's database (D#56's root cause). Each globalSetup instead
 * `provide()`s this helper's URLs through vitest's per-project context; see
 * bind-test-env.ts for the worker-side half of that.
 */
export interface EphemeralPostgres {
  url: string;
  appUserUrl: string;
  platformOpsUrl: string;
  partnerUserUrl: string;
  port: number;
  database: string;
  cleanup: () => void;
}

/**
 * The value each globalSetup hands to `provide('testDbEnv', ...)`, and the
 * one every project's bind-test-env.ts setupFile reads back with
 * `inject('testDbEnv')` to populate `process.env` inside its OWN worker
 * fork only (see bind-test-env.ts). `prefix` is '' for the bare
 * `DATABASE_URL*` names (db, core) and 'SPEND_' for packages/spend, which
 * has always deliberately used prefixed names to avoid exactly this kind
 * of collision (see packages/spend/test/globalSetup.ts's header) --
 * `bind-test-env.ts` is name-agnostic and just binds `${prefix}DATABASE_URL`
 * etc, so one file serves every project without needing to know which one
 * it's running in.
 */
export interface TestDbEnv {
  prefix: string;
  url: string;
  appUserUrl: string;
  platformOpsUrl: string;
  partnerUserUrl?: string;
  /** D#2 H09c: a LOGIN that is a member of both app_user and
   * agent_run_writer (see run-writer-login.ts). Optional -- only the
   * packages whose code under test writes `agent_runs` set it. */
  runWriterUrl?: string;
}

declare module 'vitest' {
  interface ProvidedContext {
    testDbEnv: TestDbEnv;
  }
}

/**
 * Asks the OS for a free TCP port on 127.0.0.1 by binding to port 0,
 * reading back the port the kernel picked, then releasing it -- no
 * `Math.random()` guesswork, and no fixed range to collide with another
 * project's cluster. There's a small window between this socket closing
 * and Postgres binding the same port (see `startWithRetry` below), which
 * is why this is a building block for a retry loop, not the whole guard
 * against collision by itself.
 */
async function getFreePort(): Promise<number> {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    srv.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

function readLogTail(logFile: string): string {
  try {
    const lines = readFileSync(logFile, 'utf8').split('\n');
    return lines.slice(-40).join('\n');
  } catch {
    return '(no postgres log was written)';
  }
}

const MAX_START_ATTEMPTS = 5;

/** Names the owner (harness) pid inside each cluster's scratch dir. */
export const OWNER_PIDFILE = 'owner.pid';
const CLUSTER_DIR = /^fx-[a-z0-9-]+-pg-/;

/**
 * 'none': no live postmaster recorded for this dir. 'ours': the pid in
 * data/postmaster.pid is a postgres of ours started with `-D <dir>/data`.
 * 'foreign': a live process that is NOT that -- a forged or recycled pid;
 * nothing may be signalled or removed on its account.
 */
function postmasterState(tmpDir: string): 'none' | 'ours' | 'foreign' {
  let pid: number;
  try {
    const first = readFileSync(path.join(tmpDir, 'data', 'postmaster.pid'), 'utf8').split('\n')[0]!.trim();
    if (!/^\d+$/.test(first)) return 'none';
    pid = Number(first);
  } catch {
    return 'none';
  }
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    const dataDirs = [path.join(tmpDir, 'data'), path.join(realpathSync(tmpDir), 'data')];
    const exe = path.basename(args[0] ?? '');
    const dIdx = args.indexOf('-D');
    const matches = (exe === 'postgres' || exe === 'postmaster') && dIdx >= 0 && dataDirs.includes(args[dIdx + 1] ?? '');
    return matches && statSync(`/proc/${pid}`).uid === process.getuid!() ? 'ours' : 'foreign';
  } catch {
    return 'none'; // no such process
  }
}

function stopCluster(tmpDir: string): void {
  if (postmasterState(tmpDir) !== 'ours') return;
  try {
    execFileSync('pg_ctl', ['-D', path.join(tmpDir, 'data'), '-m', 'fast', 'stop'], { stdio: 'ignore' });
  } catch {
    // best-effort: already down.
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Stops and removes every `fx-*-pg-*` scratch dir under `roots` whose
 * recorded owner pid is gone -- the leftovers of a harness that was killed
 * (SIGKILL / OOM) before any handler could run. Never touched: a dir whose
 * owner is alive (parallel packages and agents share the same tmpdir), a
 * symlink or a dir not owned by us, a missing or non-numeric pidfile, a
 * name outside the prefix, or a dir whose postmaster.pid names a live
 * process that is not this dir's postgres. Returns the dirs it reaped.
 */
export function reapStaleEphemeralPostgres(roots: string[] = [tmpdir()]): string[] {
  const reaped: string[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => CLUSTER_DIR.test(n))) {
      const dir = path.join(root, name);
      let owner: number;
      try {
        const st = lstatSync(dir);
        if (!st.isDirectory() || st.uid !== process.getuid!()) continue; // lstat: a symlink is not a directory
        const text = readFileSync(path.join(dir, OWNER_PIDFILE), 'utf8').trim();
        if (!/^\d+$/.test(text)) continue;
        owner = Number(text);
      } catch {
        continue;
      }
      if (owner <= 0 || pidAlive(owner) || postmasterState(dir) === 'foreign') continue;
      stopCluster(dir);
      rmSync(dir, { recursive: true, force: true });
      reaped.push(dir);
    }
  }
  return reaped;
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
// Both the registry and the "hooks installed" flag live in one Symbol.for-keyed global, so
// a second evaluation of this module in the same process shares them: ONE set of handlers
// stops the clusters of every instance.
const STATE_KEY = Symbol.for('fx.ephemeralPg.state');
interface HarnessState {
  liveClusters: Set<() => void>;
  hooksInstalled: boolean;
}
const state = ((globalThis as Record<symbol, unknown>)[STATE_KEY] ??= {
  liveClusters: new Set<() => void>(),
  hooksInstalled: false,
}) as HarnessState;
const liveClusters = state.liveClusters;

function cleanupAll(): void {
  for (const cleanup of [...liveClusters]) cleanup();
}

/** Stops every live cluster on exit and on SIGINT/SIGTERM/SIGHUP, then lets the signal take effect. */
function installCleanupHooks(): void {
  if (state.hooksInstalled) return;
  state.hooksInstalled = true;
  process.on('exit', cleanupAll);
  for (const sig of SIGNALS) {
    const handler = (): void => {
      cleanupAll();
      process.removeListener(sig, handler);
      // If another listener still owns this signal it already ran; otherwise
      // re-raise so the default action (termination) is not swallowed.
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    process.on(sig, handler);
  }
}

/**
 * Picks a free port and starts Postgres on it, retrying with a fresh port
 * if `pg_ctl start` fails -- the free-port check and Postgres actually
 * binding it aren't atomic, so something else can grab the same port in
 * between. `initdb` only runs once by the caller; this only redoes the
 * port pick and the `start`.
 */
async function startWithRetry(dataDir: string, logFile: string): Promise<number> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    const port = await getFreePort();
    appendFileSync(path.join(dataDir, 'postgresql.conf'), `port = ${port}\n`);

    try {
      execFileSync('pg_ctl', ['-D', dataDir, '-l', logFile, '-w', 'start'], { stdio: 'ignore' });
      return port;
    } catch (err) {
      lastError = err;
      try {
        execFileSync('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { stdio: 'ignore' });
      } catch {
        // best-effort: nothing may have actually started.
      }
    }
  }

  throw new Error(
    `ephemeral-pg: pg_ctl start failed after ${MAX_START_ATTEMPTS} attempts.\n` +
      `--- postgres log tail (${logFile}) ---\n${readLogTail(logFile)}\n` +
      `last error: ${String(lastError)}`,
  );
}

/**
 * Provisions a throwaway Postgres cluster: `initdb`, a free port from the
 * OS (with retry -- see `startWithRetry`), then `createdb`. Same steps
 * every one of the four copies this replaces used to take. `tmpPrefix`
 * keeps each project's scratch directory identifiable in `mkdtemp`'s
 * listing (e.g. `fx-db-pg-`); `database` is the database name to create
 * (e.g. `fx_db_test`).
 */
export async function provisionEphemeralPostgres(options: {
  database: string;
  tmpPrefix: string;
}): Promise<EphemeralPostgres> {
  const { database, tmpPrefix } = options;
  reapStaleEphemeralPostgres();
  const tmpDir = mkdtempSync(path.join(tmpdir(), tmpPrefix));
  writeFileSync(path.join(tmpDir, OWNER_PIDFILE), String(process.pid));
  const dataDir = path.join(tmpDir, 'data');
  const logFile = path.join(tmpDir, 'postgres.log');

  // --encoding=UTF8: `--no-locale` alone yields SQL_ASCII, where char_length()
  // counts bytes and multi-byte names would fail a code-point CHECK that a
  // UTF8 production database (Neon) accepts (D#31 API-3g api_tokens.name).
  execFileSync('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8'], {
    stdio: 'ignore',
  });

  appendFileSync(
    path.join(dataDir, 'postgresql.conf'),
    // TCP on loopback only, no Unix socket: the runner's sandbox refuses socket(AF_UNIX), so a
    // socket directory would stop the cluster from starting inside a job. The port is an
    // OS-assigned free one (see startWithRetry), trust auth is reachable on 127.0.0.1 only, and
    // this is for tests only -- production Postgres is unchanged.
    `listen_addresses = '127.0.0.1'\nunix_socket_directories = ''\n` +
      // D#181: this cluster is thrown away at the end of the run, so nothing
      // in it needs to survive a crash. With the default fsync=on, every
      // DROP DATABASE's forced checkpoint fsyncs every dirty buffer the
      // fully-migrated throwaway databases left behind -- measured at 7-13 s
      // of checkpoint sync time on a busy host, enough to blow the 20 s hook
      // timeout in migrate-0606-upgrade.test.ts.
      `fsync = off\nsynchronous_commit = off\nfull_page_writes = off\n`,
  );

  const cleanup = (): void => {
    liveClusters.delete(cleanup);
    stopCluster(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
  };
  liveClusters.add(cleanup);
  installCleanupHooks();

  const port = await startWithRetry(dataDir, logFile);

  execFileSync(
    'createdb',
    ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', database],
    { stdio: 'ignore' },
  );

  return {
    url: `postgres://postgres@127.0.0.1:${port}/${database}`,
    appUserUrl: `postgres://app_user@127.0.0.1:${port}/${database}`,
    platformOpsUrl: `postgres://platform_ops@127.0.0.1:${port}/${database}`,
    partnerUserUrl: `postgres://partner_user@127.0.0.1:${port}/${database}`,
    port,
    database,
    cleanup,
  };
}
