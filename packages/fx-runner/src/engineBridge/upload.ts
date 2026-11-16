/**
 * The bridge's one request: a signed POST of an `EngineEventsMessage` to the cloud's ingest route, and the reply sorted into a closed set of outcomes.
 * The signing is the runner's usual one (`signedPost`: method, full URI and body digest, made with the runner's own key). Nothing here logs, and no
 * outcome carries any text the cloud sent or any part of the key: the loop decides from the outcome's kind and its numbers only.
 */
import { ENGINE_EVENTS_BODY_MAX_BYTES, EngineEventsAcceptedReply, EngineEventsErrorReply, type EngineEventsMessage } from "@fulcrumaxe/runner-protocol";
import { signedPost } from "../cloud.js";
import type { RunnerKey } from "../keys.js";

export const ENGINE_EVENTS_PATH = "/api/runner/engine/events";
/** A wait the cloud asks for is never believed past a day (the quota resets at the next UTC midnight). */
export const MAX_WAIT_S = 86_400;

/** Why a request is tried again later, as a closed word. */
export type RetryWhy = "network" | "server" | "unauthorized" | "refused" | "unexpected";

export type SendOutcome =
  /** Every event of the request is stored (new or already there). `last` is the cloud's highest accepted `seq` for this session. */
  | { kind: "accepted"; last: number | null }
  /** The request starts at or below what the cloud holds (409). `last` says what that is. */
  | { kind: "conflict"; last: number | null }
  /** The account switch or the repo switch is off (403). Nothing was stored. */
  | { kind: "off" }
  /** The day's quota is used (429). Wait `waitS` seconds. */
  | { kind: "quota"; waitS: number }
  | { kind: "retry"; why: RetryWhy };

export interface UploaderConfig {
  origin: string;
  key: RunnerKey;
  now: () => Date;
  fetchFn: typeof fetch;
  bypass?: string | undefined;
}

/** The size of the request body exactly as it is sent. */
export const bodyBytes = (message: EngineEventsMessage): number => Buffer.byteLength(JSON.stringify(message), "utf8");

/** Sorts the cloud's answer. A body that is not one of the contract's replies for its status is `unexpected`, never believed. */
export function classify(status: number, body: unknown, retryAfter: number | undefined): SendOutcome {
  if (status === 200) {
    const reply = EngineEventsAcceptedReply.safeParse(body);
    return reply.success ? { kind: "accepted", last: reply.data.last_accepted_seq } : { kind: "retry", why: "unexpected" };
  }
  const reply = EngineEventsErrorReply.safeParse(body);
  const error = reply.success ? reply.data : undefined;
  if (status === 409) return error !== undefined && "error" in error && error.error === "seq_not_increasing" ? { kind: "conflict", last: error.last_accepted_seq } : { kind: "retry", why: "unexpected" };
  if (status === 403) return error !== undefined && (error.error === "engine_bridge_off" || error.error === "engine_repo_not_enabled") ? { kind: "off" } : { kind: "retry", why: "unauthorized" };
  if (status === 429) {
    const asked = error !== undefined && error.error === "engine_event_quota" ? error.retry_after_s : retryAfter;
    return { kind: "quota", waitS: Math.min(MAX_WAIT_S, Math.max(1, Math.ceil(asked ?? 60))) };
  }
  if (status === 401) return { kind: "retry", why: "unauthorized" };
  if (status === 400 || status === 413) return { kind: "retry", why: "refused" };
  if (status >= 500) return { kind: "retry", why: "server" };
  return { kind: "retry", why: "unexpected" };
}

/** `send(message)` never throws: a failure to reach the cloud is `retry/network`. */
export function createEventsUploader(config: UploaderConfig): (message: EngineEventsMessage) => Promise<SendOutcome> {
  return async (message) => {
    // A request over the cap is never sent: the loop splits before this, so reaching here is a bug that would only earn a 413.
    if (bodyBytes(message) > ENGINE_EVENTS_BODY_MAX_BYTES) return { kind: "retry", why: "refused" };
    try {
      const reply = await signedPost({ origin: config.origin, path: ENGINE_EVENTS_PATH, body: message, key: config.key, now: config.now(), fetchFn: config.fetchFn, bypass: config.bypass });
      if (reply.protectedDeployment) return { kind: "retry", why: "unauthorized" };
      return classify(reply.status, reply.body, reply.retryAfter);
    } catch {
      // fx-swallow-ok: the error text could name an address; a failed request is only the closed word "network"
      return { kind: "retry", why: "network" };
    }
  };
}
