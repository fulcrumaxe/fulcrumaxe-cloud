/**
 * What the host reads of a bundle before git sees a byte of it (D#587 B-5b). A bundle that leaves a guest is untrusted data, so its header is parsed here, as
 * text, and held to the one shape the runner asks for; only then is it handed to `git fetch`.
 *
 *  - The first line is `# v2 git bundle` (SHA-1 object format), or `# v3 git bundle` with exactly the one capability `@object-format=sha1`.
 *  - Exactly one prerequisite line, and it names the commit the guest was started from. Its comment (git writes the commit's subject there) is ignored, never used.
 *  - Exactly one reference, `HEAD`, at a full lower-case commit id. No other reference name is accepted, so a guest cannot name a ref of its own.
 *  - A blank line ends the header, and the pack follows: its first four bytes must be `PACK` and the version 2. The header is at most 16 KiB and the whole
 *    bundle at most the caller's cap.
 * Nothing from a refused bundle is echoed: the refusal is a closed code.
 */
export type BundleRefusal = "bundle_too_large" | "bundle_malformed" | "bundle_prerequisite" | "bundle_ref";

export class BundleRefused extends Error {
  constructor(readonly code: BundleRefusal | "bundle_commits" | "bundle_tree" | "bundle_base_moved" | "bundle_fetch_failed") {
    super(code);
    this.name = "BundleRefused";
  }
}

/** The most a bundle may be: far more than an agent's commits need, small enough to hold in memory and to refuse a flood. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const OID = /^[0-9a-f]{40}$/;

export interface BundleHeader {
  /** The commit `HEAD` names in the bundle. */
  tip: string;
  /** Where the pack starts. */
  packAt: number;
}

export function parseBundleHeader(bundle: Buffer, expectedBase: string, maxBytes = MAX_BUNDLE_BYTES): BundleHeader {
  if (bundle.length > maxBytes) throw new BundleRefused("bundle_too_large");
  if (!OID.test(expectedBase)) throw new BundleRefused("bundle_prerequisite");
  const end = bundle.subarray(0, Math.min(bundle.length, MAX_HEADER_BYTES)).indexOf("\n\n");
  if (end < 0) throw new BundleRefused("bundle_malformed");
  const lines = bundle.subarray(0, end).toString("latin1").split("\n");
  const first = lines.shift();
  let captured = 0;
  if (first === "# v3 git bundle") {
    while (lines[0]?.startsWith("@") === true) {
      if (lines.shift() !== "@object-format=sha1") throw new BundleRefused("bundle_malformed");
      captured += 1;
    }
    if (captured > 1) throw new BundleRefused("bundle_malformed");
  } else if (first !== "# v2 git bundle") {
    throw new BundleRefused("bundle_malformed");
  }
  const prerequisites: string[] = [];
  const refs: Array<{ oid: string; name: string }> = [];
  for (const line of lines) {
    if (line.startsWith("-")) {
      const oid = line.slice(1, 41);
      if (!OID.test(oid) || (line.length > 41 && line[41] !== " ")) throw new BundleRefused("bundle_malformed");
      prerequisites.push(oid);
    } else {
      const match = line.match(/^([0-9a-f]{40}) (.+)$/);
      if (match === null) throw new BundleRefused("bundle_malformed");
      refs.push({ oid: match[1] as string, name: match[2] as string });
    }
  }
  if (prerequisites.length !== 1 || prerequisites[0] !== expectedBase) throw new BundleRefused("bundle_prerequisite");
  if (refs.length !== 1 || refs[0]?.name !== "HEAD") throw new BundleRefused("bundle_ref");
  const packAt = end + 2;
  if (bundle.length < packAt + 12 || bundle.subarray(packAt, packAt + 4).toString("latin1") !== "PACK" || bundle.readUInt32BE(packAt + 4) !== 2) throw new BundleRefused("bundle_malformed");
  return { tip: (refs[0] as { oid: string }).oid, packAt };
}
