/**
 * The runner's command pull: it asks the cloud for the engine commands signed for this runner, judges each one, and hands the valid ones to the engine
 * through the inbox. It pulls at start, when the wake epoch moves, and as a safety net every 10 minutes (every 20 seconds while no wake answer has ever been seen).
 *
 * Each command is judged in this order, and the first failure acks `refused` with that reason and writes nothing to the inbox:
 * signature (`signature_invalid`), `runner_id` is this runner (`wrong_runner`), `repo_gh_id` is a bridged repo (`wrong_repo`), the repo's controls say operate is
 * on (`operate_off`), `expires_at` is ahead (`expired`), `command_seq` is above the last handed over for the repo and the id is not one seen in the last
 * 24 hours (`seq_not_increasing` for both: the closed refusal list has no word for a replayed id).
 * Before any command of a pull is written, every control in the reply is handled: a halt epoch above the local one runs the kill path (`handleControl`) first,
 * and its `halt_applied` is reported. A halt that could not be checked is reported with one survivor, never none.
 * Outcomes the engine left in `done/` are acked; a command the engine has not consumed 10 minutes after its expiry is acked `not_confirmed`.
 * A start-like command (`start_day`, `resume_loop`, `request_spawn`, `set_dial`) is also refused `halted` when the repo's control says halted, when a local stop is in force
 * (`localHalted`), or when its `halt_epoch` is below the control's.
 * `watch` is the one kind that operate being off does not refuse (D#845 watch mode: it only changes how much the bridge uploads). It is applied to the bridge's own watch state (`onWatch`)
 * and never written to the inbox, and its `until` must be ahead of the runner's own clock by no more than 600 s (`expired` otherwise).
 * The pull and the acks back off on their own: an ack the cloud will not take is kept and sent again later, and it never keeps the pull, or the halt controls in the
 * reply, from being handled. A permanent 400 from the cloud backs off at 300 seconds and drops nothing; other failures wait 2, 4, 8 ... 300 seconds. Log lines are fixed text.
 */
import { EngineControl, JobSignatureError, MAX_CLOCK_SKEW_S, isBridgeCommandKind, verifyEngineCommand, watchUntilAcceptable, type EngineCommand, type EngineCommandAck, type EngineCommandOf, type JobKeyring } from "@fulcrumaxe/runner-protocol";
import { signedPost, type CloudReply, type SignedPost } from "../cloud.js";
import type { Clock } from "../daemon/lease.js";
import { Inbox, InboxRefused, notConfirmedDueMs } from "./inbox.js";

export const PULL_PATH = "/api/runner/engine/commands/pull";
export const ackPath = (commandId: string): string => `/api/runner/engine/commands/${commandId}/ack`;
/**
 * The pull that does not wait for a wake: commands arrive on the wake path (the cloud marks the account's epoch, and the runner's wake check, 20 s by default, moves
 * `wakeEpoch`), so this only catches what a lost wake missed. It still runs once at start and again after every wake. A failed pull is retried on its own back-off, not on this.
 */
export const SAFETY_PULL_MS = 600_000;
/** The pull interval of a runner the wake path has told nothing yet (no grant, a cloud without a wake key): without a wake there is nothing else to be woken by. */
export const NO_WAKE_PULL_MS = 20_000;
export const WAKE_CHECK_MS = 1_000;
/** How often the inbox's own folders are looked at for outcomes the engine wrote (a local read; a request is made only when an ack is owed). */
export const ACK_CHECK_MS = 5_000;
export const PERMANENT_400_BACKOFF_S = 300;
export const BACKOFF_START_S = 2;
export const BACKOFF_MAX_S = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Control = ReturnType<typeof EngineControl.parse>;
/**
 * The pull reply as this runner reads it: each command is judged one by one (so one bad command cannot hide the rest), the controls are the protocol's, and
 * `allowed_repos` (which a later row reads) may be present.
 */
