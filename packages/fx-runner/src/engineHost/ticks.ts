/**
 * EB-12b: ticks replace the Team Lead's session crons. The runner sends the hosted Team Lead one fixed message at a time (a "tick") and the Team Lead does one
 * turn of work per message. Four kinds:
 *  - `loop` every N minutes (5 to 60, default 15), `checkin` for each entry of the engine config's `cloud_bridge.ticks[]`, `start_day` at a configured local time,
 *    and `command` for a cloud command the engine's reader handed to the host (`hostInbox.ts`).
 * Single flight: a tick is sent only after the previous turn's `result`. A tick that arrives mid-turn is queued, and a second one of a kind already queued is
 * dropped and counted. `pause_loop` stops `loop` and `checkin` ticks and `resume_loop` lets them go on. Every message is a template of `prompts.ts`.
 * A command is claimed before it is applied and answered with exactly one outcome file: `applied`, `refused` (with a reason of the closed list), `expired`, or
 * `not_confirmed` (a spawn or stop that no `agent_started` / `agent_stopped` followed within 10 minutes).
 * A command is applied at most once, over restarts too: `done/<name>.outcome.json` already there means it is never sent; a host exit settles every command still
 * queued as `refused` (`host_not_running`) and the one in flight as `not_confirmed`. The expiry and the gate are checked again when a command is about to be sent,
 * not only when it is claimed. While halted only `answer_ask`, `pause_loop` and `stop_agent` are applied.
 * Known limits:
 *  - a `result` line carries nothing that ties it to the message that caused it (the host's argument vector is fixed and has no flag that would echo the input), so a
 *    turn the host starts by itself (a finished background task) and ends while a tick is in flight is counted as that tick's turn. That is accepted, because the
 *    alternative (guessing) is worse, and it is bounded two ways: a `result` that arrives with no tick in flight is ignored, and every tick has a turn timeout
 *    (`TURN_MAX_MS`): a turn that has not ended by then ends the tick as `error` (its command, if it is one, as `not_confirmed`), the host is not sent anything else
 *    until the abandoned turn's own `result` arrives (consumed, not counted as any tick's) or one more timeout has passed, so a late `result` can never end the
 *    next tick early;
 *  - an `agent_started` carries no command id, so a spawn is matched by (role, discussion) alone: one event settles the oldest waiting request for that pair, and an
 *    agent the Team Lead spawned for the same pair on its own can settle an owner's request. A request for a pair that is already running is `not_confirmed`.
 * EB-12c adds the `reorient` tick: sent first (before queued ticks, and even while paused) after the host's context was compacted.
 */
import { EngineCommand, ROW_KEY_PATTERN, type EngineCommandAck } from "@fulcrumaxe/runner-protocol";
import { EngineStateError } from "../engineBridge/stateFiles.js";
import type { AnsweredStore } from "./answered.js";
import type { Claimed, HostInbox } from "./hostInbox.js";
import { renderPrompt } from "./prompts.js";
import type { TurnResult } from "./supervisor.js";

export const POLL_MS = 5_000;
export const LOOP_MIN_DEFAULT = 15;
export const LOOP_MIN_BOUNDS = { min: 5, max: 60 } as const;
/** How long a requested spawn or stop has to show up as `agent_started` / `agent_stopped` before its command is `not_confirmed`. */
export const CONFIRM_MS = 10 * 60_000;
/** A turn that has sent no `result` this long is given up: its tick ends as an error and the queue moves on. */
export const TURN_MAX_MS = 30 * 60_000;
/** The kinds a halt does not stop: they only answer, pause or stop. */
const WHILE_HALTED: ReadonlySet<string> = new Set(["answer_ask", "pause_loop", "stop_agent"]);

type CommandRefusal = NonNullable<EngineCommandAck["refusal"]>;
export type TickKind = "loop" | "checkin" | "start_day" | "command" | "reorient";
export type CredentialMode = "subscription" | "api_key";
/** The wire shapes of EB-1's `tick_started` and `tick_ended` (the emitter adds the envelope). */
export type TickEvent =
  | { kind: "tick_started"; tick_kind: TickKind }
  | { kind: "tick_ended"; tick_kind: TickKind; outcome: "ok" | "error" | "interrupted"; duration_s: number; credential_mode: CredentialMode; model?: string; usage?: TurnResult["usage"] };
