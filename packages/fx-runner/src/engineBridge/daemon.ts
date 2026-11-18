/**
 * The engine bridge inside the daemon (EB-3c): it joins the parts that exist on their own, for each repo the person enabled with `engine-bridge enable`.
 *
 *  - A repo's loops start only when the hello kept `engine_bridge_v1` AND the cloud's own list of this runner's repos holds the repo's GitHub id with the name it was
 *    enabled under. The runner keeps no list of its own: the list is `allowed_repos` of a command pull's reply (a probe pull for an id no repo has, when nothing runs yet).
 *    A repo that is not on the list, or has no readable engine version, is refused with a closed reason and nothing of it starts. A repo that leaves the list stops.
 *  - Per repo: the upload loop (`BridgeLoop` over the events-file tail), the command puller (its own inbox in the engine's state directory) and the dial ceiling keeper.
 *    The engine's state directory belongs to that one repo (`settings.ts` refuses two repos on one). Each is a loop of its own, started in the background: nothing here
 *    is awaited by the claim loop, and one that fails never stops another.
 *  - One decide socket for the machine, over the repos that run: it forwards a decision only for those, and only while the last pull said operate is on (`true`; never when it is unknown).
 *  - The halt path (`handleControl`, the halt-state reader), the ceiling keeper and the dials fetch come in through `EngineBridgePorts`, bound once by the program's entry
 *    point (`ports.ts`), so this file names no process table, scope or systemd path.
 *  - `engine-bridge status` is a separate process, so the daemon writes a small status file (closed words and numbers only, no event content, no path) every minute and when it changes.
 */
import path from "node:path";
import { ENGINE_VERSION_PATTERN, type EngineEventsMessage, type JobKeyring } from "@fulcrumaxe/runner-protocol";
import { readPrivateFile, writePrivateFile } from "../config.js";
import type { CloudReply } from "../cloud.js";
import type { Clock } from "../daemon/lease.js";
import { CommandPuller, PULL_PATH, createCloudPost, type HaltOutcome, type PullStatus } from "./commands.js";
import { loadCursor } from "./cursor.js";
import { serveDecideSocket, socketPathFor, type DecideSocket } from "./decideSocket.js";
import { readEngineVersion } from "./engineVersion.js";
import { Inbox } from "./inbox.js";
import { BridgeLoop, type BridgeStatus } from "./loop.js";
import { loadBridgeSettings, type BridgedRepo } from "./settings.js";
import { EngineTail } from "./tail.js";
import type { SendOutcome } from "./upload.js";

export const ENGINE_EVENTS_FILE = "engine-events.jsonl";
/** The engine host's own events, written by `engineHost/hostFeeds.ts` (`SPOOL_FILE`; a test pins the two names equal). */
export const HOST_EVENTS_FILE = "engine-host-events.jsonl";
export const BRIDGE_STATUS_FILE = "engine-bridge-status.json";
/** How often the supervisor looks again: settings, the cloud's list, the loops it must start or stop. */
export const SUPERVISE_MS = 10_000;
/** The cloud's list is asked for again (by a probe pull) when none is held and a repo waits for it. */
export const ALLOWED_PROBE_MS = 60_000;
/**
 * The oldest the cloud's list may be for a repo to start or keep running on it: 25 minutes, two safety pulls (10 minutes each) and some slack. A running repo's own pull (at every wake, and every 10 minutes at the longest) renews it; a list nobody renewed
 * (the pulls fail, or answer without a readable list) ages out, the repo stops, and a probe pull asks again.
 */
export const ALLOWED_MAX_AGE_MS = 25 * 60_000;
export const STATUS_WRITE_MS = 60_000;
/** A repo id no GitHub repository has: a pull for it returns the runner's list and delivers nothing. */
export const PROBE_REPO_ID = Number.MAX_SAFE_INTEGER;

