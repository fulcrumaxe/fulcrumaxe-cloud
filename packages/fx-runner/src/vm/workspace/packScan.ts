/**
 * What the host reads of a bundle's pack before git sees a byte of it (D#587 B-5b). The compressed size of a bundle is capped, but nothing about its INFLATED size is: a few
 * hundred KB of zlib can stand for gigabytes of zeros, and a delta that copies one 64 KiB block ten thousand times declares an object of hundreds of MiB (git builds a delta's
 * result whole in memory, and resolves several at once). Both would fill the host's disk or memory before any later check ran.
 *
 * So the pack is walked here, as data. For each object the declared size is read from its header; a delta's declared RESULT size is read from the first bytes of its own
 * (inflated) instructions. The bundle is refused (`bundle_too_large`) when one object is over the per-object cap, or the sum of all of them (each header size, and each delta's result as well) is over the total cap, or the pack
 * holds more objects than any agent's commits need. Git checks every declared size against the real data, so a cap on the declared sizes is a cap on the real ones.
 * Every inflate is bounded by the size its own header declared (`maxOutputLength`), so a header that lies small cannot make this walk inflate more than it said.
 *
 * Nothing is written anywhere, and nothing from a refused pack is echoed: the refusal is a closed code. A pack whose framing does not parse is `bundle_malformed`.
 */
import { inflateSync } from "node:zlib";
import { BundleRefused } from "./bundleHeader.js";

export interface PackLimits {
  /** The most one object's declared size, or one delta's declared result size, may be (GitHub refuses a larger blob anyway). */
  perObject: number;
  /** The most all objects' declared sizes may add up to. */
  total: number;
  /** The most objects the pack may hold. */
  objects: number;
}

export const DEFAULT_PACK_LIMITS: Readonly<PackLimits> = Object.freeze({ perObject: 100 * 1024 * 1024, total: 1024 * 1024 * 1024, objects: 500_000 });

/** The 20-byte SHA-1 that ends a pack. */
const TRAILER = 20;

const refuse = (code: "bundle_too_large" | "bundle_malformed"): never => {
  throw new BundleRefused(code);
};

const yieldToLoop = (): Promise<void> => new Promise<void>((resolve) => void setImmediate(resolve));

/** A little-endian base-128 number (the delta header's): its value and the position after it. Over `cap` is refused as too large; one that runs off the data is malformed. */
function delta128(data: Buffer, from: number, cap: number): { value: number; next: number } {
  let value = 0;
  let scale = 1;
  for (let i = from; i < data.length && i < from + 10; i++) {
    const byte = data[i] as number;
    value += (byte & 0x7f) * scale;
    if (value > cap) return refuse("bundle_too_large");
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    scale *= 128;
  }
  return refuse("bundle_malformed");
}

/**
 * Walks the pack that starts at `packAt` (the header parser has checked the `PACK` magic and version 2). Throws `BundleRefused`; resolves when every object is within the limits
 * and the pack ends where its object count says.
 */
export async function scanPack(bundle: Buffer, packAt: number, limits: Readonly<PackLimits> = DEFAULT_PACK_LIMITS): Promise<void> {
  if (bundle.length < packAt + 12 + TRAILER) return refuse("bundle_malformed");
  const count = bundle.readUInt32BE(packAt + 8);
  if (count > limits.objects) return refuse("bundle_too_large");
  const end = bundle.length - TRAILER;
  let at = packAt + 12;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at >= end) return refuse("bundle_malformed");
    let byte = bundle[at++] as number;
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let scale = 16;
    while ((byte & 0x80) !== 0) {
      if (at >= end) return refuse("bundle_malformed");
      byte = bundle[at++] as number;
      size += (byte & 0x7f) * scale;
      scale *= 128;
      if (size > limits.perObject) return refuse("bundle_too_large");
    }
    if (size > limits.perObject) return refuse("bundle_too_large");
    if (type === 6) {
      // an offset delta names its base by a distance, in the same base-128 form with a continuation bit
      let more = true;
      for (let i = 0; more; i++) {
        if (i >= 10 || at >= end) return refuse("bundle_malformed");
        more = ((bundle[at++] as number) & 0x80) !== 0;
      }
    } else if (type === 7) {
      at += TRAILER;
      if (at >= end) return refuse("bundle_malformed");
    } else if (type < 1 || type > 4) {
      return refuse("bundle_malformed");
    }
    const isDelta = type === 6 || type === 7;
    // Every object's header size counts: a plain object's is what it builds, a delta's is the instruction stream this walk (and then git) inflates. A delta's result is added below as well.
    total += size;
    if (total > limits.total) return refuse("bundle_too_large");
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = inflateSync(bundle.subarray(at, end), { maxOutputLength: Math.max(size, 1), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    } catch {
      // fx-swallow-ok: replaced by a closed code; zlib's own text is never kept (the data is a guest's)
      return refuse("bundle_malformed");
    }
    if (inflated.buffer.length !== size || inflated.engine.bytesWritten <= 0) return refuse("bundle_malformed");
    at += inflated.engine.bytesWritten;
    if (isDelta) {
      // the delta's own instructions begin with the size of the base and then the size of the result it builds
      const source = delta128(inflated.buffer, 0, limits.perObject);
      const target = delta128(inflated.buffer, source.next, limits.perObject);
      total += target.value;
      if (total > limits.total) return refuse("bundle_too_large");
    }
    if (size > 1024 * 1024 || n % 256 === 255) await yieldToLoop();
  }
  if (at !== end) return refuse("bundle_malformed");
}
