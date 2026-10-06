// apps/workspace/perf/dev-tls.mjs
//
// Generates a throwaway self-signed certificate and key at run time for
// perf/brotli-proxy.mjs --tls, so no private key is ever committed.
//
// Uses only node:crypto, which comes with the flake's Node. Node can read
// X.509 but cannot issue it, so the minimal DER a self-signed cert needs
// is built by hand; the key material comes from generateKeyPairSync. The
// `openssl` CLI is not in the dev shell, so it is not used. This is the
// same builder as packages/webhooks/test/helpers/selfSignedCert.ts, kept
// separate because this is plain .mjs that runs outside the TypeScript
// toolchain.

import crypto from "node:crypto";

function encodeLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function seq(...parts) {
  return tlv(0x30, Buffer.concat(parts));
}

function set(...parts) {
  return tlv(0x31, Buffer.concat(parts));
}

function asn1Integer(buf) {
  let b = buf;
  let i = 0;
  while (i < b.length - 1 && b[i] === 0x00) i++;
  b = b.subarray(i);
  if ((b[0] ?? 0) & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return tlv(0x02, b);
}

function smallInteger(n) {
  const bytes = [];
  let v = n;
  if (v === 0) bytes.push(0);
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return asn1Integer(Buffer.from(bytes));
}

function oid(dotted) {
  const parts = dotted.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
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

function utf8String(s) {
  return tlv(0x0c, Buffer.from(s, "utf8"));
}

function bitString(buf, unusedBits = 0) {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), buf]));
}

function octetString(buf) {
  return tlv(0x04, buf);
}

function explicit(tagNum, content) {
  return tlv(0xa0 | tagNum, content);
}

function utcTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return tlv(0x17, Buffer.from(text, "ascii"));
}

const SHA256_WITH_RSA_ENCRYPTION = oid("1.2.840.113549.1.1.11");
const COMMON_NAME_OID = oid("2.5.4.3");

function algorithmIdentifier() {
  return seq(SHA256_WITH_RSA_ENCRYPTION, tlv(0x05, Buffer.alloc(0)));
}

function distinguishedName(commonName) {
  return seq(set(seq(COMMON_NAME_OID, utf8String(commonName))));
}

/** subjectAltName with dNSName ([2]) and iPAddress ([7]) entries. */
function subjectAltNameExtension(dnsNames, ipAddresses) {
  const names = [
    ...dnsNames.map((n) => tlv(0x82, Buffer.from(n, "ascii"))),
    ...ipAddresses.map((ip) => tlv(0x87, Buffer.from(ip.split(".").map(Number)))),
  ];
  return seq(oid("2.5.29.17"), octetString(seq(...names)));
}

function derToPem(der, label) {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** Fresh self-signed cert/key for 127.0.0.1 and localhost, valid from
 * yesterday for `days` days (default 1). Written to a temp directory by
 * the caller, never into the repository. */
export function generateDevTlsCert(days = 1) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const commonName = "127.0.0.1";
  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const tbsCertificate = seq(
    explicit(0, smallInteger(2)),
    asn1Integer(crypto.randomBytes(8)),
    algorithmIdentifier(),
    distinguishedName(commonName),
    seq(utcTime(notBefore), utcTime(notAfter)),
    distinguishedName(commonName),
    publicKey,
    explicit(3, seq(subjectAltNameExtension(["localhost"], ["127.0.0.1"]))),
  );
  const signature = crypto.sign("sha256", tbsCertificate, crypto.createPrivateKey(privateKey));
  const certificate = seq(tbsCertificate, algorithmIdentifier(), bitString(signature, 0));
  return { certPem: derToPem(certificate, "CERTIFICATE"), keyPem: privateKey };
}
