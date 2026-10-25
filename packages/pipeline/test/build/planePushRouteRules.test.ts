import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as scanModule from "../../../runner-protocol/src/planePush/planePush.js";
import * as routeModule from "../../../runner-protocol/src/planePush/planePushRoute.js";
import { PlaneRouteError, type RepoPairing, type PlaneRouteDeps, type PlaneRouteInput, type PublicApi } from "../../../runner-protocol/src/planePush/planePushRoute.js";
import { createGitTransport, type PublicGitTransport } from "../../../runner-protocol/src/planePush/planePushTransport.js";
import { startGitHttpServer, type GitHttpServer } from "./helpers/gitHttpServer.js";

vi.mock("../../../runner-protocol/src/planePush/planePush.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../runner-protocol/src/planePush/planePush.js")>();
  return { ...actual, scanPlanePush: vi.fn(actual.scanPlanePush) };
});

/**
 * Where the push route takes its rules from, on real git (a private repo, a public bare repo behind `git http-backend`, a fake of the
 * public repo's API). The rule files are read at the private base the platform recorded, an item that touches a declared rule file is
 * refused before anything is built, and a pairing whose rule files are not private paths is refused. The last block runs the same
 * scenarios against copies of the route with one of those checks taken out, to show each one is what the tests above depend on.
 * Fixture values are invented.
 */

const IDS = "=== FORBIDDEN_PATTERNS_START ===\nacme-internal-host\n=== FORBIDDEN_PATTERNS_END ===\n";
const EDITED_IDS = "=== FORBIDDEN_PATTERNS_START ===\n^zz[0-9]{50}$\n=== FORBIDDEN_PATTERNS_END ===\n";
const PLAN = JSON.stringify({ priceUsdPerMonth: 7391 });
const EDITED_PLAN = JSON.stringify({ priceUsdPerMonth: 918273645 });
// The rule files are on the public side too: under a pairing that never kept them private (LEGACY below) they were published with the rest.
const PUBLIC_FILES: Record<string, string> = { "README.md": "# widgets\n", "src/a.ts": "export const a = 1;\n", "rules/ids.txt": IDS, "rules/plan.json": PLAN };
const OVERLAY_FILES: Record<string, string> = { "docs/ops/plan.md": "private plan\n" };
const TOKEN = ["ghs", "rulesbasetoken1"].join("_");

