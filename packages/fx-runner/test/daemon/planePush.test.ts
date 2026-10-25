import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanePushPairingReply, PlanePushReportMessage, PlanePushTokenReply } from "@fulcrumaxe/runner-protocol";
import { pairingDigest } from "@fulcrumaxe/runner-protocol/pairingDigest";
import { createGitTransport, type PublicGitTransport } from "@fulcrumaxe/runner-protocol/planePush";
import type { PlanePushPairingResult, PlanePushReportResult, PlanePushTokenResult } from "../../src/daemon/client.js";
import { createPlaneBaseLedger, createPlanePushHook, reportRefusals, sweepWorkRoot, type PlanePushOutcome, type PlanePushRunEnd } from "../../src/daemon/planePush.js";
import { createPlanePushGithub } from "../../src/daemon/planePushGithub.js";
import { startFakePublicGithub, type FakePublicGithub } from "../helpers/fakePublicGithub.js";
import { startGitHttpServer, type GitHttpServer } from "../helpers/gitHttpServer.js";

/**
 * D#598 P1f-3: the run-end hook, on real git. A private repository and its daemon mirror, a public bare repository served over smart HTTP by `git
 * http-backend` (a push needs the token), a fake of the public repo's GitHub API on loopback, and a fake of the cloud's three signed routes at the
 * protocol level. What is not faked faithfully is said in each helper; fixture values are invented.
 */
const IDS = "=== FORBIDDEN_PATTERNS_START ===\nacme-internal-host\n=== FORBIDDEN_PATTERNS_END ===\n";
const PLAN = JSON.stringify({ priceUsdPerMonth: 7391 });
const PUBLIC_FILES: Record<string, string> = { "README.md": "# widgets\n", "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n", "tools/run.sh": "#!/bin/sh\necho run\n" };
const OVERLAY_FILES: Record<string, string> = { "docs/ops/plan.md": "private plan\n", "rules/ids.txt": IDS, "rules/plan.json": PLAN };
const TOKEN = ["ghs", "p13bhooktokenvalue000001"].join("_");
const BRANCH = "fx/p-11111111-2222-4333-8444-555555555555";
const RUN = "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f";
const PAIRING = { codeRepo: "acme/widgets", overlayGlobs: ["docs/ops/", "rules/"], identifierRulesPath: "rules/ids.txt" as string | null, planDataRulesPath: "rules/plan.json" as string | null };
const PR = { title: "Change from fulcrumaxe run 0b1b6c52", body: "Opened by a fulcrumaxe run, id 0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f." };
const IDENTITY = { name: "Fulcrumaxe Bot", email: "bot@example.test" };

const cleanEnv = (): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && k !== "P13B_COUNT_FILE")), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
const sh = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=Item Author", "-c", "user.email=private-author@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: cleanEnv() }).trim();
const put = (dir: string, files: Record<string, string | Buffer>): void => {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), c);
  }
};
const commitAll = (dir: string, msg: string): string => {
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", msg);
  return sh(dir, "rev-parse", "HEAD");
};

interface World {
  root: string;
  priv: string;
  mirror: string;
  bare: string;
  pubWork: string;
  publicTip: string;
  base: string;
  server: GitHttpServer;
  api: FakePublicGithub;
  tokens: Map<string, string[]>;
  workRoot: string;
}

let world: World;
beforeEach(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "p13b-hook-"));
  const bare = path.join(root, "pub", "acme", "widgets.git");
  mkdirSync(bare, { recursive: true });
  sh(bare, "init", "-q", "--bare", "-b", "main");
  const pubWork = path.join(root, "pubwork");
  mkdirSync(pubWork);
  sh(pubWork, "init", "-q", "-b", "main");
  put(pubWork, PUBLIC_FILES);
  chmodSync(path.join(pubWork, "tools/run.sh"), 0o755);
  const publicTip = commitAll(pubWork, "initial public");
  sh(pubWork, "push", "-q", bare, "main");
  const priv = path.join(root, "priv");
  mkdirSync(priv);
  sh(priv, "init", "-q", "-b", "main");
  put(priv, { ...PUBLIC_FILES, ...OVERLAY_FILES });
  chmodSync(path.join(priv, "tools/run.sh"), 0o755);
  const base = commitAll(priv, "private base");
  const mirror = path.join(root, "mirror.git");
  execFileSync("git", ["clone", "--bare", "-q", priv, mirror], { env: cleanEnv() });
  mkdirSync(path.join(root, "state"), { mode: 0o700 });
  const tokens = new Map<string, string[]>([[TOKEN, ["acme/widgets"]]]);
  const server = await startGitHttpServer(path.join(root, "pub"), tokens);
  const api = await startFakePublicGithub({ bare, repo: "acme/widgets", tokens, env: cleanEnv() });
  world = { root, priv, mirror, bare, pubWork, publicTip, base, server, api, tokens, workRoot: path.join(root, "state", "plane-push") };
});
afterEach(async () => {
  await world.server.close();
  await world.api.close();
  rmSync(world.root, { recursive: true, force: true });
});

