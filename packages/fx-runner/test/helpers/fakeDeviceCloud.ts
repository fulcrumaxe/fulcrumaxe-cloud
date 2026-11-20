import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEVICE_CODE_TTL_SECONDS, DEVICE_POLL_INTERVAL_SECONDS, DEVICE_POLL_PATH, DEVICE_START_PATH, DevicePollMessage, RevokeMessage, DeviceStartMessage, RegisterResponse, jwkThumbprint, verifyDevicePop, verifyRunnerRequest,
  type Ed25519Jwk,
} from "@fulcrumaxe/runner-protocol";

/**
 * A stand-in for `POST /api/runner/device/start` and `/poll` (packages/runner-cloud/src/deviceFlow.ts), reached over a real HTTP connection. It does what those
 * handlers do that the CLI touches: the strict `DeviceStartMessage` and `DevicePollMessage` (400 `invalid_message` for any other key), the proof of the key checked with
 * the protocol's own `verifyDevicePop` against `origin + path` and the clock, the poll signature checked with `verifyRunnerRequest` against the key the code was started
 * with (401 for any other), 429 `slow_down` for a poll made before the interval, the one-time `approved` reply and 410 `consumed` after it, and the exact reply shapes
 * (built with the protocol's own `DeviceStartResponse`/`RegisterResponse` parsers by the code under test). `POST /api/runner/revoke` is there too: the strict `RevokeMessage`, the
 * signature checked against the key of an approved code, 401 for a key that has no runner, and `{ revoked: true }` once (a runner counts as left behind while `leftBehind()` lists it).
 * What it cannot reproduce: the database functions behind the
 * codes, the hashes of the codes, the per-address limits (`force` makes the reply instead) and the person's approval page (a test calls `approve`).
 */
export interface DeviceSeen {
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}
interface CodeRow {
  deviceCode: string;
  userCode: string;
  jwk: Ed25519Jwk;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  lastPollAt: number;
  /** Set when the person approves (`runner_device_approve`, migration 1037): the runner the cloud made for this code, whether or not the approved reply is ever handed out. */
  runnerId?: string;
  revoked?: boolean;
}
export type { CodeRow };
export interface FakeDeviceCloud {
  origin: string;
  seen: DeviceSeen[];
  codes: CodeRow[];
  accountId: string;
  mode: "subscription" | "api_key";
  /** The test's clock, in ms; the same one the CLI is given. */
  clock: { now: number };
  /** Next replies to force instead of the real answer, consumed in order. `reply` is sent for the matching path. */
  force: Array<{ path: string; status: number; body?: unknown }>;
  /** Changes what the next start reply carries (a hostile cloud). */
  tweakStart?: ((reply: Record<string, unknown>) => Record<string, unknown>) | undefined;
  /** How long a code really lives, in ms (default ten minutes); a test sets a year to see the CLI stop on its own clock. */
  ttlMs?: number | undefined;
  tweakApproved?: ((reply: Record<string, unknown>) => Record<string, unknown>) | undefined;
  /** The person's approval, as `runner_device_approve` does it: only a pending code that has not expired (otherwise `gone`, thrown here), and it makes the runner then. */
  approve: (userCode: string) => void;
  /** Number of next poll replies to lose in transit: the cloud does everything it would (the code is consumed) and the connection is cut instead of the reply sent. */
  dropPollReplies: number;
  expire: (userCode: string) => void;
  deny: (userCode: string) => void;
  /** The runners the cloud made (from the approval on) that nothing has revoked. */
  leftBehind: () => CodeRow[];
  /** The signed revokes it accepted, as the key thumbprint they were signed with. */
  revokes: string[];
  close: () => Promise<void>;
}

