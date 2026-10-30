import net from "node:net";
import { request as httpsRequest } from "node:https";
import { isBlockedAddress, resolveChecked, type HostLookup } from "@fx/net-guard";

/** The one place the Resend address is written. */
const RESEND_HOST = "api.resend.com";
const RESEND_PATH = "/emails";
export const RESEND_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Every failure is reduced to one of these: no provider message, address or key ever reaches a log or a stamp decision. */
export type SendCode = "rate_limited" | "server_error" | "auth" | "rejected" | "timeout" | "network" | "blocked";

export interface EmailMessage {
  from: string;
  to: readonly string[];
  subject: string;
  text: string;
}

export type SendResult = { ok: true } | { ok: false; code: SendCode };

export interface EmailTransport {
  send(message: EmailMessage): Promise<SendResult>;
}

export interface ResendOptions {
  apiKey: string;
  timeoutMs?: number;
  /** Test only (refused unless NODE_ENV is exactly "test"): answers the DNS query, so a local TLS receiver can stand in for Resend. The certificate is still verified against `ca`. */
  testTarget?: { lookup: HostLookup; port: number; ca: string };
}

/** Maps an HTTP status to the fixed code. 429 and 5xx are retried by the next tick; 401 and 403 are a settings problem; any other 4xx is a refusal that retrying cannot fix. */
export function codeForStatus(status: number): SendCode | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status === 401 || status === 403) return "auth";
  return "rejected";
}

export function createResendTransport(options: ResendOptions): EmailTransport {
  const timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;
  return {
    async send(message) {
      const test = options.testTarget;
      if (test && process.env.NODE_ENV !== "test") return { ok: false, code: "blocked" };
      let address: string | undefined;
      try {
        address = test ? (await test.lookup(RESEND_HOST, { all: true, verbatim: true }))[0]?.address : (await resolveChecked(RESEND_HOST))[0];
      } catch {
        // fx-swallow-ok: reduced to the fixed code; the resolver's message names the host only
        return { ok: false, code: "blocked" };
      }
      if (!address || (!test && isBlockedAddress(address))) return { ok: false, code: "blocked" };
      const pinned = address;
      const body = JSON.stringify({ from: message.from, to: [...message.to], subject: message.subject, text: message.text });
      return new Promise<SendResult>((resolve) => {
        let settled = false;
        const settle = (r: SendResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve(r);
        };
        const deadline = setTimeout(() => {
          req.destroy();
          settle({ ok: false, code: "timeout" });
        }, timeoutMs);
        const req = httpsRequest(
          {
            hostname: RESEND_HOST,
            port: test ? test.port : 443,
            path: RESEND_PATH,
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
              "User-Agent": "fulcrumaxe-notify/1",
              "Content-Length": Buffer.byteLength(body).toString(),
            },
            timeout: timeoutMs,
            ...(test ? { ca: test.ca } : {}),
            // Pins the socket to the address validated above; Node 20+ asks for { all: true }, older callers for the triple.
            lookup: ((_h: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
              const family = net.isIPv6(pinned) ? 6 : 4;
              if (opts?.all) cb(null, [{ address: pinned, family }]);
              else cb(null, pinned, family);
            }) as never,
          },
          (res) => {
            let received = 0;
            res.on("data", (chunk: Buffer) => {
              received += chunk.length;
              if (received > MAX_RESPONSE_BYTES) res.destroy();
            });
            const finish = (): void => {
              const code = codeForStatus(res.statusCode ?? 0);
              settle(code === null ? { ok: true } : { ok: false, code });
            };
            res.on("end", finish);
            res.on("close", finish);
          },
        );
        req.on("timeout", () => {
          req.destroy();
          settle({ ok: false, code: "timeout" });
        });
        req.on("error", () => settle({ ok: false, code: "network" }));
        req.end(body);
      });
    },
  };
}
