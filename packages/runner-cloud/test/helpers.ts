import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { jwkThumbprint, signRequest, type Ed25519Jwk } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { hashRegistrationCode, type RunnerCloudDeps, type RunnerHttpRequest } from "../src/index.js";

export const ORIGIN = "https://runner.example.test";

export interface TestKey {
  privateKey: KeyObject;
  jwk: Ed25519Jwk;
  jkt: string;
}

export function newKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as Ed25519Jwk;
  return { privateKey, jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x }, jkt: jwkThumbprint(jwk) };
}

/** A request the way a runner would send it. The Host header lies on purpose: nothing may read it. */
export function signed(key: TestKey, path: string, body: unknown, o: { url?: string; nonce?: string; created?: number; method?: string; rawBody?: Buffer } = {}): RunnerHttpRequest {
  const bytes = o.rawBody ?? Buffer.from(JSON.stringify(body));
  const headers = signRequest({
    method: o.method ?? "POST",
    url: o.url ?? `${ORIGIN}${path}`,
    body: bytes,
    privateKey: key.privateKey,
    keyid: key.jkt,
    nonce: o.nonce ?? randomBytes(16).toString("base64url"),
    created: o.created ?? Math.floor(Date.now() / 1000),
  });
  return { method: o.method ?? "POST", headers: { ...headers, host: "attacker.example", "x-forwarded-host": "attacker.example" }, body: bytes };
}

export interface Harness {
  admin: PoolClient;
  adminPool: Pool;
  appPool: Pool;
  opsPool: Pool;
  deps: (over?: Partial<RunnerCloudDeps>) => RunnerCloudDeps;
  close: () => Promise<void>;
}

export async function harness(): Promise<Harness> {
  const adminPool = createPool(process.env.RUNNER_CLOUD_DATABASE_URL!);
  const appPool = createPool(process.env.RUNNER_CLOUD_DATABASE_URL_APP_USER!);
  const opsPool = createPool(process.env.RUNNER_CLOUD_DATABASE_URL_PLATFORM_OPS!);
  const admin = await adminPool.connect();
  return {
    admin,
    adminPool,
    appPool,
    opsPool,
    deps: (over = {}) => ({ appUserPool: appPool, platformOpsPool: opsPool, origin: ORIGIN, failRunnerLeases: null, ...over }),
    close: async () => {
      admin.release();
      await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
    },
  };
}

/** A runner row holding `key`, inserted as the admin role. */
export const registerKey = (admin: PoolClient, accountId: string, registeredBy: string, key: TestKey): Promise<string> =>
  insertRunner(admin, accountId, registeredBy, { jwk: key.jwk, jkt: key.jkt });

/** A fresh registration code row, returning the plaintext code. */
export async function insertCode(admin: PoolClient, accountId: string, registeredBy: string): Promise<string> {
  const code = `fxrr_${randomBytes(30).toString("base64url").replace(/[-_]/g, "a").slice(0, 40)}`;
  await admin.query(
    `INSERT INTO runner_registration_codes (account_id, registered_by, code_sha256, expires_at, credential_mode) VALUES ($1, $2, $3, now() + interval '10 minutes', 'subscription')`,
    [accountId, registeredBy, hashRegistrationCode(code)],
  );
  return code;
}

export { toResponse as respond } from "../src/index.js";
