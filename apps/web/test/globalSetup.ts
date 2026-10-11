// apps/web/test/globalSetup.ts
//
// D#37 WS-C2 criterion 1: apps/web/app/route.ts imports a generated
// module (app/_generated/workspace-index.ts) built by
// apps/web/scripts/copy-workspace.mjs from apps/workspace's own build.
// `pnpm --filter web build`'s "build:prepare" script regenerates it before
// `next build`, but the root `pnpm test` (`vitest run`) step runs
// BEFORE that build step in scripts/check.sh — without this,
// apps/web/test/route.test.ts (and anything else importing that
// module) would only ever see whatever copy happened to be committed,
// never a fresh one built from the current tree.
//
// This regenerates it once, before any test in the "web" Vitest
// project runs, from vitest.workspace.ts's `globalSetup` entry for
// that project — the same mechanism packages/db/vitest.config.ts uses
// to stand up its throwaway Postgres before its own tests run.
//
// This does neither of the two things D#56's guard (scripts/
// check-globalsetup-env.sh) forbids in a globalSetup file: it writes
// no environment variable, and it picks no random port. Root cause for
// both rules is documented in that script's own header.
import { copyWorkspace } from "../scripts/copy-workspace.mjs";

export default async function globalSetup(): Promise<void> {
  await copyWorkspace();
}
