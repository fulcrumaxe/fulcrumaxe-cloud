/**
 * D#6 C44-4: the pre-check the host-side dependency install makes of a repo's lockfile and package-manager settings, before any package manager starts.
 * The repo is hostile, so every check fails closed: a document the check cannot place is refused, never skipped.
 *
 * The documents are PARSED (YAML with the JSON schema: no custom tags, no merge keys, no anchors or aliases, one document, duplicate keys refused;
 * JSON for `package-lock.json`) and the parsed structure is walked. Nothing is read line by line, so indentation, flow style, multi-line and folded
 * scalars and an explicit document start cannot hide a value from the check. Every string, key and value, wherever it sits, is held to the same rules:
 *  - a package comes from the pinned registry host over https with an integrity hash, and its resolution holds nothing else (a git, directory or
 *    other-host resolution is refused);
 *  - no git, file, ssh, http, portal, exec or other-registry dependency, and no URL anywhere except a pinned-host tarball;
 *  - `link:` only as an importer's own dependency and only to a project that stays inside the repo;
 *  - keys outside a known list are refused where they could change how a package is resolved or where it is written.
 * The repo's `.npmrc` and `pnpm-workspace.yaml` may hold only a short list of harmless settings.
 * Pure functions over text. They name one closed reason and nothing from the repo (no path, no URL, no value).
 */
import path from "node:path";
import { JSON_SCHEMA, load } from "js-yaml";

/** Why a pre-check refused. A closed set; it is shown on the runner's terminal and never sent. */
export type LockRefusal = "lockfile_unparsable" | "other_host_tarball" | "unsafe_dependency" | "integrity_missing" | "npmrc_unsafe";

export type LockCheck = { ok: true; projects: string[] } | { ok: false; reason: LockRefusal };

type Verdict = LockRefusal | undefined;
type Obj = Record<string, unknown>;

