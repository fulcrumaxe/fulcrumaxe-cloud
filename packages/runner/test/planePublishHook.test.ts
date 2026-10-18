import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createFakeSandbox } from "../src/fakeSandbox.js";
import { runPublishSandbox } from "../src/planePublish/run.js";
import { runPlanePublish, BROKERED } from "../src/planePublish/hook.js";
import { PLANE_PUBLISH_INPUT_PATH, parsePhaseLines, parsePlanePublishInput, phaseLine, terminalLine, type PlanePublishInput, type PlanePublishLine } from "../src/planePublish/protocol.js";
import { startPublishProxy, type PublishProxyFake } from "./helpers/publishProxyFake.js";

/**
 * D#598 P1f-5a: the publish hook on real git, behind a fake of the gh-proxy that decides every request with the real `plane_publish` rule set.
 * Covers C4 item 25's proxy half (a public PR on the public tip, one mint/use/revoke per request, no token on the sandbox side) and item 27
 * (each refusal leaves the public branch list unchanged and prints a code with place and rule key, never the matched value). Invented values only.
 */
const IDS = "=== FORBIDDEN_PATTERNS_START ===\nacme-internal-host\n=== FORBIDDEN_PATTERNS_END ===\n";
const PLAN = JSON.stringify({ priceUsdPerMonth: 7391 });
const PUBLIC_FILES: Record<string, string> = { "README.md": "# widgets\n", "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };
const OVERLAY_FILES: Record<string, string> = { "docs/ops/plan.md": "private plan\n", "rules/ids.txt": IDS, "rules/plan.json": PLAN };
const BRANCH = "fx/p-11111111-2222-4333-8444-555555555555";
const MATCHED = ["acme-internal-host", "7391"];
/** GitHub credential shapes: installation, user, OAuth, refresh, server tokens, and fine-grained tokens. */
const TOKEN_SHAPES = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/];
const TOKEN_SHAPE_ANY = new RegExp(TOKEN_SHAPES.map((r) => r.source).join("|"));
const decodeBasic = (header: string): string => (header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString("utf8") : header);

const cleanEnv = (): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
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
  tmp: string;
  priv: string;
  pubBare: string;
  privBare: string;
  publicTip: string;
  base: string;
  proxy: PublishProxyFake;
}
let world: World;

beforeEach(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "p15a-hook-"));
  const srv = path.join(root, "srv");
  const pubBare = path.join(srv, "acme", "widgets.git");
  const privBare = path.join(srv, "acme", "widgets-private.git");
  for (const b of [pubBare, privBare]) {
    mkdirSync(b, { recursive: true });
    sh(b, "init", "-q", "--bare", "-b", "main");
  }
  // GitHub serves a fetch by full commit id; a stock smart-HTTP server needs this switched on to do the same.
  sh(privBare, "config", "uploadpack.allowAnySHA1InWant", "true");
  const pubWork = path.join(root, "pubwork");
  mkdirSync(pubWork);
  sh(pubWork, "init", "-q", "-b", "main");
  put(pubWork, PUBLIC_FILES);
  const publicTip = commitAll(pubWork, "initial public");
  sh(pubWork, "push", "-q", pubBare, "main");
  const priv = path.join(root, "priv");
  mkdirSync(priv);
  sh(priv, "init", "-q", "-b", "main");
  put(priv, { ...PUBLIC_FILES, ...OVERLAY_FILES });
  const base = commitAll(priv, "private base");
  sh(priv, "push", "-q", privBare, "main");
  const tmp = path.join(root, "tmp");
  mkdirSync(tmp);
  const proxy = await startPublishProxy({ root: srv, privateRepo: { owner: "acme", repo: "widgets-private" }, publishTarget: { codeRepo: "acme/widgets", branch: BRANCH }, env: cleanEnv() });
  world = { root, tmp, priv, pubBare, privBare, publicTip, base, proxy };
});
afterEach(async () => {
  await world.proxy.close();
  rmSync(world.root, { recursive: true, force: true });
});

