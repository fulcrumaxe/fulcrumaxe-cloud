import { MISE_CONFIG, MISE_TOOLS_ALLOWED, TOOLS_ROOT, miseConfigText, miseFiles, miseSteps, type Layer } from "@fx/env-presets";
import { EnvBuildError, type BuildErrorCode } from "./errors.js";

/** A tool version a repo file pins, already read by the pure parser (E2). `source` is the file it came from. */
export interface VersionPin { readonly tool: string; readonly version: string; readonly source: string }

/** The honoured fields of `rust-toolchain.toml` or `rust-toolchain` (security M-B2). */
export interface RustToolchainFile {
  readonly source: "rust-toolchain.toml" | "rust-toolchain";
  readonly channel: string;
  readonly components?: readonly string[];
  readonly targets?: readonly string[];
  readonly profile?: string;
}

/**
 * M-B3. Starts with a letter or digit, then letters, digits and `._+-`, at most 64 characters. That admits real values
 * such as `20.11.1`, `temurin-21.0.2+13.0.LTS`, `pypy3.10-7.3.15` and `3.13.0rc1`. The only slash and star forms are the
 * fixed aliases `lts/*` and `lts/<codename>`. No colon, whitespace or quote can match, so nothing can open a TOML string.
 */
const VERSION = /^(?:lts\/\*|lts\/[a-z]{3,30}|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/;
/** Forms that name a git ref, a filesystem path, a sub-version selector or the host's own install: never allowed. */
const REFUSED_FORM = /^(?:ref|path|sub-|system)/i;
/** A leading `v` before a digit (`v20.11.1`, the usual `.nvmrc` form) is dropped: mise's version lists have none. */
const stripV = (v: string): string => (/^v\d/.test(v) ? v.slice(1) : v);
export const MAX_TOOLS = 16;
/** M-B12. A bare `stable`, `beta` or `nightly` is allowed in a customer file; our own default is always exact. */
const CHANNEL = /^(?:stable|beta|nightly|\d+\.\d+(?:\.\d+)?)(?:-\d{4}-\d{2}-\d{2})?$/;
/** M-B12, tightened so a value can never begin with `-` and be read as a flag. */
const COMPONENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROFILES = ["minimal", "default", "complete"];
const MAX_LIST = 32;

const bad = (code: BuildErrorCode, detail: string): never => { throw new EnvBuildError(code, detail); };

/** Validates and orders the pins. The result is sorted by tool, so input order cannot change the plan. */
function checkPins(pins: readonly VersionPin[]): { tool: string; version: string }[] {
  if (!Array.isArray(pins)) return bad("invalid_version_pin", "version pins must be a list");
  if (pins.length > MAX_TOOLS) return bad("too_many_tools", `a repo may pin at most ${MAX_TOOLS} tools`);
  const files = MISE_CONFIG.versionFiles as Readonly<Record<string, string>>;
  const out = new Map<string, string>();
  for (const p of pins as readonly unknown[]) {
    const r = (p ?? {}) as Record<string, unknown>;
    const { tool, version, source } = r;
    if (typeof source !== "string" || !Object.hasOwn(files, source)) return bad("invalid_version_pin", "a pin must come from one of the honoured version files");
    if (typeof tool !== "string" || !(MISE_TOOLS_ALLOWED as readonly string[]).includes(tool)) return bad("tool_not_allowed", `${source} names a tool that is not supported here; a Dockerfile can install it`);
    if (files[source] !== "any" && files[source] !== tool) return bad("invalid_version_pin", `${source} cannot pin ${tool}`);
    const v = typeof version === "string" ? stripV(version) : "";
    if (typeof version !== "string" || REFUSED_FORM.test(v) || !VERSION.test(v)) return bad("invalid_version_pin", `${source} has a version that is not a plain version or a supported alias`);
    if (out.has(tool)) return bad("invalid_version_pin", `${tool} is pinned twice`);
    out.set(tool, v);
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([tool, version]) => ({ tool, version }));
}

/**
 * The version-file layer (C3 section 5.6): mise installs each pinned tool in the builder, outside the repo, with our
 * generated config, and is removed before the layer ends. Tools reach PATH as explicit directories, first.
 */
export function versionToolsLayer(pins: readonly VersionPin[]): Layer | undefined {
  const tools = checkPins(pins);
  if (tools.length === 0) return undefined;
  const names = tools.map((t) => t.tool);
  return {
    id: "version-tools",
    toolchains: names,
    aptPackages: [],
    files: miseFiles(miseConfigText(tools.map((t) => [t.tool, t.version] as const))),
    env: { PATH: `${names.map((n) => `${TOOLS_ROOT}/${n}/bin`).join(":")}:\${PATH}` },
    steps: miseSteps(names),
  };
}

const list = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_LIST) return bad("invalid_rust_toolchain", `${what} must be a list of at most ${MAX_LIST}`);
  for (const x of v as unknown[]) if (typeof x !== "string" || !COMPONENT.test(x)) return bad("invalid_rust_toolchain", `${what} has an entry that is not a plain name`);
  return [...new Set(v as string[])].sort();
};

/** The rust-toolchain layer (C3 section 6.1): the named channel, components and targets, installed by rustup. */
export function rustToolchainLayer(t: RustToolchainFile): Layer {
  const r = (t ?? {}) as unknown as Record<string, unknown>;
  if (r.source !== "rust-toolchain.toml" && r.source !== "rust-toolchain") return bad("invalid_rust_toolchain", "source must be rust-toolchain.toml or rust-toolchain");
  const file = r.source;
  if (Object.hasOwn(r, "path")) return bad("rust_toolchain_path", `${file} sets \`path\`, which names a local toolchain directory; use a channel`);
  if (typeof r.channel !== "string" || !CHANNEL.test(r.channel)) return bad("invalid_rust_toolchain", `${file} needs a channel that is a version, stable, beta or nightly, optionally dated`);
  const channel = r.channel;
  const profile = r.profile === undefined ? "minimal" : r.profile;
  if (typeof profile !== "string" || !PROFILES.includes(profile)) return bad("invalid_rust_toolchain", `${file} has an unknown profile`);
  const components = list(r.components, "components");
  const targets = list(r.targets, "targets");
  return {
    id: "rust-toolchain",
    toolchains: [`rust-${channel}`],
    aptPackages: [],
    files: [],
    steps: [
      ["rustup", "toolchain", "install", channel, "--profile", profile, "--no-self-update",
        ...components.flatMap((c) => ["--component", c]), ...targets.flatMap((x) => ["--target", x])],
      ["rustup", "default", channel],
      ["chown", "-R", "ubuntu:ubuntu", "/usr/local/rustup", "/usr/local/cargo"],
    ],
  };
}