const INTEGRITY = /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
/** Characters a document never holds: control characters other than tab, newline and carriage return. */
const ODD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** A dependency kind that is not a registry package, at the start of a string or after `@`, a space, `(` or `,`. */
const FORBIDDEN_KIND = /(?:^|[@\s(,])(?:file|git\+[a-z]+|git|ssh|http|github|gitlab|bitbucket|gist|portal|exec|jsr|ftp):/i;
const MAX_DEPTH = 64;

const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** A repo-relative directory: no leading slash, no `..` segment after normalising. */
export function isInsideRelative(relative: string): boolean {
  if (relative === "" || relative.startsWith("/") || relative.startsWith("~") || relative.includes("\0") || relative.includes("\\")) return false;
  const normal = path.posix.normalize(relative);
  return normal !== ".." && !normal.startsWith("../") && !path.posix.isAbsolute(normal);
}

/** `https://<host>/...` with no user, no password and no port, exactly on the pinned host. */
function tarballVerdict(value: unknown, host: string): "ok" | "other_host_tarball" | "unsafe_dependency" {
  if (typeof value !== "string") return "unsafe_dependency";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // fx-swallow-ok: a value that is not a URL is the closed answer "unsafe"
    return "unsafe_dependency";
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return "unsafe_dependency";
  return url.hostname === host ? "ok" : "other_host_tarball";
}

type Parsed = { ok: true; value: unknown } | { ok: false };

/** One YAML document, JSON schema, no anchors or aliases, no duplicate keys, no tags. Empty text parses to `undefined`. */
function parseYaml(text: string): Parsed {
  if (ODD_CHARS.test(text)) return { ok: false };
  let anchored = false;
  try {
    const value = load(text, {
      schema: JSON_SCHEMA,
      listener: (_event, state) => {
        if (state.anchor !== null && state.anchor !== undefined) anchored = true;
      },
    });
    return anchored ? { ok: false } : { ok: true, value };
  } catch {
    // fx-swallow-ok: a document the parser refuses (several documents, a tag, a duplicate key, bad syntax) is the closed answer "unparsable"
    return { ok: false };
  }
}

interface Ctx {
  /** The importer a `link:` is read relative to, or undefined where a link is not allowed at all. */
  importer?: string;
}

/** One string or key. No name grants an exemption: the only free text in a lockfile is `packages.<entry>.deprecated`, which its own position handles. */
function stringVerdict(text: string, ctx: Ctx, isKey: boolean): Verdict {
  if (text.includes("://") || FORBIDDEN_KIND.test(text)) return "unsafe_dependency";
  if (/link:/i.test(text)) {
    if (isKey || !text.startsWith("link:") || ctx.importer === undefined) return "unsafe_dependency";
    const target = text.slice("link:".length);
    // A target holding whitespace is a folded multi-line value or a padded one: pnpm may trim it to a different path than the one judged here.
    if (target.startsWith("/") || target.startsWith("~") || /\s/.test(target)) return "unsafe_dependency";
    if (!isInsideRelative(path.posix.join(ctx.importer, target))) return "unsafe_dependency";
  }
  return undefined;
}

/**
 * The path-exact checks. Each position of a pnpm lockfile has a checker that says what may appear there; a value of the wrong kind or a key the position does
 * not list is refused, so nothing is accepted by being unrecognised and no key name earns an exemption at a position that does not list it.
 */
type Check = (value: unknown, ctx: Ctx) => Verdict;
const WRONG_KIND: LockRefusal = "lockfile_unparsable";

const str: Check = (value, ctx) => (typeof value === "string" ? stringVerdict(value, ctx, false) : WRONG_KIND);
const bool: Check = (value) => (typeof value === "boolean" ? undefined : WRONG_KIND);
const scalar: Check = (value, ctx) => (typeof value === "boolean" || typeof value === "number" ? undefined : str(value, ctx));
/** Free text shown to a person (`packages.<entry>.deprecated`): any string, never acted on. */
const freeText: Check = (value) => (typeof value === "string" ? undefined : WRONG_KIND);
const arrayOf = (item: Check): Check => (value, ctx) => {
  if (!Array.isArray(value)) return WRONG_KIND;
  for (const element of value) {
    const verdict = item(element, ctx);
    if (verdict !== undefined) return verdict;
  }
  return undefined;
};
/** A mapping whose keys are names (checked as keys) and whose values pass `item`. */
const mapOf = (item: Check): Check => (value, ctx) => {
  if (!isObj(value)) return WRONG_KIND;
  for (const [key, element] of Object.entries(value)) {
    if (key === "__proto__") return WRONG_KIND;
    const named = stringVerdict(key, ctx, true) ?? item(element, ctx);
    if (named !== undefined) return named;
  }
  return undefined;
};
/** A mapping with exactly these keys allowed, each with its own checker. An unknown key is `unknown`. */
const shape = (fields: Readonly<Record<string, Check>>, unknown: LockRefusal): Check => (value, ctx) => {
  if (!isObj(value)) return WRONG_KIND;
  for (const [key, element] of Object.entries(value)) {
    if (!Object.hasOwn(fields, key)) return unknown;
    const verdict = fields[key]!(element, ctx);
    if (verdict !== undefined) return verdict;
  }
  return undefined;
};

/** An importer's dependency: a version string, or `{ specifier, version }`. */
const depEntry: Check = (value, ctx) => (typeof value === "string" ? str(value, ctx) : shape({ specifier: str, version: str }, "unsafe_dependency")(value, ctx));
const depMap = mapOf(depEntry);
const strMap = mapOf(str);
const scalarMap = mapOf(scalar);

/** Top-level positions. Each is judged by its own checker; `importers`, `packages` and `patchedDependencies` have extra rules below. */
const LOCK_FIELDS: Readonly<Record<string, Check>> = {
  lockfileVersion: scalar,
  settings: shape({ autoInstallPeers: bool, excludeLinksFromLockfile: bool, peersSuffixMaxLength: scalar, injectWorkspacePackages: bool, linkWorkspacePackages: scalar, preferWorkspacePackages: bool, dedupePeerDependents: bool }, "lockfile_unparsable"),
  overrides: strMap,
  packageExtensionsChecksum: str,
  pnpmfileChecksum: str,
  patchedDependencies: mapOf(shape({ path: str, hash: str }, "unsafe_dependency")),
  importers: () => undefined,
  packages: () => undefined,
  snapshots: () => undefined,
  catalogs: mapOf(mapOf(shape({ specifier: str, version: str }, "unsafe_dependency"))),
  ignoredOptionalDependencies: arrayOf(str),
  time: strMap,
  neverBuiltDependencies: arrayOf(str),
  onlyBuiltDependencies: arrayOf(str),
  dependencies: depMap,
  devDependencies: depMap,
  optionalDependencies: depMap,
  specifiers: strMap,
};

const IMPORTER_FIELDS: Readonly<Record<string, Check>> = {
  dependencies: depMap,
  devDependencies: depMap,
  optionalDependencies: depMap,
  dependenciesMeta: mapOf(shape({ injected: bool, node: str }, "unsafe_dependency")),
  publishDirectory: str,
  specifiers: strMap,
};

/** `packages.<entry>`: everything but `resolution`, which has its own check because it is the one place a URL may appear. */
const PACKAGE_FIELDS: Readonly<Record<string, Check>> = {
  engines: scalarMap,
  cpu: arrayOf(str),
  os: arrayOf(str),
  libc: arrayOf(str),
  deprecated: freeText,
  hasBin: bool,
  prepare: bool,
  requiresBuild: bool,
  bundledDependencies: (value, ctx) => (typeof value === "boolean" ? undefined : arrayOf(str)(value, ctx)),
  bundleDependencies: (value, ctx) => (typeof value === "boolean" ? undefined : arrayOf(str)(value, ctx)),
  peerDependencies: strMap,
  peerDependenciesMeta: mapOf(shape({ optional: bool }, "unsafe_dependency")),
  dependencies: strMap,
  optionalDependencies: strMap,
  transitivePeerDependencies: arrayOf(str),
  name: str,
  version: str,
  dev: bool,
  optional: bool,
  patched: bool,
};

const SNAPSHOT_FIELDS: Readonly<Record<string, Check>> = {
  dependencies: strMap,
  optionalDependencies: strMap,
  transitivePeerDependencies: arrayOf(str),
  optional: bool,
  patched: bool,
  dev: bool,
  bundledDependencies: PACKAGE_FIELDS.bundledDependencies!,
  bundleDependencies: PACKAGE_FIELDS.bundleDependencies!,
};

/** A `pnpm-lock.yaml`, parsed and checked position by position. Anything outside the shape pnpm writes is refused. */
export function checkPnpmLock(text: string, host: string): LockCheck {
  const parsed = parseYaml(text);
  if (!parsed.ok) return { ok: false, reason: "lockfile_unparsable" };
  if (parsed.value === undefined || parsed.value === null) return { ok: true, projects: [] };
  const lock = parsed.value;
  if (!isObj(lock)) return { ok: false, reason: "lockfile_unparsable" };
  const fail = (reason: LockRefusal) => ({ ok: false, reason }) as const;
  for (const [key, value] of Object.entries(lock)) {
    if (!Object.hasOwn(LOCK_FIELDS, key)) return fail("lockfile_unparsable");
    const verdict = LOCK_FIELDS[key]!(value, {});
    if (verdict !== undefined) return fail(verdict);
  }

  const projects: string[] = [];
  const importers = lock.importers;
  if (importers !== undefined) {
    if (!isObj(importers)) return fail("lockfile_unparsable");
    for (const [name, importer] of Object.entries(importers)) {
      if (!isInsideRelative(name)) return fail("unsafe_dependency");
      if (importer === null) {
        projects.push(name);
        continue;
      }
      const publish = isObj(importer) ? importer.publishDirectory : undefined;
      if (publish !== undefined && (typeof publish !== "string" || !isInsideRelative(path.posix.join(name, publish)))) return fail("unsafe_dependency");
      const verdict = shape(IMPORTER_FIELDS, "unsafe_dependency")(importer, { importer: name });
      if (verdict !== undefined) return fail(verdict);
      projects.push(name);
    }
  }

  const patched = lock.patchedDependencies;
  if (isObj(patched)) for (const value of Object.values(patched)) {
    const patchPath = (value as { path?: unknown }).path;
    if (typeof patchPath !== "string" || !isInsideRelative(patchPath)) return fail("unsafe_dependency");
  }

  const packages = lock.packages;
  if (packages !== undefined) {
    if (!isObj(packages)) return fail("lockfile_unparsable");
    for (const [name, entry] of Object.entries(packages)) {
      if (name === "__proto__") return fail("lockfile_unparsable");
      const named = stringVerdict(name, {}, true);
      if (named !== undefined) return fail(named);
      if (!isObj(entry)) return fail("lockfile_unparsable");
      const { resolution, ...rest } = entry;
      if (!isObj(resolution)) return fail("integrity_missing");
      for (const key of Object.keys(resolution)) if (key !== "integrity" && key !== "tarball") return fail("unsafe_dependency");
      if (resolution.tarball !== undefined) {
        const verdict = tarballVerdict(resolution.tarball, host);
        if (verdict !== "ok") return fail(verdict);
      }
      if (typeof resolution.integrity !== "string" || !INTEGRITY.test(resolution.integrity)) return fail("integrity_missing");
      const verdict = shape(PACKAGE_FIELDS, "unsafe_dependency")(rest, {});
      if (verdict !== undefined) return fail(verdict);
    }
  }

  const snapshots = lock.snapshots;
  if (snapshots !== undefined) {
    if (!isObj(snapshots)) return fail("lockfile_unparsable");
    for (const [name, entry] of Object.entries(snapshots)) {
      if (name === "__proto__") return fail("lockfile_unparsable");
      const named = stringVerdict(name, {}, true);
      if (named !== undefined) return fail(named);
      const verdict = shape(SNAPSHOT_FIELDS, "unsafe_dependency")(entry, {});
      if (verdict !== undefined) return fail(verdict);
    }
  }
  return { ok: true, projects };
}

const NPM_TOP: ReadonlySet<string> = new Set(["name", "version", "lockfileVersion", "requires", "packages"]);
const NPM_ENTRY: ReadonlySet<string> = new Set([
  "name", "version", "resolved", "integrity", "link", "dev", "optional", "devOptional", "peer", "inBundle", "hasInstallScript", "hasShrinkwrap", "dependencies", "devDependencies",
  "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "engines", "bin", "license", "funding", "os", "cpu", "libc", "deprecated", "workspaces", "bundleDependencies",
  "bundledDependencies", "extraneous", "fund", "directories", "main", "description",
]);
const NPM_DEP_MAPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** A `package-lock.json` (lockfile version 2 or 3: the `packages` map), parsed as JSON. */
export function checkNpmLock(text: string, host: string): LockCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // fx-swallow-ok: a lockfile that is not JSON is the closed answer "unparsable"
    return { ok: false, reason: "lockfile_unparsable" };
  }
  if (!isObj(parsed) || !isObj(parsed.packages)) return { ok: false, reason: "lockfile_unparsable" };
  if (Object.keys(parsed).some((key) => !NPM_TOP.has(key))) return { ok: false, reason: "lockfile_unparsable" };
  const packages = parsed.packages;
  const projects: string[] = [];
  for (const [key, raw] of Object.entries(packages)) {
    if (key === "__proto__") return { ok: false, reason: "lockfile_unparsable" };
    if (!isObj(raw)) return { ok: false, reason: "lockfile_unparsable" };
    if (key !== "" && !isInsideRelative(key)) return { ok: false, reason: "unsafe_dependency" };
    if (Object.keys(raw).some((name) => !NPM_ENTRY.has(name))) return { ok: false, reason: "unsafe_dependency" };
    for (const map of NPM_DEP_MAPS) {
      const deps = raw[map];
      if (deps === undefined) continue;
      if (!isObj(deps)) return { ok: false, reason: "lockfile_unparsable" };
      for (const spec of Object.values(deps)) if (typeof spec !== "string" || FORBIDDEN_KIND.test(spec) || /link:/i.test(spec) || spec.includes("://")) return { ok: false, reason: "unsafe_dependency" };
    }
    if (key === "") continue;
    const { resolved, integrity } = raw;
    if (raw.link === true) {
      if (typeof resolved !== "string" || !isInsideRelative(resolved)) return { ok: false, reason: "unsafe_dependency" };
      projects.push(resolved);
      continue;
    }
    if (raw.inBundle === true) {
      // Bundled inside its parent's tarball: it has no download of its own, and a parent must exist for it to be bundled in.
      const marker = key.lastIndexOf("/node_modules/");
      if (resolved !== undefined || marker < 0 || !isObj(packages[key.slice(0, marker)])) return { ok: false, reason: "unsafe_dependency" };
      continue;
    }
    // A project of the repo itself (a workspace member): listed outside any `node_modules`, with no download.
    if (!key.split("/").includes("node_modules") && resolved === undefined) {
      projects.push(key);
      continue;
    }
    if (typeof resolved !== "string") return { ok: false, reason: "integrity_missing" };
    const verdict = tarballVerdict(resolved, host);
    if (verdict !== "ok") return { ok: false, reason: verdict };
    if (typeof integrity !== "string" || !INTEGRITY.test(integrity)) return { ok: false, reason: "integrity_missing" };
  }
  return { ok: true, projects };
}