/** The item's work: a commit on a private run branch, pushed to the private server. Returns its id. */
function runWith(files: Record<string, string | Buffer>): string {
  sh(world.priv, "checkout", "-q", "-B", "fx/run", world.base);
  put(world.priv, files);
  const head = commitAll(world.priv, "item work by a private author");
  sh(world.priv, "push", "-q", "-f", world.privBare, "fx/run");
  return head;
}
const branches = (): string => sh(world.pubBare, "for-each-ref", "--sort=refname", "--format=%(refname) %(objectname)", "refs/heads");
const inputFor = (head: string, over: Partial<PlanePublishInput> = {}): PlanePublishInput => ({
  own: { owner: "acme", name: "widgets-private" },
  codeRepo: "acme/widgets",
  privateBase: world.base,
  privateHead: head,
  branch: BRANCH,
  title: "Change from fulcrumaxe run 0b1b6c52",
  body: "Opened by a fulcrumaxe run, id 0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f.",
  identity: { name: "Fulcrumaxe Bot", email: "bot@example.test" },
  commitTime: 1_700_000_000,
  pairing: { overlayGlobs: ["docs/ops/", "rules/"], identifierRulesPath: "rules/ids.txt", planDataRulesPath: "rules/plan.json" },
  ...over,
});
async function runHook(input: PlanePublishInput): Promise<{ raw: string[]; lines: PlanePublishLine[] }> {
  const raw: string[] = [];
  await runPlanePublish(input, { gitOrigin: world.proxy.origin, apiOrigin: world.proxy.origin, say: (l) => raw.push(l), tmpRoot: world.tmp });
  return { raw, lines: parsePhaseLines(raw.join("\n")) };
}

