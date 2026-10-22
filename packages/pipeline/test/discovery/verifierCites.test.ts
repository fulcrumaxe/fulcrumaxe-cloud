import { describe, expect, it } from "vitest";
import { CiteReadError, MAX_EXCERPT_CHARS, excerptOf, fileReaderFromContents } from "../../src/discovery/verifierCites.js";
import { recordFromOutput } from "../../src/discovery/verifierResult.js";
import { fakeGithubContents } from "./fakeGithubContents.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const repo = { owner: "acme", name: "widgets" };
const FILE = "line one\nline two\n\tline three\nline four\n";
const files = { "src/a.ts": FILE, "docs/a b#c.md": "alpha\nbeta\n", "src/ctl.ts": "ok\nbad\u0001line\n", "src/big.ts": "x".repeat(1000) + "\ny\n", "src/blank.ts": "a\n\n\nb\n", "src/nul.ts": "ok\nbad\u0000line\n", "src/link": { symlink: "../../outside/target" }, "vendor/sub": { submodule: "https://example.com/x.git" }, "src/huge.ts": "y\n".repeat(600_000) };

const setup = () => {
  const fake = fakeGithubContents(repo, { [SHA]: files, [OTHER]: { "src/a.ts": "different\n" } });
  return { fake, reader: fileReaderFromContents(fake.request, repo) };
};
const out = (claims: unknown[]) => ({ category: "bug", claims });
const cite = (path: string, s: number, e: number) => ({ path, start_line: s, end_line: e });

