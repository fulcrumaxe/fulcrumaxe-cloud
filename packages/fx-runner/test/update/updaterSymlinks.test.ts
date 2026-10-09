import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Updater } from "../../src/update/updater.js";
import { installedVersions, saveUpdateState, switchLink, versionBinary, versionInstalled, type UpdateState } from "../../src/update/versions.js";
import { program, updateWorld, type UpdateWorld } from "../helpers/updateWorld.js";

/**
 * A link where the updater expects a directory (CWE-59). Each case builds a tree OUTSIDE the state directory that the link leads to, runs
 * the update path, and checks that the tree is byte for byte what it was and that the answer is a closed refusal.
 */

const T = (v: string, platform = "linux-x64"): string => `v${v}/fx-runner-${platform}`;

/** Every path under `dir` with what is at it: a file's bytes, a link's target, a directory marker. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = `${prefix}/${name}`;
    const st = lstatSync(full);
    if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(full)}`;
    else if (st.isDirectory()) Object.assign(out, { [rel]: "dir" }, snapshot(full, rel));
    else out[rel] = `file:${readFileSync(full).toString("base64")}`;
  }
  return out;
}

/** An outside tree that looks like a versions directory with leftovers and an old version in it. */
function outsideVersions(w: UpdateWorld): string {
  const outside = path.join(w.root, "outside");
  mkdirSync(path.join(outside, "versions", ".staging-zzz"), { recursive: true });
  writeFileSync(path.join(outside, "versions", ".staging-zzz", "fx-runner"), "partial");
  mkdirSync(path.join(outside, "versions", "0.9.0"), { recursive: true });
  writeFileSync(path.join(outside, "versions", "0.9.0", "fx-runner"), program("0.9.0"), { mode: 0o755 });
  return outside;
}

/** Replaces `<state>/versions` with a link to `<outside>/versions`, keeping the real versions there too. Returns the program path as the entry point reports it (links resolved). */
function linkVersions(w: UpdateWorld): { outside: string; realProgram: string; lexicalProgram: string } {
  const outside = outsideVersions(w);
  mkdirSync(path.join(outside, "versions", "1.0.0"), { recursive: true });
  writeFileSync(path.join(outside, "versions", "1.0.0", "fx-runner"), program("1.0.0"), { mode: 0o755 });
  renameSync(path.join(w.stateDir, "versions"), path.join(w.root, "old-versions"));
  symlinkSync(path.join(outside, "versions"), path.join(w.stateDir, "versions"));
  return { outside, realProgram: path.join(outside, "versions", "1.0.0", "fx-runner"), lexicalProgram: path.join(w.stateDir, "versions", "1.0.0", "fx-runner") };
}

function linkBin(w: UpdateWorld): { outside: string } {
  const outside = path.join(w.root, "outside");
  mkdirSync(outside, { recursive: true });
  renameSync(path.join(w.stateDir, "bin"), path.join(outside, "bin"));
  symlinkSync(path.join(outside, "bin"), path.join(w.stateDir, "bin"));
  return { outside };
}

const forceManaged = (updater: Updater): void => {
  vi.spyOn(updater, "kind").mockReturnValue("managed");
};
const priv = (updater: Updater): { prune: (state: UpdateState, current: string) => void } => updater as unknown as { prune: (state: UpdateState, current: string) => void };

describe("a symlinked <state>/versions is never followed", () => {
  it.each([
    ["the entry point's resolved path (inside the link's target)", "realProgram"],
    ["the lexical path under the state directory", "lexicalProgram"],
  ] as const)("is unmanaged, and nothing outside is touched, when the program is %s", async (_name, which) => {
    const w = updateWorld();
    const linked = linkVersions(w);
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    const updater = w.updaterWith({ execPath: linked[which] });
    const before = snapshot(linked.outside);
    expect(updater.kind()).toBe("unmanaged");
    expect(await updater.applyLatest()).toMatchObject({ ok: false, code: "unmanaged" });
    expect(await updater.install("1.1.0", true)).toMatchObject({ ok: false, code: "unmanaged" });
    await updater.cleanup();
    expect(w.tuf.fetchCalls).toEqual([]);
    expect(snapshot(linked.outside)).toEqual(before);
    expect(existsSync(path.join(linked.outside, "versions", "1.1.0"))).toBe(false);
  });

  it("install refuses on its own even when the install were taken for managed: no download, no stage, no delete", async () => {
    const w = updateWorld();
    const linked = linkVersions(w);
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    const updater = w.updaterWith({ execPath: linked.lexicalProgram });
    forceManaged(updater);
    const before = snapshot(linked.outside);
    expect(await updater.install("1.1.0", true)).toMatchObject({ ok: false, code: "unmanaged" });
    expect(w.tuf.fetchCalls).toEqual([]);
    expect(snapshot(linked.outside)).toEqual(before);
  });

  it("rollback refuses on its own even when the install were taken for managed, and the stable link does not move", async () => {
    const w = updateWorld();
    const linked = linkVersions(w);
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: true, previous: "0.9.0" });
    const updater = w.updaterWith({ execPath: linked.lexicalProgram });
    forceManaged(updater);
    const before = snapshot(linked.outside);
    const target = readlinkSync(path.join(w.stateDir, "bin", "fx-runner"));
    expect(await updater.rollback()).toMatchObject({ ok: false, code: "unmanaged" });
    expect(readlinkSync(path.join(w.stateDir, "bin", "fx-runner"))).toBe(target);
    expect(snapshot(linked.outside)).toEqual(before);
  });

  it("crash recovery (cleanup) does not remove staging leftovers or the recorded version inside the link's target", async () => {
    const w = updateWorld();
    const linked = linkVersions(w);
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: true, applying: { version: "0.9.0", from: "1.0.0" } });
    const before = snapshot(linked.outside);
    await w.updaterWith({ execPath: linked.lexicalProgram }).cleanup();
    expect(snapshot(linked.outside)).toEqual(before);
  });

  it("pruning does not delete versions inside the link's target, and the listing sees none", () => {
    const w = updateWorld();
    const linked = linkVersions(w);
    const before = snapshot(linked.outside);
    priv(w.updater).prune({ version: 1, autoUpdate: true }, "1.0.0");
    expect(snapshot(linked.outside)).toEqual(before);
    expect(installedVersions(w.stateDir)).toEqual([]);
    expect(versionInstalled(w.stateDir, "1.0.0")).toBe(false);
  });
});

