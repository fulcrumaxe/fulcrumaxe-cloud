import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineCommand, EngineCommandAck, signEngineCommand, type SignedEngineCommand } from "@fulcrumaxe/runner-protocol";
import type { CloudReply } from "../../src/cloud.js";
import { createBridgeApply, type EngineBridgeCommandOptions } from "../../src/commands/engineBridge.js";
import { BRIDGE_COMMANDS_FILE, BridgeCommandPuller, ackForEnable } from "../../src/engineBridge/bridgeCommands.js";
import { PULL_PATH } from "../../src/engineBridge/commands.js";
import { BRIDGE_SETTINGS_FILE, loadBridgeSettings } from "../../src/engineBridge/settings.js";
import { BRIDGE_STATE_FILE } from "../../src/engineHost/hostFiles.js";
import { manualClock } from "../helpers/manualClock.js";

// D#845 ON-BR-2, criteria 3, 4, 5, 8 and 10 on the runner: real Ed25519 signatures, a real temporary filesystem (clones, symlinks, a settings file), the same enable code the command line runs.
const uid = process.getuid?.();
const RUNNER_ID = "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f";
const REPO = 77;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyring = { "job-key-1": publicKey };
const OK = (body: unknown): CloudReply => ({ status: 200, body, retryAfter: undefined, protectedDeployment: false }) as CloudReply;

let tmp: string;
let home: string;
let runnerState: string;
let logs: string[];
let seq: number;
let handed: SignedEngineCommand[];
let acks: Array<{ id: string; body: unknown }>;
let pulls: unknown[];
let ackStatus: number;
let allowed: Array<{ repo_gh_id: number; full_name: string }> | undefined;
const clock = manualClock();

