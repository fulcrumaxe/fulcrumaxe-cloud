import { describe, expect, it } from "vitest";
import type { SandboxReason } from "../src/sandbox/probe.js";
import { APPARMOR_PROFILE_PATH, CLAUDE_SANDBOX_DOC_URL, DEFAULT_BWRAP_PATH, UBUNTU_USERNS_URL, apparmorProfile, detectDistro, sandboxFixLines, type Distro } from "../src/sandbox/sandboxFix.js";

const osRelease = (...lines: string[]): string => `${lines.join("\n")}\n`;
const detect = (text: string | undefined, over: { platform?: NodeJS.Platform; nixosMarker?: boolean } = {}): Distro => detectDistro({ platform: over.platform ?? "linux", osRelease: text, nixosMarker: over.nixosMarker ?? false });

describe("which distro this is", () => {
  it("reads the machine's own ID first, then the families it says it is like", () => {
    expect(detect(osRelease('NAME="Debian GNU/Linux"', "ID=debian"))).toBe("debian");
    expect(detect(osRelease('NAME="Ubuntu"', "ID=ubuntu", "ID_LIKE=debian"))).toBe("ubuntu");
    expect(detect(osRelease('ID="pop"', 'ID_LIKE="ubuntu debian"'))).toBe("ubuntu");
    expect(detect(osRelease("ID=linuxmint", "ID_LIKE=ubuntu debian"))).toBe("ubuntu");
    expect(detect(osRelease("ID=fedora"))).toBe("fedora");
    expect(detect(osRelease('ID="rhel"', 'ID_LIKE="fedora"'))).toBe("fedora");
    expect(detect(osRelease("ID=arch"))).toBe("arch");
    expect(detect(osRelease("ID=manjaro", "ID_LIKE=arch"))).toBe("arch");
    expect(detect(osRelease("ID=nixos"))).toBe("nixos");
    expect(detect(osRelease("ID=alpine"))).toBe("other");
    expect(detect(undefined)).toBe("other");
  });

  it("NixOS is also told by its marker file, and macOS by the platform", () => {
    expect(detect(undefined, { nixosMarker: true })).toBe("nixos");
    expect(detect(osRelease("ID=ubuntu"), { nixosMarker: true })).toBe("nixos");
    expect(detect(undefined, { platform: "darwin" })).toBe("macos");
  });
});

const link = (text: string): string => `Claude Code sandboxing: ${text}`;

