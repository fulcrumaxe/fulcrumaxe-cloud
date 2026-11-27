import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEngineBridge, type EngineBridge, type EngineBridgeDeps, type EngineBridgePorts } from "../../src/engineBridge/daemon.js";
import { createEventsUploader } from "../../src/engineBridge/upload.js";
import { createSessionRegistry, type SessionEntry, type SessionRegistry } from "../../src/engineSession/registry.js";
import { generateRunnerKey } from "../../src/keys.js";
import { engineLine, fakeGuest, hostEventLine, INSTANCE_E, INSTANCE_H, type FakeGuest } from "../helpers/fakeGuestStreams.js";
import { manualClock, type ManualClock } from "../helpers/manualClock.js";
import { startFakeCommands, type FakeCommands } from "../helpers/strictEngineCommands.js";
import { startStrictEngineIngest, type StrictEngineIngest } from "../helpers/strictEngineIngest.js";

/**
 * D#845 ON-14a: an engine session's repository through the whole bridge daemon: the session registry (not a settings file) names it, the strict fake cloud judges what is sent and what is acked, and the guest is the fake channel (`fakeGuestStreams.ts`).
 * The host has no directory for the repo in any of these tests; a ceiling keeper, a halt path or a bridge-state file would need one.
 */
const REPO = 77;
const NAME = "acme/widgets";
const uid = process.getuid?.();

let root: string;
let runnerDir: string;
let missingStateDir: string;
let xdg: string;
let ingest: StrictEngineIngest;
let cmds: FakeCommands;
let clock: ManualClock;
let key: ReturnType<typeof generateRunnerKey>;
let logs: string[];
let bridge: EngineBridge | undefined;
let sessions: SessionRegistry;
let guest: FakeGuest;
let hostTouched: string[];

const ports = (): EngineBridgePorts => ({
  halt: {
    handleControl: async (dir) => void hostTouched.push(`halt:${dir}`) as undefined,
    readHostHandle: (dir) => void hostTouched.push(`handle:${dir}`) as undefined,
    readHaltState: (dir) => void hostTouched.push(`haltstate:${dir}`) as undefined,
  },
  ceiling: { create: () => (hostTouched.push("ceiling"), { run: async () => undefined, controlsChanged: () => undefined, status: () => null }) },
});
const entry = (over: Partial<SessionEntry> = {}): SessionEntry => ({ repo_gh_id: REPO, job_id: "job-1", engine_version: "1.2.3", fresh: false, channel: guest.channel, ...over });

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fx-on14a-"));
  runnerDir = path.join(root, "runner");
  xdg = path.join(root, "x");
  missingStateDir = path.join(root, "no-such-engine-state");
  for (const d of [runnerDir, xdg]) mkdirSync(d, { mode: 0o700 });
  key = generateRunnerKey();
  ingest = await startStrictEngineIngest();
  cmds = await startFakeCommands();
  ingest.trust(key.publicJwk);
  cmds.trust(key.publicJwk);
  clock = manualClock(Date.now());
  ingest.now = () => clock.now();
  cmds.now = () => clock.now();
  cmds.allowedRepos = [{ repo_gh_id: REPO, full_name: NAME }];
  cmds.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: true });
  logs = [];
  hostTouched = [];
  bridge = undefined;
  sessions = createSessionRegistry();
  guest = fakeGuest();
});
afterEach(async () => {
  await bridge?.stop();
  await ingest.close();
  await cmds.close();
  rmSync(root, { recursive: true, force: true });
});

