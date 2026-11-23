import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as scanModule from "../../../runner-protocol/src/planePush/planePush.js";
import { PlaneRouteError, type RepoPairing, routeAndPush, type PlaneRouteDeps, type PlaneRouteInput, type PublicApi } from "../../../runner-protocol/src/planePush/planePushRoute.js";
import { createGitTransport, type PublicGitTransport } from "../../../runner-protocol/src/planePush/planePushTransport.js";
import { startGitHttpServer, type GitHttpServer } from "./helpers/gitHttpServer.js";

vi.mock("../../../runner-protocol/src/planePush/planePush.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../runner-protocol/src/planePush/planePush.js")>();
  return { ...actual, scanPlanePush: vi.fn(actual.scanPlanePush) };
});

/**
 * D#845 ON-27c1, on real git: the export mode of `routeAndPush` (the private twin publishes a filtered export). Same harness as the paired-repo
 * route test: a private repo, a public bare repo behind smart HTTP that checks the push token, and a fake of the public GitHub API. The default
 * ("refuse") mode is exercised here too, on the same inputs, to show it is unchanged. Fixture values are invented.
 */

const IDS = "=== FORBIDDEN_PATTERNS_START ===\nacme-internal-host\n=== FORBIDDEN_PATTERNS_END ===\n";
const PLAN = JSON.stringify({ priceUsdPerMonth: 7391 });
const PUBLIC_FILES: Record<string, string> = { "README.md": "# widgets\n", "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n", "assets/keep.txt": "keep\n" };
const OVERLAY_FILES: Record<string, string> = {
  "docs/ops/plan.md": "private plan\n",
  "rules/ids.txt": IDS,
  "rules/plan.json": PLAN,
  "secrets/prod.env": "A=1\n",
  "install.json": "{}\n",
  "docs/ops/notes/long.md": Array.from({ length: 12 }, (_, n) => `private line number ${n}\n`).join(""),
  "docs/ops/notes/old.md": "a distinctive private note that is long enough to be its own blob\n",
};
const TOKEN = "ghs_" + "planepushtoken1"; // gitleaks:allow
const SECRET_LINE = `const k = "sk-ant-api03-` + `a1B2c3D4e5F6g7";`; // gitleaks:allow

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
let privateBase: string;

const pairing: RepoPairing = {
  enabled: true,
  codeRepo: "acme/widgets",
  overlayGlobs: ["docs/ops/", "rules/", "secrets/*.env", "install.json"],
  identifierRulesPath: "rules/ids.txt",
  planDataRulesPath: "rules/plan.json",
};
const own = { owner: "acme", name: "widgets-twin" };
const branches = (): string => sh(bare, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
const pushes = (): number => server.seen.filter((s) => s.path.includes("git-receive-pack")).length;
const PRIVATE_PATH = /^(docs\/ops\/|rules\/|secrets\/[^/]*\.env$|install\.json$)/;

function fakeApi(): PublicApi & { minted: number; opened: unknown[] } {
  const api = {
    minted: 0,
    opened: [] as unknown[],
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
    async openPullRequest(i: unknown) {
      api.opened.push(i);
      return { number: 9, url: "https://github.com/acme/widgets/pull/9" };
    },
  };
  return api;
}

const head = (): string => sh(priv, "rev-parse", "HEAD");
const input = (over: Partial<PlaneRouteInput> = {}): PlaneRouteInput => ({
  repoDir: priv, privateBase, privateHead: head(), privateDefaultTip: head(), own, defaultBranch: "trunk", branch: "publish-1", title: "Publish merged changes", body: "Files: 1",
  identity: { name: "Fulcrumaxe Bot", email: "bot@example.test" }, commitTime: 1_700_000_000, mode: "export", ...over,
});
let transport: PublicGitTransport;
const deps = (over: Partial<PlaneRouteDeps> = {}): PlaneRouteDeps => ({ loadPairing: async () => pairing, loadOwn: async () => own, api: fakeApi(), transport, ...over });
const refusal = async (p: Promise<unknown>): Promise<PlaneRouteError> => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(PlaneRouteError);
  return e as PlaneRouteError;
};
const publicTree = (commit: string): string[] => sh(bare, "ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "plane-export-"));
  mkdirSync(join(root, "acme/widgets.git"), { recursive: true });
  sh(join(root, "acme/widgets.git"), "init", "-q", "--bare", "-b", "main");
  bare = join(root, "acme/widgets.git");
  pubWork = mkdtempSync(join(tmpdir(), "plane-export-pub-"));
  sh(pubWork, "init", "-q", "-b", "main");
  put(pubWork, PUBLIC_FILES);
  commitAll(pubWork, "initial public");
  sh(pubWork, "push", "-q", bare, "main");
  priv = mkdtempSync(join(tmpdir(), "plane-export-priv-"));
  sh(priv, "init", "-q", "-b", "trunk");
  put(priv, { ...PUBLIC_FILES, ...OVERLAY_FILES });
  privateBase = commitAll(priv, "twin base");
  server = await startGitHttpServer(root, new Map([[TOKEN, ["acme/widgets"]]]));
  transport = createGitTransport({ origin: server.origin });
});

