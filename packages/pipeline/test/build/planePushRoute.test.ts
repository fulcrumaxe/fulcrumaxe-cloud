import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAllowedErrorCode } from "@fx/telemetry";
import { buildPlanePushText } from "../../../runner-protocol/src/planePush/planePushText.js";
import * as scanModule from "../../../runner-protocol/src/planePush/planePush.js";
import { PLANE_REFUSAL_CODES, PlaneRouteError, type RepoPairing, routeAndPush, routeFor, type PlaneRouteDeps, type PlaneRouteInput, type PublicApi } from "../../../runner-protocol/src/planePush/planePushRoute.js";
import { git, gitCommitSource } from "../../../runner-protocol/src/planePush/planePushGit.js";
import { createGitTransport, type PublicGitTransport } from "../../../runner-protocol/src/planePush/planePushTransport.js";
import { startGitHttpServer, type GitHttpServer } from "./helpers/gitHttpServer.js";

vi.mock("../../../runner-protocol/src/planePush/planePush.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../runner-protocol/src/planePush/planePush.js")>();
  return { ...actual, scanPlanePush: vi.fn(actual.scanPlanePush) };
});

/**
 * D#598 P1c, on real git: a private repository, a public bare repository served over smart HTTP by `git http-backend` (reads are
 * anonymous; a push needs a token bound to the repository), and a fake of the public repo's GitHub API (token mint, branch lookup,
 * pull request). What the fakes cannot do is in gitHttpServer.ts and in the github package's planePushApi.test.ts. Fixture values
 * are invented.
 */

const IDS = "=== FORBIDDEN_PATTERNS_START ===\nacme-internal-host\n=== FORBIDDEN_PATTERNS_END ===\n";
const PLAN = JSON.stringify({ priceUsdPerMonth: 7391 });
const PUBLIC_FILES: Record<string, string> = { "README.md": "# widgets\n", "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n", "tools/run.sh": "#!/bin/sh\necho run\n" };
const OVERLAY_FILES: Record<string, string> = { "docs/ops/plan.md": "private plan\n", "rules/ids.txt": IDS, "rules/plan.json": PLAN };
const TOKEN = "ghs_" + "planepushtoken1"; // gitleaks:allow

const cleanEnv = (): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
const sh = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=Item Author", "-c", "user.email=private-author@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: cleanEnv() }).trim();
const put = (dir: string, files: Record<string, string | Buffer>): void => {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
};
const commitAll = (dir: string, msg: string): string => {
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", msg);
  return sh(dir, "rev-parse", "HEAD");
};

let root: string;
let priv: string;
let pubWork: string;
let bare: string;
let server: GitHttpServer;
let publicTip: string;
let privateBase: string;

const pairing: RepoPairing = { enabled: true, codeRepo: "acme/widgets", overlayGlobs: ["docs/ops/", "rules/"], identifierRulesPath: "rules/ids.txt", planDataRulesPath: "rules/plan.json" };
const own = { owner: "acme", name: "widgets-private" };
const branches = (): string => sh(bare, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
const pushes = (): number => server.seen.filter((s) => s.path.includes("git-receive-pack")).length;

function fakeApi(over: Partial<PublicApi> = {}): PublicApi & { minted: number; opened: Array<Parameters<PublicApi["openPullRequest"]>[0]> } {
  const api = {
    minted: 0,
    opened: [] as Array<Parameters<PublicApi["openPullRequest"]>[0]>,
    async mintPushToken() {
      api.minted++;
      return TOKEN;
    },
    async branchExists({ branch }: { branch: string }) {
      try {
        sh(bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
        return true;
      } catch {
        return false;
      }
    },
    async openPullRequest(i: Parameters<PublicApi["openPullRequest"]>[0]) {
      api.opened.push(i);
      return { number: 9, url: "https://github.com/acme/widgets/pull/9" };
    },
    ...over,
  };
  return api;
}

const input = (over: Partial<PlaneRouteInput> = {}): PlaneRouteInput => ({
  repoDir: priv, privateBase, privateHead: sh(priv, "rev-parse", "HEAD"), privateDefaultTip: privateBase, own, defaultBranch: "trunk", branch: "item-1", title: "Add the thing", body: "Adds the thing.",
  identity: { name: "Fulcrumaxe Bot", email: "bot@example.test" }, commitTime: 1_700_000_000, ...over,
});
let transport: PublicGitTransport;
const deps = (over: Partial<PlaneRouteDeps> = {}): PlaneRouteDeps => ({ loadPairing: async () => pairing, loadOwn: async () => own, api: fakeApi(), transport, ...over });
const refusal = async (p: Promise<unknown>): Promise<PlaneRouteError> => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(PlaneRouteError);
  return e as PlaneRouteError;
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "plane-route-"));
  for (const r of ["acme/widgets", "other/thing"]) {
    mkdirSync(join(root, `${r}.git`), { recursive: true });
    sh(join(root, `${r}.git`), "init", "-q", "--bare", "-b", "main");
  }
  bare = join(root, "acme/widgets.git");
  // The public repo: its files only.
  pubWork = mkdtempSync(join(tmpdir(), "plane-route-pub-"));
  sh(pubWork, "init", "-q", "-b", "main");
  put(pubWork, PUBLIC_FILES);
  chmodSync(join(pubWork, "tools/run.sh"), 0o755);
  publicTip = commitAll(pubWork, "initial public");
  sh(pubWork, "push", "-q", bare, "main");
  // The private repo: the same files plus the overlay, in its own unrelated history, as a real paired repo is.
  priv = mkdtempSync(join(tmpdir(), "plane-route-priv-"));
  sh(priv, "init", "-q", "-b", "trunk");
  put(priv, { ...PUBLIC_FILES, ...OVERLAY_FILES });
  chmodSync(join(priv, "tools/run.sh"), 0o755);
  privateBase = commitAll(priv, "private base");
  server = await startGitHttpServer(root, new Map([[TOKEN, ["acme/widgets"]]]));
  transport = createGitTransport({ origin: server.origin });
});

