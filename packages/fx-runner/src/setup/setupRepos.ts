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
import { EMPTY_BASE_COMMIT } from "@fulcrumaxe/runner-protocol";
import type { SetupRepos } from "./projectSetup.js";

const FULL = /^[0-9a-f]{40}$/;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_BASE_ENV = { GIT_AUTHOR_NAME: "fulcrumaxe", GIT_AUTHOR_EMAIL: "runner@localhost", GIT_COMMITTER_NAME: "fulcrumaxe", GIT_COMMITTER_EMAIL: "runner@localhost", GIT_AUTHOR_DATE: "@0 +0000", GIT_COMMITTER_DATE: "@0 +0000" };

export function createSetupRepos(deps: { git: Git; gitLarge: Git; mirrors: Pick<Mirrors, "sync">; workspaceRoot: string; scratchDir: () => string }): SetupRepos {
  return {
    async open({ repoId, owner, name, baseSha, mode }) {
      if (!FULL.test(baseSha)) throw new Error("base_sha");
      mkdirSync(deps.workspaceRoot, { recursive: true, mode: 0o700 });
      const workspace = path.join(deps.workspaceRoot, `setup-${randomBytes(8).toString("hex")}`);
      // Direct mode (the remote has no commit yet): the mirror cannot be made from it, so a scratch repository of ours holds the one fixed empty base commit. Nothing in it is ever pushed.
      const scratch = mode === "direct" ? path.join(deps.workspaceRoot, `setup-empty-${randomBytes(8).toString("hex")}.git`) : undefined;
      const release = async (): Promise<void> => {
        rmSync(workspace, { recursive: true, force: true });
        if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
      };
      try {
        let mirrorDir: string;
        if (scratch !== undefined) {
          if (baseSha !== EMPTY_BASE_COMMIT) throw new Error("base_sha");
          await deps.git.run("workspace_failed", ["init", "-q", "--bare", "--", scratch]);
          const made = (await deps.git.run("workspace_failed", ["-C", scratch, "commit-tree", EMPTY_TREE, "-m", "Empty base"], undefined, undefined, EMPTY_BASE_ENV)).trim();
          if (made !== EMPTY_BASE_COMMIT) throw new Error("empty_base");
          await deps.git.run("workspace_failed", ["-C", scratch, "update-ref", "refs/heads/fx-empty-base", made]);
          mirrorDir = scratch;
        } else {
          mirrorDir = (await deps.mirrors.sync({ id: String(repoId), owner, name })).dir;
        }
        await deps.git.run("workspace_failed", ["-C", mirrorDir, "cat-file", "-e", `${baseSha}^{commit}`]);
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
