/**
 * Tests that must not run against production: the ones whose title carries the `@staging-only` tag.
 *
 * A pack on both targets can still hold a test that writes (a valid telemetry report, an oversize body). It is
 * tagged in its title, and three things keep it off production: `plan` lists it as skipped, the runner passes
 * `--grep-invert @staging-only` to Playwright, and the test skips itself when the target is not staging. The
 * write fence is the backstop behind all three.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const STAGING_ONLY_TAG = "@staging-only";

export interface StagingOnlyTest {
  pack: string;
  test: string;
}

const TITLE = /\btest\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;

/** Titles in `text` that carry the tag. */
export function stagingOnlyTitles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TITLE)) {
    const title = m[2] as string;
    if (title.includes(STAGING_ONLY_TAG)) out.push(title.replace(STAGING_ONLY_TAG, "").replace(/\s+/g, " ").trim());
  }
  return out;
}

/** Every staging-only test under `packsDir/<id>/*.spec.ts`, in pack-id then file order. */
export function listStagingOnlyTests(packsDir: string): StagingOnlyTest[] {
  if (!existsSync(packsDir)) return [];
  const out: StagingOnlyTest[] = [];
  for (const pack of readdirSync(packsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    for (const file of readdirSync(join(packsDir, pack)).filter((f) => f.endsWith(".spec.ts")).sort()) {
      for (const test of stagingOnlyTitles(readFileSync(join(packsDir, pack, file), "utf8"))) out.push({ pack, test });
    }
  }
  return out;
}
