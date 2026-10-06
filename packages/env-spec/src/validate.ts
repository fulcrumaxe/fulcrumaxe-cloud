import { EnvSpecError, type ErrorCode, type Path } from "./errors.js";
import { BASE_DIGEST, KNOWN_PRESET_IDS, MAX_PRESETS, NIX_DEFAULTS, TOP_LEVEL_KEYS, type EnvSpec, type NixSpec } from "./spec.js";

export const LIMITS = { bytes: 65536, depth: 8, nodes: 2000, string: 4096, commands: 64, args: 64, entries: 128 } as const;

/** Address-range and port keys (C2, C4), compared after dropping case and separators so aliases like `ip_ranges` match. */
const FORBIDDEN = new Set([
  "subnet", "subnets", "cidr", "cidrs", "cidrblock", "cidrblocks", "iprange", "ipranges", "ipaddress", "ipaddresses",
  "port", "ports", "exposeports", "forwardports", "publishports", "expose",
]);
const REGISTRY = /^(\*\.)?([a-z0-9-]+\.)*(docker\.io|ghcr\.io|gcr\.io|quay\.io|azurecr\.io|pkg\.dev|public\.ecr\.aws|mcr\.microsoft\.com|registry\.gitlab\.com|amazonaws\.com)$/;

/**
 * C10: `name:tag`, `name@sha256:...`, `host/path`, or a bare well-known registry host. Deliberately conservative.
 * Scope (TL ruling): it guards the fields that can name or build an image -- preset, dockerfile, services and
 * network.domains -- and nothing else. Env values and argv elements are free text (`db:5432`, `npm run lint:fix`).
 */
export function looksLikeImageRef(v: string): boolean {
  const s = v.toLowerCase();
  return (
    /@sha(256|512):[0-9a-f]{16,}/.test(s) ||
    /^[a-z][a-z0-9._-]*(\/[a-z0-9._-]+)*:[a-z0-9_][a-z0-9._-]{0,127}$/.test(s) ||
    /^(?![\d.]+\/)[a-z0-9-]+(?:(?:\.[a-z0-9-]+)+(?::\d+)?|:\d+)\/\S+$/.test(s) ||
    REGISTRY.test(s)
  );
}

const fail = (path: Path, code: ErrorCode, detail: string): never => {
  throw new EnvSpecError(code, path, detail);
};

function shape(v: unknown, path: Path, allowed: readonly string[]): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(path, "invalid_type", "must be a mapping");
  for (const k of Object.keys(v)) {
    if (FORBIDDEN.has(k.toLowerCase().replace(/[^a-z0-9]/g, ""))) fail([...path, k], "forbidden_field", `"${k}" is rejected: an EnvSpec has no address-range or port fields`);
    if (!allowed.includes(k)) fail([...path, k], "unknown_field", `unknown field "${k}"`);
  }
  return v as Record<string, unknown>;
}

function arr(v: unknown, path: Path, max: number): unknown[] {
  if (!Array.isArray(v)) return fail(path, "invalid_type", "must be a list");
  return v.length > max ? fail(path, "limit_exceeded", `at most ${max} entries`) : v;
}

function str(v: unknown, path: Path): string {
  if (typeof v !== "string") return fail(path, "invalid_type", "must be a string (quote numbers and booleans)");
  if (v.length > LIMITS.string || v.includes("\0")) fail(path, "invalid_value", `must be at most ${LIMITS.string} characters with no NUL`);
  return v;
}

/** A string in a field that can name or build an image: refuse anything shaped like an image reference. */
function noImage(v: unknown, path: Path): string {
  const s = str(v, path);
  if (looksLikeImageRef(s)) fail(path, "image_reference", "looks like a container image reference; supply a Dockerfile or a preset, never an image");
  return s;
}

const matching = (v: unknown, path: Path, re: RegExp, what: string, image = false): string => {
  const s = image ? noImage(v, path) : str(v, path);
  return re.test(s) ? s : fail(path, "invalid_value", `must be ${what}`);
};

/** Env names that would reach Object.prototype (or its usual suspects) if a consumer indexed a plain object with them. */
const RESERVED_ENV = new Set(["__proto__", "constructor", "prototype"]);

/** `preset` is 1-3 ids; a single string is a list of one. Image-shaped values are refused before unknown ids are. */
function presets(v: unknown): string[] {
  const one = (x: unknown, path: Path): string => {
    const id = matching(x, path, /^[a-z][a-z0-9-]{0,31}$/, "a lowercase preset name", true);
    return (KNOWN_PRESET_IDS as readonly string[]).includes(id) ? id : fail(path, "unknown_preset", `unknown preset; use one of: ${KNOWN_PRESET_IDS.join(", ")}`);
  };
  if (!Array.isArray(v)) return [one(v, ["preset"])];
  const ids = [...new Set(arr(v, ["preset"], LIMITS.entries).map((x, i) => one(x, ["preset", i])))];
  if (ids.length === 0) fail(["preset"], "invalid_value", "needs at least one preset");
  if (ids.length > MAX_PRESETS) fail(["preset"], "limit_exceeded", `at most ${MAX_PRESETS} presets can be combined`);
  return ids;
}

