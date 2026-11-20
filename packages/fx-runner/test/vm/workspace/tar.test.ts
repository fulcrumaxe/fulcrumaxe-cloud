import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArchiveRefused, confinedPath, linkStaysInside, readTar, type TarLimits } from "../../../src/vm/workspace/tar.js";
import { blobOid, parseTreeListing, verifyTree } from "../../../src/vm/workspace/tree.js";
import { fixtureRepo, git, GIT_ENV } from "./helpers.js";

const LIMITS: TarLimits = { maxEntries: 100, maxTotalBytes: 1 << 20 };

interface Spec { name: string; type?: string; body?: string; mode?: number; link?: string; pax?: Record<string, string>; rawSize?: number }
function header(name: string, type: string, size: number, mode: number, link = ""): Buffer {
  const b = Buffer.alloc(512);
  b.write(name.slice(0, 100), 0, "utf8");
  b.write(mode.toString(8).padStart(7, "0"), 100);
  b.write("0000000", 108);
  b.write("0000000", 116);
  b.write(size.toString(8).padStart(11, "0"), 124);
  b.write("00000000000", 136);
  b.fill(0x20, 148, 156);
  b.write(type, 156);
  b.write(link.slice(0, 100), 157);
  b.write("ustar\0" + "00", 257, "latin1");
  let sum = 0;
  for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return b;
}
const pad = (body: Buffer): Buffer => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
function tarOf(specs: Spec[], finish = true): Buffer {
  const parts: Buffer[] = [];
  for (const s of specs) {
    if (s.pax !== undefined) {
      const text = Object.entries(s.pax).map(([k, v]) => { const rest = ` ${k}=${v}\n`; let len = rest.length + 1; while (String(len).length + rest.length !== len) len = String(len).length + rest.length; return `${String(len)}${rest}`; }).join("");
      parts.push(header("pax", "x", Buffer.byteLength(text), 0o644), pad(Buffer.from(text)));
    }
    const body = Buffer.from(s.body ?? "");
    parts.push(header(s.name, s.type ?? "0", s.rawSize ?? body.length, s.mode ?? 0o644, s.link), pad(body));
  }
  if (finish) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const refusal = (tar: Buffer, limits = LIMITS): string | undefined => {
  try {
    readTar(tar, limits);
    return undefined;
  } catch (error) {
    if (error instanceof ArchiveRefused) return error.code;
    throw error;
  }
};

describe("the archive reader keeps every entry inside the workspace", () => {
  it("reads files, directories and a link that stays inside, with their modes and bytes", () => {
    const entries = readTar(tarOf([{ name: "src/", type: "5", mode: 0o755 }, { name: "src/a.ts", body: "x\n" }, { name: "run.sh", body: "#!/bin/sh\n", mode: 0o755 }, { name: "l", type: "2", link: "src/a.ts", mode: 0o777 }]), LIMITS);
    expect(entries.map((e) => [e.path, e.kind, e.mode])).toEqual([["src", "dir", 0o755], ["src/a.ts", "file", 0o644], ["run.sh", "file", 0o755], ["l", "symlink", 0o777]]);
    expect(entries[1]?.data?.toString()).toBe("x\n");
    expect(entries[3]?.target).toBe("src/a.ts");
  });

  it.each([
    ["an absolute path", "/etc/passwd"],
    ["a parent segment", "a/../../b"],
    ["a leading parent segment", "../b"],
    ["a .git entry", ".git/config"],
    ["a nested .GIT entry", "sub/.GIT/hooks/x"],
    ["a newline in a name", "a\nb"],
    ["a backslash in a name", "a\\b"],
    ["a dot segment", "a/./b"],
    ["an empty segment", "a//b"],
  ])("refuses %s", (_why, name) => {
    expect(refusal(tarOf([{ name, body: "x" }]))).toBe("archive_path");
  });

  it("refuses a name over the length cap, in a pax record too", () => {
    expect(refusal(tarOf([{ name: "f", pax: { path: "a/".repeat(2100) + "x" } }]))).toBe("archive_path");
  });

  it("takes a long name from a pax record, and refuses a pax record that names an escape", () => {
    expect(readTar(tarOf([{ name: "short", pax: { path: `${"d/".repeat(60)}file.txt` }, body: "x" }]), LIMITS)[0]?.path).toBe(`${"d/".repeat(60)}file.txt`);
    expect(refusal(tarOf([{ name: "short", pax: { path: "../../outside" }, body: "x" }]))).toBe("archive_path");
    expect(refusal(tarOf([{ name: "l", type: "2", link: "x", pax: { linkpath: "/etc/shadow" } }]))).toBe("archive_link");
  });

  it.each([
    ["an absolute target", "/etc/passwd"],
    ["a target that climbs out", "../../etc/passwd"],
    ["a target that climbs out after going in", "../a/../../x"],
    ["a target with a backslash", "a\\b"],
  ])("refuses a symbolic link with %s", (_why, target) => {
    expect(refusal(tarOf([{ name: "d/l", type: "2", link: target }]))).toBe("archive_link");
  });

  it("allows a link that goes up and back down inside the tree, and one in the root pointing into a directory", () => {
    expect(refusal(tarOf([{ name: "a/b/l", type: "2", link: "../c/x" }, { name: "r", type: "2", link: "a/b" }]))).toBeUndefined();
    expect(linkStaysInside("a/b/l", "../../x")).toBe(true);
    expect(linkStaysInside("a/b/l", "../../../x")).toBe(false);
  });

  it("refuses a link whose target has a .git part, in any case, written or resolved; a name that only contains the letters is fine", () => {
    for (const target of [".git/config", "a/.git/hooks/x", "../.git", ".GIT/config", ".Git", "x/../.git/config", ".git/../README"]) expect(linkStaysInside("a/l", target), target).toBe(false);
    expect(refusal(tarOf([{ name: "l", type: "2", link: ".git/config" }]))).toBe("archive_link");
    expect(linkStaysInside("a/l", ".github/workflows/x.yml")).toBe(true);
    expect(linkStaysInside("a/l", "docs/.gitignore")).toBe(true);
    expect(linkStaysInside("a/l", "notgit/.gitkeep")).toBe(true);
  });

  it("refuses a hard link, a device, a FIFO and any unknown type", () => {
    expect(refusal(tarOf([{ name: "h", type: "1", link: "a" }]))).toBe("archive_link");
    for (const type of ["3", "4", "6", "7", "L", "K", "S"]) expect(refusal(tarOf([{ name: "n", type }])), type).toBe("archive_type");
  });

  it("refuses a set-id or sticky mode", () => {
    for (const mode of [0o4755, 0o2755, 0o1755]) expect(refusal(tarOf([{ name: "f", mode }])), mode.toString(8)).toBe("archive_mode");
  });

  it("refuses an entry written below a symbolic link, whatever the link points at", () => {
    expect(refusal(tarOf([{ name: "s", type: "2", link: "d" }, { name: "d/", type: "5" }, { name: "s/x", body: "y" }]))).toBe("archive_link");
  });

  it("refuses a repeated name, a bad checksum, a truncated body and a size that is too large", () => {
    expect(refusal(tarOf([{ name: "f", body: "1" }, { name: "f", body: "2" }]))).toBe("archive_path");
    const bad = tarOf([{ name: "f", body: "1" }]);
    bad[0] = bad[0] === 0x66 ? 0x67 : 0x66;
    expect(refusal(bad)).toBe("archive_malformed");
    expect(refusal(tarOf([{ name: "f", body: "abc", rawSize: 5000 }], false).subarray(0, 700))).toBe("archive_malformed");
    expect(refusal(tarOf([{ name: "f", body: "x".repeat(600) }]), { maxEntries: 10, maxTotalBytes: 500 })).toBe("archive_too_large");
    expect(refusal(tarOf([{ name: "a", body: "1" }, { name: "b", body: "2" }]), { maxEntries: 1, maxTotalBytes: 100 })).toBe("archive_too_large");
  });

  it("the closed refusal never carries a name from the archive", () => {
    try {
      readTar(tarOf([{ name: "/very/secret/name", body: "x" }]), LIMITS);
    } catch (error) {
      expect(String((error as Error).message)).toBe("archive_path");
      return;
    }
    throw new Error("expected a refusal");
  });

  it("confinedPath is the one definition of a plain relative path", () => {
    expect(confinedPath("a/b/c.txt")).toBe("a/b/c.txt");
    expect(confinedPath("dir/")).toBe("dir");
    for (const bad of ["", "/", "..", "a/..", ".git", "a/.git/b", "a\0b"]) expect(confinedPath(bad), JSON.stringify(bad)).toBeUndefined();
  });
});

describe("what git itself archives reads back, and verifyTree holds it to the tree", () => {
  it("a real `git archive` of a fixture tree parses and matches git's own listing, byte for byte", () => {
    const fx = fixtureRepo();
    const tar = execFileSync("git", ["-C", fx.mirror, "archive", "--format=tar", fx.tree], { env: GIT_ENV(), maxBuffer: 1 << 24 });
    const entries = readTar(tar, LIMITS);
    const items = parseTreeListing(git(fx.mirror, "ls-tree", "-r", "-z", "--full-tree", fx.tree).replace(/$/, "\0"), 100);
    expect(items.map((i) => i.path).sort()).toEqual(["README.md", "link-to-a", "run.sh", "src/a.ts"]);
    expect(() => verifyTree(entries, items)).not.toThrow();
    expect(blobOid(readFileSync(path.join(fx.repo, "README.md")))).toBe(items.find((i) => i.path === "README.md")?.oid);
  });

  it("an entry that is not in the tree, one that is missing, a changed byte and a changed mode all refuse", () => {
    const fx = fixtureRepo();
    const tar = execFileSync("git", ["-C", fx.mirror, "archive", "--format=tar", fx.tree], { env: GIT_ENV(), maxBuffer: 1 << 24 });
    const entries = readTar(tar, LIMITS);
    const items = parseTreeListing(git(fx.mirror, "ls-tree", "-r", "-z", "--full-tree", fx.tree).replace(/$/, "\0"), 100);
    const code = (e: typeof entries, i = items): string | undefined => {
      try {
        verifyTree(e, i);
        return undefined;
      } catch (error) {
        return (error as ArchiveRefused).code;
      }
    };
    expect(code([...entries, { path: "extra.txt", kind: "file", mode: 0o644, size: 1, data: Buffer.from("x") }])).toBe("archive_mismatch");
    expect(code(entries.filter((e) => e.path !== "README.md"))).toBe("archive_mismatch");
    expect(code(entries.map((e) => (e.path === "README.md" ? { ...e, data: Buffer.from("changed\n") } : e)))).toBe("archive_mismatch");
    expect(code(entries.map((e) => (e.path === "run.sh" ? { ...e, mode: 0o644 } : e)))).toBe("archive_mismatch");
    expect(code(entries.map((e) => (e.path === "link-to-a" ? { ...e, target: "src/other.ts" } : e)))).toBe("archive_mismatch");
  });

  it("git leaves out a file an export-ignore attribute names when it archives a COMMIT; held to the tree's listing, that archive is refused", () => {
    const fx = fixtureRepo((dir) => writeFileSync(path.join(dir, ".gitattributes"), "src/a.ts export-ignore\n"));
    const tar = execFileSync("git", ["-C", fx.mirror, "archive", "--format=tar", fx.commit], { env: GIT_ENV(), maxBuffer: 1 << 24 });
    const items = parseTreeListing(git(fx.mirror, "ls-tree", "-r", "-z", "--full-tree", fx.tree).replace(/$/, "\0"), 100);
    expect(() => verifyTree(readTar(tar, LIMITS), items)).toThrowError(expect.objectContaining({ code: "archive_mismatch" }) as Error);
  });

  it("a tree listing that holds a submodule, a path that is not plain or a 64-hex id is refused", () => {
    const oid = "a".repeat(40);
    expect(() => parseTreeListing(`160000 commit ${oid}\tsub\0`, 10)).toThrowError(expect.objectContaining({ code: "archive_type" }) as Error);
    expect(() => parseTreeListing(`100644 blob ${oid}\t../x\0`, 10)).toThrowError(expect.objectContaining({ code: "archive_path" }) as Error);
    expect(() => parseTreeListing(`100644 blob ${"b".repeat(64)}\tx\0`, 10)).toThrowError(expect.objectContaining({ code: "archive_type" }) as Error);
    expect(() => parseTreeListing(`100644 blob ${oid}\ta\x00100644 blob ${oid}\tb\x00`, 1)).toThrowError(expect.objectContaining({ code: "archive_too_large" }) as Error);
  });
});