afterEach(async () => {
  await server.close();
  for (const d of [root, pubWork, priv]) rmSync(d, { recursive: true, force: true });
  vi.mocked(scanModule.scanPlanePush).mockClear();
});

/** Runs the route expecting a refusal, and checks that nothing reached the public repo or the API. */
async function refusedWith(over: Partial<PlaneRouteInput> = {}, d: Partial<PlaneRouteDeps> = {}): Promise<PlaneRouteError> {
  const before = branches();
  const api = fakeApi();
  const e = await refusal(routeAndPush(input(over), deps({ api, ...d })));
  expect(branches()).toBe(before);
  expect(pushes()).toBe(0);
  // A refusal at scan time mints no token; the push-time pairing check runs after the mint, so only `pairing_changed` may have one.
  if (e.code !== "pairing_changed") expect(api.minted).toBe(0);
  expect(api.opened).toEqual([]);
  return e;
}

describe("export mode drops private paths instead of refusing them", () => {
  it("publishes the public change and none of the private ones, over every kind of private path", async () => {
    put(priv, {
      "src/a.ts": "export const a = 1;\nexport const a2 = 3;\n",
      "docs/ops/plan.md": "private plan, edited\n", // a fixed root
      "docs/ops/deep/new.md": "new private file\n",
      "secrets/prod.env": "A=2\n", // a glob
      "secrets/other.env": "B=1\n",
      "install.json": '{"x":1}\n', // an exact path
    });
    commitAll(priv, "twin work");
    const api = fakeApi();
    const r = await routeAndPush(input(), deps({ api }));
    if (r.plane !== "paired") throw new Error("expected a publish");
    expect(sh(bare, "diff", "--name-only", sh(bare, "rev-parse", "main"), r.commit)).toBe("src/a.ts");
    expect(publicTree(r.commit).filter((p) => PRIVATE_PATH.test(p))).toEqual([]);
    expect(sh(bare, "show", "--format=", "--name-only", r.commit)).toBe("src/a.ts");
    expect(api.opened).toHaveLength(1);
  });

  it("refuses with no_changes, and pushes nothing, when every change is private", async () => {
    put(priv, { "docs/ops/plan.md": "x\n", "install.json": "{}\n\n" });
    commitAll(priv, "only private");
    expect((await refusedWith()).code).toBe("no_changes");
  });

  it("the same private-path change is still refused in the default mode, and by name", async () => {
    put(priv, { "src/c.ts": "export const c = 1;\n", "docs/ops/new.md": "more private text\n" });
    commitAll(priv, "work");
    for (const mode of [undefined, "refuse" as const]) {
      const e = await refusedWith({ mode });
      expect(e.code).toBe("private_path_change");
      expect(e.message).toContain("docs/ops/new.md");
    }
  });

  it("a rename from a private path to a public one publishes the new path, only after the scan", async () => {
    sh(priv, "mv", "docs/ops/notes/old.md", "src/notes.md");
    commitAll(priv, "move out of private");
    const r = await routeAndPush(input(), deps());
    if (r.plane !== "paired") throw new Error("expected a publish");
    expect(sh(bare, "show", `${r.commit}:src/notes.md`)).toContain("distinctive private note");
    expect(publicTree(r.commit).filter((p) => PRIVATE_PATH.test(p))).toEqual([]);
    // The scan ran on that commit and covered the new path.
    const scanCalls = vi.mocked(scanModule.scanPlanePush).mock.calls;
    expect(scanCalls).toHaveLength(1);
  });

  it("a rename out of a private path whose content hits a rule is refused by place and rule, not published", async () => {
    sh(priv, "mv", "docs/ops/notes/old.md", "src/notes.md");
    writeFileSync(join(priv, "src/notes.md"), "a distinctive private note\nsee acme-internal-host\n");
    commitAll(priv, "move out with a leak");
    const e = await refusedWith();
    expect(e.code).toBe("scan_refused");
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "identifier_hit", path: "src/notes.md", rule: "identifier-rule#1" })]);
    expect(JSON.stringify([e.message, e.refusals])).not.toContain("acme-internal-host");
  });

  it("a rename from a public path into a private path removes the public file and publishes nothing private", async () => {
    sh(priv, "mv", "src/b.ts", "docs/ops/b.ts");
    commitAll(priv, "move into private");
    const r = await routeAndPush(input(), deps());
    if (r.plane !== "paired") throw new Error("expected a publish");
    expect(publicTree(r.commit)).not.toContain("src/b.ts");
    expect(publicTree(r.commit).filter((p) => PRIVATE_PATH.test(p))).toEqual([]);
  });

  it("a copy of a file that stays private, under a public name, is still refused", async () => {
    put(priv, { "src/copy.md": "a distinctive private note that is long enough to be its own blob\n" });
    commitAll(priv, "copy a private file");
    const e = await refusedWith();
    expect(e.code).toBe("private_path_change");
    expect(e.refusals.length).toBeGreaterThan(0);
    expect(e.refusals.every((r) => r.kind === "overlay_path" && r.path === "src/copy.md")).toBe(true);
  });

  it("an edited copy of a file that stays private is still refused (git's copy detection)", async () => {
    put(priv, { "src/long.md": `${OVERLAY_FILES["docs/ops/notes/long.md"]}one more line\n` });
    commitAll(priv, "copy with an edit");
    const e = await refusedWith();
    expect(e.code).toBe("private_path_change");
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "overlay_path", path: "src/long.md" })]);
  });

  it("a symlink into a private path is still refused", async () => {
    mkdirSync(join(priv, "src"), { recursive: true });
    sh(priv, "update-index", "--add", "--cacheinfo", `120000,${execFileSync("git", ["-C", priv, "hash-object", "-w", "--stdin"], { input: "../docs/ops/plan.md", encoding: "utf8", env: cleanEnv() }).trim()},src/link`);
    sh(priv, "commit", "-q", "-m", "link");
    expect((await refusedWith()).code).toBe("private_path_change");
  });

  it("still refuses a public path the public repo moved since the base", async () => {
    put(pubWork, { "src/a.ts": "export const a = 99;\n" });
    commitAll(pubWork, "public edits a");
    sh(pubWork, "push", "-q", bare, "main");
    put(priv, { "src/a.ts": "export const a = 1;\nexport const mine = 2;\n", "docs/ops/plan.md": "edited\n" });
    commitAll(priv, "work");
    expect((await refusedWith()).code).toBe("base_diverged");
  });
});

