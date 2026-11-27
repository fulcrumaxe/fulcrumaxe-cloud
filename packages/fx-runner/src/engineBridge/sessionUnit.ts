/**
 * D#845 ON-14a: the bridge's loops for one engine SESSION repository (Ruling 120). The pieces are the host repo's own, on other sources: the upload loop reads two channel streams (the engine's own events and the host's) instead of two files, and the command puller
 * forwards over the session's channel instead of writing an inbox directory. Left out on purpose: the dial ceiling keeper, the halt kill path and the bridge-state file, which belong to a host engine's files; a session is halted by a stop job (the guest's
 * supervisor is the process that ends), and a command's operate and halt checks are the puller's own. The repository is the signed start job's, so the puller's one bridged repo is that id and a command for any other is `wrong_repo`.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import type { EngineEventsMessage, JobKeyring } from "@fulcrumaxe/runner-protocol";
import type { CloudReply } from "../cloud.js";
import type { Clock } from "../daemon/lease.js";
import type { SessionEntry } from "../engineSession/registry.js";
import { createChannelInbox } from "./channelInbox.js";
import { createChannelTail } from "./channelTail.js";
import { CommandPuller } from "./commands.js";
import { loadCursor } from "./cursor.js";
import { DetailSpool, detailSpoolPaths } from "./detailSpool.js";
import { BridgeLoop } from "./loop.js";
import type { SendOutcome } from "./upload.js";
import { WatchState } from "./watchState.js";

const cursorOf = (runnerStateDir: string, repoGhId: number, stream: "engine" | "events"): string => path.join(runnerStateDir, "engine-bridge", `${repoGhId}.session-${stream}.cursor.json`);
const inboxDirOf = (runnerStateDir: string, repoGhId: number): string => path.join(runnerStateDir, "engine-bridge", "sessions", String(repoGhId));

/** A session that made a new disk begins its files again: the saved offsets of the old ones (events, engine, outcomes) are removed. The replay state (sequence and ids seen) stays: those belong to the cloud's commands, not to a disk. */
export function removeSessionCursors(runnerStateDir: string, repoGhId: number): void {
  for (const file of [cursorOf(runnerStateDir, repoGhId, "engine"), cursorOf(runnerStateDir, repoGhId, "events"), path.join(inboxDirOf(runnerStateDir, repoGhId), "outcomes-offset.json")]) rmSync(file, { force: true });
}

/** An engine instance id belongs to the first stream it appears in (or the cursor that already holds it): the other stream never adopts it, so neither can take over a session of the other. */
export function instanceGuard(tails: () => ReadonlyArray<readonly ["engine" | "host", { currentInstance(): string | null }]>): (me: "engine" | "host") => (id: string) => boolean {
  const owners = new Map<string, "engine" | "host">();
  return (me) => (id) => {
    for (const [name, t] of tails()) {
      const known = t.currentInstance();
      if (known !== null && !owners.has(known)) owners.set(known, name);
    }
    const owner = owners.get(id);
    if (owner === undefined) {
      owners.set(id, me);
      return false;
    }
    return owner !== me;
  };
}

export interface SessionUnitDeps {
  runnerStateDir: string;
  uid: number | undefined;
  clock: Clock;
  runnerVersion: string;
  keyring: JobKeyring;
  runnerId: string;
  send: (message: EngineEventsMessage) => Promise<SendOutcome>;
  wakeEpoch: () => number | null;
  cloudWatchMode?: (() => boolean) | undefined;
  secrets: () => readonly string[];
  /** The daemon's own post (its list of repos is read from every pull reply on the way through). */
  post: (path: string, body: unknown) => Promise<CloudReply>;
  log: (line: string) => void;
}

export interface SessionUnit {
  loop: BridgeLoop;
  puller: CommandPuller;
  run(signal: AbortSignal): Promise<void>[];
}

export function createSessionUnit(deps: SessionUnitDeps, entry: SessionEntry, engineVersion: string): SessionUnit {
  const { runnerStateDir, uid, clock, log } = deps;
  const id = entry.repo_gh_id;
  if (entry.fresh) removeSessionCursors(runnerStateDir, id);
  const guard = instanceGuard(() => [["engine", tail], ["host", hostTail]]);
  const tail = createChannelTail({ channel: entry.channel, stream: "engine", cursorPath: cursorOf(runnerStateDir, id, "engine"), uid, secrets: deps.secrets, log, isForeignInstance: guard("engine") });
  const hostTail = createChannelTail({ channel: entry.channel, stream: "events", cursorPath: cursorOf(runnerStateDir, id, "events"), uid, secrets: deps.secrets, log, isForeignInstance: guard("host") });
  let lastAckedSeq: number | null = null;
  try {
    lastAckedSeq = loadCursor(cursorOf(runnerStateDir, id, "engine"), undefined, uid)?.last_acked_seq ?? null;
  } catch {
    // fx-swallow-ok: a refused cursor shows no acked seq in `status`; the tail itself refuses it again and says so once
  }
  const watchState = new WatchState(() => clock.now().getTime());
  const spool = new DetailSpool({ ...detailSpoolPaths(runnerStateDir, id), uid, now: () => clock.now().getTime() });
  const cloudWatchMode = deps.cloudWatchMode;
  const loop = new BridgeLoop({
    tail, tails: [hostTail], send: deps.send, clock, repoGhId: id, engineVersion, bridgeVersion: deps.runnerVersion, log, lastAckedSeq, wakeEpoch: deps.wakeEpoch,
    ...(cloudWatchMode === undefined ? {} : { watch: { state: watchState, spool, advertised: cloudWatchMode } }),
  });
  const puller = new CommandPuller({
    post: deps.post,
    inbox: createChannelInbox({ channel: entry.channel, dir: inboxDirOf(runnerStateDir, id), uid, now: () => clock.now().getTime(), log }),
    keyring: deps.keyring,
    runnerId: deps.runnerId,
    clock,
    bridgedRepos: () => [id],
    wakeEpoch: deps.wakeEpoch,
    // no host process or halt file of this machine belongs to a session: a halt is a stop job, and the cloud's `halted` control still refuses every start-like command
    handleControl: () => Promise.resolve(undefined),
    localHalted: () => false,
    reportHalt: (_repoGhId, report) => loop.reportHalt(report),
    onWatch: (repoGhId, command) => {
      if (repoGhId !== id) return;
      watchState.extend(Date.parse(command.args.until));
      if (command.args.before !== undefined) loop.requestOlder(command.args.before);
    },
    log,
  });
  const own = (name: string, work: () => Promise<void>): Promise<void> =>
    work().catch(() => {
      // fx-swallow-ok: the error could name a path or a line of the engine's file; a fixed line is logged and the other loop goes on
      log(`engine-bridge: the ${name} loop stopped`);
    });
  return { loop, puller, run: (signal) => [own("upload", () => loop.run(signal)), own("command", () => puller.run(signal))] };
}