afterEach(async () => {
  await server.close();
  for (const d of [root, pubWork, priv]) rmSync(d, { recursive: true, force: true });
  vi.mocked(scanModule.scanPlanePush).mockClear();
});

describe("routing (acceptance 1: no pairing is today's path)", () => {
  it("gives the repo's own name and default branch when there is no pairing, and touches nothing", async () => {
    const off: RepoPairing = { enabled: false, codeRepo: null, overlayGlobs: [], identifierRulesPath: null, planDataRulesPath: null };
    expect(routeFor(off, own, "trunk")).toEqual({ plane: "single", repo: "acme/widgets-private", base: "trunk" });
    const t = { fetchTip: vi.fn(), push: vi.fn() };
    const api = fakeApi();
    await expect(routeAndPush(input(), { loadPairing: async () => off, loadOwn: async () => own, api, transport: t })).resolves.toEqual({ plane: "single", repo: "acme/widgets-private", base: "trunk" });
    expect(t.fetchTip).not.toHaveBeenCalled();
    expect(t.push).not.toHaveBeenCalled();
    expect(api.minted).toBe(0);
    expect(server.seen).toEqual([]);
  });

  it("refuses a pairing that names the repo itself, in any letter case, before anything is read", async () => {
    for (const codeRepo of ["acme/widgets-private", "ACME/Widgets-Private"]) {
      const e = await refusal(routeAndPush(input(), deps({ loadPairing: async () => ({ ...pairing, codeRepo }) })));
      expect(e.code).toBe("pairing_self");
    }
    expect(server.seen).toEqual([]);
  });

  it("uses only error codes the telemetry allowlist keeps", () => {
    for (const code of PLANE_REFUSAL_CODES) expect(isAllowedErrorCode(code), code).toBe(true);
  });
});

