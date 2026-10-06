import { RUSTUP_HOSTS, RUSTUP_INIT, RUST_DEFAULT_TOOLCHAIN, SCCACHE, type BinaryPin } from "./pins.js";
import type { Argv, Layer, LayerFile, Preset, PresetId } from "./types.js";

/** ubuntu:26.04 resolved on Docker Hub (registry-1.docker.io, library/ubuntu, index digest) on 2026-09-30. */
const UBUNTU_2604 = "docker.io/library/ubuntu@sha256:da6fc2be547864451aa253836dd926da33623312df4a9a243e35dc877c378a78";

/**
 * The laptop basics (D#5 C3 section 5.1): exactly these seven, no more. Adding one needs a PM correction.
 * Each is pinned to major.minor with a separator before the `*`, so `1.8.*` cannot match `1.80`. Versions are
 * the ubuntu 26.04 (resolute) ones on 2026-10-05. `ca-certificates` is date-versioned (YYYYMMDD), so its only
 * stable prefix is the year; it is the one pin without a separator and DATE_VERSIONED names it.
 */
const BASE_TOOLS: readonly string[] = [
  "ca-certificates=2026*",
  "git=1:2.53.*",
  "curl=8.18.*",
  "build-essential=12.12ubuntu*",
  "jq=1.8.*",
  "unzip=6.0-*",
  "openssh-client=1:10.2p1-*",
];

/** Packages whose version is a fixed-width date, so no separator exists to put before the `*`. */
export const DATE_VERSIONED: readonly string[] = ["ca-certificates"];

/** The package names of BASE_TOOLS, for the "exactly these seven" test and for consumers. */
export const BASE_TOOL_NAMES: readonly string[] = BASE_TOOLS.map((p) => p.slice(0, p.indexOf("=")));

/** What every preset's smoke set gains with the laptop basics (C3 section 5.1). */
export const BASE_SMOKE_COMMANDS: readonly Argv[] = [
  ["git", "--version"],
  ["curl", "--version"],
  ["jq", "--version"],
  ["ssh", "-V"],
  ["make", "--version"],
  ["unzip", "-v"],
];

/**
 * Vercel's published sandbox setup (vercel/sandbox images/ubuntu/Dockerfile): sudo, a passwordless-sudo
 * `ubuntu` user, HOME=/vercel and WORKDIR /vercel. Shared as the first layer of every preset. It also carries
 * the laptop basics. It is not a toolchain layer: it declares none, and the one-toolchain test exempts it by name.
 */
const sandboxBase: Layer = {
  id: "sandbox-base",
  toolchains: [],
  aptPackages: [...BASE_TOOLS, "sudo"],
  files: [{
    path: "/etc/sudoers.d/sandbox",
    mode: "0440",
    content: "Defaults always_set_home\nDefaults !env_reset\nDefaults !fqdn\nubuntu ALL=(ALL) NOPASSWD:ALL\n",
  }],
  steps: [
    ["install", "-d", "-o", "ubuntu", "-g", "ubuntu", "/vercel"],
    ["usermod", "--home", "/vercel", "ubuntu"],
    ["chown", "-R", "ubuntu:ubuntu", "/vercel"],
  ],
};

export const PINS_DIR = "/usr/local/share/fx-pins";

/** The checksum file `sha256sum -c` reads: argv-only steps cannot pipe a hash into it. */
export const checksumFile = (name: string, pin: BinaryPin, target: string): LayerFile =>
  ({ path: `${PINS_DIR}/${name}.sha256`, mode: "0444", content: `${pin.sha256}  ${target}\n` });

/** Download over https, refuse anything but the pinned bytes. The curl and ca-certificates come from sandbox-base. */
export const downloadSteps = (name: string, pin: BinaryPin, target: string): Argv[] => [
  ["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--tlsv1.2", "--output", target, pin.url],
  ["sha256sum", "--check", "--strict", `${PINS_DIR}/${name}.sha256`],
];

