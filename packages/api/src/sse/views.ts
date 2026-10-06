import { redactEventPayload } from "@fx/core/src/events/redact.js";
import type { RunEventDTO } from "@fx/core/src/events/read.js";
import { sanitizeWebhookPayload } from "@fx/webhooks";
import type { AccountEventRow } from "./poller.js";
import { sealCursor, type CursorEnv } from "./cursor.js";

/**
 * What each stream event looks like on the wire, shared by the SSE frames
 * and the JSON mode so "the same events" (criterion 8) is true by
 * construction.
 *
 * Redaction (criterion 9, "exactly as H11 does"): run events are stored
 * already redacted at source (`redactEventPayload` before insert). This
 * layer applies the SAME function again on the way out -- idempotent on
 * clean data, and the difference between "redacted at write" and "cannot
 * leak even if a row got in some other way" (a hand-edited row, a future
 * writer that forgot). Account events additionally go through the
 * webhook dispatcher's ids-only allowlist (`sanitizeWebhookPayload`), the
 * same backstop outbound webhooks use, so the two delivery channels
 * cannot disagree about what a payload may contain.
 */

export interface AccountEventDTO {
  id: string;
  type: string;
  created_at: string;
  data: Record<string, string | number | boolean | null>;
}

/**
 * Outbox types that exist only for the server: never in an SSE frame, a JSON page or a webhook. The cursor still
 * moves past them. One list, applied through `isStreamVisible` by both modes, so they cannot drift apart.
 */
export const STREAM_INTERNAL_EVENT_TYPES: readonly string[] = ["session.revoked"];

export function isStreamVisible(row: AccountEventRow): boolean {
  return !STREAM_INTERNAL_EVENT_TYPES.includes(row.type);
}

export function toAccountEventDTO(row: AccountEventRow): AccountEventDTO {
  const payload =
    row.payload !== null && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  return redactEventPayload({
    id: row.id,
    type: row.type,
    created_at: row.createdAt.toISOString(),
    data: sanitizeWebhookPayload(payload),
  });
}

/** The SSE `id:` for an account event: the sealed cursor positioned AT this event, carrying the event's own created_at as its position time. */
export function accountEventCursor(row: AccountEventRow, accountId: string, env: CursorEnv): string {
  return sealCursor({ accountId, serial: row.seq, issuedAtMs: row.createdAt.getTime() }, env);
}

export function toRunEventDTO(dto: RunEventDTO): RunEventDTO {
  return redactEventPayload(dto);
}

/**
 * The largest `data:` line a run event may put on a stream (CWE-770): one
 * event with an enormous payload must not be able to fill a consumer's
 * whole queue. An event over the cap is NOT skipped -- its `seq`, `kind`
 * and `at` still go out so the client's resume point advances and it sees
 * that something happened -- but its payload is replaced by a marker,
 * `{"truncated":true,"original_bytes":N}`; the full payload stays
 * available through the JSON mode's pages.
 */
export const MAX_RUN_EVENT_DATA_BYTES = 64 * 1024;

export function capRunEventForWire(dto: RunEventDTO): RunEventDTO {
  const bytes = Buffer.byteLength(JSON.stringify(dto), "utf8");
  if (bytes <= MAX_RUN_EVENT_DATA_BYTES) return dto;
  return { ...dto, payload: { truncated: true, original_bytes: bytes } };
}

const SSE_EVENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** An `event:` field must never carry a newline: a value outside the safe charset falls back to the generic name rather than being written through. */
export function safeEventName(name: string, fallback = "event"): string {
  return SSE_EVENT_NAME_RE.test(name) ? name : fallback;
}

/** One SSE frame. `data` is always one line of JSON (JSON.stringify never emits a raw newline), so no input can forge an extra field or frame. */
export function frame(fields: { id?: string; event?: string; data?: unknown }): string {
  let out = "";
  if (fields.id !== undefined) out += `id: ${fields.id}\n`;
  if (fields.event !== undefined) out += `event: ${safeEventName(fields.event)}\n`;
  out += `data: ${JSON.stringify(fields.data ?? {})}\n\n`;
  return out;
}

export const HEARTBEAT_FRAME = ": heartbeat\n\n";
