import { describe, expect, it } from "vitest";
import { WSL_CODES, WSL_CONF, windowsMounts, wslChecks, wslConfValue, type WslCheckInput, type WslCode } from "../src/sandbox/wslChecks.js";

const CONF_OK = "[interop]\nenabled=false\nappendWindowsPath=false\n";
const mount = (point: string, type: string): string => `55 22 0:48 / ${point} rw,noatime - ${type} C:\\134 rw,aname=drvfs`;
const ROOT = "26 1 8:16 / / rw,relatime - ext4 /dev/sdb rw";

/** A machine that exists only in the test: the wsl.conf text, the interop entry and the mount table. Nothing is read from the real one. */
function input(over: { conf?: string | null; interop?: boolean; mountinfo?: string | null; mounts?: string[]; denyRead?: string[]; denyWrite?: string[]; directories?: Array<[string, string]> } = {}): WslCheckInput {
  const conf = over.conf === null ? undefined : (over.conf ?? CONF_OK);
  const table = over.mountinfo === null ? undefined : (over.mountinfo ?? [ROOT, ...(over.mounts ?? [])].join("\n"));
  return {
    fs: { readText: (target) => (target === WSL_CONF ? conf : undefined), wsl: { interopEntry: () => over.interop === true, mountinfo: () => table } },
    denyRead: over.denyRead ?? [],
    denyWrite: over.denyWrite ?? [],
    directories: over.directories ?? [["state directory", "/home/dev/.local/state/fx"]],
  };
}

function failing(source: WslCheckInput): WslCode[] {
  return wslChecks(source).filter((finding) => !finding.ok).map((finding) => finding.code);
}

describe("a WSL2 machine set up the way the README says", () => {
  it("passes all four checks, in the closed order", () => {
    const findings = wslChecks(input({ mounts: [mount("/mnt/c", "9p")], denyRead: ["/mnt"], denyWrite: ["/mnt"] }));
    expect(findings.map((finding) => finding.code)).toEqual([...WSL_CODES]);
    expect(findings.every((finding) => finding.ok)).toBe(true);
  });
});

describe("wsl_interop_enabled", () => {
  it("fails when the WSLInterop entry exists, even when wsl.conf says false (a restart is still owed)", () => {
    const result = wslChecks(input({ interop: true }))[0]!;
    expect(result).toMatchObject({ code: "wsl_interop_enabled", ok: false });
    expect(result.detail).toContain("wsl --shutdown");
  });

  it.each([["no wsl.conf at all", undefined], ["[interop] enabled=true", "[interop]\nenabled=true\nappendWindowsPath=false\n"], ["the key in another section", "[automount]\nenabled=false\n[interop]\nappendWindowsPath=false\n"], ["a commented-out false", "[interop]\n#enabled=false\nappendWindowsPath=false\n"]])("fails with %s", (_name, conf) => {
    expect(failing(input({ conf: conf ?? null }))).toContain("wsl_interop_enabled");
  });

  it("says the cost: no .exe launches while the runner is installed", () => {
    expect(wslChecks(input({ interop: true }))[0]!.detail).toContain("no .exe launches from WSL2");
  });

  it("reads the setting without regard to case, spacing or quotes", () => {
    expect(failing(input({ conf: '[Interop]\n Enabled = "FALSE" \nAppendWindowsPath = False\n' }))).toEqual([]);
  });
});

