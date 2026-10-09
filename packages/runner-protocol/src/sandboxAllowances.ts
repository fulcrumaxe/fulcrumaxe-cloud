/**
 * D#6 R7a (correction C35 section 3.4, amending C15 sections 3 and 4): the per-repo sandbox allowances a signed job may carry, and the
 * floor no allowance may cross. The cloud checks a set against this floor when an admin uploads it and again when it signs a job; the
 * runner checks the signed job against the same constant before any process starts (R7b). A compromised or mistaken cloud therefore
 * cannot widen a customer's sandbox past it, and there is one list, here, not three.
 *
 * The floor is an allowlist of shapes plus a denylist of places, and it fails closed: a value it cannot read as one of the shapes is
 * refused, never passed through. It knows nothing of the runner's home directory, so it refuses every path under a home directory
 * root (`/home`, `/Users`, `/root`) outright: the runner's own per-repo store and temp directories are applied by the runner, not
 * named by an entry.
 */
import { z } from "zod";

/** The kinds of entry, and the accesses each takes. Closed: a new kind is a protocol change. */
export const ALLOWANCE_ACCESS = Object.freeze({ path: ["read", "write"], domain: ["connect"], loopback: ["bind"] } as const);
export type AllowanceKind = keyof typeof ALLOWANCE_ACCESS;
export const ALLOWANCE_KINDS = Object.freeze(Object.keys(ALLOWANCE_ACCESS) as AllowanceKind[]);

export const MAX_ALLOWANCE_ENTRIES = 64;
export const MAX_ALLOWANCE_VALUE_CHARS = 512;
export const MAX_ALLOWANCE_REASON_CHARS = 500;
/** The longest a job's command may run, in seconds. The same bound sits in the database. */
export const MAX_COMMAND_TIMEOUT_S = 1800;

/** No control characters and no line breaks; the reason is for a person to read, never to act on. */
const REASON = new RegExp(`^[^\\u0000-\\u001f\\u007f]{1,${MAX_ALLOWANCE_REASON_CHARS}}$`);
/** Printable ASCII with no space. Whether a value is a path, a host or the loopback address is the floor's question. */
const VALUE = new RegExp(`^[\\x21-\\x7e]{1,${MAX_ALLOWANCE_VALUE_CHARS}}$`);

export const AllowanceEntrySchema = z
  .object({
    kind: z.enum(["path", "domain", "loopback"]),
    value: z.string().regex(VALUE),
    access: z.enum(["read", "write", "connect", "bind"]),
    reason: z.string().regex(REASON),
  })
  .strict();
export type AllowanceEntry = z.infer<typeof AllowanceEntrySchema>;

/** The set as it is uploaded, approved, stored and signed. A set with no entries has no timeout. */
export const AllowanceSetSchema = z
  .object({ entries: z.array(AllowanceEntrySchema).max(MAX_ALLOWANCE_ENTRIES), command_timeout_s: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_S).optional() })
  .strict();
export type AllowanceSet = z.infer<typeof AllowanceSetSchema>;

/** The job's key: present only when the approved set has entries, so it never has none. */
export const JobAllowancesSchema = z
  .object({ entries: z.array(AllowanceEntrySchema).min(1).max(MAX_ALLOWANCE_ENTRIES), command_timeout_s: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_S) })
  .strict();
export type JobAllowances = z.infer<typeof JobAllowancesSchema>;

export const ALLOWANCE_REFUSALS = [
  "invalid_shape", "access_not_allowed_for_kind", "duplicate_entry", "timeout_without_entries", "entries_without_timeout",
  "path_malformed", "path_home", "path_credential", "path_system", "path_socket", "path_write_outside_tmp", "path_bare_tmp",
  "domain_malformed", "domain_wildcard", "domain_address", "domain_private", "loopback_value",
] as const;
export type AllowanceRefusal = (typeof ALLOWANCE_REFUSALS)[number];

/** A path is segments of these characters. No `~`, `$`, glob or shell characters, no backslash, no `..`. */
const PATH = /^\/[A-Za-z0-9._+@=,:-]+(?:\/[A-Za-z0-9._+@=,:-]+)*$/;
/** Where a home directory lives, on Linux and macOS. Refused whole: the floor cannot see the runner's own home, so it refuses them all. */
const HOME_ROOTS = ["home", "users", "root", "var/home", "var/root", "var/roothome", "var/mnt", "volumes", "mnt", "media", "system/volumes/data"];
/** Credential directories and files, wherever they sit in a path. Compared lowercase, because the default macOS volume is case-insensitive. */
const CREDENTIAL_SEGMENTS = [".ssh", ".aws", ".kube", ".docker", ".gnupg", ".netrc", ".npmrc", ".claude", ".claude.json", ".fx-runner", ".git-credentials", ".pgpass", "keyrings", "keychains"];
const CREDENTIAL_SEQUENCES = [".config/gh", ".config/fx-runner", ".config/gcloud", ".local/share/keyrings", "library/keychains"];
/** System places no entry may name or sit under. `/nix/var` holds the Nix daemon socket; `/var/run` and `/run` hold the others. */
const SYSTEM_ROOTS = ["etc", "proc", "sys", "dev", "boot", "run", "private", "nix/var", "var/run", "var/lib/docker"];
const SOCKET_SUFFIX = /\.(?:sock|socket)$/;
const SOCKET_SEGMENTS = ["daemon-socket", "docker.sock", "containerd"];

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".localdomain", ".lan", ".home.arpa", ".corp", ".intranet", ".private"];

