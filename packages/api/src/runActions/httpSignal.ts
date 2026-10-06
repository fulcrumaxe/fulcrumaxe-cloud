import { createHmac } from "node:crypto";
import type { RunActionMessage, RunActionSignal } from "@fx/core/src/runActions/signal.js";

/**
 * D#2 H14c-3b: the web-side sender of the run-action kick.
 *
 * POSTs `{"actionId": "<uuid>"}` to `url` with `X-Fx-Kick: t=<unix seconds>,sig=<hex>`, where
 * sig is HMAC-SHA256 of `<t>.<body>` under `secret`. The kick only speeds a request up (the
 * `run_action_requests` row is the durable signal and the sweep picks up what a lost kick
 * leaves), so this is fire-and-forget in effect: a 2 s timeout, nothing thrown to the route.
 * A refused or failed kick is recorded in one log line carrying the status or the error name
 * only (never the url, secret, signature or body). The body carries the request id only.
 *
 * This file and packages/pipeline's kick handler are the only two places the secret is read
 * from the environment. NOT registered as the routes' signal in this PR (the routes keep
 * answering 503 until the worker is configured); the credentials PR wires it.
 */

export const KICK_TIMEOUT_MS = 2000;

export interface HttpRunActionSignalOptions {
  url: string;
  secret: string;
  /** Vercel's Protection Bypass for Automation secret; sent as `x-vercel-protection-bypass` only when set. */
  bypassSecret?: string;
  /** Receives the refusal or failure line. Default: console.warn. */
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
  timeoutMs?: number;
}

/** The header value for a body at a timestamp. */
export function kickHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},sig=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export class HttpRunActionSignal implements RunActionSignal {
  private readonly fetchImpl: typeof fetch;
  private readonly nowSeconds: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpRunActionSignalOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.timeoutMs = options.timeoutMs ?? KICK_TIMEOUT_MS;
  }

  async signal(msg: RunActionMessage): Promise<void> {
    try {
      const body = JSON.stringify({ actionId: msg.actionId });
      const response = await this.fetchImpl(this.options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fx-kick": kickHeader(this.options.secret, this.nowSeconds(), body),
          ...(this.options.bypassSecret ? { "x-vercel-protection-bypass": this.options.bypassSecret } : {}),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await response.body?.cancel();
      if (!response.ok) this.logger.warn(`run-action kick: refused status=${response.status}`);
    } catch (err) {
      // Dropped, slow or failed: the pending marker and the sweep cover it. Never thrown into the request.
      this.logger.warn(`run-action kick: failed ${(err as { name?: string } | null)?.name ?? "error"}`);
    }
  }

  /** The kick's logger: the configured sink (default console.warn), which can never throw into the request. */
  private readonly logger = {
    warn: (line: string): void => {
      try {
        (this.options.log ?? ((l: string) => console.warn(l)))(line);
      } catch {
        // fx-swallow-ok: the log line is the report; a failing logger must not reach the request, and there is nowhere left to report it
        return;
      }
    },
  };
}

/** The sender from the environment, or null unless both variables are set. */
export function httpRunActionSignalFromEnv(): HttpRunActionSignal | null {
  const url = process.env.RUN_ACTION_KICK_URL;
  const secret = process.env.RUN_ACTION_KICK_SECRET;
  return url && secret ? new HttpRunActionSignal({ url, secret, bypassSecret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET || undefined }) : null;
}
