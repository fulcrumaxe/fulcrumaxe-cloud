import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlaneMergeClaimReply, PlaneMergeReportMessage, PlaneMergeVerifyMessage } from "@fulcrumaxe/runner-protocol";
import { createPublicHeadsReader, diffTreeEntries, sameChangeKeys, treeFromEntries } from "@fulcrumaxe/runner-protocol/planePush";
import type { PlaneMergeClaimResult, PlaneMergeOrder, PlaneMergeReportResult, PlaneMergeVerifyResult } from "../../src/daemon/client.js";
import { checkContent, createPlaneMergeHandler, readTree, type PlaneMergeOutcome } from "../../src/daemon/planeMerge.js";
import { createPlanePushGithub } from "../../src/daemon/planePushGithub.js";
import { startGitHttpServer, type GitHttpServer } from "../helpers/gitHttpServer.js";

/**
 * D#6 PUBLIC-MERGE PR3: the runner's side of a merge order, on real git. A public bare repository served over smart HTTP by `git http-backend`, a private
 * repository and its daemon mirror, a fake of GitHub's API on loopback that enforces what the merge touches (a User-Agent, a live bearer, a revoked token
 * answering 401, the `sha` precondition as 409, an unmergeable pull request as 405) and a fake of the cloud's three order routes that holds the protocol
 * schemas strictly. Not faked faithfully: TLS (loopback http is the one place the clients allow plain http), GitHub's branch protection and rate limits, and
 * the permission difference between two App tokens beyond "a write token may merge, a read token may not".
 */
const T = 60_000;
const IDS = "=== FORBIDDEN_PATTERNS_START ===\nacme-internal-host\n=== FORBIDDEN_PATTERNS_END ===\n";
const PUBLIC_FILES: Record<string, string> = { "README.md": "# widgets\n", "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n", "tools/run.sh": "#!/bin/sh\necho run\n" };
const OVERLAY_FILES: Record<string, string> = { "docs/ops/plan.md": "private plan\n", "rules/ids.txt": IDS };
const OVERLAY_GLOBS = ["docs/ops/", "rules/"];
const READ = ["ghs", "readtokenvalue00000001"].join("_");
const WRITE = ["ghs", "writetokenvalue0000002"].join("_");
const BRANCH = "fx/p-11111111-2222-4333-8444-555555555555";
const ORDER_ID = "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f";
const PR_NUMBER = 7;
const SHA_A = "a".repeat(40);

const cleanEnv = (): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
const sh = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=Item Author", "-c", "user.email=author@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: cleanEnv() }).trim();
const put = (dir: string, files: Record<string, string | Buffer>): void => {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), c);
  }
};
/** A file whose name is not valid UTF-8 (0xff is never a UTF-8 byte). Git stores names as bytes. */
const putBadName = (dir: string): void => writeFileSync(Buffer.concat([Buffer.from(`${dir}/src/`), Buffer.from([0x66, 0xff, 0x6f, 0x2e, 0x74, 0x78, 0x74])]), "x\n");
const commitAll = (dir: string, msg: string): string => {
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", msg);
  return sh(dir, "rev-parse", "HEAD");
};

interface World {
  root: string;
  bare: string;
  pubWork: string;
  mainTip: string;
  priv: string;
  mirror: string;
  base: string;
  server: GitHttpServer;
  workRoot: string;
}
let world: World;
let gh: FakeGithub | undefined;

beforeEach(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pm-merge-"));
  const bare = path.join(root, "pub", "acme", "widgets.git");
  mkdirSync(bare, { recursive: true });
  sh(bare, "init", "-q", "--bare", "-b", "main");
  const pubWork = path.join(root, "pubwork");
  mkdirSync(pubWork);
  sh(pubWork, "init", "-q", "-b", "main");
  put(pubWork, PUBLIC_FILES);
  chmodSync(path.join(pubWork, "tools/run.sh"), 0o755);
  const mainTip = commitAll(pubWork, "initial public");
  sh(pubWork, "push", "-q", bare, "main");
  const priv = path.join(root, "priv");
  mkdirSync(priv);
  sh(priv, "init", "-q", "-b", "main");
  put(priv, { ...PUBLIC_FILES, ...OVERLAY_FILES });
  chmodSync(path.join(priv, "tools/run.sh"), 0o755);
  const base = commitAll(priv, "private base");
  const mirror = path.join(root, "mirror.git");
  execFileSync("git", ["clone", "--bare", "-q", priv, mirror], { env: cleanEnv() });
  const server = await startGitHttpServer(path.join(root, "pub"), new Map());
  world = { root, bare, pubWork, mainTip, priv, mirror, base, server, workRoot: path.join(root, "state", "plane-merge") };
});
afterEach(async () => {
  await world.server.close();
  await gh?.close();
  gh = undefined;
  rmSync(world.root, { recursive: true, force: true });
});

