/**
 * `fx-runner register --code fxrr_... --credential-mode subscription|api_key --cloud-url https://...`
 *
 * Generates the runner's key on this machine, signs the registration with it and, once the cloud accepts, saves the key
 * (0600) and the registration. The request body holds the code and the public JWK only.
 */
import { CredentialMode, RegisterMessage, RegisterResponse, RevokeMessage } from "@fulcrumaxe/runner-protocol";
import { CliError } from "../cliError.js";
import { requireUsable } from "../protectionBypass.js";
import { REGISTER_PATH, REVOKE_PATH, errorCodeOf, normaliseOrigin, refusalError, signedPost } from "../cloud.js";
import { loadRegistration, saveRegistration, withRegisterLock } from "../config.js";
import type { CommandContext, Flags } from "../context.js";
import { defaultRunnerName, readHostname } from "../hostFacts.js";
import { generateRunnerKey, saveRunnerKey, type RunnerKey } from "../keys.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringFlag(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value === "") throw new CliError(`--${name} is required`, 2);
  return value;
}

/** Revokes the runner that `key` just registered, signed with that key. True once the cloud says it is revoked. */
async function selfRevoke(origin: string, key: RunnerKey, ctx: CommandContext, reason: string): Promise<boolean> {
  try {
    const body = RevokeMessage.parse({ reason });
    const reply = await signedPost({ origin, path: REVOKE_PATH, body, key, now: ctx.now(), fetchFn: ctx.fetchFn, bypass: requireUsable(ctx.bypass) });
    const revoked = (reply.body as { revoked?: unknown } | undefined)?.revoked === true;
    // 503 leases_not_failed also means the runner is revoked (the cloud could not yet stop its jobs, and a new runner has none).
    return revoked && (reply.status === 200 || (reply.status === 503 && errorCodeOf(reply.body) === "leases_not_failed"));
  } catch {
    // fx-swallow-ok: the caller reports that the revoke did not happen, with the runner id, so an owner can do it
    return false;
  }
}

export async function registerCommand(flags: Flags, ctx: CommandContext): Promise<number> {
  const code = stringFlag(flags, "code");
  const mode = CredentialMode.safeParse(stringFlag(flags, "credential-mode"));
  if (!mode.success) throw new CliError("--credential-mode must be subscription or api_key", 2);
  const origin = normaliseOrigin(stringFlag(flags, "cloud-url"));

  const key = generateRunnerKey();
  // D#605 FL-2: the host name is the default runner name (the person renames it in the workspace). Without a usable one the request carries no name.
  const name = defaultRunnerName(ctx.hostname ?? readHostname());
  const message = RegisterMessage.safeParse({ code, public_key_jwk: key.publicJwk, ...(name === undefined ? {} : { name }) });
  if (!message.success) throw new CliError("the registration code is not in the form fxrr_ followed by letters and digits", 2);

  // One registration per machine, whatever its mode or account: a machine that holds one cannot hold two accounts, which
  // is what keeps a subscription login to one person. Re-registering needs a revoke first. The lock makes the check and
  // the save one step, so two runs started together cannot both register.
  return withRegisterLock(ctx.stateDir, ctx.now, async () => {
    const existing = loadRegistration(ctx.stateDir);
    if (existing) {
      const ways = "run: fx-runner revoke, then register again (if the cloud no longer accepts this machine's key, such as an expired one, run: fx-runner revoke --local)";
      throw new CliError(
        existing.credential_mode === "subscription" || mode.data === "subscription"
          ? `this machine already holds a runner registration, and a subscription login is never shared between accounts; ${ways}`
          : `this machine already holds a runner registration; ${ways}`,
      );
    }

    const reply = await signedPost({ origin, path: REGISTER_PATH, body: message.data, key, now: ctx.now(), fetchFn: ctx.fetchFn, bypass: requireUsable(ctx.bypass) });
    // A cloud that predates runner names refuses the unknown `name` key as an invalid message. The name was checked against the same rule here, so
    // that answer means the cloud is older than this runner: the fix is on the cloud's side, not a newer fx-runner.
    if (reply.status === 400 && errorCodeOf(reply.body) === "invalid_message" && name !== undefined) {
      throw new CliError("this cloud does not support runner names yet; ask your admin to update the cloud, then register again");
    }
    if (reply.status !== 201) throw refusalError(reply);
    const parsed = RegisterResponse.safeParse(reply.body);
    if (!parsed.success) {
      // The cloud may have created a runner even though its reply is unusable. When the reply names one, undo it with the
      // key still in memory (best effort); the id and the runner screen are named only if that did not work.
      const id = (reply.body as { runner_id?: unknown } | undefined)?.runner_id;
      let created = "";
      if (typeof id === "string" && UUID.test(id) && !(await selfRevoke(origin, key, ctx, "the registration reply was not understood"))) {
        created = `; runner ${id} could not be revoked from here, so revoke it on the runner screen in the workspace`;
      }
      throw new CliError(`the cloud's reply was not understood; update fx-runner and try again${created}`);
    }
    const { runner_id: runnerId, account_id: accountId, credential_mode: serverMode } = parsed.data;

    // The cloud decides which runs this runner may take from the mode it stored for the code, so the local copy must equal
    // it. If it does not, nothing is saved, and the runner just created is revoked with the key still in memory.
    if (serverMode !== mode.data) {
      const revoked = await selfRevoke(origin, key, ctx, "credential mode did not match the registration code");
      throw new CliError(
        `This code was made for ${serverMode} runners, not ${mode.data}. Ask an owner or admin for a new code.` +
          (revoked ? "" : ` Runner ${runnerId} could not be revoked from here; an owner or admin can revoke it on the runner screen in the workspace.`),
      );
    }

    try {
      saveRunnerKey(ctx.stateDir, key);
      saveRegistration(ctx.stateDir, { version: 1, cloud_origin: origin, runner_id: runnerId, account_id: accountId, credential_mode: serverMode, jkt: key.jkt, registered_at: ctx.now().toISOString() });
    } catch {
      throw new CliError(`registered, but the key could not be saved under ${ctx.stateDir}; revoke runner ${runnerId} in the workspace and register again`);
    }
    ctx.out(`Registered runner ${runnerId} (${mode.data}). The key is saved under ${ctx.stateDir}.`);
    return 0;
  });
}
