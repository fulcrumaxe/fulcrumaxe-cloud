import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HaltOutcome } from "../../src/engineBridge/commands.js";
import { createBridgeTails, ENGINE_EVENTS_FILE, HOST_EVENTS_FILE, startEngineBridge, type EngineBridge, type EngineBridgeDeps, type EngineBridgePorts } from "../../src/engineBridge/daemon.js";
import { saveBridgeSettings, type BridgedRepo } from "../../src/engineBridge/settings.js";
import { createEventsUploader } from "../../src/engineBridge/upload.js";
import { generateRunnerKey } from "../../src/keys.js";
import { manualClock, type ManualClock } from "../helpers/manualClock.js";
import { SPOOL_FILE } from "../../src/engineHost/hostFeeds.js";
import { startFakeCommands, type FakeCommands } from "../helpers/strictEngineCommands.js";
import { startStrictEngineIngest, type StrictEngineIngest } from "../helpers/strictEngineIngest.js";

const H = "7c2d8e4f-3a1b-4c5d-8e6f-9a0b1c2d3e4f";
const A = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const REPO = 77;
const NAME = "acme/widgets";
const uid = process.getuid?.();
const line = (seq: number, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ v: 1, engine_instance_id: A, seq, ts: "2026-11-16T15:00:00.000Z", kind: "loop_tick", origin: "cron", duration_s: 5, ...extra })}\n`;

let root: string;
let runnerDir: string;
let stateDir: string;
let repoRoot: string;
let xdg: string;
let ingest: StrictEngineIngest;
let cmds: FakeCommands;
let clock: ManualClock;
let logs: string[];
let key: ReturnType<typeof generateRunnerKey>;
let bridge: EngineBridge | undefined;

interface Calls {
  controls: Array<{ stateDir: string; handle: unknown; control: unknown; opts: unknown }>;
  keeper: { created: number; changed: number; runs: number };
}
let calls: Calls;
let halt: { outcome: HaltOutcome | undefined; haltedState: { halted: boolean } | undefined | "throw"; handle: { pid: number } | undefined | "throw" };

function fakePorts(): EngineBridgePorts {
  return {
    halt: {
      handleControl: async (dir, handle, control, opts) => {
        calls.controls.push({ stateDir: dir, handle, control, opts });
        return halt.outcome;
      },
      readHostHandle: () => {
        if (halt.handle === "throw") throw new Error("/secret/path unreadable");
        return halt.handle;
      },
      readHaltState: () => {
        if (halt.haltedState === "throw") throw new Error("/secret/path unreadable");
        return halt.haltedState;
      },
    },
    ceiling: {
      create: () => {
        calls.keeper.created++;
        return {
          run: async (signal) => {
            calls.keeper.runs++;
            await clock.sleep(1e9, signal);
          },
          controlsChanged: () => void calls.keeper.changed++,
          status: () => null,
        };
      },
    },
  };
}

const repoEntry = (over: Partial<BridgedRepo> = {}): BridgedRepo => ({ repo_gh_id: REPO, full_name: NAME, state_dir: stateDir, repo_root: repoRoot, ...over });
const manifest = (version: string | object): void => {
  mkdirSync(path.join(repoRoot, "engine"), { recursive: true });
  writeFileSync(path.join(repoRoot, "engine", "manifest.json"), JSON.stringify(typeof version === "string" ? { engine_version: version, files: {} } : version), { mode: 0o644 });
};

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fx-eb3c-"));
  runnerDir = path.join(root, "runner");
  stateDir = path.join(root, "engine-state");
  repoRoot = path.join(root, "repo");
  xdg = path.join(root, "x");
  for (const d of [runnerDir, stateDir, xdg]) mkdirSync(d, { mode: 0o700 });
  manifest("1.2.3");
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
  calls = { controls: [], keeper: { created: 0, changed: 0, runs: 0 } };
  halt = { outcome: undefined, haltedState: undefined, handle: undefined };
  bridge = undefined;
});
afterEach(async () => {
  await bridge?.stop();
  await ingest.close();
  await cmds.close();
  rmSync(root, { recursive: true, force: true });
});

function start(over: Partial<EngineBridgeDeps> = {}): EngineBridge {
  const cloud = { origin: cmds.origin, key, now: () => clock.now(), fetchFn: fetch };
  bridge = startEngineBridge({
    runnerStateDir: runnerDir,
    uid,
    clock,
    runnerVersion: "0.1.1",
    cloud,
    keyring: cmds.keyring,
    runnerId: cmds.runnerId,
    send: createEventsUploader({ ...cloud, origin: ingest.origin }),
    wakeEpoch: () => null,
    accepted: () => true,
    xdgRuntimeDir: xdg,
    secrets: () => [],
    ports: fakePorts(),
    log: (l) => logs.push(l),
    ...over,
  });
  return bridge;
}
/** Moves the manual clock by `ms` in `stepMs` steps, letting the loops run for real between steps. */
async function passTime(ms: number, stepMs = 10_000): Promise<void> {
  for (let done = 0; done < ms; done += stepMs) {
    await clock.advance(stepMs, stepMs);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function advanceUntil(cond: () => boolean, stepMs = 2000, max = 60): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) {
    await clock.advance(stepMs, stepMs);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // The virtual-time budget above is what the caller asked for. Real file and socket IO behind the last step can still be in flight on a loaded machine, so give it real time to land without moving the clock further.
  for (let since = Date.now(); !cond() && Date.now() - since < 15_000; ) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!cond()) throw new Error("condition never held");
}

/** A host event line (the shape `createEventSpool` writes). */
const hostLine = (seq: number, kind = "tick_started", extra: Record<string, unknown> = {}): string => {
  const rest = kind === "ask_raised" ? { kind, ask_id: "fedcba9876543210", ask_kind: "owner_decision", source: "team_log" } : kind === "host_stopped" ? { kind, reason: "halted" } : kind === "tick_started" ? { kind, tick_kind: "loop", outcome: "ok" } : { kind };
  return `${JSON.stringify({ v: 1, engine_instance_id: H, seq, ts: "2026-11-16T15:00:01.000Z", ...rest, ...extra })}\n`;
};
const hostFile = (): string => path.join(stateDir, HOST_EVENTS_FILE);
const cursorDir = (): string => path.join(runnerDir, "engine-bridge");
const readCursor = (name: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(cursorDir(), name), "utf8")) as Record<string, unknown>;

describe("the engine host's events file is a second tail", () => {
  it("names the file the host writes", () => {
    expect(HOST_EVENTS_FILE).toBe(SPOOL_FILE);
  });

  it("uploads both files' events, and keeps a cursor file for each that holds only its own source", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), `${line(0)}${line(1)}`, { mode: 0o600 });
    writeFileSync(hostFile(), `${hostLine(0, "host_started")}${hostLine(1)}${hostLine(2, "tick_ended", { tick_kind: "loop", credential_mode: "subscription" })}`, { mode: 0o600 });
    start();
    await advanceUntil(() => ingest.seqsOf(A).length === 2 && ingest.seqsOf(H).length === 3, 2000, 120);
    expect(ingest.seqsOf(A)).toEqual([0, 1]);
    expect(ingest.seqsOf(H)).toEqual([0, 1, 2]);
    await advanceUntil(() => existsSync(path.join(cursorDir(), `${REPO}.cursor.json`)) && existsSync(path.join(cursorDir(), `${REPO}.host.cursor.json`)));
    expect(readCursor(`${REPO}.cursor.json`)).toMatchObject({ engine_instance_id: A, last_acked_seq: 1 });
    expect(readCursor(`${REPO}.host.cursor.json`)).toMatchObject({ engine_instance_id: H, last_acked_seq: 2 });
    // The status still shows the engine's own acked seq, not the host's.
    expect(bridge!.status().repos[0]!.upload).toMatchObject({ lastAckedSeq: 1 });
  });

  it("a restart resumes each tail at its own cursor: nothing is sent twice, nothing is missed", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), `${line(0)}${line(1)}`, { mode: 0o600 });
    writeFileSync(hostFile(), `${hostLine(0, "host_started")}${hostLine(1)}`, { mode: 0o600 });
    start();
    await advanceUntil(() => ingest.seqsOf(A).length === 2 && ingest.seqsOf(H).length === 2, 2000, 120);
    await advanceUntil(() => existsSync(path.join(cursorDir(), `${REPO}.host.cursor.json`)) && existsSync(path.join(cursorDir(), `${REPO}.cursor.json`)));
    await bridge!.stop();
    const sent = ingest.seen.length;
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), `${line(0)}${line(1)}${line(2)}`, { mode: 0o600 });
    writeFileSync(hostFile(), `${hostLine(0, "host_started")}${hostLine(1)}${hostLine(2)}`, { mode: 0o600 });
    start();
    await advanceUntil(() => ingest.seqsOf(A).length === 3 && ingest.seqsOf(H).length === 3, 2000, 120);
    const after = ingest.seen.slice(sent).filter((s) => s.status === 200);
    const resent = after.flatMap((s) => s.seqs.map((seq) => `${s.instance === A ? "E" : s.instance === H ? "H" : "B"}${seq}`)).filter((x) => !x.startsWith("B"));
    expect(resent.sort()).toEqual(["E2", "H2"]);
  });

  it("an ask in the host file reaches the cloud within one tick of its being written", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), line(0), { mode: 0o600 });
    start();
    await advanceUntil(() => ingest.seqsOf(A).length === 1, 2000, 120);
    // An ordinary host event waits for the window; the ask goes at once and takes it along.
    writeFileSync(hostFile(), hostLine(0), { mode: 0o600 });
    await passTime(4_000, 2_000);
    expect(ingest.seqsOf(H)).toEqual([]);
    writeFileSync(hostFile(), `${hostLine(0)}${hostLine(1, "ask_raised")}`, { mode: 0o600 });
    await advanceUntil(() => ingest.seqsOf(H).length === 2, 2000, 3);
    expect(ingest.seqsOf(H)).toEqual([0, 1]);
  });

  it("a host file that appears later is picked up; one that is missing costs nothing", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), line(0), { mode: 0o600 });
    start();
    await advanceUntil(() => ingest.seqsOf(A).length === 1, 2000, 120);
    expect(existsSync(hostFile())).toBe(false);
    expect(logs.join("\n")).not.toContain("refused");
    writeFileSync(hostFile(), hostLine(0, "ask_raised"), { mode: 0o600 });
    await advanceUntil(() => ingest.seqsOf(H).length === 1, 2000, 10);
  });

  it("refuses a host file that is a link or open to others, with the engine file's own words, and still sends the engine's events", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    const victim = path.join(root, "victim.jsonl");
    writeFileSync(victim, hostLine(0, "ask_raised"), { mode: 0o600 });
    symlinkSync(victim, hostFile());
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), line(0), { mode: 0o600 });
    start();
    await advanceUntil(() => ingest.seqsOf(A).length === 1, 2000, 120);
    await passTime(10_000, 2_000);
    expect(ingest.seqsOf(H)).toEqual([]);
    expect(logs.filter((l) => l.includes("refused (link)")).length).toBe(1);
    rmSync(hostFile());
    writeFileSync(hostFile(), hostLine(0, "ask_raised"), { mode: 0o600 });
    chmodSync(hostFile(), 0o666);
    await passTime(10_000, 2_000);
    expect(ingest.seqsOf(H)).toEqual([]);
    expect(logs.filter((l) => l.includes("refused (open_permissions)")).length).toBe(1);
    // Fixed words only: no path, no line.
    expect(logs.join("\n")).not.toContain(root);
    chmodSync(hostFile(), 0o600);
    await advanceUntil(() => ingest.seqsOf(H).length === 1, 2000, 10);
  });

  it("rejects an event kind the protocol does not have, as for the engine's file, and counts it", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), line(0), { mode: 0o600 });
    writeFileSync(hostFile(), `${hostLine(0, "made_up_kind")}${hostLine(1, "ask_raised")}`, { mode: 0o600 });
    start();
    await advanceUntil(() => ingest.seqsOf(H).length === 1, 2000, 120);
    expect(ingest.seqsOf(H)).toEqual([1]);
    const dropped = (): number => [...ingest.sessions.values()].flatMap((s) => s.stored).filter((e) => e.kind === "bridge_dropped").length;
    await advanceUntil(() => dropped() > 0, 2000, 400);
    const notice = [...ingest.sessions.values()].flatMap((s) => s.stored).find((e) => e.kind === "bridge_dropped");
    expect(notice).toMatchObject({ reason: "schema", count: 1 });
  });

  it("while halted, the host's file is read exactly as the engine's is: both go on", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    halt.haltedState = { halted: true };
    cmds.controls.set(REPO, { halt_epoch: 3, halted: true, operate_enabled: true });
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), line(0, { kind: "halt_applied", halt_epoch: 3, method: "scope", survivors: 0, origin: undefined, duration_s: undefined }), { mode: 0o600 });
    writeFileSync(hostFile(), `${hostLine(0, "host_stopped")}`, { mode: 0o600 });
    start();
    await advanceUntil(() => ingest.seqsOf(A).length === 1 && ingest.seqsOf(H).length === 1, 2000, 120);
    expect([...ingest.sessions.get(H)!.stored.map((e) => e.kind)]).toEqual(["host_stopped"]);
  });

  it("builds both tails with the runner's user id: a file of another user is refused for the host's file as for the engine's", () => {
    if (uid === undefined) return;
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), line(0), { mode: 0o600 });
    writeFileSync(hostFile(), hostLine(0, "ask_raised"), { mode: 0o600 });
    const refusals: string[] = [];
    const { tail, hostTail } = createBridgeTails({ stateDir, runnerStateDir: runnerDir, repoGhId: REPO, uid: uid + 1, secrets: () => [], log: (l) => refusals.push(l) });
    expect(tail.poll().status).toBe("refused");
    expect(hostTail.poll().status).toBe("refused");
    expect(refusals.filter((l) => l.includes("foreign_owner")).length).toBe(2);
    // With the right id the same files are read.
    const mine = createBridgeTails({ stateDir, runnerStateDir: runnerDir, repoGhId: REPO, uid, secrets: () => [], log: () => undefined });
    expect(mine.tail.poll().status).toBe("ok");
    expect(mine.hostTail.poll().status).toBe("ok");
  });

  it("through the daemon, a host line that claims the engine's session is dropped, the real events of both files go and the upload never wedges", async () => {
    saveBridgeSettings(runnerDir, [repoEntry()]);
    const forged = `${JSON.stringify({ v: 1, engine_instance_id: A, seq: 0, ts: "2026-11-16T15:00:00.500Z", kind: "tick_started", tick_kind: "loop", outcome: "ok" })}\n`;
    writeFileSync(path.join(stateDir, ENGINE_EVENTS_FILE), `${line(0)}${line(1)}`, { mode: 0o600 });
    writeFileSync(hostFile(), `${forged}${hostLine(0, "ask_raised")}`, { mode: 0o600 });
    start();
    await advanceUntil(() => ingest.seqsOf(A).length === 2 && ingest.seqsOf(H).length === 1, 2000, 120);
    expect(ingest.seqsOf(A)).toEqual([0, 1]);
    expect(ingest.seen.filter((s) => s.status === 400)).toEqual([]);
  });
});