/** The public pull request's commit: one commit on `parent` (default: the public main tip), pushed as the order's branch. */
function publicPr(files: Record<string, string | Buffer>, remove: string[] = [], over: { parent?: string; mode?: string } = {}): string {
  sh(world.pubWork, "checkout", "-q", "-B", BRANCH, over.parent ?? world.mainTip);
  put(world.pubWork, files);
  for (const r of remove) rmSync(path.join(world.pubWork, r));
  if (over.mode !== undefined) chmodSync(path.join(world.pubWork, "src/a.ts"), parseInt(over.mode, 8));
  const head = commitAll(world.pubWork, "public change");
  sh(world.pubWork, "push", "-q", "-f", world.bare, `HEAD:refs/heads/${BRANCH}`);
  return head;
}
/** The item's reviewed commit on the private repository's run branch, pushed to the mirror (which keeps it). */
function privateRun(files: Record<string, string | Buffer>, remove: string[] = [], over: { mode?: string; bad?: boolean } = {}): string {
  sh(world.priv, "checkout", "-q", "-B", "fx/run", world.base);
  put(world.priv, files);
  for (const r of remove) rmSync(path.join(world.priv, r));
  if (over.mode !== undefined) chmodSync(path.join(world.priv, "src/a.ts"), parseInt(over.mode, 8));
  if (over.bad) putBadName(world.priv);
  const head = commitAll(world.priv, "item work");
  sh(world.priv, "push", "-q", "-f", world.mirror, "HEAD:refs/heads/fx/run");
  return head;
}
const CHANGE = { "src/c.ts": "export const c = 3;\n" };

// ---------------------------------------------------------------------------------------------------------------------------------------------
// GitHub's API for the code repository: the calls the merge makes, with the rules they meet.

interface PullFake {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  mergeable: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  defaultBranch: string;
  /** What the body of a GET says about the head and base repositories and the number; each differs from the truth only when a test sets it. */
  headRepo: string;
  baseRepo: string;
  reportedNumber: number | undefined;
}
interface FakeGithub {
  origin: string;
  seen: Array<{ method: string; path: string; authorization: string | undefined; body: unknown }>;
  /** The tokens that are live now; a revoked one answers 401. */
  live: Set<string>;
  pull: PullFake;
  /** Runs after a GET of the pull request was answered (a test moves the head here, between the runner's read and its merge call). */
  afterGet: (() => void) | undefined;
  /** Makes the next merge call fail with this status once (e.g. 500). */
  failMerge: number | undefined;
  failGet: number | undefined;
  close(): Promise<void>;
}

async function startGithub(head: string): Promise<FakeGithub> {
  const writers = new Set([WRITE]);
  const state: FakeGithub = {
    origin: "",
    seen: [],
    live: new Set([READ]),
    pull: { number: PR_NUMBER, state: "open", merged: false, draft: false, mergeable: true, headSha: head, headRef: BRANCH, baseRef: "main", defaultBranch: "main", headRepo: "acme/widgets", baseRepo: "acme/widgets", reportedNumber: undefined },
    afterGet: undefined,
    failMerge: undefined,
    failGet: undefined,
    close: async () => undefined,
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      state.seen.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization, body });
      const json = (status: number, b: unknown): void => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (!req.headers["user-agent"]) return json(403, { message: "Request forbidden by administrative rules. Please make sure your request has a User-Agent header." });
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (bearer === undefined || !state.live.has(bearer)) return json(401, { message: "Bad credentials" });
      const p = new URL(req.url ?? "/", "http://x").pathname;
      if (req.method === "DELETE" && p === "/installation/token") {
        state.live.delete(bearer);
        return void res.writeHead(204).end();
      }
      const pr = state.pull;
      if (req.method === "GET" && p === `/repos/acme/widgets/pulls/${pr.number}`) {
        if (state.failGet !== undefined) return json(state.failGet, { message: "boom" });
        json(200, {
          number: pr.reportedNumber ?? pr.number,
          state: pr.state,
          merged: pr.merged,
          draft: pr.draft,
          head: { sha: pr.headSha, ref: pr.headRef, repo: { full_name: pr.headRepo } },
          base: { ref: pr.baseRef, repo: { full_name: pr.baseRepo, default_branch: pr.defaultBranch } },
        });
        state.afterGet?.();
        return;
      }
      if (req.method === "PUT" && p === `/repos/acme/widgets/pulls/${pr.number}/merge`) {
        if (!writers.has(bearer)) return json(403, { message: "Resource not accessible by integration" });
        if (state.failMerge !== undefined) {
          const s = state.failMerge;
          state.failMerge = undefined;
          return json(s, { message: "boom" });
        }
        const b = body as { sha?: unknown; merge_method?: unknown } | undefined;
        if (b?.merge_method !== "squash") return json(422, { message: "Invalid merge method" });
        if (typeof b.sha === "string" && b.sha !== pr.headSha) return json(409, { message: "Head branch was modified. Review and try the merge again." });
        if (pr.state !== "open" || pr.draft || !pr.mergeable) return json(405, { message: "Pull Request is not mergeable" });
        pr.merged = true;
        pr.state = "closed";
        return json(200, { sha: "c".repeat(40), merged: true, message: "Pull Request successfully merged" });
      }
      json(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}
