import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileOverlay } from "../../src/planePush/planePush.js";
import { privateSourceRefusals, type PrivateSourceChange } from "../../src/planePush/planePushPrivateSource.js";
import { PlaneRouteError, routeAndPush, type PlaneRouteDeps, type PlaneRouteInput, type RepoPairing } from "../../src/planePush/planePushRoute.js";

/** Content that comes from a private-only path, on real git objects in a temp repository. Fixture values are invented. */

let dir: string;
const env = (): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
const sh = (...args: string[]): string => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: env() }).trim();
const put = (p: string, c: string): void => {
  mkdirSync(dirname(join(dir, p)), { recursive: true });
  writeFileSync(join(dir, p), c);
};
const commitAll = (m: string): string => {
  sh("add", "-A");
  sh("commit", "-q", "-m", m);
  return sh("rev-parse", "HEAD");
};
const OVERLAY = ["docs/ops/", "rules/"];
const PLAN = "the private plan, line one\nline two\nline three\nline four\nline five\n";
let base: string;

const m = compileOverlay(OVERLAY);
if ("error" in m) throw new Error(m.error);
const match = m.match;

async function refusals(head: string): Promise<string[]> {
  const raw = execFileSync("git", ["-C", dir, "diff", "--raw", "-z", "--no-abbrev", "--no-renames", base, head], { env: env() }).toString("latin1").split("\0");
  const changes: PrivateSourceChange[] = [];
  for (let n = 0; n + 1 < raw.length; n += 2) {
    const r = /^:(\d+) (\d+) ([0-9a-f]{40}) ([0-9a-f]{40}) (\w)$/.exec(raw[n] ?? "");
    if (r) changes.push({ key: raw[n + 1] as string, deleted: r[5] === "D", mode: r[2] as string, sha: r[4] as string });
  }
  return (await privateSourceRefusals(dir, changes, base, head, match)).map((x) => `${x.kind}|${x.path}|${x.message}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "private-source-"));
  sh("init", "-q", "-b", "trunk");
  put("src/a.ts", "export const a = 1;\n");
  put("docs/ops/plan.md", PLAN);
  put("rules/ids.txt", "short\n");
  base = commitAll("base");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("content from a private-only path", () => {
  it("passes an ordinary public change and a delete of an overlay file (controls)", async () => {
    put("src/b.ts", "export const b = 2;\n");
    sh("rm", "-q", "docs/ops/plan.md");
    expect(await refusals(commitAll("ordinary"))).toEqual([]);
  });

  it("refuses a move of an overlay file to a public path, naming both paths and no content", async () => {
    sh("mv", "docs/ops/plan.md", "src/plan.md");
    const r = await refusals(commitAll("move"));
    expect(r.length).toBeGreaterThan(0);
    expect(r.join("\n")).toContain("src/plan.md");
    expect(r.join("\n")).toContain("docs/ops/plan.md");
    expect(r.join("\n")).not.toContain("private plan");
  });

  it("refuses a move with small edits (git still sees a rename)", async () => {
    sh("mv", "docs/ops/plan.md", "src/plan.md");
    put("src/plan.md", `${PLAN}one more line\n`);
    const r = await refusals(commitAll("move and edit"));
    expect(r.some((x) => x.includes("src/plan.md") && x.includes("docs/ops/plan.md"))).toBe(true);
  });

  it("refuses a copy that keeps the original (same content under a public name)", async () => {
    put("src/copy.md", PLAN);
    const r = await refusals(commitAll("copy"));
    expect(r.length).toBeGreaterThan(0);
    for (const x of r) expect(x).toContain("src/copy.md");
    expect(r.join("\n")).toContain("docs/ops/plan.md");
  });

  it("refuses a copy of a file that is only in the item's head, not in the base", async () => {
    put("docs/ops/new.md", "brand new private text\n");
    put("src/new.md", "brand new private text\n");
    const r = await refusals(commitAll("both new"));
    expect(r.some((x) => x.includes("src/new.md") && x.includes("docs/ops/new.md"))).toBe(true);
  });

  it("does not refuse an empty public file just because an overlay file is empty", async () => {
    put("docs/ops/empty", "");
    base = commitAll("empty overlay file");
    put("src/empty", "");
    expect(await refusals(commitAll("empty public"))).toEqual([]);
  });

  it("refuses a symlink into an overlay path (file or directory), and passes one to a public path", async () => {
    symlinkSync("../docs/ops/plan.md", join(dir, "src/link"));
    symlinkSync("../docs/ops", join(dir, "src/dirlink"));
    symlinkSync("a.ts", join(dir, "src/ok"));
    const r = await refusals(commitAll("links"));
    expect(r.map((x) => x.split("|")[1]).sort()).toEqual(["src/dirlink", "src/link"]);
  });
});

describe("through the route", () => {
  const pairing: RepoPairing = { enabled: true, codeRepo: "acme/widgets", overlayGlobs: OVERLAY, identifierRulesPath: null, planDataRulesPath: null };
  it("refuses with the private-path code before anything is built, minted or pushed", async () => {
    sh("mv", "docs/ops/plan.md", "src/plan.md");
    const head = commitAll("move");
    const own = { owner: "acme", name: "widgets-private" };
    const transport = { fetchTip: vi.fn(async () => base), push: vi.fn() };
    const mintPushToken = vi.fn(async () => "x");
    const input: PlaneRouteInput = {
      repoDir: dir, privateBase: base, privateHead: head, privateDefaultTip: base, own, defaultBranch: "trunk", branch: "item-1", title: "Move a file", body: "Moves a file.",
      identity: { name: "Bot", email: "bot@example.test" }, commitTime: 1_700_000_000,
    };
    const deps = { loadPairing: async () => pairing, loadOwn: async () => own, api: { mintPushToken, branchExists: vi.fn(), openPullRequest: vi.fn() }, transport } as unknown as PlaneRouteDeps;
    const e = await routeAndPush(input, deps).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(PlaneRouteError);
    expect((e as PlaneRouteError).code).toBe("private_path_change");
    expect((e as PlaneRouteError).message).toContain("src/plan.md");
    expect((e as PlaneRouteError).message).not.toContain("private plan");
    expect(mintPushToken).not.toHaveBeenCalled();
    expect(transport.push).not.toHaveBeenCalled();
  });
});

describe("a git failure or a cut-short search inside the check", () => {
  const none: PrivateSourceChange[] = [];

  it("refuses when git reports rename detection was cut short (explicit limit, a larger change set)", async () => {
    put("docs/ops/plan2.md", `${PLAN}and a second private file\n`);
    base = commitAll("second overlay file");
    for (let n = 0; n < 6; n++) put(`src/gen${n}.txt`, `generated ${n}\nwith a few lines\nof its own\n`);
    const head = commitAll("many files");
    const r = await privateSourceRefusals(dir, none, base, head, match, 1);
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe("overlay_path");
    expect(r[0]?.message).toContain("cut short");
    // the default limit handles the same change set normally
    expect(await privateSourceRefusals(dir, none, base, head, match)).toEqual([]);
  });

  it("rejects, never passes, when the rename diff fails (unknown objects)", async () => {
    const missing = "1".repeat(40);
    await expect(privateSourceRefusals(dir, none, base, missing, match)).rejects.toThrow(/git diff failed/);
  });

  it("rejects, never passes, when the tree listing fails after the diff succeeded", async () => {
    // The same blob id on both sides diffs cleanly, but it names no tree, so only the ls-tree listing can fail.
    const blob = sh("rev-parse", "HEAD:src/a.ts");
    const live: PrivateSourceChange[] = [{ key: "src/x.ts", deleted: false, mode: "100644", sha: blob }];
    await expect(privateSourceRefusals(dir, live, blob, blob, match)).rejects.toThrow(/git ls-tree failed/);
  });
});
