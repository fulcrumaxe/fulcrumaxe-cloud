import type { PoolClient } from "pg";
import { emitDomainEvent, type EmittedDomainEvent } from "@fx/core/src/domain-events/emit.js";

/**
 * D#71 DS-2 criterion 15: "create, comment, revise, publishSpec and
 * addCorrection each emit exactly one event through D#31's
 * emitDomainEvent(client, ...) in the same transaction." This PR wires
 * the first three event types (spec.published/spec.corrected are DS-2
 * PR-b's). "Payload keys are ids and enums only. A test asserts that no
 * payload contains body, title or any key whose value is longer than 64
 * characters" -- enforced here defensively, not only by test, so a future
 * caller can't accidentally regress it.
 */
export type DiscussionsEventType =
  | "discussion.created"
  | "discussion.comment_created"
  | "discussion.revised"
  | "spec.published"
  | "spec.corrected";

export type DomainEventPayload = Record<string, string | number | boolean | null>;

const FORBIDDEN_PAYLOAD_KEYS = new Set(["body", "title"]);
const MAX_PAYLOAD_VALUE_LENGTH = 64;

function assertPayloadShape(payload: DomainEventPayload): void {
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) {
      throw new Error(`emitDiscussionsEvent: payload key "${key}" is not allowed -- ids and enums only`);
    }
    if (typeof value === "string" && value.length > MAX_PAYLOAD_VALUE_LENGTH) {
      throw new Error(
        `emitDiscussionsEvent: payload key "${key}" is ${value.length} characters, over the ${MAX_PAYLOAD_VALUE_LENGTH}-character limit`,
      );
    }
  }
}

export async function emitDiscussionsEvent(
  client: PoolClient,
  type: DiscussionsEventType,
  accountId: string,
  subjectId: string,
  payload: DomainEventPayload,
): Promise<EmittedDomainEvent> {
  assertPayloadShape(payload);
  return emitDomainEvent(client, { type, accountId, subjectId, payload });
}
