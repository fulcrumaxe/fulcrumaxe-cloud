import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand } from "@fulcrumaxe/runner-protocol";
import { createCloudPost, CommandPuller, judge, PERMANENT_400_BACKOFF_S, SAFETY_PULL_MS, type InboxLoopDeps, type HaltOutcome } from "../../src/engineBridge/commands.js";
import { Inbox, notConfirmedDueMs } from "../../src/engineBridge/inbox.js";
import { generateRunnerKey } from "../../src/keys.js";
import { manualClock, until, type ManualClock } from "../helpers/manualClock.js";
import { startFakeCommands, type FakeCommands } from "../helpers/strictEngineCommands.js";

const REPO = 77;
const uid = process.getuid?.();

let dir: string;
let cloud: FakeCommands;
let clock: ManualClock;
let logs: string[];
let events: string[];
let halts: Array<{ repo: number; report: unknown }>;
let bridged: number[];
let epoch: number | null;
let handle: InboxLoopDeps["handleControl"];
let localStop: boolean;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-eb8b-"));
  chmodSync(dir, 0o700);
  cloud = await startFakeCommands();
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  clock = manualClock(Date.now());
  cloud.now = () => clock.now();
  cloud.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: true });
  logs = [];
  events = [];
  halts = [];
  bridged = [REPO];
  epoch = 1;
  handle = async () => undefined;
  localStop = false;
  postFor = createCloudPost({ origin: cloud.origin, key, now: () => clock.now(), fetchFn: fetch });
});
afterEach(async () => {
  await cloud.close();
  rmSync(dir, { recursive: true, force: true });
});
let postFor: ReturnType<typeof createCloudPost>;

function make(over: Partial<InboxLoopDeps> = {}) {
  const inbox = new Inbox(dir, uid);
  const post: InboxLoopDeps["post"] = async (p, b) => {
    events.push(`post ${p.includes("/ack") ? "ack" : "pull"}`);
    return postFor(p, b);
  };
  const puller = new CommandPuller({
    post,
    inbox,
    keyring: cloud.keyring,
    runnerId: cloud.runnerId,
    clock,
    bridgedRepos: () => bridged,
    wakeEpoch: () => epoch,
    localHalted: () => localStop,
    handleControl: (repo, control) => {
      events.push("handleControl");
      return handle(repo, control);
    },
    reportHalt: (repo, report) => void halts.push({ repo, report }),
    log: (l) => logs.push(l),
    ...over,
  });
  return { inbox, puller };
}
const inboxDir = (): string => path.join(dir, "engine-inbox");
const inboxFiles = (): string[] => (existsSync(inboxDir()) ? readdirSync(inboxDir()).filter((f) => f.endsWith(".json")) : []);
const queue = (...c: EngineCommand[]): void => void cloud.queue.push(...c);

