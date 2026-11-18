/**
 * The one parser for a 32-byte key given as base64 in the environment. Canonical only: standard alphabet, padded, nothing before, after or inside it, and
 * exactly 32 bytes once decoded. Shared by the environment check (health and the build gate) and by the machine key reader, so a value one accepts the other
 * accepts too. No imports: the environment check loads it under Node's type stripping.
 */
export function parseKek32(raw: string | undefined): Buffer | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 && key.toString('base64') === raw ? key : null;
}
