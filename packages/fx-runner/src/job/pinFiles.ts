import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isPinPath, pinLedgerNotes, pinnedSectionText, readPinFiles, sha256Text, splitPinsByExcludes, type ContextSection, type Job, type PinFileSource, type PinFiles } from "@fulcrumaxe/runner-protocol";

/**
 * D#600 CX-5c2: the files a person pinned, read from THIS machine's checkout of the repository at the run's start commit, before the agent starts. The signed job carries
 * the paths only; the text is read here and goes into the prompt, and nothing of it leaves the machine (the ledger gets counts, closed reasons and a hash per section).
 *
 * The caps, the closed reasons and the exclude-wins rule are the protocol package's `readPinFiles`, `splitPinsByExcludes` and `pinLedgerNotes`, the same code the cloud's
 * sandbox path runs. This file is only the reading of the files, which must not follow a link out of the checkout: every path component is `lstat`ed (a link anywhere on
 * the way is refused, not followed), the path is checked lexically first (`isPinPath`: no `..`, no absolute path), the last component is opened with O_NOFOLLOW, and the
 * file's real location must lie under the checkout's. The `.git` folder is never read (its config can hold a remote's credentials). A refused path reads as missing.
 */

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * A pin source over a checkout directory. `between` is a seam for tests only: it runs after a file is located and before it is opened, the moment a swap would have to happen in.
 * The opened file must be the very file the walk saw (same device and inode), or it is refused.
 */
export function checkoutPinSource(root: string, between?: (rel: string) => Promise<void>): PinFileSource {
  /** The absolute path of a regular file at `rel` reached through plain directories only, with its identity, or null. */
  async function locate(rel: string): Promise<{ abs: string; size: number; dev: number; ino: number } | null> {
    if (!isPinPath(rel)) return null;
    const segments = rel.split("/");
    if (segments.some((seg) => seg.toLowerCase() === ".git")) return null;
    let current = path.resolve(root);
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]!);
      const info = await lstat(current).catch(() => null);
      if (info === null || info.isSymbolicLink()) return null;
      if (i === segments.length - 1) return info.isFile() ? { abs: current, size: info.size, dev: info.dev, ino: info.ino } : null;
      if (!info.isDirectory()) return null;
    }
    return null;
  }
  async function contained(abs: string): Promise<boolean> {
    const [real, base] = await Promise.all([realpath(abs), realpath(root)]);
    return real.startsWith(base + path.sep);
  }
  return {
    async stat(rel) {
      const found = await locate(rel);
      return found === null || !(await contained(found.abs).catch(() => false)) ? null : { size: found.size };
    },
    async text(rel, maxBytes) {
      const found = await locate(rel);
      if (found === null || !(await contained(found.abs).catch(() => false))) return null;
      await between?.(rel);
      const handle = await open(found.abs, constants.O_RDONLY | NO_FOLLOW | constants.O_NONBLOCK).catch(() => null);
      if (handle === null) return null;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > maxBytes || info.dev !== found.dev || info.ino !== found.ino) return null;
        const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > maxBytes) return null;
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } catch {
        // fx-swallow-ok: a file that cannot be read as text is a missing pin; the error text could hold a path
        return null;
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
  };
}

/** What the job's pins came to on this machine: the files read and the counts for the ledger. */
export interface JobPinsRead extends PinFiles {
  /** Pins an exclude covers: never opened. */
  excluded: number;
  /** The repository budget the job named, if it did. */
  budgetBytes?: number;
}

/**
 * Reads the pins of a job out of the checkout directory `workspace`. An exclude of the job wins over a pin: a pin it covers is counted, never handed to the source. A failure to read leaves every
 * remaining pin missing; it never refuses the run.
 */
export async function readJobPins(job: Pick<Job, "pins" | "excludes">, workspace: string, source: PinFileSource = checkoutPinSource(workspace)): Promise<JobPinsRead | undefined> {
  if (job.pins === undefined) return undefined;
  const { readable, excluded } = splitPinsByExcludes(job.pins.paths, job.excludes ?? []);
  let files: PinFiles;
  try {
    files = await readPinFiles(readable, source);
  } catch {
    // fx-swallow-ok: pins that cannot be read are counted as missing; the run starts without them
    files = { items: [], missing: readable.length, tooLarge: 0 };
  }
  return { ...files, excluded, ...(job.pins.budget_bytes === undefined ? {} : { budgetBytes: job.pins.budget_bytes }) };
}

/**
 * The ledger's account of the pins: one `pinned` section per file in the prompt (its byte count and the hash of its text) and then the closed-reason notes. Counts, sizes and
 * fixed hashes: no path, no file text.
 */
export function pinLedgerSections(read: JobPinsRead): ContextSection[] {
  const sections = read.items.map((item, i): ContextSection => {
    const text = pinnedSectionText(item, i, read.items.length);
    return { code: "pinned", bytes: Buffer.byteLength(text, "utf8"), sha256: sha256Text(text), trimmed_bytes: 0 };
  });
  return [...sections, ...pinLedgerNotes(read, read.budgetBytes)];
}