/** The only `.npmrc` keys the host install accepts from a repo; `registry` only when it names the pinned registry. */
const NPMRC_KEYS: ReadonlySet<string> = new Set([
  "engine-strict", "auto-install-peers", "strict-peer-dependencies", "shamefully-hoist", "public-hoist-pattern[]", "hoist-pattern[]", "node-linker",
  "link-workspace-packages", "prefer-workspace-packages", "save-exact", "save-prefix", "legacy-peer-deps", "resolution-mode", "dedupe-peer-dependents",
]);

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, "$2");

/** A repo's root `.npmrc`: comments and blank lines, harmless keys, and `registry=` only if it is the pinned one. A value with `${` (environment expansion) is refused. */
export function checkNpmrc(text: string, registryUrl: string): LockCheck {
  if (ODD_CHARS.test(text) || text.includes("\\")) return { ok: false, reason: "npmrc_unsafe" };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const at = line.indexOf("=");
    if (at <= 0) return { ok: false, reason: "npmrc_unsafe" };
    const key = line.slice(0, at).trim();
    const value = unquote(line.slice(at + 1));
    if (value.includes("${")) return { ok: false, reason: "npmrc_unsafe" };
    if (key === "registry") {
      if (value.replace(/\/+$/, "") !== registryUrl.replace(/\/+$/, "")) return { ok: false, reason: "npmrc_unsafe" };
    } else if (!NPMRC_KEYS.has(key)) return { ok: false, reason: "npmrc_unsafe" };
  }
  return { ok: true, projects: [] };
}