const mergeCalls = (g: FakeGithub) => g.seen.filter((s) => s.method === "PUT");

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The cloud's three order routes, at the protocol level, holding the schemas strictly.

const orderFor = (publicHead: string, reviewedHead: string): PlaneMergeOrder => {
  const parsed = PlaneMergeClaimReply.parse({
    order_id: ORDER_ID,
    lease_generation: 1,
    code_repo: "acme/widgets",
    pr_number: PR_NUMBER,
    public_branch: BRANCH,
    expected_public_head: publicHead,
    reviewed_head: reviewedHead,
    private_repo: { id: "5b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", owner: "acme", name: "private-widgets" },
    overlay_globs: OVERLAY_GLOBS,
    pairing_digest: "d".repeat(64),
    read: { token: READ, expires_at: new Date(Date.now() + 3_000_000).toISOString() },
  });
  if (!("order_id" in parsed)) throw new Error("not an order");
  return parsed;
};

interface CloudScript {
  verify?: (m: PlaneMergeVerifyMessage, call: number) => PlaneMergeVerifyResult;
  report?: (m: PlaneMergeReportMessage, call: number) => PlaneMergeReportResult;
  claim?: PlaneMergeClaimResult;
}
function fakeCloud(order: PlaneMergeOrder, script: CloudScript = {}) {
  const log: string[] = [];
  const verifies: PlaneMergeVerifyMessage[] = [];
  const reports: PlaneMergeReportMessage[] = [];
  let authorized = false;
  let verifyCalls = 0;
  let reportCalls = 0;
  const goWith = (token = WRITE): PlaneMergeVerifyResult => ({ kind: "go", token, expiresAt: new Date(Date.now() + 3_000_000).toISOString(), sha: order.expected_public_head });
  const client = {
    async planeMergeClaim(): Promise<PlaneMergeClaimResult> {
      log.push("claim");
      return script.claim ?? { kind: "order", order };
    },
    async planeMergeVerify(message: PlaneMergeVerifyMessage): Promise<PlaneMergeVerifyResult> {
      log.push("verify");
      // Strict, as the route: the schema is the contract, and the bound values are the order's.
      const parsed = PlaneMergeVerifyMessage.parse(message);
      verifies.push(parsed);
      verifyCalls++;
      if (parsed.order_id !== order.order_id || parsed.lease_generation !== order.lease_generation || parsed.reviewed_head !== order.reviewed_head || parsed.public_head !== order.expected_public_head || parsed.pairing_digest !== order.pairing_digest) {
        return { kind: "fenced", code: "order_mismatch" };
      }
      if (authorized) return { kind: "fenced", code: "already_issued" };
      const answer = script.verify ? script.verify(parsed, verifyCalls) : parsed.same && !parsed.incomplete ? goWith() : { kind: "no_go" as const, reasons: ["public_head_not_reviewed"] };
      if (answer.kind === "go") {
        authorized = true;
        // The cloud mints the write credential at this moment: it is live on GitHub from here until the runner revokes it.
        gh!.live.add(answer.token);
      }
      return answer;
    },
    async planeMergeReport(message: PlaneMergeReportMessage): Promise<PlaneMergeReportResult> {
      log.push(`report:${message.result}`);
      const parsed = PlaneMergeReportMessage.parse(message);
      reports.push(parsed);
      reportCalls++;
      // As the route: before a go was issued, only an abort can be true.
      if (!authorized && parsed.result !== "aborted") return { kind: "fenced", code: "not_authorized" };
      return script.report ? script.report(parsed, reportCalls) : { kind: "recorded" };
    },
  };
  return { client, log, verifies, reports };
}