describe("a symlinked <state>/bin is never followed", () => {
  it("is unmanaged, and an update changes nothing outside the tree", async () => {
    const w = updateWorld();
    const linked = linkBin(w);
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    const before = snapshot(linked.outside);
    expect(w.updater.kind()).toBe("unmanaged");
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "unmanaged" });
    expect(await w.updater.rollback()).toMatchObject({ ok: false, code: "unmanaged" });
    expect(w.tuf.fetchCalls).toEqual([]);
    expect(snapshot(linked.outside)).toEqual(before);
  });

  it("install and rollback refuse on their own even when the install were taken for managed", async () => {
    const w = updateWorld();
    const linked = linkBin(w);
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: true, previous: "1.0.0" });
    forceManaged(w.updater);
    const before = snapshot(linked.outside);
    expect(await w.updater.install("1.1.0", true)).toMatchObject({ ok: false, code: "unmanaged" });
    expect(await w.updater.rollback()).toMatchObject({ ok: false, code: "unmanaged" });
    expect(w.tuf.fetchCalls).toEqual([]);
    expect(snapshot(linked.outside)).toEqual(before);
    expect(readdirSync(path.join(w.stateDir, "versions"))).toEqual(["1.0.0"]);
  });

  it("switchLink itself throws before it creates or renames anything", () => {
    const w = updateWorld({ installed: ["1.0.0", "1.1.0"] });
    const linked = linkBin(w);
    const before = snapshot(linked.outside);
    expect(() => switchLink(w.stateDir, "1.1.0")).toThrow();
    expect(snapshot(linked.outside)).toEqual(before);
  });
});

describe("a symlinked versions/<v> is not an installed version", () => {
  function linkedVersionDir(w: UpdateWorld): { outside: string } {
    const outside = path.join(w.root, "outside");
    mkdirSync(path.join(outside, "elsewhere"), { recursive: true });
    writeFileSync(path.join(outside, "elsewhere", "fx-runner"), program("0.9.0"), { mode: 0o755 });
    symlinkSync(path.join(outside, "elsewhere"), path.join(w.stateDir, "versions", "0.9.0"));
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: true, previous: "0.9.0" });
    return { outside };
  }

  it("versionInstalled says no", () => {
    const w = updateWorld();
    linkedVersionDir(w);
    expect(versionInstalled(w.stateDir, "0.9.0")).toBe(false);
  });

  it("rollback to it is refused as no previous version, and the stable link stays where it is", async () => {
    const w = updateWorld();
    const { outside } = linkedVersionDir(w);
    const before = snapshot(outside);
    const target = readlinkSync(path.join(w.stateDir, "bin", "fx-runner"));
    expect(await w.updater.rollback()).toMatchObject({ ok: false, code: "no_previous" });
    expect(readlinkSync(path.join(w.stateDir, "bin", "fx-runner"))).toBe(target);
    expect(snapshot(outside)).toEqual(before);
  });

  it("installing it does not reuse it: the version is fetched through TUF and the outside directory is untouched", async () => {
    const w = updateWorld();
    const { outside } = linkedVersionDir(w);
    const fresh = program("0.9.0", { versionLine: "fx-runner 0.9.0 (from tuf)" });
    w.tuf.add(T("0.9.0"), fresh);
    const before = snapshot(outside);
    const result = await w.updater.install("0.9.0", true);
    expect(result).toMatchObject({ ok: true, version: "0.9.0" });
    expect(w.tuf.fetchCalls).toEqual([T("0.9.0")]);
    expect(snapshot(outside)).toEqual(before);
    expect(lstatSync(path.join(w.stateDir, "versions", "0.9.0")).isDirectory()).toBe(true);
    expect(readFileSync(versionBinary(w.stateDir, "0.9.0")).equals(fresh)).toBe(true);
    expect(realpathSync(path.join(w.stateDir, "bin", "fx-runner")).startsWith(`${realpathSync(w.stateDir)}${path.sep}`)).toBe(true);
  });
});

describe("a state directory reached through a link in its parent path is still managed", () => {
  it("compares the program with the versions directory under the resolved state directory", () => {
    const w = updateWorld();
    const alias = path.join(w.root, "alias");
    symlinkSync(w.stateDir, alias);
    const updater = w.updaterWith({ execPath: realpathSync(versionBinary(w.stateDir, "1.0.0")) }, { stateDir: alias });
    expect(updater.kind()).toBe("managed");
  });
});

describe("the staging directory is private until it is moved into place", () => {
  it("the installed version directory ends 0755", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    expect(await w.updater.applyLatest()).toMatchObject({ ok: true });
    expect(lstatSync(path.join(w.stateDir, "versions", "1.1.0")).mode & 0o777).toBe(0o755);
  });
});
