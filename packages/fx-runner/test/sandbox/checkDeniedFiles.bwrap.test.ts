import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bwrapArgs } from "../../src/sandbox/probe.js";
import { bwrapCanCreateNamespaces } from "../helpers/bwrapProbe.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#6 R-CHK-2: the agent's full deny-read list is files as well as directories (a toolchain prefix's system-wide `etc/npmrc` and `etc/gitconfig`, `.npmrc`, `etc/yarnrc`,
 * `.yarnrc.yml`). The doctor probe covers a denied file only inside a re-allowed directory; the check covers every denied file that exists, on real bubblewrap.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = BWRAP !== undefined && bwrapCanCreateNamespaces(BWRAP);
const SECRET = "FX-RCHK2-DENIED-FILE";

let root: string;
const isDir = (target: string): boolean => existsSync(target) && statSync(target).isDirectory();
const isFile = (target: string): boolean => existsSync(target) && statSync(target).isFile();

describe.skipIf(!usable)("R-CHK-2: a denied file is unreadable in the check", () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpRoot(), "rchk2-denied-"));
    mkdirSync(path.join(root, "prefix", "etc"), { recursive: true });
    for (const file of ["etc/npmrc", "etc/gitconfig", "etc/yarnrc"]) writeFileSync(path.join(root, "prefix", file), SECRET);
    writeFileSync(path.join(root, "prefix", ".npmrc"), SECRET);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const settings = (): Record<string, unknown> => {
    const files = ["etc/npmrc", "etc/gitconfig", "etc/yarnrc", ".npmrc"].map((file) => path.join(root, "prefix", file));
    // the prefix is neither re-allowed nor hidden as a directory: only the files are denied
    return { filesystem: { denyRead: files, allowRead: [], allowWrite: [] }, credentials: { files: files.map((file) => ({ path: file, mode: "deny" })), envVars: [] } };
  };
  const cat = (file: string, every: boolean) => spawnSync(BWRAP!, [...bwrapArgs(settings(), isDir, isFile, every), "--", "/bin/sh", "-c", `cat ${file}`], { encoding: "utf8", env: { PATH: "/run/current-system/sw/bin:/usr/bin:/bin" } }).stdout;

  it("control: the doctor probe's translation leaves a denied file outside a re-allowed directory readable", () => {
    expect(cat(path.join(root, "prefix", "etc", "npmrc"), false)).toContain(SECRET);
  });

  it("with every denied file covered, each of the toolchain prefix's credential files reads as empty", () => {
    for (const file of ["etc/npmrc", "etc/gitconfig", "etc/yarnrc", ".npmrc"]) expect(cat(path.join(root, "prefix", file), true), file).toBe("");
  });
});
