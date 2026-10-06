/** Secret and private-infrastructure patterns. Plants for each live in test/gates.test.ts. */
export const SECRET_PATTERNS: readonly [kind: string, re: RegExp][] = [
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["aws_secret_key", /aws_secret_access_key["'\s:=]+[A-Za-z0-9/+=]{40}/gi],
  ["gcp_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["azure_storage_key", /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/g],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g],
  ["stripe_live_key", /\b[sr]k_live_[A-Za-z0-9]{8,}\b/g],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["api_key_sk", /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["jwt", /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  // RFC 1918, loopback, link-local and unspecified IPv4.
  [
    "private_ip",
    /\b(?:0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/g,
  ],
  // Unique-local (fc00::/7) and link-local (fe80::/10) IPv6.
  ["private_ip", /(?<![0-9A-Fa-f:])(?:f[cd][0-9A-Fa-f]{2}|fe80)(?::[0-9A-Fa-f]{0,4}){2,7}(?![0-9A-Fa-f:])/gi],
  // IPv6 loopback.
  ["private_ip", /(?<![0-9A-Fa-f:])::1(?![0-9A-Fa-f:])/g],
  ["private_hostname", /\b(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|lan|corp|intranet|home\.arpa))\b/gi],
];

export const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/** "img@2x.png" is an asset name, not an address. */
export const FILE_EXTENSION_TLDS: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "css", "js", "mjs", "json", "map", "woff", "woff2",
]);
