/**
 * What `doctor` tells a person whose sandbox probe failed (D#6 R4a-5, correction C16 section 1.2): the exact commands for their
 * distro. The caller reads the machine's os-release text (and looks for the NixOS marker file); nothing here runs a command or reads a file.
 */
import type { SandboxReason } from "./probe.js";

export type Distro = "debian" | "ubuntu" | "fedora" | "arch" | "nixos" | "macos" | "other";

/** Ubuntu's own write-up of the restriction, and Claude Code's sandboxing page. Each is a single constant; the PR records that both resolve. */
export const UBUNTU_USERNS_URL = "https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces";
export const CLAUDE_SANDBOX_DOC_URL = "https://code.claude.com/docs/en/sandboxing";

/** Where the AppArmor profile for bubblewrap goes, and what is in it: user namespaces for `/usr/bin/bwrap` only. */
export const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/bwrap";
export const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap";
/** The profile for the bubblewrap the probe ran. A path with anything unusual in it is not printed into a profile; the usual one is named instead. */
export function apparmorProfile(bwrapPath: string | undefined): string[] {
  const target = bwrapPath !== undefined && /^\/[A-Za-z0-9._+/-]{1,200}$/.test(bwrapPath) && !bwrapPath.includes("..") ? bwrapPath : DEFAULT_BWRAP_PATH;
  return ["abi <abi/4.0>,", "", `profile bwrap ${target} flags=(unconfined) {`, "  userns,", "", "  include if exists <local/bwrap>", "}"];
}

export const INSTALL_COMMAND: Record<Exclude<Distro, "nixos" | "macos" | "other">, string> = {
  debian: "sudo apt-get install -y bubblewrap socat",
  ubuntu: "sudo apt-get install -y bubblewrap socat",
  fedora: "sudo dnf install -y bubblewrap socat",
  arch: "sudo pacman -S --needed bubblewrap socat",
};

export const NIXOS_CONFIG_LINE = "environment.systemPackages = [ pkgs.bubblewrap pkgs.socat ];";

function osReleaseValues(text: string, key: string): string[] {
  const entry = text.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
  return entry === undefined ? [] : entry.slice(key.length + 1).trim().replace(/^["']|["']$/g, "").toLowerCase().split(/\s+/).filter((word) => word !== "");
}

/** The distro family: the machine's own `ID` first, then the families it says it is like. */
export function detectDistro(input: { platform: NodeJS.Platform; osRelease: string | undefined; nixosMarker: boolean }): Distro {
  if (input.platform === "darwin") return "macos";
  if (input.nixosMarker) return "nixos";
  const text = input.osRelease ?? "";
  const names = [...osReleaseValues(text, "ID"), ...osReleaseValues(text, "ID_LIKE")];
  for (const name of ["nixos", "ubuntu", "debian", "fedora", "arch"] as const) if (names.includes(name)) return name;
  return "other";
}

const GENERIC_NEEDS = "Install bubblewrap (bwrap) and socat with your package manager, and allow unprivileged user namespaces (user.max_user_namespaces above 0).";

function installLines(distro: Distro): string[] {
  if (distro === "nixos") return [`Add this to your NixOS configuration: ${NIXOS_CONFIG_LINE}`, "Then run: sudo nixos-rebuild switch"];
  if (distro === "macos") return ["macOS has the sandbox built in (Seatbelt); there is nothing to install."];
  if (distro === "other") return [GENERIC_NEEDS];
  return [`Run: ${INSTALL_COMMAND[distro]}`];
}

/** The lines to print under a failed sandbox check. Nothing here is taken from the machine or from the tool's output. */
export function sandboxFixLines(distro: Distro, reason: SandboxReason, bwrapPath?: string): string[] {
  if (reason === "apparmor_userns_restricted") {
    return [
      "Preferred: allow user namespaces for bubblewrap only. Save this as " + APPARMOR_PROFILE_PATH + ":",
      ...apparmorProfile(bwrapPath).map((text) => (text === "" ? "" : `  ${text}`)),
      "The profile names the bubblewrap that was tested; if that path is a link, name the file it points to.",
      "Trade-off: with this profile any local program can create user namespaces by running that bubblewrap.",
      `Then load it: sudo apparmor_parser -r ${APPARMOR_PROFILE_PATH}`,
      "Weaker (it lifts the restriction for every program on this machine): sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0",
      `Why Ubuntu does this: ${UBUNTU_USERNS_URL}`,
      `Claude Code sandboxing: ${CLAUDE_SANDBOX_DOC_URL}`,
    ];
  }
  if (reason === "userns_disabled" && distro === "nixos") {
    // /etc is generated on NixOS, so the setting goes into the configuration.
    return [
      'Add this to your NixOS configuration: boot.kernel.sysctl."user.max_user_namespaces" = 15000;',
      "If your configuration sets security.allowUserNamespaces = false, set it to true instead.",
      "Then run: sudo nixos-rebuild switch",
      `Claude Code sandboxing: ${CLAUDE_SANDBOX_DOC_URL}`,
    ];
  }
  if (reason === "userns_disabled") {
    return [
      "Turn unprivileged user namespaces on: sudo sysctl -w user.max_user_namespaces=15000 (and, on older Debian kernels, sudo sysctl -w kernel.unprivileged_userns_clone=1).",
      "To keep it after a restart, put the same setting in a file under /etc/sysctl.d/.",
      `Claude Code sandboxing: ${CLAUDE_SANDBOX_DOC_URL}`,
    ];
  }
  if (reason === "probe_failed_other" && distro !== "other" && distro !== "macos") {
    return [...installLines(distro), `Check that unprivileged user namespaces are allowed. Claude Code sandboxing: ${CLAUDE_SANDBOX_DOC_URL}`];
  }
  return [...installLines(distro), ...(distro === "macos" ? [] : [`Claude Code sandboxing: ${CLAUDE_SANDBOX_DOC_URL}`])];
}