/** The item's work: a commit on the private repo's run branch, pushed to the mirror, whose branch ref is then deleted (the daemon deletes its private ref). */
function runWith(files: Record<string, string | Buffer>, remove: string[] = []): string {
  sh(world.priv, "checkout", "-q", "-B", "fx/run", world.base);
  put(world.priv, files);
  for (const r of remove) rmSync(path.join(world.priv, r));
  const head = commitAll(world.priv, "item work by a private author");
  sh(world.priv, "push", "-q", world.mirror, "HEAD:refs/heads/fx/run");
  sh(world.mirror, "update-ref", "-d", "refs/heads/fx/run");
  return head;
}
const branches = (): string => sh(world.bare, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");

const pairingResult = (p: { codeRepo: string; overlayGlobs: string[]; identifierRulesPath: string | null; planDataRulesPath: string | null } = PAIRING): PlanePushPairingResult => ({
  kind: "pairing",
  pairing: PlanePushPairingReply.parse({ code_repo: p.codeRepo, overlay_globs: p.overlayGlobs, identifier_rules_path: p.identifierRulesPath, plan_data_rules_path: p.planDataRulesPath, pairing_digest: pairingDigest(p) }),
});
const tokenResult = (over: Record<string, unknown> = {}): PlanePushTokenResult => ({
  kind: "token",
  reply: PlanePushTokenReply.parse({ token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString(), code_repo: "acme/widgets", branch: BRANCH, base: "main", pr: PR, identity: IDENTITY, ...over }),
});

interface Script {
  pairing?: (call: number) => PlanePushPairingResult;
  token?: () => PlanePushTokenResult;
  report?: (message: PlanePushReportMessage) => PlanePushReportResult;
}
function fakeClient(script: Script = {}) {
  const events: string[] = [];
  const reports: PlanePushReportMessage[] = [];
  const state = { pairing: 0, token: 0 };
  const client = {
    async planePushPairing(): Promise<PlanePushPairingResult> {
      state.pairing++;
      events.push(`pairing#${state.pairing}`);
      return script.pairing ? script.pairing(state.pairing) : pairingResult();
    },
    async planePushToken(): Promise<PlanePushTokenResult> {
      state.token++;
      events.push("token");
      return script.token ? script.token() : tokenResult();
    },
    async planePushReport(message: PlanePushReportMessage): Promise<PlanePushReportResult> {
      events.push(`report:${message.phase}`);
      reports.push(PlanePushReportMessage.parse(message));
      return script.report ? script.report(message) : { kind: "recorded" };
    },
  };
  return { client, events, reports, state };
}

interface Harness {
  run: (head: string | undefined, over?: Partial<PlanePushRunEnd>) => Promise<PlanePushOutcome>;
  lines: string[];
  events: string[];
  reports: PlanePushReportMessage[];
  state: { pairing: number; token: number };
  /** True when the token was found in the throwaway repository's files right after the push (it must not be). */
  tokenInRepo: () => boolean;
  ledger: ReturnType<typeof createPlaneBaseLedger>;
}
function harness(script: Script = {}, over: { transport?: (real: PublicGitTransport, events: string[]) => PublicGitTransport; base?: string | null } = {}): Harness {
  const c = fakeClient(script);
  const lines: string[] = [];
  const ledger = createPlaneBaseLedger();
  if (over.base !== null) ledger.record(RUN, over.base ?? world.base);
  let found = false;
  const real = createGitTransport({ origin: world.server.origin });
  const logging: PublicGitTransport = {
    async fetchTip(dir, repo) {
      c.events.push("fetchTip");
      return real.fetchTip(dir, repo);
    },
    async push(i) {
      c.events.push("push");
      await real.push(i);
      found = found || treeContains(i.repoDir, TOKEN);
    },
  };
  const hook = createPlanePushHook({
    client: c.client,
    github: createPlanePushGithub({ apiOrigin: world.api.origin }),
    transport: over.transport ? over.transport(logging, c.events) : logging,
    baseLedger: ledger,
    workRoot: world.workRoot,
    sleep: async () => undefined,
    say: (line) => lines.push(line),
  });
  return {
    run: (head, extra = {}) => hook({ runId: RUN, leaseGeneration: 1, repo: { owner: "acme", name: "widgets-private" }, mirrorDir: world.mirror, privateHead: head, ...extra }),
    lines,
    events: c.events,
    reports: c.reports,
    state: c.state,
    tokenInRepo: () => found,
    ledger,
  };
}

/** True when `needle` is in any file under `dir` (read as bytes), `.git` internals included. */
function treeContains(dir: string, needle: string): boolean {
  const bytes = Buffer.from(needle);
  const walk = (d: string): boolean =>
    readdirSync(d, { withFileTypes: true }).some((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      return e.isFile() && readFileSync(p).includes(bytes);
    });
  return existsSync(dir) && walk(dir);
}

/** Runs `fn` with a `git` first on the PATH that counts every call it gets from the code under test (not from this test's own helpers). */
async function countingGit<T>(fn: () => Promise<T>): Promise<{ value: T; calls: number }> {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(path.join(tmpdir(), "p13b-shim-"));
  const count = path.join(dir, "count");
  writeFileSync(path.join(dir, "git"), `#!/bin/sh\n[ -n "$P13B_COUNT_FILE" ] && echo x >> "$P13B_COUNT_FILE"\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  process.env.P13B_COUNT_FILE = count;
  try {
    const value = await fn();
    return { value, calls: existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0 };
  } finally {
    delete process.env.P13B_COUNT_FILE;
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

const last = <T>(items: T[]): T => items[items.length - 1] as T;
const workDirs = (): string[] => (existsSync(world.workRoot) ? readdirSync(world.workRoot) : []);

describe("a paired run ends with a public pull request (C4 acceptance 13, 15, 20; C6 P1f-3-a, P1f-3-c)", () => {
  const ITEM = { "src/a.ts": "export const a = 1;\nexport const a2 = 3;\n", "src/new/c.ts": "export const c = 4;\n", "PR_BODY.md": "Title: steal the title\n\nThis text must never be the pull request body.\n" };

  it("opens one commit on the public tip whose only changes are the item's paths, with the cloud's text and identity", async () => {
    const head = runWith(ITEM, ["src/b.ts"]);
    const before = branches();
    const t0 = Date.now();
    const h = harness();
    const outcome = await h.run(head);
    expect(outcome).toMatchObject({ kind: "pr_opened", number: 9 });
    const pushed = branches().split("\n").filter((l) => !before.split("\n").includes(l));
    expect(pushed).toHaveLength(1);
    const commit = pushed[0]!.split(" ")[1]!;
    expect(pushed[0]).toBe(`refs/heads/${BRANCH} ${commit}`);
    // Its single commit's parent is the public main tip, and nothing but the item's paths differs from it.
    expect(sh(world.bare, "rev-list", "--parents", "-n1", BRANCH)).toBe(`${commit} ${world.publicTip}`);
    expect(sh(world.bare, "diff", "--name-only", world.publicTip, commit).split("\n").sort()).toEqual(["PR_BODY.md", "src/a.ts", "src/b.ts", "src/new/c.ts"]);
    // The author, committer and message are the cloud's; the pull request carries the cloud's title and body, whatever the agent wrote.
    expect(sh(world.bare, "log", "-1", "--format=%an <%ae> %cn <%ce>%n%B", commit)).toBe(`${IDENTITY.name} <${IDENTITY.email}> ${IDENTITY.name} <${IDENTITY.email}>\n${PR.title}`);
    expect(world.api.pulls).toEqual([{ title: PR.title, body: PR.body, head: BRANCH, base: "main" }]);
    expect(PR.body).not.toContain("steal the title");
    // The seconds are printed and under the bound.
    expect(h.lines).toEqual([expect.stringMatching(/^fx-runner: public push: pr_opened in \d+(\.\d)?s$/)]);
    expect(Date.now() - t0).toBeLessThan(30_000);
  });

  it("asks the cloud for the pairing exactly twice, the second after the scan and before the push, and reports each phase in order", async () => {
    const h = harness();
    await h.run(runWith(ITEM));
    expect(h.state).toEqual({ pairing: 2, token: 1 });
    expect(h.events).toEqual(["token", "pairing#1", "fetchTip", "report:scanning", "pairing#2", "fetchTip", "push", "report:pushed", "report:pr_opened"]);
    expect(h.reports.map((r) => r.phase)).toEqual(["scanning", "pushed", "pr_opened"]);
    const tip = world.publicTip;
    const commit = sh(world.bare, "rev-parse", BRANCH);
    expect(last(h.reports)).toMatchObject({ run_id: RUN, lease_generation: 1, phase: "pr_opened", branch: BRANCH, head_sha: commit, tip_sha: tip, pr_number: 9, pairing_digest: pairingDigest(PAIRING), token_revoked: true });
    expect(h.reports[1]).toMatchObject({ phase: "pushed", branch: BRANCH, head_sha: commit, tip_sha: tip, pairing_digest: pairingDigest(PAIRING) });
  });

  it("the token reaches the push only in the Authorization header of the receive-pack requests, is in no file and no line, and is revoked", async () => {
    const h = harness();
    await h.run(runWith(ITEM));
    // The git server saw it only on pushes, never in a URL; reads were anonymous.
    expect(world.server.seen.some((s) => s.path.includes(TOKEN))).toBe(false);
    const pushes = world.server.seen.filter((s) => s.path.includes("git-receive-pack"));
    expect(pushes.length).toBeGreaterThan(0);
    for (const s of pushes) expect(s.authorization).toBe(`Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
    for (const s of world.server.seen.filter((s) => !s.path.includes("git-receive-pack"))) expect(s.authorization, s.path).toBeUndefined();
    // The two API calls and the revoke carried it as a bearer, with a User-Agent.
    expect(world.api.seen.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /repos/acme/widgets/git/ref/heads/${BRANCH}`, "POST /repos/acme/widgets/pulls", "DELETE /installation/token"]);
    for (const s of world.api.seen) expect(s).toMatchObject({ authorization: `Bearer ${TOKEN}`, userAgent: "fulcrumaxe-runner" });
    // Nowhere else: not in the throwaway repository while it existed, not under the mirror, the private repo, the public repo or the state directory, not in a report or a line.
    expect(h.tokenInRepo()).toBe(false);
    for (const dir of [world.root]) expect(treeContains(dir, TOKEN), dir).toBe(false);
    expect(JSON.stringify([h.reports, h.lines])).not.toContain(TOKEN);
    // It was revoked: a call with it gets 401 now, on the API and on the git server.
    expect(world.tokens.has(TOKEN)).toBe(false);
    const after = await fetch(`${world.api.origin}/repos/acme/widgets/pulls`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "user-agent": "t" }, body: "{}" });
    expect(after.status).toBe(401);
    const push = await fetch(`${world.server.origin}/acme/widgets.git/info/refs?service=git-receive-pack`, { headers: { authorization: `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}` } });
    expect(push.status).toBe(401);
    // The throwaway repository is gone.
    expect(workDirs()).toEqual([]);
  });

  it("builds from a mirror whose branch ref is gone (objects only), and never writes to the mirror", async () => {
    const head = runWith(ITEM);
    expect(sh(world.mirror, "for-each-ref")).not.toContain("fx/run");
    const mirrorBefore = sh(world.mirror, "for-each-ref", "--format=%(refname) %(objectname)");
    const configBefore = readFileSync(path.join(world.mirror, "config"), "utf8");
    expect((await harness().run(head)).kind).toBe("pr_opened");
    expect(sh(world.mirror, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(mirrorBefore);
    expect(readFileSync(path.join(world.mirror, "config"), "utf8")).toBe(configBefore);
  });

  it("is the same from the built output moved to another directory (nothing reads a path baked in at build time)", async () => {
    const { buildSync } = await import("esbuild");
    const built = mkdtempSync(path.join(tmpdir(), "p13b-built-"));
    const moved = mkdtempSync(path.join(tmpdir(), "p13b-moved-"));
    try {
      const out = path.join(built, "hook.mjs");
      buildSync({ entryPoints: [path.resolve(__dirname, "../../src/daemon/planePush.ts"), path.resolve(__dirname, "../../src/daemon/planePushGithub.ts")], bundle: true, platform: "node", format: "esm", outdir: built, entryNames: "[name]", logLevel: "silent", external: [], outExtension: { ".js": ".mjs" } });
      expect(existsSync(path.join(built, "planePush.mjs"))).toBe(true);
      for (const f of readdirSync(built)) writeFileSync(path.join(moved, f), readFileSync(path.join(built, f)));
      rmSync(built, { recursive: true, force: true });
      expect(existsSync(out)).toBe(false);
      const hookMod = (await import(path.join(moved, "planePush.mjs"))) as typeof import("../../src/daemon/planePush.js");
      const ghMod = (await import(path.join(moved, "planePushGithub.mjs"))) as typeof import("../../src/daemon/planePushGithub.js");
      const c = fakeClient();
      const ledger = hookMod.createPlaneBaseLedger();
      ledger.record(RUN, world.base);
      const hook = hookMod.createPlanePushHook({ client: c.client, github: ghMod.createPlanePushGithub({ apiOrigin: world.api.origin }), transport: createGitTransport({ origin: world.server.origin }), baseLedger: ledger, workRoot: world.workRoot, sleep: async () => undefined });
      const outcome = await hook({ runId: RUN, leaseGeneration: 1, repo: { owner: "acme", name: "widgets-private" }, mirrorDir: world.mirror, privateHead: runWith(ITEM) });
      expect(outcome).toMatchObject({ kind: "pr_opened", number: 9 });
      expect(sh(world.bare, "rev-list", "--parents", "-n1", BRANCH).split(" ")[1]).toBe(world.publicTip);
    } finally {
      rmSync(built, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    }
  });
});

describe("a run that is not paired never enters the hook (acceptance 14)", () => {
  it("is told 403 by the token route and then does nothing: no pairing read, no report, no git, no throwaway repository, no GitHub call", async () => {
    const head = runWith({ "src/c.ts": "export const c = 1;\n" });
    const h = harness({ token: () => ({ kind: "not_paired" }) });
    const { value, calls } = await countingGit(() => h.run(head));
    expect(value).toEqual({ kind: "not_entered", why: "unpaired" });
    expect(h.events).toEqual(["token"]);
    expect(calls).toBe(0);
    expect(world.api.seen).toEqual([]);
    expect(world.server.seen).toEqual([]);
    expect(existsSync(world.workRoot)).toBe(false);
    expect(h.lines).toEqual([]);
  });

  it("a run that added no commit reports no_change without a token; an unpaired one is told 403 by that report and stops", async () => {
    const paired = harness();
    expect(await paired.run(undefined)).toEqual({ kind: "no_change" });
    expect(paired.events).toEqual(["report:no_change"]);
    expect(paired.state).toEqual({ pairing: 0, token: 0 });
    const unpaired = harness({ report: () => ({ kind: "not_paired" }) });
    const { value, calls } = await countingGit(() => unpaired.run(undefined));
    expect(value).toEqual({ kind: "not_entered", why: "unpaired" });
    expect(calls).toBe(0);
    expect(existsSync(world.workRoot)).toBe(false);
  });

  it("a cloud that cannot be asked for the token (a network error, an old cloud) leaves the run exactly as it was", async () => {
    const h = harness({ token: () => ({ kind: "error", status: 0 }) });
    const { value, calls } = await countingGit(() => h.run(runWith({ "src/c.ts": "export const c = 1;\n" })));
    expect(value).toEqual({ kind: "not_entered", why: "unavailable" });
    expect(calls).toBe(0);
    expect(h.reports).toEqual([]);
  });

  it("a run whose start commit was never recorded, or that was told to stop before the hook, asks for nothing", async () => {
    const head = runWith({ "src/c.ts": "export const c = 1;\n" });
    const noBase = harness({}, { base: null });
    expect(await noBase.run(head)).toEqual({ kind: "not_entered", why: "no_base" });
    expect(noBase.events).toEqual([]);
    const aborted = harness();
    const controller = new AbortController();
    controller.abort();
    expect(await aborted.run(head, { signal: controller.signal })).toEqual({ kind: "not_entered", why: "aborted" });
    expect(aborted.events).toEqual([]);
  });
});

describe("the pairing is the cloud's alone (P1f-3-a, P1f-3-b; P1f-2b acceptance 5)", () => {
  const ITEM = { "src/c.ts": "export const c = 1;\n" };

  it("a pairing edited between the first and second read refuses pairing_changed, pushes nothing and revokes the token", async () => {
    const head = runWith(ITEM);
    const before = branches();
    const edited = { ...PAIRING, overlayGlobs: ["docs/ops/", "rules/", "extra/"] };
    const h = harness({ pairing: (n) => pairingResult(n === 1 ? PAIRING : edited) });
    const outcome = await h.run(head);
    expect(outcome).toMatchObject({ kind: "refused", code: "pairing_changed" });
    expect(h.events).not.toContain("push");
    expect(h.state.pairing).toBe(2);
    expect(branches()).toBe(before);
    expect(last(h.reports)).toMatchObject({ phase: "refused", code: "pairing_changed", token_revoked: true });
    expect(world.tokens.has(TOKEN)).toBe(false);
  });

  it("every kind of edit between the two reads refuses: a glob removed, reordered, a rule path changed or cleared, another repo", async () => {
    const head = runWith(ITEM);
    const before = branches();
    for (const edit of [{ overlayGlobs: ["docs/ops/"] }, { overlayGlobs: ["rules/", "docs/ops/"] }, { planDataRulesPath: null }, { identifierRulesPath: "rules/other.txt" }, { codeRepo: "acme/other" }]) {
      world.tokens.set(TOKEN, ["acme/widgets"]);
      const h = harness({ pairing: (n) => pairingResult(n === 1 ? PAIRING : { ...PAIRING, ...edit }) });
      const outcome = await h.run(head);
      expect(outcome, JSON.stringify(edit)).toMatchObject({ kind: "refused", code: "pairing_changed" });
      expect(branches()).toBe(before);
    }
  });

  it("a 409 from the second read (the cloud's own digest check) refuses the same way", async () => {
    const head = runWith(ITEM);
    const before = branches();
    const h = harness({ pairing: (n) => (n === 1 ? pairingResult() : { kind: "pairing_changed" }) });
    expect(await h.run(head)).toMatchObject({ kind: "refused", code: "pairing_changed" });
    expect(branches()).toBe(before);
  });

  it("a pairing reply the client cannot believe costs no local work: the git call count is 0 and nothing is built", async () => {
    const head = runWith(ITEM);
    const h = harness({ pairing: () => ({ kind: "error", status: 200, code: "invalid_reply" }) });
    const { value, calls } = await countingGit(() => h.run(head));
    expect(value).toMatchObject({ kind: "refused", code: "public_unavailable" });
    expect(calls).toBe(0);
    expect(existsSync(world.workRoot)).toBe(false);
    expect(h.state.pairing).toBe(1);
    expect(last(h.reports)).toMatchObject({ phase: "refused", code: "public_unavailable", token_revoked: true });
  });

  it("a read that fails on the network or a 5xx is tried again (it has no side effect), and then goes on", async () => {
    const head = runWith(ITEM);
    const h = harness({ pairing: (n) => (n < 3 ? { kind: "error", status: n === 1 ? 0 : 503 } : pairingResult()) });
    expect((await h.run(head)).kind).toBe("pr_opened");
    expect(h.state.pairing).toBe(4);
  });

  it("the cloud's rule-file paths decide which rules apply: a run that changed a declared rule file is refused (it would be scanned by its own rules)", async () => {
    const before = branches();
    const weakened = runWith({ "rules/ids.txt": "=== FORBIDDEN_PATTERNS_START ===\nnothing-at-all\n=== FORBIDDEN_PATTERNS_END ===\n", "src/leak.ts": "export const host = 'acme-internal-host';\n" });
    const h = harness();
    const outcome = await h.run(weakened);
    expect(outcome).toMatchObject({ kind: "refused", code: "scan_refused" });
    expect(last(h.reports)).toMatchObject({ phase: "refused", code: "scan_refused", refusals: [{ kind: "rule_file_changed", place: "rules/ids.txt", rule_key: "rule_file_changed" }] });
    expect(branches()).toBe(before);
  });

  it("the same for the plan-data file: a run that edited it is refused, and nothing reaches the public repo", async () => {
    const before = branches();
    const edited = runWith({ "rules/plan.json": JSON.stringify({ priceUsdPerMonth: 918273645 }), "src/price.ts": "export const price = 7391;\n" });
    const h = harness();
    expect(await h.run(edited)).toMatchObject({ kind: "refused", code: "scan_refused" });
    expect(last(h.reports)).toMatchObject({ phase: "refused", code: "scan_refused", refusals: [{ kind: "rule_file_changed", place: "rules/plan.json", rule_key: "rule_file_changed" }] });
    expect(branches()).toBe(before);
  });

  it("rules updated on the default branch after the run started apply to the run: a value newly listed there is refused", async () => {
    const before = branches();
    const head = runWith({ "src/vault.ts": "export const host = 'acme-staging-vault';\n" });
    // The default branch moves on after the run's start commit: its identifier rules gain a value.
    const defaultRef = sh(world.mirror, "symbolic-ref", "HEAD");
    sh(world.priv, "checkout", "-q", "--detach", world.base);
    put(world.priv, { "rules/ids.txt": IDS.replace("acme-internal-host\n", "acme-internal-host\nacme-staging-vault\n") });
    commitAll(world.priv, "rule update");
    sh(world.priv, "push", "-q", world.mirror, `HEAD:${defaultRef}`);
    const h = harness();
    expect(await h.run(head)).toMatchObject({ kind: "refused", code: "scan_refused" });
    expect(last(h.reports)).toMatchObject({ phase: "refused", code: "scan_refused", refusals: [{ kind: "identifier_hit", place: "src/vault.ts:1" }] });
    expect(branches()).toBe(before);
  });

  it("a stored pairing whose rule files are not private paths is refused on the runner path too, before anything is pushed", async () => {
    const before = branches();
    const legacy = { ...PAIRING, overlayGlobs: ["docs/ops/"] };
    const h = harness({ pairing: () => pairingResult(legacy) });
    expect(await h.run(runWith(ITEM))).toMatchObject({ kind: "refused", code: "rule_files_not_private" });
    expect(last(h.reports)).toMatchObject({ phase: "refused", code: "rule_files_not_private", refusals: [{ kind: "rule_file_not_private", place: "rules/ids.txt" }, { kind: "rule_file_not_private", place: "rules/plan.json" }] });
    expect(branches()).toBe(before);
  });

  it("a static test: nothing in fx-runner's source reads globs or rule paths from anywhere but the pairing reply", () => {
    const src = path.resolve(__dirname, "../../src");
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith(".ts")) files.push(path.join(d, e.name));
      }
    };
    walk(src);
    const NAMES = /overlay_?[Gg]lobs|identifier_?[Rr]ules_?[Pp]ath|plan_?[Dd]ata_?[Rr]ules_?[Pp]ath/;
    const naming = files.filter((f) => NAMES.test(readFileSync(f, "utf8"))).map((f) => path.relative(src, f).split(path.sep).join("/"));
    // D#6 PUBLIC-MERGE PR3: the merge-order handler is the one other reader, and it takes the list from the claim reply's order alone (the cloud's own row).
    expect(naming).toEqual(["daemon/planeMerge.ts", "daemon/planePush.ts"]);
    const merge = readFileSync(path.join(src, "daemon/planeMerge.ts"), "utf8");
    expect(merge).not.toMatch(/process\.env|readFileSync|readFile\(|JSON\.parse|loadSettings|import\(/);
    expect(merge.match(/order\.overlay_globs/g)?.length).toBe(1);
    // That one file builds the pairing from the reply object alone and reads nothing from disk, the environment or JSON.
    const text = readFileSync(path.join(src, "daemon/planePush.ts"), "utf8");
    expect(text).not.toMatch(/process\.env|readFileSync|readFile\(|JSON\.parse|loadSettings|import\(/);
    const assignments = [...text.matchAll(/(?:overlayGlobs|identifierRulesPath|planDataRulesPath):\s*([^,}]+)/g)].map((m) => m[1]!.trim());
    expect(assignments.every((a) => /^(\[\.\.\.p\.overlay_globs\]|p\.identifier_rules_path|p\.plan_data_rules_path)$/.test(a))).toBe(true);
    expect(assignments.length).toBe(3);
  });
});

describe("the text, the identity and the branch are the token reply's alone (P1f-3-c)", () => {
  it("the route input takes title, body, identity and branch from the grant, and a hostile file in the item changes none of them", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../src/daemon/planePush.ts"), "utf8");
    for (const field of ["branch: grant.branch", "title: grant.pr.title", "body: grant.pr.body", "identity: grant.identity"]) expect(text).toContain(field);
    const head = runWith({ ".github/pull_request_template.md": "body from the agent\n", "PR_TITLE.txt": "title from the agent\n", "src/c.ts": "export const c = 1;\n" });
    const h = harness();
    expect((await h.run(head)).kind).toBe("pr_opened");
    expect(world.api.pulls[0]).toMatchObject({ title: PR.title, body: PR.body, head: BRANCH });
    expect(sh(world.bare, "log", "-1", "--format=%an|%ae|%s", BRANCH)).toBe(`${IDENTITY.name}|${IDENTITY.email}|${PR.title}`);
  });
});

describe("the start commit is the daemon's record, not the checkout's (P1f-3-d)", () => {
  it("a base that is not an ancestor of the run's head is refused bad_input and nothing is pushed", async () => {
    const before = branches();
    // A commit the mirror holds but that is not in the run's history: the public tip's own commit, pushed to the mirror on a side branch.
    sh(world.pubWork, "push", "-q", world.mirror, "HEAD:refs/heads/side");
    const head = runWith({ "src/c.ts": "export const c = 1;\n" });
    const h = harness({}, { base: world.publicTip });
    expect(await h.run(head)).toMatchObject({ kind: "refused", code: "bad_input" });
    expect(h.events).toEqual(["token", "pairing#1", "report:refused"]);
    expect(branches()).toBe(before);
    expect(world.tokens.has(TOKEN)).toBe(false);
  });

  it("a base on the run branch but not on the mirror's default branch is refused too", async () => {
    const before = branches();
    sh(world.priv, "checkout", "-q", "-B", "fx/run", world.base);
    put(world.priv, { "src/c.ts": "export const c = 1;\n" });
    const first = commitAll(world.priv, "first");
    put(world.priv, { "src/d.ts": "export const d = 1;\n" });
    const second = commitAll(world.priv, "second");
    sh(world.priv, "push", "-q", world.mirror, "HEAD:refs/heads/fx/run");
    // The recorded base is the run's own first commit: an ancestor of the head, but not the default branch's history.
    const h = harness({}, { base: first });
    expect(await h.run(second)).toMatchObject({ kind: "refused", code: "bad_input" });
    expect(branches()).toBe(before);
  });

  it("the ledger refuses a second record for a run and a value that is not a full commit id", () => {
    const ledger = createPlaneBaseLedger();
    ledger.record(RUN, world.base);
    expect(() => ledger.record(RUN, "b".repeat(40))).toThrow();
    expect(ledger.read(RUN)).toBe(world.base);
    expect(() => createPlaneBaseLedger().record(RUN, "main")).toThrow(TypeError);
    ledger.forget(RUN);
    expect(ledger.read(RUN)).toBeUndefined();
  });
});

describe("every refusal leaves the public repository's branches as they were (acceptance 16)", () => {
  interface Case {
    name: string;
    files: Record<string, string | Buffer>;
    code: string;
    refusal?: { kind: string; place?: string; rule_key?: string };
    script?: Script;
    token?: boolean;
    transport?: (real: PublicGitTransport) => PublicGitTransport;
  }
  const MATCHED = ["acme-internal-host", "7391"];
  const cases: Case[] = [
    { name: "an overlay path", files: { "docs/ops/new.md": "private\n" }, code: "scan_refused", refusal: { kind: "overlay_path", place: "docs/ops/new.md" } },
    { name: "an identifier hit", files: { "src/a.ts": "export const a = 1;\nconst host = 'acme-internal-host';\n" }, code: "scan_refused", refusal: { kind: "identifier_hit", place: "src/a.ts:2", rule_key: "identifier-rule#1" } },
    { name: "a plan-data key", files: { "src/a.ts": "export const a = 1;\nconst o = { priceUsdPerMonth: 7391 };\n" }, code: "scan_refused", refusal: { kind: "plan_data_hit", place: "src/a.ts:2", rule_key: "priceUsdPerMonth" } },
    { name: "a binary file", files: { "src/blob.dat": Buffer.from([1, 2, 0, 3]) }, code: "scan_refused", refusal: { kind: "binary_file", place: "src/blob.dat" } },
    { name: "a file over 8 MB", files: { "src/big.txt": ("y".repeat(99) + "\n").repeat(81_000) }, code: "scan_refused", refusal: { kind: "file_too_large", place: "src/big.txt" } },
    { name: "a declared rule file that is missing", files: { "src/c.ts": "export const c = 1;\n" }, code: "scan_refused", refusal: { kind: "rule_file_missing", place: "rules/gone.txt" }, script: { pairing: () => pairingResult({ ...PAIRING, identifierRulesPath: "rules/gone.txt" }) } },
    { name: "the App not installed on the public repo", files: { "src/c.ts": "export const c = 1;\n" }, code: "app_not_installed", script: { token: () => ({ kind: "refused", code: "app_not_installed" }) }, token: false },
    { name: "a token mint that failed", files: { "src/c.ts": "export const c = 1;\n" }, code: "public_unavailable", script: { token: () => ({ kind: "refused", code: "public_unavailable" }) }, token: false },
    { name: "a token for another repository than the pairing names", files: { "src/c.ts": "export const c = 1;\n" }, code: "token_scope_mismatch", script: { token: () => tokenResult({ code_repo: "acme/other" }) } },
    { name: "a token that is already expired", files: { "src/c.ts": "export const c = 1;\n" }, code: "public_unavailable", script: { token: () => tokenResult({ expires_at: new Date(Date.now() - 1000).toISOString() }) } },
    {
      name: "a network error on the push",
      files: { "src/c.ts": "export const c = 1;\n" },
      code: "push_failed",
      transport: (real) => ({
        fetchTip: (d, r) => real.fetchTip(d, r),
        push: async (i) => {
          await world.server.close();
          await real.push(i);
        },
      }),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: the branch list is unchanged and the report names the code with place and rule key, never the value`, async () => {
      const head = runWith(c.files);
      const before = branches();
      const h = harness(c.script, c.transport ? { transport: c.transport } : {});
      const outcome = await h.run(head);
      expect(outcome).toMatchObject({ kind: "refused", code: c.code });
      expect(branches()).toBe(before);
      const final = last(h.reports);
      expect(final).toMatchObject({ phase: "refused", code: c.code });
      if (c.refusal) expect(final.refusals).toEqual(expect.arrayContaining([expect.objectContaining(c.refusal)]));
      for (const refusal of final.refusals ?? []) expect(Object.keys(refusal).sort()).toEqual(["kind", "place", "rule_key"]);
      for (const value of MATCHED) expect(JSON.stringify([h.reports, h.lines]), value).not.toContain(value);
      // A token that was granted is revoked; one that never existed is not revoked (there is nothing to).
      if (c.token === false) expect(world.api.seen.filter((s) => s.method === "DELETE")).toEqual([]);
      else expect(last(world.api.seen)).toMatchObject({ method: "DELETE", path: "/installation/token" });
      expect(workDirs()).toEqual([]);
    }, 60_000);
  }

  it("a hook that is never told the token pushes nothing: a refusal before the scan makes no push request at all", async () => {
    const head = runWith({ "docs/ops/new.md": "private\n" });
    await harness().run(head);
    expect(world.server.seen.filter((s) => s.path.includes("git-receive-pack"))).toEqual([]);
  });
});

