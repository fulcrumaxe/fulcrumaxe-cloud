import { randomBytes } from "node:crypto";
import { request as httpsRequest, createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { RUNNER_VERSION } from "../../src/version.js";
import { generateSelfSignedCert } from "./selfSignedCert.js";

/**
 * D#597 CC-7a-1: a strict stand-in for the cloud's assistant routes, reached over real TLS (a self-signed certificate the client is handed as its
 * explicit `ca`). It enforces what the real routes do that the runner touches: the User-Agent `fulcrumaxe-runner/<version>` (anything else 400),
 * strict JSON bodies (an unlisted key is 400), the CC-4 link routes (`pending`, `expired` after 10 minutes of the injected clock, the token
 * exactly once, a later poll 409 `link_already_redeemed`), and the corrections routes (a bearer token this fake issued and has not revoked or
 * outlived, else 401). Tokens are built from short parts at run time. What it cannot do: the database, session approval, or the real role checks.
 */
export const TOKEN_PARTS = ["fxat", "k3m9".repeat(10)];
export interface Seen { method: string; path: string; body: string; auth: string | undefined; userAgent: string | undefined }

export interface AssistantCloud {
  origin: string;
  ca: string;
  seen: Seen[];
  /** Approves the pending link as if a person did in a workspace session. */
  approve(): void;
  /** Makes the next poll answer 409 as if another client had already redeemed the code. */
  redeemElsewhere(): void;
  revokeToken(): void;
  issuedToken(): string | undefined;
  /** From now on the token revoke route answers 403. */
  refuseRevoke: boolean;
  /** From now on a started link claims an expiry a day away (a bad `expires_at`). */
  farExpiry: boolean;
  close(): Promise<void>;
}

const KINDS = ["question", "run_note", "spec_amend", "new_item", "pause", "priority"];

export async function startAssistantCloud(now: () => number): Promise<AssistantCloud> {
  const cert = generateSelfSignedCert("127.0.0.1", 1, { ipAddresses: ["127.0.0.1"] });
  const seen: Seen[] = [];
  let link: { client: string; device: string; user: string; expires: number; approved: boolean; redeemed: boolean } | undefined;
  const flags = { refuseRevoke: false, farExpiry: false };
  let token: { value: string; expires: number; revoked: boolean } | undefined;

  const server = createServer({ key: cert.keyPem, cert: cert.certPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const userAgent = req.headers["user-agent"];
      seen.push({ method: req.method ?? "", path: req.url ?? "", body, auth: req.headers.authorization, userAgent });
      const send = (status: number, value: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const fail = (status: number, code: string): void => send(status, { error: { code, message: code } });
      if (userAgent !== `fulcrumaxe-runner/${RUNNER_VERSION}`) return fail(400, "bad_user_agent");
      let json: Record<string, unknown> = {};
      if (req.method === "POST") {
        try {
          json = JSON.parse(body) as Record<string, unknown>;
        } catch {
          // fx-swallow-ok: a test fake answering a malformed body
          return fail(400, "invalid_message");
        }
      }
      const strict = (keys: string[]): boolean => Object.keys(json).length === keys.length && keys.every((k) => k in json);
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/api/v1/assistant/link") {
        if (!strict(["client_id"]) || !/^[A-Za-z0-9._-]{1,48}$/.test(String(json.client_id))) return fail(400, "invalid_message");
        link = { client: String(json.client_id), device: `fxdl_${randomBytes(32).toString("base64url")}`, user: "ABCD2345", expires: now() + (flags.farExpiry ? 86_400_000 : 600_000), approved: false, redeemed: false };
        return send(201, { device_code: link.device, user_code: link.user, expires_at: new Date(link.expires).toISOString(), interval_seconds: 5 });
      }
      if (req.method === "POST" && url === "/api/v1/assistant/link/poll") {
        const code = String(json.device_code);
        if (!strict(["device_code"]) || code.length < 20 || code.length > 100) return fail(400, "invalid_message");
        if (link === undefined || link.device !== code) return fail(404, "not_found");
        if (link.redeemed) return fail(409, "link_already_redeemed");
        if (now() >= link.expires) return send(200, { status: "expired" });
        if (!link.approved) return send(200, { status: "pending" });
        link.redeemed = true;
        token = { value: `${TOKEN_PARTS.join("_")}${randomBytes(4).toString("hex")}`, expires: now() + 3_600_000, revoked: false };
        return send(200, { status: "approved", token: { token_id: "11111111-1111-4111-8111-111111111111", token: token.value, scopes: ["read", "corrections:write"], repo_id: "22222222-2222-4222-8222-222222222222", client_id: link.client, expires_at: new Date(token.expires).toISOString() } });
      }
      if (req.method === "DELETE" && url === "/api/v1/tokens/11111111-1111-4111-8111-111111111111") {
        if (token === undefined || req.headers.authorization !== `Bearer ${token.value}` || token.revoked || now() >= token.expires) return fail(401, "unauthorized");
        if (flags.refuseRevoke) return fail(403, "session_required");
        token.revoked = true;
        res.writeHead(204);
        return void res.end();
      }
      const m = /^\/api\/v1\/work-items\/([0-9a-f-]{36})\/corrections$/.exec(url);
      if (m !== null) {
        if (token === undefined || req.headers.authorization !== `Bearer ${token.value}` || token.revoked || now() >= token.expires) return fail(401, "unauthorized");
        if (req.method === "GET") return send(200, { data: [] });
        if (!strict(["kind", "body"]) || !KINDS.includes(String(json.kind)) || typeof json.body !== "string" || json.body.length > 4000) return fail(400, "invalid_message");
        return send(201, { id: "33333333-3333-4333-8333-333333333333", work_item_id: m[1], status: "proposed", origin: "agent" });
      }
      return fail(404, "not_found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    ca: cert.certPem,
    seen,
    get refuseRevoke() { return flags.refuseRevoke; },
    set refuseRevoke(v) { flags.refuseRevoke = v; },
    get farExpiry() { return flags.farExpiry; },
    set farExpiry(v) { flags.farExpiry = v; },
    approve: () => void (link && (link.approved = true)),
    redeemElsewhere: () => void (link && (link.redeemed = true)),
    revokeToken: () => void (token && (token.revoked = true)),
    issuedToken: () => token?.value,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** A `fetch` that goes through Node's real TLS path (`https.request`) and trusts only `ca`. */
export function tlsFetch(ca: string): typeof fetch {
  return ((input: string | URL, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(String(input));
      const req = httpsRequest({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: init.method ?? "GET", headers: init.headers as Record<string, string>, ca }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(new Response([204, 205, 304].includes(res.statusCode ?? 0) ? null : Buffer.concat(chunks), { status: res.statusCode ?? 0 })));
      });
      req.on("error", reject);
      init.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")));
      req.end(init.body as string | undefined);
    })) as typeof fetch;
}
