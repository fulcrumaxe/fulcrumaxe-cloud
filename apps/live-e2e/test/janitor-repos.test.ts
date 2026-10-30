/**
 * The stale-repo janitor (`janitor repos`) against a strict stand-in for `gh`. The fake accepts only the argument
 * shapes the real CLI accepts for the three calls we make (`auth status --hostname`, `api --paginate <path> --jq`, `api
 * -X DELETE repos/<owner>/<name>`), answers a listing as `--jq` would (one JSON object per line), and records any
 * other call as `bad`. Offline: real GitHub is never called, and no token exists anywhere here.
 *
 * What it cannot fake: GitHub's real paging, the delete_repo scope check and rate limits.
 */
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { isStale, runReposJanitor, type GhRunner, type ReposJanitorOptions, type ReposResult } from "../src/janitor/repos.js";
import { makeIo, scratchRoot } from "./helpers.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const ago = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();
const ORG = "test-org";

class FakeGh {
  repos = new Map<string, string>();
  loggedIn = true;
  failDelete = new Set<string>();
  listFails = false;
  /** What a re-read of one repo answers when it differs from the listing, and whether the re-read fails. */
  refetchCreated = new Map<string, string>();
  refetchFails = false;
  refetchName = new Map<string, string>();
  rawLines: string[] = [];
  fetched: string[] = [];
  calls: string[][] = [];
  deleted: string[] = [];
  bad: string[][] = [];
  add(full: string, createdAt: string): this {
    this.repos.set(full, createdAt);
    return this;
  }
  run: GhRunner = async (args) => {
    this.calls.push(args);
    const ok = (stdout = ""): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr: string): { code: number; stdout: string; stderr: string } => ({ code: 1, stdout: "", stderr });
    const [a, b, c, d, e] = args;
    if (args.length === 4 && a === "auth" && b === "status" && c === "--hostname" && d === "github.com") return this.loggedIn ? ok() : fail("not logged in");
    if (args.length === 5 && a === "api" && b === "--paginate" && c === `orgs/${ORG}/repos?per_page=100&type=all` && d === "--jq" && e === ".[] | {full_name, created_at}") {
      if (!this.loggedIn || this.listFails) return fail("boom");
      return ok([...this.repos].map(([full_name, created_at]) => JSON.stringify({ full_name, created_at })).concat(this.rawLines).join("\n"));
    }
    if (args.length === 4 && a === "api" && b?.startsWith(`repos/${ORG}/`) === true && c === "--jq" && d === "{full_name, created_at}") {
      const full = b.slice("repos/".length);
      this.fetched.push(full);
      if (this.refetchFails || !this.repos.has(full)) return fail("HTTP 404");
      return ok(JSON.stringify({ full_name: this.refetchName.get(full) ?? full, created_at: this.refetchCreated.get(full) ?? this.repos.get(full) }));
    }
    if (args.length === 4 && a === "api" && b === "-X" && c === "DELETE" && d?.startsWith(`repos/${ORG}/`) === true) {
      const full = d.slice("repos/".length);
      if (!this.repos.has(full) || this.failDelete.has(full)) return fail("HTTP 403");
      this.repos.delete(full);
      this.deleted.push(full);
      return ok();
    }
    this.bad.push(args);
    return fail("unknown gh invocation");
  };
}

const standard = (): FakeGh =>
  new FakeGh()
    .add(`${ORG}/e2e-tmp-old`, ago(30))
    .add(`${ORG}/e2e-tmp-new`, ago(2))
    .add(`${ORG}/e2e-tmp-edge`, ago(24))
    .add(`${ORG}/fixture`, ago(900))
    .add(`${ORG}/old-e2e-tmp-x`, ago(900))
    .add(`${ORG}/e2e-tmpfoo`, ago(900));

async function go(fake: FakeGh, over: Partial<ReposJanitorOptions> = {}): Promise<{ result: ReposResult; lines: string[]; asked: string[] }> {
  const lines: string[] = [];
  const asked: string[] = [];
  const result = await runReposJanitor({ org: ORG, apply: false, env: {}, now: NOW, gh: fake.run, confirm: async (q) => (asked.push(q), ORG), say: (l) => lines.push(l), ...over });
  return { result, lines, asked };
}
const reason = (r: ReposResult): string => (r.status === "refused" ? r.reason : r.status);