describe("the pull request is not opened (acceptance 17)", () => {
  it("a pull request GitHub refuses after the push reports pr_failed with the pushed branch, and the branch stays", async () => {
    const head = runWith({ "src/c.ts": "export const c = 1;\n" });
    world.api.failNextPull(422);
    const h = harness();
    const outcome = await h.run(head);
    expect(outcome).toMatchObject({ kind: "pr_not_opened" });
    const commit = sh(world.bare, "rev-parse", BRANCH);
    expect(last(h.reports)).toMatchObject({ phase: "pr_failed", branch: BRANCH, head_sha: commit, tip_sha: world.publicTip, pairing_digest: pairingDigest(PAIRING), token_revoked: true });
    expect(h.reports.map((r) => r.phase)).toEqual(["scanning", "pushed", "pr_failed"]);
    // Nothing is pushed twice: one receive-pack exchange, and the branch is the one commit.
    expect(sh(world.bare, "rev-list", "--count", `${world.publicTip}..${BRANCH}`)).toBe("1");
    expect(world.api.pulls).toEqual([]);
  });
});

describe("no product-path change (acceptance 18)", () => {
  it("a run whose change the public repository already has reports no_change, pushes nothing and revokes the token", async () => {
    // The public repo already has the item's edit of README.md.
    put(world.pubWork, { "README.md": "# widgets, newer\n" });
    commitAll(world.pubWork, "public edits the readme");
    sh(world.pubWork, "push", "-q", world.bare, "main");
    const before = branches();
    const head = runWith({ "README.md": "# widgets, newer\n" });
    const h = harness();
    const outcome = await h.run(head);
    expect(outcome).toEqual({ kind: "no_change" });
    expect(last(h.reports)).toMatchObject({ phase: "no_change", token_revoked: true });
    expect(branches()).toBe(before);
    expect(h.events).not.toContain("push");
  });
});