describe("a publish run end to end (item 25, the proxy half)", () => {
  it("ends with one public PR whose single commit sits on the public tip and changes only the item's paths", async () => {
    const head = runWith({ "src/c.ts": "export const c = 3;\n", "src/a.ts": "export const a = 10;\n", "docs/ops/plan.md": "private plan\n" });
    // The overlay file above is unchanged from the base, so only the two src paths are the item's change.
    const { raw, lines } = await runHook(inputFor(head));
    expect(lines.map((l) => l.phase)).toEqual(["building", "scanning", "pushed", "pr_opened"]);
    const last = lines.at(-1)!;
    const commit = sh(world.pubBare, "rev-parse", BRANCH);
    expect(last).toMatchObject({ phase: "pr_opened", branch: BRANCH, head_sha: commit, tip_sha: world.publicTip, pr_number: 9 });
    expect(sh(world.pubBare, "rev-list", "--parents", "-n1", BRANCH).split(" ")).toEqual([commit, world.publicTip]);
    expect(sh(world.pubBare, "diff", "--name-only", world.publicTip, BRANCH).split("\n").sort()).toEqual(["src/a.ts", "src/c.ts"]);
    expect(branches()).toBe(`refs/heads/${BRANCH} ${commit}\nrefs/heads/main ${world.publicTip}`);
    expect(world.proxy.pulls).toEqual([expect.objectContaining({ head: BRANCH, base: "main", title: "Change from fulcrumaxe run 0b1b6c52" })]);
    // Every output line is one of the fixed shapes, and the private author never reaches the public commit.
    expect(raw.every((l) => parsePhaseLines(l).length === 1)).toBe(true);
    expect(sh(world.pubBare, "log", "-1", "--format=%an %ae %cn %ce", BRANCH)).toBe("Fulcrumaxe Bot bot@example.test Fulcrumaxe Bot bot@example.test");
  }, 60_000);

  it("every request passed the plane_publish rule set, and each public request had exactly one mint, one use and one revoke, in that order", async () => {
    const head = runWith({ "src/c.ts": "export const c = 3;\n" });
    await runHook(inputFor(head));
    expect(world.proxy.log.length).toBeGreaterThan(5);
    expect(world.proxy.log.every((e) => e.decision === "allowed")).toBe(true);
    for (const e of world.proxy.log) expect(e.steps, `${e.method} ${e.path}`).toEqual(["mint", "use", "revoke"]);
    expect(world.proxy.liveTokens.size).toBe(0);
    const kinds = new Set(world.proxy.log.map((e) => `${e.method} ${e.path.replace(/\?.*/, "")}`));
    expect([...kinds].sort()).toEqual(
      [
        "GET /acme/widgets-private.git/info/refs",
        "POST /acme/widgets-private.git/git-upload-pack",
        "GET /acme/widgets.git/info/refs",
        "POST /acme/widgets.git/git-upload-pack",
        "GET /repos/acme/widgets/git/ref/heads/" + BRANCH,
        "GET /acme/widgets.git/info/refs",
        "POST /acme/widgets.git/git-receive-pack",
        "POST /repos/acme/widgets/pulls",
      ].filter((v, i, a) => a.indexOf(v) === i).sort(),
    );
  }, 60_000);

  it("the sandbox side holds no token: nothing it sent or printed carries a token shape or a minted value, and the temporary repository is gone", async () => {
    const head = runWith({ "src/c.ts": "export const c = 3;\n" });
    const { raw } = await runHook(inputFor(head));
    expect(world.proxy.minted.length).toBeGreaterThan(5);
    // Literal shapes of GitHub credentials, searched in the decoded form of every Basic header as well as the raw text.
    const sent = [...world.proxy.clientAuth.filter((a): a is string => a !== undefined).flatMap((a) => [a, decodeBasic(a)]), ...raw];
    expect(sent.filter((t) => TOKEN_SHAPES.some((re) => re.test(t)))).toEqual([]);
    for (const token of world.proxy.minted) expect(sent.some((t) => t.includes(token))).toBe(false);
    expect(BROKERED).not.toMatch(TOKEN_SHAPE_ANY);
    expect(readdirSync(world.tmp)).toEqual([]);
  }, 60_000);

  it("the token check itself catches a leak: a marker shaped like a token, or a minted value in a Basic header, is found (control)", () => {
    const basic = (v: string): string => `Basic ${Buffer.from(`x-access-token:${v}`).toString("base64")}`;
    const shaped = `ghs_${"a1B2".repeat(9)}`;
    expect(TOKEN_SHAPES.some((re) => re.test(decodeBasic(basic(shaped))))).toBe(true);
    expect(TOKEN_SHAPES.some((re) => re.test(basic(shaped)))).toBe(false); // raw base64 hides it: decoding is what finds it
    expect(shaped).toMatch(TOKEN_SHAPE_ANY);
    expect(TOKEN_SHAPES.some((re) => re.test(decodeBasic(basic(BROKERED))))).toBe(false);
  });

  it("GitHub refusing the PR after the push prints pr_failed with the pushed branch; the branch stays and nothing is pushed twice", async () => {
    const head = runWith({ "src/c.ts": "export const c = 3;\n" });
    world.proxy.failNextPull(422);
    const { lines } = await runHook(inputFor(head));
    const commit = sh(world.pubBare, "rev-parse", BRANCH);
    expect(lines.at(-1)).toMatchObject({ phase: "pr_failed", branch: BRANCH, head_sha: commit, tip_sha: world.publicTip });
    expect(world.proxy.log.filter((e) => e.method === "POST" && e.path.endsWith("git-receive-pack"))).toHaveLength(1);
    expect(world.proxy.pulls).toEqual([]);
  }, 60_000);

  it("a run whose change the public repo already has prints no_change and pushes nothing", async () => {
    const head = runWith({ "src/a.ts": "export const a = 1;\n", "src/new.ts": "export const n = 1;\n" });
    // Public gets the same new file first.
    const pubWork = path.join(world.root, "pubwork");
    put(pubWork, { "src/new.ts": "export const n = 1;\n" });
    commitAll(pubWork, "public has it");
    sh(pubWork, "push", "-q", world.pubBare, "main");
    const before = branches();
    const { lines } = await runHook(inputFor(head));
    expect(lines.at(-1)).toEqual({ phase: "no_change" });
    expect(branches()).toBe(before);
  }, 60_000);
});