describe("a valid command", () => {
  it("is written atomically to engine-inbox/<seq>-<id>.json at 0600, holds the verified command, and its seq and id are remembered", async () => {
    const { puller } = make();
    const c = cloud.command(REPO, 5, { kind: "answer_ask", args: { ask_id: "0123456789abcdef", choice: "approve" } });
    queue(c);
    await puller.pullOnce();
    expect(inboxFiles()).toEqual([`5-${c.command_id}.json`]);
    const file = path.join(inboxDir(), inboxFiles()[0]!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(inboxDir()).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(c);
    expect(readdirSync(inboxDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const state = path.join(dir, "engine-commands-state.json");
    expect(statSync(state).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({ repos: { [String(REPO)]: 5 }, seen: { [c.command_id]: expect.any(Number) } });
    expect(cloud.acks).toEqual([]);
    await clock.advance(WAIT_PAST_HOLD);
    await puller.pullOnce();
    expect(cloud.pulls.at(-1)!.after_seq).toEqual({ [String(REPO)]: 5 });
  });

  it("is acked with the outcome the engine left in done/, once", async () => {
    const { puller } = make();
    const c = cloud.command(REPO, 1);
    queue(c);
    await puller.pullOnce();
    const name = `1-${c.command_id}`;
    writeFileSync(path.join(inboxDir(), "done", `${name}.outcome.json`), JSON.stringify({ outcome: "refused", refusal: "unknown_agent" }), { mode: 0o600 });
    renameSync(path.join(inboxDir(), `${name}.json`), path.join(inboxDir(), "done", `${name}.json`));
    await puller.pullOnce();
    expect(cloud.acks).toEqual([{ id: c.command_id, ack: { outcome: "refused", refusal: "unknown_agent" } }]);
    expect(existsSync(path.join(inboxDir(), "done", `${name}.acked.json`))).toBe(true);
    expect(existsSync(path.join(inboxDir(), "done", `${name}.outcome.json`))).toBe(false);
    await puller.pullOnce();
    expect(cloud.acks).toHaveLength(1);
  });

  it("is acked not_confirmed and moved to done/ once the engine has not consumed it 10 minutes after its expiry", async () => {
    const { puller } = make();
    const c = cloud.command(REPO, 1);
    queue(c);
    await puller.pullOnce();
    await clock.advance(600_000 + 9 * 60_000);
    await puller.pullOnce();
    expect(cloud.acks).toEqual([]);
    expect(inboxFiles()).toHaveLength(1);
    await clock.advance(2 * 60_000);
    await puller.pullOnce();
    expect(cloud.acks).toEqual([{ id: c.command_id, ack: { outcome: "not_confirmed" } }]);
    expect(inboxFiles()).toEqual([]);
    expect(existsSync(path.join(inboxDir(), "done", `1-${c.command_id}.json`))).toBe(true);
  });

  it("settles a waiting file that cannot be read as not_confirmed once it is older than the longest command life plus 10 minutes (by its mtime)", async () => {
    const { puller, inbox } = make();
    inbox.ensure();
    const id = "5d1e0c2a-9b3f-4a7e-8c6d-2b4f6a8c0e1d";
    cloud.delivered.add(id);
    const file = path.join(inboxDir(), `4-${id}.json`);
    writeFileSync(file, "this is not json", { mode: 0o600 });
    await puller.pullOnce();
    await clock.advance(19 * 60_000);
    await puller.pullOnce();
    expect(cloud.acks).toEqual([]);
    expect(existsSync(file)).toBe(true);
    await clock.advance(2 * 60_000);
    await puller.pullOnce();
    expect(cloud.acks).toEqual([{ id, ack: { outcome: "not_confirmed" } }]);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.join(inboxDir(), "done", `4-${id}.acked.json`))).toBe(true);
  });

  it("an engine that rewrites the file, or sets a far-future expires_at, cannot keep it open: the time the runner recorded decides", async () => {
    const { puller } = make();
    const c = cloud.command(REPO, 1);
    queue(c);
    await puller.pullOnce();
    const file = path.join(inboxDir(), `1-${c.command_id}.json`);
    const farFuture = new Date(clock.now().getTime() + 30 * 86_400_000).toISOString();
    // Every few minutes the file is rewritten with a far-future expiry and a fresh mtime.
    for (let i = 0; i < 3; i++) {
      await clock.advance(5 * 60_000);
      writeFileSync(file, JSON.stringify({ ...c, expires_at: farFuture }));
      utimesSync(file, clock.now(), clock.now());
      await puller.pullOnce();
      expect(cloud.acks).toEqual([]);
    }
    // 15 minutes in: recorded time + 10 minutes of command life + 10 minutes is 20 minutes, and nothing the engine wrote moves it.
    await clock.advance(4 * 60_000);
    await puller.pullOnce();
    expect(cloud.acks).toEqual([]);
    await clock.advance(2 * 60_000);
    writeFileSync(file, JSON.stringify({ ...c, expires_at: farFuture }));
    utimesSync(file, clock.now(), clock.now());
    await puller.pullOnce();
    expect(cloud.acks).toEqual([{ id: c.command_id, ack: { outcome: "not_confirmed" } }]);
    expect(existsSync(file)).toBe(false);
  });

  it("notConfirmedDueMs: the recorded time wins over mtime, the file's expiry can only make it earlier, mtime is used only with no record", () => {
    const T = 1_000_000_000_000;
    const life = 600_000;
    const wait = 600_000;
    expect(notConfirmedDueMs({ expiresMs: T + 10 * 86_400_000, mtimeMs: T + 5 * 3_600_000 }, T)).toBe(T + life + wait);
    expect(notConfirmedDueMs({ expiresMs: T + 60_000, mtimeMs: T + 5 * 3_600_000 }, T)).toBe(T + 60_000 + wait);
    expect(notConfirmedDueMs({ expiresMs: null, mtimeMs: T + 5 * 3_600_000 }, T)).toBe(T + life + wait);
    // No record of the id: its mtime, still capped by a nearer expiry.
    expect(notConfirmedDueMs({ expiresMs: null, mtimeMs: T }, undefined)).toBe(T + life + wait);
    expect(notConfirmedDueMs({ expiresMs: T + 10 * 86_400_000, mtimeMs: T }, undefined)).toBe(T + life + wait);
    expect(notConfirmedDueMs({ expiresMs: T + 30_000, mtimeMs: T }, undefined)).toBe(T + 30_000 + wait);
  });

  it("settle checks the directories first: an unsafe done/ gets nothing written", () => {
    const inbox = new Inbox(dir, uid);
    inbox.ensure();
    chmodSync(path.join(inboxDir(), "done"), 0o770);
    expect(() => inbox.settle("1-0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10", { outcome: "not_confirmed" })).toThrow(/refused/);
    expect(readdirSync(path.join(inboxDir(), "done"))).toEqual([]);
  });
});
const WAIT_PAST_HOLD = 1_000;

describe("every refusal acks refused with its reason and writes nothing", () => {
  const refused = (c: { id: string }, reason: string): void => {
    expect(cloud.acks).toEqual([{ id: c.id, ack: { outcome: "refused", refusal: reason } }]);
    expect(inboxFiles()).toEqual([]);
  };

  it("signature: a command signed by another key", async () => {
    const c = cloud.command(REPO, 1);
    cloud.pullOverride = () => [cloud.signWithStranger(c)];
    cloud.delivered.add(c.command_id);
    await make().puller.pullOnce();
    refused({ id: c.command_id }, "signature_invalid");
  });

  it("signature: a command changed after it was signed, and one with no signature", async () => {
    const a = cloud.command(REPO, 1);
    const b = cloud.command(REPO, 2);
    const changed = { ...(cloud.sign(a) as object), command: { ...a, kind: "start_day" } };
    const unsigned = { command: b, key_id: "cmd-key-1" };
    cloud.pullOverride = () => [changed, unsigned];
    cloud.delivered.add(a.command_id).add(b.command_id);
    await make().puller.pullOnce();
    expect(cloud.acks.map((x) => x.ack)).toEqual([
      { outcome: "refused", refusal: "signature_invalid" },
      { outcome: "refused", refusal: "signature_invalid" },
    ]);
    expect(inboxFiles()).toEqual([]);
  });

  it("runner_id: a command made out to another runner", async () => {
    const c = cloud.command(REPO, 1, { runner_id: "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10" });
    queue(c);
    await make().puller.pullOnce();
    refused({ id: c.command_id }, "wrong_runner");
  });

  it("repo_gh_id: judged on its own, a repo this runner does not bridge", () => {
    const other = cloud.command(REPO + 1, 1);
    const verdict = judge(cloud.sign(other), { keyring: cloud.keyring, runnerId: cloud.runnerId, clock, localHalted: () => false }, new Set([REPO]), new Map(), {}, {});
    expect(verdict).toEqual({ ok: false, refusal: "wrong_repo" });
  });

  it("repo_gh_id: a signed command for another repo that the cloud sent anyway", async () => {
    const c = cloud.command(REPO + 1, 1);
    cloud.pullOverride = () => [cloud.sign(c)];
    cloud.delivered.add(c.command_id);
    await make().puller.pullOnce();
    refused({ id: c.command_id }, "wrong_repo");
  });

  it("operate: controls say operate is off, so even a valid command is refused", async () => {
    cloud.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: false });
    const c = cloud.command(REPO, 1);
    queue(c);
    await make().puller.pullOnce();
    refused({ id: c.command_id }, "operate_off");
  });

  it("operate: no control for the repo is operate off too (fail closed)", async () => {
    cloud.controls.delete(REPO);
    const c = cloud.command(REPO, 1);
    queue(c);
    await make().puller.pullOnce();
    refused({ id: c.command_id }, "operate_off");
  });

  it("expires_at: a command past its expiry, and one issued far ahead of the runner's clock", async () => {
    const past = cloud.command(REPO, 1, { issued_at: new Date(clock.now().getTime() - 700_000).toISOString(), expires_at: new Date(clock.now().getTime() - 100_000).toISOString() });
    const future = cloud.command(REPO, 2, { issued_at: new Date(clock.now().getTime() + 300_000).toISOString(), expires_at: new Date(clock.now().getTime() + 500_000).toISOString() });
    queue(past, future);
    await make().puller.pullOnce();
    expect(cloud.acks.map((a) => [a.id, a.ack])).toEqual([
      [past.command_id, { outcome: "refused", refusal: "expired" }],
      [future.command_id, { outcome: "refused", refusal: "expired" }],
    ]);
    expect(inboxFiles()).toEqual([]);
  });

  it("command_seq: not above the last one handed over for the repo", async () => {
    const { puller } = make();
    const first = cloud.command(REPO, 9);
    queue(first);
    await puller.pullOnce();
    await clock.advance(WAIT_PAST_HOLD);
    const stale = cloud.command(REPO, 9);
    cloud.pullOverride = () => [cloud.sign(stale)];
    cloud.delivered.add(stale.command_id);
    await puller.pullOnce();
    expect(cloud.acks).toEqual([{ id: stale.command_id, ack: { outcome: "refused", refusal: "seq_not_increasing" } }]);
    expect(inboxFiles()).toEqual([`9-${first.command_id}.json`]);
  });

  it("command_id: one seen in the last 24 hours, even with a higher seq", async () => {
    const { puller } = make();
    const first = cloud.command(REPO, 1);
    queue(first);
    await puller.pullOnce();
    const replay = cloud.command(REPO, 2, { command_id: first.command_id });
    cloud.pullOverride = () => [cloud.sign(replay)];
    await puller.pullOnce();
    expect(cloud.acks).toEqual([{ id: first.command_id, ack: { outcome: "refused", refusal: "seq_not_increasing" } }]);
    expect(inboxFiles()).toEqual([`1-${first.command_id}.json`]);
  });

  it("an id is forgotten after 24 hours (the seen-set does not grow for ever)", () => {
    const inbox = new Inbox(dir, uid);
    inbox.ensure();
    const t = Date.now();
    inbox.saveState({ repos: {}, seen: { "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10": t - 25 * 3_600_000, "5d1e0c2a-9b3f-4a7e-8c6d-2b4f6a8c0e1d": t - 3_600_000 } });
    expect(Object.keys(inbox.loadState(t).seen)).toEqual(["5d1e0c2a-9b3f-4a7e-8c6d-2b4f6a8c0e1d"]);
  });

  it("the first failure is the one named, in the Spec's order", () => {
    const base = { keyring: cloud.keyring, runnerId: cloud.runnerId, clock, localHalted: () => false };
    const both = cloud.command(REPO + 5, 1, { runner_id: "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10", expires_at: new Date(clock.now().getTime() + 1).toISOString() });
    expect(judge(cloud.signWithStranger(both), base, new Set([REPO]), new Map(), {}, {})).toEqual({ ok: false, refusal: "signature_invalid" });
    expect(judge(cloud.sign(both), base, new Set([REPO]), new Map(), {}, {})).toEqual({ ok: false, refusal: "wrong_runner" });
    const repoAndOperate = cloud.command(REPO + 5, 1);
    expect(judge(cloud.sign(repoAndOperate), base, new Set([REPO]), new Map(), {}, {})).toEqual({ ok: false, refusal: "wrong_repo" });
    const operateAndExpired = cloud.command(REPO, 1, { issued_at: new Date(clock.now().getTime() - 700_000).toISOString(), expires_at: new Date(clock.now().getTime() - 100_000).toISOString() });
    expect(judge(cloud.sign(operateAndExpired), base, new Set([REPO]), new Map([[REPO, { operate_enabled: false, halted: false, halt_epoch: 0 }]]), {}, {})).toEqual({ ok: false, refusal: "operate_off" });
    expect(judge(cloud.sign(operateAndExpired), base, new Set([REPO]), new Map([[REPO, { operate_enabled: true, halted: false, halt_epoch: 0 }]]), { [String(REPO)]: 9 }, {})).toEqual({ ok: false, refusal: "expired" });
  });
});