/** What the kill path and the halt-state files need, bound to the machine by the entry point (EB-11b, #995). */
export interface HaltPort {
  /** `handleControl(stateDir, handle, control, deps, opts)` with `deps` already bound. */
  handleControl(stateDir: string, handle: { pid: number; unit?: string } | undefined, control: { halt_epoch: number; halted: boolean }, opts: { repoGhId: number; handleProblem?: string }): Promise<HaltOutcome | undefined>;
  /** The engine host's handle; undefined when none is recorded; throws when the file is unsafe or malformed. */
  readHostHandle(stateDir: string, uid: number): { pid: number; unit?: string } | undefined;
  /** The halt file's state; undefined when there is none; throws when it cannot be read. */
  readHaltState(stateDir: string, uid: number): { halted: boolean } | undefined;
}
/** The dial ceiling keeper (EB-9b, #1002), made for one repo. */
export interface CeilingKeeperLike {
  run(signal: AbortSignal): Promise<void>;
  controlsChanged(): void;
  status(): "written" | "kept_old" | null;
}
export interface CloudConfig {
  origin: string;
  key: Parameters<typeof createCloudPost>[0]["key"];
  now: () => Date;
  fetchFn: typeof fetch;
  bypass?: string | undefined;
}
export interface CeilingPort {
  create(cloud: CloudConfig, args: { stateDir: string; uid: number | undefined; clock: Clock; repoGhId: number; log: (line: string) => void }): CeilingKeeperLike;
}
export interface EngineBridgePorts {
  halt: HaltPort;
  ceiling: CeilingPort;
}

export interface EngineBridgeDeps {
  /** The runner's own state directory: the settings, the cursors and the status file live here. */
  runnerStateDir: string;
  uid: number | undefined;
  clock: Clock;
  /** This runner's version, for the bridge's own session. */
  runnerVersion: string;
  cloud: CloudConfig;
  /** The pinned public keys the cloud's commands are signed with, and this runner's id. */
  keyring: JobKeyring;
  runnerId: string;
  /** The events upload (`createEventsUploader` bound to the cloud and the key). */
  send: (message: EngineEventsMessage) => Promise<SendOutcome>;
  /** The wake epoch the claim loop last saw. */
  wakeEpoch: () => number | null;
  /** True once the hello was answered and kept `engine_bridge_v1`. Nothing starts before. */
  accepted: () => boolean;
  /** `XDG_RUNTIME_DIR`, looked up by name by the caller. Without it no decide socket is served. */
  xdgRuntimeDir: string | undefined;
  /** The runner's secrets, for the redaction every uploaded event goes through. */
  secrets: () => readonly string[];
  ports: EngineBridgePorts;
  /** Gets fixed text only. */
  log: (line: string) => void;
  /** Test seam: the supervisor's period. */
  superviseMs?: number;
}

export type RepoRunState = "running" | "waiting" | "refused";
export interface RepoStatus {
  repo_gh_id: number;
  full_name: string;
  run: RepoRunState;
  /** A closed word: why the repo waits or is refused; null while it runs. */
  reason: string | null;
  upload: BridgeStatus | null;
  pull: PullStatus | null;
  ceiling: "written" | "kept_old" | null;
}
export interface DaemonStatus {
  settings: "ok" | "damaged";
  hello: boolean;
  socket: "serving" | "off" | "unavailable";
  repos: RepoStatus[];
}
export interface EngineBridge {
  /** Aborts every loop, waits for them and closes the socket. */
  stop(): Promise<void>;
  status(): DaemonStatus;
}

interface Allowed {
  repo_gh_id: number;
  full_name: string;
}
const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** The pull reply's `allowed_repos`, or undefined when it holds none or any entry is not exactly `{repo_gh_id, full_name}` (a list that cannot be read is no list). */
export function parseAllowedRepos(body: unknown): Allowed[] | undefined {
  const list = (body as { allowed_repos?: unknown } | null)?.allowed_repos;
  if (!Array.isArray(list) || list.length > 100) return undefined;
  const out: Allowed[] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown> | null;
    if (r === null || typeof r !== "object" || Object.keys(r).sort().join(",") !== "full_name,repo_gh_id") return undefined;
    if (typeof r.repo_gh_id !== "number" || !Number.isSafeInteger(r.repo_gh_id) || r.repo_gh_id < 1 || typeof r.full_name !== "string" || !FULL_NAME.test(r.full_name)) return undefined;
    out.push({ repo_gh_id: r.repo_gh_id, full_name: r.full_name });
  }
  return out;
}

