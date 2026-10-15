import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * A software passkey that speaks the real WebAuthn wire format: ES256 key, "none" attestation, authenticator data with the
 * UP/UV/AT flags and a counter, clientDataJSON, and a DER signature over authData || SHA-256(clientDataJSON). The app's
 * verification is the real @simplewebauthn/server, so these responses pass or fail on the same rules a browser's would.
 * What it cannot show: a real browser's prompt, or a platform authenticator's own behaviour.
 */
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64 = (b: Uint8Array | Buffer): string => isoBase64URL.fromBuffer(new Uint8Array(b));
const sha256 = (b: Uint8Array | Buffer | string): Buffer => createHash("sha256").update(b).digest();

export interface CeremonyOptions {
  /** Set the user-verified flag (default true). */
  uv?: boolean;
  /** Override the signature counter this response reports. */
  counter?: number;
  /** The origin written into clientDataJSON (default: the authenticator's own). */
  origin?: string;
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  counter = 0;
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;

  constructor(
    private readonly rpID: string,
    private readonly origin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.x = Buffer.from(jwk.x!, "base64url");
    this.y = Buffer.from(jwk.y!, "base64url");
  }

  get id(): string {
    return b64(this.credentialId);
  }

  private authData(flags: number, counter: number, attested: Buffer | null): Buffer {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    return Buffer.concat([sha256(this.rpID), Buffer.from([flags]), c, ...(attested ? [attested] : [])]);
  }

  private clientData(type: string, challenge: string, origin?: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: origin ?? this.origin, crossOrigin: false }));
  }

  /** The response to `navigator.credentials.create(options)`. */
  register(options: { challenge: string }, o: CeremonyOptions = {}) {
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(this.x)],
        [-3, new Uint8Array(this.y)],
      ]),
    );
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), len, this.credentialId, Buffer.from(cose)]);
    const flags = FLAG_UP | FLAG_AT | (o.uv === false ? 0 : FLAG_UV);
    const authData = this.authData(flags, o.counter ?? this.counter, attested);
    const attestation = new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)]]);
    const attestationObject = isoCBOR.encode(attestation as unknown as Parameters<typeof isoCBOR.encode>[0]);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64(this.clientData("webauthn.create", options.challenge, o.origin)),
        attestationObject: b64(attestationObject),
        transports: ["internal" as const],
      },
      clientExtensionResults: {},
    };
  }

  /** The response to `navigator.credentials.get(options)`. The counter advances unless one is given. */
  assert(options: { challenge: string }, o: CeremonyOptions = {}) {
    const counter = o.counter ?? ++this.counter;
    const flags = FLAG_UP | (o.uv === false ? 0 : FLAG_UV);
    const authData = this.authData(flags, counter, null);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, o.origin);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), { key: this.privateKey, dsaEncoding: "der" });
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authData), signature: b64(signature) },
      clientExtensionResults: {},
    };
  }
}