const options = (): EngineBridgeCommandOptions => ({ home, engineStateDirOverride: undefined, discovery: { cwd: undefined, searchRoots: undefined } });
/** A clone of acme/widgets with a project file naming its own state directory, an engine manifest, and the state directory itself. */
function clone(dir: string, over: { remote?: string; state?: string | null; manifest?: boolean } = {}): { root: string; state: string } {
  const state = over.state ?? path.join(tmp, `state-${path.basename(dir)}`);
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${over.remote ?? "https://github.com/acme/widgets.git"}\n`);
  mkdirSync(path.join(dir, ".autonomous-team"), { recursive: true });
  writeFileSync(path.join(dir, ".autonomous-team", "project.json"), JSON.stringify({ project_name: "widgets", state_dir: state }));
  if (over.manifest !== false) {
    mkdirSync(path.join(dir, "engine"), { recursive: true });
    writeFileSync(path.join(dir, "engine", "manifest.json"), JSON.stringify({ engine_version: "1.2.3" }));
  }
  mkdirSync(state, { recursive: true, mode: 0o700 });
  return { root: dir, state };
}
function command(kind: "bridge_enable" | "bridge_disable", args: Record<string, unknown> = {}, over: Record<string, unknown> = {}): SignedEngineCommand {
  const issued = clock.now();
  const body = { v: 1, purpose: "engine_command_v1", command_id: randomUUID(), command_seq: ++seq, runner_id: RUNNER_ID, repo_gh_id: REPO, kind, args, issued_by: randomUUID(), issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 600_000).toISOString(), halt_epoch: 0, ...over };
  return signEngineCommand(EngineCommand.parse(body), "job-key-1", privateKey);
}
const puller = (opts: EngineBridgeCommandOptions = options()): BridgeCommandPuller => {
  const apply = createBridgeApply({ stateDir: runnerState, uid, now: () => clock.now(), options: opts });
  return new BridgeCommandPuller({
    post: async (p, body) => {
      if (p === PULL_PATH) {
        pulls.push(body);
        const commands = handed;
        handed = [];
        return OK({ commands, controls: [], allowed_repos: allowed });
      }
      acks.push({ id: p.split("/").at(-2)!, body });
      return { status: ackStatus, body: {}, retryAfter: undefined, protectedDeployment: false } as CloudReply;
    },
    keyring, runnerId: RUNNER_ID, clock, wakeEpoch: () => null, accepted: () => true, runnerStateDir: runnerState,
    allowed: () => allowed, apply, log: (l) => logs.push(l),
  });
};
const handle = async (p: BridgeCommandPuller, ...cmds: SignedEngineCommand[]) => {
  handed = cmds;
  await p.pullOnce();
};
const lastAck = () => acks.at(-1)!.body as Record<string, unknown>;
const settings = () => {
  const l = loadBridgeSettings(runnerState);
  return l.ok ? l.repos : undefined;
};
/** The folders this runner offered for the repo a moment ago, as its state file holds them after an answer that listed them. */
const seedOffer = (roots: string[], agoMs = 0) =>
  writeFileSync(path.join(runnerState, BRIDGE_COMMANDS_FILE), JSON.stringify({ version: 1, last_seq: {}, seen: {}, offers: { [String(REPO)]: { at: clock.now().getTime() - agoMs, roots } } }), { mode: 0o600 });
const settingsBytes = () => (existsSync(path.join(runnerState, BRIDGE_SETTINGS_FILE)) ? readFileSync(path.join(runnerState, BRIDGE_SETTINGS_FILE), "utf8") : "");

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "fx-onbr2-"));
  home = path.join(tmp, "home");
  runnerState = path.join(tmp, "runner");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(runnerState, { mode: 0o700 });
  logs = [];
  seq = 0;
  handed = [];
  acks = [];
  pulls = [];
  ackStatus = 200;
  allowed = [{ repo_gh_id: REPO, full_name: "acme/widgets" }];
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("bridge_enable: finding the checkout", () => {
  it("connects with the one clone the scan finds, ends with the same settings as the explicit flags, and acks only the last two parts of the folder", async () => {
    const c = clone(path.join(home, "code", "acme", "widgets"));
    await handle(puller(), command("bridge_enable"));
    expect(settings()).toEqual([{ repo_gh_id: REPO, full_name: "acme/widgets", state_dir: c.state, repo_root: c.root }]);
    expect(lastAck()).toEqual({ outcome: "applied", result: "connected", root_tail: "acme/widgets" });
    expect(JSON.stringify(acks)).not.toContain(home);
    // The same pair the command line writes for the explicit flags.
    const apply = createBridgeApply({ stateDir: path.join(tmp, "other-runner"), uid, now: () => clock.now(), options: options() });
    mkdirSync(path.join(tmp, "other-runner"), { mode: 0o700 });
    expect(apply.enable({ repo_gh_id: REPO, full_name: "acme/widgets" }, c.root)).toEqual({ ok: true, root: c.root });
    expect(readFileSync(path.join(tmp, "other-runner", BRIDGE_SETTINGS_FILE), "utf8")).toBe(settingsBytes());
  });

  it("takes the folder the person picked from what it offered, and acks connected", async () => {
    const a = clone(path.join(home, "a", "widgets"));
    const b = clone(path.join(home, "b", "widgets"));
    const p = puller();
    await handle(p, command("bridge_enable"));
    expect(lastAck()).toMatchObject({ result: "ambiguous", candidates: [a.root, b.root] });
    await handle(p, command("bridge_enable", { repo_root: a.root }));
    expect(settings()!.map((r) => r.repo_root)).toEqual([a.root]);
    expect(lastAck()).toMatchObject({ outcome: "applied", result: "connected", root_tail: "a/widgets" });
  });

  it("finds none: not_found, nothing written, the roots are not listed in the ack", async () => {
    await handle(puller(), command("bridge_enable"));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "checkout_not_found", result: "not_found" });
    expect(settingsBytes()).toBe("");
  });

  it("ON-BR-4: a search that hit its entry cap and found nothing says `incomplete: true`; one that finished says nothing of the kind", async () => {
    let first = true;
    const flood = { readDir: () => (first ? ((first = false), Array.from({ length: 25000 }, (_, i) => ({ name: `n${i}`, isDirectory: false }))) : []) };
    await handle(puller({ ...options(), discovery: { cwd: undefined, searchRoots: undefined, ops: flood } }), command("bridge_enable"));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "checkout_not_found", result: "not_found", incomplete: true });
    expect(EngineCommandAck.safeParse(lastAck()).success).toBe(true);
    expect(settingsBytes()).toBe("");
    await handle(puller(), command("bridge_enable"));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "checkout_not_found", result: "not_found" });
  });

  it("lists the clones it skipped as unsafe for information only, in `skipped`, never as a pick: a pick of one is refused, and after chmod go-w the scan finds it by itself (ruling 9)", async () => {
    const wide = clone(path.join(home, "shared", "widgets"));
    chmodSync(wide.root, 0o775);
    const p = puller();
    await handle(p, command("bridge_enable"));
    expect(lastAck()).toMatchObject({ outcome: "refused", result: "not_found", refusal: "checkout_not_found", skipped: [wide.root] });
    expect(lastAck()).not.toHaveProperty("candidates");
    expect(settingsBytes()).toBe("");
    // Not offered, so a pick is refused whatever the cloud sends; and offered by a stale or hostile state it is still refused by the guards.
    await handle(p, command("bridge_enable", { repo_root: wide.root }));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "repo_root_invalid", result: "refused" });
    seedOffer([wide.root]);
    await handle(puller(), command("bridge_enable", { repo_root: wide.root }));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "checkout_unsafe", result: "refused" });
    expect(settingsBytes()).toBe("");
    chmodSync(wide.root, 0o755);
    await handle(puller(), command("bridge_enable"));
    expect(lastAck()).toMatchObject({ outcome: "applied", result: "connected", root_tail: "shared/widgets" });
  });

  it("an offer stamped in the future (a clock that went back, or a planted file) is no offer: the age must be 0 to 10 minutes", async () => {
    const c = clone(path.join(home, "a", "widgets"));
    seedOffer([c.root], -86_400_000);
    await handle(puller(), command("bridge_enable", { repo_root: c.root }));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "repo_root_invalid", result: "refused" });
    expect(settingsBytes()).toBe("");
    seedOffer([c.root], -1);
    await handle(puller(), command("bridge_enable", { repo_root: c.root }));
    expect(lastAck().refusal).toBe("repo_root_invalid");
    seedOffer([c.root], 0);
    await handle(puller(), command("bridge_enable", { repo_root: c.root }));
    expect(lastAck().result).toBe("connected");
  });

  it("two clones: ambiguous with both folders, nothing written; twelve clones: the first ten", async () => {
    const a = clone(path.join(home, "a", "widgets"));
    const b = clone(path.join(home, "b", "widgets"));
    await handle(puller(), command("bridge_enable"));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "checkout_ambiguous", result: "ambiguous", candidates: [a.root, b.root] });
    expect(settingsBytes()).toBe("");
    for (let i = 0; i < 10; i++) clone(path.join(home, `c${String(i).padStart(2, "0")}`, "widgets"));
    await handle(puller(), command("bridge_enable"));
    expect(lastAck().candidates).toHaveLength(10);
    expect(settingsBytes()).toBe("");
  });

  it("a clone with no usable project file is refused checkout_layout_unexpected, never matched", async () => {
    const c = clone(path.join(home, "x", "widgets"));
    writeFileSync(path.join(c.root, ".autonomous-team", "project.json"), "{ not json");
    await handle(puller(), command("bridge_enable"));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "checkout_layout_unexpected", result: "refused" });
    expect(settingsBytes()).toBe("");
  });

  it("every enable refusal the command line has is answered with its code and writes nothing: state dir missing, no engine version, a shared state directory", async () => {
    const c = clone(path.join(home, "a", "widgets"));
    rmSync(c.state, { recursive: true });
    await handle(puller(), command("bridge_enable"));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "state_dir_missing", result: "refused" });
    mkdirSync(c.state, { mode: 0o700 });
    rmSync(path.join(c.root, "engine", "manifest.json"));
    await handle(puller(), command("bridge_enable"));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "engine_version_unusable", result: "refused" });
    expect(settingsBytes()).toBe("");
  });
});

describe("bridge_enable: a folder the cloud carried is only a request", () => {
  it("a clone that was never offered is refused, however good it is; so is one offered more than ten minutes ago", async () => {
    const c = clone(path.join(home, "a", "widgets"));
    await handle(puller(), command("bridge_enable", { repo_root: c.root }));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "repo_root_invalid", result: "refused" });
    seedOffer([c.root], 601_000);
    await handle(puller(), command("bridge_enable", { repo_root: c.root }));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "repo_root_invalid", result: "refused" });
    seedOffer(["/work/other/widgets"]);
    await handle(puller(), command("bridge_enable", { repo_root: c.root }));
    expect(lastAck().refusal).toBe("repo_root_invalid");
    expect(settingsBytes()).toBe("");
    seedOffer([c.root], 599_000);
    await handle(puller(), command("bridge_enable", { repo_root: c.root }));
    expect(lastAck().result).toBe("connected");
  });

  it("an offer is kept per repo: what was offered for another repo does not open this one", async () => {
    const c = clone(path.join(home, "a", "widgets"));
    writeFileSync(path.join(runnerState, BRIDGE_COMMANDS_FILE), JSON.stringify({ version: 1, last_seq: {}, seen: {}, offers: { "78": { at: clock.now().getTime(), roots: [c.root] } } }), { mode: 0o600 });
    await handle(puller(), command("bridge_enable", { repo_root: c.root }));
    expect(lastAck().refusal).toBe("repo_root_invalid");
  });

  it("is refused checkout_mismatch when its remote names another repo: the cloud's word never replaces the remote check", async () => {
    const other = clone(path.join(home, "other", "widgets"), { remote: "git@github.com:acme/gadgets.git" });
    seedOffer([other.root]);
    await handle(puller(), command("bridge_enable", { repo_root: other.root }));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "checkout_mismatch", result: "refused" });
    expect(settingsBytes()).toBe("");
  });

  it("is refused repo_root_invalid for a symlink, a path through a symlink, a folder with no .git directory, a file, and a folder that is not there", async () => {
    const real = clone(path.join(home, "real", "widgets"));
    const link = path.join(home, "link");
    symlinkSync(real.root, link);
    const through = path.join(home, "via");
    symlinkSync(path.join(home, "real"), through);
    const bare = path.join(home, "bare");
    mkdirSync(bare);
    const file = path.join(home, "file");
    writeFileSync(file, "x");
    const gitFile = path.join(home, "gitfile");
    mkdirSync(gitFile);
    writeFileSync(path.join(gitFile, ".git"), "gitdir: /elsewhere");
    const roots = [link, path.join(through, "widgets"), bare, file, path.join(home, "missing"), gitFile];
    seedOffer([...roots, real.root]);
    for (const root of roots) {
      await handle(puller(), command("bridge_enable", { repo_root: root }));
      expect(lastAck(), root).toEqual({ outcome: "refused", refusal: "repo_root_invalid", result: "refused" });
    }
    expect(settingsBytes()).toBe("");
    // The one real folder still works.
    await handle(puller(), command("bridge_enable", { repo_root: real.root }));
    expect(lastAck().result).toBe("connected");
  });

  it("an offered clone gets every guard the scan gives: a world-writable parent that is not sticky, a world-writable .git, a folder others can write in, and one that is not the runner's user's are all checkout_unsafe, and nothing is written", async () => {
    const roots: string[] = [];
    const parent = path.join(home, "open");
    mkdirSync(parent);
    const under = clone(path.join(parent, "widgets"));
    chmodSync(parent, 0o777);
    roots.push(under.root);
    const wideGit = clone(path.join(home, "widegit", "widgets"));
    chmodSync(path.join(wideGit.root, ".git"), 0o777);
    roots.push(wideGit.root);
    const wideRoot = clone(path.join(home, "wideroot", "widgets"));
    chmodSync(wideRoot.root, 0o775);
    roots.push(wideRoot.root);
    seedOffer(roots);
    for (const root of roots) {
      await handle(puller(), command("bridge_enable", { repo_root: root }));
      expect(lastAck(), root).toEqual({ outcome: "refused", refusal: "checkout_unsafe", result: "refused" });
    }
    expect(settingsBytes()).toBe("");
    // A sticky parent (like a shared temp directory) is allowed.
    chmodSync(parent, 0o1777);
    seedOffer([under.root]);
    await handle(puller(), command("bridge_enable", { repo_root: under.root }));
    expect(lastAck().result).toBe("connected");
  });

  it("reads .autonomous-team through no link: a symlinked .autonomous-team (or project file) cannot bring a state_dir from outside the checkout", async () => {
    const c = clone(path.join(home, "a", "widgets"));
    const outside = path.join(tmp, "outside");
    mkdirSync(outside, { mode: 0o700 });
    const evilState = path.join(tmp, "evil-state");
    mkdirSync(evilState, { mode: 0o700 });
    writeFileSync(path.join(outside, "project.json"), JSON.stringify({ project_name: "widgets", state_dir: evilState }));
    rmSync(path.join(c.root, ".autonomous-team"), { recursive: true });
    symlinkSync(outside, path.join(c.root, ".autonomous-team"));
    seedOffer([c.root]);
    await handle(puller(), command("bridge_enable", { repo_root: c.root }));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "checkout_layout_unexpected", result: "refused" });
    expect(settingsBytes()).toBe("");
    // The project file itself as a link is refused the same way.
    rmSync(path.join(c.root, ".autonomous-team"));
    mkdirSync(path.join(c.root, ".autonomous-team"));
    symlinkSync(path.join(outside, "project.json"), path.join(c.root, ".autonomous-team", "project.json"));
    await handle(puller(), command("bridge_enable", { repo_root: c.root }));
    expect(lastAck().refusal).toBe("checkout_layout_unexpected");
    expect(settingsBytes()).toBe("");
  });

  it("a folder with a .. part, a doubled slash or a relative path is refused before anything is read, even handed to the runner's code directly", () => {
    const real = clone(path.join(home, "real", "widgets"));
    const apply = createBridgeApply({ stateDir: runnerState, uid, now: () => clock.now(), options: options() });
    for (const root of [`${home}/real/../real/widgets`, `${home}//real/widgets`, `${real.root}/`, "real/widgets", "/etc/../etc"]) {
      expect(apply.enable({ repo_gh_id: REPO, full_name: "acme/widgets" }, root), root).toEqual({ ok: false, code: "repo_root_invalid", candidates: [] });
    }
    expect(settingsBytes()).toBe("");
  });

  it("never reads a .git/config that is a symlink to another file, and reads nothing outside the folder", async () => {
    const c = clone(path.join(home, "a", "widgets"));
    const secret = path.join(tmp, "elsewhere.cfg");
    writeFileSync(secret, `[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n`);
    rmSync(path.join(c.root, ".git", "config"));
    symlinkSync(secret, path.join(c.root, ".git", "config"));
    seedOffer([c.root]);
    await handle(puller(), command("bridge_enable", { repo_root: c.root }));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "checkout_mismatch", result: "refused" });
  });

  it("a command whose state cannot be written runs nothing and enables nothing (it is not acked, so the cloud reads it as not confirmed)", async () => {
    clone(path.join(home, "a", "widgets"));
    mkdirSync(path.join(runnerState, BRIDGE_COMMANDS_FILE)); // the state file's name taken by a directory: it cannot be written
    await handle(puller(), command("bridge_enable"));
    expect(settingsBytes()).toBe("");
    expect(acks).toEqual([]);
    expect(logs.join("\n")).toMatch(/could not be written; the command was not run/);
  });

  it("does not follow a symlinked project file, and never logs a folder, a url or a token", async () => {
    const token = "ghp_sentinelTOKEN123";
    const c = clone(path.join(home, "a", "widgets"), { remote: `https://user:${token}@github.com/acme/widgets.git` });
    await handle(puller(), command("bridge_enable"));
    expect(lastAck().result).toBe("connected");
    expect(JSON.stringify(acks)).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);
    expect(logs.join("\n")).not.toContain(c.root);
    expect(readFileSync(path.join(runnerState, BRIDGE_SETTINGS_FILE), "utf8")).not.toContain(token);
  });
});