interface Harness {
  run: () => Promise<PlaneMergeOutcome>;
  lines: string[];
  cloud: ReturnType<typeof fakeCloud>;
}
function harness(order: PlaneMergeOrder, script: CloudScript = {}, over: { syncMirror?: () => Promise<{ dir: string }>; sleeps?: number[] } = {}): Harness {
  const cloud = fakeCloud(order, script);
  const lines: string[] = [];
  const handler = createPlaneMergeHandler({
    client: cloud.client,
    github: createPlanePushGithub({ apiOrigin: gh!.origin }),
    reader: createPublicHeadsReader({ origin: world.server.origin }),
    syncMirror: over.syncMirror ?? (async () => ({ dir: world.mirror })),
    workRoot: world.workRoot,
    sleep: async (ms) => void over.sleeps?.push(ms),
    say: (l) => lines.push(l),
  });
  return { run: handler, lines, cloud };
}
/** Both credentials are dead at the end of every order, whatever happened. */
const bothRevoked = (): void => {
  expect(gh!.live.has(READ), "the read credential is revoked").toBe(false);
  expect(gh!.live.has(WRITE), "the write credential is revoked").toBe(false);
};
const workDirsLeft = (): string[] => (existsSync(world.workRoot) ? readdirSync(world.workRoot) : []);

// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("a clean order", () => {
  it("compares the content locally, reports it bound to both shas, merges with the expected sha, and revokes both credentials", async () => {
    const head = publicPr(CHANGE);
    const reviewed = privateRun({ ...CHANGE, "docs/ops/plan.md": "a later private plan\n" });
    gh = await startGithub(head);
    const h = harness(orderFor(head, reviewed));
    expect(await h.run()).toBe("merged");
    expect(h.cloud.log).toEqual(["claim", "verify", "report:merged"]);
    expect(h.cloud.verifies[0]).toMatchObject({ same: true, incomplete: false, paths: ["src/c.ts"], reviewed_head: reviewed, public_head: head, token_revoked: true });
    expect(h.cloud.reports[0]).toMatchObject({ result: "merged", http_status: 200, token_revoked: true });
    // The one merge call names the expected head and squash, with the write credential.
    expect(mergeCalls(gh)).toHaveLength(1);
    expect(mergeCalls(gh)[0]).toMatchObject({ authorization: `Bearer ${WRITE}`, body: { sha: head, merge_method: "squash" } });
    expect(gh.pull.merged).toBe(true);
    bothRevoked();
    expect(workDirsLeft()).toEqual([]);
    // The read credential travelled only as the git fetch's header; the write credential only to the API.
    const fetchAuth = world.server.seen.map((s) => s.authorization).filter((a): a is string => a !== undefined);
    expect(fetchAuth.length).toBeGreaterThan(0);
    for (const a of fetchAuth) expect(Buffer.from(a.replace(/^Basic /, ""), "base64").toString("utf8")).toBe(`x-access-token:${READ}`);
    expect(gh.seen.filter((s) => s.method === "GET").every((s) => s.authorization === `Bearer ${WRITE}`)).toBe(true);
  }, T);

  it("no token is ever in a log line, a message or a report", async () => {
    const head = publicPr(CHANGE);
    const reviewed = privateRun(CHANGE);
    gh = await startGithub(head);
    const h = harness(orderFor(head, reviewed));
    await h.run();
    const everything = JSON.stringify([h.lines, h.cloud.verifies, h.cloud.reports]);
    expect(everything).not.toContain(READ);
    expect(everything).not.toContain(WRITE);
    // Nothing is left on disk under the work root, and the state directory holds no token either.
    expect(existsSync(world.workRoot) ? readdirSync(world.workRoot) : []).toEqual([]);
  }, T);
});

describe("the content check says no, and no write credential is ever used", () => {
  it.each([
    ["an extra file on the public side", () => [publicPr({ ...CHANGE, "src/extra.ts": "x\n" }), privateRun(CHANGE)] as const],
    ["an overlay path on the public side", () => [publicPr({ ...CHANGE, "docs/ops/plan.md": "leak\n" }), privateRun(CHANGE)] as const],
    ["a different blob", () => [publicPr({ "src/c.ts": "export const c = 4;\n" }), privateRun(CHANGE)] as const],
    ["a mode change on the public side only", () => [publicPr(CHANGE, [], { mode: "755" }), privateRun(CHANGE)] as const],
    ["a file the reviewers deleted that the public side kept", () => [publicPr(CHANGE), privateRun(CHANGE, ["src/b.ts"])] as const],
  ])("%s: same false, incomplete false, no go, no merge call", async (_name, build) => {
    const [head, reviewed] = build();
    gh = await startGithub(head);
    const h = harness(orderFor(head, reviewed));
    expect(await h.run()).toBe("blocked");
    expect(h.cloud.verifies[0]).toMatchObject({ same: false, incomplete: false });
    expect(mergeCalls(gh)).toHaveLength(0);
    expect(h.cloud.log).toEqual(["claim", "verify"]);
    bothRevoked();
  }, T);
});

