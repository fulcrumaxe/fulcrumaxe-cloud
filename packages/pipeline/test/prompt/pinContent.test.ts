import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PINS_MAX_READ, PIN_FILE_MAX_BYTES, PIN_FILE_MAX_CHARS, createPinContentPort, excludeCovers, type PinSource } from "../../src/prompt/pinContent.js";
import { assemblePrompt } from "../../src/prompt/assemblePrompt.js";

/** D#600 CX-5b: the pin port against a GitHub that answers in the trees and blobs APIs' shapes. The real shapes over real TLS are in packages/github/test/repoTreeSource.test.ts. */
const HEAD = "a".repeat(40);
const REQ = { accountId: "acct", repoId: "repo", owner: "acme", name: "widgets" };

class Gh implements PinSource {
  calls: string[] = [];
  truncated = false;
  tree_: Array<{ path: string; type: "blob" | "tree" | "commit"; sha: string; size?: number }> | null = [];
  blobs = new Map<string, string | null>();
  headSha_: string | null = HEAD;
  async headSha() {
    this.calls.push("head");
    return this.headSha_;
  }
  async tree(sha: string) {
    this.calls.push(`tree:${sha}`);
    return this.tree_ === null ? null : { truncated: this.truncated, entries: this.tree_ };
  }
  async blob(sha: string, maxBytes = 65_536) {
    this.calls.push(`blob:${sha}:${maxBytes}`);
    const text = this.blobs.get(sha) ?? null;
    return text === null || Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
  }
  file(p: string, text: string, size = Buffer.byteLength(text, "utf8")) {
    const sha = (this.tree_?.length ?? 0).toString(16).padStart(40, "0");
    this.tree_?.push({ path: p, type: "blob", sha, size });
    this.blobs.set(sha, text);
  }
}
const port = (gh: Gh, log?: (r: string) => void) => createPinContentPort({ open: async () => gh, log });