function start(over: Partial<EngineBridgeDeps> = {}): EngineBridge {
  const cloud = { origin: cmds.origin, key, now: () => clock.now(), fetchFn: fetch };
  bridge = startEngineBridge({ runnerStateDir: runnerDir, uid, clock, runnerVersion: "0.1.1", cloud, keyring: cmds.keyring, runnerId: cmds.runnerId, send: createEventsUploader({ ...cloud, origin: ingest.origin }), wakeEpoch: () => null, accepted: () => true, xdgRuntimeDir: xdg, secrets: () => [], ports: ports(), sessions, log: (l) => logs.push(l), ...over });
  return bridge;
}
async function advanceUntil(cond: () => boolean, stepMs = 2000, max = 120): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) {
    await clock.advance(stepMs, stepMs);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (let since = Date.now(); !cond() && Date.now() - since < 15_000; ) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!cond()) throw new Error("condition never held");
}
const passTime = async (ms: number, step = 2000): Promise<void> => {
  for (let done = 0; done < ms; done += step) {
    await clock.advance(step, step);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const cursorDir = (): string => path.join(runnerDir, "engine-bridge");

describe("a session repository is bridged from the registry alone", () => {
  it("uploads the engine's own stream and the host's, with a cursor for each in the runner's directory, and touches no host path", async () => {
    guest.append("engine", engineLine(0) + engineLine(1));
    guest.append("events", hostEventLine(0) + hostEventLine(1));
    sessions.register(entry());
    start();
    await advanceUntil(() => ingest.seqsOf(INSTANCE_E).length === 2 && ingest.seqsOf(INSTANCE_H).length === 2);
    await advanceUntil(() => existsSync(path.join(cursorDir(), `${REPO}.session-engine.cursor.json`)) && existsSync(path.join(cursorDir(), `${REPO}.session-events.cursor.json`)));
    expect(new Set(guest.reads.map((r) => r.stream))).toEqual(new Set(["engine", "events", "outcomes"]));
    expect(hostTouched).toEqual([]); // no ceiling keeper, no halt path, no state directory
    expect(existsSync(missingStateDir)).toBe(false);
    expect(bridge!.status().repos).toMatchObject([{ repo_gh_id: REPO, full_name: "engine session", run: "running", reason: null, upload: { lastAckedSeq: 1 }, ceiling: null }]);
    expect(logs.join("\n")).not.toContain(root);
  });

  it("the cloud's list is checked by the start job's repository id alone: another name still starts, a list without the id never does", async () => {
    guest.append("engine", engineLine(0));
    cmds.allowedRepos = [{ repo_gh_id: REPO, full_name: "someone/renamed" }];
    sessions.register(entry());
    start();
    await advanceUntil(() => ingest.seqsOf(INSTANCE_E).length === 1);
    await bridge!.stop();
    cmds.allowedRepos = [{ repo_gh_id: 78, full_name: NAME }];
    const other = fakeGuest();
    other.append("engine", engineLine(0, "2b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10"));
    sessions.register(entry({ job_id: "job-2", channel: other.channel }));
    start();
    await advanceUntil(() => bridge!.status().repos[0]?.reason === "not_allowed");
    await passTime(30_000);
    expect(other.far.requests).toHaveLength(0);
    expect(bridge!.status().repos[0]).toMatchObject({ run: "refused", reason: "not_allowed" });
  });

  it("does not start without an engine version from the signed job, or with one that is not a version", async () => {
    sessions.register(entry({ engine_version: undefined }));
    start();
    await advanceUntil(() => bridge!.status().repos[0]?.reason === "engine_version");
    sessions.register(entry({ job_id: "job-2", engine_version: "latest" }));
    await passTime(12_000);
    expect(bridge!.status().repos[0]).toMatchObject({ run: "refused", reason: "engine_version" });
    expect(guest.far.requests).toHaveLength(0);
  });

  it("a session that ends stops its loops and clears its detail; a replaced one is read through the new channel", async () => {
    guest.append("engine", engineLine(0));
    sessions.register(entry());
    start();
    await advanceUntil(() => ingest.seqsOf(INSTANCE_E).length === 1);
    const replacement = fakeGuest();
    sessions.register(entry({ job_id: "job-2", channel: replacement.channel }));
    await advanceUntil(() => replacement.reads.length > 0);
    const before = guest.far.requests.length;
    await passTime(10_000);
    expect(guest.far.requests.length).toBe(before); // the old channel is not asked again
    sessions.clear(REPO, "job-2");
    await advanceUntil(() => logs.filter((l) => l.includes("stopped for a session")).length === 2);
    const asked = replacement.far.requests.length;
    await passTime(20_000);
    expect(replacement.far.requests.length).toBe(asked);
  });

  it("an event of the engine's own instance in the host's stream is dropped, so neither stream can take over the other's session", async () => {
    guest.append("engine", engineLine(0));
    guest.append("events", hostEventLine(0) + hostEventLine(7, INSTANCE_E));
    sessions.register(entry());
    start();
    await advanceUntil(() => ingest.seqsOf(INSTANCE_E).length === 1 && ingest.seqsOf(INSTANCE_H).length === 1);
    await passTime(20_000);
    expect(ingest.seqsOf(INSTANCE_E)).toEqual([0]);
    expect(ingest.seqsOf(INSTANCE_H)).toEqual([0]);
    // the foreign line is counted as a drop, as the file tails count it (a tail that took it would have sent it instead)
    const dropped = (): unknown[] => [...ingest.sessions.values()].flatMap((x) => x.stored).filter((e) => e.kind === "bridge_dropped");
    await advanceUntil(() => dropped().length > 0, 2000, 400);
    expect(dropped()[0]).toMatchObject({ reason: "schema", count: 1 });
  });

  it("nothing is read or sent until a hello kept the bridge, and the session is read again once it did", async () => {
    guest.append("engine", engineLine(0));
    sessions.register(entry());
    let kept = false;
    start({ accepted: () => kept });
    await passTime(30_000);
    expect(guest.far.requests).toHaveLength(0);
    expect(bridge!.status().repos[0]).toMatchObject({ run: "waiting", reason: "hello" });
    kept = true;
    await advanceUntil(() => ingest.seqsOf(INSTANCE_E).length === 1);
  });

  it("a hello that later drops the bridge stops a running session as `hello` (waiting), not as a replaced session, and it is read again once a hello keeps it", async () => {
    guest.append("engine", engineLine(0));
    sessions.register(entry());
    let kept = true;
    start({ accepted: () => kept });
    await advanceUntil(() => ingest.seqsOf(INSTANCE_E).length === 1);
    expect(bridge!.status().repos[0]).toMatchObject({ run: "running" });
    kept = false;
    await advanceUntil(() => bridge!.status().repos[0]?.run === "waiting", 30_000, 400);
    expect(bridge!.status().repos[0]).toMatchObject({ run: "waiting", reason: "hello" });
    guest.far.requests.length = 0;
    await passTime(30_000);
    expect(guest.far.requests).toHaveLength(0);
    guest.append("engine", engineLine(1));
    kept = true;
    await advanceUntil(() => ingest.seqsOf(INSTANCE_E).length === 2, 30_000, 400);
  });

  it("a restart resumes from the saved cursors; a start that made a new disk begins its files again", async () => {
    guest.append("engine", engineLine(0) + engineLine(1));
    sessions.register(entry());
    start();
    await advanceUntil(() => ingest.seqsOf(INSTANCE_E).length === 2);
    await advanceUntil(() => existsSync(path.join(cursorDir(), `${REPO}.session-engine.cursor.json`)));
    await bridge!.stop();
    const saved = Buffer.byteLength(engineLine(0) + engineLine(1));
    guest.reads.length = 0;
    start();
    await advanceUntil(() => guest.reads.some((r) => r.stream === "engine"));
    expect(guest.reads.find((r) => r.stream === "engine")).toEqual({ after: saved, stream: "engine" });
    await bridge!.stop();
    sessions.register(entry({ job_id: "job-2", fresh: true }));
    guest.reads.length = 0;
    start();
    await advanceUntil(() => guest.reads.some((r) => r.stream === "engine"));
    expect(guest.reads.find((r) => r.stream === "engine")).toEqual({ after: 0, stream: "engine" });
  });
});

describe("signed commands go into the guest, and only the ones this repository may have", () => {
  it("forwards a verified command byte for byte and acks the outcome the guest wrote", async () => {
    sessions.register(entry());
    start();
    await advanceUntil(() => guest.reads.length > 0);
    const c = cmds.command(REPO, 1);
    cmds.queue.push(c);
    await advanceUntil(() => guest.commands.length === 1);
    expect(guest.commands[0]).toEqual(cmds.sign(c));
    guest.append("outcomes", `${JSON.stringify({ name: `1-${c.command_id}`, ack: { outcome: "applied" } })}\n`);
    await advanceUntil(() => cmds.acks.length === 1);
    expect(cmds.acks[0]).toEqual({ id: c.command_id, ack: { outcome: "applied" } });
    expect(hostTouched).toEqual([]);
  });

  it("refuses, and never forwards, a forged signature, another repository's command, a command with operate off and a replay", async () => {
    sessions.register(entry());
    start();
    await advanceUntil(() => guest.reads.length > 0);
    const forged = cmds.command(REPO, 1);
    const stranger = cmds.command(REPO, 2);
    const other = cmds.command(REPO + 1, 3);
    const off = cmds.command(REPO, 4);
    for (const c of [forged, stranger, other, off]) cmds.delivered.add(c.command_id);
    cmds.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: false });
    cmds.pullOverride = () => [cmds.signWithStranger(forged), cmds.signWithStranger(stranger), cmds.sign(other), cmds.sign(off)];
    await passTime(6_000, 1_000);
    await advanceUntil(() => cmds.acks.length === 4);
    const refusal = (id: string): unknown => cmds.acks.find((a) => a.id === id)?.ack;
    expect(refusal(forged.command_id)).toEqual({ outcome: "refused", refusal: "signature_invalid" });
    expect(refusal(stranger.command_id)).toEqual({ outcome: "refused", refusal: "signature_invalid" });
    expect(refusal(other.command_id)).toEqual({ outcome: "refused", refusal: "wrong_repo" });
    expect(refusal(off.command_id)).toEqual({ outcome: "refused", refusal: "operate_off" });
    expect(guest.commands).toEqual([]);
    // a replay of a command the guest already took is refused by the runner's own record, not forwarded again
    cmds.pullOverride = undefined;
    cmds.controls.set(REPO, { halt_epoch: 0, halted: false, operate_enabled: true });
    const good = cmds.command(REPO, 5);
    cmds.queue.push(good);
    await advanceUntil(() => guest.commands.length === 1);
    cmds.delivered.add(good.command_id);
    cmds.pullOverride = () => [cmds.sign(good)];
    const acks = cmds.acks.length;
    await advanceUntil(() => cmds.acks.length > acks);
    expect(guest.commands).toHaveLength(1);
  });
});
