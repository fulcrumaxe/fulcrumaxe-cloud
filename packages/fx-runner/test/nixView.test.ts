import os from "node:os";
import { describe, expect, it } from "vitest";
import { buildNixView, viewedArgv, type NixViewFs } from "../src/sandbox/nixView.js";

/** D#6 R7c fix round 2: what the Nix client's view is built from. Pure: a fake file system says what exists, the options are read off the result. */
const FILES = new Set(["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ssl/certs/ca-certificates.crt", "/etc/nix/nix.conf", "/etc/nix/registry.json"]);
const DIRS = new Set(["/nix/store", "/nix/var/nix/daemon-socket", "/cache/mirrors/m.git", "/usr/lib", "/lib"]);
const fsx: NixViewFs = {
  exists: (target) => FILES.has(target) || DIRS.has(target) || target === "/nix/var/nix/daemon-socket/socket",
  isDir: (target) => DIRS.has(target),
  isFile: (target) => FILES.has(target),
  list: (target) => (target === "/etc/nix" ? ["nix.conf", "registry.json", "sub"] : []),
};
const NIX = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-nix/bin/nix";
const input = { nixBin: NIX, mirrorDir: "/cache/mirrors/m.git" };

/** The `--ro-bind SRC DEST` and `--bind SRC DEST` triples in an option list. */
const binds = (args: readonly string[]): string[] => args.flatMap((arg, i) => (arg === "--ro-bind" || arg === "--bind" || arg === "--ro-bind-try" ? [`${arg} ${args[i + 1]} ${args[i + 2]}`] : []));

describe("the view the nix client runs in", () => {
  it("holds the mirror, the store, the daemon socket directory, the nix config, the CA bundle and the resolver files, read-only, and an empty /tmp", () => {
    const view = buildNixView(input, fsx)!;
    expect(binds(view.args).sort()).toEqual([
      "--ro-bind /cache/mirrors/m.git /cache/mirrors/m.git",
      "--ro-bind /etc/hosts /etc/hosts",
      "--ro-bind /etc/nix/nix.conf /etc/nix/nix.conf",
      "--ro-bind /etc/nix/registry.json /etc/nix/registry.json",
      "--ro-bind /etc/nsswitch.conf /etc/nsswitch.conf",
      "--ro-bind /etc/resolv.conf /etc/resolv.conf",
      "--ro-bind /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt",
      "--ro-bind /nix/store /nix/store",
      "--ro-bind /nix/var/nix/daemon-socket /nix/var/nix/daemon-socket",
    ]);
    expect(view.args).toContain("--clearenv");
    expect(view.args.join(" ")).toContain("--tmpfs /tmp --dir /tmp/home");
    expect(view.env).toMatchObject({ HOME: "/tmp/home", TMPDIR: "/tmp", NIX_REMOTE: "daemon", NIX_SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt" });
  });

  it("never names the runner's home, a writable bind, or anything outside the list", () => {
    const text = JSON.stringify(buildNixView({ ...input, gitBin: "/usr/bin/git" }, fsx)!.args);
    expect(text).not.toContain(os.homedir());
    expect(text).not.toContain("--bind\"");
    expect(text).not.toMatch(/"--ro-bind","\/(?:home|root|tmp|var\/lib|run)[/"]/);
  });

  it("shows the directory of a nix that is not in the store, and git's directory plus the system libraries only when git is not in the store", () => {
    expect(binds(buildNixView({ ...input, nixBin: "/opt/nix/bin/nix" }, fsx)!.args)).toContain("--ro-bind /opt/nix/bin /opt/nix/bin");
    const inStore = binds(buildNixView({ ...input, gitBin: "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-git/bin/git" }, fsx)!.args);
    expect(inStore.some((line) => line.includes("/usr/lib"))).toBe(false);
    const outside = buildNixView({ ...input, gitBin: "/usr/bin/git" }, fsx)!;
    expect(binds(outside.args)).toEqual(expect.arrayContaining(["--ro-bind /usr/bin /usr/bin", "--ro-bind /usr/lib /usr/lib", "--ro-bind /lib /lib"]));
    expect(outside.env["PATH"]).toBe("/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-nix/bin:/usr/bin");
  });

  it.each([
    ["no daemon socket", { ...fsx, exists: () => false }],
    ["no store", { ...fsx, isDir: (target: string) => target !== "/nix/store" && DIRS.has(target) }],
    ["no mirror", { ...fsx, isDir: (target: string) => target !== "/cache/mirrors/m.git" && DIRS.has(target) }],
  ])("cannot be built with %s", (_name, broken) => {
    expect(buildNixView(input, broken)).toBeUndefined();
  });

  it.each([
    ["a mirror with a .. segment", { ...input, mirrorDir: "/cache/../etc" }],
    ["a relative mirror", { ...input, mirrorDir: "cache/m.git" }],
    ["a mirror with a newline", { ...input, mirrorDir: "/cache/m\n.git" }],
    ["a relative nix", { ...input, nixBin: "nix" }],
  ])("is not built for %s", (_name, bad) => {
    expect(buildNixView(bad, fsx)).toBeUndefined();
  });

  it("viewedArgv puts the environment before the `--` and the command after it", () => {
    const argv = viewedArgv(buildNixView(input, fsx)!, NIX, ["print-dev-env"]);
    const at = argv.indexOf("--");
    expect(argv.slice(at)).toEqual(["--", NIX, "print-dev-env"]);
    expect(argv.slice(0, at).join(" ")).toContain("--setenv HOME /tmp/home");
  });
});
