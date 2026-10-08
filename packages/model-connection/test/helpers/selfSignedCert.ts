// A copy of the self-signed certificate generator in the webhooks test helpers, kept here because this package cannot
// depend on @fx/webhooks (webhooks already depends on this package). Dependency-free: Node's crypto plus hand-built DER.
// Generated fresh per call, in memory, never written to disk.
import crypto from 'node:crypto';

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
