/**
 * `fx-runner register --code fxrr_... --credential-mode subscription|api_key --cloud-url https://...`
 *
 * Generates the runner's key on this machine, signs the registration with it and, once the cloud accepts, saves the key
 * (0600) and the registration. The request body holds the code and the public JWK only.
 */
import { CredentialMode, RegisterMessage } from "@fulcrumaxe/runner-protocol";
import { CliError } from "../cliError.js";
import { REGISTER_PATH, normaliseOrigin, refusalError, signedPost } from "../cloud.js";
import { loadRegistration, saveRegistration, withRegisterLock } from "../config.js";
import type { CommandContext, Flags } from "../context.js";
import { generateRunnerKey, saveRunnerKey } from "../keys.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringFlag(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value === "") throw new CliError(`--${name} is required`, 2);
  return value;
}

export async function registerCommand(flags: Flags, ctx: CommandContext): Promise<number> {
  const code = stringFlag(flags, "code");
  const mode = CredentialMode.safeParse(stringFlag(flags, "credential-mode"));
  if (!mode.success) throw new CliError("--credential-mode must be subscription or api_key", 2);
  const origin = normaliseOrigin(stringFlag(flags, "cloud-url"));

  const key = generateRunnerKey();
  const message = RegisterMessage.safeParse({ code, public_key_jwk: key.publicJwk });
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

    const reply = await signedPost({ origin, path: REGISTER_PATH, body: message.data, key, now: ctx.now(), fetchFn: ctx.fetchFn });
    const runnerId = (reply.body as { runner_id?: unknown } | undefined)?.runner_id;
    if (reply.status !== 201) throw refusalError(reply);
    if (typeof runnerId !== "string" || !UUID.test(runnerId)) throw new CliError("the cloud's reply was not understood; update fx-runner and try again");

    try {
      saveRunnerKey(ctx.stateDir, key);
      saveRegistration(ctx.stateDir, { version: 1, cloud_origin: origin, runner_id: runnerId, credential_mode: mode.data, jkt: key.jkt, registered_at: ctx.now().toISOString() });
    } catch {
      throw new CliError(`registered, but the key could not be saved under ${ctx.stateDir}; revoke runner ${runnerId} in the workspace and register again`);
    }
    ctx.out(`Registered runner ${runnerId} (${mode.data}). The key is saved under ${ctx.stateDir}.`);
    return 0;
  });
}
