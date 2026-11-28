/**
 * D#845 ON-13b2: the ticks and signed commands of the engine session, inside the guest (or the standard tier's unit). It is EB-12b's ticker (`ticks.ts`: single flight, queued kinds, `pause_loop`, one outcome per command)
 * with two guest-side inputs in place of the files the host-mode runner uses:
 *  - `verifyCommandWith`: the signed `EngineCommand` the runner forwards over the channel is checked AGAIN here, against the key pinned in this build for the cloud address `session.json` names (the table is code,
 *    so a runner that is not trusted can pick among the keys the build pins and can add none), then against the session's own runner id and repository. A command that fails any of these is `command_unverified`
 *    and is never handed to the ticker, so a forged one cannot start a turn.
 *  - an in-memory claim list (`HostInbox`) fed by the channel's `command`, and an outcome sink: every outcome is one line `{name, ack}` of `engine-host-outcomes.jsonl`, read back with `events_read {stream: "outcomes"}`.
 * Known limit: the ticker's sequence and "already answered" memory are this process's, and the process ends at every stop; a command replayed to the next supervisor is bounded by its own expiry (the runner's puller also
 * keeps the ids it handed over).
 */
import { EngineCommand, isBridgeCommandKind, verifyEngineCommand, type EngineCommandAck, type JobKeyring } from "@fulcrumaxe/runner-protocol";
import type { AnsweredStore } from "./answered.js";
import type { Claimed, HostInbox } from "./hostInbox.js";
import { createTicker, type AgentEvent, type CredentialMode, type TickEvent, type Ticker, type TickSettings } from "./ticks.js";

export const OUTCOMES_FILE = "engine-host-outcomes.jsonl";

/** The command a verified signed envelope holds, or undefined for anything that is not a command this session may apply (no cause is kept). */
export function verifyCommandWith(raw: unknown, who: { keyring: JobKeyring; runnerId: string; repoGhId: number; now: Date }): EngineCommand | undefined {
  try {
    const cmd = verifyEngineCommand(raw, who.keyring, who.now);
    return cmd.runner_id === who.runnerId && cmd.repo_gh_id === who.repoGhId && !isBridgeCommandKind(cmd.kind) ? cmd : undefined;
  } catch {
    // fx-swallow-ok: a signature or shape that does not check out is one fixed refusal (`command_unverified`); the cause says nothing the peer may use
    return undefined;
  }
}

export interface GuestTicksDeps {
  send: (text: string) => boolean;
  touch: () => boolean;
  emit: (event: TickEvent) => void;
  now: () => number;
  after: (ms: number, fn: () => void) => () => void;
  settings: () => TickSettings;
  credentialMode: () => CredentialMode;
  repoGhId: number;
  gate: () => "halted" | "operate_off" | undefined;
  answered: AnsweredStore;
  agentEvents: () => AgentEvent[];
  log: (line: string) => void;
  /** Writes one outcome line; false when it could not be written. */
  outcome: (name: string, ack: EngineCommandAck) => boolean;
}

export interface GuestTicks {
  ticker: Ticker;
  /** Hands a VERIFIED command to the ticker (its name is `<seq>-<command_id>`) and applies it now. */
  submit(command: EngineCommand): string;
}

export function createGuestTicks(deps: GuestTicksDeps): GuestTicks {
  const pending: Claimed[] = [];
  const done = new Set<string>();
  const inbox: HostInbox = {
    claimAll: () => pending.splice(0).sort((a, b) => a.seq - b.seq),
    writeOutcome(name, ack) {
      if (done.has(name)) return false;
      if (!deps.outcome(name, ack)) throw new Error("outcome"); // the ticker counts a failed write and the command is never reported applied
      done.add(name);
      return true;
    },
    hasOutcome: (name) => done.has(name),
    dropClaimed: () => undefined,
  };
  const ticker = createTicker({ send: deps.send, touch: deps.touch, emit: deps.emit, now: deps.now, after: deps.after, settings: deps.settings, localClock: () => ({ date: new Date(deps.now()).toLocaleDateString("sv-SE"), hhmm: new Date(deps.now()).toTimeString().slice(0, 5) }), credentialMode: deps.credentialMode, repoGhId: deps.repoGhId, gate: deps.gate, inbox, answered: deps.answered, log: deps.log, agentEvents: deps.agentEvents });
  return {
    ticker,
    submit(command) {
      const name = `${command.command_seq}-${command.command_id}`;
      pending.push({ name, seq: command.command_seq, commandId: command.command_id, body: command });
      try {
        ticker.poll();
      } catch {
        // fx-swallow-ok: a poll that throws leaves the command claimed; the ticker's own timer polls again in a few seconds
        deps.log("engine host ticker: a poll failed");
      }
      return name;
    },
  };
}