const engineCursorPath = (runnerStateDir: string, repoGhId: number): string => path.join(runnerStateDir, "engine-bridge", `${repoGhId}.cursor.json`);

/**
 * The two tails of a repo: the engine's own events file and the engine host's. Each has a cursor file of its own (the two never share state), the same owner check, and
 * refuses an event that carries the other's engine instance: one file can never put events into the other's session.
 */
export function createBridgeTails(args: { stateDir: string; runnerStateDir: string; repoGhId: number; uid: number | undefined; secrets: () => readonly string[]; log: (line: string) => void }): { tail: EngineTail; hostTail: EngineTail } {
  const { stateDir, runnerStateDir, repoGhId, uid, secrets, log } = args;
  // An engine instance id belongs to the file it first appears in (or the cursor that already holds it): the other tail never adopts it, so one file cannot take over a
  // session of the other, whether it is the other's current one, an old one from before a restart, or one the other has not read yet.
  const owners = new Map<string, "engine" | "host">();
  const foreign =
    (me: "engine" | "host") =>
    (id: string): boolean => {
      for (const [name, t] of [["engine", tail], ["host", hostTail]] as const) {
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
  const tail: EngineTail = new EngineTail({ eventsPath: path.join(stateDir, ENGINE_EVENTS_FILE), cursorPath: engineCursorPath(runnerStateDir, repoGhId), uid, secrets, log, isForeignInstance: foreign("engine") });
  const hostTail: EngineTail = new EngineTail({ eventsPath: path.join(stateDir, HOST_EVENTS_FILE), cursorPath: path.join(runnerStateDir, "engine-bridge", `${repoGhId}.host.cursor.json`), uid, secrets, log, isForeignInstance: foreign("host") });
  return { tail, hostTail };
}

interface Unit {
  repo: BridgedRepo;
  abort: AbortController;
  loop: BridgeLoop;
  puller: CommandPuller;
  keeper: CeilingKeeperLike;
  done: Promise<unknown>;
}

const sameBinding = (a: BridgedRepo, b: BridgedRepo): boolean => a.repo_gh_id === b.repo_gh_id && a.full_name === b.full_name && a.state_dir === b.state_dir && a.repo_root === b.repo_root;

export function startEngineBridge(deps: EngineBridgeDeps): EngineBridge {
  const { clock, ports } = deps;
  const root = new AbortController();
  const uidNum = deps.uid ?? -1;
  const units = new Map<number, Unit>();
  const refused = new Map<number, string>();
  let settings: "ok" | "damaged" = "ok";
  let known: readonly BridgedRepo[] = [];
  let allowed: Allowed[] | undefined;
  let allowedAt = Number.NEGATIVE_INFINITY;
  /** Which ask the held list answered: asks are numbered in the order they are sent, and only a later ask's list replaces it. */
  let allowedAsk = 0;
  let asks = 0;
  let probeAt = Number.NEGATIVE_INFINITY;
  let socket: DecideSocket | undefined;
  let socketState: DaemonStatus["socket"] = "off";
  let lastWrite = { json: "", at: Number.NEGATIVE_INFINITY };

  const rawPost = createCloudPost({ origin: deps.cloud.origin, key: deps.cloud.key, now: deps.cloud.now, fetchFn: deps.cloud.fetchFn, bypass: deps.cloud.bypass });
  /**
   * Every pull reply is read once on its way through: the cloud's list of repos, and (per repo, below) whether the controls changed.
   * The list is as old as the ask, not the answer: it is stamped with the time the pull was sent, so an answer that lands after the clock stepped back is
   * no fresher than its ask was. An answer to an older ask that lands after a newer one's never replaces the newer list.
   */
  const post = (observe: ((reply: CloudReply) => void) | undefined) => async (p: string, body: unknown): Promise<CloudReply> => {
    const ask = ++asks;
    const askedAt = clock.now().getTime();
    const reply = await rawPost(p, body);
    if (p === PULL_PATH && reply.status === 200) {
      const list = parseAllowedRepos(reply.body);
      if (list !== undefined && ask > allowedAsk) {
        allowed = list;
        allowedAt = askedAt;
        allowedAsk = ask;
      }
      observe?.(reply);
    }
    return reply;
  };
  const decidePost = post(undefined);

  const statusOf = (repo: BridgedRepo): RepoStatus => {
    const unit = units.get(repo.repo_gh_id);
    const why = refused.get(repo.repo_gh_id);
    return { repo_gh_id: repo.repo_gh_id, full_name: repo.full_name, run: unit !== undefined ? "running" : why !== undefined ? "refused" : "waiting", reason: unit !== undefined ? null : (why ?? (deps.accepted() ? "cloud_list" : "hello")), upload: unit?.loop.status() ?? null, pull: unit?.puller.status() ?? null, ceiling: unit?.keeper.status() ?? null };
  };
  const status = (): DaemonStatus => ({ settings, hello: deps.accepted(), socket: socketState, repos: known.map(statusOf) });

  function localHalted(repo: BridgedRepo): boolean {
    try {
      return ports.halt.readHaltState(repo.state_dir, uidNum)?.halted === true;
    } catch {
      // fx-swallow-ok: a halt file nobody can read is a stop nobody can rule out: it counts as halted
      return true;
    }
  }

  async function handleControl(repo: BridgedRepo, repoGhId: number, control: { halt_epoch: number; halted: boolean }): Promise<HaltOutcome | undefined> {
    let handle: { pid: number; unit?: string } | undefined;
    let handleProblem: string | undefined;
    try {
      handle = ports.halt.readHostHandle(repo.state_dir, uidNum);
    } catch {
      // fx-swallow-ok: an unreadable host file is reported as "nothing could be checked" (method none, one survivor); its error could name a path
      handleProblem = "the engine host's file could not be read";
    }
    return ports.halt.handleControl(repo.state_dir, handle, control, { repoGhId, ...(handleProblem === undefined ? {} : { handleProblem }) });
  }

  /** Whether the cloud's list holds the repo, by id and by the name it was enabled under: ok, `cloud_list` (no list, or one older than `ALLOWED_MAX_AGE_MS`: wait) or `not_allowed` (refuse). */
  function listFresh(): boolean {
    const age = clock.now().getTime() - allowedAt;
    // A clock that went back (a negative age) is not a fresh list.
    return age >= 0 && age <= ALLOWED_MAX_AGE_MS;
  }

  function listVerdict(repo: BridgedRepo): "ok" | "cloud_list" | "not_allowed" {
    if (allowed === undefined || !listFresh()) return "cloud_list";
    const found = allowed.find((a) => a.repo_gh_id === repo.repo_gh_id);
    return found !== undefined && found.full_name === repo.full_name ? "ok" : "not_allowed";
  }

  function start(repo: BridgedRepo, engineVersion: string): void {
    const abort = new AbortController();
    const log = deps.log;
    const cursorPath = engineCursorPath(deps.runnerStateDir, repo.repo_gh_id);
    let lastAckedSeq: number | null = null;
    try {
      lastAckedSeq = loadCursor(cursorPath, undefined, deps.uid)?.last_acked_seq ?? null;
    } catch {
      // fx-swallow-ok: a refused cursor shows no acked seq in `status`; the tail itself refuses it again and says so once
    }
    const { tail, hostTail } = createBridgeTails({ stateDir: repo.state_dir, runnerStateDir: deps.runnerStateDir, repoGhId: repo.repo_gh_id, uid: deps.uid, secrets: deps.secrets, log });
    const loop = new BridgeLoop({ tail, tails: [hostTail], send: deps.send, clock, repoGhId: repo.repo_gh_id, engineVersion, bridgeVersion: deps.runnerVersion, log, lastAckedSeq });
    const keeper = ports.ceiling.create(deps.cloud, { stateDir: repo.state_dir, uid: deps.uid, clock, repoGhId: repo.repo_gh_id, log });
    let lastControl: string | undefined;
    const puller = new CommandPuller({
      post: post((reply) => {
        const controls = (reply.body as { controls?: unknown } | null)?.controls;
        const mine = Array.isArray(controls) ? controls.find((c) => (c as { repo_gh_id?: unknown } | null)?.repo_gh_id === repo.repo_gh_id) : undefined;
        const seen = JSON.stringify(mine === undefined ? null : { h: (mine as Record<string, unknown>).halt_epoch, d: (mine as Record<string, unknown>).halted, o: (mine as Record<string, unknown>).operate_enabled });
        if (seen !== lastControl) {
          lastControl = seen;
          keeper.controlsChanged();
        }
      }),
      inbox: new Inbox(repo.state_dir, deps.uid),
      keyring: deps.keyring,
      runnerId: deps.runnerId,
      clock,
      bridgedRepos: () => [repo.repo_gh_id],
      wakeEpoch: deps.wakeEpoch,
      handleControl: (repoGhId, control) => handleControl(repo, repoGhId, control),
      localHalted: () => localHalted(repo),
      reportHalt: (_repoGhId, report) => loop.reportHalt(report),
      log,
    });
    // Three loops, each its own promise: a failure in one is a fixed line and never reaches the others or the claim loop.
    const own = (name: string, run: () => Promise<void>): Promise<void> =>
      run().catch(() => {
        // fx-swallow-ok: the error could name a path or a line of the engine's file; a fixed line is logged and the other loops go on
        log(`engine-bridge: the ${name} loop stopped`);
      });
    const done = Promise.all([own("upload", () => loop.run(abort.signal)), own("command", () => puller.run(abort.signal)), own("dial", () => keeper.run(abort.signal))]);
    units.set(repo.repo_gh_id, { repo, abort, loop, puller, keeper, done });
    refused.delete(repo.repo_gh_id);
    log("engine-bridge: started for a repo");
  }

  async function stopUnit(id: number, why: string): Promise<void> {
    const unit = units.get(id);
    if (unit === undefined) return;
    units.delete(id);
    unit.abort.abort();
    await unit.done;
    refused.set(id, why);
    deps.log("engine-bridge: stopped for a repo");
  }

  async function probe(): Promise<void> {
    const now = clock.now().getTime();
    const elapsed = now - Math.max(allowedAt, probeAt);
    // A clock that went back gives a negative elapsed time: the list is not fresh then (`listFresh`), so the probe is due now, not when the clock catches up.
    if (elapsed >= 0 && elapsed < ALLOWED_PROBE_MS) return;
    probeAt = now;
    await decidePost(PULL_PATH, { repo_gh_ids: [PROBE_REPO_ID], after_seq: {} });
  }

  async function supervise(): Promise<void> {
    const loaded = loadBridgeSettings(deps.runnerStateDir);
    settings = loaded.ok ? "ok" : "damaged";
    if (!loaded.ok) {
      if (units.size > 0 || known.length > 0) deps.log("engine-bridge: the settings file is damaged; nothing is bridged until it is fixed");
      known = [];
      for (const id of [...units.keys()]) await stopUnit(id, "settings");
    } else {
      known = loaded.repos;
      const wanted = new Map(loaded.repos.map((r) => [r.repo_gh_id, r]));
      for (const [id, unit] of [...units]) if (!wanted.has(id) || !sameBinding(unit.repo, wanted.get(id)!)) await stopUnit(id, "disabled");
      for (const id of [...refused.keys()]) if (!wanted.has(id)) refused.delete(id);
      if (!deps.accepted()) {
        // A later hello that dropped `engine_bridge_v1` (or was not answered) stops every running repo: it waits for a hello that kept it.
        for (const id of [...units.keys()]) {
          await stopUnit(id, "hello");
          refused.delete(id);
        }
      } else {
        if (loaded.repos.some((r) => !units.has(r.repo_gh_id)) || !listFresh()) await probe();
        for (const repo of loaded.repos) {
          const id = repo.repo_gh_id;
          try {
            const verdict = listVerdict(repo);
            // A repo that is running leaves when the cloud's list drops it, or when the list is older than ALLOWED_MAX_AGE_MS; it waits until a fresh list holds it again.
            if (units.has(id)) {
              if (verdict === "not_allowed") await stopUnit(id, "not_allowed");
              else if (verdict === "cloud_list") {
                await stopUnit(id, "cloud_list");
                refused.delete(id);
              }
              continue;
            }
            if (verdict === "cloud_list") refused.delete(id);
            else if (verdict === "not_allowed") refused.set(id, "not_allowed");
            else if (!ENGINE_VERSION_PATTERN.test(deps.runnerVersion)) refused.set(id, "bridge_version");
            else {
              const version = readEngineVersion(repo.repo_root, deps.uid);
              if (version.ok) start(repo, version.version);
              else refused.set(id, `engine_${version.why}`);
            }
          } catch {
            // fx-swallow-ok: one repo that fails to be judged is refused with a closed word and the others' pass goes on; the error could name a path
            refused.set(id, "unexpected");
          }
        }
      }
    }
    await manageSocket();
    writeStatus();
  }

  async function manageSocket(): Promise<void> {
    if (units.size === 0) {
      if (socket !== undefined) await socket.close();
      socket = undefined;
      socketState = "off";
      return;
    }
    if (socket !== undefined) return;
    try {
      socket = await serveDecideSocket({
        socketPath: socketPathFor({ XDG_RUNTIME_DIR: deps.xdgRuntimeDir }),
        uid: deps.uid,
        post: decidePost,
        pairedRepos: () => [...units.keys()],
        // Forwarded only on an explicit `true` from the last pull: no unit, no pull yet, or no control for the repo reads as off (the socket refuses on `false`).
        operateEnabled: (id) => units.get(id)?.puller.operateEnabled(id) === true,
        log: deps.log,
      });
      socketState = "serving";
    } catch {
      // fx-swallow-ok: the error could name a path; the bridge keeps uploading without the decide socket, says so once, and tries again next pass
      if (socketState !== "unavailable") deps.log("engine-bridge: the decide socket could not be started; the engine cannot ask for decisions until it can");
      socketState = "unavailable";
    }
  }

  function writeStatus(): void {
    const now = clock.now().getTime();
    const snapshot = status();
    const json = JSON.stringify(snapshot);
    if (json === lastWrite.json && now - lastWrite.at < STATUS_WRITE_MS) return;
    try {
      writePrivateFile(deps.runnerStateDir, BRIDGE_STATUS_FILE, `${JSON.stringify({ version: 1, updated_at: new Date(now).toISOString(), ...snapshot })}\n`);
      lastWrite = { json, at: now };
    } catch {
      // fx-swallow-ok: a status file that cannot be written only leaves `status` saying "not running"
    }
  }

  const main = (async () => {
    while (!root.signal.aborted) {
      try {
        await supervise();
      } catch {
        // fx-swallow-ok: one failed pass is a fixed line and another pass; it never ends the supervisor or touches the claim loop
        deps.log("engine-bridge: a supervising pass failed; trying again later");
      }
      await clock.sleep(deps.superviseMs ?? SUPERVISE_MS, root.signal);
    }
  })();

  return {
    status,
    async stop() {
      root.abort();
      await main;
      for (const id of [...units.keys()]) await stopUnit(id, "stopped");
      if (socket !== undefined) await socket.close();
      socket = undefined;
    },
  };
}

/** What `engine-bridge status` reads: the daemon's status file, with its age. Undefined when there is none or it is damaged. */
export function readDaemonStatus(runnerStateDir: string, nowMs: number): { status: DaemonStatus; ageS: number } | undefined {
  let text: string | undefined;
  try {
    text = readPrivateFile(runnerStateDir, BRIDGE_STATUS_FILE);
  } catch {
    // fx-swallow-ok: an unreadable status file is "no status"
    return undefined;
  }
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as DaemonStatus & { version?: number; updated_at?: string };
    const at = Date.parse(parsed.updated_at ?? "");
    if (parsed.version !== 1 || !Number.isFinite(at) || !Array.isArray(parsed.repos)) return undefined;
    return { status: parsed, ageS: Math.max(0, Math.round((nowMs - at) / 1000)) };
  } catch {
    // fx-swallow-ok: a status file that is not JSON is "no status"
    return undefined;
  }
}