describe("createPinContentPort", () => {
  it("reads each pinned path once at the given commit, in path order, in full, and asks for the head only when no commit is given", async () => {
    const gh = new Gh();
    gh.file("b.md", "bee");
    gh.file("a/a.md", "aye\nwith lines\n");
    const out = await port(gh).forRun({ ...REQ, paths: ["b.md", "a/a.md", "b.md"], sha: "c".repeat(40) });
    expect(out).toEqual({ items: [{ path: "a/a.md", text: "aye\nwith lines\n" }, { path: "b.md", text: "bee" }], missing: 0, tooLarge: 0 });
    expect(gh.calls.filter((c) => c === "head")).toEqual([]);
    expect(gh.calls[0]).toBe(`tree:${"c".repeat(40)}`);
    const headed = new Gh();
    headed.file("x", "y");
    await port(headed).forRun({ ...REQ, paths: ["x"] });
    expect(headed.calls[0]).toBe("head");
    expect(headed.calls[1]).toBe(`tree:${HEAD}`);
  });

  it("makes no GitHub call at all when nothing is pinned", async () => {
    const gh = new Gh();
    expect(await port(gh).forRun({ ...REQ, paths: [] })).toEqual({ items: [], missing: 0, tooLarge: 0 });
    expect(gh.calls).toEqual([]);
  });

  it("a path that is not a file in the tree is missing: deleted, renamed, a folder, a submodule; and a pin is matched by exact path (a bracketed folder is literal)", async () => {
    const gh = new Gh();
    gh.file("app/[id]/page.tsx", "page");
    gh.tree_!.push({ path: "docs", type: "tree", sha: "d".repeat(40) }, { path: "vendor/lib", type: "commit", sha: "e".repeat(40) });
    const out = await port(gh).forRun({ ...REQ, paths: ["app/[id]/page.tsx", "app/i/page.tsx", "docs", "vendor/lib", "gone.md"] });
    expect(out.items.map((i) => i.path)).toEqual(["app/[id]/page.tsx"]);
    expect(out.missing).toBe(4);
  });

  it("a file over the cap is never fetched (its tree size says so), and a NUL byte or a blob the API refuses reads as missing", async () => {
    const gh = new Gh();
    gh.file("huge.bin", "", PIN_FILE_MAX_BYTES + 1);
    gh.file("nul.dat", "a\0b");
    gh.file("gone-blob.md", "x");
    gh.blobs.clear();
    gh.file("ok.md", "fine");
    const out = await port(gh).forRun({ ...REQ, paths: ["huge.bin", "nul.dat", "gone-blob.md", "ok.md"] });
    expect(out).toEqual({ items: [{ path: "ok.md", text: "fine" }], missing: 2, tooLarge: 1 });
    expect(gh.calls.filter((c) => c.startsWith("blob:")).length).toBe(3); // huge.bin was not asked for
    expect(gh.calls.filter((c) => c.startsWith("blob:")).every((c) => c.endsWith(`:${PIN_FILE_MAX_BYTES}`))).toBe(true);
  });

  it("D#600 CX-5b: a decoded file over 190,000 characters is skipped as too large, never cut; one at the cap is read whole", async () => {
    const gh = new Gh();
    gh.file("at.md", "a".repeat(PIN_FILE_MAX_CHARS));
    gh.file("over.md", "b".repeat(PIN_FILE_MAX_CHARS + 1));
    gh.file("wide.md", "é".repeat(PIN_FILE_MAX_CHARS)); // 380,000 bytes but 190,000 characters
    const out = await port(gh).forRun({ ...REQ, paths: ["at.md", "over.md", "wide.md"] });
    expect(out.items.map((i) => [i.path, i.text.length])).toEqual([["at.md", PIN_FILE_MAX_CHARS], ["wide.md", PIN_FILE_MAX_CHARS]]);
    expect(out).toMatchObject({ missing: 0, tooLarge: 1 });
  });

  it("a tree GitHub cut is logged, and a pin it cannot find is missing, not a failure", async () => {
    const gh = new Gh();
    gh.truncated = true;
    gh.file("a.md", "A");
    const logged: string[] = [];
    expect(await port(gh, (r) => logged.push(r)).forRun({ ...REQ, paths: ["a.md", "far-away.md"] })).toEqual({ items: [{ path: "a.md", text: "A" }], missing: 1, tooLarge: 0 });
    expect(logged).toEqual(["tree_truncated"]);
  });

  it("no head, no tree, a thrown GitHub error: every pin is missing, the port does not throw, and the log is a fixed word with no repository name or error text", async () => {
    const logged: string[] = [];
    const noHead = new Gh();
    noHead.headSha_ = null;
    expect(await port(noHead, (r) => logged.push(r)).forRun({ ...REQ, paths: ["a", "b"] })).toEqual({ items: [], missing: 2, tooLarge: 0 });
    const noTree = new Gh();
    noTree.tree_ = null;
    expect(await port(noTree, (r) => logged.push(r)).forRun({ ...REQ, paths: ["a"] })).toEqual({ items: [], missing: 1, tooLarge: 0 });
    const boom = createPinContentPort({ open: async () => { throw new Error("no installation for acme/widgets token=ghs_x"); }, log: (r) => logged.push(r) });
    expect(await boom.forRun({ ...REQ, paths: ["a", "b", "c"] })).toEqual({ items: [], missing: 3, tooLarge: 0 });
    expect(logged).toEqual(["no_head", "no_tree", "unavailable"]);
  });

  it("only PINS_MAX_READ files are read; the rest are counted as missing and logged", async () => {
    const gh = new Gh();
    const paths = Array.from({ length: PINS_MAX_READ + 5 }, (_, i) => `f${String(i).padStart(3, "0")}.md`);
    for (const p of paths) gh.file(p, p);
    const logged: string[] = [];
    const out = await port(gh, (r) => logged.push(r)).forRun({ ...REQ, paths });
    expect(out.items).toHaveLength(PINS_MAX_READ);
    expect(out.missing).toBe(5);
    expect(logged).toEqual(["pins_over_count"]);
  });

  it("D#600 CX-5b acceptance 5: the module reads no file and no path of its own, so a build moved to another directory behaves the same", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ["../../src/prompt/pinContent.ts", "../../../runner/src/agentConfig.ts"]) {
      const code = readFileSync(path.join(here, file), "utf8")
        .split("\n")
        .map((l) => l.replace(/^\s*(\/\/|\*|\/\*\*).*$/, ""))
        .join("\n");
      expect(code, file).not.toMatch(/\b(readFileSync|readFile|existsSync|__dirname|__filename|import\.meta\.(url|dirname)|process\.cwd|require\()/);
      expect(code, file).not.toMatch(/from "node:(fs|path|url)/);
    }
  });
});

