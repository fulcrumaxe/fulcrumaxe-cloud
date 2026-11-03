/**
 * D#597 CC-7a-1: `fx-runner assistant unlink`, the undo for `assistant link`. It revokes the delegation token on the cloud (a delegation token may
 * delete itself) and then removes the token file. A refused or unreachable cloud does not keep the file: it is removed anyway and the person is
 * told the token lapses within its hour and where an admin can revoke it now. Safe to run twice.
 */
import { assistantCall } from "./cloudCall.js";
import { AssistantError, readAssistantToken, removeAssistantToken } from "./tokenFile.js";

export interface UnlinkOptions {
  stateDir: string;
  uid: number | undefined;
  fetchFn: typeof fetch;
  out: (line: string) => void;
  bypass?: string | undefined;
}

const LAPSES = "The token could not be revoked on the cloud now; it expires within an hour of being issued. An admin can revoke it at once from the workspace's tokens list.";

export async function runUnlink(o: UnlinkOptions): Promise<void> {
  let revoked = false;
  let stored;
  try {
    stored = readAssistantToken(o.stateDir, o.uid);
  } catch (error) {
    if (!(error instanceof AssistantError)) throw error;
    // Nothing readable to revoke: a missing file is the repeat case; an unsafe one is still removed below.
    if (error.code === "assistant_token_missing") {
      o.out("No assistant token was stored.");
      return;
    }
  }
  if (stored !== undefined) {
    try {
      const reply = await assistantCall({ fetchFn: o.fetchFn, origin: stored.origin, method: "DELETE", path: `/api/v1/tokens/${encodeURIComponent(stored.token_id)}`, token: stored.token, bypass: o.bypass });
      // 401 or 404: it was already revoked or has expired, which is what was wanted.
      revoked = reply.status === 204 || reply.status === 401 || reply.status === 404;
    } catch {
      // fx-swallow-ok: offline is reported with the fixed lapse message below; the file is removed either way
      revoked = false;
    }
  }
  const removed = removeAssistantToken(o.stateDir, o.uid);
  o.out(revoked ? "Assistant token revoked on the cloud and removed from this machine." : removed ? "Assistant token removed from this machine." : "No assistant token was stored.");
  if (!revoked) o.out(LAPSES);
}