const cleanEnv = (): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
const sh = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.name=Item Author", "-c", "user.email=private-author@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: cleanEnv() }).trim();
const put = (dir: string, files: Record<string, string>): void => {
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
let transport: PublicGitTransport;

/** Rule files under a private path: the pairing as it must be. */
const COVERED: RepoPairing = { enabled: true, codeRepo: "acme/widgets", overlayGlobs: ["docs/ops/", "rules/"], identifierRulesPath: "rules/ids.txt", planDataRulesPath: "rules/plan.json" };
/** The same rule files with no private path over them: a pairing stored before the pairing check refused that. */
const LEGACY: RepoPairing = { ...COVERED, overlayGlobs: ["docs/ops/"] };
const own = { owner: "acme", name: "widgets-private" };
const branches = (): string => sh(bare, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
const pushes = (): number => server.seen.filter((s) => s.path.includes("git-receive-pack")).length;

function fakeApi(): PublicApi & { minted: number; opened: number } {
  const api = {
    minted: 0,
    opened: 0,
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
    async openPullRequest() {
      api.opened++;
      return { number: 9, url: "https://github.com/acme/widgets/pull/9" };
    },
  };
  return api;
}

type Route = (input: PlaneRouteInput, deps: PlaneRouteDeps) => Promise<unknown>;

/** One commit on `from` (default: the private default branch's tip), on a branch of its own. Returns its id. */
function commitOn(files: Record<string, string>, remove: string[] = [], from = privateBase): string {
  sh(priv, "checkout", "-q", "-B", `work-${Math.random().toString(36).slice(2)}`, from);
  put(priv, files);
  for (const f of remove) sh(priv, "rm", "-q", "--", f);
  return commitAll(priv, "item work");
}

/**
 * The item's work as one commit, and the input the route gets for it. Its recorded base is the default branch's tip, or, for a stacked item,
 * `from`: its parent's unmerged head. The default tip the platform read is always the default branch's.
 */
function item(files: Record<string, string>, remove: string[] = [], from = privateBase, tip = privateBase): PlaneRouteInput {
  const head = commitOn(files, remove, from);
  return { repoDir: priv, privateBase: from, privateHead: head, privateDefaultTip: tip, own, defaultBranch: "trunk", branch: "item-1", title: "Add the thing", body: "Adds the thing.", identity: { name: "Fulcrumaxe Bot", email: "bot@example.test" }, commitTime: 1_700_000_000 };
}

/** Runs the route; a refusal must have pushed, minted and opened nothing. */
async function attempt(route: Route, input: PlaneRouteInput, pairing: RepoPairing): Promise<{ pushed: true } | { code: string; refusals: readonly scanModule.Refusal[] }> {
  const before = branches();
  const sent = pushes();
  const api = fakeApi();
  try {
    await route(input, { loadPairing: async () => pairing, loadOwn: async () => own, api, transport });
    return { pushed: true };
  } catch (e) {
    if (!(e instanceof Error) || typeof (e as { code?: unknown }).code !== "string") throw e;
    expect(branches()).toBe(before);
    expect(pushes()).toBe(sent);
    expect(api.minted).toBe(0);
    expect(api.opened).toBe(0);
    return { code: (e as PlaneRouteError).code, refusals: (e as PlaneRouteError).refusals };
  }
}
const shape = (r: Awaited<ReturnType<typeof attempt>>): unknown => ("pushed" in r ? "pushed" : { code: r.code, refusals: r.refusals.map((x) => `${x.kind} ${x.path ?? "-"}`) });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "rulesbase-route-"));
  mkdirSync(join(root, "acme/widgets.git"), { recursive: true });
  bare = join(root, "acme/widgets.git");
  sh(bare, "init", "-q", "--bare", "-b", "main");
  pubWork = mkdtempSync(join(tmpdir(), "rulesbase-pub-"));
  sh(pubWork, "init", "-q", "-b", "main");
  put(pubWork, PUBLIC_FILES);
  commitAll(pubWork, "initial public");
  sh(pubWork, "push", "-q", bare, "main");
  priv = mkdtempSync(join(tmpdir(), "rulesbase-priv-"));
  sh(priv, "init", "-q", "-b", "trunk");
  put(priv, { ...PUBLIC_FILES, ...OVERLAY_FILES });
  privateBase = commitAll(priv, "private base");
  server = await startGitHttpServer(root, new Map([[TOKEN, ["acme/widgets"]]]));
  transport = createGitTransport({ origin: server.origin });
});

afterEach(async () => {
  await server.close();
  for (const d of [root, pubWork, priv]) rmSync(d, { recursive: true, force: true });
  vi.mocked(scanModule.scanPlanePush).mockClear();
});

const real: Route = routeModule.routeAndPush;
const FLAGGED = { "src/host.ts": "export const host = 'acme-internal-host';\n" };
const PRICE = { "src/price.ts": "export const price = 7391;\n" };

describe("an item that changes a declared rule file is refused before anything is built or scanned", () => {
  it("an edited identifier-rules file at the item's head, with a change those rules would refuse", async () => {
    const r = await attempt(real, item({ "rules/ids.txt": EDITED_IDS, ...FLAGGED }), COVERED);
    expect(shape(r)).toEqual({ code: "scan_refused", refusals: ["rule_file_changed rules/ids.txt"] });
    expect(scanModule.scanPlanePush).not.toHaveBeenCalled();
  });

  it("an edited plan-data file at the item's head, with a figure those rules would refuse", async () => {
    const r = await attempt(real, item({ "rules/plan.json": EDITED_PLAN, ...PRICE }), COVERED);
    expect(shape(r)).toEqual({ code: "scan_refused", refusals: ["rule_file_changed rules/plan.json"] });
    expect(scanModule.scanPlanePush).not.toHaveBeenCalled();
  });

  it("a declared rule file removed by the item, and one the item adds where the base had none", async () => {
    expect(shape(await attempt(real, item({ "src/c.ts": "export const c = 1;\n" }, ["rules/ids.txt"]), COVERED))).toEqual({ code: "scan_refused", refusals: ["rule_file_changed rules/ids.txt"] });
    const adds = { ...COVERED, identifierRulesPath: "rules/new.txt" };
    expect(shape(await attempt(real, item({ "rules/new.txt": EDITED_IDS, "src/c.ts": "export const c = 1;\n" }), adds))).toEqual({ code: "scan_refused", refusals: ["rule_file_changed rules/new.txt"] });
    expect(scanModule.scanPlanePush).not.toHaveBeenCalled();
  });
});

