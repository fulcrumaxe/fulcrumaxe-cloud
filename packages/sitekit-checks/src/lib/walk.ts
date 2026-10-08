import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Recursively find every file under `dir` whose basename passes `match`.
 * Sorted, so results are deterministic across platforms.
 */
export async function walkFiles(
  dir: string,
  match: (name: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      // fx-swallow-ok: an unreadable directory is skipped; the walk lists what it can read
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && match(entry.name)) {
        out.push(full);
      }
    }
  }

  await walk(dir);
  return out.sort();
}

export function findHtmlFiles(renderedDir: string): Promise<string[]> {
  return walkFiles(renderedDir, (name) => name.endsWith(".html"));
}

/** The path a browser would request for a page on disk, e.g. "/faq.html" or "/" for the root index. */
export function urlFor(renderedDir: string, filePath: string): string {
  const rel = path.relative(path.resolve(renderedDir), path.resolve(filePath)).split(path.sep).join("/");
  return rel === "index.html" ? "/" : "/" + rel;
}