describe("a path that is not UTF-8", () => {
  it("is 'could not know' (incomplete, never the same), also when the reviewed side holds the identical bytes", async () => {
    sh(world.pubWork, "checkout", "-q", "-B", BRANCH, world.mainTip);
    put(world.pubWork, CHANGE);
    putBadName(world.pubWork);
    const head = commitAll(world.pubWork, "public change");
    sh(world.pubWork, "push", "-q", "-f", world.bare, `HEAD:refs/heads/${BRANCH}`);
    const reviewed = privateRun(CHANGE, [], { bad: true });
    gh = await startGithub(head);
    const h = harness(orderFor(head, reviewed));
    expect(await h.run()).toBe("blocked");
    expect(h.cloud.verifies[0]).toMatchObject({ same: false, incomplete: true });
    expect(mergeCalls(gh)).toHaveLength(0);
    bothRevoked();
    // The raw-byte reader refuses the tree outright; it does not turn the name into U+FFFD and carry on.
    expect(await readTree(world.bare, head)).toBeNull();
  }, T);
});

describe("checkContent against real repositories", () => {
  const check = async (head: string, reviewed: string, publicDefault = world.mainTip) => checkContent({ publicDir: world.bare, publicHead: head, publicDefault, privateDir: world.mirror, reviewedHead: reviewed, overlayGlobs: OVERLAY_GLOBS });

  it("same content: same, and the public paths are the change set", async () => {
    const head = publicPr({ ...CHANGE, "src/a.ts": "export const a = 9;\n" });
    const reviewed = privateRun({ ...CHANGE, "src/a.ts": "export const a = 9;\n", "rules/ids.txt": `${IDS}# more\n` });
    expect(await check(head, reviewed)).toEqual({ same: true, incomplete: false, paths: expect.arrayContaining(["src/a.ts", "src/c.ts"]) });
  }, T);

  it("the same end content reached from another base entry is a different change", async () => {
    // Public main moved a.ts on; the private base still has the old one. Both ends are a.ts = 3.
    sh(world.pubWork, "checkout", "-q", "-B", "main", world.mainTip);
    put(world.pubWork, { "src/a.ts": "export const a = 2;\n" });
    const moved = commitAll(world.pubWork, "main moved");
    sh(world.pubWork, "push", "-q", world.bare, "main");
    const head = publicPr({ "src/a.ts": "export const a = 3;\n" }, [], { parent: moved });
    const reviewed = privateRun({ "src/a.ts": "export const a = 3;\n" });
    expect(await check(head, reviewed, moved)).toMatchObject({ same: false, incomplete: false });
  }, T);

  it("a two-parent public head is 'could not know'", async () => {
    const side = (() => {
      sh(world.pubWork, "checkout", "-q", "-B", "side", world.mainTip);
      put(world.pubWork, { "src/side.ts": "s\n" });
      return commitAll(world.pubWork, "side");
    })();
    sh(world.pubWork, "checkout", "-q", "-B", BRANCH, world.mainTip);
    put(world.pubWork, CHANGE);
    commitAll(world.pubWork, "public change");
    sh(world.pubWork, "merge", "-q", "--no-ff", "-m", "merge", side);
    const head = sh(world.pubWork, "rev-parse", "HEAD");
    sh(world.pubWork, "push", "-q", "-f", world.bare, `HEAD:refs/heads/${BRANCH}`);
    expect(await check(head, privateRun(CHANGE))).toEqual({ same: false, incomplete: true, paths: [] });
  }, T);

  it("a public head whose parent is not the merge base with the default branch is 'could not know'", async () => {
    sh(world.pubWork, "checkout", "-q", "-B", "stack", world.mainTip);
    put(world.pubWork, { "src/stack.ts": "s\n" });
    const stacked = commitAll(world.pubWork, "stacked parent");
    const head = publicPr(CHANGE, [], { parent: stacked });
    expect(await check(head, privateRun(CHANGE))).toEqual({ same: false, incomplete: true, paths: [] });
  }, T);

  it("unreadable input is 'could not know', not 'no files': a commit that is not there, and an overlay list that does not compile", async () => {
    const head = publicPr(CHANGE);
    const reviewed = privateRun(CHANGE);
    expect(await check(SHA_A, reviewed)).toEqual({ same: false, incomplete: true, paths: [] });
    expect(await checkContent({ publicDir: world.bare, publicHead: head, publicDefault: world.mainTip, privateDir: world.mirror, reviewedHead: reviewed, overlayGlobs: ["[bad"] })).toEqual({ same: false, incomplete: true, paths: [] });
  }, T);

  it("the reviewed side not being readable is 'not the same' (as the cloud's own check), with the public paths", async () => {
    const head = publicPr(CHANGE);
    const r = await check(head, SHA_A);
    expect(r).toEqual({ same: false, incomplete: false, paths: ["src/c.ts"] });
  }, T);

  it("parity: the local reader and the GitHub-shaped reader give the same keys for the same commits", async () => {
    const heads = [publicPr({ ...CHANGE, "src/a.ts": "export const a = 9;\n" }), publicPr({ "src/b.ts": "export const b = 5;\n" }, ["src/a.ts"]), publicPr(CHANGE, [], { mode: "755" })];
    for (const head of heads) {
      const local = await readTree(world.bare, head);
      const baseLocal = await readTree(world.bare, world.mainTip);
      // What GitHub's recursive tree endpoint answers: directories included as `tree` entries, files as `blob`, with sizes and urls we ignore.
      const github = (commit: string) => {
        const out = execFileSync("git", ["-C", world.bare, "ls-tree", "-r", "-t", "-z", commit], { env: cleanEnv() }).toString("utf8");
        return treeFromEntries(
          out.split("\0").filter(Boolean).map((rec) => {
            const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.*)$/s.exec(rec)!;
            return { path: m[4], mode: m[1], type: m[2] === "tree" ? "tree" : m[2], sha: m[3], size: 1, url: "https://api.example.test/x" };
          }),
        );
      };
      const remoteHead = github(head);
      const remoteBase = github(world.mainTip);
      expect(local).not.toBeNull();
      expect([...local!.entries()]).toEqual([...remoteHead!.entries()]);
      const keep = (p: string) => !p.startsWith("docs/");
      expect(sameChangeKeys(diffTreeEntries(baseLocal!, local!, keep).keys, diffTreeEntries(remoteBase!, remoteHead!, keep).keys)).toBe(true);
    }
  }, T);
});