describe("a stacked item: the rules come from where the stack left the default branch", () => {
  it("a parent that edited a declared rule file refuses its child (rule_file_changed), and nothing is pushed", async () => {
    const parent = commitOn({ "rules/ids.txt": EDITED_IDS });
    expect(shape(await attempt(real, item(FLAGGED, [], parent), COVERED))).toEqual({ code: "scan_refused", refusals: ["rule_file_changed rules/ids.txt"] });
    const planParent = commitOn({ "rules/plan.json": EDITED_PLAN });
    expect(shape(await attempt(real, item(PRICE, [], planParent), COVERED))).toEqual({ code: "scan_refused", refusals: ["rule_file_changed rules/plan.json"] });
    expect(scanModule.scanPlanePush).not.toHaveBeenCalled();
  });

  it("a parent that left the rules alone: the child is pushed with only its own change, and the default branch's rules still apply", async () => {
    const parent = commitOn({ "src/p.ts": "export const p = 1;\n" });
    const input = item({ "src/c.ts": "export const c = 1;\n" }, [], parent);
    expect(await attempt(real, input, COVERED)).toEqual({ pushed: true });
    expect(sh(bare, "diff", "--name-only", "main", "item-1")).toBe("src/c.ts");
    sh(bare, "update-ref", "-d", "refs/heads/item-1");
    expect(shape(await attempt(real, item(FLAGGED, [], parent), COVERED))).toEqual({ code: "scan_refused", refusals: ["identifier_hit src/host.ts"] });
  });

  it("a recorded base that shares no history with the default branch's tip is refused: there is no rule base", async () => {
    const input = item({ "src/c.ts": "export const c = 1;\n" });
    sh(priv, "checkout", "-q", "--orphan", "unrelated");
    put(priv, { "x.txt": "x\n" });
    const unrelated = commitAll(priv, "unrelated");
    expect(await attempt(real, { ...input, privateDefaultTip: unrelated }, COVERED)).toMatchObject({ code: "bad_input" });
    expect(scanModule.scanPlanePush).not.toHaveBeenCalled();
  });
});

describe("the current rules apply: they are read at the default branch's tip", () => {
  /** The default branch moves on after `privateBase`: its identifier rules gain a value, and its plan data a figure. Returns the new tip. */
  const updateRules = (): string =>
    commitOn({ "rules/ids.txt": IDS.replace("acme-internal-host\n", "acme-internal-host\nacme-staging-vault\n"), "rules/plan.json": JSON.stringify({ priceUsdPerMonth: 7391, seatsIncluded: 4417 }) });
  const NEW_ID = { "src/vault.ts": "export const host = 'acme-staging-vault';\n" };
  const NEW_FIGURE = { "src/seats.ts": "export const seats = 4417;\n" };

  it("a stacked child whose parent forked before a rule update is scanned by the updated rules", async () => {
    const tip = updateRules();
    const parent = commitOn({ "src/p.ts": "export const p = 1;\n" });
    expect(shape(await attempt(real, item(NEW_ID, [], parent, tip), COVERED))).toEqual({ code: "scan_refused", refusals: ["identifier_hit src/vault.ts"] });
    expect(shape(await attempt(real, item(NEW_FIGURE, [], parent, tip), COVERED))).toEqual({ code: "scan_refused", refusals: ["plan_data_hit src/seats.ts"] });
  });

  it("so is an item that started before the update, with no stack", async () => {
    const tip = updateRules();
    expect(shape(await attempt(real, item(NEW_ID, [], privateBase, tip), COVERED))).toEqual({ code: "scan_refused", refusals: ["identifier_hit src/vault.ts"] });
  });

  it("the rule update on the default branch is not the item's change: an unrelated change is still pushed", async () => {
    const tip = updateRules();
    const parent = commitOn({ "src/p.ts": "export const p = 1;\n" });
    expect(await attempt(real, item({ "src/c.ts": "export const c = 1;\n" }, [], parent, tip), COVERED)).toEqual({ pushed: true });
  });
});