describe("halt controls", () => {
  it("run the kill path before any command of the pull is written, and report halt_applied", async () => {
    cloud.controls.set(REPO, { halt_epoch: 4, halted: true, operate_enabled: true });
    const c = cloud.command(REPO, 1, { kind: "pause_loop" });
    queue(c);
    const seen: Array<{ repo: number; control: unknown }> = [];
    handle = async (repo, control) => {
      seen.push({ repo, control });
      events.push(`files:${inboxFiles().length}`);
      return { halt_epoch: 4, method: "scope", survivors: 0 } satisfies HaltOutcome;
    };
    await make().puller.pullOnce();
    expect(seen).toEqual([{ repo: REPO, control: { halt_epoch: 4, halted: true } }]);
    expect(events.slice(events.indexOf("handleControl"), events.indexOf("handleControl") + 2)).toEqual(["handleControl", "files:0"]);
    expect(halts).toEqual([{ repo: REPO, report: { halt_epoch: 4, method: "scope", survivors: 0 } }]);
    expect(inboxFiles()).toEqual([`1-${c.command_id}.json`]);
  });

  it("report a halt that could not be checked as one survivor, never none, and refuse the pull's commands for that repo", async () => {
    cloud.controls.set(REPO, { halt_epoch: 2, halted: true, operate_enabled: true });
    const c = cloud.command(REPO, 1);
    queue(c);
    handle = async () => {
      throw new Error("kill path failed");
    };
    await make().puller.pullOnce();
    expect(halts).toEqual([{ repo: REPO, report: { halt_epoch: 2, method: "group_only", survivors: 1 } }]);
    expect(cloud.acks).toEqual([{ id: c.command_id, ack: { outcome: "refused", refusal: "halted" } }]);
    expect(inboxFiles()).toEqual([]);
    expect(logs.join("\n")).not.toContain("kill path failed");
  });

  it("report method none as group_only with at least one survivor, and a count the handler cannot make as 1", async () => {
    cloud.controls.set(REPO, { halt_epoch: 3, halted: true, operate_enabled: true });
    handle = async () => ({ halt_epoch: 3, method: "none", survivors: 0 });
    await make().puller.pullOnce();
    expect(halts.at(-1)!.report).toEqual({ halt_epoch: 3, method: "group_only", survivors: 1 });
    handle = async () => ({ halt_epoch: 3, method: "group_only", survivors: Number.NaN });
    cloud.controls.set(REPO, { halt_epoch: 3, halted: true, operate_enabled: true });
    await clock.advance(WAIT_PAST_HOLD);
    await make().puller.pullOnce();
    expect(halts.at(-1)!.report).toEqual({ halt_epoch: 3, method: "group_only", survivors: 1 });
  });

  it("report nothing when the handler applied no halt", async () => {
    await make().puller.pullOnce();
    expect(halts).toEqual([]);
  });
});

