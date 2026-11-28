import { describe, expect, it } from "vitest";
import { sudoFileHolds, sudoFindArgv, sudoGrepArgv, sudoListFiles, type Run } from "./helpers/snapshotSearchSudo.js";

const reply = (status: number | null, out = "", error?: Error): ReturnType<Run> => ({ status, stdout: Buffer.from(out), ...(error === undefined ? {} : { error }) }) as ReturnType<Run>;

describe("the sudo RAM-snapshot search builds fixed argv and judges exit codes", () => {
  it("the listing is `sudo -n find <dir> -type f`, NUL separated, with no shell and no permission change", () => {
    expect(sudoFindArgv("/fictional/snaps")).toEqual(["-n", "find", "/fictional/snaps", "-type", "f", "-print0"]);
    const seen: Array<[string, string[]]> = [];
    const files = sudoListFiles("/fictional/snaps", (f, a) => (seen.push([f, a]), reply(0, "/fictional/snaps/a/mem\0/fictional/snaps/b/meta.json\0")));
    expect(files).toEqual(["/fictional/snaps/a/mem", "/fictional/snaps/b/meta.json"]);
    expect(seen).toEqual([["sudo", ["-n", "find", "/fictional/snaps", "-type", "f", "-print0"]]]);
  });

  it("a listing that fails (sudo needs a password, the directory is gone, no sudo) is undefined, so the search is reported as not run", () => {
    expect(sudoListFiles("/fictional/snaps", () => reply(1))).toBeUndefined();
    expect(sudoListFiles("/fictional/snaps", () => reply(null, "", new Error("ENOENT")))).toBeUndefined();
  });

  it("the search is `sudo -n grep -qF -- <needle> <file>`: the needle is one argv element after `--`, even when it starts with a dash", () => {
    expect(sudoGrepArgv("/fictional/snaps/a/mem", Buffer.from("engine-bridge.py"))).toEqual(["-n", "grep", "-qF", "--", "engine-bridge.py", "/fictional/snaps/a/mem"]);
    expect(sudoGrepArgv("/f", Buffer.from("-e evil"))).toEqual(["-n", "grep", "-qF", "--", "-e evil", "/f"]);
  });

  it("a needle that grep -F would read as several patterns, or that cannot be one argv string, is refused rather than searched wrongly", () => {
    for (const bad of [Buffer.from("a\nb"), Buffer.from([0x61, 0x00, 0x62]), Buffer.from([0xff, 0xfe, 0x41]), Buffer.alloc(0)]) expect(() => sudoGrepArgv("/f", bad)).toThrow();
  });

  it("exit 0 is found, exit 1 is not found, and anything else (sudo refused, unreadable, no spawn) throws", () => {
    expect(sudoFileHolds("/f", Buffer.from("x"), () => reply(0))).toBe(true);
    expect(sudoFileHolds("/f", Buffer.from("x"), () => reply(1))).toBe(false);
    expect(() => sudoFileHolds("/f", Buffer.from("x"), () => reply(2))).toThrow();
    expect(() => sudoFileHolds("/f", Buffer.from("x"), () => reply(null))).toThrow();
    expect(() => sudoFileHolds("/f", Buffer.from("x"), () => reply(null, "", new Error("ENOENT")))).toThrow();
  });
});