describe("janitor repos", () => {
  it("dry run is the default: lists only the stale e2e-tmp repos and deletes nothing", async () => {
    const f = standard();
    const { result, lines, asked } = await go(f);
    expect(lines).toEqual([`would delete ${ORG}/e2e-tmp-old`]);
    expect(result).toEqual({ status: "done", repos: [`${ORG}/e2e-tmp-old`], applied: false });
    expect(f.calls.some((c) => c.includes("DELETE"))).toBe(false);
    expect(asked).toEqual([]);
    expect(f.bad).toEqual([]);
  });

  it("with --apply and the org typed, deletes exactly the stale e2e-tmp repos", async () => {
    const f = standard();
    const { result, lines } = await go(f, { apply: true });
    expect(result.status).toBe("done");
    expect(f.deleted).toEqual([`${ORG}/e2e-tmp-old`]);
    expect([...f.repos.keys()].sort()).toEqual([`${ORG}/e2e-tmp-edge`, `${ORG}/e2e-tmp-new`, `${ORG}/e2e-tmpfoo`, `${ORG}/fixture`, `${ORG}/old-e2e-tmp-x`]);
    expect(lines).toEqual([`done: delete ${ORG}/e2e-tmp-old`]);
    expect(f.bad).toEqual([]);
  });

  it("never touches what it does not own: prefix must be exact, age strictly over a day", async () => {
    const f = standard();
    await go(f, { apply: true });
    for (const kept of ["e2e-tmp-new", "e2e-tmp-edge", "fixture", "old-e2e-tmp-x", "e2e-tmpfoo"]) expect(f.repos.has(`${ORG}/${kept}`)).toBe(true);
  });

  it("an unreadable or missing created_at is never deleted", async () => {
    const f = standard().add(`${ORG}/e2e-tmp-nodate`, "not a date");
    const { lines } = await go(f);
    expect(lines).toEqual([`would delete ${ORG}/e2e-tmp-old`]);
  });

  it("a typed answer that is not exactly the org deletes nothing", async () => {
    for (const typed of ["", "yes", "TEST-ORG", " test-org", "test"]) {
      const f = standard();
      const { result } = await go(f, { apply: true, confirm: async () => typed });
      expect(reason(result)).toBe("janitor-repos-not-confirmed");
      expect(f.deleted).toEqual([]);
    }
  });

  it("asks for the confirmation only with --apply and only when there is something to delete", async () => {
    const f = new FakeGh().add(`${ORG}/fixture`, ago(900));
    const { asked, lines } = await go(f, { apply: true });
    expect(asked).toEqual([]);
    expect(lines).toEqual(["nothing to do"]);
  });

  it("refuses when a listed repo is outside the org, before any delete", async () => {
    const f = standard().add("other-org/e2e-tmp-old", ago(900));
    const { result } = await go(f, { apply: true });
    expect(reason(result)).toBe("janitor-repos-outside-org");
    expect(f.deleted).toEqual([]);
  });

  it("the per-repo test itself rejects a repo of another org, even for a matching name and age", () => {
    expect(isStale({ full_name: `${ORG}/e2e-tmp-old`, created_at: ago(30) }, ORG, NOW)).toBe(true);
    expect(isStale({ full_name: "other-org/e2e-tmp-old", created_at: ago(30) }, ORG, NOW)).toBe(false);
    expect(isStale({ full_name: `${ORG}/sub/e2e-tmp-old`, created_at: ago(30) }, ORG, NOW)).toBe(false);
  });

  it("compares the owner with an ASCII-only fold: case variants match, the Kelvin sign does not", async () => {
    expect(isStale({ full_name: "TEST-ORG/e2e-tmp-old", created_at: ago(30) }, ORG, NOW)).toBe(true);
    expect(isStale({ full_name: "test-org/e2e-tmp-old", created_at: ago(30) }, "Test-Org", NOW)).toBe(true);
    // U+212A folds to "k" under toLowerCase; here it must stay a different org.
    expect(isStale({ full_name: "Ke/e2e-tmp-old", created_at: ago(30) }, "ke", NOW)).toBe(false);
    const f = new FakeGh().add(`${ORG}/e2e-tmp-old`, ago(30));
    f.rawLines.push(JSON.stringify({ full_name: "Ke/e2e-tmp-old", created_at: ago(30) }));
    expect(reason((await go(f, { org: ORG })).result)).toBe("janitor-repos-outside-org");
  });

  it("an upper-case name prefix does not match", () => {
    expect(isStale({ full_name: `${ORG}/E2E-TMP-old`, created_at: ago(30) }, ORG, NOW)).toBe(false);
    expect(isStale({ full_name: `${ORG}/e2e-TMP-old`, created_at: ago(30) }, ORG, NOW)).toBe(false);
  });

  it("a null or non-object row from gh is a list failure, not a throw", async () => {
    for (const raw of ["null", "7", '"x"', "[1]"]) {
      const f = standard();
      f.rawLines.push(raw);
      expect(reason((await go(f, { apply: true })).result)).toBe("janitor-repos-list-failed");
      expect(f.deleted).toEqual([]);
    }
  });

  it("refuses when GH_HOST is set, naming the variable and never its value", async () => {
    const f = standard();
    const { result } = await go(f, { env: { GH_HOST: "ghe.example.test" } });
    expect(reason(result)).toBe("janitor-repos-not-local");
    expect(JSON.stringify(result)).toContain("GH_HOST");
    expect(JSON.stringify(result)).not.toContain("ghe.example");
    expect(f.calls).toEqual([]);
  });

  it("re-reads each repo before deleting it: a changed created_at or a failed read deletes nothing", async () => {
    const changed = standard();
    changed.refetchCreated.set(`${ORG}/e2e-tmp-old`, ago(1));
    const a = await go(changed, { apply: true });
    expect(a.result).toMatchObject({ status: "refused", reason: "janitor-repos-delete-failed", done: 0 });
    expect(changed.deleted).toEqual([]);
    expect(changed.fetched).toEqual([`${ORG}/e2e-tmp-old`]);

    const renamed = standard();
    renamed.refetchName.set(`${ORG}/e2e-tmp-old`, `${ORG}/e2e-tmp-old-renamed`);
    expect(reason((await go(renamed, { apply: true })).result)).toBe("janitor-repos-delete-failed");
    expect(renamed.deleted).toEqual([]);

    const broken = standard();
    broken.refetchFails = true;
    expect(reason((await go(broken, { apply: true })).result)).toBe("janitor-repos-delete-failed");
    expect(broken.deleted).toEqual([]);
    expect(broken.bad).toEqual([]);
  });

  it("refuses with a fixed code when the org is missing or malformed, before any gh call", async () => {
    for (const [org, code] of [[undefined, "janitor-repos-org-missing"], ["", "janitor-repos-org-missing"], ["a/b", "janitor-repos-org-malformed"], ["-lead", "janitor-repos-org-malformed"], ["a b", "janitor-repos-org-malformed"], ["x".repeat(40), "janitor-repos-org-malformed"]] as const) {
      const f = standard();
      expect(reason((await go(f, { org })).result)).toBe(code);
      expect(f.calls).toEqual([]);
    }
  });

  it("refuses when gh is not logged in", async () => {
    const f = standard();
    f.loggedIn = false;
    expect(reason((await go(f, { apply: true })).result)).toBe("janitor-repos-gh-not-logged-in");
    expect(f.deleted).toEqual([]);
  });

  it("refuses off a person's machine: CI or any token in the environment, before any gh call", async () => {
    for (const key of ["CI", "GITHUB_ACTIONS", "GH_TOKEN", "GITHUB_TOKEN"]) {
      const f = standard();
      const { result } = await go(f, { env: { [key]: "x" } });
      expect(reason(result)).toBe("janitor-repos-not-local");
      expect(JSON.stringify(result)).not.toContain('"x"');
      expect(f.calls).toEqual([]);
    }
  });

  it("a failed listing is a refusal", async () => {
    const f = standard();
    f.listFails = true;
    expect(reason((await go(f)).result)).toBe("janitor-repos-list-failed");
  });

  it("a failed delete stops the run and names the repo", async () => {
    const f = standard().add(`${ORG}/e2e-tmp-a`, ago(50)).add(`${ORG}/e2e-tmp-z`, ago(50));
    f.failDelete.add(`${ORG}/e2e-tmp-old`);
    const { result } = await go(f, { apply: true });
    expect(result).toMatchObject({ status: "refused", reason: "janitor-repos-delete-failed", done: 0 });
    expect(JSON.stringify(result)).toContain("e2e-tmp-old");
    expect(f.deleted).toEqual([]);
  });
});