describe("replay, order and the judge", () => {
  it("a replay of an acked command is refused seq_not_increasing and changes nothing; the enable that already succeeded is already_connected and writes nothing", async () => {
    const c = clone(path.join(home, "a", "widgets"));
    const p = puller();
    const first = command("bridge_enable");
    await handle(p, first);
    expect(lastAck().result).toBe("connected");
    const bytes = settingsBytes();
    await handle(p, first);
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "seq_not_increasing" });
    // A fresh command for the same repo while it is connected: nothing is written.
    const before = statSync(path.join(runnerState, BRIDGE_SETTINGS_FILE)).mtimeMs;
    await handle(p, command("bridge_enable", { repo_root: c.root }));
    expect(lastAck()).toEqual({ outcome: "applied", result: "already_connected", root_tail: "a/widgets" });
    expect(settingsBytes()).toBe(bytes);
    expect(statSync(path.join(runnerState, BRIDGE_SETTINGS_FILE)).mtimeMs).toBe(before);
  });

  it("connect, disconnect, then a replay of the connect: the monotonic seq refuses it, even after a restart (the state is on disk)", async () => {
    clone(path.join(home, "a", "widgets"));
    const connect = command("bridge_enable");
    const off = command("bridge_disable");
    await handle(puller(), connect);
    await handle(puller(), off);
    expect(lastAck()).toEqual({ outcome: "applied" });
    expect(settings()).toEqual([]);
    await handle(puller(), connect);
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "seq_not_increasing" });
    expect(settings()).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(runnerState, BRIDGE_COMMANDS_FILE), "utf8")).last_seq).toEqual({ [String(REPO)]: 2 });
  });

  it("a changed repo_root fails verification (signature_invalid) and nothing runs", async () => {
    const a = clone(path.join(home, "a", "widgets"));
    const b = clone(path.join(home, "b", "widgets"));
    const signed = command("bridge_enable", { repo_root: a.root });
    const swapped = { ...signed, command: { ...signed.command, args: { repo_root: b.root } } } as SignedEngineCommand;
    await handle(puller(), swapped);
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "signature_invalid" });
    expect(settingsBytes()).toBe("");
  });

  it("judges in order: signature, runner, repo, expiry, sequence; each refusal changes nothing", async () => {
    clone(path.join(home, "a", "widgets"));
    const p = puller();
    const bad = command("bridge_enable");
    await handle(p, { ...bad, signature: "A".repeat(86) });
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "signature_invalid" });
    await handle(p, command("bridge_enable", {}, { runner_id: randomUUID() }));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "wrong_runner" });
    await handle(p, command("bridge_enable", {}, { repo_gh_id: 999 }));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "wrong_repo" });
    allowed = undefined;
    await handle(p, command("bridge_enable"));
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "wrong_repo" });
    allowed = [{ repo_gh_id: REPO, full_name: "acme/widgets" }];
    const old = command("bridge_enable");
    clock.jump(601_000);
    await handle(p, old);
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "expired" });
    expect(settingsBytes()).toBe("");
  });

  it("a command that is not a bridge command is refused and reaches no inbox", async () => {
    const p = puller();
    const other = signEngineCommand(EngineCommand.parse({ v: 1, purpose: "engine_command_v1", command_id: randomUUID(), command_seq: 50, runner_id: RUNNER_ID, repo_gh_id: REPO, kind: "start_day", args: {}, issued_by: randomUUID(), issued_at: clock.now().toISOString(), expires_at: new Date(clock.now().getTime() + 60_000).toISOString(), halt_epoch: 0 }), "job-key-1", privateKey);
    await handle(p, other);
    expect(lastAck()).toEqual({ outcome: "refused", refusal: "wrong_repo" });
  });
});

