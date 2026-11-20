// Reads the installed template manifest for the boot facts (src/vm/bootFacts.ts). Only node:fs is imported here so a test can load it; the path comes from the caller.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const MAX_MANIFEST_BYTES = 64 * 1024;

/**
 * The manifest's text. Any failure throws, which is `image_not_installed`: a missing file, a final symlink, a FIFO or device or directory, a file not owned by
 * `expectedUid` (root, as `vm install` leaves it), a file anyone but the owner can write, or one over the cap. The owner is a parameter for the caller (a test
 * runs as an ordinary user); it never comes from the environment.
 * @param {string} file
 * @param {number} [expectedUid]
 */
export function readInstalledManifest(file, expectedUid = 0) {
  // O_NONBLOCK so opening a FIFO cannot wait for a writer; the regular-file check below then refuses it.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== expectedUid || (st.mode & 0o022) !== 0 || st.size > MAX_MANIFEST_BYTES) throw new Error("not a plain manifest");
    // At most cap + 1 bytes: a file that grew after the check is refused, never read in full.
    const buf = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
    }
    if (total > MAX_MANIFEST_BYTES) throw new Error("manifest over the cap");
    return buf.toString("utf8", 0, total);
  } finally {
    closeSync(fd);
  }
}
