import https from 'node:https';
import type { HostLookup } from '@fx/net-guard';
import { generateSelfSignedCert } from './selfSignedCert.js';

/**
 * D#31 fix round 2 (MUST 1, MUST 2): a real local HTTPS receiver for
 * connector.test.ts, plus the `HostLookup` that points `deliver()` at it.
 * `connector.ts`'s `lookup`/test-only bypass exists specifically so a real
 * e2e test can reach a loopback receiver -- this is that receiver.
 */
export interface TlsReceiver {
  port: number;
  /** Pins `deliver()`'s DNS resolution to 127.0.0.1, this receiver's own
   * address, no matter what hostname the request URL uses. */
  lookup: HostLookup;
  requestCount: () => number;
  close: () => Promise<void>;
}

/** Starts an HTTPS server on an ephemeral 127.0.0.1 port running `handler`
 * for every request, resolving only once it is actually listening (so
 * `.port` is never read before it exists). Always torn down by the
 * caller's `close()` -- tests use `afterEach`/`finally` for this, never
 * rely on process exit. */
export function startTlsReceiver(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<TlsReceiver> {
  const { certPem, keyPem } = generateSelfSignedCert();
  let requestCount = 0;

  const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    requestCount += 1;
    handler(req, res);
  });

  return new Promise<TlsReceiver>((resolve, reject) => {
    server.once('error', reject);
    // Test-only receivers are never used from production code paths --
    // `connector.ts`'s NODE_ENV allowlist refuses the `lookup` bypass
    // unless NODE_ENV === 'test' (SHOULD 3), which vitest sets by default.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('startTlsReceiver: server is not listening on a TCP port'));
        return;
      }
      const lookup: HostLookup = async (_host, _options) => [{ address: '127.0.0.1', family: 4 }];
      resolve({
        port: addr.port,
        lookup,
        requestCount: () => requestCount,
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((err) => (err ? rej2(err) : res2()));
            // Force-destroy any sockets still open (e.g. a hostile
            // receiver's own long-lived connection, or the client side
            // after the client already gave up) so `close()`'s callback
            // fires promptly instead of waiting for a keep-alive socket
            // to time out on its own.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