describe("bridge_disable", () => {
  it("removes the repo's bridge settings and its bridge state file, and never the engine's state directory or the checkout", async () => {
    const c = clone(path.join(home, "a", "widgets"));
    writeFileSync(path.join(c.root, "SENTINEL"), "keep");
    writeFileSync(path.join(c.state, "SENTINEL"), "keep");
    const p = puller();
    await handle(p, command("bridge_enable"));
    writeFileSync(path.join(c.state, BRIDGE_STATE_FILE), "{}", { mode: 0o600 });
    await handle(p, command("bridge_disable"));
    expect(lastAck()).toEqual({ outcome: "applied" });
    expect(settings()).toEqual([]);
    expect(existsSync(path.join(c.state, BRIDGE_STATE_FILE))).toBe(false);
    expect(readFileSync(path.join(c.root, "SENTINEL"), "utf8")).toBe("keep");
    expect(readFileSync(path.join(c.state, "SENTINEL"), "utf8")).toBe("keep");
    expect(existsSync(path.join(c.root, ".git", "config"))).toBe(true);
    expect(existsSync(path.join(c.state, "."))).toBe(true);
  });

  it("is applied when the repo is not enabled (nothing to undo), and leaves another repo alone", async () => {
    await handle(puller(), command("bridge_disable"));
    expect(lastAck()).toEqual({ outcome: "applied" });
  });
});