/** A path inside the repo: relative, no dot-dot segment, and only characters that cannot change meaning on a command line (no segment starts with a hyphen). */
const REPO_PATH = /^(?:\.\/)?(?!\.{1,2}(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._-]*(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._-]*)*$/;
/** An ed25519 Nix public key: `<name>:<44 base64 characters>`. */
const NIX_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[A-Za-z0-9+/]{43}=$/;
const NIX_SUBSTITUTERS_MAX = 3;

function substituter(x: unknown, path: Path, domains: readonly string[]): { url: string; publicKey: string } {
  const s = shape(x, path, ["url", "publicKey"]);
  const raw = str(s.url, [...path, "url"]);
  const bad = (detail: string): never => fail([...path, "url"], "invalid_value", detail);
  let u: URL | undefined;
  try { u = new URL(raw); } catch { /* fx-swallow-ok: an unparsable URL leaves u undefined and is refused with a named error on the next line */ }
  if (u === undefined || u.protocol !== "https:" || !raw.toLowerCase().startsWith("https://")) return bad("must be an https URL");
  if (u.username || u.password || u.search || u.hash || u.port) return bad("must be a plain https URL: no credentials, port, query or fragment");
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(u.hostname) || /^\d+(\.\d+){3}$/.test(u.hostname)) return bad("needs a hostname, not an address");
  if (!domains.includes(u.hostname)) return bad("its host must also be listed in network.domains");
  return {
    url: `https://${u.hostname}${u.pathname.replace(/\/+$/, "")}`,
    publicKey: matching(s.publicKey, [...path, "publicKey"], NIX_KEY, "a Nix public key such as name-1:<base64>"),
  };
}

/** `nix: {flake, shell, inputs, substituters}`: argv-safe values only (B6), at most three customer substituters (B5, section 4.1). */
function nix(v: unknown, domains: readonly string[]): NixSpec {
  const o = shape(v, ["nix"], ["flake", "shell", "inputs", "substituters"]);
  const relPath = (x: unknown, path: Path): string => matching(x, path, REPO_PATH, "a relative path inside the repo (no dot-dot segment, no URL)");
  const flake = o.flake === undefined ? NIX_DEFAULTS.flake : o.flake === "." ? "." : relPath(o.flake, ["nix", "flake"]);
  const shell = o.shell === undefined ? NIX_DEFAULTS.shell : matching(o.shell, ["nix", "shell"], /^[a-z][a-z0-9-]{0,63}$/, "a shell name: lowercase letters, digits and hyphens");
  const inputs = arr(o.inputs ?? [], ["nix", "inputs"], LIMITS.entries).map((x, i) => relPath(x, ["nix", "inputs", i]));
  const subs = arr(o.substituters ?? [], ["nix", "substituters"], NIX_SUBSTITUTERS_MAX).map((x, i) => substituter(x, ["nix", "substituters", i], domains));
  return { flake, shell, inputs, substituters: subs };
}

/** The image field takes a bare sha256 digest, nothing else: a repository or tag is image_reference (C3 section 4.4). */
function imageDigest(v: unknown): string {
  const s = str(v, ["image"]);
  if (BASE_DIGEST.test(s)) return s;
  return looksLikeImageRef(s)
    ? fail(["image"], "image_reference", "names an image by repository or tag; give the sha256 digest alone (sha256:<64 lowercase hex>)")
    : fail(["image"], "invalid_value", "must be a sha256 digest: sha256:<64 lowercase hex>");
}

/**
 * Toolchain managers read their configuration and download sources from these variables, so a spec cannot set them:
 * NIX_* (B5: the locked nix.conf must hold), and MISE_*, RUSTUP_* (RUSTUP_DIST_SERVER, RUSTUP_UPDATE_ROOT), ASDF_*,
 * NVM_*, PYENV_* and NODE_MIRROR (M-B9: the pinned download hosts and checksums must hold).
 */
const TOOLCHAIN_ENV = /^(?:(?:nix|mise|rustup|asdf|nvm|pyenv)_|node_mirror$)/i;
const refusedEnv = (name: string): string => `"${name}" is refused: it would override the locked ${/^nix_/i.test(name) ? "Nix" : "toolchain"} configuration`;