describe("every refusal leaves the public branches as they were (item 27)", () => {
  interface Case {
    name: string;
    files: Record<string, string | Buffer>;
    code: string;
    refusal?: { kind: string; place?: string; rule_key?: string };
    input?: Partial<PlanePublishInput>;
    proxy?: (p: PublishProxyFake) => void;
  }
  const cases: Case[] = [
    { name: "an overlay path", files: { "docs/ops/new.md": "private\n" }, code: "scan_refused", refusal: { kind: "overlay_path", place: "docs/ops/new.md" } },
    { name: "an identifier hit", files: { "src/a.ts": "export const a = 1;\nconst host = 'acme-internal-host';\n" }, code: "scan_refused", refusal: { kind: "identifier_hit", place: "src/a.ts:2", rule_key: "identifier-rule#1" } },
    { name: "a plan-data key", files: { "src/a.ts": "export const a = 1;\nconst o = { priceUsdPerMonth: 7391 };\n" }, code: "scan_refused", refusal: { kind: "plan_data_hit", place: "src/a.ts:2", rule_key: "priceUsdPerMonth" } },
    { name: "a binary file", files: { "src/blob.dat": Buffer.from([1, 2, 0, 3]) }, code: "scan_refused", refusal: { kind: "binary_file", place: "src/blob.dat" } },
    { name: "a file over 8 MB", files: { "src/big.txt": ("y".repeat(99) + "\n").repeat(81_000) }, code: "scan_refused", refusal: { kind: "file_too_large", place: "src/big.txt" } },
    {
      name: "a declared rule file that is missing",
      files: { "src/c.ts": "export const c = 1;\n" },
      code: "scan_refused",
      refusal: { kind: "rule_file_missing", place: "rules/gone.txt" },
      input: { pairing: { overlayGlobs: ["docs/ops/"], identifierRulesPath: "rules/gone.txt", planDataRulesPath: null } },
    },
    // The proxy mints for the sandbox, so an uninstalled App and a failed mint reach the hook as the proxy's refusal of the public repository.
    { name: "the App not installed (the proxy refuses the public repo)", files: { "src/c.ts": "export const c = 1;\n" }, code: "public_unavailable", proxy: (p) => p.failPublic(404) },
    { name: "a mint that failed (the proxy cannot serve the public repo)", files: { "src/c.ts": "export const c = 1;\n" }, code: "public_unavailable", proxy: (p) => p.failPublic(502) },
    { name: "a network error on the push", files: { "src/c.ts": "export const c = 1;\n" }, code: "push_failed", proxy: (p) => p.dropReceivePack() },
  ];
  for (const c of cases) {
    it(`${c.name}: the branch list is unchanged and the terminal line names the code with place and rule key, never the value`, async () => {
      const head = runWith(c.files);
      const before = branches();
      c.proxy?.(world.proxy);
      const { raw, lines } = await runHook(inputFor(head, c.input));
      expect(branches()).toBe(before);
      const final = lines.at(-1)!;
      expect(terminalLine(lines)).toMatchObject({ phase: "refused", code: c.code });
      if (c.refusal) expect(final.refusals).toEqual(expect.arrayContaining([expect.objectContaining(c.refusal)]));
      for (const r of final.refusals ?? []) expect(Object.keys(r).sort()).toEqual(["kind", "place", "rule_key"]);
      for (const v of MATCHED) expect(raw.join("\n"), v).not.toContain(v);
      expect(world.proxy.pulls).toEqual([]);
      expect(world.proxy.liveTokens.size).toBe(0);
      expect(readdirSync(world.tmp)).toEqual([]);
    }, 60_000);
  }

  it("a scan refusal makes no receive-pack request at all", async () => {
    const head = runWith({ "docs/ops/new.md": "private\n" });
    await runHook(inputFor(head));
    expect(world.proxy.log.filter((e) => e.method === "POST" && e.path.endsWith("git-receive-pack"))).toEqual([]);
  }, 60_000);

  it("commits that are not in the private repository, or a base that is not an ancestor of the head, refuse as bad_input", async () => {
    const head = runWith({ "src/c.ts": "export const c = 1;\n" });
    const missing = await runHook(inputFor("e".repeat(40)));
    expect(terminalLine(missing.lines)).toMatchObject({ phase: "refused", code: "bad_input" });
    const swapped = await runHook(inputFor(world.base, { privateBase: head }));
    expect(terminalLine(swapped.lines)).toMatchObject({ phase: "refused", code: "bad_input" });
    expect(branches()).toBe(`refs/heads/main ${world.publicTip}`);
  }, 60_000);
});

