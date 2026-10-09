#!/bin/sh
# fx-runner installer (D#6 R6-4). POSIX sh. It never uses sudo by itself and never edits a shell profile.
#
#   sh install.sh [--yes] [--non-interactive]     install (or re-link) this release
#   sh install.sh --uninstall                     remove bin/fx-runner and versions/; the registration and keys stay
#
# What it does, in order:
#   1. refuses native Windows and WSL, notes the macOS preview, and picks the artifact for this machine;
#   2. downloads that artifact over HTTPS and checks its SHA-256 against the value baked into THIS copy of the script (R6-5
#      writes the values in when it renders the release copy; an unrendered copy refuses to install). The script's own trust
#      is HTTPS to GitHub Releases; later updates are verified through the signed update metadata, not here;
#   3. installs into <state dir>/versions/<version>/ and links <state dir>/bin/fx-runner (a rerun is idempotent, a new
#      version lands beside the old one);
#   4. on Linux, offers to install a missing bwrap or socat (shows the exact command, asks first, asks even as root);
#   5. runs `fx-runner doctor --sandbox-only`; a failed probe leaves fx-runner installed and exits 3;
#   6. checks that Claude Code is installed (absolute path, version at least MIN_CLAUDE_VERSION). It never downloads it;
#      a missing or old one prints the official install line and exits 4.
# Exit codes: 0 done, 1 install failed (download, checksum, unusable file, a symlink or wrong file type in the state
# directory), 2 refused or bad use (platform, options, an unsafe state directory, an unrendered copy), 3 sandbox probe
# failed, 4 Claude Code missing or too old. When both 3 and 4 apply, 3 is reported.
#
# Safety properties (each has a test):
#   - the whole body lives in main(), called on the last line, so a truncated copy (or a download cut short and piped to a
#     shell) is a syntax error or does nothing; it never runs the first half and reports success;
#   - every child process gets an explicit stdin, so piping this script into a shell cannot have the rest of it eaten by a
#     child: the downloaded binary and the Claude Code check read /dev/null, the package manager reads the terminal;
#   - the downloaded binary runs with NODE_OPTIONS and NODE_PATH cleared (the Node runtime honours both, and the caller's
#     environment is not ours to trust for a binary that is only now being checked);
#   - the state directory is validated before anything is written or removed: absolute, no . or .. segments, not the root,
#     and not your home directory or a parent of it. versions/, bin/ and versions/<version> must be real directories and
#     bin/fx-runner a symlink or absent, otherwise nothing is changed;
#   - uninstall removes only bin/fx-runner (then bin/, if that leaves it empty) and versions/.
#
# Test seams (all harmless in real use): FX_INSTALL_BASE_URL replaces the release download base (it must still be https, and
# the baked checksum still has to match), FX_INSTALL_OS_RELEASE_FILE, FX_INSTALL_PROC_VERSION_FILE and
# FX_INSTALL_NIXOS_MARKER replace the os-release file, /proc/version and the NixOS marker file.

set -eu

# --- values rendered by the release workflow (R6-5); the placeholders below are replaced by sed ---
FX_VERSION="@FX_VERSION@"
FX_SHA256_DARWIN_ARM64="@FX_SHA256_DARWIN_ARM64@"
FX_SHA256_DARWIN_X64="@FX_SHA256_DARWIN_X64@"
FX_SHA256_LINUX_X64="@FX_SHA256_LINUX_X64@"
FX_SHA256_LINUX_ARM64="@FX_SHA256_LINUX_ARM64@"

# --- constants other files must agree with (each one has a test) ---
# The release file names: exactly the output of `node scripts/release-manifest.mjs --names`.
FX_ARTIFACT_NAMES="darwin-arm64 fx-runner-darwin-arm64
darwin-x64 fx-runner-darwin-x64
linux-x64 fx-runner-linux-x64
linux-arm64 fx-runner-linux-arm64"
# src/engines/claude/pin.ts: MIN_CLAUDE_VERSION
MIN_CLAUDE_VERSION="2.1.294"
# src/platformSupport.ts
WINDOWS_UNSUPPORTED_NOTICE="fx-runner does not support Windows yet, including WSL2. Linux and macOS are supported."
MACOS_PREVIEW_NOTICE="macOS support is a preview, not yet verified: jobs run in Claude Code's own sandbox, which has not been proven on macOS yet."
# src/sandbox/sandboxFix.ts: INSTALL_COMMAND (each is printed with "sudo " in front) and NIXOS_CONFIG_LINE
PKG_APT="apt-get install -y bubblewrap socat"
PKG_DNF="dnf install -y bubblewrap socat"
PKG_PACMAN="pacman -S --needed bubblewrap socat"
NIXOS_CONFIG_LINE="environment.systemPackages = [ pkgs.bubblewrap pkgs.socat ];"
GENERIC_DEPS_LINE="Install bubblewrap (bwrap) and socat with your package manager, and allow unprivileged user namespaces (user.max_user_namespaces above 0)."