describe("rule files in export mode", () => {
  it("allows a declared rule file to change between base and head, and applies the head's rules", async () => {
    put(priv, { "src/a.ts": "export const a = 1;\nconst x = 'newly-forbidden';\n", "rules/ids.txt": `${IDS}=== FORBIDDEN_PATTERNS_START ===\nnewly-forbidden\n=== FORBIDDEN_PATTERNS_END ===\n` });
    commitAll(priv, "rules and code");
    // The default-tip field still names the base: the export reads the rules at the head, so the newly added pattern applies.
    const e = await refusedWith({ privateDefaultTip: privateBase });
    expect(e.code).toBe("scan_refused");
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "identifier_hit", path: "src/a.ts", line: 2 })]);
  });

  it("a rule-file change publishes when the code is clean, but is refused in the default mode", async () => {
    put(priv, { "src/a.ts": "export const a = 5;\n", "rules/ids.txt": `${IDS}# comment\n` });
    commitAll(priv, "rules and code");
    const before = branches();
    const refuse = await refusal(routeAndPush(input({ mode: "refuse", privateDefaultTip: privateBase }), deps()));
    expect(refuse.code).toBe("scan_refused");
    expect(refuse.refusals).toEqual([expect.objectContaining({ kind: "rule_file_changed", path: "rules/ids.txt" })]);
    expect(branches()).toBe(before);
    const r = await routeAndPush(input(), deps());
    expect(r.plane).toBe("paired");
  });
});