/** Setup and run commands are argv arrays; a string form is rejected so nothing is ever shell-parsed. */
function commands(v: unknown, path: Path): string[][] {
  return arr(v, path, LIMITS.commands).map((c, i) => {
    const p = [...path, i];
    if (typeof c === "string") return fail(p, "string_form_command", 'must be an argv array such as ["npm", "ci"], not a shell string');
    const argv = arr(c, p, LIMITS.args).map((a, j) => str(a, [...p, j]));
    return argv[0] ? argv : fail(p, "invalid_value", "needs a non-empty program name as its first element");
  });
}

/** Validates an already-parsed document. Throws EnvSpecError (line-less; parse() adds the line). */
export function validate(input: unknown): EnvSpec {
  const o = shape(input, [], TOP_LEVEL_KEYS);
  if (o.version !== 1) fail(["version"], "invalid_value", "is required and must be the number 1");
  const preset = o.preset === undefined ? undefined : presets(o.preset);
  const dockerfile = o.dockerfile === undefined ? undefined : matching(o.dockerfile, ["dockerfile"], /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\\]+$/, "a relative path inside the repo", true);
  if (preset !== undefined && dockerfile !== undefined) fail(["dockerfile"], "invalid_value", "cannot be combined with preset: choose one base");
  const env: [string, string][] = [];
  const envIn = o.env ?? {};
  if (typeof envIn !== "object" || envIn === null || Array.isArray(envIn)) fail(["env"], "invalid_type", "must be a mapping");
  if (Object.keys(envIn).length > LIMITS.entries) fail(["env"], "limit_exceeded", `at most ${LIMITS.entries} entries`);
  for (const [k, v] of Object.entries(envIn)) {
    const name = matching(k, ["env", k], /^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "an environment variable name");
    if (TOOLCHAIN_ENV.test(name)) fail(["env", k], "forbidden_env_name", refusedEnv(name));
    if (RESERVED_ENV.has(name)) fail(["env", k], "invalid_value", `"${name}" is a reserved name and cannot be an environment variable`);
    env.push([name, str(v, ["env", k])]);
  }
  const secrets = arr(o.secrets ?? [], ["secrets"], LIMITS.entries).map((x, i) => {
    const p = ["secrets", i];
    const s = shape(x, p, ["name", "kind"]);
    const kind = s.kind ?? "brokered_http";
    if (kind !== "brokered_http" && kind !== "in_sandbox") return fail([...p, "kind"], "invalid_value", "must be brokered_http or in_sandbox");
    // 39: the longest name env_secret_refs can actually store (see D#5 correction, E7 lowers the column cap to match).
    const name = matching(s.name, [...p, "name"], /^[A-Za-z_][A-Za-z0-9_]{0,38}$/, "a secret name of at most 39 characters");
    if (TOOLCHAIN_ENV.test(name)) fail([...p, "name"], "forbidden_env_name", refusedEnv(name));
    return { name, kind } as const;
  });
  if (new Set(secrets.map((s) => s.name)).size !== secrets.length) fail(["secrets"], "invalid_value", "names must be unique");
  const services = arr(o.services ?? [], ["services"], 8).map((x, i) => {
    const s = noImage(x, ["services", i]);
    return s === "postgres" || s === "redis" ? s : fail(["services", i], "invalid_value", "must be postgres or redis");
  });
  const domains = arr(shape(o.network ?? {}, ["network"], ["domains"]).domains ?? [], ["network", "domains"], LIMITS.entries)
    .map((d, i) => matching(d, ["network", "domains", i], /^[a-z0-9*][a-z0-9.*-]{0,252}$/i, "a hostname (no scheme, path, port or address range)", true));
  const nixSpec = o.nix === undefined ? undefined : nix(o.nix, domains.map((d) => d.toLowerCase()));
  const image = o.image === undefined ? undefined : imageDigest(o.image);
  // One base per spec: a preset list, a Dockerfile, a Nix flake or an imported image digest. Presets compose with each other only.
  for (const [k, present] of [["nix", nixSpec], ["image", image]] as const) {
    if (present === undefined) continue;
    const other = (["preset", "dockerfile", "nix", "image"] as const).find((b) => b !== k && o[b] !== undefined);
    if (other !== undefined) fail([k], "invalid_value", `cannot be combined with ${other}: choose one base`);
  }
  return {
    version: 1, ...(preset !== undefined && { preset }), ...(dockerfile !== undefined && { dockerfile }),
    ...(image !== undefined && { image }), ...(nixSpec !== undefined && { nix: nixSpec }),
    setup: commands(o.setup ?? [], ["setup"]), run: commands(o.run ?? [], ["run"]),
    env: Object.fromEntries(env), secrets, services, network: { domains },
  };
}
