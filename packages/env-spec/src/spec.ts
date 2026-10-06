import { createHash } from "node:crypto";
import { EnvSpecError } from "./errors.js";

export type Argv = readonly string[];
export type SecretKind = "brokered_http" | "in_sandbox";
/** A secret is its NAME (and how it is delivered) only -- never a value or a handle. */
export interface EnvSecret { readonly name: string; readonly kind: SecretKind }
/** A customer Nix binary cache: https URL (host listed in network.domains) plus the key its paths are signed with. */
export interface NixSubstituter { readonly url: string; readonly publicKey: string }
/** The Nix devShell to realise in the builder (D#5 C3 section 1). Every field is always present in canonical form. */
export interface NixSpec {
  readonly flake: string;
  readonly shell: string;
  /** Extra repo files whose content defines the shell (hashed into inputsDigest). */
  readonly inputs: readonly string[];
  readonly substituters: readonly NixSubstituter[];
}
export interface EnvSpec {
  readonly version: 1;
  /** 1-3 preset ids, sorted and de-duplicated in canonical form. */
  readonly preset?: readonly string[];
  readonly dockerfile?: string;
  /** A base image named by its sha256 digest alone, never a repository or tag (C3 section 4.4). */
  readonly image?: string;
  readonly nix?: NixSpec;
  /** Snapshot-eligible phase: ordered argv arrays, never shell strings. */
  readonly setup: readonly Argv[];
  /** Per-run phase: ordered argv arrays. */
  readonly run: readonly Argv[];
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: readonly EnvSecret[];
  readonly services: readonly ("postgres" | "redis")[];
  readonly network: { readonly domains: readonly string[] };
}

/** The exact top-level key set (C2/C4: no subnets, cidr, ipRanges or ports, and no alias of them). */
export const TOP_LEVEL_KEYS = ["dockerfile", "env", "image", "network", "nix", "preset", "run", "secrets", "services", "setup", "version"] as const;

/**
 * The nine preset ids. A copy of env-presets' PRESET_IDS, because env-presets depends on this package; a test in
 * env-presets pins the two lists together. `nix` is the `nix` field, not a preset id, until E3b.
 */
export const KNOWN_PRESET_IDS = ["rust", "go", "jvm", "dotnet", "ruby", "php", "cpp", "node", "python"] as const;
/** At most this many presets compose (D#5 C3 section 5.2; a PM default the owner may change). */
export const MAX_PRESETS = 3;
export const NIX_DEFAULTS = { flake: ".", shell: "default" } as const;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (a: readonly string[]): string[] => [...new Set(a)].sort();

/** A string is a list of one; anything else is read as the list it is. */
const presetList = (p: unknown): string[] => (Array.isArray(p) ? (p as string[]) : [p as string]);

/**
 * Projects any EnvSpec-shaped value onto the canonical shape: only known fields are copied (a stray
 * `value` on a secret is dropped, never stored), defaults are filled, sets are sorted and de-duplicated,
 * and keys are inserted alphabetically. Command order is kept -- it is semantic.
 */
export function normalize(s: EnvSpec): EnvSpec {
  const o: Record<string, unknown> = {};
  if (s.dockerfile !== undefined) o.dockerfile = s.dockerfile;
  o.env = Object.fromEntries(Object.entries(s.env ?? {}).sort(([a], [b]) => cmp(a, b)));
  if (s.image !== undefined) o.image = s.image;
  o.network = { domains: sorted((s.network?.domains ?? []).map((d) => d.toLowerCase())) };
  if (s.nix !== undefined) {
    const subs = new Map((s.nix.substituters ?? []).map((x) => [`${x.url}\n${x.publicKey}`, { publicKey: x.publicKey, url: x.url }] as const));
    o.nix = {
      flake: s.nix.flake ?? NIX_DEFAULTS.flake,
      inputs: sorted(s.nix.inputs ?? []),
      shell: s.nix.shell ?? NIX_DEFAULTS.shell,
      substituters: [...subs.entries()].sort(([a], [b]) => cmp(a, b)).map(([, v]) => v),
    };
  }
  if (s.preset !== undefined) o.preset = sorted(presetList(s.preset));
  o.run = (s.run ?? []).map((c) => [...c]);
  const kinds = new Map((s.secrets ?? []).map((x) => [x.name, x.kind ?? "brokered_http"] as const));
  o.secrets = sorted([...kinds.keys()]).map((name) => ({ kind: kinds.get(name), name }));
  o.services = sorted(s.services ?? []);
  o.setup = (s.setup ?? []).map((c) => [...c]);
  o.version = 1;
  return o as unknown as EnvSpec;
}

