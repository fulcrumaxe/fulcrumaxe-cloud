import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D#519 MQ4-e2-c1 (C19-1): the signed `conflict_round` job key comes from a typed `conflictRound` input that only a merge-conflict round's start sets. The ordinary fix-round start never does.
 * This scan pins where the input is built, where it is forwarded, and where the issuer reads it, so a new start path cannot set it without this test naming the file.
 */
const ROOT = join(__dirname, "../../..");
const SKIP = new Set(["node_modules", ".next", "dist", "_generated", "test", "tests", "archive"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}
// The start chain's field (other files use the word for the plane-push round, a different thing).
const FIELD = /conflictRound\??:\s*\{\s*fromSha|conflictRound:\s*(req|input)\.conflictRound|\b(run|input|req)\.conflictRound\b/;
const files = [...sources(join(ROOT, "packages")), ...sources(join(ROOT, "apps"))];
const mentions = files.filter((f) => FIELD.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f)).sort();
const text = (p: string): string => readFileSync(join(ROOT, p), "utf8");

describe("the conflictRound input has one origin", () => {
  it("is named only by the files that build it, carry it or read it", () => {
    expect(mentions).toEqual([
      "apps/web/lib/mergeQueueConflict.ts",
      "packages/runner/src/executionTarget.ts",
      "packages/runner/src/startAgentRun.ts",
      "packages/runner/src/targets/jobIssuer.ts",
      "packages/worker/src/advance.ts",
    ]);
  });

  it("is built in one place: the conflict round's own start, from the round row it was handed, in a request of kind conflict", () => {
    const src = text("apps/web/lib/mergeQueueConflict.ts");
    expect(src.match(/conflictRound:/g)).toHaveLength(1);
    const call = src.slice(src.indexOf("advanceStartFix(l.who, {"), src.indexOf("conflictRound:") + 160);
    expect(call).toContain('kind: "conflict"');
    expect(call).toContain("conflictRound: { fromSha: round.fromSha, baseSha: round.baseSha, baseRef: round.baseRef }");
  });

  it("is forwarded by the fix start only for a conflict request (both the fresh-session start and the resume), and refused on any other kind", () => {
    const src = text("packages/worker/src/advance.ts");
    const forwards = src.match(/\.\.\.\(conflict && req\.conflictRound \? \{ conflictRound: req\.conflictRound \} : \{\}\)/g) ?? [];
    expect(forwards).toHaveLength(2);
    expect(src).toContain("(req.conflictRound === undefined || (conflict && SHA_RE.test(req.conflictRound.fromSha)");
    // No other place in the file reads the request's field.
    expect(src.match(/req\.conflictRound/g)).toHaveLength(2 * 2 + 3);
  });

  it("is read at issue time only from the run it was carried on, never from the database", () => {
    const src = text("packages/runner/src/targets/jobIssuer.ts");
    expect(src.match(/run\.conflictRound/g)).toHaveLength(4);
    expect(src).not.toMatch(/merge_conflict_rounds/);
  });
});
