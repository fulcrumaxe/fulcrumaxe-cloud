/**
 * D#845 ON-8d: the host's copy of a repo for a setup: the mirror brought up to date (the person's own git, never the guest's), a pinned work tree at `base_sha` that the verified bundle is applied to (named at random
 * below the workspace root, removed when the setup ends), and the archive of that commit for the guest.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Git } from "../daemon/git.js";
import { pinWorkspaceGit } from "../daemon/hostRead.js";
import type { Mirrors } from "../daemon/mirror.js";
import { buildWorkspaceArchive } from "../daemon/vmArchive.js";
import type { SetupRepos } from "./projectSetup.js";

const FULL = /^[0-9a-f]{40}$/;

export function createSetupRepos(deps: { git: Git; gitLarge: Git; mirrors: Pick<Mirrors, "sync">; workspaceRoot: string; scratchDir: () => string }): SetupRepos {
  return {
    async open({ repoId, owner, name, baseSha }) {
      if (!FULL.test(baseSha)) throw new Error("base_sha");
      const { dir: mirrorDir } = await deps.mirrors.sync({ id: String(repoId), owner, name });
      await deps.git.run("workspace_failed", ["-C", mirrorDir, "cat-file", "-e", `${baseSha}^{commit}`]);
      mkdirSync(deps.workspaceRoot, { recursive: true, mode: 0o700 });
      const workspace = path.join(deps.workspaceRoot, `setup-${randomBytes(8).toString("hex")}`);
      const release = async (): Promise<void> => rmSync(workspace, { recursive: true, force: true });
      try {
        await deps.git.run("workspace_failed", ["clone", "--reference", mirrorDir, "--no-local", "--", mirrorDir, workspace]);
        await deps.git.run("workspace_failed", ["-C", workspace, "checkout", "-q", "-B", "fx/setup", baseSha]);
        await pinWorkspaceGit(deps.gitLarge, workspace, path.join(mirrorDir, "objects"));
        const archive = await buildWorkspaceArchive({ git: deps.git, gitLarge: deps.gitLarge, scratchDir: deps.scratchDir() }, mirrorDir, baseSha);
        return { mirrorDir, workspace, archive, release };
      } catch (error) {
        await release();
        throw error;
      }
    },
  };
}
