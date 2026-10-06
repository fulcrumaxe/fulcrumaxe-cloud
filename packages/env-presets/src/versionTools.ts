import { MISE, MISE_CONFIG } from "./pins.js";
import { PINS_DIR, checksumFile, downloadSteps } from "./presets.js";
import type { Argv, LayerFile } from "./types.js";

/**
 * Data for the version-file layer (D#5 C3 section 5.6, security M-B1 to M-B10). mise installs the pinned tools in
 * the builder and is deleted before the layer ends, so the image a run starts from never contains it (M-B10).
 */
export const MISE_ROOT = "/opt/fx-mise";
/** Where each installed tool is linked: `<TOOLS_ROOT>/<tool>/bin` goes first on PATH, as an explicit directory, never a shim. */
export const TOOLS_ROOT = "/opt/fx-tools";
export const MISE_BIN = `${MISE_ROOT}/bin/mise`;
export const MISE_CONFIG_FILE = `${MISE_ROOT}/config/config.toml`;
/** One line per tool, `<tool> <exact version>`: what a range or alias resolved to, for the builder to record. */
export const RESOLVED_TOOLS_FILE = `${PINS_DIR}/resolved-tools`;

/** Core backends only (M-B5). Adding a tool is a reviewed change to this list, after the E-S1m spike. */
export const MISE_TOOLS_ALLOWED = ["node", "python", "go", "java", "ruby", "bun", "deno"] as const;

/**
 * Every backend the pinned mise (MISE.version) lists under `mise backends ls`. A test pins this list, so a mise bump
 * that adds a backend fails until someone decides whether it is allowed (M-B5).
 */
export const MISE_KNOWN_BACKENDS = [
  "aqua", "asdf", "cargo", "conda", "core", "dotnet", "forgejo", "gem", "github", "gitlab", "go", "http", "npm",
  "packslip", "pypi", "s3", "spinel", "spm", "ubi", "vfox",
] as const;
/** Backends a build may use. Only mise's own core tools are on the allowed-tool list, so nothing else is needed yet. */
export const MISE_ALLOWED_BACKENDS: readonly string[] = ["core"];
/**
 * Every other backend is disabled (M-B5). mise has no allowlist setting, so the list is spelled out. `pipx` is the
 * name older mise releases gave `pypi`; it stays so a downgrade cannot re-enable it.
 */
export const MISE_REFUSED_BACKENDS: readonly string[] = [
  ...MISE_KNOWN_BACKENDS.filter((b) => !MISE_ALLOWED_BACKENDS.includes(b)), "pipx",
].sort();

const LINK_PATH = `${MISE_ROOT}/bin/fx-mise-link`;

/** Static text. It links each tool's install directory and records the exact version mise resolved. */
const LINK_SCRIPT = [
  "#!/bin/sh",
  "set -eu",
  `mkdir -p ${TOOLS_ROOT}`,
  `: > ${RESOLVED_TOOLS_FILE}`,
  'for t in "$@"; do',
  '  dir=$(mise where "$t")',
  `  ln -s "$dir" "${TOOLS_ROOT}/$t"`,
  `  printf '%s %s\\n' "$t" "$(basename "$dir")" >> ${RESOLVED_TOOLS_FILE}`,
  "done",
  "",
].join("\n");

/** The files the builder writes before mise runs: its pinned checksum, the link script, and the config body. */
export const miseFiles = (configText: string): LayerFile[] => [
  checksumFile("mise", MISE, MISE_BIN),
  { path: LINK_PATH, mode: "0555", content: LINK_SCRIPT },
  { path: MISE_CONFIG_FILE, mode: "0444", content: configText },
];

/** `env` options that give mise nothing but our files: no inherited variables, no repo directory, nothing trusted. */
const miseEnv: readonly string[] = [
  `HOME=${MISE_ROOT}/home`,
  `PATH=${MISE_ROOT}/bin:/usr/local/bin:/usr/bin:/bin`,
  `MISE_DATA_DIR=${MISE_ROOT}/data`,
  `MISE_CACHE_DIR=${MISE_ROOT}/cache`,
  `MISE_STATE_DIR=${MISE_ROOT}/state`,
  `MISE_CONFIG_DIR=${MISE_ROOT}/config`,
  `MISE_GLOBAL_CONFIG_FILE=${MISE_CONFIG_FILE}`,
  `MISE_SYSTEM_DIR=${MISE_ROOT}/system`,
  `MISE_CEILING_PATHS=/opt`,
  "MISE_TRUSTED_CONFIG_PATHS=",
  "MISE_YES=1",
];
const underMise = (...cmd: Argv): Argv => ["env", "-i", "-C", MISE_ROOT, ...miseEnv, ...cmd];

/** Install, link, then delete everything but the tools. `tools` must already be validated. */
export const miseSteps = (tools: readonly string[]): Argv[] => [
  ...downloadSteps("mise", MISE, MISE_BIN),
  ["chmod", "0755", MISE_BIN],
  underMise(MISE_BIN, "install"),
  underMise(LINK_PATH, ...tools),
  ["rm", "-rf", ...["bin", "config", "cache", "state", "home", "system", "data/downloads", "data/shims", "data/plugins"].map((d) => `${MISE_ROOT}/${d}`)],
  ["chown", "-R", "ubuntu:ubuntu", TOOLS_ROOT, `${MISE_ROOT}/data`],
];

/** The locked config text for validated `[tools]` entries (M-B1, M-B5, M-B6). Values are already regex-checked: no quote can occur. */
export function miseConfigText(tools: readonly (readonly [string, string])[]): string {
  const q = (s: string): string => `"${s}"`;
  const s = MISE_CONFIG.settings;
  return [
    "[settings]",
    `disable_backends = [${MISE_REFUSED_BACKENDS.map(q).join(", ")}]`,
    `enable_tools = [${tools.map(([t]) => q(t)).join(", ")}]`,
    `gpg_verify = ${s.gpg_verify}`,
    `not_found_auto_install = ${s.not_found_auto_install}`,
    `paranoid = ${s.paranoid}`,
    "[settings.node]",
    "gpg_verify = true",
    "[settings.aqua]",
    "cosign = true",
    "slsa = true",
    "minisign = true",
    "[settings.github]",
    "github_attestations = true",
    "[tools]",
    ...tools.map(([t, v]) => `${t} = ${q(v)}`),
    "",
  ].join("\n");
}
