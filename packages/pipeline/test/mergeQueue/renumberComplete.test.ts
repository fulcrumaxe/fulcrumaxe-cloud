import { describe, expect, it } from "vitest";
import { RENUMBER_PUSH_HOPS_MAX, renumberInScope, roundOwnPushes, type PlatformPush } from "../../src/mergeQueue/index.js";

/**
 * D#519 MQ5-b2: the two pure checks of a renumber round's end. No GitHub, no database: a push record log and a path list.
 */
const FROM = "a".repeat(40);
const MID = "b".repeat(40);
const HEAD = "c".repeat(40);
const RUN = "run-1";
const push = (oldSha: string | null, newSha: string, runId = RUN): PlatformPush => ({ oldSha, newSha, startSha: null, runId });
const logOf = (...log: PlatformPush[]) => async (sha: string) => log.filter((p) => p.newSha === sha);

describe("roundOwnPushes (rule a at the round's end)", () => {
  const round = { fromSha: FROM, runId: RUN };

  it("one push of the round's run from from_sha to the head is the round's own", async () => {
    expect(await roundOwnPushes(logOf(push(FROM, HEAD)), round, HEAD)).toBe("ok");
  });

  it("two pushes of the same run chain back to from_sha", async () => {
    expect(await roundOwnPushes(logOf(push(FROM, MID), push(MID, HEAD)), round, HEAD)).toBe("ok");
  });

  it("a person's commit in the range leaves a break in the chain", async () => {
    // The platform pushed HEAD on top of MID, but nothing records how MID came to be: it is not the round's.
    expect(await roundOwnPushes(logOf(push(MID, HEAD)), round, HEAD)).toBe("foreign");
    expect(await roundOwnPushes(logOf(), round, HEAD)).toBe("foreign");
  });

  it("a record of another run, or one that created the branch, is no link", async () => {
    expect(await roundOwnPushes(logOf(push(FROM, HEAD, "run-2")), round, HEAD)).toBe("foreign");
    expect(await roundOwnPushes(logOf(push(null, HEAD)), round, HEAD)).toBe("foreign");
    expect(await roundOwnPushes(logOf(push(FROM, MID), push(MID, HEAD, "run-2")), round, HEAD)).toBe("foreign");
  });

  it("a record whose new tip is not the one asked for is no link", async () => {
    expect(await roundOwnPushes(async () => [push(FROM, MID)], round, HEAD)).toBe("foreign");
  });

  it("proof that cannot be read is unread, never ok", async () => {
    expect(await roundOwnPushes(async () => null, round, HEAD)).toBe("unread");
    expect(await roundOwnPushes(async (sha) => (sha === HEAD ? [push(MID, HEAD)] : null), round, HEAD)).toBe("unread");
  });

  it("a chain longer than the bound fails closed, and a loop cannot run for ever", async () => {
    const reads: string[] = [];
    // A record that points at itself never reaches from_sha.
    expect(await roundOwnPushes(async (sha) => (reads.push(sha), [push(sha, sha)]), round, HEAD)).toBe("foreign");
    expect(reads).toHaveLength(RENUMBER_PUSH_HOPS_MAX);
  });
});

describe("renumberInScope (the scope test)", () => {
  const DIR = "packages/db/migrations";
  const isResource = (p: string) => p.startsWith(`${DIR}/`) && p.endsWith(".sql");
  const base = {
    changed: [`${DIR}/0710_x.sql`, `${DIR}/0713_x.sql`, "packages/db/src/refs.ts"],
    renamed: [`${DIR}/0710_x.sql`],
    prFiles: [`${DIR}/0710_x.sql`, "packages/db/src/refs.ts", "docs/notes.md"],
    isResource,
  };
  const scope = (over: Partial<typeof base> = {}) => renumberInScope({ ...base, ...over });

  it("the renamed file, its new name beside it, and a file the pull request already changed are in scope", () => {
    expect(scope()).toBe(true);
  });

  it("a path the pull request never changed is out of scope", () => {
    expect(scope({ changed: [...base.changed, "src/other.ts"] })).toBe(false);
    expect(scope({ changed: [...base.changed, ".github/workflows/ci.yml"] })).toBe(false);
  });

  it("an extra resource file, an edit of another resource, or a new file in another directory is out of scope", () => {
    expect(scope({ changed: [...base.changed, `${DIR}/0714_extra.sql`] })).toBe(false);
    expect(scope({ changed: [...base.changed, `${DIR}/0600_old.sql`], prFiles: [...base.prFiles, `${DIR}/0600_old.sql`] })).toBe(false);
    expect(scope({ changed: [`${DIR}/0710_x.sql`, "other/dir/0713_x.sql", "packages/db/src/refs.ts"], isResource: (p) => p.endsWith(".sql") })).toBe(false);
  });

  it("a renamed file the round left alone, or no new file at all, is out of scope", () => {
    expect(scope({ changed: [`${DIR}/0713_x.sql`, "packages/db/src/refs.ts"] })).toBe(false);
    expect(scope({ changed: [`${DIR}/0710_x.sql`, "packages/db/src/refs.ts"] })).toBe(false);
  });

  it("nothing renamed is out of scope", () => {
    expect(scope({ renamed: [], changed: ["packages/db/src/refs.ts"] })).toBe(false);
  });

  it("two renamed files take two new files, one each", () => {
    const two = { renamed: [`${DIR}/0710_x.sql`, `${DIR}/0711_y.sql`], prFiles: [`${DIR}/0710_x.sql`, `${DIR}/0711_y.sql`] };
    expect(scope({ ...two, changed: [...two.renamed, `${DIR}/0713_x.sql`, `${DIR}/0714_y.sql`] })).toBe(true);
    expect(scope({ ...two, changed: [...two.renamed, `${DIR}/0713_x.sql`] })).toBe(false);
  });
});
