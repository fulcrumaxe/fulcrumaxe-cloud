import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RegisterMessage, RegisterResponse, RevokeMessage, jwkThumbprint, verifyRunnerRequest, type CredentialMode, type Ed25519Jwk } from "@fulcrumaxe/runner-protocol";

/**
 * A stand-in for the cloud's `/api/runner/register` and `/api/runner/revoke` routes (packages/runner-cloud/src/register.ts
 * and revoke.ts, apps/web/lib/runnerRoutes.ts), reached over a real HTTP connection. It does what those handlers do that
 * the CLI touches: the 256 KiB body cap before anything is read, then for a registration the strict message schema (400
 * `invalid_message` before any signature is looked at, as `registerRunner` does) and for both routes the signature checked
 * with the protocol package's own `verifyRunnerRequest` against `origin + path` (never the Host header), the key resolved
 * from the body for a registration and from the registered runners (active ones only) for a revoke, a code that works
 * once, 409 for a key that is already registered, and the exact reply shapes: 201 `{runner_id, account_id, credential_mode}` (the mode and account of the stored code, never the request's; built with the protocol's `RegisterResponse`), 200 `{revoked, runs_failed}`
 * and `{error:{code,message}}` refusals (with `revoked:true` beside `error` for 503 `leases_not_failed`, as `errorResponse`
 * builds it). What it cannot reproduce: the 400 `invalid_key` for a small-order public key (that check lives in runner-cloud's strictEd25519, which this package may not import, and the CLI only ever sends keys it generated), the database functions behind the codes, the per-address limit's real counter
 * (`rateLimit` forces the 429 reply instead) and the 90-day key age (`keyTooOld` forces that 401).
 */
export interface SeenRequest {
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface FakeCloud {
  origin: string;
  seen: SeenRequest[];
  validCodes: Set<string>;
  /** The mode each code was minted for; a code not listed here is an `api_key` code. */
  codeModes: Map<string, CredentialMode>;
  /** The account every code and runner here belongs to. */
  accountId: string;
  runners: Map<string, { runnerId: string; jwk: Ed25519Jwk; revoked: boolean; credentialMode: CredentialMode }>;
  /** The `name` of each registration that carried one (D#605 FL-2 adds it to the message). */
  names: string[];
  /** False stands in for a cloud that predates runner names: the strict message schema then refuses the unknown `name` key. */
  acceptNames: boolean;
  /** Next replies to force, consumed in order. */
  force: Array<"rate_limit" | "runner_limit" | "leases_not_failed" | "key_too_old">;
  close: () => Promise<void>;
}

const MAX_BODY = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function startFakeCloud(): Promise<FakeCloud> {
  const state: FakeCloud = { origin: "", seen: [], validCodes: new Set(), codeModes: new Map(), accountId: randomUUID(), runners: new Map(), names: [], acceptNames: true, force: [], close: async () => undefined };
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(JSON.stringify(body));
    };
    const refuse = (status: number, code: string, extra: Record<string, unknown> = {}): void => send(status, { error: { code, message: code }, ...extra });
    void (async () => {
      const path = req.url ?? "";
      if (req.method !== "POST" || (path !== "/api/runner/register" && path !== "/api/runner/revoke")) return refuse(404, "not_found");
      if (state.force[0] === "rate_limit") {
        state.force.shift();
        return send(429, { error: { code: "rate_limited", message: "too many requests" }, retry_after: 42 }, { "retry-after": "42" });
      }
      const body = await readBody(req);
      if (!body) return refuse(413, "body_too_large");
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]));
      state.seen.push({ path, headers, body: body.toString("utf8") });

      let json: unknown;
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        // Not JSON: a register is refused as `invalid_message` below; a revoke fails its signature check or its schema.
        json = undefined;
      }
      const isRegister = path === "/api/runner/register";
      // A cloud with runner names (FL-2) takes an optional `name` beside the rest; this fake checks it is a string and parses the rest with the protocol's own schema.
      let parsed: unknown = json;
      if (isRegister && state.acceptNames && typeof json === "object" && json !== null && "name" in json) {
        const { name, ...rest } = json as Record<string, unknown>;
        if (typeof name !== "string") return refuse(400, "invalid_message");
        state.names.push(name);
        parsed = rest;
      }
      const registerMessage = isRegister ? RegisterMessage.safeParse(parsed) : undefined;
      // `registerRunner` parses the message before it looks at the signature, so a bad body is 400 whoever signed it.
      if (isRegister && !registerMessage?.success) return refuse(400, "invalid_message");
      const resolveKey = (keyid: string): Ed25519Jwk | undefined => {
        if (isRegister) return registerMessage?.success && keyid.length === 43 ? registerMessage.data.public_key_jwk : undefined;
        const found = [...state.runners.values()].find((r) => !r.revoked && jktOf(r.jwk) === keyid);
        return found?.jwk;
      };
      let keyid: string;
      try {
        keyid = (await verifyRunnerRequest({ method: "POST", url: `${state.origin}${path}`, headers: headers as Record<string, string | undefined>, body }, resolveKey)).keyid;
      } catch {
        return refuse(401, "unauthorized");
      }

      if (isRegister) {
        if (!registerMessage?.success) return refuse(400, "invalid_message"); // unreachable: checked above; narrows the type
        if ([...state.runners.values()].some((r) => jktOf(r.jwk) === keyid)) return refuse(409, "key_registered");
        if (state.force[0] === "runner_limit") {
          state.force.shift();
          return refuse(409, "runner_limit");
        }
        if (!state.validCodes.delete(registerMessage.data.code)) return refuse(401, "invalid_code");
        const runnerId = randomUUID();
        const credentialMode = state.codeModes.get(registerMessage.data.code) ?? "api_key";
        state.runners.set(runnerId, { runnerId, jwk: registerMessage.data.public_key_jwk, revoked: false, credentialMode });
        return send(201, RegisterResponse.parse({ runner_id: runnerId, account_id: state.accountId, credential_mode: credentialMode }));
      }

      if (state.force[0] === "key_too_old") {
        state.force.shift();
        return refuse(401, "reregister_required");
      }
      if (!RevokeMessage.safeParse(json).success) return refuse(400, "invalid_message");
      const runner = [...state.runners.values()].find((r) => jktOf(r.jwk) === keyid)!;
      runner.revoked = true;
      if (state.force[0] === "leases_not_failed") {
        state.force.shift();
        return refuse(503, "leases_not_failed", { revoked: true });
      }
      return send(200, { revoked: true, runs_failed: 2 });
    })().catch(() => refuse(500, "internal"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

const jktOf = (jwk: Ed25519Jwk): string => jwkThumbprint(jwk);