/** The top-level keys a repo's `pnpm-workspace.yaml` may hold: project lists, catalogs and dependency-shaping data, none that reach a registry, a script, a hook or a directory. */
const WORKSPACE_KEYS: ReadonlySet<string> = new Set([
  "packages", "catalog", "catalogs", "overrides", "patchedDependencies", "peerDependencyRules", "packageExtensions", "allowedDeprecatedVersions",
  "onlyBuiltDependencies", "ignoredBuiltDependencies", "neverBuiltDependencies", "allowBuilds", "ignoredOptionalDependencies", "autoInstallPeers", "linkWorkspacePackages", "shamefullyHoist",
  "publicHoistPattern", "hoistPattern", "nodeLinker", "engineStrict", "strictPeerDependencies", "dedupePeerDependents", "supportedArchitectures",
]);

/** Every key and string of a workspace file's data, wherever it sits: the same string rules as the lockfile, and no `link:` at all. There is no free text here. */
function walkAny(node: unknown, depth = 0): Verdict {
  if (depth > MAX_DEPTH) return "lockfile_unparsable";
  if (typeof node === "string") return stringVerdict(node, {}, false);
  if (Array.isArray(node)) {
    for (const item of node) {
      const verdict = walkAny(item, depth + 1);
      if (verdict !== undefined) return verdict;
    }
    return undefined;
  }
  if (isObj(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "__proto__") return "lockfile_unparsable";
      const verdict = stringVerdict(key, {}, true) ?? walkAny(value, depth + 1);
      if (verdict !== undefined) return verdict;
    }
  }
  return undefined;
}

