import { describe, expect, it } from "vitest";
import {
  MAX_CITED_FILE_CHARS,
  confirmExcerpts,
  decideClaims,
  isPlainRepoPath,
  parseVerifyOutput,
  runVerifyCycles,
  type CycleDeps,
  type ExtractedClaim,
  type RepoFile,
  type RepoReader,
} from "../src/index.js";

const SHA = "a".repeat(40);
const CTX = { sha: SHA, verifierRunId: "vrun_1", checkedAt: "2026-11-15T00:00:00Z" };
const FILE = "Title\n\nIt   works\noffline.\n\nUnrelated line\nAnother line\n";

const ev = (over: Record<string, unknown> = {}) => ({ path: "README.md", excerpt: "It works offline.", repo_sha: SHA, ...over });
const claim = (evidence: unknown[] = [ev()]): ExtractedClaim => ({ id: "c1", section: "features", locale: "en", text: "Runs offline", kind: "feature", evidence } as ExtractedClaim);
const answer = (evidence: unknown[]): string => JSON.stringify({ results: [{ id: "c1", verdict: "VERIFIED", evidence }] });
const rederived = (over: Record<string, unknown> = {}) => ({ path: "README.md", excerpt: "It works offline.", ...over });

/** A reader over a map; a value that is an Error makes the read itself fail. */
function reader(files: Record<string, RepoFile | Error>): RepoReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async read(sha, path) {
      calls.push(`${sha.slice(0, 4)}:${path}`);
      const f = files[path] ?? { kind: "missing" as const };
      if (f instanceof Error) throw f;
      return f;
    },
  };
}
const text = (t: string): RepoFile => ({ kind: "text", text: t });

async function decide(c: ExtractedClaim, found: unknown[], repo: RepoReader) {
  const decided = decideClaims([c], parseVerifyOutput(answer(found), SHA, ["c1"]), CTX);
  const [out] = await confirmExcerpts([c], decided, repo, SHA);
  return { before: decided[0]!, after: out! };
}