describe("rule files must be private paths", () => {
  it("a stored pairing whose rule files no private path covers is refused at push time, naming each file and nothing else", async () => {
    const r = await attempt(real, item({ "src/c.ts": "export const c = 1;\n" }), LEGACY);
    expect(shape(r)).toEqual({ code: "rule_files_not_private", refusals: ["rule_file_not_private rules/ids.txt", "rule_file_not_private rules/plan.json"] });
    const half = await attempt(real, item({ "src/c.ts": "export const c = 1;\n" }), { ...LEGACY, overlayGlobs: ["docs/ops/", "rules/plan.json"] });
    expect(shape(half)).toEqual({ code: "rule_files_not_private", refusals: ["rule_file_not_private rules/ids.txt"] });
    expect(scanModule.scanPlanePush).not.toHaveBeenCalled();
  });

  it("the same pairing with an edited rule file and a change the base's rules refuse is refused the same way", async () => {
    expect(shape(await attempt(real, item({ "rules/ids.txt": EDITED_IDS, ...FLAGGED }), LEGACY))).toMatchObject({ code: "rule_files_not_private" });
  });

  it("a rule file under a private path keeps working: a clean change is pushed, and the base's rules still refuse a change they cover", async () => {
    expect(await attempt(real, item({ "src/c.ts": "export const c = 1;\n" }), COVERED)).toEqual({ pushed: true });
    sh(bare, "update-ref", "-d", "refs/heads/item-1");
    expect(shape(await attempt(real, item(FLAGGED), COVERED))).toEqual({ code: "scan_refused", refusals: ["identifier_hit src/host.ts"] });
    expect(shape(await attempt(real, item(PRICE), COVERED))).toEqual({ code: "scan_refused", refusals: ["plan_data_hit src/price.ts"] });
  });
});

/**
 * Mutation checks: the route's source with one check taken out, loaded from a temporary copy. Each replacement must apply exactly as many
 * times as stated, so a rewrite of the route that moves these lines fails here rather than passing quietly.
 */