describe("a run the cloud ended (acceptance 19)", () => {
  it("a stop on the first pairing read ends the hook with nothing built, nothing pushed and the token revoked, and reports nothing more", async () => {
    const head = runWith({ "src/c.ts": "export const c = 1;\n" });
    const h = harness({ pairing: () => ({ kind: "stop", reason: "stale_generation" }) });
    const { value, calls } = await countingGit(() => h.run(head));
    expect(value).toEqual({ kind: "stopped", reason: "stale_generation" });
    expect(calls).toBe(0);
    expect(h.reports).toEqual([]);
    expect(world.tokens.has(TOKEN)).toBe(false);
  });

  it("a stop on the scanning report ends it before the build is pushed", async () => {
    const head = runWith({ "src/c.ts": "export const c = 1;\n" });
    const before = branches();
    const h = harness({ report: (m) => (m.phase === "scanning" ? { kind: "stop", reason: "stale_generation" } : { kind: "recorded" }) });
    expect(await h.run(head)).toEqual({ kind: "stopped", reason: "stale_generation" });
    expect(branches()).toBe(before);
    expect(h.events).not.toContain("push");
    expect(world.tokens.has(TOKEN)).toBe(false);
  });

  it("a report that fails on the network or a 5xx is tried three times and never stops the push; a 4xx is not tried again", async () => {
    let scanning = 0;
    const flaky = harness({ report: (m) => (m.phase === "scanning" && ++scanning < 3 ? { kind: "error", status: scanning === 1 ? 0 : 503 } : { kind: "recorded" }) });
    expect((await flaky.run(runWith({ "src/c.ts": "export const c = 1;\n" }))).kind).toBe("pr_opened");
    expect(flaky.events.filter((e) => e === "report:scanning")).toHaveLength(3);
    world.tokens.set(TOKEN, ["acme/widgets"]);
    sh(world.bare, "update-ref", "-d", `refs/heads/${BRANCH}`);
    const broken = harness({ report: () => ({ kind: "error", status: 500 }) });
    expect((await broken.run(runWith({ "src/d.ts": "export const d = 1;\n" }))).kind).toBe("pr_opened");
    expect(broken.events.filter((e) => e === "report:scanning")).toHaveLength(3);
    world.tokens.set(TOKEN, ["acme/widgets"]);
    sh(world.bare, "update-ref", "-d", `refs/heads/${BRANCH}`);
    const refused = harness({ report: () => ({ kind: "error", status: 400, code: "invalid_message" }) });
    expect((await refused.run(runWith({ "src/e.ts": "export const e = 1;\n" }))).kind).toBe("pr_opened");
    expect(refused.events.filter((e) => e === "report:scanning")).toHaveLength(1);
  });
});

