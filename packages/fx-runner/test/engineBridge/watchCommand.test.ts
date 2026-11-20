import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_COMMAND_KINDS, isBridgeCommandKind, type EngineCommand, type EngineCommandOf } from "@fulcrumaxe/runner-protocol";
import { createCloudPost, CommandPuller, judge, type InboxLoopDeps } from "../../src/engineBridge/commands.js";
import { Inbox } from "../../src/engineBridge/inbox.js";
import { generateRunnerKey } from "../../src/keys.js";
import { manualClock, type ManualClock } from "../helpers/manualClock.js";
import { startFakeCommands, type FakeCommands } from "../helpers/strictEngineCommands.js";

/**
 * D#845 watch mode, the `watch` command at the runner (follow-up 12). It is judged like any command, but operate being off does not refuse it (and only it), it is applied to the
 * bridge's own watch state through `onWatch`, it never reaches an inbox, and its `until` is held to the runner's own clock.
 */
const REPO = 77;
const uid = process.getuid?.();

let dir: string;
let cloud: FakeCommands;
let clock: ManualClock;
let applied: Array<{ repo: number; until: string; before: number | undefined }>;
let logs: string[];
let postFor: ReturnType<typeof createCloudPost>;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-watch-cmd-"));
  chmodSync(dir, 0o700);
  cloud = await startFakeCommands();
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  clock = manualClock(Date.now());
  cloud.now = () => clock.now();
  cloud.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: true });
  applied = [];
  logs = [];
  postFor = createCloudPost({ origin: cloud.origin, key, now: () => clock.now(), fetchFn: fetch });
});
afterEach(async () => {
  await cloud.close();
  rmSync(dir, { recursive: true, force: true });
});

const make = (over: Partial<InboxLoopDeps> = {}) =>
  new CommandPuller({
    post: postFor,
    inbox: new Inbox(dir, uid),
    keyring: cloud.keyring,
    runnerId: cloud.runnerId,
    clock,
    bridgedRepos: () => [REPO],
    wakeEpoch: () => 1,
    localHalted: () => false,
    handleControl: async () => undefined,
    reportHalt: () => undefined,
    onWatch: (repo, command) => void applied.push({ repo, until: command.args.until, before: command.args.before }),
    log: (l) => logs.push(l),
    ...over,
  });
const inboxFiles = (): string[] => (existsSync(path.join(dir, "engine-inbox")) ? readdirSync(path.join(dir, "engine-inbox")).filter((f) => f.endsWith(".json")) : []);
const watchCmd = (seq: number, untilFromNowMs: number, args: Partial<EngineCommandOf<"watch">["args"]> = {}, over: Partial<EngineCommand> = {}): EngineCommand => {
  const issued = clock.now();
  return cloud.command(REPO, seq, { kind: "watch", issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 600_000).toISOString(), args: { until: new Date(issued.getTime() + untilFromNowMs).toISOString(), ...args }, ...over } as Partial<EngineCommand>);
};
const bareJudge = (cmd: EngineCommand, controls: Map<number, { operate_enabled: boolean; halted: boolean; halt_epoch: number }>) =>
  judge(cloud.sign(cmd), { keyring: cloud.keyring, runnerId: cloud.runnerId, clock, localHalted: () => false }, new Set([REPO]), controls, {}, {});

