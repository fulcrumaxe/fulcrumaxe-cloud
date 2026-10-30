import https from "node:https";
import type { AddressInfo } from "node:net";
import { generateSelfSignedCert } from "../../../webhooks/test/helpers/selfSignedCert.js";

/**
 * A Resend API that refuses what the real one refuses, served over real TLS (the certificate names api.resend.com and is handed to the client as its
 * explicit `ca`; nothing sets rejectUnauthorized: false), so the real transport talks to it through Node's real connection path. No mail leaves the machine.
 *
 * Enforced (each has a test that a lenient fake would have let a wrong client through):
 *  - POST /emails only; anything else 404 / 405.
 *  - `Authorization: Bearer <key>` with a key it knows; 401 `restricted_api_key`-style body otherwise.
 *  - `User-Agent` present (Resend answers 403 without one); `Content-Type: application/json` (else 400 `invalid_content_type`).
 *  - Body: `from`, `to` (1..50 addresses), `subject` (non-empty), and `text` or `html` (else 422 `missing_required_field`); a malformed address is 422 `validation_error`.
 *  - The `from` domain must be one the account verified (403 `validation_error`, "The domain is not verified").
 *  - 429 `rate_limit_exceeded` with Retry-After, and 5xx, on demand (`world.failNext`).
 *
 * Not faked faithfully (the PR says so): deliverability, bounces, domain-verification delay, the real rate-limit thresholds (2 requests a second by
 * default), the wording of every message, attachments, tags and batch sends, and the live DNS answer.
 */

export interface ResendWorld {
  /** The only API keys the fake accepts. */
  keys: Set<string>;
  /** Sending domains the account has verified. */
  verifiedDomains: Set<string>;
  /** Answer the next requests with these statuses, then carry on. */
  failNext: number[];
  /** Accepted emails, in order. */
  sent: SentEmail[];
  /** Hold every request open until released (for race tests). */
  gate?: Promise<void>;
}

export interface SentEmail {
  from: string;
  to: string[];
  subject: string;
  text: string | undefined;
}

export interface StrictResend {
  port: number;
  ca: string;
  /** Resolves api.resend.com to this receiver, whatever name is asked for. */
  lookup: (host: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
  world: ResendWorld;
  /** Every request seen, accepted or not. */
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: string }>;
  close(): Promise<void>;
}

export function newResendWorld(keys: string[], verifiedDomains: string[]): ResendWorld {
  return { keys: new Set(keys), verifiedDomains: new Set(verifiedDomains), failNext: [], sent: [] };
}

const ADDRESS = /^(?:[^<>@]+<)?[^<>@\s]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})>?$/;
const reply = (status: number, name: string, message: string) => ({ status, body: { statusCode: status, name, message }, headers: {} as Record<string, string> });

export async function startStrictResend(world: ResendWorld): Promise<StrictResend> {
  const { certPem, keyPem } = generateSelfSignedCert("api.resend.com", 1, { dnsNames: ["api.resend.com"] });
  const requests: StrictResend["requests"] = [];

  async function answer(method: string, path: string, headers: Record<string, string>, raw: string): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
    if (world.gate) await world.gate;
    const failure = world.failNext.shift();
    if (failure === 429) return { ...reply(429, "rate_limit_exceeded", "Too many requests."), headers: { "retry-after": "1" } };
    if (failure !== undefined) return reply(failure, "application_error", "Something went wrong.");
    if (path !== "/emails") return reply(404, "not_found", "Route not found.");
    if (method !== "POST") return reply(405, "method_not_allowed", "Method is not allowed for the requested path.");
    const auth = headers["authorization"] ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!key) return reply(401, "missing_api_key", "Missing API key in the authorization header.");
    if (!world.keys.has(key)) return reply(403, "invalid_api_key", "API key is invalid.");
    if (!headers["user-agent"]) return reply(403, "missing_user_agent", "A User-Agent header is required.");
    if (!/^application\/json/i.test(headers["content-type"] ?? "")) return reply(400, "invalid_content_type", "Content-Type must be application/json.");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return reply(422, "invalid_json", "The body is not valid JSON.");
    }
    const { from, to, subject, text, html } = body;
    if (typeof from !== "string" || !Array.isArray(to) || to.length === 0 || typeof subject !== "string" || subject === "" || (typeof text !== "string" && typeof html !== "string")) {
      return reply(422, "missing_required_field", "Missing `from`, `to`, `subject` or a body.");
    }
    if (to.length > 50) return reply(422, "validation_error", "The `to` field accepts at most 50 recipients.");
    const fromDomain = ADDRESS.exec(from)?.[1];
    if (!fromDomain || to.some((t) => typeof t !== "string" || !ADDRESS.test(t))) return reply(422, "validation_error", "Invalid address.");
    if (!world.verifiedDomains.has(fromDomain.toLowerCase())) return reply(403, "validation_error", "The domain is not verified.");
    world.sent.push({ from, to: to as string[], subject, text: typeof text === "string" ? text : undefined });
    return { status: 200, body: { id: `fake-${world.sent.length}` }, headers: {} };
  }

  const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      const raw = Buffer.concat(chunks).toString("utf8");
      const method = req.method ?? "GET";
      const path = req.url ?? "/";
      requests.push({ method, path, headers, body: raw });
      void answer(method, path, headers, raw).then((out) => {
        res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
        res.end(JSON.stringify(out.body));
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    ca: certPem,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    world,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}