describe("the throwaway repository and its directory (no-follow file operations)", () => {
  it("a link at the work root is refused: nothing is created through it and nothing behind it is touched", async () => {
    const target = path.join(world.root, "elsewhere");
    mkdirSync(target);
    writeFileSync(path.join(target, "keep.txt"), "keep");
    symlinkSync(target, world.workRoot);
    const head = runWith({ "src/c.ts": "export const c = 1;\n" });
    const before = branches();
    const h = harness();
    expect(await h.run(head)).toEqual({ kind: "failed" });
    expect(readdirSync(target)).toEqual(["keep.txt"]);
    expect(branches()).toBe(before);
    expect(last(h.reports)).toMatchObject({ phase: "refused", code: "push_failed", token_revoked: true });
    expect(lstatSync(world.workRoot).isSymbolicLink()).toBe(true);
  });

  it("a stale throwaway directory from a stopped daemon is swept at start, and nothing else is: a link, a file and a foreign name survive", () => {
    mkdirSync(world.workRoot, { recursive: true, mode: 0o700 });
    const outside = path.join(world.root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "precious.txt"), "precious");
    mkdirSync(path.join(world.workRoot, "p-abc123"));
    writeFileSync(path.join(world.workRoot, "p-abc123", "x"), "x");
    symlinkSync(outside, path.join(world.workRoot, "p-lnk123"));
    writeFileSync(path.join(world.workRoot, "p-file12"), "not a directory");
    mkdirSync(path.join(world.workRoot, "other"));
    sweepWorkRoot(world.workRoot);
    expect(readdirSync(world.workRoot).sort()).toEqual(["other", "p-file12", "p-lnk123"]);
    expect(readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("precious");
    // A work root that is itself a link is left alone.
    const linked = path.join(world.root, "linked-root");
    symlinkSync(outside, linked);
    sweepWorkRoot(linked);
    expect(readdirSync(outside)).toEqual(["precious.txt"]);
  });

  it("creating the hook sweeps the work root, and the root it makes is private", async () => {
    mkdirSync(world.workRoot, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(world.workRoot, "p-stale1"));
    harness();
    expect(workDirs()).toEqual([]);
    const head = runWith({ "src/c.ts": "export const c = 1;\n" });
    await harness().run(head);
    expect(lstatSync(world.workRoot).mode & 0o077).toBe(0);
  });
});