describe("janitor repos through the command line", () => {
  const run = async (argv: string[], f: FakeGh, typed = ORG, env: Record<string, string | undefined> = {}) => {
    const { io, out, err } = makeIo(scratchRoot([]), env);
    const code = await main(["janitor", "repos", ...argv], { ...io, gh: f.run, now: () => NOW, confirm: async () => typed });
    return { code, out, err };
  };

  it("exit 0 on a dry run and on --apply with the org typed", async () => {
    const f = standard();
    expect((await run(["--org", ORG], f)).code).toBe(0);
    expect(f.deleted).toEqual([]);
    const r = await run(["--org", ORG, "--apply"], f);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`done: delete ${ORG}/e2e-tmp-old`]);
  });

  it("exit 1 with a REFUSED line for a wrong confirmation, a logged-out gh and a CI environment", async () => {
    const f = standard();
    const wrong = await run(["--org", ORG, "--apply"], f, "nope");
    expect([wrong.code, wrong.err[0]]).toEqual([1, expect.stringContaining("REFUSED janitor-repos-not-confirmed")]);
    f.loggedIn = false;
    expect((await run(["--org", ORG], f)).err[0]).toContain("REFUSED janitor-repos-gh-not-logged-in");
    expect((await run(["--org", ORG], standard(), ORG, { CI: "true" })).code).toBe(1);
    expect(f.deleted).toEqual([]);
  });

  it("exit 2 for a missing or malformed org and for bad flags", async () => {
    const f = standard();
    const missing = await run([], f);
    expect([missing.code, missing.err[0]]).toEqual([2, "REFUSED janitor-repos-org-missing"]);
    expect((await run(["--org", "a/b"], f)).code).toBe(2);
    expect((await run(["--org", ORG, "--force"], f)).code).toBe(2);
    expect((await run(["--org", ORG, "--apply", "--apply"], f)).code).toBe(2);
    expect(f.calls).toEqual([]);
  });
});
