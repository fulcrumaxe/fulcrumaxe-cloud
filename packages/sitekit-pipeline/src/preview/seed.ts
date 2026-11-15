import type { SeedFile } from "../extract/index.js";

const MAX_SEED_FILES = 12;
const MAX_SEED_CHARS = 16_000;
const DOC_EXT = /\.(md|markdown|txt|rst|adoc)$/i;

/**
 * The shallow read a preview makes: the README and the other documentation files in the repository's top directory, and
 * nothing deeper. A path with a separator, a dot-dot or no documentation name is dropped. Each file is cut to a fixed size.
 * The text stays repository text: the prompt builder sanitizes it inside the untrusted-content fence.
 */
export function previewSeedFiles(files: readonly SeedFile[]): SeedFile[] {
  const isReadme = (p: string): boolean => /^readme/i.test(p);
  const top = files.filter(
    (f) =>
      typeof f.path === "string" &&
      typeof f.content === "string" &&
      f.path.length > 0 &&
      f.path.length <= 100 &&
      !f.path.includes("/") &&
      !f.path.includes("\\") &&
      f.path !== ".." &&
      f.path !== "." &&
      (isReadme(f.path) || DOC_EXT.test(f.path)),
  );
  top.sort((a, b) => Number(!isReadme(a.path)) - Number(!isReadme(b.path)) || a.path.localeCompare(b.path));
  return top.slice(0, MAX_SEED_FILES).map((f) => ({ path: f.path, content: f.content.slice(0, MAX_SEED_CHARS) }));
}
