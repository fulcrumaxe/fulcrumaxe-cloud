/**
 * The platform key-encryption-key (KEK) wrapping each connection's data
 * key (criterion 2). Versioned so the platform can rotate its own root
 * key without re-encrypting every stored connection:
 * `model_connections.kek_version` records which version wrapped a row's
 * data key, and decrypt always asks for that exact version.
 *
 * An interface, not a bare `Buffer`, so tests inject a fake source
 * instead of depending on `FX_KEK_V1` being set -- see
 * test/helpers/fakeKek.ts.
 */
export interface KekSource {
  /** The version new connections should be wrapped under. */
  currentVersion(): number;
  /** The raw 32-byte AES-256 key for `version`. Throws if unavailable. */
  keyFor(version: number): Buffer;
}

/**
 * Reads `FX_KEK_V{version}` from the environment (base64, exactly 32
 * bytes decoded). Current version from `FX_KEK_CURRENT_VERSION`
 * (default 1) -- `FX_KEK_V1` is that default's env var name.
 *
 * `FX_KEK_V*` is this package's own root key, scoped to model
 * connections specifically (crypto.ts's AAD binds every ciphertext to
 * `purpose: 'model_key'`) -- not a platform-wide key shared across
 * secret types. A future category (D#31 named webhook signing secrets)
 * gets its own `FX_WEBHOOK_KEK_V1` and its own KekSource, never this one.
 */
export function envKekSource(env: Readonly<Record<string, string | undefined>> = process.env): KekSource {
  const currentVersion = Number.parseInt(env.FX_KEK_CURRENT_VERSION ?? '1', 10);
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new Error(`envKekSource: FX_KEK_CURRENT_VERSION must be a positive integer, got: ${env.FX_KEK_CURRENT_VERSION}`);
  }

  return {
    currentVersion: () => currentVersion,
    keyFor: (version: number): Buffer => {
      const varName = `FX_KEK_V${version}`;
      const raw = env[varName];
      if (!raw) {
        throw new Error(`envKekSource: ${varName} is not set`);
      }
      const key = Buffer.from(raw, 'base64');
      if (key.length !== 32) {
        throw new Error(`envKekSource: ${varName} must decode (base64) to exactly 32 bytes, got ${key.length}`);
      }
      return key;
    },
  };
}