const CONSONANTS = "BCDFGHJKLMNPQRSTVWXZ";
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const draw = (alphabet: string, n: number): string => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > 256 * 1024) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function startFakeDeviceCloud(startMs: number): Promise<FakeDeviceCloud> {
  const state: FakeDeviceCloud = {
    origin: "", seen: [], codes: [], accountId: randomUUID(), mode: "subscription", clock: { now: startMs }, force: [],
    approve: (u) => {
      const row = state.codes.find((c) => c.userCode === u)!;
      if (row.status !== "pending" || state.clock.now >= row.expiresAt) throw new Error(`runner_device_approve: ${u} is gone (${row.status})`);
      row.status = "approved";
      row.runnerId = randomUUID();
    },
    dropPollReplies: 0,
    expire: (u) => void (state.codes.find((c) => c.userCode === u)!.status = "expired"),
    deny: (u) => void (state.codes.find((c) => c.userCode === u)!.status = "denied"),
    leftBehind: () => state.codes.filter((c) => c.runnerId !== undefined && c.revoked !== true),
    revokes: [],
    close: async () => undefined,
  };
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      if (req.url === DEVICE_POLL_PATH && state.dropPollReplies > 0) {
        state.dropPollReplies--;
        return void req.socket.destroy();
      }
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const refuse = (status: number, code: string): void => send(status, { error: { code, message: code } });
    void (async () => {
      const path = req.url ?? "";
      if (req.method !== "POST" || (path !== DEVICE_START_PATH && path !== DEVICE_POLL_PATH && path !== "/api/runner/revoke")) return refuse(404, "not_found");
      const body = await readBody(req);
      if (!body) return refuse(413, "body_too_large");
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]));
      state.seen.push({ path, headers, body: body.toString("utf8") });
      const forced = state.force[0];
      if (forced !== undefined && forced.path === path) {
        state.force.shift();
        return send(forced.status, forced.body ?? { error: { code: "forced", message: "forced" } });
      }
      let json: unknown;
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        // fx-swallow-ok: not JSON is refused as an invalid message below
        json = undefined;
      }
      if (path === DEVICE_START_PATH) {
        const message = DeviceStartMessage.safeParse(json);
        if (!message.success) return refuse(400, "invalid_message");
        if (headers.signature !== undefined || headers["signature-input"] !== undefined) return refuse(400, "invalid_message");
        if (!verifyDevicePop(message.data.pop, message.data.public_key_jwk, { origin: state.origin, path }, Math.floor(state.clock.now / 1000))) return refuse(400, "invalid_pop");
        const row: CodeRow = { deviceCode: `fxrd_${draw(BASE62, 43)}`, userCode: `${draw(CONSONANTS, 4)}-${draw(CONSONANTS, 4)}`, jwk: message.data.public_key_jwk, expiresAt: state.clock.now + (state.ttlMs ?? DEVICE_CODE_TTL_SECONDS * 1000), status: "pending", lastPollAt: 0 };
        state.codes.push(row);
        const reply = { device_code: row.deviceCode, user_code: row.userCode, verification_uri: `${state.origin}/link`, expires_at: new Date(row.expiresAt).toISOString(), interval_s: DEVICE_POLL_INTERVAL_SECONDS };
        return send(201, state.tweakStart ? state.tweakStart(reply) : reply);
      }
      if (path === "/api/runner/revoke") {
        if (!RevokeMessage.safeParse(json).success) return refuse(400, "invalid_message");
        try {
          const verified = await verifyRunnerRequest({ method: "POST", url: `${state.origin}${path}`, headers: headers as Record<string, string | undefined>, body }, (keyid) => state.codes.find((c) => c.runnerId !== undefined && c.revoked !== true && jwkThumbprint(c.jwk) === keyid)?.jwk, new Date(state.clock.now));
          const owner = state.codes.find((c) => c.runnerId !== undefined && c.revoked !== true && jwkThumbprint(c.jwk) === verified.keyid);
          if (owner === undefined) return refuse(401, "unauthorized");
          owner.revoked = true;
          state.revokes.push(verified.keyid);
          return send(200, { revoked: true });
        } catch {
          return refuse(401, "unauthorized");
        }
      }
      const message = DevicePollMessage.safeParse(json);
      if (!message.success) return refuse(400, "invalid_message");
      const row = state.codes.find((c) => c.deviceCode === message.data.device_code);
      try {
        const verified = await verifyRunnerRequest({ method: "POST", url: `${state.origin}${path}`, headers: headers as Record<string, string | undefined>, body }, (keyid) => (row !== undefined && jwkThumbprint(row.jwk) === keyid ? row.jwk : undefined), new Date(state.clock.now));
        if (row === undefined || verified.keyid !== jwkThumbprint(row.jwk)) return refuse(401, "unauthorized");
      } catch {
        return refuse(401, "unauthorized");
      }
      if (row.status === "pending" && state.clock.now >= row.expiresAt) row.status = "expired";
      // As in the poll function: the interval is measured from the last poll for a pending code and an approved one alike.
      if ((row.status === "pending" || row.status === "approved") && row.lastPollAt !== 0 && state.clock.now - row.lastPollAt < DEVICE_POLL_INTERVAL_SECONDS * 1000) return send(429, { error: { code: "slow_down", message: "slow_down" }, interval_s: DEVICE_POLL_INTERVAL_SECONDS });
      row.lastPollAt = state.clock.now;
      if (row.status === "pending") return send(200, { status: "pending" });
      if (row.status === "approved") {
        row.status = "consumed";
        row.lastPollAt = state.clock.now;
        // The code is consumed whatever the runner's state, and a revoked runner gets none.
        if (row.revoked === true) return refuse(410, "denied");
        const reply = { status: "approved", registration: RegisterResponse.parse({ runner_id: row.runnerId, account_id: state.accountId, credential_mode: state.mode }) };
        return send(200, state.tweakApproved ? state.tweakApproved(reply) : reply);
      }
      return refuse(410, row.status);
    })().catch(() => refuse(500, "internal"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