describe("binary files in export mode", () => {
  const BIN = Buffer.from([1, 2, 0, 3, 4]);

  it("refuses a binary file with no allow list, and one outside it", async () => {
    put(priv, { "assets/logo.png": BIN });
    commitAll(priv, "add a binary");
    for (const binaryGlobs of [undefined, [], ["other/**"]]) {
      const e = await refusedWith({}, { loadPairing: async () => ({ ...pairing, ...(binaryGlobs ? { binaryGlobs } : {}) }) });
      expect(e.code).toBe("scan_refused");
      expect(e.refusals).toEqual([expect.objectContaining({ kind: "binary_file", path: "assets/logo.png" })]);
    }
  });

  it("publishes a binary file under an allowed glob", async () => {
    put(priv, { "assets/logo.png": BIN, "src/a.ts": "export const a = 7;\n" });
    commitAll(priv, "add a binary");
    const r = await routeAndPush(input(), deps({ loadPairing: async () => ({ ...pairing, binaryGlobs: ["assets/**"] }) }));
    if (r.plane !== "paired") throw new Error("expected a publish");
    expect(sh(bare, "diff", "--name-only", sh(bare, "rev-parse", "main"), r.commit).split("\n").sort()).toEqual(["assets/logo.png", "src/a.ts"]);
  });

  it("an allowed binary is still bounded by size", async () => {
    put(priv, { "assets/big.bin": Buffer.alloc(8_000_001, 7) });
    commitAll(priv, "big");
    const big = await refusedWith({}, { loadPairing: async () => ({ ...pairing, binaryGlobs: ["assets/**"] }) });
    expect(big.refusals).toEqual([expect.objectContaining({ kind: "file_too_large", path: "assets/big.bin" })]);
  });

  it("a text file under an allowed glob is still scanned", async () => {
    put(priv, { "assets/note.txt": "see acme-internal-host\n" });
    commitAll(priv, "text under the glob");
    const e = await refusedWith({}, { loadPairing: async () => ({ ...pairing, binaryGlobs: ["assets/**"] }) });
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "identifier_hit", path: "assets/note.txt", line: 1 })]);
  });

  it("an unusable allow list refuses and pushes nothing", async () => {
    put(priv, { "assets/logo.png": BIN });
    commitAll(priv, "add a binary");
    const e = await refusedWith({}, { loadPairing: async () => ({ ...pairing, binaryGlobs: ["assets/[a-z]*"] }) });
    expect(e.code).toBe("scan_refused");
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "overlay_list_invalid" })]);
  });

  it("the default mode ignores binaryGlobs and refuses the binary", async () => {
    put(priv, { "assets/logo.png": BIN });
    commitAll(priv, "add a binary");
    const e = await refusedWith({ mode: "refuse", privateDefaultTip: privateBase }, { loadPairing: async () => ({ ...pairing, binaryGlobs: ["assets/**"] }) });
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "binary_file" })]);
  });
});

