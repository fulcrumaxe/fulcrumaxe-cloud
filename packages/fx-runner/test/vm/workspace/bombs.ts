/**
 * Bundles made by hand for the host's size and framing checks (D#587 B-5b). A real `git bundle` never holds a 1 GiB object in a few hundred KB, so the shapes a hostile guest
 * would send are built here: a pack is a header, objects (each a size header, an optional delta base, and a zlib stream) and the SHA-1 of all of it.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { GIT_ENV } from "./helpers.js";

const sha1 = (...parts: Buffer[]): Buffer => {
  const h = createHash("sha1");
  for (const part of parts) h.update(part);
  return h.digest();
};
const oidOf = (type: string, body: Buffer): Buffer => sha1(Buffer.from(`${type} ${String(body.length)}\0`), body);

/** An object's header in a pack: the type in bits 4 to 6 of the first byte, the size in base-128 pieces after its low four bits. */
export function entryHeader(type: number, size: number): Buffer {
  const out: number[] = [];
  let first = (type << 4) | (size % 16);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(first);
  return Buffer.from(out);
}

function varint(n: number): Buffer {
  const out: number[] = [];
  let rest = n;
  for (;;) {
    const low = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) out.push(low | 0x80);
    else {
      out.push(low);
      return Buffer.from(out);
    }
  }
}

/** A whole object entry: a commit, tree or blob (types 1 to 3) from its raw body. */
export const plainEntry = (type: 1 | 2 | 3, body: Buffer): Buffer => Buffer.concat([entryHeader(type, body.length), deflateSync(body, { level: 9 })]);

/** A reference delta (type 7) against the object `baseOid` that rebuilds `size` bytes from `blocks` copies of one 64 KiB block of it. */
export function copyDeltaEntry(baseOid: Buffer, baseLength: number, size: number): Buffer {
  const copies = size / 65536;
  const delta = Buffer.concat([varint(baseLength), varint(size), Buffer.alloc(copies, 0x80)]);
  return Buffer.concat([entryHeader(7, delta.length), baseOid, deflateSync(delta, { level: 9 })]);
}

export interface PackObjects {
  /** Entries in the order they are written. */
  entries: Buffer[];
  /** The object count the pack header says (default: the number of entries). */
  count?: number;
  /** Bytes between the last entry and the checksum. */
  after?: Buffer;
  /** Leaves the checksum off, or ends the pack early. */
  noTrailer?: boolean;
}

export function packOf(objects: PackObjects): Buffer {
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "latin1");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.count ?? objects.entries.length, 8);
  const body = Buffer.concat([head, ...objects.entries, objects.after ?? Buffer.alloc(0)]);
  return objects.noTrailer === true ? body : Buffer.concat([body, sha1(body)]);
}

/** The bundle text a real `git bundle` writes for one prerequisite and `HEAD`, then the pack. */
export const bundleOf = (base: string, tip: string, pack: Buffer): Buffer => Buffer.concat([Buffer.from(`# v2 git bundle\n-${base} crafted\n${tip} HEAD\n\n`, "latin1"), pack]);

export type BlobSource = { kind: "raw"; body: Buffer } | { kind: "zeros"; size: number } | { kind: "copies"; size: number };

export interface CraftedBundle {
  bundle: Buffer;
  tip: string;
  /** The names and sizes of what the tip's tree holds beside the start commit's files. */
  added: Array<{ name: string; size: number }>;
}

/**
 * A bundle with one commit on `base` whose tree is the base tree plus the named blobs. `zeros` is one blob of that many zero bytes (a zlib stream of a few hundred KB for a
 * gigabyte); `copies` is a blob rebuilt by a delta that copies one 64 KiB block that many bytes over (the size must be a multiple of 65536); `raw` is stored as given.
 */
export function craftBundle(mirror: string, base: string, blobs: Array<{ name: string; source: BlobSource }>, over: { extraObjects?: Buffer[]; extraCopies?: number[] } = {}): CraftedBundle {
  const git = (...args: string[]): Buffer => execFileSync("git", ["-C", mirror, ...args], { env: GIT_ENV(), maxBuffer: 1 << 26 });
  const baseTree = git("rev-parse", `${base}^{tree}`).toString().trim();
  const rawTree = git("cat-file", "tree", baseTree);
  const entries: Array<{ mode: string; name: string; oid: Buffer }> = [];
  for (let at = 0; at < rawTree.length; ) {
    const space = rawTree.indexOf(0x20, at);
    const nul = rawTree.indexOf(0, space);
    entries.push({ mode: rawTree.subarray(at, space).toString(), name: rawTree.subarray(space + 1, nul).toString(), oid: Buffer.from(rawTree.subarray(nul + 1, nul + 21)) });
    at = nul + 21;
  }
  const packEntries: Buffer[] = [];
  const added: CraftedBundle["added"] = [];
  let seed: { oid: Buffer; body: Buffer } | undefined;
  for (const blob of blobs) {
    const source = blob.source;
    let oid: Buffer;
    let size: number;
    if (source.kind === "raw") {
      oid = oidOf("blob", source.body);
      size = source.body.length;
      packEntries.push(plainEntry(3, source.body));
    } else if (source.kind === "zeros") {
      const body = Buffer.alloc(source.size);
      oid = oidOf("blob", body);
      size = source.size;
      packEntries.push(plainEntry(3, body));
    } else {
      if (seed === undefined) {
        const body = randomBytes(65536);
        seed = { oid: oidOf("blob", body), body };
        packEntries.push(plainEntry(3, body));
        entries.push({ mode: "100644", name: "seed.bin", oid: seed.oid });
      }
      const h = createHash("sha1").update(`blob ${String(source.size)}\0`);
      for (let i = 0; i < source.size / 65536; i++) h.update(seed.body);
      oid = h.digest();
      size = source.size;
      packEntries.push(copyDeltaEntry(seed.oid, seed.body.length, source.size));
    }
    entries.push({ mode: "100644", name: blob.name, oid });
    added.push({ name: blob.name, size });
  }
  // delta objects the tree does not name (their results count toward the pack's caps all the same)
  for (const size of over.extraCopies ?? []) {
    if (seed === undefined) {
      const body = randomBytes(65536);
      seed = { oid: oidOf("blob", body), body };
      packEntries.push(plainEntry(3, body));
      entries.push({ mode: "100644", name: "seed.bin", oid: seed.oid });
    }
    packEntries.push(copyDeltaEntry(seed.oid, seed.body.length, size));
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const tree = Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), e.oid])));
  const treeOid = oidOf("tree", tree);
  const commit = Buffer.from(`tree ${treeOid.toString("hex")}\nparent ${base}\nauthor t <t@e> 1700000000 +0000\ncommitter t <t@e> 1700000000 +0000\n\ncrafted\n`);
  const tip = oidOf("commit", commit).toString("hex");
  const pack = packOf({ entries: [plainEntry(1, commit), plainEntry(2, tree), ...packEntries, ...(over.extraObjects ?? [])] });
  return { bundle: bundleOf(base, tip, pack), tip, added };
}