describe("assemblePrompt: the exclude line (D#600 CX-5b)", () => {
  const base = { roleLine: "You are X.", boundary: "B", backstops: "steps", spec: { version: 1, body: "do it" }, output: "out" };
  it("is part of the boundary section right after the backstops, once, and absent when not given", () => {
    const withLine = assemblePrompt({ ...base, contextRulesLine: "LINE-ONCE" });
    expect(withLine.prompt.split("LINE-ONCE")).toHaveLength(2);
    expect(withLine.prompt.indexOf("steps")).toBeLessThan(withLine.prompt.indexOf("LINE-ONCE"));
    expect(withLine.prompt.indexOf("LINE-ONCE")).toBeLessThan(withLine.prompt.indexOf("SPEC (version"));
    expect(withLine.sections.map((s) => s.code)).toEqual(["boundary", "spec", "output"]);
    const without = assemblePrompt(base);
    expect(without.prompt).not.toContain("LINE-ONCE");
    expect(without.prompt).toBe(assemblePrompt({ ...base, contextRulesLine: undefined }).prompt);
  });

  it("pinned files sit after the Spec, are fenced as data, and are never cut at a budget below their size", () => {
    const text = `${"x".repeat(5000)}END`;
    const out = assemblePrompt({ ...base, pinned: [{ label: "PINNED FILE 1 of 1", text: `path: a.md\n${text}` }] }, { spill: true, budgetBytes: 100 });
    expect(out.prompt).toContain("END");
    expect(out.prompt.indexOf("SPEC (version")).toBeLessThan(out.prompt.indexOf("PINNED FILE 1 of 1"));
    expect(out.sections.find((s) => s.code === "pinned")).toMatchObject({ trimmed_bytes: 0 });
    expect(out.sections.find((s) => s.code === "pinned")!.trimmed_reason).toBeUndefined();
  });
});

describe("excludeCovers (D#600 CX-5b: an exclude wins over a pin)", () => {
  it("a folder covers everything under it, and an exact path covers itself", () => {
    expect(excludeCovers("secrets", "secrets/key.txt")).toBe(true);
    expect(excludeCovers("secrets", "secrets/a/b.txt")).toBe(true);
    expect(excludeCovers("secrets/", "secrets/key.txt")).toBe(true);
    expect(excludeCovers("secret/a.txt", "secret/a.txt")).toBe(true);
    expect(excludeCovers("secret/a.txt", "secret/b.txt")).toBe(false);
    expect(excludeCovers("secrets", "secrets-public/readme.md")).toBe(false);
    expect(excludeCovers("a/secrets", "b/a/secrets/x")).toBe(false);
  });

  it("globs: * and ? stay in one folder, ** crosses folders, a character class is a class", () => {
    expect(excludeCovers("**/*.pem", "cfg/prod.pem")).toBe(true);
    expect(excludeCovers("**/*.pem", "prod.pem")).toBe(true);
    expect(excludeCovers("**/*.pem", "cfg/prod.txt")).toBe(false);
    expect(excludeCovers("src/*.ts", "src/a.ts")).toBe(true);
    expect(excludeCovers("src/*.ts", "src/x/a.ts")).toBe(false);
    expect(excludeCovers("src/?.ts", "src/a.ts")).toBe(true);
    expect(excludeCovers("src/**/[ab].ts", "src/x/a.ts")).toBe(true);
    expect(excludeCovers("src/**/[ab].ts", "src/x/c.ts")).toBe(false);
  });

  it("case does not matter: the CLI refused Secret/a.txt under the exclude `secret`, so a pin spelled differently is still covered", () => {
    expect(excludeCovers("secret", "Secret/a.txt")).toBe(true);
    expect(excludeCovers("SECRET/", "secret/a.txt")).toBe(true);
    expect(excludeCovers("**/*.PEM", "cfg/prod.pem")).toBe(true);
    expect(excludeCovers(".ENV", "a/b/.env")).toBe(true);
    expect(excludeCovers("src/[AB].ts", "src/a.ts")).toBe(true);
    expect(excludeCovers("secret", "secrets-public/x")).toBe(false);
  });

  it("a pattern with no slash matches at any depth (so a pin is never let through by a looser reading)", () => {
    expect(excludeCovers(".env", "a/b/.env")).toBe(true);
    expect(excludeCovers(".env", ".env")).toBe(true);
    expect(excludeCovers("*.pem", "deep/er/x.pem")).toBe(true);
  });

  it("brackets, braces and parentheses in a name are ordinary characters outside a class; an empty or broken pattern is handled", () => {
    expect(excludeCovers("a{b,c}.txt", "a{b,c}.txt")).toBe(true);
    expect(excludeCovers("a{b,c}.txt", "ab.txt")).toBe(false);
    expect(excludeCovers("(group)/c.txt", "(group)/c.txt")).toBe(true);
    expect(excludeCovers("", "anything")).toBe(false);
    expect(excludeCovers("/", "anything")).toBe(false);
    expect(excludeCovers("a[", "a[")).toBe(true);
  });
});