function parsePullReply(body: unknown): { commands: unknown[]; controls: Control[] } | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { commands, controls, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).some((k) => k !== "allowed_repos") || !Array.isArray(commands) || commands.length > 20 || !Array.isArray(controls) || controls.length > 10) return undefined;
  const parsed = controls.map((c) => EngineControl.safeParse(c));
  return parsed.every((p) => p.success) ? { commands, controls: parsed.map((p) => (p as { data: Control }).data) } : undefined;
}
type Refusal = EngineCommandAck["refusal"] & string;
/** The kinds that start something. While a repo is halted, or a command was made before the halt, none of them may reach the engine. */
const START_LIKE: ReadonlySet<string> = new Set(["start_day", "resume_loop", "request_spawn", "set_dial"]);

/** What the kill path (`handleControl`, EB-11b) answers; `none` is a halt that could not be checked. */
export interface HaltOutcome {
  halt_epoch: number;
  method: "scope" | "group_only" | "none";
  survivors: number;
}
export interface HaltReport {
  halt_epoch: number;
  method: "scope" | "group_only";
  survivors: number;
}
export type BackoffWhy = "network" | "server" | "unauthorized" | "refused" | "unexpected";
export interface PullStatus {
  state: "idle" | "backoff";
  /** Why it is backing off; null when it is not. */
  why: BackoffWhy | null;
}

export interface InboxLoopDeps {
  /** One signed POST to the cloud (`signedPost` bound to the origin and the runner key). Never throws: a failure to reach the cloud is a reply of status 0. */
  post: (path: string, body: unknown) => Promise<CloudReply>;
  inbox: Inbox;
  /** The pinned public keys the cloud's commands are signed with. */
  keyring: JobKeyring;
  runnerId: string;
  clock: Clock;
  /** The repos this runner bridges, by GitHub id, as the cloud last said (the controls and dials reply). The runner keeps no list of its own. */
  bridgedRepos: () => readonly number[];
  /** The wake epoch the claim loop last saw; null before the first. A change starts a pull. */
  wakeEpoch: () => number | null;
  /** EB-11b `handleControl(stateDir, handle, control, deps, {repoGhId})`, bound by the daemon. */
  handleControl: (repoGhId: number, control: { halt_epoch: number; halted: boolean }) => Promise<HaltOutcome | undefined>;
  /** Whether a local stop is in force for the repo, read through the halt-state reader the kill path uses. Fails closed: when it cannot tell, it answers true. */
  localHalted: (repoGhId: number) => boolean;
  /** Sends `halt_applied` through the bridge. */
  reportHalt: (repoGhId: number, report: HaltReport) => void;
  /** Called after each successful pull, once its controls have been handled (the halt first). `haltFailed` is true when the pull asked for a halt and the kill path could not be completed: the hook must then withdraw the bridge state, never publish "operate on". A throw is ignored. */
  onPulled?: (repoGhId: number, haltFailed: boolean) => void;
  /**
   * Applies a `watch` command (D#845 watch mode) to the bridge's own watch state, never to the engine's inbox. It is judged like any command (signature, runner, repo, expiry, sequence),
   * except that operate being off does not refuse it: a watch changes how much is uploaded and never acts on the engine. Absent, a `watch` is refused (`wrong_repo`) and nothing is applied.
   */
  onWatch?: (repoGhId: number, command: EngineCommandOf<"watch">) => void;
  /** Gets fixed text only. */
  log: (line: string) => void;
}

/** `signedPost` bound to the cloud and the runner's key. It never throws: a request that cannot reach the cloud is a reply of status 0. */
export function createCloudPost(config: Omit<SignedPost, "path" | "body" | "now"> & { now: () => Date }): (path: string, body: unknown) => Promise<CloudReply> {
  return async (path, body) => {
    try {
      return await signedPost({ ...config, path, body, now: config.now() });
    } catch {
      // fx-swallow-ok: the error text could name an address; a failed request is only status 0
      return { status: 0, body: undefined, retryAfter: undefined, protectedDeployment: false };
    }
  };
}

