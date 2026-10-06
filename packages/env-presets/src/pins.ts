/**
 * Tool binaries the presets pin by sha256 (D#5 C3 section 5.6, 6.1 and 7). Each hash was checked by downloading
 * the artifact and hashing it; the pin is data, so a bump is a reviewed change to this file and nothing else.
 * All three are linux x86_64, the only platform the sandbox runs on.
 */
export interface BinaryPin { readonly version: string; readonly url: string; readonly sha256: string }

/** rustup-init (not rustup itself): the installer runs in the image build, with a fixed distribution host. */
export const RUSTUP_INIT: BinaryPin = {
  version: "1.29.1",
  url: "https://static.rust-lang.org/rustup/archive/1.29.1/x86_64-unknown-linux-gnu/rustup-init",
  sha256: "dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71",
};

/** The default Rust toolchain: an exact version, never the moving `stable` (C3 section 6.1, M-B12). */
export const RUST_DEFAULT_TOOLCHAIN = "1.93.0";

/** M-B9 and M-B12: the distribution hosts are ours to fix, so a customer env key cannot redirect rustup. */
export const RUSTUP_HOSTS = {
  RUSTUP_DIST_SERVER: "https://static.rust-lang.org",
  RUSTUP_UPDATE_ROOT: "https://static.rust-lang.org/rustup",
} as const;

/** sccache: the compiler wrapper for the rust and cpp presets. A gzip tarball holding `<dir>/sccache`. */
export const SCCACHE: BinaryPin & { readonly dir: string } = {
  version: "0.18.0",
  url: "https://github.com/mozilla/sccache/releases/download/v0.18.0/sccache-v0.18.0-x86_64-unknown-linux-musl.tar.gz",
  sha256: "45f1447fbe231e3037bde351ef70677dd212216c8d62ae7ca409fecc4d6acc89",
  dir: "sccache-v0.18.0-x86_64-unknown-linux-musl",
};

/**
 * mise, the one tool that reads the repo's version files. It runs only in the builder (M-B4), so it is data
 * here and no preset layer installs it: the image a run starts from never contains mise (M-B10).
 */
export const MISE: BinaryPin = {
  version: "2026.10.2",
  url: "https://github.com/jdx/mise/releases/download/v2026.10.2/mise-v2026.10.2-linux-x64",
  sha256: "8f5f6660336f572830e33cd9b378d3131e529a0d4c4f0c553776be90a1ba302a",
};

/**
 * The locked mise configuration (C3 section 5.6, M-B1, M-B6, M-B10). The builder renders it into a directory
 * outside the repo; mise never reads the repo's own config. Reading `.nvmrc`, `.node-version` and
 * `.python-version` is opt-in per tool in mise, so each is listed with the one tool it feeds. `rust-toolchain`
 * files are absent on purpose: rustup reads those, not mise.
 */
export const MISE_CONFIG = {
  versionFiles: {
    ".nvmrc": "node",
    ".node-version": "node",
    ".python-version": "python",
    ".tool-versions": "any",
    "mise.toml": "any",
    ".mise.toml": "any",
  },
  settings: {
    not_found_auto_install: false,
    paranoid: true,
    gpg_verify: true,
  },
} as const;