describe("things that go wrong before the verify", () => {
  it("the public branch is not at the order's head: no check, an abort 'head_moved' is reported, the read credential is revoked", async () => {
    const old = publicPr(CHANGE);
    const reviewed = privateRun(CHANGE);
    const newer = publicPr({ ...CHANGE, "src/more.ts": "m\n" });
    gh = await startGithub(newer);
    const h = harness(orderFor(old, reviewed));
    expect(await h.run()).toBe("head_moved");
    expect(h.cloud.log).toEqual(["claim", "report:aborted"]);
    expect(h.cloud.reports[0]).toMatchObject({ result: "aborted", abort_code: "head_moved", token_revoked: true });
    bothRevoked();
    expect(mergeCalls(gh)).toHaveLength(0);
  }, T);

  it("a fetch that fails (no such repository) verifies as incomplete, never silence, and revokes the read credential", async () => {
    const head = publicPr(CHANGE);
    const reviewed = privateRun(CHANGE);
    gh = await startGithub(head);
    const order = { ...orderFor(head, reviewed), code_repo: "acme/missing" };
    const h = harness(order);
    expect(await h.run()).toBe("blocked");
    expect(h.cloud.verifies[0]).toMatchObject({ same: false, incomplete: true, paths: [], token_revoked: true });
    bothRevoked();
  }, T);

  it("a mirror that cannot be synced, and a reviewed commit the mirror does not have, are incomplete", async () => {
    const head = publicPr(CHANGE);
    const reviewed = privateRun(CHANGE);
    gh = await startGithub(head);
    const a = harness(orderFor(head, reviewed), {}, { syncMirror: async () => Promise.reject(new Error("mirror_failed")) });
    expect(await a.run()).toBe("blocked");
    expect(a.cloud.verifies[0]).toMatchObject({ same: false, incomplete: true });
    const b = harness(orderFor(head, SHA_A));
    expect(await b.run()).toBe("blocked");
    expect(b.cloud.verifies[0]).toMatchObject({ same: false, incomplete: true });
    expect(mergeCalls(gh)).toHaveLength(0);
  }, T);

  it("no order waiting, a fenced claim and a failed claim do nothing", async () => {
    gh = await startGithub(SHA_A);
    const dummy = orderFor(SHA_A, SHA_A);
    for (const claim of [{ kind: "none", retryAfter: 60 }, { kind: "fenced" }, { kind: "error", status: 503 }] as PlaneMergeClaimResult[]) {
      const h = harness(dummy, { claim });
      expect(await h.run()).toBe("none");
      expect(h.cloud.log).toEqual(["claim"]);
      expect(h.lines).toEqual([]);
    }
  }, T);

  it("a verify that cannot be reached is tried three times and then given up on; a verify answered 503 once goes on", async () => {
    const head = publicPr(CHANGE);
    const reviewed = privateRun(CHANGE);
    gh = await startGithub(head);
    const sleeps: number[] = [];
    const down = harness(orderFor(head, reviewed), { verify: () => ({ kind: "error", status: 503 }) }, { sleeps });
    expect(await down.run()).toBe("failed");
    expect(down.cloud.log.filter((l) => l === "verify")).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    bothRevoked();
    gh.live.add(READ);
    const flaky = harness(orderFor(head, reviewed), { verify: (m, call) => (call === 1 ? { kind: "error", status: 502 } : { kind: "go", token: WRITE, expiresAt: new Date(Date.now() + 3_000_000).toISOString(), sha: head }) });
    expect(await flaky.run()).toBe("merged");
  }, T);

  it("a verify the cloud fences ends the order with no merge", async () => {
    const head = publicPr(CHANGE);
    const reviewed = privateRun(CHANGE);
    gh = await startGithub(head);
    const h = harness(orderFor(head, reviewed), { verify: () => ({ kind: "fenced", code: "already_issued" }) });
    expect(await h.run()).toBe("stopped");
    expect(mergeCalls(gh)).toHaveLength(0);
    bothRevoked();
  }, T);

  it("a go-phase 'head moved' and a 'no go' end without a merge call", async () => {
    const head = publicPr(CHANGE);
    const reviewed = privateRun(CHANGE);
    gh = await startGithub(head);
    expect(await harness(orderFor(head, reviewed), { verify: () => ({ kind: "head_moved" }) }).run()).toBe("head_moved");
    expect(mergeCalls(gh)).toHaveLength(0);
  }, T);
});