const startsWithPath = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);
/**
 * Whether granting `path` would reach `root`: it is the root, under it, or a strict ancestor of it (granting `nix` hands over the daemon socket
 * under `nix/var`, and `var` hands over `var/run`). The usr tree is an ancestor of none of the roots, so by this rule it stays grantable for reads;
 * writes still stop at /tmp.
 */
const touches = (path: string, root: string): boolean => startsWithPath(path, root) || startsWithPath(root, path);

function pathViolation(entry: AllowanceEntry): AllowanceRefusal | null {
  const value = entry.value;
  if (!PATH.test(value) || value.split("/").some((segment) => segment === "." || segment === "..")) return "path_malformed";
  const lower = value.slice(1).toLowerCase();
  const segments = lower.split("/");
  if (HOME_ROOTS.some((root) => touches(lower, root))) return "path_home";
  if (segments.some((segment) => CREDENTIAL_SEGMENTS.includes(segment)) || CREDENTIAL_SEQUENCES.some((sequence) => `/${lower}/`.includes(`/${sequence}/`))) return "path_credential";
  if (SOCKET_SUFFIX.test(lower) || segments.some((segment) => SOCKET_SEGMENTS.includes(segment))) return "path_socket";
  if (SYSTEM_ROOTS.some((root) => touches(lower, root))) return "path_system";
  // The whole of /tmp holds other processes' sockets and files: a read needs a subdirectory, as a write does.
  if (lower === "tmp") return "path_bare_tmp";
  // A write is for scratch space only; every other place a job reads from is a read.
  if (entry.access === "write" && !(segments[0] === "tmp" && segments.length > 1)) return "path_write_outside_tmp";
  return null;
}

function domainViolation(entry: AllowanceEntry): AllowanceRefusal | null {
  const value = entry.value;
  if (value.includes("*")) return "domain_wildcard";
  // An address of any kind: dotted digits, an IPv6 literal (colons or brackets), a bare number.
  if (/^[0-9.]+$/.test(value) || /[:[\]]/.test(value) || /^0x[0-9a-f.]+$/i.test(value)) return "domain_address";
  if (!HOST.test(value)) return "domain_malformed";
  if (PRIVATE_SUFFIXES.some((suffix) => value.endsWith(suffix))) return "domain_private";
  return null;
}

/**
 * Why one entry may never be granted, or null when it clears the floor. The kind-and-access pairing is part of it: `write` on a domain or
 * `connect` on a path is not a thing, and is refused rather than read as the nearest thing that is.
 */
export function allowanceFloorViolation(entry: AllowanceEntry): AllowanceRefusal | null {
  if (!(ALLOWANCE_ACCESS[entry.kind] as readonly string[]).includes(entry.access)) return "access_not_allowed_for_kind";
  if (entry.kind === "path") return pathViolation(entry);
  if (entry.kind === "domain") return domainViolation(entry);
  // A loopback entry lets the job bind 127.0.0.1 (a test database). It is never an egress target, and no other address is a loopback entry.
  return entry.value === "127.0.0.1" ? null : "loopback_value";
}

export type ParsedAllowanceSet = { ok: true; set: AllowanceSet } | { ok: false; code: AllowanceRefusal; index: number | null };

/**
 * Reads an uploaded or stored set: strict shape, then the floor on every entry, then no duplicates, no timeout without entries and a timeout
 * with them. The entries come back sorted by kind, value and access, so the same set always has the same hash. Anything it cannot read is a
 * refusal; it never repairs a value.
 */
export function parseAllowanceSet(input: unknown): ParsedAllowanceSet {
  const parsed = AllowanceSetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_shape", index: null };
  const { entries, command_timeout_s: timeout } = parsed.data;
  for (const [index, entry] of entries.entries()) {
    const code = allowanceFloorViolation(entry);
    if (code) return { ok: false, code, index };
  }
  const key = (entry: AllowanceEntry): string => `${entry.kind}\u0000${entry.value}\u0000${entry.access}`;
  const sorted = [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  // Reported at the uploaded position of the later copy, so the admin is pointed at the right entry.
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (seen.has(key(entry))) return { ok: false, code: "duplicate_entry", index };
    seen.add(key(entry));
  }
  if (sorted.length === 0 && timeout !== undefined) return { ok: false, code: "timeout_without_entries", index: null };
  if (sorted.length > 0 && timeout === undefined) return { ok: false, code: "entries_without_timeout", index: null };
  return { ok: true, set: { entries: sorted, ...(timeout === undefined ? {} : { command_timeout_s: timeout }) } };
}
