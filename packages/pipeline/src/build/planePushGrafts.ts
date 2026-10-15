import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Whether the graft file git named exists. It lives in the git directory, not the working tree, and is kept
 * out of planePushGit.ts so that file can stay free of any filesystem import.
 */
export function graftFileExists(repoDir: string, graftPath: string): boolean {
  return existsSync(resolve(repoDir, graftPath));
}