/** Whether a local stop is in force. A reader that throws is a stop nobody could rule out: it counts as halted, and the rest of the pull goes on. */
function localStopOrUnknown(deps: Pick<InboxLoopDeps, "localHalted">, repoGhId: number): boolean {
  try {
    return deps.localHalted(repoGhId);
  } catch {
    // fx-swallow-ok: the halt-state reader's error could name a path; failing closed (halted) is the answer, and the pull is not stopped by it
    return true;
  }
}

/** Judges one pulled command. `controls` is the reply's controls by repo. Returns the verified command, or the first refusal. */
export function judge(raw: unknown, deps: Pick<InboxLoopDeps, "keyring" | "runnerId" | "clock" | "localHalted">, bridged: ReadonlySet<number>, controls: ReadonlyMap<number, Pick<Control, "operate_enabled" | "halted" | "halt_epoch">>, lastSeq: Record<string, number>, seen: Record<string, number>): { ok: true; command: EngineCommand } | { ok: false; refusal: Refusal } {
  const now = deps.clock.now();
  let command: EngineCommand;
  try {
    command = verifyEngineCommand(raw, deps.keyring, now);
  } catch (error) {
    // An expired or far-future command is judged again at a moment inside its life, so the later checks still run in their order.
    const expiresAt = (raw as { command?: { expires_at?: unknown } } | null)?.command?.expires_at;
    const at = typeof expiresAt === "string" ? Date.parse(expiresAt) - 1 : Number.NaN;
    if (!(error instanceof JobSignatureError) || error.code !== "expired" || !Number.isFinite(at)) return { ok: false, refusal: "signature_invalid" };
    try {
      command = verifyEngineCommand(raw, deps.keyring, new Date(at));
    } catch {
      // fx-swallow-ok: a signature that fails at any moment is simply invalid
      return { ok: false, refusal: "signature_invalid" };
    }
  }
  if (command.runner_id !== deps.runnerId) return { ok: false, refusal: "wrong_runner" };
  // A bridge command is the runner's own (bridgeCommands.ts) and never goes to an engine inbox.
  if (isBridgeCommandKind(command.kind)) return { ok: false, refusal: "wrong_repo" };
  if (!bridged.has(command.repo_gh_id)) return { ok: false, refusal: "wrong_repo" };
  const control = controls.get(command.repo_gh_id);
  // Only `watch` is exempt from the operate gate (it never acts on the engine); every other kind keeps it.
  if (control?.operate_enabled !== true && command.kind !== "watch") return { ok: false, refusal: "operate_off" };
  if (START_LIKE.has(command.kind) && control !== undefined && (control.halted || command.halt_epoch < control.halt_epoch || localStopOrUnknown(deps, command.repo_gh_id))) return { ok: false, refusal: "halted" };
  if (Date.parse(command.expires_at) <= now.getTime() || Date.parse(command.issued_at) > now.getTime() + MAX_CLOCK_SKEW_S * 1000) return { ok: false, refusal: "expired" };
  // Against this runner's own clock, whatever the issuer's said: a watch that is over, or reaches further than ten minutes, is not applied.
  if (command.kind === "watch" && !watchUntilAcceptable(command, now)) return { ok: false, refusal: "expired" };
  if (command.command_seq <= (lastSeq[String(command.repo_gh_id)] ?? 0) || Object.hasOwn(seen, command.command_id.toLowerCase())) return { ok: false, refusal: "seq_not_increasing" };
  return { ok: true, command };
}

export class CommandPuller {
  /** The pull's back-off and the acks' back-off are separate: a failed ack never stops a pull. */
  private holdUntil = 0;
  private failures = 0;
  private why: BackoffWhy | null = null;
  private ackHoldUntil = 0;
  private ackFailures = 0;
  private ackWhy: BackoffWhy | null = null;
  private inboxRefused = false;
  /** Acks the cloud has not taken yet, by command id. They are sent again, never dropped. */
  private readonly unsent = new Map<string, { name: string | null; ack: EngineCommandAck }>();
  private controls = new Map<number, Control>();

