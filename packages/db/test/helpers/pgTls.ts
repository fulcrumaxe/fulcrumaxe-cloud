import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { Pool } from 'pg';
// Relative on purpose: the dependency-free certificate generator lives with the webhook tests (no openssl in the dev shell).
import { generateSelfSignedCert } from '../../../webhooks/test/helpers/selfSignedCert.js';

/**
 * Test helpers that put TLS in front of the local test Postgres the way the hosted one has it.
 *
 * Why this matters: the local cluster is plain TCP, and Neon is not. Neon ends the client's TLS at its
 * proxy, so (a) the client really negotiates and verifies TLS, and (b) the backend's own
 * `pg_stat_ssl` reports the internal hop, not the client's connection. A test against plain local
 * Postgres exercises neither. Two pieces here:
 *
 *   - `enableClusterTls`: switch TLS on in the test cluster itself, with a throwaway self-signed
 *     certificate. The client gets that certificate as its explicit CA (`ssl: { ca }`); nothing is
 *     trusted globally and `rejectUnauthorized` is never turned off.
 *   - `startTlsTerminatingProxy`: a TCP proxy in front of the cluster that answers Postgres'
 *     SSLRequest with 'S', does the TLS handshake itself, and forwards the decrypted bytes to the
 *     cluster over a plain connection. The client sees verified TLS; the backend sees none
 *     (`pg_stat_ssl.ssl = false`), exactly the Neon shape.
 *
 * What it cannot fake faithfully: Neon's SNI-based routing and endpoint IDs, its connection pooler
 * (pgbouncer) behaviour, and its certificate chain (a public CA there, a self-signed one here).
 */
export interface ClusterTls {
  /** The server certificate (also its own CA), to pass as `ssl: { ca }`. */
  ca: string;
  certFile: string;
  keyFile: string;
  /** Switches TLS back off and removes the files. */
  restore: () => Promise<void>;
}

export const TLS_NAMES = { dnsNames: ['localhost'], ipAddresses: ['127.0.0.1'] };

export async function enableClusterTls(admin: Pool): Promise<ClusterTls> {
  const dir = mkdtempSync(path.join(tmpdir(), 'fx-pg-tls-'));
  mkdirSync(dir, { recursive: true });
  const { certPem, keyPem } = generateSelfSignedCert('127.0.0.1', 1, TLS_NAMES);
  const certFile = path.join(dir, 'server.crt');
  const keyFile = path.join(dir, 'server.key');
  writeFileSync(certFile, certPem);
  writeFileSync(keyFile, keyPem);
  chmodSync(keyFile, 0o600);
  await admin.query(`ALTER SYSTEM SET ssl_cert_file = '${certFile}'`);
  await admin.query(`ALTER SYSTEM SET ssl_key_file = '${keyFile}'`);
  await admin.query('ALTER SYSTEM SET ssl = on');
  await admin.query('SELECT pg_reload_conf()');
  return {
    ca: certPem,
    certFile,
    keyFile,
    restore: async () => {
      for (const k of ['ssl', 'ssl_cert_file', 'ssl_key_file']) await admin.query(`ALTER SYSTEM RESET ${k}`);
      await admin.query('SELECT pg_reload_conf()');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TlsProxy {
  port: number;
  /** The certificate the proxy presents (also its own CA). */
  ca: string;
  /** How many client connections completed the TLS handshake. */
  readonly handshakes: number;
  close: () => Promise<void>;
}

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;

/** A TLS-terminating proxy for the Postgres wire protocol in front of a plain cluster at 127.0.0.1:`upstreamPort`. */
export async function startTlsTerminatingProxy(upstreamPort: number): Promise<TlsProxy> {
  const { certPem, keyPem } = generateSelfSignedCert('127.0.0.1', 1, TLS_NAMES);
  const secureContext = tls.createSecureContext({ cert: certPem, key: keyPem });
  const sockets = new Set<net.Socket>();
  let handshakes = 0;

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    // Before TLS the protocol is: the client sends an 8-byte SSLRequest and waits for one byte. 'N' to a
    // GSS-encryption request makes it fall back to SSLRequest.
    const onFirst = (chunk: Buffer): void => {
      if (chunk.length !== 8 || chunk.readInt32BE(0) !== 8) return void client.destroy();
      const code = chunk.readInt32BE(4);
      if (code === GSSENC_REQUEST) return void client.once('data', onFirst).write('N');
      if (code !== SSL_REQUEST) return void client.destroy(); // a client that skips TLS is refused: the hosted service has no plain path
      client.write('S');
      const secure = new tls.TLSSocket(client, { isServer: true, secureContext });
      sockets.add(secure);
      secure.on('close', () => sockets.delete(secure));
      secure.on('error', () => secure.destroy());
      secure.once('secure', () => {
        handshakes++;
      });
      const upstream = net.connect(upstreamPort, '127.0.0.1');
      sockets.add(upstream);
      upstream.on('close', () => {
        sockets.delete(upstream);
        secure.destroy();
      });
      upstream.on('error', () => secure.destroy());
      secure.on('close', () => upstream.destroy());
      secure.pipe(upstream);
      upstream.pipe(secure);
    };
    client.once('data', onFirst);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    ca: certPem,
    get handshakes() {
      return handshakes;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