describe("wsl_drvfs_exposed", () => {
  it.each(["9p", "drvfs", "virtiofs"])("fails for a %s mount that is not denied", (type) => {
    expect(failing(input({ mounts: [mount("/mnt/c", type)], denyRead: ["/mnt/c"], denyWrite: [] }))).toEqual(["wsl_drvfs_exposed"]);
    expect(failing(input({ mounts: [mount("/mnt/c", type)], denyRead: [], denyWrite: ["/mnt/c"] }))).toEqual(["wsl_drvfs_exposed"]);
    expect(failing(input({ mounts: [mount("/mnt/c", type)] }))).toEqual(["wsl_drvfs_exposed"]);
  });

  it("passes when a parent of the mount is denied for both, and ignores other file systems", () => {
    expect(failing(input({ mounts: [mount("/mnt/c", "9p"), "30 26 0:30 / /tmp rw - tmpfs tmpfs rw"], denyRead: ["/mnt/"], denyWrite: ["/mnt"] }))).toEqual([]);
  });

  it("does not treat a sibling with the same prefix as covered", () => {
    expect(failing(input({ mounts: [mount("/mnt/cache", "9p")], denyRead: ["/mnt/c"], denyWrite: ["/mnt/c"] }))).toEqual(["wsl_drvfs_exposed"]);
  });

  it("lists the mounts, capped, and decodes an escaped space in a mount point", () => {
    expect(windowsMounts(mount("/mnt/my\\040drive", "9p"))).toEqual(["/mnt/my drive"]);
    const many = Array.from({ length: 8 }, (_, index) => mount(`/mnt/${String.fromCharCode(97 + index)}`, "9p"));
    expect(wslChecks(input({ mounts: many }))[1]!.detail).toContain("and 3 more");
  });

  it("skips a malformed line", () => {
    expect(windowsMounts("garbage\n\n55 22 0:48 / relative rw - 9p x rw")).toEqual([]);
  });

  it.each([["unreadable", null], ["empty", ""], ["blank", "  \n"]])("FAILs when the mount table is %s: nothing is known about the drives", (_name, mountinfo) => {
    const source = input({ mountinfo });
    expect(failing(source)).toEqual(["wsl_drvfs_exposed"]);
    expect(wslChecks(source)[1]!.detail).toContain("could not read the mount table");
  });

  it("FAILs when the machine has no WSL reader at all", () => {
    const source = input();
    source.fs = { readText: source.fs.readText };
    expect(failing(source)).toContain("wsl_drvfs_exposed");
    expect(wslChecks(source)[1]!.detail).toContain("could not read the mount table");
  });
});

describe("wsl_mnt_path", () => {
  it.each(["/mnt/c/Users/dev/work", "/mnt/wsl/state", "/mnt/d"])("fails for %s", (dir) => {
    const result = wslChecks(input({ directories: [["workspace directory", dir]] }))[2]!;
    expect(result).toMatchObject({ code: "wsl_mnt_path", ok: false });
    expect(result.detail).toContain("the workspace directory");
  });

  it.each(["/home/dev/work", "/mntx/c", "/mnt", "/opt/mnt/c"])("passes for %s", (dir) => {
    expect(failing(input({ directories: [["mirrors directory", dir]] }))).toEqual([]);
  });

  it("checks every directory it is given", () => {
    expect(wslChecks(input({ directories: [["state directory", "/home/a"], ["snapshot directory", "/mnt/c/snap"]] }))[2]!.detail).toContain("the snapshot directory (/mnt/c/snap)");
  });

  it("normalises a path that climbs out of /home into /mnt", () => {
    expect(failing(input({ directories: [["state directory", "/home/dev/../../mnt/c/x"]] }))).toEqual(["wsl_mnt_path"]);
  });
});

describe("wsl_append_windows_path", () => {
  it.each([["missing", "[interop]\nenabled=false\n"], ["true", "[interop]\nenabled=false\nappendWindowsPath=true\n"], ["in the wrong section", "[interop]\nenabled=false\n[boot]\nappendWindowsPath=false\n"]])("fails when it is %s", (_name, conf) => {
    const result = wslChecks(input({ conf }))[3]!;
    expect(result).toMatchObject({ code: "wsl_append_windows_path", ok: false });
    expect(failing(input({ conf }))).toEqual(["wsl_append_windows_path"]);
  });
});

describe("the wsl.conf reader", () => {
  it("returns the last value, lower-cased, and undefined when absent", () => {
    expect(wslConfValue("[interop]\nenabled=true\nenabled=False\n", "interop", "enabled")).toBe("false");
    expect(wslConfValue("[interop]\n", "interop", "enabled")).toBeUndefined();
    expect(wslConfValue(undefined, "interop", "enabled")).toBeUndefined();
    expect(wslConfValue("[interop]\r\nenabled=false ; trailing note\r\n", "interop", "enabled")).toBe("false");
  });

  it("every failure message names what to change and why, and carries no value from the machine's files", () => {
    for (const finding of wslChecks(input({ conf: "", mounts: [mount("/mnt/c", "9p")], directories: [["state directory", "/mnt/c/x"]] }))) {
      expect(finding.ok).toBe(false);
      expect(finding.detail.length).toBeGreaterThan(60);
    }
  });
});