describe("after the go: the pull request is read again, and the merge call is the only write", () => {
  const setup = async (change?: (g: FakeGithub) => void): Promise<Harness> => {
    const head = publicPr(CHANGE);
    const reviewed = privateRun(CHANGE);
    gh = await startGithub(head);
    change?.(gh);
    return harness(orderFor(head, reviewed));
  };

  it("the head moves between the verify and the runner's read: head_moved, no merge call, both credentials revoked", async () => {
    const h = await setup((g) => (g.pull.headSha = "b".repeat(40)));
    expect(await h.run()).toBe("aborted");
    expect(h.cloud.reports[0]).toMatchObject({ result: "aborted", abort_code: "head_moved", token_revoked: true });
    expect(mergeCalls(gh!)).toHaveLength(0);
    bothRevoked();
  }, T);

  it("the head moves between the runner's read and its merge call: GitHub's own sha check refuses (409) and nothing merges", async () => {
    const h = await setup((g) => (g.afterGet = () => (g.pull.headSha = "b".repeat(40))));
    expect(await h.run()).toBe("refused");
    expect(mergeCalls(gh!)).toHaveLength(1);
    expect(h.cloud.reports[0]).toMatchObject({ result: "refused", http_status: 409, token_revoked: true });
    expect(gh!.pull.merged).toBe(false);
    bothRevoked();
  }, T);

  it.each([
    ["the base was retargeted", (g: FakeGithub) => (g.pull.baseRef = "release"), "base_retargeted"],
    ["the base is not the repository's default branch", (g: FakeGithub) => (g.pull.defaultBranch = "trunk"), "base_retargeted"],
    ["the base IS the repository's default branch, but that is not the branch the content was compared against", (g: FakeGithub) => ((g.pull.baseRef = "trunk"), (g.pull.defaultBranch = "trunk")), "base_retargeted"],
    ["the pull request was closed", (g: FakeGithub) => (g.pull.state = "closed"), "pr_not_open"],
    ["the pull request was already merged", (g: FakeGithub) => ((g.pull.merged = true), (g.pull.state = "closed")), "pr_not_open"],
    ["the pull request is a draft", (g: FakeGithub) => (g.pull.draft = true), "pr_draft"],
    ["the pull request's branch is another one", (g: FakeGithub) => (g.pull.headRef = "someone/else"), "internal"],
    ["the head repository is not the base repository (a fork)", (g: FakeGithub) => (g.pull.headRepo = "someone/widgets"), "internal"],
    ["GitHub answers another pull request's number", (g: FakeGithub) => (g.pull.reportedNumber = PR_NUMBER + 1), "pr_not_open"],
    ["the base repository is not the order's code repository", (g: FakeGithub) => ((g.pull.headRepo = "acme/other"), (g.pull.baseRepo = "acme/other")), "internal"],
  ])("%s: aborted with a closed code, no merge call, both revoked", async (_n, change, code) => {
    const h = await setup(change);
    expect(await h.run()).toBe("aborted");
    expect(h.cloud.reports[0]).toMatchObject({ result: "aborted", abort_code: code, token_revoked: true });
    expect(mergeCalls(gh!)).toHaveLength(0);
    bothRevoked();
  }, T);

  it.each([
    [405, "refused"],
    [409, "refused"],
  ] as const)("GitHub refuses the merge with %i: reported as refused with the status, the pull request is not merged", async (status, outcome) => {
    const h = await setup((g) => {
      if (status === 405) g.pull.mergeable = false;
      else g.failMerge = 409;
    });
    expect(await h.run()).toBe(outcome);
    expect(h.cloud.reports[0]).toMatchObject({ result: "refused", http_status: status, token_revoked: true });
    expect(gh!.pull.merged).toBe(false);
    bothRevoked();
  }, T);

  it("a merge call that gets a 500 is refused with that status; a pull request read that fails is 'read_failed'", async () => {
    const a = await setup((g) => (g.failMerge = 500));
    expect(await a.run()).toBe("refused");
    expect(a.cloud.reports[0]).toMatchObject({ result: "refused", http_status: 500 });
    bothRevoked();
    await gh!.close();
    const b = await setup((g) => (g.failGet = 500));
    expect(await b.run()).toBe("aborted");
    expect(b.cloud.reports[0]).toMatchObject({ result: "aborted", abort_code: "read_failed" });
    expect(mergeCalls(gh!)).toHaveLength(0);
    bothRevoked();
  }, T);

  it("a write credential about to expire is not used, and is revoked", async () => {
    const head = publicPr(CHANGE);
    const reviewed = privateRun(CHANGE);
    gh = await startGithub(head);
    const h = harness(orderFor(head, reviewed), { verify: () => ({ kind: "go", token: WRITE, expiresAt: new Date(Date.now() + 5_000).toISOString(), sha: head }) });
    expect(await h.run()).toBe("aborted");
    expect(h.cloud.reports[0]).toMatchObject({ result: "aborted", abort_code: "internal", token_revoked: true });
    expect(gh.seen.filter((s) => s.authorization === `Bearer ${WRITE}`).map((s) => s.method)).toEqual(["DELETE"]);
    bothRevoked();
  }, T);

  it("a go that names another sha than the order's is not merged", async () => {
    const head = publicPr(CHANGE);
    const reviewed = privateRun(CHANGE);
    gh = await startGithub(head);
    const h = harness(orderFor(head, reviewed), { verify: () => ({ kind: "go", token: WRITE, expiresAt: new Date(Date.now() + 3_000_000).toISOString(), sha: "b".repeat(40) }) });
    expect(await h.run()).toBe("aborted");
    // The exact code tells this check apart from the later head check (which would say head_moved): the pull request's head is the order's, the go's sha is not.
    expect(h.cloud.reports[0]).toMatchObject({ result: "aborted", abort_code: "internal", token_revoked: true });
    expect(gh.seen.filter((s) => s.method === "GET")).toHaveLength(0);
    expect(mergeCalls(gh)).toHaveLength(0);
    bothRevoked();
  }, T);
});

