import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDerivedFileRules, type DerivedFileRule } from "@fulcrumaxe/runner-protocol";
import { createChangedFiles, createFailedFiles, createHeadBlob, createIndexHidesChanges } from "../../src/daemon/checkStep.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { testLaunch } from "../helpers/launch.js";
import { pinFixture } from "../helpers/pinFixture.js";
import { DERIVED_FILES_TABLE_PATH, readDerivedRules, verifyDerivedOutputs } from "../../src/daemon/derivedStep.js";
import { scopeVerdict, type VerifyDerived } from "../../src/daemon/scopeStep.js";

const OPENAPI = "api/openapi.json";
const CLIENT = "client/generated.ts";
const ROUTE = "api/src/routes/runs.ts";
const TABLE = { version: 1, rules: [{ id: "routes", kind: "generated", inputs: ["api/src/routes/**"], outputs: [OPENAPI, CLIENT], generators: [["gen-openapi"], ["gen-client"]] }] };
const rules = parseDerivedFileRules(TABLE) as DerivedFileRule[];

describe("scopeVerdict: generated files beside a listed route (#751)", () => {
  const scope = [ROUTE];
  const listing = (...files: string[]) => async () => files;
  const base = { scope, workspace: "/w", base: "b", rules };

  it("counts a generated file outside the list when nothing vouches for it, as before", async () => {
    expect(await scopeVerdict({ ...base, changedFiles: listing(ROUTE, OPENAPI, CLIENT) })).toMatchObject({ outside: 2, derivedFresh: [] });
    expect(await scopeVerdict({ ...base, changedFiles: listing(ROUTE, OPENAPI, CLIENT), verifyDerived: async () => [] })).toEqual({ outside: 2, derivedFresh: [], derivedWhy: { rules: 1, candidates: 2, reason: "not_equal" } });
  });

  it("lifts the files a fresh generator run reproduced, and reports them", async () => {
    let asked: { rules: string[]; paths: string[] } | undefined;
    const verifyDerived: VerifyDerived = async (r, paths) => ((asked = { rules: r.map((x) => x.id), paths: [...paths] }), [...paths]);
    expect(await scopeVerdict({ ...base, changedFiles: listing(ROUTE, OPENAPI, CLIENT), verifyDerived })).toEqual({ outside: 0, derivedFresh: [OPENAPI, CLIENT] });
    expect(asked).toEqual({ rules: ["routes"], paths: [OPENAPI, CLIENT] });
  });

  it("keeps a stale file outside, and never asks about a file that is not a candidate", async () => {
    const seen: string[][] = [];
    const verifyDerived: VerifyDerived = async (_r, paths) => (seen.push([...paths]), [CLIENT]);
    expect(await scopeVerdict({ ...base, changedFiles: listing(ROUTE, OPENAPI, CLIENT, "api/src/openapi.ts"), verifyDerived })).toEqual({ outside: 2, derivedFresh: [CLIENT] });
    expect(seen).toEqual([[OPENAPI, CLIENT]]);
  });

  it("does not verify at all when the route is not in the list, or there is no table", async () => {
    let called = false;
    const verifyDerived: VerifyDerived = async (_r, p) => ((called = true), [...p]);
    expect(await scopeVerdict({ ...base, scope: ["api/test/x.test.ts"], changedFiles: listing("api/test/x.test.ts", OPENAPI), verifyDerived })).toEqual({ outside: 1, derivedFresh: [], derivedWhy: { rules: 1, candidates: 0, reason: "inputs_not_in_scope" } });
    expect(await scopeVerdict({ ...base, rules: [], changedFiles: listing(ROUTE, OPENAPI), verifyDerived })).toEqual({ outside: 1, derivedFresh: [], derivedWhy: { rules: 0, candidates: 0, reason: "no_rules" } });
    expect(called).toBe(false);
  });

  it("counts a file the generators wrote that the first listing did not hold, and vouches for nothing a verifier that throws touched", async () => {
    let calls = 0;
    const changedFiles = async () => (calls++ === 0 ? [ROUTE, OPENAPI] : [ROUTE, OPENAPI, "extra.ts"]);
    expect(await scopeVerdict({ ...base, changedFiles, verifyDerived: async (_r, p) => [...p] })).toEqual({ outside: 1, derivedFresh: [OPENAPI] });
    expect(await scopeVerdict({ ...base, changedFiles: listing(ROUTE, OPENAPI), verifyDerived: async () => { throw new Error("boom"); } })).toEqual({ outside: 1, derivedFresh: [], derivedWhy: { rules: 1, candidates: 1, reason: "unreadable" } });
  });

  it("is still null when the runner cannot say (no list, an unreadable list, no listing)", async () => {
    expect(await scopeVerdict({ ...base, scope: undefined, changedFiles: listing(ROUTE) })).toBeNull();
    expect(await scopeVerdict({ ...base, scope: ["a/?"], changedFiles: listing(ROUTE) })).toBeNull();
    expect(await scopeVerdict({ ...base, changedFiles: async () => null })).toBeNull();
  });
});