FX_RELEASE_REPO="fulcrumaxe/fulcrumaxe-cloud"
CLAUDE_INSTALL_LINE="curl -fsSL https://claude.ai/install.sh | bash"

# --- helpers (definitions only; nothing runs until main is called on the last line) ---
say() { printf '%s\n' "$*"; }
note() { printf 'fx-runner install: %s\n' "$*" >&2; }
die() {
  _code=$1
  shift
  note "$*"
  exit "$_code"
}

# Runs a command with the caller's Node settings removed. Every caller gives it an explicit stdin.
run_clean() {
  (
    unset NODE_OPTIONS NODE_PATH
    exec "$@"
  )
}

# Refuses, and changes nothing, when the state directory holds a symlink or the wrong kind of file where this script is
# about to write or remove something. $FX_HOME itself may be a symlink (check_home_not_precious resolves it).
check_layout() {
  for _name in versions bin; do
    _p=$FX_HOME/$_name
    if [ -L "$_p" ]; then
      die 1 "$_p is a symbolic link; refusing to follow it. Nothing was changed."
    elif [ -e "$_p" ] && [ ! -d "$_p" ]; then
      die 1 "$_p is not a directory. Nothing was changed."
    fi
  done
  _p=$FX_HOME/bin/fx-runner
  if [ -e "$_p" ] && [ ! -L "$_p" ]; then
    die 1 "$_p is not a symbolic link made by this installer (it is a file or a directory). Nothing was changed."
  fi
  if [ -n "${1:-}" ]; then
    _p=$FX_HOME/versions/$1
    if [ -L "$_p" ]; then
      die 1 "$_p is a symbolic link; refusing to follow it. Nothing was changed."
    elif [ -e "$_p" ] && [ ! -d "$_p" ]; then
      die 1 "$_p is not a directory. Nothing was changed."
    fi
  fi
}