describe("moves out of private paths, binaries decided by content (review fixes)", () => {
  const withGlobs = { loadPairing: async () => ({ ...pairing, binaryGlobs: ["assets/**"] }) };
  const NUL_LEAK = Buffer.concat([Buffer.from([1, 2, 0, 3]), Buffer.from("see acme-internal-host here\n"), Buffer.from([0, 9])]);

  it("a private binary moved to an allowed binary path is refused, and not published unscanned", async () => {
    put(priv, { "docs/ops/key.der": NUL_LEAK });
    const base = commitAll(priv, "private binary");
    sh(priv, "mv", "docs/ops/key.der", "assets/logo.png");
    commitAll(priv, "move it out");
    const e = await refusedWith({ privateBase: base }, withGlobs);
    expect(e.code).toBe("private_path_change");
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "overlay_path", path: "assets/logo.png" })]);
  });

  it("a private binary moved to any other public path is refused too", async () => {
    put(priv, { "docs/ops/key.der": Buffer.from([1, 2, 0, 3, 4]) });
    const base = commitAll(priv, "private binary");
    sh(priv, "mv", "docs/ops/key.der", "src/key.bin");
    commitAll(priv, "move it out");
    expect((await refusedWith({ privateBase: base }, withGlobs)).code).toBe("private_path_change");
  });

  it("a private text file moved under the binary allow list is refused, but published when moved elsewhere", async () => {
    sh(priv, "mv", "docs/ops/notes/old.md", "assets/old.md");
    commitAll(priv, "move into the binary glob");
    expect((await refusedWith({}, withGlobs)).code).toBe("private_path_change");
    const r = await routeAndPush(input({ branch: "other" }), deps({ loadPairing: async () => ({ ...pairing, binaryGlobs: ["elsewhere/**"] }) }));
    expect(r.plane).toBe("paired");
  });

  it("a .gitattributes line marking text as binary does not make it unscanned", async () => {
    put(priv, { ".gitattributes": "assets/** binary\n", "assets/note.txt": `see acme-internal-host\n${SECRET_LINE}\nplain line\n` });
    commitAll(priv, "attribute trick");
    const e = await refusedWith({}, withGlobs);
    expect(e.code).toBe("scan_refused");
    expect(e.refusals.map((r) => `${r.kind}:${r.path}:${r.line}`).sort()).toEqual(["identifier_hit:assets/note.txt:1", "secret_shaped:assets/note.txt:2"]);
  });

  it("a clean text file under such an attribute publishes (every line is scanned, none refuses)", async () => {
    put(priv, { ".gitattributes": "assets/** binary\n", "assets/note.txt": "plain line\n" });
    commitAll(priv, "attribute with clean text");
    const r = await routeAndPush(input(), deps(withGlobs));
    expect(r.plane).toBe("paired");
  });

  it("a text file with a NUL only after the first 8 KB under an allowed glob is scanned as text", async () => {
    put(priv, { "assets/late.bin": Buffer.concat([Buffer.from(`${"x".repeat(9000)}\0\nsee acme-internal-host\n`)]) });
    commitAll(priv, "late NUL");
    const e = await refusedWith({}, withGlobs);
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "identifier_hit", path: "assets/late.bin", line: 2 })]);
  });

  it("an allowed binary's printable runs are scanned: one NUL byte does not let an identifier or a secret through", async () => {
    put(priv, { "assets/a.bin": NUL_LEAK, "assets/b.bin": Buffer.concat([Buffer.from([0]), Buffer.from(`${SECRET_LINE}\n`), Buffer.from([0])]) });
    commitAll(priv, "binaries with text");
    const e = await refusedWith({}, withGlobs);
    expect(e.code).toBe("scan_refused");
    expect(e.refusals.map((r) => `${r.kind}:${r.path}`).sort()).toEqual(["identifier_hit:assets/a.bin", "secret_shaped:assets/b.bin"]);
    expect(JSON.stringify([e.message, e.refusals])).not.toContain("a1B2c3D4e5F6g7");
  });

  it("an allowed binary with no printable run of 8 bytes or more (or none that match) still publishes", async () => {
    put(priv, { "assets/ok.bin": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("acme-int"), Buffer.from([0]), Buffer.from("ernal-host"), Buffer.from([0, 3])]) });
    commitAll(priv, "harmless binary");
    const r = await routeAndPush(input(), deps(withGlobs));
    expect(r.plane).toBe("paired");
  });

  // Wide text has NULs everywhere, so it counts as binary and has no plain 8-byte run. The secret starts the file and the identifier ends it with no
  // newline, so a run found one byte out of step (the wrong regex matching a shifted view) loses its first or its last character and no longer matches:
  // each regex is needed for its own encoding.
  const WIDE_LINES = "sk-ant-api03-" + "a1B2c3D4e5F6g7\nacme-internal-host";
  const wide = (enc: "u16le" | "u16be" | "u32le" | "u32be", text: string, bom = false): Buffer => {
    const out: number[] = bom ? [0xff, 0xfe] : [];
    for (const ch of text) {
      const c = ch.charCodeAt(0);
      out.push(...(enc === "u16le" ? [c, 0] : enc === "u16be" ? [0, c] : enc === "u32le" ? [c, 0, 0, 0] : [0, 0, 0, c]));
    }
    return Buffer.from(out);
  };
  const wideCases: Array<[string, Buffer]> = [
    ["UTF-16LE with a BOM", wide("u16le", WIDE_LINES, true)],
    ["UTF-16LE without a BOM", wide("u16le", WIDE_LINES)],
    ["UTF-16BE", wide("u16be", WIDE_LINES)],
    ["UTF-32LE", wide("u32le", WIDE_LINES)],
    ["UTF-32BE", wide("u32be", WIDE_LINES)],
  ];
  for (const [name, bytes] of wideCases) {
    it(`${name} text under an allowed binary glob is scanned: an identifier and a secret are refused`, async () => {
      put(priv, { "assets/wide.bin": bytes });
      commitAll(priv, "wide text");
      const e = await refusedWith({}, withGlobs);
      expect(e.code).toBe("scan_refused");
      expect(e.refusals.map((r) => `${r.kind}:${r.path}`).sort()).toEqual(["identifier_hit:assets/wide.bin", "secret_shaped:assets/wide.bin"]);
      expect(JSON.stringify([e.message, e.refusals])).not.toContain("a1B2c3D4e5F6g7");
    });
  }

  it("clean wide text (and a wide run split by a NUL pair under 8 characters) under an allowed binary glob publishes", async () => {
    put(priv, { "assets/clean16.bin": wide("u16le", "just an ordinary label\n", true), "assets/clean32.bin": wide("u32be", "another plain label\n"), "assets/split.bin": wide("u16be", "acme-in\u0001ternal-host") });
    commitAll(priv, "clean wide text");
    const r = await routeAndPush(input(), deps(withGlobs));
    expect(r.plane).toBe("paired");
  });

  it("a copy or rename between two private paths is dropped like any private change, and a clean public change still publishes", async () => {
    put(priv, {
      "docs/ops/notes/long2.md": `${OVERLAY_FILES["docs/ops/notes/long.md"]}one more private line\n`, // a similar copy
      "docs/ops/notes/old2.md": OVERLAY_FILES["docs/ops/notes/old.md"] as string, // an exact copy
      "src/a.ts": "export const a = 1;\nexport const a2 = 3;\n",
    });
    sh(priv, "mv", "docs/ops/plan.md", "docs/ops/plan-renamed.md");
    commitAll(priv, "private to private");
    const r = await routeAndPush(input(), deps());
    if (r.plane !== "paired") throw new Error("expected a publish");
    expect(sh(bare, "diff", "--name-only", sh(bare, "rev-parse", "main"), r.commit)).toBe("src/a.ts");
  });

  it("the same private-to-private copy is still refused in the default mode", async () => {
    put(priv, { "docs/ops/notes/old2.md": OVERLAY_FILES["docs/ops/notes/old.md"] as string, "src/c.ts": "export const c = 1;\n" });
    commitAll(priv, "private copy");
    const e = await refusedWith({ mode: "refuse", privateDefaultTip: privateBase });
    expect(e.code).toBe("private_path_change");
  });
});