describe("each of the checks is load-bearing (mutated copies of the route)", () => {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../runner-protocol/src/planePush");
  const source = readFileSync(join(srcDir, "planePushRoute.ts"), "utf8");
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const GUARD = "  await assertRuleFilesUnchanged(input.repoDir, ruleBase, input.privateHead, decision.pairing);\n";
  const PRIVATE = "  assertRuleFilesPrivate(decision.pairing);\n";
  const RULE_READ = "readRuleFile(input.repoDir, input.privateDefaultTip,";
  const HEAD_READ = "readRuleFile(input.repoDir, input.privateHead,";
  const RECORDED_READ = "readRuleFile(input.repoDir, input.privateBase,";
  const RULE_BASE_READ = "readRuleFile(input.repoDir, ruleBase,";
  async function mutant(edits: Array<[string, string, number]>): Promise<Route> {
    let text = source.replace(/from "\.\/([A-Za-z]+)\.js"/g, (_m, name: string) => `from ${JSON.stringify(join(srcDir, `${name}.ts`))}`);
    for (const [from, to, times] of edits) {
      expect(text.split(from).length - 1, from).toBe(times);
      text = text.split(from).join(to);
    }
    const dir = mkdtempSync(join(tmpdir(), "rulesbase-mutant-"));
    made.push(dir);
    const file = join(dir, "planePushRoute.ts");
    writeFileSync(file, text);
    return ((await import(file)) as typeof routeModule).routeAndPush;
  }

  it("an unmodified copy behaves as the route does (the harness itself changes nothing)", async () => {
    const same = await mutant([]);
    expect(shape(await attempt(same, item({ "rules/ids.txt": EDITED_IDS, ...FLAGGED }), COVERED))).toEqual({ code: "scan_refused", refusals: ["rule_file_changed rules/ids.txt"] });
    expect(shape(await attempt(same, item({ "src/c.ts": "export const c = 1;\n" }), LEGACY))).toMatchObject({ code: "rule_files_not_private" });
  });

  it("without the change guard, the first test above no longer sees rule_file_changed", async () => {
    const noGuard = await mutant([[GUARD, "", 1]]);
    const r = await attempt(noGuard, item({ "rules/ids.txt": EDITED_IDS, ...FLAGGED }), COVERED);
    expect(shape(r)).not.toEqual({ code: "scan_refused", refusals: ["rule_file_changed rules/ids.txt"] });
  });

  it("without the private-path check, a stored uncovered pairing is pushed", async () => {
    const noPrivate = await mutant([[PRIVATE, "", 1]]);
    expect(await attempt(noPrivate, item({ "src/c.ts": "export const c = 1;\n" }), LEGACY)).toEqual({ pushed: true });
  });

  it("with only the base read left, an edited rule file still does not change the outcome; reading at the head instead does", async () => {
    const baseOnly = await mutant([[GUARD, "", 1], [PRIVATE, "", 1]]);
    expect(shape(await attempt(baseOnly, item({ "rules/ids.txt": EDITED_IDS, ...FLAGGED }), LEGACY))).toEqual({ code: "scan_refused", refusals: ["identifier_hit src/host.ts"] });
    expect(shape(await attempt(baseOnly, item({ "rules/plan.json": EDITED_PLAN, ...PRICE }), LEGACY))).toEqual({ code: "scan_refused", refusals: ["plan_data_hit src/price.ts"] });
    const headRead = await mutant([[GUARD, "", 1], [PRIVATE, "", 1], [RULE_READ, HEAD_READ, 3]]);
    expect(shape(await attempt(headRead, item({ "rules/ids.txt": EDITED_IDS, ...FLAGGED }), LEGACY))).toEqual("pushed");
  });

  it("with the change guard run from the recorded base instead of the rule base, a stacked parent's rule edit is no longer reported", async () => {
    const fromRecorded = await mutant([[GUARD, GUARD.replace("ruleBase", "input.privateBase"), 1]]);
    const parent = commitOn({ "rules/ids.txt": EDITED_IDS });
    expect(shape(await attempt(fromRecorded, item(FLAGGED, [], parent), COVERED))).not.toEqual({ code: "scan_refused", refusals: ["rule_file_changed rules/ids.txt"] });
  });

  it("reading at the rule base instead of the default branch's tip scans a child of an old fork with the old rules", async () => {
    const tip = commitOn({ "rules/ids.txt": IDS.replace("acme-internal-host\n", "acme-internal-host\nacme-staging-vault\n") });
    const parent = commitOn({ "src/p.ts": "export const p = 1;\n" });
    const child = { "src/vault.ts": "export const host = 'acme-staging-vault';\n" };
    expect(shape(await attempt(real, item(child, [], parent, tip), COVERED))).toEqual({ code: "scan_refused", refusals: ["identifier_hit src/vault.ts"] });
    const atRuleBase = await mutant([[RULE_READ, RULE_BASE_READ, 3]]);
    expect(shape(await attempt(atRuleBase, item(child, [], parent, tip), COVERED))).toEqual("pushed");
  });

  it("with only the tip read left, a stacked parent's edited rules do not decide; reading at the recorded base instead lets the child through", async () => {
    const parent = commitOn({ "rules/ids.txt": EDITED_IDS });
    const ruleBaseOnly = await mutant([[GUARD, "", 1], [PRIVATE, "", 1]]);
    expect(shape(await attempt(ruleBaseOnly, item(FLAGGED, [], parent), LEGACY))).toEqual({ code: "scan_refused", refusals: ["identifier_hit src/host.ts"] });
    const recordedRead = await mutant([[GUARD, "", 1], [PRIVATE, "", 1], [RULE_READ, RECORDED_READ, 3]]);
    expect(shape(await attempt(recordedRead, item(FLAGGED, [], parent), LEGACY))).toEqual("pushed");
  });
});