describe("a paired item (acceptance 2)", () => {
  it("opens one commit parented on the public tip whose tree differs from it only in the item's paths", async () => {
    put(priv, { "src/a.ts": "export const a = 1;\nexport const a2 = 3;\n", "src/new/c.ts": "export const c = 4;\n", "tools/new.sh": "#!/bin/sh\n" });
    chmodSync(join(priv, "tools/new.sh"), 0o755);
    rmSync(join(priv, "src/b.ts"));
    commitAll(priv, "item work by a private author");
    // The public repo moves on a path the item does not touch: the item must be built on that, not on its own base.
    put(pubWork, { "README.md": "# widgets, newer\n" });
    const newTip = commitAll(pubWork, "public moves on");
    sh(pubWork, "push", "-q", bare, "main");
    const before = branches();
    const api = fakeApi();
    const r = await routeAndPush(input(), deps({ api }));
    expect(r).toMatchObject({ plane: "paired", repo: "acme/widgets", number: 9, branch: "item-1", tip: newTip });
    if (r.plane !== "paired") throw new Error("unreachable");
    // Check on the public repo itself.
    expect(sh(bare, "rev-list", "--parents", "-n1", "item-1")).toBe(`${r.commit} ${newTip}`);
    expect(sh(bare, "diff", "--name-only", newTip, r.commit).split("\n").sort()).toEqual(["src/a.ts", "src/b.ts", "src/new/c.ts", "tools/new.sh"]);
    expect(sh(bare, "ls-tree", r.commit, "tools/new.sh")).toMatch(/^100755 /);
    expect(sh(bare, "show", `${r.commit}:README.md`)).toBe("# widgets, newer");
    expect(sh(bare, "log", "-1", "--format=%an <%ae> %cn <%ce> %at %ct%n%B", r.commit)).toBe("Fulcrumaxe Bot <bot@example.test> Fulcrumaxe Bot <bot@example.test> 1700000000 1700000000\nAdd the thing");
    expect(branches().split("\n").filter((l) => !before.split("\n").includes(l))).toEqual([`refs/heads/item-1 ${r.commit}`]);
    expect(api.opened).toEqual([{ codeRepo: "acme/widgets", branch: "item-1", base: "main", title: "Add the thing", body: "Adds the thing.", token: TOKEN }]);
  });

  it("sends the token only in a header scoped to the repo, never in a URL, and reads anonymously", async () => {
    put(priv, { "src/c.ts": "export const c = 1;\n" });
    commitAll(priv, "work");
    await routeAndPush(input(), deps());
    expect(server.seen.some((s) => s.path.includes(TOKEN))).toBe(false);
    const pushed = server.seen.filter((s) => s.path.includes("git-receive-pack"));
    expect(pushed.length).toBeGreaterThan(0);
    for (const s of pushed) expect(s.authorization).toBe(`Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
    for (const s of server.seen.filter((s) => s.path.includes("git-upload-pack") || s.path.includes("service=git-upload-pack"))) expect(s.authorization).toBeUndefined();
  });

  it("builds on a public path the item also changes only when the public repo did not move it", async () => {
    put(pubWork, { "src/a.ts": "export const a = 99;\n" });
    commitAll(pubWork, "public edits a");
    sh(pubWork, "push", "-q", bare, "main");
    put(priv, { "src/a.ts": "export const a = 1;\nexport const mine = 2;\n" });
    commitAll(priv, "work on a");
    const before = branches();
    const e = await refusal(routeAndPush(input(), deps()));
    expect(e.code).toBe("base_diverged");
    expect(e.message).toMatch(/changed path #1/);
    expect(e.message).not.toContain("src/a.ts");
    expect(branches()).toBe(before);
  });

  it("refuses an item whose change the public repo already has", async () => {
    put(pubWork, { "src/same.ts": "export const same = 1;\n" });
    commitAll(pubWork, "public gets same");
    sh(pubWork, "push", "-q", bare, "main");
    put(priv, { "src/same.ts": "export const same = 1;\n" });
    commitAll(priv, "work");
    expect((await refusal(routeAndPush(input(), deps()))).code).toBe("no_changes");
    expect(pushes()).toBe(0);
  });

  it("refuses an item with no changed file", async () => {
    sh(priv, "commit", "-q", "--allow-empty", "-m", "nothing");
    expect((await refusal(routeAndPush(input(), deps()))).code).toBe("no_changes");
  });
});

describe("refusals push nothing (acceptance 3, 4, 5)", () => {
  async function refused(files: Record<string, string | Buffer>, over: Partial<PlaneRouteInput> = {}, d: Partial<PlaneRouteDeps> = {}) {
    put(priv, files);
    commitAll(priv, "work");
    const before = branches();
    const api = fakeApi();
    const e = await refusal(routeAndPush(input(over), deps({ api, ...d })));
    expect(branches()).toBe(before);
    expect(pushes()).toBe(0);
    expect(api.minted).toBe(0);
    expect(api.opened).toEqual([]);
    return e;
  }

  it("an overlay path among the item's paths names the path and sends nothing", async () => {
    const e = await refused({ "src/c.ts": "export const c = 1;\n", "docs/ops/new.md": "more private text\n" });
    expect(e.code).toBe("scan_refused");
    expect(e.message).toContain("docs/ops/new.md");
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "overlay_path", path: "docs/ops/new.md" })]);
  });

  it("an identifier hit and a plan-data hit name file, line and rule key and never the matched text", async () => {
    const e = await refused({ "src/a.ts": "export const a = 1;\nconst host = 'acme-internal-host';\nconst price = 7391;\nconst o = { priceUsdPerMonth: 7391 };\n" });
    expect(e.code).toBe("scan_refused");
    expect(e.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "identifier_hit", path: "src/a.ts", line: 2, rule: "identifier-rule#1" }),
        expect.objectContaining({ kind: "plan_data_hit", path: "src/a.ts", line: 3, rule: "priceUsdPerMonth" }),
        expect.objectContaining({ kind: "plan_data_hit", path: "src/a.ts", line: 4, rule: "priceUsdPerMonth" }),
      ]),
    );
    const everything = JSON.stringify({ m: e.message, r: e.refusals, s: e.stack });
    expect(everything).not.toContain("acme-internal-host");
    expect(everything).not.toContain("7391");
  });

  it("scans the whole raw commit object: an identity that matches a rule refuses, though no changed file does", async () => {
    const e = await refused({ "src/c.ts": "export const c = 1;\n" }, { identity: { name: "acme-internal-host bot", email: "bot@example.test" } });
    expect(e.code).toBe("scan_refused");
    // Two lines of the object carry it: the author and the committer.
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "identifier_hit", path: "commit object", rule: "identifier-rule#1" }), expect.objectContaining({ kind: "identifier_hit", path: "commit object", rule: "identifier-rule#1" })]);
    expect(JSON.stringify(e.refusals)).not.toContain("acme-internal-host");
  });

  it("scans the pull request title and body with the same rules", async () => {
    const t = await refused({ "src/c.ts": "export const c = 1;\n" }, { title: "Move acme-internal-host out" });
    expect(t.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ path: "pull request title", rule: "identifier-rule#1" }), expect.objectContaining({ path: "commit object" })]));
    const b = await refused({ "src/d.ts": "export const d = 1;\n" }, { body: "line one\nthe price is $7391 per month\n", branch: "item-2" });
    expect(b.refusals).toEqual([expect.objectContaining({ kind: "plan_data_hit", path: "pull request body", line: 2 })]);
  });

  it("the pairing's footer rides in the body that is scanned: a footer that names a private identifier or a plan figure refuses the push, naming the place and not the value", async () => {
    const run = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
    const ident = await refused({ "src/e.ts": "export const e = 1;\n" }, { body: buildPlanePushText({ itemTitle: "x", runId: run, prFooter: "Refs acme-internal-host", issueNumber: 1 }).body, branch: "item-3" });
    expect(ident.refusals).toEqual([expect.objectContaining({ kind: "identifier_hit", path: "pull request body", rule: "identifier-rule#1" })]);
    expect(JSON.stringify(ident.refusals)).not.toContain("acme-internal-host");
    const plan = await refused({ "src/f.ts": "export const f = 1;\n" }, { body: buildPlanePushText({ itemTitle: "x", runId: run, prFooter: "costs $7391 for {issue_number}", issueNumber: 1 }).body, branch: "item-4" });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: "plan_data_hit", path: "pull request body" })]);
  });

  it("a declared rule file missing at the item's commit refuses and names the file", async () => {
    const e = await refused({ "src/c.ts": "export const c = 1;\n" }, {}, { loadPairing: async () => ({ ...pairing, identifierRulesPath: "rules/gone.txt" }) });
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "rule_file_missing", path: "rules/gone.txt" })]);
    expect(e.message).toContain("rules/gone.txt");
  });

  it("a binary file and a file over 8 MB each refuse", async () => {
    const bin = await refused({ "src/blob.dat": Buffer.from([1, 2, 0, 3]) });
    expect(bin.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "binary_file", path: "src/blob.dat" })]));
    const big = await refused({ "src/big.txt": "x".repeat(99) + "\n".repeat(1) + ("y".repeat(99) + "\n").repeat(80_000) }, { branch: "item-3" });
    expect(big.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "file_too_large", path: "src/big.txt" })]));
  });

  it("an empty overlay list refuses (a pairing with nothing private is not a pairing)", async () => {
    const e = await refused({ "src/c.ts": "export const c = 1;\n" }, {}, { loadPairing: async () => ({ ...pairing, overlayGlobs: [] }) });
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "overlay_list_invalid" })]);
  });

  it("bad input is refused before the public repo is read", async () => {
    put(priv, { "src/c.ts": "export const c = 1;\n" });
    commitAll(priv, "work");
    const head = sh(priv, "rev-parse", "HEAD");
    for (const over of [{ branch: "main" }, { branch: "refs/heads/x" }, { branch: "a..b" }, { privateHead: head.slice(0, 12) }, { title: "two\nlines" }, { title: " padded" }, { body: "" }, { commitTime: -1 }, { identity: { name: "x\n", email: "bot@example.test" } }]) {
      expect((await refusal(routeAndPush(input(over), deps()))).code, JSON.stringify(over)).toBe("bad_input");
    }
    expect(server.seen).toEqual([]);
  });
});

describe("the push-time checks (the review carry-overs)", () => {
  beforeEach(() => {
    put(priv, { "src/c.ts": "export const c = 1;\n" });
    commitAll(priv, "work");
  });

  it("refuses when the public main moved after the scan, even on a path the item does not touch", async () => {
    const api = fakeApi({
      async mintPushToken() {
        put(pubWork, { "README.md": "# moved while we were preparing\n" });
        commitAll(pubWork, "concurrent public commit");
        sh(pubWork, "push", "-q", bare, "main");
        return TOKEN;
      },
    });
    const before = branches();
    expect((await refusal(routeAndPush(input(), deps({ api })))).code).toBe("public_tip_moved");
    expect(pushes()).toBe(0);
    expect(branches().split("\n").some((l) => l.includes("item-1"))).toBe(false);
    expect(before).toContain("refs/heads/main");
  });

  it("refuses when the scan did not report this commit, or reported a base other than the freshly fetched tip", async () => {
    const real = (await vi.importActual<typeof import("../../../runner-protocol/src/planePush/planePush.js")>("../../../runner-protocol/src/planePush/planePush.js")).scanPlanePush;
    const scan = vi.mocked(scanModule.scanPlanePush);
    for (const tweak of [(r: scanModule.PlanePushResult) => ({ ...r, scanned: undefined }), (r: scanModule.PlanePushResult) => ({ ...r, scanned: { commit: r.scanned!.commit, base: privateBase } }), (r: scanModule.PlanePushResult) => ({ ...r, scanned: { commit: privateBase, base: r.scanned!.base } })]) {
      scan.mockImplementationOnce(async (i) => tweak(await real(i)) as scanModule.PlanePushResult);
      expect((await refusal(routeAndPush(input(), deps()))).code).toBe("scan_identity_mismatch");
    }
    expect(pushes()).toBe(0);
  });

  it("re-checks self-pairing at push time with its own code", async () => {
    let calls = 0;
    const loadPairing = async (): Promise<RepoPairing> => (++calls === 1 ? pairing : { ...pairing, codeRepo: "Acme/Widgets-Private" });
    const e = await refusal(routeAndPush(input(), deps({ loadPairing })));
    expect(e.code).toBe("pairing_self");
    expect(pushes()).toBe(0);
  });

  it("re-checks that the repo was not renamed onto the paired repo", async () => {
    let calls = 0;
    const loadOwn = async () => (++calls === 1 ? own : { owner: "acme", name: "widgets" });
    expect((await refusal(routeAndPush(input(), deps({ loadOwn })))).code).toBe("pairing_self");
    expect(pushes()).toBe(0);
  });

  it.each([
    ["removed", { enabled: false, codeRepo: null, overlayGlobs: [], identifierRulesPath: null, planDataRulesPath: null } as RepoPairing],
    ["pointed elsewhere", { ...pairing, codeRepo: "other/thing" }],
    ["given a shorter overlay list", { ...pairing, overlayGlobs: ["rules/"] }],
    ["given another rule file", { ...pairing, planDataRulesPath: null }],
  ])("refuses when the pairing was %s since the scan", async (_l, later) => {
    let calls = 0;
    const e = await refusal(routeAndPush(input(), deps({ loadPairing: async () => (++calls === 1 ? pairing : later) })));
    expect(e.code).toBe("pairing_changed");
    expect(pushes()).toBe(0);
  });

  it("never pushes over a branch that exists", async () => {
    sh(bare, "branch", "item-1", publicTip);
    const before = branches();
    expect((await refusal(routeAndPush(input(), deps()))).code).toBe("branch_exists");
    expect(branches()).toBe(before);
    expect(pushes()).toBe(0);
  });

  it("maps a mint failure to its own code, and an unknown failure to public_unavailable", async () => {
    const coded = (code: string) => fakeApi({ mintPushToken: async () => Promise.reject(Object.assign(new Error("x"), { code })) });
    expect((await refusal(routeAndPush(input(), deps({ api: coded("app_not_installed") })))).code).toBe("app_not_installed");
    expect((await refusal(routeAndPush(input(), deps({ api: coded("token_scope_mismatch") })))).code).toBe("token_scope_mismatch");
    expect((await refusal(routeAndPush(input(), deps({ api: coded("something_else") })))).code).toBe("public_unavailable");
    expect(pushes()).toBe(0);
  });

  it("says when the branch was pushed but the pull request was not opened", async () => {
    const api = fakeApi({ openPullRequest: async () => Promise.reject(Object.assign(new Error("x"), { code: "pr_failed" })) });
    const e = await refusal(routeAndPush(input(), deps({ api })));
    expect(e).toMatchObject({ code: "pr_failed", pushed: true });
    expect(branches()).toContain("refs/heads/item-1");
  });

  it("an unreachable or missing public repo is public_unavailable and nothing is minted", async () => {
    const api = fakeApi();
    const e = await refusal(routeAndPush(input(), deps({ api, loadPairing: async () => ({ ...pairing, codeRepo: "acme/missing" }) })));
    expect(e.code).toBe("public_unavailable");
    expect(api.minted).toBe(0);
  });
});

describe("the transport (acceptance 6: the token covers one repo)", () => {
  it("a push to a repository the token does not cover fails, and the failure does not echo the token", async () => {
    const head = sh(priv, "rev-parse", "HEAD");
    const other = join(root, "other/thing.git");
    const err = await transport.push({ repoDir: priv, codeRepo: "other/thing", commit: head, branch: "item-1", token: TOKEN }).then(() => undefined, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(`${err!.message}\n${err!.stack}`).not.toContain(TOKEN);
    expect(sh(other, "for-each-ref", "refs/heads")).toBe("");
    expect(server.seen.some((s) => s.path.includes("/other/thing.git/") && s.path.includes("receive-pack"))).toBe(true);
  });

  it("a wrong token and no token both fail on the covered repository", async () => {
    const head = sh(priv, "rev-parse", "HEAD");
    for (const token of ["ghs_" + "wrongtoken", ""]) { // gitleaks:allow
      await expect(transport.push({ repoDir: priv, codeRepo: "acme/widgets", commit: head, branch: "item-1", token })).rejects.toThrow();
    }
    expect(branches().split("\n").some((l) => l.includes("item-1"))).toBe(false);
  });

  it("never forces: a second push of a different commit to the same branch is refused", async () => {
    put(priv, { "first.txt": "1\n" });
    const first = commitAll(priv, "first");
    await transport.push({ repoDir: priv, codeRepo: "acme/widgets", commit: first, branch: "item-1", token: TOKEN });
    sh(priv, "reset", "-q", "--hard", privateBase);
    put(priv, { "other.txt": "x\n" });
    const second = commitAll(priv, "different");
    await expect(transport.push({ repoDir: priv, codeRepo: "acme/widgets", commit: second, branch: "item-1", token: TOKEN })).rejects.toThrow();
    expect(sh(bare, "rev-parse", "item-1")).toBe(first);
  });

  it("refuses a bad commit id, branch or repository before running git", async () => {
    const head = sh(priv, "rev-parse", "HEAD");
    for (const bad of [{ commit: "HEAD" }, { branch: "main" }, { branch: "x y" }, { codeRepo: "acme" }, { codeRepo: "../x/y" }]) {
      await expect(transport.push({ repoDir: priv, codeRepo: "acme/widgets", commit: head, branch: "item-1", token: TOKEN, ...bad })).rejects.toThrow();
    }
    expect(server.seen).toEqual([]);
  });

  it("accepts only an https origin, or http on loopback", () => {
    for (const origin of ["http://github.com", "ftp://x", "file:///tmp/x", "https://user:pw@github.com", "https://github.com/extra", "https://github.com/?x=1"]) expect(() => createGitTransport({ origin }), origin).toThrow();
    expect(() => createGitTransport({ origin: "https://github.com" })).not.toThrow();
    expect(() => createGitTransport({ origin: "http://127.0.0.1:8080" })).not.toThrow();
  });
});

describe("the clone's own config cannot redirect the transfer", () => {
  it.each([
    ["a url insteadOf rewrite", "url.http://127.0.0.1:2/.insteadOf", "http://127.0.0.1:2/"],
    ["a url pushInsteadOf rewrite", "url.http://127.0.0.1:2/.pushInsteadOf", "http://127.0.0.1:2/"],
    ["a proxy", "http.proxy", "http://127.0.0.1:1"],
    ["a scoped TLS switch", "http.https://github.com/.sslVerify", "false"],
    ["an ssh command", "core.sshCommand", "/bin/true"],
    ["an include", "include.path", "/tmp/elsewhere"],
    ["a credential helper", "credential.helper", "store"],
  ])("refuses %s before any network call, on both fetch and push", async (_l, key, value) => {
    sh(priv, "config", "--local", key, value);
    const head = sh(priv, "rev-parse", "HEAD");
    const e1 = await transport.fetchTip(priv, "acme/widgets").then(() => undefined, (x: unknown) => x);
    expect(e1).toMatchObject({ code: "unsafe_git_config" });
    const e2 = await transport.push({ repoDir: priv, codeRepo: "acme/widgets", commit: head, branch: "item-1", token: TOKEN }).then(() => undefined, (x: unknown) => x);
    expect(e2).toMatchObject({ code: "unsafe_git_config" });
    expect(JSON.stringify([String(e1), String(e2)])).not.toContain(TOKEN);
    expect(server.seen).toEqual([]);
  });

  it("through the route it is its own refusal code, and nothing is minted or pushed", async () => {
    sh(priv, "config", "--local", `url.${server.origin}/.insteadOf`, "http://127.0.0.1:2/");
    put(priv, { "src/c.ts": "export const c = 1;\n" });
    commitAll(priv, "work");
    const api = fakeApi();
    expect((await refusal(routeAndPush(input(), deps({ api })))).code).toBe("unsafe_git_config");
    expect(api.minted).toBe(0);
    expect(server.seen).toEqual([]);
  });

  it("a clone's remote and branch tracking are refused (the hook never uses a clone), before any network call", async () => {
    sh(priv, "config", "--local", "remote.origin.url", "https://example.test/acme/widgets-private.git");
    sh(priv, "config", "--local", "branch.trunk.remote", "origin");
    await expect(transport.fetchTip(priv, "acme/widgets")).rejects.toMatchObject({ code: "unsafe_git_config" });
    expect(server.seen).toEqual([]);
  });
});

describe("the branch name is scanned like the rest of the published text", () => {
  it("refuses a private identifier in the branch name, naming the place and rule and never the value", async () => {
    put(priv, { "src/c.ts": "export const c = 1;\n" });
    commitAll(priv, "work");
    const before = branches();
    const e = await refusal(routeAndPush(input({ branch: "fix-acme-internal-host-thing" }), deps()));
    expect(e.code).toBe("scan_refused");
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "identifier_hit", path: "branch name", line: 1, rule: "identifier-rule#1" })]);
    expect(JSON.stringify({ m: e.message, r: e.refusals })).not.toContain("acme-internal-host");
    expect(branches()).toBe(before);
    expect(pushes()).toBe(0);
  });
});

describe("nothing the clone plants runs as the harness (hooks, fsmonitor)", () => {
  const plantHook = (name: string, marker: string): void => {
    const path = join(priv, ".git/hooks", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\necho ran > '${marker}'\n`);
    chmodSync(path, 0o755);
  };

  it("sanity: the planted hooks do fire for a plain git call, so the test below can fail", () => {
    const marker = join(root, "control-marker");
    plantHook("reference-transaction", marker);
    sh(priv, "update-ref", "refs/fx/control", sh(priv, "rev-parse", "HEAD"));
    expect(existsSync(marker)).toBe(true);
  });

  it("a full paired push with reference-transaction, pre-push and fsmonitor planted runs none of them", async () => {
    const markers = ["reference-transaction", "pre-push", "post-commit", "fsmonitor"].map((n) => join(root, `marker-${n}`));
    plantHook("reference-transaction", markers[0]!);
    plantHook("pre-push", markers[1]!);
    plantHook("post-commit", markers[2]!);
    // fsmonitor goes in the config of a second clone state: the transport refuses that key, so it is exercised through the helper and the scan path.
    put(priv, { "src/c.ts": "export const c = 1;\n" });
    commitAll(priv, "work");
    for (const m of markers) rmSync(m, { force: true }); // the commit above ran the planted post-commit through the test's own plain git
    const r = await routeAndPush(input(), deps());
    expect(r.plane).toBe("paired");
    for (const m of markers.slice(0, 3)) expect(existsSync(m), m).toBe(false);

    const fsm = markers[3]!;
    sh(priv, "config", "--local", "core.fsmonitor", `echo ran > '${fsm}'; exit 0`);
    const head = sh(priv, "rev-parse", "HEAD");
    await git(priv, ["diff", "--raw", "-z", privateBase, head, "--"]);
    await git(priv, ["read-tree", head], undefined, { GIT_INDEX_FILE: join(root, "fsm-index") });
    await git(priv, ["update-index", "-z", "--index-info"], Buffer.alloc(0), { GIT_INDEX_FILE: join(root, "fsm-index") });
    await gitCommitSource({ repoDir: priv, commit: head, base: privateBase }).changes();
    expect(existsSync(fsm)).toBe(false);
    // And the transport refuses the key outright.
    await expect(transport.fetchTip(priv, "acme/widgets")).rejects.toMatchObject({ code: "unsafe_git_config" });
  });
});

describe("the clone must pass an allowlist (config keys and files), failing closed", () => {
  const refused = async (): Promise<void> => {
    const head = sh(priv, "rev-parse", "HEAD");
    await expect(transport.fetchTip(priv, "acme/widgets")).rejects.toMatchObject({ code: "unsafe_git_config" });
    await expect(transport.push({ repoDir: priv, codeRepo: "acme/widgets", commit: head, branch: "item-1", token: TOKEN })).rejects.toMatchObject({ code: "unsafe_git_config" });
    expect(server.seen).toEqual([]);
  };

  it("a freshly created bare repository is accepted, and a plain clone is not (it carries a remote and branch tracking)", async () => {
    const clone = join(root, "fresh-clone");
    sh(root, "clone", "-q", bare, clone);
    await expect(transport.fetchTip(clone, "acme/widgets")).rejects.toMatchObject({ code: "unsafe_git_config" });
    const made = join(root, "made-bare");
    sh(root, "init", "-q", "--bare", made);
    await expect(transport.fetchTip(made, "acme/widgets")).resolves.toBe(publicTip);
    await expect(transport.fetchTip(priv, "acme/widgets")).resolves.toBe(publicTip); // a plain git init
  });

  it("refuses an insteadOf that lives only in config.worktree (extensions.worktreeConfig)", async () => {
    sh(priv, "config", "--local", "extensions.worktreeConfig", "true");
    sh(priv, "config", "--worktree", `url.http://127.0.0.1:2/.insteadOf`, server.origin + "/");
    await refused();
  });

  it("refuses a config.worktree file and any extensions key by themselves", async () => {
    writeFileSync(join(priv, ".git/config.worktree"), "");
    await refused();
  });

  it("refuses an unknown key, and never puts its value in the message", async () => {
    sh(priv, "config", "--local", "foo.bar", "secret-value-123");
    const e = await transport.fetchTip(priv, "acme/widgets").then(() => undefined, (x: unknown) => x as Error);
    expect(e).toMatchObject({ code: "unsafe_git_config" });
    expect(e!.message).toContain("foo.bar");
    expect(e!.message).not.toContain("secret-value-123");
    await refused();
  });

  it.each([
    ["an alternates file", "objects/info/alternates"],
    ["an http-alternates file", "objects/info/http-alternates"],
    ["a grafts file", "info/grafts"],
    ["a shallow file", "shallow"],
  ])("refuses %s before any network call or command", async (_l, rel) => {
    mkdirSync(dirname(join(priv, ".git", rel)), { recursive: true });
    writeFileSync(join(priv, ".git", rel), "/nonexistent\n");
    await refused();
  });

  it("an alternates file plus core.alternateRefsCommand: refused, and the command never runs", async () => {
    const marker = join(root, "alt-marker");
    mkdirSync(join(priv, ".git/objects/info"), { recursive: true });
    writeFileSync(join(priv, ".git/objects/info/alternates"), join(root, "acme/widgets.git/objects") + "\n");
    sh(priv, "config", "--local", "core.alternateRefsCommand", `echo ran > '${marker}'`);
    await refused();
    expect(existsSync(marker)).toBe(false);
  });
});
