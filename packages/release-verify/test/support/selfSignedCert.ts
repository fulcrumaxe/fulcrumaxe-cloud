import crypto from 'node:crypto';

/**
 * D#31 fix round 2 (MUST 2): a dependency-free self-signed X.509
 * certificate generator for connector.test.ts's live local HTTPS
 * receivers.
 *
 * Deliberately does NOT use the `selfsigned` npm package or shell out to
 * the `openssl` CLI: `openssl` is not on PATH in this repo's nix dev shell
 * (confirmed: `nix develop --command which openssl` exits 1, and
 * flake.nix never references it, so CI -- which runs
 * `nix develop --command bash scripts/check.sh` -- doesn't have it
 * either), and adding a new npm dependency for this would hit the same
 * `external_docs:` hard gate that blocked `selfsigned` in the #179 fix
 * round (it is not anchored with a URL in D#31's spec).
 *
 * Node's `node:crypto` has no "issue a certificate" API, only
 * `X509Certificate` for reading one -- so this hand-builds the minimal
 * DER/ASN.1 a self-signed cert needs (TBSCertificate + signature),
 * reusing Node's own `generateKeyPairSync` for the key material (its
 * `spki`/`der` public-key encoding IS a ready-made
 * `SubjectPublicKeyInfo`, and its `pkcs8`/`pem` private-key encoding is a
 * ready-made key PEM -- neither needs hand-rolling). No Subject
 * Alternative Name extension is included by default: the webhook receivers
 * connect with `rejectUnauthorized: false` (this is exactly what
 * `DeliverRequest.lookup` gates), so hostname/chain verification is never
 * exercised there. A caller that DOES verify (the strict GitHub and
 * Postgres TLS helpers) passes `alt` for a SAN and hands the certificate
 * to the client as its explicit `ca`.
 *
 * Generated fresh per call, in memory, never written to disk and never
 * committed -- there is no key to leak.
 */
export interface GeneratedCert {
  certPem: string;
  keyPem: string;
}

function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function seq(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

function asn1Integer(buf: Buffer): Buffer {
  let b = buf;
  let i = 0;
  while (i < b.length - 1 && b[i] === 0x00) i++;
  b = b.subarray(i);
  if ((b[0] ?? 0) & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return tlv(0x02, b);
}

function smallInteger(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  if (v === 0) bytes.push(0);
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return asn1Integer(Buffer.from(bytes));
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i]!;
    const chunk = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utf8String(s: string): Buffer {
  return tlv(0x0c, Buffer.from(s, 'utf8'));
}

function bitString(buf: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), buf]));
}

function nullValue(): Buffer {
  return tlv(0x05, Buffer.alloc(0));
}

function explicit(tagNum: number, content: Buffer): Buffer {
  return tlv(0xa0 | tagNum, content);
}

function utcTime(date: Date): Buffer {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const yy = pad(date.getUTCFullYear() % 100);
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return tlv(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
}

const SHA256_WITH_RSA_ENCRYPTION = oid('1.2.840.113549.1.1.11');
const COMMON_NAME_OID = oid('2.5.4.3');

function algorithmIdentifier(): Buffer {
  return seq(SHA256_WITH_RSA_ENCRYPTION, nullValue());
}

function distinguishedName(commonName: string): Buffer {
  return seq(set(seq(COMMON_NAME_OID, utf8String(commonName))));
}

function octetString(buf: Buffer): Buffer {
  return tlv(0x04, buf);
}

/** subjectAltName with dNSName ([2]) and iPAddress ([7]) entries, as one X.509 extension. */
function subjectAltNameExtension(dnsNames: readonly string[], ipAddresses: readonly string[]): Buffer {
  const names = [
    ...dnsNames.map((n) => tlv(0x82, Buffer.from(n, 'ascii'))),
    ...ipAddresses.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))),
  ];
  return seq(oid('2.5.29.17'), octetString(seq(...names)));
}

function derToPem(der: Buffer, label: string): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** A fresh self-signed cert/key pair valid from yesterday for `days` days
 * (default 1 day -- these are single-test-run receivers, not long-lived
 * fixtures). `commonName` only affects the cert's Subject/Issuer field;
 * since every caller connects with `rejectUnauthorized: false`, nothing
 * here checks it against the hostname actually connected to. */
export function generateSelfSignedCert(
  commonName = '127.0.0.1',
  days = 1,
  /** Subject Alternative Names (IPv4 only for `ipAddresses`). Give them when the client verifies the certificate (the cert is then passed as `ca`). */
  alt: { dnsNames?: readonly string[]; ipAddresses?: readonly string[] } = {},
): GeneratedCert {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const tbsCertificate = seq(
    explicit(0, smallInteger(2)), // version: v3
    asn1Integer(crypto.randomBytes(8)), // serialNumber
    algorithmIdentifier(), // signature algorithm (in the TBS, per RFC 5280)
    distinguishedName(commonName), // issuer
    seq(utcTime(notBefore), utcTime(notAfter)), // validity
    distinguishedName(commonName), // subject (self-signed: same as issuer)
    publicKey, // subjectPublicKeyInfo -- already a complete DER SPKI
    ...(alt.dnsNames?.length || alt.ipAddresses?.length
      ? [explicit(3, seq(subjectAltNameExtension(alt.dnsNames ?? [], alt.ipAddresses ?? [])))] // extensions
      : []),
  );

  const signature = crypto.sign('sha256', tbsCertificate, crypto.createPrivateKey(privateKey));
  const certificate = seq(tbsCertificate, algorithmIdentifier(), bitString(signature, 0));

  return { certPem: derToPem(certificate, 'CERTIFICATE'), keyPem: privateKey };
}