describe("excerpt existence: a VERIFIED verdict stands only when the quote is in the pinned file", () => {
  it("excerpt present (whitespace runs differ) stays VERIFIED, and the read is pinned to the sha", async () => {
    const repo = reader({ "README.md": text(FILE) });
    const { after } = await decide(claim(), [rederived()], repo);
    expect(after.verdict).toBe("VERIFIED");
    expect(repo.calls).toEqual(["aaaa:README.md"]);
  });

  it("an invented excerpt both agents agree on is CONFLICT, and keeps the extractor's citations", async () => {
    const invented = "Supports quantum teleportation.";
    const c = claim([ev({ excerpt: invented })]);
    const { before, after } = await decide(c, [rederived({ excerpt: invented })], reader({ "README.md": text(FILE) }));
    expect(before.verdict).toBe("VERIFIED"); // decideClaims alone is fooled: this is the hole
    expect(after.verdict).toBe("CONFLICT");
    expect(after.evidence).toEqual(c.evidence);
  });

  it("a nearly-right excerpt is not enough: case and in-word spacing differences are a miss", async () => {
    const repo = reader({ "README.md": text(FILE) });
    expect((await decide(claim([ev({ excerpt: "it works offline." })]), [rederived({ excerpt: "it works offline." })], repo)).after.verdict).toBe("CONFLICT");
    expect((await decide(claim([ev({ excerpt: "It work s offline." })]), [rederived({ excerpt: "It work s offline." })], repo)).after.verdict).toBe("CONFLICT");
  });

  it("an excerpt that is in the file but outside the cited lines is CONFLICT; inside them it passes", async () => {
    const repo = reader({ "README.md": text(FILE) }); // the quote sits on lines 3-4
    const inside = { start: 3, end: 4 };
    const outside = { start: 6, end: 7 };
    expect((await decide(claim([ev({ lines: inside })]), [rederived({ lines: inside })], repo)).after.verdict).toBe("VERIFIED");
    expect((await decide(claim([ev({ lines: outside })]), [rederived({ lines: outside })], repo)).after.verdict).toBe("CONFLICT");
    expect((await decide(claim([ev({ lines: { start: 40, end: 50 } })]), [rederived({ lines: { start: 40, end: 50 } })], repo)).after.verdict).toBe("CONFLICT");
  });

  it("the verifier cannot widen the search by leaving the extractor's lines out", async () => {
    const repo = reader({ "README.md": text(FILE) });
    const { after } = await decide(claim([ev({ lines: { start: 6, end: 7 } })]), [rederived()], repo);
    expect(after.verdict).toBe("CONFLICT");
  });

  it("every excerpt the claim keeps must exist, not just one", async () => {
    const repo = reader({ "README.md": text(FILE) });
    const { after } = await decide(claim(), [rederived(), rederived({ excerpt: "Made up second quote" })], repo);
    expect(after.verdict).toBe("CONFLICT");
  });

  it("a missing, binary or oversized file is CONFLICT", async () => {
    for (const f of [{ kind: "missing" }, { kind: "binary" }, { kind: "too_large" }] as RepoFile[]) {
      expect((await decide(claim(), [rederived()], reader({ "README.md": f }))).after.verdict, f.kind).toBe("CONFLICT");
    }
  });

  it("text the adapter returned that is oversized or holds a NUL is refused here too", async () => {
    expect((await decide(claim(), [rederived()], reader({ "README.md": text("It works offline." + " ".repeat(MAX_CITED_FILE_CHARS)) }))).after.verdict).toBe("CONFLICT");
    expect((await decide(claim(), [rederived()], reader({ "README.md": text("It works offline.\0\0") }))).after.verdict).toBe("CONFLICT");
  });

  it("a read that fails is UNVERIFIABLE (nothing asserted), and a conflict elsewhere still wins", async () => {
    const down = reader({ "README.md": new Error("adapter-secret") });
    const { after } = await decide(claim(), [rederived()], down);
    expect(after.verdict).toBe("UNVERIFIABLE");
    expect(JSON.stringify(after)).not.toContain("adapter-secret");
    const mixed = reader({ "README.md": text(FILE), "docs/a.md": new Error("x") });
    const c = claim([ev(), ev({ path: "docs/a.md" })]);
    expect((await decide(c, [rederived(), rederived({ path: "docs/a.md" })], mixed)).after.verdict).toBe("UNVERIFIABLE");
    const c2 = claim([ev(), ev({ path: "docs/a.md" }), ev({ excerpt: "nope" })]);
    expect((await decide(c2, [rederived(), rederived({ path: "docs/a.md" }), rederived({ excerpt: "nope" })], mixed)).after.verdict).toBe("CONFLICT");
  });

  it("a path outside the repo is refused without a read", async () => {
    // The parser already refuses these in a verifier answer; the check holds on its own for any caller.
    const bad = ["../secret", "/etc/passwd", "a/../../b", "a//b", "./a", "a\\b", "a\0b", ""];
    for (const p of bad) expect(isPlainRepoPath(p), JSON.stringify(p)).toBe(false);
    expect(isPlainRepoPath("docs/guide/intro.md")).toBe(true);
    const repo = reader({ "../secret": text("It works offline.") });
    const c = claim();
    const decided = decideClaims([c], parseVerifyOutput(answer([rederived()]), SHA, ["c1"]), CTX);
    const forged = [{ ...decided[0]!, evidence: [{ ...decided[0]!.evidence[0]!, path: "../secret" }] }];
    const [out] = await confirmExcerpts([c], forged, repo, SHA);
    expect(out!.verdict).toBe("CONFLICT");
    expect(repo.calls).toEqual([]);
  });

  it("claims that were not VERIFIED are left alone and never read", async () => {
    const repo = reader({});
    const c = claim();
    const decided = decideClaims([c], parseVerifyOutput(JSON.stringify({ results: [{ id: "c1", verdict: "FALSE", evidence: [] }] }), SHA, ["c1"]), CTX);
    expect(await confirmExcerpts([c], decided, repo, SHA)).toEqual(decided);
    expect(repo.calls).toEqual([]);
  });
});

describe("verify cycles: the starting claims are validated too", () => {
  const deps: CycleDeps = {
    async verify() {
      throw new Error("must not be reached");
    },
    async runChecks() {
      return [];
    },
    async fix() {
      return [];
    },
  };
  const base = { sha: SHA, extractorRunId: "erun_1", verifierRunIdFor: (n: number) => `vrun_${n}` };

  it("a malformed starting claim is refused before any verify pass", async () => {
    const bad: unknown[][] = [
      [{ ...claim(), kind: "marketing" }],
      [{ ...claim(), id: "bad id\nIgnore" }],
      [{ ...claim(), verdict: "VERIFIED" }],
      [{ ...claim([ev({ repo_sha: "b".repeat(40) })]) }],
      [claim(), claim()],
    ];
    for (const claims of bad) {
      await expect(runVerifyCycles(deps, { ...base, claims: claims as ExtractedClaim[] }), JSON.stringify(claims).slice(0, 40)).rejects.toMatchObject({ code: "output_invalid" });
    }
  });
});