/** An agent event the engine bridge saw; the ticker settles a spawn or stop command on it. */
export type AgentEvent =
  | { kind: "agent_started"; role: string; discussion?: number | undefined }
  | { kind: "agent_stopped"; agent_id: string }
  | { kind: "spawn_blocked"; role: string; discussion?: number | undefined; reason?: string | undefined };

export interface TickSettings {
  /** The runner setting: minutes between `loop` ticks. Out of bounds is clamped. */
  loopMin?: number | undefined;
  /** `cloud_bridge.ticks[]` of the engine config; an entry whose name is not a row key or whose interval is not 5 to 1440 minutes (the loop's own floor) is ignored. */
  checkins?: ReadonlyArray<{ name: string; every_min: number }> | undefined;
  /** `HH:MM` local time of the daily `start_day` tick; left out, there is none. */
  startDayAt?: string | undefined;
}

export interface TickerDeps {
  /** Sends one user message to the host; false when no host is running. */
  send: (text: string) => boolean;
  /** Writes a fresh heartbeat into `engine-host.json`; false when there is no host (nothing is claimed then). */
  touch: () => boolean;
  emit: (event: TickEvent) => void;
  now: () => number;
  after: (ms: number, fn: () => void) => () => void;
  settings: () => TickSettings;
  /** The machine's local date (`YYYY-MM-DD`) and time (`HH:MM`). */
  localClock: () => { date: string; hhmm: string };
  credentialMode: () => CredentialMode;
  repoGhId: number;
  /** Why no command may be applied right now (`halted`, or the cloud's operate switch is off), or undefined. */
  gate: () => "halted" | "operate_off" | undefined;
  inbox: HostInbox;
  /** The asks already answered (EB-12c); left out, they are remembered for this process only. */
  answered?: AnsweredStore | undefined;
  /** One fixed line for the host log; never an error's text. Left out, nothing is logged. */
  log?: ((line: string) => void) | undefined;
  /** How long a tick's turn may take; default `TURN_MAX_MS`. */
  turnTimeoutMs?: number | undefined;
  /** The agent events seen since the last call (the engine's `agent_started` / `agent_stopped`); read at every poll and handed to `noteAgentEvent`. Never throws. */
  agentEvents?: (() => AgentEvent[]) | undefined;
}

export interface Ticker {
  start(): void;
  /** One round: claim commands, queue the ticks that are due, send the next one if the host is idle. The timer calls it every `POLL_MS`; tests call it directly. */
  poll(): void;
  /** The supervisor's `observer.onTurn`. */
  onTurn(turn: TurnResult): void;
  /** The supervisor's `observer.onExit`: the turn in flight is over, interrupted. */
  onHostExit(): void;
  /** The supervisor's `observer.onCompaction` (EB-12c): the next tick sent is the `reorient` one. */
  onCompaction(): void;
  noteAgentEvent(event: AgentEvent): void;
  /** Ends the ticker: queued commands are refused (`host_not_running`), a command in flight or waiting to be confirmed is `not_confirmed`. */
  close(): void;
  counts(): { dropped: number; queued: number; paused: boolean; outcomeWriteFailures: number; timedOut: number };
}

interface Confirm {
  match: (e: AgentEvent) => boolean;
  /** An event that says the request will not happen: settles it as `refused`, or as `not_confirmed` when the reason says nothing about the owner's request itself. */
  blocked?: ((e: AgentEvent) => CommandRefusal | "not_confirmed" | undefined) | undefined;
  /** True when one event settles every waiting request that matches it, false when only the oldest. */
  all: boolean;
}
interface Tick {
  /** What a duplicate is judged by. A command's key is its own name: commands are never merged. */
  key: string;
  kind: TickKind;
  prompt: string;
  command?: { name: string; kind: string; askId?: string; expiresAt: number; confirm?: Confirm } | undefined;
}

/**
 * What a `spawn_blocked` reason means for the owner's request. A halt is `halted`; a limit the spawn checks enforce (breaker, budget, planned PRs, the cloud's denial)
 * is `ceiling`. A reason that is no limit at all (no Spec to build from, the cloud not reachable, an unnamed one) says the request was not carried out and not why,
 * so it is `not_confirmed`, never a ceiling the owner would go and raise.
 */