/** A project glob: inside the repo after normalising, no brace expansion, no backslash, and no `..` segment anywhere. */
function globStaysInside(glob: string): boolean {
  const bare = glob.replace(/^!/, "");
  return isInsideRelative(bare) && !/[{}]/.test(bare) && !bare.split("/").includes("..");
}

/** `pnpm-workspace.yaml`, parsed: one document, a mapping whose every key is on the list; project globs and patch paths stay inside the repo; no URL, link or non-registry kind in any value. */
export function checkWorkspaceYaml(text: string): LockCheck {
  const parsed = parseYaml(text);
  if (!parsed.ok) return { ok: false, reason: "npmrc_unsafe" };
  const doc = parsed.value;
  if (doc === undefined || doc === null) return { ok: true, projects: [] };
  if (!isObj(doc)) return { ok: false, reason: "npmrc_unsafe" };
  for (const key of Object.keys(doc)) if (!WORKSPACE_KEYS.has(key)) return { ok: false, reason: "npmrc_unsafe" };
  const globs = doc.packages;
  if (globs !== undefined) {
    if (!Array.isArray(globs)) return { ok: false, reason: "npmrc_unsafe" };
    for (const glob of globs) if (typeof glob !== "string" || !globStaysInside(glob)) return { ok: false, reason: "npmrc_unsafe" };
  }
  const patched = doc.patchedDependencies;
  if (patched !== undefined) {
    if (!isObj(patched)) return { ok: false, reason: "npmrc_unsafe" };
    for (const value of Object.values(patched)) if (typeof value !== "string" || !isInsideRelative(value)) return { ok: false, reason: "npmrc_unsafe" };
  }
  return walkAny(doc) === undefined ? { ok: true, projects: [] } : { ok: false, reason: "npmrc_unsafe" };
}
