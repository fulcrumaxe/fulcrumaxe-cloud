import path from "node:path";
import { pinWorkspace } from "../../src/daemon/workspacePin.js";

/** Pins a fixture workspace the way the daemon pins its clone (`hostRead.ts`), for tests that read a hand-made repository through the host-read helpers. Its `.git/config` must hold only keys the clone writes. */
export function pinFixture(workspace: string): void {
  pinWorkspace(workspace, path.join(workspace, ".git", "objects"));
}
