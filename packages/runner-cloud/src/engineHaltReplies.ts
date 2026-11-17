import { COMMAND_REFUSALS, type EngineDecideReply } from '@fulcrumaxe/runner-protocol';

/**
 * What the cloud answers while a repo's engine is halted (migration 1031 raises HX409 `engine_halted` from the insert; `isEngineHalted` in @fx/db
 * recognises it). One place for the two answers, so the decide path (EB-9a) and the command ack (EB-8a) cannot drift from the wire shapes.
 */

/** The decide reply while halted: ask, with nothing recorded (the insert was refused), so there is no receipt and no ask to answer. */
export function haltedDecideReply(): EngineDecideReply {
  return { disposition: 'ask', receipt_id: null, ask_id: null, answered: null, halted: true };
}

/** The refusal a command carries when the halt is the reason. It is one of EB-1's `COMMAND_REFUSALS`. */
export const HALTED_COMMAND_REFUSAL: (typeof COMMAND_REFUSALS)[number] = 'halted';

/** The commands a halted repo still takes: they quiet the engine or answer it, and none starts or widens work. */
export const COMMANDS_ALLOWED_WHILE_HALTED = ['pause_loop', 'answer_ask', 'stop_agent'] as const;
/** The commands a halted repo refuses (409 `halted`). The trigger in 1031 holds the same four names. */
export const COMMANDS_REFUSED_WHILE_HALTED = ['start_day', 'resume_loop', 'request_spawn', 'set_dial'] as const;