  constructor(private readonly deps: InboxLoopDeps) {}

  status(): PullStatus {
    const why = this.why ?? this.ackWhy;
    return { state: why === null ? "idle" : "backoff", why };
  }
  /** What the last pull said about a repo's operate switch; undefined before the first pull answers for it. */
  operateEnabled(repoGhId: number): boolean | undefined {
    return this.controls.get(repoGhId)?.operate_enabled;
  }

  /** Pulls at start, on a wake, and every `SAFETY_PULL_MS` (`NO_WAKE_PULL_MS` before the wake path has answered); after a failure, as soon as its back-off ends. Until `signal` aborts. A pass that throws is a failure and a wait, never the end of the loop. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const epoch = this.deps.wakeEpoch();
      const startedAt = this.deps.clock.now().getTime();
      try {
        await this.pullOnce();
      } catch {
        // fx-swallow-ok: the error text could hold a command or a path; a fixed line is logged and the pull is tried again after a wait
        this.deps.log("engine-inbox: a pull failed; trying again later");
        this.fail("unexpected");
      }
      let ackCheckedAt = startedAt;
      for (;;) {
        await this.deps.clock.sleep(WAKE_CHECK_MS, signal);
        const nowMs = this.deps.clock.now().getTime();
        if (signal.aborted) break;
        // The safety pull is rare now, so an outcome the engine wrote is acked on its own: it must not wait 10 minutes to show as done.
        if (nowMs - ackCheckedAt >= ACK_CHECK_MS || nowMs < ackCheckedAt) {
          ackCheckedAt = nowMs;
          await this.sendAcks();
        }
        if (nowMs < Math.min(this.holdUntil, this.ackHoldUntil)) continue;
        const failing = this.why !== null || this.ackWhy !== null;
        const current = this.deps.wakeEpoch();
        const every = current === null ? NO_WAKE_PULL_MS : SAFETY_PULL_MS;
        // A clock that went back (a negative elapsed time) is not a pull that is not yet due for ever: it pulls.
        if (current !== epoch || failing || nowMs - startedAt >= every || nowMs < startedAt) break;
      }
    }
  }

  /** One pull: acks first, then the pull, the controls, the commands. Never throws for a cloud or inbox failure. */
  async pullOnce(): Promise<void> {
    // A failed ack pass never skips the pull: the halt controls in the reply are handled whatever the acks did.
    await this.sendAcks();
    if (this.deps.clock.now().getTime() < this.holdUntil) return;
    const repos = [...new Set(this.deps.bridgedRepos())].slice(0, 10);
    if (repos.length === 0) return;
    const state = this.deps.inbox.loadState(this.deps.clock.now().getTime());
    const after: Record<string, number> = {};
    for (const id of repos) if (state.repos[String(id)] !== undefined) after[String(id)] = state.repos[String(id)]!;
    const reply = await this.deps.post(PULL_PATH, { repo_gh_ids: repos, after_seq: after });
    const parsed = reply.status === 200 ? parsePullReply(reply.body) : undefined;
    if (parsed === undefined) return void this.fail(this.why200(reply));
    this.succeed();
    const bridged = new Set(repos);
    this.controls = new Map(parsed.controls.filter((c) => bridged.has(c.repo_gh_id)).map((c) => [c.repo_gh_id, c]));
    // The kill path comes before anything of this pull reaches the inbox.
    const haltFailed = new Set<number>();
    for (const [repoGhId, control] of this.controls) if (!(await this.applyControl(repoGhId, { halt_epoch: control.halt_epoch, halted: control.halted }))) haltFailed.add(repoGhId);
    for (const repoGhId of repos) this.notePulled(repoGhId, haltFailed.has(repoGhId));
    const raws = [...parsed.commands].sort((a, b) => seqOf(a) - seqOf(b));
    for (const raw of raws) {
      const id = idOf(raw);
      if (id === null) continue;
      const verdict = judge(raw, this.deps, bridged, this.controls, state.repos, state.seen);
      if (!verdict.ok) {
        this.unsent.set(id, { name: null, ack: { outcome: "refused", refusal: verdict.refusal } });
        continue;
      }
      const { command } = verdict;
      if (haltFailed.has(command.repo_gh_id)) {
        this.unsent.set(id, { name: null, ack: { outcome: "refused", refusal: "halted" } });
        continue;
      }
      if (command.kind === "watch") {
        // The bridge's own: applied to the watch state, recorded as seen like any command, and never written to an inbox (the engine's ticker would only refuse it).
        if (this.deps.onWatch === undefined) {
          this.unsent.set(id, { name: null, ack: { outcome: "refused", refusal: "wrong_repo" } });
          continue;
        }
        try {
          this.deps.onWatch(command.repo_gh_id, command);
        } catch {
          // fx-swallow-ok: the handler's error could name a path; nothing is applied and the command is acked refused with the one fixed reason
          this.deps.log("engine-inbox: a watch could not be applied");
          this.unsent.set(id, { name: null, ack: { outcome: "refused", refusal: "wrong_repo" } });
          continue;
        }
        state.repos[String(command.repo_gh_id)] = command.command_seq;
        state.seen[command.command_id.toLowerCase()] = this.deps.clock.now().getTime();
        this.deps.inbox.saveState(state);
        this.unsent.set(id, { name: null, ack: { outcome: "applied" } });
        continue;
      }
      try {
        this.deps.inbox.write(command);
      } catch (error) {
        // fx-swallow-ok: the error could name a path or a command; nothing was written, the command stays unacked (the cloud reads it as not confirmed) and a fixed line is logged
        if (error instanceof InboxRefused) {
          if (!this.inboxRefused) this.deps.log("engine-inbox: the inbox directory is not safe (a link, someone else's, or open to others); nothing was written");
          this.inboxRefused = true;
        } else this.deps.log("engine-inbox: a command could not be written");
        continue;
      }
      this.inboxRefused = false;
      state.repos[String(command.repo_gh_id)] = command.command_seq;
      state.seen[command.command_id.toLowerCase()] = this.deps.clock.now().getTime();
      this.deps.inbox.saveState(state);
    }
    await this.sendAcks();
  }

