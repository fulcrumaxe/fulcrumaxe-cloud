import type { Pool } from "pg";
import { MAX_CREATED_SKEW_SECONDS } from "@fulcrumaxe/runner-protocol";
import { reportError } from "@fx/telemetry";

/** The framework-free request and response the runner handlers speak. apps/web adapts `Request` and `NextResponse` to these. */
export interface RunnerHttpRequest {
  method: string;
  /** Header fields by lower-case name. */
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
}

export interface RunnerHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A refusal with a fixed status and code. Messages are fixed text, never an argument value or a database message. */
export class RunnerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string = code,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RunnerHttpError";
  }
}

export const errorResponse = (error: RunnerHttpError): RunnerHttpResponse => ({
  status: error.status,
  body: { error: { code: error.code, message: error.message }, ...error.extra },
});

/**
 * Runs a handler and turns whatever it throws into the response a route sends. A refusal keeps its fixed status and
 * code; anything else is a bare 500, so no database or library message ever reaches a runner.
 */
export async function toResponse(run: () => Promise<RunnerHttpResponse>): Promise<RunnerHttpResponse> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RunnerHttpError) return errorResponse(error);
    // The reporter logs the error's name and code, never its message (which may carry values from the request or the database).
    reportError(error, { stage: "runner.unhandled", route: "/api/runner" });
    return errorResponse(new RunnerHttpError(500, "internal", "internal error"));
  }
}

/** Any request body over this gets 413 before its signature is looked at (criterion 9). */
export const MAX_BODY_BYTES = 256 * 1024;
/** A runner key older than this must be re-registered (criterion 6). */
export const MAX_KEY_AGE_DAYS = 90;
/**
 * How long a seen nonce is remembered, derived from the signature's own skew bound. A signature stays acceptable from
 * `created - skew` to `created + skew`, so a request first seen at the early edge can be replayed for twice the skew;
 * add a minute for the second the clock is read in and for clock steps. 180 with the current bound. The database
 * refuses anything shorter than 180 (migration 0724), so lowering the bound cannot quietly shorten the memory below it.
 */
export const NONCE_RETENTION_SECONDS = 2 * MAX_CREATED_SKEW_SECONDS + 60;
/** The protocol version this cloud speaks. A `hello` below `current - 1` gets 426 (criterion 10). */
export const CURRENT_PROTOCOL_VERSION = 1;

/** What the handlers need from the outside. Everything that varies in tests is here. */
export interface RunnerCloudDeps {
  /**
   * The web tier's login: tenant work and every SECURITY DEFINER function (0712, 0724). This package never holds the
   * platform_ops login; a test scans the source to keep it that way.
   */
  appUserPool: Pool;
  /** The configured public origin (FX_APP_ORIGIN). The only source of the URL a signature is checked against. */
  origin: string | undefined;
  /** The worker's lease-fail method, or null while no worker is configured. Called after a revoke has committed. */
  failRunnerLeases: FailRunnerLeases | null;
  /** The clock. Tests inject a fixed one. */
  now?: () => Date;
  /** The protocol version `hello` is judged against. Defaults to the constant. */
  currentProtocolVersion?: number;
  /**
   * The most active runners an account on the runner plan may hold, read from the plan data (D#6 R2b criterion 12).
   * Throws while the plan data is unavailable: registering then answers 503 and registers nothing. Absent is the same
   * as unavailable. An account that is not on the runner plan is never asked.
   */
  maxRunners?: () => number;
}

export type FailRunnerLeases = (input: { accountId: string; runnerId: string; reason: "runner_revoked" }) => Promise<{ runIds: string[]; complete: boolean }>;

/** The body as JSON, or 400. */
export function parseJsonBody(req: RunnerHttpRequest): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new RunnerHttpError(400, "invalid_json", "the body is not valid JSON");
  }
}

/** Parses `value` with a strict message schema, or throws 400. The schema's own error text is never echoed. */
export function parseMessage<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  return result.data;
}

/** The signed-in user a session route acts for. Always taken from the verified session, never from the request. */
export interface SessionPrincipal {
  accountId: string;
  userId: string;
}

/** The Postgres error code of a thrown error, if it has one. */
export const pgCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