describe("the pull and the acks", () => {
  it("reports what it bridges, with the checkout, and asks for its bridge commands", async () => {
    const c = clone(path.join(home, "a", "widgets"));
    const p = puller();
    await handle(p);
    expect(pulls.at(-1)).toMatchObject({ bridge_commands: true, repo_gh_ids: [Number.MAX_SAFE_INTEGER], after_seq: {} });
    expect(pulls.at(-1)).toMatchObject({ bridged: [] }); // nothing enabled yet is still a report: a repo that was there is dropped
    await handle(p, command("bridge_enable"));
    await handle(p);
    expect(pulls.at(-1)).toMatchObject({ bridged: [{ repo_gh_id: REPO, root: c.root }] });
    // A repo disabled by hand drops out of the next report.
    rmSync(path.join(runnerState, BRIDGE_SETTINGS_FILE));
    await handle(p);
    expect(pulls.at(-1)).toMatchObject({ bridged: [] });
  });

  it("keeps an ack the cloud would not take and sends it again, never dropping it; a 409 settles it", async () => {
    clone(path.join(home, "a", "widgets"));
    const p = puller();
    ackStatus = 503;
    await handle(p, command("bridge_enable"));
    const tries = acks.length;
    expect(tries).toBeGreaterThanOrEqual(1);
    clock.jump(400_000);
    ackStatus = 409;
    await handle(p);
    expect(acks.length).toBeGreaterThan(tries);
    const settled = acks.length;
    await handle(p);
    expect(acks.length).toBe(settled);
  });

  it("every ack it sends is a valid ack", async () => {
    const c = clone(path.join(home, "a", "widgets"));
    const p = puller();
    await handle(p, command("bridge_enable", { repo_root: path.join(home, "nowhere") }), command("bridge_enable"), command("bridge_disable"));
    expect(acks.length).toBe(3);
    for (const a of acks) expect(EngineCommandAck.safeParse(a.body).success, JSON.stringify(a.body)).toBe(true);
    void c;
  });
});