describe("secret_shaped in export mode", () => {
  it("refuses an added line the credential redactor would change, by place and rule key only", async () => {
    put(priv, { "src/a.ts": `export const a = 1;\n${SECRET_LINE}\n` });
    commitAll(priv, "add a secret");
    const e = await refusedWith();
    expect(e.code).toBe("scan_refused");
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "secret_shaped", path: "src/a.ts", line: 2, rule: "secret_shaped" })]);
    expect(JSON.stringify([e.message, e.refusals, e.stack])).not.toContain("a1B2c3D4e5F6g7");
  });

  it("covers credential-named values and url userinfo, and leaves an ordinary line alone", async () => {
    put(priv, { "src/a.ts": "export const a = 1;\nconst note = 'tokens are counted';\n", "src/env.sh": "API_KEY=abc123xyz\n", "src/u.ts": "const u = 'postgres://user:hunter2@db.example.test/x';\n" });
    commitAll(priv, "work");
    const e = await refusedWith();
    expect(e.refusals.map((r) => `${r.path}:${r.line}`).sort()).toEqual(["src/env.sh:1", "src/u.ts:1"]);
    expect(e.refusals.every((r) => r.kind === "secret_shaped")).toBe(true);
  });

  it("looks only at ADDED lines: an existing secret-shaped line that stays does not refuse", async () => {
    put(pubWork, { "src/old.ts": `${SECRET_LINE}\n` });
    commitAll(pubWork, "public already has it");
    sh(pubWork, "push", "-q", bare, "main");
    put(priv, { "src/old.ts": `${SECRET_LINE}\n` });
    sh(priv, "add", "-A");
    sh(priv, "commit", "-q", "-m", "base has it");
    const base = head();
    put(priv, { "src/old.ts": `${SECRET_LINE}\nconst fine = 1;\n` });
    commitAll(priv, "append a clean line");
    const r = await routeAndPush(input({ privateBase: base }), deps());
    expect(r.plane).toBe("paired");
  });

  it("is not part of the default mode: the same content is not refused there", async () => {
    put(priv, { "src/a.ts": `export const a = 1;\n${SECRET_LINE}\n` });
    commitAll(priv, "add a secret");
    const r = await routeAndPush(input({ mode: "refuse", privateDefaultTip: privateBase }), deps());
    expect(r.plane).toBe("paired");
  });
});

