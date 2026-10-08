/**
 * The runner's Ed25519 identity. The private key is generated here, stored as PKCS#8 PEM at mode 0600 in the 0700 state
 * directory, and never leaves the machine. Only the public JWK (kty, crv, x) is ever put in a request body.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { Ed25519PublicJwk, jwkThumbprint } from "@fulcrumaxe/runner-protocol";
import { CliError } from "./cliError.js";
import { KEY_FILE, readPrivateFile, writePrivateFile } from "./config.js";

export interface RunnerKey {
  privateKey: KeyObject;
  /** Built member by member from the public key, so a private member cannot be carried along. */
  publicJwk: Ed25519PublicJwk;
  /** RFC 7638 thumbprint of `publicJwk`: the `keyid` of every signature. */
  jkt: string;
}

function fromPrivateKey(privateKey: KeyObject): RunnerKey {
  const exported = createPublicKey(privateKey).export({ format: "jwk" }) as { kty?: string; crv?: string; x?: string };
  const parsed = Ed25519PublicJwk.safeParse({ kty: exported.kty, crv: exported.crv, x: exported.x });
  if (!parsed.success) throw new CliError("the runner key is not an Ed25519 key");
  return { privateKey, publicJwk: parsed.data, jkt: jwkThumbprint(parsed.data) };
}

export function generateRunnerKey(): RunnerKey {
  return fromPrivateKey(generateKeyPairSync("ed25519").privateKey);
}

export function saveRunnerKey(dir: string, key: RunnerKey): void {
  writePrivateFile(dir, KEY_FILE, key.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
}

/** The saved key, or undefined when there is none. */
export function loadRunnerKey(dir: string): RunnerKey | undefined {
  const pem = readPrivateFile(dir, KEY_FILE);
  if (pem === undefined) return undefined;
  try {
    return fromPrivateKey(createPrivateKey(pem));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("the runner key file cannot be read; run: fx-runner revoke --local, then register again");
  }
}