describe("start-like commands while a halt is in force", () => {
  const START_LIKE: Array<Partial<EngineCommand>> = [
    { kind: "start_day", args: {} },
    { kind: "resume_loop", args: {} },
    { kind: "request_spawn", args: { role: "executor", discussion: 12 } },
    { kind: "set_dial", args: { dial_class: "docs.write", level: 2, ttl: "for_today" } },
  ] as Array<Partial<EngineCommand>>;
  const live = { operate_enabled: true, halted: false, halt_epoch: 3 };
  const deps = (localHalted: boolean) => ({ keyring: cloud.keyring, runnerId: cloud.runnerId, clock, localHalted: () => localHalted });

  it("are refused halted when the repo's control says halted", () => {
    for (const over of START_LIKE) {
      const c = cloud.command(REPO, 1, { ...over, halt_epoch: 3 });
      expect(judge(cloud.sign(c), deps(false), new Set([REPO]), new Map([[REPO, { ...live, halted: true }]]), {}, {})).toEqual({ ok: false, refusal: "halted" });
      expect(judge(cloud.sign(c), deps(false), new Set([REPO]), new Map([[REPO, live]]), {}, {})).toMatchObject({ ok: true });
    }
  });

  it("are refused halted when a local stop is in force", () => {
    for (const over of START_LIKE) {
      const c = cloud.command(REPO, 1, { ...over, halt_epoch: 3 });
      expect(judge(cloud.sign(c), deps(true), new Set([REPO]), new Map([[REPO, live]]), {}, {})).toEqual({ ok: false, refusal: "halted" });
    }
  });

  it("are refused halted when they were made before the halt (a lower halt_epoch)", () => {
    for (const over of START_LIKE) {
      const c = cloud.command(REPO, 1, { ...over, halt_epoch: 2 });
      expect(judge(cloud.sign(c), deps(false), new Set([REPO]), new Map([[REPO, live]]), {}, {})).toEqual({ ok: false, refusal: "halted" });
    }
  });

  it("do not stop the kinds that only stop or answer", () => {
    for (const over of [{ kind: "pause_loop", args: {} }, { kind: "stop_agent", args: { agent_id: "executor-1" } }] as Array<Partial<EngineCommand>>) {
      const c = cloud.command(REPO, 1, { ...over, halt_epoch: 0 });
      expect(judge(cloud.sign(c), deps(true), new Set([REPO]), new Map([[REPO, { ...live, halted: true }]]), {}, {})).toMatchObject({ ok: true });
    }
  });

  it("a local-stop reader that throws counts as halted: start-like kinds are refused, and the rest of the reply is handled as usual", async () => {
    const start = cloud.command(REPO, 1, { kind: "start_day", args: {}, halt_epoch: 0 });
    const pause = cloud.command(REPO, 2, { kind: "pause_loop", args: {}, halt_epoch: 0 });
    queue(start, pause);
    const { puller } = make({
      localHalted: () => {
        throw new Error("/secret/state/path unreadable");
      },
    });
    await puller.pullOnce();
    // The start-like command is refused, and the ack went out; the pause was written; no pull-level failure was logged.
    expect(cloud.acks).toEqual([{ id: start.command_id, ack: { outcome: "refused", refusal: "halted" } }]);
    expect(inboxFiles()).toEqual([`2-${pause.command_id}.json`]);
    expect(puller.status()).toEqual({ state: "idle", why: null });
    expect(logs.join("\n")).not.toContain("secret");
    // after_seq advanced past the written command.
    await clock.advance(WAIT_PAST_HOLD);
    await puller.pullOnce();
    expect(cloud.pulls.at(-1)!.after_seq).toEqual({ [String(REPO)]: 2 });
  });

  it("judge itself answers halted (not a throw) for a start-like kind when the reader throws", () => {
    const c = cloud.command(REPO, 1, { kind: "start_day", args: {}, halt_epoch: 3 });
    const throwing = { keyring: cloud.keyring, runnerId: cloud.runnerId, clock, localHalted: (): boolean => { throw new Error("boom"); } };
    expect(judge(cloud.sign(c), throwing, new Set([REPO]), new Map([[REPO, live]]), {}, {})).toEqual({ ok: false, refusal: "halted" });
    const p = cloud.command(REPO, 2, { kind: "pause_loop", args: {}, halt_epoch: 3 });
    expect(judge(cloud.sign(p), throwing, new Set([REPO]), new Map([[REPO, live]]), {}, {})).toMatchObject({ ok: true });
  });

  it("through a pull: a start_day under a halted control is acked halted and never written", async () => {
    cloud.controls.set(REPO, { halt_epoch: 1, halted: true, operate_enabled: true });
    const c = cloud.command(REPO, 1, { kind: "start_day", args: {}, halt_epoch: 1 });
    queue(c);
    await make().puller.pullOnce();
    expect(cloud.acks).toEqual([{ id: c.command_id, ack: { outcome: "refused", refusal: "halted" } }]);
    expect(inboxFiles()).toEqual([]);
  });
});

