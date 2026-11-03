/**
 * D#597 CC-7a-1: the one way the assistant code calls the cloud: User-Agent `fulcrumaxe-runner/<version>`, no redirect, a timeout, at most 64 KiB
 * read. The delegation token goes in the Authorization header only; a call without one is the anonymous link call.
 */
import { CliError } from "../cliError.js";
import { bypassHeaders } from "../protectionBypass.js";
import { readCapped } from "../cloud.js";
import { RUNNER_VERSION } from "../version.js";

export const USER_AGENT = `fulcrumaxe-runner/${RUNNER_VERSION}`;
const TIMEOUT_MS = 15_000;
const MAX_REPLY_BYTES = 64 * 1024;

export interface AssistantCall {
  fetchFn: typeof fetch;
  origin: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  token?: string | undefined;
  bypass?: string | undefined;
}

export async function assistantCall(call: AssistantCall): Promise<{ status: number; body: unknown }> {
  const url = `${call.origin}${call.path}`;
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json", ...bypassHeaders(call.bypass, call.origin, url) };
  if (call.body !== undefined) headers["content-type"] = "application/json";
  if (call.token !== undefined) headers.authorization = `Bearer ${call.token}`;
  let response: Response;
  try {
    response = await call.fetchFn(url, {
      method: call.method,
      headers,
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // fx-swallow-ok: the system's text could quote the address or a header; the person gets fixed words
    throw new CliError("could not reach the cloud; check your network and try again");
  }
  const raw = await readCapped(response, MAX_REPLY_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // fx-swallow-ok: a reply that is not JSON is returned as undefined and handled as unexpected by the caller
    body = undefined;
  }
  return { status: response.status, body };
}