/** sccache into /usr/local/bin, shared by the rust and cpp layers. Wiring RUSTC_WRAPPER is E15's job. */
const sccache = {
  files: [checksumFile("sccache", SCCACHE, "/tmp/sccache.tar.gz")],
  steps: [
    ...downloadSteps("sccache", SCCACHE, "/tmp/sccache.tar.gz"),
    ["tar", "--extract", "--gzip", "--file", "/tmp/sccache.tar.gz", "--directory", "/usr/local/bin", "--strip-components=1", `${SCCACHE.dir}/sccache`],
    ["rm", "--force", "/tmp/sccache.tar.gz"],
  ] as Argv[],
};

const toolchain = (id: string, aptPackages: readonly string[], extra: Partial<Layer> = {}): Layer =>
  ({ id, toolchains: [id], aptPackages, files: [], steps: [], ...extra });

/**
 * Rust through rustup, not apt (C3 section 6.1): rustup-init pinned by sha256, an exact default toolchain, and
 * the distribution hosts fixed so no customer env key can move them. It lives in /usr/local so a toolchain
 * switch by the `ubuntu` user (who owns it) works with the image's default HOME.
 */
const rustLayer: Layer = toolchain("rust-1.93", [], {
  env: {
    RUSTUP_HOME: "/usr/local/rustup",
    CARGO_HOME: "/usr/local/cargo",
    ...RUSTUP_HOSTS,
    PATH: "/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  },
  files: [checksumFile("rustup-init", RUSTUP_INIT, "/tmp/rustup-init"), ...sccache.files],
  steps: [
    ...downloadSteps("rustup-init", RUSTUP_INIT, "/tmp/rustup-init"),
    ["chmod", "0755", "/tmp/rustup-init"],
    ["/tmp/rustup-init", "-y", "--no-modify-path", "--profile", "minimal", "--default-toolchain", RUST_DEFAULT_TOOLCHAIN],
    ["rm", "--force", "/tmp/rustup-init"],
    ["chown", "-R", "ubuntu:ubuntu", "/usr/local/rustup", "/usr/local/cargo"],
    ...sccache.steps,
  ],
});

const preset = (id: PresetId, layer: Layer, smokeCommand: Argv, extraSmoke: readonly Argv[] = []): Preset => ({
  id,
  base: UBUNTU_2604,
  runtime: { user: "ubuntu", home: "/vercel", workdir: "/vercel" },
  layers: [sandboxBase, layer],
  smokeCommand,
  smokeCommands: [smokeCommand, ...extraSmoke, ...BASE_SMOKE_COMMANDS],
});

/** Deep-freezes the finished data so no consumer can mutate a preset in place. */
const freeze = <T>(v: T): T => {
  if (v !== null && typeof v === "object") for (const x of Object.values(v)) freeze(x);
  return Object.freeze(v);
};

const SCCACHE_SMOKE: Argv = ["sccache", "--version"];

export const PRESETS: readonly Preset[] = freeze([
  preset("rust", rustLayer, ["cargo", "--version"], [SCCACHE_SMOKE]),
  // golang-go is 2:1.26~1 on 26.04 (a pre-release tilde), so its separator is `~`; `2:1.26.*` matches nothing.
  preset("go",toolchain("go-1.26", ["golang-go=2:1.26~*"]), ["go", "version"]),
  preset("jvm", toolchain("openjdk-25", ["openjdk-25-jdk-headless=25.0.*"]), ["java", "-version"]),
  preset("dotnet", toolchain("dotnet-10.0", ["dotnet-sdk-10.0=10.0.*"]), ["dotnet", "--version"]),
  preset("ruby", toolchain("ruby-3.3", ["ruby=1:3.3build*"]), ["ruby", "--version"]),
  preset("php", toolchain("php-8.5", ["php-cli=2:8.5+*"]), ["php", "--version"]),
  preset("cpp", toolchain("gcc-15", ["g++=4:15.2.*", "build-essential=12.12ubuntu*"], sccache), ["g++", "--version"], [SCCACHE_SMOKE]),
  preset("node", toolchain("node-22", ["nodejs=22.22.*"]), ["node", "--version"]),
  preset("python", toolchain("python-3.14", ["python3=3.14.*"]), ["python3", "--version"]),
]);
