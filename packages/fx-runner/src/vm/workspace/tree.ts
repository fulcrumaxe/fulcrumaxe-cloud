/**
 * What the host knows of a tree, read from git's own listing (`git ls-tree -r -z`), and the checks built on it (D#587 B-5b):
 *  - the archive sent into a guest must BE the tree it claims (`verifyTree`): the same paths, modes and bytes, nothing added, nothing left out
 *    (a `.gitattributes` `export-ignore` or `export-subst` would otherwise change the tree the guest starts from);
 *  - the start commit goes in as its own raw text, so the guest's repository holds the REAL commit (same id, parents absent and marked shallow), and
 *    whatever the agent commits has that commit as its parent: the bundle that comes back is held to exactly that prerequisite.
 * Only SHA-1 repositories are supported; a 64-hex object id is refused (`archive_mismatch`), never hashed some other way.
 */
import { createHash } from "node:crypto";
import { ArchiveRefused, confinedPath, linkStaysInside, type TarEntry } from "./tar.js";

export interface TreeItem {
  /** `100644` and `100755` are files, `120000` a symbolic link; the listing of a tree that has any other entry (a submodule) is refused. */
  mode: "100644" | "100755" | "120000";
  oid: string;
  path: string;
  /** The blob's size in bytes, present when the listing was made with `-l`. */
  size?: number;
}

const SHA1 = /^[0-9a-f]{40}$/;

/** `git ls-tree -r -z --full-tree <tree>` output (or the same with `-l`, which adds each blob's size) as items. Every path is confined; anything else is refused. */
export function parseTreeListing(text: string, maxEntries: number): TreeItem[] {
  const items: TreeItem[] = [];
  for (const line of text.split("\0")) {
    if (line === "") continue;
    const match = line.match(/^(\d{6}) (blob|commit|tree) ([0-9a-f]{40,64})(?: +(\d{1,15}|-))?\t([\s\S]+)$/);
    if (match === null) throw new ArchiveRefused("archive_malformed");
    const [, mode, type, oid, sized, name] = match as unknown as [string, string, string, string, string | undefined, string];
    if (type !== "blob" || !SHA1.test(oid) || (mode !== "100644" && mode !== "100755" && mode !== "120000")) throw new ArchiveRefused("archive_type");
    const clean = confinedPath(name);
    if (clean === undefined || clean !== name) throw new ArchiveRefused("archive_path");
    if (items.length >= maxEntries) throw new ArchiveRefused("archive_too_large");
    items.push({ mode, oid, path: clean, ...(sized === undefined || sized === "-" ? {} : { size: Number(sized) }) });
  }
  return items;
}

/** Throws `archive_too_large` when the listed blobs add up to more than `maxBytes`, or a size is missing. The sum is taken before git writes any of the tree to disk. */
export function assertTreeSize(items: readonly TreeItem[], maxBytes: number): void {
  let total = 0;
  for (const item of items) {
    if (item.size === undefined) throw new ArchiveRefused("archive_too_large");
    total += item.size;
    if (total > maxBytes) throw new ArchiveRefused("archive_too_large");
  }
}

/** The id git gives a blob with these bytes (SHA-1 object format). */
export function blobOid(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${String(bytes.length)}\0`).update(bytes).digest("hex");
}

/** Throws `archive_mismatch` unless `entries` hold exactly the files and links `items` list, with the same bytes and the same executable bit. */
export function verifyTree(entries: readonly TarEntry[], items: readonly TreeItem[]): void {
  const wanted = new Map(items.map((item) => [item.path, item]));
  let seen = 0;
  for (const entry of entries) {
    if (entry.kind === "dir") continue;
    const item = wanted.get(entry.path);
    if (item === undefined) throw new ArchiveRefused("archive_mismatch");
    seen += 1;
    if (entry.kind === "symlink") {
      if (item.mode !== "120000" || blobOid(Buffer.from(entry.target ?? "", "utf8")) !== item.oid) throw new ArchiveRefused("archive_mismatch");
    } else {
      const executable = (entry.mode & 0o111) !== 0;
      if (item.mode === "120000" || (item.mode === "100755") !== executable || blobOid(entry.data ?? Buffer.alloc(0)) !== item.oid) throw new ArchiveRefused("archive_mismatch");
    }
  }
  if (seen !== items.length) throw new ArchiveRefused("archive_mismatch");
}

/** True when a listed link's target stays inside the tree (the same rule as for an archive's links). */
export function treeLinksStayInside(items: readonly TreeItem[], targetOf: (item: TreeItem) => string): boolean {
  return items.every((item) => item.mode !== "120000" || linkStaysInside(item.path, targetOf(item)));
}

/** The id git gives a commit object with this text (SHA-1 object format). */
export function commitOid(text: Buffer): string {
  return createHash("sha1").update(`commit ${String(text.length)}\0`).update(text).digest("hex");
}