describe("the inbox directory is checked", () => {
  const LINE = "engine-inbox: the inbox directory is not safe (a link, someone else's, or open to others); nothing was written";

  it("refuses a symlinked inbox directory: one fixed line, nothing written through it", async () => {
    const target = mkdtempSync(path.join(tmpdir(), "fx-eb8b-target-"));
    symlinkSync(target, inboxDir());
    const { puller } = make();
    const a = cloud.command(REPO, 1);
    queue(a);
    await puller.pullOnce();
    await clock.advance(WAIT_PAST_HOLD);
    const b = cloud.command(REPO, 2);
    queue(b);
    await puller.pullOnce();
    expect(readdirSync(target)).toEqual([]);
    expect(logs.filter((l) => l === LINE)).toHaveLength(1);
    expect(statSync(path.join(dir, "engine-commands-state.json"), { throwIfNoEntry: false })).toBeUndefined();
    rmSync(target, { recursive: true, force: true });
  });

  it("refuses an inbox directory wider than 0700, and a done/ directory wider than 0700", async () => {
    mkdirSync(inboxDir(), { mode: 0o755 });
    chmodSync(inboxDir(), 0o755);
    queue(cloud.command(REPO, 1));
    await make().puller.pullOnce();
    expect(readdirSync(inboxDir())).toEqual([]);
    expect(logs).toContain(LINE);
    chmodSync(inboxDir(), 0o700);
    mkdirSync(path.join(inboxDir(), "done"), { mode: 0o770 });
    chmodSync(path.join(inboxDir(), "done"), 0o770);
    logs.length = 0;
    await clock.advance(WAIT_PAST_HOLD);
    queue(cloud.command(REPO, 2));
    await make().puller.pullOnce();
    expect(inboxFiles()).toEqual([]);
    expect(logs).toContain(LINE);
  });

  it("makes the directories at 0700 when they are missing", async () => {
    queue(cloud.command(REPO, 1));
    await make().puller.pullOnce();
    expect(statSync(inboxDir()).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(inboxDir(), "done")).mode & 0o777).toBe(0o700);
  });
});