describe("fail closed in export mode", () => {
  beforeEach(() => {
    put(priv, { "src/a.ts": "export const a = 2;\n" });
    commitAll(priv, "work");
  });

  it("an unreadable (missing) rule file at the head refuses", async () => {
    sh(priv, "rm", "-q", "rules/ids.txt");
    sh(priv, "commit", "-q", "-m", "drop the rules");
    const e = await refusedWith();
    expect(e.code).toBe("scan_refused");
    expect(e.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "rule_file_missing", path: "rules/ids.txt" })]));
  });

  it("a rule file that does not parse refuses", async () => {
    put(priv, { "rules/plan.json": "{ not json" });
    commitAll(priv, "break the plan data");
    const e = await refusedWith();
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "rule_file_invalid", path: "rules/plan.json" })]);
  });

  it("a scan reader that throws refuses", async () => {
    const real = scanModule.scanPlanePush;
    vi.mocked(scanModule.scanPlanePush).mockImplementationOnce((i) => real({ ...i, source: { ...i.source, changes: async () => Promise.reject(new Error("reader broke")) } }));
    const e = await refusedWith();
    expect(e.code).toBe("scan_refused");
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "scan_failed" })]);
  });

  it("an overlay list that does not compile refuses", async () => {
    const e = await refusedWith({}, { loadPairing: async () => ({ ...pairing, overlayGlobs: ["docs/[ab]"] }) });
    expect(e.code).toBe("scan_refused");
    expect(e.refusals).toEqual([expect.objectContaining({ kind: "overlay_list_invalid" })]);
  });

  it("a pairing that changed between issue and push refuses at push time, including the binary allow list", async () => {
    for (const next of [{ ...pairing, binaryGlobs: ["assets/**"] }, { ...pairing, overlayGlobs: [...pairing.overlayGlobs, "extra/"] }]) {
      let reads = 0;
      const e = await refusedWith({}, { loadPairing: async () => (reads++ === 0 ? pairing : next) });
      expect(e.code).toBe("pairing_changed");
    }
  });

  it("a rule file that is not under a private path refuses", async () => {
    const e = await refusedWith({}, { loadPairing: async () => ({ ...pairing, identifierRulesPath: "src/ids.txt" }) });
    expect(e.code).toBe("rule_files_not_private");
  });

  it("an unknown mode is a bad input", async () => {
    const e = await refusal(routeAndPush(input({ mode: "export-all" as unknown as "export" }), deps()));
    expect(e.code).toBe("bad_input");
    expect(pushes()).toBe(0);
  });

  it("an explicit refuse mode and no mode behave the same on a clean change", async () => {
    const a = await routeAndPush(input({ mode: "refuse", privateDefaultTip: privateBase, branch: "b-1" }), deps());
    const b = await routeAndPush(input({ mode: undefined, privateDefaultTip: privateBase, branch: "b-2" }), deps());
    if (a.plane !== "paired" || b.plane !== "paired") throw new Error("expected publishes");
    expect(sh(bare, "rev-parse", `${a.commit}^{tree}`)).toBe(sh(bare, "rev-parse", `${b.commit}^{tree}`));
  });
});