describe("the exact fix text, per distro", () => {
  const missing: Array<[Distro, string[]]> = [
    ["debian", ["Run: sudo apt-get install -y bubblewrap socat"]],
    ["ubuntu", ["Run: sudo apt-get install -y bubblewrap socat"]],
    ["fedora", ["Run: sudo dnf install -y bubblewrap socat"]],
    ["arch", ["Run: sudo pacman -S --needed bubblewrap socat"]],
    ["nixos", ["Add this to your NixOS configuration: environment.systemPackages = [ pkgs.bubblewrap pkgs.socat ];", "Then run: sudo nixos-rebuild switch"]],
    ["other", ["Install bubblewrap (bwrap) and socat with your package manager, and allow unprivileged user namespaces (user.max_user_namespaces above 0)."]],
  ];
  for (const reason of ["bwrap_missing", "socat_missing"] as const) {
    for (const [distro, lines] of missing) {
      it(`${reason} on ${distro}`, () => {
        expect(sandboxFixLines(distro, reason)).toEqual([...lines, link(CLAUDE_SANDBOX_DOC_URL)]);
      });
    }
  }

  it("macOS has nothing to install", () => {
    expect(sandboxFixLines("macos", "probe_failed_other")).toEqual(["macOS has the sandbox built in (Seatbelt); there is nothing to install."]);
  });

  it("probe_failed_other on a known distro adds the install line and the user-namespace pointer", () => {
    expect(sandboxFixLines("fedora", "probe_failed_other")).toEqual(["Run: sudo dnf install -y bubblewrap socat", `Check that unprivileged user namespaces are allowed. ${link(CLAUDE_SANDBOX_DOC_URL)}`]);
    expect(sandboxFixLines("other", "probe_failed_other")).toEqual(sandboxFixLines("other", "bwrap_missing"));
  });

  it("userns_disabled gives the sysctl for the standard and the older Debian setting", () => {
    expect(sandboxFixLines("debian", "userns_disabled")).toEqual([
      "Turn unprivileged user namespaces on: sudo sysctl -w user.max_user_namespaces=15000 (and, on older Debian kernels, sudo sysctl -w kernel.unprivileged_userns_clone=1).",
      "To keep it after a restart, put the same setting in a file under /etc/sysctl.d/.",
      link(CLAUDE_SANDBOX_DOC_URL),
    ]);
  });

  it("Ubuntu with the AppArmor restriction: the profile for bwrap only comes first, then the weaker machine-wide switch, then both links", () => {
    const lines = sandboxFixLines("ubuntu", "apparmor_userns_restricted");
    expect(lines).toEqual([
      "Preferred: allow user namespaces for bubblewrap only. Save this as /etc/apparmor.d/bwrap:",
      "  abi <abi/4.0>,",
      "",
      "  profile bwrap /usr/bin/bwrap flags=(unconfined) {",
      "    userns,",
      "",
      "    include if exists <local/bwrap>",
      "  }",
      "The profile names the bubblewrap that was tested; if that path is a link, name the file it points to.",
      "Trade-off: with this profile any local program can create user namespaces by running that bubblewrap.",
      "Then load it: sudo apparmor_parser -r /etc/apparmor.d/bwrap",
      "Weaker (it lifts the restriction for every program on this machine): sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0",
      `Why Ubuntu does this: ${UBUNTU_USERNS_URL}`,
      link(CLAUDE_SANDBOX_DOC_URL),
    ]);
    expect(lines.findIndex((line) => line.startsWith("Preferred"))).toBeLessThan(lines.findIndex((line) => line.includes("sysctl")));
    expect(APPARMOR_PROFILE_PATH).toBe("/etc/apparmor.d/bwrap");
    expect(apparmorProfile(undefined).join("\n")).toContain("userns,");
  });

  it("the AppArmor profile names the bubblewrap the probe found, not a fixed path; an odd path falls back to the usual one", () => {
    expect(sandboxFixLines("ubuntu", "apparmor_userns_restricted", "/opt/tools/bin/bwrap").join("\n")).toContain("  profile bwrap /opt/tools/bin/bwrap flags=(unconfined) {");
    expect(sandboxFixLines("ubuntu", "apparmor_userns_restricted", "/opt/tools/bin/bwrap").join("\n")).not.toContain("/usr/bin/bwrap");
    for (const odd of ["relative/bwrap", "/opt/a b/bwrap", "/opt/../bwrap", "/opt/x{y}/bwrap", "/opt/x\nprofile evil", ""]) {
      expect(apparmorProfile(odd).join("\n"), odd).toContain(`profile bwrap ${DEFAULT_BWRAP_PATH} flags=(unconfined)`);
    }
  });

  it("NixOS with user namespaces off gets the declarative setting and a rebuild, never /etc/sysctl.d", () => {
    const lines = sandboxFixLines("nixos", "userns_disabled");
    expect(lines).toEqual([
      'Add this to your NixOS configuration: boot.kernel.sysctl."user.max_user_namespaces" = 15000;',
      "If your configuration sets security.allowUserNamespaces = false, set it to true instead.",
      "Then run: sudo nixos-rebuild switch",
      link(CLAUDE_SANDBOX_DOC_URL),
    ]);
    expect(lines.join("\n")).not.toMatch(/sysctl\.d|sysctl -w/);
  });

  it("the two links are the single constants C16 names", () => {
    expect(UBUNTU_USERNS_URL).toBe("https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces");
    expect(CLAUDE_SANDBOX_DOC_URL).toBe("https://code.claude.com/docs/en/sandboxing");
  });

  it("never suggests nix-env, on NixOS or anywhere", () => {
    const distros: Distro[] = ["debian", "ubuntu", "fedora", "arch", "nixos", "macos", "other"];
    const reasons: SandboxReason[] = ["bwrap_missing", "socat_missing", "userns_disabled", "apparmor_userns_restricted", "probe_failed_other"];
    for (const distro of distros) for (const reason of reasons) expect(sandboxFixLines(distro, reason).join("\n"), `${distro} ${reason}`).not.toMatch(/nix-env/);
  });
});