describe("failures of the cloud", () => {
  it("a permanent 400 on a pull backs off for 300 s and shows why", async () => {
    cloud.faults.push({ status: 400, body: { error: "invalid_message" } });
    const { puller } = make();
    await puller.pullOnce();
    expect(puller.status()).toEqual({ state: "backoff", why: "refused" });
    const pulls = cloud.pulls.length;
    await clock.advance((PERMANENT_400_BACKOFF_S - 5) * 1000);
    await puller.pullOnce();
    expect(cloud.pulls.length).toBe(pulls);
    await clock.advance(10_000);
    await puller.pullOnce();
    expect(cloud.pulls.length).toBe(pulls + 1);
    expect(puller.status()).toEqual({ state: "idle", why: null });
  });

  it("a permanent 400 on an ack is never dropped: it is sent again after 300 s", async () => {
    const c = cloud.command(REPO, 1, { runner_id: "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10" });
    queue(c);
    const { puller } = make();
    const real = postFor;
    let acks = 0;
    postFor = async (p, b) => {
      if (p.includes("/ack") && acks++ === 0) return { status: 400, body: { error: "invalid_message" }, retryAfter: undefined, protectedDeployment: false };
      return real(p, b);
    };
    await puller.pullOnce();
    expect(puller.status()).toEqual({ state: "backoff", why: "refused" });
    expect(cloud.acks).toEqual([]);
    await clock.advance(PERMANENT_400_BACKOFF_S * 1000 + 1000);
    await puller.pullOnce();
    expect(cloud.acks).toEqual([{ id: c.command_id, ack: { outcome: "refused", refusal: "wrong_runner" } }]);
    expect(puller.status().state).toBe("idle");
  });

  describe("a failed ack never blocks halt delivery", () => {
    const answers: Array<[string, (real: typeof postFor) => typeof postFor]> = [
      ["400", () => async () => ({ status: 400, body: { error: "invalid_message" }, retryAfter: undefined, protectedDeployment: false })],
      ["500", () => async () => ({ status: 500, body: undefined, retryAfter: undefined, protectedDeployment: false })],
      // A request that times out reaches the runner as status 0, as createCloudPost answers when the fetch is aborted.
      ["a timeout", () => async () => ({ status: 0, body: undefined, retryAfter: undefined, protectedDeployment: false })],
    ];
    for (const [label, broken] of answers) {
      it(`with the ack answered ${label}, a halted control at a higher epoch still reaches handleControl on the next pass, and the ack is kept for later`, async () => {
        const stray = cloud.command(REPO, 1, { runner_id: "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10" });
        queue(stray);
        const { puller } = make();
        const real = postFor;
        const failing = broken(real);
        postFor = async (p, b) => (p.includes("/ack") ? failing(p, b) : real(p, b));
        await puller.pullOnce();
        expect(cloud.acks).toEqual([]);
        expect(puller.status().state).toBe("backoff");
        const seen: Array<{ repo: number; control: unknown }> = [];
        handle = async (repo, control) => {
          seen.push({ repo, control });
          return { halt_epoch: 5, method: "scope", survivors: 0 };
        };
        cloud.controls.set(REPO, { halt_epoch: 5, halted: true, operate_enabled: true });
        await clock.advance(WAIT_PAST_HOLD);
        const pulls = cloud.pulls.length;
        await puller.pullOnce();
        expect(cloud.pulls.length).toBe(pulls + 1);
        expect(seen).toEqual([{ repo: REPO, control: { halt_epoch: 5, halted: true } }]);
        expect(halts).toEqual([{ repo: REPO, report: { halt_epoch: 5, method: "scope", survivors: 0 } }]);
        // The owed ack is still owed, and goes out once the cloud takes acks again.
        postFor = real;
        await clock.advance(PERMANENT_400_BACKOFF_S * 1000 + 1000);
        await puller.pullOnce();
        expect(cloud.acks).toEqual([{ id: stray.command_id, ack: { outcome: "refused", refusal: "wrong_runner" } }]);
        expect(puller.status()).toEqual({ state: "idle", why: null });
      });
    }
  });

  it("an unreachable cloud and a 500 wait 2, 4, 8 s and so on, up to 300 s, and one good pull resets it", async () => {
    const { puller } = make();
    const posts = (): number => events.filter((e) => e === "post pull").length;
    for (const wait of [2, 4, 8, 16, 32, 64, 128, 256, 300, 300]) {
      cloud.faults.push(wait % 4 === 0 ? { status: 500 } : "drop");
      const before = posts();
      await puller.pullOnce();
      expect(posts()).toBe(before + 1);
      await clock.advance((wait - 1) * 1000);
      await puller.pullOnce();
      expect(posts()).toBe(before + 1);
      await clock.advance(1000);
      expect(puller.status().state).toBe("backoff");
    }
    await puller.pullOnce();
    expect(puller.status()).toEqual({ state: "idle", why: null });
  });

  it("a wrong shape in a 200 is a failure, not trusted", async () => {
    cloud.pullOverride = () => Array.from({ length: 21 }, () => ({}));
    const { puller } = make();
    await puller.pullOnce();
    expect(puller.status()).toEqual({ state: "backoff", why: "unexpected" });
    expect(inboxFiles()).toEqual([]);
  });

  it("asks nothing when the runner bridges no repo", async () => {
    bridged = [];
    await make().puller.pullOnce();
    expect(cloud.pulls).toEqual([]);
  });
});