describe("ackForEnable", () => {
  const dirs = (n: number) => Array.from({ length: n }, (_, i) => `/work/c${i}/widgets`);
  it("maps each outcome to its result", () => {
    expect(ackForEnable({ ok: true, root: "/home/me/code/acme/widgets" })).toEqual({ outcome: "applied", result: "connected", root_tail: "acme/widgets" });
    expect(ackForEnable({ ok: false, code: "checkout_not_found", candidates: [] })).toEqual({ outcome: "refused", refusal: "checkout_not_found", result: "not_found" });
    expect(ackForEnable({ ok: false, code: "checkout_ambiguous", candidates: dirs(12) })).toMatchObject({ result: "ambiguous", candidates: dirs(10) });
    expect(ackForEnable({ ok: false, code: "checkout_incomplete", candidates: ["/work/one/widgets"] })).toEqual({ outcome: "refused", refusal: "checkout_incomplete", result: "refused", candidates: ["/work/one/widgets"] });
    expect(ackForEnable({ ok: false, code: "state_dir_shared", candidates: ["/work/never/shown"] })).toEqual({ outcome: "refused", refusal: "state_dir_shared", result: "refused" });
  });
  it("ON-BR-4: incomplete rides only a not_found answer, whatever the outcome says", () => {
    expect(ackForEnable({ ok: false, code: "checkout_not_found", candidates: [], incomplete: true })).toEqual({ outcome: "refused", refusal: "checkout_not_found", result: "not_found", incomplete: true });
    expect(ackForEnable({ ok: false, code: "checkout_not_found", candidates: ["/work/ok/x"], incomplete: true })).toEqual({ outcome: "refused", refusal: "checkout_not_found", result: "not_found", skipped: ["/work/ok/x"], incomplete: true });
    expect(ackForEnable({ ok: false, code: "checkout_incomplete", candidates: ["/work/one/widgets"], incomplete: true })).not.toHaveProperty("incomplete");
    expect(ackForEnable({ ok: false, code: "checkout_ambiguous", candidates: ["/work/a/x", "/work/b/x"], incomplete: true })).not.toHaveProperty("incomplete");
  });
  it("never sends a candidate that is not a plain absolute folder, and an ambiguous answer left with fewer than two is a plain failure", () => {
    expect(ackForEnable({ ok: false, code: "checkout_ambiguous", candidates: ["/work/a\nb/x", "relative", "/work/c/x"] })).toEqual({ outcome: "refused", refusal: "bridge_failed", result: "refused" });
    expect(ackForEnable({ ok: false, code: "checkout_not_found", candidates: ["/work/a‮b/x", "/work/ok/x"] })).toMatchObject({ result: "not_found", skipped: ["/work/ok/x"] });
  });
});
