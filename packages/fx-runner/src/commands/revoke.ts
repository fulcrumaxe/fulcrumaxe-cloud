/**
 * `fx-runner revoke [--reason text] [--local]`
 *
 * Tells the cloud to revoke this runner (signed by its own key), then deletes the key and the registration. With
 * `--local` nothing is sent: the local files are removed, and the runner stays registered until it is revoked in the
 * workspace. That is the way out when the cloud no longer accepts this machine's key.
 */
import { RevokeMessage } from "@fulcrumaxe/runner-protocol";
import { CliError } from "../cliError.js";
import { requireUsable } from "../protectionBypass.js";
import { REVOKE_PATH, errorCodeOf, refusalError, signedPost } from "../cloud.js";
import { KEY_FILE, REGISTRATION_FILE, loadRegistration, removeStateFile } from "../config.js";
import type { CommandContext, Flags } from "../context.js";
import { loadRunnerKey } from "../keys.js";

function forget(ctx: CommandContext): void {
  removeStateFile(ctx.stateDir, KEY_FILE);
  removeStateFile(ctx.stateDir, REGISTRATION_FILE);
}

export async function revokeCommand(flags: Flags, ctx: CommandContext): Promise<number> {
  const reason = flags.get("reason");
  if (reason !== undefined && typeof reason !== "string") throw new CliError("--reason needs a value", 2);
  const local = flags.get("local") === true;
  if (flags.get("local") !== undefined && !local) throw new CliError("--local takes no value", 2);

  if (local) {
    forget(ctx);
    ctx.out("Removed this machine's runner key and registration. The runner stays registered in the workspace until it is revoked there.");
    return 0;
  }

  const registration = loadRegistration(ctx.stateDir);
  if (!registration) throw new CliError("this machine has no runner registration");
  const key = loadRunnerKey(ctx.stateDir);
  if (!key || key.jkt !== registration.jkt) throw new CliError("the runner key is missing or does not match; run: fx-runner revoke --local");

  const message = RevokeMessage.safeParse(reason === undefined ? {} : { reason });
  if (!message.success) throw new CliError("--reason must be at most 200 characters with no control characters", 2);

  const reply = await signedPost({ origin: registration.cloud_origin, path: REVOKE_PATH, body: message.data, key, now: ctx.now(), fetchFn: ctx.fetchFn, bypass: requireUsable(ctx.bypass) });
  const body = reply.body as { revoked?: unknown; runs_failed?: unknown } | undefined;
  if (reply.status === 200 && body?.revoked === true) {
    forget(ctx);
    const failed = typeof body.runs_failed === "number" && Number.isSafeInteger(body.runs_failed) ? body.runs_failed : 0;
    ctx.out(`Revoked runner ${registration.runner_id}. ${failed} running job${failed === 1 ? " was" : "s were"} stopped. The local key is deleted.`);
    if (registration.credential_mode === "api_key") ctx.out("The stored API key file is left in place; to remove it run: fx-runner credentials clear-api-key");
    return 0;
  }
  // The cloud revoked the runner but could not yet fail its jobs: the key is dead either way, so it goes.
  if (reply.status === 503 && errorCodeOf(reply.body) === "leases_not_failed" && (reply.body as { revoked?: unknown }).revoked === true) {
    forget(ctx);
    ctx.err(`Runner ${registration.runner_id} is revoked, but its running jobs could not be stopped yet. Revoke it again from the workspace to finish. The local key is deleted.`);
    return 1;
  }
  throw refusalError(reply);
}
