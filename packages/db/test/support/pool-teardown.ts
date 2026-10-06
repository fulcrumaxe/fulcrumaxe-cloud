import type { Pool, PoolClient } from 'pg';

/**
 * Test-support: deterministic teardown for a `pg.Pool` whose Postgres
 * cluster is stopped by the same test file (`provisionEphemeralPostgres`'s
 * `cleanup()` runs `pg_ctl stop -m fast`).
 *
 * Why this exists (D#219 flake 1): `pool.end()` resolves once every client
 * has been told to terminate, NOT once its socket has closed. If the cluster
 * is stopped in that window, the server sends SQLSTATE 57P01 ("terminating
 * connection due to administrator command") to a socket the pool has already
 * detached its `error` listener from, and Node reports an uncaught exception
 * after every test has passed. Two parts:
 *
 *  1. `endAndWaitForSockets()` awaits every socket's `close` event, so the
 *     server has nothing left to terminate when the cluster stops.
 *  2. `beginTeardown()` flips the listener into "teardown window" mode, where
 *     ONLY SQLSTATE 57P01 is absorbed. Before it, any pool/client error is
 *     rethrown, so a 57P01 in the middle of a test still fails that test.
 *
 * Deliberately NOT a `process.on('uncaughtException')` handler: that would
 * hide unrelated failures.
 */

const ADMIN_SHUTDOWN = '57P01';

/** The bits of a `pg.Pool` this helper uses, so a unit test can pass an EventEmitter. */
export type TeardownPool = Pick<Pool, 'on' | 'end' | 'totalCount' | 'idleCount' | 'waitingCount'>;

export interface PoolTeardownGuard {
  /** Enter the teardown window: from now on only 57P01 is absorbed. */
  beginTeardown(): void;
  /** 57P01 errors absorbed during the teardown window. */
  readonly absorbed: readonly unknown[];
  /** Fails if any client is checked out (would be a production leak, not a teardown race). */
  assertNoCheckedOutClients(): void;
  /** `pool.end()`, then wait until every socket the pool ever opened has closed. */
  endAndWaitForSockets(timeoutMs?: number): Promise<void>;
}

function codeOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

type SocketLike = { destroyed: boolean; once(event: 'close', cb: () => void): unknown };

function socketOf(client: PoolClient): SocketLike | undefined {
  return (client as unknown as { connection?: { stream?: SocketLike } }).connection?.stream;
}

export function guardPoolTeardown(pool: TeardownPool, label = 'pool'): PoolTeardownGuard {
  let tearingDown = false;
  const absorbed: unknown[] = [];
  const sockets = new Set<SocketLike>();

  const handle = (err: unknown): void => {
    if (tearingDown && codeOf(err) === ADMIN_SHUTDOWN) {
      absorbed.push(err);
      return;
    }
    // Before teardown, or any other code: fail loudly (thrown from an event
    // listener this surfaces as an uncaught exception, which fails the run).
    throw err;
  };

  pool.on('error', (err) => handle(err));
  pool.on('connect', (client) => {
    const socket = socketOf(client);
    if (socket) sockets.add(socket);
    // pg-pool removes its own `error` listener from a client it has removed
    // (e.g. by `end()`), leaving a still-open socket with no listener at all.
    // Only the teardown window needs this one; before it the pool's listener
    // above already saw the error.
    client.on('error', (err) => {
      if (tearingDown) handle(err);
    });
  });

  return {
    beginTeardown() {
      tearingDown = true;
    },
    get absorbed() {
      return absorbed;
    },
    assertNoCheckedOutClients() {
      if (pool.totalCount !== pool.idleCount) {
        throw new Error(
          `${label}: ${pool.totalCount - pool.idleCount} client(s) still checked out at teardown ` +
            `(totalCount=${pool.totalCount}, idleCount=${pool.idleCount}, waitingCount=${pool.waitingCount})`,
        );
      }
    },
    async endAndWaitForSockets(timeoutMs = 5000) {
      tearingDown = true;
      await pool.end();
      const open = [...sockets].filter((s) => !s.destroyed);
      const closed = Promise.all(open.map((s) => new Promise<void>((resolve) => s.once('close', resolve))));
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: ${open.length} socket(s) did not close within ${timeoutMs}ms of pool.end()`)),
          timeoutMs,
        );
      });
      try {
        await Promise.race([closed, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
