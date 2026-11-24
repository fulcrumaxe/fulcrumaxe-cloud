import { describe, expect, it } from "vitest";
import { MANAGED_SERVER_MARKER, MANAGED_SERVER_MARKER_DIRS, isManagedServer, type LstatPort } from "../../src/daemon/managedServer.js";

type Entry = { kind: "file" | "dir" | "link"; uid: number; mode: number };
const entry = (kind: Entry["kind"], uid = 0, mode = kind === "dir" ? 0o755 : 0o644): Entry => ({ kind, uid, mode });
const lstatOf = (table: Record<string, Entry | "throws">): LstatPort => (p) => {
  const e = table[p];
  if (e === "throws") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  return e === undefined ? undefined : { isFile: () => e.kind === "file", isDirectory: () => e.kind === "dir", uid: e.uid, mode: e.mode };
};
/** What the cloud's bootstrap leaves on a server it has finished: root-owned directories and an empty root-owned `done`. */
const installed = (): Record<string, Entry | "throws"> => ({ [MANAGED_SERVER_MARKER_DIRS[0]!]: entry("dir"), [MANAGED_SERVER_MARKER_DIRS[1]!]: entry("dir"), [MANAGED_SERVER_MARKER]: entry("file") });

describe("whether this machine is a server the cloud set up", () => {
  it("is the marker the bootstrap leaves as its last stage", () => {
    expect(MANAGED_SERVER_MARKER).toBe("/var/lib/fx/stage/done");
    expect(isManagedServer(lstatOf(installed()))).toBe(true);
  });
  it("is not on a machine without it (a laptop, a hand install, a bootstrap that has not finished)", () => {
    for (const missing of [MANAGED_SERVER_MARKER, ...MANAGED_SERVER_MARKER_DIRS]) {
      const table = installed();
      delete table[missing];
      expect(isManagedServer(lstatOf(table))).toBe(false);
    }
    expect(isManagedServer(lstatOf({}))).toBe(false);
  });
  it("is not when the marker is a link, a directory, or owned by anyone but root", () => {
    for (const bad of [entry("link"), entry("dir"), entry("file", 1000), entry("file", 0, 0o664), entry("file", 0, 0o646)]) {
      expect(isManagedServer(lstatOf({ ...installed(), [MANAGED_SERVER_MARKER]: bad }))).toBe(false);
    }
  });
  it("is not when a directory above it could be changed by a user (a link, another owner, group or other writable)", () => {
    for (const dir of MANAGED_SERVER_MARKER_DIRS) {
      for (const bad of [entry("link"), entry("dir", 1000), entry("dir", 0, 0o775), entry("dir", 0, 0o757), entry("file")]) {
        expect(isManagedServer(lstatOf({ ...installed(), [dir]: bad }))).toBe(false);
      }
    }
  });
  it("is not when the machine cannot be read (fail closed)", () => {
    expect(isManagedServer(lstatOf({ ...installed(), [MANAGED_SERVER_MARKER]: "throws" }))).toBe(false);
    expect(isManagedServer(lstatOf({ ...installed(), [MANAGED_SERVER_MARKER_DIRS[0]!]: "throws" }))).toBe(false);
  });
  it("on this machine the real answer is a boolean and never throws", () => {
    expect(typeof isManagedServer()).toBe("boolean");
  });
});