describe("a failure that is not a decision about the change is a crash, not a refusal", () => {
  it("an unusable temp directory ends the run with no terminal line and no push", async () => {
    const head = runWith({ "src/c.ts": "export const c = 3;\n" });
    const raw: string[] = [];
    await expect(runPlanePublish(inputFor(head), { gitOrigin: world.proxy.origin, apiOrigin: world.proxy.origin, say: (l) => raw.push(l), tmpRoot: path.join(world.tmp, "missing", "dir") })).rejects.toThrow();
    expect(terminalLine(parsePhaseLines(raw.join("\n")))).toBeUndefined();
    expect(parsePhaseLines(raw.join("\n")).map((l) => l.phase)).toEqual(["building"]);
    expect(world.proxy.log).toEqual([]);
  });

  it("git is pinned to the system CA bundle the role env exports, in the hook and in the public transport", async () => {
    const { SYSTEM_CA_BUNDLE } = await import("../src/planePublish/hook.js");
    const { SANDBOX_CA_ENV } = await import("../src/sandboxEnv.js");
    expect(SYSTEM_CA_BUNDLE).toBe(SANDBOX_CA_ENV.SSL_CERT_FILE);
    const src = readFileSync(path.resolve(__dirname, "../src/planePublish/hook.ts"), "utf8");
    expect(src).toContain("http.sslCAInfo=${SYSTEM_CA_BUNDLE}");
    expect(src).toContain("caInfo: SYSTEM_CA_BUNDLE");
    const { createGitTransport } = await import("@fulcrumaxe/runner-protocol/planePush");
    expect(() => createGitTransport({ caInfo: "relative/ca.pem" })).toThrow(/absolute path/);
    expect(() => createGitTransport({ caInfo: "/etc/ssl/certs/x y" })).toThrow(/absolute path/);
    expect(() => createGitTransport({ caInfo: SYSTEM_CA_BUNDLE })).not.toThrow();
  });
});

describe("the protocol: closed shapes both ways", () => {
  it("the input parser accepts exactly the shape and nothing else", () => {
    const good = JSON.stringify(inputFor("b".repeat(40), { privateBase: "a".repeat(40) }));
    expect(parsePlanePublishInput(good)).toBeDefined();
    const obj = JSON.parse(good) as Record<string, unknown>;
    for (const bad of [{ ...obj, token: "x" }, { ...obj, codeRepo: "../x" }, { ...obj, privateHead: "main" }, { ...obj, own: { owner: "a", name: "b", extra: 1 } }, { ...obj, pairing: { ...(obj.pairing as object), overlayGlobs: [""] } }, { ...obj, pairing: { overlayGlobs: [], identifierRulesPath: "../x/../y", planDataRulesPath: null } }]) {
      expect(parsePlanePublishInput(JSON.stringify(bad)), JSON.stringify(bad).slice(0, 60)).toBeUndefined();
    }
    expect(parsePlanePublishInput("not json")).toBeUndefined();
  });

  it("a line with an unknown field, an unknown code or a value outside its pattern is neither printed nor read", () => {
    expect(() => phaseLine({ phase: "refused", code: "scan_refused", content: "secret" } as never)).toThrow();
    expect(() => phaseLine({ phase: "refused", code: "made_up" } as never)).toThrow();
    expect(() => phaseLine({ phase: "pr_opened", head_sha: "not-a-sha" })).toThrow();
    expect(() => phaseLine({ phase: "refused", code: "scan_refused", refusals: [{ kind: "k", place: "a\nb", rule_key: "r" }] })).toThrow();
    const mark = '{"fx":"plane_publish",';
    const lines = [`${mark}"phase":"refused","code":"scan_refused","diff":"+secret"}`, `${mark}"phase":"nope"}`, `${mark}"phase":"pr_opened","pr_number":-1}`, "noise", phaseLine({ phase: "no_change" })];
    expect(parsePhaseLines(lines.join("\n"))).toEqual([{ phase: "no_change" }]);
  });

  it("one terminal line is required: none, or two, is no outcome", () => {
    expect(terminalLine([{ phase: "building" }])).toBeUndefined();
    expect(terminalLine([{ phase: "no_change" }, { phase: "no_change" }])).toBeUndefined();
    expect(terminalLine([{ phase: "building" }, { phase: "no_change" }])).toEqual({ phase: "no_change" });
  });
});