describe("S4b-1: the system reads the cites and stores the bytes it read", () => {
  it("a cite on real lines gives verified, and the excerpt equals the file's own bytes", async () => {
    const { reader } = setup();
    const r = await recordFromOutput({ envelope: out([{ text: "c", verdict: "supported", cites: [cite("src/a.ts", 2, 3)] }]), sha: SHA, reader });
    expect(r.verification).toBe("verified");
    expect(r.verified_sha).toBe(SHA);
    expect(r.claims).toEqual([{ text: "c", verdict: "supported" }]);
    expect(r.evidence).toEqual([{ kind: "file_lines", ref: "src/a.ts:2-3", excerpt: FILE.split("\n").slice(1, 3).join("\n"), commit_sha: SHA }]);
    expect(r.evidence[0]!.excerpt).toBe("line two\n\tline three");
  });

  it("the same output with lines past the end of the file gives refuted / cite_not_found and keeps no evidence", async () => {
    const { reader } = setup();
    const r = await recordFromOutput({ envelope: out([{ text: "c", verdict: "supported", cites: [cite("src/a.ts", 3, 5)] }]), sha: SHA, reader });
    expect(r.verification).toBe("refuted");
    expect(r.claims).toEqual([{ text: "c", verdict: "refuted", refute_code: "cite_not_found" }]);
    expect(r.evidence).toEqual([]);
  });

  it("a missing file, or a file that exists only at another commit, is cite_not_found", async () => {
    const { reader } = setup();
    for (const path of ["src/none.ts", "src/a.ts/extra"]) {
      const r = await recordFromOutput({ envelope: out([{ text: "c", verdict: "supported", cites: [cite(path, 1, 1)] }]), sha: SHA, reader });
      expect(r.claims[0], path).toEqual({ text: "c", verdict: "refuted", refute_code: "cite_not_found" });
    }
    const r2 = await recordFromOutput({ envelope: out([{ text: "c", verdict: "supported", cites: [cite("docs/a b#c.md", 1, 1)] }]), sha: OTHER, reader });
    expect(r2.claims[0]!.refute_code).toBe("cite_not_found");
  });

  it("a path with a space and a # is percent-encoded on the wire and read (the fake refuses a raw one)", async () => {
    const { reader, fake } = setup();
    const r = await recordFromOutput({ envelope: out([{ text: "c", verdict: "supported", cites: [cite("docs/a b#c.md", 2, 2)] }]), sha: SHA, reader });
    expect(r.evidence[0]).toMatchObject({ ref: "docs/a b#c.md:2", excerpt: "beta" });
    expect(fake.log[0]).toEqual({ path: "/repos/acme/widgets/contents/docs/a%20b%23c.md", ref: SHA });
  });

  it("one failing cite among several makes the claim cite_not_found and drops that claim's other evidence", async () => {
    const { reader } = setup();
    const r = await recordFromOutput({
      envelope: out([
        { text: "bad", verdict: "supported", cites: [cite("src/a.ts", 1, 1), cite("src/a.ts", 9, 9)] },
        { text: "good", verdict: "supported", cites: [cite("src/a.ts", 4, 4)] },
      ]),
      sha: SHA,
      reader,
    });
    expect(r.verification).toBe("partly_verified");
    expect(r.evidence.map((e) => e.ref)).toEqual(["src/a.ts:4"]);
  });

  it("a model-refuted claim whose cites hold is recorded as contradicted; with no cites, or unverifiable, nothing is read", async () => {
    const { reader, fake } = setup();
    const r = await recordFromOutput({
      envelope: out([
        { text: "r", verdict: "refuted", cites: [cite("src/a.ts", 1, 1)] },
        { text: "s", verdict: "supported", cites: [] },
        { text: "u", verdict: "unverifiable", cites: [cite("src/none.ts", 1, 1)] },
      ]),
      sha: SHA,
      reader,
    });
    expect(r.claims).toEqual([{ text: "r", verdict: "refuted", refute_code: "contradicted" }, { text: "s", verdict: "unverifiable" }, { text: "u", verdict: "unverifiable" }]);
    expect(r.verification).toBe("refuted");
    expect(fake.log).toHaveLength(1);
  });

  it("each file is read once per run, however many cites name it, and the evidence is de-duplicated by ref", async () => {
    const { reader, fake } = setup();
    const r = await recordFromOutput({
      envelope: out([
        { text: "a", verdict: "supported", cites: [cite("src/a.ts", 1, 1), cite("src/a.ts", 2, 2)] },
        { text: "b", verdict: "supported", cites: [cite("src/a.ts", 1, 1)] },
      ]),
      sha: SHA,
      reader,
    });
    expect(fake.log).toHaveLength(1);
    expect(r.evidence.map((e) => e.ref)).toEqual(["src/a.ts:1", "src/a.ts:2"]);
  });

  it("an excerpt is cut at 600 characters (a prefix of the file's own bytes); control characters and blank lines are not evidence", async () => {
    const { reader } = setup();
    const big = await recordFromOutput({ envelope: out([{ text: "c", verdict: "supported", cites: [cite("src/big.ts", 1, 1)] }]), sha: SHA, reader });
    expect(big.evidence[0]!.excerpt).toBe("x".repeat(MAX_EXCERPT_CHARS));
    for (const [path, s, e] of [["src/ctl.ts", 2, 2], ["src/blank.ts", 2, 3]] as const) {
      const r = await recordFromOutput({ envelope: out([{ text: "c", verdict: "supported", cites: [cite(path, s, e)] }]), sha: SHA, reader });
      expect(r.claims[0], path).toMatchObject({ verdict: "refuted", refute_code: "cite_not_found" });
    }
  });

  it("excerptOf counts lines the way the file does: a final newline does not add a line, CRLF bytes stay", () => {
    expect(excerptOf("a\nb\n", 2, 2)).toBe("b");
    expect(excerptOf("a\nb\n", 3, 3)).toBeNull();
    expect(excerptOf("a\r\nb\r\n", 1, 2)).toBe("a\r\nb\r");
    expect(excerptOf("a\nb", 2, 2)).toBe("b");
  });
});

