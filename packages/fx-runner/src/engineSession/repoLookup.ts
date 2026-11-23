/**
 * D#845 ON-13a1: who a repository id is on THIS machine. A signed session job names a repository by its numeric id only, and a start that has to seed a new VM needs its owner and name to bring the host's
 * mirror up to date. The answer comes only from the mirror this machine already made for the id (the setup's), never from the cloud: the recorded `remote.origin.url` must be exactly the plain
 * `https://github.com/<owner>/<name>.git` this runner clones from, with an owner and a name of the shapes the mirror code itself accepts. A machine with no such mirror answers undefined, and the start
 * ends `vm_workspace_failed` (a repository this machine never set up is not one it can seed).
 */
import { lstatSync } from "node:fs";
import type { Git } from "../daemon/git.js";

const ORIGIN = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\.git$/;

export function createRepoLookup(deps: { git: Pick<Git, "run">; mirrorDir: (repoGhId: number) => string }): (repoGhId: number) => Promise<{ owner: string; name: string } | undefined> {
  return async (repoGhId) => {
    try {
      const dir = deps.mirrorDir(repoGhId);
      const stat = lstatSync(dir, { throwIfNoEntry: false });
      if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
      const origin = (await deps.git.run("mirror_failed", ["-C", dir, "config", "--get", "remote.origin.url"])).trim();
      const found = origin.match(ORIGIN);
      if (found === null || /^\.+$/.test(found[2] as string)) return undefined;
      return { owner: found[1] as string, name: found[2] as string };
    } catch {
      // fx-swallow-ok: a mirror that cannot be read is no answer; the start then ends in one closed code and nothing of the error is kept
      return undefined;
    }
  };
}