/** Byte-stable canonical JSON: the string E9 stores as `canonical_spec`. Idempotent; key order and whitespace never matter. */
export const canonicalize = (s: EnvSpec): string => JSON.stringify(normalize(s));

export const BASE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BLOB_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A repo file and its git blob sha, as read from the commit's tree listing (E9 does the reading; this package does no I/O). */
export interface TreeEntry { readonly path: string; readonly sha: string }

const VERSION_FILES = [".nvmrc", ".node-version", ".python-version", ".tool-versions", "mise.toml", ".mise.toml", "mise.lock"];
const RUST_FILES = ["rust-toolchain.toml", "rust-toolchain"];
const trimDot = (p: string): string => (p.startsWith("./") ? p.slice(2) : p);

/**
 * Whether a repo-relative path is one of the files that define this spec's environment (C3 section 1.4):
 * `nix` specs: the flake's `flake.lock`, every `*.nix`, and the listed `nix.inputs`; `dockerfile` specs: the
 * Dockerfile; preset specs: the version files the builder honours (section 5.6), plus `rust-toolchain(.toml)` when
 * `rust` is a preset (section 6.1). Version files are read from the repo root.
 */
export function isInputFile(spec: EnvSpec, path: string): boolean {
  const s = normalize(spec);
  if (path === "" || path.startsWith("/") || path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return false;
  if (s.nix !== undefined) {
    const dir = s.nix.flake === "." ? "" : `${trimDot(s.nix.flake)}/`;
    return path === `${dir}flake.lock` || path.endsWith(".nix") || s.nix.inputs.map(trimDot).includes(path);
  }
  if (s.dockerfile !== undefined) return path === trimDot(s.dockerfile);
  if (s.preset !== undefined) return VERSION_FILES.includes(path) || (s.preset.includes("rust") && RUST_FILES.includes(path));
  return false;
}

/**
 * sha256 over the sorted (path, blob sha) pairs of the tree entries that are this spec's input files. Hand it the
 * WHOLE tree listing: the filtering is done here, so a caller cannot hash a different set than the one defined above.
 */
export function inputsDigest(spec: EnvSpec, tree: readonly TreeEntry[]): string {
  const picked = new Map<string, string>();
  // The tree listing holds blobs only, so a nix.inputs entry that is a directory would hash nothing and go stale.
  for (const dir of spec.nix?.inputs ?? []) {
    if (tree.some((e) => e.path.startsWith(`${trimDot(dir)}/`))) throw new EnvSpecError("invalid_value", ["nix", "inputs"], "lists a directory; list the files inside it instead");
  }
  for (const e of tree) {
    if (!isInputFile(spec, e.path)) continue;
    if (!BLOB_SHA.test(e.sha)) throw new EnvSpecError("invalid_value", ["tree", e.path], "blob sha must be 40 or 64 lowercase hex");
    if (picked.has(e.path) && picked.get(e.path) !== e.sha) throw new EnvSpecError("invalid_value", ["tree", e.path], "appears twice with different blob shas");
    picked.set(e.path, e.sha);
  }
  return sha256(JSON.stringify([...picked.entries()].sort(([a], [b]) => cmp(a, b))));
}

/** The inputsDigest of a spec with no input files in the tree. */
export const EMPTY_INPUTS_DIGEST = sha256("[]");

/**
 * sha256(canonical || baseDigest || inputsDigest) as 64 lowercase hex -- the shape env_versions.env_version_id stores.
 * Both suffixes are fixed-width, so the concatenation is unambiguous. A `nix` or `dockerfile` spec must be given its
 * inputsDigest: without it a flake.lock or Dockerfile edit would reuse a stale image. Other specs may omit it.
 */
export function envVersionId(s: EnvSpec, baseDigest: string, inputs?: string): string {
  if (!BASE_DIGEST.test(baseDigest)) throw new EnvSpecError("invalid_value", ["baseDigest"], "must be sha256:<64 lowercase hex>");
  const n = normalize(s);
  if (inputs === undefined && (n.nix !== undefined || n.dockerfile !== undefined)) {
    throw new EnvSpecError("invalid_value", ["inputsDigest"], "is required for a nix or dockerfile spec");
  }
  const digest = inputs ?? EMPTY_INPUTS_DIGEST;
  if (!HEX64.test(digest)) throw new EnvSpecError("invalid_value", ["inputsDigest"], "must be 64 lowercase hex");
  return sha256(canonicalize(n) + baseDigest + digest);
}