function blockedOutcome(reason: string | undefined): CommandRefusal | "not_confirmed" {
  if (reason === "halted") return "halted";
  if (reason === "no_spec" || reason === "cloud_unreachable" || reason === "other") return "not_confirmed";
  return "ceiling";
}

const ANSWERED_UNREADABLE = "the answered-asks record could not be read; answers are held until it is fixed";

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export function createTicker(deps: TickerDeps): Ticker {
  const memoryAnswered = new Map<string, number>();
  const answered: AnsweredStore = deps.answered ?? { has: (id) => memoryAnswered.has(id), mark: (id, at) => void memoryAnswered.set(id, at) };
  const queue: Tick[] = [];
  let inFlight: { tick: Tick; at: number } | undefined;
  let cancelTurn: (() => void) | undefined;
  /** A turn was abandoned at its timeout and its own `result` has not come yet: nothing is sent until it does (or one more timeout passes). */
  let orphan = false;
  let cancelOrphan: (() => void) | undefined;
  let orphanAt = 0;
  let timedOut = 0;
  const turnMs = deps.turnTimeoutMs ?? TURN_MAX_MS;
  const waiting = new Map<string, { confirm: Confirm; cancel: () => void }>();
  let paused = false;
  let closed = false;
  let dropped = 0;
  let writeFailures = 0;
  let lastSeq = 0;
  let cancelPoll: (() => void) | undefined;
  const due: Array<{ key: string; kind: TickKind; every: number; next: number; make: () => Tick }> = [];
  let startDayDate = "";

  const loopMsOf = (s: TickSettings): number => clamp(Math.floor(s.loopMin ?? LOOP_MIN_DEFAULT) || LOOP_MIN_DEFAULT, LOOP_MIN_BOUNDS.min, LOOP_MIN_BOUNDS.max) * 60_000;
  const loopTick = (): Tick => ({ key: "loop", kind: "loop", prompt: renderPrompt("loop") });

  function settle(name: string, ack: EngineCommandAck): void {
    waiting.get(name)?.cancel();
    waiting.delete(name);
    try {
      deps.inbox.writeOutcome(name, ack);
    } catch {
      // fx-swallow-ok: an outcome that cannot be written is counted; the reader and the runner see no outcome and the command is never reported applied
      writeFailures++;
    }
  }
  const refuse = (name: string, refusal: CommandRefusal): void => settle(name, { outcome: "refused", refusal });

  function enqueue(tick: Tick): void {
    if (closed) return;
    if ((tick.kind === "loop" || tick.kind === "checkin") && paused) return;
    if (tick.command === undefined && queue.some((q) => q.key === tick.key)) {
      dropped++;
      return;
    }
    queue.push(tick);
    pump();
  }

  /** Why a command may not be applied now, or undefined. A halt lets the answering, pausing and stopping kinds through. */
  function blockedFor(kind: string): "halted" | "operate_off" | undefined {
    const g = deps.gate();
    return g === "halted" && WHILE_HALTED.has(kind) ? undefined : g;
  }

  function pump(): void {
    while (inFlight === undefined && !orphan && queue.length > 0 && !closed) {
      const tick = queue[0]!;
      const cmd = tick.command;
      if (cmd !== undefined) {
        // It waited in the queue: what was true at the claim is judged again before the message goes out.
        const why = cmd.expiresAt <= deps.now() ? "expired" : blockedFor(cmd.kind);
        if (why !== undefined) {
          queue.shift();
          if (why === "expired") settle(cmd.name, { outcome: "expired" });
          else refuse(cmd.name, why);
          continue;
        }
        // Two answers for one ask may both have been queued before either went out: the second one never does.
        const seen = cmd.askId === undefined ? false : answered.has(cmd.askId, deps.now());
        if (seen === "unknown") {
          queue.shift();
          settle(cmd.name, { outcome: "not_confirmed" });
          logFixed(ANSWERED_UNREADABLE);
          continue;
        }
        if (seen) {
          queue.shift();
          refuse(cmd.name, "already_answered");
          logFixed("a second answer to an ask that was already answered was refused");
          continue;
        }
      }
      if (!deps.send(tick.prompt)) return;
      // Marked when it is sent, not when the engine records it: if the host dies in between, the ask stays answered and the owner's second answer is refused. That is the safe direction, since a second answer could only record twice.
      if (cmd?.askId !== undefined) answered.mark(cmd.askId, deps.now());
      queue.shift();
      const flight = { tick, at: deps.now() };
      inFlight = flight;
      cancelTurn = deps.after(turnMs, () => {
        if (inFlight === flight) timeOut();
      });
      deps.emit({ kind: "tick_started", tick_kind: tick.kind });
      const name = tick.command?.name;
      if (name !== undefined && tick.command?.confirm !== undefined) {
        const cancel = deps.after(CONFIRM_MS, () => settle(name, { outcome: "not_confirmed" }));
        waiting.set(name, { confirm: tick.command.confirm, cancel });
      }
    }
  }

  /** The turn in flight has not ended in time: the tick ends as `error`, its command is `not_confirmed`, and the turn's own `result` is waited for before anything else is sent. */
  function timeOut(): void {
    timedOut++;
    orphan = true;
    orphanAt = deps.now();
    cancelOrphan?.();
    cancelOrphan = deps.after(turnMs, releaseOrphan);
    endTurn("error");
  }

  /** One more timeout has passed since the abandoned turn: nothing more is waited for. Taken by the orphan's own timer and, as a backstop, by the poll. */
  function releaseOrphan(): void {
    if (!orphan) return;
    orphan = false;
    cancelOrphan?.();
    cancelOrphan = undefined;
    pump();
  }

  function endTurn(outcome: "ok" | "error" | "interrupted", turn?: TurnResult): void {
    if (inFlight === undefined) return;
    const { tick, at } = inFlight;
    inFlight = undefined;
    cancelTurn?.();
    cancelTurn = undefined;
    deps.emit({
      kind: "tick_ended",
      tick_kind: tick.kind,
      outcome,
      duration_s: Math.max(0, Math.round((deps.now() - at) / 1000)),
      credential_mode: deps.credentialMode(),
      ...(turn?.model === undefined ? {} : { model: turn.model }),
      ...(turn?.usage === undefined ? {} : { usage: turn.usage }),
    });
    const name = tick.command?.name;
    if (name !== undefined) {
      if (outcome !== "ok") settle(name, { outcome: "not_confirmed" });
      else if (tick.command?.confirm === undefined) settle(name, { outcome: "applied" });
    }
    pump();
  }

  function apply(c: Claimed): void {
    const parsed = EngineCommand.safeParse(c.body);
    if (!parsed.success || `${parsed.data.command_seq}-${parsed.data.command_id}` !== c.name.toLowerCase()) return refuse(c.name, "signature_invalid");
    const cmd = parsed.data;
    // An outcome already on disk means this command was answered (a restart, or a copy the reader handed over again): it is never sent a second time.
    if (deps.inbox.hasOutcome(c.name)) {
      // Answered already: its claimed copy has nothing left to guard, so it goes (a copy handed over again would be skipped here the same way).
      try {
        deps.inbox.dropClaimed(c.name);
      } catch {
        // fx-swallow-ok: a claimed copy that cannot be removed only stays where it is; the command is not applied either way
        logFixed("a claimed command that was already answered could not be removed");
      }
      return;
    }
    // The bridge applies a `watch` itself (commands.ts) and never writes one to the inbox. One that reaches the ticker is refused with the fixed code the bridge uses for a command that is not the engine's, whatever the gate says, and nothing runs.
    if (cmd.kind === "watch") return refuse(c.name, "wrong_repo");
    if (c.seq <= lastSeq) return refuse(c.name, "seq_not_increasing");
    lastSeq = c.seq;
    if (cmd.repo_gh_id !== deps.repoGhId) return refuse(c.name, "wrong_repo");
    if (Date.parse(cmd.expires_at) <= deps.now()) return settle(c.name, { outcome: "expired" });
    const blocked = blockedFor(cmd.kind);
    if (blocked !== undefined) return refuse(c.name, blocked);
    const common = { command_id: cmd.command_id };
    const own = (confirm?: Confirm): Tick["command"] => ({ name: c.name, kind: cmd.kind, expiresAt: Date.parse(cmd.expires_at), ...(confirm === undefined ? {} : { confirm }) });
    try {
      switch (cmd.kind) {
        case "pause_loop":
        case "resume_loop":
          paused = cmd.kind === "pause_loop";
          if (paused) for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.kind === "loop" || queue[i]!.kind === "checkin") queue.splice(i, 1);
          return settle(c.name, { outcome: "applied" });
        case "start_day":
          return enqueue({ key: c.name, kind: "start_day", prompt: renderPrompt("start_day", common), command: own() });
        case "answer_ask":
          const seen = answered.has(cmd.args.ask_id, deps.now());
          if (seen === "unknown") {
            logFixed(ANSWERED_UNREADABLE);
            return settle(c.name, { outcome: "not_confirmed" });
          }
          if (seen) {
            logFixed("a second answer to an ask that was already answered was refused");
            return refuse(c.name, "already_answered");
          }
          return enqueue({ key: c.name, kind: "command", prompt: renderPrompt("answer_ask", { ...common, issued_by: cmd.issued_by, ask_id: cmd.args.ask_id, choice: cmd.args.choice, note: cmd.args.note }), command: { ...own(), askId: cmd.args.ask_id } as NonNullable<Tick["command"]> });
        case "set_dial":
          return enqueue({ key: c.name, kind: "command", prompt: renderPrompt("set_dial", { ...common, ...cmd.args }), command: own() });
        case "request_spawn": {
          const { role, discussion } = cmd.args;
          return enqueue({ key: c.name, kind: "command", prompt: renderPrompt("request_spawn", { ...common, role, discussion }), command: own({ all: false, match: (e) => e.kind === "agent_started" && e.role === role && e.discussion === discussion, blocked: (e) => (e.kind === "spawn_blocked" && e.role === role && e.discussion === discussion ? blockedOutcome(e.reason) : undefined) }) });
        }
        case "stop_agent": {
          const { agent_id } = cmd.args;
          return enqueue({ key: c.name, kind: "command", prompt: renderPrompt("stop_agent", { ...common, agent_id }), command: own({ all: true, match: (e) => e.kind === "agent_stopped" && e.agent_id === agent_id }) });
        }
      }
    } catch {
      // fx-swallow-ok: a value that does not fit its template slot is never sent; the command is answered with the one fixed refusal for a body that is not what was signed
      refuse(c.name, "signature_invalid");
    }
  }

  function scanInbox(): void {
    // The heartbeat is written before anything is claimed, and the supervisor's own timer keeps it fresh while a command is being applied.
    if (!deps.touch()) return;
    let claimed: Claimed[];
    try {
      claimed = deps.inbox.claimAll();
    } catch (error) {
      // fx-swallow-ok: an unsafe directory is "nothing to claim"; any other file error is the same, said once in the log in fixed words. The next poll tries again.
      logFixed(error instanceof EngineStateError ? "the host inbox is not safe to read" : "the host inbox could not be read");
      return;
    }
    for (const c of claimed) {
      try {
        apply(c);
      } catch {
        // fx-swallow-ok: one command that cannot be handled must not stop the others; it stays claimed with no outcome and is never applied
        logFixed("a claimed command could not be handled");
      }
    }
  }

  function logFixed(line: string): void {
    try {
      deps.log?.(`engine host ticker: ${line}`);
    } catch {
      // fx-swallow-ok: a log that cannot be written must not stop the poll
    }
  }

  function scheduleFromSettings(): void {
    const s = deps.settings();
    const loopMs = loopMsOf(s);
    due.push({ key: "loop", kind: "loop", every: loopMs, next: deps.now() + loopMs, make: loopTick });
    for (const c of s.checkins ?? []) {
      if (!ROW_KEY_PATTERN.test(c.name) || !Number.isInteger(c.every_min) || c.every_min < LOOP_MIN_BOUNDS.min || c.every_min > 1440) continue;
      due.push({ key: `checkin:${c.name}`, kind: "checkin", every: c.every_min * 60_000, next: deps.now() + c.every_min * 60_000, make: () => ({ key: `checkin:${c.name}`, kind: "checkin", prompt: renderPrompt("checkin", { name: c.name }) }) });
    }
    // A start-of-day time that has already passed today is not caught up: the first one is tomorrow's.
    if (s.startDayAt !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.startDayAt)) {
      const clock = deps.localClock();
      if (clock.hhmm >= s.startDayAt) startDayDate = clock.date;
    }
  }

  const api: Ticker = {
    start() {
      scheduleFromSettings();
      const arm = (): void => {
        cancelPoll = deps.after(POLL_MS, () => {
          if (closed) return;
          try {
            api.poll();
          } catch {
            // fx-swallow-ok: a poll that throws (a settings or clock source that failed) must not end the ticker or reach the timer; the next round tries again, said once in the log in fixed words
            logFixed("a poll failed");
          } finally {
            if (!closed) arm();
          }
        });
      };
      arm();
    },
    poll() {
      if (closed) return;
      // The turn's own timer ends it too; this is the same step taken from the poll, so a timer that never fired still cannot hold the queue.
      if (inFlight !== undefined && deps.now() - inFlight.at >= turnMs) timeOut();
      // The same for the abandoned turn's wait: one more timeout after it began releases the queue even if its own timer never fired.
      if (orphan && inFlight === undefined && deps.now() - orphanAt >= turnMs) releaseOrphan();
      try {
        for (const e of deps.agentEvents?.() ?? []) api.noteAgentEvent(e);
      } catch {
        // fx-swallow-ok: a feed that throws must not stop the inbox scan or the ticks; a spawn or stop it would have settled ends as not_confirmed after its own timeout
      }
      scanInbox();
      const t = deps.now();
      // The runner's loop minutes are read again here: a change made while the host runs applies from the last loop tick on (one that is already overdue goes out now).
      const loop = due.find((d) => d.key === "loop");
      if (loop !== undefined) {
        const wanted = loopMsOf(deps.settings());
        if (wanted !== loop.every) {
          loop.next = loop.next - loop.every + wanted;
          loop.every = wanted;
        }
      }
      for (const item of due) {
        if (t < item.next) continue;
        item.next = t + item.every;
        enqueue(item.make());
      }
      const at = deps.settings().startDayAt;
      const clock = deps.localClock();
      if (at !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(at) && clock.hhmm >= at && clock.date !== startDayDate) {
        startDayDate = clock.date;
        enqueue({ key: "start_day", kind: "start_day", prompt: renderPrompt("start_day_scheduled") });
      }
      pump();
    },
    onTurn(turn) {
      if (inFlight === undefined && orphan) {
        // The abandoned turn has now ended: this `result` is its own and ends no tick.
        orphan = false;
        cancelOrphan?.();
        cancelOrphan = undefined;
        pump();
        return;
      }
      endTurn(turn.ok ? "ok" : "error", turn);
    },
    onHostExit() {
      // Before the supervisor removes the handle: nothing queued may go to a host that restarts, and each command gets its answer now.
      for (let i = queue.length - 1; i >= 0; i--) {
        const cmd = queue[i]!.command;
        if (cmd === undefined) continue;
        queue.splice(i, 1);
        refuse(cmd.name, "host_not_running");
      }
      // A new host process has no abandoned turn.
      orphan = false;
      cancelOrphan?.();
      cancelOrphan = undefined;
      endTurn("interrupted");
    },
    onCompaction() {
      if (closed) return;
      if (queue.some((q) => q.key === "reorient")) {
        dropped++;
        return;
      }
      // First in line, and not held back by `pause_loop`: the host lost its context, whatever the loop is doing.
      queue.unshift({ key: "reorient", kind: "reorient", prompt: renderPrompt("reorient") });
      pump();
    },
    noteAgentEvent(event) {
      // `waiting` is in the order the requests were sent: the first match is the oldest.
      for (const [name, w] of [...waiting]) {
        const refusal = w.confirm.blocked?.(event);
        if (refusal !== undefined) {
          if (refusal === "not_confirmed") settle(name, { outcome: "not_confirmed" });
          else refuse(name, refusal);
          return;
        }
        if (!w.confirm.match(event)) continue;
        settle(name, { outcome: "applied" });
        if (!w.confirm.all) return;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      cancelPoll?.();
      cancelTurn?.();
      cancelOrphan?.();
      for (const tick of queue.splice(0)) if (tick.command !== undefined) refuse(tick.command.name, "host_not_running");
      if (inFlight?.tick.command !== undefined) settle(inFlight.tick.command.name, { outcome: "not_confirmed" });
      for (const name of [...waiting.keys()]) settle(name, { outcome: "not_confirmed" });
      inFlight = undefined;
    },
    counts: () => ({ dropped, queued: queue.length, paused, outcomeWriteFailures: writeFailures, timedOut }),
  };
  return api;
}