describe("verifyDerivedOutputs: a fresh generator run decides (#751)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fx-derived-"));
    mkdirSync(path.join(dir, "api"), { recursive: true });
    mkdirSync(path.join(dir, "client"), { recursive: true });
    writeFileSync(path.join(dir, OPENAPI), "{\"paths\":1}\n");
    writeFileSync(path.join(dir, CLIENT), "export const x = 1;\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A stand-in for the generators: `gen-openapi` writes the document, `gen-client` the client, each from the "truth" it is given. */
  const generators = (truth: { openapi: string; client: string }, ran: string[] = []) => async (argv: readonly string[]): Promise<boolean> => {
    ran.push(argv[0]!);
    writeFileSync(path.join(dir, argv[0] === "gen-openapi" ? OPENAPI : CLIENT), argv[0] === "gen-openapi" ? truth.openapi : truth.client);
    return true;
  };
  const input = (run: (argv: readonly string[]) => Promise<boolean>) => ({ workspace: dir, rules, paths: [OPENAPI, CLIENT], run, dirty: async () => [] as string[], changed: [] as string[], headBlob: async (rel: string) => { try { return readFileSync(path.join(dir, rel)); } catch { return null; } }, hidden: async () => false as boolean | null });

  it("vouches for files equal to the generators' output, running them in table order", async () => {
    const ran: string[] = [];
    expect(await verifyDerivedOutputs(input(generators({ openapi: "{\"paths\":1}\n", client: "export const x = 1;\n" }, ran)))).toEqual([OPENAPI, CLIENT]);
    expect(ran).toEqual(["gen-openapi", "gen-client"]);
  });

  it("does not vouch for a hand-edited or stale file (only for its sibling that is fresh), and puts its bytes back instead of repairing it", async () => {
    expect(await verifyDerivedOutputs(input(generators({ openapi: "{\"paths\":2}\n", client: "export const x = 1;\n" })))).toEqual([CLIENT]);
    expect(readFileSync(path.join(dir, OPENAPI), "utf8")).toBe("{\"paths\":1}\n");
  });

  it("vouches for nothing when a generator fails, and still puts the bytes back", async () => {
    const run = async (argv: readonly string[]): Promise<boolean> => (writeFileSync(path.join(dir, OPENAPI), "changed"), argv[0] !== "gen-client");
    expect(await verifyDerivedOutputs(input(run))).toEqual([]);
    expect(readFileSync(path.join(dir, OPENAPI), "utf8")).toBe("{\"paths\":1}\n");
  });

  it("vouches for nothing when a generator throws", async () => {
    expect(await verifyDerivedOutputs(input(async () => { throw new Error("x"); }))).toEqual([]);
  });

  it("vouches for nothing when a file is missing, or is a link, or sits behind a linked directory", async () => {
    rmSync(path.join(dir, CLIENT));
    expect(await verifyDerivedOutputs(input(generators({ openapi: "{\"paths\":1}\n", client: "" })))).toEqual([]);
    const outside = mkdtempSync(path.join(tmpdir(), "fx-derived-out-"));
    try {
      writeFileSync(path.join(outside, "generated.ts"), "export const x = 1;\n");
      symlinkSync(path.join(outside, "generated.ts"), path.join(dir, CLIENT));
      expect(await verifyDerivedOutputs(input(async () => true))).toEqual([]);
      rmSync(path.join(dir, CLIENT));
      rmSync(path.join(dir, "client"), { recursive: true });
      symlinkSync(outside, path.join(dir, "client"));
      expect(await verifyDerivedOutputs(input(async () => true))).toEqual([]);
      expect(readFileSync(path.join(outside, "generated.ts"), "utf8")).toBe("export const x = 1;\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("verifyDerivedOutputs: only what HEAD commits is vouched for (#751, CWE-367)", () => {
  let repo: string;
  const git = (...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.email=a@b.c", "-c", "user.name=t", ...args], { encoding: "utf8" });
  const capture = (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs, 1024 * 1024, 2048);
  const checks = { dirty: () => createChangedFiles(capture, {})(repo, "HEAD"), changed: [ROUTE], headBlob: (rel: string) => createHeadBlob(capture, {})(repo, rel), hidden: () => createIndexHidesChanges(capture, {})(repo) };
  const dirty = (): Promise<string[] | null> => createChangedFiles(capture, {})(repo, "HEAD");
  const put = (rel: string, text: string): void => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), text);
  };
  const generate = async (argv: readonly string[]): Promise<boolean> => {
    put(argv[0] === "gen-openapi" ? OPENAPI : CLIENT, argv[0] === "gen-openapi" ? "doc\n" : "client\n");
    return true;
  };
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "fx-derived-git-"));
    git("init", "-q");
    put(OPENAPI, "doc\n");
    put(CLIENT, "client\n");
    put("api/src/routes/runs.ts", "export {};\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    pinFixture(repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));
  const run = () => verifyDerivedOutputs({ workspace: repo, rules, paths: [OPENAPI, CLIENT], run: generate, ...checks });

  it("vouches when the committed files equal the generators' output and the tree is clean", async () => {
    expect(await run()).toEqual([OPENAPI, CLIENT]);
  });

  it("the attack: a hand-written file is committed and the fresh bytes are left uncommitted in the working tree; nothing is vouched", async () => {
    put(CLIENT, "HAND WRITTEN\n");
    git("add", "-A");
    git("commit", "-q", "-m", "hand written");
    put(CLIENT, "client\n");
    expect(await dirty()).toEqual([CLIENT]);
    expect(await run()).toEqual([]);
  });

  it("an untracked file or an edit anywhere makes the tree unclean: nothing is vouched", async () => {
    put("stray.txt", "x");
    expect(await run()).toEqual([]);
    rmSync(path.join(repo, "stray.txt"));
    put("api/src/routes/runs.ts", "export const changed = 1;\n");
    expect(await run()).toEqual([]);
  });

  it("a committed stale file is not vouched for, is put back, and leaves the tree clean; a listing that cannot be read vouches for nothing", async () => {
    put(OPENAPI, "stale\n");
    git("add", "-A");
    git("commit", "-q", "-m", "stale");
    expect(await run()).toEqual([CLIENT]);
    expect(readFileSync(path.join(repo, OPENAPI), "utf8")).toBe("stale\n");
    expect(await dirty()).toEqual([]);
    expect(await verifyDerivedOutputs({ workspace: repo, rules, paths: [OPENAPI, CLIENT], run: generate, ...checks, dirty: async () => null })).toEqual([]);
  });

  /** Commits a hand-written client, then leaves the fresh bytes in the working tree and hides the difference from the index. */
  const forgeThenHide = (how: () => void): void => {
    put(CLIENT, "HAND WRITTEN\n");
    git("add", "-A");
    git("commit", "-q", "-m", "hand written");
    how();
    put(CLIENT, "client\n");
  };

  it("assume-unchanged hides the fresh copy from diff and status, but not from the check: nothing is vouched", async () => {
    forgeThenHide(() => git("update-index", "--assume-unchanged", CLIENT));
    expect(await checks.dirty()).toEqual([]);
    expect(await checks.hidden()).toBe(true);
    expect(await run()).toEqual([]);
  });

  it("skip-worktree is the same: nothing is vouched", async () => {
    forgeThenHide(() => git("update-index", "--skip-worktree", CLIENT));
    expect(await checks.dirty()).toEqual([]);
    expect(await checks.hidden()).toBe(true);
    expect(await run()).toEqual([]);
  });

  it("an output HEAD deletes, whose fresh untracked copy an exclude file hides, is never vouched", async () => {
    git("rm", "-q", CLIENT);
    git("commit", "-q", "-m", "delete");
    writeFileSync(path.join(repo, ".git", "info", "exclude"), "client/\n");
    put(CLIENT, "client\n");
    expect(await checks.dirty()).toEqual([]);
    expect(await checks.hidden()).toBe(false);
    expect(await checks.headBlob(CLIENT)).toBeNull();
    expect(await run()).toEqual([]);
  });

  /** Commits a hand-written client as HEAD, restores the fresh bytes in the tree, and returns the honest commit and the evil one. */
  const evilHead = (): { honest: string; evil: string } => {
    const honest = git("rev-parse", "HEAD").trim();
    put(CLIENT, "HAND WRITTEN\n");
    git("add", "-A");
    git("commit", "-q", "-m", "hand written");
    const evil = git("rev-parse", "HEAD").trim();
    put(CLIENT, "client\n");
    return { honest, evil };
  };

  it("a commit replacement (refs/replace) cannot make HEAD read as an honest twin: nothing is vouched, and the guarded read ignores it", async () => {
    const { honest, evil } = evilHead();
    git("replace", evil, honest);
    expect(await checks.hidden()).toBe(true);
    expect((await checks.headBlob(CLIENT))?.toString()).toBe("HAND WRITTEN\n");
    expect(await run()).toEqual([]);
  });

  it("a tree replacement is the same: nothing is vouched", async () => {
    const { honest, evil } = evilHead();
    git("replace", git("rev-parse", `${evil}^{tree}`).trim(), git("rev-parse", `${honest}^{tree}`).trim());
    expect(await checks.hidden()).toBe(true);
    expect((await checks.headBlob(CLIENT))?.toString()).toBe("HAND WRITTEN\n");
    expect(await run()).toEqual([]);
  });

  it("with replacement ignored by the guarded read alone (the listing missed it), a forged HEAD still fails the byte comparison", async () => {
    const { honest, evil } = evilHead();
    git("replace", evil, honest);
    expect(await verifyDerivedOutputs({ workspace: repo, rules, paths: [OPENAPI, CLIENT], run: generate, ...checks, hidden: async () => false })).toEqual([]);
  });

  it("a grafts file is refused too", async () => {
    writeFileSync(path.join(repo, ".git", "info", "grafts"), "");
    expect(await checks.hidden()).toBe(true);
    expect(await run()).toEqual([]);
  });

  it("the object database is read, not the index: HEAD's blob is what was committed", async () => {
    expect((await checks.headBlob(OPENAPI))?.toString()).toBe("doc\n");
    expect(await checks.headBlob("nope.txt")).toBeNull();
    expect(await checks.hidden()).toBe(false);
  });

  it("a changed input that differs from HEAD's blob vouches for nothing", async () => {
    const withInput = () => verifyDerivedOutputs({ workspace: repo, rules, paths: [OPENAPI, CLIENT], run: generate, ...checks, changed: [ROUTE] });
    expect(await withInput()).toEqual([OPENAPI, CLIENT]);
    git("update-index", "--assume-unchanged", ROUTE);
    put(ROUTE, "export const sneaky = 1;\n");
    expect(await withInput()).toEqual([]);
  });

  it("a generator that writes another file leaves the tree unclean afterwards: nothing is vouched", async () => {
    const noisy = async (argv: readonly string[]): Promise<boolean> => (put("junk.txt", "x"), generate(argv));
    expect(await verifyDerivedOutputs({ workspace: repo, rules, paths: [OPENAPI, CLIENT], run: noisy, ...checks })).toEqual([]);
  });
});

describe("readDerivedRules: the table comes from the default branch's copy", () => {
  const at = (bytes: string | null) => async (_dir: string, _base: string, relative: string) => (relative === DERIVED_FILES_TABLE_PATH && bytes !== null ? Buffer.from(bytes) : null);

  it("reads the table the base commit holds", async () => {
    expect((await readDerivedRules(at(JSON.stringify(TABLE)), "/m", "b")).map((r) => r.id)).toEqual(["routes"]);
  });

  it("is the empty table for no file, a table the parser refuses, text that is not JSON, or a read that throws", async () => {
    expect(await readDerivedRules(at(null), "/m", "b")).toEqual([]);
    expect(await readDerivedRules(at(JSON.stringify({ version: 9, rules: [] })), "/m", "b")).toEqual([]);
    expect(await readDerivedRules(at("not json"), "/m", "b")).toEqual([]);
    expect(await readDerivedRules(async () => { throw new Error("x"); }, "/m", "b")).toEqual([]);
  });
});

describe("createFailedFiles: a failing test file's own Run: hint (#751)", () => {
  const FAIL = " FAIL  packages/api-client/test/drift.test.ts > the client matches the document";
  const feed = (...lines: string[]) => {
    const found = createFailedFiles("/w");
    for (const l of lines) found.line(l);
    return found;
  };

  it("takes the first line that starts with Run: after the failure line, as a header line of its own", () => {
    const found = feed(FAIL, "AssertionError: out of date", "    Run: pnpm --filter @fx/api-client gen", "    Run: something else");
    expect(found.hints()).toBe("hint for packages/api-client/test/drift.test.ts: pnpm --filter @fx/api-client gen\n");
  });

  it("takes the Run: that ends an assertion message, the way a runner prints it", () => {
    const found = feed(FAIL, "AssertionError: src/generated.ts is out of date with packages/api/openapi.json. Run: pnpm --filter @fx/api-client gen");
    expect(found.hints()).toBe("hint for packages/api-client/test/drift.test.ts: pnpm --filter @fx/api-client gen\n");
  });

  it("gives each file its own hint, and none to a file that printed none", () => {
    const found = feed(FAIL, "Run: a", " FAIL  packages/x/test/b.test.ts > t", "boom", " FAIL  packages/x/test/c.test.ts > t", "Run: c");
    expect(found.hints()).toBe("hint for packages/api-client/test/drift.test.ts: a\nhint for packages/x/test/c.test.ts: c\n");
  });

  it("ignores a Run: line before any failure, mid-sentence text, and names the widened path", async () => {
    expect(feed("Run: before", "the Run: in the middle of a line").hints()).toBe("");
    const found = createFailedFiles("/w", async () => ["packages/api-client/test/drift.test.ts"]);
    for (const l of [" FAIL  test/drift.test.ts > t", "Run: pnpm gen"]) found.line(l);
    await found.resolve();
    expect(found.hints()).toBe("hint for packages/api-client/test/drift.test.ts: pnpm gen\n");
  });

  it("redacts a credential shape and bounds the hint's length and the number of lines", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(feed(FAIL, `Run: use ${token}`).hints()).not.toContain(token);
    expect(feed(FAIL, `Run: ${"x".repeat(500)}`).hints().length).toBeLessThan(300);
    const many = createFailedFiles("/w");
    for (let n = 0; n < 30; n++) for (const l of [` FAIL  t/f${String(n)}.test.ts > t`, `Run: r${String(n)}`]) many.line(l);
    expect(many.hints().split("\n").filter(Boolean)).toHaveLength(10);
  });
});