  private notePulled(repoGhId: number, haltFailed: boolean): void {
    try {
      this.deps.onPulled?.(repoGhId, haltFailed);
    } catch {
      // fx-swallow-ok: a hook that fails must not stop the pull; the hook logs its own fixed line
    }
  }

  /** Handles one repo's control. False when a halt was asked for and the kill path could not be completed. */
  private async applyControl(repoGhId: number, control: { halt_epoch: number; halted: boolean }): Promise<boolean> {
    let applied: HaltOutcome | undefined;
    let ok = true;
    try {
      applied = await this.deps.handleControl(repoGhId, control);
    } catch (error) {
      // fx-swallow-ok: the kill path says what it did even when the halt file could not be written; anything else is an unchecked halt, reported with one survivor
      const carried = (error as { applied?: HaltOutcome } | null)?.applied;
      applied = carried ?? { halt_epoch: control.halt_epoch, method: "none", survivors: 1 };
      ok = false;
      this.deps.log("engine-inbox: the halt could not be fully applied");
    }
    if (applied === undefined) return true;
    const survivors = Number.isSafeInteger(applied.survivors) && applied.survivors >= 0 ? applied.survivors : 1;
    this.deps.reportHalt(repoGhId, { halt_epoch: applied.halt_epoch, method: applied.method === "scope" ? "scope" : "group_only", survivors: applied.method === "none" ? Math.max(1, survivors) : survivors });
    return ok;
  }