describe("the loop", () => {
  it("pulls at once, when the wake epoch moves, and every 20 s as a safety net", async () => {
    const { puller } = make();
    const controller = new AbortController();
    const done = puller.run(controller.signal);
    await until(() => cloud.pulls.length === 1);
    await clock.advance(5_000);
    expect(cloud.pulls).toHaveLength(1);
    epoch = 2;
    await clock.advance(1_000);
    await until(() => cloud.pulls.length === 2);
    await clock.advance(SAFETY_PULL_MS - 2_000);
    expect(cloud.pulls).toHaveLength(2);
    await clock.advance(3_000);
    await until(() => cloud.pulls.length === 3);
    controller.abort();
    await done;
  });

  it("keeps going after a pull that throws", async () => {
    const { puller } = make({
      handleControl: async () => {
        throw Object.assign(new Error("x"), { applied: { halt_epoch: 1, method: "scope", survivors: 0 } });
      },
    });
    cloud.controls.set(REPO, { halt_epoch: 1, halted: true, operate_enabled: true });
    const controller = new AbortController();
    const done = puller.run(controller.signal);
    await until(() => halts.length >= 1);
    expect(halts[0]!.report).toEqual({ halt_epoch: 1, method: "scope", survivors: 0 });
    controller.abort();
    await done;
  });
});
