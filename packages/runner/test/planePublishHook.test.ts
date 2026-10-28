import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createFakeSandbox } from "../src/fakeSandbox.js";
import { runPublishSandbox } from "../src/planePublish/run.js";
import { runPlanePublish, BROKERED, classifyPrivateRead } from "../src/planePublish/hook.js";
import { PLANE_PUBLISH_INPUT_PATH, parsePhaseLines, parsePlanePublishInput, phaseLine, terminalLine, type PlanePublishInput, type PlanePublishLine } from "../src/planePublish/protocol.js";
import { startPublishProxy, type PublishProxyFake } from "./helpers/publishProxyFake.js";

/**
 * D#598 P1f-5a: the publish hook on real git, behind a fake of the gh-proxy that decides every request with the real `plane_publish` rule set.
 * Covers C4 item 25's proxy half (a public PR on the public tip, one mint/use/revoke per request, no token on the sandbox side) and item 27
 * (each refusal leaves the public branch list unchanged and prints a code with place and rule key, never the matched value). Invented values only.
 */
const IDS = "=== FORBIDDEN_PATTERNS_START ===\nacme-internal-host\n=== FORBIDDEN_PATTERNS_END ===\n";
const PLAN = JSON.stringify({ priceUsdPerMonth: 7391 });
/** Edited rule files: a pattern that matches nothing here, and a figure nothing states. */
const EDITED_IDS = "=== FORBIDDEN_PATTERNS_START ===\n^zz[0-9]{50}$\n=== FORBIDDEN_PATTERNS_END ===\n";
const EDITED_PLAN = JSON.stringify({ priceUsdPerMonth: 918273645 });
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

