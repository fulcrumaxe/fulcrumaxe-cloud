/**
 * What `register` and the device flow (`setup`) share: the refusal for a machine that already holds a registration, and the undo of a runner
 * the cloud created that this machine cannot keep.
 */
import { RevokeMessage } from "@fulcrumaxe/runner-protocol";
import { CliError } from "./cliError.js";
import { REVOKE_PATH, errorCodeOf, signedPost } from "./cloud.js";
import type { Registration } from "./config.js";
import type { CommandContext } from "./context.js";
import type { RunnerKey } from "./keys.js";
import { requireUsable } from "./protectionBypass.js";

/** One registration per machine, whatever its mode or account: a machine that holds one cannot hold two accounts. Re-registering needs a revoke first. */
export function existingRegistrationError(existing: Registration, requestedMode?: string): CliError {
  const ways = "run: fx-runner revoke, then register again (if the cloud no longer accepts this machine's key, such as an expired one, run: fx-runner revoke --local)";
  return new CliError(
    existing.credential_mode === "subscription" || requestedMode === "subscription"
      ? `this machine already holds a runner registration, and a subscription login is never shared between accounts; ${ways}`
      : `this machine already holds a runner registration; ${ways}`,
  );
}

/** What a signed revoke came to: the runner is revoked, the cloud knows no runner for this key (401: nothing was made), or the answer was neither (a refusal, a failure on the way). */
export type RevokeResult = "revoked" | "none" | "failed";

/** Asks the cloud to revoke the runner that `key` registered, signed with that key. */
export async function revokeByKey(origin: string, key: RunnerKey, ctx: CommandContext, reason: string): Promise<RevokeResult> {
  try {
    const body = RevokeMessage.parse({ reason });
    const reply = await signedPost({ origin, path: REVOKE_PATH, body, key, now: ctx.now(), fetchFn: ctx.fetchFn, bypass: requireUsable(ctx.bypass) });
    if (reply.status === 401) return "none";
    const revoked = (reply.body as { revoked?: unknown } | undefined)?.revoked === true;
    // 503 leases_not_failed also means the runner is revoked (the cloud could not yet stop its jobs, and a new runner has none).
    return revoked && (reply.status === 200 || (reply.status === 503 && errorCodeOf(reply.body) === "leases_not_failed")) ? "revoked" : "failed";
  } catch {
    // fx-swallow-ok: the caller reports that the revoke did not happen (with the runner id when it knows one), so an owner can do it
    return "failed";
  }
}

/** Revokes the runner that `key` just registered, signed with that key. True once the cloud says it is revoked. */
export async function selfRevoke(origin: string, key: RunnerKey, ctx: CommandContext, reason: string): Promise<boolean> {
  return (await revokeByKey(origin, key, ctx, reason)) === "revoked";
}