  /** Acks everything owed: outcomes the engine wrote, commands it did not consume in time, and acks that failed before. A failure keeps them and backs the acks off; it never throws. */
  private async sendAcks(): Promise<void> {
    try {
      const nowMs = this.deps.clock.now().getTime();
      for (const done of this.deps.inbox.consumed()) if (!this.unsent.has(done.commandId)) this.unsent.set(done.commandId, { name: done.name, ack: done.ack });
      const seen = this.deps.inbox.loadState(nowMs).seen;
      for (const w of this.deps.inbox.waiting()) {
        // The engine can rewrite the file, so the time the runner recorded when it wrote it decides; the file's expiry can only make that earlier.
        const due = notConfirmedDueMs(w, seen[w.commandId.toLowerCase()]);
        if (this.unsent.has(w.commandId) || nowMs < due) continue;
        this.unsent.set(w.commandId, { name: w.name, ack: { outcome: "not_confirmed" } });
      }
    } catch (error) {
      // fx-swallow-ok: an unsafe inbox is one fixed line; acks already owed are still sent below
      if (error instanceof InboxRefused && !this.inboxRefused) this.deps.log("engine-inbox: the inbox directory is not safe (a link, someone else's, or open to others); nothing was written");
      this.inboxRefused = error instanceof InboxRefused;
    }
    if (this.deps.clock.now().getTime() < this.ackHoldUntil) return;
    for (const [id, owed] of [...this.unsent]) {
      const reply = await this.deps.post(ackPath(id), owed.ack);
      if (reply.status === 200 || reply.status === 404 || reply.status === 409) {
        // 404 and 409 mean the cloud will not take this ack (another runner's, or already acked): it is settled either way.
        this.unsent.delete(id);
        this.ackSucceed();
        if (owed.name !== null) {
          try {
            this.deps.inbox.settle(owed.name, owed.ack);
          } catch {
            // fx-swallow-ok: an unsettled file is acked again, and the cloud answers 409
            this.deps.log("engine-inbox: a settled command could not be moved");
          }
        }
        continue;
      }
      this.ackFail(this.why200(reply));
      return;
    }
    this.ackSucceed();
  }

  private why200(reply: CloudReply): BackoffWhy {
    if (reply.status === 400) return "refused";
    if (reply.status === 401 || reply.status === 403 || reply.protectedDeployment) return "unauthorized";
    if (reply.status >= 500) return "server";
    return reply.status === 0 ? "network" : "unexpected";
  }

  private succeed(): void {
    if (this.why !== null) this.deps.log("engine-inbox: the cloud is taking pulls again");
    this.why = null;
    this.failures = 0;
    this.holdUntil = 0;
  }

  private ackSucceed(): void {
    if (this.ackWhy !== null) this.deps.log("engine-inbox: the cloud is taking acks again");
    this.ackWhy = null;
    this.ackFailures = 0;
    this.ackHoldUntil = 0;
  }

  /** A permanent 400 waits 300 s; anything else waits 2, 4, 8 ... 300 s. */
  private fail(why: BackoffWhy): void {
    if (this.why === null) this.deps.log("engine-inbox: the cloud did not take the request; trying again later");
    this.why = why;
    this.holdUntil = this.deps.clock.now().getTime() + this.waitSeconds(why, this.failures) * 1000;
    this.failures += 1;
  }

  private ackFail(why: BackoffWhy): void {
    if (this.ackWhy === null) this.deps.log("engine-inbox: the cloud did not take an ack; trying again later");
    this.ackWhy = why;
    this.ackHoldUntil = this.deps.clock.now().getTime() + this.waitSeconds(why, this.ackFailures) * 1000;
    this.ackFailures += 1;
  }

  private waitSeconds(why: BackoffWhy, failures: number): number {
    return why === "refused" ? PERMANENT_400_BACKOFF_S : Math.min(BACKOFF_MAX_S, BACKOFF_START_S * 2 ** Math.min(failures, 10));
  }
}

const idOf = (raw: unknown): string | null => {
  const id = (raw as { command?: { command_id?: unknown } } | null)?.command?.command_id;
  return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
};
const seqOf = (raw: unknown): number => {
  const seq = (raw as { command?: { command_seq?: unknown } } | null)?.command?.command_seq;
  return typeof seq === "number" ? seq : Number.MAX_SAFE_INTEGER;
};
