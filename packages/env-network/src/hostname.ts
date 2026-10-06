import { domainToASCII } from "node:url";
import type { NetworkErrorCode } from "./errors.js";

export type HostnameResult = { readonly host: string } | { readonly code: NetworkErrorCode };

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV6_CHARS = /^\[?[0-9a-f:.]+\]?$/;
const CIDR = /^(\[?[0-9a-f:.]+\]?)\/\d{1,3}$/;
/** A dotted quad, a bare integer, hex or octal: every spelling of an IPv4 address ends in one of these. */
const NUMERIC_LABEL = /^(0x[0-9a-f]*|\d+)$/;

const SPECIAL_USE_SUFFIXES: readonly string[] = ["internal", "local", "localhost", "home.arpa"];

/**
 * Lower-cases, converts a non-ASCII name to its ASCII (punycode) form, drops ONE trailing dot, then decides
 * what the entry is. Every check runs on the normalised form, so a look-alike that normalises to a
 * wildcard, an address or a reserved host is refused as that. Only a plain DNS hostname comes back
 * as `{ host }`; the syntax is the one E1 accepts (letters, digits, `-`, `.`), so this refuses nothing
 * a parsed spec could legitimately carry.
 */
export function normalizeHostname(raw: unknown): HostnameResult {
  if (typeof raw !== "string") return { code: "not_a_hostname" };
  if (raw === "") return { code: "empty" };
  if (/[*＊]/.test(raw)) return { code: "wildcard" };
  const ascii = /^[\x00-\x7f]*$/.test(raw);
  let s = ascii ? raw.toLowerCase() : domainToASCII(raw).toLowerCase();
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s === "") return { code: ascii ? "empty" : "not_a_hostname" };
  if (s.includes("*")) return { code: "wildcard" };
  if (CIDR.test(s)) return { code: "address_range" };
  if (s.includes(":") && IPV6_CHARS.test(s)) return { code: "ip_address" };
  const labels = s.split(".");
  if (NUMERIC_LABEL.test(labels[labels.length - 1]!)) return { code: "ip_address" };
  if (s.length > 253 || !labels.every((l) => LABEL.test(l))) return { code: "not_a_hostname" };
  // Names that resolve inside the platform or the VM, never to a customer's service: a bare label (`localhost`,
  // `metadata`) is looked up through the resolver's search path, and these suffixes are special-use (RFC 6761/8375)
  // or the cloud metadata zone (`metadata.google.internal`).
  if (labels.length === 1 || SPECIAL_USE_SUFFIXES.some((x) => s === x || s.endsWith(`.${x}`))) return { code: "special_use_host" };
  return { host: s };
}