describe("a watch command at the runner", () => {
  it("is applied to the watch state, acked applied, recorded as seen, and never written to an inbox", async () => {
    const c = watchCmd(3, 300_000, { before: 41 });
    cloud.queue.push(c);
    await make().pullOnce();
    expect(applied).toEqual([{ repo: REPO, until: (c as EngineCommandOf<"watch">).args.until, before: 41 }]);
    expect(cloud.acks).toEqual([{ id: c.command_id, ack: { outcome: "applied" } }]);
    expect(inboxFiles()).toEqual([]);
    const next = make();
    await clock.advance(1_000);
    await next.pullOnce();
    // The next pull asks above seq 3: a watch counts for the repo's sequence like any command.
    expect(cloud.pulls.at(-1)!.after_seq).toEqual({ [String(REPO)]: 3 });
  });

  it("is applied while operate is off (ruling 11): it changes only how much is uploaded", async () => {
    cloud.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: false });
    const c = watchCmd(1, 120_000);
    cloud.queue.push(c);
    await make().pullOnce();
    expect(applied).toHaveLength(1);
    expect(cloud.acks).toEqual([{ id: c.command_id, ack: { outcome: "applied" } }]);
  });

  it("is applied while the repo is halted: a halt stops starting things, never looking", async () => {
    cloud.controls.set(REPO, { halt_epoch: 2, halted: true, operate_enabled: true });
    const c = watchCmd(1, 120_000, {}, { halt_epoch: 1 });
    cloud.queue.push(c);
    await make({ localHalted: () => true }).pullOnce();
    expect(applied).toHaveLength(1);
  });

  it("the operate exemption is the watch's alone: every other kind the engine takes is still refused operate_off", () => {
    const off = new Map([[REPO, { operate_enabled: false, halted: false, halt_epoch: 0 }]]);
    const arguments_: Record<string, unknown> = {
      start_day: {}, pause_loop: {}, resume_loop: {},
      answer_ask: { ask_id: "0123456789abcdef", choice: "approve" },
      set_dial: { dial_class: "docs.write", level: 3, ttl: "none" },
      request_spawn: { role: "executor", discussion: 5 },
      stop_agent: { agent_id: "a1" },
    };
    const engineKinds = ENGINE_COMMAND_KINDS.filter((k) => k !== "watch" && !isBridgeCommandKind(k));
    expect(engineKinds.length).toBeGreaterThanOrEqual(7);
    for (const kind of engineKinds) expect(bareJudge(cloud.command(REPO, 1, { kind, args: arguments_[kind] } as Partial<EngineCommand>), off), kind).toEqual({ ok: false, refusal: "operate_off" });
    expect(bareJudge(watchCmd(1, 120_000), off).ok).toBe(true);
  });

  it("with no control for the repo at all it is still judged (the cloud decides who may watch), and the other kinds fail closed", () => {
    expect(bareJudge(watchCmd(1, 120_000), new Map()).ok).toBe(true);
    expect(bareJudge(cloud.command(REPO, 1), new Map())).toEqual({ ok: false, refusal: "operate_off" });
  });

  it.each([
    ["an until already past on the runner's clock (the issuer's clock was behind)", -499_000, -500_000, "expired"],
    ["an until more than 600 s ahead on the runner's clock (the issuer's clock was ahead)", 630_000, 30_000, "expired"],
  ] as const)("is refused expired for %s", async (_name, untilFromNow, issuedFromNow, refusal) => {
    const issued = new Date(clock.now().getTime() + issuedFromNow);
    const c = cloud.command(REPO, 1, { kind: "watch", issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 600_000).toISOString(), args: { until: new Date(clock.now().getTime() + untilFromNow).toISOString() } } as Partial<EngineCommand>);
    cloud.queue.push(c);
    await make().pullOnce();
    expect(applied).toEqual([]);
    expect(cloud.acks).toEqual([{ id: c.command_id, ack: { outcome: "refused", refusal } }]);
  });

  it("an until exactly 600 s ahead is applied and one a millisecond past it is not", () => {
    const edge = bareJudge(watchCmd(1, 600_000), new Map());
    expect(edge.ok).toBe(true);
    const issued = new Date(clock.now().getTime() + 1_000);
    const over = cloud.command(REPO, 1, { kind: "watch", issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 600_000).toISOString(), args: { until: new Date(clock.now().getTime() + 600_001).toISOString() } } as Partial<EngineCommand>);
    expect(bareJudge(over, new Map())).toEqual({ ok: false, refusal: "expired" });
  });

  it("a repeat of the same sequence, and a second use of the same id, are refused and apply nothing", async () => {
    const puller = make();
    const first = watchCmd(5, 120_000);
    cloud.queue.push(first);
    await puller.pullOnce();
    expect(applied).toHaveLength(1);
    const again = watchCmd(5, 200_000);
    const sameId = watchCmd(9, 200_000, {}, { command_id: first.command_id });
    cloud.pullOverride = () => [cloud.sign(again), cloud.sign(sameId)];
    cloud.delivered.add(again.command_id).add(sameId.command_id);
    await clock.advance(1_000);
    await puller.pullOnce();
    expect(applied).toHaveLength(1);
    // The repeated sequence is acked refused; the reused id names a command already acked, which the cloud answers 409 and keeps as it was.
    expect(cloud.acks.slice(1).map((a) => [a.id, a.ack])).toEqual([[again.command_id, { outcome: "refused", refusal: "seq_not_increasing" }]]);
    expect(cloud.acks[0]!.ack).toEqual({ outcome: "applied" });
  });

  it("is refused wrong_repo for a repo this runner does not bridge", async () => {
    const c = cloud.command(REPO + 1, 1, { kind: "watch", args: { until: new Date(clock.now().getTime() + 60_000).toISOString() } } as Partial<EngineCommand>);
    cloud.pullOverride = () => [cloud.sign(c)];
    cloud.delivered.add(c.command_id);
    await make().pullOnce();
    expect(applied).toEqual([]);
    expect(cloud.acks).toEqual([{ id: c.command_id, ack: { outcome: "refused", refusal: "wrong_repo" } }]);
  });

  it("with no watch handler wired it is refused wrong_repo, never written to an inbox", async () => {
    const c = watchCmd(1, 120_000);
    cloud.queue.push(c);
    await make({ onWatch: undefined }).pullOnce();
    expect(inboxFiles()).toEqual([]);
    expect(cloud.acks).toEqual([{ id: c.command_id, ack: { outcome: "refused", refusal: "wrong_repo" } }]);
  });

  it("a handler that throws applies nothing: refused wrong_repo, one fixed line, the pull goes on", async () => {
    const c = watchCmd(1, 120_000);
    const next = cloud.command(REPO, 2);
    cloud.queue.push(c, next);
    await make({ onWatch: () => { throw new Error("/secret/path"); } }).pullOnce();
    expect(cloud.acks.find((a) => a.id === c.command_id)!.ack).toEqual({ outcome: "refused", refusal: "wrong_repo" });
    expect(logs).toContain("engine-inbox: a watch could not be applied");
    expect(logs.join("\n")).not.toContain("secret");
    expect(inboxFiles()).toEqual([`2-${next.command_id}.json`]);
  });

  it("is judged with a signature first: an unsigned or re-signed watch is signature_invalid", () => {
    const c = watchCmd(1, 120_000);
    expect(judge(cloud.signWithStranger(c), { keyring: cloud.keyring, runnerId: cloud.runnerId, clock, localHalted: () => false }, new Set([REPO]), new Map(), {}, {})).toEqual({ ok: false, refusal: "signature_invalid" });
  });
});