describe("only a regular file is evidence (the real contents API answers 200 for more than files)", () => {
  const cases: Array<[string, string]> = [
    ["a directory", "src"],
    ["a symlink", "src/link"],
    ["a submodule", "vendor/sub"],
    ["a file over 1 MB (no inline content)", "src/huge.ts"],
  ];
  it.each(cases)("%s is cite_not_found with no evidence and no metadata in the record", async (_n, path) => {
    const { reader } = setup();
    const r = await recordFromOutput({ envelope: out([{ text: "c", verdict: "supported", cites: [cite(path, 1, 1)] }]), sha: SHA, reader });
    expect(r.verification).toBe("refuted");
    expect(r.claims).toEqual([{ text: "c", verdict: "refuted", refute_code: "cite_not_found" }]);
    expect(r.evidence).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/token=|download_url|raw\.githubusercontent/);
  });

  it("the fake really answers 200 with a tokened link for the first three (so the cases above fail without the type check)", async () => {
    const { fake } = setup();
    for (const [, path] of cases.slice(0, 3)) {
      const res = await fake.request({ method: "GET", path: `/repos/acme/widgets/contents/${path}`, query: { ref: SHA }, accept: "application/vnd.github.object+json", maxBytes: 1 << 20 });
      expect(res.status, path).toBe(200);
    }
    const dir = await fake.request({ method: "GET", path: "/repos/acme/widgets/contents/src", query: { ref: SHA }, accept: "application/vnd.github.object+json", maxBytes: 1 << 20 });
    expect(dir.text).toContain("token=");
  });

  it("no excerpt of a real file contains metadata: it is exactly the decoded file bytes", async () => {
    const { reader } = setup();
    const r = await recordFromOutput({ envelope: out([{ text: "c", verdict: "supported", cites: [cite("src/a.ts", 1, 4)] }]), sha: SHA, reader });
    expect(r.evidence[0]!.excerpt).toBe(FILE.trimEnd());
    expect(r.evidence[0]!.excerpt).not.toContain("token=");
  });

  it("a NUL in the cited lines is cite_not_found (Postgres text cannot hold it)", async () => {
    expect(excerptOf("a\u0000b\n", 1, 1)).toBeNull();
    const { reader } = setup();
    const r = await recordFromOutput({ envelope: out([{ text: "c", verdict: "supported", cites: [cite("src/nul.ts", 2, 2)] }]), sha: SHA, reader });
    expect(r.claims[0]).toMatchObject({ verdict: "refuted", refute_code: "cite_not_found" });
  });

  it("a body that is not a JSON object is a failed read, not a file", async () => {
    for (const text of ["not json", "[]", "null"]) {
      const rd = fileReaderFromContents(async () => ({ status: 200, text }), repo);
      await expect(rd.readFile("a.ts", SHA)).rejects.toBeInstanceOf(CiteReadError);
    }
  });
});

describe("the contents reader keeps the real API's contract", () => {
  it("a failed read is check_failed (read_failed), never a refutation: 5xx, 403, a thrown error", async () => {
    for (const request of [
      async () => ({ status: 502, text: "" }),
      async () => ({ status: 403, text: "" }),
      async () => {
        throw new Error("socket hang up");
      },
    ]) {
      const r = await recordFromOutput({ envelope: out([{ text: "c", verdict: "supported", cites: [cite("src/a.ts", 1, 1)] }]), sha: SHA, reader: fileReaderFromContents(request, repo) });
      expect(r).toMatchObject({ verification: "check_failed", failure: "read_failed", claims: [], evidence: [], verified_sha: null });
    }
  });

  it("refuses a ref that is not a full sha and a repository name that is not a GitHub name", async () => {
    const { fake } = setup();
    await expect(fileReaderFromContents(fake.request, repo).readFile("src/a.ts", "main")).rejects.toThrow(/full commit sha/);
    expect(() => fileReaderFromContents(fake.request, { owner: "a/b", name: "c" })).toThrow(/GitHub name/);
    expect(fake.log).toEqual([]);
  });

  it("an unexpected error class is not swallowed as a read failure", async () => {
    const reader = { readFile: async () => { throw new TypeError("bug"); } };
    await expect(recordFromOutput({ envelope: out([{ text: "c", verdict: "supported", cites: [cite("src/a.ts", 1, 1)] }]), sha: SHA, reader })).rejects.toThrow(TypeError);
    expect(new CiteReadError().message).toBe("cite read failed");
  });
});