describe("the built output moved to another directory (N6: nothing reads a path baked in at build time)", () => {
  it("bundles the hook and the entry, moves them, and runs both", async () => {
    const { buildSync } = await import("esbuild");
    const built = mkdtempSync(path.join(tmpdir(), "p15a-built-"));
    const moved = mkdtempSync(path.join(tmpdir(), "p15a-moved-"));
    try {
      buildSync({
        entryPoints: [path.resolve(__dirname, "../src/planePublish/hook.ts"), path.resolve(__dirname, "../src/planePublish/main.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        outdir: built,
        entryNames: "[name]",
        logLevel: "silent",
        outExtension: { ".js": ".mjs" },
      });
      for (const f of readdirSync(built)) writeFileSync(path.join(moved, f), readFileSync(path.join(built, f)));
      rmSync(built, { recursive: true, force: true });
      for (const f of readdirSync(moved)) {
        const text = readFileSync(path.join(moved, f), "utf8");
        expect(text.includes(path.resolve(__dirname, "..")), `${f} holds a build-time path`).toBe(false);
        expect(text).not.toMatch(/process\.env\.(FX_|GH_|ANTHROPIC)/);
      }
      const mod = (await import(path.join(moved, "hook.mjs"))) as typeof import("../src/planePublish/hook.js");
      const head = runWith({ "src/c.ts": "export const c = 3;\n" });
      const raw: string[] = [];
      await mod.runPlanePublish(inputFor(head), { gitOrigin: world.proxy.origin, apiOrigin: world.proxy.origin, say: (l) => raw.push(l), tmpRoot: world.tmp });
      expect(parsePhaseLines(raw.join("\n")).at(-1)).toMatchObject({ phase: "pr_opened", tip_sha: world.publicTip });
      expect(sh(world.pubBare, "rev-list", "--parents", "-n1", BRANCH).split(" ")[1]).toBe(world.publicTip);
      // N2: the bytes the port records for the hook are the bytes of the real built bundle (hash against the file on disk).
      const bundle = readFileSync(path.join(moved, "main.mjs"), "utf8");
      const fake = createFakeSandbox({ start: async () => undefined, stop: async () => undefined, resume: async () => undefined } as never);
      const name = "pp-11111111-2222-4333-8444-555555555555";
      fake.scriptCommand(name, { exitCode: 0, stdout: `${phaseLine({ phase: "no_change" })}\n` });
      await runPublishSandbox(fake.port, { sandboxName: name, hook: bundle, input: inputFor(head), networkPolicy: [{ host: "gh-proxy.fulcrumaxe.app", purpose: "github_proxy" }] });
      const hookFile = fake.state.writtenFiles.find((f) => f.path === "/fx/plane-publish/fx-plane-publish.mjs")!;
      expect(hookFile.mode).toBe(0o555);
      expect(bundle.length).toBeGreaterThan(10_000);
      expect(hookFile.sha256).toBe(createHash("sha256").update(readFileSync(path.join(moved, "main.mjs"))).digest("hex"));
      // The entry, run as the sandbox runs it (`node <file>`): with no input file at its fixed path it prints one closed refusal and exits 0.
      expect(existsSync(PLANE_PUBLISH_INPUT_PATH)).toBe(false);
      const out = execFileSync(process.execPath, [path.join(moved, "main.mjs")], { encoding: "utf8" });
      expect(parsePhaseLines(out)).toEqual([{ phase: "refused", code: "bad_input" }]);
    } finally {
      rmSync(built, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    }
  }, 90_000);
});