describe("the refusals as the report carries them", () => {
  it("are a kind, a place and a rule key of fixed shape, whatever the path holds", () => {
    const hostile = [{ kind: "malformed_path" as const, path: `a\n b\u0000${"x".repeat(500)}`, line: 3, message: "m" }, { kind: "overlay_path" as const, message: "m" }, { kind: "identifier_hit" as const, path: "src/a.ts", line: 2, rule: `identifier-rule#1${"r".repeat(300)}`, message: "acme-internal-host" }];
    const entries = reportRefusals(hostile);
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(["kind", "place", "rule_key"]);
      expect(e.place.length).toBeLessThanOrEqual(300);
      expect(e.rule_key.length).toBeLessThanOrEqual(200);
    }
    expect(entries[1]).toEqual({ kind: "overlay_path", place: "-", rule_key: "overlay_path" });
    expect(JSON.stringify(entries)).not.toContain("acme-internal-host");
    expect(PlanePushReportMessage.safeParse({ run_id: RUN, lease_generation: 1, phase: "refused", code: "scan_refused", refusals: entries }).success).toBe(true);
    expect(reportRefusals(Array.from({ length: 150 }, () => hostile[1]!))).toHaveLength(100);
  });
});

describe("a fix round updates the open public pull request (FIXROUND-REPUBLISH R2-c1)", () => {
  const FIRST = { "src/a.ts": "export const a = 1;\nexport const a2 = 3;\n", "src/new/c.ts": "export const c = 4;\n" };

  /** The first publication: the item's work, one commit on the public tip, on the platform's branch. */
  async function published(): Promise<{ stamp: string; head1: string }> {
    const head1 = runWith(FIRST);
    expect(await harness().run(head1)).toMatchObject({ kind: "pr_opened" });
    return { stamp: sh(world.bare, "rev-parse", BRANCH), head1 };
  }

  /**
   * Main moves on both sides (a public file changes in both, and an overlay file changes in the private one only), then the cloud merges the private
   * main into the item's branch (a private merge commit) and the round adds a fix. The mirror is brought up to date, as the daemon's is before a round.
   * Returns the cloud's signed base (the private main tip it merged), the new public tip and the round's head.
   */
  function fixRound(opts: { dropBase?: boolean } = {}): { base2: string; tip2: string; head2: string } {
    sh(world.priv, "checkout", "-q", "-B", "main2", world.base);
    put(world.priv, { "src/b.ts": "export const b = 22;\n", "docs/ops/plan.md": "private plan, changed on main\n" });
    const base2 = commitAll(world.priv, "main moved (private)");
    put(world.pubWork, { "src/b.ts": "export const b = 22;\n" });
    const tip2 = commitAll(world.pubWork, "main moved (public)");
    sh(world.pubWork, "push", "-q", world.bare, "main");
    sh(world.priv, "checkout", "-q", "fx/run");
    if (opts.dropBase) {
      // The branch was force-pushed after the sync: its new history never contained the base.
      sh(world.priv, "checkout", "-q", "-B", "fx/run", world.base);
      put(world.priv, { ...FIRST, "src/new/d.ts": "export const d = 5;\n" });
    } else {
      sh(world.priv, "merge", "-q", "--no-edit", base2);
      put(world.priv, { "src/new/d.ts": "export const d = 5;\n" });
    }
    const head2 = commitAll(world.priv, "fix round");
    sh(world.priv, "push", "-q", "-f", world.mirror, "HEAD:refs/heads/fx/run", "main2:refs/heads/main");
    sh(world.mirror, "update-ref", "-d", "refs/heads/fx/run");
    return { base2, tip2, head2 };
  }
  // A new token for the round, as the cloud mints one per grant (the first was revoked after the first publication).
  const TOKEN2 = ["ghs", "p13bhooktokenvalue000002"].join("_");
  const withStamp = (stamp: string) => {
    world.tokens.set(TOKEN2, ["acme/widgets"]);
    return { token: () => tokenResult({ replaces_head: stamp, token: TOKEN2 }) };
  };

  it("replaces the branch with ONE commit whose only parent is the new public tip: no private commit goes along, the diff is the item's paths, and an overlay change that came in with the sync is not in it", async () => {
    const { stamp } = await published();
    const callsBefore = world.api.seen.length;
    const { base2, tip2, head2 } = fixRound();
    const h = harness(withStamp(stamp), { base: base2 });
    const outcome = await h.run(head2);
    expect(outcome).toMatchObject({ kind: "updated" });
    const commit = sh(world.bare, "rev-parse", BRANCH);
    expect(commit).not.toBe(stamp);
    expect(sh(world.bare, "rev-list", "--parents", "-n1", BRANCH)).toBe(`${commit} ${tip2}`);
    expect(sh(world.bare, "rev-list", "--count", `${tip2}..${BRANCH}`)).toBe("1");
    // Neither the round's head, the private merge commit nor the signed base was sent.
    for (const private_ of [head2, base2, sh(world.priv, "rev-parse", `${head2}^`)]) expect(() => sh(world.bare, "cat-file", "-e", private_)).toThrow();
    // The item's paths, all of them, and nothing the sync brought in: not the public file main changed (it is already in the tip), not the private overlay file.
    expect(sh(world.bare, "diff", "--name-only", tip2, commit).split("\n").sort()).toEqual(["src/a.ts", "src/new/c.ts", "src/new/d.ts"]);
    expect(() => sh(world.bare, "cat-file", "-e", `${commit}:docs/ops/plan.md`)).toThrow();
    expect(sh(world.bare, "show", `${commit}:src/b.ts`)).toBe("export const b = 22;");
    // One update report with the new head, no `pushed`, no second pull request, and the token revoked.
    expect(h.reports.map((r) => r.phase)).toEqual(["scanning", "updated"]);
    expect(last(h.reports)).toMatchObject({ phase: "updated", branch: BRANCH, head_sha: commit, tip_sha: tip2, pairing_digest: pairingDigest(PAIRING), token_revoked: true });
    expect(world.api.pulls).toHaveLength(1);
    expect(world.api.seen.slice(callsBefore).map((s) => `${s.method} ${s.path}`)).toEqual([`GET /repos/acme/widgets/git/ref/heads/${BRANCH}`, "DELETE /installation/token"]);
  });

  it("is a compare-and-swap: a commit someone pushes to the branch between the check and the push is kept, and the update is refused public_branch_moved", async () => {
    const { stamp } = await published();
    const { base2, head2 } = fixRound();
    let person = "";
    const h = harness(withStamp(stamp), {
      base: base2,
      transport: (real) => ({
        fetchTip: (d, r) => real.fetchTip(d, r),
        async push(i) {
          // The race: a person's commit lands after the cloud's own read of the branch and before our push.
          put(world.pubWork, { "src/person.ts": "export const p = 1;\n" });
          person = commitAll(world.pubWork, "a person's commit");
          sh(world.pubWork, "push", "-q", "-f", world.bare, `${person}:refs/heads/${BRANCH}`);
          await real.push(i);
        },
      }),
    });
    expect(await h.run(head2)).toMatchObject({ kind: "refused", code: "public_branch_moved" });
    expect(sh(world.bare, "rev-parse", BRANCH)).toBe(person);
    expect(last(h.reports)).toMatchObject({ phase: "refused", code: "public_branch_moved" });
  });

  it("a push the server applied but the client reported as failed is an update that stands: the branch is at our commit, not a person's, and the report says updated", async () => {
    const { stamp } = await published();
    const { base2, tip2, head2 } = fixRound();
    const h = harness(withStamp(stamp), {
      base: base2,
      transport: (real) => ({
        fetchTip: (d, r) => real.fetchTip(d, r),
        async push(i) {
          await real.push(i);
          throw new Error("connection reset after receive-pack");
        },
      }),
    });
    expect(await h.run(head2)).toMatchObject({ kind: "updated" });
    const commit = sh(world.bare, "rev-parse", BRANCH);
    expect(commit).not.toBe(stamp);
    expect(last(h.reports)).toMatchObject({ phase: "updated", head_sha: commit, tip_sha: tip2 });
  });

  it("a failed push that left the branch at the stamp is push_failed, not a moved branch", async () => {
    const { stamp } = await published();
    const { base2, head2 } = fixRound();
    const h = harness(withStamp(stamp), {
      base: base2,
      transport: (real) => ({ fetchTip: (d, r) => real.fetchTip(d, r), push: async () => { throw new Error("network down"); } }),
    });
    expect(await h.run(head2)).toMatchObject({ kind: "refused", code: "push_failed" });
    expect(sh(world.bare, "rev-parse", BRANCH)).toBe(stamp);
  });

  it("a branch already moved before the update is refused the same way without a push", async () => {
    const { stamp } = await published();
    const { base2, head2 } = fixRound();
    put(world.pubWork, { "src/person.ts": "export const p = 1;\n" });
    const person = commitAll(world.pubWork, "a person's commit");
    sh(world.pubWork, "push", "-q", "-f", world.bare, `${person}:refs/heads/${BRANCH}`);
    const h = harness(withStamp(stamp), { base: base2 });
    expect(await h.run(head2)).toMatchObject({ kind: "refused", code: "public_branch_moved" });
    expect(h.events).not.toContain("push");
    expect(sh(world.bare, "rev-parse", BRANCH)).toBe(person);
  });

  it("a private branch force-pushed after the sync (the signed base is no longer in its history) refuses at push time and leaves the public branch alone", async () => {
    const { stamp } = await published();
    const { base2, head2 } = fixRound({ dropBase: true });
    const h = harness(withStamp(stamp), { base: base2 });
    expect(await h.run(head2)).toMatchObject({ kind: "refused", code: "bad_input" });
    expect(h.events).not.toContain("push");
    expect(sh(world.bare, "rev-parse", BRANCH)).toBe(stamp);
  });

  it("a signed base that is not on the default branch (a stacked change) is refused at push time too", async () => {
    const { stamp } = await published();
    const { base2, head2 } = fixRound();
    // The mirror's default branch does not hold the base: it is some other branch's tip.
    sh(world.mirror, "update-ref", "refs/heads/main", world.base);
    const h = harness(withStamp(stamp), { base: base2 });
    expect(await h.run(head2)).toMatchObject({ kind: "refused", code: "bad_input" });
    expect(sh(world.bare, "rev-parse", BRANCH)).toBe(stamp);
  });
});