# Refuses the filesystem root, the user's home directory and any parent of it, once symlinks are resolved.
check_home_not_precious() {
  FX_HOME_REAL=$(cd "$FX_HOME" && pwd -P) || die 1 "cannot enter the state directory $FX_HOME"
  [ "$FX_HOME_REAL" != / ] || die 2 "the state directory must not be /"
  if [ -n "${HOME:-}" ] && [ -d "$HOME" ]; then
    _home_real=$(cd "$HOME" && pwd -P) || _home_real=
    case "$_home_real/" in
      "$FX_HOME_REAL"/*) die 2 "the state directory $FX_HOME is your home directory or a parent of it; use a dedicated directory such as $HOME/.fx-runner" ;;
    esac
  fi
}

check_sha() {
  # $1 = platform, $2 = value
  case $2 in
    *[!0-9a-f]* | '') die 2 "this copy of install.sh has no checksum for $1; download install.sh from a release page." ;;
  esac
  [ "${#2}" = 64 ] || die 2 "this copy of install.sh has a malformed checksum for $1"
}

# --- C16: sandbox dependencies (Linux) ---
confirm() {
  # reads one line from the terminal; anything but y/yes is a no
  if [ -t 0 ]; then
    read -r _ans || _ans=n
  else
    read -r _ans </dev/tty || _ans=n
  fi
  case $_ans in y | Y | yes | YES | Yes) return 0 ;; *) return 1 ;; esac
}
have_terminal() {
  if [ -t 0 ]; then return 0; fi
  # the subshell keeps a failed open of /dev/tty from ending the script
  (: </dev/tty) 2>/dev/null
}
offer_deps() {
  missing=
  command -v bwrap >/dev/null 2>&1 || missing="bwrap"
  command -v socat >/dev/null 2>&1 || missing="${missing:+$missing and }socat"
  [ -n "$missing" ] || return 0

  distro=other
  if [ -e "$NIXOS_MARKER" ]; then
    distro=nixos
  elif [ -r "$OS_RELEASE_FILE" ]; then
    ids=$(sed -n -e 's/^ID=//p' -e 's/^ID_LIKE=//p' "$OS_RELEASE_FILE" | tr -d "\"'" | tr '[:upper:]' '[:lower:]' | tr '\n' ' ')
    for family in nixos ubuntu debian fedora arch; do
      case " $ids " in *" $family "*)
        distro=$family
        break
        ;;
      esac
    done
  fi
  case $distro in
    ubuntu | debian) pkg=$PKG_APT ;;
    fedora) pkg=$PKG_DNF ;;
    arch) pkg=$PKG_PACMAN ;;
    *) pkg= ;;
  esac

  note "missing for the sandbox: $missing"
  if [ "$distro" = nixos ]; then
    say "Add this to your NixOS configuration: $NIXOS_CONFIG_LINE"
    say "Then run: sudo nixos-rebuild switch"
    return 0
  fi
  if [ -z "$pkg" ]; then
    say "$GENERIC_DEPS_LINE"
    return 0
  fi
  say "Run: sudo $pkg"
  # Only a person at a terminal is asked. No terminal, or CI / --non-interactive without --yes: print and stop.
  if ! have_terminal; then return 0; fi
  if [ "$ASSUME_YES" = 0 ] && { [ "$NON_INTERACTIVE" = 1 ] || [ -n "${CI:-}" ]; }; then return 0; fi
  if [ "$ASSUME_YES" = 1 ]; then
    answer=yes
  else
    printf 'Run it now? [y/N] ' >&2
    if confirm; then answer=yes; else answer=no; fi
  fi
  if [ "$answer" != yes ]; then
    say "Not installed. Run the command above yourself, then 'fx-runner doctor --sandbox-only'."
    return 0
  fi
  # The package manager reads the terminal, never this script (pacman, for one, can prompt); a terminal exists at this point.
  # shellcheck disable=SC2086 # $pkg is a fixed word list from this file
  if [ "$(id -u)" = 0 ]; then
    $pkg </dev/tty || note "the package command failed; the sandbox check below will say what is still missing"
  else
    # shellcheck disable=SC2086,SC2024 # the terminal is opened by this shell on purpose; sudo only inherits it
    sudo $pkg </dev/tty || note "the package command failed; the sandbox check below will say what is still missing"
  fi
}

# --- C19: the installed Claude Code CLI. Checked, never downloaded. ---
version_at_least() {
  # $1 = version found, $2 = minimum; both are x.y.z
  IFS=. read -r a1 a2 a3 <<EOF
$1
EOF
  IFS=. read -r b1 b2 b3 <<EOF
$2
EOF
  for pair in "$a1 $b1" "$a2 $b2" "$a3 $b3"; do
    # shellcheck disable=SC2086
    set -- $pair
    if [ "$1" -gt "$2" ]; then return 0; fi
    if [ "$1" -lt "$2" ]; then return 1; fi
  done
  return 0
}

main() {
  ASSUME_YES=0
  NON_INTERACTIVE=0
  UNINSTALL=0
  for arg in "$@"; do
    case $arg in
      --yes) ASSUME_YES=1 ;;
      --non-interactive) NON_INTERACTIVE=1 ;;
      --uninstall) UNINSTALL=1 ;;
      *) die 2 "unknown option: $arg (use --yes, --non-interactive or --uninstall)" ;;
    esac
  done

  # --- the state directory (same rule as the runner: FX_RUNNER_HOME, else ~/.fx-runner) ---
  if [ -n "${FX_RUNNER_HOME:-}" ]; then
    FX_HOME=$FX_RUNNER_HOME
  elif [ -n "${HOME:-}" ]; then
    FX_HOME=$HOME/.fx-runner
  else
    die 2 "HOME is not set; set FX_RUNNER_HOME to the state directory"
  fi
  case $FX_HOME in
    /*) ;;
    *) die 2 "the state directory must be an absolute path: $FX_HOME" ;;
  esac
  # normalise: trailing slashes go; what is left must not be empty (the root) and must have no . or .. segment
  while :; do
    case $FX_HOME in
      */) FX_HOME=${FX_HOME%/} ;;
      *) break ;;
    esac
  done
  [ -n "$FX_HOME" ] || die 2 "the state directory must not be /"
  case $FX_HOME in
    */. | */.. | */./* | */../*) die 2 "the state directory must not contain . or .. segments: $FX_HOME" ;;
  esac

  # --- uninstall: bin/fx-runner, then bin/ if empty, and versions/ ---
  if [ "$UNINSTALL" = 1 ]; then
    if [ ! -d "$FX_HOME" ]; then
      say "Nothing to remove: $FX_HOME does not exist."
      exit 0
    fi
    check_home_not_precious
    check_layout
    if [ -e "$FX_HOME/registration.json" ] || [ -e "$FX_HOME/runner-key.pem" ]; then
      note "your registration and keys in $FX_HOME stay. To remove this runner from the cloud, run 'fx-runner revoke' first (it needs the binary this command removes)."
    fi
    rm -f "$FX_HOME/bin/fx-runner"
    # rmdir fails, harmlessly, when bin/ holds anything else
    if [ -d "$FX_HOME/bin" ]; then rmdir "$FX_HOME/bin" 2>/dev/null || note "$FX_HOME/bin holds other files and stays."; fi
    rm -rf "${FX_HOME:?}/versions"
    say "Removed $FX_HOME/bin/fx-runner and $FX_HOME/versions."
    exit 0
  fi

  # --- platform ---
  OS_NAME=$(uname -s)
  ARCH_NAME=$(uname -m)
  OS_RELEASE_FILE=${FX_INSTALL_OS_RELEASE_FILE:-/etc/os-release}
  PROC_VERSION_FILE=${FX_INSTALL_PROC_VERSION_FILE:-/proc/version}
  NIXOS_MARKER=${FX_INSTALL_NIXOS_MARKER:-/etc/NIXOS}

  case $OS_NAME in
    Linux)
      OS=linux
      if [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ]; then
        die 2 "$WINDOWS_UNSUPPORTED_NOTICE"
      fi
      if [ -r "$PROC_VERSION_FILE" ] && grep -qi 'microsoft' "$PROC_VERSION_FILE" 2>/dev/null; then
        die 2 "$WINDOWS_UNSUPPORTED_NOTICE"
      fi
      ;;
    Darwin) OS=darwin ;;
    MINGW* | MSYS* | CYGWIN* | Windows*) die 2 "$WINDOWS_UNSUPPORTED_NOTICE" ;;
    *) die 2 "unsupported operating system: $OS_NAME. Linux and macOS are supported." ;;
  esac
  case $ARCH_NAME in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die 2 "unsupported CPU: $ARCH_NAME. x86-64 and arm64 are supported." ;;
  esac
  # A shell started under Rosetta on an Apple-silicon Mac reports x86_64; the native build is the one to install.
  if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && command -v sysctl >/dev/null 2>&1; then
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then ARCH=arm64; fi
  fi
  PLATFORM=$OS-$ARCH
  if [ "$OS" = darwin ]; then note "$MACOS_PREVIEW_NOTICE"; fi

  ARTIFACT=$(printf '%s\n' "$FX_ARTIFACT_NAMES" | while read -r p n; do
    if [ "$p" = "$PLATFORM" ]; then
      printf '%s' "$n"
      break
    fi
  done)
  [ -n "$ARTIFACT" ] || die 2 "no release file for $PLATFORM"
  case $PLATFORM in
    darwin-arm64) WANT_SHA=$FX_SHA256_DARWIN_ARM64 ;;
    darwin-x64) WANT_SHA=$FX_SHA256_DARWIN_X64 ;;
    linux-x64) WANT_SHA=$FX_SHA256_LINUX_X64 ;;
    linux-arm64) WANT_SHA=$FX_SHA256_LINUX_ARM64 ;;
    *) die 2 "no release file for $PLATFORM" ;;
  esac

  # --- this copy must have been fully rendered by a release: the version and ALL four checksums, not only this platform's ---
  case $FX_VERSION in
    '' | *[!0-9A-Za-z.+-]* | @*) die 2 "this copy of install.sh was not rendered by a release (no version). Download install.sh from a release page." ;;
  esac
  case $FX_VERSION in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) die 2 "this copy of install.sh has a malformed version" ;;
  esac
  check_sha darwin-arm64 "$FX_SHA256_DARWIN_ARM64"
  check_sha darwin-x64 "$FX_SHA256_DARWIN_X64"
  check_sha linux-x64 "$FX_SHA256_LINUX_X64"
  check_sha linux-arm64 "$FX_SHA256_LINUX_ARM64"

  # --- tools ---
  command -v curl >/dev/null 2>&1 || die 1 "curl is required"
  if command -v sha256sum >/dev/null 2>&1; then
    sha_of() { sha256sum "$1" | cut -d ' ' -f 1; }
  elif command -v shasum >/dev/null 2>&1; then
    sha_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
  else
    die 1 "neither sha256sum nor shasum was found, so the download cannot be checked"
  fi

  VERSION_DIR=$FX_HOME/versions/$FX_VERSION
  BIN=$VERSION_DIR/fx-runner
  LINK=$FX_HOME/bin/fx-runner
  BASE_URL=${FX_INSTALL_BASE_URL:-https://github.com/$FX_RELEASE_REPO/releases/download}
  URL=$BASE_URL/v$FX_VERSION/$ARTIFACT

  # --- the state directory exists and is a safe place; nothing inside it is a symlink we would follow ---
  umask 077
  if [ ! -d "$FX_HOME" ]; then
    [ ! -e "$FX_HOME" ] || die 1 "$FX_HOME exists and is not a directory"
    mkdir -p "$FX_HOME"
  fi
  check_home_not_precious
  check_layout "$FX_VERSION"

  # --- download, check, install ---
  if [ -f "$BIN" ] && [ ! -L "$BIN" ] && [ "$(sha_of "$BIN")" = "$WANT_SHA" ]; then
    say "fx-runner $FX_VERSION is already installed."
  else
    STAGE=$(mktemp -d "$FX_HOME/.install.XXXXXX")
    trap 'rm -rf "$STAGE"' EXIT
    trap 'exit 1' HUP INT TERM
    say "Downloading $ARTIFACT $FX_VERSION ..."
    if ! curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL -o "$STAGE/$ARTIFACT" "$URL"; then
      die 1 "the download failed: $URL"
    fi
    GOT_SHA=$(sha_of "$STAGE/$ARTIFACT")
    if [ "$GOT_SHA" != "$WANT_SHA" ]; then
      die 1 "the downloaded file does not match the checksum in this installer (expected $WANT_SHA, got $GOT_SHA). Nothing was installed."
    fi
    chmod 755 "$STAGE/$ARTIFACT"
    if ! run_clean "$STAGE/$ARTIFACT" --version </dev/null >/dev/null 2>&1; then
      die 1 "the downloaded file matches its checksum but does not run on this machine. Nothing was installed."
    fi
    mkdir -p "$FX_HOME/versions"
    rm -rf "$VERSION_DIR"
    mkdir "$VERSION_DIR"
    mv "$STAGE/$ARTIFACT" "$BIN"
    say "Installed fx-runner $FX_VERSION to $VERSION_DIR."
  fi
  mkdir -p "$FX_HOME/bin"
  # check_layout made sure the old link, if any, is a symlink. Removing it first means the new one can never be created
  # inside a directory the old one pointed at (mv onto a symlink to a directory moves into it).
  rm -f "$LINK"
  ln -s "../versions/$FX_VERSION/fx-runner" "$LINK"

  if [ "$OS" = linux ]; then offer_deps; fi

  # --- C16: the sandbox probe. A failure leaves fx-runner installed. ---
  EXIT_CODE=0
  if run_clean "$LINK" doctor --sandbox-only </dev/null; then
    say "Sandbox check passed."
  else
    note "the sandbox check failed (see above). fx-runner is installed; fix that, then run: fx-runner doctor --sandbox-only"
    EXIT_CODE=3
  fi

  # --- C19: Claude Code ---
  CLAUDE_PATH=$(command -v claude 2>/dev/null || true)
  CLAUDE_PROBLEM=
  case $CLAUDE_PATH in
    /*)
      if [ ! -x "$CLAUDE_PATH" ]; then
        CLAUDE_PROBLEM="Claude Code was not found (claude is not an executable file)."
      else
        CLAUDE_VERSION=$("$CLAUDE_PATH" --version </dev/null 2>/dev/null | head -n 1 | sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' || true)
        if [ -z "$CLAUDE_VERSION" ]; then
          CLAUDE_PROBLEM="Claude Code at $CLAUDE_PATH did not report a version."
        elif ! version_at_least "$CLAUDE_VERSION" "$MIN_CLAUDE_VERSION"; then
          CLAUDE_PROBLEM="Claude Code $CLAUDE_VERSION at $CLAUDE_PATH is older than $MIN_CLAUDE_VERSION."
        else
          say "Claude Code $CLAUDE_VERSION found at $CLAUDE_PATH."
        fi
      fi
      ;;
    *) CLAUDE_PROBLEM="Claude Code was not found on your PATH." ;;
  esac
  if [ -n "$CLAUDE_PROBLEM" ]; then
    note "$CLAUDE_PROBLEM fx-runner needs Claude Code $MIN_CLAUDE_VERSION or newer, installed and signed in by you. To install or update it, run Anthropic's installer yourself:"
    note "  $CLAUDE_INSTALL_LINE"
    if [ "$EXIT_CODE" = 0 ]; then EXIT_CODE=4; fi
  fi

  # --- next step ---
  case ":${PATH:-}:" in
    *":$FX_HOME/bin:"*) ;;
    *) say "Add fx-runner to your PATH: export PATH=\"$FX_HOME/bin:\$PATH\"" ;;
  esac
  say "Next: fx-runner register --code <code> --credential-mode <subscription|api_key> --cloud-url <url>"
  exit "$EXIT_CODE"
}

main "$@"