describe("the report is tried again until it is recorded", () => {
  it("a 503 with retry_after is waited out (capped), a network failure is backed off, and a fenced report ends it", async () => {
    const head = publicPr(CHANGE);
    const reviewed = privateRun(CHANGE);
    gh = await startGithub(head);
    const sleeps: number[] = [];
    const h = harness(orderFor(head, reviewed), { report: (_m, call) => (call === 1 ? { kind: "retry", retryAfter: 600 } : call === 2 ? { kind: "error", status: 0 } : { kind: "recorded" }) }, { sleeps });
    expect(await h.run()).toBe("merged");
    expect(h.cloud.log.filter((l) => l.startsWith("report"))).toHaveLength(3);
    expect(sleeps).toEqual([60_000, 3_000]);
    bothRevoked();
    gh.live.add(READ);
    gh.pull.merged = false;
    gh.pull.state = "open";
    const fenced = harness(orderFor(head, reviewed), { report: () => ({ kind: "fenced", code: "fenced" }) });
    expect(await fenced.run()).toBe("stopped");
  }, T);
});

describe("the heads reader refuses what it was not built for, before any network call", () => {
  it("a branch that is the base branch or a ref, and a repository that is not owner/name", async () => {
    const reader = createPublicHeadsReader({ origin: world.server.origin });
    const dir = path.join(world.root, "scratch.git");
    mkdirSync(dir);
    sh(dir, "init", "-q", "--bare");
    for (const branch of ["main", "refs/heads/x", "a..b", "x.lock"]) await expect(reader.fetchHeads(dir, "acme/widgets", branch)).rejects.toThrow();
    await expect(reader.fetchHeads(dir, "acme/widgets/extra", BRANCH)).rejects.toThrow();
    expect(world.server.seen).toEqual([]);
    expect(() => createPublicHeadsReader({ origin: "http://example.com" })).toThrow();
  }, T);
});
