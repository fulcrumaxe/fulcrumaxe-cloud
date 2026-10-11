/**
 * `fx-runner status`: what this machine knows about its own registration. It makes no network call and reads no
 * secret: the key is loaded only to prove the file is intact and private.
 */
import { KEY_MAX_AGE_DAYS, loadRegistration } from "../config.js";
import type { CommandContext } from "../context.js";
import { loadRunnerKey } from "../keys.js";
import { isPaused, loadSettings } from "../runnerSettings.js";

const DAY_MS = 86_400_000;

export async function statusCommand(ctx: CommandContext): Promise<number> {
  const registration = loadRegistration(ctx.stateDir);
  if (!registration) {
    ctx.out("Not registered. Create a registration code in the workspace, then run: fx-runner register --code-stdin --credential-mode <mode> --cloud-url <url>");
    return 1;
  }
  const key = loadRunnerKey(ctx.stateDir);
  const ageDays = Math.max(0, Math.floor((ctx.now().getTime() - Date.parse(registration.registered_at)) / DAY_MS));
  ctx.out(`Runner:          ${registration.runner_id}`);
  ctx.out(`Account:         ${registration.account_id}`);
  ctx.out(`Cloud:           ${registration.cloud_origin}`);
  ctx.out(`Credential mode: ${registration.credential_mode}`);
  ctx.out(`Registered:      ${registration.registered_at}`);
  if (!key) {
    ctx.out("Key:             missing; run: fx-runner revoke --local, then register again");
    return 1;
  }
  if (key.jkt !== registration.jkt) {
    ctx.out("Key:             does not match the registration; run: fx-runner revoke --local, then register again");
    return 1;
  }
  if (ageDays >= KEY_MAX_AGE_DAYS) {
    ctx.out(`Key:             ${ageDays} days old; the cloud refuses keys over ${KEY_MAX_AGE_DAYS} days. Run: fx-runner revoke --local, then register again`);
    return 1;
  }
  ctx.out(`Key:             ok, ${ageDays} days old (re-register before ${KEY_MAX_AGE_DAYS})`);
  const settings = loadSettings(ctx.stateDir);
  ctx.out(`Claiming:        ${isPaused(ctx.stateDir) ? "paused by you; run: fx-runner resume" : "on"} (at most ${settings.ceilingTotal} jobs, ${settings.ceilingHeavy} heavy)`);
  return 0;
}
