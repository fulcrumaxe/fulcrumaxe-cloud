import { createServer, type Server } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { generateSelfSignedCert } from './selfSignedCert.js';
import type { HostLookup } from '@fx/net-guard';

/**
 * D#31 API-4b "VERIFY ON REAL INPUT": a real local HTTPS receiver for the
 * dispatcher/e2e tests to send actual signed deliveries to over a real
 * TCP+TLS connection -- criterion 11's "a TLS receiver on 127.0.0.1
 * reached through a test-only resolver override." Not a mock of
 * `connector.ts` or `sign.ts` -- both run unmodified against this.
 *
 * Bound to 127.0.0.1 on an ephemeral port. Its own certificate is
 * self-signed and unrelated to any real CA -- `connector.ts` only skips
 * certificate verification (`rejectUnauthorized: false`) when its own
 * `lookup` override is present, i.e. exactly the test-only path this
 * receiver exists for; the real (production) path always verifies.
 */
export interface ReceivedRequest {
  headers: IncomingHttpHeaders;
  body: string;
}

export interface TestReceiver {
  /** An https:// URL with a hostname that is NOT actually resolvable --
   * `lookup` is what makes delivery reach 127.0.0.1 anyway. */
  url: string;
  /** Pass as `DispatcherOpts.lookup` / `DeliverRequest.lookup`. */
  lookup: HostLookup;
  requests: ReceivedRequest[];
  /** Status code the receiver responds with to every request from now on (default 200). */
  setResponseStatus(status: number): void;
  /** Milliseconds to wait before responding (default 0) -- for the timeout criterion. */
  setDelayMs(ms: number): void;
  close(): Promise<void>;
}

export async function startTestReceiver(): Promise<TestReceiver> {
  const { certPem, keyPem } = generateSelfSignedCert('receiver.test', 1);

  const requests: ReceivedRequest[] = [];
  let responseStatus = 200;
  let delayMs = 0;

  const server: Server = createServer({ key: keyPem, cert: certPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ headers: req.headers, body });
      const respond = (): void => {
        res.writeHead(responseStatus);
        res.end();
      };
      if (delayMs > 0) {
        setTimeout(respond, delayMs);
      } else {
        respond();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('startTestReceiver: server did not bind to a TCP port');
  }
  const port = address.port;

  const lookup: HostLookup = async () => [{ address: '127.0.0.1', family: 4 }];

  return {
    url: `https://receiver.test:${port}/hook`,
    lookup,
    requests,
    setResponseStatus(status: number) {
      responseStatus = status;
    },
    setDelayMs(ms: number) {
      delayMs = ms;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