/** The item's work: a commit on a private run branch (on `from`, default the base), pushed to the private server. Returns its id. */
function runWith(files: Record<string, string | Buffer>, from = world.base, branch = "fx/run"): string {
  sh(world.priv, "checkout", "-q", "-B", branch, from);
  put(world.priv, files);
  const head = commitAll(world.priv, "item work by a private author");
  sh(world.priv, "push", "-q", "-f", world.privBare, branch);
  return head;
}
const branches = (): string => sh(world.pubBare, "for-each-ref", "--sort=refname", "--format=%(refname) %(objectname)", "refs/heads");
const inputFor = (head: string, over: Partial<PlanePublishInput> = {}): PlanePublishInput => ({
  own: { owner: "acme", name: "widgets-private" },
  codeRepo: "acme/widgets",
  privateBase: world.base,
  privateHead: head,
  privateDefaultTip: world.base,
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

describe("a stacked item: its recorded base is the parent's unmerged head, and the rules come from the default branch", () => {
  it("a parent that edited a declared rule file refuses the child's first push (rule_file_changed): nothing is pushed and no PR opened", async () => {
    const parent = runWith({ "rules/ids.txt": EDITED_IDS }, world.base, "fx/parent");
    const head = runWith({ "src/host.ts": "export const host = 'acme-internal-host';\n" }, parent);
    const before = branches();
    const { raw, lines } = await runHook(inputFor(head, { privateBase: parent }));
    expect(terminalLine(lines)).toMatchObject({ phase: "refused", code: "scan_refused", refusals: [{ kind: "rule_file_changed", place: "rules/ids.txt", rule_key: "rule_file_changed" }] });
    expect(branches()).toBe(before);
    expect(world.proxy.pulls).toEqual([]);
    for (const v of MATCHED) expect(raw.join("\n"), v).not.toContain(v);
  }, 60_000);

  it("a parent that left the rules alone: the child opens its PR with only its own change", async () => {
    const parent = runWith({ "src/p.ts": "export const p = 1;\n" }, world.base, "fx/parent");
    const head = runWith({ "src/c.ts": "export const c = 3;\n" }, parent);
    const { lines } = await runHook(inputFor(head, { privateBase: parent }));
    expect(terminalLine(lines)).toMatchObject({ phase: "pr_opened" });
    expect(sh(world.pubBare, "diff", "--name-only", world.publicTip, BRANCH)).toBe("src/c.ts");
  }, 60_000);

  it("a default tip that is not in the private repository is refused before anything is built", async () => {
    const head = runWith({ "src/c.ts": "export const c = 3;\n" });
    const before = branches();
    const { lines } = await runHook(inputFor(head, { privateDefaultTip: "e".repeat(40) }));
    expect(terminalLine(lines)).toMatchObject({ phase: "refused", code: "private_read_failed", failure_class: "not_found" });
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
      input: { pairing: { overlayGlobs: ["docs/ops/", "rules/"], identifierRulesPath: "rules/gone.txt", planDataRulesPath: null } },
    },
    // The rules a first push is scanned by are the run's recorded base: a run that rewrites a rule file is refused before anything is built.
    {
      name: "an edited identifier-rules file at the run's head, with a change the base's rules refuse",
      files: { "rules/ids.txt": EDITED_IDS, "src/host.ts": "export const host = 'acme-internal-host';\n" },
      code: "scan_refused",
      refusal: { kind: "rule_file_changed", place: "rules/ids.txt" },
    },
    {
      name: "an edited plan-data file at the run's head, with a figure the base's rules refuse",
      files: { "rules/plan.json": EDITED_PLAN, "src/price.ts": "export const price = 7391;\n" },
      code: "scan_refused",
      refusal: { kind: "rule_file_changed", place: "rules/plan.json" },
    },
    {
      name: "a stored pairing whose rule files are not private paths",
      files: { "src/c.ts": "export const c = 1;\n" },
      code: "rule_files_not_private",
      refusal: { kind: "rule_file_not_private", place: "rules/ids.txt" },
      input: { pairing: { overlayGlobs: ["docs/ops/"], identifierRulesPath: "rules/ids.txt", planDataRulesPath: "rules/plan.json" } },
    },
    {
      name: "the same stored pairing, with an edited rule file and a change the base's rules refuse",
      files: { "rules/ids.txt": EDITED_IDS, "src/host.ts": "export const host = 'acme-internal-host';\n" },
      code: "rule_files_not_private",
      refusal: { kind: "rule_file_not_private", place: "rules/ids.txt" },
      input: { pairing: { overlayGlobs: ["docs/ops/"], identifierRulesPath: "rules/ids.txt", planDataRulesPath: "rules/plan.json" } },
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

  it("a commit the private repository does not have refuses private_read_failed with class not_found, and nothing is pushed", async () => {
    runWith({ "src/c.ts": "export const c = 1;\n" });
    const missing = await runHook(inputFor("e".repeat(40)));
    expect(terminalLine(missing.lines)).toEqual({ phase: "refused", code: "private_read_failed", failure_class: "not_found" });
    expect(branches()).toBe(`refs/heads/main ${world.publicTip}`);
  }, 60_000);

  it("a private upload-pack the proxy denies with 403 refuses private_read_failed with class auth_denied, and the output carries no address or tool text", async () => {
    const head = runWith({ "src/c.ts": "export const c = 1;\n" });
    // The same real rule set, told that the run's private repository is a different one: it answers its fixed 403 `denied` to every request for this one.
    const other = await startPublishProxy({ root: path.join(world.root, "srv"), privateRepo: { owner: "acme", repo: "someone-elses" }, publishTarget: { codeRepo: "acme/widgets", branch: BRANCH }, env: cleanEnv() });
    try {
      const raw: string[] = [];
      await runPlanePublish(inputFor(head), { gitOrigin: other.origin, apiOrigin: other.origin, say: (l) => raw.push(l), tmpRoot: world.tmp });
      expect(terminalLine(parsePhaseLines(raw.join("\n")))).toEqual({ phase: "refused", code: "private_read_failed", failure_class: "auth_denied" });
      expect(raw.join("\n")).not.toMatch(/127\.0\.0\.1|https?:|widgets|fatal|returned error|403/);
    } finally {
      await other.close();
    }
    expect(branches()).toBe(`refs/heads/main ${world.publicTip}`);
  }, 60_000);

  it("a base that is not an ancestor of the head refuses base_not_ancestor", async () => {
    const head = runWith({ "src/c.ts": "export const c = 1;\n" });
    const swapped = await runHook(inputFor(world.base, { privateBase: head }));
    expect(terminalLine(swapped.lines)).toEqual({ phase: "refused", code: "base_not_ancestor" });
    expect(branches()).toBe(`refs/heads/main ${world.publicTip}`);
  }, 60_000);

  it("a default tip that shares no history with the base is still bad_input (a genuine input error, from the route)", async () => {
    const head = runWith({ "src/c.ts": "export const c = 1;\n" });
    const lone = path.join(world.root, "lone");
    mkdirSync(lone);
    sh(lone, "init", "-q", "-b", "main");
    put(lone, { "x.txt": "x\n" });
    const unrelated = commitAll(lone, "unrelated root");
    sh(lone, "push", "-q", world.privBare, "main:refs/heads/unrelated");
    const res = await runHook(inputFor(head, { privateDefaultTip: unrelated }));
    expect(terminalLine(res.lines)).toMatchObject({ phase: "refused", code: "bad_input" });
    expect(branches()).toBe(`refs/heads/main ${world.publicTip}`);
  }, 60_000);

  it("a 1 MB stderr (one long line, or a repeated near-match) classifies in under 100 ms", () => {
    const e = (stderr: string): Error => Object.assign(new Error("x"), { stderr });
    for (const text of ["a".repeat(1_000_000), "object file ".repeat(100_000), `object file ${"x ".repeat(500_000)}`]) {
      const t0 = performance.now();
      expect(classifyPrivateRead(e(text))).toBe("other");
      expect(performance.now() - t0).toBeLessThan(100);
    }
    // Only the head is read: a marker past 8 KB is not seen.
    expect(classifyPrivateRead(e(`${"a".repeat(9000)} returned error: 403`))).toBe("other");
  });

  it("the failure class is a closed word: classified locally from stderr, anything else is other, and a class on another code or an unknown class is not printed", () => {
    const e = (stderr: string): Error => Object.assign(new Error("x"), { stderr });
    expect(classifyPrivateRead(e("fatal: unable to access 'https://h/o/r.git/': The requested URL returned error: 403"))).toBe("auth_denied");
    expect(classifyPrivateRead(e("fatal: remote error: upload-pack: not our ref abc"))).toBe("not_found");
    expect(classifyPrivateRead(e("error: object abc: fsck error in tree"))).toBe("object_check_failed");
    expect(classifyPrivateRead(e("fatal: something new"))).toBe("other");
    expect(classifyPrivateRead(new Error("spawn git ENOENT"))).toBe("other");
    expect(phaseLine({ phase: "refused", code: "private_read_failed", failure_class: "auth_denied" })).toContain('"failure_class":"auth_denied"');
    expect(() => phaseLine({ phase: "refused", code: "private_read_failed", failure_class: "https://h/o/r" } as never)).toThrow();
    expect(() => phaseLine({ phase: "refused", code: "bad_input", failure_class: "other" })).toThrow();
  });
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

describe("a fix round updates the open public branch (FIXROUND-REPUBLISH R2-c2)", () => {
  /** The first publication: the item's work, one commit on the public tip, on the platform's branch. Returns the head the platform left there (the stamp). */
  async function published(): Promise<string> {
    const head = runWith({ "src/c.ts": "export const c = 3;\n", "src/a.ts": "export const a = 10;\n" });
    const { lines } = await runHook(inputFor(head));
    expect(lines.at(-1)).toMatchObject({ phase: "pr_opened" });
    return sh(world.pubBare, "rev-parse", BRANCH);
  }
  /**
   * Main moves on both sides (a public file in both, an overlay file in the private one only), the cloud merges the private main into the item's branch and the round adds a fix.
   * Returns the cloud's base (the private main tip it merged), the new public tip and the round's head.
   */
  function fixRound(): { base2: string; tip2: string; head2: string } {
    sh(world.priv, "checkout", "-q", "-B", "main2", world.base);
    put(world.priv, { "src/b.ts": "export const b = 22;\n", "docs/ops/plan.md": "private plan, changed on main\n" });
    const base2 = commitAll(world.priv, "main moved (private)");
    const pubWork = path.join(world.root, "pubwork");
    put(pubWork, { "src/b.ts": "export const b = 22;\n" });
    const tip2 = commitAll(pubWork, "main moved (public)");
    sh(pubWork, "push", "-q", world.pubBare, "main");
    sh(world.priv, "checkout", "-q", "fx/run");
    sh(world.priv, "merge", "-q", "--no-edit", base2);
    put(world.priv, { "src/d.ts": "export const d = 5;\n" });
    const head2 = commitAll(world.priv, "fix round");
    sh(world.priv, "push", "-q", "-f", world.privBare, "fx/run", "main2:main");
    return { base2, tip2, head2 };
  }
  const personCommit = (): string => {
    const pubWork = path.join(world.root, "pubwork");
    put(pubWork, { "src/person.ts": "export const p = 1;\n" });
    const c = commitAll(pubWork, "a person's commit");
    sh(pubWork, "push", "-q", "-f", world.pubBare, `${c}:refs/heads/${BRANCH}`);
    return c;
  };

  it("replaces the branch with ONE commit whose only parent is the new public tip: no private commit goes along, the diff is the item's paths, and the private overlay change that came with the sync is not in it", async () => {
    const stamp = await published();
    const { base2, tip2, head2 } = fixRound();
    const { lines } = await runHook(inputFor(head2, { privateBase: base2, updateOf: stamp }));
    const commit = sh(world.pubBare, "rev-parse", BRANCH);
    expect(commit).not.toBe(stamp);
    expect(lines.map((l) => l.phase)).toEqual(["building", "scanning", "updated"]);
    expect(lines.at(-1)).toEqual({ phase: "updated", branch: BRANCH, head_sha: commit, tip_sha: tip2 });
    expect(sh(world.pubBare, "rev-list", "--parents", "-n1", BRANCH)).toBe(`${commit} ${tip2}`);
    expect(sh(world.pubBare, "rev-list", "--count", `${tip2}..${BRANCH}`)).toBe("1");
    for (const privateCommit of [head2, base2, sh(world.priv, "rev-parse", `${head2}^`)]) expect(() => sh(world.pubBare, "cat-file", "-e", privateCommit)).toThrow();
    expect(sh(world.pubBare, "diff", "--name-only", tip2, commit).split("\n").sort()).toEqual(["src/a.ts", "src/c.ts", "src/d.ts"]);
    expect(() => sh(world.pubBare, "cat-file", "-e", `${commit}:docs/ops/plan.md`)).toThrow();
    // No second pull request, and every request still passed the rule set with one mint, one use and one revoke.
    expect(world.proxy.pulls).toHaveLength(1);
    expect(world.proxy.log.every((e) => e.decision === "allowed" && e.steps.join() === "mint,use,revoke")).toBe(true);
  }, 60_000);

  it("is a compare-and-swap: a branch that moved before the update is refused public_branch_moved with no push, and keeps the person's commit", async () => {
    const stamp = await published();
    const { base2, head2 } = fixRound();
    const person = personCommit();
    const pushes = world.proxy.log.filter((e) => e.method === "POST" && e.path.endsWith("git-receive-pack")).length;
    const { lines } = await runHook(inputFor(head2, { privateBase: base2, updateOf: stamp }));
    expect(terminalLine(lines)).toMatchObject({ phase: "refused", code: "public_branch_moved" });
    expect(sh(world.pubBare, "rev-parse", BRANCH)).toBe(person);
    expect(world.proxy.log.filter((e) => e.method === "POST" && e.path.endsWith("git-receive-pack"))).toHaveLength(pushes);
  }, 60_000);

  it("a commit a person pushes between the hook's own read of the branch and its push is kept, and the update is refused public_branch_moved", async () => {
    const stamp = await published();
    const { base2, head2 } = fixRound();
    let person = "";
    // The race: right after the hook reads the branch through the API, a person's commit lands.
    const racing: typeof fetch = async (url, init) => {
      const res = await fetch(url, init);
      if (String(url).includes("/git/ref/heads/") && person === "") person = personCommit();
      return res;
    };
    const raw: string[] = [];
    await runPlanePublish(inputFor(head2, { privateBase: base2, updateOf: stamp }), { gitOrigin: world.proxy.origin, apiOrigin: world.proxy.origin, say: (l) => raw.push(l), tmpRoot: world.tmp, fetchFn: racing });
    expect(terminalLine(parsePhaseLines(raw.join("\n")))).toMatchObject({ phase: "refused", code: "public_branch_moved" });
    expect(person).not.toBe("");
    expect(sh(world.pubBare, "rev-parse", BRANCH)).toBe(person);
  }, 60_000);

  it("the proxy's rule set allows the lease-checked update of the recorded branch: both pushes (the first publish and the update) passed it, and nothing was denied", async () => {
    const stamp = await published();
    const { base2, head2 } = fixRound();
    await runHook(inputFor(head2, { privateBase: base2, updateOf: stamp }));
    expect(world.proxy.log.filter((e) => e.method === "POST" && e.path.endsWith("git-receive-pack")).map((e) => e.decision)).toEqual(["allowed", "allowed"]);
    expect(world.proxy.log.some((e) => e.decision === "denied")).toBe(false);
  }, 60_000);

  it("a republish whose fix-round base predates a rule update is scanned by the rules at the trusted private default tip, not the ones at the base", async () => {
    const stamp = await published();
    // The private default branch gains a new forbidden pattern after the item's base; the item's branch (and its base) never saw it.
    sh(world.priv, "checkout", "-q", "-B", "main2", world.base);
    put(world.priv, { "rules/ids.txt": IDS.replace("acme-internal-host\n", "acme-internal-host\nacme-new-secret\n") });
    const tipWithRule = commitAll(world.priv, "rules updated on private main");
    sh(world.priv, "checkout", "-q", "fx/run");
    put(world.priv, { "src/d.ts": "export const d = 'acme-new-secret';\n" });
    const head2 = commitAll(world.priv, "fix round");
    sh(world.priv, "push", "-q", "-f", world.privBare, "fx/run", "main2:main");
    const before = branches();
    // Control: the rules as of the base do not know the pattern, so the same change would have been published.
    const { lines } = await runHook(inputFor(head2, { privateBase: world.base, privateDefaultTip: tipWithRule, updateOf: stamp }));
    expect(terminalLine(lines)).toMatchObject({ phase: "refused", code: "scan_refused" });
    expect(branches()).toBe(before);
    const old = await runHook(inputFor(head2, { privateBase: world.base, privateDefaultTip: world.base, updateOf: stamp }));
    expect(terminalLine(old.lines)).toMatchObject({ phase: "updated" });
  }, 60_000);

  it("the input shape accepts updateOf only as a full commit id, and nothing else extra", () => {
    const base = inputFor("a".repeat(40));
    expect(parsePlanePublishInput(JSON.stringify({ ...base, updateOf: "b".repeat(40) }))).toMatchObject({ updateOf: "b".repeat(40) });
    expect(parsePlanePublishInput(JSON.stringify({ ...base, updateOf: "main" }))).toBeUndefined();
    expect(parsePlanePublishInput(JSON.stringify(base))).toMatchObject({ branch: BRANCH });
    expect(parsePlanePublishInput(JSON.stringify({ ...base, extra: 1 }))).toBeUndefined();
  });
});
